const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../src/games.js');

test('betFor snaps to an allowed level within maxBet', () => {
  assert.equal(G.betFor(100, 1000), 100);
  assert.equal(G.betFor(150, 1000), 100);
  assert.equal(G.betFor(1000, 200), 200);
  assert.equal(G.betFor(5, 200), 20);
  assert.equal(G.betFor(100, 10), 20);
});

test('energyNow refills one point every two minutes up to the cap', () => {
  const now = 1_000_000;
  assert.equal(G.energyNow({ energy: 20, nextEnergyAt: null }, now), 20);
  assert.equal(G.energyNow({ energy: 3, nextEnergyAt: now + 60_000 }, now), 3);
  assert.equal(G.energyNow({ energy: 3, nextEnergyAt: now - 1 }, now), 4);
  assert.equal(G.energyNow({ energy: 3, nextEnergyAt: now - 120_001 }, now), 5);
  assert.equal(G.energyNow({ energy: 19, nextEnergyAt: now - 600_000, maxEnergy: 20 }, now), 20);
  assert.equal(G.energyNow(null, now), 0);
});

test('gameDelta books spins, roulette and garnished winnings', () => {
  const spin = G.gameDelta('/api/slot/spin', { bet: 40 }, { player: { credits: 1060 }, xpGain: 2 }, 1000);
  assert.deepEqual(spin, { game: 'blaze', rounds: 1, wagered: 40, net: 60, xp: 2, stake: 0 });

  const roulette = G.gameDelta('/api/roulette/spin', { bets: { red: 50, odd: 50 } }, { player: { credits: 900 } }, 1000);
  assert.equal(roulette.wagered, 100);
  assert.equal(roulette.net, -100);

  const garnished = G.gameDelta('/api/skeleton/spin', { bet: 20 }, { player: { credits: 1010 }, garnished: 30 }, 1000);
  assert.equal(garnished.net, 40);

  // A level-up reward lands in the same balance but is not a game win.
  const levelUp = G.gameDelta('/api/slot/spin', { bet: 20 }, { player: { credits: 1480 }, levelUp: { to: 5, reward: 500 } }, 1000);
  assert.equal(levelUp.net, -20);

  assert.equal(G.gameDelta('/api/work/submit', {}, { player: { credits: 1 } }, 0), null);
  assert.equal(G.gameDelta('/api/slot/spin', { bet: 20 }, { player: { credits: 1 } }, undefined), null);
});

test('gameDelta books a doubled blackjack hand as one round', () => {
  const deal = G.gameDelta('/api/blackjack/deal', { bet: 100 }, { player: { credits: 900 }, hand: { stake: 100 } }, 1000);
  const double = G.gameDelta('/api/blackjack/action', { action: 'double' }, { player: { credits: 1200 }, hand: { stake: 200 } }, 900, deal.stake);
  const games = G.addDelta(G.addDelta({}, deal), double);
  assert.deepEqual(games.blackjack, { rounds: 1, wagered: 200, net: 200, xp: 0 });
});

test('profitRows computes return rate and net per round', () => {
  const [row] = G.profitRows({ blaze: { rounds: 10, wagered: 200, net: -40, xp: 5 }, roulette: { rounds: 0, wagered: 0, net: 0, xp: 0 } });
  assert.equal(row.game, 'blaze');
  assert.equal(row.returned, 160);
  assert.equal(row.rtp, 0.8);
  assert.equal(row.perRound, -4);
  assert.equal(G.totalNet({ a: { net: 5 }, b: { net: -8 } }), -3);
});

test('upgradeOffer prices the next level like the shop does', () => {
  assert.deepEqual(G.upgradeOffer({}, 'crash', 'sla'), { game: 'crash', key: 'sla', next: 1, price: 4000, minLevel: 3 });
  assert.equal(G.upgradeOffer({ crash: { sla: 1 } }, 'crash', 'sla').price, 8800);
  assert.equal(G.upgradeOffer({ crash: { sla: 2 } }, 'crash', 'sla').minLevel, 9);
  assert.equal(G.upgradeOffer({ crash: { sla: 3 } }, 'crash', 'sla'), null);
  assert.equal(G.upgradeOffer({}, 'crash', 'nope'), null);
});

const goal = (queue) => queue.find((offer) => !offer.reason) ?? null;

test('the upgrade plan never buys a bigger max bet', () => {
  assert.equal(G.UPGRADE_PLAN.some((o) => o.game === 'global'), false);
});

test('the upgrade plan never buys crash upgrades', () => {
  assert.equal(G.UPGRADE_PLAN.some((o) => o.game === 'crash'), false);
});

test('shopQueue follows the plan order and level gates', () => {
  const plan = [
    { game: 'crash', key: 'sla' },
    { game: 'blaze', key: 'star' },
    { game: 'blaze', key: 'lucky' },
  ];
  const low = G.shopQueue(plan, { level: 1, upgrades: {} });
  assert.deepEqual(low.map((o) => o.reason), ['level', null, null]);
  assert.equal(goal(low).key, 'star');
  assert.equal(goal(G.shopQueue(plan, { level: 3, upgrades: {} })).key, 'sla');
  // sla level 2 needs player level 6
  const next = G.shopQueue(plan, { level: 3, upgrades: { crash: { sla: 1 } } });
  assert.deepEqual(next[0], { game: 'crash', key: 'sla', next: 2, price: 8800, minLevel: 6, reason: 'level' });
  assert.equal(goal(next).key, 'star');
  assert.deepEqual(G.shopQueue(plan, { level: 50, upgrades: { crash: { sla: 3 } } }).map((o) => o.key), ['star', 'lucky']);
  assert.deepEqual(G.shopQueue([], { level: 50, upgrades: {} }), []);
});

test('shopQueue keeps the reason the skip check gives', () => {
  const plan = [
    { game: 'blackjack', key: 'hint' },
    { game: 'blackjack', key: 'ties' },
  ];
  const player = { level: 20, upgrades: {} };
  assert.equal(goal(G.shopQueue(plan, player)).key, 'hint');
  const queue = G.shopQueue(plan, player, (o) => (o.key === 'hint' ? 'tooSmall' : null));
  assert.deepEqual(queue.map((o) => o.reason), ['tooSmall', null]);
  assert.equal(goal(queue).key, 'ties');
  assert.equal(goal(G.shopQueue(plan, player, () => 'tooSmall')), null);
});

test('upgradeRest prices every remaining level', () => {
  const rest = G.upgradeRest({ skeleton: { team: 2 } }, 'skeleton', ['team', 'deploy']);
  // team 3 and 4, deploy 1 to 3
  assert.equal(rest.price, 13000 + 23300 + 6000 + 12000 + 24000);
  assert.deepEqual(rest.upgrades.skeleton, { team: 4, deploy: 3 });
  assert.deepEqual(G.upgradeRest({}, 'skeleton', []).price, 0);
});

test('gameDelta leaves out standup and achievement rewards paid with the round', () => {
  const data = {
    player: { credits: 1500 },
    quests: [{ key: 'a', reward: 480 }, { key: 'all', all: true, reward: 100 }],
    achievements: [{ key: 'standup', reward: 500 }],
  };
  assert.deepEqual(G.rewardsPaid(data), { levelUp: 0, standup: 580, achievement: 500, payroll: 0, event: 0 });
  assert.equal(G.rewardTotal(data), 1080);
  // 1500 - 1000 - 1080: the spin itself lost 580.
  assert.equal(G.gameDelta('/api/slot/spin', { bet: 20 }, data, 1000).net, -580);
  assert.equal(G.rewardTotal({ player: { credits: 1 } }), 0);
});

test('UPGRADE_PLAN only names upgrades in the shop, each once', () => {
  const names = G.UPGRADE_PLAN.map(({ game, key }) => `${game}:${key}`);
  assert.ok(G.UPGRADE_PLAN.every(({ game, key }) => G.SHOP[game]?.[key]));
  assert.equal(new Set(names).size, names.length);
});

test('a payroll fund drop is booked as a reward, net of the garnish', () => {
  const data = { player: { credits: 12_980 }, payrollWin: { amount: 12_000, garnished: 0 } };
  assert.equal(G.rewardsPaid(data).payroll, 12_000);
  assert.equal(G.gameDelta('/api/slot/spin', { bet: 20 }, data, 1000).net, -20);
  assert.equal(G.rewardsPaid({ payrollWin: { amount: 12_000, garnished: 6000 } }).payroll, 6000);
});

test('the Konec kvartálu bonus is kept out of the game return', () => {
  // A 100 bet won 200 back plus a 50 bonus.
  const data = { player: { credits: 1150 }, eventBonus: 50 };
  assert.equal(G.rewardsPaid(data).event, 50);
  assert.equal(G.gameDelta('/api/roulette/spin', { bets: { red: 100 } }, data, 1000).net, 100);
});

test('lottery tickets are booked as lottery rounds at their price', () => {
  const delta = G.gameDelta('/api/lottery/buy', { numbers: [1, 2, 3, 4, 5, 6], price: 20 }, { player: { credits: 980 } }, 1000);
  assert.deepEqual([delta.game, delta.rounds, delta.wagered, delta.net], ['lottery', 1, 20, -20]);
});

test('crash stakes go up to 10x the slot max bet', () => {
  assert.equal(G.betFor(5000, G.CRASH_MAX_BET(1000), G.CRASH_LEVELS), 4000);
  assert.equal(G.betFor(50_000, G.CRASH_MAX_BET(1000), G.CRASH_LEVELS), 10_000);
  assert.equal(G.betFor(5000, G.CRASH_MAX_BET(100), G.CRASH_LEVELS), 1000);
  assert.equal(G.betFor(5000, 1000), 1000);
});

test('recordLevel keeps XP per level and the level-up reward, same map when nothing is new', () => {
  const levels = G.recordLevel({}, { level: 3, xpNeed: 450 });
  assert.deepEqual(levels, { 3: { xpNeed: 450 } });
  assert.equal(G.recordLevel(levels, { level: 3, xpNeed: 450 }), levels);
  const up = G.recordLevel(levels, { level: 4, xpNeed: 600 }, { to: 4, reward: 800 });
  assert.deepEqual(up, { 3: { xpNeed: 450 }, 4: { xpNeed: 600, reward: 800 } });
  assert.equal(G.recordLevel(up, { level: 4 }), up);
  assert.equal(G.recordLevel(up, null, null), up);
});

test('dailyBonus follows the client formula', () => {
  // Client: round((500 + 250 * (min(day, 7) - 1)) * (1 + (level - 1) * 0.1 + max(0, level - 4) * 0.05) / 10) * 10
  assert.equal(G.dailyBonus(1, 1), 500);
  assert.equal(G.dailyBonus(7, 1), 2000);
  assert.equal(G.dailyBonus(9, 5), 2900);
  assert.equal(G.dailyBonus(7, 15), 5900);
  assert.equal(G.dailyBonus(3, 10), 1000 * 2.2);
});
