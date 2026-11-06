// Runs the extension's own scripts with no browser. Every saved account gets a
// tab of its own: page-hook.js and the content scripts run in one vm context
// per account that stands in for a casino tab logged in as it, all at once and
// each pinned to its account (no rotation). The service worker's solvers run in
// another context. chrome.storage is the shared Store, each tab has its own
// localStorage (session, pacing, learned speeds), and API calls go straight to
// the casino with that tab's session. The dashboard mirrors the home tab's panel.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import vm from 'node:vm';
import { createDom } from './dom.mjs';
import { memoryStorage } from './store.mjs';
import { log } from './log.mjs';

const require = createRequire(import.meta.url);

const ACTIVITY_LIMIT = 500;
const PLAY_LIMIT = 300;
// The tab that runs while no account is saved, showing the logged-out panel.
const LOGIN_TAB = '';
const REFRESH_EVERY_MS = 30_000;
// A session is refreshed this long before its access token runs out.
const REFRESH_AHEAD_MS = 5 * 60_000;
const SESSION_KEY = /^sb-.+-auth-token$/;
const ACCOUNT_PREFIX = 'account:';
// A GitHub sign-in the dashboard started has this long to come back.
const GITHUB_FLOW_MS = 15 * 60_000;
const GITHUB_FLOWS_MAX = 20;

// The code from what the dashboard pasted: the casino address the sign-in
// landed on, or the code alone.
function oauthCode(input) {
  const text = input.trim();
  if (/^[\w-]{16,}$/.test(text)) return text;
  try {
    return new URL(text).searchParams.get('code');
  } catch {
    return null;
  }
}

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
    this.activity = [];
    this.plays = [];
    // id -> { id, localStorage, sessionStorage, page }
    this.tabs = new Map();
    this.solve = null;
    this.refreshTimer = null;
    this.bundleSrc = null;
    this.reloadTimer = null;
    this.githubFlows = new Map();
    // A login that arrives for an account with no tab yet (a backup imported
    // in the settings) gets its tab at once instead of on the next check.
    store.onChanged((changes) => {
      if (this.reloadTimer || !this.started) return;
      const fresh = Object.entries(changes).some(([key, change]) => key.startsWith(ACCOUNT_PREFIX) && change.newValue?.session && !this.tabs.has(key.slice(ACCOUNT_PREFIX.length)));
      if (!fresh) return;
      this.reloadTimer = setTimeout(() => {
        this.reloadTimer = null;
        this.syncTabs().catch((error) => log.warn('tabs_sync_error', { error: error.message }));
      }, 1000);
    });
  }

  async start() {
    this.started = true;
    this.bootBackground();
    this.adoptLegacyPage();
    await this.syncTabs();
    this.refreshTimer = setInterval(() => this.tick().catch((error) => log.warn('session_refresh_error', { error: error.message })), REFRESH_EVERY_MS);
  }

  async tick() {
    await this.syncTabs();
    for (const tab of this.tabs.values()) await this.refreshSession(tab);
  }

  stop() {
    this.started = false;
    clearInterval(this.refreshTimer);
    clearTimeout(this.reloadTimer);
    for (const tab of this.tabs.values()) this.disposePage(tab);
    this.store.flush();
  }

  // The single page of before kept its localStorage unnamed; it moves to the
  // account its session belongs to, so that tab keeps its learned speeds.
  adoptLegacyPage() {
    const legacy = this.store.localStorage();
    if (!legacy.length) return;
    const items = {};
    for (let i = 0; i < legacy.length; i++) items[legacy.key(i)] = legacy.getItem(legacy.key(i));
    const session = Object.entries(items).find(([key]) => SESSION_KEY.test(key));
    let id = null;
    try {
      id = session && this.core.tokenSubject(JSON.parse(session[1])?.access_token);
    } catch {}
    if (!id) return;
    const target = this.store.localStorage(id);
    if (!target.length) for (const [key, value] of Object.entries(items)) target.setItem(key, value);
    legacy.clear();
    log.info('page_storage_moved', { id });
  }

  // Opens a tab for every saved account with a login, and the login tab
  // while there is none.
  async syncTabs() {
    const ids = this.accounts()
      .filter(([, saved]) => saved.session)
      .map(([id]) => id);
    for (const id of ids) if (!this.tabs.has(id)) await this.openTab(id);
    if (ids.length && this.tabs.has(LOGIN_TAB)) this.closeTab(LOGIN_TAB);
    if (!this.tabs.size) await this.openTab(LOGIN_TAB);
  }

  // A tab logged in as id: its own localStorage, given the account's saved
  // login unless it holds a newer one (raw, a session just issued, wins).
  async openTab(id, raw = null) {
    const tab = { id, localStorage: this.store.localStorage(id), sessionStorage: memoryStorage(), page: null };
    this.tabs.set(id, tab);
    const saved = id ? this.store.get(ACCOUNT_PREFIX + id)[ACCOUNT_PREFIX + id] : null;
    const session = raw ?? saved?.session;
    const current = this.readSession(tab);
    if (session && (!current || this.core.isNewerSession(session, current.raw))) {
      if (current) tab.localStorage.removeItem(current.key);
      tab.localStorage.setItem(current?.key ?? saved?.storageKey ?? this.storageKey(), session);
    }
    await this.bootPage(tab);
    return tab;
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.disposePage(tab);
    this.tabs.delete(id);
  }

  // The tab whose panel the dashboard mirrors: home, else any. Every tab
  // runs either way; the panel's controls are shared settings.
  focusTab() {
    const { settings = {} } = this.store.get('settings');
    return this.tabs.get(settings.homeAccount) ?? this.tabs.values().next().value ?? null;
  }

  get page() {
    return this.focusTab()?.page ?? null;
  }

  loginOf(id) {
    return id ? (this.store.get(ACCOUNT_PREFIX + id)[ACCOUNT_PREFIX + id]?.login ?? null) : null;
  }

  // A played round, ticket, spin or reward from a tab, for the play feed.
  addPlay(tab, item) {
    const play = { ...item, account: item.account ?? this.loginOf(tab.id) };
    this.plays.push(play);
    if (this.plays.length > PLAY_LIMIT) this.plays.shift();
    this.emit('play', play);
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

  console(origin, tab = null) {
    const write = (level) => (...args) => {
      const text = args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ');
      let entry = null;
      try {
        entry = JSON.parse(text);
      } catch {}
      if (entry?.app !== 'botter') return log[level === 'log' ? 'debug' : level]?.('script', { origin, text });
      process.stdout.write(text + '\n');
      const { app, level: lvl = 'info', msg = '', ...fields } = entry;
      const item = { time: new Date().toISOString(), level: lvl, msg, fields, ...(tab?.id ? { account: this.loginOf(tab.id) } : {}) };
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

  async bootPage(tab) {
    await this.refreshSession(tab).catch((error) => log.warn('session_refresh_error', { error: error.message }));
    this.bundleSrc = await this.findBundle();

    let alive = true;
    // Inside the context `window` is its global proxy, not the object below,
    // and page-hook.js checks event.source against it.
    let global = null;
    const timers = this.timers(() => alive);
    const listeners = { message: new Set() };
    const unsubscribers = [];
    const casino = this.casinoUrl;
    const dom = createDom(this.bundleSrc);

    const window = {
      ...WEB_GLOBALS,
      ...timers.globals,
      BotterHeadless: { pinned: true, play: (item) => alive && this.addPlay(tab, item) },
      console: this.console('page', tab),
      navigator: { language: this.locale, languages: [this.locale] },
      location: {
        origin: casino.origin,
        href: casino.href,
        host: casino.host,
        hostname: casino.hostname,
        protocol: casino.protocol,
        pathname: casino.pathname,
        reload: () => setImmediate(() => this.reload(tab)),
      },
      localStorage: tab.localStorage,
      sessionStorage: tab.sessionStorage,
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
      document: dom.document,
      Option: dom.window.Option,
      Event: dom.window.Event,
      KeyboardEvent: dom.window.KeyboardEvent ?? dom.window.Event,
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

    tab.page = {
      window,
      document: dom.document,
      dispose: () => {
        alive = false;
        timers.clearAll();
        for (const off of unsubscribers) off();
      },
    };
    log.info('page_booted', { session: !!this.readSession(tab), account: this.loginOf(tab.id) });
  }

  disposePage(tab) {
    tab.page?.dispose();
    tab.page = null;
  }

  async reload(tab) {
    if (this.tabs.get(tab.id) !== tab) return;
    this.disposePage(tab);
    await this.bootPage(tab);
  }

  // The home tab's panel, as HTML for the dashboard to mirror.
  panelHtml() {
    return this.page?.document.getElementById('botter-panel')?.shadowRoot?.innerHTML ?? '';
  }

  // Replays one dashboard interaction on the panel. path is the list of
  // element-child indexes from the panel's shadow root to the target.
  panelEvent({ path, type, value, open }) {
    let element = this.page?.document.getElementById('botter-panel')?.shadowRoot;
    for (const index of path) element = element?.children[index];
    if (!element || element === this.page.document) return false;
    const { Event } = this.page.window;
    if (type === 'click') element.click();
    else if (type === 'change') {
      element.value = value;
      element.dispatchEvent(new Event('change'));
    } else if (type === 'toggle') {
      element.open = open;
      element.dispatchEvent(new Event('toggle'));
    } else return false;
    return true;
  }

  async setLocale(locale) {
    this.locale = locale;
    this.i18n = i18n(this.extensionDir, locale);
    for (const tab of [...this.tabs.values()]) await this.reload(tab);
  }

  // The home tab's report, with every tab's status and player.
  report() {
    const report = this.page?.window.BotterHeadless.report?.() ?? null;
    if (!report) return null;
    const focus = this.focusTab();
    report.tabs = [...this.tabs.values()]
      .filter((tab) => tab.id)
      .map((tab) => {
        const own = tab === focus ? report : tab.page?.window.BotterHeadless.report?.();
        return { id: tab.id, login: own?.player?.login ?? this.loginOf(tab.id), status: own?.status ?? null, player: own?.player ?? null };
      });
    return report;
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

  readSession(tab = this.focusTab()) {
    const storage = tab?.localStorage;
    if (!storage) return null;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (SESSION_KEY.test(key)) return { key, raw: storage.getItem(key) };
    }
    return null;
  }

  // A GET on the casino API as the home tab's account. Null when it has
  // no login or the call fails.
  async casinoGet(path) {
    let token;
    try {
      token = JSON.parse(this.readSession()?.raw ?? 'null')?.access_token;
    } catch {}
    if (!token) return null;
    const res = await fetch(new URL(path, this.casinoUrl), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
      log.warn('casino_get_failed', { path, status: res.status });
      return null;
    }
    return res.json();
  }

  storageKey() {
    return `sb-${new URL(this.supabaseUrl).hostname.split('.')[0]}-auth-token`;
  }

  accounts() {
    return Object.entries(this.store.get(null))
      .filter(([key]) => key.startsWith(ACCOUNT_PREFIX))
      .map(([key, value]) => [key.slice(ACCOUNT_PREFIX.length), value]);
  }

  // supabase-js refreshes the session in the browser; here the runner does,
  // and files the new one under its account straight away, since the server
  // has revoked the refresh token it replaced.
  async refreshSession(tab) {
    const current = this.readSession(tab);
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
    this.saveSession(data, current, tab);
  }

  // Stores a session the auth server issued: in the account's tab when it
  // still holds the one replaced, and on the saved account always.
  saveSession(data, replacing = null, tab = null) {
    const raw = this.core.sessionFromToken(data);
    const id = this.core.tokenSubject(data.access_token);
    if (!raw || !id) return null;
    tab ??= this.tabs.get(id) ?? null;
    const now = tab ? this.readSession(tab) : null;
    const key = replacing?.key ?? now?.key ?? this.storageKey();
    if (tab && (!replacing || now?.raw === replacing.raw)) {
      if (now && now.key !== key) tab.localStorage.removeItem(now.key);
      tab.localStorage.setItem(key, raw);
    }
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
    await this.adopt(data);
    return { ok: true };
  }

  // GitHub sign-in with PKCE. The auth server only sends people back to the
  // casino, so the code lands in the casino's address bar (the casino ignores
  // it) and the dashboard pastes that address into githubFinish.
  githubStart() {
    const now = Date.now();
    for (const [id, flow] of this.githubFlows) if (now - flow.at > GITHUB_FLOW_MS) this.githubFlows.delete(id);
    if (this.githubFlows.size >= GITHUB_FLOWS_MAX) this.githubFlows.delete(this.githubFlows.keys().next().value);
    const id = randomUUID();
    const verifier = randomBytes(32).toString('base64url');
    this.githubFlows.set(id, { verifier, at: now });
    const url = new URL(`${this.supabaseUrl}/auth/v1/authorize`);
    url.search = new URLSearchParams({
      provider: 'github',
      redirect_to: this.casinoUrl.href,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 's256',
    });
    return { id, url: url.href };
  }

  async githubFinish(id, pasted) {
    const flow = this.githubFlows.get(id);
    if (!flow || Date.now() - flow.at > GITHUB_FLOW_MS) return { error: 'expired' };
    const code = oauthCode(pasted);
    if (!code) return { error: 'no_code' };
    this.githubFlows.delete(id);
    const res = await fetch(`${this.supabaseUrl}/auth/v1/token?grant_type=pkce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: this.supabaseKey },
      body: JSON.stringify({ auth_code: code, code_verifier: flow.verifier }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      log.warn('github_signin_failed', { status: res.status, error: data.error_description ?? data.msg ?? data.error });
      return { error: 'failed' };
    }
    await this.adopt(data);
    return { ok: true };
  }

  // Runs a fresh session in its account's tab, opening one for a new account,
  // and shows it on the dashboard.
  async adopt(data) {
    const id = this.core.tokenSubject(data.access_token);
    const raw = this.core.sessionFromToken(data);
    if (!id || !raw) return;
    const tab = this.tabs.get(id);
    if (tab) {
      this.saveSession(data, null, tab);
      await this.reload(tab);
    } else {
      this.saveSession(data);
      await this.openTab(id, raw);
    }
    this.closeTab(LOGIN_TAB);
  }
}
