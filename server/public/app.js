const { t, apply } = window.I18n;
const $ = (id) => document.getElementById(id);

const RECENT_SHOWN = 12;
const ACTIVITY_KEPT = 300;
const FIELD_MAX = 90;
let connected = false;
let report = null;
const activity = [];

const number = (value) => (typeof value === 'number' ? new Intl.NumberFormat(I18n.lang).format(Math.round(value)) : '-');

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401) location.assign('/login');
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

// ---------- tabs ----------

const tabs = [...document.querySelectorAll('[role="tab"]')];

function selectTab(name, focus = false) {
  const tab = tabs.find((item) => item.id === `tab-${name}`) ?? tabs[0];
  for (const item of tabs) {
    const on = item === tab;
    item.setAttribute('aria-selected', String(on));
    item.tabIndex = on ? 0 : -1;
    $(item.getAttribute('aria-controls')).hidden = !on;
  }
  if (focus) tab.focus();
  const key = tab.id.slice(4);
  if (location.hash.slice(1) !== key) history.replaceState(null, '', key === 'overview' ? location.pathname : `#${key}`);
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab.id.slice(4)));
  tab.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
    selectTab(next.id.slice(4), true);
  });
}
for (const link of document.querySelectorAll('[data-goto]')) link.addEventListener('click', () => selectTab(link.dataset.goto, true));

// ---------- the bot's panel ----------

// The panel content.js builds on the server, mirrored here. Clicks, picks and
// opened sections go back by element path and the server re-renders it. These
// rules turn the floating casino widget into a card that matches the page:
// the title row, status and Auto move to the account strip above.
const PANEL_OVERRIDES = `
  .panel { position: static !important; width: 100% !important; max-height: none !important; overflow: visible !important;
    background: transparent !important; border: 0 !important; box-shadow: none !important; padding: 0 !important;
    font: 14px/1.5 system-ui, -apple-system, 'Segoe UI', sans-serif !important; color: var(--fg) !important; }
  .panel[hidden] { display: block !important; }
  .panel > .row:first-child, .panel > .status, .show, .hide, .add-account { display: none !important; }
  .row { gap: 8px; margin-bottom: 10px; }
  .name { width: 64px; }
  button, select, input { background: var(--card); color: var(--fg); border: 1px solid var(--border); border-radius: 8px;
    padding: 6px 10px; min-height: 36px; }
  button { font-weight: 600; }
  button:hover:not(:disabled), select:hover { border-color: var(--accent); }
  button.on { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
  button:focus-visible, select:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--focus); }
  .auto-switches { gap: 6px; margin: 2px 0 12px; }
  .auto-switches button { min-height: 30px; padding: 2px 12px; font-size: 13px; }
  .muted { color: var(--muted); }
  details { border-top: 1px solid var(--border); padding: 4px 0; margin: 0; }
  summary { padding: 8px 0; font-size: 15px; }
  table { margin: 4px 0 8px; }
  th { color: var(--muted); border-bottom-color: var(--border); font-size: 12px; padding: 4px; }
  td { padding: 5px 4px; }
  tfoot td { border-top-color: var(--border); }
  .pos { color: var(--pos); }
  .neg { color: var(--neg); }
  tr.pick td { color: var(--accent); }
  .note, .stats, .cost, .bundle { font-size: 13px; }
`;
const panelRoot = $('panel').attachShadow({ mode: 'open' });
let panelHtml = '';
let panelPending = null;

function editing() {
  const active = panelRoot.activeElement;
  return !!active && (active.tagName === 'SELECT' || active.tagName === 'INPUT');
}

function showPanel(html) {
  if (editing()) {
    panelPending = html;
    return;
  }
  panelPending = null;
  if (html === panelHtml) return;
  panelHtml = html;
  $('panel-empty').hidden = !!html;
  panelRoot.innerHTML = `${html}<style>${PANEL_OVERRIDES}</style>`;
  $('auto').disabled = !panelRoot.querySelector('.auto-toggle');
}

function pathOf(element) {
  const path = [];
  for (let node = element; node && node !== panelRoot; node = node.parentNode) {
    path.unshift([...node.parentNode.children].indexOf(node));
  }
  return path;
}

const panelEvent = (element, type, extra = {}) => post('/api/panel/event', { path: pathOf(element), type, ...extra });

panelRoot.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (button && !button.disabled) panelEvent(button, 'click');
});
panelRoot.addEventListener('change', (event) => {
  const field = event.target;
  if (field.matches('select, input')) panelEvent(field, 'change', { value: field.value });
});
// toggle does not bubble, so it is caught on the way down.
panelRoot.addEventListener('toggle', (event) => panelEvent(event.target, 'toggle', { open: event.target.open }), true);
panelRoot.addEventListener('focusout', () => setTimeout(() => panelPending !== null && showPanel(panelPending)));

// Auto is the panel's own switch, pressed through the mirror.
$('auto').addEventListener('click', () => {
  const toggle = panelRoot.querySelector('.auto-toggle');
  if (toggle) panelEvent(toggle, 'click');
});

// ---------- account strip and accounts ----------

function renderReport() {
  const player = report?.player;
  $('hero-account').textContent = player?.login ?? t('notLoggedIn');
  $('hero-status').textContent = report?.status || t('panelNone');
  $('stat-level').textContent = number(player?.level);
  $('stat-credits').textContent = number(player?.credits);
  $('stat-energy').textContent = player ? `${player.energy} / ${player.maxEnergy}` : '-';
  $('energy-bar').style.width = player ? `${Math.round((100 * player.energy) / player.maxEnergy)}%` : '0';
  const auto = !!report?.settings?.autoMode;
  $('auto').setAttribute('aria-pressed', String(auto));
  $('auto-state').textContent = t(auto ? 'on' : 'off');
  renderAccounts(report?.accounts ?? []);
}

function renderAccounts(accounts) {
  $('accounts-empty').hidden = accounts.length > 0;
  $('accounts').hidden = accounts.length === 0;
  const now = Date.now();
  $('accounts').tBodies[0].replaceChildren(
    ...accounts.map((account) => {
      const row = document.createElement('tr');
      const name = document.createElement('td');
      name.textContent = account.login;
      row.append(name);
      // The saved snapshot of the account playing lags; its live figures are in the report.
      const live = account.current && report?.player ? report.player : account;
      for (const value of [number(live.level), number(live.credits), live.energy ?? '-']) {
        const cell = document.createElement('td');
        cell.className = 'num';
        cell.textContent = value;
        row.append(cell);
      }
      const action = document.createElement('td');
      action.className = 'action';
      if (account.current) {
        action.append(badge(t('current'), true));
      } else if (account.brokenUntil > now) {
        action.append(badge(t('setAside')));
      } else if (!account.session) {
        action.append(badge(t('noSession')));
      } else {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = t('use');
        button.setAttribute('aria-label', `${t('use')}: ${account.login}`);
        button.addEventListener('click', async () => {
          button.disabled = true;
          await post('/api/account/switch', { id: account.id });
        });
        action.append(button);
      }
      row.append(action);
      return row;
    }),
  );
}

function badge(text, on = false) {
  const span = document.createElement('span');
  span.className = on ? 'badge on' : 'badge';
  span.textContent = text;
  return span;
}

// ---------- activity ----------

function logItem(item) {
  const li = document.createElement('li');
  li.className = `level-${item.level}`;
  const time = document.createElement('time');
  time.dateTime = item.time;
  time.textContent = new Date(item.time).toLocaleTimeString(I18n.lang);
  const level = document.createElement('span');
  level.className = 'level';
  level.title = item.level;
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = item.msg;
  li.append(time, level, msg);
  const entries = Object.entries(item.fields ?? {});
  if (entries.length) {
    const fields = document.createElement('span');
    fields.className = 'fields';
    for (const [key, value] of entries) {
      const text = `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`;
      const field = document.createElement('span');
      field.className = 'field';
      field.textContent = text.length > FIELD_MAX ? `${text.slice(0, FIELD_MAX)}...` : text;
      if (text.length > FIELD_MAX) field.title = text;
      fields.append(field);
    }
    li.append(fields);
  }
  return li;
}

function renderActivity() {
  const problems = $('only-problems').checked;
  const shown = activity.filter((item) => !problems || item.level === 'warn' || item.level === 'error');
  $('recent').replaceChildren(...activity.slice(0, RECENT_SHOWN).map(logItem));
  $('activity').replaceChildren(...shown.map(logItem));
  for (const empty of document.querySelectorAll('.empty-activity')) empty.hidden = activity.length > 0;
}

$('only-problems').addEventListener('change', renderActivity);

// ---------- live updates ----------

function connect() {
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => setConnected(true));
  source.addEventListener('panel', (event) => showPanel(JSON.parse(event.data)));
  source.addEventListener('report', (event) => {
    report = JSON.parse(event.data);
    renderReport();
  });
  source.addEventListener('activity', (event) => {
    activity.unshift(...JSON.parse(event.data).reverse());
    activity.length = Math.min(activity.length, ACTIVITY_KEPT);
    renderActivity();
  });
  source.addEventListener('error', async () => {
    setConnected(false);
    // EventSource retries by itself; a signed-out session never comes back.
    const res = await fetch('/', { redirect: 'manual' }).catch(() => null);
    if (res?.type === 'opaqueredirect') location.assign('/login');
  });
}

function setConnected(value) {
  connected = value;
  $('conn-text').textContent = t(connected ? 'connected' : 'disconnected');
  $('conn').classList.toggle('ok', connected);
}

// ---------- controls ----------

$('signin').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = $('signin-result');
  result.textContent = t('working');
  const res = await post('/api/account/signin', { email: $('signin-email').value, password: $('signin-password').value });
  $('signin-password').value = '';
  result.textContent = t(res.ok ? 'signinOk' : res.data?.error === 'invalid' ? 'signinInvalid' : 'signinFailed');
});

const loadSettings = () => ($('settings').src = `/ext/options.html?lang=${I18n.lang}`);

function relabel() {
  apply();
  setConnected(connected);
  renderReport();
  renderActivity();
}

// One language for everything: the server renders the panel in it too.
$('lang').addEventListener('click', async () => {
  const locale = I18n.lang === 'cs' ? 'en' : 'cs';
  I18n.set(locale);
  relabel();
  loadSettings();
  await post('/api/locale', { locale });
});
$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.assign('/login');
});

async function start() {
  const config = await fetch('/api/config').then((res) => (res.ok ? res.json() : {})).catch(() => ({}));
  if (config.locale) I18n.set(config.locale);
  relabel();
  selectTab(location.hash.slice(1) || 'overview');
  loadSettings();
  connect();
}

start();
