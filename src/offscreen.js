// Offscreen document: hosts the Prompt API when the service worker cannot see it.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.kind !== 'solve-local') return false;
  globalThis.BotterLocal.solve(message.task).then(
    (index) => sendResponse({ ok: true, index }),
    (err) => sendResponse({ ok: false, error: err.message }),
  );
  return true;
});
