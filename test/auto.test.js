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

const xpCells = (perRound, bets) => Object.fromEntries(bets.map((bet) => [bet, { rounds: 10, xp: perRound(bet) * 10 }]));

test('grindPlan explores each game first at the smallest bet', () => {
  const unlocks = { blaze: 1, skeleton: 5, blackjack: 10 };
  const games = Object.keys(unlocks);
  assert.deepEqual(A.grindPlan(games, [100, 20, 40], 1, {}, {}, unlocks), { game: 'blaze', bet: 20 });
  const stats = { blaze: { rounds: 40, wagered: 800, net: -100, xp: 40 } };
  assert.deepEqual(A.grindPlan(games, [20, 40], 6, stats, {}, unlocks), { game: 'skeleton', bet: 20 });
  assert.equal(A.grindPlan(games, [20], 0, stats, {}, unlocks), null);
  assert.equal(A.grindPlan(games, [], 12, stats, {}, unlocks), null);
});

test('grindPlan picks the game with the lowest loss per XP', () => {
  const unlocks = { blaze: 1, skeleton: 5, blackjack: 10 };
  const games = Object.keys(unlocks);
  const stats = {
    blaze: { rounds: 40, wagered: 800, net: -400, xp: 40 },
    skeleton: { rounds: 40, wagered: 800, net: -100, xp: 40 },
    blackjack: { rounds: 40, wagered: 800, net: -200, xp: 40 },
  };
  const flat = xpCells(() => 1, [20, 40]);
  const betXp = { blaze: flat, skeleton: flat, blackjack: flat };
  assert.deepEqual(A.grindPlan(games, [20, 40], 12, stats, betXp, unlocks), { game: 'skeleton', bet: 20 });
  // A game whose first bet level has no XP sample yet is sampled before choosing.
  assert.deepEqual(A.grindPlan(games, [20, 40], 12, stats, { blaze: flat, skeleton: flat }, unlocks), {
    game: 'blackjack',
    bet: 20,
  });
});

test('grindPlan keeps the smallest bet when XP is per round', () => {
  const unlocks = { blaze: 1 };
  const stats = { blaze: { rounds: 40, wagered: 800, net: -100, xp: 40 } };
  const levels = [20, 40, 100, 200];
  // Only the next level gets sampled; XP per credit halves there, so the climb stops.
  assert.deepEqual(A.grindPlan(['blaze'], levels, 1, stats, { blaze: xpCells(() => 1, [20]) }, unlocks), {
    game: 'blaze',
    bet: 40,
  });
  assert.deepEqual(A.grindPlan(['blaze'], levels, 1, stats, { blaze: xpCells(() => 1, [20, 40]) }, unlocks), {
    game: 'blaze',
    bet: 20,
  });
});

test('grindPlan climbs to bigger bets while XP grows with the stake', () => {
  const unlocks = { blaze: 1 };
  const stats = { blaze: { rounds: 40, wagered: 800, net: -100, xp: 40 } };
  const levels = [20, 40, 100, 200];
  const linear = (bet) => bet / 20;
  assert.deepEqual(A.grindPlan(['blaze'], levels, 1, stats, { blaze: xpCells(linear, [20, 40]) }, unlocks), {
    game: 'blaze',
    bet: 100,
  });
  assert.deepEqual(A.grindPlan(['blaze'], levels, 1, stats, { blaze: xpCells(linear, levels) }, unlocks), {
    game: 'blaze',
    bet: 200,
  });
  // XP per credit peaks at 100: the bet goes back there once 200 is measured.
  const peaked = (bet) => (bet <= 100 ? bet / 20 : 5);
  assert.deepEqual(A.grindPlan(['blaze'], levels, 1, stats, { blaze: xpCells(peaked, levels) }, unlocks), {
    game: 'blaze',
    bet: 100,
  });
});

test('grindPlan only climbs the ladder of the leading game', () => {
  const unlocks = { blaze: 1, skeleton: 5 };
  const stats = {
    blaze: { rounds: 40, wagered: 800, net: -400, xp: 40 },
    skeleton: { rounds: 40, wagered: 800, net: -100, xp: 40 },
  };
  const first = xpCells(() => 1, [20]);
  assert.deepEqual(A.grindPlan(['blaze', 'skeleton'], [20, 40], 6, stats, { blaze: first, skeleton: first }, unlocks), {
    game: 'skeleton',
    bet: 40,
  });
});

test('grindBets keeps a daily budget from being overshot by one round', () => {
  const daily = { grindLimit: 'daily', xpBudget: 500, grindMinBalance: 0, reserve: 0 };
  assert.deepEqual(A.grindBets(daily, 10_000, 0, [20, 40, 100, 200, 400, 1000]), [20, 40, 100, 200, 400]);
  assert.deepEqual(A.grindBets(daily, 10_000, 450, [20, 40, 100]), [20, 40]);
  const floor = { grindLimit: 'balance', xpBudget: 0, grindMinBalance: 1000, reserve: 0 };
  assert.deepEqual(A.grindBets(floor, 1100, 0, [20, 40, 100, 200]), [20, 40, 100]);
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

test('pickAccount visits an account not seen today first', () => {
  const accounts = [
    { id: 'a', seenAt: 300, seenDay: '2026-10-07', energy: 20, normDone: false },
    { id: 'b', seenAt: 200, seenDay: '2026-10-06', energy: 0, normDone: false },
    { id: 'c', seenAt: 100, seenDay: '2026-10-05', energy: 0, normDone: false },
  ];
  assert.equal(A.pickAccount(accounts, '2026-10-07', 5), 'c');
});

test('pickAccount takes the most energy, only above the minimum and before the norm', () => {
  const today = '2026-10-07';
  const accounts = [
    { id: 'a', seenAt: 1, seenDay: today, energy: 16, normDone: false },
    { id: 'b', seenAt: 2, seenDay: today, energy: 20, normDone: true },
    { id: 'c', seenAt: 3, seenDay: today, energy: 15, normDone: false },
  ];
  assert.equal(A.pickAccount(accounts, today, 15), 'a');
  assert.equal(A.pickAccount(accounts, today, 16), null);
  assert.equal(A.pickAccount([], today, 15), null);
});

test('pickAccount returns home from another account, even with nothing to do there', () => {
  const today = '2026-10-07';
  const accounts = [
    { id: 'home', seenAt: 1, seenDay: today, energy: 0, normDone: false },
    { id: 'b', seenAt: 2, seenDay: today, energy: 20, normDone: false },
  ];
  assert.equal(A.pickAccount(accounts, today, 15, 'home'), 'home');
  // A home without a saved login is not a candidate, so rotation carries on.
  assert.equal(A.pickAccount(accounts.slice(1), today, 15, 'home'), 'b');
});

test('pickAccount moves to the richest account that can grind when none has energy', () => {
  const today = '2026-10-07';
  const accounts = [
    { id: 'a', seenAt: 1, seenDay: today, energy: 3, credits: 900, canGrind: true },
    { id: 'b', seenAt: 2, seenDay: today, energy: 2, credits: 5000, canGrind: false },
    { id: 'c', seenAt: 3, seenDay: today, energy: 1, credits: 2000, canGrind: true },
  ];
  assert.equal(A.pickAccount(accounts, today, 15), 'c');
  assert.equal(A.pickAccount(accounts.map((a) => ({ ...a, canGrind: false })), today, 15), null);
});

test('grindReport shows XP per bet and where each level stands on the ladder', () => {
  const unlocks = { blaze: 1, roulette: 15 };
  const stats = { blaze: { rounds: 40, wagered: 2000, net: -100, xp: 120 } };
  // 20 and 40 keep XP per credit, 100 drops off, so 200 is never tried.
  const betXp = {
    blaze: { 20: { rounds: 10, xp: 20 }, 40: { rounds: 10, xp: 40 }, 100: { rounds: 10, xp: 50 } },
  };
  const [blaze, roulette] = A.grindReport(['blaze', 'roulette'], [200, 100, 40, 20], 5, stats, betXp, unlocks);
  assert.equal(blaze.locked, false);
  assert.equal(blaze.edge, 0.05);
  assert.equal(blaze.perRound, 3);
  assert.deepEqual(
    blaze.bets.map(({ bet, perRound, cost, state }) => [bet, perRound, cost, state]),
    [
      [20, 2, 0.5, null],
      [40, 4, 0.5, 'best'],
      [100, 5, 1, 'worse'],
      [200, null, null, 'skipped'],
    ],
  );
  assert.equal(roulette.locked, true);
  assert.equal(roulette.edge, null);
  assert.equal(roulette.bets[0].state, 'next');
});
