// The casino's leaderboards for the dashboard, fetched with the session the
// bot plays with and cached briefly, so an open tab costs one request per
// board a minute at most.
export const BOARDS = ['sprint', 'level', 'credits', 'biggest', 'losers', 'debtors'];
export const CACHE_MS = 60_000;
const AVATAR = /^https:\/\/avatars\.githubusercontent\.com\//;

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const text = (value) => (typeof value === 'string' ? value.slice(0, 100) : null);

// Only what the dashboard shows. An entry is marked own when it is one of the
// saved accounts, so every account the bot plays stands out, not only the
// one logged in.
export function entryOf(entry, ownIds) {
  return {
    rank: num(entry.rank),
    login: text(entry.login) ?? '?',
    avatar: AVATAR.test(entry.avatarUrl ?? '') ? entry.avatarUrl : null,
    title: text(entry.title),
    level: num(entry.level),
    prestige: num(entry.prestige) ?? 0,
    value: num(entry.value),
    debtor: entry.debtor === true,
    insolvent: entry.insolvent === true,
    me: entry.me === true,
    own: entry.me === true || ownIds.has(entry.id),
  };
}

export function boardOf(by, data, ownIds) {
  const board = { by, entries: (Array.isArray(data?.entries) ? data.entries : []).map((entry) => entryOf(entry, ownIds)) };
  const sprint = data?.sprint;
  if (sprint) {
    board.sprint = {
      number: num(sprint.number),
      endAt: num(sprint.endAt),
      last: Array.isArray(sprint.last?.results)
        ? {
            number: num(sprint.last.number),
            results: sprint.last.results.map((row) => ({ place: num(row.place), login: text(row.login) ?? '?', score: num(row.score), reward: num(row.reward) })),
          }
        : null,
    };
  }
  return board;
}

export class Leaderboards {
  // fetchBoard(by) resolves to the casino's JSON or null; ownIds() to a Set of saved account ids.
  constructor({ fetchBoard, ownIds, now = Date.now }) {
    this.fetchBoard = fetchBoard;
    this.ownIds = ownIds;
    this.now = now;
    this.cached = null;
    this.pending = null;
  }

  async get() {
    if (this.cached && this.now() - this.cached.at < CACHE_MS) return this.cached;
    // Requests that arrive while one is in flight share it.
    this.pending ??= this.load().finally(() => (this.pending = null));
    return this.pending;
  }

  async load() {
    const ids = this.ownIds();
    const boards = [];
    // One after another, like the bot opens them, to stay clear of the casino's rate limit.
    for (const by of BOARDS) {
      const data = await this.fetchBoard(by).catch(() => null);
      if (data) boards.push(boardOf(by, data, ids));
    }
    if (!boards.length) return this.cached ?? { at: null, boards: [] };
    this.cached = { at: this.now(), boards };
    return this.cached;
  }
}
