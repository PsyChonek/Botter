// The extension APIs the settings page (options.html) uses, served by the
// dashboard: chrome.storage.local over /api/storage with onChanged from the
// server's event stream, and chrome.i18n from the extension's messages.
(() => {
  const lang = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'cs';
  const table = { ...window.BotterMessages.en, ...window.BotterMessages[lang] };

  function getMessage(key, subs) {
    const entry = table[key];
    if (!entry) return '';
    const args = subs === undefined || subs === null ? [] : (Array.isArray(subs) ? subs : [subs]).map(String);
    return entry.message
      .replace(/\$([\w@]+)\$/g, (match, name) => entry.placeholders?.[name.toLowerCase()]?.content ?? match)
      .replace(/\$(\$|\d)/g, (match, digit) => (digit === '$' ? '$' : (args[Number(digit) - 1] ?? '')));
  }

  let cache = {};
  const listeners = new Set();
  const ready = fetch('/api/storage')
    .then((res) => {
      if (res.status === 401) top.location.assign('/login');
      return res.json();
    })
    .then((data) => (cache = data));

  function pick(keys) {
    if (keys === null || keys === undefined) return structuredClone(cache);
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const defaults = Array.isArray(keys) || typeof keys === 'string' ? {} : keys;
    const out = {};
    for (const key of list) {
      if (key in cache) out[key] = structuredClone(cache[key]);
      else if (key in defaults) out[key] = defaults[key];
    }
    return out;
  }

  async function post(path, body) {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`storage_${res.status}`);
  }

  const local = {
    async get(keys) {
      await ready;
      return pick(keys);
    },
    // The cache updates at once so a read right after a write sees it; the
    // server's change event then fires onChanged, as chrome does.
    async set(items) {
      await ready;
      Object.assign(cache, structuredClone(items));
      await post('/api/storage/set', { items });
    },
    async remove(keys) {
      await ready;
      for (const key of typeof keys === 'string' ? [keys] : keys) delete cache[key];
      await post('/api/storage/remove', { keys: typeof keys === 'string' ? [keys] : keys });
    },
  };

  const events = new EventSource('/api/events?storage=1');
  events.addEventListener('storage', (event) => {
    const changes = JSON.parse(event.data);
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (newValue === undefined) delete cache[key];
      else cache[key] = newValue;
    }
    for (const listener of listeners) listener(changes, 'local');
  });

  const chrome = (window.chrome ??= {});
  chrome.storage = { local, onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) } };
  chrome.i18n = { getMessage, getUILanguage: () => lang };
  chrome.runtime = { ...chrome.runtime, sendMessage: async () => ({ ok: false, error: 'unavailable' }), getURL: (path) => `/ext/${path.replace(/^\/?src\//, '')}` };
})();
