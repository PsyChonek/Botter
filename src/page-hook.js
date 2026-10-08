// Runs in the page's own JS world at document_start, before the app bundle.
// - Wraps fetch so the content script sees every /api/ response (tasks, results,
//   game rounds, the player snapshot), tagged with the user id of the token the
//   request was made with, so the content script can file it under the right account.
// - Performs API calls for the game bot with the user's current session, so the
//   bot code never handles the token.
// - Reports every session the auth server issues, so the saved copy of a login
//   follows each refresh token rotation even when supabase-js drops the result.
(() => {
  const originalFetch = window.fetch;
  let lastAuth = null;
  let refreshing = 0; // token requests in flight
  let idleWaiters = [];

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

  const isPlayer = (value) =>
    value !== null && typeof value === 'object' && typeof value.credits === 'number' && typeof value.level === 'number' && 'work' in value;

  // The app loads the player once on mount and then only updates it from its
  // own calls, so rounds the bot plays would leave the credits, XP bar and level
  // on the page frozen. Find the app's player useState (the topmost state hook
  // holding a player) and hand it the fresh snapshot.
  function syncAppPlayer(player) {
    const root = document.getElementById('root');
    const key = root && Object.keys(root).find((k) => k.startsWith('__reactContainer$'));
    if (!key) return;
    const stack = [root[key]];
    while (stack.length) {
      const fiber = stack.pop();
      if (!fiber) continue;
      for (let hook = fiber.memoizedState; hook && typeof hook === 'object' && 'next' in hook; hook = hook.next) {
        if (hook.queue?.dispatch && isPlayer(hook.memoizedState)) {
          hook.queue.dispatch(player);
          return;
        }
      }
      // Sibling below child, so the walk is depth first, top down.
      stack.push(fiber.sibling, fiber.child);
    }
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

  const isTokenCall = (input) => {
    try {
      return new URL(typeof input === 'string' ? input : input.url, location.href).pathname.endsWith('/auth/v1/token');
    } catch {
      return false;
    }
  };

  // A refresh rotates the refresh token on the server before the response is
  // read. supabase-js discards the new tokens when localStorage changed while
  // the call ran (an account switch), and a reload loses them, so the session is
  // posted here as soon as it arrives.
  async function tokenFetch(self, args) {
    refreshing += 1;
    try {
      const response = await originalFetch.apply(self, args);
      if (response.ok) {
        const data = await response
          .clone()
          .json()
          .catch(() => null);
        if (data) post({ kind: 'session', data });
      }
      return response;
    } finally {
      refreshing -= 1;
      if (!refreshing) {
        idleWaiters.forEach((resolve) => resolve());
        idleWaiters = [];
      }
    }
  }

  window.fetch = async function (input, init) {
    if (isTokenCall(input)) return tokenFetch(this, arguments);
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
          .then((data) => post({ kind: 'response', path: url.pathname, ok: response.ok, status: response.status, request, data, uid }))
          .catch(() => {});
      }
    } catch {}
    return response;
  };

  // Resolves once no token request is in flight, so an account switch never
  // replaces the session while a refresh of it is still on the way.
  const idle = (timeoutMs) =>
    refreshing
      ? Promise.race([new Promise((resolve) => idleWaiters.push(resolve)), new Promise((resolve) => setTimeout(resolve, timeoutMs))])
      : Promise.resolve();

  window.addEventListener('message', async (event) => {
    if (event.source !== window || event.data?.source !== 'botter-content') return;
    if (event.data.kind === 'idle') {
      await idle(10_000);
      post({ kind: 'idle', id: event.data.id });
      return;
    }
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
      if (res.ok && isPlayer(data?.player)) {
        try {
          syncAppPlayer(data.player);
        } catch {}
      }
      post({ kind: 'api-result', id, ok: res.ok, status: res.status, data });
    } catch (err) {
      post({ kind: 'api-result', id, ok: false, status: 0, data: { error: String(err) } });
    }
  });
})();
