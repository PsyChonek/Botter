// Pure casino helpers: bet sizing, blackjack decisions, energy and profit
// bookkeeping. Classic script like core.js (globalThis.BotterGames in the
// extension, require() in Node).
(function (root) {
  const BET_LEVELS = [20, 40, 100, 200, 400, 1000];
  const ENERGY_MS = 120_000;

  // Unlock levels and spin endpoints mirror the casino's own game list.
  const GAMES = {
    blaze: { unlock: 1, path: '/api/slot/spin' },
    skeleton: { unlock: 5, path: '/api/skeleton/spin' },
    slotingi: { unlock: 7, path: '/api/slotingi/spin' },
    blackjack: { unlock: 10 },
    roulette: { unlock: 15 },
  };
  const GAME_KEYS = Object.keys(GAMES);
  const ROULETTE_BETS = ['red', 'black', 'even', 'odd', 'low', 'high'];

  // Crash is left out on purpose: its auto cash-out is paid by the server
  // later without a response, so a bet would look like a pure loss.
  const PATH_GAME = {
    '/api/slot/spin': 'blaze',
    '/api/skeleton/spin': 'skeleton',
    '/api/slotingi/spin': 'slotingi',
    '/api/roulette/spin': 'roulette',
    '/api/blackjack/deal': 'blackjack',
    '/api/blackjack/action': 'blackjack',
  };

  // Highest allowed bet level that does not exceed what the user asked for.
  function betFor(wanted, maxBet) {
    const allowed = BET_LEVELS.filter((b) => b <= maxBet);
    if (!allowed.length) return BET_LEVELS[0];
    return [...allowed].reverse().find((b) => b <= wanted) ?? allowed[0];
  }

  // Same refill rule as the app: +1 energy every 2 minutes up to the cap.
  function energyNow(work, now) {
    if (!work) return 0;
    const { energy, nextEnergyAt, maxEnergy = 20 } = work;
    if (nextEnergyAt == null) return energy;
    const gained = Math.floor((now - (nextEnergyAt - ENERGY_MS)) / ENERGY_MS);
    return Math.min(maxEnergy, energy + Math.max(0, gained));
  }

  // Profit of one game API response. Net is the credit change plus whatever the
  // debt collector took from the win, because that still paid down the loan.
  function gameDelta(path, request, data, creditsBefore, prevStake = 0) {
    const game = PATH_GAME[path];
    if (!game || !data?.player || typeof creditsBefore !== 'number') return null;
    let rounds = 1;
    let wagered;
    if (path === '/api/roulette/spin') {
      wagered = Object.values(request?.bets ?? {}).reduce((sum, amount) => sum + amount, 0);
    } else if (path === '/api/blackjack/deal') {
      wagered = data.hand?.stake ?? request?.bet ?? 0;
    } else if (path === '/api/blackjack/action') {
      // Only a double adds to the stake; hit and stand cost nothing.
      rounds = 0;
      wagered = Math.max(0, (data.hand?.stake ?? prevStake) - prevStake);
    } else {
      wagered = request?.bet ?? 0;
    }
    return {
      game,
      rounds,
      wagered,
      net: data.player.credits - creditsBefore + (data.garnished ?? 0),
      xp: data.xpGain ?? 0,
      stake: data.hand?.stake ?? prevStake,
    };
  }

  function addDelta(games, delta) {
    const row = (games[delta.game] ??= { rounds: 0, wagered: 0, net: 0, xp: 0 });
    row.rounds += delta.rounds;
    row.wagered += delta.wagered;
    row.net += delta.net;
    row.xp += delta.xp;
    return games;
  }

  function totalNet(games) {
    return Object.values(games).reduce((sum, row) => sum + row.net, 0);
  }

  // Rows for the profit tables, most played first. rtp is the share of the
  // wagered credits that came back (1 = break even).
  function profitRows(games) {
    return Object.entries(games)
      .filter(([, row]) => row.rounds > 0 || row.wagered > 0)
      .map(([game, row]) => ({
        game,
        ...row,
        returned: row.wagered + row.net,
        rtp: row.wagered > 0 ? (row.wagered + row.net) / row.wagered : null,
        perRound: row.rounds > 0 ? row.net / row.rounds : null,
      }))
      .sort((a, b) => b.rounds - a.rounds);
  }

  const api = {
    BET_LEVELS,
    GAMES,
    GAME_KEYS,
    ROULETTE_BETS,
    PATH_GAME,
    betFor,
    energyNow,
    gameDelta,
    addDelta,
    totalNet,
    profitRows,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterGames = api;
})(globalThis);
