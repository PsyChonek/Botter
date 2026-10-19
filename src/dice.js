// Kostky (from level 25): sic bo with three dice, solved exactly over the 216
// rolls. The client's pays: Malá / Velká / Lichá / Sudá 1:1 but lost to any
// triple, a sum 6:1 to 60:1, a number 1:1 per die, two numbers 5:1, a double
// 10:1, any triple 30:1, a given triple 180:1. Management takes a commission
// from every win (Daňový poradce: 10, 7, 4, 1.5 %), taken here from the net
// win as in baccarat, and Pojištění proti trojici returns half the Malá /
// Velká / Lichá / Sudá stakes on a triple. The dice are rolled on the server,
// so fair dice and the commission rule are what the recorded rolls check
// (addRoll). Classic script: globalThis.BotterDice in the extension, require()
// in Node.
(function (root) {
  // Same mapping as the shop: Daňový poradce levels index into COMMISSIONS.
  const COMMISSIONS = [0.1, 0.07, 0.04, 0.015];
  const SUM_PAYS = { 4: 60, 5: 30, 6: 17, 7: 12, 8: 8, 9: 6, 10: 6, 11: 6, 12: 6, 13: 8, 14: 12, 15: 17, 16: 30, 17: 60 };
  const SINGLE_PAYS = [0, 1, 2, 3];
  const EVEN_MONEY = ['small', 'big', 'odd', 'even'];
  const FACES = [1, 2, 3, 4, 5, 6];
  const COMBOS = FACES.flatMap((a) => FACES.filter((b) => b > a).map((b) => `combo${a}${b}`));
  const SPOTS = [
    ...EVEN_MONEY,
    ...Object.keys(SUM_PAYS).map((s) => `sum${s}`),
    ...FACES.map((f) => `single${f}`),
    ...FACES.map((f) => `double${f}`),
    ...FACES.map((f) => `triple${f}`),
    'anytriple',
    ...COMBOS,
  ];
  const ROLLS = FACES.flatMap((a) => FACES.flatMap((b) => FACES.map((c) => [a, b, c])));

  const clampLevel = (upgrades, key, max) => Math.max(0, Math.min(max, upgrades?.[key] ?? 0));
  const rulesFromUpgrades = (upgrades) => ({
    commission: COMMISSIONS[clampLevel(upgrades, 'house', COMMISSIONS.length - 1)],
    tripleBack: clampLevel(upgrades, 'insure', 1) ? 0.5 : 0,
  });

  const sumOf = (dice) => dice[0] + dice[1] + dice[2];
  const isTriple = (dice) => dice[0] === dice[1] && dice[1] === dice[2];
  const count = (dice, face) => dice.filter((d) => d === face).length;

  // The client's pay multiple of a spot on a roll (0 when it loses).
  function pays(spot, dice) {
    const sum = sumOf(dice);
    const triple = isTriple(dice);
    if (spot === 'small') return +(!triple && sum <= 10);
    if (spot === 'big') return +(!triple && sum >= 11);
    if (spot === 'odd') return +(!triple && sum % 2 === 1);
    if (spot === 'even') return +(!triple && sum % 2 === 0);
    if (spot === 'anytriple') return triple ? 30 : 0;
    const n = Number(spot.replace(/^\D+/, ''));
    if (spot.startsWith('sum')) return sum === n ? SUM_PAYS[n] : 0;
    if (spot.startsWith('single')) return SINGLE_PAYS[count(dice, n)];
    if (spot.startsWith('double')) return count(dice, n) >= 2 ? 10 : 0;
    if (spot.startsWith('triple')) return count(dice, n) === 3 ? 180 : 0;
    if (spot.startsWith('combo')) return count(dice, Math.floor(n / 10)) && count(dice, n % 10) ? 5 : 0;
    return 0;
  }

  // What one credit on a spot returns on a roll (stake included).
  function spotReturn(spot, dice, rules) {
    const pay = pays(spot, dice);
    if (pay > 0) return 1 + pay * (1 - rules.commission);
    return isTriple(dice) && EVEN_MONEY.includes(spot) ? rules.tripleBack : 0;
  }

  // The distribution of a credit's return on a spot: [[return, chance], ...].
  function spotDistribution(spot, upgrades) {
    const rules = rulesFromUpgrades(upgrades);
    const merged = new Map();
    for (const dice of ROLLS) {
      const r = spotReturn(spot, dice, rules);
      merged.set(r, (merged.get(r) ?? 0) + 1 / ROLLS.length);
    }
    return [...merged];
  }

  const spotRtp = (spot, upgrades) => spotDistribution(spot, upgrades).reduce((sum, [r, p]) => sum + r * p, 0);
  const spotChance = (spot) => ROLLS.filter((dice) => pays(spot, dice) > 0).length / ROLLS.length;

  // Malá, Velká, Lichá and Sudá return the same at every upgrade and beat
  // every other spot, so the bot bets Malá.
  const BEST_SPOT = 'small';

  // Payout the client's rules give these bets on a roll, or null for a roll
  // or spot the model does not know.
  function payout(bets, dice, upgrades) {
    if (!Array.isArray(dice) || dice.length !== 3 || !dice.every((d) => FACES.includes(d))) return null;
    const rules = rulesFromUpgrades(upgrades);
    let paid = 0;
    for (const [spot, amount] of Object.entries(bets ?? {})) {
      if (!SPOTS.includes(spot)) return null;
      paid += amount * spotReturn(spot, dice, rules);
    }
    return paid;
  }

  // Kostky model check per upgrade combination: { [combo]: { rolls, wagered,
  // paid, net, triples, faces, checked, payErrors, expected, checkedPaid,
  // checkedWagered } }. faces counts each face over every die (fair dice give
  // each a sixth), triples the triple rolls (1 in 36), payErrors payouts more
  // than a credit off the client's pays with the commission on the net win;
  // expected is the payout the model expects for the checked bets.
  function addRoll(check, combo, upgrades, request, data, net) {
    const dice = data?.dice;
    if (!Array.isArray(dice)) return check;
    const row = (check[combo] ??= {
      rolls: 0, wagered: 0, paid: 0, net: 0, triples: 0, faces: [0, 0, 0, 0, 0, 0],
      checked: 0, payErrors: 0, expected: 0, checkedPaid: 0, checkedWagered: 0,
    });
    const paid = Number(data.payout) || 0;
    const wagered = Number(data.total) || Object.values(request?.bets ?? {}).reduce((sum, amount) => sum + amount, 0);
    row.rolls += 1;
    row.wagered += wagered;
    row.paid += paid;
    row.net += net;
    if (isTriple(dice)) row.triples += 1;
    for (const d of dice) if (FACES.includes(d)) row.faces[d - 1] += 1;
    const rule = payout(request?.bets, dice, upgrades);
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
    COMMISSIONS, SUM_PAYS, EVEN_MONEY, SPOTS, BEST_SPOT, ROLLS,
    rulesFromUpgrades, sumOf, isTriple, pays, spotReturn, spotDistribution, spotRtp, spotChance, payout, addRoll,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterDice = api;
})(globalThis);
