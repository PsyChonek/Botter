const { t, apply, toggle } = window.I18n;
const $ = (id) => document.getElementById(id);

const ACTIVITY_SHOWN = 200;
let connected = false;

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401) location.assign('/login');
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

// ---------- the bot's panel ----------

// The panel content.js builds on the server, mirrored here. Clicks, picks and
// opened sections go back by their element path and the server re-renders.
// It sits inline here, so the fixed position and the hide buttons go.
const PANEL_OVERRIDES = `
  .panel { position: static !important; width: 100% !important; max-height: none !important; }
  .panel[hidden] { display: block !important; }
  .show, .hide, .add-account { display: none !important; }
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

// ---------- live updates ----------

function connect() {
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => setConnected(true));
  source.addEventListener('panel', (event) => showPanel(JSON.parse(event.data)));
  source.addEventListener('activity', (event) => {
    for (const item of JSON.parse(event.data)) addActivity(item);
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
  $('conn').textContent = t(connected ? 'connected' : 'disconnected');
  $('conn').classList.toggle('ok', connected);
}

function addActivity(item) {
  $('activity-empty').hidden = true;
  const li = document.createElement('li');
  li.className = `level-${item.level}`;
  const time = document.createElement('time');
  time.dateTime = item.time;
  time.textContent = new Date(item.time).toLocaleTimeString(I18n.lang);
  const msg = document.createElement('span');
  msg.className = 'msg';
  msg.textContent = item.msg;
  const fields = document.createElement('span');
  fields.className = 'fields';
  fields.textContent = Object.entries(item.fields ?? {})
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(' ');
  li.append(time, msg, fields);
  const list = $('activity');
  list.prepend(li);
  while (list.children.length > ACTIVITY_SHOWN) list.lastElementChild.remove();
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

$('lang').addEventListener('click', () => {
  toggle();
  setConnected(connected);
  loadSettings();
});
$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.assign('/login');
});

apply();
setConnected(false);
loadSettings();
connect();
