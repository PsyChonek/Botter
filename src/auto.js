// Pure decision helpers for the full auto mode: crash betting from the round
// history, debt repayment and choosing the cheapest game to grind XP on.
// Classic script: globalThis.BotterAuto in the extension, require() in Node.
(function (root) {
  const BAC = root.BotterBaccarat ?? require('./baccarat.js');
  const DICE = root.BotterDice ?? require('./dice.js');
  const CASES = root.BotterCases ?? require('./cases.js');
  const CRASH_DOUBLING_MS = 4 * 60 * 60 * 1000;
  // A round that survives until the next 9:00 deploy pays every open bet at the
  // production multiplier reached after 24 hours.
  const CRASH_PLANNED_MULT = 2 ** 6;
  const CRASH_TARGET_MIN = 1.01;
  const CRASH_TARGET_MAX = 1000;
  const CRASH_MIN_HISTORY = 5;

  const crashMult = (startAt, now) => 2 ** (Math.max(0, now - startAt) / CRASH_DOUBLING_MS);

  // Best auto cash-out target (on the bet's own multiplier, rate * A / entry)
  // for a bet placed now, estimated from past rounds. Returns null when the
  // history is too short. ev is the expected payout per credit staked.
  function bestCrashTarget(history, entry, rate) {
    const outcomes = (history ?? [])
      .map((round) => (round.planned ? Infinity : Number(round.mult)))
      .filter((mult) => Number.isFinite(mult) || mult === Infinity)
      .filter((mult) => mult > entry);
    if (outcomes.length < CRASH_MIN_HISTORY) return null;

    const n = outcomes.length;
    const survives = (production) => outcomes.filter((mult) => mult >= production).length / n;
    const plannedPayout = (rate * CRASH_PLANNED_MULT) / entry;

    // Each option is a two-outcome bet: win prob p paying `payout` per credit
    // staked, else the stake is lost. ev = p * payout; p and payout are kept so
    // the caller can size the stake by Kelly.
    // Holding with no target only pays on a planned outage.
    const holdP = survives(Infinity);
    let best = { target: null, p: holdP, payout: plannedPayout, ev: plannedPayout * holdP };
    const candidates = new Set([1.5, 2, 3, 5, 10]);
    for (const mult of outcomes) {
      // Cash out just below each observed crash point.
      if (Number.isFinite(mult)) candidates.add(Math.floor(((rate * mult) / entry) * 0.995 * 100) / 100);
    }
    for (const raw of candidates) {
      const target = Math.min(CRASH_TARGET_MAX, Math.max(CRASH_TARGET_MIN, raw));
      const production = (target * entry) / rate;
      // A target above the planned-outage level is paid at that level instead.
      const [p, payout] =
        production > CRASH_PLANNED_MULT ? [holdP, plannedPayout] : [survives(production), target];
      const ev = p * payout;
      if (ev > best.ev) best = { target, p, payout, ev };
    }
    return best;
  }

  // Fractional-Kelly stake in credits for a crash plan. A plan is an EV-positive
  // two-outcome bet (win prob p, payout multiple), so the growth-optimal fraction
  // of the bankroll is f = (ev - 1) / (payout - 1); fraction scales it down
  // (0.5 = half Kelly) to trade growth for a smoother bankroll. Returns 0 when
  // the edge is not positive, so a thin plan stakes nothing.
  function crashStake(plan, bankroll, fraction = 0.5) {
    if (!plan || !(bankroll > 0) || !(plan.payout > 1) || !(plan.ev > 1)) return 0;
    const kelly = (plan.ev - 1) / (plan.payout - 1);
    const clamped = Math.max(0, Math.min(1, kelly * fraction));
    return Math.floor(clamped * bankroll);
  }

  // Credits to repay right now, keeping the reserve. Debt grows 8 %/h until it
  // is capped, and after that half of every payout is garnished, so paying it
  // off is never worse than holding credits that would only be gambled.
  function repayAmount(player, reserve) {
    const debt = player?.loan?.debt ?? 0;
    if (debt <= 0) return 0;
    return Math.max(0, Math.floor(Math.min(debt, player.credits - reserve)));
  }

  // Credits the casino leaves after a personal bankruptcy.
  const BANKRUPT_CREDITS = 500;

  // Whether declaring personal bankruptcy beats paying the debt. The casino
  // offers it only in execution: the debt is wiped and credits are set to 500,
  // but the XP into the current level is lost (along with this week's sprint
  // points and a week without loans, which the bot does not use). Paying costs
  // the whole debt, now or through the garnish, so bankruptcy wins when the debt
  // is bigger than the credits above 500 plus what the lost XP costs to grind
  // back. xpPrice is credits per XP point, null when not measured yet, and then
  // only a bankruptcy that loses no XP is taken.
  function bankruptWorth(player, xpPrice) {
    const loan = player?.loan;
    if (!loan?.execution || !(loan.debt > 0)) return false;
    const xpLost = Math.max(0, player.xpInto ?? 0);
    if (xpLost > 0 && xpPrice === null) return false;
    const cost = player.credits - BANKRUPT_CREDITS + (xpLost > 0 ? xpLost * xpPrice : 0);
    return loan.debt > cost;
  }

  // Share of every win and payout the debt collector takes in execution.
  const GARNISH = 0.5;

  // Whether a planned bankruptcy should wait until the current level is done.
  // Declaring now loses the XP into the level, worth xpPrice credits a point.
  // Waiting means the work bot earns the XP still missing while half of its pay
  // is garnished into a debt that is wiped anyway. workPerXp is the credits a
  // ticket pays per XP point. Without either price it does not wait.
  function waitForLevel(player, xpPrice, workPerXp) {
    const into = player?.xpInto ?? 0;
    if (!(into > 0) || xpPrice === null || workPerXp === null) return false;
    const left = Math.max(0, (player.xpNeed ?? 0) - into);
    return into * xpPrice > GARNISH * left * workPerXp;
  }

  // Weekly sprint: story points are the XP earned since Monday 9:00, and when it
  // ends the top three are paid these prizes. Bankruptcy wipes the week's points.
  const SPRINT_PRIZES = [5_000, 3_500, 2_000];
  // From taking a loan until its debt hits the cap and execution starts.
  const LOAN_EXECUTION_MS = 12 * 60 * 60 * 1000;

  // Prize a bankruptcy now would throw away: the one for the account's place in
  // the sprint (sprint = { rank, score }), 0 off the podium, where the points
  // are only this week's progress.
  function sprintAtStake(sprint) {
    if (!sprint || !(sprint.score > 0)) return 0;
    return SPRINT_PRIZES[sprint.rank - 1] ?? 0;
  }

  // Whether a bankruptcy should wait for the sprint to end: the account holds a
  // podium place, and the prize is paid when the sprint ends, after which the
  // new sprint's points are close to nothing. sprint.endAt is that moment.
  const sprintHold = (sprint, now = Date.now()) => sprintAtStake(sprint) > 0 && now < sprint.endAt;

  // Whether a loan taken now for the bankruptcy cycle keeps the sprint prize:
  // off the podium, or the sprint ends before execution allows the bankruptcy.
  const loanSprintSafe = (sprint, now = Date.now()) =>
    sprintAtStake(sprint) === 0 || now + LOAN_EXECUTION_MS >= sprint.endAt;

  // The shark lends in steps of 500.
  const loanAmount = (limit) => Math.floor(Math.max(0, limit ?? 0) / 500) * 500;

  // Expected value of a loan taken to be dropped by bankruptcy: the loan is
  // spent on upgrades and XP, and once the debt hits its cap (12 hours) and
  // execution starts, bankruptcy wipes it. The only cost is the XP into the
  // level at that moment, uniform over the level. Each point x of it costs the
  // cheaper of losing it (x * xpPrice) or waiting for the level
  // (GARNISH * workPerXp * (xpNeed - x), see waitForLevel), so the expected
  // cost is the integral of that minimum over the level. The credits the
  // account holds above 500 count too: the reset would wipe them, so they are
  // ground away with the loan. Sprint points and the week without loans are not
  // valued. Null when the XP price is unknown.
  function loanCycle(amount, credits, xpNeed, xpPrice, workPerXp) {
    if (!(amount > 0) || !(xpNeed > 0) || xpPrice === null) return null;
    let cost = (xpPrice * xpNeed) / 2;
    if (workPerXp !== null && xpPrice + GARNISH * workPerXp > 0) {
      const wait = GARNISH * workPerXp;
      const cross = (wait * xpNeed) / (xpPrice + wait);
      cost = (xpPrice * cross ** 2 + wait * (xpNeed - cross) ** 2) / 2 / xpNeed;
    }
    cost += Math.max(0, credits - BANKRUPT_CREDITS);
    return { amount, cost, value: amount - cost };
  }

  // The wheel of fortune is free once an hour; null means never spun. A player
  // snapshot from before the wheel existed has no field and is not ready. It is
  // spun WHEEL_GRACE_MS late: right at wheelNextAt the server can still refuse.
  const WHEEL_GRACE_MS = 5_000;
  const wheelReady = (wheelNextAt, now = Date.now()) =>
    wheelNextAt !== undefined && (wheelNextAt === null || wheelNextAt + WHEEL_GRACE_MS <= now);

  // XP per credit wagered on a game, measured from its tracked rounds, or null
  // before it has earned any. Shown on the panel and used to price XP, never to
  // pick a game: XP per round is proportional to the bet the same way in every
  // game, so the simulated edge alone decides.
  const xpRate = (row) => (row?.wagered > 0 && row.xp > 0 ? row.xp / row.wagered : null);

  // XP per credit wagered over every game that has earned XP, or null before
  // any: XP per round is proportional to the bet the same way in every game,
  // so all rounds measure the same rate. Crash and the lottery book no XP.
  function pooledXpRate(games) {
    let xp = 0;
    let wagered = 0;
    for (const row of Object.values(games ?? {})) {
      if (!(row?.xp > 0) || !(row.wagered > 0)) continue;
      xp += row.xp;
      wagered += row.wagered;
    }
    return wagered > 0 ? xp / wagered : null;
  }

  // Extra XP on a Hackathon weekend.
  const HACKATHON_XP = 0.5;
  // Credits wagered off Hackathon weekends before their rate alone is trusted.
  const PLAIN_XP_MIN_WAGERED = 100_000;

  // XP per credit wagered to plan with: from the rounds played off Hackathon
  // weekends (plain, rows like games) once they cover PLAIN_XP_MIN_WAGERED, else
  // the rate of all rounds without the Hackathon bonus, as if every one had it.
  // The weekend's +50 % would otherwise make levels look cheaper than they are.
  function planXpRate(games, plain) {
    let wagered = 0;
    for (const row of Object.values(plain ?? {})) if (row?.xp > 0) wagered += row.wagered;
    if (wagered >= PLAIN_XP_MIN_WAGERED) return pooledXpRate(plain);
    const rate = pooledXpRate(games);
    return rate === null ? null : rate / (1 + HACKATHON_XP);
  }

  // Credits an upgrade purchase must leave on top of the reserve so the grinder
  // can still reach the next level: the expected loss on the XP left in the
  // level, plus two standard deviations of the swing at the grind bet. xpLeft
  // is the XP to the next level, rate XP per credit wagered (null before it is
  // measured, then 0 is asked), edge and variance per credit of the grind game,
  // sigmas the standard deviations of the swing covered.
  function levelUpCushion(xpLeft, rate, edge, bet, variance = 1, sigmas = 2) {
    if (!(xpLeft > 0) || !(rate > 0) || !(bet > 0)) return 0;
    const wagered = xpLeft / rate;
    return Math.round(Math.max(0, edge) * wagered + sigmas * Math.sqrt(variance * bet * wagered));
  }

  // Every upgrade purchase leaves the credits to grind the XP to the end of this
  // many levels, no level-up reward counted on the way, with this many standard
  // deviations of the swing.
  const MARGIN_LEVELS = 2;
  const MARGIN_SIGMAS = 3;

  // Credits lost per XP point on a game: house edge over XP per credit wagered.
  // It does not depend on the bet, so the bet only sets the pace.
  function xpCost(game, stats, edges) {
    const edge = edges?.[game] ?? null;
    const rate = xpRate(stats[game]);
    return edge !== null && rate > 0 ? edge / rate : null;
  }

  // Unlocked game with the lowest simulated house edge (edges, from BotterOdds
  // at the current upgrades), or null. A game without a model is never picked.
  function cheapestGame(games, level, unlocks, edges = {}) {
    const unlocked = games.filter((game) => level >= unlocks[game]);
    const edge = (game) => edges?.[game] ?? Infinity;
    return unlocked.length ? unlocked.reduce((a, b) => (edge(b) < edge(a) ? b : a)) : null;
  }

  // Game to grind at the given bet (null when no bet is allowed or no unlocked
  // game has a model): the one with the lowest simulated edge. XP per credit is
  // the same in every game, so the lowest edge is the lowest loss per XP.
  function grindPlan(games, bet, level, unlocks, edges = {}) {
    if (!(bet > 0)) return null;
    const game = cheapestGame(games, level, unlocks, edges);
    return game && edges[game] !== undefined ? { game, bet } : null;
  }

  // What the XP grinder knows per game, for the panel: the simulated edge, XP
  // per credit wagered and credits lost per XP point, with the account's XP
  // bonus (GameData.prestigeBonus) on the XP tracked without it.
  function grindReport(games, level, stats, unlocks, edges = {}, bonus = 1) {
    return games.map((game) => {
      const rate = xpRate(stats[game]);
      const cost = xpCost(game, stats, edges);
      return {
        game,
        locked: level < unlocks[game],
        unlock: unlocks[game],
        edge: edges?.[game] ?? null,
        rate: rate === null ? null : rate * bonus,
        cost: cost === null ? null : cost / bonus,
      };
    });
  }

  // An upgrade has to raise its game's return by at least this much per credit
  // of its remaining levels: 0.5 percentage points per 10,000 credits. Below
  // that sit blackjack's hint (the bot already plays perfectly), its
  // double-anything and soft 17, and Slotingi's coin minting.
  const UPGRADE_MIN_GAIN = 0.005 / 10_000;
  // Grinding volume an upgrade must pay back over, under a daily loss budget.
  const UPGRADE_HORIZON_DAYS = 14;
  // Levels of XP an upgrade must pay back over once the XP rate is measured.
  const UPGRADE_HORIZON_LEVELS = 10;

  // Credits the grinder expects to lose while an upgrade has to pay off: the
  // daily budget over the horizon, what is above the minimum balance, or with
  // the limit off what is above the reserve.
  function grindVolume(settings, credits) {
    if (settings.grindLimit === 'off') return Math.max(0, credits - settings.reserve);
    if (settings.grindLimit === 'balance') return Math.max(0, credits - settings.grindMinBalance);
    return Math.max(0, settings.xpBudget) * UPGRADE_HORIZON_DAYS;
  }

  // Game the grinder ends on: the one with the lowest edge once every upgrade
  // is bought and it is unlocked, or null when no game has a model. Upgrades
  // of any other game stop paying as soon as a cheaper game unlocks, so only
  // this one is upgraded. maxedEdge(game) is that edge, or null. With cost
  // ({ price(game): what its remaining upgrades cost, and wagered: credits to
  // be wagered over the horizon, or budget: credits to be lost over it, see
  // grindVolume }) the price counts too, so a slightly lower edge behind far
  // dearer upgrades (Bakarat against roulette) does not win on edge alone:
  // with wagered the game where the price plus the loss on it is smallest,
  // with budget the one where what is left of it after the price buys the
  // most wagering.
  function finalGame(games, maxedEdge, cost = null) {
    const score = (game, edge) => {
      if (!cost) return edge;
      if (cost.wagered != null) return cost.price(game) + cost.wagered * edge;
      return edge <= 0 ? -Infinity : -(cost.budget - cost.price(game)) / edge;
    };
    let best = null;
    for (const game of games) {
      const edge = maxedEdge(game);
      if (edge === null) continue;
      const total = score(game, edge);
      if (best === null || total < best.total) best = { game, total };
    }
    return best?.game ?? null;
  }

  // Why an upgrade from the shop plan is not worth its price, or null when it is.
  // ctx: games (unlocked games the grinder may pick), finalGame (see finalGame),
  // finalUnknown (the final game hangs on the undecided Blaze star rule),
  // xpAhead (XP to the next UPGRADE_HORIZON_LEVELS levels) and xpRate (measured
  // XP per credit wagered, or null),
  // upgrades,
  // edge(game, upgrades) (modelled house edge or null), rest(keys, upTo)
  // ({ price, upgrades } after buying those upgrades of the offer's game up to
  // level upTo, default max), maxLevels ({ key: max } of the game) and volume (see
  // grindVolume).
  // With the XP rate measured, an upgrade is bought when it saves more than its
  // price on the XP to the next levels: credits wagered for that XP (xpAhead /
  // xpRate) times the drop in edge. Levels pay rewards, so grinding is not a
  // loss to be kept small but XP to be bought cheap. Before the rate is known:
  // credits spent on upgrades are not there to grind with, so they are bought
  // only if the XP from the remaining volume at the cheaper cost beats the XP
  // from the whole volume at today's best cost. That is checked for the next
  // levels of this upgrade alone (a cheap first level can pay back on its own)
  // and for every worthwhile upgrade of the game maxed together.
  function upgradeVerdict(offer, ctx) {
    const { game } = offer;
    const now = (g) => ctx.edge(g, ctx.upgrades);
    // A game without a validated model is bought only as the first-game pick.
    if (now(game) === null) return 'noModel';
    // Credits put into the wrong final game are lost, so nothing is bought until it is known.
    if (ctx.finalUnknown) return 'starRule';
    if (!ctx.games.includes(game)) return 'notGrinded';

    const gainPerCredit = (keys) => {
      const rest = ctx.rest(keys);
      return rest.price > 0 ? (now(game) - ctx.edge(game, rest.upgrades)) / rest.price : 0;
    };
    if (gainPerCredit([offer.key]) < UPGRADE_MIN_GAIN) return 'tooSmall';
    const keys = Object.keys(ctx.maxLevels);

    // XP per credit is the same in every game, so costs compare by edge alone.
    // Only the final game is upgraded; until it unlocks the grinder plays the
    // cheapest game as it is. Without a final game, only the game the grinder
    // plays, or one this level alone makes the cheapest: credits put into a
    // game it does not play buy no XP.
    const before = Math.min(...ctx.games.map((g) => now(g) ?? Infinity));
    if (ctx.finalGame && game !== ctx.finalGame) return 'notFinal';
    const nextEdge = ctx.edge(game, ctx.rest([offer.key], offer.next).upgrades);
    if (!ctx.finalGame && now(game) > before && nextEdge > before) return 'notBest';
    const maxed = ctx.rest(keys.filter((key) => gainPerCredit([key]) >= UPGRADE_MIN_GAIN));
    const pays = (rest) => {
      const after = Math.min(before, ctx.edge(game, rest.upgrades));
      if (after <= 0) return true; // the player is ahead: it pays for itself
      if (ctx.xpAhead > 0 && ctx.xpRate > 0) return (ctx.xpAhead / ctx.xpRate) * (before - after) > rest.price;
      return (ctx.volume - rest.price) / after > ctx.volume / before;
    };
    const steps = [];
    for (let upTo = offer.next; upTo <= ctx.maxLevels[offer.key]; upTo++) steps.push(ctx.rest([offer.key], upTo));
    return [...steps, maxed].some(pays) ? null : 'xpFarmingBetter';
  }

  // Goal of the shop queue (G.shopQueue): the cheapest upgrade of the priority
  // game (null for none) that the player level allows, whatever its verdict, or
  // else the first entry worth buying. Null when there is neither.
  function shopGoal(queue, priority = null) {
    let best = null;
    for (const offer of queue) {
      if (offer.game !== priority || offer.reason === 'level') continue;
      if (!best || offer.price < best.price) best = offer;
    }
    return best ?? queue.find((offer) => !offer.reason) ?? null;
  }

  // Cheapest upgrade from the shop queue (G.shopQueue) that the XP plan skips
  // but the player level allows, bought only from spare credits: what is left
  // after its price must still cover need (reserve, the saved goal and the
  // cushion to the next level). Upgrades of the priority game come before any
  // other. Null when none fits.
  function spareUpgrade(queue, credits, need, priority = null) {
    const rank = (offer) => (offer.game === priority ? 0 : 1);
    let best = null;
    for (const offer of queue) {
      if (!offer.reason || offer.reason === 'level' || credits - offer.price < need) continue;
      if (!best || rank(offer) < rank(best) || (rank(offer) === rank(best) && offer.price < best.price)) best = offer;
    }
    return best;
  }

  // Bet levels XP grinding may use now: allowed by the limits, and under a daily
  // budget no bigger than what is left of it, so one lost round cannot overshoot.
  function grindBets(settings, credits, lostToday, levels) {
    return levels.filter(
      (bet) =>
        grindAllowed(settings, credits, lostToday, bet) &&
        (settings.grindLimit !== 'daily' || bet <= settings.xpBudget - lostToday),
    );
  }

  // Bet XP grinding plays: the chosen level, or the biggest smaller one the
  // limits still allow, so the grinder steps down near a limit instead of
  // stopping. Null when not even the smallest level is allowed.
  function grindBet(settings, credits, lostToday, levels, wanted) {
    return grindBets(settings, credits, lostToday, levels.filter((bet) => bet <= wanted)).at(-1) ?? null;
  }

  // Whether XP grinding may place another bet. The limit is a daily loss
  // budget, a minimum account balance (0 turns either off) or off, which
  // grinds down to the reserve. The reserve applies under every limit.
  function grindAllowed(settings, credits, lostToday, bet) {
    const after = credits - bet;
    if (after < settings.reserve) return false;
    if (settings.grindLimit === 'off') return true;
    if (settings.grindLimit === 'balance') return settings.grindMinBalance > 0 && after >= settings.grindMinBalance;
    return settings.xpBudget > 0 && lostToday < settings.xpBudget;
  }

  // While XP grinding can go on, work keeps energy this far below the cap and no
  // lower: at the cap the refill clock stops, and tickets pay more at a higher
  // level, so the rest of the energy waits until the grinder is done.
  const WORK_CAP_MARGIN = 2;

  // Whether the work bot should take a ticket now. While grinding, only to keep
  // energy off the cap. Otherwise a run starts above minEnergy and works energy
  // down to zero, so single refilled points do not keep interrupting.
  function workDue(energy, maxEnergy, running, minEnergy, grinding) {
    if (grinding) return energy >= maxEnergy - WORK_CAP_MARGIN;
    return energy > minEnergy || (running && energy >= 1);
  }

  // Account worth leaving even a busy one for, longest unseen first: one that
  // still owes the running Produkce padá round its bet while entering pays (the
  // entry gets worse as the round ages), one not visited today (its daily bonus
  // and checks are waiting), one that still owes the next lottery draw its
  // tickets, then one whose free wheel spin is ready. Null when there is none.
  function urgentAccount(candidates, today) {
    const oldest = (list) => list.reduce((a, b) => (b.seenAt < a.seenAt ? b : a)).id;
    const crash = candidates.filter((a) => a.crash);
    if (crash.length) return oldest(crash);
    const fresh = candidates.filter((a) => a.seenDay !== today);
    if (fresh.length) return oldest(fresh);
    const lottery = candidates.filter((a) => a.lottery);
    if (lottery.length) return oldest(lottery);
    const spin = candidates.filter((a) => a.wheel);
    if (spin.length) return oldest(spin);
    return null;
  }

  // Account to switch to once the current one has nothing left to do. Each
  // candidate is { id, seenAt, seenDay, energy, normDone, credits, canGrind,
  // wheel, crash, lottery }. An urgent one goes first (see urgentAccount). Away from the home
  // account, the next stop is home. From home, the one with the most refilled
  // energy above minEnergy, else the richest one that can still grind XP, so
  // betting carries on when home has run out of credits.
  function pickAccount(candidates, today, minEnergy, home = null) {
    const urgent = urgentAccount(candidates, today);
    if (urgent) return urgent;
    if (home && candidates.some((a) => a.id === home)) return home;
    const ready = candidates.filter((a) => !a.normDone && a.energy > minEnergy);
    if (ready.length) return ready.reduce((a, b) => (b.energy > a.energy ? b : a)).id;
    const funded = candidates.filter((a) => a.canGrind);
    if (funded.length) return funded.reduce((a, b) => (b.credits > a.credits ? b : a)).id;
    return null;
  }

  // Daily standup quests (player.quests: { key, text, progress, target, done,
  // reward }). The server tracks the progress and pays each reward the moment a
  // quest is done, plus a bonus for all three, so the bot only plays the rounds.
  // Quests come as Czech text, so the game and the kind are read from it.
  const QUEST_GAMES = {
    blaze: /blaze/,
    skeleton: /skeleton slot/,
    slotingi: /sloting/,
    blackjack: /blackjack/,
    roulette: /rulet|roulette/,
    baccarat: /bakarat|baccarat/,
    dice: /kostk|dice/,
    cases: /case opening|bedn|beden/,
    crash: /produkce|crash/,
  };

  // Game a quest is tied to, from its key or its text, or null for any game.
  function questGame(quest) {
    const words = String(quest?.key ?? '').toLowerCase().split(/[^a-z]+/);
    const text = String(quest?.text ?? '').toLowerCase();
    const game = Object.keys(QUEST_GAMES).find((g) => words.includes(g) || QUEST_GAMES[g].test(text));
    return game ?? null;
  }

  // Win sizes a quest can ask for, as the index into the simulated big win
  // rates (BotterOdds.bigRates: 10x, 25x and 50x the bet).
  const BIG_KINDS = ['big', 'mega', 'super'];

  // 'rounds' (play N rounds of a game), 'wager' (wager N credits), 'wins'
  // (finish N rounds ahead), 'big', 'mega' or 'super' (hit N wins of 10x, 25x
  // or 50x the bet), or null for a quest the bot cannot play, such as an
  // amount won.
  function questKind(quest) {
    const text = `${quest?.key ?? ''} ${quest?.text ?? ''}`.toLowerCase();
    if (/super[ _-]?win/.test(text)) return 'super';
    if (/mega[ _-]?win/.test(text)) return 'mega';
    if (/big[ _-]?win|velk\S* v[yý]hr/.test(text)) return 'big';
    const credits = /kredit|credit|wager/.test(text);
    if (/plus|vyhr|win/.test(text)) return credits ? null : 'wins';
    if (credits) return 'wager';
    return questGame(quest) ? 'rounds' : null;
  }

  // Chance that one round ends ahead: the simulated one from wins when given
  // (BotterOdds.winRates). Without it, an even-money roulette bet wins 18 of
  // the 36 / rtp numbers, so half its return; basic-strategy blackjack wins
  // about 42 % of hands; the slots pay often but mostly less than the bet, so
  // 25 % is a rough guess.
  const winChance = (game, edge, wins) => {
    if (wins?.[game] > 0) return wins[game];
    if (game === 'roulette') return (1 - edge) / 2;
    if (game === 'blackjack') return 0.42;
    return 0.25;
  };

  // Expected loss of finishing a quest on one game, and the bet to play it at.
  // levels are the affordable bet levels, ascending. Rounds and wins go at the
  // smallest bet; a wager quest costs the same at any bet, so it goes at the
  // biggest one that does not overshoot what is left. A big win quest goes at
  // the smallest bet for the expected rounds to hit it (bigs: the game's
  // simulated rates).
  function questCost(kind, game, left, edge, levels, wins, bigs) {
    const house = Math.max(0, edge);
    const min = levels[0];
    const big = BIG_KINDS.indexOf(kind);
    if (big >= 0) return { bet: min, cost: (left / bigs[big]) * min * house };
    if (kind === 'wager') {
      const bet = [...levels].reverse().find((b) => b <= left) ?? min;
      return { bet, cost: left * house };
    }
    if (kind === 'wins') return { bet: min, cost: (left / winChance(game, edge, wins)) * min * house };
    return { bet: min, cost: left * min * house };
  }

  // Open standup quest to play next with its game and bet, or null. A quest is
  // played only when its expected loss is below its reward, on the game where
  // that loss is smallest. The bonus for all three and the standup achievement
  // are left out, so a quest that pays only with them is skipped. ctx: level,
  // unlocks ({ game: level }), edges ({ game: house edge }), wins ({ game:
  // share of rounds that end ahead }, optional), bigs ({ game: [share of
  // rounds paying 10x, 25x, 50x] }; a big win quest is played only on a game
  // listed there with a chance above zero) and levels (bet levels affordable
  // now). skipped collects the quests that are not worth it.
  function standupPlan(quests, ctx, skipped = []) {
    const levels = [...(ctx.levels ?? [])].sort((a, b) => a - b);
    let best = null;
    for (const quest of quests ?? []) {
      const left = Math.max(0, (quest.target ?? 0) - (quest.progress ?? 0));
      if (quest.done || !(left > 0)) continue;
      const kind = questKind(quest);
      const only = questGame(quest);
      const big = BIG_KINDS.indexOf(kind);
      const games = (only ? [only] : Object.keys(ctx.unlocks)).filter(
        (g) =>
          ctx.unlocks[g] !== undefined &&
          ctx.level >= ctx.unlocks[g] &&
          ctx.edges[g] !== undefined &&
          (big < 0 || ctx.bigs?.[g]?.[big] > 0),
      );
      if (!kind || !games.length || !levels.length) {
        skipped.push({ key: quest.key, reason: !kind ? 'unknown' : !games.length ? 'noGame' : 'noCredits' });
        continue;
      }
      const plan = games
        .map((game) => ({ game, ...questCost(kind, game, left, ctx.edges[game], levels, ctx.wins, ctx.bigs?.[game]) }))
        .reduce((a, b) => (b.cost < a.cost ? b : a));
      if (plan.cost >= quest.reward) {
        skipped.push({ key: quest.key, reason: 'tooCostly', cost: Math.round(plan.cost), reward: quest.reward });
        continue;
      }
      const candidate = { quest, kind, ...plan };
      if (!best || candidate.cost / quest.reward < best.cost / best.quest.reward) best = candidate;
    }
    return best;
  }

  // Credit-paying achievements the hunt goes after, copied from the client's
  // catalog (reward per tier, and the tier thresholds of counted ones). The
  // rest either happen on their own, are claimed elsewhere (clean loan,
  // podium, standup, wheel, attendance, maxed) or hinge on rare slot events.
  const HUNT_ROUNDS_TIERS = [1000, 10_000, 100_000];
  const HUNT_ACHIEVEMENTS = {
    zero_hero: { reward: 1000 }, // win a roulette bet on a zero
    uptime_hero: { reward: 2000 }, // cash out a crash bet at 10x or more
    natural: { reward: 300 }, // blackjack from the first two cards
    five_cards: { reward: 1000 }, // win a blackjack hand with five or more cards
    night_owl: { reward: 300 }, // play between 2:00 and 5:00
    regular: { reward: [1000, 5000, 25000], tiers: HUNT_ROUNDS_TIERS }, // rounds played
    friday_deploy: { reward: 200 }, // work on Friday after 17:00
    speedy: { reward: 200 }, // a right answer within 3 seconds
    lottery_3: { reward: 1000 }, // 3 or more numbers on one lottery ticket
    lottery_4: { reward: 5000 }, // 4 numbers on one ticket
    lottery_5: { reward: 20_000 }, // 5 numbers on one ticket (secret)
    lottery_full: { reward: 300 }, // all 5 tickets on one draw
    lottery_days: { reward: [300, 2000, 5000], tiers: [1, 7, 30] }, // tickets on 1 / 7 / 30 draws
    bac_pair: { reward: 1000 }, // win a baccarat bet on a pair
    bac_tie: { reward: 1000 }, // win a baccarat bet on a tie
    dice_triple: { reward: 2000 }, // win a Kostky bet on a triple
    dice_edge: { reward: 2000 }, // win a Kostky bet on the sum 4 or 17
    dice_taken: { reward: 500 }, // lose a Malá or Velká bet to a triple
    case_knife: { reward: 5000 }, // a gold knife from a case
    case_car: { reward: 2000 }, // the burning Fabia from a case
    case_pen: { reward: 500 }, // three pens in a row
  };
  // Per hand of the bot's strategy, from 2,000,000 simulated hands with no
  // upgrades (natural 4.76 %, five-card win 0.51 %; maxed upgrades 0.65 %).
  const BJ_NATURAL = 0.0476;
  const BJ_FIVE_CARD_WIN = 0.005;
  const CRASH_ACHIEVEMENT_TARGET = 10;
  const ROULETTE_ZERO_SPOT = 'n:0';

  // Tier still to unlock of a hunted achievement, or null when it is done or
  // the player snapshot does not list achievements.
  function achievementTier(player, key) {
    const def = HUNT_ACHIEVEMENTS[key];
    if (!def || !player?.achievements) return null;
    const tier = player.achievements[key]?.tier ?? 0;
    return tier < (def.tiers?.length ?? 1) ? tier : null;
  }

  const achievementReward = (key, tier) => {
    const { reward } = HUNT_ACHIEVEMENTS[key];
    return Array.isArray(reward) ? reward[tier] : reward;
  };

  const nightHours = (now) => {
    const hour = new Date(now).getHours();
    return hour >= 2 && hour < 5;
  };
  const fridayEvening = (now) => {
    const d = new Date(now);
    return d.getDay() === 5 && d.getHours() >= 17;
  };

  // Baccarat side bets the hunt places, with their chance to win and their
  // edge. Neither depends on the upgrades: the cut is taken from Hráč and
  // Bankéř wins only.
  const BAC_HUNT = {
    bac_tie: { spot: 'tie', chance: BAC.outcomes().tie, edge: 1 - BAC.spotRtp('tie', {}) },
    bac_pair: { spot: 'ppair', chance: BAC.PAIR_CHANCE, edge: 1 - BAC.spotRtp('ppair', {}) },
  };

  // Kostky bets the hunt places: a sum of 4 (a 17 counts the same), any
  // triple, and Malá, which a triple takes. Their edge depends on the
  // commission, so it is taken at the player's upgrades.
  const DICE_HUNT = {
    dice_edge: { spot: 'sum4', chance: DICE.spotChance('sum4') },
    dice_triple: { spot: 'anytriple', chance: DICE.spotChance('anytriple') },
    dice_taken: { spot: DICE.BEST_SPOT, chance: 6 / 216 },
  };

  // The side bet with the best value over its own loss at this bet, or null:
  // sides is { key: { spot, chance, edge } }, only open achievements count.
  function bestSide(sides, open, bet) {
    return Object.entries(sides)
      .filter(([key]) => open(key))
      .map(([key, side]) => ({ key, ...side, value: side.chance * achievementReward(key, 0) }))
      .reduce((a, b) => (a && a.value - bet * a.edge >= b.value - bet * b.edge ? a : b), null);
  }

  // Next game round worth playing for achievements, or null. Every round is
  // valued at the rewards it can unlock times their chance: a natural and a
  // five-card win per blackjack hand, a straight bet on 0 per roulette spin, a
  // tie or pair bet per baccarat hand (whichever pays more), a sum, triple or
  // Malá bet per Kostky roll (the same way), a gold knife, the burning Fabia
  // and a third pen in a row per case (the pens counted as three in a row),
  // any round at night, and the next rounds-played tier spread over the rounds
  // it still needs (finishing it costs those rounds, so a round is worth the
  // reward over that count). A round is played when that beats its expected
  // loss, on the game where the margin is biggest, at the smallest bet.
  // ctx: level, unlocks, edges (house edge per game), levels (affordable bet
  // levels), roundsGoal (highest rounds-played tier to chase, all when unset), now.
  function huntPlan(player, ctx) {
    const bet = Math.min(...(ctx.levels ?? []));
    if (!Number.isFinite(bet)) return null;
    const now = ctx.now ?? Date.now();
    const open = (key) => achievementTier(player, key) !== null;

    const shared = [];
    if (open('night_owl') && nightHours(now)) shared.push({ key: 'night_owl', value: achievementReward('night_owl', 0) });
    const tier = achievementTier(player, 'regular');
    // The client shows counter progress from achProgress; totalSpins is the same count.
    const played = player.achProgress?.regular ?? player.totalSpins ?? Infinity;
    const goal = HUNT_ACHIEVEMENTS.regular.tiers[tier];
    const left = tier === null || goal > (ctx.roundsGoal ?? Infinity) ? 0 : goal - played;
    if (left > 0) shared.push({ key: 'regular', value: achievementReward('regular', tier) / left });

    let best = null;
    for (const game of Object.keys(ctx.unlocks)) {
      const edge = ctx.edges[game];
      if (edge === undefined || ctx.level < ctx.unlocks[game]) continue;
      const own = [];
      if (game === 'blackjack') {
        if (open('natural')) own.push({ key: 'natural', value: BJ_NATURAL * achievementReward('natural', 0) });
        if (open('five_cards')) own.push({ key: 'five_cards', value: BJ_FIVE_CARD_WIN * achievementReward('five_cards', 0) });
      }
      let spot = null;
      let spotEdge = edge;
      if (game === 'roulette' && open('zero_hero')) {
        // A straight bet pays 36 like the outside bets, so it has the same edge.
        const pockets = 36 / (1 - edge);
        own.push({ key: 'zero_hero', value: achievementReward('zero_hero', 0) / pockets });
        spot = ROULETTE_ZERO_SPOT;
      }
      if (game === 'baccarat' || game === 'dice') {
        // One side bet a round, the one with the best value over its own loss.
        const upgrades = player.upgrades?.dice;
        const sides = game === 'baccarat' ? BAC_HUNT : Object.fromEntries(
          Object.entries(DICE_HUNT).map(([key, side]) => [key, { ...side, edge: 1 - DICE.spotRtp(side.spot, upgrades) }]),
        );
        const side = bestSide(sides, open, bet);
        if (side) {
          own.push({ key: side.key, value: side.value });
          spot = side.spot;
          spotEdge = side.edge;
        }
      }
      if (game === 'cases') {
        const upgrades = player.upgrades?.cases;
        if (open('case_knife')) own.push({ key: 'case_knife', value: CASES.chance('gold', upgrades) * achievementReward('case_knife', 0) });
        if (open('case_car')) own.push({ key: 'case_car', value: CASES.chance('car', upgrades) * achievementReward('case_car', 0) });
        if (open('case_pen')) own.push({ key: 'case_pen', value: CASES.chance('pen', upgrades) ** 3 * achievementReward('case_pen', 0) });
      }
      const targets = [...shared, ...own];
      if (!targets.length) continue;
      const value = targets.reduce((sum, t) => sum + t.value, 0);
      const loss = bet * Math.max(0, spotEdge);
      if (value <= loss) continue;
      const plan = { game, bet, spot, targets: targets.map((t) => t.key), value, loss };
      if (!best || value - loss > best.value - best.loss) best = plan;
    }
    return best;
  }

  // Lottery (Loterie, from level 4): 6 of 49, drawn every day at 20:00, at most
  // five tickets per draw. A ticket pays its price times LOTTERY_PAYS[hits],
  // the same odds at every price.
  const LOTTERY_PAYS = { 2: 1, 3: 20, 4: 200, 5: 2000, 6: 10_000 };
  const LOTTERY_MAX_TICKETS = 5;
  const choose = (n, k) => {
    let out = 1;
    for (let i = 1; i <= k; i++) out = (out * (n - k + i)) / i;
    return out;
  };
  const lotteryChance = (hits) => (choose(6, hits) * choose(43, 6 - hits)) / choose(49, 6);
  const lotteryAtLeast = (hits) => [3, 4, 5, 6].filter((h) => h >= hits).reduce((sum, h) => sum + lotteryChance(h), 0);
  // About 71.7 %: the lottery alone never pays, only its achievements do.
  const LOTTERY_RTP = Object.entries(LOTTERY_PAYS).reduce((sum, [hits, pay]) => sum + lotteryChance(Number(hits)) * pay, 0);

  // Lottery tickets worth buying for the next draw, or null: { price, tickets,
  // value }. Every ticket is valued at the achievements it can unlock times
  // their chance (3+, 4 and exactly 5 numbers), the first ticket of a draw at
  // the next draws-played tier spread over the draws it still needs, and the
  // fifth at the all-five achievement, against the ticket's expected loss.
  // Tickets go at the cheapest price: the rewards do not grow with it, the loss
  // does. ctx: mine (tickets already on this draw), prices (affordable prices).
  function lotteryPlan(player, ctx) {
    const price = Math.min(...(ctx.prices ?? []));
    const mine = ctx.mine ?? 0;
    const room = LOTTERY_MAX_TICKETS - mine;
    if (!Number.isFinite(price) || room <= 0) return null;
    const open = (key) => achievementTier(player, key) !== null;
    let perTicket = -price * (1 - LOTTERY_RTP);
    if (open('lottery_3')) perTicket += lotteryAtLeast(3) * achievementReward('lottery_3', 0);
    if (open('lottery_4')) perTicket += lotteryAtLeast(4) * achievementReward('lottery_4', 0);
    if (open('lottery_5')) perTicket += lotteryChance(5) * achievementReward('lottery_5', 0);
    let first = 0;
    const tier = achievementTier(player, 'lottery_days');
    if (!mine && tier !== null) {
      const played = player.achProgress?.lottery_days ?? player.stats?.lotteryDays ?? 0;
      const left = HUNT_ACHIEVEMENTS.lottery_days.tiers[tier] - played;
      if (left > 0) first = achievementReward('lottery_days', tier) / left;
    }
    const full = open('lottery_full') ? achievementReward('lottery_full', 0) : 0;
    let best = null;
    for (let n = 1; n <= room; n++) {
      const value = n * perTicket + first + (mine + n === LOTTERY_MAX_TICKETS ? full : 0);
      if (value > 0 && (!best || value > best.value)) best = { price, tickets: n, value };
    }
    return best;
  }

  // "Feeling lucky": the next lottery ticket bought whatever it is worth, or
  // null once the draw has the wanted number of tickets. It goes at the
  // biggest affordable price up to the wanted one. ctx: mine (tickets already
  // on this draw), prices (affordable prices), price and tickets (wanted).
  function luckyPlan(ctx) {
    const tickets = Math.min(ctx.tickets, LOTTERY_MAX_TICKETS);
    const price = Math.max(...(ctx.prices ?? []).filter((p) => p <= ctx.price));
    if (!Number.isFinite(price) || (ctx.mine ?? 0) >= tickets) return null;
    return { price, tickets: tickets - (ctx.mine ?? 0) };
  }

  // A switch for the lottery waits this long before a draw: the draw is
  // already running by the time the other account has loaded.
  const LOTTERY_CLOSE_MS = 2 * 60_000;

  // What a saved account still owes the shared rounds, judged from its saved
  // record: { crash, lottery }. rounds is what the bot last saw: crash
  // { startAt, openUntil } while entering the running round pays, lottery
  // { drawAt, minPrice } of the next draw. The record keeps crashRound (startAt
  // of the round it is in) and lotteryDraw / lotteryBought (the draw it has
  // finished buying for and the tickets it held then). One that finished a
  // draw with no tickets bought only for the hunt, which then had nothing worth
  // buying, is not due again unless "Feeling lucky" buys regardless.
  // ctx: { now, crash, lottery, lucky (switches), reserve, crashLevel,
  // lotteryLevel (unlocks), crashStake (smallest stake) }.
  function roundsDue(saved, rounds, ctx) {
    const level = saved.level ?? 0;
    const credits = saved.credits ?? 0;
    const crash = rounds?.crash;
    const draw = rounds?.lottery;
    return {
      crash: Boolean(
        ctx.crash &&
          crash &&
          ctx.now < crash.openUntil &&
          level >= ctx.crashLevel &&
          saved.crashRound !== crash.startAt &&
          credits - ctx.crashStake >= ctx.reserve,
      ),
      lottery: Boolean(
        ctx.lottery &&
          draw &&
          ctx.now < draw.drawAt - LOTTERY_CLOSE_MS &&
          level >= ctx.lotteryLevel &&
          saved.lotteryDraw !== draw.drawAt &&
          (ctx.lucky || saved.lotteryBought !== 0) &&
          credits - (draw.minPrice ?? 0) >= ctx.reserve,
      ),
    };
  }

  const LOTTERY_BALLS = 49;
  const LOTTERY_PICKS = 6;
  const LOTTERY_PICK_MODES = ['random', 'fixed', 'hot', 'cold'];

  // Six distinct numbers from 1 to 49 written on one line, separated by
  // spaces, commas or semicolons, sorted; null when the line is anything else.
  function parseTicket(line) {
    const parts = String(line).trim().split(/[\s,;]+/).filter(Boolean);
    const numbers = parts.map(Number);
    const valid =
      numbers.length === LOTTERY_PICKS &&
      numbers.every((n) => Number.isInteger(n) && n >= 1 && n <= LOTTERY_BALLS) &&
      new Set(numbers).size === LOTTERY_PICKS;
    return valid ? numbers.sort((a, b) => a - b) : null;
  }

  // The fixed tickets from the settings, one line per ticket in buying order:
  // [numbers | null] for up to five tickets, null for a blank or invalid line.
  const parseTickets = (text) =>
    String(text ?? '')
      .split('\n')
      .slice(0, LOTTERY_MAX_TICKETS)
      .map((line) => (line.trim() ? parseTicket(line) : null));

  // Numbers for ticket index (0 to 4) of a draw. random: six at random. fixed:
  // that ticket's line from the settings (ctx.tickets, see parseTickets), at
  // random when it has none. hot / cold: at random, weighted toward the numbers
  // drawn most / least often in the recent draws (ctx.history: [{ numbers }]).
  // Every ticket has the same odds whatever its numbers; this only picks them.
  function lotteryNumbers(mode, index, ctx = {}, random = Math.random) {
    const fixed = mode === 'fixed' ? ctx.tickets?.[index] : null;
    if (fixed) return [...fixed];
    const counts = new Array(LOTTERY_BALLS + 1).fill(0);
    for (const draw of ctx.history ?? []) for (const n of draw.numbers ?? []) if (n >= 1 && n <= LOTTERY_BALLS) counts[n]++;
    const most = Math.max(...counts);
    const weight = (n) => (mode === 'hot' ? 1 + counts[n] : mode === 'cold' ? 1 + most - counts[n] : 1);
    const pool = Array.from({ length: LOTTERY_BALLS }, (_, i) => i + 1);
    const out = [];
    while (out.length < LOTTERY_PICKS) {
      const total = pool.reduce((sum, n) => sum + weight(n), 0);
      let r = random() * total;
      let i = 0;
      while (i < pool.length - 1 && (r -= weight(pool[i])) >= 0) i++;
      out.push(pool.splice(i, 1)[0]);
    }
    return out.sort((a, b) => a - b);
  }

  // Konec kvartálu weekend: +50 % on the net profit of every round that ends
  // ahead, up to a weekend limit.
  const WINS_BONUS = 0.5;

  // House edges with the Konec kvartálu bonus on wins taken off: per credit a
  // round then loses edge minus winsBonus times gain (see edgePlan). A game
  // without a simulated gain keeps its plain edge.
  function bonusEdges(edges, gains, winsBonus) {
    if (!(winsBonus > 0)) return edges;
    return Object.fromEntries(Object.entries(edges).map(([game, edge]) => [game, edge - winsBonus * (gains?.[game] ?? 0)]));
  }

  // A round worth playing for its own expected profit, or null: the Konec
  // kvartálu bonus on wins, or a game whose model pays over 100 % by itself.
  // Per credit a round returns -edge plus winsBonus times gain (the mean net
  // profit per credit staked of the rounds that end ahead). The bet is sized
  // by fractional Kelly on that edge over the round's variance, the smallest
  // level always allowed. The pick is the biggest expected profit per round.
  // ctx: level, unlocks, edges, gains and variances per game, levels
  // (affordable bets, ascending), bankroll (credits above the reserve), kelly,
  // winsBonus (0 off the weekend or past its limit).
  function edgePlan(ctx) {
    const levels = ctx.levels ?? [];
    let best = null;
    for (const game of Object.keys(ctx.unlocks)) {
      const edge = ctx.edges[game];
      if (edge === undefined || ctx.level < ctx.unlocks[game]) continue;
      const ev = -edge + (ctx.winsBonus ?? 0) * (ctx.gains?.[game] ?? 0);
      if (!(ev > 0)) continue;
      const variance = ctx.variances?.[game] ?? 1;
      for (const bet of levels) {
        if (bet !== levels[0] && bet > (ev / variance) * ctx.kelly * ctx.bankroll) continue;
        const value = ev * bet;
        if (!best || value > best.value) best = { game, bet, ev, value };
      }
    }
    return best;
  }

  // Weekend events, one per weekend from Friday 17:00 to Monday 9:00 (Prague
  // time, when the sprint ends), in this order from the week of 2026-10-05:
  // Hackathon +50 % XP, Konec kvartálu +50 % on wins, Teambuilding double
  // wheel, Placené přesčasy double work pay and XP. Same rule as the client.
  const WEEKEND_EVENTS = ['xp', 'wins', 'wheel', 'overtime'];
  const WEEKEND_EPOCH = Date.parse('2026-10-05T12:00:00Z');
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const pragueDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(ms);
  const addDays = (day, n) => {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  function pragueOffset(ms) {
    const zone = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Prague', timeZoneName: 'shortOffset' })
      .formatToParts(new Date(ms))
      .find((part) => part.type === 'timeZoneName').value;
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(zone);
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) * 60_000 : 0;
  }
  // Moment of the given Prague hour on a Prague day (YYYY-MM-DD).
  function pragueAt(day, hour) {
    const [y, m, d] = day.split('-').map(Number);
    const local = Date.UTC(y, m - 1, d, hour);
    return local - pragueOffset(local - pragueOffset(local));
  }

  // Next Produkce padá deploy (a new round starts every day at 9:00 Prague
  // time) after now.
  function nextDeployAt(now = Date.now()) {
    const today = pragueAt(pragueDay(now), 9);
    return now < today ? today : pragueAt(addDays(pragueDay(now), 1), 9);
  }

  // Milliseconds to wait before retrying a request the server turned away for
  // going too fast, or null when the response is not that. A 429, a
  // Retry-After header or an error text about speed counts. The wait is the
  // Retry-After header (seconds or a date), else the body's retryAfterMs /
  // retryAfter (seconds), else doubling from 1 s, at most RATE_LIMIT_MAX_MS.
  const RATE_LIMIT_MAX_MS = 30_000;
  const RATE_LIMIT_TEXT = /rate|too.?(fast|many|soon)|slow|cooldown|throttl|rychl|počkej|zpomal|animac/i;
  function rateLimitWait(res, attempt = 0, now = Date.now()) {
    if (!res || res.ok || !res.status) return null;
    const text = `${res.data?.code ?? ''} ${res.data?.error ?? ''}`;
    if (res.status !== 429 && !res.retryAfter && !RATE_LIMIT_TEXT.test(text)) return null;
    let wait = NaN;
    if (res.retryAfter) {
      const seconds = Number(res.retryAfter);
      wait = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(res.retryAfter) - now;
    }
    if (!(wait >= 0) && Number.isFinite(Number(res.data?.retryAfterMs))) wait = Number(res.data.retryAfterMs);
    if (!(wait >= 0) && Number.isFinite(Number(res.data?.retryAfter))) wait = Number(res.data.retryAfter) * 1000;
    if (!(wait >= 0)) wait = 1000 * 2 ** attempt;
    return Math.min(RATE_LIMIT_MAX_MS, Math.max(250, wait));
  }

  // This week's event: { key, startAt, endAt, active }. A week runs from
  // Monday 9:00, like the sprint.
  function weekendEvent(now = Date.now()) {
    let day = pragueDay(now);
    if (now < pragueAt(day, 9)) day = addDays(day, -1);
    const monday = addDays(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
    const weeks = Math.round((Date.parse(`${monday}T12:00:00Z`) - WEEKEND_EPOCH) / WEEK_MS);
    const n = WEEKEND_EVENTS.length;
    const startAt = pragueAt(addDays(monday, 4), 17);
    const endAt = pragueAt(addDays(monday, 7), 9);
    return { key: WEEKEND_EVENTS[((weeks % n) + n) % n], startAt, endAt, active: now >= startAt && now < endAt };
  }

  // Before a weekend that pays work more (Placené přesčasy, Hackathon), work
  // waits while the energy it would spend refills to no more than the cap by
  // the start, so the start finds a full bar to work at the bonus. energyMs is
  // one point's refill time.
  function workHold(energy, maxEnergy, event, now, energyMs) {
    if ((event?.key !== 'overtime' && event?.key !== 'xp') || now >= event.startAt) return false;
    return energy + (event.startAt - now) / energyMs <= maxEnergy;
  }

  // A Hackathon weekend gives +50 % XP for everything, so XP bought with losing
  // rounds costs a third less then. In the week before it XP grinding holds.
  const grindHold = (event, now) => event.key === 'xp' && now < event.startAt;

  const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

  // Daily-limit budget and the loss counted against it. On a Hackathon weekend
  // the budgets held back during the week (grind.pool.held, credits per day)
  // and one for every weekend day are pooled against the weekend's loss
  // (grind.pool.net); the start day's own budget is already in held if it was
  // held. grind: the account's stats.grind.
  function grindBudget(grind, xpBudget, event, now) {
    if (!(event.active && event.key === 'xp')) {
      return { budget: xpBudget, lost: Math.max(0, -(grind.day === dayKey(now) ? grind.net : 0)) };
    }
    const pool = grind.pool?.startAt === event.startAt ? grind.pool : { held: {}, net: 0 };
    const start = dayKey(event.startAt);
    const days = daysBetween(start, dayKey(now)) + (start in pool.held ? 0 : 1);
    const held = Object.values(pool.held).reduce((sum, credits) => sum + credits, 0);
    return { budget: held + days * xpBudget, lost: Math.max(0, -pool.net) };
  }

  // Chance that a crash bet placed now reaches its own multiplier target,
  // from the round history like bestCrashTarget. A target past the planned
  // outage is paid at that level instead, so it never reaches the target.
  function crashHitChance(history, entry, rate, target) {
    const outcomes = (history ?? [])
      .map((round) => (round.planned ? Infinity : Number(round.mult)))
      .filter((mult) => (Number.isFinite(mult) || mult === Infinity) && mult > entry);
    if (outcomes.length < CRASH_MIN_HISTORY) return null;
    const production = (target * entry) / rate;
    if (production > CRASH_PLANNED_MULT) return 0;
    return outcomes.filter((mult) => mult >= production).length / outcomes.length;
  }

  // Whether a crash bet of stake at the achievement's 10x target pays on
  // average, counting the achievement reward on top of the payout.
  function crashHuntWorth(p, stake) {
    if (!(p > 0) || !(stake > 0)) return false;
    return p * (CRASH_ACHIEVEMENT_TARGET * stake + achievementReward('uptime_hero', 0)) > stake;
  }

  // Local calendar day, used to reset daily budgets and checks.
  function dayKey(now = Date.now()) {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  const api = {
    CRASH_PLANNED_MULT,
    crashMult,
    bestCrashTarget,
    crashStake,
    repayAmount,
    bankruptWorth,
    waitForLevel,
    sprintAtStake,
    sprintHold,
    loanSprintSafe,
    loanAmount,
    loanCycle,
    wheelReady,
    grindPlan,
    grindReport,
    cheapestGame,
    xpCost,
    grindBets,
    grindBet,
    grindAllowed,
    workDue,
    grindVolume,
    finalGame,
    pooledXpRate,
    planXpRate,
    levelUpCushion,
    UPGRADE_HORIZON_LEVELS,
    upgradeVerdict,
    shopGoal,
    spareUpgrade,
    MARGIN_LEVELS,
    MARGIN_SIGMAS,
    urgentAccount,
    pickAccount,
    questGame,
    questKind,
    standupPlan,
    CRASH_ACHIEVEMENT_TARGET,
    achievementTier,
    fridayEvening,
    HUNT_ROUNDS_TIERS,
    huntPlan,
    crashHitChance,
    crashHuntWorth,
    LOTTERY_RTP,
    lotteryChance,
    lotteryPlan,
    luckyPlan,
    roundsDue,
    LOTTERY_PICK_MODES,
    parseTicket,
    parseTickets,
    lotteryNumbers,
    nextDeployAt,
    rateLimitWait,
    WINS_BONUS,
    bonusEdges,
    edgePlan,
    weekendEvent,
    workHold,
    grindHold,
    grindBudget,
    dayKey,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterAuto = api;
})(globalThis);
