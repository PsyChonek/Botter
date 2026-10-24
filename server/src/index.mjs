// Dashboard server: login page, the dashboard, a JSON API to control the bot,
// a server-sent event stream of its status and log, and /health.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth, readCookie, COOKIE_NAME } from './auth.mjs';
import { log } from './log.mjs';
import { Runner } from './runner.mjs';
import { Store } from './store.mjs';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const env = process.env;
const port = Number(env.PORT || 8080);
const trustProxy = env.TRUST_PROXY === '1';
const extensionDir = resolve(env.EXTENSION_DIR || join(root, '..'));
const dataDir = resolve(env.DATA_DIR || join(root, '.data'));

const Core = require(join(extensionDir, 'src', 'core.js'));
const Backup = require(join(extensionDir, 'src', 'backup.js'));

const auth = createAuth({ user: env.DASHBOARD_USER || 'admin', password: env.DASHBOARD_PASSWORD });
const store = new Store(join(dataDir, 'storage.json'));
const runner = new Runner({
  extensionDir,
  store,
  casinoUrl: env.CASINO_URL || 'https://skeleton-casino.jrezab.cz/',
  // Public values from the casino's own client bundle.
  supabaseUrl: env.SUPABASE_URL || 'https://xrgcdzxellfcscbybrec.supabase.co',
  supabaseKey: env.SUPABASE_KEY || 'sb_publishable_582CKqAOfQSOLdNhjZ-cOg_4-Rbq4tr',
  locale: env.BOT_LOCALE || 'cs',
});

const PUBLIC = {
  '/login': ['login.html', 'text/html; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

const SOLVERS = ['local', 'claude', 'openrouter', 'off'];
const TOGGLES = ['autoMode', 'enabled', 'gamesEnabled'];

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

// One id per install, like the extension's, so a backup exported here and
// imported back does not add its stats twice.
function installId() {
  const { installId: id } = store.get('installId');
  if (id) return id;
  const created = randomUUID();
  store.set({ installId: created });
  return created;
}

async function importBackup(backup) {
  if (!Backup.isBackup(backup)) return { error: 'not_backup' };
  const stored = store.get(null);
  const { set, counts, statsSkipped } = Backup.importBackup(stored, backup, { install: installId(), isBankEntry: Core.isBankEntry });
  // A login in the file that is newer than the one here replaces it: the
  // older refresh token has most likely been revoked.
  for (const [id, incoming] of Object.entries(backup.accounts ?? {})) {
    const key = `account:${id}`;
    const local = set[key] ?? stored[key];
    if (local && incoming?.session && Core.isNewerSession(incoming.session, local.session)) {
      set[key] = { ...local, session: incoming.session, storageKey: incoming.storageKey ?? local.storageKey };
    }
  }
  store.set(set);
  await runner.reload();
  const sessions = Object.values(backup.accounts ?? {}).filter((saved) => saved?.session).length;
  return { ok: true, counts, statsSkipped, sessions };
}

function settingsPatch(patch) {
  const { settings = {} } = store.get('settings');
  store.set({ settings: { ...settings, ...patch } });
}

// Routes that need a signed-in session; mutations also need the same origin.
const API = {
  'POST /api/toggle': ({ body }) => {
    const patch = Object.fromEntries(TOGGLES.filter((key) => typeof body[key] === 'boolean').map((key) => [key, body[key]]));
    if (!Object.keys(patch).length) return [400, { error: 'bad_request' }];
    settingsPatch(patch);
    log.info('toggle', patch);
    return { ok: true };
  },
  'POST /api/solver': ({ body }) => {
    if (!SOLVERS.includes(body.aiSolver)) return [400, { error: 'bad_request' }];
    settingsPatch({ aiSolver: body.aiSolver });
    const keys = {};
    if (typeof body.apiKey === 'string' && body.apiKey.trim()) keys.apiKey = body.apiKey.trim();
    if (typeof body.openrouterKey === 'string' && body.openrouterKey.trim()) keys.openrouterKey = body.openrouterKey.trim();
    store.set(keys);
    log.info('solver', { aiSolver: body.aiSolver, keys: Object.keys(keys) });
    return { ok: true };
  },
  'POST /api/account/switch': async ({ body }) => {
    if (typeof body.id !== 'string') return [400, { error: 'bad_request' }];
    const result = await runner.switchTo(body.id);
    return result.error ? [409, result] : result;
  },
  'POST /api/account/signin': async ({ body }) => {
    if (typeof body.email !== 'string' || typeof body.password !== 'string' || !body.email || !body.password) return [400, { error: 'bad_request' }];
    const result = await runner.signIn(body.email.trim(), body.password);
    log.info('casino_signin', { ok: !result.error });
    return result.error ? [401, result] : result;
  },
  'POST /api/backup/import': async ({ body }) => {
    const result = await importBackup(body);
    log.info('backup_import', { ok: !result.error, counts: result.counts, sessions: result.sessions });
    return result.error ? [400, result] : result;
  },
  'GET /api/backup/export': ({ url }) => {
    const secrets = url.searchParams.get('secrets') === '1';
    const backup = Backup.buildBackup(store.get(null), { secrets, id: randomUUID(), source: installId() });
    log.info('backup_export', { secrets });
    return backup;
  },
};

const BODY_LIMIT = { 'POST /api/backup/import': 50 * 1024 * 1024 };

const streams = new Set();

function events(req, res) {
  res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
  res.write(`event: activity\ndata: ${JSON.stringify(runner.activity.slice(-200))}\n\n`);
  res.write(`event: report\ndata: ${JSON.stringify(runner.report())}\n\n`);
  const stream = { res, token: readCookie(req.headers.cookie, COOKIE_NAME) };
  streams.add(stream);
  req.on('close', () => streams.delete(stream));
}

function broadcast(event, data) {
  const line = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const stream of streams) {
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
setInterval(() => streams.size && broadcast('report', runner.report()), 2000);

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === 'GET /health') return send(res, runner.page ? 200 : 503, { status: runner.page ? 'ok' : 'down' });
    if (route === 'GET /') {
      if (!authed(req)) return send(res, 302, '', 'text/plain', { Location: '/login' });
      return serveFile(res, 'app.html', 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && PUBLIC[url.pathname]) return serveFile(res, ...PUBLIC[url.pathname]);

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
      if (route === 'GET /api/events') return events(req, res);
      if (req.method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
      const body = req.method === 'POST' ? await readJson(req, BODY_LIMIT[route] ?? 16 * 1024) : {};
      const result = await API[route]({ body, url });
      const [status, payload] = Array.isArray(result) ? result : [200, result];
      return send(res, status, payload);
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
