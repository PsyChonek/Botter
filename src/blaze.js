// Model of the Blaze 20 Wild slot built from the tables in the casino client:
// reel weights, paytable, upgrade effects, win evaluation and RTP simulation.
// The client does not show whether the star scatter counts star symbols or reels
// with a star, so both variants are evaluated and checked against real spins.
// Classic script: globalThis.BotterBlaze in the extension, require() in Node.
(function (root) {
  const SYMBOLS = ['cherry', 'lemon', 'orange', 'plum', 'grapes', 'melon', 'seven', 'star', 'wild'];
  const LINES = [
    [1, 1, 1, 1, 1], [2, 2, 2, 2, 2], [0, 0, 0, 0, 0], [3, 3, 3, 3, 3], [0, 1, 2, 1, 0],
    [3, 2, 1, 2, 3], [1, 2, 3, 2, 1], [2, 1, 0, 1, 2], [0, 0, 1, 0, 0], [3, 3, 2, 3, 3],
    [1, 1, 2, 1, 1], [2, 2, 1, 2, 2], [1, 0, 0, 0, 1], [2, 3, 3, 3, 2], [0, 1, 1, 1, 0],
    [3, 2, 2, 2, 3], [1, 2, 2, 2, 1], [2, 1, 1, 1, 2], [0, 1, 0, 1, 0], [3, 2, 3, 2, 3],
  ];
  const BASE_WEIGHTS = { cherry: 26, lemon: 26, orange: 24, plum: 24, grapes: 13, melon: 13, seven: 5, star: 4, wild: 0 };
  const WILD_WEIGHT = 2.3; // reels 2 to 4 only
  const PAYTABLE = {
    cherry: [5, 20, 80], lemon: [5, 20, 80], orange: [5, 20, 80], plum: [5, 20, 80],
    grapes: [15, 50, 250], melon: [15, 50, 250], seven: [40, 200, 1000],
  };
  // Upgrade effects per level, copied from the client.
  const LUCKY_CUT = [0, 3.4, 5.6, 7.2, 8.5, 9.6];
  const LUCKY_SEVEN = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
  const WILD_BOOST = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
  const SCATTER_PAYS = [2, 3, 4, 5, 6, 7].map((three, i) => ({ 3: three, 4: 10 + 2 * i, 5: 50 + 5 * i }));
  const LINE_COUNT = LINES.length;
  const SCATTER_MODES = ['symbols', 'reels'];

  const level = (upgrades, key) => Math.max(0, Math.min(5, upgrades?.[key] ?? 0));

  function config(upgrades) {
    const lucky = level(upgrades, 'lucky');
    const wild = level(upgrades, 'wild');
    const weights = [0, 1, 2, 3, 4].map((reel) => {
      const w = { ...BASE_WEIGHTS, wild: reel >= 1 && reel <= 3 ? WILD_WEIGHT + WILD_BOOST[wild] : 0 };
      w.cherry -= LUCKY_CUT[lucky];
      w.lemon -= LUCKY_CUT[lucky];
      w.seven += LUCKY_SEVEN[lucky];
      return w;
    });
    return { weights, scatterPay: SCATTER_PAYS[level(upgrades, 'star')] };
  }

  function countStars(grid, mode) {
    let stars = 0;
    for (const reel of grid) {
      const n = reel.filter((symbol) => symbol === 'star').length;
      stars += mode === 'reels' ? Math.min(n, 1) : n;
    }
    return stars;
  }

  function expand(grid) {
    return grid.map((reel) => (reel.includes('wild') ? reel.map(() => 'wild') : reel));
  }

  // Win in credits for one spin. grid is reels x rows before wild expansion.
  function evaluate(grid, bet, cfg, mode, finalGrid = expand(grid)) {
    let win = 0;
    for (const line of LINES) {
      const first = finalGrid[0][line[0]];
      if (!PAYTABLE[first]) continue;
      let count = 1;
      while (count < 5) {
        const symbol = finalGrid[count][line[count]];
        if (symbol !== first && symbol !== 'wild') break;
        count += 1;
      }
      if (count >= 3) win += (PAYTABLE[first][count - 3] * bet) / LINE_COUNT;
    }
    const stars = countStars(grid, mode);
    if (stars >= 3) win += cfg.scatterPay[Math.min(stars, 5)] * bet;
    return win;
  }

  function sampler(weights, rand) {
    const entries = SYMBOLS.map((symbol) => [symbol, weights[symbol]]).filter(([, w]) => w > 0);
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    return () => {
      let r = rand() * total;
      for (const [symbol, w] of entries) {
        r -= w;
        if (r < 0) return symbol;
      }
      return entries[entries.length - 1][0];
    };
  }

  // Return to player as a fraction of the bet, by Monte Carlo.
  function simulateRtp(cfg, mode, spins = 200_000, rand = Math.random) {
    const draws = cfg.weights.map((w) => sampler(w, rand));
    let paid = 0;
    for (let n = 0; n < spins; n++) {
      const grid = draws.map((draw) => [draw(), draw(), draw(), draw()]);
      paid += evaluate(grid, 1, cfg, mode);
    }
    return paid / spins;
  }

  // How often each scatter rule reproduces the server's win on recorded spins.
  // A spin record is { grid, finalGrid, bet, win, upgrades }.
  function checkSpins(records) {
    const result = Object.fromEntries(SCATTER_MODES.map((mode) => [mode, { match: 0, total: 0 }]));
    for (const spin of records) {
      if (!Array.isArray(spin.grid) || typeof spin.win !== 'number') continue;
      const cfg = config(spin.upgrades);
      for (const mode of SCATTER_MODES) {
        const predicted = evaluate(spin.grid, spin.bet, cfg, mode, spin.finalGrid ?? expand(spin.grid));
        result[mode].total += 1;
        if (Math.abs(predicted - spin.win) < 1) result[mode].match += 1;
      }
    }
    return result;
  }

  const api = { SYMBOLS, LINES, SCATTER_MODES, config, evaluate, expand, simulateRtp, checkSpins };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterBlaze = api;
})(globalThis);
