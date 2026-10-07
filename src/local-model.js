// On-device solver using Chrome's built-in Prompt API (Gemini Nano).
// Classic script: loaded by the service worker (via import), the offscreen
// document and the options page. Needs globalThis.BotterCore loaded first.
(function (root) {
  const { buildPrompt, parseAnswer, ANSWER_SCHEMA, SYSTEM_PROMPT } = root.BotterCore;

  const OPTIONS = {
    expectedInputs: [{ type: 'text', languages: ['en'] }],
    expectedOutputs: [{ type: 'text', languages: ['en'] }],
  };
  let basePromise = null;

  const supported = () => typeof root.LanguageModel !== 'undefined';

  // 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported'
  async function availability() {
    if (!supported()) return 'unsupported';
    return root.LanguageModel.availability(OPTIONS);
  }

  // Creating the session triggers the model download; outside the options page
  // there is no user gesture, so only call this when the model is available.
  function create(monitor) {
    return root.LanguageModel.create({
      ...OPTIONS,
      initialPrompts: [{ role: 'system', content: SYSTEM_PROMPT }],
      ...(monitor ? { monitor } : {}),
    });
  }

  async function solve(task) {
    const state = await availability();
    if (state !== 'available') throw new Error(`local_model_${state}`);
    basePromise ??= create().catch((err) => {
      basePromise = null;
      throw err;
    });
    // Clone so each ticket starts from the system prompt only.
    const session = await (await basePromise).clone();
    try {
      const text = await session.prompt(buildPrompt(task), { responseConstraint: ANSWER_SCHEMA });
      return parseAnswer(text);
    } finally {
      session.destroy();
    }
  }

  root.BotterLocal = { supported, availability, create, solve };
})(globalThis);
