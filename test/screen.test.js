const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/screen.js');
const G = require('../src/games.js');

test('parseCredits reads the app formatting', () => {
  assert.equal(S.parseCredits('1 000'), 1000);
  assert.equal(S.parseCredits('1 000'), 1000);
  assert.equal(S.parseCredits('20'), 20);
  assert.equal(S.parseCredits(''), null);
  assert.equal(S.parseCredits(undefined), null);
});

test('chipsFor makes every bet level from the table chips', () => {
  for (const bet of G.BET_LEVELS) {
    const chips = S.chipsFor(bet);
    assert.ok(chips, `no chips for ${bet}`);
    assert.equal(chips.reduce((a, b) => a + b, 0), bet);
  }
  assert.deepEqual(S.chipsFor(1000), [500, 500]);
  assert.deepEqual(S.chipsFor(40), [10, 10, 10, 10]);
  assert.equal(S.chipsFor(15), null);
  assert.equal(S.chipsFor(0), null);
});

test('isIdle sees a game busy while its controls are disabled', () => {
  const button = (disabled) => ({ disabled });
  const screen = (buttons) => ({ querySelectorAll: () => buttons, querySelector: () => buttons[0] });
  assert.equal(S.isIdle('blaze', screen([button(true), button(true)])), false);
  assert.equal(S.isIdle('skeleton', screen([button(true), button(false)])), true);
  assert.equal(S.isIdle('roulette', screen([button(false)])), true);
  assert.equal(S.isIdle('roulette', screen([button(true)])), false);
});

test('every game has a screen, and Skeleton Slots never matches Forbes z Chánova', () => {
  for (const game of G.GAME_KEYS) assert.ok(S.SCREENS[game], game);
  assert.match(S.SCREENS.skeleton, /:not\(\.hotfix\)/);
  const button = (disabled) => ({ disabled });
  for (const game of ['baccarat', 'dice']) {
    assert.equal(S.isIdle(game, { querySelector: () => button(false) }), true);
    assert.equal(S.isIdle(game, { querySelector: () => button(true) }), false);
  }
});
