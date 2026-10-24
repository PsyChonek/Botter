// Dashboard server: login page, the dashboard, /health and one WebSocket that
// streams the browser to the dashboard and carries input back.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { createAuth, readCookie, COOKIE_NAME } from './auth.mjs';
import { Bot } from './browser.mjs';
import { log } from './log.mjs';
import { parseClientMessage } from './protocol.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const env = process.env;
const port = Number(env.PORT || 8080);
const trustProxy = env.TRUST_PROXY === '1';

const auth = createAuth({ user: env.DASHBOARD_USER || 'admin', password: env.DASHBOARD_PASSWORD });
const bot = new Bot({
  extensionDir: resolve(env.EXTENSION_DIR || join(root, '..')),
  profileDir: resolve(env.PROFILE_DIR || join(root, '.profile')),
  casinoUrl: env.CASINO_URL || 'https://skeleton-casino.jrezab.cz/',
  headless: env.HEADLESS !== '0',
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
    "default-src 'self'; img-src 'self' data: blob:; connect-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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

// Cookie mutations and the WebSocket only accept requests from this origin.
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

function authed(req) {
  return auth.valid(readCookie(req.headers.cookie, COOKIE_NAME));
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveFile(res, name, type) {
  send(res, 200, readFileSync(join(root, 'public', name)), type);
}

async function readJson(req, limit = 4096) {
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

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (req.method === 'GET' && pathname === '/health') {
      return send(res, bot.running ? 200 : 503, { status: bot.running ? 'ok' : 'down', tabs: bot.tabs.size });
    }
    if (req.method === 'GET' && pathname === '/') {
      if (!authed(req)) return send(res, 302, '', 'text/plain', { Location: '/login' });
      return serveFile(res, 'app.html', 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && PUBLIC[pathname]) return serveFile(res, ...PUBLIC[pathname]);

    if (req.method === 'POST' && pathname === '/api/login') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
      const { user, password } = await readJson(req);
      const ip = clientIp(req);
      const result = auth.login(ip, String(user ?? ''), String(password ?? ''));
      if (result.error) {
        log.warn('login failed', { ip, reason: result.error });
        return send(res, result.error === 'rate_limited' ? 429 : 401, { error: result.error });
      }
      log.info('login', { ip });
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': sessionCookie(req, result.token, auth.maxAgeSeconds) });
    }
    if (req.method === 'POST' && pathname === '/api/logout') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'forbidden' });
      auth.logout(readCookie(req.headers.cookie, COOKIE_NAME));
      return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': sessionCookie(req, '', 0) });
    }
    send(res, 404, { error: 'not_found' });
  } catch (error) {
    log.error('request failed', { path: pathname, error: error.message });
    if (!res.headersSent) send(res, 400, { error: 'bad_request' });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname !== '/ws' || !sameOrigin(req) || !authed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const ws of wss.clients) {
    // Skip frames for a client that is still behind instead of queueing them.
    if (message.type === 'frame' && ws.bufferedAmount > 2_000_000) continue;
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

bot.on('state', (state) => broadcast({ type: 'state', ...state }));
bot.on('frame', (frame) => broadcast({ type: 'frame', ...frame }));
bot.on('activity', (item) => broadcast({ type: 'activity', item }));
bot.on('panel', (panel) => broadcast({ type: 'panel', panel }));

// Commands run one at a time, in arrival order, so key presses and clicks
// reach the page in the order they were made.
let commands = Promise.resolve();

async function run(message) {
  try {
    if (message.type === 'input') await bot.input(message.event);
    else if (message.type === 'select') await bot.select(message.id);
    else if (message.type === 'open') await bot.open(message.target);
    else if (message.type === 'close') await bot.close(message.id);
    else if (message.type === 'nav') await bot.navigate(message.action, message.url);
  } catch (error) {
    log.debug('command failed', { type: message.type, error: error.message });
  }
}

wss.on('connection', async (ws, req) => {
  ws.on('message', (raw) => {
    // A session that logged out elsewhere stops controlling the browser.
    if (!authed(req)) return ws.close(4001, 'unauthorized');
    const message = parseClientMessage(raw);
    if (message) commands = commands.then(() => run(message));
  });

  const state = await bot.state();
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify({ type: 'state', ...state }));
  ws.send(JSON.stringify({ type: 'activity', items: bot.activity }));
  ws.send(JSON.stringify({ type: 'panel', panel: bot.panel }));
  if (bot.lastFrame) ws.send(JSON.stringify({ type: 'frame', ...bot.lastFrame }));
});

async function shutdown(signal) {
  log.info('shutting down', { signal });
  server.close();
  await bot.stop();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

bot.on('closed', () => process.exit(1));
await bot.start();
server.listen(port, () => log.info('listening', { port }));
