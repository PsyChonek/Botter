const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/egypt.js');

test('free spins come about 1 in 300 spins, 1 in 250 with every upgrade, as the client says', () => {
  assert.equal(Math.round(1 / E.freeChance({})), 300);
  assert.equal(Math.round(1 / E.freeChance({ archeo: 3, cleanup: 4, deadline: 2 })), 249);
  assert.ok(E.bookChance(5, {}) < E.bookChance(4, {}));
  assert.ok(E.bookChance(4, {}) < E.freeChance({}));
});

test('upgrades move the book, scarab and cobra weights and add free spins', () => {
  const { weights, freeSpins } = E.config({ archeo: 3, cleanup: 4, deadline: 2 });
  assert.ok(Math.abs(weights.book - 2.82) < 1e-9);
  assert.ok(Math.abs(weights.scarab - 22.4) < 1e-9);
  assert.ok(Math.abs(weights.cobra - 22.4) < 1e-9);
  assert.equal(freeSpins, 12);
  assert.equal(E.config({ deadline: 9 }).freeSpins, 12);
  assert.equal(E.config({}, 'pharaoh').weights.pharaoh, 3 + E.FREE_BOOST);
  assert.equal(E.minCount('pharaoh'), 2);
  assert.equal(E.minCount('scarab'), 3);
});
