const msg = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

const CHECKBOXES = [
  'guessUnknown',
  'stopAtNorm',
  'autoClaim',
  'repayDebt',
  'autoBankrupt',
  'loanCycle',
  'loanTrick',
  'standup',
  'crashEnabled',
  'buyUpgrades',
  'saveForUpgrades',
  'recordSpins',
  'captureDebug',
  'panelHidden',
  'rotateAccounts',
  'playOnScreen',
];
const SELECTS = ['aiSolver', 'model', 'effort', 'logLevel', 'rouletteBet', 'grindLimit', 'grindGame', 'grindBet'];
const INT_SELECTS = ['gameBet', 'crashBet'];
const TEXTS = ['openrouterModel'];
const NUMBERS = [
  'minDelayMs',
  'maxDelayMs',
  'stopLoss',
  'takeProfit',
  'reserve',
  'gameDelayMs',
  'crashMinEv',
  'crashKelly',
  'xpBudget',
  'grindMinBalance',
  'grindExploreRounds',
];
const DEFAULTS = {
  aiSolver: 'local',
  guessUnknown: true,
  stopAtNorm: false,
  autoClaim: true,
  repayDebt: true,
  autoBankrupt: true,
  loanCycle: true,
  loanTrick: true,
  standup: true,
  crashEnabled: true,
  crashBet: 100,
  crashMinEv: 1.05,
  crashKelly: 0.5,
  grindLimit: 'daily',
  xpBudget: 0,
  grindMinBalance: 0,
  grindGame: 'auto',
  grindBet: 'auto',
  grindExploreRounds: 30,
  buyUpgrades: false,
  saveForUpgrades: true,
  recordSpins: true,
  captureDebug: false,
  panelHidden: false,
  rotateAccounts: true,
  playOnScreen: false,
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
  gameDelayMs: 800,
};

const G = globalThis.BotterGames;
const locale = chrome.i18n.getUILanguage();
const num = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
const signed = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, signDisplay: 'exceptZero' });
const pct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
const when = new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' });

// Same storage layout as the content script: one key per account.
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
const field = (name) => document.querySelector(`[name="${name}"]`);

for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = msg(el.dataset.i18n);
for (const el of document.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', msg(el.dataset.i18nLabel));
document.documentElement.lang = locale;

for (const name of INT_SELECTS) {
  for (const bet of G.BET_LEVELS) field(name).add(new Option(num.format(bet), String(bet)));
}
for (const key of G.ROULETTE_BETS) field('rouletteBet').add(new Option(msg(`roulette_${key}`), key));
field('grindGame').add(new Option(msg('grind_auto'), 'auto'));
for (const game of G.GAME_KEYS) field('grindGame').add(new Option(msg(`game_${game}`), game));
field('grindBet').add(new Option(msg('grindBet_auto'), 'auto'));
for (const bet of G.BET_LEVELS) field('grindBet').add(new Option(num.format(bet), String(bet)));

async function load() {
  const { settings = {}, apiKey = '', openrouterKey = '', bank = {} } = await chrome.storage.local.get([
    'settings',
    'apiKey',
    'openrouterKey',
    'bank',
  ]);
  fill({ ...DEFAULTS, ...settings });
  $('apiKey').value = apiKey;
  $('openrouterKey').value = openrouterKey;
  showBankSize(bank);
  showLocalStatus();
  showAccounts();
  showSpinCount();
}

// Skips the field being edited, so a save or a change made from the in-page
// panel never yanks text out from under the cursor.
function fill(values) {
  for (const name of CHECKBOXES) field(name).checked = values[name];
  for (const name of [...SELECTS, ...INT_SELECTS, ...TEXTS, ...NUMBERS]) {
    if (field(name) !== document.activeElement) field(name).value = values[name];
  }
  showRelevant();
}

// data-when="name" shows an element while that checkbox is ticked or that
// number is above 0; data-when="name:value" while that field equals value.
// Space-separated conditions must all hold; "|" separates alternatives.
function holds(condition) {
  const [name, value] = condition.split(':');
  const el = field(name);
  if (el.type === 'checkbox') return el.checked;
  if (value !== undefined) return el.value === value;
  return Number(el.value) > 0;
}

const shown = (when) => when.split('|').some((all) => all.trim().split(/\s+/).every(holds));

function showRelevant() {
  for (const el of document.querySelectorAll('[data-when]')) el.hidden = !shown(el.dataset.when);
}

// ---------- tabs ----------

const tabs = [...document.querySelectorAll('[role="tab"]')];

function selectTab(tab, focus = false) {
  for (const t of tabs) {
    const selected = t === tab;
    t.setAttribute('aria-selected', String(selected));
    t.tabIndex = selected ? 0 : -1;
    $(t.getAttribute('aria-controls')).hidden = !selected;
  }
  if (focus) tab.focus();
  try {
    localStorage.setItem('tab', tab.id);
  } catch {}
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    const i = tabs.indexOf(tab);
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectTab(tabs[(next + tabs.length) % tabs.length], true);
  });
}

let lastTab = null;
try {
  lastTab = $(localStorage.getItem('tab'));
} catch {}
selectTab(tabs.includes(lastTab) ? lastTab : tabs[0]);

// ---------- autosave ----------

const SETTING_NAMES = new Set([...CHECKBOXES, ...SELECTS, ...INT_SELECTS, ...TEXTS, ...NUMBERS]);
const KEY_IDS = ['apiKey', 'openrouterKey'];
const isSetting = (el) => SETTING_NAMES.has(el.name) || KEY_IDS.includes(el.id);

function readFields() {
  const next = {};
  for (const name of CHECKBOXES) next[name] = field(name).checked;
  for (const name of SELECTS) next[name] = field(name).value;
  for (const name of INT_SELECTS) next[name] = Number(field(name).value);
  for (const name of TEXTS) next[name] = field(name).value.trim();
  for (const name of NUMBERS) next[name] = Math.max(0, Number(field(name).value) || 0);
  next.crashMinEv = Math.max(1, next.crashMinEv);
  next.crashKelly = Math.max(0, Math.min(1, next.crashKelly));
  if (next.maxDelayMs < next.minDelayMs) next.maxDelayMs = next.minDelayMs;
  return next;
}

let saveTimer = null;

// Merges into the stored settings so keys owned by the in-page panel
// (enabled, autoMode, game, taskType) survive.
async function save() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({
      settings: { ...settings, ...readFields() },
      apiKey: $('apiKey').value.trim(),
      openrouterKey: $('openrouterKey').value.trim(),
    });
    flash(msg('optionsSaved'));
  } catch (err) {
    flash(msg('optionsSaveFailed', [err.message]));
  }
}

// Toggles and dropdowns save at once; typing waits for a pause.
document.querySelector('main').addEventListener('input', (event) => {
  showRelevant();
  if (!isSetting(event.target)) return;
  const typing = event.target.matches('input:not([type="checkbox"]), textarea');
  clearTimeout(saveTimer);
  saveTimer = typing ? setTimeout(save, 600) : null;
  if (!typing) save();
});

// Leaving a field saves right away and shows the value that was actually
// stored, for example a max delay raised to match the min delay.
document.querySelector('main').addEventListener('change', async (event) => {
  if (!isSetting(event.target) || event.target.type === 'checkbox' || event.target.tagName === 'SELECT') return;
  await save();
  const values = readFields();
  for (const name of [...TEXTS, ...NUMBERS]) field(name).value = values[name];
});

// Closing the side panel mid-debounce must not drop the last edit.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && saveTimer) save();
});

const Z = globalThis.BotterBlaze;
const pct2 = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });

async function showSpinCount() {
  const { spins = [] } = await chrome.storage.local.get('spins');
  $('spinCount').textContent = msg('optionsSpinCount', [num.format(spins.length)]);
  return spins;
}

function download(name, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Which scatter rule reproduces the server, then the RTP that rule implies for
// the current upgrades and for every upgrade maxed.
$('checkModel').addEventListener('click', async () => {
  const spins = await showSpinCount();
  if (!spins.length) {
    $('modelResult').textContent = msg('optionsModelEmpty');
    return;
  }
  $('modelResult').textContent = msg('optionsModelRunning');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const check = Z.checkSpins(spins);
  const rate = (mode) => (check[mode].total ? check[mode].match / check[mode].total : 0);
  const best = Z.SCATTER_MODES.reduce((a, b) => (rate(b) > rate(a) ? b : a));
  const current = spins[spins.length - 1].upgrades ?? {};
  const lines = Z.SCATTER_MODES.map((mode) =>
    msg('optionsModelMatch', [msg(`scatter_${mode}`), pct2.format(rate(mode)), num.format(check[mode].total)]),
  );
  lines.push(
    msg('optionsModelRtp', [msg(`scatter_${best}`), pct2.format(Z.simulateRtp(Z.config(current), best)), JSON.stringify(current)]),
    msg('optionsModelRtpMax', [pct2.format(Z.simulateRtp(Z.config({ lucky: 5, wild: 5, star: 5 }), best))]),
  );
  if (rate(best) < 0.99) lines.push(msg('optionsModelMismatch'));
  $('modelResult').textContent = lines.join('\n');
});

$('exportSpins').addEventListener('click', async () => download('botter-blaze-spins.json', await showSpinCount()));

$('clearSpins').addEventListener('click', async () => {
  if (!confirm(msg('optionsClearSpinsConfirm'))) return;
  await chrome.storage.local.set({ spins: [] });
  showSpinCount();
  $('modelResult').textContent = '';
});

$('exportCapture').addEventListener('click', async () => {
  const { capture = [] } = await chrome.storage.local.get('capture');
  download('botter-capture.json', capture);
});

function cell(text, tone) {
  const td = document.createElement('td');
  td.textContent = text;
  if (tone) td.className = tone;
  return td;
}

const tone = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

function profitRow(label, row) {
  const tr = document.createElement('tr');
  tr.append(
    cell(label),
    cell(num.format(row.rounds)),
    cell(row.wagered ? num.format(row.wagered) : '-'),
    cell(row.wagered ? num.format(row.returned) : '-'),
    cell(signed.format(row.net), tone(row.net)),
    cell(row.rtp === null ? '-' : pct.format(row.rtp)),
    cell(row.perRound === null ? '-' : signed.format(row.perRound), tone(row.perRound)),
    cell(num.format(row.xp)),
  );
  return tr;
}

function showProfit(stats = {}) {
  const rows = G.profitRows(stats.games ?? {}).map((row) => profitRow(msg(`game_${row.game}`), row));
  const work = stats.work;
  if (work?.tickets > 0) {
    rows.push(
      profitRow(msg('panelWork'), {
        rounds: work.tickets,
        wagered: 0,
        returned: 0,
        net: work.net,
        rtp: null,
        perRound: work.net / work.tickets,
        xp: work.xp,
      }),
    );
  }
  const free = stats.free ?? {};
  for (const [kind, amount] of Object.entries(free)) {
    if (!amount) continue;
    rows.push(profitRow(msg(`free_${kind}`), { rounds: 0, wagered: 0, returned: 0, net: amount, rtp: null, perRound: null, xp: 0 }));
  }
  $('profitBody').replaceChildren(...rows);
  const total =
    G.totalNet(stats.games ?? {}) + (work?.net ?? 0) + Object.values(free).reduce((sum, amount) => sum + amount, 0);
  const foot = document.createElement('tr');
  foot.append(cell(msg('colTotal')), ...Array(3).fill().map(() => cell('')), cell(signed.format(total), tone(total)));
  $('profitFoot').replaceChildren(...(rows.length ? [foot] : []));
  $('profitEmpty').hidden = rows.length > 0;
}

// Totals of several accounts' stats, for the "all accounts" profit view.
function sumStats(list) {
  const total = { games: {}, work: { tickets: 0, net: 0, xp: 0 }, free: {} };
  for (const stats of list) {
    for (const [game, row] of Object.entries(stats.games ?? {})) G.addDelta(total.games, { game, ...row });
    for (const key of Object.keys(total.work)) total.work[key] += stats.work?.[key] ?? 0;
    for (const [kind, amount] of Object.entries(stats.free ?? {})) total.free[kind] = (total.free[kind] ?? 0) + amount;
  }
  return total;
}

let profitStats = {}; // account id -> stats; '' holds stats from before accounts existed
let profitChoice = ALL_ACCOUNTS;
let profitOptions = '';

function showChosenProfit() {
  const chosen = profitChoice === ALL_ACCOUNTS ? sumStats(Object.values(profitStats)) : profitStats[profitChoice];
  showProfit(chosen);
}

function forgetAccount(id, login) {
  if (!confirm(msg('optionsForgetConfirm', [login]))) return;
  chrome.storage.local.remove(ACCOUNT_PREFIX + id);
}

function showAccountRows(accounts) {
  const now = Date.now();
  const rows = Object.entries(accounts)
    .sort(([, a], [, b]) => (b.seenAt ?? 0) - (a.seenAt ?? 0))
    .map(([id, saved]) => {
      const login = saved.login ?? id;
      const forget = document.createElement('button');
      forget.type = 'button';
      forget.textContent = msg('optionsForget');
      forget.setAttribute('aria-label', msg('optionsForgetLabel', [login]));
      forget.addEventListener('click', () => forgetAccount(id, login));
      const actions = document.createElement('td');
      actions.append(forget);
      const energy = saved.work ? `${G.energyNow(saved.work, now)}/${saved.work.maxEnergy ?? 20}` : '-';
      const tr = document.createElement('tr');
      tr.append(
        cell(saved.session ? login : msg('optionsAccountNoLogin', [login])),
        cell(saved.level == null ? '-' : num.format(saved.level)),
        cell(saved.credits == null ? '-' : num.format(saved.credits)),
        cell(energy),
        cell(saved.seenAt ? when.format(saved.seenAt) : '-'),
        actions,
      );
      return tr;
    });
  $('accountsBody').replaceChildren(...rows);
  $('accountsEmpty').hidden = rows.length > 0;
}

async function showAccounts() {
  const stored = await chrome.storage.local.get(null);
  const accounts = byPrefix(stored, ACCOUNT_PREFIX);
  showAccountRows(accounts);

  profitStats = byPrefix(stored, STATS_PREFIX);
  if (stored.stats) profitStats[''] = stored.stats;
  const label = (id) => (id === '' ? msg('accountLegacy') : (accounts[id]?.login ?? id.slice(0, 8)));
  const choices = [[ALL_ACCOUNTS, msg('optionsProfitAll')], ...Object.keys(profitStats).map((id) => [id, label(id)])];
  if (!profitStats[profitChoice]) profitChoice = ALL_ACCOUNTS;
  // Rebuilt only when the list changes, so a game round does not close an open dropdown.
  const signature = JSON.stringify(choices);
  if (signature !== profitOptions) {
    profitOptions = signature;
    $('profitAccount').replaceChildren(...choices.map(([id, text]) => new Option(text, id)));
  }
  $('profitAccount').value = profitChoice;
  showChosenProfit();
}

$('profitAccount').addEventListener('change', (event) => {
  profitChoice = event.target.value;
  showChosenProfit();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const keys = Object.keys(changes);
  if (keys.some((key) => key === 'stats' || key.startsWith(STATS_PREFIX) || key.startsWith(ACCOUNT_PREFIX))) showAccounts();
  if (changes.bank) showBankSize(changes.bank.newValue ?? {});
  if (changes.settings && !saveTimer) fill({ ...DEFAULTS, ...changes.settings.newValue });
});

async function showLocalStatus(state) {
  state ??= await BotterLocal.availability().catch(() => 'unavailable');
  $('localStatus').textContent = msg('optionsLocalStatus', [msg(`localState_${state}`)]);
  $('prepareLocal').hidden = state !== 'downloadable' && state !== 'downloading';
  $('localFlags').hidden = state === 'available';
}

// The first create() downloads Gemini Nano and needs this click as user activation.
$('prepareLocal').addEventListener('click', async () => {
  $('prepareLocal').disabled = true;
  try {
    const session = await BotterLocal.create((monitor) => {
      monitor.addEventListener('downloadprogress', (e) => {
        $('localStatus').textContent = msg('optionsLocalProgress', [String(Math.round(e.loaded * 100))]);
      });
    });
    session.destroy();
    await showLocalStatus();
  } catch (err) {
    $('localStatus').textContent = msg('optionsLocalFailed', [err.message]);
    $('localFlags').hidden = false;
  } finally {
    $('prepareLocal').disabled = false;
  }
});

function showBankSize(bank) {
  $('bankSize').textContent = msg('optionsBankSize', [String(Object.keys(bank).length)]);
}

let flashTimer = null;

function flash(text) {
  clearTimeout(flashTimer);
  $('saved').textContent = text;
  flashTimer = setTimeout(() => ($('saved').textContent = ''), 2500);
}

$('export').addEventListener('click', async () => {
  const { bank = {} } = await chrome.storage.local.get('bank');
  download('botter-bank.json', bank);
});

$('importButton').addEventListener('click', () => $('import').click());

$('import').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const incoming = JSON.parse(await file.text());
    const valid = Object.fromEntries(Object.entries(incoming).filter(([key, entry]) => BotterCore.isBankEntry(key, entry)));
    const { bank = {} } = await chrome.storage.local.get('bank');
    const merged = { ...bank, ...valid };
    await chrome.storage.local.set({ bank: merged });
    showBankSize(merged);
    flash(msg('optionsImported', [String(Object.keys(valid).length)]));
  } catch {
    flash(msg('optionsImportFailed'));
  }
});

$('clear').addEventListener('click', async () => {
  if (!confirm(msg('optionsClearConfirm'))) return;
  const stored = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(['stats', ...Object.keys(stored).filter((key) => key.startsWith(STATS_PREFIX))]);
  await chrome.storage.local.set({ bank: {} });
  showBankSize({});
  flash(msg('optionsCleared'));
});

load();
