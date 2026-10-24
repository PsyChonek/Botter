// Runs Chromium with the Botter extension loaded, keeps the casino tab open,
// streams the selected tab as JPEG frames and replays dashboard input into it.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { log } from './log.mjs';

const VIEWPORT = { width: 1280, height: 800 };
const ACTIVITY_LIMIT = 500;
const STATUS_INTERVAL_MS = 2_000;

// Reads the extension's on-page panel. Runs inside the casino tab.
function readPanel() {
  const root = document.getElementById('botter-panel')?.shadowRoot;
  if (!root) return null;
  const text = (selector) => root.querySelector(selector)?.textContent?.trim() ?? '';
  const account = root.querySelector('#account');
  return {
    status: text('.status'),
    auto: text('.auto-toggle'),
    work: text('.work-toggle'),
    games: text('.games-toggle'),
    account: account?.selectedOptions?.[0]?.textContent?.trim() ?? '',
  };
}

export class Bot extends EventEmitter {
  constructor({ extensionDir, profileDir, casinoUrl, headless = true }) {
    super();
    this.extensionDir = extensionDir;
    this.profileDir = profileDir;
    this.casinoUrl = casinoUrl;
    this.headless = headless;
    this.context = null;
    this.extensionId = '';
    this.tabs = new Map();
    this.currentId = '';
    this.cdp = null;
    this.activity = [];
    this.panel = null;
    this.lastFrame = null;
    this.statusTimer = null;
    this.closed = false;
  }

  async start() {
    // A container that was killed leaves Chromium's profile lock behind and the
    // next launch would refuse the profile.
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      rmSync(join(this.profileDir, name), { force: true });
    }

    this.context = await chromium.launchPersistentContext(this.profileDir, {
      channel: 'chromium',
      headless: this.headless,
      viewport: VIEWPORT,
      args: [`--disable-extensions-except=${this.extensionDir}`, `--load-extension=${this.extensionDir}`],
    });
    this.context.on('close', () => {
      this.closed = true;
      log.error('browser closed');
      this.emit('closed');
    });

    const worker = this.context.serviceWorkers()[0] ?? (await this.context.waitForEvent('serviceworker'));
    this.extensionId = new URL(worker.url()).host;
    log.info('extension loaded', { extensionId: this.extensionId });

    this.context.on('page', (page) => this.track(page));
    this.context.on('console', (message) => this.onConsole(message));
    for (const page of this.context.pages()) this.track(page);

    const casino = [...this.tabs.values()].find((tab) => tab.page.url().startsWith(this.casinoUrl));
    if (casino) await this.select(casino.id);
    else await this.open('casino');

    // Persistent profiles reopen with an about:blank tab; drop it once the casino is up.
    for (const tab of [...this.tabs.values()]) {
      if (tab.page.url() === 'about:blank' && this.tabs.size > 1) await tab.page.close();
    }

    this.statusTimer = setInterval(() => this.refreshPanel(), STATUS_INTERVAL_MS);
  }

  async stop() {
    clearInterval(this.statusTimer);
    await this.context?.close().catch(() => {});
  }

  get running() {
    return Boolean(this.context) && !this.closed;
  }

  track(page) {
    const known = [...this.tabs.values()].find((tab) => tab.page === page);
    if (known) return known.id;
    const id = randomBytes(6).toString('base64url');
    this.tabs.set(id, { id, page });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.emitState();
    });
    page.on('load', () => this.emitState());
    page.on('close', () => this.onClose(id));
    this.emitState();
    return id;
  }

  async onClose(id) {
    this.tabs.delete(id);
    if (this.currentId === id) {
      this.currentId = '';
      this.cdp = null;
      const next = this.tabs.keys().next().value;
      if (next) await this.select(next).catch((error) => log.warn('select failed', { error: error.message }));
      else if (this.context) await this.open('casino').catch((error) => log.warn('reopen failed', { error: error.message }));
    }
    this.emitState();
  }

  onConsole(message) {
    let entry;
    try {
      entry = JSON.parse(message.text());
    } catch {
      return;
    }
    if (entry?.app !== 'botter') return;
    const { app, level = 'info', msg = '', ...fields } = entry;
    const item = { time: new Date().toISOString(), level, msg, fields };
    this.activity.push(item);
    if (this.activity.length > ACTIVITY_LIMIT) this.activity.shift();
    this.emit('activity', item);
  }

  async refreshPanel() {
    const casino = [...this.tabs.values()].find((tab) => tab.page.url().startsWith(this.casinoUrl));
    const panel = casino ? await casino.page.evaluate(readPanel).catch(() => null) : null;
    if (JSON.stringify(panel) === JSON.stringify(this.panel)) return;
    this.panel = panel;
    this.emit('panel', panel);
  }

  async state() {
    const tabs = await Promise.all(
      [...this.tabs.values()].map(async ({ id, page }) => {
        const url = page.url();
        const settings = url.startsWith(`chrome-extension://${this.extensionId}/`);
        const title = settings ? 'Botter settings' : (await page.title().catch(() => '')) || url;
        return { id, url, title, current: id === this.currentId };
      }),
    );
    return { tabs, viewport: VIEWPORT, extensionId: this.extensionId };
  }

  async emitState() {
    this.emit('state', await this.state());
  }

  async open(target) {
    let url;
    if (target === 'casino') url = this.casinoUrl;
    else if (target === 'settings') url = `chrome-extension://${this.extensionId}/src/options.html`;
    else throw new Error('unknown_target');
    const page = await this.context.newPage();
    const id = this.track(page);
    await page.goto(url).catch((error) => log.warn('open failed', { url, error: error.message }));
    await this.select(id);
  }

  async select(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    if (this.cdp) await this.cdp.detach().catch(() => {});
    this.currentId = id;
    this.lastFrame = null;
    await tab.page.bringToFront();

    const cdp = await this.context.newCDPSession(tab.page);
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
      cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      if (this.cdp !== cdp) return;
      this.lastFrame = { data, width: metadata.deviceWidth, height: metadata.deviceHeight };
      this.emit('frame', this.lastFrame);
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height });

    // The screencast only sends a frame when something repaints; a still page
    // would stay blank, so send one screenshot right away.
    const shot = await tab.page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
    if (shot && this.cdp === cdp && !this.lastFrame) {
      this.lastFrame = { data: shot.toString('base64'), ...VIEWPORT };
      this.emit('frame', this.lastFrame);
    }
    this.emitState();
  }

  async close(id) {
    await this.tabs.get(id)?.page.close();
  }

  async navigate(action, url) {
    const page = this.tabs.get(this.currentId)?.page;
    if (!page) return;
    if (action === 'back') await page.goBack().catch(() => {});
    else if (action === 'forward') await page.goForward().catch(() => {});
    else if (action === 'reload') await page.reload().catch(() => {});
    else if (action === 'goto') {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('bad_url');
      await page.goto(parsed.href).catch((error) => log.warn('goto failed', { error: error.message }));
    }
  }

  // Replays one input event from the dashboard. Coordinates are CSS pixels.
  async input(event) {
    const page = this.tabs.get(this.currentId)?.page;
    if (!page) return;
    const { mouse, keyboard } = page;
    switch (event.kind) {
      case 'move':
        return mouse.move(event.x, event.y);
      case 'down':
        await mouse.move(event.x, event.y);
        return mouse.down({ button: event.button });
      case 'up':
        await mouse.move(event.x, event.y);
        return mouse.up({ button: event.button });
      case 'wheel':
        await mouse.move(event.x, event.y);
        return mouse.wheel(event.dx, event.dy);
      case 'keydown':
        return keyboard.down(event.key);
      case 'keyup':
        return keyboard.up(event.key);
      case 'text':
        return keyboard.insertText(event.text);
    }
  }
}
