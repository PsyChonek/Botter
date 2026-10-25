// The runner against a fake casino: it logs in from a saved account, works
// tickets through /api/work/start and /api/work/submit, banks the answer the
// server returns and refreshes a session that is about to run out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Runner } from '../src/runner.mjs';
import { Store } from '../src/store.mjs';

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UID = 'user-1';

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (n) => `${b64({ alg: 'none' })}.${b64({ sub: UID, n })}.sig`;
const session = (expiresInS, n = 0) =>
  JSON.stringify({ access_token: token(n), refresh_token: `refresh-${n}`, expires_at: Math.round(Date.now() / 1000) + expiresInS });

function fakeCasino() {
  const calls = [];
  const player = () => ({ login: 'tester', credits: 100, level: 1, work: { energy: 10, maxEnergy: 20, paidToday: 0, norm: 50 }, upgrades: {} });
  let taskId = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = body ? JSON.parse(body) : null;
    calls.push({ path: req.url, auth: req.headers.authorization, body: json });
    const reply = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    if (req.url === '/') return res.end('<html></html>');
    if (req.url.startsWith('/auth/v1/token')) {
      return reply(200, { access_token: token(1), refresh_token: 'refresh-1', expires_in: 3600, token_type: 'bearer' });
    }
    if (req.url === '/api/me') return reply(200, { player: player() });
    if (req.url === '/api/work/start') {
      taskId += 1;
      const task = { id: `t${taskId}`, type: 'output', lang: 'js', code: 'console.log(1)', options: ['0', '1', '2'], expiresAt: Date.now() + 60_000 };
      return reply(200, { task, player: player() });
    }
    if (req.url === '/api/work/submit') {
      return reply(200, { result: { correct: json.answer === 1, answer: 1, earned: 5, xpGain: 1 }, player: player() });
    }
    reply(404, { error: 'not_found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

async function until(check, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out');
}

function setup(casino, accountSession) {
  const dir = mkdtempSync(join(tmpdir(), 'botter-runner-'));
  const store = new Store(join(dir, 'storage.json'));
  store.set({
    settings: { enabled: true, taskType: 'output', aiSolver: 'off', guessUnknown: true, maxSpeed: true, autoClaim: false, rotateAccounts: false, logLevel: 'warn' },
    [`account:${UID}`]: { login: 'tester', session: accountSession, storageKey: 'sb-fake-auth-token' },
  });
  const runner = new Runner({ extensionDir, store, casinoUrl: `${casino.url}/`, supabaseUrl: casino.url, supabaseKey: 'anon', locale: 'en' });
  return { runner, store, cleanup: () => (runner.stop(), rmSync(dir, { recursive: true, force: true })) };
}

test('works tickets through the API and banks the answers', async () => {
  const casino = await fakeCasino();
  const { runner, store, cleanup } = setup(casino, session(3600));
  try {
    await runner.start();
    const submits = () => casino.calls.filter((call) => call.path === '/api/work/submit');
    await until(() => submits().length >= 2);
    const [first, second] = submits();
    assert.equal(first.body.id, 't1');
    assert.ok(Number.isInteger(first.body.answer));
    assert.equal(second.body.answer, 1, 'the second copy of the ticket is answered from the bank');
    assert.equal(first.auth, `Bearer ${token(0)}`);
    await until(() => Object.keys(store.get('bank').bank ?? {}).length === 1);
    assert.equal(runner.report().player.login, 'tester');
  } finally {
    cleanup();
    casino.server.close();
  }
});

test('refreshes a session about to expire and files it under the account', async () => {
  const casino = await fakeCasino();
  const { runner, store, cleanup } = setup(casino, session(60));
  try {
    await runner.start();
    assert.ok(casino.calls.some((call) => call.path.startsWith('/auth/v1/token?grant_type=refresh_token') && call.body.refresh_token === 'refresh-0'));
    const saved = store.get(`account:${UID}`)[`account:${UID}`];
    assert.equal(JSON.parse(saved.session).refresh_token, 'refresh-1');
    await until(() => casino.calls.some((call) => call.path === '/api/me'));
    assert.equal(casino.calls.find((call) => call.path === '/api/me').auth, `Bearer ${token(1)}`);
  } finally {
    cleanup();
    casino.server.close();
  }
});

test('builds the real panel and replays clicks on it', async () => {
  const casino = await fakeCasino();
  const { runner, store, cleanup } = setup(casino, session(3600));
  try {
    store.set({ settings: { ...store.get('settings').settings, enabled: false } });
    await runner.start();
    await until(() => runner.panelHtml().includes('tester'));
    const root = runner.page.document.getElementById('botter-panel').shadowRoot;
    const button = root.querySelector('.work-toggle');
    const path = [];
    for (let node = button; node !== root; node = node.parentNode) path.unshift([...node.parentNode.children].indexOf(node));
    assert.equal(runner.panelEvent({ path, type: 'click' }), true);
    await until(() => store.get('settings').settings.enabled === true);
  } finally {
    cleanup();
    casino.server.close();
  }
});

test('signs in with GitHub through PKCE from the pasted casino address', async () => {
  const casino = await fakeCasino();
  const { runner, cleanup } = setup(casino, undefined);
  try {
    await runner.start();
    const { id, url } = runner.githubStart();
    const authorize = new URL(url);
    assert.equal(authorize.pathname, '/auth/v1/authorize');
    assert.equal(authorize.searchParams.get('provider'), 'github');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 's256');

    assert.deepEqual(await runner.githubFinish(id, `${casino.url}/`), { error: 'no_code' });
    assert.deepEqual(await runner.githubFinish('unknown', `${casino.url}/?code=abcdefgh-1234-5678`), { error: 'expired' });
    assert.deepEqual(await runner.githubFinish(id, `${casino.url}/?code=abcdefgh-1234-5678`), { ok: true });

    const exchange = casino.calls.find((call) => call.path === '/auth/v1/token?grant_type=pkce');
    assert.equal(exchange.body.auth_code, 'abcdefgh-1234-5678');
    const challenge = createHash('sha256').update(exchange.body.code_verifier).digest('base64url');
    assert.equal(challenge, authorize.searchParams.get('code_challenge'));
    assert.equal(JSON.parse(runner.readSession().raw).access_token, token(1));
    assert.deepEqual(await runner.githubFinish(id, `${casino.url}/?code=abcdefgh-1234-5678`), { error: 'expired' }, 'a flow is used once');
  } finally {
    cleanup();
    casino.server.close();
  }
});
