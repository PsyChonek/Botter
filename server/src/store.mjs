// What the extension keeps in chrome.storage.local and the page's localStorage,
// in one JSON file under /data. Writes are batched and land atomically.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const SAVE_DELAY_MS = 1000;

export class Store {
  constructor(file) {
    this.file = file;
    this.local = {};
    this.page = {};
    this.listeners = new Set();
    this.timer = null;
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      this.local = data.local ?? {};
      this.page = data.page ?? {};
    }
  }

  // chrome.storage.local.get: null for everything, a key, a list of keys, or
  // an object of keys with defaults.
  get(keys) {
    if (keys === null || keys === undefined) return structuredClone(this.local);
    if (typeof keys === 'string') keys = [keys];
    const defaults = Array.isArray(keys) ? {} : keys;
    const out = {};
    for (const key of Array.isArray(keys) ? keys : Object.keys(keys)) {
      if (key in this.local) out[key] = structuredClone(this.local[key]);
      else if (key in defaults) out[key] = defaults[key];
    }
    return out;
  }

  set(items) {
    const changes = {};
    for (const [key, value] of Object.entries(items)) {
      if (value === undefined) continue;
      changes[key] = { oldValue: this.local[key], newValue: structuredClone(value) };
      this.local[key] = structuredClone(value);
    }
    this.changed(changes);
  }

  remove(keys) {
    const changes = {};
    for (const key of typeof keys === 'string' ? [keys] : keys) {
      if (!(key in this.local)) continue;
      changes[key] = { oldValue: this.local[key] };
      delete this.local[key];
    }
    this.changed(changes);
  }

  changed(changes) {
    if (!Object.keys(changes).length) return;
    this.scheduleSave();
    for (const listener of this.listeners) {
      // Listeners get their own copy, like chrome.storage.onChanged.
      setImmediate(() => listener(structuredClone(changes), 'local'));
    }
  }

  onChanged(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // The page's localStorage, persisted with the rest.
  localStorage() {
    const page = this.page;
    const save = () => this.scheduleSave();
    return {
      get length() {
        return Object.keys(page).length;
      },
      key: (index) => Object.keys(page)[index] ?? null,
      getItem: (key) => (key in page ? page[key] : null),
      setItem: (key, value) => {
        page[key] = String(value);
        save();
      },
      removeItem: (key) => {
        delete page[key];
        save();
      },
      clear: () => {
        for (const key of Object.keys(page)) delete page[key];
        save();
      },
    };
  }

  scheduleSave() {
    this.timer ??= setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ local: this.local, page: this.page }));
    renameSync(tmp, this.file);
  }
}

// A sessionStorage that lives as long as the process, so it survives the
// reloads the bot does to switch accounts.
export function memoryStorage() {
  const items = new Map();
  return {
    get length() {
      return items.size;
    },
    key: (index) => [...items.keys()][index] ?? null,
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
    clear: () => items.clear(),
  };
}
