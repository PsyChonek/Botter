// Case opening (from level 17): the bet buys a case and one item always drops,
// paying max(1, round(bet x its value)). The client draws a rarity by its
// odds, then an item of that rarity by weight. Lepší dodavatel moves 2.02 %
// per level from blue to purple, Známá v kuchyňce 0.02 % per level from blue
// to gold. The drop is drawn on the server, so these odds are what the
// recorded drops check. Classic script: globalThis.BotterCases in the
// extension, require() in Node.
(function (root) {
  const ODDS = { blue: 0.7992, purple: 0.1598, pink: 0.032, red: 0.0064, gold: 0.0026 };
  const SUPPLIER_SHIFT = 0.0202;
  const KITCHEN_SHIFT = 0.0002;
  // [key, rarity, value, weight] as the client lists them.
  const ITEMS = [
    ['pen', 'blue', 0.15, 1], ['lanyard', 'blue', 0.2, 1], ['pad', 'blue', 0.25, 1], ['usb', 'blue', 0.3, 1],
    ['mug', 'blue', 0.35, 1], ['tshirt', 'blue', 0.45, 1],
    ['webcam', 'purple', 1, 1], ['mouse', 'purple', 1.1, 1], ['keyboard', 'purple', 1.3, 1], ['headset', 'purple', 1.6, 1],
    ['monitor', 'pink', 3, 1], ['chair', 'pink', 4, 1], ['desk', 'pink', 5, 1],
    ['macbook', 'red', 12, 2], ['car', 'red', 20, 1],
    ['knife_fade', 'gold', 50, 6], ['knife_doppler', 'gold', 100, 3], ['knife_ruby', 'gold', 250, 1],
  ].map(([key, rarity, value, weight]) => ({ key, rarity, value, weight }));

  const clampLevel = (upgrades, key, max) => Math.max(0, Math.min(max, upgrades?.[key] ?? 0));
  function oddsFromUpgrades(upgrades) {
    const supplier = clampLevel(upgrades, 'supplier', 3) * SUPPLIER_SHIFT;
    const kitchen = clampLevel(upgrades, 'kitchen', 2) * KITCHEN_SHIFT;
    return { ...ODDS, blue: ODDS.blue - supplier - kitchen, purple: ODDS.purple + supplier, gold: ODDS.gold + kitchen };
  }

  // Every item with its chance at these upgrades: [{ key, rarity, value, p }].
  function itemChances(upgrades) {
    const odds = oddsFromUpgrades(upgrades);
    return ITEMS.map((item) => {
      const total = ITEMS.filter((i) => i.rarity === item.rarity).reduce((sum, i) => sum + i.weight, 0);
      return { ...item, p: (odds[item.rarity] * item.weight) / total };
    });
  }

  const itemPay = (bet, item) => Math.max(1, Math.round(bet * item.value));
  const item = (key) => ITEMS.find((i) => i.key === key) ?? null;

  // The distribution of a credit's return: [[return, chance], ...], at the
  // smallest bet's rounding when one is given.
  function distribution(upgrades, bet = null) {
    const merged = new Map();
    for (const i of itemChances(upgrades)) {
      const r = bet ? itemPay(bet, i) / bet : i.value;
      merged.set(r, (merged.get(r) ?? 0) + i.p);
    }
    return [...merged];
  }

  const rtp = (upgrades, bet = null) => distribution(upgrades, bet).reduce((sum, [r, p]) => sum + r * p, 0);
  // Chance of one drop: a rarity or an item key.
  const chance = (what, upgrades) => itemChances(upgrades).filter((i) => i.key === what || i.rarity === what).reduce((sum, i) => sum + i.p, 0);

  // Case opening model check per upgrade combination: { [combo]: { opens,
  // wagered, paid, net, rarities, unknown, payErrors } }. rarities counts the
  // drops per rarity (compare with oddsFromUpgrades), unknown items the model
  // does not list, payErrors wins more than a credit off bet x value.
  function addOpen(check, combo, request, data, net) {
    const drop = item(data?.item);
    const bet = Number(data?.bet) || Number(request?.bet) || 0;
    if (!data?.item || !bet) return check;
    const row = (check[combo] ??= { opens: 0, wagered: 0, paid: 0, net: 0, rarities: {}, unknown: 0, payErrors: 0 });
    const paid = Number(data.win) || 0;
    row.opens += 1;
    row.wagered += bet;
    row.paid += paid;
    row.net += net;
    if (!drop) row.unknown += 1;
    else {
      row.rarities[drop.rarity] = (row.rarities[drop.rarity] ?? 0) + 1;
      if (Math.abs(itemPay(bet, drop) - paid) > 1) row.payErrors += 1;
    }
    return check;
  }

  const api = { ODDS, SUPPLIER_SHIFT, KITCHEN_SHIFT, ITEMS, oddsFromUpgrades, itemChances, itemPay, item, distribution, rtp, chance, addOpen };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterCases = api;
})(globalThis);
