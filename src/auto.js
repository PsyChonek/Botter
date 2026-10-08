// Pure decision helpers for the full auto mode: crash betting from the round
// history, debt repayment and choosing the cheapest game to grind XP on.
// Classic script: globalThis.BotterAuto in the extension, require() in Node.
(function (root) {
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
  const SPRINT_PRIZES = [10_000, 5_000, 2_500];
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
  // snapshot from before the wheel existed has no field and is not ready.
  const wheelReady = (wheelNextAt, now = Date.now()) =>
    wheelNextAt !== undefined && (wheelNextAt === null || wheelNextAt <= now);

  const XP_SAMPLE_ROUNDS = 10;
  // The next bet level is still sampled while XP per credit wagered stays within
  // this share of the best so far, so measurement noise does not end the climb.
  const XP_LADDER_KEEP = 0.9;
  // The smallest bet within this share of the best XP per credit is preferred:
  // about the same loss per XP, with less riding on each round.
  const XP_SIMILAR = 0.95;

  // Bets above this are not sampled: XP per round looks proportional to the bet
  // there, so it is scaled up from the biggest sampled level.
  const XP_SAMPLE_MAX_BET = 100;

  // Measured bet ladder of one game: the best bet so far (the smallest within
  // XP_SIMILAR of the top XP per credit), the next level still to sample (null
  // once XP per credit drops off), the level where it dropped off (null while
  // the climb goes on) and XP per round per level reached, measured up to
  // XP_SAMPLE_MAX_BET and scaled with the bet above it.
  function betLadder(cells, levels) {
    const reached = [];
    let top = 0;
    let last = null;
    const rates = {};
    const ladder = (next, stop) => {
      const pick = reached.find((r) => r.perRound / r.bet >= top * XP_SIMILAR);
      const best = pick ? { bet: pick.bet, perRound: pick.perRound } : null;
      return { best, next, stop, rates };
    };
    for (const bet of levels) {
      let perRound;
      if (bet > XP_SAMPLE_MAX_BET && last) {
        perRound = (last.perRound * bet) / last.bet;
      } else {
        const cell = cells?.[bet];
        if (!cell || cell.rounds < XP_SAMPLE_ROUNDS) return ladder(bet, null);
        perRound = cell.xp / cell.rounds;
        last = { bet, perRound };
      }
      rates[bet] = perRound;
      const perCredit = perRound / bet;
      if (reached.length && perCredit < top * XP_LADDER_KEEP) return ladder(null, bet);
      top = Math.max(top, perCredit);
      reached.push({ bet, perRound });
    }
    return ladder(null, null);
  }

  // Whether a bigger max bet would buy XP cheaper on this game: its bet ladder
  // is done and settled on the biggest allowed level, so XP per credit was still
  // rising there. From XP_SAMPLE_MAX_BET up XP per round is proportional to the
  // bet, so a bigger bet costs the same per XP and only risks more per round.
  function biggerBetPays(cells, levels) {
    const top = levels.at(-1);
    if (top === undefined || top >= XP_SAMPLE_MAX_BET) return false;
    const ladder = betLadder(cells, levels);
    return ladder.next === null && ladder.stop === null && ladder.best?.bet === top;
  }

  // House edge of a game measured from its tracked rounds (0 when it is ahead).
  const gameEdge = (row) => (row?.wagered > 0 ? Math.max(0, -row.net) / row.wagered : null);

  // House edge the grinder plans with: the model at the current upgrades
  // (edges, from BotterOdds) when the game has one, since a few dozen rounds of
  // a slot say little about its edge, otherwise the measured one.
  const planEdge = (game, stats, edges) => edges?.[game] ?? gameEdge(stats[game]);

  // Cheapest game and bet per XP point. The loss per XP of a bet is the game's
  // house edge times bet / XP per round: the edge does not depend on the bet,
  // XP per round is measured per bet level, since the server's XP formula is
  // unknown. Games without a modelled edge and fewer than minRounds tracked
  // rounds are explored first at the smallest bet. Then every game climbs its
  // bet ladder while XP per credit wagered keeps up, so a flat XP per round
  // costs only one sample at the next level, and games are compared at their
  // best bets: one measured at 20 and another at 100 would not compare fairly.
  // bets are the levels allowed right now; betXp is { game: { bet: { rounds, xp } } }.
  function grindPlan(games, bets, level, stats, betXp, unlocks, edges = {}, minRounds = 30) {
    const unlocked = games.filter((game) => level >= unlocks[game]);
    const levels = [...bets].sort((a, b) => a - b);
    if (!unlocked.length || !levels.length) return null;
    const rounds = (game) => stats[game]?.rounds ?? 0;
    const unexplored = unlocked.filter((game) => edges?.[game] === undefined && rounds(game) < minRounds);
    if (unexplored.length) {
      return { game: unexplored.reduce((a, b) => (rounds(b) < rounds(a) ? b : a)), bet: levels[0] };
    }

    const ladders = unlocked.map((game) => ({ game, ...betLadder(betXp?.[game], levels) }));
    const climbing = ladders.find((ladder) => ladder.next !== null);
    if (climbing) return { game: climbing.game, bet: climbing.next };

    const cost = ({ game, best }) => {
      const edge = planEdge(game, stats, edges) ?? 0;
      return best.perRound > 0 ? (edge * best.bet) / best.perRound : Infinity;
    };
    const better = (a, b) => cost(b) < cost(a) || (cost(b) === cost(a) && b.best.bet < a.best.bet);
    const lead = ladders.reduce((a, b) => (better(a, b) ? b : a));
    return { game: lead.game, bet: lead.best.bet };
  }

  // What the XP grinder has measured, per game, for the panel: the measured
  // and the modelled edge, the average XP per round and, per bet level, the
  // sampled rounds, XP per round (scaled up above XP_SAMPLE_MAX_BET), credits
  // lost per XP point (from the edge the grinder plans with) and where the level stands on the bet ladder: 'best',
  // 'next' (being sampled), 'worse' (XP per credit dropped off there),
  // 'skipped' (above that, never tried) or null.
  function grindReport(games, levels, level, stats, betXp, unlocks, edges = {}) {
    const sorted = [...levels].sort((a, b) => a - b);
    return games.map((game) => {
      const row = stats[game];
      const edge = planEdge(game, stats, edges);
      const ladder = betLadder(betXp?.[game], sorted);
      // Levels above the sampled ones are listed once the ladder has scaled them.
      const shown = sorted.filter((bet) => bet <= XP_SAMPLE_MAX_BET || ladder.rates[bet] !== undefined);
      const bets = shown.map((bet) => {
        const cell = betXp?.[game]?.[bet];
        const rounds = cell?.rounds ?? 0;
        const perRound = ladder.rates[bet] ?? (rounds > 0 ? cell.xp / rounds : null);
        const cost = edge !== null && perRound > 0 ? (edge * bet) / perRound : null;
        let state = null;
        if (bet === ladder.best?.bet) state = 'best';
        else if (bet === ladder.next) state = 'next';
        else if (bet === ladder.stop) state = 'worse';
        else if (ladder.stop !== null && bet > ladder.stop) state = 'skipped';
        return { bet, rounds, perRound, cost, state };
      });
      const rounds = row?.rounds ?? 0;
      return {
        game,
        locked: level < unlocks[game],
        unlock: unlocks[game],
        rounds,
        edge,
        measuredEdge: gameEdge(row),
        modelEdge: edges?.[game] ?? null,
        perRound: rounds > 0 ? row.xp / rounds : null,
        bets,
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

  // Credits the grinder expects to lose while an upgrade has to pay off: the
  // daily budget over the horizon, what is above the minimum balance, or with
  // the limit off what is above the reserve.
  function grindVolume(settings, credits) {
    if (settings.grindLimit === 'off') return Math.max(0, credits - settings.reserve);
    if (settings.grindLimit === 'balance') return Math.max(0, credits - settings.grindMinBalance);
    return Math.max(0, settings.xpBudget) * UPGRADE_HORIZON_DAYS;
  }

  // Why an upgrade from the shop plan is not worth its price, or null when it is.
  // ctx: games (unlocked games the grinder may pick), upgrades, betXp, levels
  // (bet levels allowed now), edge(game, upgrades) (modelled house edge or null),
  // rest(keys, upTo) ({ price, upgrades } after buying those upgrades of the
  // offer's game up to level upTo, default max), maxLevels ({ key: max } of the
  // game), volume (see grindVolume), betGame (the game the grinder plays, or
  // null), betWanted (a fixed grind or crash bet asks for more than the max bet)
  // and crashOn (crash betting is on).
  // Credits spent on upgrades are not there to grind with, so they are bought
  // only if the XP from the remaining volume at the cheaper cost beats the XP
  // from the whole volume at today's best cost. That is checked for the next
  // levels of this upgrade alone (a cheap first level can pay back on its own)
  // and for every worthwhile upgrade of the game maxed together.
  function upgradeVerdict(offer, ctx) {
    const { game } = offer;
    if (game === 'global') {
      const pays = ctx.betWanted || (ctx.betGame !== null && biggerBetPays(ctx.betXp?.[ctx.betGame], ctx.levels));
      return pays ? null : 'noBetGain';
    }
    if (game === 'crash') return ctx.crashOn ? null : 'crashOff';
    const now = (g) => ctx.edge(g, ctx.upgrades);
    if (now(game) === null) return null;
    if (!ctx.games.includes(game)) return 'notGrinded';

    const gainPerCredit = (keys) => {
      const rest = ctx.rest(keys);
      return rest.price > 0 ? (now(game) - ctx.edge(game, rest.upgrades)) / rest.price : 0;
    };
    if (gainPerCredit([offer.key]) < UPGRADE_MIN_GAIN) return 'tooSmall';
    const keys = Object.keys(ctx.maxLevels);

    // XP per credit wagered of each game's best measured bet. Until every game
    // has one, costs compare by edge alone (same XP per credit everywhere).
    const rates = Object.fromEntries(
      ctx.games.map((g) => {
        const best = betLadder(ctx.betXp?.[g], ctx.levels).best;
        return [g, best && best.perRound > 0 ? best.perRound / best.bet : null];
      }),
    );
    const useRates = Object.values(rates).every((r) => r !== null);
    const cost = (g, edge) => (useRates ? edge / rates[g] : edge);
    const before = Math.min(...ctx.games.map((g) => (now(g) === null ? Infinity : cost(g, now(g)))));
    const maxed = ctx.rest(keys.filter((key) => gainPerCredit([key]) >= UPGRADE_MIN_GAIN));
    if (cost(game, ctx.edge(game, maxed.upgrades)) >= before) return 'neverBest';
    const pays = (rest) => {
      const after = Math.min(before, cost(game, ctx.edge(game, rest.upgrades)));
      if (after <= 0) return true; // the player is ahead: it pays for itself
      return (ctx.volume - rest.price) / after > ctx.volume / before;
    };
    const steps = [];
    for (let upTo = offer.next; upTo <= ctx.maxLevels[offer.key]; upTo++) steps.push(ctx.rest([offer.key], upTo));
    return [...steps, maxed].some(pays) ? null : 'xpFarmingBetter';
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

  // Account with free credits waiting, worth leaving even a busy one for: one
  // not visited today (its daily bonus and checks are waiting), then one whose
  // free wheel spin is ready, longest unseen first. Null when there is none.
  function urgentAccount(candidates, today) {
    const oldest = (list) => list.reduce((a, b) => (b.seenAt < a.seenAt ? b : a)).id;
    const fresh = candidates.filter((a) => a.seenDay !== today);
    if (fresh.length) return oldest(fresh);
    const spin = candidates.filter((a) => a.wheel);
    if (spin.length) return oldest(spin);
    return null;
  }

  // Account to switch to once the current one has nothing left to do. Each
  // candidate is { id, seenAt, seenDay, energy, normDone, credits, canGrind,
  // wheel }. An urgent one goes first (see urgentAccount). Away from the home
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
    crash: /produkce|crash/,
  };

  // Game a quest is tied to, from its key or its text, or null for any game.
  function questGame(quest) {
    const words = String(quest?.key ?? '').toLowerCase().split(/[^a-z]+/);
    const text = String(quest?.text ?? '').toLowerCase();
    const game = Object.keys(QUEST_GAMES).find((g) => words.includes(g) || QUEST_GAMES[g].test(text));
    return game ?? null;
  }

  // 'rounds' (play N rounds of a game), 'wager' (wager N credits), 'wins'
  // (finish N rounds ahead), or null for a quest the bot cannot play, such as
  // an amount won.
  function questKind(quest) {
    const text = `${quest?.key ?? ''} ${quest?.text ?? ''}`.toLowerCase();
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
  // biggest one that does not overshoot what is left.
  function questCost(kind, game, left, edge, levels, wins) {
    const house = Math.max(0, edge);
    const min = levels[0];
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
  // share of rounds that end ahead }, optional) and levels (bet levels
  // affordable now). skipped collects the quests that are not worth it.
  function standupPlan(quests, ctx, skipped = []) {
    const levels = [...(ctx.levels ?? [])].sort((a, b) => a - b);
    let best = null;
    for (const quest of quests ?? []) {
      const left = Math.max(0, (quest.target ?? 0) - (quest.progress ?? 0));
      if (quest.done || !(left > 0)) continue;
      const kind = questKind(quest);
      const only = questGame(quest);
      const games = (only ? [only] : Object.keys(ctx.unlocks)).filter(
        (g) => ctx.unlocks[g] !== undefined && ctx.level >= ctx.unlocks[g] && ctx.edges[g] !== undefined,
      );
      if (!kind || !games.length || !levels.length) {
        skipped.push({ key: quest.key, reason: !kind ? 'unknown' : !games.length ? 'noGame' : 'noCredits' });
        continue;
      }
      const plan = games
        .map((game) => ({ game, ...questCost(kind, game, left, ctx.edges[game], levels, ctx.wins) }))
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
  const HUNT_ACHIEVEMENTS = {
    zero_hero: { reward: 1000 }, // win a roulette bet on a zero
    uptime_hero: { reward: 2000 }, // cash out a crash bet at 10x or more
    natural: { reward: 300 }, // blackjack from the first two cards
    five_cards: { reward: 1000 }, // win a blackjack hand with five or more cards
    night_owl: { reward: 300 }, // play between 2:00 and 5:00
    regular: { reward: [1000, 5000, 25000], tiers: [1000, 10_000, 100_000] }, // rounds played
    friday_deploy: { reward: 200 }, // work on Friday after 17:00
    speedy: { reward: 200 }, // a right answer within 3 seconds
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

  // Next game round worth playing for achievements, or null. Every round is
  // valued at the rewards it can unlock times their chance: a natural and a
  // five-card win per blackjack hand, a straight bet on 0 per roulette spin,
  // any round at night, and the next rounds-played tier spread over the rounds
  // it still needs (finishing it costs those rounds, so a round is worth the
  // reward over that count). A round is played when that beats its expected
  // loss, on the game where the margin is biggest, at the smallest bet.
  // ctx: level, unlocks, edges (house edge per game), levels (affordable bet
  // levels), now.
  function huntPlan(player, ctx) {
    const bet = Math.min(...(ctx.levels ?? []));
    if (!Number.isFinite(bet)) return null;
    const now = ctx.now ?? Date.now();
    const open = (key) => achievementTier(player, key) !== null;

    const shared = [];
    if (open('night_owl') && nightHours(now)) shared.push({ key: 'night_owl', value: achievementReward('night_owl', 0) });
    const tier = achievementTier(player, 'regular');
    const left = tier === null ? 0 : HUNT_ACHIEVEMENTS.regular.tiers[tier] - (player.totalSpins ?? Infinity);
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
      if (game === 'roulette' && open('zero_hero')) {
        // A straight bet pays 36 like the outside bets, so it has the same edge.
        const pockets = 36 / (1 - edge);
        own.push({ key: 'zero_hero', value: achievementReward('zero_hero', 0) / pockets });
        spot = ROULETTE_ZERO_SPOT;
      }
      const targets = [...shared, ...own];
      if (!targets.length) continue;
      const value = targets.reduce((sum, t) => sum + t.value, 0);
      const loss = bet * Math.max(0, edge);
      if (value <= loss) continue;
      const plan = { game, bet, spot, targets: targets.map((t) => t.key), value, loss };
      if (!best || value - loss > best.value - best.loss) best = plan;
    }
    return best;
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
    grindBets,
    grindAllowed,
    workDue,
    grindVolume,
    upgradeVerdict,
    urgentAccount,
    pickAccount,
    questGame,
    questKind,
    standupPlan,
    CRASH_ACHIEVEMENT_TARGET,
    achievementTier,
    fridayEvening,
    huntPlan,
    crashHitChance,
    crashHuntWorth,
    dayKey,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterAuto = api;
})(globalThis);
