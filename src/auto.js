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

  const XP_SAMPLE_ROUNDS = 10;
  // The next bet level is still sampled while XP per credit wagered stays within
  // this share of the best so far, so measurement noise does not end the climb.
  const XP_LADDER_KEEP = 0.9;
  // A bigger bet within this share of the best XP per credit is preferred: about
  // the same loss per XP, but more XP per round.
  const XP_BIGGER_BET_SLACK = 0.98;

  // Measured bet ladder of one game: the best bet sampled so far, the next
  // level still to sample (null once XP per credit drops off) and the level
  // where it dropped off (null while the climb goes on).
  function betLadder(cells, levels) {
    let best = null;
    let top = 0;
    for (const bet of levels) {
      const cell = cells?.[bet];
      if (!cell || cell.rounds < XP_SAMPLE_ROUNDS) return { best, next: bet, stop: null };
      const perRound = cell.xp / cell.rounds;
      const perCredit = perRound / bet;
      if (best && perCredit < top * XP_LADDER_KEEP) return { best, next: null, stop: bet };
      top = Math.max(top, perCredit);
      if (perCredit >= top * XP_BIGGER_BET_SLACK) best = { bet, perRound };
    }
    return { best, next: null, stop: null };
  }

  // House edge of a game measured from its tracked rounds (0 when it is ahead).
  const gameEdge = (row) => (row?.wagered > 0 ? Math.max(0, -row.net) / row.wagered : null);

  // Cheapest game and bet per XP point. The loss per XP of a bet is the game's
  // house edge times bet / XP per round: the edge is measured per game (it does
  // not depend on the bet), XP per round per bet level, since the server's XP
  // formula is unknown. Games with fewer than minRounds tracked rounds are
  // explored first at the smallest bet. Then the leading game climbs its bet
  // ladder while XP per credit wagered keeps up, so a flat XP per round costs
  // only one sample at the next level. bets are the levels allowed right now;
  // betXp is { game: { bet: { rounds, xp } } }.
  function grindPlan(games, bets, level, stats, betXp, unlocks, minRounds = 30) {
    const unlocked = games.filter((game) => level >= unlocks[game]);
    const levels = [...bets].sort((a, b) => a - b);
    if (!unlocked.length || !levels.length) return null;
    const rounds = (game) => stats[game]?.rounds ?? 0;
    const unexplored = unlocked.filter((game) => rounds(game) < minRounds);
    if (unexplored.length) {
      return { game: unexplored.reduce((a, b) => (rounds(b) < rounds(a) ? b : a)), bet: levels[0] };
    }

    const ladders = unlocked.map((game) => ({ game, ...betLadder(betXp?.[game], levels) }));
    const unsampled = ladders.find((ladder) => !ladder.best);
    if (unsampled) return { game: unsampled.game, bet: unsampled.next };

    const cost = ({ game, best }) => {
      const edge = gameEdge(stats[game]) ?? 0;
      return best.perRound > 0 ? (edge * best.bet) / best.perRound : Infinity;
    };
    const better = (a, b) => cost(b) < cost(a) || (cost(b) === cost(a) && b.best.perRound > a.best.perRound);
    const lead = ladders.reduce((a, b) => (better(a, b) ? b : a));
    return { game: lead.game, bet: lead.next ?? lead.best.bet };
  }

  // What the XP grinder has measured, per game, for the panel: the edge, the
  // average XP per round and, per bet level, the sampled rounds, XP per round,
  // credits lost per XP point and where the level stands on the bet ladder:
  // 'best', 'next' (being sampled), 'worse' (XP per credit dropped off there),
  // 'skipped' (above that, never tried) or null.
  function grindReport(games, levels, level, stats, betXp, unlocks) {
    const sorted = [...levels].sort((a, b) => a - b);
    return games.map((game) => {
      const row = stats[game];
      const edge = gameEdge(row);
      const ladder = betLadder(betXp?.[game], sorted);
      const bets = sorted.map((bet) => {
        const cell = betXp?.[game]?.[bet];
        const rounds = cell?.rounds ?? 0;
        const perRound = rounds > 0 ? cell.xp / rounds : null;
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
        perRound: rounds > 0 ? row.xp / rounds : null,
        bets,
      };
    });
  }

  // Bet levels XP grinding may use now: allowed by the limits, and under a daily
  // budget no bigger than what is left of it, so one lost round cannot overshoot.
  function grindBets(settings, credits, lostToday, levels) {
    return levels.filter(
      (bet) =>
        grindAllowed(settings, credits, lostToday, bet) &&
        (settings.grindLimit === 'balance' || bet <= settings.xpBudget - lostToday),
    );
  }

  // Whether XP grinding may place another bet. The limit is either a daily loss
  // budget or a minimum account balance, 0 turns the chosen one off, and the
  // reserve applies on top of both.
  function grindAllowed(settings, credits, lostToday, bet) {
    const after = credits - bet;
    if (after < settings.reserve) return false;
    if (settings.grindLimit === 'balance') return settings.grindMinBalance > 0 && after >= settings.grindMinBalance;
    return settings.xpBudget > 0 && lostToday < settings.xpBudget;
  }

  // Account to switch to once the current one has nothing left to do. Each
  // candidate is { id, seenAt, seenDay, energy, normDone }. One not visited
  // today goes first (its daily bonus and checks are waiting), otherwise the one
  // with the most refilled energy, if it has at least minEnergy.
  function pickAccount(candidates, today, minEnergy) {
    const fresh = candidates.filter((a) => a.seenDay !== today);
    if (fresh.length) return fresh.reduce((a, b) => (b.seenAt < a.seenAt ? b : a)).id;
    const ready = candidates.filter((a) => !a.normDone && a.energy >= minEnergy);
    if (!ready.length) return null;
    return ready.reduce((a, b) => (b.energy > a.energy ? b : a)).id;
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
    grindPlan,
    grindReport,
    grindBets,
    grindAllowed,
    pickAccount,
    dayKey,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterAuto = api;
})(globalThis);
