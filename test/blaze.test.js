const test = require('node:test');
const assert = require('node:assert/strict');
const Z = require('../src/blaze.js');

// grid[reel][row]. Reels 1 and 2 share no symbol, so no line can pay.
const blank = () => [
  ['plum', 'orange', 'plum', 'orange'],
  ['grapes', 'melon', 'grapes', 'melon'],
  ['lemon', 'lemon', 'lemon', 'lemon'],
  ['lemon', 'lemon', 'lemon', 'lemon'],
  ['lemon', 'lemon', 'lemon', 'lemon'],
];

test('config applies upgrade levels to weights and scatter pays', () => {
  const base = Z.config({});
  assert.equal(base.weights[0].wild, 0);
  assert.equal(base.weights[2].wild, 2.3);
  assert.deepEqual(base.scatterPay, { 3: 2.7, 4: 10, 5: 50 });
  const maxed = Z.config({ lucky: 5, wild: 5, star: 5 });
  assert.ok(Math.abs(maxed.weights[0].cherry - 16.4) < 1e-9);
  assert.ok(Math.abs(maxed.weights[1].wild - 2.8) < 1e-9);
  assert.deepEqual(maxed.scatterPay, { 3: 7.2, 4: 20, 5: 75 });
});

test('blank board pays nothing', () => {
  assert.equal(Z.evaluate(blank(), 20, Z.config({}), 'symbols'), 0);
});

test('a line of three sevens pays per line bet', () => {
  const grid = blank();
  for (let reel = 0; reel < 3; reel++) grid[reel][1] = 'seven';
  // Line 0 runs along row 1: 40 x (20 / 20 lines).
  assert.equal(Z.evaluate(grid, 20, Z.config({}), 'symbols'), 40);
});

test('an expanding wild completes lines across its whole reel', () => {
  const grid = blank();
  grid[0] = ['cherry', 'cherry', 'cherry', 'cherry'];
  grid[1] = ['cherry', 'cherry', 'cherry', 'cherry'];
  grid[2][0] = 'wild';
  // Every line starts with cherry, cherry, wild: 20 lines x 5 x (20 / 20).
  assert.equal(Z.evaluate(grid, 20, Z.config({}), 'symbols'), 100);
});

test('an expanding wild leaves a star on its reel, which breaks lines through it', () => {
  assert.deepEqual(Z.expand([['star', 'wild', 'plum', 'plum']])[0], ['star', 'wild', 'wild', 'wild']);
  const grid = blank();
  grid[0] = ['cherry', 'cherry', 'cherry', 'cherry'];
  grid[1] = ['cherry', 'cherry', 'cherry', 'cherry'];
  grid[2] = ['star', 'wild', 'lemon', 'lemon'];
  // Lines through row 0 on reel 3 stop at the star: 15 of the 20 lines pay
  // cherry, cherry, wild (5 x 20 / 20 each); one star pays no scatter.
  const rows = Z.LINES.filter((line) => line[2] !== 0).length;
  assert.equal(Z.evaluate(grid, 20, Z.config({}), 'symbols'), rows * 5);
});

test('scatter rules differ when one reel holds two stars', () => {
  const grid = blank();
  grid[0][0] = 'star';
  grid[0][2] = 'star';
  grid[3][1] = 'star';
  const cfg = Z.config({});
  assert.equal(Z.evaluate(grid, 20, cfg, 'symbols'), 2.7 * 20);
  assert.equal(Z.evaluate(grid, 20, cfg, 'reels'), 0);
});

test('checkSpins counts which rule reproduces the server win', () => {
  const grid = blank();
  grid[0][0] = 'star';
  grid[0][2] = 'star';
  grid[3][1] = 'star';
  const result = Z.checkSpins([
    { grid, bet: 20, win: 54, upgrades: {} },
    { grid: blank(), bet: 20, win: 0, upgrades: {} },
  ]);
  assert.deepEqual(result.symbols, { match: 2, total: 2 });
  assert.deepEqual(result.reels, { match: 1, total: 2 });
});

test('simulated base RTP lands in a plausible band', () => {
  let seed = 42;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
  const rtp = Z.simulateRtp(Z.config({}), 'symbols', 50_000, rand);
  assert.ok(rtp > 0.5 && rtp < 0.85, `rtp ${rtp}`);
});
