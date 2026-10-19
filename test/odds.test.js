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

test('blazeDecided needs enough spins and one rule matching more', () => {
  assert.equal(O.blazeDecided(null), false);
  assert.equal(O.blazeDecided({ symbols: { match: 60, total: 60 }, reels: { match: 60, total: 60 } }), false);
  // A tie over 1,000 spins: stars do not stack, the rules pay the same.
  assert.equal(O.blazeDecided({ symbols: { match: 1996, total: 2000 }, reels: { match: 1996, total: 2000 } }), true);
  assert.equal(O.blazeMode({ symbols: { match: 1996, total: 2000 }, reels: { match: 1996, total: 2000 } }), 'reels');
  assert.equal(O.blazeDecided({ symbols: { match: 40, total: 40 }, reels: { match: 39, total: 40 } }), false);
  assert.equal(O.blazeDecided({ symbols: { match: 60, total: 60 }, reels: { match: 59, total: 60 } }), true);
  assert.equal(O.blazeDecided({ symbols: { match: 59, total: 60 }, reels: { match: 60, total: 60 } }), true);
});

test('blazeMode needs enough spins before trusting the richer scatter rule', () => {
  assert.equal(O.blazeMode(null), 'reels');
  assert.equal(O.blazeMode({ symbols: { match: 10, total: 10 }, reels: { match: 5, total: 10 } }), 'reels');
  assert.equal(O.blazeMode({ symbols: { match: 60, total: 60 }, reels: { match: 40, total: 60 } }), 'symbols');
  assert.equal(O.blazeMode({ symbols: { match: 40, total: 60 }, reels: { match: 60, total: 60 } }), 'reels');
});

test('chances cover every game and upgrade combination', () => {
  const sizes = { blaze: 216, skeleton: 100, slotingi: 80, blackjack: 60, roulette: 3, baccarat: 8, dice: 8, cases: 12, hotfix: 80 };
  for (const [game, size] of Object.entries(sizes)) {
    const rows = O.table(game);
    assert.equal(rows.length, size, game);
    for (const row of rows) {
      assert.ok(row.win > 0 && row.win < 1, `${game} ${JSON.stringify(row)}`);
      assert.ok(row.ahead >= 0 && row.ahead <= 1, `${game} ${JSON.stringify(row)}`);
      assert.ok(row.rtp > 0.5, `${game} ${JSON.stringify(row)}`);
    }
  }
  assert.equal(O.table('blaze', 'symbols').length, 216);
  assert.deepEqual(O.table('roulette')[2].upgrades, { zeros: 2 });
  assert.equal(O.chances('crash', {}), null);
});

test('simulated chances match the exact roulette odds', () => {
  for (const zeros of [0, 1, 2]) {
    const { win } = O.chances('roulette', { roulette: { zeros } });
    assert.ok(Math.abs(win - 18 / (39 - zeros)) < 0.005, `zeros ${zeros}: ${win}`);
  }
  // A house edge loses most 1,000-round sessions; upgrades lift the chance to end ahead.
  assert.ok(O.chances('blackjack', {}).ahead < 0.01);
  assert.ok(O.chances('blackjack', { blackjack: { ties: 4, bjpay: 2, soft17: 1, double: 1 } }).ahead > 0.1);
});

test('winRates skips games without a model', () => {
  const wins = O.winRates(['roulette', 'crash'], {});
  assert.deepEqual(Object.keys(wins), ['roulette']);
});

test('combo keys an upgrade combination and comboUpgrades reads it back', () => {
  const upgrades = { blaze: { lucky: 2, star: 3 }, roulette: { zeros: 1 } };
  assert.equal(O.combo('blaze', upgrades), '203');
  assert.deepEqual(O.comboUpgrades('blaze', '203'), { lucky: 2, wild: 0, star: 3 });
  assert.equal(O.combo('roulette', upgrades), '1');
  assert.equal(O.combo('crash', upgrades), null);
  assert.equal(O.rtp('blaze', { blaze: O.comboUpgrades('blaze', '203') }), O.rtp('blaze', upgrades));
});
