// Single-operator login: one user name and password from the environment,
// random session tokens kept in memory, and a per-IP limit on failed logins.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const COOKIE_NAME = 'botter_session';

export function createAuth({ user, password, sessionHours = 24 * 7, maxFailures = 10, windowMinutes = 15, now = Date.now }) {
  if (!user || !password) throw new Error('DASHBOARD_USER and DASHBOARD_PASSWORD must be set');
  if (password.length < 12) throw new Error('DASHBOARD_PASSWORD must be at least 12 characters');

  const salt = randomBytes(16);
  const hash = (value) => scryptSync(String(value), salt, 64);
  const expected = hash(`${user}\n${password}`);
  const sessions = new Map();
  const failures = new Map();
  const windowMs = windowMinutes * 60_000;

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
    sessions.set(token, now() + sessionHours * 3_600_000);
    return { token };
  }

  function valid(token) {
    if (!token) return false;
    const expires = sessions.get(token);
    if (!expires) return false;
    if (expires < now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  function logout(token) {
    sessions.delete(token);
  }

  return { login, valid, logout, maxAgeSeconds: sessionHours * 3600 };
}

export function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}
