// The session side of the bot for one account, run by the server in the
// account's context before content.js.
// - Wraps fetch so content.js sees every /api/ response (tasks, results, game
//   rounds, the player snapshot), tagged with the user id of the token the
//   request was made with, so it is filed under the right account.
// - Performs API calls for the bot with the account's current session, so the
//   bot code never handles the token.
(() => {
  const originalFetch = window.fetch;
  let lastAuth = null;

  const post = (payload) => window.postMessage({ source: 'botter-hook', ...payload }, location.origin);

  function readAuth(headers) {
    if (!headers) return null;
    if (headers instanceof Headers) return headers.get('authorization');
    return headers.authorization ?? headers.Authorization ?? null;
  }

  // The server keeps the session in localStorage and refreshes it there, so it
  // is fresher than the last header sent.
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

  // Same decoding as BotterCore.tokenSubject, which is not loaded in this world.
  function subject(auth) {
    const token = auth?.replace(/^Bearer\s+/i, '');
    if (!token) return null;
    if (token.startsWith('dev:')) return token;
    try {
      return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub ?? null;
    } catch {
      return null;
    }
  }

  window.fetch = async function (input, init) {
    const auth = readAuth(init?.headers);
    if (auth) lastAuth = auth;
    const response = await originalFetch.apply(this, arguments);
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.origin === location.origin && url.pathname.startsWith('/api/')) {
        const uid = subject(auth ?? currentAuth());
        let request = null;
        try {
          request = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        } catch {}
        response
          .clone()
          .json()
          .then((data) => post({ kind: 'response', path: url.pathname, ok: response.ok, status: response.status, retryAfter: response.headers.get('retry-after'), request, data, uid }))
          .catch(() => {});
      }
    } catch {}
    return response;
  };

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.source !== 'botter-content') return;
    if (event.data.kind !== 'api') return;
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
      post({ kind: 'api-result', id, ok: res.ok, status: res.status, retryAfter: res.headers.get('retry-after'), data });
    } catch (err) {
      post({ kind: 'api-result', id, ok: false, status: 0, data: { error: String(err) } });
    }
  });
})();
