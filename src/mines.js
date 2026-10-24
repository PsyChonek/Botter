// Hledání bugů (from level 9): minesweeper on 25 cells. A round starts with a
// bet and a bug count (1, 3, 5, 10, 15, 20 or 24), each clean cell revealed
// raises the multiplier and a bug takes the bet. After n clean cells the
// multiplier is the return to player over the chance of surviving them,
// floored to 0.01 and capped at 1,000x, and the payout is the bet times that,
// floored to whole credits. So every bug count and number of reveals returns
// the same share of the bet, less the flooring, and the bot picks the round
// shape for what it is after: the grinder the best return with few reveals, a
// quest or achievement the shape that reaches its multiplier cheapest.
// Return to player is 82 % plus 2 points per Unit testy level and 5/3 points
// per Gumová kachnička level (95 % maxed), all copied from the client.
// Classic script: globalThis.BotterMines in the extension, require() in Node.
(function (root) {
  const CELLS = 25;
  const BUG_COUNTS = [1, 3, 5, 10, 15, 20, 24];
  const MAX_MULT = 1000;
  const BASE_RTP = 0.82;
  const TESTS_RTP = 0.02;
  const DUCK_RTP = 0.05 / 3;
  // mines_clear needs every clean cell revealed with at least this many bugs.
  const CLEAR_MIN_BUGS = 3;
  // The grinder's shape returns at most this much less than the best one, so
  // it does not reveal 15 cells for the last tenth of a point.
  const EV_SLACK = 0.002;

  const level = (upgrades, key, max) => Math.max(0, Math.min(max, upgrades?.[key] ?? 0));
  const rtp = (upgrades) => BASE_RTP + TESTS_RTP * level(upgrades, 'tests', 4) + DUCK_RTP * level(upgrades, 'duck', 3);

  const choose = (n, k) => {
    if (k < 0 || k > n) return 0;
    let out = 1;
    for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i;
    return out;
  };

  // Chance that the first reveals cells are all clean with bugs on the board.
  const survive = (bugs, reveals) => choose(CELLS - bugs, reveals) / choose(CELLS, reveals);

  // Multiplier after reveals clean cells, the client's formula.
  function multiplier(r, bugs, reveals) {
    if (reveals <= 0) return 0;
    return Math.min(MAX_MULT, Math.floor((r / survive(bugs, reveals)) * 100 + 1e-9) / 100);
  }

  // One round shape at return r and bet (Infinity leaves out the whole-credit
  // flooring): { bugs, reveals, chance, mult, ev, variance }, ev and variance
  // per credit staked.
  function shape(r, bugs, reveals, bet = Infinity) {
    const chance = survive(bugs, reveals);
    const mult = multiplier(r, bugs, reveals);
    const pay = Number.isFinite(bet) ? Math.floor(bet * mult) / bet : mult;
    const ev = chance * pay;
    return { bugs, reveals, chance, mult, pay, ev, variance: chance * pay * pay - ev * ev };
  }

  function allShapes(r, bet) {
    const out = [];
    for (const bugs of BUG_COUNTS) for (let n = 1; n <= CELLS - bugs; n++) out.push(shape(r, bugs, n, bet));
    return out;
  }

  // The grinder's shape: within EV_SLACK of the best return, the fewest
  // reveals (each is a request), then the smallest swing.
  function grindShape(r, bet = Infinity) {
    const all = allShapes(r, bet);
    const best = Math.max(...all.map((s) => s.ev));
    return all
      .filter((s) => s.ev >= best - EV_SLACK)
      .reduce((a, b) => (b.reveals < a.reveals || (b.reveals === a.reveals && b.variance < a.variance) ? b : a));
  }

  // The shape paying at least x times the bet that loses least per hit:
  // expected loss per round over its chance. At a small bet the flooring can
  // make a likelier shape with a slightly worse return the cheaper one.
  // Null when no shape pays that much.
  function targetShape(r, x, bet = Infinity) {
    const cost = (s) => (1 - s.ev) / s.chance;
    const fits = allShapes(r, bet).filter((s) => s.pay >= x && s.chance > 0);
    return fits.length ? fits.reduce((a, b) => (cost(b) < cost(a) || (cost(b) === cost(a) && b.reveals < a.reveals) ? b : a)) : null;
  }

  // Shapes the bot plays, by spot: null for the grinder, 'win' (more back than
  // the bet, for quests counting rounds that end ahead), 'x10' / 'x25' / 'x50'
  // (big, mega and super wins) and 'x100' (the mines_100x achievement), and
  // 'clear' (24 bugs and the one clean cell: every clean cell revealed for
  // mines_clear, 1 in 25).
  function plan(upgrades, bet = Infinity, spot = null) {
    const r = rtp(upgrades);
    if (spot === 'clear') return shape(r, 24, 1, bet);
    if (spot === 'win') return targetShape(r, 1.01, bet);
    const x = /^x(\d+)$/.exec(spot ?? '')?.[1];
    if (x) return targetShape(r, Number(x), bet);
    return grindShape(r, bet);
  }

  // What the odds module needs: return of the grinder's shape, its share of
  // rounds ending ahead, mean gain of those, variance, and the best chance of
  // a 10x, 25x and 50x win any shape offers (quests play that shape).
  function chances(upgrades) {
    const grind = plan(upgrades);
    const win = plan(upgrades, Infinity, 'win');
    const bigs = ['x10', 'x25', 'x50'].map((spot) => plan(upgrades, Infinity, spot)?.chance ?? 0);
    const ahead = grind.pay > 1 ? grind.chance : 0;
    return {
      rtp: grind.ev,
      win: win?.chance ?? 0,
      ahead,
      gain: ahead > 0 ? grind.pay - 1 : 0,
      variance: grind.variance,
      bigs,
    };
  }

  // Cells to reveal this round: count distinct cells at random, skipping the
  // ones already open.
  function pickCells(count, open = [], random = Math.random) {
    const free = Array.from({ length: CELLS }, (_, i) => i).filter((cell) => !open.includes(cell));
    const out = [];
    while (out.length < count && free.length) out.push(free.splice(Math.floor(random() * free.length), 1)[0]);
    return out;
  }

  const api = { CELLS, BUG_COUNTS, MAX_MULT, CLEAR_MIN_BUGS, rtp, survive, multiplier, shape, grindShape, targetShape, plan, chances, pickCells };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterMines = api;
})(globalThis);
