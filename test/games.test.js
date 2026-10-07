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

test('parsePlan and nextPurchase follow the plan order and level gates', () => {
  const plan = G.parsePlan('crash:sla, blaze:star\nbogus:x blaze:lucky');
  assert.deepEqual(plan, [
    { game: 'crash', key: 'sla' },
    { game: 'blaze', key: 'star' },
    { game: 'blaze', key: 'lucky' },
  ]);
  assert.equal(G.nextPurchase(plan, { level: 1, upgrades: {} }).key, 'star');
  assert.equal(G.nextPurchase(plan, { level: 3, upgrades: {} }).key, 'sla');
  assert.equal(G.nextPurchase(plan, { level: 3, upgrades: { crash: { sla: 1 } } }).key, 'star');
  assert.equal(G.nextPurchase([], { level: 50, upgrades: {} }), null);
});
