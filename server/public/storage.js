// The bot's shared storage as the browser sees it: a cache of /api/storage
// kept current by the server's change stream, and the bot's messages in the
// dashboard's language. Saved logins and API keys arrive as SECRET_MARK.
(() => {
  const SECRET_MARK = '[kept on the server]';
  let cache = {};
  const listeners = new Set();
  const ready = fetch('/api/storage')
    .then((res) => {
      if (res.status === 401) location.assign('/login');
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
    if (res.status === 401) location.assign('/login');
    if (!res.ok) throw new Error(`storage_${res.status}`);
    return res.json().catch(() => ({}));
  }

  const events = new EventSource('/api/events?storage=1');
  events.addEventListener('storage', (event) => {
    const changes = JSON.parse(event.data);
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (newValue === undefined) delete cache[key];
      else cache[key] = newValue;
    }
    for (const listener of listeners) listener(changes);
  });

  // $name$ placeholders resolve to their content, then $1..$9 to the substitutions.
  function message(key, subs) {
    const lang = window.I18n?.lang === 'en' ? 'en' : 'cs';
    const entry = window.BotterMessages[lang][key] ?? window.BotterMessages.en[key];
    if (!entry) return key;
    const args = subs === undefined || subs === null ? [] : (Array.isArray(subs) ? subs : [subs]).map(String);
    return entry.message
      .replace(/\$([\w@]+)\$/g, (match, name) => entry.placeholders?.[name.toLowerCase()]?.content ?? match)
      .replace(/\$(\$|\d)/g, (match, digit) => (digit === '$' ? '$' : (args[Number(digit) - 1] ?? '')));
  }

  window.BotterStorage = {
    SECRET_MARK,
    ready,
    // The cache updates at once so a read right after a write sees it; the
    // server's change event then tells every listener.
    async get(keys) {
      await ready;
      return pick(keys);
    },
    async set(items) {
      await ready;
      Object.assign(cache, structuredClone(items));
      await post('/api/storage/set', { items });
    },
    async remove(keys) {
      await ready;
      const list = typeof keys === 'string' ? [keys] : keys;
      for (const key of list) delete cache[key];
      await post('/api/storage/remove', { keys: list });
    },
    post,
    onChanged: (fn) => listeners.add(fn),
    message,
  };
})();
