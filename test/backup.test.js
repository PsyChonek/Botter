const test = require('node:test');
const assert = require('node:assert/strict');
const B = require('../src/backup.js');

const stored = {
  settings: { buyUpgrades: true, reserve: 1000 },
  apiKey: 'sk-test',
  'stats:a': {
    games: { blaze: { rounds: 10, wagered: 200, net: -40, xp: 5 } },
    free: { daily: 500 },
    grind: { day: '2026-10-11', net: -300, pool: null },
    flags: { cleanDone: true },
    dwell: { bug: 4000 },
    crashBooked: [1, 2],
  },
  'account:a': { login: 'alice', level: 15, session: 'raw', storageKey: 'sb-auth' },
  levels: { 15: { xpNeed: 10_000, reward: 14_000 } },
  bank: { k1: { answer: 1 } },
  spins: [{ grid: [1] }],
  installId: 'here',
};

test('buildBackup leaves API keys and login sessions out unless asked', () => {
  const plain = B.buildBackup(stored, { id: 'x', source: 'here', now: 0 });
  assert.equal(plain.apiKey, undefined);
  assert.deepEqual(plain.accounts.a, { login: 'alice', level: 15 });
  assert.deepEqual(plain.stats.a, stored['stats:a']);
  assert.ok(B.isBackup(plain));
  const full = B.buildBackup(stored, { secrets: true, id: 'x', source: 'here', now: 0 });
  assert.equal(full.apiKey, 'sk-test');
  assert.equal(full.accounts.a.session, 'raw');
});

test('addStats sums counters but keeps the local day, flags and the longer dwell', () => {
  const incoming = {
    games: { blaze: { rounds: 5, wagered: 100, net: 20, xp: 3 }, roulette: { rounds: 1, wagered: 10, net: -10, xp: 1 } },
    free: { daily: 250, levelUp: 2000 },
    grind: { day: '2026-10-10', net: -900, pool: null },
    flags: { cleanDone: false, boardsDay: '2026-10-10' },
    dwell: { bug: 6000, feature: 3000 },
    crashBooked: [2, 3],
  };
  const sum = B.addStats(stored['stats:a'], incoming);
  assert.deepEqual(sum.games.blaze, { rounds: 15, wagered: 300, net: -20, xp: 8 });
  assert.deepEqual(sum.games.roulette, incoming.games.roulette);
  assert.deepEqual(sum.free, { daily: 750, levelUp: 2000 });
  assert.deepEqual(sum.grind, stored['stats:a'].grind);
  assert.deepEqual(sum.flags, { cleanDone: true, boardsDay: '2026-10-10' });
  assert.deepEqual(sum.dwell, { bug: 6000, feature: 3000 });
  assert.deepEqual(sum.crashBooked, [2, 3, 1]);
});

test('importBackup applies settings and merges the rest', () => {
  const backup = {
    ...B.buildBackup({}, { id: 'b1', source: 'there', now: 0 }),
    settings: { reserve: 5000 },
    stats: { a: { free: { daily: 100 } }, b: { free: { daily: 50 } } },
    accounts: { a: { login: 'alice', level: 3 }, b: { login: 'bob' } },
    levels: { 15: { xpNeed: 1 }, 16: { xpNeed: 11_000 } },
    bank: { k1: { answer: 2 }, k2: { answer: 3 }, bad: {} },
    spins: [{ grid: [1] }, { grid: [2] }],
  };
  const { set, counts, statsSkipped } = B.importBackup(stored, backup, { install: 'here', isBankEntry: (key) => key !== 'bad' });
  assert.equal(statsSkipped, false);
  assert.deepEqual(set.settings, { buyUpgrades: true, reserve: 5000 });
  assert.equal(set['stats:a'].free.daily, 600);
  assert.deepEqual(set['stats:b'], { free: { daily: 50 } });
  assert.deepEqual(set.importedBackups, ['b1']);
  assert.equal(set['account:a'], undefined, 'a known account keeps its own record');
  assert.deepEqual(set['account:b'], { login: 'bob' });
  assert.deepEqual(set.bank, { k1: { answer: 1 }, k2: { answer: 3 } });
  assert.deepEqual(set.levels, { 15: { xpNeed: 10_000, reward: 14_000 }, 16: { xpNeed: 11_000 } });
  assert.deepEqual(set.spins, [{ grid: [2] }, { grid: [1] }]);
  assert.deepEqual(counts, { stats: 2, accounts: 1, answers: 1, levels: 1, spins: 1 });
});

test('importBackup never adds the same stats twice', () => {
  const backup = B.buildBackup(stored, { id: 'b1', source: 'here', now: 0 });
  assert.equal(B.importBackup(stored, backup, { install: 'here' }).statsSkipped, true);
  const again = B.importBackup({ ...stored, importedBackups: ['b1'] }, { ...backup, source: 'there' }, { install: 'here' });
  assert.equal(again.statsSkipped, true);
  assert.equal(again.set['stats:a'], undefined);
});

test('importBackup refuses a file that is not a backup', () => {
  assert.throws(() => B.importBackup(stored, { k1: { answer: 1 } }, {}));
});
