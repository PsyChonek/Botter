// Isolated-world content script: owns the work bot, the game bot, the answer
// bank, profit tracking and the in-page control panel.
// Work tickets are answered by clicking the app's own buttons; casino games are
// played through the API via the page hook, so they run on any screen.
(() => {
  const C = globalThis.BotterCore;
  const G = globalThis.BotterGames;
  const BJ = globalThis.BotterBlackjack;
  const msg = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

  const DEFAULT_SETTINGS = {
    enabled: false,
    taskType: 'alternate',
    minDelayMs: 1500,
    maxDelayMs: 4000,
    stopAtNorm: false,
    aiSolver: 'local',
    guessUnknown: true,
    gamesEnabled: false,
    game: 'blaze',
    gameBet: 20,
    rouletteBet: 'red',
    stopLoss: 1000,
    takeProfit: 0,
    reserve: 0,
    gameDelayMs: 800,
    autoClaim: true,
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
    games: {},
    work: { tickets: 0, net: 0, xp: 0 },
    free: { daily: 0, bailout: 0 },
  };
  const FREE_PATHS = { '/api/bonus/daily': 'daily', '/api/bonus/bailout': 'bailout' };
  const CLAIM_RETRY_MS = 10 * 60_000;
  const TICK_MS = 700;
  const API_TIMEOUT_MS = 30_000;

  let settings = { ...DEFAULT_SETTINGS };
  let bank = {};
  let stats = structuredClone(EMPTY_STATS);
  let log = C.createLogger(settings.logLevel);

  let player = null;
  let task = null; // current task as returned by /api/work/start
  let answeredTaskId = null; // task the bot already clicked an answer for
  let pending = null; // { taskId, source } of the bot's last answer
  let lastType = null;
  let bjStake = 0; // stake of the open blackjack hand, to book doubles
  let sessionBase = 0; // total game net when the game bot was started
  const claimTried = {}; // kind -> last attempt, so a refused claim is not spammed
  let busy = false;
  let status = { key: 'statusIdle' };
  let ui = null;

  const locale = chrome.i18n.getUILanguage();
  const usd = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  const num = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const signed = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, signDisplay: 'exceptZero' });
  const pct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  const humanDelay = () => C.delayBetween(settings.minDelayMs, settings.maxDelayMs);

  // ---------- storage ----------

  const mergeStats = (stored) => ({ ...structuredClone(EMPTY_STATS), ...stored });

  async function load() {
    const stored = await chrome.storage.local.get(['settings', 'bank', 'stats']);
    settings = { ...DEFAULT_SETTINGS, ...stored.settings };
    bank = stored.bank ?? {};
    stats = mergeStats(stored.stats);
    sessionBase = G.totalNet(stats.games);
    log = C.createLogger(settings.logLevel);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
      log = C.createLogger(settings.logLevel);
    }
    if (changes.bank) bank = changes.bank.newValue ?? {};
    if (changes.stats) stats = mergeStats(changes.stats.newValue);
    render();
  });

  const saveSettings = (patch) => chrome.storage.local.set({ settings: { ...settings, ...patch } });
  const saveStats = () => chrome.storage.local.set({ stats });

  // ---------- messages from the page hook ----------

  const apiWaiters = new Map();
  let apiSeq = 0;

  // Calls the casino API through the page hook, which adds the session token.
  function api(path, body) {
    const id = ++apiSeq;
    return new Promise((resolve) => {
      apiWaiters.set(id, resolve);
      window.postMessage({ source: 'botter-content', kind: 'api', id, path, body }, location.origin);
      setTimeout(() => {
        if (apiWaiters.delete(id)) resolve({ ok: false, status: 0, data: { error: 'timeout' } });
      }, API_TIMEOUT_MS);
    });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'botter-hook') return;
    if (event.data.kind === 'api-result') {
      const resolve = apiWaiters.get(event.data.id);
      apiWaiters.delete(event.data.id);
      resolve?.(event.data);
      return;
    }
    onResponse(event.data);
  });

  // Every /api/ response the page sees, from the app or from the bot.
  function onResponse({ path, ok, request, data }) {
    const before = player?.credits;
    if (data?.player) player = data.player;
    if (!ok) return;

    if (path === '/api/work/start' && data.task) {
      task = data.task;
      log.debug('task_started', { id: task.id, type: task.type });
    } else if (path === '/api/work/submit' && data.result) {
      onResult(request?.id, data, before);
    } else if (FREE_PATHS[path] && typeof before === 'number' && data.player) {
      stats.free[FREE_PATHS[path]] += data.player.credits - before;
      saveStats();
    } else {
      const delta = G.gameDelta(path, request, data, before, bjStake);
      if (delta) {
        bjStake = data.hand && !data.hand.done ? delta.stake : 0;
        G.addDelta(stats.games, delta);
        saveStats();
        log.debug('game_round', delta);
      }
    }
    render();
  }

  function onResult(taskId, data, creditsBefore) {
    const { result } = data;
    if (typeof creditsBefore === 'number' && data.player) {
      stats.work.tickets += 1;
      stats.work.net += data.player.credits - creditsBefore + (result.garnished ?? 0);
      stats.work.xp += result.xpGain ?? 0;
    }
    if (task && task.id === taskId && Number.isInteger(result.answer)) {
      bank[C.taskKey(task)] = C.bankEntry(task, result.answer);
      const source = pending?.taskId === taskId ? pending.source : 'manual';
      stats[source][result.correct ? 'correct' : 'wrong'] += 1;
      pending = null;
      log.info('task_result', { ticket: C.ticketLabel(task.id), type: task.type, source, correct: result.correct });
    }
    chrome.storage.local.set({ bank, stats });
  }

  // Every AI call is billed, even when its answer turns out unusable.
  function recordSpend(cost) {
    if (typeof cost !== 'number') return;
    stats.spend.usd += cost;
    stats.spend.calls += 1;
    saveStats();
  }

  // ---------- work bot ----------

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
      stopWork('statusNoSolver');
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

  const normDone = () => settings.stopAtNorm && player && player.work.paidToday >= player.work.norm;

  // Whether the work bot has something to do right now, so games can use the gaps.
  function workAvailable() {
    if (document.querySelector('.work-screen section.task')) return true;
    if (!player) return true;
    return !normDone() && G.energyNow(player.work, Date.now()) >= 1;
  }

  async function workStep() {
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
    if (normDone()) {
      stopWork('statusNormDone');
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

  // ---------- game bot ----------

  const credits = (n) => num.format(n);

  async function playBlackjack(bet) {
    const open = player.blackjack && !player.blackjack.done ? player.blackjack : null;
    if (open) bjStake = open.stake ?? bjStake;
    let res = open ? { ok: true, data: { hand: open, player } } : await api('/api/blackjack/deal', { bet });
    while (res.ok && res.data.hand && !res.data.hand.done && settings.gamesEnabled) {
      await sleep(settings.gameDelayMs / 2);
      const rules = BJ.rulesFromUpgrades(player.upgrades?.blackjack);
      const action = BJ.decide(res.data.hand, rules, res.data.player?.credits ?? player.credits);
      res = await api('/api/blackjack/action', { action });
    }
    return res;
  }

  async function gameStep() {
    if (!player) {
      setStatus('statusLoading');
      await api('/api/me');
      return;
    }
    const game = settings.game;
    const info = G.GAMES[game];
    if (!info) return stopGames('statusIdle');
    if (player.level < info.unlock) return stopGames('statusGameLocked', [msg(`game_${game}`), String(info.unlock)]);

    const sessionNet = G.totalNet(stats.games) - sessionBase;
    if (settings.stopLoss > 0 && sessionNet <= -settings.stopLoss) {
      return stopGames('statusStopLoss', [credits(-sessionNet)]);
    }
    if (settings.takeProfit > 0 && sessionNet >= settings.takeProfit) {
      return stopGames('statusTakeProfit', [credits(sessionNet)]);
    }

    const bet = G.betFor(settings.gameBet, player.maxBet);
    const handOpen = game === 'blackjack' && player.blackjack && !player.blackjack.done;
    if (!handOpen && player.credits - bet < settings.reserve) return stopGames('statusReserve');

    setStatus('statusPlaying', [msg(`game_${game}`), credits(bet), signed.format(sessionNet)]);
    let res;
    if (game === 'blackjack') res = await playBlackjack(bet);
    else if (game === 'roulette') res = await api('/api/roulette/spin', { bets: { [settings.rouletteBet]: bet } });
    else res = await api(info.path, { bet });

    if (!res.ok) {
      log.warn('game_failed', { game, status: res.status, error: res.data?.error });
      return stopGames('statusGameError', [res.data?.error ?? String(res.status)]);
    }
    await sleep(settings.gameDelayMs);
  }

  // ---------- loop ----------

  // Free credits: the daily bonus, and the once-a-day bailout when broke.
  async function claimFreebies() {
    if (!player || !settings.autoClaim) return false;
    const due = (kind) => Date.now() - (claimTried[kind] ?? 0) > CLAIM_RETRY_MS;
    let kind = null;
    if (player.daily?.available && due('daily')) kind = 'daily';
    else if (player.bailout?.available && player.credits < G.BET_LEVELS[0] && due('bailout')) kind = 'bailout';
    if (!kind) return false;
    claimTried[kind] = Date.now();
    setStatus(kind === 'daily' ? 'statusClaimDaily' : 'statusClaimBailout');
    const res = await api(`/api/bonus/${kind}`, {});
    if (!res.ok) log.warn('claim_failed', { kind, status: res.status, error: res.data?.error });
    return true;
  }

  async function step() {
    if (await claimFreebies()) return;
    if (settings.enabled && workAvailable()) return workStep();
    if (settings.gamesEnabled) return gameStep();
    if (settings.enabled) return workStep();
  }

  async function tick() {
    if ((!settings.enabled && !settings.gamesEnabled) || busy) return;
    busy = true;
    try {
      await step();
    } catch (err) {
      log.error('step_failed', { error: String(err) });
    } finally {
      busy = false;
    }
  }

  function startWork() {
    saveSettings({ enabled: true });
    setStatus('statusStarting');
  }

  function stopWork(reasonKey = 'statusIdle') {
    saveSettings({ enabled: false });
    setStatus(reasonKey);
  }

  function startGames() {
    sessionBase = G.totalNet(stats.games);
    saveSettings({ gamesEnabled: true });
    setStatus('statusStarting');
  }

  function stopGames(reasonKey = 'statusIdle', subs) {
    saveSettings({ gamesEnabled: false });
    setStatus(reasonKey, subs);
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
        .panel { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; width: 290px;
          max-height: calc(100vh - 24px); overflow: auto; box-sizing: border-box;
          font: 12px/1.4 system-ui, sans-serif; color: #e8f5c8; background: #101a08f2;
          border: 1px solid #7aa02c; border-radius: 10px; padding: 10px; box-shadow: 0 4px 16px #0008; }
        .row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
        .title { font-weight: 700; flex: 1; }
        .grow { flex: 1; min-width: 0; }
        button, select { font: inherit; color: inherit; background: #1f3010; border: 1px solid #7aa02c;
          border-radius: 6px; padding: 4px 8px; cursor: pointer; }
        button:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid #d4ff6a; outline-offset: 1px; }
        button.on { background: #7aa02c; color: #101a08; }
        .status { min-height: 1.4em; margin-bottom: 4px; }
        .muted { color: #b5c99a; }
        details { margin-top: 6px; }
        summary { cursor: pointer; font-weight: 600; }
        table { width: 100%; border-collapse: collapse; margin-top: 4px; font-variant-numeric: tabular-nums; }
        th, td { padding: 2px 4px; text-align: right; white-space: nowrap; }
        th:first-child, td:first-child { text-align: left; white-space: normal; }
        th { color: #b5c99a; font-weight: 600; border-bottom: 1px solid #3d5420; }
        .pos { color: #a6e05a; }
        .neg { color: #ff8f7a; }
      </style>
      <div class="panel" role="region">
        <div class="row"><span class="title"></span></div>
        <div class="row">
          <label class="muted grow" for="type"></label>
          <select id="type">
            <option value="alternate"></option>
            <option value="bughunt"></option>
            <option value="output"></option>
          </select>
          <button type="button" class="work-toggle"></button>
        </div>
        <div class="row">
          <label class="muted grow" for="game"></label>
          <select id="game"></select>
          <button type="button" class="games-toggle"></button>
        </div>
        <div class="status" role="status" aria-live="polite"></div>
        <div class="stats muted"></div>
        <div class="cost muted"></div>
        <details>
          <summary></summary>
          <table>
            <thead><tr><th scope="col"></th><th scope="col"></th><th scope="col"></th><th scope="col"></th></tr></thead>
            <tbody></tbody>
          </table>
        </details>
      </div>`;
    const $ = (sel) => shadow.querySelector(sel);
    ui = {
      panel: $('.panel'),
      title: $('.title'),
      typeLabel: $('label[for="type"]'),
      type: $('#type'),
      workToggle: $('.work-toggle'),
      gameLabel: $('label[for="game"]'),
      game: $('#game'),
      gamesToggle: $('.games-toggle'),
      status: $('.status'),
      stats: $('.stats'),
      cost: $('.cost'),
      summary: $('summary'),
      head: [...shadow.querySelectorAll('th')],
      body: $('tbody'),
    };
    ui.panel.setAttribute('aria-label', msg('extName'));
    ui.title.textContent = msg('extName');
    ui.typeLabel.textContent = msg('panelWork');
    ui.gameLabel.textContent = msg('panelGames');
    ui.summary.textContent = msg('panelProfit');
    ['colGame', 'colRounds', 'colNet', 'colRtp'].forEach((key, i) => (ui.head[i].textContent = msg(key)));
    for (const option of ui.type.options) option.textContent = msg(`type_${option.value}`);
    for (const game of G.GAME_KEYS) ui.game.add(new Option(msg(`game_${game}`), game));
    ui.workToggle.addEventListener('click', () => (settings.enabled ? stopWork() : startWork()));
    ui.gamesToggle.addEventListener('click', () => (settings.gamesEnabled ? stopGames() : startGames()));
    ui.type.addEventListener('change', () => saveSettings({ taskType: ui.type.value }));
    ui.game.addEventListener('change', () => saveSettings({ game: ui.game.value }));
    document.documentElement.appendChild(host);
    render();
  }

  function cell(text, className) {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  const tone = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

  function renderProfit() {
    const rows = G.profitRows(stats.games).map((row) => [
      msg(`game_${row.game}`),
      num.format(row.rounds),
      { text: signed.format(row.net), tone: tone(row.net) },
      row.rtp === null ? '-' : pct.format(row.rtp),
    ]);
    if (stats.work.tickets > 0) {
      rows.push([
        msg('panelWork'),
        num.format(stats.work.tickets),
        { text: signed.format(stats.work.net), tone: tone(stats.work.net) },
        '-',
      ]);
    }
    for (const [kind, amount] of Object.entries(stats.free)) {
      if (amount) rows.push([msg(`free_${kind}`), '-', { text: signed.format(amount), tone: tone(amount) }, '-']);
    }
    ui.body.replaceChildren(
      ...rows.map((values) => {
        const tr = document.createElement('tr');
        for (const value of values) tr.append(typeof value === 'object' ? cell(value.text, value.tone) : cell(value));
        return tr;
      }),
    );
  }

  function setToggle(button, on) {
    button.textContent = msg(on ? 'panelStop' : 'panelStart');
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  }

  function render() {
    if (!ui) return;
    setToggle(ui.workToggle, settings.enabled);
    setToggle(ui.gamesToggle, settings.gamesEnabled);
    ui.workToggle.setAttribute('aria-label', `${msg('panelWork')}: ${ui.workToggle.textContent}`);
    ui.gamesToggle.setAttribute('aria-label', `${msg('panelGames')}: ${ui.gamesToggle.textContent}`);
    ui.type.value = settings.taskType;
    ui.game.value = settings.game;
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
    renderProfit();
  }

  // ---------- boot ----------

  load().then(() => {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountPanel);
    else mountPanel();
    setInterval(tick, TICK_MS);
  });
})();
