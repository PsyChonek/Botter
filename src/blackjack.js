// Exact infinite-deck blackjack solver for the casino's rule set: hit, stand
// and double only (no split, no surrender), dealer hole card resolved at the
// end, ties push only from a minimum total, blackjack pay set by upgrades.
// Classic script: globalThis.BotterBlackjack in the extension, require() in Node.
(function (root) {
  // Card values 2..11 (11 = ace) with infinite-deck probabilities.
  const CARDS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((v) => [v, v === 10 ? 4 / 13 : 1 / 13]);

  // Same mapping as the shop: levels index into these tables.
  const BJ_PAY = [1, 1.2, 1.5];
  const PUSH_FROM = [22, 21, 20, 19, 18];

  const clampLevel = (upgrades, key, max) => Math.max(0, Math.min(max, upgrades?.[key] ?? 0));

  function rulesFromUpgrades(upgrades) {
    return {
      bjPay: BJ_PAY[clampLevel(upgrades, 'bjpay', 2)],
      pushFrom: PUSH_FROM[clampLevel(upgrades, 'ties', 4)],
      dealerHitsSoft17: !clampLevel(upgrades, 'soft17', 1),
      doubleAny: !!clampLevel(upgrades, 'double', 1),
    };
  }

  function add(total, soft, card) {
    let t = total + card;
    let s = soft + (card === 11 ? 1 : 0);
    while (t > 21 && s > 0) {
      t -= 10;
      s -= 1;
    }
    return [t, s];
  }

  // Final dealer outcome distribution for an upcard: keys 17..21, 'bust', 'bj'.
  function dealerOutcomes(upcard, hitSoft17) {
    const out = { 17: 0, 18: 0, 19: 0, 20: 0, 21: 0, bust: 0, bj: 0 };
    const draw = (total, soft, cards, p) => {
      if (total > 21) return void (out.bust += p);
      if (cards === 2 && total === 21) return void (out.bj += p);
      const mustHit = total < 17 || (total === 17 && soft > 0 && hitSoft17);
      if (!mustHit) return void (out[total] += p);
      for (const [card, q] of CARDS) {
        const [t, s] = add(total, soft, card);
        draw(t, s, cards + 1, p * q);
      }
    };
    const [t, s] = add(0, 0, upcard);
    draw(t, s, 1, 1);
    return out;
  }

  function createSolver(rules) {
    const dealer = new Map(CARDS.map(([up]) => [up, dealerOutcomes(up, rules.dealerHitsSoft17)]));
    const memo = new Map();

    function standEV(total, up) {
      const d = dealer.get(up);
      let ev = -d.bj + d.bust;
      for (let dt = 17; dt <= 21; dt++) {
        if (total > dt) ev += d[dt];
        else if (total < dt) ev -= d[dt];
        else if (total < rules.pushFrom) ev -= d[dt];
      }
      return ev;
    }

    // Best EV of a hand that may only hit or stand from here.
    function playEV(total, soft, up) {
      const key = `${total}|${soft}|${up}`;
      if (memo.has(key)) return memo.get(key);
      let hit = 0;
      for (const [card, q] of CARDS) {
        const [t, s] = add(total, soft, card);
        hit += q * (t > 21 ? -1 : playEV(t, s, up));
      }
      const ev = Math.max(standEV(total, up), hit);
      memo.set(key, ev);
      return ev;
    }

    function hitEV(total, soft, up) {
      let ev = 0;
      for (const [card, q] of CARDS) {
        const [t, s] = add(total, soft, card);
        ev += q * (t > 21 ? -1 : playEV(t, s, up));
      }
      return ev;
    }

    function doubleEV(total, soft, up) {
      let ev = 0;
      for (const [card, q] of CARDS) {
        const [t, s] = add(total, soft, card);
        ev += q * (t > 21 ? -2 : 2 * standEV(t, up));
      }
      return ev;
    }

    const canDouble = (total, soft) => rules.doubleAny || (soft === 0 && total >= 9 && total <= 11);

    // EV of every action available for a hand, per unit bet.
    function actions(total, soft, up, firstTwo) {
      const result = { stand: standEV(total, up), hit: hitEV(total, soft, up) };
      if (firstTwo && canDouble(total, soft)) result.double = doubleEV(total, soft, up);
      return result;
    }

    function best(total, soft, up, firstTwo) {
      const options = actions(total, soft, up, firstTwo);
      return Object.entries(options).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
    }

    // Expected return per unit bet over a whole round.
    function houseEdge() {
      let ev = 0;
      for (const [c1, p1] of CARDS) {
        for (const [c2, p2] of CARDS) {
          const [t, s] = add(...add(0, 0, c1), c2);
          for (const [up, pu] of CARDS) {
            const p = p1 * p2 * pu;
            const d = dealer.get(up);
            if (t === 21) {
              // Natural: dealer natural ties, which pushes only if 21 qualifies.
              const tie = rules.pushFrom <= 21 ? 0 : -1;
              ev += p * (d.bj * tie + (1 - d.bj) * rules.bjPay);
            } else {
              const o = actions(t, s, up, true);
              ev += p * Math.max(...Object.values(o));
            }
          }
        }
      }
      return ev;
    }

    return { actions, best, houseEdge };
  }

  function handState(cards) {
    let total = 0;
    let soft = 0;
    for (const { rank } of cards) {
      const v = rank === 'A' ? 11 : ['K', 'Q', 'J', 'T', '10'].includes(rank) ? 10 : Number(rank);
      [total, soft] = add(total, soft, v);
    }
    return [total, soft];
  }

  const solvers = new Map();
  function solverFor(rules) {
    const key = JSON.stringify(rules);
    if (!solvers.has(key)) solvers.set(key, createSolver(rules));
    return solvers.get(key);
  }

  // Best action for an open hand from the server ({player, dealer, canDouble, bet}).
  function decide(hand, rules, credits) {
    const [total, soft] = handState(hand.player);
    const up = handState(hand.dealer.slice(0, 1))[0];
    const solver = solverFor(rules);
    const firstTwo = hand.player.length === 2 && hand.canDouble !== false && credits >= (hand.bet ?? 0);
    return solver.best(total, soft, up, firstTwo);
  }

  const api = { rulesFromUpgrades, dealerOutcomes, createSolver, solverFor, handState, decide };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterBlackjack = api;
})(globalThis);
