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
    cases: { unlock: 17, path: '/api/cases/open' },
    baccarat: { unlock: 20, path: '/api/baccarat/deal' },
    dice: { unlock: 25, path: '/api/dice/roll' },
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
    '/api/baccarat/deal': 'baccarat',
    '/api/cases/open': 'cases',
    '/api/dice/roll': 'dice',
    '/api/blackjack/deal': 'blackjack',
    '/api/blackjack/action': 'blackjack',
    '/api/lottery/buy': 'lottery',
  };

  // Shop catalog copied from the client: [max level, base price, price growth],
  // plus the price of each level where the client lists them.
  const SHOP = {
    global: { bets: [3, 1000, 3, [1000, 3000, 8000]] },
    blaze: { lucky: [5, 3000, 1.8], wild: [5, 4000, 1.8], star: [5, 2000, 1.8] },
    crash: { sla: [3, 4000, 2.2] },
    skeleton: { team: [4, 4000, 1.8], wild: [4, 5000, 1.8], deploy: [3, 6000, 2] },
    slotingi: { crown: [3, 6000, 2], gulas: [4, 5000, 1.8], mint: [3, 8000, 2.2] },
    blackjack: { ties: [4, 8000, 1.8], bjpay: [2, 10000, 2], soft17: [1, 6000, 1], double: [1, 4000, 1], hint: [1, 3000, 1] },
    hotfix: { oncall: [3, 9000, 2], fix: [3, 8000, 2], review: [4, 7000, 1.8] },
    roulette: { zeros: [2, 15000, 2.5] },
    baccarat: { cut: [3, 12000, 2], push: [1, 25000, 1] },
    dice: { house: [3, 15000, 2], insure: [1, 30000, 1] },
    cases: { supplier: [3, 10000, 2], kitchen: [2, 20000, 2] },
  };
  const SHOP_UNLOCK = { global: 1, blaze: 1, crash: 3, skeleton: 5, slotingi: 7, blackjack: 10, hotfix: 13, roulette: 15, cases: 17, baccarat: 20, dice: 25 };

  // Next level of an upgrade: its price and the player level it needs.
  function upgradeOffer(upgrades, game, key) {
    const item = SHOP[game]?.[key];
    if (!item) return null;
    const [max, base, growth, prices] = item;
    const have = upgrades?.[game]?.[key] ?? 0;
    if (have >= max) return null;
    const next = have + 1;
    return {
      game,
      key,
      next,
      price: prices?.[next - 1] ?? Math.round((base * growth ** (next - 1)) / 100) * 100,
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
    'slotingi:crown', 'roulette:zeros', 'dice:house', 'dice:insure', 'baccarat:push', 'baccarat:cut', 'blackjack:ties', 'blackjack:bjpay',
    'hotfix:review', 'hotfix:oncall', 'hotfix:fix', 'cases:supplier', 'cases:kitchen',
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

  // Forbes z Chánova animation times in ms, from the app at normal speed: reels
  // dropping in, the Hotfix wheel and its banner, redrawing the reels after it
  // (900 when the reel sizes stay, a new drop otherwise), one winning cascade,
  // three or more scatters, the incident banner before the free-spin pick, the
  // free-spin intro, gap and outro banners, and a big-win banner.
  const HOTFIX_ANIM = {
    drop: 1250,
    wheel: 5800,
    morph: 900,
    cascade: 1800,
    scatters: 1100,
    incident: 2400,
    freeIntro: 2800,
    freeGap: 350,
    freeOutro: 2600,
    bigWin: 2600,
  };
  const BIG_WIN_X = 10;

  function hotfixRoundMs(round) {
    const A = HOTFIX_ANIM;
    let ms = A.drop;
    if (round.mod) {
      ms += A.wheel;
      const first = round.steps[0].reels;
      const sameSizes = round.pre?.every((reel, i) => reel.length === first[i].length);
      if (round.pre) ms += sameSizes && round.mod.key !== 'refactor' ? A.morph : A.drop;
    }
    for (const step of round.steps) {
      if (!step.wins.length) break;
      ms += A.cascade;
    }
    if (round.scatters >= 3) ms += A.scatters;
    return ms;
  }

  // How long the app animates a Forbes z Chánova response before it lets the
  // player act: the free-spin pick shows once a triggering spin has animated,
  // and the next spin once the free spins have. The server turns game requests
  // away ("počkej na animaci") until then, so the bot waits as long. Other
  // spins are not held and give 0.
  function hotfixLockMs(path, data) {
    const A = HOTFIX_ANIM;
    if (path === '/api/hotfix/spin') return data?.outcome?.trigger ? hotfixRoundMs(data.outcome.round) + A.incident : 0;
    if (path !== '/api/hotfix/free' || !data?.free) return 0;
    const rounds = data.free.rounds.reduce((ms, round) => ms + hotfixRoundMs(round) + A.freeGap, 0);
    const big = data.totalWin >= BIG_WIN_X * data.bet ? A.bigWin : 0;
    return A.freeIntro + rounds + A.freeOutro + big;
  }

  // Profit of one game API response. Net is the credit change plus whatever the
  // debt collector took from the win, because that still paid down the loan,
  // minus the rewards the same response pays but the game did not earn.
  function gameDelta(path, request, data, creditsBefore, prevStake = 0) {
    const game = PATH_GAME[path];
    if (!game || !data?.player || typeof creditsBefore !== 'number') return null;
    let rounds = 1;
    let wagered;
    if (path === '/api/roulette/spin' || path === '/api/baccarat/deal' || path === '/api/dice/roll') {
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
      xp: (data.xpGain ?? 0) / prestigeBonus(data.player.prestige),
      stake: data.hand?.stake ?? prevStake,
    };
  }

  // XP multiplier of an account's výpověď count (player.prestige), the client's
  // formula: +10 % per výpověď, at most five. XP is tracked without it, so rates
  // measured before a výpověď still hold after it.
  const PRESTIGE_XP = 0.1;
  const PRESTIGE_MAX = 5;
  const prestigeBonus = (prestige) => 1 + PRESTIGE_XP * Math.min(Math.max(0, Number(prestige) || 0), PRESTIGE_MAX);

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

  // What the client's roulette rules pay for these bets on this pocket: a
  // number 36 times the chip, a dozen 3 times, red/black, even/odd and
  // low/high 2 times, and every outside bet loses on a zero (0, 00 or the
  // skull S). null when a bet spot is one the check does not know (columns).
  const ROULETTE_RED = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);
  function roulettePayout(bets, pocket) {
    const n = /^\d+$/.test(pocket) ? Number(pocket) : 0;
    let paid = 0;
    for (const [spot, amount] of Object.entries(bets ?? {})) {
      let hit;
      if (spot.startsWith('n:')) hit = spot.slice(2) === pocket ? 36 : 0;
      else if (spot.startsWith('dozen:')) hit = n > 0 && Math.ceil(n / 12) === Number(spot.slice(6)) ? 3 : 0;
      else {
        const outside = { red: ROULETTE_RED.has(n), black: n > 0 && !ROULETTE_RED.has(n), even: n > 0 && n % 2 === 0, odd: n % 2 === 1, low: n >= 1 && n <= 18, high: n >= 19 }[spot];
        if (outside === undefined) return null;
        hit = outside ? 2 : 0;
      }
      paid += amount * hit;
    }
    return paid;
  }

  // Pockets of the wheel with this many zeros removed by the upgrade: 0 to 36
  // plus the skull S and the double zero 00 that are left, as in the client.
  const ROULETTE_EXTRA = ['S', '00'];
  const roulettePockets = (zeros) => [...Array.from({ length: 37 }, (_, n) => String(n)), ...ROULETTE_EXTRA.slice(Math.min(ROULETTE_EXTRA.length, zeros))];

  // Roulette model check per zeros upgrade level: { [zeros]: { spins, wagered,
  // paid, net, greens, checked, mismatches, expected, variance } }. paid is the
  // server's payout, net the profit booked from the credits (gameDelta), so
  // paid - wagered - net is a cost the response does not show (such as the
  // payroll fund's 0.5 %). greens counts zero pockets, mismatches payouts that
  // differ from the rules; expected and variance are the payout's mean and
  // variance by the rules, summed over the checked spins.
  function addRouletteSpin(check, zeros, request, data, net) {
    // The key comes from the server's upgrade level: only 0 to 2 are kept apart.
    zeros = Math.max(0, Math.min(ROULETTE_EXTRA.length, Math.trunc(Number(zeros)) || 0));
    const row = (check[zeros] ??= { spins: 0, wagered: 0, paid: 0, net: 0, greens: 0, checked: 0, mismatches: 0, expected: 0, variance: 0, checkedPaid: 0, checkedWagered: 0 });
    const pocket = String(data.pocket);
    const paid = Number(data.payout) || 0;
    row.spins += 1;
    row.wagered += Number(data.total) || Object.values(request?.bets ?? {}).reduce((sum, amount) => sum + amount, 0);
    row.paid += paid;
    row.net += net;
    if (!/^\d+$/.test(pocket) || Number(pocket) === 0) row.greens += 1;
    const rule = roulettePayout(request?.bets, pocket);
    if (rule !== null) {
      const pays = roulettePockets(zeros).map((p) => roulettePayout(request.bets, p));
      const mean = pays.reduce((sum, x) => sum + x, 0) / pays.length;
      row.checked += 1;
      if (Math.abs(rule - paid) > 0.5) row.mismatches += 1;
      row.expected += mean;
      row.variance += pays.reduce((sum, x) => sum + (x - mean) ** 2, 0) / pays.length;
      row.checkedPaid += paid;
      row.checkedWagered += Object.values(request.bets).reduce((sum, amount) => sum + amount, 0);
    }
    return check;
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
    prestigeBonus,
    levelReward,
    xpAhead,
    dailyBonus,
    addDelta,
    hotfixLockMs,
    roulettePayout,
    roulettePockets,
    addRouletteSpin,
    totalNet,
    profitRows,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterGames = api;
})(globalThis);
