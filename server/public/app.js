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
  watchHistory(key === 'progress');
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
  $('hero-signin').hidden = !!player;
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

// ---------- progress charts ----------

// Every account's level and credits over time, from /api/history, drawn as one
// line per account plus the sum of all of them. Colors follow the account's
// place in the history, so a range change never repaints a line.
const SVG = 'http://www.w3.org/2000/svg';
const SERIES_MAX = 8;
const DAY_MS = 24 * 3600_000;
const HISTORY_EVERY_MS = 60_000;
const CHART = { height: 240, left: 56, right: 16, top: 12, bottom: 28 };
let progress = null;
let rangeDays = 7;
let historyTimer = null;

const compact = (value) => new Intl.NumberFormat(I18n.lang, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const signed = (value) => (value > 0 ? `+${number(value)}` : number(value));

function svg(name, attrs = {}) {
  const element = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

// Round steps for an axis: 1, 2 or 5 times a power of ten.
function ticks(min, max, count = 4) {
  if (min === max) [min, max] = [min - 1, max + 1];
  const raw = (max - min) / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw);
  const out = [];
  for (let value = Math.floor(min / step) * step; value <= max + step / 2; value += step) out.push(value);
  if (out.at(-1) < max) out.push(out.at(-1) + step);
  return out;
}

// Lines for one measure (0 level, 1 credits): accounts, then their sum.
function seriesOf(index) {
  const from = rangeDays ? Date.now() - rangeDays * DAY_MS : 0;
  const samples = progress.samples.filter((sample) => sample.t >= from);
  const ids = Object.keys(progress.names).slice(0, SERIES_MAX);
  const series = ids.map((id, slot) => ({
    name: progress.names[id],
    color: `var(--series-${slot + 1})`,
    points: samples.filter((sample) => sample.v[id]).map((sample) => [sample.t, sample.v[id][index]]),
  }));
  if (ids.length > 1) {
    series.push({
      name: t('total'),
      color: 'var(--fg)',
      total: true,
      points: samples.map((sample) => [sample.t, Object.values(sample.v).reduce((sum, value) => sum + value[index], 0)]),
    });
  }
  return series.filter((line) => line.points.length);
}

// The value a line had at a time: its last point at or before it.
function valueAt(points, time) {
  let value = null;
  for (const [t0, v] of points) {
    if (t0 > time) break;
    value = v;
  }
  return value;
}

function timeLabel(time, span) {
  const options = span <= 2 * DAY_MS ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'numeric' };
  return new Date(time).toLocaleString(I18n.lang, options);
}

function drawChart(box, series, format) {
  box.replaceChildren();
  if (!series.length) return;
  const width = Math.max(box.clientWidth, 280);
  const { height, left, right, top, bottom } = CHART;
  const times = [...new Set(series.flatMap((line) => line.points.map(([time]) => time)))].sort((a, b) => a - b);
  const values = series.flatMap((line) => line.points.map(([, value]) => value));
  let [t0, t1] = [times[0], times.at(-1)];
  if (t0 === t1) [t0, t1] = [t0 - 3600_000, t1 + 3600_000];
  const yTicks = ticks(Math.min(...values), Math.max(...values));
  const [y0, y1] = [yTicks[0], yTicks.at(-1)];
  const x = (time) => left + ((time - t0) / (t1 - t0)) * (width - left - right);
  const y = (value) => top + (1 - (value - y0) / (y1 - y0)) * (height - top - bottom);

  const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, 'aria-hidden': 'true' });
  for (const value of yTicks) {
    chart.append(svg('line', { x1: left, x2: width - right, y1: y(value), y2: y(value), class: 'grid' }));
    const label = svg('text', { x: left - 8, y: y(value), class: 'axis', 'text-anchor': 'end', 'dominant-baseline': 'middle' });
    label.textContent = format(value);
    chart.append(label);
  }
  const xCount = Math.max(2, Math.floor((width - left - right) / 110));
  for (let i = 0; i <= xCount; i++) {
    const time = t0 + ((t1 - t0) * i) / xCount;
    const anchor = i === 0 ? 'start' : i === xCount ? 'end' : 'middle';
    const label = svg('text', { x: x(time), y: height - 8, class: 'axis', 'text-anchor': anchor });
    label.textContent = timeLabel(time, t1 - t0);
    chart.append(label);
  }
  // Credits and levels move in jumps, so each line holds its value until the next sample.
  for (const line of series) {
    const d = line.points.map(([time, value], i) => (i ? `H${x(time)}V${y(value)}` : `M${x(time)},${y(value)}`)).join('');
    chart.append(svg('path', { d, class: line.total ? 'line total' : 'line', style: `stroke:${line.color}` }));
    const [lastT, lastV] = line.points.at(-1);
    chart.append(svg('circle', { cx: x(lastT), cy: y(lastV), r: 4, class: 'end', style: `fill:${line.color}` }));
  }

  const cross = svg('line', { y1: top, y2: height - bottom, class: 'cross', visibility: 'hidden' });
  const dots = series.map((line) => svg('circle', { r: 4, class: 'end', style: `fill:${line.color}`, visibility: 'hidden' }));
  chart.append(cross, ...dots);
  const tip = document.createElement('div');
  tip.className = 'tip';
  tip.hidden = true;
  box.append(chart, tip);

  let shown = -1;
  const show = (index) => {
    shown = Math.max(0, Math.min(times.length - 1, index));
    const time = times[shown];
    cross.setAttribute('x1', x(time));
    cross.setAttribute('x2', x(time));
    cross.setAttribute('visibility', 'visible');
    const head = document.createElement('div');
    head.className = 'tip-time';
    head.textContent = new Date(time).toLocaleString(I18n.lang, { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
    const rows = series.map((line, i) => {
      const value = valueAt(line.points, time);
      dots[i].setAttribute('visibility', value === null ? 'hidden' : 'visible');
      if (value !== null) {
        dots[i].setAttribute('cx', x(time));
        dots[i].setAttribute('cy', y(value));
      }
      const row = document.createElement('div');
      row.className = 'tip-row';
      const key = document.createElement('span');
      key.className = 'key';
      key.style.background = line.color;
      const strong = document.createElement('strong');
      strong.textContent = value === null ? '-' : number(value);
      const name = document.createElement('span');
      name.textContent = line.name;
      row.append(key, strong, name);
      return row;
    });
    tip.replaceChildren(head, ...rows);
    tip.hidden = false;
    const px = (x(time) / width) * box.clientWidth;
    tip.style.left = `${Math.min(px + 12, box.clientWidth - tip.offsetWidth)}px`;
    if (px + 12 + tip.offsetWidth > box.clientWidth) tip.style.left = `${Math.max(0, px - 12 - tip.offsetWidth)}px`;
  };
  const hide = () => {
    shown = -1;
    tip.hidden = true;
    cross.setAttribute('visibility', 'hidden');
    for (const dot of dots) dot.setAttribute('visibility', 'hidden');
  };
  box.onpointermove = (event) => {
    const rect = chart.getBoundingClientRect();
    const time = t0 + ((((event.clientX - rect.left) / rect.width) * width - left) / (width - left - right)) * (t1 - t0);
    let nearest = 0;
    for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - time) < Math.abs(times[nearest] - time)) nearest = i;
    show(nearest);
  };
  box.onpointerleave = hide;
  box.onblur = hide;
  box.onfocus = () => show(times.length - 1);
  box.onkeydown = (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, Home: -Infinity, End: Infinity }[event.key];
    if (!step) return;
    event.preventDefault();
    show(Number.isFinite(step) ? (shown < 0 ? times.length - 1 : shown) + step : step > 0 ? times.length - 1 : 0);
  };
}

// The legend and table in one: each line's key, where it is now and how far it moved in the range.
function drawTable(table, series) {
  const head = document.createElement('tr');
  for (const [key, cls] of [['account', ''], ['now', 'num'], ['change', 'num']]) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.className = cls;
    th.textContent = t(key);
    head.append(th);
  }
  const rows = series.map((line) => {
    const row = document.createElement('tr');
    if (line.total) row.className = 'total';
    const name = document.createElement('td');
    const key = document.createElement('span');
    key.className = 'key';
    key.style.background = line.color;
    name.append(key, document.createTextNode(line.name));
    const first = line.points[0][1];
    const last = line.points.at(-1)[1];
    const change = last - first;
    const cells = [number(last), signed(change)].map((text, i) => {
      const cell = document.createElement('td');
      cell.className = i && change ? `num ${change > 0 ? 'pos' : 'neg'}` : 'num';
      cell.textContent = text;
      return cell;
    });
    row.append(name, ...cells);
    return row;
  });
  const thead = document.createElement('thead');
  thead.append(head);
  const tbody = document.createElement('tbody');
  tbody.append(...rows);
  table.replaceChildren(thead, tbody);
  table.hidden = !rows.length;
}

function renderProgress() {
  if (!progress || $('view-progress').hidden) return;
  const credits = seriesOf(1);
  const levels = seriesOf(0);
  $('progress-empty').hidden = credits.length > 0;
  for (const card of $('view-progress').querySelectorAll('.card')) card.hidden = !credits.length;
  drawChart($('chart-credits'), credits, compact);
  drawChart($('chart-level'), levels, number);
  drawTable($('table-credits'), credits);
  drawTable($('table-level'), levels);
}

async function loadHistory() {
  const res = await fetch('/api/history').catch(() => null);
  if (res?.status === 401) return location.assign('/login');
  if (!res?.ok) return;
  progress = await res.json();
  renderProgress();
}

// Fetched while the tab is open; the server adds a sample every few minutes.
function watchHistory(open) {
  clearInterval(historyTimer);
  historyTimer = null;
  if (!open) return;
  loadHistory();
  historyTimer = setInterval(loadHistory, HISTORY_EVERY_MS);
}

for (const button of document.querySelectorAll('[data-range]')) {
  button.addEventListener('click', () => {
    rangeDays = Number(button.dataset.range);
    for (const other of document.querySelectorAll('[data-range]')) other.setAttribute('aria-pressed', String(other === button));
    renderProgress();
  });
}
let progressWidth = 0;
new ResizeObserver(([entry]) => {
  if (entry.contentRect.width === progressWidth) return;
  progressWidth = entry.contentRect.width;
  renderProgress();
}).observe($('view-progress'));

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

$('hero-signin').addEventListener('click', () => {
  selectTab('accounts');
  $('github-start').focus();
});

// GitHub sign-in: the server hands out the authorize address, GitHub sends
// the browser back to the casino with ?code=, and that address is pasted here.
let githubFlow = null;
$('github-start').addEventListener('click', async () => {
  const result = $('github-result');
  // Opened before the request so the browser does not treat it as a pop-up.
  const tab = window.open('about:blank', '_blank');
  if (tab) tab.opener = null;
  result.textContent = t('working');
  const res = await post('/api/account/github/start', {});
  if (!res.ok) {
    tab?.close();
    result.textContent = t('signinFailed');
    return;
  }
  githubFlow = res.data.id;
  if (tab) tab.location.href = res.data.url;
  $('github-link').href = res.data.url;
  $('github-url').value = '';
  $('github-finish').hidden = false;
  result.textContent = t('githubWaiting');
  $('github-url').focus();
});

$('github-finish').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = $('github-result');
  result.textContent = t('working');
  const res = await post('/api/account/github/finish', { id: githubFlow ?? '', url: $('github-url').value });
  const error = res.data?.error;
  result.textContent = t(res.ok ? 'signinOk' : error === 'no_code' ? 'githubNoCode' : error === 'expired' ? 'githubExpired' : 'githubFailed');
  if (res.ok || error === 'expired') {
    githubFlow = null;
    $('github-finish').hidden = true;
  }
});

const loadSettings = () => ($('settings').src = `/ext/options.html?lang=${I18n.lang}`);

// The settings frame takes the height of its page, which changes with its
// tabs and open sections, so the dashboard scrolls once instead of twice.
let settingsObserver = null;
$('settings').addEventListener('load', () => {
  const frame = $('settings');
  const doc = frame.contentDocument;
  if (!doc) return;
  const fit = () => (frame.style.height = `${Math.ceil(doc.body.getBoundingClientRect().height)}px`);
  settingsObserver?.disconnect();
  settingsObserver = new frame.contentWindow.ResizeObserver(fit);
  settingsObserver.observe(doc.body);
  fit();
});

function relabel() {
  apply();
  setConnected(connected);
  renderReport();
  renderActivity();
  renderProgress();
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
