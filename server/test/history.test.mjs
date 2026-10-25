// The progress history: what a sample holds, when one is kept, and how old
// samples thin out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { History, compact, snapshot } from '../src/history.mjs';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const report = (credits) => ({
  player: { login: 'alpha', level: 5, credits },
  accounts: [
    { id: 'a', login: 'alpha', level: 4, credits: 10, current: true },
    { id: 'b', login: 'beta', level: 2, credits: 50, current: false },
    { id: 'c', login: 'gamma', level: null, credits: null, current: false },
  ],
});

test('a snapshot takes live figures for the account playing and skips accounts with none', () => {
  assert.deepEqual(snapshot(report(99)), { values: { a: [5, 99], b: [2, 50] }, names: { a: 'alpha', b: 'beta' } });
  assert.deepEqual(snapshot(null), { values: {}, names: {} });
});

test('an unchanged sample is kept only once an hour, and the file reloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botter-history-'));
  try {
    const file = join(dir, 'history.json');
    const history = new History(file);
    const start = Date.now();
    assert.equal(history.record(report(1), start), true);
    assert.equal(history.record(report(1), start + 5 * 60_000), false);
    assert.equal(history.record(report(2), start + 10 * 60_000), true);
    assert.equal(history.record(report(2), start + 10 * 60_000 + HOUR), true);
    assert.equal(history.record({ accounts: [] }, start + 2 * HOUR), false);
    const reloaded = new History(file);
    assert.equal(reloaded.samples.length, 3);
    assert.deepEqual(reloaded.names, { a: 'alpha', b: 'beta' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('samples older than a week keep the last of each hour, and past a year they go', () => {
  const now = 1000 * DAY;
  const old = now - 10 * DAY;
  const samples = [
    { t: now - 400 * DAY, v: {} },
    { t: old, v: { a: [1, 1] } },
    { t: old + 10 * 60_000, v: { a: [1, 2] } },
    { t: old + HOUR, v: { a: [1, 3] } },
    { t: now - HOUR, v: { a: [2, 4] } },
    { t: now - HOUR + 60_000, v: { a: [2, 5] } },
  ];
  assert.deepEqual(
    compact(samples, now).map((sample) => sample.v.a?.[1]),
    [2, 3, 4, 5],
  );
});
