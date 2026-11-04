// The leaderboards the dashboard shows: what an entry keeps, which rows are
// ours, and how the cache and failed boards behave.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOARDS, CACHE_MS, Leaderboards, boardOf, entryOf } from '../src/leaderboards.mjs';

const raw = (over = {}) => ({
  rank: 1,
  id: 'u1',
  login: 'alpha',
  avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
  level: 10,
  title: 'Medior',
  value: 500,
  debtor: false,
  insolvent: true,
  badge: 'x',
  prestige: 2,
  look: null,
  me: false,
  ...over,
});

test('an entry keeps only what the dashboard shows and marks saved accounts as own', () => {
  const entry = entryOf(raw(), new Set(['u1']));
  assert.deepEqual(entry, {
    rank: 1,
    login: 'alpha',
    avatar: 'https://avatars.githubusercontent.com/u/1?v=4',
    title: 'Medior',
    level: 10,
    prestige: 2,
    value: 500,
    debtor: false,
    insolvent: true,
    me: false,
    own: true,
  });
  assert.equal(entryOf(raw({ id: 'u2' }), new Set(['u1'])).own, false);
  assert.equal(entryOf(raw({ id: 'u2', me: true }), new Set()).own, true);
});

test('an avatar from anywhere but GitHub is dropped', () => {
  assert.equal(entryOf(raw({ avatarUrl: 'https://evil.example/a.png' }), new Set()).avatar, null);
  assert.equal(entryOf(raw({ avatarUrl: null }), new Set()).avatar, null);
});

test('the sprint board carries its end and the last podium', () => {
  const board = boardOf(
    'sprint',
    { entries: [raw()], sprint: { number: 45, endAt: 9, last: { number: 44, results: [{ place: 1, login: 'b', score: 3, reward: 5000 }] } } },
    new Set(),
  );
  assert.deepEqual(board.sprint, { number: 45, endAt: 9, last: { number: 44, results: [{ place: 1, login: 'b', score: 3, reward: 5000 }] } });
  assert.equal(boardOf('level', { entries: 'nope' }, new Set()).entries.length, 0);
});

test('boards are cached for a minute, a failed board is skipped and a failed load keeps the last one', async () => {
  let now = 0;
  let calls = 0;
  let down = false;
  const boards = new Leaderboards({
    now: () => now,
    ownIds: () => new Set(),
    fetchBoard: async (by) => {
      calls += 1;
      if (down) return null;
      if (by === 'losers') throw new Error('timeout');
      return { entries: [raw()] };
    },
  });
  const first = await boards.get();
  assert.deepEqual(first.boards.map((board) => board.by), BOARDS.filter((by) => by !== 'losers'));
  assert.equal(calls, BOARDS.length);
  await boards.get();
  assert.equal(calls, BOARDS.length);
  now += CACHE_MS;
  down = true;
  assert.equal(await boards.get(), first);
  assert.equal(calls, 2 * BOARDS.length);
});
