// Runs in the page's own JS world at document_start, before the app bundle.
// - Wraps fetch so the content script sees every /api/ response (tasks, results,
//   game rounds, the player snapshot).
// - Performs API calls for the game bot with the user's current session, so the
//   token never leaves the page.
(() => {
  const originalFetch = window.fetch;
  let lastAuth = null;

  const post = (payload) => window.postMessage({ source: 'botter-hook', ...payload }, location.origin);

  function readAuth(headers) {
    if (!headers) return null;
    if (headers instanceof Headers) return headers.get('authorization');
    return headers.authorization ?? headers.Authorization ?? null;
  }

  // supabase-js keeps the session in localStorage and refreshes it on a timer,
  // so it is fresher than the last header the app happened to send.
  function currentAuth() {
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!/^sb-.+-auth-token$/.test(key)) continue;
        const token = JSON.parse(localStorage.getItem(key))?.access_token;
        if (token) return `Bearer ${token}`;
      }
    } catch {}
    return lastAuth;
  }

  window.fetch = async function (input, init) {
    const auth = readAuth(init?.headers);
    if (auth) lastAuth = auth;
    const response = await originalFetch.apply(this, arguments);
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
        let request = null;
        try {
          request = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        } catch {}
        response
          .clone()
          .json()
          .then((data) => post({ kind: 'response', path: url.pathname, ok: response.ok, request, data }))
          .catch(() => {});
      }
    } catch {}
    return response;
  };

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.source !== 'botter-content' || event.data.kind !== 'api') return;
    const { id, path, body } = event.data;
    if (typeof path !== 'string' || !/^\/api\/[\w/-]+(\?[\w=&-]+)?$/.test(path)) {
      post({ kind: 'api-result', id, ok: false, status: 0, data: { error: 'bad_path' } });
      return;
    }
    const auth = currentAuth();
    try {
      // Goes through the wrapped fetch, so the round is tracked like a manual one.
      const res = await window.fetch(path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      post({ kind: 'api-result', id, ok: res.ok, status: res.status, data });
    } catch (err) {
      post({ kind: 'api-result', id, ok: false, status: 0, data: { error: String(err) } });
    }
  });
})();
