// Generates src/odds-table.js: the long-run return to player of every slot for
// every combination of its shop upgrades, by Monte Carlo over models built from
// the tables in the casino client (weights, paytables, upgrade effects, rules).
// The slots are evaluated on the server, so Skeleton Slots and Slotingi follow
// the client's rules text where it leaves details open (see the notes below).
// Usage: node scripts/odds.mjs [spins per combination]
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Blaze = require('../src/blaze.js');
const SPINS = Number(process.argv[2] ?? 300_000);
const rand = Math.random;

function picker(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  const cum = [];
  let acc = 0;
  for (const w of weights) cum.push((acc += w) / total);
  return () => {
    const r = rand();
    for (let i = 0; i < cum.length; i++) if (r < cum[i]) return i;
    return cum.length - 1;
  };
}

// Every combination of upgrade levels, as [levels, key] with key like "203".
function combos(maxLevels) {
  let out = [[]];
  for (const max of maxLevels) out = out.flatMap((prefix) => Array.from({ length: max + 1 }, (_, l) => [...prefix, l]));
  return out.map((levels) => [levels, levels.join('')]);
}

const round3 = (x) => Math.round(x * 1000) / 1000;

// ---------- Blaze 20 Wild (model in src/blaze.js) ----------
function blazeRtp([lucky, wild, star]) {
  const cfg = Blaze.config({ lucky, wild, star });
  const draws = cfg.weights.map((w) => picker(Blaze.SYMBOLS.map((s) => w[s] ?? 0)));
  const paid = { symbols: 0, reels: 0 };
  for (let n = 0; n < SPINS; n++) {
    const grid = draws.map((draw) => [0, 0, 0, 0].map(() => Blaze.SYMBOLS[draw()]));
    const expanded = Blaze.expand(grid);
    for (const mode of Blaze.SCATTER_MODES) paid[mode] += Blaze.evaluate(grid, 1, cfg, mode, expanded);
  }
  return { symbols: round3(paid.symbols / SPINS), reels: round3(paid.reels / SPINS) };
}

// ---------- Skeleton Slots: 7x7 clusters with cascades ----------
// Open points, chosen as the most common reading of the rules: rockets are
// counted on the board after the last cascade, free spins can retrigger, and
// the multiplier starts at x1 and rises by 1 per cascade.
const SK_FACES = 8;
const SK_WILD = 8;
const SK_ROCKET = 9;
const scale = (a) => a.map((e) => Math.max(1, Math.round(e * 4.4)));
const SK_LOW = scale([4, 5, 6, 8, 10, 12, 16, 20, 30, 40, 60]);
const SK_MID = scale([8, 10, 12, 16, 20, 25, 32, 40, 60, 80, 120]);
const SK = {
  weights: [20, 20, 19, 19, 13, 13, 8, 7, 1.4, 0.8],
  pays: [
    SK_LOW, SK_LOW, SK_LOW, SK_LOW, SK_MID, SK_MID,
    scale([14, 18, 22, 28, 36, 45, 60, 80, 120, 160, 300]),
    scale([20, 25, 30, 40, 50, 65, 85, 110, 160, 220, 400]),
  ],
  freeSpins: [8, 10, 12],
  baseMultCap: 5,
  freeMultCap: 15,
};
const SK_TEAM = [1, 1.03, 1.06, 1.09, 1.12];
const SK_WILD_ADD = [0, 0.13, 0.26, 0.39, 0.52];
const SK_ROCKET_ADD = [0, 0.06, 0.12, 0.18];

function skeletonConfig([team, wild, deploy]) {
  const weights = SK.weights.slice();
  weights[SK_WILD] += SK_WILD_ADD[wild];
  weights[SK_ROCKET] += SK_ROCKET_ADD[deploy];
  const pays = SK.pays.map((p, i) => (i < 6 ? p.map((e) => Math.round(e * SK_TEAM[team])) : p));
  return { ...SK, weights, pays };
}

// Same flood fill as the client: per face, sides only, wilds join every cluster.
const seen = new Uint8Array(49);
const visited = new Uint8Array(49);
const stack = new Int8Array(49);
function skeletonClusters(grid, pays) {
  const out = [];
  for (let sym = 0; sym < SK_FACES; sym++) {
    seen.fill(0);
    for (let start = 0; start < 49; start++) {
      if (grid[start] !== sym || seen[start]) continue;
      visited.fill(0);
      const cells = [];
      let top = 0;
      stack[top++] = start;
      visited[start] = 1;
      while (top) {
        const t = stack[--top];
        cells.push(t);
        if (grid[t] === sym) seen[t] = 1;
        const row = (t / 7) | 0;
        const col = t - row * 7;
        for (const n of [row > 0 ? t - 7 : -1, row < 6 ? t + 7 : -1, col > 0 ? t - 1 : -1, col < 6 ? t + 1 : -1]) {
          if (n < 0 || visited[n] || (grid[n] !== sym && grid[n] !== SK_WILD)) continue;
          visited[n] = 1;
          stack[top++] = n;
        }
      }
      if (cells.length >= 5) {
        const p = pays[sym];
        out.push({ cells, pay: p[Math.min(cells.length, 4 + p.length) - 5] });
      }
    }
  }
  return out;
}

function skeletonSpin(cfg, draw, mult, cap) {
  const grid = new Int8Array(49);
  for (let i = 0; i < 49; i++) grid[i] = draw();
  let win = 0;
  for (;;) {
    const clusters = skeletonClusters(grid, cfg.pays);
    if (!clusters.length) break;
    const gone = new Uint8Array(49);
    for (const c of clusters) {
      win += (c.pay * mult) / 20;
      for (const i of c.cells) gone[i] = 1;
    }
    for (let col = 0; col < 7; col++) {
      const kept = [];
      for (let row = 6; row >= 0; row--) if (!gone[row * 7 + col]) kept.push(grid[row * 7 + col]);
      for (let row = 6, k = 0; row >= 0; row--, k++) grid[row * 7 + col] = k < kept.length ? kept[k] : draw();
    }
    mult = Math.min(cap, mult + 1);
  }
  let rockets = 0;
  for (let i = 0; i < 49; i++) if (grid[i] === SK_ROCKET) rockets++;
  return { win, rockets, mult };
}

function skeletonRtp(levels) {
  const cfg = skeletonConfig(levels);
  const draw = picker(cfg.weights);
  let paid = 0;
  for (let n = 0; n < SPINS; n++) {
    const base = skeletonSpin(cfg, draw, 1, cfg.baseMultCap);
    paid += base.win;
    let free = base.rockets >= 3 ? cfg.freeSpins[Math.min(base.rockets, 5) - 3] : 0;
    let mult = 1;
    while (free-- > 0) {
      const spin = skeletonSpin(cfg, draw, mult, cfg.freeMultCap);
      paid += spin.win;
      mult = spin.mult;
      if (spin.rockets >= 3) free += cfg.freeSpins[Math.min(spin.rockets, 5) - 3];
    }
  }
  return round3(paid / SPINS);
}

// ---------- Slotingi: 5x3, 20 lines, Lingi Cash hold and win ----------
// Open point: during respins every empty cell lands a coin with probability
// respinCoin, independently.
const SL_SYMBOLS = ['phones', 'headset', 'muffs', 'rocker', 'elf', 'luigi', 'gulas', 'mrazik', 'wild', 'coin'];
const SL_WEIGHTS = { phones: 30, headset: 30, muffs: 28, rocker: 16, elf: 14, luigi: 11, gulas: 8, mrazik: 5, coin: 22 };
const SL_LINES = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
  [0, 0, 1, 2, 2], [2, 2, 1, 0, 0], [1, 0, 0, 0, 1], [1, 2, 2, 2, 1], [0, 1, 1, 1, 0],
  [2, 1, 1, 1, 2], [1, 0, 1, 2, 1], [1, 2, 1, 0, 1], [0, 1, 0, 1, 0], [2, 1, 2, 1, 2],
  [1, 1, 0, 1, 1], [1, 1, 2, 1, 1], [0, 2, 0, 2, 0], [2, 0, 2, 0, 2], [0, 2, 2, 2, 0],
];
const SL_PAYTABLE = {
  phones: [7, 25, 80], headset: [7, 25, 80], muffs: [7, 25, 80], rocker: [13, 50, 200],
  elf: [20, 65, 240], luigi: [26, 100, 400], gulas: [40, 150, 650], mrazik: [80, 320, 1300],
};
const SL_COINS = [[1, 34], [2, 26], [3, 15], [5, 12], [8, 6], [10, 4], [25, 2], [100, 1]];
const SL_CROWN = [0, 0.5, 1, 1.5];
const SL_GULAS = [1, 1.05, 1.1, 1.15, 1.2];
const SL_MINT = [0, 0.003, 0.006, 0.009];
const SL_WILD = 8;
const SL_COIN = 9;

function slotingiRtp([crown, gulas, mint]) {
  const draws = [0, 1, 2, 3, 4].map((reel) =>
    picker(SL_SYMBOLS.map((s) => (s === 'wild' ? (reel >= 1 && reel <= 3 ? 6 : 0) : SL_WEIGHTS[s] + (s === 'coin' ? SL_CROWN[crown] : 0)))),
  );
  const pays = SL_SYMBOLS.slice(0, SL_WILD).map((s) => SL_PAYTABLE[s].map((e) => Math.round(e * SL_GULAS[gulas]) / 20));
  const coin = picker(SL_COINS.map(([, w]) => w));
  const respinCoin = 0.045 + SL_MINT[mint];
  let paid = 0;
  for (let n = 0; n < SPINS; n++) {
    const grid = draws.map((draw) => [draw(), draw(), draw()]);
    for (const line of SL_LINES) {
      const first = grid[0][line[0]];
      if (first >= SL_WILD) continue;
      let count = 1;
      while (count < 5 && (grid[count][line[count]] === first || grid[count][line[count]] === SL_WILD)) count++;
      if (count >= 3) paid += pays[first][count - 3];
    }
    let coins = 0;
    for (const reel of grid) for (const s of reel) if (s === SL_COIN) coins++;
    if (coins < 6) continue;
    for (let i = 0; i < coins; i++) paid += SL_COINS[coin()][0];
    let respins = 3;
    while (respins > 0 && coins < 15) {
      let fresh = 0;
      for (let i = coins; i < 15; i++) {
        if (rand() < respinCoin) {
          fresh++;
          paid += SL_COINS[coin()][0];
        }
      }
      coins += fresh;
      respins = fresh ? 3 : respins - 1;
    }
    if (coins === 15) paid += 1000;
  }
  return round3(paid / SPINS);
}

// ---------- write ----------
const table = { blaze: { symbols: {}, reels: {} }, skeleton: {}, slotingi: {} };
const started = Date.now();
for (const [levels, key] of combos([5, 5, 5])) {
  const rtp = blazeRtp(levels);
  table.blaze.symbols[key] = rtp.symbols;
  table.blaze.reels[key] = rtp.reels;
}
console.log(`blaze done in ${Math.round((Date.now() - started) / 1000)} s`);
for (const [levels, key] of combos([4, 4, 3])) table.skeleton[key] = skeletonRtp(levels);
console.log(`skeleton done in ${Math.round((Date.now() - started) / 1000)} s`);
for (const [levels, key] of combos([3, 4, 3])) table.slotingi[key] = slotingiRtp(levels);
console.log(`slotingi done in ${Math.round((Date.now() - started) / 1000)} s`);

writeFileSync(
  new URL('../src/odds-table.js', import.meta.url),
  `// Generated by scripts/odds.mjs (${SPINS.toLocaleString('en')} spins per combination). Do not edit.
// Slot return to player per upgrade combination. Keys are the upgrade levels in
// order: blaze lucky/wild/star (per scatter rule), skeleton team/wild/deploy,
// slotingi crown/gulas/mint.
(function (root) {
  const table = ${JSON.stringify(table)};
  if (typeof module !== 'undefined' && module.exports) module.exports = table;
  else root.BotterOddsTable = table;
})(globalThis);
`,
);
console.log('wrote src/odds-table.js');
