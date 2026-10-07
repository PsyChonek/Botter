const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/blackjack.js');

const near = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

test('dealer outcome distribution matches the textbook table for a 10 upcard (S17)', () => {
  const d = B.dealerOutcomes(10, false);
  near(d[17], 0.1114, 0.0001);
  near(d[20], 0.3422, 0.0001);
  near(d.bust, 0.2121, 0.0001);
  near(d.bj, 1 / 13, 1e-9);
  near(Object.values(d).reduce((a, b) => a + b, 0), 1, 1e-9);
});

test('house edge matches known infinite-deck figures', () => {
  // 3:2, S17, double any, ties push, no split, no peek: about -1.15%.
  near(B.createSolver({ bjPay: 1.5, pushFrom: 0, dealerHitsSoft17: false, doubleAny: true }).houseEdge(), -0.0117, 0.001);
});

test('casino upgrades improve the edge but never make it positive', () => {
  const base = B.createSolver(B.rulesFromUpgrades({})).houseEdge();
  const full = B.createSolver(B.rulesFromUpgrades({ ties: 4, bjpay: 2, soft17: 1, double: 1 })).houseEdge();
  near(base, -0.1242, 0.001);
  assert.ok(full > base);
  assert.ok(full < 0);
});

test('decide plays basic strategy spots correctly', () => {
  const rules = B.rulesFromUpgrades({ ties: 4, bjpay: 2, soft17: 1, double: 1 });
  const hand = (player, up, extra = {}) => ({ player: player.map((rank) => ({ rank })), dealer: [{ rank: up }], canDouble: true, bet: 20, ...extra });
  assert.equal(B.decide(hand(['6', '5'], '6'), rules, 1000), 'double');
  assert.equal(B.decide(hand(['6', '5'], '6'), rules, 10), 'hit');
  assert.equal(B.decide(hand(['10', '3'], '10'), rules, 1000), 'hit');
  assert.equal(B.decide(hand(['10', '6'], '6'), rules, 1000), 'stand');
  assert.equal(B.decide(hand(['10', '9'], 'A'), rules, 1000), 'stand');
  assert.equal(B.decide(hand(['10', '2', '3'], '5'), rules, 1000), 'stand');
});
