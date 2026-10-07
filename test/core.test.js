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
  assert.throws(() => C.parseAnswer('two'));
});

test('nextType alternates unless a type is pinned', () => {
  assert.equal(C.nextType('alternate', null), 'bughunt');
  assert.equal(C.nextType('alternate', 'bughunt'), 'output');
  assert.equal(C.nextType('output', 'output'), 'output');
});

test('ticketLabel matches the app header format', () => {
  assert.equal(C.ticketLabel('ffff0000'), `JIRA-${(0xffff % 9000) + 1000}`);
});

test('delayBetween stays within bounds', () => {
  assert.equal(C.delayBetween(100, 200, () => 0), 100);
  assert.equal(C.delayBetween(100, 200, () => 0.999999), 200);
  assert.equal(C.delayBetween(300, 100, () => 0.5), 300);
});
