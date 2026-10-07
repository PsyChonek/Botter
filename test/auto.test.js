const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../src/auto.js');

test('crashMult doubles every four hours', () => {
  assert.equal(A.crashMult(0, 0), 1);
  assert.equal(A.crashMult(0, 4 * 3600_000), 2);
  assert.equal(A.crashMult(0, 24 * 3600_000), 64);
  assert.equal(A.crashMult(1000, 0), 1);
});

test('bestCrashTarget needs enough history', () => {
  assert.equal(A.bestCrashTarget([{ mult: 2 }, { mult: 3 }], 1, 0.9), null);
  assert.equal(A.bestCrashTarget(null, 1, 0.9), null);
});

test('bestCrashTarget cashes just below the crash points that maximise EV', () => {
  // Five rounds crashing at 2, 2, 2, 8, 8: target ~2 pays 2 * 5/5, ~8 pays 8 * 2/5.
  const history = [2, 2, 2, 8, 8].map((mult) => ({ mult }));
  const best = A.bestCrashTarget(history, 1, 1);
  assert.ok(best.target > 7.9 && best.target < 8, `target ${best.target}`);
  assert.ok(Math.abs(best.ev - best.target * 0.4) < 1e-9);
});

test('bestCrashTarget values planned outages and conditions on the entry point', () => {
  const history = [{ planned: true }, { planned: true }, { mult: 1.2 }, { mult: 1.3 }, { mult: 30 }, { mult: 40 }, { mult: 50 }];
  const early = A.bestCrashTarget(history, 1, 0.8);
  // Holding to the outage pays 0.8 * 64 on 2 of 7 rounds.
  assert.ok(early.ev >= (0.8 * 64 * 2) / 7 - 1e-9);
  // Entering at production 20 drops the early crashes from the sample.
  const late = A.bestCrashTarget(history, 20, 0.8);
  assert.ok(late.ev > 0);
});

test('bestCrashTarget exposes the win probability and payout of its choice', () => {
  const history = [2, 2, 2, 8, 8].map((mult) => ({ mult }));
  const best = A.bestCrashTarget(history, 1, 1);
  // Chosen target ~8 wins on 2 of 5 rounds, paying the target multiple.
  assert.ok(Math.abs(best.p - 0.4) < 1e-9, `p ${best.p}`);
  assert.ok(Math.abs(best.payout - best.target) < 1e-9, `payout ${best.payout}`);
  assert.ok(Math.abs(best.ev - best.p * best.payout) < 1e-9);
});

test('crashStake sizes by fractional Kelly and refuses a non-positive edge', () => {
  // ev 1.6, payout 8 -> full Kelly (ev-1)/(payout-1) = 0.6/7; half of that * 7000.
  const plan = { p: 0.2, payout: 8, ev: 1.6 };
  const full = A.crashStake(plan, 7000, 1);
  assert.equal(full, Math.floor((0.6 / 7) * 7000));
  assert.equal(A.crashStake(plan, 7000, 0.5), Math.floor((0.6 / 7) * 0.5 * 7000));
  // No edge, no money.
  assert.equal(A.crashStake({ p: 0.1, payout: 8, ev: 0.8 }, 7000, 0.5), 0);
  assert.equal(A.crashStake(plan, 0, 0.5), 0);
  assert.equal(A.crashStake(null, 7000, 0.5), 0);
  // Kelly is capped at the whole bankroll even if the formula exceeds it.
  assert.equal(A.crashStake({ p: 0.95, payout: 1.5, ev: 1.425 }, 1000, 1), 850);
});

test('repayAmount keeps the reserve and never exceeds the debt', () => {
  assert.equal(A.repayAmount({ credits: 1000, loan: { debt: 300 } }, 100), 300);
  assert.equal(A.repayAmount({ credits: 1000, loan: { debt: 3000 } }, 100), 900);
  assert.equal(A.repayAmount({ credits: 50, loan: { debt: 3000 } }, 100), 0);
  assert.equal(A.repayAmount({ credits: 1000, loan: null }, 0), 0);
});

test('grindGame explores first, then picks the lowest loss per XP', () => {
  const unlocks = { blaze: 1, skeleton: 5, blackjack: 10 };
  const games = Object.keys(unlocks);
  assert.equal(A.grindGame(games, 1, {}, unlocks), 'blaze');
  assert.equal(A.grindGame(games, 6, { blaze: { rounds: 40, net: -100, xp: 40 } }, unlocks), 'skeleton');
  const stats = {
    blaze: { rounds: 40, net: -400, xp: 40 },
    skeleton: { rounds: 40, net: -100, xp: 40 },
    blackjack: { rounds: 40, net: -200, xp: 40 },
  };
  assert.equal(A.grindGame(games, 12, stats, unlocks), 'skeleton');
  assert.equal(A.grindGame(games, 0, stats, unlocks), null);
});

test('dayKey is a local calendar date', () => {
  assert.match(A.dayKey(Date.UTC(2026, 9, 7, 12)), /^2026-10-0[78]$/);
});

test('grindAllowed stops at the daily loss budget', () => {
  const settings = { grindLimit: 'daily', xpBudget: 500, grindMinBalance: 0, reserve: 0 };
  assert.equal(A.grindAllowed(settings, 1000, 499, 20), true);
  assert.equal(A.grindAllowed(settings, 1000, 500, 20), false);
  assert.equal(A.grindAllowed({ ...settings, xpBudget: 0 }, 1000, 0, 20), false);
});

test('grindAllowed never bets below the minimum balance', () => {
  const settings = { grindLimit: 'balance', xpBudget: 0, grindMinBalance: 1000, reserve: 0 };
  assert.equal(A.grindAllowed(settings, 1020, 5000, 20), true);
  assert.equal(A.grindAllowed(settings, 1019, 0, 20), false);
  assert.equal(A.grindAllowed({ ...settings, grindMinBalance: 0 }, 5000, 0, 20), false);
});

test('grindAllowed keeps the reserve under either limit', () => {
  const daily = { grindLimit: 'daily', xpBudget: 500, grindMinBalance: 0, reserve: 300 };
  assert.equal(A.grindAllowed(daily, 310, 0, 20), false);
  assert.equal(A.grindAllowed({ ...daily, grindLimit: 'balance', grindMinBalance: 100 }, 310, 0, 20), false);
});
