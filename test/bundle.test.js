const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/bundle.js');
const G = require('../src/games.js');
const O = require('../src/odds.js');

// A bundle made of the pieces the check looks for, minified the way the real
// one is (1e3 for 1000, .1 for 0.1).
const minify = (text) => text.replace(/\b1000\b/g, '1e3').replace(/(?<![\d.])0\.(\d)/g, '.$1');
function fakeBundle({ shop = G.SHOP, zeros = '`S`,`00`', needles = B.NEEDLES.map(([, , needle]) => needle) } = {}) {
  const items = Object.entries(shop)
    .map(([game, keys]) => `${game}:[${Object.entries(keys).map(([key, [max, base, growth, prices]]) => `{key:\`${key}\`,icon:\`x\`,name:\`n\`,description:\`d\`,maxLevel:${game === 'roulette' ? 'bl.length' : max},basePrice:${base},growth:${growth}${prices ? `,prices:[${prices}]` : ''}}`).join(',')}]`)
    .join(',');
  const games = Object.entries(G.GAMES).map(([key, { unlock }]) => `{key:\`${key}\`,name:\`n\`,icon:\`i\`,blurb:\`b\`,unlock:${unlock}}`).join(',');
  return minify(
    [
      `VO=[{date:\`2026-10-10\`,changes:[]},{date:\`2026-10-06\`,changes:[]}]`,
      `Cc=[${G.BET_LEVELS}],wc=Cc[0],Tc=[{key:\`big\`,x:10,xp:15}]`,
      `bl=[${zeros}],xl=[0,32,15,19,4,21,2,25,17,34,6]`,
      `nu={${items}}`,
      `[${games}]`,
      ...needles,
    ].join(';'),
  );
}

test('a bundle with every model table and fact matches', () => {
  const { facts, problems } = B.check(fakeBundle(), G, O);
  assert.deepEqual(problems, []);
  assert.equal(facts.changelog, '2026-10-10');
  assert.equal(facts.rouletteZeros, 2);
  assert.deepEqual(facts.shop.roulette.zeros, [2, 15000, 2.5]);
  assert.deepEqual(facts.shop.global.bets, [3, 1000, 3, [1000, 3000, 8000]]);
  assert.deepEqual(facts.betLevels, G.BET_LEVELS);
});

test('a changed paytable, price or wheel is reported', () => {
  const needles = B.NEEDLES.map(([, , needle]) => needle.replace('seven:[40,200,1000]', 'seven:[40,200,900]'));
  const shop = { ...G.SHOP, roulette: { zeros: [2, 20000, 2.5] } };
  const { problems } = B.check(fakeBundle({ needles, shop, zeros: '`S`,`00`,`000`' }), G, O);
  assert.ok(problems.includes('blaze: paytable changed'));
  assert.ok(problems.some((line) => line.startsWith('shop roulette:zeros: 3/20000/2.5')));
  assert.ok(problems.includes('roulette: 3 extra zeros, bot has 2'));
});

test('a bundle the patterns no longer fit says so instead of passing', () => {
  const { problems } = B.check('console.log(1)', G, O);
  assert.ok(problems.includes('shop: not found in the bundle'));
  assert.ok(problems.length > B.NEEDLES.length);
});

test('bundleName reads the file name from a script URL', () => {
  assert.equal(B.bundleName('https://skeleton-casino.vercel.app/assets/index-DD7zv7qF.js'), 'index-DD7zv7qF.js');
  assert.equal(B.bundleName('https://example.com/app.js'), null);
});

test('a new game or shop game in the bundle is reported, a coming one is not', () => {
  const games = { ...G.GAMES };
  delete games.baccarat;
  const shop = { ...G.SHOP };
  delete shop.baccarat;
  const bot = { ...G, GAMES: games, SHOP: shop };
  const text = fakeBundle() + ';[{key:`dice`,name:`n`,icon:`i`,blurb:`b`,unlock:25,soon:`s`}]';
  const { facts, problems } = B.check(text, bot, O);
  assert.deepEqual(facts.soon, ['dice']);
  assert.deepEqual(problems, ['baccarat: new game from level 20', 'shop baccarat: new game in the shop']);
});
