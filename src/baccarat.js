// Bakarat (from level 20): punto banco with the casino's commission rules,
// solved exactly on an infinite deck. The client shows the table's pays: Hráč
// 1:1 less the management cut, Bankéř 1:1 less the cut plus 5 %, remíza 8:1,
// each pair 10:1; on a tie the Hráč and Bankéř bets get half back, or all
// with the Smírčí řízení upgrade. The deal is drawn on the server, so the
// standard drawing rules and an infinite deck are assumptions the recorded
// hands check (addHand). Classic script: globalThis.BotterBaccarat in the
// extension, require() in Node.
(function (root) {
  // Same mapping as the shop: Vyjednaná provize levels index into CUTS.
  const CUTS = [0.08, 0.06, 0.04, 0.025];
  const BANKER_EXTRA = 0.05;
  const TIE_PAYS = 8;
  const PAIR_PAYS = 10;
  const SPOTS = ['player', 'banker', 'tie', 'ppair', 'bpair'];
  // Ranks in the order the server names them; points are the rank mod 10.
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const points = (rank) => (rank === 'A' ? 1 : ['10', 'J', 'Q', 'K'].includes(rank) ? 0 : Number(rank));
  const total = (cards) => cards.reduce((sum, card) => sum + points(card.rank), 0) % 10;

  const clampLevel = (upgrades, key, max) => Math.max(0, Math.min(max, upgrades?.[key] ?? 0));
  const rulesFromUpgrades = (upgrades) => ({
    commission: CUTS[clampLevel(upgrades, 'cut', CUTS.length - 1)],
    tieBack: clampLevel(upgrades, 'push', 1) ? 1 : 0.5,
  });

  // Whether the banker draws a third card, by the standard tableau: on 0-2
  // always, on 3-6 by the player's third card (null when the player stood),
  // never on 7.
  function bankerDraws(banker, third) {
    if (third === null) return banker <= 5;
    if (banker <= 2) return true;
    if (banker === 3) return third !== 8;
    if (banker === 4) return third >= 2 && third <= 7;
    if (banker === 5) return third >= 4 && third <= 7;
    if (banker === 6) return third === 6 || third === 7;
    return false;
  }

  // Which cards the rules deal from the first four: { playerDraws, bankerDraws
  // (given the player's third card's points, null if none) }.
  function deal(player2, banker2) {
    const natural = player2 >= 8 || banker2 >= 8;
    return { natural, playerDraws: !natural && player2 <= 5 };
  }

  // Exact chance of each winner on an infinite deck, where a card's points are
  // 0 with 4/13 (10, J, Q, K) and 1 to 9 with 1/13 each. A pair (first two
  // cards of one hand of the same rank) is 1/13 whatever the outcome.
  let outcomeCache = null;
  function outcomes() {
    if (outcomeCache) return outcomeCache;
    const p = Array.from({ length: 10 }, (_, v) => (v === 0 ? 4 / 13 : 1 / 13));
    const out = { player: 0, banker: 0, tie: 0 };
    for (let a = 0; a < 10; a++) for (let b = 0; b < 10; b++) for (let c = 0; c < 10; c++) for (let d = 0; d < 10; d++) {
      const w4 = p[a] * p[b] * p[c] * p[d];
      const pl = (a + b) % 10;
      const bk = (c + d) % 10;
      const { natural, playerDraws } = deal(pl, bk);
      const settle = (pt, bt, w) => {
        out[pt > bt ? 'player' : bt > pt ? 'banker' : 'tie'] += w;
      };
      if (natural) {
        settle(pl, bk, w4);
        continue;
      }
      if (playerDraws) {
        for (let e = 0; e < 10; e++) {
          const pt = (pl + e) % 10;
          if (bankerDraws(bk, e)) for (let f = 0; f < 10; f++) settle(pt, (bk + f) % 10, w4 * p[e] * p[f]);
          else settle(pt, bk, w4 * p[e]);
        }
      } else if (bankerDraws(bk, null)) {
        for (let f = 0; f < 10; f++) settle(pl, (bk + f) % 10, w4 * p[f]);
      } else settle(pl, bk, w4);
    }
    outcomeCache = out;
    return out;
  }
  const PAIR_CHANCE = 1 / 13;

  // What one credit on a spot returns for a winner and a pair flag, by the
  // client's pays (stake included).
  function spotReturn(spot, winner, pair, rules) {
    if (spot === 'ppair' || spot === 'bpair') return pair ? 1 + PAIR_PAYS : 0;
    if (spot === 'tie') return winner === 'tie' ? 1 + TIE_PAYS : 0;
    if (winner === 'tie') return rules.tieBack;
    if (winner !== spot) return 0;
    return 2 - rules.commission - (spot === 'banker' ? BANKER_EXTRA : 0);
  }

  // Return to player of one spot at these upgrades, and the distribution of a
  // credit's return: [[return, chance], ...].
  function spotDistribution(spot, upgrades) {
    const rules = rulesFromUpgrades(upgrades);
    if (spot === 'ppair' || spot === 'bpair') return [[1 + PAIR_PAYS, PAIR_CHANCE], [0, 1 - PAIR_CHANCE]];
    const odds = outcomes();
    const merged = new Map();
    for (const winner of ['player', 'banker', 'tie']) {
      const r = spotReturn(spot, winner, false, rules);
      merged.set(r, (merged.get(r) ?? 0) + odds[winner]);
    }
    return [...merged];
  }

  const spotRtp = (spot, upgrades) => spotDistribution(spot, upgrades).reduce((sum, [r, p]) => sum + r * p, 0);

  // The even-money spot with the best return: Bankéř wins more often but pays
  // 5 % less, which leaves it a little ahead of Hráč at every cut.
  const bestSpot = (upgrades) => (spotRtp('banker', upgrades) >= spotRtp('player', upgrades) ? 'banker' : 'player');

  // Payout the client's rules give these bets on a dealt hand ({ player,
  // banker: [{ rank }], winner }), or null without the cards.
  function payout(bets, hand, upgrades) {
    if (!Array.isArray(hand?.player) || !Array.isArray(hand?.banker)) return null;
    const rules = rulesFromUpgrades(upgrades);
    const winner = winnerOf(hand);
    const pairs = {
      ppair: hand.player[0]?.rank === hand.player[1]?.rank,
      bpair: hand.banker[0]?.rank === hand.banker[1]?.rank,
    };
    let paid = 0;
    for (const [spot, amount] of Object.entries(bets ?? {})) {
      if (!SPOTS.includes(spot)) return null;
      paid += amount * spotReturn(spot, winner, pairs[spot] ?? false, rules);
    }
    return paid;
  }

  const winnerOf = (hand) => {
    const p = total(hand.player);
    const b = total(hand.banker);
    return p > b ? 'player' : b > p ? 'banker' : 'tie';
  };

  // Whether the cards were dealt by the standard tableau: the player draws on
  // 0-5 and the banker by bankerDraws, nobody on a natural 8 or 9.
  function dealtByRules(hand) {
    const [p1, p2, p3] = hand.player;
    const [b1, b2, b3] = hand.banker;
    if (!p1 || !p2 || !b1 || !b2) return false;
    const pl = total([p1, p2]);
    const bk = total([b1, b2]);
    const { natural, playerDraws } = deal(pl, bk);
    if (natural) return !p3 && !b3;
    if (playerDraws !== !!p3) return false;
    return bankerDraws(bk, p3 ? points(p3.rank) : null) === !!b3;
  }

  // Baccarat model check per upgrade combination: { [combo]: { hands, wagered,
  // paid, net, player, banker, tie, pairs, drawErrors, winnerErrors, checked,
  // payErrors, expected } }. paid is the server's payout, net the profit booked
  // from the credits (G.gameDelta), so paid - wagered - net is a cost the
  // response does not show. player / banker / tie count the winners, pairs the
  // hands with a pair on either side, drawErrors hands dealt against the
  // tableau, winnerErrors winners other than the totals give, payErrors
  // payouts more than a credit off the client's pays; expected is the payout
  // the model expects for the checked bets.
  function addHand(check, combo, upgrades, request, data, net) {
    const hand = data?.hand;
    if (!hand) return check;
    const row = (check[combo] ??= {
      hands: 0, wagered: 0, paid: 0, net: 0, player: 0, banker: 0, tie: 0, pairs: 0,
      drawErrors: 0, winnerErrors: 0, checked: 0, payErrors: 0, expected: 0, checkedPaid: 0, checkedWagered: 0,
    });
    const paid = Number(data.payout) || 0;
    const wagered = Number(data.total) || Object.values(request?.bets ?? {}).reduce((sum, amount) => sum + amount, 0);
    row.hands += 1;
    row.wagered += wagered;
    row.paid += paid;
    row.net += net;
    const winner = Array.isArray(hand.player) && Array.isArray(hand.banker) ? winnerOf(hand) : hand.winner;
    if (winner in { player: 1, banker: 1, tie: 1 }) row[winner] += 1;
    if (hand.winner && hand.winner !== winner) row.winnerErrors += 1;
    if (Array.isArray(hand.player) && Array.isArray(hand.banker)) {
      if (!dealtByRules(hand)) row.drawErrors += 1;
      if (hand.player[0]?.rank === hand.player[1]?.rank || hand.banker[0]?.rank === hand.banker[1]?.rank) row.pairs += 1;
    }
    const rule = payout(request?.bets, hand, upgrades);
    if (rule !== null) {
      row.checked += 1;
      if (Math.abs(rule - paid) > 1) row.payErrors += 1;
      row.expected += Object.entries(request.bets).reduce((sum, [spot, amount]) => sum + amount * spotRtp(spot, upgrades), 0);
      row.checkedPaid += paid;
      row.checkedWagered += Object.values(request.bets).reduce((sum, amount) => sum + amount, 0);
    }
    return check;
  }

  const api = {
    CUTS, BANKER_EXTRA, TIE_PAYS, PAIR_PAYS, PAIR_CHANCE, SPOTS, RANKS,
    points, total, rulesFromUpgrades, bankerDraws, outcomes, spotReturn, spotDistribution, spotRtp, bestSpot,
    payout, dealtByRules, addHand,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterBaccarat = api;
})(globalThis);
