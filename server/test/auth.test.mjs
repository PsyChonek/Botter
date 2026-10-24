import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, readCookie } from '../src/auth.mjs';
import { parseClientMessage } from '../src/protocol.mjs';

const make = (overrides = {}) => createAuth({ user: 'admin', password: 'correct horse battery', ...overrides });

test('rejects a short or missing password at startup', () => {
  assert.throws(() => createAuth({ user: 'admin', password: '' }));
  assert.throws(() => createAuth({ user: 'admin', password: 'short' }));
});

test('logs in with the right credentials and the session is valid', () => {
  const auth = make();
  const { token } = auth.login('1.2.3.4', 'admin', 'correct horse battery');
  assert.ok(token);
  assert.equal(auth.valid(token), true);
  auth.logout(token);
  assert.equal(auth.valid(token), false);
});

test('rejects a wrong password or user', () => {
  const auth = make();
  assert.deepEqual(auth.login('1.2.3.4', 'admin', 'wrong'), { error: 'invalid' });
  assert.deepEqual(auth.login('1.2.3.4', 'root', 'correct horse battery'), { error: 'invalid' });
  assert.equal(auth.valid(''), false);
  assert.equal(auth.valid('made-up'), false);
});

test('blocks an IP after too many failures until the window passes', () => {
  let clock = 0;
  const auth = make({ maxFailures: 3, windowMinutes: 15, now: () => clock });
  for (let i = 0; i < 3; i++) auth.login('9.9.9.9', 'admin', 'nope');
  assert.deepEqual(auth.login('9.9.9.9', 'admin', 'correct horse battery'), { error: 'rate_limited' });
  assert.ok(auth.login('8.8.8.8', 'admin', 'correct horse battery').token, 'other IPs are not blocked');
  clock += 16 * 60_000;
  assert.ok(auth.login('9.9.9.9', 'admin', 'correct horse battery').token);
});

test('sessions expire', () => {
  let clock = 0;
  const auth = make({ sessionHours: 1, now: () => clock });
  const { token } = auth.login('1.2.3.4', 'admin', 'correct horse battery');
  clock += 2 * 3_600_000;
  assert.equal(auth.valid(token), false);
});

test('reads one cookie out of a header', () => {
  assert.equal(readCookie('a=1; botter_session=abc%3D; b=2', 'botter_session'), 'abc=');
  assert.equal(readCookie(undefined, 'botter_session'), '');
});

test('accepts only well-formed dashboard messages', () => {
  assert.deepEqual(parseClientMessage('{"type":"open","target":"settings"}'), { type: 'open', target: 'settings' });
  assert.equal(parseClientMessage('{"type":"open","target":"file:///etc/passwd"}'), null);
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'input', event: { kind: 'down', x: 5, y: 6, button: 'left', extra: 1 } })), {
    type: 'input',
    event: { kind: 'down', x: 5, y: 6, button: 'left' },
  });
  assert.equal(parseClientMessage(JSON.stringify({ type: 'input', event: { kind: 'down', x: -1, y: 6, button: 'left' } })), null);
  assert.equal(parseClientMessage(JSON.stringify({ type: 'select', id: '../x' })), null);
  assert.equal(parseClientMessage('not json'), null);
});
