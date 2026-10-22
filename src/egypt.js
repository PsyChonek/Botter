// Kniha mrtvého kódu (from level 30): 5 reels of 3, 10 lines left to right.
// The book is wild and pays anywhere (3, 4 and 5 books pay 2x, 20x and 200x
// the bet); 3 or more start free spins with a special symbol that lands more
// often and expands over every reel holding it once it is on enough of them
// (high symbols 2 reels, low 3), paying on all 10 lines. Archeolog adds 0.04
// per level to the book's weight, Úklid legacy takes 0.4 per level from the
// scarab and the cobra, Posunutá deadline adds a free spin per level. Every
// cell is drawn on its own, so the client's "free spins 1 in ~300 rounds, ~250
// with every upgrade" is the chance of 3 or more books among the 15 cells.
// Classic script: globalThis.BotterEgypt in the extension, require() in Node.
(function (root) {
  const SYMBOLS = ['scarab', 'cobra', 'urn', 'cat', 'eye', 'anubis', 'horus', 'mummy', 'pharaoh', 'book'];
  const WEIGHTS = { scarab: 24, cobra: 24, urn: 23, cat: 19, eye: 19, anubis: 6, horus: 6, mummy: 4, pharaoh: 3, book: 2.7 };
  const HIGH = ['anubis', 'horus', 'mummy', 'pharaoh'];
  const LINES = [
    [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2], [0, 1, 2, 1, 0], [2, 1, 0, 1, 2],
    [1, 2, 2, 2, 1], [1, 0, 0, 0, 1], [2, 2, 1, 0, 0], [0, 0, 1, 2, 2], [2, 1, 1, 1, 0],
  ];
  // Pays for 2 to 5 of a kind as a multiple of the bet spread over the 10 lines.
  const PAYTABLE = {
    scarab: [0, 6, 20, 80], cobra: [0, 6, 20, 80], urn: [0, 6, 20, 80], cat: [0, 6, 30, 120], eye: [0, 6, 30, 120],
    anubis: [5, 20, 60, 200], horus: [5, 20, 60, 200], mummy: [5, 25, 100, 400], pharaoh: [10, 50, 200, 1000],
  };
  const SCATTER = [2, 20, 200];
  const FREE_SPINS = 10;
  // Weight added to the special symbol during free spins.
  const FREE_BOOST = 9;
  const ARCHEO_BOOK = 0.04;
  const CLEANUP_LOW = 0.4;
  const CELLS = 15;

  const level = (upgrades, key, max) => Math.max(0, Math.min(max, upgrades?.[key] ?? 0));
  const minCount = (symbol) => (HIGH.includes(symbol) ? 2 : 3);

  // Symbol weights and free spins per trigger at these upgrades; special is
  // the free spins' special symbol, or null for a base spin.
  function config(upgrades, special = null) {
    const weights = { ...WEIGHTS };
    weights.book += level(upgrades, 'archeo', 3) * ARCHEO_BOOK;
    weights.scarab -= level(upgrades, 'cleanup', 4) * CLEANUP_LOW;
    weights.cobra -= level(upgrades, 'cleanup', 4) * CLEANUP_LOW;
    if (special) weights[special] += FREE_BOOST;
    return { weights, freeSpins: FREE_SPINS + level(upgrades, 'deadline', 2) };
  }

  const choose = (n, k) => {
    let out = 1;
    for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i;
    return out;
  };

  // Chance of a base spin showing at least books books.
  function bookChance(books, upgrades) {
    const { weights } = config(upgrades);
    const p = weights.book / Object.values(weights).reduce((a, b) => a + b, 0);
    let out = 0;
    for (let k = books; k <= CELLS; k++) out += choose(CELLS, k) * p ** k * (1 - p) ** (CELLS - k);
    return out;
  }
  const freeChance = (upgrades) => bookChance(3, upgrades);

  const api = { SYMBOLS, WEIGHTS, HIGH, LINES, PAYTABLE, SCATTER, FREE_SPINS, FREE_BOOST, minCount, config, bookChance, freeChance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterEgypt = api;
})(globalThis);
