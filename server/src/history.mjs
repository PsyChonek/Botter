// Level and credits of every saved account over time, for the dashboard's
// progress charts. One JSON file under /data, next to storage.json.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const SAMPLE_EVERY_MS = 5 * 60_000;
// An unchanged sample is still kept this often, so a flat stretch has points.
const KEEP_FLAT_MS = 60 * 60_000;
// Past this age samples thin out to one per hour, and past the limit they go.
const FULL_DETAIL_MS = 7 * 24 * 3600_000;
const THIN_TO_MS = 60 * 60_000;
const KEEP_MS = 365 * 24 * 3600_000;

// The values the dashboard charts, from runner.report(): { id: [level, credits] }.
// The account playing has live figures in report.player; the saved ones lag.
export function snapshot(report) {
  const values = {};
  const names = {};
  for (const account of report?.accounts ?? []) {
    const live = account.current && report.player ? report.player : account;
    if (typeof live.level !== 'number' || typeof live.credits !== 'number') continue;
    values[account.id] = [live.level, live.credits];
    names[account.id] = account.login;
  }
  return { values, names };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Old samples keep the last one of each hour; the newest week stays whole.
export function compact(samples, now) {
  const kept = [];
  for (const [index, sample] of samples.entries()) {
    const age = now - sample.t;
    if (age > KEEP_MS) continue;
    const next = samples[index + 1];
    if (age > FULL_DETAIL_MS && next && Math.floor(next.t / THIN_TO_MS) === Math.floor(sample.t / THIN_TO_MS)) continue;
    kept.push(sample);
  }
  return kept;
}

export class History {
  constructor(file) {
    this.file = file;
    this.samples = [];
    this.names = {};
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      this.samples = data.samples ?? [];
      this.names = data.names ?? {};
    }
  }

  // Adds a sample when something moved, or when the last one is an hour old.
  record(report, now = Date.now()) {
    const { values, names } = snapshot(report);
    if (!Object.keys(values).length) return false;
    Object.assign(this.names, names);
    const last = this.samples.at(-1);
    if (last && same(last.v, values) && now - last.t < KEEP_FLAT_MS) return false;
    this.samples.push({ t: now, v: values });
    this.samples = compact(this.samples, now);
    this.save();
    return true;
  }

  toJSON() {
    return { names: this.names, samples: this.samples };
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this));
    renameSync(tmp, this.file);
  }
}
