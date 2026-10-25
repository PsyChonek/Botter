// Single-operator login: one user name and password from the environment,
// random session tokens, and a per-IP limit on failed logins. Sessions are kept
// in a file (only their hashes), so a restart or rebuild does not sign out.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const COOKIE_NAME = 'botter_session';

const tokenHash = (token) => createHash('sha256').update(token).digest('base64url');

function loadSessions(file) {
  if (!file || !existsSync(file)) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(file, 'utf8'))));
  } catch {
    return new Map();
  }
}

export function createAuth({ user, password, file, sessionHours = 24 * 30, maxFailures = 10, windowMinutes = 15, now = Date.now }) {
  if (!user || !password) throw new Error('DASHBOARD_USER and DASHBOARD_PASSWORD must be set');
  if (password.length < 12) throw new Error('DASHBOARD_PASSWORD must be at least 12 characters');

  const salt = randomBytes(16);
  const hash = (value) => scryptSync(String(value), salt, 64);
  const expected = hash(`${user}\n${password}`);
  // token hash -> expiry
  const sessions = loadSessions(file);
  const failures = new Map();
  const windowMs = windowMinutes * 60_000;

  function save() {
    if (!file) return;
    for (const [key, expires] of sessions) if (expires < now()) sessions.delete(key);
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
    renameSync(tmp, file);
  }

  function blocked(ip) {
    const entry = failures.get(ip);
    if (!entry || now() - entry.first > windowMs) return false;
    return entry.count >= maxFailures;
  }

  function fail(ip) {
    const entry = failures.get(ip);
    if (!entry || now() - entry.first > windowMs) failures.set(ip, { first: now(), count: 1 });
    else entry.count += 1;
  }

  // Returns { token } on success, { error: 'rate_limited' | 'invalid' } otherwise.
  function login(ip, givenUser, givenPassword) {
    if (blocked(ip)) return { error: 'rate_limited' };
    const ok = timingSafeEqual(hash(`${givenUser}\n${givenPassword}`), expected);
    if (!ok) {
      fail(ip);
      return { error: 'invalid' };
    }
    failures.delete(ip);
    const token = randomBytes(32).toString('base64url');
    sessions.set(tokenHash(token), now() + sessionHours * 3_600_000);
    save();
    return { token };
  }

  function valid(token) {
    if (!token) return false;
    const expires = sessions.get(tokenHash(token));
    if (!expires) return false;
    if (expires < now()) {
      sessions.delete(tokenHash(token));
      return false;
    }
    return true;
  }

  // A session in use runs for another full period, saved at most once a day.
  function touch(token) {
    if (!valid(token)) return false;
    const expires = now() + sessionHours * 3_600_000;
    if (expires - sessions.get(tokenHash(token)) < 24 * 3_600_000) return true;
    sessions.set(tokenHash(token), expires);
    save();
    return true;
  }

  function logout(token) {
    if (token && sessions.delete(tokenHash(token))) save();
  }

  return { login, valid, touch, logout, maxAgeSeconds: sessionHours * 3600 };
}

export function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}
