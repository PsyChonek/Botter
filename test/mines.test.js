const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/mines.js');
const O = require('../src/odds.js');
const G = require('../src/games.js');

test('return follows the client formula: 82 % plus the upgrades, 95 % maxed', () => {
  assert.equal(M.rtp({}), 0.82);
  assert.ok(Math.abs(M.rtp({ tests: 4, duck: 3 }) - 0.95) < 1e-12);
  assert.ok(Math.abs(M.rtp({ tests: 9, duck: 9 }) - 0.95) < 1e-12);
});

test('multiplier is the return over the survival chance, floored and capped', () => {
  // One bug, one cell: 0.82 / (24 / 25) = 0.854 floors to 0.85.
  assert.equal(M.multiplier(0.82, 1, 1), 0.85);
  // 24 bugs and the one clean cell: 0.82 x 25.
  assert.equal(M.multiplier(0.82, 24, 1), 20.5);
  // Three bugs and all 22 clean cells would be 1,886x; the cap is 1,000.
  assert.equal(M.multiplier(0.82, 3, 22), 1000);
});

test('every shape returns the same share, less the flooring', () => {
  for (const bugs of M.BUG_COUNTS) {
    for (let n = 1; n <= Math.min(5, 25 - bugs); n++) {
      const s = M.shape(0.9, bugs, n);
      if (s.mult < 1000) assert.ok(s.ev <= 0.9 + 1e-12 && s.ev > 0.88, `${bugs}/${n} ${s.ev}`);
    }
  }
  // Whole credits cut a small bet's payout: 20 x 0.89 = 17.8 pays 17.
  assert.equal(M.shape(0.82, 1, 2, 20).pay, 0.85);
});

test('the grinder keeps the best return with few reveals', () => {
  const s = M.grindShape(0.82);
  assert.ok(s.ev >= 0.818, `ev ${s.ev}`);
  assert.ok(s.reveals <= 2, `reveals ${s.reveals}`);
  assert.equal(M.plan({}, Infinity, null).reveals, s.reveals);
});

test('targets pick the likeliest shape that pays enough', () => {
  const clear = M.plan({}, 20, 'clear');
  assert.equal(clear.bugs, 24);
  assert.equal(clear.reveals, 1);
  assert.equal(clear.chance, 1 / 25);
  const hundred = M.plan({}, 20, 'x100');
  assert.ok(hundred.pay >= 100);
  assert.ok(hundred.chance > 0.005 && hundred.chance < 0.01, `chance ${hundred.chance}`);
  const ahead = M.plan({}, 20, 'win');
  assert.ok(ahead.pay > 1 && ahead.chance > 0.75, `win ${ahead.chance}`);
  const big = M.plan({}, Infinity, 'x10');
  assert.ok(big.pay >= 10 && big.chance > 0.075, `big ${big.chance}`);
});

test('pickCells reveals distinct cells that are not open yet', () => {
  const cells = M.pickCells(24, [3]);
  assert.equal(new Set(cells).size, 24);
  assert.ok(!cells.includes(3));
  assert.ok(cells.every((cell) => cell >= 0 && cell < 25));
});

test('odds, shop and booking know Hledání bugů', () => {
  assert.ok(Math.abs(O.rtp('mines', {}) - M.grindShape(0.82).ev) < 1e-12);
  const c = O.chances('mines', { mines: { tests: 4, duck: 3 } });
  assert.equal(c.gain, null);
  assert.ok(c.bigs[0] > 0.08 && c.bigs[2] > 0);
  assert.deepEqual(G.upgradeOffer({}, 'mines', 'tests'), { game: 'mines', key: 'tests', next: 1, price: 6000, minLevel: 9 });
  assert.equal(G.upgradeOffer({ mines: { duck: 2 } }, 'mines', 'duck').price, 36000);
  const start = G.gameDelta('/api/mines/start', { bet: 100, mines: 1 }, { player: { credits: 900 } }, 1000);
  assert.deepEqual([start.rounds, start.wagered, start.net], [1, 100, -100]);
  const cash = G.gameDelta('/api/mines/cashout', {}, { player: { credits: 1003 }, xpGain: 5 }, 900);
  assert.deepEqual([cash.rounds, cash.wagered, cash.net, cash.xp], [0, 0, 103, 5]);
  assert.equal(G.animationLockMs('/api/mines/reveal', {}), 390);
});
