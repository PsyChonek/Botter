const msg = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

const CHECKBOXES = ['guessUnknown', 'stopAtNorm', 'autoClaim'];
const SELECTS = ['aiSolver', 'model', 'effort', 'logLevel', 'rouletteBet'];
const INT_SELECTS = ['gameBet'];
const TEXTS = ['openrouterModel'];
const NUMBERS = ['minDelayMs', 'maxDelayMs', 'stopLoss', 'takeProfit', 'reserve', 'gameDelayMs'];
const DEFAULTS = {
  aiSolver: 'local',
  guessUnknown: true,
  stopAtNorm: false,
  autoClaim: true,
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

const $ = (id) => document.getElementById(id);
const field = (name) => document.querySelector(`[name="${name}"]`);

for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = msg(el.dataset.i18n);
document.documentElement.lang = locale;

for (const bet of G.BET_LEVELS) field('gameBet').add(new Option(num.format(bet), String(bet)));
for (const key of G.ROULETTE_BETS) field('rouletteBet').add(new Option(msg(`roulette_${key}`), key));

async function load() {
  const { settings = {}, apiKey = '', openrouterKey = '', bank = {}, stats } = await chrome.storage.local.get([
    'settings',
    'apiKey',
    'openrouterKey',
    'bank',
    'stats',
  ]);
  const values = { ...DEFAULTS, ...settings };
  for (const name of CHECKBOXES) field(name).checked = values[name];
  for (const name of [...SELECTS, ...INT_SELECTS, ...TEXTS, ...NUMBERS]) field(name).value = values[name];
  $('apiKey').value = apiKey;
  $('openrouterKey').value = openrouterKey;
  showBankSize(bank);
  showLocalStatus();
  showProfit(stats);
}

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

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.stats) showProfit(changes.stats.newValue);
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

function flash(text) {
  $('saved').textContent = text;
  setTimeout(() => ($('saved').textContent = ''), 2500);
}

$('save').addEventListener('click', async () => {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const next = { ...settings };
  for (const name of CHECKBOXES) next[name] = field(name).checked;
  for (const name of SELECTS) next[name] = field(name).value;
  for (const name of INT_SELECTS) next[name] = Number(field(name).value);
  for (const name of TEXTS) next[name] = field(name).value.trim();
  for (const name of NUMBERS) next[name] = Math.max(0, Number(field(name).value) || 0);
  if (next.maxDelayMs < next.minDelayMs) next.maxDelayMs = next.minDelayMs;
  await chrome.storage.local.set({
    settings: next,
    apiKey: $('apiKey').value.trim(),
    openrouterKey: $('openrouterKey').value.trim(),
  });
  flash(msg('optionsSaved'));
});

$('export').addEventListener('click', async () => {
  const { bank = {} } = await chrome.storage.local.get('bank');
  const blob = new Blob([JSON.stringify(bank, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'botter-bank.json';
  a.click();
  URL.revokeObjectURL(a.href);
});

$('import').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const incoming = JSON.parse(await file.text());
    const valid = Object.fromEntries(
      Object.entries(incoming).filter(
        ([key, entry]) => /^[bo]:/.test(key) && entry && typeof entry.text === 'string' && ['bughunt', 'output'].includes(entry.type),
      ),
    );
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
  await chrome.storage.local.set({ bank: {}, stats: {} });
  showBankSize({});
  showProfit({});
  flash(msg('optionsCleared'));
});

load();
