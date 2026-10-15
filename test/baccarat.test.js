const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/baccarat.js');

const card = (rank) => ({ rank, suit: 'S' });
const hand = (player, banker) => ({ player: player.map(card), banker: banker.map(card) });
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('outcomes match the known infinite-deck punto banco odds', () => {
  const odds = B.outcomes();
  near(odds.player + odds.banker + odds.tie, 1, 1e-9);
  near(odds.banker, 0.458428, 1e-6);
  near(odds.player, 0.446147, 1e-6);
  near(odds.tie, 0.095426, 1e-6);
});

test('spot returns follow the cut, the banker extra and the tie refund', () => {
  const odds = B.outcomes();
  near(B.spotRtp('banker', {}), odds.banker * (2 - 0.08 - 0.05) + odds.tie * 0.5);
  near(B.spotRtp('player', { cut: 3, push: 1 }), odds.player * (2 - 0.025) + odds.tie);
  near(B.spotRtp('tie', {}), odds.tie * 9);
  near(B.spotRtp('ppair', { cut: 3 }), 11 / 13);
  // Bankéř stays a little ahead of Hráč at every cut.
  for (const cut of [0, 1, 2, 3]) assert.equal(B.bestSpot({ cut }), 'banker');
});

test('bankerDraws follows the tableau', () => {
  assert.equal(B.bankerDraws(5, null), true);
  assert.equal(B.bankerDraws(6, null), false);
  assert.equal(B.bankerDraws(3, 8), false);
  assert.equal(B.bankerDraws(3, 9), true);
  assert.equal(B.bankerDraws(4, 1), false);
  assert.equal(B.bankerDraws(5, 4), true);
  assert.equal(B.bankerDraws(6, 6), true);
  assert.equal(B.bankerDraws(6, 5), false);
  assert.equal(B.bankerDraws(7, 2), false);
});

test('dealtByRules spots a card drawn against the tableau', () => {
  assert.equal(B.dealtByRules(hand(['9', 'K'], ['3', '3'])), true); // natural, nobody draws
  assert.equal(B.dealtByRules(hand(['9', 'K', '2'], ['3', '3'])), false);
  assert.equal(B.dealtByRules(hand(['2', '3', '8'], ['3', 'K'])), true); // banker 3 stands on an 8
  assert.equal(B.dealtByRules(hand(['2', '3', '8'], ['3', 'K', '4'])), false);
  assert.equal(B.dealtByRules(hand(['6', 'K'], ['2', '3', 'A'])), true); // player stands, banker draws on 5
});

test('payout pays the client rules for every spot', () => {
  const bankerWin = hand(['2', '3', 'K'], ['3', '3']); // 5 against 8
  assert.equal(B.payout({ banker: 100 }, bankerWin, {}), 187);
  assert.equal(B.payout({ player: 100 }, bankerWin, {}), 0);
  assert.equal(B.payout({ bpair: 20 }, bankerWin, {}), 220);
  const tie = hand(['7', 'K'], ['3', '4']);
  assert.equal(B.payout({ banker: 100, tie: 20 }, tie, {}), 50 + 180);
  assert.equal(B.payout({ player: 100 }, tie, { push: 1 }), 100);
  assert.equal(B.payout({ red: 20 }, tie, {}), null);
});

test('addHand books winners, pairs, rule breaks and payout errors', () => {
  const check = {};
  const data = (h, payout) => ({ hand: { ...h, winner: 'banker' }, payout, total: 100 });
  B.addHand(check, '00', {}, { bets: { banker: 100 } }, data(hand(['2', '3', 'K'], ['3', '3']), 187), 87);
  B.addHand(check, '00', {}, { bets: { banker: 100 } }, data(hand(['2', '3', 'K'], ['3', '3']), 180), 80);
  const row = check['00'];
  assert.equal(row.hands, 2);
  assert.equal(row.banker, 2);
  assert.equal(row.pairs, 2);
  assert.equal(row.drawErrors, 0);
  assert.equal(row.payErrors, 1);
  assert.equal(row.checked, 2);
  near(row.expected, 200 * B.spotRtp('banker', {}));
});
