// Pure helpers shared by the content script, the service worker and the tests.
// Loaded as a classic script in the extension (exposes globalThis.BotterCore)
// and via require() in Node.
(function (root) {
  const TYPES = ['bughunt', 'output'];

  // cyrb53: small, fast, good enough to key a few thousand puzzles.
  function hash(str) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  // Options may come back shuffled, so the output key ignores their order.
  function taskKey(task) {
    if (task.type === 'bughunt') {
      return 'b:' + hash([task.lang, task.title, ...task.lines].join('\n'));
    }
    return 'o:' + hash([task.lang, task.code, ...[...task.options].sort()].join('\n'));
  }

  // What we persist for a solved task. Output puzzles store the option text so a
  // reshuffled copy of the same puzzle still resolves to the right button.
  function bankEntry(task, answerIndex) {
    if (task.type === 'bughunt') return { type: 'bughunt', line: answerIndex, text: task.lines[answerIndex] };
    return { type: 'output', text: task.options[answerIndex] };
  }

  function answerFromBank(task, entry) {
    if (!entry || entry.type !== task.type) return null;
    if (task.type === 'bughunt') {
      if (task.lines[entry.line] === entry.text) return entry.line;
      const i = task.lines.indexOf(entry.text);
      return i >= 0 ? i : null;
    }
    const i = task.options.indexOf(entry.text);
    return i >= 0 ? i : null;
  }

  function choices(task) {
    if (task.type === 'bughunt') {
      return task.lines.map((line, i) => (line.trim() ? i : -1)).filter((i) => i >= 0);
    }
    return task.options.map((_, i) => i);
  }

  function isValidAnswer(task, index) {
    return Number.isInteger(index) && choices(task).includes(index);
  }

  function randomChoice(task, rand = Math.random) {
    const all = choices(task);
    return all[Math.floor(rand() * all.length)];
  }

  function buildPrompt(task) {
    if (task.type === 'bughunt') {
      const lines = task.lines.map((line, i) => `${i}: ${line}`).join('\n');
      return [
        `A bug-hunt puzzle. Language: ${task.lang}. Ticket title (Czech): "${task.title}".`,
        'Exactly one line contains the bug that causes the described problem.',
        'Lines are prefixed with their 0-based index:',
        '```',
        lines,
        '```',
        'Reply with the 0-based index of the buggy line. Blank lines are never the answer.',
      ].join('\n');
    }
    const options = task.options.map((opt, i) => `${i}: ${opt}`).join('\n');
    return [
      `A "what does this print" puzzle. Language: ${task.lang}.`,
      '```',
      task.code,
      '```',
      'Options, prefixed with their 0-based index:',
      options,
      'Trace the code exactly as the real runtime would and reply with the 0-based index of the option that matches the printed output.',
    ].join('\n');
  }

  const SYSTEM_PROMPT =
    'You solve short programming puzzles from a code-review game. ' +
    'Read the code carefully, reason about the exact runtime behaviour, and answer with the index only. ' +
    'Reply with JSON only, in the form {"index": <number>}.';

  const ANSWER_SCHEMA = {
    type: 'object',
    properties: { index: { type: 'integer' } },
    required: ['index'],
    additionalProperties: false,
  };

  // Structured output gives clean JSON; models without it may wrap it in prose or fences.
  function parseAnswer(text) {
    try {
      const index = JSON.parse(text).index;
      if (Number.isInteger(index)) return index;
    } catch {}
    const match = text.match(/"index"\s*:\s*(\d+)/) ?? text.match(/\d+/);
    if (!match) throw new Error('unparseable_answer');
    return Number(match[1] ?? match[0]);
  }

  function delayBetween(min, max, rand = Math.random) {
    return Math.round(min + rand() * Math.max(0, max - min));
  }

  function nextType(preference, lastType) {
    if (TYPES.includes(preference)) return preference;
    return lastType === 'bughunt' ? 'output' : 'bughunt';
  }

  // Anthropic list prices in USD per million tokens (input, output).
  // Thinking tokens are billed as output and already included in output_tokens.
  const CLAUDE_PRICES = {
    'claude-opus-5-5': [4, 20],
    'claude-sonnet-5-5': [2, 10],
    'claude-haiku-4-5': [1, 5],
  };

  function claudeCost(model, usage) {
    const key = Object.keys(CLAUDE_PRICES).find((id) => model?.startsWith(id));
    if (!key || !usage) return null;
    const [input, output] = CLAUDE_PRICES[key];
    return ((usage.input_tokens ?? 0) * input + (usage.output_tokens ?? 0) * output) / 1e6;
  }

  // Same label the app renders in the task header, used to match DOM to data.
  function ticketLabel(id) {
    return `JIRA-${(parseInt(id.slice(0, 4), 16) % 9000) + 1000}`;
  }

  const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

  // Structured console logger; every line is one JSON object.
  function createLogger(level = 'info') {
    const min = LEVELS[level] ?? LEVELS.info;
    const emit = (lvl) => (msg, fields = {}) => {
      if (LEVELS[lvl] < min) return;
      const line = JSON.stringify({ app: 'botter', level: lvl, msg, ...fields });
      (lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log)(line);
    };
    return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
  }

  const api = {
    TYPES,
    ANSWER_SCHEMA,
    SYSTEM_PROMPT,
    hash,
    taskKey,
    bankEntry,
    answerFromBank,
    choices,
    isValidAnswer,
    randomChoice,
    buildPrompt,
    parseAnswer,
    delayBetween,
    nextType,
    claudeCost,
    ticketLabel,
    createLogger,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterCore = api;
})(globalThis);
