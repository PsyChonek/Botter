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

test('grindPlan plays the unlocked game with the lowest simulated edge at the chosen bet', () => {
  const unlocks = { blaze: 1, skeleton: 5, blackjack: 10 };
  const games = Object.keys(unlocks);
  // Blaze once looked cheaper per XP on a lucky 10-round XP sample despite the
  // higher edge; measured XP no longer takes part in the pick.
  const edges = { blaze: 0.363, skeleton: 0.294, blackjack: 0.124 };
  assert.deepEqual(A.grindPlan(games, 100, 1, unlocks, edges), { game: 'blaze', bet: 100 });
  assert.deepEqual(A.grindPlan(games, 20, 6, unlocks, edges), { game: 'skeleton', bet: 20 });
  assert.deepEqual(A.grindPlan(games, 40, 12, unlocks, edges), { game: 'blackjack', bet: 40 });
  assert.equal(A.grindPlan(games, 20, 0, unlocks, edges), null);
  assert.equal(A.grindPlan(games, null, 12, unlocks, edges), null);
});

test('grindPlan never picks a game without a model', () => {
  const unlocks = { blaze: 1, skeleton: 5 };
  assert.deepEqual(A.grindPlan(['blaze', 'skeleton'], 20, 6, unlocks, { skeleton: 0.294 }), { game: 'skeleton', bet: 20 });
  assert.equal(A.grindPlan(['blaze'], 20, 6, unlocks, {}), null);
});

test('grindBet plays the chosen bet and steps down near a limit', () => {
  const levels = [20, 40, 100, 200];
  const daily = { grindLimit: 'daily', xpBudget: 500, grindMinBalance: 0, reserve: 0 };
  assert.equal(A.grindBet(daily, 10_000, 0, levels, 100), 100);
  assert.equal(A.grindBet(daily, 10_000, 450, levels, 100), 40);
  assert.equal(A.grindBet(daily, 10_000, 500, levels, 100), null);
  const off = { grindLimit: 'off', xpBudget: 0, grindMinBalance: 0, reserve: 0 };
  assert.equal(A.grindBet(off, 150, 0, levels, 200), 100);
  // A bet above the max bet plays the max bet.
  assert.equal(A.grindBet(off, 10_000, 0, [20, 40], 1000), 40);
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

test('grindAllowed with the limit off bets down to the reserve only', () => {
  const off = { grindLimit: 'off', xpBudget: 0, grindMinBalance: 0, reserve: 0 };
  assert.equal(A.grindAllowed(off, 20, 50_000, 20), true);
  assert.equal(A.grindAllowed(off, 19, 0, 20), false);
  assert.equal(A.grindAllowed({ ...off, reserve: 300 }, 320, 0, 20), true);
  assert.equal(A.grindAllowed({ ...off, reserve: 300 }, 319, 0, 20), false);
  assert.deepEqual(A.grindBets(off, 1200, 50_000, [20, 40, 100, 1000, 2000]), [20, 40, 100, 1000]);
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

test('grindReport shows the simulated edge, XP per credit and loss per XP for every game', () => {
  const unlocks = { blaze: 1, roulette: 15 };
  // Blaze ran lucky (measured edge 0.05); the report shows the simulated one.
  const stats = { blaze: { rounds: 40, wagered: 2000, net: -100, xp: 120 } };
  // 120 XP over 2000 credits wagered: 0.06 XP per credit.
  const [blaze, roulette] = A.grindReport(['blaze', 'roulette'], 5, stats, unlocks, { blaze: 0.3, roulette: 0.077 });
  assert.equal(blaze.locked, false);
  assert.equal(blaze.edge, 0.3);
  assert.equal(blaze.rate, 0.06);
  assert.ok(Math.abs(blaze.cost - 5) < 1e-9);
  assert.equal(roulette.locked, true);
  assert.equal(roulette.edge, 0.077);
  assert.equal(roulette.rate, null);
  assert.equal(roulette.cost, null);
  const [unmodelled] = A.grindReport(['blaze'], 5, stats, unlocks);
  assert.equal(unmodelled.edge, null);
  assert.equal(unmodelled.cost, null);
});

// Upgrade verdict context with a toy edge model: each level of a key cuts the
// edge by perLevel[key], each level costs 1000.
function verdictCtx(overrides = {}) {
  const perLevel = { team: 0.03, wild: 0.03, hint: 0 };
  const base = { skeleton: 0.3, roulette: 0.077 };
  const edge = (game, upgrades) => {
    if (!(game in base)) return null;
    const own = upgrades?.[game] ?? {};
    return base[game] - Object.entries(own).reduce((sum, [key, l]) => sum + (perLevel[key] ?? 0) * l, 0);
  };
  const upgrades = {};
  return {
    games: ['skeleton'],
    upgrades,
    edge,
    rest: (keys, upTo = 4) => {
      const own = Object.fromEntries(keys.map((key) => [key, Math.min(4, upTo)]));
      return { price: keys.length * Math.min(4, upTo) * 1000, upgrades: { skeleton: own } };
    },
    maxLevels: { team: 4, wild: 4, hint: 1 },
    volume: 1_000_000,
    ...overrides,
  };
}
const offer = (game, key) => ({ game, key, next: 1, price: 1000 });

test('upgradeVerdict buys an upgrade that pays back in XP', () => {
  assert.equal(A.upgradeVerdict(offer('skeleton', 'team'), verdictCtx()), null);
});

test('upgradeVerdict skips upgrades that barely change the odds', () => {
  assert.equal(A.upgradeVerdict(offer('skeleton', 'hint'), verdictCtx()), 'tooSmall');
});

test('upgradeVerdict upgrades only the game the grinder plays', () => {
  const ctx = verdictCtx({ games: ['skeleton', 'roulette'] });
  // Skeleton maxed would get to 0.06 edge, below roulette's 0.077, but the grinder
  // plays roulette until then, so Skeleton is not upgraded.
  assert.equal(A.upgradeVerdict(offer('skeleton', 'team'), ctx), 'notBest');
  // Roulette at 0.28: one level of team (0.3 -> 0.27) makes Skeleton the cheapest.
  const close = (game, upgrades) => (game === 'roulette' ? 0.28 : ctx.edge(game, upgrades));
  assert.equal(A.upgradeVerdict(offer('skeleton', 'team'), { ...ctx, edge: close }), null);
  // Skeleton already the cheapest.
  const far = (game, upgrades) => (game === 'roulette' ? 0.4 : ctx.edge(game, upgrades));
  assert.equal(A.upgradeVerdict(offer('skeleton', 'team'), { ...ctx, edge: far }), null);
  assert.equal(A.upgradeVerdict(offer('skeleton', 'team'), { ...ctx, games: ['roulette'] }), 'notGrinded');
});

test('finalGame is the lowest edge maxed and upgradeVerdict buys nothing for other games', () => {
  const maxed = { blaze: 0.039, blackjack: 0.029, roulette: 0.027, crash: null };
  assert.equal(A.finalGame(Object.keys(maxed), (g) => maxed[g]), 'roulette');
  assert.equal(A.finalGame(['crash'], (g) => maxed[g]), null);
  const ctx = verdictCtx({ finalGame: 'roulette' });
  assert.equal(A.upgradeVerdict(offer('skeleton', 'team'), ctx), 'notFinal');
  // The final game is upgraded even while it is not the cheapest yet.
  const behind = verdictCtx({ games: ['skeleton', 'roulette'], finalGame: 'skeleton' });
  assert.equal(A.upgradeVerdict(offer('skeleton', 'team'), behind), null);
});

test('upgradeVerdict prefers plain XP grinding when the volume is too small to pay back', () => {
  // Spending 8000 of 9000 credits on upgrades leaves too little to grind.
  assert.equal(A.upgradeVerdict(offer('skeleton', 'team'), verdictCtx({ volume: 9000 })), 'xpFarmingBetter');
  assert.equal(A.upgradeVerdict(offer('skeleton', 'team'), verdictCtx({ volume: 0 })), 'xpFarmingBetter');
});

test('grindVolume is the budget over the horizon or what is above the floor', () => {
  assert.equal(A.grindVolume({ grindLimit: 'daily', xpBudget: 1000 }, 50_000), 14_000);
  assert.equal(A.grindVolume({ grindLimit: 'balance', grindMinBalance: 20_000 }, 50_000), 30_000);
  assert.equal(A.grindVolume({ grindLimit: 'balance', grindMinBalance: 60_000 }, 50_000), 0);
  assert.equal(A.grindVolume({ grindLimit: 'off', reserve: 5_000 }, 50_000), 45_000);
});

test('upgradeVerdict buys a cheap first level that pays back on its own', () => {
  // Maxing team and wild (8000) does not pay back on 20,000 credits, but the
  // first two levels of team (2000, edge 0.3 -> 0.24) do.
  const ctx = verdictCtx({ volume: 20_000 });
  assert.equal(A.upgradeVerdict(offer('skeleton', 'team'), ctx), null);
  assert.equal(A.upgradeVerdict(offer('skeleton', 'team'), verdictCtx({ volume: 5000 })), 'xpFarmingBetter');
});

test('workDue keeps energy off the cap while grinding, else drains a run from above the minimum', () => {
  // Grinding: work only near the cap, whatever the run state.
  assert.equal(A.workDue(17, 20, false, 5, true), false);
  assert.equal(A.workDue(17, 20, true, 5, true), false);
  assert.equal(A.workDue(18, 20, false, 5, true), true);
  assert.equal(A.workDue(20, 20, false, 5, true), true);
  assert.equal(A.workDue(28, 30, false, 5, true), true);
  // Not grinding: start above the minimum, then work down to zero.
  assert.equal(A.workDue(5, 20, false, 5, false), false);
  assert.equal(A.workDue(6, 20, false, 5, false), true);
  assert.equal(A.workDue(3, 20, true, 5, false), true);
  assert.equal(A.workDue(0, 20, true, 5, false), false);
  // Grinding ends with energy just below the cap: that energy is worked down.
  assert.equal(A.workDue(17, 20, false, 5, false), true);
});

test('bankruptWorth only in execution, when the debt costs more than the reset', () => {
  const player = (debt, credits, xpInto = 0, execution = true) => ({
    credits,
    xpInto,
    loan: { debt, execution },
  });
  // 2500 debt against 300 credits: the debt vanishes and credits rise to 500.
  assert.equal(A.bankruptWorth(player(2500, 300), 1), true);
  // Not offered before execution, and never without a loan.
  assert.equal(A.bankruptWorth(player(2500, 300, 0, false), 1), false);
  assert.equal(A.bankruptWorth({ credits: 300 }, 1), false);
  // Rich enough to pay: losing 9500 credits to drop 2500 of debt is worse.
  assert.equal(A.bankruptWorth(player(2500, 10_000), 1), false);
  // Between the debt and debt + 500 the reset is cheaper.
  assert.equal(A.bankruptWorth(player(2500, 2800), 1), true);
  // The lost XP counts at the grinder's price per XP point.
  assert.equal(A.bankruptWorth(player(2500, 300, 1000, true), 2), true);
  assert.equal(A.bankruptWorth(player(2500, 300, 1000, true), 3), false);
  // Unknown XP price: only a bankruptcy that loses no XP.
  assert.equal(A.bankruptWorth(player(2500, 300, 0), null), true);
  assert.equal(A.bankruptWorth(player(2500, 300, 10), null), false);
});

test('wheelReady when never spun or a few seconds past the cooldown, not for old snapshots', () => {
  assert.equal(A.wheelReady(null, 1000), true);
  assert.equal(A.wheelReady(1000, 6000), true);
  assert.equal(A.wheelReady(1000, 5999), false);
  assert.equal(A.wheelReady(1000, 1000), false);
  assert.equal(A.wheelReady(undefined, 1000), false);
});

test('pickAccount spins a ready wheel after fresh accounts and before going home', () => {
  const today = '2026-10-07';
  const accounts = [
    { id: 'home', seenAt: 1, seenDay: today, energy: 0, wheel: false },
    { id: 'b', seenAt: 3, seenDay: today, energy: 20, wheel: true },
    { id: 'c', seenAt: 2, seenDay: today, energy: 0, wheel: true },
  ];
  assert.equal(A.pickAccount(accounts, today, 15, 'home'), 'c');
  assert.equal(A.pickAccount([...accounts, { id: 'd', seenAt: 9, seenDay: '2026-10-06' }], today, 15, 'home'), 'd');
  assert.equal(A.pickAccount(accounts.map((a) => ({ ...a, wheel: false })), today, 15, 'home'), 'home');
});

test('urgentAccount leaves only for a fresh account or a ready wheel', () => {
  const today = '2026-10-07';
  const accounts = [
    { id: 'home', seenAt: 1, seenDay: today, energy: 20, canGrind: true, wheel: false },
    { id: 'b', seenAt: 3, seenDay: today, energy: 20, wheel: true },
    { id: 'c', seenAt: 2, seenDay: today, energy: 0, wheel: true },
  ];
  assert.equal(A.urgentAccount(accounts, today), 'c');
  assert.equal(A.urgentAccount([...accounts, { id: 'd', seenAt: 9, seenDay: '2026-10-06' }], today), 'd');
  assert.equal(A.urgentAccount(accounts.map((a) => ({ ...a, wheel: false })), today), null);
  assert.equal(A.urgentAccount([], today), null);
});

test('waitForLevel finishes a level when its XP is worth more than the garnished pay', () => {
  // 900 of 1000 XP in: losing 900 XP at 2 credits costs 1800, finishing the
  // last 100 XP costs half of 100 * 3 = 150 of work pay.
  assert.equal(A.waitForLevel({ xpInto: 900, xpNeed: 1000 }, 2, 3), true);
  // 50 of 1000 XP in: losing 100 credits of XP beats 1425 of garnish.
  assert.equal(A.waitForLevel({ xpInto: 50, xpNeed: 1000 }, 2, 3), false);
  // No prices, or nothing to lose: declare now.
  assert.equal(A.waitForLevel({ xpInto: 900, xpNeed: 1000 }, null, 3), false);
  assert.equal(A.waitForLevel({ xpInto: 900, xpNeed: 1000 }, 2, null), false);
  assert.equal(A.waitForLevel({ xpInto: 0, xpNeed: 1000 }, 2, 3), false);
});

test('loanAmount rounds down to the 500 steps the shark lends in', () => {
  assert.equal(A.loanAmount(4321), 4000);
  assert.equal(A.loanAmount(499), 0);
  assert.equal(A.loanAmount(undefined), 0);
});

test('loanCycle expects the cheaper of losing or finishing each point of the level', () => {
  const [amount, xpNeed, xpPrice, workPerXp] = [3000, 1000, 2, 3];
  // Monte Carlo: bankruptcy lands at a uniform point of the level, and the bot
  // waits for the level when that is cheaper (waitForLevel).
  let seed = 1;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let total = 0;
  const runs = 200_000;
  for (let i = 0; i < runs; i++) {
    const xpInto = random() * xpNeed;
    const wait = A.waitForLevel({ xpInto, xpNeed }, xpPrice, workPerXp);
    total += wait ? 0.5 * workPerXp * (xpNeed - xpInto) : xpInto * xpPrice;
  }
  const plan = A.loanCycle(amount, 0, xpNeed, xpPrice, workPerXp);
  assert.ok(Math.abs(plan.cost - total / runs) < 5, `${plan.cost} vs ${total / runs}`);
  assert.ok(plan.value > 0);
  // A small loan against an expensive level does not pay.
  assert.ok(A.loanCycle(500, 0, 10_000, 2, 3).value < 0);
  // Savings above 500 would be ground away with the loan, so they count.
  assert.equal(A.loanCycle(3000, 2500, 1000, 2, null).cost, 3000);
  // Without a work rate, the XP lost is half a level on average.
  assert.equal(A.loanCycle(3000, 300, 1000, 2, null).cost, 1000);
  assert.equal(A.loanCycle(3000, 0, 1000, null, 3), null);
  assert.equal(A.loanCycle(0, 0, 1000, 2, 3), null);
});

test('questGame and questKind read the standup quest text', () => {
  const spins = { key: 'q1', text: 'Zatoč si 25× Skeleton Slots' };
  const wager = { key: 'q2', text: 'Protoč 2 500 kreditů' };
  const ahead = { key: 'q3', text: 'Skonči 10× v plusu' };
  assert.equal(A.questGame(spins), 'skeleton');
  assert.equal(A.questKind(spins), 'rounds');
  assert.equal(A.questGame(wager), null);
  assert.equal(A.questKind(wager), 'wager');
  assert.equal(A.questKind(ahead), 'wins');
  assert.equal(A.questGame({ key: 'spins_roulette', text: 'Roztoč kolo' }), 'roulette');
  assert.equal(A.questKind({ key: 'q', text: 'Vyhraj 1 000 kreditů' }), null);
  assert.equal(A.questKind({ key: 'q', text: 'Dej si kafe' }), null);
  // A big win is a payout of 10x the bet or more, not a round ahead.
  assert.equal(A.questKind({ key: 'big_win', text: 'Tref BIG WIN' }), 'big');
  assert.equal(A.questKind({ key: 'q', text: 'Tref 2× velkou výhru' }), 'big');
  assert.equal(A.questKind({ key: 'q', text: 'Tref MEGA WIN' }), 'mega');
});

test('standupPlan plays a big win quest only on a game that can pay one', () => {
  const ctx = {
    level: 20,
    unlocks: { blaze: 1, skeleton: 5, blackjack: 10 },
    edges: { blaze: 0.05, skeleton: 0.04, blackjack: 0.01 },
    bigs: { blaze: [0.02, 0.004, 0.001], skeleton: [0.01, 0.002, 0.0005], blackjack: [0, 0, 0] },
    levels: [20],
  };
  const quest = { key: 'big_win', text: 'Tref BIG WIN', progress: 0, target: 1, reward: 800 };
  // Blaze: 50 rounds * 20 * 0.05 = 50; Skeleton: 100 rounds * 20 * 0.04 = 80; blackjack never pays 10x.
  const plan = A.standupPlan([quest], ctx);
  assert.equal(plan.game, 'blaze');
  assert.ok(Math.abs(plan.cost - 50) < 1e-9);
  // A super win at 1 in 1,000 rounds costs 1,000 on Blaze, more than it pays.
  const skipped = [];
  assert.equal(A.standupPlan([{ ...quest, text: 'Tref SUPER WIN' }], ctx, skipped), null);
  assert.equal(skipped[0].reason, 'tooCostly');
  // Without simulated rates nothing can be priced.
  const none = [];
  assert.equal(A.standupPlan([quest], { ...ctx, bigs: undefined }, none), null);
  assert.equal(none[0].reason, 'noGame');
});

test('standupPlan plays a quest on the game and bet where it costs least', () => {
  const ctx = {
    level: 20,
    unlocks: { blaze: 1, skeleton: 5, slotingi: 7, blackjack: 10, roulette: 15 },
    edges: { blaze: 0.37, skeleton: 0.29, slotingi: 0.26, blackjack: 0.12, roulette: 1 - 36 / 39 },
    levels: [20, 40, 100],
  };
  const quests = [
    { key: 'a', text: 'Zatoč si 25× Skeleton Slots', progress: 10, target: 25, done: false, reward: 480 },
    { key: 'b', text: 'Protoč 2 500 kreditů', progress: 2500, target: 2500, done: true, reward: 480 },
  ];
  // 15 spins at 20 lose 15 * 20 * 0.29 = 87 on average, under the 480 reward.
  const plan = A.standupPlan(quests, ctx);
  assert.equal(plan.quest.key, 'a');
  assert.equal(plan.game, 'skeleton');
  assert.equal(plan.bet, 20);
  assert.ok(Math.abs(plan.cost - 87) < 1e-9);

  // A wager goes to the lowest edge at the biggest bet that does not overshoot.
  const wager = A.standupPlan([{ key: 'w', text: 'Protoč 2 500 kreditů', progress: 2450, target: 2500, reward: 480 }], ctx);
  assert.equal(wager.game, 'roulette');
  assert.equal(wager.bet, 40);
  // Rounds ahead go to roulette: half its return wins on an even-money bet.
  const wins = A.standupPlan([{ key: 'p', text: 'Skonči 10× v plusu', progress: 0, target: 10, reward: 480 }], ctx);
  assert.equal(wins.game, 'roulette');
  assert.equal(wins.bet, 20);
});

test('standupPlan prices a rounds-ahead quest with the simulated win rate when given', () => {
  const ctx = {
    level: 20,
    unlocks: { slotingi: 7, roulette: 15 },
    edges: { slotingi: 0.03, roulette: 1 - 36 / 39 },
    levels: [20],
  };
  const quest = [{ key: 'p', text: 'Skonči 10× v plusu', progress: 0, target: 10, reward: 480 }];
  // Without win rates a slot is guessed to win a quarter of its rounds: 10 / 0.25 * 20 * 0.03 = 24,
  // under roulette's 10 / 0.4615 * 20 * 0.0769 = 33.
  assert.equal(A.standupPlan(quest, ctx).game, 'slotingi');
  // At a simulated 10 % the slot costs 60, so roulette wins.
  const plan = A.standupPlan(quest, { ...ctx, wins: { slotingi: 0.1, roulette: 18 / 39 } });
  assert.equal(plan.game, 'roulette');
  assert.ok(Math.abs(plan.cost - (10 / (18 / 39)) * 20 * (3 / 39)) < 1e-9);
});

test('standupPlan skips quests that cost more than they pay or cannot be played', () => {
  const ctx = { level: 6, unlocks: { blaze: 1, skeleton: 5, roulette: 15 }, edges: { blaze: 0.37, skeleton: 0.29, roulette: 0.05 }, levels: [20] };
  const skipped = [];
  const plan = A.standupPlan(
    [
      { key: 'costly', text: 'Zatoč si 200× Blaze 20 Wild', progress: 0, target: 200, reward: 480 },
      { key: 'locked', text: 'Zatoč si 10× Ruletu', progress: 0, target: 10, reward: 480 },
      { key: 'crash', text: 'Vsaď na Produkce padá', progress: 0, target: 1, reward: 480 },
      { key: 'odd', text: 'Dej si kafe', progress: 0, target: 1, reward: 480 },
    ],
    ctx,
    skipped,
  );
  assert.equal(plan, null);
  assert.deepEqual(
    skipped.map((item) => `${item.key} ${item.reason}`),
    ['costly tooCostly', 'locked noGame', 'crash noGame', 'odd unknown'],
  );
  // Nothing affordable: no bet level fits above the reserve.
  const broke = [];
  assert.equal(A.standupPlan([{ key: 'a', text: 'Zatoč si 5× Blaze', progress: 0, target: 5, reward: 480 }], { ...ctx, levels: [] }, broke), null);
  assert.equal(broke[0].reason, 'noCredits');
});

test('sprint prize at stake only on the podium with points', () => {
  assert.equal(A.sprintAtStake({ rank: 1, score: 900 }), 5_000);
  assert.equal(A.sprintAtStake({ rank: 3, score: 900 }), 2_000);
  assert.equal(A.sprintAtStake({ rank: 4, score: 900 }), 0);
  assert.equal(A.sprintAtStake({ rank: 1, score: 0 }), 0);
  assert.equal(A.sprintAtStake(null), 0);
});

test('bankruptcy waits for the sprint end on the podium, loans start 12 hours before it', () => {
  const hour = 60 * 60 * 1000;
  const endAt = 100 * hour;
  const podium = { rank: 2, score: 500, endAt };
  const off = { rank: 7, score: 500, endAt };
  assert.equal(A.sprintHold(podium, endAt - 1), true);
  assert.equal(A.sprintHold(podium, endAt), false);
  assert.equal(A.sprintHold(off, endAt - 1), false);
  // Execution comes 12 hours after the loan, so the bankruptcy lands after the end.
  assert.equal(A.loanSprintSafe(podium, endAt - 13 * hour), false);
  assert.equal(A.loanSprintSafe(podium, endAt - 12 * hour), true);
  assert.equal(A.loanSprintSafe(off, 0), true);
});

// Player with every hunted achievement open, at level 20 with 500 rounds played.
const hunter = (extra = {}) => ({ achievements: {}, totalSpins: 500, ...extra });
const huntCtx = (extra = {}) => ({
  level: 20,
  unlocks: { blaze: 1, blackjack: 10, roulette: 15 },
  edges: { blaze: 0.3, blackjack: 0.124, roulette: 1 - 36 / 39 },
  levels: [20, 40, 100],
  now: new Date(2026, 9, 8, 12).getTime(), // a Thursday noon
  ...extra,
});

test('achievementTier reads the next tier, null when done or unknown', () => {
  assert.equal(A.achievementTier({ achievements: {} }, 'regular'), 0);
  assert.equal(A.achievementTier({ achievements: { regular: { tier: 2 } } }, 'regular'), 2);
  assert.equal(A.achievementTier({ achievements: { regular: { tier: 3 } } }, 'regular'), null);
  assert.equal(A.achievementTier({ achievements: { natural: { tier: 1 } } }, 'natural'), null);
  assert.equal(A.achievementTier({}, 'natural'), null);
});

test('huntPlan bets on zero at the smallest bet while roulette pays it best', () => {
  const plan = A.huntPlan(hunter(), huntCtx());
  assert.equal(plan.game, 'roulette');
  assert.equal(plan.spot, 'n:0');
  assert.equal(plan.bet, 20);
  // 1000 / 39 for the zero plus 1000 / 500 for the rounds tier, against 20 * 3/39.
  assert.ok(Math.abs(plan.value - (1000 / 39 + 2)) < 1e-9, `value ${plan.value}`);
  assert.deepEqual(plan.targets, ['regular', 'zero_hero']);
});

test('huntPlan moves to blackjack once the zero is done and stops when nothing pays', () => {
  const plan = A.huntPlan(hunter({ achievements: { zero_hero: { tier: 1 } } }), huntCtx());
  assert.equal(plan.game, 'blackjack');
  assert.deepEqual(plan.targets, ['regular', 'natural', 'five_cards']);
  const done = { zero_hero: { tier: 1 }, natural: { tier: 1 }, five_cards: { tier: 1 } };
  // The rounds tier alone is worth 1000 / 500 = 2 a round, above roulette's 20 * 3/39 loss.
  assert.equal(A.huntPlan(hunter({ achievements: done }), huntCtx()).game, 'roulette');
  assert.equal(A.huntPlan(hunter({ achievements: done, totalSpins: 100 }), huntCtx()), null);
  assert.equal(A.huntPlan(hunter({ achievements: done, achProgress: { regular: 100 } }), huntCtx()), null);
});

test('bonusEdges takes the wins bonus off each edge and can change the grind pick', () => {
  const edges = { skeleton: 0.2, slotingi: 0.22 };
  assert.equal(A.bonusEdges(edges, { skeleton: 0.1 }, 0), edges);
  const bonus = A.bonusEdges(edges, { skeleton: 0.1, slotingi: 0.4 }, 0.5);
  assert.ok(Math.abs(bonus.skeleton - 0.15) < 1e-12 && Math.abs(bonus.slotingi - 0.02) < 1e-12);
  assert.equal(A.cheapestGame(['skeleton', 'slotingi'], 10, { skeleton: 5, slotingi: 7 }, edges), 'skeleton');
  assert.equal(A.cheapestGame(['skeleton', 'slotingi'], 10, { skeleton: 5, slotingi: 7 }, bonus), 'slotingi');
});

test('huntPlan leaves rounds-played tiers above the chosen goal', () => {
  const done = { zero_hero: { tier: 1 }, natural: { tier: 1 }, five_cards: { tier: 1 } };
  assert.equal(A.huntPlan(hunter({ achievements: done }), huntCtx({ roundsGoal: 1000 })).game, 'roulette');
  const second = hunter({ achievements: { ...done, regular: { tier: 1 } }, totalSpins: 9000 });
  // 5000 over the 1,000 rounds left is worth 5 a round, above the 20 * 3/39 roulette loss.
  assert.equal(A.huntPlan(second, huntCtx({ roundsGoal: 10_000 })).game, 'roulette');
  assert.equal(A.huntPlan(second, huntCtx({ roundsGoal: 1000 })), null);
});

test('huntPlan plays a round at night and skips locked games and missing data', () => {
  const done = { zero_hero: { tier: 1 }, natural: { tier: 1 }, five_cards: { tier: 1 }, regular: { tier: 3 } };
  assert.equal(A.huntPlan(hunter({ achievements: done }), huntCtx()), null);
  const night = A.huntPlan(hunter({ achievements: done }), huntCtx({ now: new Date(2026, 9, 8, 3).getTime() }));
  assert.deepEqual(night.targets, ['night_owl']);
  assert.equal(night.game, 'roulette');
  assert.equal(A.huntPlan(hunter(), huntCtx({ level: 5 })), null);
  assert.equal(A.huntPlan({ totalSpins: 500 }, huntCtx()), null);
  assert.equal(A.huntPlan(hunter(), huntCtx({ levels: [] })), null);
});

test('crashHitChance reads the share of rounds that reach the target', () => {
  const history = [2, 5, 12, 20, { planned: true }].map((m) => (typeof m === 'number' ? { mult: m } : m));
  assert.equal(A.crashHitChance(history, 1, 1, 10), 3 / 5);
  assert.equal(A.crashHitChance(history.slice(0, 3), 1, 1, 10), null);
  // Past the planned outage level the bet is paid there, short of the target.
  assert.equal(A.crashHitChance(history, 1, 0.1, 10), 0);
});

test('crashHuntWorth counts the achievement reward on top of the payout', () => {
  assert.equal(A.crashHuntWorth(0.02, 20), true); // 0.02 * (200 + 2000) = 44 > 20
  assert.equal(A.crashHuntWorth(0.005, 20), false); // 11 < 20
  assert.equal(A.crashHuntWorth(null, 20), false);
});

test('fridayEvening is Friday from 17:00', () => {
  assert.equal(A.fridayEvening(new Date(2026, 9, 9, 17).getTime()), true);
  assert.equal(A.fridayEvening(new Date(2026, 9, 9, 16, 59).getTime()), false);
  assert.equal(A.fridayEvening(new Date(2026, 9, 10, 18).getTime()), false);
});

test('lottery tickets pay about 71.7 % back', () => {
  assert.ok(Math.abs(A.LOTTERY_RTP - 0.7167) < 0.0005);
  const all = [0, 1, 2, 3, 4, 5, 6].reduce((sum, hits) => sum + A.lotteryChance(hits), 0);
  assert.ok(Math.abs(all - 1) < 1e-12);
});

test('luckyPlan buys the wanted tickets at the biggest affordable price up to the wanted one', () => {
  assert.deepEqual(A.luckyPlan({ mine: 0, prices: [20, 40, 100], price: 40, tickets: 5 }), { price: 40, tickets: 5 });
  assert.deepEqual(A.luckyPlan({ mine: 0, prices: [20, 40], price: 200, tickets: 3 }), { price: 40, tickets: 3 });
  assert.deepEqual(A.luckyPlan({ mine: 2, prices: [20], price: 20, tickets: 9 }), { price: 20, tickets: 3 });
  assert.equal(A.luckyPlan({ mine: 3, prices: [20], price: 20, tickets: 3 }), null);
  assert.equal(A.luckyPlan({ mine: 0, prices: [100], price: 40, tickets: 5 }), null);
  assert.equal(A.luckyPlan({ mine: 0, prices: [], price: 20, tickets: 5 }), null);
});

test('lotteryPlan buys five cheap tickets while the hit achievements are open', () => {
  const plan = A.lotteryPlan({ achievements: {} }, { mine: 0, prices: [100, 20, 40] });
  assert.deepEqual([plan.price, plan.tickets], [20, 5]);
  // Two tickets already on the draw: three more fill it.
  assert.equal(A.lotteryPlan({ achievements: {} }, { mine: 2, prices: [20] }).tickets, 3);
  assert.equal(A.lotteryPlan({ achievements: {} }, { mine: 5, prices: [20] }), null);
  assert.equal(A.lotteryPlan({ achievements: {} }, { mine: 0, prices: [] }), null);
});

test('lotteryPlan buys one ticket per draw for the draws-played tiers only', () => {
  const done = { lottery_3: { tier: 1 }, lottery_full: { tier: 1 } };
  const plan = A.lotteryPlan({ achievements: { ...done, lottery_days: { tier: 1 } }, achProgress: { lottery_days: 3 } }, { mine: 0, prices: [20] });
  assert.equal(plan.tickets, 1);
  // A ticket already on this draw counted it.
  assert.equal(A.lotteryPlan({ achievements: done }, { mine: 1, prices: [20] }), null);
  const allDone = { ...done, lottery_days: { tier: 3 } };
  assert.equal(A.lotteryPlan({ achievements: allDone }, { mine: 0, prices: [20] }), null);
});

test('payrollWorth pays the whole fund to a bet that reaches the cap, a share of it to a push', () => {
  const fund = { amount: 11_500, cap: 12_000 };
  // 500 left takes 50,000 in bets; half the pushes are expected to win 11,500.
  assert.equal(A.payrollWorth(fund, 1000), (0.5 * 11_500) / 50_000);
  assert.equal(A.payrollWorth(fund, 20), A.payrollWorth(fund, 1000));
  // 1 % of 1,000 covers the last 10.
  assert.equal(A.payrollWorth({ amount: 11_990, cap: 12_000 }, 1000), 11.99);
  // A 400 bet only pushes the last 10: half the fund over 1,000 in bets.
  assert.equal(A.payrollWorth({ amount: 11_990, cap: 12_000 }, 400), (0.5 * 11_990) / 1000);
  assert.equal(A.payrollWorth(null, 1000), 0);
});

test('payrollPollMs reads the fund often once pushing it pays', () => {
  assert.equal(A.payrollPollMs({ amount: 11_500, cap: 12_000 }, 0.027), 10_000);
  assert.equal(A.payrollPollMs({ amount: 3000, cap: 12_000 }, 0.027), 60_000);
  assert.equal(A.payrollPollMs(null, 0.027), 60_000);
  assert.equal(A.payrollPollMs({ amount: 11_500, cap: 12_000 }, null), 60_000);
});

test('edgePlan bets on the payroll fund only near its cap', () => {
  const ctx = {
    level: 20,
    unlocks: { blaze: 1, roulette: 15 },
    edges: { blaze: 0.3, roulette: 0.027 },
    variances: { roulette: 1 },
    levels: [20, 40, 100, 200, 400, 1000],
    bankroll: 20_000,
    kelly: 0.5,
    winsBonus: 0,
  };
  // Far from the cap a push adds 0.5 * 0.01 * 6000 / 6000 = 0.5 % per credit, less than the edge.
  assert.equal(A.edgePlan({ ...ctx, payroll: { amount: 6000, cap: 12_000 } }), null);
  // At 11,500 it adds 11.5 %: the biggest bet half Kelly allows on roulette (0.088 * 0.5 * 20,000).
  const plan = A.edgePlan({ ...ctx, payroll: { amount: 11_500, cap: 12_000 } });
  assert.deepEqual([plan.game, plan.bet, plan.payroll], ['roulette', 400, true]);
  // A small bankroll keeps the bet small.
  assert.equal(A.edgePlan({ ...ctx, bankroll: 1000, payroll: { amount: 11_500, cap: 12_000 } }).bet, 40);
  // With 30 left the smallest bet that reaches the cap takes the fund.
  assert.equal(A.edgePlan({ ...ctx, payroll: { amount: 11_970, cap: 12_000 } }).bet, 1000);
  assert.equal(A.edgePlan({ ...ctx, payroll: { amount: 11_997, cap: 12_000 } }).bet, 400);
  assert.equal(A.edgePlan({ ...ctx, payroll: null }), null);
});

test('edgePlan plays the Konec kvartálu bonus on the game with the best edge', () => {
  const ctx = {
    level: 20,
    unlocks: { blaze: 1, roulette: 15 },
    edges: { blaze: 0.3, roulette: 0.027 },
    gains: { blaze: 0.2, roulette: 0.486 },
    variances: { blaze: 20, roulette: 1 },
    levels: [20, 40, 100, 200, 400, 1000],
    bankroll: 5000,
    kelly: 0.5,
    winsBonus: A.WINS_BONUS,
    payroll: null,
  };
  const plan = A.edgePlan(ctx);
  // 0.5 * 0.486 - 0.027 = +21.6 % a credit; half Kelly on 5,000 allows 540.
  assert.equal(plan.game, 'roulette');
  assert.equal(plan.bet, 400);
  assert.ok(Math.abs(plan.ev - 0.216) < 1e-9);
  assert.equal(A.edgePlan({ ...ctx, winsBonus: 0 }), null);
});

test('weekendEvent follows the client rotation from Friday 17:00 to Monday 9:00 Prague time', () => {
  const at = (iso) => A.weekendEvent(Date.parse(iso));
  const first = at('2026-10-09T16:00:00Z');
  assert.equal(first.key, 'xp');
  assert.equal(first.active, true);
  assert.equal(new Date(first.startAt).toISOString(), '2026-10-09T15:00:00.000Z');
  assert.equal(new Date(first.endAt).toISOString(), '2026-10-12T07:00:00.000Z');
  assert.equal(at('2026-10-09T14:59:00Z').active, false);
  assert.equal(at('2026-10-12T06:59:00Z').active, true);
  assert.deepEqual(
    ['2026-10-17', '2026-10-24', '2026-10-31', '2026-11-07'].map((day) => at(`${day}T12:00:00Z`).key),
    ['wins', 'wheel', 'overtime', 'xp'],
  );
  // Winter time: 17:00 Prague is 16:00 UTC.
  assert.equal(new Date(at('2026-10-31T12:00:00Z').startAt).toISOString(), '2026-10-30T16:00:00.000Z');
});

test('workHold saves energy for the start of a weekend that pays work more', () => {
  const event = { key: 'overtime', startAt: 100 * 120_000 };
  // 10 points refill by the start: holding 10 ends at the cap of 20.
  assert.equal(A.workHold(10, 20, event, 90 * 120_000, 120_000), true);
  assert.equal(A.workHold(11, 20, event, 90 * 120_000, 120_000), false);
  assert.equal(A.workHold(10, 20, event, 100 * 120_000, 120_000), false);
  assert.equal(A.workHold(10, 20, { ...event, key: 'xp' }, 90 * 120_000, 120_000), true);
  assert.equal(A.workHold(10, 20, { ...event, key: 'wins' }, 90 * 120_000, 120_000), false);
});

test('grindHold waits for a Hackathon weekend only before it starts', () => {
  const hackathon = A.weekendEvent(Date.parse('2026-10-08T10:00:00Z'));
  assert.equal(A.grindHold(hackathon, Date.parse('2026-10-08T10:00:00Z')), true);
  assert.equal(A.grindHold(hackathon, hackathon.startAt), false);
  const wins = A.weekendEvent(Date.parse('2026-10-14T10:00:00Z'));
  assert.equal(A.grindHold(wins, Date.parse('2026-10-14T10:00:00Z')), false);
});

test('grindBudget pools the held weekday budgets into the Hackathon weekend', () => {
  const at = (iso) => Date.parse(iso);
  const sunday = at('2026-10-11T12:00:00Z');
  const event = A.weekendEvent(sunday);
  const grind = { day: A.dayKey(sunday), net: -900, pool: { startAt: event.startAt, held: {}, net: -1500 } };
  // Off the weekend: today's loss against one day's budget.
  assert.deepEqual(A.grindBudget(grind, 1000, A.weekendEvent(at('2026-10-14T12:00:00Z')), at('2026-10-14T12:00:00Z')), { budget: 1000, lost: 0 });
  // Friday was never held, so the weekend has Friday, Saturday and Sunday.
  assert.deepEqual(A.grindBudget(grind, 1000, event, sunday), { budget: 3000, lost: 1500 });
  // Held Thursday and Friday: Friday's budget is in held, not counted again.
  const held = { ...grind, pool: { ...grind.pool, held: { [A.dayKey(at('2026-10-08T12:00:00Z'))]: 1000, [A.dayKey(event.startAt)]: 400 } } };
  assert.deepEqual(A.grindBudget(held, 1000, event, sunday), { budget: 3400, lost: 1500 });
  // A pool from an older Hackathon does not count.
  const stale = { ...held, pool: { ...held.pool, startAt: 1 } };
  assert.deepEqual(A.grindBudget(stale, 1000, event, sunday), { budget: 3000, lost: 0 });
});
