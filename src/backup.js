// Full backup of the extension's storage: export everything, and on import
// apply the settings and merge the rest (stats added up, bank, levels, spins
// and accounts filled in). API keys and saved logins are left out unless asked
// for, since the file is plain JSON.
(function (root) {
  'use strict';

  const FORMAT = 'botter-backup';
  const VERSION = 1;
  const STATS_PREFIX = 'stats:';
  const ACCOUNT_PREFIX = 'account:';
  const SECRET_KEYS = ['apiKey', 'openrouterKey'];
  const SESSION_FIELDS = ['session', 'storageKey'];
  const MAX_SPINS = 2000;
  const MAX_CRASH_BOOKED = 50;
  const MAX_IMPORTED = 100;

  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const withoutSession = (record) => Object.fromEntries(Object.entries(record).filter(([key]) => !SESSION_FIELDS.includes(key)));

  // The backup of everything in storage (chrome.storage.local.get(null)). id
  // names this export and source the install it came from, so importing it
  // twice, or back into the same install, does not add the stats again.
  function buildBackup(stored, { secrets = false, id, source, now = Date.now() } = {}) {
    const stats = {};
    const accounts = {};
    for (const [key, value] of Object.entries(stored)) {
      if (key.startsWith(STATS_PREFIX)) stats[key.slice(STATS_PREFIX.length)] = value;
      else if (key.startsWith(ACCOUNT_PREFIX)) accounts[key.slice(ACCOUNT_PREFIX.length)] = secrets ? value : withoutSession(value);
    }
    if (stored.stats) stats[''] = stored.stats;
    const backup = {
      format: FORMAT,
      version: VERSION,
      id,
      source,
      exportedAt: new Date(now).toISOString(),
      settings: stored.settings ?? {},
      stats,
      accounts,
      levels: stored.levels ?? {},
      bank: stored.bank ?? {},
      spins: stored.spins ?? [],
    };
    if (secrets) for (const key of SECRET_KEYS) if (stored[key]) backup[key] = stored[key];
    return backup;
  }

  const isBackup = (data) => isObject(data) && data.format === FORMAT && Number(data.version) <= VERSION;

  // Two stats records of one account added up. Counters are summed; the day's
  // grinding loss and the flags describe this install's today and stay as
  // they are, only filled in where missing; dwell times keep the longer one,
  // the safer wait before a submit.
  function addStats(local = {}, incoming = {}) {
    const sum = (a, b) => {
      if (typeof a === 'number' && typeof b === 'number') return a + b;
      if (isObject(a) && isObject(b)) {
        const out = { ...a };
        for (const [key, value] of Object.entries(b)) out[key] = key in a ? sum(a[key], value) : value;
        return out;
      }
      return a ?? b;
    };
    const out = sum(local, incoming);
    out.grind = local.grind ?? incoming.grind;
    out.flags = { ...incoming.flags, ...local.flags };
    const dwell = { ...incoming.dwell };
    for (const [type, ms] of Object.entries(local.dwell ?? {})) dwell[type] = Math.max(ms, dwell[type] ?? 0);
    out.dwell = dwell;
    out.crashBooked = [...new Set([...(incoming.crashBooked ?? []), ...(local.crashBooked ?? [])])].slice(-MAX_CRASH_BOOKED);
    for (const key of ['grind', 'flags', 'dwell', 'crashBooked']) if (!(key in local) && !(key in incoming)) delete out[key];
    return out;
  }

  // Storage writes that import a backup into what is stored now:
  // { set, counts, statsSkipped }. Settings and given API keys are applied,
  // stats added up (unless this export was imported before or came from this
  // install), and the bank, level curve, spins and accounts merged with what is
  // here winning a conflict. isBankEntry(key, entry) keeps out broken answers.
  function importBackup(stored, backup, { install, isBankEntry = () => true } = {}) {
    if (!isBackup(backup)) throw new Error('not a backup');
    const set = {};
    const counts = { stats: 0, accounts: 0, answers: 0, levels: 0, spins: 0 };

    if (isObject(backup.settings)) set.settings = { ...stored.settings, ...backup.settings };
    for (const key of SECRET_KEYS) if (typeof backup[key] === 'string' && backup[key]) set[key] = backup[key];

    const imported = Array.isArray(stored.importedBackups) ? stored.importedBackups : [];
    const statsSkipped = (backup.source && backup.source === install) || (backup.id && imported.includes(backup.id));
    if (!statsSkipped && isObject(backup.stats)) {
      for (const [id, incoming] of Object.entries(backup.stats)) {
        if (!isObject(incoming)) continue;
        const key = id === '' ? 'stats' : STATS_PREFIX + id;
        set[key] = addStats(stored[key], incoming);
        counts.stats++;
      }
      if (backup.id) set.importedBackups = [...imported, backup.id].slice(-MAX_IMPORTED);
    }

    for (const [id, incoming] of Object.entries(isObject(backup.accounts) ? backup.accounts : {})) {
      if (!isObject(incoming)) continue;
      const key = ACCOUNT_PREFIX + id;
      const local = stored[key];
      if (local && Object.keys(incoming).every((field) => field in local)) continue;
      set[key] = { ...incoming, ...local };
      counts.accounts++;
    }

    const bank = stored.bank ?? {};
    const answers = Object.entries(isObject(backup.bank) ? backup.bank : {}).filter(
      ([key, entry]) => !(key in bank) && isBankEntry(key, entry),
    );
    if (answers.length) {
      set.bank = { ...bank, ...Object.fromEntries(answers) };
      counts.answers = answers.length;
    }

    const levels = { ...stored.levels };
    for (const [level, incoming] of Object.entries(isObject(backup.levels) ? backup.levels : {})) {
      if (!isObject(incoming)) continue;
      const merged = { ...incoming, ...levels[level] };
      if (JSON.stringify(merged) === JSON.stringify(levels[level])) continue;
      levels[level] = merged;
      counts.levels++;
    }
    if (counts.levels) set.levels = levels;

    if (Array.isArray(backup.spins) && backup.spins.length) {
      const local = stored.spins ?? [];
      const seen = new Set(local.map((spin) => JSON.stringify(spin)));
      const added = backup.spins.filter((spin) => isObject(spin) && !seen.has(JSON.stringify(spin)));
      if (added.length) {
        set.spins = [...added, ...local].slice(-MAX_SPINS);
        counts.spins = added.length;
      }
    }

    return { set, counts, statsSkipped: Boolean(statsSkipped) };
  }

  const api = { buildBackup, isBackup, addStats, importBackup };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterBackup = api;
})(globalThis);
