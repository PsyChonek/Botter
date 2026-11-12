// Dashboard server: login page, the dashboard, a JSON API to control the bot,
// a server-sent event stream of its status and log, and /health.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth, readCookie, COOKIE_NAME } from './auth.mjs';
import { History, SAMPLE_EVERY_MS } from './history.mjs';
import { Leaderboards } from './leaderboards.mjs';
import { log } from './log.mjs';
import { Runner } from './runner.mjs';
import { Store } from './store.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const env = process.env;
const port = Number(env.PORT || 8080);
const trustProxy = env.TRUST_PROXY === '1';
const botDir = resolve(env.BOT_DIR || join(root, '..'));
const require = createRequire(import.meta.url);
const core = require(join(botDir, 'src', 'core.js'));
const backups = require(join(botDir, 'src', 'backup.js'));
const dataDir = resolve(env.DATA_DIR || join(root, '.data'));


const auth = createAuth({ user: env.DASHBOARD_USER || 'admin', password: env.DASHBOARD_PASSWORD, file: join(dataDir, 'sessions.json') });
const store = new Store(join(dataDir, 'storage.json'));
const history = new History(join(dataDir, 'history.json'));
const runner = new Runner({
  botDir,
  store,
  casinoUrl: env.CASINO_URL || 'https://skeleton-casino.jrezab.cz/',
  // Public values from the casino's own client bundle.
  supabaseUrl: env.SUPABASE_URL || 'https://xrgcdzxellfcscbybrec.supabase.co',
  supabaseKey: env.SUPABASE_KEY || 'sb_publishable_582CKqAOfQSOLdNhjZ-cOg_4-Rbq4tr',
  locale: store.get('serverLocale').serverLocale || env.BOT_LOCALE || 'cs',
});
const leaderboards = new Leaderboards({
  fetchBoard: (by) => runner.casinoGet(`/api/leaderboard?by=${by}`),
  ownIds: () => new Set(runner.accounts().map(([id]) => id)),
});
const LOCALES = ['cs', 'en'];

const PUBLIC = {
  '/login': ['login.html', 'text/html; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/storage.js': ['storage.js', 'text/javascript; charset=utf-8'],
  '/settings.js': ['settings.js', 'text/javascript; charset=utf-8'],
  '/controls.js': ['controls.js', 'text/javascript; charset=utf-8'],
};

// The bot's own modules the settings and statistics use in the browser (bet
// levels, odds tables, model checks, the backup format), behind the login.
const LIB = new Set(['core', 'games', 'blackjack', 'baccarat', 'dice', 'cases', 'egypt', 'mines', 'blaze', 'odds-table', 'odds', 'auto']);
const LIB_FILE = /^\/lib\/([\w-]+)\.js$/;
// Saved logins and API keys never leave the server: the browser sees this
// instead, and a write that sends it back keeps the stored value.
const SECRET_MARK = '[kept on the server]';
const SECRET_KEYS = ['apiKey', 'openrouterKey'];
const BACKUP_TYPE = 'application/json; charset=utf-8';

const HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function clientIp(req) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? '';
}

function isHttps(req) {
  return req.socket.encrypted || (trustProxy && req.headers['x-forwarded-proto'] === 'https');
}

// Every request that changes something must come from this origin.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  const host = (trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const authed = (req) => auth.valid(readCookie(req.headers.cookie, COOKIE_NAME));

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveFile(res, name, type) {
  send(res, 200, readFileSync(join(root, 'public', name)), type);
}

async function readJson(req, limit) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new Error('too_large');
  }
  return JSON.parse(body || '{}');
}

function sessionCookie(req, token, maxAge) {
  const secure = isHttps(req) ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

const isAccountKey = (key) => key.startsWith('account:');

function redact(key, value) {
  if (SECRET_KEYS.includes(key)) return value ? SECRET_MARK : value;
  return isAccountKey(key) && value?.session ? { ...value, session: SECRET_MARK } : value;
}

function redactAll(items) {
  return Object.fromEntries(Object.entries(items).map(([key, value]) => [key, redact(key, value)]));
}

function redactChanges(changes) {
  return Object.fromEntries(
    Object.entries(changes).map(([key, change]) => [key, { oldValue: redact(key, change.oldValue), newValue: redact(key, change.newValue) }]),
  );
}

function storageSet(items) {
  if (!items || typeof items !== 'object' || Array.isArray(items)) return [400, { error: 'bad_request' }];
  const stored = store.get(null);
  const set = { ...items };
  for (const [key, value] of Object.entries(set)) {
    if (SECRET_KEYS.includes(key) && value === SECRET_MARK) delete set[key];
    else if (isAccountKey(key) && value?.session === SECRET_MARK) {
      set[key] = { ...value, session: stored[key]?.session, storageKey: stored[key]?.storageKey };
      if (!set[key].session) delete set[key].session;
    }
  }
  store.set(set);
  return { ok: true };
}

// One id per install, so a backup imported back into the install it came from
// does not add its stats a second time.
function installId() {
  const { installId: id } = store.get('installId');
  if (id) return id;
  const created = randomUUID();
  store.set({ installId: created });
  return created;
}

// The switches the dashboard sends to one account's bot (BotterHeadless.command).
const COMMANDS = { auto: 'boolean', work: 'boolean', games: 'boolean', taskType: 'string', game: 'string', hotfixTest: 'undefined' };

// Routes that need a signed-in session; mutations also need the same origin.
const API = {
  'GET /api/config': () => ({ locale: runner.locale }),
  // The bot writes its status lines in one language, so switching reboots every account's context.
  'POST /api/locale': async ({ body }) => {
    if (!LOCALES.includes(body.locale)) return [400, { error: 'bad_request' }];
    if (body.locale !== runner.locale) {
      store.set({ serverLocale: body.locale });
      await runner.setLocale(body.locale);
    }
    return { ok: true };
  },

  'GET /api/history': () => history,
  'GET /api/leaderboards': () => leaderboards.get(),
  // The casino deploys the bot has seen and the app's own changelog (trackBundle in content.js).
  'GET /api/changes': () => {
    const { bundle = null, bundleLog = [] } = store.get(['bundle', 'bundleLog']);
    return { bundle, log: [...bundleLog].reverse() };
  },
  'GET /api/storage': () => redactAll(store.get(null)),
  'POST /api/storage/set': ({ body }) => storageSet(body.items),
  'POST /api/storage/remove': ({ body }) => {
    if (!Array.isArray(body.keys) || !body.keys.every((key) => typeof key === 'string')) return [400, { error: 'bad_request' }];
    store.remove(body.keys);
    return { ok: true };
  },
  'POST /api/bot/command': ({ body }) => {
    const { account, command, value } = body;
    if (typeof account !== 'string' || !Object.hasOwn(COMMANDS, command) || typeof value !== COMMANDS[command]) return [400, { error: 'bad_request' }];
    if (typeof value === 'string' && value.length > 40) return [400, { error: 'bad_request' }];
    const done = runner.command(account, command, value);
    if (done) log.info('bot_command', { account, command, value });
    return done ? { ok: true } : [404, { error: 'not_found' }];
  },
  // Built on the server, where the keys and logins are, and only with them when asked.
  'GET /api/backup': ({ url }) => {
    const secrets = url.searchParams.get('secrets') === '1';
    const backup = backups.buildBackup(store.get(null), { secrets, id: randomUUID(), source: installId() });
    log.info('backup_export', { secrets });
    return [200, backup, { 'Content-Disposition': `attachment; filename="botter-backup-${backup.exportedAt.slice(0, 10)}.json"` }];
  },
  'POST /api/backup/import': ({ body }) => {
    if (!backups.isBackup(body.backup)) return [400, { error: 'not_a_backup' }];
    const { set, counts, statsSkipped } = backups.importBackup(store.get(null), body.backup, { install: installId(), isBankEntry: core.isBankEntry });
    store.set(set);
    log.info('backup_import', { ...counts, statsSkipped });
    return { ok: true, counts, statsSkipped };
  },
  'POST /api/account/signin': async ({ body }) => {
    if (typeof body.email !== 'string' || typeof body.password !== 'string' || !body.email || !body.password) return [400, { error: 'bad_request' }];
    const result = await runner.signIn(body.email.trim(), body.password);
    log.info('casino_signin', { ok: !result.error });
    return result.error ? [401, result] : result;
  },
  'POST /api/account/github/start': () => runner.githubStart(),
  'POST /api/account/github/finish': async ({ body }) => {
    if (typeof body.id !== 'string' || body.id.length > 100 || typeof body.url !== 'string' || !body.url || body.url.length > 4000) return [400, { error: 'bad_request' }];
    const result = await runner.githubFinish(body.id, body.url);
    log.info('casino_github_signin', { ok: !result.error });
    return result.error ? [401, result] : result;
  },
};

const BODY_LIMIT = { 'POST /api/storage/set': 50 * 1024 * 1024, 'POST /api/backup/import': 50 * 1024 * 1024 };

const streams = new Set();

// The dashboard's stream carries the log, the plays and the report; the
// settings' (?storage=1) carries storage changes.
function events(req, res, url) {
  res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
  const storage = url.searchParams.get('storage') === '1';
  if (!storage) {
    res.write(`event: activity\ndata: ${JSON.stringify(runner.activity.slice(-200))}\n\n`);
    res.write(`event: plays\ndata: ${JSON.stringify(runner.plays.slice(-120))}\n\n`);
    res.write(`event: report\ndata: ${JSON.stringify(runner.report())}\n\n`);
  }
  const stream = { res, storage, token: readCookie(req.headers.cookie, COOKIE_NAME) };
  streams.add(stream);
  req.on('close', () => streams.delete(stream));
}

function broadcast(event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const stream of streams) {
    if (stream.storage !== (event === 'storage')) continue;
    // A session that signed out stops receiving.
    if (!auth.valid(stream.token)) {
      stream.res.end();
      streams.delete(stream);
      continue;
    }
    stream.res.write(line);
  }
}

runner.on('activity', (item) => broadcast('activity', [item]));
// Plays come several a second per account, so they go out in batches.
let playBatch = [];
runner.on('play', (item) => playBatch.push(item));
setInterval(() => {
  if (!playBatch.length) return;
  if (streams.size) broadcast('plays', playBatch);
  playBatch = [];
}, 500);
setInterval(() => streams.size && broadcast('report', runner.report()), 2000);
store.onChanged((changes) => broadcast('storage', redactChanges(changes)));

function recordHistory() {
  try {
    history.record(runner.report());
  } catch (error) {
    log.error('history_failed', { error: error.message });
  }
}
setInterval(recordHistory, SAMPLE_EVERY_MS);
// The first sample once the page has loaded the player.
setTimeout(recordHistory, 60_000);

// The bot's messages in every locale, for the settings.
function serveMessages(res) {
  const tables = {};
  for (const lang of LOCALES) tables[lang] = JSON.parse(readFileSync(join(botDir, '_locales', lang, 'messages.json'), 'utf8'));
  send(res, 200, `window.BotterMessages = ${JSON.stringify(tables)};`, 'text/javascript; charset=utf-8');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /health') return send(res, runner.page ? 200 : 503, { status: runner.page ? 'ok' : 'down' });
    if (route === 'GET /') {
      const token = readCookie(req.headers.cookie, COOKIE_NAME);
      if (!auth.touch(token)) return send(res, 302, '', 'text/plain', { Location: '/login' });
      // Opening the dashboard renews the cookie along with the session.
      res.setHeader('Set-Cookie', sessionCookie(req, token, auth.maxAgeSeconds));
      return serveFile(res, 'app.html', 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && PUBLIC[url.pathname]) return serveFile(res, ...PUBLIC[url.pathname]);
    if (req.method === 'GET' && url.pathname.startsWith('/lib/')) {
      if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
      if (url.pathname === '/lib/messages.js') return serveMessages(res);
      const name = url.pathname.match(LIB_FILE)?.[1];
      if (!LIB.has(name)) return send(res, 404, { error: 'not_found' });
      return send(res, 200, readFileSync(join(botDir, 'src', `${name}.js`)), 'text/javascript; charset=utf-8');
    }

    if (route === 'POST /api/login') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
      const { user, password } = await readJson(req, 4096);
      const ip = clientIp(req);
      const result = auth.login(ip, String(user ?? ''), String(password ?? ''));
      if (result.error) {
        log.warn('login_failed', { ip, reason: result.error });
        return send(res, result.error === 'rate_limited' ? 429 : 401, { error: result.error });
      }
      log.info('login', { ip });
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': sessionCookie(req, result.token, auth.maxAgeSeconds) });
    }
    if (route === 'POST /api/logout') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
      auth.logout(readCookie(req.headers.cookie, COOKIE_NAME));
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }

    if (route === 'GET /api/events' || API[route]) {
      if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
      if (route === 'GET /api/events') return events(req, res, url);
      if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
      const body = req.method === 'POST' ? await readJson(req, BODY_LIMIT[route] ?? 16 * 1024) : {};
      const result = await API[route]({ body, url });
      const [status, payload, extra] = Array.isArray(result) ? result : [200, result];
      return send(res, status, payload, undefined, extra);
    }
    send(res, 404, { error: 'not_found' });
  } catch (error) {
    log.error('request_failed', { route, error: error.message });
    if (!res.headersSent) send(res, 400, { error: 'bad_request' });
  }
});

function shutdown(signal) {
  log.info('shutting_down', { signal });
  server.close();
  runner.stop();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await runner.start();
server.listen(port, () => log.info('listening', { port }));
