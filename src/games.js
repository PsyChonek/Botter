// Pure casino helpers: bet sizing, blackjack decisions, energy and profit
// bookkeeping. Classic script like core.js (globalThis.BotterGames in the
// extension, require() in Node).
(function (root) {
  const BET_LEVELS = [20, 40, 100, 200, 400, 1000];
  // Produkce padá takes stakes up to 10x the slot max bet (10,000 from level 15).
  const CRASH_LEVELS = [...BET_LEVELS, 2000, 4000, 10_000];
  const CRASH_MAX_BET = (maxBet) => maxBet * 10;
  const ENERGY_MS = 120_000;

  // Unlock levels and spin endpoints mirror the casino's own game list.
  const GAMES = {
    blaze: { unlock: 1, path: '/api/slot/spin' },
    skeleton: { unlock: 5, path: '/api/skeleton/spin' },
    slotingi: { unlock: 7, path: '/api/slotingi/spin' },
    blackjack: { unlock: 10 },
    hotfix: { unlock: 13, path: '/api/hotfix/spin' },
    roulette: { unlock: 15 },
  };
  const LOTTERY_UNLOCK = 4;
  const GAME_KEYS = Object.keys(GAMES);
  const ROULETTE_BETS = ['red', 'black', 'even', 'odd', 'low', 'high'];

  // Crash is not here: its auto cash-out is paid without a response, so its
  // bets are booked from the round's bet list instead (see the content script).
  const PATH_GAME = {
    '/api/slot/spin': 'blaze',
    '/api/skeleton/spin': 'skeleton',
    '/api/slotingi/spin': 'slotingi',
    '/api/hotfix/spin': 'hotfix',
    '/api/hotfix/free': 'hotfix',
    '/api/roulette/spin': 'roulette',
    '/api/blackjack/deal': 'blackjack',
    '/api/blackjack/action': 'blackjack',
    '/api/lottery/buy': 'lottery',
  };

  // Shop catalog copied from the client: [max level, base price, price growth].
  const SHOP = {
    global: { bets: [3, 5000, 2.5] },
    blaze: { lucky: [5, 3000, 1.8], wild: [5, 4000, 1.8], star: [5, 2000, 1.8] },
    crash: { sla: [3, 4000, 2.2] },
    skeleton: { team: [4, 4000, 1.8], wild: [4, 5000, 1.8], deploy: [3, 6000, 2] },
    slotingi: { crown: [3, 6000, 2], gulas: [4, 5000, 1.8], mint: [3, 8000, 2.2] },
    blackjack: { ties: [4, 8000, 1.8], bjpay: [2, 10000, 2], soft17: [1, 6000, 1], double: [1, 4000, 1], hint: [1, 3000, 1] },
    hotfix: { oncall: [3, 9000, 2], fix: [3, 8000, 2], review: [4, 7000, 1.8] },
    roulette: { zeros: [2, 15000, 2.5] },
  };
  const SHOP_UNLOCK = { global: 1, blaze: 1, crash: 3, skeleton: 5, slotingi: 7, blackjack: 10, hotfix: 13, roulette: 15 };

  // Next level of an upgrade: its price and the player level it needs.
  function upgradeOffer(upgrades, game, key) {
    const item = SHOP[game]?.[key];
    if (!item) return null;
    const [max, base, growth] = item;
    const have = upgrades?.[game]?.[key] ?? 0;
    if (have >= max) return null;
    const next = have + 1;
    return {
      game,
      key,
      next,
      price: Math.round((base * growth ** (next - 1)) / 100) * 100,
      minLevel: SHOP_UNLOCK[game] + (next - 1) * 3,
    };
  }

  // Shop upgrades in priority order: the next level of the first one that is
  // worth its price is bought, later ones wait. global:bets is left out: XP per
  // round is proportional to the bet, so a bigger max bet never buys XP cheaper.
  // crash:sla is left out too: Produkce padá's daily payout cap is too small for
  // it to pay back.
  const UPGRADE_PLAN = [
    'blaze:star', 'skeleton:team', 'blaze:lucky', 'blaze:wild', 'skeleton:wild', 'slotingi:gulas', 'skeleton:deploy',
    'slotingi:crown', 'roulette:zeros', 'blackjack:ties', 'blackjack:bjpay',
    'hotfix:review', 'hotfix:oncall', 'hotfix:fix',
  ].map((entry) => {
    const [game, key] = entry.split(':');
    return { game, key };
  });

  // Price of buying the given upgrades of one game up to level upTo (default
  // their max), and the upgrades after that.
  function upgradeRest(upgrades, game, keys, upTo = Infinity) {
    const own = { ...upgrades?.[game] };
    let price = 0;
    for (const key of keys) {
      for (let offer = upgradeOffer({ [game]: own }, game, key); offer && offer.next <= upTo; offer = upgradeOffer({ [game]: own }, game, key)) {
        price += offer.price;
        own[key] = offer.next;
      }
    }
    return { price, upgrades: { ...upgrades, [game]: own } };
  }

  // Every plan entry that is not maxed, in plan order, with the next level's
  // offer and why it is not bought now: 'level' (needs a higher player level),
  // a skip reason (skip returns why an offer is not worth buying, or null) or
  // null when it is worth buying. The first entry with no reason is the goal;
  // later entries wait until it is bought, so the order is the priority.
  function shopQueue(plan, player, skip = () => null) {
    const queue = [];
    for (const { game, key } of plan) {
      const offer = upgradeOffer(player?.upgrades, game, key);
      if (!offer) continue;
      queue.push({ ...offer, reason: player.level < offer.minLevel ? 'level' : skip(offer) });
    }
    return queue;
  }

  // Highest allowed bet level that does not exceed what the user asked for.
  function betFor(wanted, maxBet, levels = BET_LEVELS) {
    const allowed = levels.filter((b) => b <= maxBet);
    if (!allowed.length) return levels[0];
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

  // Credits a response pays on top of what was played: a level-up reward, the
  // rewards of standup quests and achievements it completed, which the server
  // pays at once, the shared payroll fund when this bet dropped it (less what
  // the debt collector took), and the Konec kvartálu weekend bonus on a win.
  // { levelUp, standup, achievement, payroll, event }.
  function rewardsPaid(data) {
    const sum = (list) => (Array.isArray(list) ? list.reduce((total, item) => total + (Number(item?.reward) || 0), 0) : 0);
    const fund = data?.payrollWin;
    return {
      levelUp: Number(data?.levelUp?.reward) || 0,
      standup: sum(data?.quests),
      achievement: sum(data?.achievements),
      payroll: Math.max(0, (Number(fund?.amount) || 0) - (Number(fund?.garnished) || 0)),
      event: Math.max(0, Number(data?.eventBonus) || 0),
    };
  }

  const rewardTotal = (data) => Object.values(rewardsPaid(data)).reduce((a, b) => a + b, 0);

  // Profit of one game API response. Net is the credit change plus whatever the
  // debt collector took from the win, because that still paid down the loan,
  // minus the rewards the same response pays but the game did not earn.
  function gameDelta(path, request, data, creditsBefore, prevStake = 0) {
    const game = PATH_GAME[path];
    if (!game || !data?.player || typeof creditsBefore !== 'number') return null;
    let rounds = 1;
    let wagered;
    if (path === '/api/roulette/spin') {
      wagered = Object.values(request?.bets ?? {}).reduce((sum, amount) => sum + amount, 0);
    } else if (path === '/api/blackjack/deal') {
      wagered = data.hand?.stake ?? request?.bet ?? 0;
    } else if (path === '/api/lottery/buy') {
      wagered = request?.price ?? 0;
    } else if (path === '/api/hotfix/free') {
      // Free spins finish the spin that triggered them and pay its win with theirs.
      rounds = 0;
      wagered = 0;
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
      net: data.player.credits - creditsBefore + (data.garnished ?? 0) - rewardTotal(data),
      xp: data.xpGain ?? 0,
      stake: data.hand?.stake ?? prevStake,
    };
  }

  // Level curve seen so far, shared by every account: { [level]: { xpNeed, reward } }
  // with the XP a level needs (player.xpNeed while at it) and the credits paid on
  // reaching it (levelUp.reward). Returns a new map when something new was
  // seen, else the same one, so the caller saves only on a change.
  function recordLevel(levels, player, levelUp) {
    let next = levels;
    const set = (level, field, value) => {
      if (!(level >= 1) || !(value >= 0) || next[level]?.[field] === value) return;
      next = { ...next, [level]: { ...next[level], [field]: value } };
    };
    // Numbers as strings count too, as in rewardsPaid.
    if (player && player.xpNeed != null) set(Number(player.level), 'xpNeed', Number(player.xpNeed));
    if (levelUp && levelUp.reward != null) set(Number(levelUp.to ?? player?.level), 'reward', Number(levelUp.reward));
    return next;
  }

  // Level curve of the server, fitted exactly to the recorded levels 14 to 18:
  // XP a level needs and the credits paid on reaching it.
  const xpForLevel = (level) => Math.round(280 * level ** 1.35);
  const levelReward = (level) => 1000 * (level - 1);

  // XP from where the player stands to the start of level `level + levels`.
  function xpAhead(player, levels) {
    if (!(player?.level >= 1)) return 0;
    let xp = Math.max(0, (player.xpNeed ?? xpForLevel(player.level)) - (player.xpInto ?? 0));
    for (let level = player.level + 1; level < player.level + levels; level++) xp += xpForLevel(level);
    return xp;
  }

  // Daily bonus on a streak day at a player level, the client's formula: the
  // base grows 250 a day up to day 7, and every level adds 10 % of it, 15 %
  // from level 5.
  function dailyBonus(day, level) {
    const base = 500 + 250 * (Math.max(1, Math.min(day, 7)) - 1);
    return Math.round((base * (1 + (level - 1) * 0.1 + Math.max(0, level - 4) * 0.05)) / 10) * 10;
  }

  function addDelta(games, delta) {
    const row = (games[delta.game] ??= { rounds: 0, wagered: 0, net: 0, xp: 0 });
    row.rounds += delta.rounds;
    row.wagered += delta.wagered;
    row.net += delta.net;
    row.xp += delta.xp;
    return games;
  }

  // XP per game and bet level: { [game]: { [bet]: { rounds, xp } } }, to test
  // whether XP per round really grows with the bet. A blackjack action adds its
  // XP to the hand's opening bet with no round.
  function addBetXp(table, game, bet, rounds, xp) {
    const cell = ((table[game] ??= {})[bet] ??= { rounds: 0, xp: 0 });
    cell.rounds += rounds;
    cell.xp += xp;
    return table;
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
    ENERGY_MS,
    CRASH_LEVELS,
    CRASH_MAX_BET,
    LOTTERY_UNLOCK,
    GAMES,
    GAME_KEYS,
    ROULETTE_BETS,
    PATH_GAME,
    SHOP,
    UPGRADE_PLAN,
    upgradeOffer,
    upgradeRest,
    shopQueue,
    betFor,
    energyNow,
    rewardsPaid,
    rewardTotal,
    gameDelta,
    recordLevel,
    xpForLevel,
    levelReward,
    xpAhead,
    dailyBonus,
    addDelta,
    addBetXp,
    totalNet,
    profitRows,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterGames = api;
})(globalThis);
