// Dashboard server: login page, the dashboard, a JSON API to control the bot,
// a server-sent event stream of its status and log, and /health.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAuth, readCookie, COOKIE_NAME } from './auth.mjs';
import { log } from './log.mjs';
import { Runner } from './runner.mjs';
import { Store } from './store.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const env = process.env;
const port = Number(env.PORT || 8080);
const trustProxy = env.TRUST_PROXY === '1';
const extensionDir = resolve(env.EXTENSION_DIR || join(root, '..'));
const dataDir = resolve(env.DATA_DIR || join(root, '.data'));


const auth = createAuth({ user: env.DASHBOARD_USER || 'admin', password: env.DASHBOARD_PASSWORD });
const store = new Store(join(dataDir, 'storage.json'));
const runner = new Runner({
  extensionDir,
  store,
  casinoUrl: env.CASINO_URL || 'https://skeleton-casino.jrezab.cz/',
  // Public values from the casino's own client bundle.
  supabaseUrl: env.SUPABASE_URL || 'https://xrgcdzxellfcscbybrec.supabase.co',
  supabaseKey: env.SUPABASE_KEY || 'sb_publishable_582CKqAOfQSOLdNhjZ-cOg_4-Rbq4tr',
  locale: store.get('serverLocale').serverLocale || env.BOT_LOCALE || 'cs',
});
const LOCALES = ['cs', 'en'];

const PUBLIC = {
  '/login': ['login.html', 'text/html; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/i18n.js': ['i18n.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/chrome-shim.js': ['chrome-shim.js', 'text/javascript; charset=utf-8'],
  '/settings-embed.css': ['settings-embed.css', 'text/css; charset=utf-8'],
};

// The settings page is the extension's own options.html, served from its
// src folder with chrome.storage and chrome.i18n shimmed over this API.
const EXT_FILE = /^\/ext\/([\w-]+\.(?:js|css))$/;
const EXT_TYPES = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };
// Saved logins never leave the server: the settings page sees this instead,
// and a write that sends it back keeps the stored session.
const SESSION_MARK = '[kept on the server]';

const HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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
  return isAccountKey(key) && value?.session ? { ...value, session: SESSION_MARK } : value;
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
    if (isAccountKey(key) && value?.session === SESSION_MARK) {
      set[key] = { ...value, session: stored[key]?.session, storageKey: stored[key]?.storageKey };
      if (!set[key].session) delete set[key].session;
    }
  }
  store.set(set);
  return { ok: true };
}

// Every dashboard event path is a short list of child indexes.
const isPath = (path) => Array.isArray(path) && path.length <= 32 && path.every((i) => Number.isInteger(i) && i >= 0 && i < 1000);

// Routes that need a signed-in session; mutations also need the same origin.
const API = {
  'GET /api/config': () => ({ locale: runner.locale }),
  // The panel is rendered in one language, so switching it reboots the page context.
  'POST /api/locale': async ({ body }) => {
    if (!LOCALES.includes(body.locale)) return [400, { error: 'bad_request' }];
    if (body.locale !== runner.locale) {
      store.set({ serverLocale: body.locale });
      await runner.setLocale(body.locale);
    }
    return { ok: true };
  },
  'POST /api/account/switch': ({ body }) => {
    if (typeof body.id !== 'string' || body.id.length > 100) return [400, { error: 'bad_request' }];
    return runner.switchTo(body.id) ? { ok: true } : [409, { error: 'no_session' }];
  },
  'GET /api/storage': () => redactAll(store.get(null)),
  'POST /api/storage/set': ({ body }) => storageSet(body.items),
  'POST /api/storage/remove': ({ body }) => {
    if (!Array.isArray(body.keys) || !body.keys.every((key) => typeof key === 'string')) return [400, { error: 'bad_request' }];
    store.remove(body.keys);
    return { ok: true };
  },
  'POST /api/panel/event': ({ body }) => {
    if (!isPath(body.path) || !['click', 'change', 'toggle'].includes(body.type)) return [400, { error: 'bad_request' }];
    if (body.type === 'change' && (typeof body.value !== 'string' || body.value.length > 1000)) return [400, { error: 'bad_request' }];
    const done = runner.panelEvent({ path: body.path, type: body.type, value: body.value, open: !!body.open });
    setImmediate(pushPanel);
    return done ? { ok: true } : [404, { error: 'not_found' }];
  },
  'POST /api/account/signin': async ({ body }) => {
    if (typeof body.email !== 'string' || typeof body.password !== 'string' || !body.email || !body.password) return [400, { error: 'bad_request' }];
    const result = await runner.signIn(body.email.trim(), body.password);
    log.info('casino_signin', { ok: !result.error });
    return result.error ? [401, result] : result;
  },
};

const BODY_LIMIT = { 'POST /api/storage/set': 50 * 1024 * 1024 };

const streams = new Set();

// The dashboard's stream carries the log, the report and the mirrored panel;
// the settings page's (?storage=1) carries storage changes for onChanged.
function events(req, res, url) {
  res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
  const storage = url.searchParams.get('storage') === '1';
  if (!storage) {
    res.write(`event: activity\ndata: ${JSON.stringify(runner.activity.slice(-200))}\n\n`);
    res.write(`event: report\ndata: ${JSON.stringify(runner.report())}\n\n`);
    res.write(`event: panel\ndata: ${JSON.stringify(runner.panelHtml())}\n\n`);
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
setInterval(() => streams.size && broadcast('report', runner.report()), 2000);
store.onChanged((changes) => broadcast('storage', redactChanges(changes)));

let lastPanel = '';
function pushPanel() {
  const html = runner.panelHtml();
  if (html === lastPanel) return;
  lastPanel = html;
  broadcast('panel', html);
}
setInterval(() => streams.size && pushPanel(), 500);

// options.html with the shim loaded before its scripts, framable by the dashboard.
function serveOptions(res) {
  const html = readFileSync(join(extensionDir, 'src', 'options.html'), 'utf8')
    .replace('<link rel="stylesheet" href="options.css" />', '<link rel="stylesheet" href="options.css" />\n    <link rel="stylesheet" href="/settings-embed.css" />')
    .replace(
      '<script src="core.js"></script>',
      '<script src="/ext/messages.js"></script>\n    <script src="/chrome-shim.js"></script>\n    <script src="core.js"></script>',
    );
  const csp = HEADERS['Content-Security-Policy'].replace("frame-ancestors 'none'", "frame-ancestors 'self'");
  send(res, 200, html, 'text/html; charset=utf-8', { 'Content-Security-Policy': csp });
}

// The extension's messages for the shim's chrome.i18n, every locale.
function serveMessages(res) {
  const tables = {};
  for (const lang of ['en', 'cs']) tables[lang] = JSON.parse(readFileSync(join(extensionDir, '_locales', lang, 'messages.json'), 'utf8'));
  send(res, 200, `window.BotterMessages = ${JSON.stringify(tables)};`, 'text/javascript; charset=utf-8');
}

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
    if (req.method === 'GET' && url.pathname.startsWith('/ext/')) {
      if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
      if (url.pathname === '/ext/options.html') return serveOptions(res);
      if (url.pathname === '/ext/messages.js') return serveMessages(res);
      const name = url.pathname.match(EXT_FILE)?.[1];
      const file = name && join(extensionDir, 'src', name);
      if (file && existsSync(file)) return send(res, 200, readFileSync(file), EXT_TYPES[name.split('.').pop()]);
      return send(res, 404, { error: 'not_found' });
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
