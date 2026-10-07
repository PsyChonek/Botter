// Service worker: answers tickets the bank does not know, either with Chrome's
// on-device model or with Claude. Claude goes through raw fetch because the
// extension ships unbundled and the SDK needs a build step.
import './core.js';
import './local-model.js';

const { buildPrompt, parseAnswer, answerSchema, SYSTEM_PROMPT, claudeCost, createLogger } = globalThis.BotterCore;
const local = globalThis.BotterLocal;

const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_EFFORT = 'medium';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.5-flash';
const TIMEOUT_MS = 60_000;

let offscreenPromise = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  offscreenPromise ??= chrome.offscreen
    .createDocument({
      url: 'src/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Runs the on-device Prompt API, which is only exposed to window contexts.',
    })
    .finally(() => (offscreenPromise = null));
  await offscreenPromise;
}

// The Prompt API may not be exposed to the service worker; fall back to the
// offscreen document, which is a regular window context.
async function solveLocal(task) {
  if (local.supported()) return { index: await local.solve(task), cost: 0 };
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ kind: 'solve-local', task });
  if (!res?.ok) throw new Error(res?.error ?? 'offscreen_no_response');
  return { index: res.index, cost: 0 };
}

async function solveClaude(task, settings, log) {
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) throw new Error('no_api_key');
  const model = settings.model || DEFAULT_MODEL;
  const isHaiku = model.startsWith('claude-haiku');

  const body = {
    model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildPrompt(task) }],
    output_config: {
      format: { type: 'json_schema', schema: answerSchema(task) },
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
  const index = parseAnswer(text, task);
  const cost = claudeCost(data.model ?? model, data.usage);
  log.info('ai_answer', {
    model: data.model,
    type: task.type,
    index,
    cost,
    ms: Date.now() - started,
    inputTokens: data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
  });
  return { index, cost };
}

// OpenAI-compatible endpoint. json_schema is honoured by models that support it and
// ignored by the rest, so parseAnswer also accepts a bare number in prose.
async function solveOpenRouter(task, settings, log) {
  const { openrouterKey } = await chrome.storage.local.get('openrouterKey');
  if (!openrouterKey) throw new Error('no_api_key');
  const model = settings.openrouterModel || DEFAULT_OPENROUTER_MODEL;

  const started = Date.now();
  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${openrouterKey}`,
      'X-Title': 'Botter',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildPrompt(task) },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'answer', strict: true, schema: answerSchema(task) },
      },
      usage: { include: true },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`openrouter_${res.status}: ${data.error?.message ?? 'unknown error'}`);

  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error(`no_text (finish_reason: ${data.choices?.[0]?.finish_reason})`);
  const index = parseAnswer(text, task);
  const cost = typeof data.usage?.cost === 'number' ? data.usage.cost : null;
  log.info('ai_answer', {
    model: data.model,
    type: task.type,
    index,
    cost,
    ms: Date.now() - started,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  });
  return { index, cost };
}

const SOLVERS = { local: solveLocal, claude: solveClaude, openrouter: solveOpenRouter };

async function solve(task) {
  const { settings = {} } = await chrome.storage.local.get('settings');
  const log = createLogger(settings.logLevel);
  const started = Date.now();
  const answer = await (SOLVERS[settings.aiSolver] ?? solveLocal)(task, settings, log);
  log.debug('ai_solved', { solver: settings.aiSolver, type: task.type, ...answer, ms: Date.now() - started });
  return answer;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.kind !== 'solve') return false;
  solve(message.task).then(
    ({ index, cost }) => sendResponse({ ok: true, index, cost }),
    (err) => sendResponse({ ok: false, error: err.message }),
  );
  return true;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
