const msg = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

const CHECKBOXES = ['useAi', 'guessUnknown', 'stopAtNorm'];
const SELECTS = ['model', 'effort', 'logLevel'];
const NUMBERS = ['minDelayMs', 'maxDelayMs'];
const DEFAULTS = {
  useAi: true,
  guessUnknown: true,
  stopAtNorm: false,
  model: 'claude-opus-5-5',
  effort: 'medium',
  logLevel: 'info',
  minDelayMs: 1500,
  maxDelayMs: 4000,
};

const $ = (id) => document.getElementById(id);
const field = (name) => document.querySelector(`[name="${name}"]`);

for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = msg(el.dataset.i18n);
document.documentElement.lang = chrome.i18n.getUILanguage();

async function load() {
  const { settings = {}, apiKey = '', bank = {} } = await chrome.storage.local.get(['settings', 'apiKey', 'bank']);
  const values = { ...DEFAULTS, ...settings };
  for (const name of CHECKBOXES) field(name).checked = values[name];
  for (const name of [...SELECTS, ...NUMBERS]) field(name).value = values[name];
  $('apiKey').value = apiKey;
  showBankSize(bank);
}

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
  for (const name of NUMBERS) next[name] = Math.max(0, Number(field(name).value) || 0);
  if (next.maxDelayMs < next.minDelayMs) next.maxDelayMs = next.minDelayMs;
  await chrome.storage.local.set({ settings: next, apiKey: $('apiKey').value.trim() });
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
  flash(msg('optionsCleared'));
});

load();
