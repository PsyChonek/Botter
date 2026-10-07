// Runs in the page's own JS world at document_start, before the app bundle.
// Wraps fetch so the content script can see work tasks and their results
// without needing the user's auth token.
(() => {
  const WATCHED = /^\/api\/(me|work\/start|work\/submit)$/;
  const originalFetch = window.fetch;

  window.fetch = async function (input, init) {
    const response = await originalFetch.apply(this, arguments);
    try {
      const url = new URL(typeof input === 'string' ? input : input.url, location.href);
      if (url.origin === location.origin && WATCHED.test(url.pathname)) {
        let request = null;
        try {
          request = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        } catch {}
        response
          .clone()
          .json()
          .then((data) => {
            window.postMessage(
              { source: 'botter-hook', path: url.pathname, ok: response.ok, request, data },
              location.origin,
            );
          })
          .catch(() => {});
      }
    } catch {}
    return response;
  };
})();
