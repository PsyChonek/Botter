// Checks the Forbes z Chánova model (scripts/hotfix-sim.mjs) against rounds
// recorded by the extension (settings, Data tab: export Forbes rounds). Every
// cascade step's wins are recomputed from its grid, and what the client leaves
// open is measured: how often the Hotfix wheel turns, which modifiers it picks
// and how big they are, and how the free-spin multiplier grows. Forced spins are
// left out. Then the model is simulated with the measured wheel chance.
// The extension keeps the last 800 rounds, so exports of several tests can be
// given together; a round in more than one of them counts once.
// Usage: node scripts/hotfix-check.mjs <export.json>... [--spins N]
import { readFileSync } from 'node:fs';
import { BASE, OPTIONS, SCATTER, WILD, config, evaluate, optionFor, simulate } from './hotfix-sim.mjs';

const args = process.argv.slice(2);
const flag = args.indexOf('--spins');
const simSpins = flag >= 0 ? Number(args.splice(flag, 2)[1]) : 200_000;
if (!args.length) throw new Error('usage: node scripts/hotfix-check.mjs <export.json>... [--spins N]');
const unique = new Map();
for (const file of args) {
  for (const round of JSON.parse(readFileSync(file, 'utf8'))) unique.set(`${round.at} ${round.path}`, round);
}
const recorded = [...unique.values()].sort((a, b) => a.at - b.at).filter((r) => r.request?.force === undefined);
const spins = recorded.filter((r) => r.path === '/api/hotfix/spin');
const frees = recorded.filter((r) => r.path === '/api/hotfix/free');
const combos = new Set(recorded.map((r) => JSON.stringify(r.upgrades ?? {})));
if (combos.size > 1) console.log(`warning: ${combos.size} upgrade combinations mixed, checked against the first`);
const own = recorded[0]?.upgrades ?? {};
const cfg = config(own.oncall, own.fix, own.review);

const pct = (x) => `${(x * 100).toFixed(1)} %`;
const count = (list) => list.reduce((out, x) => ({ ...out, [x]: (out[x] ?? 0) + 1 }), {});
const show = (obj) => Object.entries(obj).sort(([a], [b]) => (Number(a) - Number(b)) || a.localeCompare(b)).map(([k, v]) => `${k}: ${v}`).join(', ');
// Standard deviations a count is from n draws at chance p.
const z = (hits, n, p) => (hits - n * p) / Math.sqrt(n * p * (1 - p));

const base = spins.map((r) => r.data.outcome.round);
const free = frees.flatMap((r) => r.data.free.rounds);
const all = [...base.map((round) => ({ round, free: false })), ...free.map((round) => ({ round, free: true }))];

console.log(`${spins.length} spins, ${frees.length} free-spin games (${free.length} free spins), bets ${[...new Set(spins.map((r) => r.request.bet))].join('/')}, upgrades ${[...combos].join(' ')}`);

// Return: base wins plus the free-spin games they started.
const wagered = spins.reduce((sum, r) => sum + r.request.bet, 0);
const paid = spins.reduce((sum, r) => sum + r.data.totalWin, 0) + frees.reduce((sum, r) => sum + (r.data.free.win100 * r.data.bet) / 100, 0);
console.log(`\nreturn ${pct(paid / wagered)} measured over ${wagered} credits wagered`);

// 1. Wins and cascades, recomputed from every step's grid.
let steps = 0;
let wrongWins = 0;
let wrongFalls = 0;
for (const { round } of all) {
  round.steps.forEach((step, i) => {
    steps++;
    const { win, remove } = evaluate(step.reels.map((reel) => reel.slice()), cfg);
    const shown = step.wins.reduce((sum, w) => sum + w.win100, 0);
    if (Math.abs(win * 100 * step.mult - shown) > step.mult / 2) wrongWins++;
    const next = round.steps[i + 1];
    if (!next) return;
    step.reels.forEach((reel, r) => {
      const kept = reel.filter((_, j) => !remove[r][j]);
      if (JSON.stringify(next.reels[r].slice(next.reels[r].length - kept.length)) !== JSON.stringify(kept)) wrongFalls++;
    });
  });
}
console.log(`\n1. wins: ${steps} cascade steps recomputed, ${wrongWins} paid differently, ${wrongFalls} reels fell differently`);

// 2. Clean grids (no modifier): row heights, symbol weights, wild reels.
const clean = all.filter(({ round }) => !round.mod).map(({ round }) => round.steps[0].reels);
const rows = count(clean.flatMap((grid) => grid.map((reel) => reel.length)));
const reels = clean.length * 6;
const rowWeight = BASE.rowWeights.reduce((a, b) => a + b, 0);
console.log(`\n2. rows on ${reels} reels: ${BASE.rowWeights.map((w, i) => `${i + 2}: ${rows[i + 2] ?? 0}/${Math.round((reels * w) / rowWeight)}`).join(', ')} (seen/model)`);
const seen = Array(cfg.weights.length).fill(0);
const expected = Array(cfg.weights.length).fill(0);
const wildsOff = [0, 0];
for (const grid of clean) {
  grid.forEach((reel, r) => {
    const weights = cfg.weights.map((w, s) => (s === WILD && (r < 1 || r > 4) ? 0 : w));
    const total = weights.reduce((a, b) => a + b, 0);
    for (const s of reel) seen[s]++;
    weights.forEach((w, s) => (expected[s] += (reel.length * w) / total));
    if (r < 1 || r > 4) wildsOff[0] += reel.filter((s) => s === WILD).length;
  });
}
const chi = seen.reduce((sum, n, s) => sum + (n - expected[s]) ** 2 / expected[s], 0);
console.log(`   symbols: chi-square ${chi.toFixed(1)} on ${seen.length - 1} degrees of freedom (above ${(seen.length - 1 + 3 * Math.sqrt(2 * (seen.length - 1))).toFixed(0)} the weights differ); wilds on reels 1 and 6: ${wildsOff[0]}`);
console.log(`   scatters per spin ${(seen[SCATTER] / clean.length).toFixed(2)}`);

// 3. The Hotfix wheel: how often it turns and what it picks.
const mods = (list) => list.filter((round) => round.mod).map((round) => round.mod);
const report = (label, list, chance, wheel) => {
  const got = mods(list);
  const total = Object.values(wheel).reduce((a, b) => a + b, 0);
  const keys = count(got.map((m) => m.key));
  console.log(`   ${label}: ${got.length} of ${list.length} spins = ${pct(got.length / list.length)}, model ${pct(chance)} (${z(got.length, list.length, chance).toFixed(1)} deviations)`);
  console.log(`     picks ${Object.keys(wheel).map((k) => `${k}: ${keys[k] ?? 0}/${((got.length * wheel[k]) / total).toFixed(1)}`).join(', ')} (seen/model)`);
};
console.log('\n3. Hotfix wheel');
report('base game', base, cfg.wheelChance, cfg.baseWheel);
if (free.length) report('free spins', free, cfg.freeWheelChance, cfg.freeWheel);

// 4. Modifier sizes, which the client does not give.
const every = mods([...base, ...free]);
const of = (key) => every.filter((m) => m.key === key);
const wildsMods = of('wilds');
console.log('\n4. modifiers');
console.log(`   wilds: cells ${show(count(wildsMods.map((m) => m.cells.length)))}; reels ${show(count(wildsMods.flatMap((m) => m.cells.map(([r]) => r + 1))))}`);
const myst = of('mystery');
console.log(`   mystery: cells ${show(count(myst.map((m) => m.cells.length)))}; symbol ${show(count(myst.map((m) => m.sym)))}`);
const syncRounds = [...base, ...free].filter((round) => round.mod?.key === 'sync');
console.log(`   sync: reels ${show(count(syncRounds.map((round) => round.mod.reels.length)))}; first reel ${show(count(syncRounds.map((round) => round.mod.reels[0] + 1)))}; wilds copied onto reel 6: ${syncRounds.filter((round) => round.steps[0].reels[5].includes(WILD)).length}`);
console.log(`   wildreel: reel ${show(count(of('wildreel').map((m) => m.reels[0] + 1)))}`);
const boosts = free.filter((round) => round.mod?.key === 'boost');
console.log(`   boost: ${boosts.length ? show(count(boosts.map((round) => JSON.stringify(round.mod)))) : 'none seen'}`);

// 5. Free-spin games: start, length and how the multiplier grows.
console.log('\n5. free spins');
let perSpin = 0;
let perStep = 0;
let growths = 0;
for (const game of frees) {
  const f = game.data.free;
  const trigger = spins.findLast((r) => r.at <= game.at && r.data.outcome.trigger);
  const scatters = Number(trigger?.data.outcome.trigger ?? 4);
  const want = optionFor(f.option, scatters);
  console.log(`   ${OPTIONS[f.option].name}: ${f.rounds.length} spins from x${f.startMult} (model ${want.spins} from x${want.mult}), up to x${f.maxMult}`);
  let mult = f.startMult;
  for (const round of f.rounds) {
    const wins = round.steps.filter((step) => step.wins.length).length;
    if (round.mod?.key !== 'boost' && wins) {
      growths++;
      if (round.multAfter === mult + 1) perSpin++;
      if (round.multAfter === mult + wins) perStep++;
    }
    mult = round.multAfter;
  }
}
if (growths) console.log(`   multiplier after ${growths} winning spins: +1 per winning spin fits ${perSpin}, +1 per winning cascade step fits ${perStep}`);
const retriggers = free.filter((round) => round.scatters >= 3).length;
console.log(`   free spins with 3+ incidents (retrigger): ${retriggers}`);

// 6. The model with the measured wheel chance, for Postupný rollout.
// The free-spin wheel moves the return the most and is seen least, so its
// measured chance is used only from MIN_FREE_SPINS free spins on.
const MIN_FREE_SPINS = 100;
const measured = { ...cfg, wheelChance: mods(base).length / base.length };
if (free.length >= MIN_FREE_SPINS) measured.freeWheelChance = mods(free).length / free.length;
else console.log(`
   (free-spin wheel stays at the client's ${pct(cfg.freeWheelChance)} until ${MIN_FREE_SPINS} free spins are recorded, ${free.length} so far)`);
console.log(`\n6. simulated return over ${simSpins} spins, Postupný rollout, multiplier +1 per winning spin`);
for (const [label, c] of [['client wheel chance', cfg], ['measured wheel chance', measured]]) {
  const r = simulate(c, Number(simSpins), 0, false);
  console.log(`   ${label.padEnd(22)} RTP ${pct(r.rtp)} (free spins ${pct(r.free)}), free spins every ${r.triggerEvery.toFixed(0)} spins, sd ${r.sd.toFixed(1)}x bet`);
  if (c === cfg) console.log(`   the measured return is ${((paid / wagered - r.rtp) / (r.sd / Math.sqrt(spins.length))).toFixed(1)} deviations from it over ${spins.length} spins`);
}
