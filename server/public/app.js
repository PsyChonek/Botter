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
  watchBoards(key === 'boards');
  if (key === 'changes') loadChanges();
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
  const next = document.createElement('div');
  next.innerHTML = `${html}<style>${PANEL_OVERRIDES}</style>`;
  morph(panelRoot, next);
  $('auto').disabled = !panelRoot.querySelector('.auto-toggle');
}

// Brings target's children in line with source's, touching only what
// differs, so a panel update changes a few text nodes instead of rebuilding
// every element (and restyling the page) several times a second.
function morph(target, source) {
  const before = [...target.childNodes];
  const after = [...source.childNodes];
  after.forEach((to, i) => {
    const from = before[i];
    if (!from) target.append(to);
    else if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) from.replaceWith(to);
    else if (from.nodeType !== Node.ELEMENT_NODE) {
      if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    } else {
      for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
      for (const { name, value } of [...to.attributes]) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
      morph(from, to);
      // A select shows the option the server marked, unless it is being used.
      if (from.nodeName === 'SELECT' && from !== document.activeElement) {
        const picked = [...to.options].findIndex((option) => option.hasAttribute('selected'));
        if (picked >= 0 && from.selectedIndex !== picked) from.selectedIndex = picked;
      }
    }
  });
  for (const extra of before.slice(after.length)) extra.remove();
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
  renderTabs(report?.tabs ?? []);
  renderShark();
  renderUpdateWarn();
}

// ---------- loan shark ----------

// The playing account's loan, worked out by the bot (BotterAuto.loanState) and
// counted down here every second between reports.
const clock = (ms) => {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const pad = (n) => String(n).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  return hours ? `${hours}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}` : `${Math.floor(total / 60)}:${pad(total % 60)}`;
};
const dateTime = (time) => new Date(time).toLocaleString(I18n.lang, { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
const KIND_KEYS = { level: 'kindLevel', cycle: 'kindCycle', clean: 'kindClean', other: 'kindOther' };

function renderShark() {
  const player = report?.player;
  const loan = player?.loan;
  $('shark-loan').hidden = !loan;
  $('shark-none').hidden = !!loan;
  if (!player) $('shark-none').textContent = t('sharkNoPlayer');
  else if (!loan) {
    $('shark-none').textContent = player.loanBlockedUntil
      ? fill(t('sharkBlocked'), { when: dateTime(player.loanBlockedUntil) })
      : fill(t('sharkNone'), { limit: number(player.loanLimit) });
  } else {
    $('shark-debt').textContent = number(loan.debt);
    $('shark-debt-box').classList.toggle('execution', !!loan.execution);
    $('shark-terms').textContent = fill(t('sharkTerms'), { principal: number(loan.principal), repaid: number(loan.repaid), hours: loan.hours });
    renderSharkTick();
    $('shark-exec').hidden = !loan.execution;
    $('shark-exec').textContent = report.loanSettings?.autoBankrupt ? `${t('sharkExec')} ${fill(t('sharkExecBankrupt'), { xp: number(player.xpInto) })}` : t('sharkExec');
    $('shark-kind').textContent = t(KIND_KEYS[loan.kind] ?? 'kindOther');
  }
  const set = report?.loanSettings;
  $('shark-bot').hidden = !set;
  if (set) {
    const state = (on) => t(on ? 'on' : 'off');
    $('shark-bot').textContent = fill(t('sharkBot'), {
      level: state(set.levelLoan),
      cycle: state(set.loanCycle),
      bankrupt: state(set.autoBankrupt),
      free: number(report.loanStats?.cycleFree ?? 0),
    });
  }
}

function renderSharkTick() {
  const loan = report?.player?.loan;
  if (!loan) return;
  $('shark-tick').textContent =
    loan.nextTickAt === null
      ? fill(t('sharkCapped'), { cap: number(loan.cap) })
      : fill(t(loan.hours === 0 ? 'sharkFree' : 'sharkTick'), { time: clock(loan.nextTickAt - Date.now()), debt: number(loan.nextDebt) });
}
setInterval(renderSharkTick, 1000);

// ---------- casino changes ----------

// A deploy that broke what the bot's models copy shows on every tab until a
// Botter update matches it again.
function renderUpdateWarn() {
  const problems = report?.bundle?.problems ?? [];
  $('update-warn').hidden = !problems.length;
  $('changes-dot').hidden = !problems.length;
  if (problems.length) $('update-text').textContent = fill(t('updateText'), { when: dateTime(report.bundle.at), n: problems.length });
}

let changes = null;

function renderChanges() {
  if (!changes || $('view-changes').hidden) return;
  const problems = changes.bundle?.problems ?? [];
  $('problems-card').hidden = !problems.length;
  $('problems').replaceChildren(
    ...problems.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );

  // Entries newer than the changelog the previous deploy carried came with the latest one.
  const entries = changes.bundle?.changes ?? [];
  const before = changes.log[1]?.changelog ?? null;
  $('changelog-empty').hidden = entries.length > 0;
  $('changelog').replaceChildren(
    ...entries.map((entry) => {
      const block = document.createElement('article');
      block.className = 'changelog-entry';
      const head = document.createElement('h3');
      head.textContent = new Date(`${entry.date}T12:00:00`).toLocaleDateString(I18n.lang, { day: 'numeric', month: 'long', year: 'numeric' });
      if (before && entry.date > before) head.append(' ', badge(t('changelogNew'), true));
      const list = document.createElement('ul');
      list.append(
        ...entry.changes.map((text) => {
          const li = document.createElement('li');
          li.textContent = text;
          return li;
        }),
      );
      block.append(head, list);
      return block;
    }),
  );

  $('deploys-empty').hidden = changes.log.length > 0;
  $('deploys').hidden = !changes.log.length;
  $('deploys').tBodies[0].replaceChildren(
    ...changes.log.map((row) => {
      const tr = document.createElement('tr');
      const stale = row.problems?.length > 0;
      const models = badge(stale ? fill(t('modelsStale'), { n: row.problems.length }) : t('modelsOk'), !stale);
      if (stale) {
        models.classList.add('bad');
        models.title = row.problems.join('; ');
      }
      tr.append(cell(dateTime(row.at)), cell(row.name), cell(row.changelog ?? '-'), cell(models));
      return tr;
    }),
  );
}

async function loadChanges() {
  const res = await fetch('/api/changes').catch(() => null);
  if (res?.status === 401) return location.assign('/login');
  if (!res?.ok) return;
  changes = await res.json();
  renderChanges();
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
      // Saved snapshots lag; every running account's live figures are in the report.
      const running = report?.tabs?.find((tab) => tab.id === account.id)?.player;
      const live = running ?? account;
      const debt = running ? (running.loan?.debt ?? 0) : account.debt;
      for (const value of [number(live.level), number(live.prestige), number(live.credits), live.energy ?? '-', debt ? number(debt) : debt === 0 ? '0' : '-']) {
        const cell = document.createElement('td');
        cell.className = 'num';
        cell.textContent = value;
        row.append(cell);
      }
      const action = document.createElement('td');
      action.className = 'action';
      if (account.brokenUntil > now) action.append(badge(t('setAside')));
      else if (!account.session) action.append(badge(t('noSession')));
      else action.append(badge(t('running'), true));
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

// ---------- leaderboards ----------

// The casino's six boards from /api/leaderboards, one shown at a time. Rows of
// the saved accounts are highlighted, the one logged in most.
const BOARDS_EVERY_MS = 60_000;
const BOARD_KEYS = { sprint: 'Sprint', level: 'Level', credits: 'Credits', biggest: 'Biggest', losers: 'Losers', debtors: 'Debtors' };
let boards = null;
let boardShown = 'sprint';
let boardsTimer = null;

const fill = (text, values) => text.replace(/\{(\w+)\}/g, (match, key) => values[key] ?? match);

function duration(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days) return `${days} ${t('days')} ${hours % 24} ${t('hours')}`;
  if (hours) return `${hours} ${t('hours')} ${minutes % 60} ${t('minutes')}`;
  return `${minutes} ${t('minutes')}`;
}

function cell(content, cls = '') {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.append(content);
  return td;
}

function playerCell(entry) {
  const box = document.createElement('div');
  box.className = 'player';
  if (entry.avatar) {
    const img = document.createElement('img');
    img.src = entry.avatar;
    img.alt = '';
    img.width = 28;
    img.height = 28;
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    box.append(img);
  } else {
    const blank = document.createElement('span');
    blank.className = 'avatar';
    blank.setAttribute('aria-hidden', 'true');
    blank.textContent = entry.login.slice(0, 1).toUpperCase();
    box.append(blank);
  }
  const text = document.createElement('div');
  const name = document.createElement('strong');
  name.textContent = entry.login;
  text.append(name);
  if (entry.me) text.append(' ', badge(t('you'), true));
  else if (entry.own) text.append(' ', badge(t('ours')));
  if (entry.insolvent) text.append(' ', badge(t('insolvent')));
  else if (entry.debtor) text.append(' ', badge(t('debtor')));
  if (entry.title) {
    const title = document.createElement('div');
    title.className = 'muted small';
    title.textContent = entry.prestige ? `${entry.title}, ${t('prestige').toLowerCase()} ${entry.prestige}` : entry.title;
    text.append(title);
  }
  box.append(text);
  return box;
}

function renderBoards() {
  if (!boards || $('view-boards').hidden) return;
  const list = boards.boards;
  $('boards-empty').hidden = list.length > 0;
  $('board-card').hidden = !list.length;
  if (!list.length) {
    $('last-sprint').hidden = true;
    $('board-pick').replaceChildren();
    return;
  }
  if (!list.some((board) => board.by === boardShown)) boardShown = list[0].by;
  $('board-pick').replaceChildren(
    ...list.map((board) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = t(`board${BOARD_KEYS[board.by]}`);
      button.setAttribute('aria-pressed', String(board.by === boardShown));
      button.addEventListener('click', () => {
        boardShown = board.by;
        renderBoards();
      });
      return button;
    }),
  );

  const board = list.find((item) => item.by === boardShown);
  const key = BOARD_KEYS[board.by];
  $('board-heading').textContent = t(`board${key}`);
  $('board-hint').textContent = t(`hint${key}`);
  $('board-value').textContent = t(`boardValue${key}`);
  $('board-updated').textContent = boards.at ? `${t('updated')} ${new Date(boards.at).toLocaleTimeString(I18n.lang, { hour: '2-digit', minute: '2-digit' })}` : '';
  $('board-none').hidden = board.entries.length > 0;
  $('board').hidden = !board.entries.length;
  const negative = board.by === 'losers' || board.by === 'debtors';
  $('board').tBodies[0].replaceChildren(
    ...board.entries.map((entry) => {
      const row = document.createElement('tr');
      if (entry.own) row.className = entry.me ? 'own me' : 'own';
      const value = entry.value === null ? '-' : negative && entry.value ? `-${number(entry.value)}` : number(entry.value);
      row.append(cell(String(entry.rank ?? '-'), entry.rank && entry.rank <= 3 ? `num podium p${entry.rank}` : 'num'), cell(playerCell(entry)), cell(number(entry.level), 'num'), cell(value, 'num'));
      return row;
    }),
  );

  const sprint = board.by === 'sprint' ? board.sprint : null;
  $('board-sprint').hidden = !sprint?.endAt;
  if (sprint?.endAt) {
    const left = sprint.endAt - Date.now();
    $('board-sprint').textContent = fill(t(left > 0 ? 'sprintEnds' : 'sprintEnded'), { n: sprint.number ?? '', time: duration(left) });
  }
  const last = sprint?.last;
  $('last-sprint').hidden = !last?.results.length;
  if (last?.results.length) {
    $('last-sprint-heading').textContent = fill(t('lastSprint'), { n: last.number ?? '' });
    $('last-sprint').querySelector('tbody').replaceChildren(
      ...last.results.map((result) => {
        const row = document.createElement('tr');
        row.append(cell(String(result.place ?? '-'), `num podium p${result.place}`), cell(result.login), cell(number(result.score), 'num'), cell(number(result.reward), 'num pos'));
        return row;
      }),
    );
  }
}

async function loadBoards() {
  const res = await fetch('/api/leaderboards').catch(() => null);
  if (res?.status === 401) return location.assign('/login');
  if (!res?.ok) return;
  boards = await res.json();
  renderBoards();
}

// Fetched while the tab is open; the server caches the boards for a minute.
function watchBoards(open) {
  clearInterval(boardsTimer);
  boardsTimer = null;
  if (!open) return;
  loadBoards();
  boardsTimer = setInterval(loadBoards, BOARDS_EVERY_MS);
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

// ---------- running accounts ----------

const PRESTIGE_LEVEL = 40;
const pct = (part, whole) => `${Math.max(0, Math.min(100, (100 * part) / whole)).toFixed(1)}%`;

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function bar(className = '') {
  const outer = el('span', `bar ${className}`);
  outer.setAttribute('aria-hidden', 'true');
  outer.append(el('span'));
  return outer;
}
const setBar = (outer, fraction) => (outer.firstChild.style.width = fraction);

const motion = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;

// Counts a number shown in node up or down to value, so changes read as motion.
function tween(node, value, format = number) {
  const from = node.dataset.value === undefined ? null : Number(node.dataset.value);
  node.dataset.value = String(value);
  if (from === null || from === value || !motion() || typeof value !== 'number') {
    node.textContent = format(value);
    return;
  }
  node.animate([{ color: 'var(--accent)' }, {}], { duration: 600, easing: 'ease-out' });
  const start = performance.now();
  const step = (now) => {
    if (node.dataset.value !== String(value)) return;
    const k = Math.min(1, (now - start) / 700);
    const eased = 1 - (1 - k) ** 3;
    node.textContent = format(from + (value - from) * eased);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function statBox(label) {
  const box = el('span', 'acct-stat');
  const value = el('span', 'v', '-');
  box.append(el('span', 'k', label), value);
  return { box, value };
}

// One card per running account, built once and updated in place, so its
// numbers count and its bars slide instead of the card being redrawn.
const cards = new Map();

function buildCard(tab) {
  const button = el('article', 'acct');
  button.dataset.id = tab.id;
  button.setAttribute('aria-label', tab.login ?? tab.id);
  const head = el('span', 'acct-head');
  const dot = el('span', 'dot');
  const name = el('span', 'acct-name');
  const badge = el('span', 'acct-badge');
  head.append(dot, name, badge);
  const status = el('span', 'acct-status');
  const stats = el('span', 'acct-stats');
  const level = statBox(t('level'));
  const credits = statBox(t('credits'));
  const energy = statBox(t('energy'));
  const energyBar = bar();
  energy.box.append(energyBar);
  stats.append(level.box, credits.box, energy.box);
  const goal = el('span', 'acct-goal');
  const xpRow = el('span', 'row');
  const xpLabel = el('span');
  const xpText = el('span');
  xpRow.append(xpLabel, xpText);
  const xpBar = bar();
  const toRow = el('span', 'row');
  const toText = el('span');
  toRow.append(el('span', '', t('toPrestige')), toText);
  const toBar = bar('goal');
  goal.append(xpRow, xpBar, toRow, toBar);
  button.append(head, status, stats, goal);
  const li = el('li');
  li.append(button);
  return { li, button, dot, name, badge, status, stats, level, credits, energy, energyBar, goal, xpRow, xpLabel, xpText, xpBar, toText, toBar };
}

function updateCard(card, tab) {
  const player = tab.player;
  card.dot.style.background = accountColor(tab.login);
  card.name.textContent = tab.login ?? tab.id;
  card.badge.hidden = !player?.prestige;
  card.badge.textContent = t('prestigeCount', [String(player?.prestige ?? 0)]);
  if (card.status.title !== (tab.status ?? '')) {
    card.status.textContent = tab.status ?? '-';
    card.status.title = tab.status ?? '';
  }
  card.stats.hidden = card.goal.hidden = !player;
  if (!player) return;
  tween(card.level.value, player.level);
  tween(card.credits.value, player.credits);
  card.energy.value.textContent = `${player.energy} / ${player.maxEnergy}`;
  setBar(card.energyBar, pct(player.energy, player.maxEnergy));
  card.xpRow.hidden = card.xpBar.hidden = !player.xpNeed;
  card.xpLabel.textContent = t('xpToNext', [String(player.level + 1)]);
  card.xpText.textContent = `${number(player.xpInto)} / ${number(player.xpNeed)}`;
  setBar(card.xpBar, pct(player.xpInto, player.xpNeed || 1));
  card.toText.textContent = `${player.level} / ${PRESTIGE_LEVEL}`;
  setBar(card.toBar, pct(player.level - 1 + (player.xpNeed ? player.xpInto / player.xpNeed : 0), PRESTIGE_LEVEL - 1));
}

function renderTabs(list) {
  const multi = list.length > 1;
  $('hero').classList.toggle('multi', multi);
  $('hero-accounts').hidden = $('hero-accounts-label').hidden = !multi;
  if (!multi) return;
  const ids = new Set(list.map((tab) => tab.id));
  for (const [id, card] of cards) {
    if (ids.has(id)) continue;
    card.li.remove();
    cards.delete(id);
  }
  list.forEach((tab, i) => {
    let card = cards.get(tab.id);
    if (!card) cards.set(tab.id, (card = buildCard(tab)));
    updateCard(card, tab);
    // Moving a node restarts its entrance animation: only when out of place.
    if ($('hero-accounts').children[i] !== card.li) $('hero-accounts').insertBefore(card.li, $('hero-accounts').children[i] ?? null);
  });
}

// ---------- live play ----------

const PLAYS_KEPT = 600;
const PLAYS_SHOWN = 60;
const STRIP_SHOWN = 40;
const PACE_WINDOW_MS = 5 * 60_000;
// Activity lines that say nothing about play, kept out of the feed.
const QUIET_ACTIONS = new Set(['rate_limit_retry', 'account', 'page_booted', 'standup_skipped', 'upgrades_skipped', 'wheel_spin', 'level_up', 'rewards', 'speed_learned']);
const RED_POCKETS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
const SUITS = { h: '♥', d: '♦', c: '♣', s: '♠' };
const clockTime = (at) => new Date(at).toLocaleTimeString(I18n.lang, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const plays = [];
let playsPaused = false;

function accountColor(login) {
  const logins = (report?.accounts ?? []).map((account) => account.login).sort();
  const slot = logins.indexOf(login);
  return slot < 0 ? 'var(--track)' : `var(--series-${(slot % 8) + 1})`;
}

const pocketColor = (pocket) => {
  const n = Number(pocket);
  return !/^\d+$/.test(String(pocket)) || n === 0 ? 'green' : RED_POCKETS.has(n) ? 'red' : 'black';
};

function pocketChip(pocket) {
  const color = pocketColor(pocket);
  const chip = el('span', `pocket ${color}`, String(pocket));
  chip.setAttribute('aria-label', t('pocketLabel', [String(pocket), t(`pocket_${color}`)]));
  return chip;
}

function cardChip(card) {
  const text = String(card);
  const suit = text.slice(-1);
  const mark = SUITS[suit];
  return el('span', `playing-card${suit === 'h' || suit === 'd' ? ' red' : ''}`, mark ? text.slice(0, -1) + mark : text);
}

function hand(label, cards) {
  const wrap = el('span', 'hand');
  wrap.append(el('span', 'hand-label', label), ...(cards ?? []).map(cardChip));
  return wrap;
}

function symbolHue(symbol) {
  let h = 0;
  for (const ch of String(symbol)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

function reels(grid) {
  const box = el('span', 'reels');
  box.style.gridTemplateColumns = `repeat(${grid[0]?.length ?? 1}, auto)`;
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', grid.map((row) => row.join(' ')).join(', '));
  for (const row of grid) {
    for (const symbol of row) {
      const cell = el('span', '', String(symbol).slice(0, 4));
      cell.style.setProperty('--h', symbolHue(symbol));
      cell.setAttribute('aria-hidden', 'true');
      box.append(cell);
    }
  }
  return box;
}

const betText = (bets) => Object.entries(bets ?? {}).map(([spot, amount]) => `${spot} ${number(amount)}`).join(', ');
const rewardSum = (item) => ['standup', 'achievement', 'payroll', 'event'].reduce((sum, key) => sum + (item[key] ?? 0), 0);

// The picture of one play: the outcome the casino showed, as far as the
// response carried it (GameData.playOutcome on the bot's side).
function playVisual(item) {
  const box = el('div', 'play-visual');
  if (item.kind === 'game') {
    if (item.pocket !== undefined) box.append(pocketChip(item.pocket));
    if (item.dice) box.append(...item.dice.map((d) => el('span', 'die', String(d))));
    if (item.game === 'baccarat') {
      box.append(hand(t('handPlayer'), item.player), hand(t('handBanker'), item.banker));
      if (item.winner) box.append(el('span', 'badge', t(`winner_${item.winner}`)));
    }
    if (item.dealer) {
      box.append(hand(t('handYou'), item.player), hand(t('handDealer'), item.dealer));
      if (item.action) box.append(el('span', 'bet-tag', item.action));
    }
    if (item.grid) box.append(reels(item.grid));
    if (item.game === 'mines') {
      const bar = el('span', 'mines-bar');
      bar.setAttribute('role', 'img');
      bar.setAttribute('aria-label', t('minesRevealed', [String(item.revealed ?? 0)]));
      for (let i = 0; i < Math.min(12, Math.max(item.revealed ?? 0, 1)); i++) bar.append(el('i', i < (item.revealed ?? 0) ? 'on' : ''));
      box.append(bar, el('span', 'bet-tag', item.step));
    }
    if (item.item) box.append(el('span', 'badge', `${item.item}${item.rarity ? ` (${item.rarity})` : ''}`));
    if (item.numbers) box.append(el('span', 'bet-tag', item.numbers.join(' ')));
    if (item.bets && item.game !== 'baccarat') box.append(el('span', 'bet-tag', betText(item.bets)));
    else if (item.bet && !item.bets) box.append(el('span', 'bet-tag', t('betOf', [number(item.bet)])));
  } else if (item.kind === 'work') {
    box.append(el('span', `badge ${item.correct ? 'good' : 'bad'}`, t(item.correct ? 'workRight' : 'workWrong')));
    if (item.type) box.append(el('span', 'bet-tag', item.type));
  } else if (item.kind === 'free') {
    const segment = item.segment;
    box.append(el('span', 'badge', segment?.label ?? (segment?.x ? `${segment.x}x` : (segment?.kind ?? item.what))));
  } else if (item.kind === 'level') {
    box.append(el('span', 'badge good', t('levelUpTo', [String(item.to)])));
  } else if (item.kind === 'reward') {
    const parts = ['standup', 'achievement', 'payroll', 'event'].filter((key) => item[key]).map((key) => `${t(`reward_${key}`)} ${number(item[key])}`);
    box.append(el('span', 'badge good', parts.join(', ')));
  } else if (item.kind === 'action') {
    const text = Object.entries(item.fields ?? {})
      .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
      .join('  ');
    const fields = el('span', 'action-fields', text);
    fields.title = text;
    box.append(fields);
  }
  return box;
}

function playTitle(item) {
  if (item.kind === 'game') return t(`game_${item.game}`);
  if (item.kind === 'free') return t(`free_${item.what}`);
  if (item.kind === 'action') return item.msg;
  return t(`play_${item.kind}`);
}

function playMoney(item) {
  const box = el('div', 'play-money');
  const value = item.kind === 'game' ? item.net : item.kind === 'reward' ? rewardSum(item) : item.credits;
  if (typeof value === 'number') box.append(el('span', `net ${value > 0 ? 'pos' : value < 0 ? 'neg' : ''}`, signed(value)));
  if (item.xp) box.append(el('span', 'sub', `${number(item.xp)} XP`));
  return box;
}

function playRow(item, enter = false) {
  const li = el('li', enter ? 'enter' : '');
  const time = el('time', '', clockTime(item.at));
  time.dateTime = new Date(item.at).toISOString();
  const what = el('span', 'play-what', playTitle(item));
  what.title = what.textContent;
  li.append(time, what, playVisual(item), playMoney(item));
  return li;
}

// A result in an account's strip: a roulette pocket in its color, any other
// game as a win or a loss. Null for plays that are not a finished round.
function stripChip(item, enter = false) {
  if (item.kind !== 'game' || item.step === 'start') return null;
  const chip = item.pocket !== undefined ? el('i', pocketColor(item.pocket), String(item.pocket)) : el('i', item.net >= 0 ? 'win' : 'loss');
  if (enter) chip.classList.add('pop');
  return chip;
}

function paceStats(items) {
  const from = Date.now() - PACE_WINDOW_MS;
  const games = items.filter((item) => item.kind === 'game' && item.at >= from);
  return {
    rate: games.length / (PACE_WINDOW_MS / 60_000),
    net: games.reduce((sum, item) => sum + (item.net ?? 0), 0),
    xp: games.reduce((sum, item) => sum + (item.xp ?? 0), 0),
  };
}

function updatePace(column, items) {
  const { rate, net, xp } = paceStats(items);
  column.rate.textContent = rate.toFixed(1);
  tween(column.net, net, signed);
  column.net.className = net > 0 ? 'pos' : net < 0 ? 'neg' : '';
  tween(column.xp, xp);
}

// One column per account, newest play first. Built when the accounts or the
// filters change; new plays are put on top of it as they come.
const columns = new Map();
let columnsKey = '';

function buildColumn(login) {
  const col = el('section', 'play-col');
  col.setAttribute('aria-label', login ?? '-');
  const head = el('div', 'play-col-head');
  const dot = el('span', 'dot');
  dot.style.background = accountColor(login);
  const pace = el('span', 'pace');
  pace.title = t('paceHint');
  const stat = (label) => {
    const span = el('span');
    const value = el('b');
    span.append(value, ` ${label}`);
    pace.append(span);
    return value;
  };
  const column = { col, rate: stat(t('perMinute')), net: stat(t('netShort')), xp: stat('XP') };
  head.append(dot, el('span', 'name', login ?? '-'), el('span', 'live-dot'), pace);
  column.strip = el('div', 'strip');
  column.strip.setAttribute('aria-hidden', 'true');
  column.list = el('ol', 'plays');
  col.append(head, column.strip, column.list);
  return column;
}

const playFilter = () => {
  const actions = $('play-actions').checked;
  return (item) => actions || item.kind !== 'action';
};

function renderPlays() {
  if (playsPaused) return;
  const shown = plays.filter(playFilter());
  const logins = [...new Set(shown.map((item) => item.account))].sort();
  $('play-empty').hidden = shown.length > 0;
  columns.clear();
  columnsKey = logins.join('\u0000');
  $('play-cols').replaceChildren(
    ...logins.map((login) => {
      const column = buildColumn(login);
      columns.set(login, column);
      const own = shown.filter((item) => item.account === login);
      column.list.append(...own.slice(0, PLAYS_SHOWN).map((item) => playRow(item)));
      column.strip.append(...own.map((item) => stripChip(item)).filter(Boolean).slice(0, STRIP_SHOWN).reverse());
      updatePace(column, own);
      return column.col;
    }),
  );
}

// New plays go on top of their column with an entrance; a new account or a
// play older than what is shown redraws everything.
function showNewPlays(items) {
  if (playsPaused) return;
  const fresh = items.filter(playFilter()).sort((a, b) => a.at - b.at);
  if (!fresh.length) return;
  const newest = plays.find(playFilter());
  const logins = [...new Set(plays.filter(playFilter()).map((item) => item.account))].sort();
  if (logins.join('\u0000') !== columnsKey || fresh.some((item) => item.at < (newest?.at ?? 0) - 60_000)) return renderPlays();
  for (const item of fresh) {
    const column = columns.get(item.account);
    column.list.prepend(playRow(item, motion()));
    while (column.list.children.length > PLAYS_SHOWN) column.list.lastChild.remove();
    const chip = stripChip(item, motion());
    if (chip) {
      column.strip.append(chip);
      while (column.strip.children.length > STRIP_SHOWN) column.strip.firstChild.remove();
    }
  }
  for (const [login, column] of columns) updatePace(column, plays.filter((item) => item.account === login));
  $('play-empty').hidden = true;
}

function addPlays(items) {
  const now = Date.now();
  const added = items.map((item) => ({ ...item, received: now }));
  plays.unshift(...added);
  plays.sort((a, b) => b.at - a.at);
  plays.length = Math.min(plays.length, PLAYS_KEPT);
  if (!columnsKey) renderPlays();
  else showNewPlays(added);
}

// Info lines of the activity log (a výpověď, a loan, a purchase) join the feed as actions.
function addActions(items) {
  const actions = items
    .filter((item) => item.level !== 'debug' && !QUIET_ACTIONS.has(item.msg))
    .map((item) => ({ kind: 'action', at: Date.parse(item.time), account: item.account ?? null, msg: item.msg, fields: item.fields }));
  if (actions.length) addPlays(actions);
}

$('play-actions').addEventListener('change', renderPlays);
$('play-pause').addEventListener('click', () => {
  playsPaused = !playsPaused;
  $('play-pause').setAttribute('aria-pressed', String(playsPaused));
  $('play-pause').textContent = t(playsPaused ? 'resume' : 'pause');
  renderPlays();
});

// ---------- live updates ----------

function connect() {
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => setConnected(true));
  source.addEventListener('panel', (event) => showPanel(JSON.parse(event.data)));
  source.addEventListener('report', (event) => {
    report = JSON.parse(event.data);
    renderReport();
  });
  source.addEventListener('plays', (event) => addPlays(JSON.parse(event.data)));
  source.addEventListener('activity', (event) => {
    addActions(JSON.parse(event.data));
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
  renderBoards();
  renderChanges();
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
