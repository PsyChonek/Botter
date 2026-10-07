const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../src/odds.js');

test('roulette return follows the zeros left on the wheel', () => {
  assert.equal(O.rtp('roulette', {}), 36 / 39);
  assert.equal(O.rtp('roulette', { roulette: { zeros: 2 } }), 36 / 37);
  assert.equal(O.rtp('roulette', { roulette: { zeros: 9 } }), 36 / 37);
});

test('blackjack return comes from the exact solver and improves with upgrades', () => {
  const base = O.rtp('blackjack', {});
  assert.ok(base > 0.85 && base < 0.9);
  assert.ok(O.rtp('blackjack', { blackjack: { ties: 4, bjpay: 2, soft17: 1, double: 1 } }) > 0.96);
});

test('slot returns are looked up per upgrade combination', () => {
  for (const game of ['skeleton', 'slotingi']) {
    const base = O.rtp(game, {});
    assert.ok(base > 0.5 && base < 1, `${game} base ${base}`);
  }
  assert.ok(O.rtp('skeleton', { skeleton: { team: 4, wild: 4, deploy: 3 } }) > O.rtp('skeleton', {}) + 0.1);
  assert.ok(O.rtp('slotingi', { slotingi: { crown: 3, gulas: 4, mint: 3 } }) > O.rtp('slotingi', {}) + 0.1);
  assert.ok(O.rtp('blaze', {}, 'symbols') > O.rtp('blaze', {}, 'reels'));
  assert.equal(O.rtp('crash', {}), null);
});

test('edges skips games without a model', () => {
  const edges = O.edges(['roulette', 'crash'], {});
  assert.deepEqual(Object.keys(edges), ['roulette']);
  assert.ok(Math.abs(edges.roulette - 3 / 39) < 1e-12);
});

test('blazeMode needs enough spins before trusting the richer scatter rule', () => {
  assert.equal(O.blazeMode(null), 'reels');
  assert.equal(O.blazeMode({ symbols: { match: 10, total: 10 }, reels: { match: 5, total: 10 } }), 'reels');
  assert.equal(O.blazeMode({ symbols: { match: 60, total: 60 }, reels: { match: 40, total: 60 } }), 'symbols');
  assert.equal(O.blazeMode({ symbols: { match: 40, total: 60 }, reels: { match: 60, total: 60 } }), 'reels');
});
