const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../src/dice.js');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('pays follow the client table and triples beat the even-money spots', () => {
  assert.equal(D.pays('small', [1, 2, 3]), 1);
  assert.equal(D.pays('small', [2, 2, 2]), 0);
  assert.equal(D.pays('big', [6, 6, 5]), 1);
  assert.equal(D.pays('odd', [1, 1, 1]), 0);
  assert.equal(D.pays('anytriple', [4, 4, 4]), 30);
  assert.equal(D.pays('sum4', [1, 1, 2]), 60);
  assert.equal(D.pays('single3', [3, 3, 1]), 2);
  assert.equal(D.pays('double5', [5, 5, 5]), 10);
  assert.equal(D.pays('triple6', [6, 6, 6]), 180);
  assert.equal(D.pays('combo26', [6, 2, 2]), 5);
  assert.equal(D.SPOTS.length, 4 + 14 + 6 + 6 + 6 + 1 + 15);
});

test('Malá returns 105 wins in 216 less the commission, plus the insurance', () => {
  near(D.spotChance('small'), 105 / 216);
  near(D.spotRtp('small', {}), (105 / 216) * 1.9);
  near(D.spotRtp('big', { house: 3 }), (105 / 216) * 1.985);
  near(D.spotRtp('small', { house: 3, insure: 1 }), (105 / 216) * 1.985 + (6 / 216) * 0.5);
  // The even-money spots beat every other spot at every upgrade.
  for (const house of [0, 3]) {
    const best = D.spotRtp(D.BEST_SPOT, { house });
    for (const spot of D.SPOTS) assert.ok(D.spotRtp(spot, { house }) <= best + 1e-12, spot);
  }
});

test('payout and addRoll check a roll against the model', () => {
  near(D.payout({ small: 100, anytriple: 20 }, [3, 3, 3], { insure: 1 }), 50 + 20 * (1 + 30 * 0.9));
  assert.equal(D.payout({ small: 20 }, [1, 2], {}), null);
  assert.equal(D.payout({ nope: 20 }, [1, 2, 3], {}), null);
  const check = {};
  D.addRoll(check, '00', {}, { bets: { small: 20 } }, { dice: [1, 2, 3], payout: 38, total: 20 }, 18);
  D.addRoll(check, '00', {}, { bets: { small: 20 } }, { dice: [5, 5, 5], payout: 0, total: 20 }, -20);
  D.addRoll(check, '00', {}, { bets: { small: 20 } }, { dice: [1, 1, 2], payout: 40, total: 20 }, 20);
  const row = check['00'];
  assert.equal(row.rolls, 3);
  assert.equal(row.triples, 1);
  assert.equal(row.payErrors, 1);
  assert.deepEqual(row.faces, [3, 2, 1, 0, 3, 0]);
});
