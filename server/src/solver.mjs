// Answers work tickets the bank does not know, with Claude or any OpenRouter
// model. The keys and the model choice come from the shared storage, so they
// change with the settings and need no restart.
const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-5-5';
const DEFAULT_EFFORT = 'medium';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_OPENROUTER_MODEL = 'google/gemini-2.5-flash';
const TIMEOUT_MS = 60_000;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

// The bot's JSON log lines (BotterCore.createLogger), written to out so the
// runner can show them in the activity log.
function createLogger(level, out) {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl) => (msg, fields = {}) => {
    if (LEVELS[lvl] >= min) out[lvl](JSON.stringify({ app: 'botter', level: lvl, msg, ...fields }));
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export function createSolver({ store, core, console: out = globalThis.console, fetch = globalThis.fetch }) {
  const { buildPrompt, parseAnswer, answerSchema, SYSTEM_PROMPT, claudeCost } = core;

  async function solveClaude(task, settings, log) {
    const { apiKey } = store.get('apiKey');
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
        // Haiku 4.5 rejects effort; the current Opus and Sonnet use adaptive thinking driven by it.
        ...(isHaiku ? {} : { effort: settings.effort || DEFAULT_EFFORT }),
      },
      // Server-side fallback reroutes a safety decline instead of returning nothing.
      ...(isHaiku ? {} : { fallbacks: 'default' }),
    };
    const headers = { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
    if (!isHaiku) headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';

    const started = Date.now();
    const res = await fetch(API_URL, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
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

  // OpenAI-compatible endpoint. json_schema is honoured by models that support
  // it and ignored by the rest, so parseAnswer also accepts a bare number in prose.
  async function solveOpenRouter(task, settings, log) {
    const { openrouterKey } = store.get('openrouterKey');
    if (!openrouterKey) throw new Error('no_api_key');
    const model = settings.openrouterModel || DEFAULT_OPENROUTER_MODEL;

    const started = Date.now();
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${openrouterKey}`, 'X-Title': 'Botter' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildPrompt(task) },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: answerSchema(task) } },
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

  const SOLVERS = { claude: solveClaude, openrouter: solveOpenRouter };

  // The answer to one ticket, in the shape content.js expects back.
  return async function solve(task) {
    const { settings = {} } = store.get('settings');
    const solver = SOLVERS[settings.aiSolver];
    if (!solver) return { ok: false, error: 'no_solver' };
    const log = createLogger(settings.logLevel, out);
    try {
      const { index, cost } = await solver(task, settings, log);
      return { ok: true, index, cost };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  };
}
