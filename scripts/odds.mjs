// Generates src/odds-table.js: the long-run return to player of every slot for
// every combination of its shop upgrades, by Monte Carlo over models built from
// the tables in the casino client (weights, paytables, upgrade effects, rules).
// The slots are evaluated on the server, so Skeleton Slots and Slotingi follow
// the client's rules text where it leaves details open (see the notes below).
// For every game, roulette, blackjack and baccarat included, it also records how
// often a round ends ahead and how often a session of 1,000 rounds does.
// Usage: node scripts/odds.mjs [spins per combination] [--only game,game]
// --only regenerates the listed games and keeps the rest of the current table.
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { config as hotfixConfig, round as hotfixRound } from './hotfix-sim.mjs';

const require = createRequire(import.meta.url);
const Blaze = require('../src/blaze.js');
const BJ = require('../src/blackjack.js');
const BAC = require('../src/baccarat.js');
const Dice = require('../src/dice.js');
const Cases = require('../src/cases.js');
const Egypt = require('../src/egypt.js');
const args = process.argv.slice(2);
const onlyAt = args.indexOf('--only');
const ONLY = onlyAt >= 0 ? new Set(args.splice(onlyAt, 2)[1].split(',')) : null;
const SPINS = Number(args[0] ?? 300_000);
const SESSIONS = 10_000;
const SESSION_ROUNDS = 1000;
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
const round5 = (x) => Math.round(x * 100_000) / 100_000;

// Payout multiples of the client's big, mega and super win (achievement big_fish).
const BIG_WINS = [10, 25, 50];

// Return to player, share of rounds that return more than the bet, share of
// SESSION_ROUNDS-round sessions that end ahead, the mean net profit per unit
// bet of the rounds that end ahead (what a bonus on wins pays on), the
// variance of one round's return and the share of rounds that pay a big, mega
// and super win (BIG_WINS times the bet or more), from the per-round returns
// (per unit bet) of one combination. Sessions are drawn from those returns with replacement, so
// a payout rarer than one in SPINS rounds is left out.
function summary(returns) {
  let paid = 0;
  let won = 0;
  let gain = 0;
  let squares = 0;
  const big = BIG_WINS.map(() => 0);
  for (const r of returns) {
    paid += r;
    squares += r * r;
    for (let i = 0; i < BIG_WINS.length; i++) if (r >= BIG_WINS[i] - 1e-9) big[i]++;
    if (r > 1 + 1e-9) {
      won++;
      gain += r - 1;
    }
  }
  const n = returns.length;
  const variance = squares / n - (paid / n) ** 2;
  let ahead = 0;
  for (let s = 0; s < SESSIONS; s++) {
    let total = 0;
    for (let n = 0; n < SESSION_ROUNDS; n++) total += returns[(rand() * returns.length) | 0];
    if (total > SESSION_ROUNDS + 1e-6) ahead++;
  }
  return { rtp: round3(paid / n), chances: [round3(won / n), round3(ahead / SESSIONS), round3(gain / n), round3(variance), ...big.map((b) => round5(b / n))] };
}

// ---------- Blaze 20 Wild (model in src/blaze.js) ----------
function blazeSim([lucky, wild, star]) {
  const cfg = Blaze.config({ lucky, wild, star });
  const draws = cfg.weights.map((w) => picker(Blaze.SYMBOLS.map((s) => w[s] ?? 0)));
  const returns = { symbols: new Float64Array(SPINS), reels: new Float64Array(SPINS) };
  for (let n = 0; n < SPINS; n++) {
    const grid = draws.map((draw) => [0, 0, 0, 0].map(() => Blaze.SYMBOLS[draw()]));
    const expanded = Blaze.expand(grid);
    for (const mode of Blaze.SCATTER_MODES) returns[mode][n] = Blaze.evaluate(grid, 1, cfg, mode, expanded);
  }
  return { symbols: summary(returns.symbols), reels: summary(returns.reels) };
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

function skeletonSim(levels) {
  const cfg = skeletonConfig(levels);
  const draw = picker(cfg.weights);
  const returns = new Float64Array(SPINS);
  for (let n = 0; n < SPINS; n++) {
    const base = skeletonSpin(cfg, draw, 1, cfg.baseMultCap);
    let paid = base.win;
    let free = base.rockets >= 3 ? cfg.freeSpins[Math.min(base.rockets, 5) - 3] : 0;
    let mult = 1;
    while (free-- > 0) {
      const spin = skeletonSpin(cfg, draw, mult, cfg.freeMultCap);
      paid += spin.win;
      mult = spin.mult;
      if (spin.rockets >= 3) free += cfg.freeSpins[Math.min(spin.rockets, 5) - 3];
    }
    returns[n] = paid;
  }
  return summary(returns);
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

function slotingiSim([crown, gulas, mint]) {
  const draws = [0, 1, 2, 3, 4].map((reel) =>
    picker(SL_SYMBOLS.map((s) => (s === 'wild' ? (reel >= 1 && reel <= 3 ? 6 : 0) : SL_WEIGHTS[s] + (s === 'coin' ? SL_CROWN[crown] : 0)))),
  );
  const pays = SL_SYMBOLS.slice(0, SL_WILD).map((s) => SL_PAYTABLE[s].map((e) => Math.round(e * SL_GULAS[gulas]) / 20));
  const coin = picker(SL_COINS.map(([, w]) => w));
  const respinCoin = 0.045 + SL_MINT[mint];
  const returns = new Float64Array(SPINS);
  for (let n = 0; n < SPINS; n++) {
    let paid = 0;
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
    if (coins >= 6) paid += slotingiCash(coins, coin, respinCoin);
    returns[n] = paid;
  }
  return summary(returns);
}

// Lingi Cash: every coin pays its value, every respin lands coins on the empty
// cells, three empty respins in a row end it, a full screen pays the grand.
function slotingiCash(coins, coin, respinCoin) {
  let paid = 0;
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
  return paid;
}

// ---------- Roulette: an even-money outside bet ----------
// 18 winning numbers on a wheel of 37 plus the zeros not yet removed.
function rouletteSim([zeros]) {
  const hit = 18 / (39 - zeros);
  const returns = new Float64Array(SPINS);
  for (let n = 0; n < SPINS; n++) returns[n] = rand() < hit ? 2 : 0;
  return summary(returns);
}

// ---------- Blackjack: the bot's play from src/blackjack.js ----------
// Infinite deck, no peek: a dealer blackjack also beats a doubled hand.
const bjCard = () => {
  const r = (rand() * 13) | 0;
  return r < 8 ? r + 2 : r < 12 ? 10 : 11;
};

function bjAdd([total, soft], card) {
  let t = total + card;
  let s = soft + (card === 11 ? 1 : 0);
  while (t > 21 && s > 0) {
    t -= 10;
    s -= 1;
  }
  return [t, s];
}

function blackjackSim([bjpay, ties, soft17, double]) {
  const rules = BJ.rulesFromUpgrades({ bjpay, ties, soft17, double });
  const solver = BJ.solverFor(rules);
  const moves = new Map();
  const best = (total, soft, up, firstTwo) => {
    const key = `${total}|${soft}|${up}|${firstTwo}`;
    if (!moves.has(key)) moves.set(key, solver.best(total, soft, up, firstTwo));
    return moves.get(key);
  };
  const returns = new Float64Array(SPINS);
  for (let n = 0; n < SPINS; n++) {
    let hand = bjAdd(bjAdd([0, 0], bjCard()), bjCard());
    const up = bjCard();
    let dealer = bjAdd(bjAdd([0, 0], up), bjCard());
    const dealerBj = dealer[0] === 21;
    if (hand[0] === 21) {
      returns[n] = dealerBj ? (rules.pushFrom <= 21 ? 1 : 0) : 1 + rules.bjPay;
      continue;
    }
    let stake = 1;
    for (let firstTwo = true; ; firstTwo = false) {
      const move = best(hand[0], hand[1], up, firstTwo);
      if (move === 'stand') break;
      hand = bjAdd(hand, bjCard());
      if (move === 'double') {
        stake = 2;
        break;
      }
      if (hand[0] > 21) break;
    }
    let net;
    if (hand[0] > 21 || dealerBj) net = -stake;
    else {
      while (dealer[0] < 17 || (dealer[0] === 17 && dealer[1] > 0 && rules.dealerHitsSoft17)) dealer = bjAdd(dealer, bjCard());
      const [p, d] = [hand[0], dealer[0]];
      if (d > 21 || p > d) net = stake;
      else if (p < d || p < rules.pushFrom) net = -stake;
      else net = 0;
    }
    returns[n] = 1 + net;
  }
  return summary(returns);
}

// ---------- Baccarat: the better even-money spot from src/baccarat.js ----------
// Infinite deck, the standard tableau, the client's pays.
const bacCard = () => BAC.points(BAC.RANKS[(rand() * 13) | 0]);

function baccaratSim([cut, push]) {
  const upgrades = { cut, push };
  const rules = BAC.rulesFromUpgrades(upgrades);
  const spot = BAC.bestSpot(upgrades);
  const returns = new Float64Array(SPINS);
  for (let n = 0; n < SPINS; n++) {
    let p = (bacCard() + bacCard()) % 10;
    let b = (bacCard() + bacCard()) % 10;
    if (p < 8 && b < 8) {
      let third = null;
      if (p <= 5) {
        third = bacCard();
        p = (p + third) % 10;
      }
      if (BAC.bankerDraws(b, third)) b = (b + bacCard()) % 10;
    }
    returns[n] = BAC.spotReturn(spot, p > b ? 'player' : b > p ? 'banker' : 'tie', false, rules);
  }
  return summary(returns);
}

// ---------- Kostky and Case opening: exact distributions, sampled ----------
// Their returns are exact in src/odds.js; the samples give the chances.
function distributionSim(dist) {
  const draw = picker(dist.map(([, p]) => p));
  const returns = new Float64Array(SPINS);
  for (let n = 0; n < SPINS; n++) returns[n] = dist[draw()][0];
  return summary(returns);
}
const diceSim = ([house, insure]) => distributionSim(Dice.spotDistribution(Dice.BEST_SPOT, { house, insure }));
const casesSim = ([supplier, kitchen]) => distributionSim(Cases.distribution({ supplier, kitchen }));

// ---------- Forbes z Chánova: the model in scripts/hotfix-sim.mjs ----------
// Free spins as Postupný rollout (the bot's pick) with the multiplier +1 per
// winning spin (the 2026-10-13 test). A round's return spreads about ten times
// wider than the other slots', so it (and Kniha mrtvého kódu) gets
// HOTFIX_FACTOR times the spins.
const HOTFIX_FACTOR = 5;
function hotfixSim([oncall, fix, review]) {
  const cfg = hotfixConfig(oncall, fix, review);
  const returns = new Float64Array(SPINS * HOTFIX_FACTOR);
  for (let n = 0; n < returns.length; n++) returns[n] = hotfixRound(cfg, 0, false).win;
  return summary(returns);
}

// ---------- Kniha mrtvého kódu: the tables in src/egypt.js ----------
// Open points: the special symbol is drawn evenly from the nine paying
// symbols, and a line pays its first non-book symbol with the books that
// extend it.
const EG_BOOK = Egypt.SYMBOLS.indexOf('book');
const EG_PAYING = EG_BOOK;
const egMin = (sym) => Egypt.minCount(Egypt.SYMBOLS[sym]);
const egPays = Egypt.SYMBOLS.slice(0, EG_PAYING).map((s) => Egypt.PAYTABLE[s]);

function egyptConfig([archeo, cleanup, deadline], special = -1) {
  const cfg = Egypt.config({ archeo, cleanup, deadline }, special >= 0 ? Egypt.SYMBOLS[special] : null);
  return { draw: picker(Egypt.SYMBOLS.map((s) => cfg.weights[s])), freeSpins: cfg.freeSpins };
}

// One spin's line and scatter pay per unit bet, the books it shows and, with
// a special symbol, how many reels hold it.
function egyptSpin(draw, special = -1) {
  const grid = [0, 1, 2, 3, 4].map(() => [draw(), draw(), draw()]);
  let paid = 0;
  for (const line of Egypt.LINES) {
    let sym = EG_BOOK;
    let count = 0;
    for (; count < 5; count++) {
      const s = grid[count][line[count]];
      if (s === EG_BOOK) continue;
      if (sym === EG_BOOK) sym = s;
      else if (s !== sym) break;
    }
    if (sym !== EG_BOOK && count >= egMin(sym)) paid += egPays[sym][count - 2] / Egypt.LINES.length;
  }
  let books = 0;
  for (const reel of grid) for (const s of reel) if (s === EG_BOOK) books++;
  if (books >= 3) paid += Egypt.SCATTER[Math.min(books, 5) - 3];
  const reels = special >= 0 ? grid.filter((reel) => reel.includes(special)).length : 0;
  return { paid, books, reels };
}

// A free spin's special symbol expands over every reel that holds it once it
// is on enough reels, and pays on all ten lines.
function egyptSim(levels) {
  const base = egyptConfig(levels);
  const free = Array.from({ length: EG_PAYING }, (_, sym) => egyptConfig(levels, sym).draw);
  const returns = new Float64Array(SPINS * HOTFIX_FACTOR);
  for (let n = 0; n < returns.length; n++) {
    const spin = egyptSpin(base.draw);
    let paid = spin.paid;
    if (spin.books >= 3) {
      const special = (rand() * EG_PAYING) | 0;
      for (let left = base.freeSpins; left > 0; left--) {
        const fs = egyptSpin(free[special], special);
        paid += fs.paid;
        if (fs.reels >= egMin(special)) paid += egPays[special][fs.reels - 2];
        if (fs.books >= 3) left += base.freeSpins;
      }
    }
    returns[n] = paid;
  }
  return summary(returns);
}

// ---------- write ----------
const kept = ONLY ? require('../src/odds-table.js') : null;
const table = kept ?? { blaze: { symbols: {}, reels: {} }, skeleton: {}, slotingi: {}, hotfix: {}, egypt: {}, chances: { blaze: { symbols: {}, reels: {} } } };
table.hotfix ??= {};
table.egypt ??= {};
const wanted = (game) => !ONLY || ONLY.has(game);
const started = Date.now();
const done = (game) => console.log(`${game} done in ${Math.round((Date.now() - started) / 1000)} s`);
for (const [levels, key] of wanted('blaze') ? combos([5, 5, 5]) : []) {
  const sim = blazeSim(levels);
  for (const mode of Blaze.SCATTER_MODES) {
    table.blaze[mode][key] = sim[mode].rtp;
    table.chances.blaze[mode][key] = sim[mode].chances;
  }
}
if (wanted('blaze')) done('blaze');
for (const [game, sim, maxLevels] of [
  ['skeleton', skeletonSim, [4, 4, 3]],
  ['slotingi', slotingiSim, [3, 4, 3]],
  ['roulette', rouletteSim, [2]],
  ['blackjack', blackjackSim, [2, 4, 1, 1]],
  ['baccarat', baccaratSim, [3, 1]],
  ['dice', diceSim, [3, 1]],
  ['cases', casesSim, [3, 2]],
  ['hotfix', hotfixSim, [3, 3, 4]],
  ['egypt', egyptSim, [3, 4, 2]],
].filter(([game]) => wanted(game))) {
  table.chances[game] = {};
  for (const [levels, key] of combos(maxLevels)) {
    const { rtp, chances } = sim(levels);
    if (table[game]) table[game][key] = rtp;
    table.chances[game][key] = chances;
    // Roulette, blackjack, baccarat, dice and cases returns are exact in src/odds.js; this checks the simulation.
    if (key === '0'.repeat(maxLevels.length) && !table[game]) console.log(`${game} simulated return ${rtp}`);
  }
  done(game);
}

writeFileSync(
  new URL('../src/odds-table.js', import.meta.url),
  `// Generated by scripts/odds.mjs (${SPINS.toLocaleString('en')} spins per combination). Do not edit.
// Slot return to player per upgrade combination. Keys are the upgrade levels in
// order: blaze lucky/wild/star (per scatter rule), skeleton team/wild/deploy,
// slotingi crown/gulas/mint, hotfix oncall/fix/review and egypt
// archeo/cleanup/deadline (${(SPINS * HOTFIX_FACTOR).toLocaleString('en')} spins each). chances holds [share of rounds that end ahead,
// share of ${SESSION_ROUNDS.toLocaleString('en')}-round sessions that end ahead, mean net profit per unit
// bet of the rounds that end ahead, variance of one round's return, share of
// rounds paying ${BIG_WINS.join(' / ')} times the bet or more] per game and
// combination, also for roulette zeros (an even-money bet), blackjack
// bjpay/ties/soft17/double, baccarat cut/push (the better even-money spot),
// dice house/insure (Malá) and cases supplier/kitchen.
(function (root) {
  const table = ${JSON.stringify(table)};
  if (typeof module !== 'undefined' && module.exports) module.exports = table;
  else root.BotterOddsTable = table;
})(globalThis);
`,
);
console.log('wrote src/odds-table.js');
