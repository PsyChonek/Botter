const { t, apply, toggle } = window.I18n;
const $ = (id) => document.getElementById(id);

const ACTIVITY_SHOWN = 200;
let report = null;
let connected = false;

const number = (value) => (typeof value === 'number' ? new Intl.NumberFormat(I18n.lang).format(Math.round(value)) : '-');

async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401) location.assign('/login');
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

// ---------- live updates ----------

function connect() {
  const source = new EventSource('/api/events');
  source.addEventListener('open', () => setConnected(true));
  source.addEventListener('report', (event) => {
    report = JSON.parse(event.data);
    render();
  });
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

// ---------- rendering ----------

function render() {
  $('status').textContent = report?.status || t('statusNone');
  const player = report?.player;
  $('fact-account').textContent = player?.login ?? t('notLoggedIn');
  $('fact-level').textContent = number(player?.level);
  $('fact-credits').textContent = number(player?.credits);
  $('fact-energy').textContent = player ? `${player.energy} / ${player.maxEnergy}` : '-';
  $('fact-bank').textContent = number(report?.bank);
  const answers = report?.answers;
  $('fact-answers').textContent = answers
    ? ['bank', 'ai', 'guess'].map((key) => `${t(`source_${key}`)} ${answers[key].correct}/${answers[key].total}`).join(', ')
    : '-';
  $('fact-work').textContent = report?.work ? `${number(report.work.tickets)} (${number(report.work.net)})` : '-';
  $('fact-games').textContent = number(report?.gamesNet);

  for (const button of document.querySelectorAll('[data-toggle]')) {
    const on = !!report?.settings?.[button.dataset.toggle];
    button.setAttribute('aria-pressed', String(on));
    button.classList.toggle('on', on);
  }
  const solver = report?.settings?.aiSolver;
  if (solver && document.activeElement !== $('solver-kind') && !$('solver-kind').dataset.touched) $('solver-kind').value = solver;

  const problems = report?.bundle?.problems ?? [];
  $('bundle').hidden = !problems.length;
  $('bundle').textContent = problems.length ? `${t('bundleStale')}: ${problems.join('; ')}` : '';

  renderAccounts(report?.accounts ?? []);
}

function renderAccounts(accounts) {
  $('accounts-empty').hidden = accounts.length > 0;
  $('accounts').hidden = accounts.length === 0;
  $('accounts').tBodies[0].replaceChildren(
    ...accounts.map((account) => {
      const row = document.createElement('tr');
      const cells = [account.login, number(account.level), number(account.credits), account.energy ?? '-'];
      for (const value of cells) {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.append(cell);
      }
      const action = document.createElement('td');
      if (account.current) {
        action.textContent = t('current');
      } else if (!account.session) {
        action.textContent = t('noSession');
        action.className = 'muted';
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

for (const button of document.querySelectorAll('[data-toggle]')) {
  button.addEventListener('click', async () => {
    const on = button.getAttribute('aria-pressed') !== 'true';
    button.setAttribute('aria-pressed', String(on));
    await post('/api/toggle', { [button.dataset.toggle]: on });
  });
}

$('signin').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = $('signin-result');
  result.textContent = t('working');
  const res = await post('/api/account/signin', { email: $('signin-email').value, password: $('signin-password').value });
  $('signin-password').value = '';
  result.textContent = t(res.ok ? 'signinOk' : res.data?.error === 'invalid' ? 'signinInvalid' : 'signinFailed');
});

$('solver-kind').addEventListener('change', () => ($('solver-kind').dataset.touched = '1'));
$('solver').addEventListener('submit', async (event) => {
  event.preventDefault();
  const aiSolver = $('solver-kind').value;
  const key = $('solver-key').value.trim();
  const body = { aiSolver, ...(aiSolver === 'claude' && key ? { apiKey: key } : {}), ...(aiSolver === 'openrouter' && key ? { openrouterKey: key } : {}) };
  const res = await post('/api/solver', body);
  $('solver-key').value = '';
  delete $('solver-kind').dataset.touched;
  $('solver-result').textContent = t(res.ok ? 'saved' : 'saveFailed');
});

$('backup-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  const result = $('backup-result');
  result.textContent = t('working');
  let backup;
  try {
    backup = JSON.parse(await file.text());
  } catch {
    result.textContent = t('backupInvalid');
    return;
  }
  const res = await post('/api/backup/import', backup);
  if (!res.ok) {
    result.textContent = t(res.data?.error === 'not_backup' ? 'backupInvalid' : 'backupFailed');
    return;
  }
  const { counts, sessions } = res.data;
  result.textContent = `${t('backupDone')} ${counts.accounts} / ${counts.answers} / ${counts.stats}. ${sessions ? '' : t('backupNoSessions')}`;
});

$('backup-export').addEventListener('click', async () => {
  const secrets = $('backup-secrets').checked;
  if (secrets && !confirm(t('backupSecretsConfirm'))) return;
  const res = await fetch(`/api/backup/export${secrets ? '?secrets=1' : ''}`);
  if (!res.ok) return;
  const backup = await res.json();
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
  link.download = `botter-backup-${backup.exportedAt.slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});

$('lang').addEventListener('click', () => {
  toggle();
  setConnected(connected);
  render();
});
$('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.assign('/login');
});

apply();
setConnected(false);
render();
connect();
