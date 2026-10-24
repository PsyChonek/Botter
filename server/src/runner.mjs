// Runs the extension's own scripts with no browser. page-hook.js and the
// content scripts run in one vm context that stands in for the casino tab, the
// service worker's solvers in another. chrome.storage and localStorage come
// from the Store, API calls go straight to the casino with the saved session,
// and the reload the bot does to switch accounts boots a fresh page context.
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';
import { memoryStorage } from './store.mjs';
import { log } from './log.mjs';

const require = createRequire(import.meta.url);

const ACTIVITY_LIMIT = 500;
const REFRESH_EVERY_MS = 30_000;
// A session is refreshed this long before its access token runs out.
const REFRESH_AHEAD_MS = 5 * 60_000;
const SESSION_KEY = /^sb-.+-auth-token$/;
const ACCOUNT_PREFIX = 'account:';

// Web APIs the scripts use that a bare vm context does not have.
const WEB_GLOBALS = {
  URL,
  URLSearchParams,
  Headers,
  Request,
  Response,
  AbortController,
  AbortSignal,
  TextEncoder,
  TextDecoder,
  atob,
  btoa,
  structuredClone,
  queueMicrotask,
  crypto: globalThis.crypto,
  performance,
};

class StubEvent {
  constructor(type, init = {}) {
    Object.assign(this, init, { type });
  }
}

// chrome.i18n.getMessage: $name$ placeholders resolve to their content, then
// $1..$9 to the substitutions.
function i18n(extensionDir, locale) {
  const read = (lang) => {
    try {
      return JSON.parse(readFileSync(join(extensionDir, '_locales', lang, 'messages.json'), 'utf8'));
    } catch {
      return {};
    }
  };
  const table = { ...read('en'), ...read(locale) };
  return {
    getUILanguage: () => locale,
    getMessage(key, subs) {
      const entry = table[key];
      if (!entry) return '';
      const args = subs === undefined || subs === null ? [] : (Array.isArray(subs) ? subs : [subs]).map(String);
      return entry.message
        .replace(/\$([\w@]+)\$/g, (match, name) => entry.placeholders?.[name.toLowerCase()]?.content ?? match)
        .replace(/\$(\$|\d)/g, (match, digit) => (digit === '$' ? '$' : (args[Number(digit) - 1] ?? '')));
    },
  };
}

export class Runner extends EventEmitter {
  constructor({ extensionDir, store, casinoUrl, supabaseUrl, supabaseKey, locale = 'cs' }) {
    super();
    this.extensionDir = extensionDir;
    this.store = store;
    this.casinoUrl = new URL(casinoUrl);
    this.supabaseUrl = supabaseUrl;
    this.supabaseKey = supabaseKey;
    this.locale = locale;
    this.i18n = i18n(extensionDir, locale);
    this.core = require(join(extensionDir, 'src', 'core.js'));
    this.manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
    this.sessionStorage = memoryStorage();
    this.localStorage = store.localStorage();
    this.activity = [];
    this.page = null;
    this.solve = null;
    this.refreshTimer = null;
    this.bundleSrc = null;
  }

  async start() {
    this.bootBackground();
    await this.bootPage();
    this.refreshTimer = setInterval(() => this.refreshSession().catch((error) => log.warn('session_refresh_error', { error: error.message })), REFRESH_EVERY_MS);
  }

  stop() {
    clearInterval(this.refreshTimer);
    this.disposePage();
    this.store.flush();
  }

  script(name) {
    return readFileSync(join(this.extensionDir, name), 'utf8');
  }

  // Timers owned by one context, so a reload can stop everything it started.
  timers(alive) {
    const owned = new Set();
    const wrap = (create, clear) => ({
      start: (fn, ms, ...args) => {
        const id = create(() => {
          if (create === setTimeout) owned.delete(id);
          if (alive()) fn(...args);
        }, ms);
        owned.add(id);
        return id;
      },
      stop: (id) => {
        owned.delete(id);
        clear(id);
      },
    });
    const timeout = wrap(setTimeout, clearTimeout);
    const interval = wrap(setInterval, clearInterval);
    return {
      globals: { setTimeout: timeout.start, clearTimeout: timeout.stop, setInterval: interval.start, clearInterval: interval.stop },
      clearAll: () => {
        for (const id of owned) {
          clearTimeout(id);
          clearInterval(id);
        }
        owned.clear();
      },
    };
  }

  console(origin) {
    const write = (level) => (...args) => {
      const text = args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
      let entry = null;
      try {
        entry = JSON.parse(text);
      } catch {}
      if (entry?.app !== 'botter') return log[level === 'log' ? 'debug' : level]?.('script', { origin, text });
      process.stdout.write(text + '\n');
      const { app, level: lvl = 'info', msg = '', ...fields } = entry;
      const item = { time: new Date().toISOString(), level: lvl, msg, fields };
      this.activity.push(item);
      if (this.activity.length > ACTIVITY_LIMIT) this.activity.shift();
      this.emit('activity', item);
    };
    return { log: write('log'), info: write('info'), debug: write('debug'), warn: write('warn'), error: write('error') };
  }

  chromeStorage(subscribe) {
    const store = this.store;
    return {
      local: {
        get: async (keys) => store.get(keys),
        set: async (items) => store.set(items),
        remove: async (keys) => store.remove(keys),
      },
      onChanged: { addListener: (fn) => subscribe(fn) },
    };
  }

  // The service worker's solvers (Claude, OpenRouter; Gemini Nano has no
  // runtime here and fails over to the next answer source).
  bootBackground() {
    let handler = null;
    const unavailable = async () => {
      throw new Error('local_model_unavailable');
    };
    const context = vm.createContext({
      ...WEB_GLOBALS,
      setTimeout,
      clearTimeout,
      fetch,
      console: this.console('background'),
      chrome: {
        storage: this.chromeStorage(() => {}),
        runtime: { onMessage: { addListener: (fn) => (handler = fn) }, sendMessage: unavailable },
        offscreen: { hasDocument: async () => false, createDocument: unavailable },
        sidePanel: { setPanelBehavior: async () => {} },
      },
    });
    for (const name of ['src/core.js', 'src/local-model.js']) vm.runInContext(this.script(name), context, { filename: name });
    // background.js is a module whose imports are the two scripts above.
    const source = this.script('src/background.js').replace(/^import .*$/gm, '');
    vm.runInContext(source, context, { filename: 'src/background.js' });
    this.solve = (message) =>
      new Promise((resolve) => {
        if (!handler || !handler(message, {}, resolve)) resolve(undefined);
      });
  }

  async bootPage() {
    this.ensureSession();
    await this.refreshSession().catch((error) => log.warn('session_refresh_error', { error: error.message }));
    this.bundleSrc = await this.findBundle();

    let alive = true;
    // Inside the context `window` is its global proxy, not the object below,
    // and page-hook.js checks event.source against it.
    let global = null;
    const timers = this.timers(() => alive);
    const listeners = { message: new Set() };
    const unsubscribers = [];
    const casino = this.casinoUrl;

    const window = {
      ...WEB_GLOBALS,
      ...timers.globals,
      BotterHeadless: {},
      console: this.console('page'),
      navigator: { language: this.locale, languages: [this.locale] },
      location: {
        origin: casino.origin,
        href: casino.href,
        host: casino.host,
        hostname: casino.hostname,
        protocol: casino.protocol,
        pathname: casino.pathname,
        reload: () => setImmediate(() => this.reload()),
      },
      localStorage: this.localStorage,
      sessionStorage: this.sessionStorage,
      fetch: (input, init) => fetch(new URL(typeof input === 'string' ? input : input.url, casino), init),
      addEventListener: (type, fn) => listeners[type]?.add(fn),
      removeEventListener: (type, fn) => listeners[type]?.delete(fn),
      dispatchEvent: () => true,
      postMessage: (data, origin) => {
        const copy = structuredClone(data);
        setImmediate(() => {
          if (!alive) return;
          for (const fn of listeners.message) fn({ source: global, origin, data: copy });
        });
      },
      document: {
        readyState: 'complete',
        addEventListener: () => {},
        getElementById: () => null,
        querySelectorAll: () => [],
        // Only the bundle check asks for an element that exists headless.
        querySelector: (selector) => (selector.includes('/assets/index-') && this.bundleSrc ? { src: this.bundleSrc } : null),
      },
      Event: StubEvent,
      KeyboardEvent: StubEvent,
      chrome: {
        i18n: this.i18n,
        storage: this.chromeStorage((fn) => unsubscribers.push(this.store.onChanged((changes, area) => alive && fn(changes, area)))),
        runtime: { sendMessage: (message) => this.solve(message) },
      },
    };
    window.window = window;
    window.self = window;

    const context = vm.createContext(window);
    global = vm.runInContext('globalThis', context);
    const scripts = this.manifest.content_scripts.flatMap((entry) => entry.js);
    for (const name of scripts) vm.runInContext(this.script(name), context, { filename: name });

    this.page = {
      window,
      dispose: () => {
        alive = false;
        timers.clearAll();
        for (const off of unsubscribers) off();
      },
    };
    log.info('page_booted', { session: !!this.readSession() });
  }

  disposePage() {
    this.page?.dispose();
    this.page = null;
  }

  async reload() {
    this.disposePage();
    await this.bootPage();
  }

  report() {
    return this.page?.window.BotterHeadless.report?.() ?? null;
  }

  // The casino's current bundle name, for the bot's model check.
  async findBundle() {
    try {
      const res = await fetch(this.casinoUrl, { signal: AbortSignal.timeout(15_000) });
      const match = (await res.text()).match(/src="(\/assets\/index-[\w-]+\.js)"/);
      return match ? new URL(match[1], this.casinoUrl).href : null;
    } catch (error) {
      log.warn('bundle_lookup_failed', { error: error.message });
      return null;
    }
  }

  readSession() {
    for (let i = 0; i < this.localStorage.length; i++) {
      const key = this.localStorage.key(i);
      if (SESSION_KEY.test(key)) return { key, raw: this.localStorage.getItem(key) };
    }
    return null;
  }

  storageKey() {
    return `sb-${new URL(this.supabaseUrl).hostname.split('.')[0]}-auth-token`;
  }

  accounts() {
    return Object.entries(this.store.get(null))
      .filter(([key]) => key.startsWith(ACCOUNT_PREFIX))
      .map(([key, value]) => [key.slice(ACCOUNT_PREFIX.length), value]);
  }

  // With no one logged in, the page logs in as a saved account: home first,
  // then any other that has a session and is not set aside.
  ensureSession() {
    if (this.readSession()) return;
    const { settings = {} } = this.store.get('settings');
    const now = Date.now();
    const usable = this.accounts().filter(([, saved]) => saved.session && !(saved.brokenUntil > now));
    const [id, saved] = usable.find(([id]) => id === settings.homeAccount) ?? usable[0] ?? [];
    if (!saved) return;
    this.localStorage.setItem(saved.storageKey ?? this.storageKey(), saved.session);
    log.info('session_restored', { login: saved.login ?? id });
  }

  // supabase-js refreshes the session in the browser; here the runner does,
  // and files the new one under its account straight away, since the server
  // has revoked the refresh token it replaced.
  async refreshSession() {
    const current = this.readSession();
    if (!current) return;
    let session;
    try {
      session = JSON.parse(current.raw);
    } catch {
      return;
    }
    if (session.expires_at * 1000 - Date.now() > REFRESH_AHEAD_MS) return;
    const res = await fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: this.supabaseKey },
      body: JSON.stringify({ refresh_token: session.refresh_token }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      log.warn('session_refresh_failed', { status: res.status, error: data.error_description ?? data.msg ?? data.error });
      return;
    }
    this.saveSession(data, current);
  }

  // Stores a session the auth server issued: in localStorage when it still
  // belongs to whoever is logged in there, and on the saved account always.
  saveSession(data, replacing = null) {
    const raw = this.core.sessionFromToken(data);
    const id = this.core.tokenSubject(data.access_token);
    if (!raw || !id) return null;
    const now = this.readSession();
    const key = replacing?.key ?? now?.key ?? this.storageKey();
    if (!replacing || now?.raw === replacing.raw) this.localStorage.setItem(key, raw);
    const saved = this.store.get(ACCOUNT_PREFIX + id)[ACCOUNT_PREFIX + id];
    if (saved && this.core.isNewerSession(raw, saved.session)) this.store.set({ [ACCOUNT_PREFIX + id]: { ...saved, session: raw, storageKey: key } });
    return id;
  }

  // Signs in with a casino e-mail login. Only the session is kept, never the password.
  async signIn(email, password) {
    const res = await fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: this.supabaseKey },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: res.status === 400 ? 'invalid' : 'failed' };
    const current = this.readSession();
    if (current) this.localStorage.removeItem(current.key);
    this.saveSession(data);
    await this.reload();
    return { ok: true };
  }

  // Logs the page in as a saved account, like the panel's account switch.
  async switchTo(id) {
    const saved = this.store.get(ACCOUNT_PREFIX + id)[ACCOUNT_PREFIX + id];
    if (!saved?.session) return { error: 'no_session' };
    const current = this.readSession();
    if (current) this.localStorage.removeItem(current.key);
    this.localStorage.setItem(saved.storageKey ?? this.storageKey(), saved.session);
    await this.reload();
    return { ok: true };
  }
}
