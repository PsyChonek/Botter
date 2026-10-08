const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core.js');

const bughunt = {
  id: 'a1b2c3d4',
  type: 'bughunt',
  lang: 'js',
  title: 'Po obnovení stránky padá košík',
  lines: [
    "localStorage.setItem('cart', JSON.stringify(cart));",
    '',
    '// ... po obnovení stránky ...',
    "const cart = localStorage.getItem('cart') || [];",
    'cart.push(newItem);',
  ],
};

const output = {
  id: 'ffff0000',
  type: 'output',
  lang: 'js',
  code: 'console.log(0.1 + 0.2 === 0.3)',
  options: ['true', 'false', 'undefined', 'TypeError'],
};

test('taskKey is stable and ignores output option order', () => {
  assert.equal(C.taskKey(bughunt), C.taskKey({ ...bughunt, id: 'other' }));
  const shuffled = { ...output, options: [...output.options].reverse() };
  assert.equal(C.taskKey(output), C.taskKey(shuffled));
  assert.notEqual(C.taskKey(output), C.taskKey({ ...output, code: 'console.log(1)' }));
});

test('bank entry resolves back to the answer, even after a reshuffle', () => {
  assert.equal(C.answerFromBank(bughunt, C.bankEntry(bughunt, 3)), 3);
  const entry = C.bankEntry(output, 1);
  const shuffled = { ...output, options: ['TypeError', 'undefined', 'false', 'true'] };
  assert.equal(C.answerFromBank(shuffled, entry), 2);
  assert.equal(C.answerFromBank(output, undefined), null);
  assert.equal(C.answerFromBank(output, C.bankEntry(bughunt, 3)), null);
});

test('blank bug-hunt lines are never valid answers', () => {
  assert.deepEqual(C.choices(bughunt), [0, 2, 3, 4]);
  assert.equal(C.isValidAnswer(bughunt, 1), false);
  assert.equal(C.isValidAnswer(bughunt, 3), true);
  assert.equal(C.isValidAnswer(output, 4), false);
  for (let i = 0; i < 50; i++) assert.notEqual(C.randomChoice(bughunt), 1);
});

test('prompt lists every line or option with its index', () => {
  const prompt = C.buildPrompt(bughunt);
  assert.match(prompt, /3: const cart = localStorage\.getItem/);
  assert.match(C.buildPrompt(output), /1: false/);
});

test('parseAnswer reads structured output', () => {
  assert.equal(C.parseAnswer('{"index": 2}'), 2);
  assert.equal(C.parseAnswer('```json\n{"index": 3}\n```'), 3);
  assert.equal(C.parseAnswer('The bug is on line 4.'), 4);
  assert.throws(() => C.parseAnswer('two'));
});

test('nextType cycles through every type unless one is pinned', () => {
  assert.equal(C.nextType('alternate', null), 'bughunt');
  assert.equal(C.nextType('alternate', 'bughunt'), 'output');
  assert.equal(C.nextType('alternate', 'output'), 'ticket');
  assert.equal(C.nextType('alternate', 'ticket'), 'bughunt');
  assert.equal(C.nextType('output', 'output'), 'output');
  assert.equal(C.nextType('ticket', 'bughunt'), 'ticket');
});

const ticket = {
  id: '0abc1234',
  type: 'ticket',
  from: 'Jana z účtárny',
  message: 'Od rána nejde nikomu ve firmě přihlásit do e-shopu, objednávky stojí.',
};

test('ticket answers cover every combination of type, priority and team', () => {
  const all = C.choices(ticket);
  assert.equal(all.length, 64);
  assert.ok(all.includes(0) && all.includes(333) && all.includes(130));
  assert.equal(C.isValidAnswer(ticket, 4), false);
  assert.equal(C.isValidAnswer(ticket, 213), true);
  assert.deepEqual(C.decodeTicket(213), [2, 1, 3]);
  assert.deepEqual(C.decodeTicket(30), [0, 3, 0]);
});

test('ticket bank entry is keyed by sender and message', () => {
  assert.equal(C.taskKey(ticket), C.taskKey({ ...ticket, id: 'ffff9999' }));
  assert.notEqual(C.taskKey(ticket), C.taskKey({ ...ticket, from: 'Petr' }));
  assert.match(C.taskKey(ticket), /^t:/);
  assert.equal(C.answerFromBank(ticket, C.bankEntry(ticket, 30)), 30);
  assert.equal(C.answerFromBank(ticket, C.bankEntry(output, 1)), null);
});

test('isBankEntry accepts every type and rejects mismatched keys', () => {
  assert.equal(C.isBankEntry(C.taskKey(ticket), C.bankEntry(ticket, 30)), true);
  assert.equal(C.isBankEntry(C.taskKey(bughunt), C.bankEntry(bughunt, 3)), true);
  assert.equal(C.isBankEntry(C.taskKey(output), C.bankEntry(output, 1)), true);
  assert.equal(C.isBankEntry(C.taskKey(output), C.bankEntry(ticket, 30)), false);
  assert.equal(C.isBankEntry('t:x', { type: 'ticket', answer: '30' }), false);
  assert.equal(C.isBankEntry('x:1', { type: 'other', text: 'a' }), false);
  assert.equal(C.isBankEntry('b:1', null), false);
});

test('ticket prompt carries the message and the rules, and parses one index per field', () => {
  const prompt = C.buildPrompt(ticket);
  assert.match(prompt, /objednávky stojí/);
  assert.match(prompt, /3: Kritická \(nefunguje to všem/);
  assert.match(prompt, /"priority": <index>/);
  assert.deepEqual(C.answerSchema(ticket).required, ['type', 'priority', 'team']);
  assert.deepEqual(C.answerSchema(output).required, ['index']);
  assert.equal(C.parseAnswer('{"type": 0, "priority": 3, "team": 0}', ticket), 30);
  assert.equal(C.parseAnswer('```json\n{"team":2,"type":1,"priority":1}\n```', ticket), 112);
  assert.throws(() => C.parseAnswer('{"type": 0, "priority": 4, "team": 0}', ticket));
  assert.throws(() => C.parseAnswer('{"index": 2}', ticket));
});

test('ticketLabel matches the app header format', () => {
  assert.equal(C.ticketLabel('ffff0000'), `JIRA-${(0xffff % 9000) + 1000}`);
});

test('claudeCost prices input and output tokens per model', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 100_000 };
  assert.equal(C.claudeCost('claude-opus-5-5', usage), 4 + 2);
  assert.equal(C.claudeCost('claude-haiku-4-5', usage), 1 + 0.5);
  assert.equal(C.claudeCost('some-other-model', usage), null);
  assert.equal(C.claudeCost('claude-sonnet-5-5', undefined), null);
});

test('minDwellMs gives tickets a reading time and honours a learned minimum', () => {
  assert.equal(C.minDwellMs({ type: 'output' }), 0);
  assert.equal(C.minDwellMs({ type: 'ticket', message: 'x'.repeat(200) }), 7000);
  assert.equal(C.minDwellMs({ type: 'ticket', message: 'short' }, 12_000), 12_000);
  assert.equal(C.minDwellMs({ type: 'bughunt' }, 3000), 3000);
});

test('slowerDwell grows past the rejected submit and stays capped', () => {
  assert.equal(C.slowerDwell(0, 4000), 7000);
  assert.equal(C.slowerDwell(10_000, 4000), 16_000);
  assert.equal(C.slowerDwell(50_000, 50_000), 60_000);
});

test('delayBetween stays within bounds', () => {
  assert.equal(C.delayBetween(100, 200, () => 0), 100);
  assert.equal(C.delayBetween(100, 200, () => 0.999999), 200);
  assert.equal(C.delayBetween(300, 100, () => 0.5), 300);
});

test('tokenSubject reads the user id from a bearer token', () => {
  const payload = Buffer.from(JSON.stringify({ sub: 'user-1', role: 'authenticated' })).toString('base64url');
  assert.equal(C.tokenSubject(`Bearer header.${payload}.signature`), 'user-1');
  assert.equal(C.tokenSubject(`header.${payload}.signature`), 'user-1');
  assert.equal(C.tokenSubject('Bearer dev:alice'), 'dev:alice');
  assert.equal(C.tokenSubject('not-a-jwt'), null);
  assert.equal(C.tokenSubject(null), null);
});

test('sessionFromToken stores the token response the way supabase-js does', () => {
  const body = { access_token: 'a', refresh_token: 'r', expires_in: 3600, token_type: 'bearer', user: { id: 'u' } };
  assert.deepEqual(JSON.parse(C.sessionFromToken(body, 1_000_000)), { ...body, expires_at: 4600 });
  assert.equal(JSON.parse(C.sessionFromToken({ ...body, expires_at: 99 })).expires_at, 99);
  assert.equal(C.sessionFromToken({ access_token: 'a' }), null);
  assert.equal(C.sessionFromToken(null), null);
});

test('isNewerSession never lets an older copy of a login replace a newer one', () => {
  const older = JSON.stringify({ refresh_token: 'r1', expires_at: 100 });
  const newer = JSON.stringify({ refresh_token: 'r2', expires_at: 200 });
  assert.equal(C.isNewerSession(newer, older), true);
  assert.equal(C.isNewerSession(older, newer), false);
  assert.equal(C.isNewerSession(older, undefined), true);
  assert.equal(C.isNewerSession(newer, 'not json'), true);
});
