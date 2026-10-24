const { t, apply, toggle } = window.I18n;
const $ = (id) => document.getElementById(id);

const ACTIVITY_SHOWN = 200;
const canvas = $('screen');
const ctx = canvas.getContext('2d');
let ws = null;
let state = { tabs: [], viewport: { width: 1280, height: 800 } };
let panel = null;
let connected = false;
let retry = 500;

function sendMessage(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

// ---------- connection ----------

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${scheme}://${location.host}/ws`);
  ws.addEventListener('open', () => {
    connected = true;
    retry = 500;
    renderConn();
  });
  ws.addEventListener('message', (event) => handle(JSON.parse(event.data)));
  ws.addEventListener('close', async () => {
    connected = false;
    renderConn();
    // A failed upgrade looks the same as a dropped socket; ask the page itself
    // whether the session is still good before retrying.
    const res = await fetch('/', { redirect: 'manual' }).catch(() => null);
    if (res?.type === 'opaqueredirect') return location.assign('/login');
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 10_000);
  });
}

function handle(message) {
  if (message.type === 'state') {
    state = message;
    renderTabs();
  } else if (message.type === 'frame') drawFrame(message);
  else if (message.type === 'panel') {
    panel = message.panel;
    renderPanel();
  } else if (message.type === 'activity') {
    for (const item of message.items ?? [message.item]) addActivity(item);
  }
}

// ---------- rendering ----------

function renderConn() {
  const el = $('conn');
  el.textContent = t(connected ? 'connected' : 'disconnected');
  el.classList.toggle('ok', connected);
}

function renderPanel() {
  $('status').textContent = panel?.status || t('statusNone');
  $('fact-account').textContent = panel?.account || '-';
  $('fact-auto').textContent = panel?.auto || '-';
  $('fact-work').textContent = panel?.work || '-';
  $('fact-games').textContent = panel?.games || '-';
}

function renderTabs() {
  const list = $('tabs');
  list.replaceChildren(
    ...state.tabs.map((tab) => {
      const item = document.createElement('div');
      item.className = 'tab';
      item.setAttribute('role', 'listitem');
      const select = document.createElement('button');
      select.type = 'button';
      select.textContent = tab.title || tab.url;
      select.title = tab.url;
      if (tab.current) select.setAttribute('aria-current', 'page');
      select.addEventListener('click', () => sendMessage({ type: 'select', id: tab.id }));
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'close';
      close.textContent = 'x';
      close.setAttribute('aria-label', `${t('closeTab')}: ${select.textContent}`);
      close.addEventListener('click', () => sendMessage({ type: 'close', id: tab.id }));
      item.append(select, close);
      return item;
    }),
  );
  const current = state.tabs.find((tab) => tab.current);
  if (current && document.activeElement !== $('url')) $('url').value = current.url;
}

function drawFrame({ data, width, height }) {
  const image = new Image();
  image.onload = () => {
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    ctx.drawImage(image, 0, 0, width, height);
  };
  image.src = `data:image/jpeg;base64,${data}`;
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

// ---------- input on the screen ----------

const BUTTONS = ['left', 'middle', 'right'];

function point(event) {
  const rect = canvas.getBoundingClientRect();
  const x = ((event.clientX - rect.left) / rect.width) * canvas.width;
  const y = ((event.clientY - rect.top) / rect.height) * canvas.height;
  return { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)) };
}

let pendingMove = null;
canvas.addEventListener('pointermove', (event) => {
  if (!pendingMove) requestAnimationFrame(() => {
    sendMessage({ type: 'input', event: { kind: 'move', ...pendingMove } });
    pendingMove = null;
  });
  pendingMove = point(event);
});
canvas.addEventListener('pointerdown', (event) => {
  canvas.focus();
  canvas.setPointerCapture(event.pointerId);
  sendMessage({ type: 'input', event: { kind: 'down', button: BUTTONS[event.button] ?? 'left', ...point(event) } });
});
canvas.addEventListener('pointerup', (event) => {
  sendMessage({ type: 'input', event: { kind: 'up', button: BUTTONS[event.button] ?? 'left', ...point(event) } });
});
canvas.addEventListener('contextmenu', (event) => event.preventDefault());
canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    sendMessage({ type: 'input', event: { kind: 'wheel', dx: event.deltaX, dy: event.deltaY, ...point(event) } });
  },
  { passive: false },
);

const isPaste = (event) => (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v';
canvas.addEventListener('keydown', (event) => {
  if (isPaste(event)) return;
  event.preventDefault();
  sendMessage({ type: 'input', event: { kind: 'keydown', key: event.key } });
});
canvas.addEventListener('keyup', (event) => {
  if (isPaste(event)) return;
  event.preventDefault();
  sendMessage({ type: 'input', event: { kind: 'keyup', key: event.key } });
});
document.addEventListener('paste', (event) => {
  if (document.activeElement !== canvas) return;
  const text = event.clipboardData?.getData('text');
  if (text) sendMessage({ type: 'input', event: { kind: 'text', text } });
  event.preventDefault();
});

// ---------- controls ----------

for (const button of document.querySelectorAll('[data-open]')) {
  button.addEventListener('click', () => sendMessage({ type: 'open', target: button.dataset.open }));
}
for (const button of document.querySelectorAll('[data-nav]')) {
  button.addEventListener('click', () => sendMessage({ type: 'nav', action: button.dataset.nav }));
}
$('nav').addEventListener('submit', (event) => {
  event.preventDefault();
  let url = $('url').value.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  sendMessage({ type: 'nav', action: 'goto', url });
  canvas.focus();
});
$('type').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = $('type-text').value;
  if (!text) return;
  sendMessage({ type: 'input', event: { kind: 'text', text } });
  $('type-text').value = '';
});
$('lang').addEventListener('click', () => {
  toggle();
  renderConn();
  renderPanel();
  renderTabs();
});
$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.assign('/login');
});

apply();
renderConn();
renderPanel();
connect();
