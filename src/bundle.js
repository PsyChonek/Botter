// Checks the casino's app bundle against the client facts the bot's models
// copy: shop catalog, unlock levels, bet levels, roulette zeros, the payroll
// fund's share, and every slot, table game and case table the odds models
// were built from. A table the bundle no longer contains means the game math
// changed and the model is stale. Used by the content script whenever the
// bundle's file name changes, and by scripts/bundle.mjs. Classic script:
// globalThis.BotterBundle in the extension, require() in Node.
(function (root) {
  // Minifiers write 1000 as 1e3 and 0.1 as .1, so numbers are compared by value.
  const canon = (text) =>
    text.replace(/(?<![\w$.])\d*\.?\d+(?:e[+-]?\d+)?(?![\w$.])/g, (n) => String(Number(n)));

  // Client tables each model copies, written as the bundle has them (numbers
  // in any form). Update a needle together with the model that copies it.
  const NEEDLES = [
    ['blaze', 'symbol weights', '{cherry:26,lemon:26,orange:24,plum:24,grapes:13,melon:13,seven:5,star:4,wild:0}'],
    ['blaze', 'wild weight', 'e>=1&&e<=3?2.3:0'],
    ['blaze', 'paytable', 'paytable:{cherry:[5,20,80],lemon:[5,20,80],orange:[5,20,80],plum:[5,20,80],grapes:[15,50,250],melon:[15,50,250],seven:[40,200,1000]}'],
    ['blaze', 'lucky upgrade', '[0,3.4,5.6,7.2,8.5,9.6],'],
    ['blaze', 'lucky and wild upgrades', '[0,0.1,0.2,0.3,0.4,0.5],'],
    ['blaze', 'star upgrade', '[2.7,3.6,4.5,5.4,6.3,7.2].map((e,t)=>({3:e,4:10+2*t,5:50+5*t}))'],
    ['blaze', 'star pays', 'scatterPay:{3:2.7,4:10,5:50}'],
    ['skeleton', 'weights', 'weights:[20,20,19,19,13,13,8,7,1.4,0.8]'],
    ['skeleton', 'pay scale', '4.4,'],
    ['skeleton', 'low pays', '[4,5,6,8,10,12,16,20,30,40,60]'],
    ['skeleton', 'mid pays', '[8,10,12,16,20,25,32,40,60,80,120]'],
    ['skeleton', 'high pays', '[14,18,22,28,36,45,60,80,120,160,300]'],
    ['skeleton', 'top pays', '[20,25,30,40,50,65,85,110,160,220,400]'],
    ['skeleton', 'free spins', 'freeSpins:[8,10,12],baseMultCap:5,freeMultCap:15'],
    ['skeleton', 'upgrades', '[1,1.03,1.06,1.09,1.12],'],
    ['skeleton', 'wild upgrade', '[0,0.13,0.26,0.39,0.52],'],
    ['skeleton', 'rocket upgrade', '[0,0.06,0.12,0.18];'],
    ['slotingi', 'symbol weights', '{phones:30,headset:30,muffs:28,rocker:16,elf:14,luigi:11,gulas:8,mrazik:5,wild:0,coin:22}'],
    ['slotingi', 'wild weight', 'e>=1&&e<=3?6:0'],
    ['slotingi', 'paytable', 'paytable:{phones:[7,25,80],headset:[7,25,80],muffs:[7,25,80],rocker:[13,50,200],elf:[20,65,240],luigi:[26,100,400],gulas:[40,150,650],mrazik:[80,320,1300]}'],
    ['slotingi', 'coins', '[{x:1,w:34},{x:2,w:26},{x:3,w:15},{x:5,w:12},{x:8,w:6},{x:10,w:4,'],
    ['slotingi', 'big coins', '{x:25,w:2,'],
    ['slotingi', 'respins', 'respinCoin:0.045,grand:1000'],
    ['slotingi', 'upgrades', '[0,0.5,1,1.5],'],
    ['slotingi', 'gulas upgrade', '[1,1.05,1.1,1.15,1.2],'],
    ['slotingi', 'mint upgrade', '[0,0.003,0.006,0.009];'],
    ['hotfix', 'weights', 'weights:[16,16,15,15,14,10,9,8,7,6,5,2.2,3.4],rowWeights:[25,30,20,13,8,4]'],
    ['hotfix', 'pay scale', '=0.97,'],
    ['hotfix', 'pays', '[25,30,40,50]),'],
    ['hotfix', 'top pays', '[110,220,550,1400])],wheelChance:0.05,freeWheelChance:0.25'],
    ['hotfix', 'wheels', 'baseWheel:{wildreel:14,wilds:30,mystery:24,sync:18,maxways:12,bonus:2},freeWheel:{wildreel:10,wilds:26,mystery:22,maxways:14,boost:18,refactor:10},multCap:50,wildsCount:[2,4],mysteryCount:[4,7]'],
    ['hotfix', 'free spins', 'spins:10,mult:1},'],
    ['hotfix', 'free spins', 'spins:5,mult:6},'],
    ['hotfix', 'free spins', 'spins:4,mult:8}'],
    ['hotfix', 'upgrades', '[0,0.07,0.14,0.2],'],
    ['hotfix', 'fix upgrade', '[0,0.004,0.008,0.012],'],
    ['hotfix', 'review upgrade', '[1,1.035,1.07,1.1,1.135];'],
    ['egypt', 'weights', 'Fl={scarab:24,cobra:24,urn:23,cat:19,eye:19,anubis:6,horus:6,mummy:4,pharaoh:3,book:2.7}'],
    ['egypt', 'paytable', 'paytable:{scarab:[0,6,20,80],cobra:[0,6,20,80],urn:[0,6,20,80],cat:[0,6,30,120],eye:[0,6,30,120],anubis:[5,20,60,200],horus:[5,20,60,200],mummy:[5,25,100,400],pharaoh:[10,50,200,1000]},scatter:[2,20,200],freeSpins:10,freeBoost:9}'],
    ['egypt', 'lines', '[[1,1,1,1,1],[0,0,0,0,0],[2,2,2,2,2],[0,1,2,1,0],[2,1,0,1,2],[1,2,2,2,1],[1,0,0,0,1],[2,2,1,0,0],[0,0,1,2,2],[2,1,1,1,0]]'],
    ['egypt', 'high symbols', '[`anubis`,`horus`,`mummy`,`pharaoh`]'],
    ['egypt', 'upgrades', '=0.04,'],
    ['egypt', 'upgrades', '=0.4;function'],
    ['egypt', 'upgrade effects', 'book:e.book+t*'],
    ['blackjack', 'ties upgrade', '[22,21,20,19,18],'],
    ['blackjack', 'blackjack pays', '[1,1.2,1.5];'],
    ['roulette', 'pays', 'číslo 35:1 · tucet a sloupec 2:1 · barva, sudá/lichá, polovina 1:1'],
    ['roulette', 'red numbers', 'new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36])'],
    ['baccarat', 'cut upgrade', '[0.08,0.06,0.04,0.025]'],
    ['baccarat', 'banker extra', 'Bankéř platí navíc 5 % jako všude.'],
    ['baccarat', 'tie pays', '{key:`tie`,label:`Remíza`,pays:`8:1`}'],
    ['baccarat', 'pair pays', '{key:`ppair`,label:`Pár hráče`,pays:`10:1`}'],
    ['baccarat', 'tie refund', 'remíza vrací polovinu sázky na Hráče a Bankéře'],
    ['baccarat', 'card points', 'e.rank===`A`?1:[`10`,`J`,`Q`,`K`].includes(e.rank)?0:Number(e.rank)'],
    ['dice', 'commission upgrade', '[0.1,0.07,0.04,0.015];'],
    ['dice', 'insurance', 'Když padne trojice, vrátí se polovina sázek na Malá, Velká, Lichá a Sudá.'],
    ['dice', 'sum pays', '{4:60,5:30,6:17,7:12,8:8,9:6,10:6,11:6,12:6,13:8,14:12,15:17,16:30,17:60}'],
    ['dice', 'number pays', '[0,1,2,3],'],
    ['dice', 'even-money pays', '`1:1`,`small`],[`Velká`,'],
    ['dice', 'even-money pays', '`1:1`,`big`],[`Lichá / Sudá`,`lichý / sudý součet`,`1:1`,`odd`]'],
    ['dice', 'triple pays', '[`Tři stejné`,`padnou tři stejná čísla`,`30:1`,`anytriple`]'],
    ['dice', 'pair pays', '[`Dvě různá čísla`,`padnou obě čísla`,`5:1`,`combo12`]'],
    ['dice', 'double pays', '[`Dvojice`,`číslo padne aspoň dvakrát`,`10:1`,`double1`]'],
    ['dice', 'given triple pays', '[`Konkrétní trojice`,`třikrát to samé číslo`,`180:1`,`triple1`]'],
    ['mines', 'bug counts', '[1,3,5,10,15,20,24],'],
    ['mines', 'board', '(25-e,t)/'],
    ['mines', 'multiplier floor', '*100+1e-9)/100)'],
    ['mines', 'base return', '=0.82,'],
    ['mines', 'upgrades', '`tests`,4)+0.05/3*'],
    ['cases', 'rarity odds', '{blue:0.7992,purple:0.1598,pink:0.032,red:0.0064,gold:0.0026}'],
    ['cases', 'supplier upgrade', '=0.0202,'],
    ['cases', 'kitchen upgrade', '=0.0002;'],
    ['cases', 'item pay', 'Math.max(1,Math.round(e*t.value))'],
    // Case opening items as rarity, value and weight, in the client's order.
    ...[
      ['blue', 0.15, 1], ['blue', 0.2, 1], ['blue', 0.25, 1], ['blue', 0.3, 1], ['blue', 0.35, 1], ['blue', 0.45, 1],
      ['purple', 1, 1], ['purple', 1.1, 1], ['purple', 1.3, 1], ['purple', 1.6, 1],
      ['pink', 3, 1], ['pink', 4, 1], ['pink', 5, 1], ['red', 12, 2], ['red', 20, 1],
      ['gold', 50, 6], ['gold', 100, 3], ['gold', 250, 1],
    ].map(([rarity, value, weight]) => ['cases', `${rarity} item ${value}x`, `rarity:\`${rarity}\`,value:${value},weight:${weight}}`]),
    ['events', 'rotation', '[`xp`,`wins`,`wheel`,`overtime`]'],
    ['events', 'halloween weekend', '.slice(5)>=`10-28`&&'],
    ['events', 'halloween weekend', '.slice(5)<=`11-03`'],
    ['events', 'halloween xp', '+30 % XP ze všeho'],
    ['payroll', 'share', 'Mzdový fond · 0,5 % z každé sázky'],
    ['xp', 'big wins', '[{key:`big`,x:10,xp:15},{key:`mega`,x:25,xp:40},{key:`super`,x:50,xp:100}]'],
    ['bets', 'max bet by level', 'e>=15?1000:e>=10?400:e>=6?200:e>=3?100:40'],
  ];

  // Facts read from the bundle: { changelog, games, soon, shop, betLevels,
  // rouletteZeros }, a field null when its pattern is not found. soon lists the
  // games the lobby shows as coming.
  function readFacts(text) {
    const src = canon(text);
    const dates = [...src.matchAll(/\{date:`(\d{4}-\d{2}-\d{2})`,changes:\[/g)].map((m) => m[1]).sort();
    const games = {};
    const soon = [];
    // An icon is a text, or a getter (Skeleton Slots swaps its icon for an event).
    for (const m of src.matchAll(/\{key:`(\w+)`,name:`[^`]*`,(?:icon:`[^`]*`|get icon\(\)\{return \w+\(\)\}),blurb:`[^`]*`,unlock:(\d+)(,soon:)?/g)) {
      games[m[1]] = Number(m[2]);
      if (m[3]) soon.push(m[1]);
    }
    const zeros = /\w+=\[((?:`\w+`,?)*)\],\w+=\[0,32,15,19,4,21,2,25,17,34/.exec(src);
    const rouletteZeros = zeros ? zeros[1].split(',').filter(Boolean).length : null;
    const bets = /\w+=\[([\d,]+)\],\w+=\w+\[0\],\w+=\[\{key:`big`/.exec(src);
    // The shop catalog: game:[{key, ..., maxLevel, basePrice, growth, prices?}, ...].
    const shop = {};
    const start = src.indexOf('global:[{key:`bets`');
    const end = start < 0 ? -1 : src.indexOf('}]}', src.indexOf('roulette:[{key:', start));
    if (end > 0) {
      const region = src.slice(start, end + 2);
      const lists = [...region.matchAll(/(\w+):\[\{key:/g)];
      for (const m of region.matchAll(/\{key:`(\w+)`[^{}]*?maxLevel:([^,]+),basePrice:([\d.]+),growth:([\d.]+)(?:,prices:\[([\d.,]+)\])?\}/g)) {
        const game = lists.findLast((list) => list.index < m.index)?.[1];
        if (!game) continue;
        // Roulette's max level is the length of its zeros list.
        const max = /^\d+$/.test(m[2]) ? Number(m[2]) : m[2].endsWith('.length') ? rouletteZeros : null;
        const item = [max, Number(m[3]), Number(m[4])];
        if (m[5]) item.push(m[5].split(',').map(Number));
        (shop[game] ??= {})[m[1]] = item;
      }
    }
    return {
      changelog: dates.at(-1) ?? null,
      games: Object.keys(games).length ? games : null,
      soon,
      shop: Object.keys(shop).length ? shop : null,
      betLevels: bets ? bets[1].split(',').map(Number) : null,
      rouletteZeros,
    };
  }

  const OUTSIDE_GAMES = ['crash', 'lottery'];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Compares the bundle with what the bot plans with (BotterGames as G,
  // BotterOdds as O). Returns { facts, problems }: each problem a short line
  // naming what differs.
  function check(text, G, O) {
    const expected = {
      games: Object.fromEntries(Object.entries(G.GAMES).map(([game, { unlock }]) => [game, unlock])),
      shop: G.SHOP,
      betLevels: G.BET_LEVELS,
      rouletteZeros: O.ROULETTE_EXTRA_ZEROS,
    };
    const facts = readFacts(text);
    const problems = [];
    const src = canon(text);
    for (const [game, what, needle] of NEEDLES) {
      if (!src.includes(canon(needle))) problems.push(`${game}: ${what} changed`);
    }
    for (const field of ['games', 'shop', 'betLevels', 'rouletteZeros']) {
      if (facts[field] === null) problems.push(`${field}: not found in the bundle`);
    }
    if (facts.games) {
      for (const [game, unlock] of Object.entries(expected.games)) {
        if (facts.games[game] !== unlock) problems.push(`${game}: unlock level ${facts.games[game] ?? 'gone'}, bot has ${unlock}`);
      }
      // Crash and the lottery are played outside the game list; coming games are not playable yet.
      for (const [game, unlock] of Object.entries(facts.games)) {
        if (!expected.games[game] && !OUTSIDE_GAMES.includes(game) && !facts.soon.includes(game)) problems.push(`${game}: new game from level ${unlock}`);
      }
    }
    if (facts.shop) {
      for (const [game, items] of Object.entries(expected.shop)) {
        for (const [key, item] of Object.entries(items)) {
          const seen = facts.shop[game]?.[key];
          if (!same(seen, item)) problems.push(`shop ${game}:${key}: ${seen ? seen.join('/') : 'gone'}, bot has ${item.join('/')}`);
        }
        for (const key of Object.keys(facts.shop[game] ?? {})) if (!items[key]) problems.push(`shop ${game}:${key}: new upgrade`);
      }
      for (const game of Object.keys(facts.shop)) if (!expected.shop[game]) problems.push(`shop ${game}: new game in the shop`);
    }
    if (facts.betLevels && !same(facts.betLevels, expected.betLevels)) problems.push(`bet levels ${facts.betLevels.join('/')}, bot has ${expected.betLevels.join('/')}`);
    if (facts.rouletteZeros !== null && facts.rouletteZeros !== expected.rouletteZeros) {
      problems.push(`roulette: ${facts.rouletteZeros} extra zeros, bot has ${expected.rouletteZeros}`);
    }
    return { facts, problems };
  }

  // File name of the app bundle a page loaded ("index-DD7zv7qF.js"), from its
  // script tag or the URL itself.
  const bundleName = (src) => /\/assets\/(index-[\w-]+\.js)/.exec(src ?? '')?.[1] ?? null;

  const api = { NEEDLES, canon, readFacts, check, bundleName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterBundle = api;
})(globalThis);
