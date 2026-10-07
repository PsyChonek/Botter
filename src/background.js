// Service worker: asks Claude for an answer when the bank does not know a task.
// Raw fetch because the extension ships unbundled and the SDK needs a build step.
import './core.js';

const { buildPrompt, parseAnswer, ANSWER_SCHEMA, createLogger } = globalThis.BotterCore;

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_EFFORT = 'medium';
const TIMEOUT_MS = 60_000;

const SYSTEM_PROMPT =
  'You solve short programming puzzles from a code-review game. ' +
  'Read the code carefully, reason about the exact runtime behaviour, and answer with the index only.';

async function solve(task) {
  const { apiKey, settings = {} } = await chrome.storage.local.get(['apiKey', 'settings']);
  if (!apiKey) throw new Error('no_api_key');
  const log = createLogger(settings.logLevel);
  const model = settings.model || DEFAULT_MODEL;
  const isHaiku = model.startsWith('claude-haiku');

  const body = {
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildPrompt(task) }],
    output_config: {
      format: { type: 'json_schema', schema: ANSWER_SCHEMA },
      // Haiku 4.5 rejects effort; the current Opus/Sonnet use adaptive thinking driven by it.
      ...(isHaiku ? {} : { effort: settings.effort || DEFAULT_EFFORT }),
    },
    // Server-side fallback reroutes a safety decline instead of returning nothing.
    ...(isHaiku ? {} : { fallbacks: 'default' }),
  };

  const headers = {
    'content-type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (!isHaiku) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';

  const started = Date.now();
  const res = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`api_${res.status}: ${data.error?.message ?? 'unknown error'}`);
  if (data.stop_reason === 'refusal') throw new Error('refusal');

  const text = data.content?.find((block) => block.type === 'text')?.text;
  if (!text) throw new Error(`no_text (stop_reason: ${data.stop_reason})`);
  const index = parseAnswer(text);
  log.info('ai_answer', {
    model: data.model,
    type: task.type,
    index,
    ms: Date.now() - started,
    inputTokens: data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
  });
  return index;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.kind !== 'solve') return false;
  solve(message.task).then(
    (index) => sendResponse({ ok: true, index }),
    (err) => sendResponse({ ok: false, error: err.message }),
  );
  return true;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
