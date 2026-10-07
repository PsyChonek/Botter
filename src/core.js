// Pure helpers shared by the content script, the service worker and the tests.
// Loaded as a classic script in the extension (exposes globalThis.BotterCore)
// and via require() in Node.
(function (root) {
  const TYPES = ['bughunt', 'output', 'ticket'];

  // Triage fields of the "Založ task" ticket, copied from the app. The answer is
  // one number with a digit per field: type * 100 + priority * 10 + team.
  const TICKET_FIELDS = [
    {
      key: 'type',
      options: ['Chyba', 'Požadavek', 'Dotaz', 'Přístup'],
      rules: [
        'něco, co má fungovat, nefunguje',
        'chtějí něco nového nebo změnu (i jednorázový export)',
        'nic se nemění, potřebují jen poradit',
        'účty, hesla, oprávnění',
      ],
    },
    {
      key: 'priority',
      options: ['Nízká', 'Střední', 'Vysoká', 'Kritická'],
      rules: [
        'kosmetika, dotaz bez spěchu, „až bude čas“',
        'vadí, ale dá se to obejít, nebo je termín daleko',
        'někdo nemůže pracovat, nebo je termín do pár dní',
        'nefunguje to všem, nebo firma právě teď přichází o peníze',
      ],
    },
    {
      key: 'team',
      options: ['Vývoj', 'Data a reporty', 'Infrastruktura', 'Podpora'],
      rules: ['aplikace, web, e-shop', 'reporty, exporty, dashboardy', 'servery, síť, přístupy', 'všechny dotazy uživatelů'],
    },
  ];

  const encodeTicket = (digits) => digits[0] * 100 + digits[1] * 10 + digits[2];
  const decodeTicket = (n) => [Math.floor(n / 100), Math.floor(n / 10) % 10, n % 10];

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
    if (task.type === 'ticket') return 't:' + hash([task.from, task.message].join('\n'));
    return 'o:' + hash([task.lang, task.code, ...[...task.options].sort()].join('\n'));
  }

  // What we persist for a solved task. Output puzzles store the option text so a
  // reshuffled copy of the same puzzle still resolves to the right button.
  function bankEntry(task, answerIndex) {
    if (task.type === 'bughunt') return { type: 'bughunt', line: answerIndex, text: task.lines[answerIndex] };
    if (task.type === 'ticket') return { type: 'ticket', answer: answerIndex };
    return { type: 'output', text: task.options[answerIndex] };
  }

  function answerFromBank(task, entry) {
    if (!entry || entry.type !== task.type) return null;
    if (task.type === 'bughunt') {
      if (task.lines[entry.line] === entry.text) return entry.line;
      const i = task.lines.indexOf(entry.text);
      return i >= 0 ? i : null;
    }
    if (task.type === 'ticket') return Number.isInteger(entry.answer) ? entry.answer : null;
    const i = task.options.indexOf(entry.text);
    return i >= 0 ? i : null;
  }

  // Guards a bank import: the key prefix and entry shape must match a known type.
  function isBankEntry(key, entry) {
    if (!entry || typeof key !== 'string') return false;
    if (entry.type === 'ticket') return key.startsWith('t:') && Number.isInteger(entry.answer);
    const prefix = { bughunt: 'b:', output: 'o:' }[entry.type];
    return Boolean(prefix) && key.startsWith(prefix) && typeof entry.text === 'string';
  }

  function choices(task) {
    if (task.type === 'bughunt') {
      return task.lines.map((line, i) => (line.trim() ? i : -1)).filter((i) => i >= 0);
    }
    if (task.type === 'ticket') {
      const [a, b, c] = TICKET_FIELDS.map((f) => f.options.map((_, i) => i));
      return a.flatMap((x) => b.flatMap((y) => c.map((z) => encodeTicket([x, y, z]))));
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
        'Answer as {"index": <number>}.',
      ].join('\n');
    }
    if (task.type === 'ticket') {
      const fields = TICKET_FIELDS.map((field) =>
        [`${field.key}:`, ...field.options.map((opt, i) => `  ${i}: ${opt} (${field.rules[i]})`)].join('\n'),
      );
      return [
        'A help-desk triage puzzle. Read the message (Czech) and file it as a task.',
        `From: ${task.from}`,
        'Message:',
        '"""',
        task.message,
        '"""',
        'Pick one option per field. Options are prefixed with their 0-based index and the rule for when they apply:',
        ...fields,
        'Answer as {"type": <index>, "priority": <index>, "team": <index>}.',
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
      'Answer as {"index": <number>}.',
    ].join('\n');
  }

  const SYSTEM_PROMPT =
    'You solve short puzzles from an office game: programming puzzles and help-desk ticket triage. ' +
    'For code, reason about the exact runtime behaviour. For tickets, apply the given rules literally. ' +
    'Reply with JSON only, in the form the puzzle asks for.';

  const ANSWER_SCHEMA = {
    type: 'object',
    properties: { index: { type: 'integer' } },
    required: ['index'],
    additionalProperties: false,
  };

  const TICKET_SCHEMA = {
    type: 'object',
    properties: Object.fromEntries(TICKET_FIELDS.map((f) => [f.key, { type: 'integer' }])),
    required: TICKET_FIELDS.map((f) => f.key),
    additionalProperties: false,
  };

  const answerSchema = (task) => (task.type === 'ticket' ? TICKET_SCHEMA : ANSWER_SCHEMA);

  function parseTicket(text) {
    const digits = TICKET_FIELDS.map((f) => Number(text.match(new RegExp(`"${f.key}"\\s*:\\s*(\\d+)`))?.[1] ?? NaN));
    if (digits.some((d, i) => !(d < TICKET_FIELDS[i].options.length))) throw new Error('unparseable_answer');
    return encodeTicket(digits);
  }

  // Structured output gives clean JSON; models without it may wrap it in prose or fences.
  // A ticket comes back as one index per field, encoded the way the app submits it.
  function parseAnswer(text, task) {
    if (task?.type === 'ticket') return parseTicket(text);
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

  const MAX_DWELL_MS = 60_000;

  // Least time a task stays open before the bot submits it: what a quick reader
  // needs for a "Založ task" message, or the minimum the server proved to enforce
  // by rejecting a faster submit, whichever is longer.
  function minDwellMs(task, learned = 0) {
    const read = task.type === 'ticket' ? 2000 + 25 * (task.message?.length ?? 0) : 0;
    return Math.max(read, learned);
  }

  // New minimum after the server rejected a submit made `rejectedAfterMs` after
  // the task opened: comfortably above both, so one rejection is usually enough.
  function slowerDwell(learned = 0, rejectedAfterMs = 0) {
    return Math.min(MAX_DWELL_MS, Math.round(Math.max(learned, rejectedAfterMs) * 1.5) + 1000);
  }

  function nextType(preference, lastType) {
    if (TYPES.includes(preference)) return preference;
    return TYPES[(TYPES.indexOf(lastType) + 1) % TYPES.length];
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

  // User id (JWT `sub`) of a supabase access token, or the token itself for the
  // casino's dev login (`dev:name`). Only the payload is decoded, nothing is verified.
  function tokenSubject(token) {
    if (typeof token !== 'string') return null;
    const bare = token.replace(/^Bearer\s+/i, '');
    if (bare.startsWith('dev:')) return bare;
    try {
      const payload = bare.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      return JSON.parse(atob(payload)).sub ?? null;
    } catch {
      return null;
    }
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
    TICKET_FIELDS,
    SYSTEM_PROMPT,
    answerSchema,
    decodeTicket,
    hash,
    taskKey,
    bankEntry,
    answerFromBank,
    isBankEntry,
    choices,
    isValidAnswer,
    randomChoice,
    buildPrompt,
    parseAnswer,
    delayBetween,
    minDwellMs,
    slowerDwell,
    nextType,
    claudeCost,
    ticketLabel,
    tokenSubject,
    createLogger,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterCore = api;
})(globalThis);
