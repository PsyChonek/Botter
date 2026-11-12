// The Settings and Statistics views: every shared bot setting, saved as it is
// changed, and the books, model checks, level curve, server speed and odds.
// Storage and the bot's messages come from storage.js (BotterStorage).
(() => {
  const store = window.BotterStorage;
  const msg = (key, subs) => store.message(key, subs);
  const G = window.BotterGames;
  const A = window.BotterAuto;
  const O = window.BotterOdds;
  const Z = window.BotterBlaze;

  const CHECKBOXES = [
    'maxSpeed',
    'guessUnknown',
    'stopAtNorm',
    'autoClaim',
    'autoWork',
    'autoGames',
    'autoWheel',
    'sprintProtect',
    'repayDebt',
    'autoBankrupt',
    'loanCycle',
    'levelLoan',
    'grindPays',
    'grindEventHold',
    'autoPrestige',
    'loanTrick',
    'standup',
    'achievementHunt',
    'edgeBets',
    'crashEnabled',
    'lotteryLucky',
    'buyUpgrades',
    'saveForUpgrades',
    'spareUpgrades',
    'buyCosmetics',
    'recordSpins',
    'learnBlaze',
    'captureDebug',
    'hotfixForce',
  ];
  const SELECTS = ['aiSolver', 'model', 'effort', 'logLevel', 'rouletteBet', 'grindLimit', 'grindGame', 'firstGame', 'lotteryPick', 'wearFrame', 'wearColor', 'wearTitle'];
  const BET_SELECTS = ['gameBet', 'crashBet', 'grindBet', 'lotteryPrice'];
  const INT_SELECTS = [...BET_SELECTS, 'huntRoundsGoal', 'autoBetBump'];
  const TEXTS = ['openrouterModel', 'lotteryLines', 'hotfixForceValue'];
  const NUMBERS = ['minDelayMs', 'maxDelayMs', 'stopLoss', 'takeProfit', 'reserve', 'gameDelayMs', 'crashMinEv', 'crashKelly', 'xpBudget', 'grindMinBalance', 'lotteryTickets'];
  // The same defaults as the bot (DEFAULT_SETTINGS in content.js).
  const DEFAULTS = {
    aiSolver: 'off',
    guessUnknown: true,
    stopAtNorm: false,
    autoClaim: true,
    autoWork: true,
    autoGames: true,
    autoWheel: true,
    sprintProtect: true,
    repayDebt: true,
    autoBankrupt: true,
    loanCycle: true,
    levelLoan: true,
    grindPays: true,
    grindEventHold: true,
    autoPrestige: true,
    loanTrick: true,
    standup: true,
    achievementHunt: true,
    huntRoundsGoal: 10_000,
    edgeBets: true,
    crashEnabled: true,
    crashBet: 100,
    crashMinEv: 1.05,
    crashKelly: 0.5,
    lotteryLucky: false,
    lotteryPrice: 20,
    lotteryTickets: 5,
    lotteryPick: 'random',
    lotteryLines: '',
    grindLimit: 'daily',
    xpBudget: 0,
    grindMinBalance: 0,
    grindGame: 'auto',
    grindBet: 0,
    autoBetBump: 1,
    buyUpgrades: false,
    saveForUpgrades: true,
    spareUpgrades: true,
    firstGame: '',
    buyCosmetics: true,
    wearFrame: 'auto',
    wearColor: 'auto',
    wearTitle: 'auto',
    recordSpins: true,
    learnBlaze: true,
    captureDebug: false,
    hotfixForce: false,
    hotfixForceValue: '',
    model: 'claude-opus-5-5',
    openrouterModel: 'google/gemini-2.5-flash',
    effort: 'medium',
    logLevel: 'info',
    minDelayMs: 1500,
    maxDelayMs: 4000,
    gameBet: 20,
    rouletteBet: 'red',
    stopLoss: 1000,
    takeProfit: 0,
    reserve: 0,
    gameDelayMs: 1500,
    maxSpeed: true,
  };
  const SECRETS = ['apiKey', 'openrouterKey'];
  const STATS_PREFIX = 'stats:';
  const ACCOUNT_PREFIX = 'account:';
  const ALL_ACCOUNTS = '*';

  const byPrefix = (items, prefix) =>
    Object.fromEntries(
      Object.entries(items)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), value]),
    );

  const $ = (id) => document.getElementById(id);
  const form = $('settings-form');
  const field = (name) => form.elements.namedItem(name);
  const secretField = (key) => form.querySelector(`[data-secret="${key}"]`);

  // Formats in the dashboard's language, rebuilt when it changes.
  let fmt = null;
  function formats() {
    const locale = window.I18n.lang;
    fmt = {
      num: new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }),
      signed: new Intl.NumberFormat(locale, { maximumFractionDigits: 1, signDisplay: 'exceptZero' }),
      pct: new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }),
      when: new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }),
      clock: new Intl.DateTimeFormat(locale, { timeStyle: 'medium' }),
      seconds: new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }),
    };
  }

  function applyMessages() {
    for (const root of [form, $('settings-nav'), $('view-stats')]) {
      for (const el of root.querySelectorAll('[data-msg]')) el.textContent = msg(el.dataset.msg);
      for (const el of root.querySelectorAll('[data-msg-label]')) el.setAttribute('aria-label', msg(el.dataset.msgLabel));
    }
    $('settings-nav').setAttribute('aria-label', msg('settingsNavLabel'));
    $('stats-nav').setAttribute('aria-label', msg('statsNavLabel'));
  }

  function fillSelect(name, options) {
    const select = field(name);
    const value = select.value;
    select.replaceChildren(...options.map(([text, optionValue]) => new Option(text, optionValue)));
    if (value) select.value = value;
  }

  // The dropdowns built from the bot's own tables.
  function fillOptions() {
    const bets = G.BET_LEVELS.map((bet) => [fmt.num.format(bet), String(bet)]);
    for (const name of BET_SELECTS) fillSelect(name, name === 'grindBet' ? [[msg('grindBet_auto'), '0'], ...bets] : bets);
    fillSelect('autoBetBump', [0, 1, 2, 3].map((bump) => [msg(`autoBetBump_${bump}`), String(bump)]));
    fillSelect('huntRoundsGoal', A.HUNT_ROUNDS_TIERS.map((rounds) => [fmt.num.format(rounds), String(rounds)]));
    fillSelect('lotteryPick', A.LOTTERY_PICK_MODES.map((mode) => [msg(`lotteryPick_${mode}`), mode]));
    fillSelect('rouletteBet', G.ROULETTE_BETS.map((key) => [msg(`roulette_${key}`), key]));
    fillSelect('grindGame', [[msg('grind_auto'), 'auto'], ...G.GAME_KEYS.map((game) => [msg(`game_${game}`), game])]);
    fillSelect('firstGame', [[msg('firstGame_none'), ''], ...['hotfix', 'blaze'].map((game) => [msg(`game_${game}`), game])]);
    for (const kind of G.COSMETIC_KINDS) {
      const items = G.COSMETICS.filter((item) => item.kind === kind).sort((a, b) => a.price - b.price);
      fillSelect(`wear${kind[0].toUpperCase()}${kind.slice(1)}`, [
        [msg('wear_auto'), 'auto'],
        [msg('wear_keep'), 'keep'],
        ...items.map((item) => [msg(item.season ? 'wearItemSeasonal' : 'wearItem', [item.name, fmt.num.format(item.price)]), item.id]),
      ]);
    }
  }

  async function load() {
    const stored = await store.get(['settings', 'bank', ...SECRETS]);
    const values = { ...DEFAULTS, ...stored.settings };
    // 0 is the auto bet size; the old 'auto' choice meant it too.
    if (values.grindBet !== 0 && !G.BET_LEVELS.includes(values.grindBet)) values.grindBet = 0;
    // The on-device model is gone; tickets it would have answered go to nobody.
    if (!['claude', 'openrouter', 'off'].includes(values.aiSolver)) values.aiSolver = 'off';
    fill(values);
    for (const key of SECRETS) showSecret(key, !!stored[key]);
    showBankSize(stored.bank ?? {});
    showSpinCount();
    showHotfixCount();
  }

  // A saved key never comes back to the browser: the field stays empty and
  // says a key is there; typing replaces it, emptying it removes it.
  function showSecret(key, saved) {
    const input = secretField(key);
    input.value = '';
    delete input.dataset.dirty;
    input.placeholder = saved ? '••••••••••••' : '';
    const hint = $(`${input.id}-hint`);
    hint.textContent = saved ? `${msg('optionsKeySet')} ${msg('optionsApiKeyHint')}` : msg('optionsApiKeyHint');
  }

  // Skips the field being edited, so a change made elsewhere never yanks text
  // out from under the cursor.
  function fill(values) {
    for (const name of CHECKBOXES) field(name).checked = values[name];
    for (const name of [...SELECTS, ...INT_SELECTS, ...TEXTS, ...NUMBERS]) {
      if (field(name) !== document.activeElement) field(name).value = values[name];
    }
    showRelevant();
    showLotteryLines();
  }

  // Which fixed ticket lines the bot can use: the line numbers of any it cannot
  // read (they are bought on random numbers), else how many tickets are set.
  function showLotteryLines() {
    const lines = field('lotteryLines').value.split('\n');
    const bad = lines.flatMap((line, i) => (line.trim() && !A.parseTicket(line) ? [i + 1] : []));
    const set = A.parseTickets(field('lotteryLines').value).filter(Boolean).length;
    $('set-lotteryLinesCheck').textContent = bad.length ? msg('optionsLotteryLinesBad', [bad.join(', ')]) : msg('optionsLotteryLinesOk', [String(set)]);
  }

  // data-when="name" shows an element while that checkbox is ticked or that
  // number is above 0; data-when="name:value" while that field equals value.
  // Space-separated conditions must all hold; "|" separates alternatives; a
  // leading "!" turns a condition around.
  function holds(condition) {
    if (condition.startsWith('!')) return !holds(condition.slice(1));
    const [name, value] = condition.split(':');
    const el = field(name);
    if (el.type === 'checkbox') return el.checked;
    if (value !== undefined) return el.value === value;
    return Number(el.value) > 0;
  }
  const shown = (when) => when.split('|').some((all) => all.trim().split(/\s+/).every(holds));

  function showRelevant() {
    for (const el of form.querySelectorAll('[data-when]')) el.hidden = !shown(el.dataset.when);
  }

  // ---------- sections ----------

  // One section of a view at a time, picked in its side navigation; the
  // address keeps it (#settings/auto), so a reload or a link lands there.
  function sectionNav(nav, body, view) {
    const links = [...nav.querySelectorAll('a')];
    const sections = [...body.querySelectorAll('.settings-section')];
    const show = (name, focus = false) => {
      const link = links.find((item) => item.dataset.section === name) ?? links[0];
      for (const item of links) {
        if (item === link) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      }
      for (const section of sections) section.hidden = section.dataset.section !== link.dataset.section;
      if (focus) sections.find((section) => !section.hidden)?.querySelector('h2')?.focus();
      return link.dataset.section;
    };
    for (const link of links) {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        show(link.dataset.section, true);
        history.replaceState(null, '', `#${view}/${link.dataset.section}`);
      });
    }
    for (const section of sections) section.querySelector('h2')?.setAttribute('tabindex', '-1');
    return show;
  }
  const showSettingsSection = sectionNav($('settings-nav'), form, 'settings');
  const showStatsSection = sectionNav($('stats-nav'), $('view-stats').querySelector('.side-body'), 'stats');

  // ---------- autosave ----------

  const SETTING_NAMES = new Set([...CHECKBOXES, ...SELECTS, ...INT_SELECTS, ...TEXTS, ...NUMBERS]);
  const isSetting = (el) => SETTING_NAMES.has(el.name) || !!el.dataset?.secret;

  function readFields() {
    const next = {};
    for (const name of CHECKBOXES) next[name] = field(name).checked;
    for (const name of SELECTS) next[name] = field(name).value;
    for (const name of INT_SELECTS) next[name] = Number(field(name).value);
    for (const name of TEXTS) next[name] = field(name).value.trim();
    for (const name of NUMBERS) next[name] = Math.max(0, Number(field(name).value) || 0);
    next.crashMinEv = Math.max(1, next.crashMinEv);
    next.crashKelly = Math.max(0, Math.min(1, next.crashKelly));
    next.lotteryTickets = Math.max(1, Math.min(5, Math.round(next.lotteryTickets)));
    if (next.maxDelayMs < next.minDelayMs) next.maxDelayMs = next.minDelayMs;
    return next;
  }

  let saveTimer = null;

  // Merges into the stored settings so keys this page does not show survive.
  async function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    try {
      const { settings = {} } = await store.get('settings');
      const items = { settings: { ...settings, ...readFields() } };
      for (const key of SECRETS) {
        const input = secretField(key);
        if (input.dataset.dirty) items[key] = input.value.trim();
      }
      await store.set(items);
      for (const key of SECRETS) if (key in items) showSecret(key, !!items[key]);
      flash(msg('optionsSaved'));
    } catch (err) {
      flash(msg('optionsSaveFailed', [err.message]), true);
    }
  }

  form.addEventListener('submit', (event) => event.preventDefault());

  // Toggles and dropdowns save at once; typing waits for a pause.
  form.addEventListener('input', (event) => {
    showRelevant();
    if (event.target.name === 'lotteryLines') showLotteryLines();
    if (!isSetting(event.target)) return;
    if (event.target.dataset.secret) event.target.dataset.dirty = '1';
    const typing = event.target.matches('input:not([type="checkbox"]), textarea');
    clearTimeout(saveTimer);
    saveTimer = typing ? setTimeout(save, 600) : null;
    if (!typing) save();
  });

  // Leaving a field saves right away and shows the value that was actually
  // stored, for example a max delay raised to match the min delay.
  form.addEventListener('change', async (event) => {
    if (!isSetting(event.target) || event.target.type === 'checkbox' || event.target.tagName === 'SELECT') return;
    if (event.target.dataset.secret && !event.target.dataset.dirty) return;
    await save();
    const values = readFields();
    for (const name of [...TEXTS, ...NUMBERS]) field(name).value = values[name];
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && saveTimer) save();
  });

  let flashTimer = null;
  function flash(text, bad = false) {
    clearTimeout(flashTimer);
    $('saved').textContent = text;
    $('saved').classList.toggle('bad', bad);
    flashTimer = setTimeout(() => ($('saved').textContent = ''), 2500);
  }

  function download(name, value) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // ---------- data ----------

  function showBankSize(bank) {
    $('set-bankSize').textContent = msg('optionsBankSize', [String(Object.keys(bank).length)]);
  }

  async function showSpinCount() {
    const { spins = [] } = await store.get('spins');
    $('set-spinCount').textContent = msg('optionsSpinCount', [fmt.num.format(spins.length)]);
    return spins;
  }

  // Forbes z Chánova responses recorded for its model check (scripts/hotfix-sim.mjs).
  async function showHotfixCount() {
    const { hotfixRounds = [] } = await store.get('hotfixRounds');
    const free = hotfixRounds.filter((round) => round.path === '/api/hotfix/free').length;
    $('set-hotfixCount').textContent = msg('optionsHotfixCount', [fmt.num.format(hotfixRounds.length - free), fmt.num.format(free)]);
    return hotfixRounds;
  }

  // Which scatter rule reproduces the server, then the RTP that rule implies for
  // the current upgrades and for every upgrade maxed.
  $('set-checkModel').addEventListener('click', async () => {
    const spins = await showSpinCount();
    if (!spins.length) {
      $('set-modelResult').textContent = msg('optionsModelEmpty');
      return;
    }
    $('set-modelResult').textContent = msg('optionsModelRunning');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const check = Z.checkSpins(spins);
    const rate = (mode) => (check[mode].total ? check[mode].match / check[mode].total : 0);
    // Same pick as the bot (BotterOdds.blazeMode): per symbol only when it matches more spins.
    const best = O.blazeMode(check, 0);
    const current = spins[spins.length - 1].upgrades ?? {};
    const lines = Z.SCATTER_MODES.map((mode) => msg('optionsModelMatch', [msg(`scatter_${mode}`), fmt.pct.format(rate(mode)), fmt.num.format(check[mode].total)]));
    lines.push(
      msg('optionsModelRtp', [msg(`scatter_${best}`), fmt.pct.format(Z.simulateRtp(Z.config(current), best)), JSON.stringify(current)]),
      msg('optionsModelRtpMax', [fmt.pct.format(Z.simulateRtp(Z.config({ lucky: 5, wild: 5, star: 5 }), best))]),
    );
    if (rate(best) < 0.99) lines.push(msg('optionsModelMismatch'));
    else if (rate('symbols') === rate('reels')) lines.push(msg(O.blazeDecided(check) ? 'optionsModelSame' : 'optionsModelUndecided', [fmt.num.format(O.BLAZE_TIE_SPINS)]));
    $('set-modelResult').textContent = lines.join('\n');
  });

  $('set-exportSpins').addEventListener('click', async () => download('botter-blaze-spins.json', await showSpinCount()));
  $('set-clearSpins').addEventListener('click', async () => {
    if (!confirm(msg('optionsClearSpinsConfirm'))) return;
    await store.set({ spins: [] });
    showSpinCount();
    $('set-modelResult').textContent = '';
  });
  $('set-exportHotfix').addEventListener('click', async () => download('botter-hotfix-rounds.json', await showHotfixCount()));
  $('set-clearHotfix').addEventListener('click', async () => {
    if (!confirm(msg('optionsClearHotfixConfirm'))) return;
    await store.set({ hotfixRounds: [] });
    showHotfixCount();
  });
  $('set-exportCapture').addEventListener('click', async () => {
    const { capture = [] } = await store.get('capture');
    download('botter-capture.json', capture);
  });

  $('set-export').addEventListener('click', async () => {
    const { bank = {} } = await store.get('bank');
    download('botter-bank.json', bank);
  });
  $('set-importButton').addEventListener('click', () => $('set-import').click());
  $('set-import').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const incoming = JSON.parse(await file.text());
      const valid = Object.fromEntries(Object.entries(incoming).filter(([key, entry]) => window.BotterCore.isBankEntry(key, entry)));
      const { bank = {} } = await store.get('bank');
      const merged = { ...bank, ...valid };
      await store.set({ bank: merged });
      showBankSize(merged);
      flash(msg('optionsImported', [String(Object.keys(valid).length)]));
    } catch {
      flash(msg('optionsImportFailed'), true);
    }
  });
  $('set-clear').addEventListener('click', async () => {
    if (!confirm(msg('optionsClearConfirm'))) return;
    const stored = await store.get(null);
    await store.remove(['stats', ...Object.keys(stored).filter((key) => key.startsWith(STATS_PREFIX))]);
    await store.set({ bank: {} });
    showBankSize({});
    flash(msg('optionsCleared'));
  });

  // The backup is built on the server, which holds the keys and logins.
  $('set-exportAll').addEventListener('click', () => {
    const secrets = $('set-backupSecrets').checked;
    if (secrets && !confirm(msg('optionsBackupSecretsConfirm'))) return;
    const a = document.createElement('a');
    a.href = `/api/backup?secrets=${secrets ? 1 : 0}`;
    a.download = '';
    a.click();
  });
  $('set-importAllButton').addEventListener('click', () => $('set-importAll').click());
  $('set-importAll').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const backup = JSON.parse(await file.text());
      if (!confirm(msg('optionsImportAllConfirm', [backup.exportedAt ?? '-']))) return;
      const { counts, statsSkipped } = await store.post('/api/backup/import', { backup });
      await load();
      const summary = msg('optionsImportedAll', [String(counts.stats), String(counts.answers), String(counts.levels), String(counts.spins), String(counts.accounts)]);
      flash(statsSkipped ? `${summary} ${msg('optionsImportStatsSkipped')}` : summary);
    } catch {
      flash(msg('optionsImportAllFailed'), true);
    }
  });

  // ---------- statistics ----------

  function cell(text, tone, num = true) {
    const td = document.createElement('td');
    td.textContent = text;
    td.className = [num ? 'num' : '', tone ?? ''].join(' ').trim();
    return td;
  }
  const label = (text) => cell(text, '', false);
  const tone = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');
  const upgradeText = (upgrades) => Object.entries(upgrades).map(([name, level]) => `${name} ${level}`).join(', ');
  const row = (cells) => {
    const tr = document.createElement('tr');
    tr.append(...cells);
    return tr;
  };

  // Speed and server responses (the bot's `net`): game requests and all
  // responses in the last minute, the average gap between the last game
  // requests against the minimum set, then per path the responses seen, the
  // bot's own calls, errors, rate limits with retries and the bot's average
  // time, busiest first, and the last errors.
  let netShown = null;
  function showNet(net = netShown) {
    netShown = net;
    const now = Date.now();
    const starts = net?.starts ?? [];
    const lastMinute = (times) => times.filter((t) => now - t < 60_000).length;
    const recent = starts.slice(-20);
    const gap = recent.length > 1 ? (recent.at(-1) - recent[0]) / (recent.length - 1) / 1000 : null;
    const minimum = field('maxSpeed').checked ? 0 : (Number(field('gameDelayMs').value) || 0) / 1000;
    $('st-netSpeed').textContent = net
      ? msg('optionsNetSpeed', [fmt.num.format(lastMinute(starts)), gap === null ? '-' : fmt.seconds.format(gap), fmt.seconds.format(minimum), fmt.num.format(lastMinute(net.seen ?? [])), fmt.when.format(net.since)])
      : '';
    const rows = Object.entries(net?.paths ?? {})
      .sort(([, a], [, b]) => b.seen + b.bot - (a.seen + a.bot))
      .map(([path, item]) =>
        row([
          label(path),
          cell(fmt.num.format(item.seen)),
          cell(fmt.num.format(item.bot)),
          cell(fmt.num.format(item.errors), item.errors ? 'neg' : ''),
          cell(`${fmt.num.format(item.limited)} / ${fmt.num.format(item.retries)}`, item.limited ? 'neg' : ''),
          cell(item.bot ? `${fmt.num.format(item.ms / item.bot)} ms` : '-'),
        ]),
      );
    $('st-netBody').replaceChildren(...rows);
    $('st-netErrors').replaceChildren(
      ...(net?.errors ?? []).map((e) => row([label(fmt.clock.format(e.at)), label(e.path), label(e.status ? String(e.status) : msg('optionsNetNoAnswer')), label(e.error || '-')])),
    );
    $('st-netEmpty').hidden = rows.length > 0;
  }
  $('st-resetNet').addEventListener('click', () => store.set({ net: null, netReset: Date.now() }));
  // The last-minute figures age even when nothing new is saved.
  setInterval(() => showNet(), 5000);

  function profitRow(name, item) {
    return row([
      label(name),
      cell(fmt.num.format(item.rounds)),
      cell(item.wagered ? fmt.num.format(item.wagered) : '-'),
      cell(item.wagered ? fmt.num.format(item.returned) : '-'),
      cell(fmt.signed.format(item.net), tone(item.net)),
      cell(item.rtp === null ? '-' : fmt.pct.format(item.rtp)),
      cell(item.perRound === null ? '-' : fmt.signed.format(item.perRound), tone(item.perRound)),
      cell(fmt.num.format(item.xp)),
    ]);
  }

  function showProfit(stats = {}) {
    const rows = G.profitRows(stats.games ?? {}).map((item) => profitRow(msg(`game_${item.game}`), item));
    const work = stats.work;
    if (work?.tickets > 0) {
      rows.push(profitRow(msg('panelWork'), { rounds: work.tickets, wagered: 0, returned: 0, net: work.net, rtp: null, perRound: work.net / work.tickets, xp: work.xp }));
    }
    const free = stats.free ?? {};
    for (const [kind, amount] of Object.entries(free)) {
      if (amount) rows.push(profitRow(msg(`free_${kind}`), { rounds: 0, wagered: 0, returned: 0, net: amount, rtp: null, perRound: null, xp: 0 }));
    }
    $('st-profitBody').replaceChildren(...rows);
    const total = G.totalNet(stats.games ?? {}) + (work?.net ?? 0) + Object.values(free).reduce((sum, amount) => sum + amount, 0);
    const foot = row([label(msg('colTotal')), cell(''), cell(''), cell(''), cell(fmt.signed.format(total), tone(total)), cell(''), cell(''), cell('')]);
    $('st-profitFoot').replaceChildren(...(rows.length ? [foot] : []));
    $('st-profitEmpty').hidden = rows.length > 0;
    showCombos(stats.combos ?? {});
    showRoulette(stats.roulette ?? {});
    showBaccarat(stats.baccarat ?? {});
    showTables(stats.dice ?? {}, stats.cases ?? {});
  }

  // Baccarat model check per upgrade combination (BotterBaccarat.addHand).
  function showBaccarat(check) {
    const B = window.BotterBaccarat;
    const odds = B.outcomes();
    const pairChance = 1 - (1 - B.PAIR_CHANCE) ** 2;
    const share = (seen, chance, hands) => `${fmt.num.format(seen)} / ${fmt.num.format(Math.round(chance * hands))}`;
    const rows = Object.entries(check)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([combo, item]) => {
        const hidden = item.wagered ? (item.paid - item.wagered - item.net) / item.wagered : null;
        return row([
          label(upgradeText(O.comboUpgrades('baccarat', combo))),
          cell(fmt.num.format(item.hands)),
          cell(['player', 'banker', 'tie'].map((w) => share(item[w], odds[w], item.hands)).join(' · ')),
          cell(share(item.pairs, pairChance, item.hands)),
          cell(item.checkedWagered ? fmt.pct.format(item.checkedPaid / item.checkedWagered) : '-'),
          cell(item.checkedWagered ? fmt.pct.format(item.expected / item.checkedWagered) : '-'),
          cell(hidden === null ? '-' : fmt.pct.format(hidden), hidden !== null && Math.abs(hidden) >= 0.001 ? 'neg' : ''),
          cell(fmt.num.format(item.drawErrors + item.winnerErrors), item.drawErrors + item.winnerErrors ? 'neg' : ''),
          cell(`${fmt.num.format(item.payErrors)} / ${fmt.num.format(item.checked)}`, item.payErrors || item.checked < item.hands ? 'neg' : ''),
        ]);
      });
    $('st-baccaratBody').replaceChildren(...rows);
    $('st-baccaratEmpty').hidden = rows.length > 0;
  }

  // Kostky and Case opening model checks per upgrade combination.
  function showTables(dice, cases) {
    const K = window.BotterCases;
    const share = (seen, chance, rounds) => `${fmt.num.format(seen)} / ${fmt.num.format(Math.round(chance * rounds))}`;
    const rows = [];
    const add = (game, combo, item, rounds, rare, model, checked) => {
      const hidden = item.wagered ? (item.paid - item.wagered - item.net) / item.wagered : null;
      rows.push(
        row([
          label(msg(`game_${game}`)),
          label(upgradeText(O.comboUpgrades(game, combo))),
          cell(fmt.num.format(rounds)),
          cell(rare),
          cell(item.wagered ? fmt.pct.format(item.paid / item.wagered) : '-'),
          cell(model === null ? '-' : fmt.pct.format(model)),
          cell(hidden === null ? '-' : fmt.pct.format(hidden), hidden !== null && Math.abs(hidden) >= 0.001 ? 'neg' : ''),
          cell(`${fmt.num.format(item.payErrors)} / ${fmt.num.format(checked)}`, item.payErrors ? 'neg' : ''),
        ]),
      );
    };
    for (const [combo, item] of Object.entries(dice).sort(([a], [b]) => a.localeCompare(b))) {
      const model = item.checkedWagered ? item.expected / item.checkedWagered : null;
      add('dice', combo, item, item.rolls, share(item.triples, 1 / 36, item.rolls), model, item.checked);
    }
    for (const [combo, item] of Object.entries(cases).sort(([a], [b]) => a.localeCompare(b))) {
      const upgrades = O.comboUpgrades('cases', combo);
      const rare = ['red', 'gold'].map((r) => share(item.rarities?.[r] ?? 0, K.chance(r, upgrades), item.opens)).join(' · ');
      add('cases', combo, item, item.opens, rare, K.rtp(upgrades), item.opens - item.unknown);
    }
    $('st-tablesBody').replaceChildren(...rows);
    $('st-tablesEmpty').hidden = rows.length > 0;
  }

  // Roulette model check per zeros level (G.addRouletteSpin).
  function showRoulette(check) {
    const rows = Object.entries(check)
      .sort(([a], [b]) => a - b)
      .map(([zeros, item]) => {
        const left = 1 + O.ROULETTE_EXTRA_ZEROS - Number(zeros);
        const greens = (item.spins * left) / (37 + O.ROULETTE_EXTRA_ZEROS - Number(zeros));
        const deviations = item.variance > 0 ? (item.checkedPaid - item.expected) / Math.sqrt(item.variance) : null;
        const hidden = item.wagered ? (item.paid - item.wagered - item.net) / item.wagered : null;
        return row([
          label(fmt.num.format(left)),
          cell(fmt.num.format(item.spins)),
          cell(`${fmt.num.format(item.greens)} / ${fmt.num.format(greens)}`),
          cell(item.checkedWagered ? fmt.pct.format(item.checkedPaid / item.checkedWagered) : '-'),
          cell(item.checkedWagered ? fmt.pct.format(item.expected / item.checkedWagered) : '-'),
          cell(deviations === null ? '-' : fmt.signed.format(deviations), deviations !== null && Math.abs(deviations) >= 3 ? 'neg' : ''),
          cell(hidden === null ? '-' : fmt.pct.format(hidden), hidden !== null && Math.abs(hidden) >= 0.001 ? 'neg' : ''),
          // Spins with a bet spot the rules check does not know are not checked.
          cell(`${fmt.num.format(item.mismatches)} / ${fmt.num.format(item.checked)}`, item.mismatches || item.checked < item.spins ? 'neg' : ''),
        ]);
      });
    $('st-rouletteBody').replaceChildren(...rows);
    $('st-rouletteEmpty').hidden = rows.length > 0;
  }

  // Profit per game and upgrade combination, next to the model's return.
  function showCombos(combos) {
    const rows = [];
    for (const game of G.GAME_KEYS) {
      for (const item of G.profitRows(combos[game] ?? {}).sort((a, b) => a.game.localeCompare(b.game))) {
        const upgrades = O.comboUpgrades(game, item.game);
        const model = O.rtp(game, { [game]: upgrades });
        rows.push(
          row([
            label(msg(`game_${game}`)),
            label(upgradeText(upgrades)),
            cell(fmt.num.format(item.rounds)),
            cell(fmt.num.format(item.wagered)),
            cell(fmt.signed.format(item.net), tone(item.net)),
            cell(item.rtp === null ? '-' : fmt.pct.format(item.rtp)),
            cell(model === null ? '-' : fmt.pct.format(model)),
            cell(fmt.num.format(item.xp)),
          ]),
        );
      }
    }
    $('st-comboBody').replaceChildren(...rows);
    $('st-comboEmpty').hidden = rows.length > 0;
  }

  // Sum of two model check rows, field by field, nested counts included.
  function addCounts(a, b) {
    const out = Array.isArray(b) ? [...(a ?? [])] : { ...a };
    for (const [key, value] of Object.entries(b)) {
      out[key] = typeof value === 'object' && value !== null ? addCounts(out[key], value) : (out[key] ?? 0) + value;
    }
    return out;
  }

  // Totals of several accounts' stats, for the "all accounts" view.
  function sumStats(list) {
    const total = { games: {}, combos: {}, roulette: {}, baccarat: {}, dice: {}, cases: {}, work: { tickets: 0, net: 0, xp: 0 }, free: {} };
    for (const stats of list) {
      for (const [game, item] of Object.entries(stats.games ?? {})) G.addDelta(total.games, { game, ...item });
      for (const [game, rows] of Object.entries(stats.combos ?? {})) {
        for (const [combo, item] of Object.entries(rows)) G.addDelta((total.combos[game] ??= {}), { ...item, game: combo });
      }
      for (const check of ['roulette', 'baccarat', 'dice', 'cases']) {
        for (const [key, item] of Object.entries(stats[check] ?? {})) total[check][key] = addCounts(total[check][key], item);
      }
      for (const key of Object.keys(total.work)) total.work[key] += stats.work?.[key] ?? 0;
      for (const [kind, amount] of Object.entries(stats.free ?? {})) total.free[kind] = (total.free[kind] ?? 0) + amount;
    }
    return total;
  }

  let profitStats = {}; // account id -> stats; '' holds stats from before accounts existed
  let profitChoice = ALL_ACCOUNTS;
  let profitOptions = '';

  const showChosenProfit = () => showProfit(profitChoice === ALL_ACCOUNTS ? sumStats(Object.values(profitStats)) : profitStats[profitChoice]);

  async function showAccounts() {
    const stored = await store.get(null);
    const accounts = byPrefix(stored, ACCOUNT_PREFIX);
    markOdds(accounts);
    profitStats = byPrefix(stored, STATS_PREFIX);
    if (stored.stats) profitStats[''] = stored.stats;
    const name = (id) => (id === '' ? msg('accountLegacy') : (accounts[id]?.login ?? id.slice(0, 8)));
    const choices = [[ALL_ACCOUNTS, msg('optionsProfitAll')], ...Object.keys(profitStats).map((id) => [id, name(id)])];
    if (!profitStats[profitChoice]) profitChoice = ALL_ACCOUNTS;
    // Rebuilt only when the list changes, so a game round does not close an open dropdown.
    const signature = JSON.stringify(choices);
    if (signature !== profitOptions) {
      profitOptions = signature;
      $('st-profitAccount').replaceChildren(...choices.map(([id, text]) => new Option(text, id)));
    }
    $('st-profitAccount').value = profitChoice;
    showChosenProfit();
  }
  $('st-profitAccount').addEventListener('change', (event) => {
    profitChoice = event.target.value;
    showChosenProfit();
  });

  // Odds of every game and upgrade combination (BotterOdds.table). Rows
  // matching the upgrades of the account seen last are marked.
  let oddsRows = [];
  let blazeSummaries = {}; // scatter rule -> its odds table summary, see markBlazeRule

  function buildOdds() {
    oddsRows = [];
    blazeSummaries = {};
    const groups = [];
    for (const game of G.GAME_KEYS.filter((g) => O.UPGRADES[g])) {
      for (const mode of game === 'blaze' ? Z.SCATTER_MODES : [undefined]) {
        const rows = O.table(game, mode);
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = mode
          ? msg('oddsGameRule', [msg(`game_${game}`), msg(`scatter_${mode}`), fmt.num.format(rows.length)])
          : msg('oddsGame', [msg(`game_${game}`), fmt.num.format(rows.length)]);
        if (mode) blazeSummaries[mode] = summary;
        const head = document.createElement('tr');
        ['colUpgrades', 'colRtp', 'colRoundWon', 'colAhead1000', 'colWinsRtp'].forEach((key, i) => {
          const th = document.createElement('th');
          th.scope = 'col';
          if (i) th.className = 'num';
          th.textContent = msg(key);
          head.append(th);
        });
        const thead = document.createElement('thead');
        thead.append(head);
        const tbody = document.createElement('tbody');
        for (const item of rows) {
          const tr = row([
            label(upgradeText(item.upgrades)),
            cell(item.rtp === null ? '-' : fmt.pct.format(item.rtp)),
            cell(item.win === undefined ? '-' : fmt.pct.format(item.win)),
            cell(item.ahead === undefined ? '-' : fmt.pct.format(item.ahead)),
            // Return on a Konec kvartálu weekend: the bonus adds to every round that ends ahead.
            cell(item.rtp === null || item.gain === null || item.gain === undefined ? '-' : fmt.pct.format(item.rtp + A.WINS_BONUS * item.gain)),
          ]);
          tbody.append(tr);
          oddsRows.push({ game, upgrades: item.upgrades, tr });
        }
        const table = document.createElement('table');
        table.className = 'data';
        table.append(thead, tbody);
        const wrap = document.createElement('div');
        wrap.className = 'table-wrap';
        wrap.append(table);
        details.append(summary, wrap);
        groups.push(details);
      }
    }
    $('st-oddsTables').replaceChildren(...groups);
  }

  // Once the recorded spins settle the Blaze star rule (BotterOdds.blazeDecided),
  // the other rule's odds table says it is ruled out.
  async function markBlazeRule() {
    const { spins = [] } = await store.get('spins');
    const check = Z.checkSpins(spins);
    if (!O.blazeDecided(check)) return;
    const kept = O.blazeMode(check);
    for (const [mode, summary] of Object.entries(blazeSummaries)) {
      if (mode !== kept) summary.textContent += msg('oddsRuledOut', [fmt.num.format(check[mode].total)]);
    }
  }

  function markOdds(accounts) {
    const last = Object.values(accounts).reduce((a, b) => ((b.seenAt ?? 0) > (a?.seenAt ?? 0) ? b : a), null);
    for (const { game, upgrades, tr } of oddsRows) {
      const own = last?.upgrades?.[game] ?? {};
      const max = Object.fromEntries(O.UPGRADES[game]);
      const current = !!last?.upgrades && Object.entries(upgrades).every(([name, level]) => Math.min(own[name] ?? 0, max[name]) === level);
      if (current) tr.setAttribute('aria-current', 'true');
      else tr.removeAttribute('aria-current');
    }
  }

  // Level curve seen by the bot (G.recordLevel): XP per level, its growth over
  // the level below, the level-up reward and the daily bonus at a 7-day streak.
  function showLevels(levels = {}) {
    const rows = Object.keys(levels)
      .map(Number)
      .sort((a, b) => a - b)
      .map((level) => {
        const { xpNeed, reward } = levels[level];
        const below = levels[level - 1]?.xpNeed;
        const growth = xpNeed > 0 && below > 0 ? xpNeed / below - 1 : null;
        return row([
          label(fmt.num.format(level)),
          cell(xpNeed === undefined ? '-' : fmt.num.format(xpNeed)),
          cell(growth === null ? '-' : `${fmt.signed.format(growth * 100)} %`),
          cell(reward === undefined ? '-' : fmt.num.format(reward)),
          cell(fmt.num.format(G.dailyBonus(7, level))),
        ]);
      });
    $('st-levelsBody').replaceChildren(...rows);
    $('st-levelsEmpty').hidden = rows.length > 0;
  }

  async function loadStats() {
    const { net = null, levels } = await store.get(['net', 'levels']);
    showNet(net);
    showLevels(levels);
    await showAccounts();
  }

  store.onChanged((changes) => {
    const keys = Object.keys(changes);
    if (keys.some((key) => key === 'stats' || key.startsWith(STATS_PREFIX) || key.startsWith(ACCOUNT_PREFIX))) showAccounts();
    if (changes.bank) showBankSize(changes.bank.newValue ?? {});
    if (changes.levels) showLevels(changes.levels.newValue);
    if (changes.hotfixRounds) showHotfixCount();
    if (changes.spins) showSpinCount();
    if (changes.net) showNet(changes.net.newValue ?? null);
    if (changes.settings && !saveTimer) fill({ ...DEFAULTS, ...changes.settings.newValue });
    for (const key of SECRETS) if (changes[key] && secretField(key) !== document.activeElement) showSecret(key, !!changes[key].newValue);
  });

  // Labels, dropdowns and tables in the dashboard's language.
  async function relabel() {
    formats();
    applyMessages();
    fillOptions();
    buildOdds();
    await store.ready;
    await Promise.all([load(), loadStats()]);
    markBlazeRule();
  }

  window.BotterSettings = { relabel, showSettings: showSettingsSection, showStats: showStatsSection };
})();
