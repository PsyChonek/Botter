// Isolated-world content script: owns the bot loop, the answer bank and the
// in-page control panel. Answers by clicking the app's own buttons so React
// state stays consistent.
(() => {
  const C = globalThis.BotterCore;
  const msg = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

  const DEFAULT_SETTINGS = {
    enabled: false,
    taskType: 'alternate',
    minDelayMs: 1500,
    maxDelayMs: 4000,
    stopAtNorm: false,
    aiSolver: 'local',
    guessUnknown: true,
    logLevel: 'info',
  };
  const EMPTY_STATS = {
    bank: { correct: 0, wrong: 0 },
    local: { correct: 0, wrong: 0 },
    claude: { correct: 0, wrong: 0 },
    openrouter: { correct: 0, wrong: 0 },
    guess: { correct: 0, wrong: 0 },
    manual: { correct: 0, wrong: 0 },
    spend: { usd: 0, calls: 0 },
  };
  const TICK_MS = 700;

  let settings = { ...DEFAULT_SETTINGS };
  let bank = {};
  let stats = structuredClone(EMPTY_STATS);
  let log = C.createLogger(settings.logLevel);

  let player = null;
  let task = null; // current task as returned by /api/work/start
  let answeredTaskId = null; // task the bot already clicked an answer for
  let pending = null; // { taskId, source } of the bot's last answer
  let lastType = null;
  let busy = false;
  let status = { key: 'statusIdle' };
  let ui = null;

  const usd = new Intl.NumberFormat(chrome.i18n.getUILanguage(), {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  const humanDelay = () => C.delayBetween(settings.minDelayMs, settings.maxDelayMs);

  // ---------- storage ----------

  async function load() {
    const stored = await chrome.storage.local.get(['settings', 'bank', 'stats']);
    settings = { ...DEFAULT_SETTINGS, ...stored.settings };
    bank = stored.bank ?? {};
    stats = { ...structuredClone(EMPTY_STATS), ...stored.stats };
    log = C.createLogger(settings.logLevel);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
      log = C.createLogger(settings.logLevel);
    }
    if (changes.bank) bank = changes.bank.newValue ?? {};
    if (changes.stats) stats = { ...structuredClone(EMPTY_STATS), ...changes.stats.newValue };
    render();
  });

  const saveSettings = (patch) => chrome.storage.local.set({ settings: { ...settings, ...patch } });

  // ---------- data from the page hook ----------

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'botter-hook') return;
    const { path, ok, request, data } = event.data;
    if (data?.player) player = data.player;
    if (!ok) return;
    if (path === '/api/work/start' && data.task) {
      task = data.task;
      log.debug('task_started', { id: task.id, type: task.type });
    } else if (path === '/api/work/submit' && data.result) {
      onResult(request?.id, data.result);
    }
    render();
  });

  function onResult(taskId, result) {
    if (!task || task.id !== taskId || !Number.isInteger(result.answer)) return;
    bank[C.taskKey(task)] = C.bankEntry(task, result.answer);
    const source = pending?.taskId === taskId ? pending.source : 'manual';
    stats[source][result.correct ? 'correct' : 'wrong'] += 1;
    pending = null;
    chrome.storage.local.set({ bank, stats });
    log.info('task_result', { ticket: C.ticketLabel(task.id), type: task.type, source, correct: result.correct });
  }

  // Every AI call is billed, even when its answer turns out unusable.
  function recordSpend(cost) {
    if (typeof cost !== 'number') return;
    stats.spend.usd += cost;
    stats.spend.calls += 1;
    chrome.storage.local.set({ stats });
  }

  // ---------- page actions ----------

  function pressKey(key) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }

  // Level-up and daily-bonus modals block the work screen; dismiss them.
  function dismissModal() {
    const button =
      document.querySelector('.modal .sheet.levelup .btn-primary') ||
      document.querySelector('.modal .sheet.daily .close');
    if (!button) return false;
    button.click();
    return true;
  }

  function answerButton(taskEl, current, index) {
    if (current.type === 'bughunt') {
      return taskEl.querySelectorAll('ol.code.lines > li')[index]?.querySelector('button');
    }
    return taskEl.querySelectorAll('.options button')[index];
  }

  async function pickAnswer(current) {
    const known = C.answerFromBank(current, bank[C.taskKey(current)]);
    if (known !== null) return { index: known, source: 'bank' };

    if (settings.aiSolver !== 'off') {
      const source = settings.aiSolver;
      setStatus('statusThinking', [C.ticketLabel(current.id), msg(`source_${source}`)]);
      const res = await chrome.runtime.sendMessage({ kind: 'solve', task: current }).catch((err) => ({
        ok: false,
        error: String(err),
      }));
      if (res?.ok) recordSpend(res.cost);
      if (res?.ok && C.isValidAnswer(current, res.index)) return { index: res.index, source };
      if (res?.error !== 'no_api_key') log.warn('ai_failed', { error: res?.error ?? 'invalid_index' });
    }

    if (settings.guessUnknown) return { index: C.randomChoice(current), source: 'guess' };
    return { index: null, source: null };
  }

  async function solve(taskEl) {
    const current = task;
    answeredTaskId = current.id;
    const started = Date.now();
    const { index, source } = await pickAnswer(current);
    if (index === null) {
      stop('statusNoSolver');
      return;
    }

    setStatus('statusAnswering', [C.ticketLabel(current.id), msg(`source_${source}`)]);
    const timeLeft = current.expiresAt - Date.now() - 2000;
    await sleep(Math.min(humanDelay() - (Date.now() - started), timeLeft));
    if (!settings.enabled || task?.id !== current.id) return;

    const button = answerButton(taskEl, current, index);
    if (!button || button.disabled) {
      log.warn('answer_button_missing', { ticket: C.ticketLabel(current.id), index });
      return;
    }
    pending = { taskId: current.id, source };
    button.click();
  }

  async function step() {
    if (dismissModal()) return;

    const screen = document.querySelector('.work-screen');
    if (!screen) {
      setStatus('statusOpening');
      document.querySelectorAll('nav.views button')[1]?.click();
      return;
    }

    const taskEl = screen.querySelector('section.task');
    if (taskEl) {
      if (taskEl.querySelector('button.right, button.wrong')) {
        await sleep(humanDelay() / 2);
        pressKey('Escape');
        return;
      }
      const label = taskEl.querySelector('.ticket')?.textContent ?? '';
      if (!task || !label.includes(C.ticketLabel(task.id))) {
        // Task opened before the extension loaded: we have no data for it.
        pressKey('Escape');
        return;
      }
      if (answeredTaskId !== task.id) await solve(taskEl);
      return;
    }

    const pick = screen.querySelector('.work-pick');
    if (!pick) return;
    if (settings.stopAtNorm && player && player.work.paidToday >= player.work.norm) {
      stop('statusNormDone');
      return;
    }
    const type = C.nextType(settings.taskType, lastType);
    const card = pick.querySelectorAll('.job-card')[C.TYPES.indexOf(type)];
    if (!card || card.disabled) {
      setStatus('statusNoEnergy');
      return;
    }
    setStatus('statusStarting');
    await sleep(humanDelay() / 2);
    if (!settings.enabled) return;
    lastType = type;
    card.click();
  }

  async function tick() {
    if (!settings.enabled || busy) return;
    busy = true;
    try {
      await step();
    } catch (err) {
      log.error('step_failed', { error: String(err) });
    } finally {
      busy = false;
    }
  }

  function start() {
    saveSettings({ enabled: true });
    setStatus('statusStarting');
  }

  function stop(reasonKey = 'statusIdle') {
    saveSettings({ enabled: false });
    setStatus(reasonKey);
  }

  // ---------- control panel ----------

  function setStatus(key, subs) {
    status = { key, subs };
    render();
  }

  function mountPanel() {
    const host = document.createElement('div');
    host.id = 'botter-panel';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; width: 240px;
          font: 12px/1.4 system-ui, sans-serif; color: #e8f5c8; background: #101a08f2;
          border: 1px solid #7aa02c; border-radius: 10px; padding: 10px; box-shadow: 0 4px 16px #0008; }
        .row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
        .title { font-weight: 700; flex: 1; }
        button, select { font: inherit; color: inherit; background: #1f3010; border: 1px solid #7aa02c;
          border-radius: 6px; padding: 4px 8px; cursor: pointer; }
        button:focus-visible, select:focus-visible { outline: 2px solid #d4ff6a; outline-offset: 1px; }
        button.on { background: #7aa02c; color: #101a08; }
        .status { min-height: 1.4em; }
        .muted { color: #b5c99a; }
      </style>
      <div class="panel" role="region">
        <div class="row">
          <span class="title"></span>
          <button type="button" class="toggle"></button>
        </div>
        <div class="row">
          <label class="muted" for="type"></label>
          <select id="type">
            <option value="alternate"></option>
            <option value="bughunt"></option>
            <option value="output"></option>
          </select>
        </div>
        <div class="status" role="status" aria-live="polite"></div>
        <div class="stats muted"></div>
        <div class="cost muted"></div>
      </div>`;
    const $ = (sel) => shadow.querySelector(sel);
    ui = {
      panel: $('.panel'),
      title: $('.title'),
      toggle: $('.toggle'),
      typeLabel: $('label'),
      type: $('#type'),
      status: $('.status'),
      stats: $('.stats'),
      cost: $('.cost'),
    };
    ui.panel.setAttribute('aria-label', msg('extName'));
    ui.title.textContent = msg('extName');
    ui.typeLabel.textContent = msg('panelType');
    for (const option of ui.type.options) option.textContent = msg(`type_${option.value}`);
    ui.toggle.addEventListener('click', () => (settings.enabled ? stop() : start()));
    ui.type.addEventListener('change', () => saveSettings({ taskType: ui.type.value }));
    document.documentElement.appendChild(host);
    render();
  }

  function render() {
    if (!ui) return;
    ui.toggle.textContent = msg(settings.enabled ? 'panelStop' : 'panelStart');
    ui.toggle.classList.toggle('on', settings.enabled);
    ui.toggle.setAttribute('aria-pressed', String(settings.enabled));
    ui.type.value = settings.taskType;
    ui.status.textContent = msg(status.key, status.subs);
    const sum = (s) => `${s.correct}/${s.correct + s.wrong}`;
    ui.stats.textContent = msg('panelStats', [
      String(Object.keys(bank).length),
      sum(stats.bank),
      sum(stats[settings.aiSolver] ?? stats.local),
      sum(stats.guess),
    ]);
    const { usd: spent, calls } = stats.spend;
    ui.cost.textContent = msg('panelCost', [usd.format(spent), usd.format(calls ? spent / calls : 0)]);
  }

  // ---------- boot ----------

  load().then(() => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountPanel);
    else mountPanel();
    setInterval(tick, TICK_MS);
  });
})();
