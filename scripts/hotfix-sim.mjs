// Monte Carlo model of Forbes z Chánova (hotfix) built from the client bundle
// (index-DgZaIucP.js, retuned 2026-10-17). Facts from the client are marked CLIENT,
// guesses about server behaviour the client does not show are marked GUESS.
// Usage: node scripts/hotfix-sim.mjs [spins] [oncall] [fix] [review], with
// VARIANT=perStep,option (e.g. 0,2) to run a single variant.
import { pathToFileURL } from 'node:url';

// CLIENT: symbols 0-4 low (10 J Q K A), 5-10 high (hi1-hi6), 11 wild, 12 scatter.
const LOW = 5, PAYING = 11, WILD = 11, SCATTER = 12;
const K = 0.97;
const q = (a) => a.map((x) => Math.max(1, Math.round(x * K)));
const BASE = {
  weights: [16, 16, 15, 15, 14, 10, 9, 8, 7, 6, 5, 2.2, 3.4],
  rowWeights: [25, 30, 20, 13, 8, 4], // rows 2..7
  // pays in % of the bet per way, for 3, 4, 5, 6 of a kind
  pays: [q([25, 30, 40, 50]), q([25, 30, 40, 50]), q([30, 40, 50, 65]), q([30, 40, 55, 80]), q([40, 50, 70, 110]), q([45, 60, 90, 160]),
    q([50, 70, 110, 220]), q([55, 80, 140, 280]), q([65, 110, 190, 400]), q([80, 140, 280, 550]), q([110, 220, 550, 1400])],
  wheelChance: 0.05,
  freeWheelChance: 0.25,
  baseWheel: { wildreel: 14, wilds: 30, mystery: 24, sync: 18, maxways: 12, bonus: 2 },
  freeWheel: { wildreel: 10, wilds: 26, mystery: 22, maxways: 14, boost: 18, refactor: 10 },
  multCap: 50,
  wildsCount: [2, 4],
  mysteryCount: [4, 7],
};
// CLIENT: free spin options; +2 spins per scatter above 4, at most 50.
const OPTIONS = [{ name: 'rollout', spins: 10, mult: 1 }, { name: 'canary', spins: 5, mult: 6 }, { name: 'bigbang', spins: 4, mult: 8 }];
const optionFor = (i, scatters) => ({ spins: Math.min(50, OPTIONS[i].spins + 2 * Math.max(0, scatters - 4)), mult: OPTIONS[i].mult });

// CLIENT: upgrades. oncall adds to the scatter weight, fix to the wheel chance, review multiplies pays.
function config(oncall = 0, fix = 0, review = 0) {
  const weights = BASE.weights.slice();
  weights[SCATTER] += [0, 0.07, 0.14, 0.2][oncall];
  const pays = BASE.pays.map((p) => p.map((x) => Math.max(1, Math.round(x * [1, 1.035, 1.07, 1.1, 1.135][review]))));
  return { ...BASE, weights, pays, wheelChance: BASE.wheelChance + [0, 0.004, 0.008, 0.012][fix] };
}

const pick = (weights, r = Math.random()) => {
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r * total;
  for (let i = 0; i < weights.length; i++) if ((x -= weights[i]) < 0) return i;
  return weights.length - 1;
};
const pickKey = (obj) => Object.keys(obj)[pick(Object.values(obj))];
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

// CLIENT: wilds only on reels 2-5 (index 1-4).
function reelWeights(cfg, reel, noLow) {
  return cfg.weights.map((w, s) => (s === WILD && (reel < 1 || reel > 4)) || (noLow && s < LOW) ? 0 : w);
}
// MEASURED: a reel never holds two scatters. Not one of 6,483 recorded grids
// (spins, cascade steps and free spins, 2026-10-13 to 2026-10-20) had two,
// and the scatters per spin fit this rule (0 to 3: 1,079 / 759 / 230 / 42 seen
// in 2,110 spins, 1,075 / 759 / 230 / 39 modelled) where scatters on any cell
// gave 1,075 / 723 / 242 / 55 and 12 spins with 4+ against none seen. So a
// cell drawn on a reel that already shows a scatter is never one.
const noScatter = (w) => w.map((x, s) => (s === SCATTER ? 0 : x));
function drawReel(w, n, kept = []) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(pick(kept.includes(SCATTER) || out.includes(SCATTER) ? noScatter(w) : w));
  return out;
}
function drawGrid(cfg, rows, noLow) {
  return rows.map((n, reel) => drawReel(reelWeights(cfg, reel, noLow), n));
}
const drawRows = (cfg) => Array.from({ length: 6 }, () => 2 + pick(cfg.rowWeights));

// CLIENT: ways from the left, at least 3 reels, pay x ways; wild substitutes all but scatter.
function evaluate(grid, cfg) {
  let win = 0;
  const remove = grid.map((reel) => reel.map(() => false));
  for (let s = 0; s < PAYING; s++) {
    let ways = 1, n = 0;
    for (let r = 0; r < 6; r++) {
      const c = grid[r].filter((x) => x === s || x === WILD).length;
      if (!c) break;
      ways *= c;
      n++;
    }
    if (n < 3 || !grid[0].includes(s)) continue;
    win += (cfg.pays[s][n - 3] * ways) / 100;
    for (let r = 0; r < n; r++) grid[r].forEach((x, i) => { if (x === s || x === WILD) remove[r][i] = true; });
  }
  return { win, remove };
}

// CLIENT: winners vanish, the rest fall, new symbols drop from the top.
function cascade(grid, remove, cfg, noLow) {
  return grid.map((reel, r) => {
    const kept = reel.filter((_, i) => !remove[r][i]);
    const fresh = drawReel(reelWeights(cfg, r, noLow), reel.length - kept.length, kept);
    return [...fresh, ...kept];
  });
}

const countScatters = (grid) => grid.reduce((n, reel) => n + reel.filter((x) => x === SCATTER).length, 0);

// Modifier details. CLIENT: sizes from the config since 2026-10-17 (before it,
// 491 spins on 2026-10-13 measured wilds 3 to 6 and mystery 5 to 9 cells).
// MEASURED: from the 2026-10-13 spins (scripts/hotfix-check.mjs), GUESS: not seen yet.
const G = {
  wildsCount: BASE.wildsCount, // CLIENT: 'wilds' turns 2 to 4 cells wild, MEASURED: on reels 2-6
  wildsReels: [1, 2, 3, 4, 5],
  mysteryCells: BASE.mysteryCount, // CLIENT: 'mystery' resolves 4 to 7 random non-scatter cells to one paying symbol
  // MEASURED: 'sync' copies the leftmost of 2 or 3 adjacent reels onto the others,
  // wilds included, even onto reel 6. GUESS: any reel can be the leftmost (5 seen, all from reel 3 on).
  syncReels: [2, 3],
  boost: [2, 5], // 'boost': multiplier added in free spins
  retrigger: (n) => (n >= 3 ? 2 + 2 * (n - 3) : 0), // free spins added by 3+ scatters in free spins
};

function applyModifier(key, cfg, ctx) {
  let rows = drawRows(cfg);
  let noLow = false;
  if (key === 'maxways') rows = rows.map(() => 7);
  if (key === 'refactor') noLow = true;
  let grid = drawGrid(cfg, rows, noLow);
  const cells = (reels) => reels.flatMap((r) => grid[r].map((_, i) => [r, i]));
  if (key === 'wildreel') grid[randInt(1, 4)].fill(WILD);
  if (key === 'wilds') {
    const pool = cells(G.wildsReels);
    for (let k = randInt(...G.wildsCount); k > 0 && pool.length; k--) {
      const [r, i] = pool.splice(randInt(0, pool.length - 1), 1)[0];
      grid[r][i] = WILD;
    }
  }
  if (key === 'mystery') {
    const sym = randInt(0, PAYING - 1);
    const pool = cells([0, 1, 2, 3, 4, 5]).filter(([r, i]) => grid[r][i] !== SCATTER);
    for (let k = randInt(...G.mysteryCells); k > 0 && pool.length; k--) {
      const [r, i] = pool.splice(randInt(0, pool.length - 1), 1)[0];
      grid[r][i] = sym;
    }
  }
  if (key === 'sync') {
    const len = randInt(...G.syncReels);
    const start = randInt(0, 6 - len);
    for (let r = start + 1; r < start + len; r++) grid[r] = grid[start].slice();
  }
  if (key === 'boost') ctx.mult = Math.min(cfg.multCap, ctx.mult + randInt(...G.boost));
  return { grid, noLow };
}

// One spin with its cascades. ctx.mult is the multiplier (free spins), ctx.perStep
// raises it after every winning cascade step instead of once per winning spin.
function spin(cfg, free, ctx) {
  const chance = free ? cfg.freeWheelChance : cfg.wheelChance;
  const key = Math.random() < chance ? pickKey(free ? cfg.freeWheel : cfg.baseWheel) : null;
  if (key === 'bonus') return { win: 0, scatters: 4, bonus: true };
  let { grid, noLow } = key ? applyModifier(key, cfg, ctx) : { grid: drawGrid(cfg, drawRows(cfg), false), noLow: false };
  let win = 0, won = false;
  for (;;) {
    const { win: w, remove } = evaluate(grid, cfg);
    if (!w) break;
    won = true;
    win += w * (free ? ctx.mult : 1);
    if (free && ctx.perStep) ctx.mult = Math.min(cfg.multCap, ctx.mult + 1);
    grid = cascade(grid, remove, cfg, noLow);
  }
  if (free && won && !ctx.perStep) ctx.mult = Math.min(cfg.multCap, ctx.mult + 1);
  return { win, scatters: countScatters(grid) };
}

function freeGame(cfg, option, scatters, perStep) {
  const o = optionFor(option, scatters);
  const ctx = { mult: o.mult, perStep };
  let left = o.spins, win = 0;
  while (left-- > 0) {
    const r = spin(cfg, true, ctx);
    win += r.win;
    left = Math.min(left + G.retrigger(r.scatters), 50);
  }
  return win;
}

// One paid spin with the free spins it triggers: { win, free } in units of the
// bet, free being the free spins' share (null when none started).
function round(cfg, option, perStep) {
  const r = spin(cfg, false, {});
  const free = r.scatters >= 4 || r.bonus ? freeGame(cfg, option, r.scatters, perStep) : null;
  return { win: r.win + (free ?? 0), free };
}

function simulate(cfg, spins, option, perStep) {
  let paid = 0, freePaid = 0, triggers = 0, sq = 0;
  for (let n = 0; n < spins; n++) {
    const { win, free } = round(cfg, option, perStep);
    if (free !== null) {
      triggers++;
      freePaid += free;
    }
    paid += win;
    sq += win * win;
  }
  const mean = paid / spins;
  return { rtp: mean, free: freePaid / spins, triggerEvery: spins / triggers, sd: Math.sqrt(sq / spins - mean * mean) };
}

export { LOW, PAYING, WILD, SCATTER, BASE, OPTIONS, G as GUESS, optionFor, config, evaluate, round, simulate };

// Run as a script, not when imported (scripts/hotfix-check.mjs uses the model).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [spins = 300_000, oncall = 0, fix = 0, review = 0] = process.argv.slice(2).map(Number);
  const cfg = config(oncall, fix, review);
  const pct = (x) => (x * 100).toFixed(1) + ' %';
  const only = process.env.VARIANT?.split(',').map(Number); // perStep,option
  for (const perStep of [false, true]) {
    for (let option = 0; option < OPTIONS.length; option++) {
      if (only && (only[0] !== Number(perStep) || only[1] !== option)) continue;
      const r = simulate(cfg, spins, option, perStep);
      console.log(`${perStep ? 'mult +1 per win step ' : 'mult +1 per win spin '} ${OPTIONS[option].name.padEnd(8)} RTP ${pct(r.rtp)} (free spins ${pct(r.free)}), free spins every ${r.triggerEvery.toFixed(0)} spins, sd ${r.sd.toFixed(1)}x bet`);
    }
  }
}
