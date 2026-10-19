const test = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src/cases.js');

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test('item chances add up and follow the upgrades', () => {
  for (const upgrades of [{}, { supplier: 3, kitchen: 2 }]) {
    near(K.itemChances(upgrades).reduce((sum, i) => sum + i.p, 0), 1);
  }
  near(K.chance('gold', {}), 0.0026);
  near(K.chance('gold', { kitchen: 2 }), 0.003);
  near(K.chance('purple', { supplier: 3 }), 0.1598 + 3 * 0.0202);
  near(K.chance('car', {}), 0.0064 / 3);
  near(K.chance('knife_ruby', {}), 0.0026 / 10);
});

test('return to player grows from about 86.9 % to 96.2 % with every upgrade', () => {
  near(K.rtp({}), 0.7992 * (1.7 / 6) + 0.1598 * 1.25 + 0.032 * 4 + 0.0064 * (44 / 3) + 0.0026 * 85);
  near(K.rtp({ supplier: 3, kitchen: 2 }) - K.rtp({}), 3 * 0.0202 * (1.25 - 1.7 / 6) + 2 * 0.0002 * (85 - 1.7 / 6));
  // Every item value is a whole number of credits at the smallest bet.
  near(K.rtp({}, 20), K.rtp({}));
  assert.equal(K.itemPay(20, K.item('pen')), 3);
  assert.equal(K.itemPay(1, K.item('pen')), 1);
});

test('addOpen counts drops per rarity and payouts off the item value', () => {
  const check = {};
  K.addOpen(check, '00', { bet: 20 }, { item: 'pen', win: 3, bet: 20 }, -17);
  K.addOpen(check, '00', { bet: 20 }, { item: 'car', win: 400, bet: 20 }, 380);
  K.addOpen(check, '00', { bet: 20 }, { item: 'mouse', win: 30, bet: 20 }, 10);
  K.addOpen(check, '00', { bet: 20 }, { item: 'stapler', win: 5, bet: 20 }, -15);
  const row = check['00'];
  assert.equal(row.opens, 4);
  assert.deepEqual(row.rarities, { blue: 1, red: 1, purple: 1 });
  assert.equal(row.payErrors, 1);
  assert.equal(row.unknown, 1);
});
