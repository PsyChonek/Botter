// Isolated-world content script: owns the work bot, the game bot, the answer
// bank, profit tracking and the in-page control panel.
// Work tickets are answered by clicking the app's own buttons; casino games are
// played through the API via the page hook, so they run on any screen.
(() => {
  const C = globalThis.BotterCore;
  const G = globalThis.BotterGames;
  const BJ = globalThis.BotterBlackjack;
  const A = globalThis.BotterAuto;
  const O = globalThis.BotterOdds;
  const Z = globalThis.BotterBlaze;
  const S = globalThis.BotterScreen;
  const msg = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

  const DEFAULT_SETTINGS = {
    enabled: false,
    taskType: 'alternate',
    minDelayMs: 1500,
    maxDelayMs: 4000,
    stopAtNorm: false,
    aiSolver: 'local',
    guessUnknown: true,
    gamesEnabled: false,
    game: 'blaze',
    gameBet: 20,
    rouletteBet: 'red',
    stopLoss: 1000,
    takeProfit: 0,
    reserve: 0,
    gameDelayMs: 800,
    playOnScreen: false,
    autoClaim: true,
    autoMode: false,
    repayDebt: true,
    autoBankrupt: true,
    loanCycle: true,
    loanTrick: true,
    standup: true,
    crashEnabled: true,
    crashBet: 100,
    crashMinEv: 1.05,
    crashKelly: 0.5,
    grindLimit: 'daily',
    xpBudget: 0,
    grindMinBalance: 0,
    grindGame: 'auto',
    grindBet: 'auto',
    grindExploreRounds: 30,
    buyUpgrades: false,
    saveForUpgrades: true,
    recordSpins: true,
    captureDebug: false,
    logLevel: 'info',
    panelHidden: false,
    rotateAccounts: true,
    homeAccount: '', // user id rotation returns to; the account picked in the panel
  };
  const EMPTY_STATS = {
    bank: { correct: 0, wrong: 0 },
    local: { correct: 0, wrong: 0 },
    claude: { correct: 0, wrong: 0 },
    openrouter: { correct: 0, wrong: 0 },
    guess: { correct: 0, wrong: 0 },
    manual: { correct: 0, wrong: 0 },
    spend: { usd: 0, calls: 0 },
    games: {},
    work: { tickets: 0, net: 0, xp: 0 },
    free: { daily: 0, bailout: 0 },
    crashBooked: [],
    grind: { day: '', net: 0 },
    betXp: {}, // game -> bet -> { rounds, xp, at }, to find the cheapest bet per XP
    betXpUpgrades: {}, // game -> upgrades the betXp samples were taken with
    flags: { cleanDone: false, cleanTaken: false, boardsDay: '' },
    dwell: {}, // task type -> least ms open before a submit the server accepts
  };
  const MAX_SUBMIT_TRIES = 3;
  const CRASH_UNLOCK = 3;
  const CRASH_POLL_MS = 60_000;
  const LEADERBOARDS = ['sprint', 'level', 'credits', 'biggest', 'losers', 'debtors'];
  const SPRINT_MAX_AGE_MS = 10 * 60_000;
  const CLEAN_LOAN = 500;
  const MAX_SPINS = 2000;
  const MAX_CAPTURE = 40;
  const SPIN_FLUSH_EVERY = 10;
  const CAPTURE_PATHS = /^\/api\/(loan|crash|shop|leaderboard|bonus|wheel)/;
  // Credits from these are booked as free income. A bankruptcy sets credits to
  // 500, so it books what that took or gave.
  const FREE_PATHS = {
    '/api/bonus/daily': 'daily',
    '/api/bonus/bailout': 'bailout',
    '/api/wheel/spin': 'wheel',
    '/api/loan/bankrupt': 'insolvency',
  };
  const CLAIM_RETRY_MS = 10 * 60_000;
  // The shop queue is re-judged this often, and at once when the account, its
  // level, upgrades or max bet change.
  const SHOP_REVIEW_MS = 10 * 60_000;
  const TICK_MS = 700;
  const API_TIMEOUT_MS = 30_000;
  const STATS_PREFIX = 'stats:';
  const ACCOUNT_PREFIX = 'account:';
  const SWITCH_KEY = 'botter-switch'; // sessionStorage: { from, to } of a switch in progress
  const ACCOUNT_SAVE_MS = 30_000;
  const ROTATE_DWELL_MS = 60_000;
  // Another account is worth a switch (a page reload) only above this much energy.
  const ROTATE_MIN_ENERGY = 15;
  // A work run starts only above this much energy and then drains it, so single
  // refilled points do not keep interrupting the grinder.
  const WORK_MIN_ENERGY = 5;
  const LOGGED_OUT_WAIT_MS = 10_000;

  let settings = { ...DEFAULT_SETTINGS };
  let bank = {};
  let stats = structuredClone(EMPTY_STATS);
  let log = C.createLogger(settings.logLevel);

  let player = null;
  let accountId = null; // supabase user id of the logged-in player
  let accountSince = 0; // when this page started working for that account
  let accountSavedAt = 0;
  let accounts = {}; // id -> saved login session and last player snapshot
  let statsCache = {}; // id -> stored stats of every account
  let legacyStats = null; // stats saved before accounts existed
  let accountOptions = ''; // what the account dropdown currently lists
  let switching = false;
  let early = []; // page-hook responses received before load() finished
  let task = null; // current task as returned by /api/work/start
  let answeredTaskId = null; // task the bot already clicked an answer for
  let pending = null; // { taskId, source } of the bot's last answer
  let taskOpenedAt = 0; // local time the current task was started
  let submitTries = 0; // submits of the current task the server rejected
  let lastType = null;
  let workRun = false; // energy went above WORK_MIN_ENERGY and is being worked down
  let bjStake = 0; // stake of the open blackjack hand, to book doubles
  let bjBet = 0; // opening bet of that hand, to book its XP per bet level
  let sessionBase = 0; // total game net when the game bot was started
  const claimTried = {}; // kind -> last attempt, so a refused claim is not spammed
  let crashPolledAt = 0;
  let shopReview = null; // { at, key, queue, goal } of the last shop review
  let sprint = null; // { rank, score, endAt, at } of this account in the weekly sprint
  let spins = []; // recorded Blaze spins for the model check
  let capture = []; // raw responses of rarely seen endpoints, for debugging
  let unsavedSpins = 0;
  let grindPausedUntil = 0;
  let busy = false;
  let status = { key: 'statusIdle' };
  let ui = null;

  const locale = chrome.i18n.getUILanguage();
  const usd = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  const num = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const signed = new Intl.NumberFormat(locale, { maximumFractionDigits: 0, signDisplay: 'exceptZero' });
  const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const pct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  const signedPct = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1, signDisplay: 'exceptZero' });

  const workOn = () => settings.enabled || settings.autoMode;
  const gamesOn = () => settings.gamesEnabled || settings.autoMode;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  const humanDelay = () => C.delayBetween(settings.minDelayMs, settings.maxDelayMs);

  // ---------- storage ----------

  const mergeStats = (stored) => ({ ...structuredClone(EMPTY_STATS), ...stored });

  // Stats and saved logins live under one key per account, so two tabs on
  // different accounts never overwrite each other.
  const byPrefix = (items, prefix) =>
    Object.fromEntries(
      Object.entries(items)
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => [key.slice(prefix.length), value]),
    );

  async function load() {
    const stored = await chrome.storage.local.get(null);
    spins = stored.spins ?? [];
    capture = stored.capture ?? [];
    settings = { ...DEFAULT_SETTINGS, ...stored.settings };
    bank = stored.bank ?? {};
    statsCache = byPrefix(stored, STATS_PREFIX);
    accounts = byPrefix(stored, ACCOUNT_PREFIX);
    legacyStats = stored.stats ?? null;
    log = C.createLogger(settings.logLevel);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.settings) {
      settings = { ...DEFAULT_SETTINGS, ...changes.settings.newValue };
      log = C.createLogger(settings.logLevel);
    }
    if (changes.bank) bank = changes.bank.newValue ?? {};
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key.startsWith(STATS_PREFIX)) {
        const id = key.slice(STATS_PREFIX.length);
        if (newValue) statsCache[id] = newValue;
        else delete statsCache[id];
        if (id === accountId) stats = mergeStats(newValue);
      } else if (key.startsWith(ACCOUNT_PREFIX)) {
        const id = key.slice(ACCOUNT_PREFIX.length);
        if (newValue) accounts[id] = newValue;
        else delete accounts[id];
      }
    }
    if (changes.spins) spins = changes.spins.newValue ?? [];
    if (changes.capture) capture = changes.capture.newValue ?? [];
    render();
  });

  const saveSettings = (patch) => chrome.storage.local.set({ settings: { ...settings, ...patch } });
  // Nothing is saved until a response says whose stats these are.
  const statsEntry = () => (accountId ? { [STATS_PREFIX + accountId]: stats } : {});
  const saveStats = () => chrome.storage.local.set(statsEntry());

  // ---------- messages from the page hook ----------

  const apiWaiters = new Map();
  let apiSeq = 0;

  // Calls the casino API through the page hook, which adds the session token.
  function api(path, body) {
    const id = ++apiSeq;
    return new Promise((resolve) => {
      apiWaiters.set(id, resolve);
      window.postMessage({ source: 'botter-content', kind: 'api', id, path, body }, location.origin);
      setTimeout(() => {
        if (apiWaiters.delete(id)) resolve({ ok: false, status: 0, data: { error: 'timeout' } });
      }, API_TIMEOUT_MS);
    });
  }

  // Rounds played on the game screen are sent by the app, so their result is
  // the next response the page sees on that path.
  const screenWaiters = new Set();
  function waitResponse(path) {
    return new Promise((resolve) => {
      const waiter = { path, resolve };
      screenWaiters.add(waiter);
      setTimeout(() => {
        if (screenWaiters.delete(waiter)) resolve({ ok: false, status: 0, data: { error: 'timeout' } });
      }, API_TIMEOUT_MS);
    });
  }

  function resolveScreenWaiters({ path, ok, status, data }) {
    for (const waiter of screenWaiters) {
      if (waiter.path !== path) continue;
      screenWaiters.delete(waiter);
      waiter.resolve({ ok, status, data });
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.source !== 'botter-hook') return;
    if (event.data.kind === 'api-result') {
      const resolve = apiWaiters.get(event.data.id);
      apiWaiters.delete(event.data.id);
      resolve?.(event.data);
      return;
    }
    // Responses that arrive before storage is loaded wait, so they are booked
    // to the right account's stats instead of an empty placeholder.
    if (early) early.push(event.data);
    else onResponse(event.data);
    resolveScreenWaiters(event.data);
  });

  // Every /api/ response the page sees, from the app or from the bot.
  function onResponse({ path, ok, request, data, uid }) {
    if (uid) useAccount(uid);
    const before = player?.credits;
    if (data?.player) {
      player = data.player;
      saveAccount();
    }
    if (settings.captureDebug && CAPTURE_PATHS.test(path)) {
      capture = [...capture, { at: Date.now(), path, ok, request, data }].slice(-MAX_CAPTURE);
      chrome.storage.local.set({ capture });
    }
    if (!ok) {
      if (path === '/api/work/submit') onSubmitRejected(request?.id, data);
      return;
    }
    bookRewards(data);
    if (data?.crash) bookCrash(data.crash);
    if (data?.by === 'sprint' && Array.isArray(data.entries)) readSprint(data);
    if (path === '/api/slot/spin' && data.result) recordSpin(request, data);

    if (path === '/api/work/start' && data.task) {
      task = data.task;
      taskOpenedAt = Date.now();
      submitTries = 0;
      log.debug('task_started', { id: task.id, type: task.type });
    } else if (path === '/api/work/submit' && data.result) {
      onResult(request?.id, data, before);
    } else if (FREE_PATHS[path] && typeof before === 'number' && data.player) {
      const kind = FREE_PATHS[path];
      // What the debt collector took from a wheel win paid off debt, it was not lost.
      const gain = data.player.credits - before + (data.result?.garnished ?? 0) - G.rewardTotal(data);
      stats.free[kind] = (stats.free[kind] ?? 0) + gain;
      saveStats();
      if (kind === 'wheel') log.info('wheel_spin', { segment: data.result?.segment, credits: data.result?.credits, energy: data.result?.energy });
    } else {
      const delta = G.gameDelta(path, request, data, before, bjStake);
      if (delta) {
        bjStake = data.hand && !data.hand.done ? delta.stake : 0;
        G.addDelta(stats.games, delta);
        if (path === '/api/blackjack/deal') bjBet = request?.bet ?? delta.wagered;
        const bet = path === '/api/blackjack/action' ? bjBet : (request?.bet ?? delta.wagered);
        if (bet > 0) {
          G.syncBetXp(stats.betXp, stats.betXpUpgrades, delta.game, data.player.upgrades);
          G.addBetXp(stats.betXp, delta.game, bet, delta.rounds, delta.xp);
        }
        if (stats.grind.day === A.dayKey()) stats.grind.net += delta.net;
        saveStats();
        log.debug('game_round', delta);
      }
    }
    render();
  }

  // Standup quest and achievement rewards are paid with whatever response
  // completed them, so they are booked as free income here and left out of that
  // response's game or work profit. Standup rewards also offset the day's
  // grinding loss, since the rounds played for a quest pay for themselves.
  function bookRewards(data) {
    const { standup, achievement } = G.rewardsPaid(data);
    if (!standup && !achievement) return;
    if (standup) stats.free.standup = (stats.free.standup ?? 0) + standup;
    if (achievement) stats.free.achievement = (stats.free.achievement ?? 0) + achievement;
    if (standup && stats.grind.day === A.dayKey()) stats.grind.net += standup;
    saveStats();
    log.info('rewards', {
      standup,
      achievement,
      quests: data.quests?.map((quest) => quest.text),
      achievements: data.achievements?.map((item) => item.key),
    });
  }

  // Keeps the Blaze board and the server's win so the slot model can be checked.
  function recordSpin(request, data) {
    if (!settings.recordSpins) return;
    const { result } = data;
    spins.push({
      grid: result.grid,
      finalGrid: result.finalGrid,
      bet: result.bet ?? request?.bet,
      win: result.totalWin,
      upgrades: data.player?.upgrades?.blaze ?? {},
    });
    if (spins.length > MAX_SPINS) spins = spins.slice(-MAX_SPINS);
    if (++unsavedSpins >= SPIN_FLUSH_EVERY) {
      unsavedSpins = 0;
      chrome.storage.local.set({ spins });
    }
  }

  // Crash pays auto cash-outs without a response, so settled bets are booked
  // from the round's bet list instead, once per bet id.
  function bookCrash(crash) {
    for (const bet of crash.bets ?? []) {
      if (!bet.me || bet.status === 'open' || stats.crashBooked.includes(bet.id)) continue;
      stats.crashBooked = [...stats.crashBooked, bet.id].slice(-50);
      G.addDelta(stats.games, { game: 'crash', rounds: 1, wagered: bet.stake, net: (bet.payout ?? 0) - bet.stake, xp: 0 });
      saveStats();
      log.info('crash_settled', { stake: bet.stake, payout: bet.payout ?? 0, status: bet.status });
    }
  }

  // The account's place in the weekly sprint, from the sprint leaderboard. An
  // account missing from the board is off the podium.
  function readSprint(data) {
    const me = data.entries.find((entry) => entry.me);
    sprint = { rank: me?.rank ?? Infinity, score: me?.value ?? 0, endAt: data.sprint?.endAt ?? 0, at: Date.now() };
  }

  function onResult(taskId, data, creditsBefore) {
    const { result } = data;
    if (typeof creditsBefore === 'number' && data.player) {
      stats.work.tickets += 1;
      stats.work.net += data.player.credits - creditsBefore + (result.garnished ?? 0) - G.rewardTotal(data);
      stats.work.xp += result.xpGain ?? 0;
    }
    if (task && task.id === taskId && Number.isInteger(result.answer)) {
      bank[C.taskKey(task)] = C.bankEntry(task, result.answer);
      const source = pending?.taskId === taskId ? pending.source : 'manual';
      stats[source][result.correct ? 'correct' : 'wrong'] += 1;
      pending = null;
      log.info('task_result', { ticket: C.ticketLabel(task.id), type: task.type, source, correct: result.correct });
    }
    chrome.storage.local.set({ bank, ...statsEntry() });
  }

  // The app only toasts a rejected submit and leaves the task open, so without
  // this the bot would wait on it forever. A submit the server found too fast is
  // retried after a longer, remembered minimum; expired tasks the app closes itself.
  function onSubmitRejected(taskId, data) {
    if (!task || task.id !== taskId) return;
    pending = null;
    const fields = { ticket: C.ticketLabel(task.id), type: task.type, code: data?.code, error: data?.error };
    if (data?.code === 'expired' || data?.code === 'already_solved') {
      log.warn('submit_rejected', fields);
      return;
    }
    const openMs = Date.now() - taskOpenedAt;
    stats.dwell[task.type] = C.slowerDwell(stats.dwell[task.type], openMs);
    saveStats();
    submitTries += 1;
    log.warn('submit_rejected', { ...fields, openMs, nextDwellMs: stats.dwell[task.type], tries: submitTries });
    if (submitTries >= MAX_SUBMIT_TRIES) {
      pressKey('Escape');
      return;
    }
    answeredTaskId = null;
  }

  // Every AI call is billed, even when its answer turns out unusable.
  function recordSpend(cost) {
    if (typeof cost !== 'number') return;
    stats.spend.usd += cost;
    stats.spend.calls += 1;
    saveStats();
  }

  // ---------- accounts ----------

  // The supabase session of whoever is logged in. Content scripts share the
  // page's localStorage, so this is the same entry the app reads.
  function readSession() {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!/^sb-.+-auth-token$/.test(key)) continue;
      const raw = localStorage.getItem(key);
      try {
        return { key, raw, uid: C.tokenSubject(JSON.parse(raw)?.access_token) };
      } catch {
        return null;
      }
    }
    return null;
  }

  function readSwitch() {
    try {
      return JSON.parse(sessionStorage.getItem(SWITCH_KEY));
    } catch {
      return null;
    }
  }

  // Every response names the account its token belongs to. A new one means the
  // page is logged in as someone else: load that account's stats and forget
  // everything known about the previous player.
  function useAccount(id) {
    if (id === accountId) return;
    accountId = id;
    accountSince = Date.now();
    accountSavedAt = 0;
    stats = mergeStats(statsCache[id] ?? adoptLegacyStats(id));
    sessionBase = G.totalNet(stats.games);
    player = null;
    task = null;
    answeredTaskId = null;
    pending = null;
    lastType = null;
    workRun = false;
    bjStake = 0;
    crashPolledAt = 0;
    grindPausedUntil = 0;
    for (const kind of Object.keys(claimTried)) delete claimTried[kind];
    if (readSwitch()?.to === id) sessionStorage.removeItem(SWITCH_KEY);
    if (!settings.homeAccount) saveSettings({ homeAccount: id });
    log.info('account', { id });
  }

  // Stats from before accounts existed belong to whoever logs in first.
  function adoptLegacyStats(id) {
    if (!legacyStats || Object.keys(statsCache).length) return undefined;
    const adopted = legacyStats;
    legacyStats = null;
    statsCache[id] = adopted;
    chrome.storage.local.set({ [STATS_PREFIX + id]: adopted });
    chrome.storage.local.remove('stats');
    return adopted;
  }

  // Keeps the account's login session and a snapshot of its player, so the panel
  // can switch back to it and rotation can project its energy.
  function saveAccount(force = false) {
    if (!accountId || !player) return Promise.resolve();
    const saved = accounts[accountId] ?? {};
    const session = readSession();
    const own = session?.uid === accountId;
    const newSession = own && session.raw !== saved.session;
    if (!force && !newSession && Date.now() - accountSavedAt < ACCOUNT_SAVE_MS) return Promise.resolve();
    accountSavedAt = Date.now();
    const record = {
      ...saved,
      login: player.login,
      level: player.level,
      credits: player.credits,
      work: player.work,
      wheelNextAt: player.wheelNextAt,
      upgrades: player.upgrades,
      seenAt: Date.now(),
      seenDay: A.dayKey(),
      ...(own ? { storageKey: session.key, session: session.raw } : {}),
    };
    accounts[accountId] = record;
    return chrome.storage.local.set({ [ACCOUNT_PREFIX + accountId]: record });
  }

  // Logs the page in as a saved account: its session goes where the app keeps
  // it, then the page reloads. The current session is saved first so it can return.
  async function switchAccount(id) {
    const target = accounts[id];
    if (switching || id === accountId || !target?.session) return;
    switching = true;
    setStatus('statusSwitching', [target.login ?? id]);
    await saveAccount(true);
    sessionStorage.setItem(SWITCH_KEY, JSON.stringify({ from: accountId, to: id }));
    localStorage.setItem(target.storageKey, target.session);
    location.reload();
  }

  // Detaches the current session and reloads to the login screen. The app's own
  // log out would revoke the session on the server, and with it the saved copy.
  async function addAccount() {
    if (switching) return;
    switching = true;
    await saveAccount(true);
    const session = readSession();
    if (session) localStorage.removeItem(session.key);
    location.reload();
  }

  // Asks for the player snapshot. With no session left the page is on the login
  // screen; if a switch just landed there, that saved login has expired.
  async function loadPlayer() {
    setStatus('statusLoading');
    const res = await api('/api/me');
    if (res.ok) return;
    if (readSession()) return sleep(LOGGED_OUT_WAIT_MS);
    const marker = readSwitch();
    sessionStorage.removeItem(SWITCH_KEY);
    const expired = marker && accounts[marker.to];
    if (!expired) {
      setStatus('statusLoggedOut');
      return sleep(LOGGED_OUT_WAIT_MS);
    }
    const kept = { ...expired };
    delete kept.session;
    delete kept.storageKey;
    accounts[marker.to] = kept;
    await chrome.storage.local.set({ [ACCOUNT_PREFIX + marker.to]: kept });
    log.warn('session_expired', { login: expired.login });
    setStatus('statusSessionExpired', [expired.login ?? marker.to]);
    if (accounts[marker.from]?.session) await switchAccount(marker.from);
  }

  // Whether a saved account could still place the smallest XP grinding bet,
  // judged from its last snapshot and today's grind loss in its stats.
  function canGrind(id, saved, today) {
    const unlock = settings.grindGame === 'auto' ? Math.min(...Object.values(GRIND_UNLOCKS)) : GRIND_UNLOCKS[settings.grindGame];
    if (!settings.autoMode || !(saved.level >= unlock)) return false;
    const grind = statsCache[id]?.grind;
    const lost = Math.max(0, -(grind?.day === today ? grind.net : 0));
    return A.grindBets(settings, saved.credits ?? 0, lost, [G.BET_LEVELS[0]]).length > 0;
  }

  // An account with nothing left to do hands over to another saved account
  // instead of idling while its energy refills, and returns home afterwards.
  // urgent only leaves for free credits waiting elsewhere (A.urgentAccount), so
  // work and grinding here do not hold up another account's wheel or daily bonus.
  // An account left within CLAIM_RETRY_MS already tried its wheel, so a refused
  // spin there does not pull the bot back and forth.
  async function rotateStep(urgent = false) {
    if (!settings.rotateAccounts || !player || Date.now() - accountSince < ROTATE_DWELL_MS) return false;
    if (urgent && document.querySelector('.work-screen section.task')) return false;
    const now = Date.now();
    const today = A.dayKey(now);
    const candidates = Object.entries(accounts)
      .filter(([id, saved]) => id !== accountId && saved.session)
      .map(([id, saved]) => ({
        id,
        seenAt: saved.seenAt ?? 0,
        seenDay: saved.seenDay,
        energy: G.energyNow(saved.work, now),
        normDone: settings.stopAtNorm && saved.seenDay === today && saved.work?.paidToday >= saved.work?.norm,
        credits: saved.credits ?? 0,
        canGrind: canGrind(id, saved, today),
        wheel: settings.autoClaim && A.wheelReady(saved.wheelNextAt, now) && now - (saved.seenAt ?? 0) > CLAIM_RETRY_MS,
      }));
    const home = settings.homeAccount && settings.homeAccount !== accountId ? settings.homeAccount : null;
    const id = urgent ? A.urgentAccount(candidates, today) : A.pickAccount(candidates, today, ROTATE_MIN_ENERGY, home);
    if (!id) return false;
    log.info('account_rotate', {
      to: accounts[id].login,
      urgent,
      home: id === settings.homeAccount,
      energy: G.energyNow(accounts[id].work, now),
      credits: accounts[id].credits,
      wheel: A.wheelReady(accounts[id].wheelNextAt, now),
    });
    await switchAccount(id);
    return true;
  }

  // ---------- work bot ----------

  function pressKey(key) {
    window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }

  // Level-up and daily-bonus modals block the work screen; dismiss them.
  function dismissModal() {
    const button =
      document.querySelector('.modal .sheet.levelup .btn-primary') ||
      document.querySelector('.modal .sheet.daily .close');
    if (!button) return false;
    button.click();
    return true;
  }

  function answerButton(taskEl, current, index) {
    if (current.type === 'bughunt') {
      return taskEl.querySelectorAll('ol.code.lines > li')[index]?.querySelector('button');
    }
    return taskEl.querySelectorAll('.options button')[index];
  }

  async function pickAnswer(current) {
    const known = C.answerFromBank(current, bank[C.taskKey(current)]);
    if (known !== null) return { index: known, source: 'bank' };

    if (settings.aiSolver !== 'off') {
      const source = settings.aiSolver;
      setStatus('statusThinking', [C.ticketLabel(current.id), msg(`source_${source}`)]);
      const res = await chrome.runtime.sendMessage({ kind: 'solve', task: current }).catch((err) => ({
        ok: false,
        error: String(err),
      }));
      if (res?.ok) recordSpend(res.cost);
      if (res?.ok && C.isValidAnswer(current, res.index)) return { index: res.index, source };
      if (res?.error !== 'no_api_key') log.warn('ai_failed', { error: res?.error ?? 'invalid_index' });
    }

    if (settings.guessUnknown) return { index: C.randomChoice(current), source: 'guess' };
    return { index: null, source: null };
  }

  async function solve(taskEl) {
    const current = task;
    answeredTaskId = current.id;
    const started = Date.now();
    const { index, source } = await pickAnswer(current);
    if (index === null) {
      stopWork('statusNoSolver');
      return;
    }

    setStatus('statusAnswering', [C.ticketLabel(current.id), msg(`source_${source}`)]);
    const timeLeft = current.expiresAt - Date.now() - 2000;
    const dwellLeft = C.minDwellMs(current, stats.dwell[current.type]) - (Date.now() - taskOpenedAt);
    await sleep(Math.min(Math.max(humanDelay() - (Date.now() - started), dwellLeft), timeLeft));
    if (!workOn() || task?.id !== current.id) return;

    if (current.type === 'ticket') {
      await fileTicket(taskEl, current, index, source);
      return;
    }
    const button = answerButton(taskEl, current, index);
    if (!button || button.disabled) {
      log.warn('answer_button_missing', { ticket: C.ticketLabel(current.id), index });
      return;
    }
    pending = { taskId: current.id, source };
    button.click();
  }

  // A ticket is answered by picking one option per field, then submitting. React
  // enables the submit button only after it re-renders with all three picks.
  async function fileTicket(taskEl, current, index, source) {
    const fields = taskEl.querySelectorAll('.ticket-field');
    const digits = C.decodeTicket(index);
    for (const [i, digit] of digits.entries()) {
      const button = fields[i]?.querySelectorAll('.ticket-options button')[digit];
      if (!button || button.disabled) {
        log.warn('answer_button_missing', { ticket: C.ticketLabel(current.id), index, field: i });
        return;
      }
      button.click();
      await sleep(C.delayBetween(150, 400));
      if (!workOn() || task?.id !== current.id) return;
    }
    const submit = taskEl.querySelector('.ticket-submit');
    if (!submit || submit.disabled) {
      log.warn('answer_button_missing', { ticket: C.ticketLabel(current.id), index, field: 'submit' });
      return;
    }
    pending = { taskId: current.id, source };
    submit.click();
  }

  const normDone = () => settings.stopAtNorm && player && player.work.paidToday >= player.work.norm;

  // Whether the work bot has something to do right now, so games can use the gaps.
  function workAvailable() {
    if (document.querySelector('.work-screen section.task')) return true;
    if (!player) return true;
    if (normDone()) return false;
    const energy = G.energyNow(player.work, Date.now());
    workRun = A.workDue(energy, player.work.maxEnergy ?? 20, workRun, WORK_MIN_ENERGY, grindReady());
    return workRun;
  }

  // Whether auto mode can grind XP now. Tickets pay more at a higher level, so
  // while it can, work waits and only keeps energy off the cap.
  const grindReady = () => settings.autoMode && Date.now() >= grindPausedUntil && grindChoice().plan !== null;

  // The upgrade goal that alone keeps the grinder from betting, or null: the
  // credits are kept for it (see savingFor), so the panel says so instead of
  // looking idle.
  function grindHeldFor() {
    if (!settings.autoMode) return null;
    const goal = savingFor();
    return goal && grindChoice().plan === null && grindChoice(false).plan !== null ? goal : null;
  }

  async function workStep() {
    if (dismissModal()) return;

    const screen = document.querySelector('.work-screen');
    const taskEl = screen?.querySelector('section.task');
    // With no ticket open and nothing to work on, leave the user on whatever
    // screen they are on instead of pulling them back to work every tick.
    if (!taskEl) {
      if (normDone()) {
        stopWork('statusNormDone');
        return;
      }
      if (!workAvailable()) {
        const goal = grindHeldFor();
        if (goal) {
          setStatus('statusSavingForUpgrade', [`${goal.game}:${goal.key} ${goal.next}`, credits(player.credits), credits(limits().reserve + goal.price)]);
        } else {
          setStatus('statusWaitEnergy', [String(WORK_MIN_ENERGY), String(G.energyNow(player.work, Date.now()))]);
        }
        return;
      }
    }

    if (!screen) {
      setStatus('statusOpening');
      document.querySelectorAll('nav.views button')[1]?.click();
      return;
    }

    if (taskEl) {
      if (taskEl.querySelector('button.right, button.wrong')) {
        await sleep(humanDelay() / 2);
        pressKey('Escape');
        return;
      }
      const label = taskEl.querySelector('.ticket')?.textContent ?? '';
      if (!task || !label.includes(C.ticketLabel(task.id))) {
        // Task opened before the extension loaded: we have no data for it.
        pressKey('Escape');
        return;
      }
      if (answeredTaskId !== task.id) await solve(taskEl);
      return;
    }

    const pick = screen.querySelector('.work-pick');
    if (!pick) return;
    const type = C.nextType(settings.taskType, lastType);
    const card = pick.querySelectorAll('.job-card')[C.TYPES.indexOf(type)];
    if (!card || card.disabled) {
      setStatus('statusNoEnergy');
      return;
    }
    setStatus('statusStarting');
    await sleep(humanDelay() / 2);
    if (!workOn()) return;
    lastType = type;
    card.click();
  }

  // ---------- game bot ----------

  const credits = (n) => num.format(n);

  const screenPlay = S.create({
    waitResponse,
    dismissModal,
    active: gamesOn,
    decide: (hand, data) =>
      BJ.decide(hand, BJ.rulesFromUpgrades(player.upgrades?.blackjack), data?.player?.credits ?? player.credits),
  });

  async function playBlackjack(bet) {
    const open = player.blackjack && !player.blackjack.done ? player.blackjack : null;
    if (open) bjStake = open.stake ?? bjStake;
    if (settings.playOnScreen) return screenPlay.blackjack(bet, open);
    let res = open ? { ok: true, data: { hand: open, player } } : await api('/api/blackjack/deal', { bet });
    while (res.ok && res.data.hand && !res.data.hand.done && gamesOn()) {
      await sleep(settings.gameDelayMs / 2);
      const rules = BJ.rulesFromUpgrades(player.upgrades?.blackjack);
      const action = BJ.decide(res.data.hand, rules, res.data.player?.credits ?? player.credits);
      res = await api('/api/blackjack/action', { action });
    }
    return res;
  }

  function playRound(game, bet) {
    if (game === 'blackjack') return playBlackjack(bet);
    if (settings.playOnScreen) return game === 'roulette' ? screenPlay.roulette(settings.rouletteBet, bet) : screenPlay.slot(game, bet);
    if (game === 'roulette') return api('/api/roulette/spin', { bets: { [settings.rouletteBet]: bet } });
    return api(G.GAMES[game].path, { bet });
  }

  async function gameStep() {
    if (!player) return loadPlayer();
    const game = settings.game;
    const info = G.GAMES[game];
    if (!info) return stopGames('statusIdle');
    if (player.level < info.unlock) return stopGames('statusGameLocked', [msg(`game_${game}`), String(info.unlock)]);

    const sessionNet = G.totalNet(stats.games) - sessionBase;
    if (settings.stopLoss > 0 && sessionNet <= -settings.stopLoss) {
      return stopGames('statusStopLoss', [credits(-sessionNet)]);
    }
    if (settings.takeProfit > 0 && sessionNet >= settings.takeProfit) {
      return stopGames('statusTakeProfit', [credits(sessionNet)]);
    }

    const bet = G.betFor(settings.gameBet, player.maxBet);
    const handOpen = game === 'blackjack' && player.blackjack && !player.blackjack.done;
    if (!handOpen && player.credits - bet < settings.reserve) return stopGames('statusReserve');

    setStatus('statusPlaying', [msg(`game_${game}`), credits(bet), signed.format(sessionNet)]);
    const res = await playRound(game, bet);
    if (!res.ok) {
      log.warn('game_failed', { game, status: res.status, error: res.data?.error });
      return stopGames('statusGameError', [res.data?.error ?? String(res.status)]);
    }
    await sleep(settings.gameDelayMs);
  }

  // ---------- loop ----------

  // Free credits: the daily bonus, the hourly wheel of fortune, and the
  // once-a-day bailout when broke.
  const FREEBIES = {
    daily: { path: '/api/bonus/daily', status: 'statusClaimDaily' },
    wheel: { path: '/api/wheel/spin', status: 'statusWheel' },
    bailout: { path: '/api/bonus/bailout', status: 'statusClaimBailout' },
  };
  async function claimFreebies() {
    if (!player || !settings.autoClaim) return false;
    const due = (kind) => Date.now() - (claimTried[kind] ?? 0) > CLAIM_RETRY_MS;
    let kind = null;
    if (player.daily?.available && due('daily')) kind = 'daily';
    else if (A.wheelReady(player.wheelNextAt) && due('wheel')) kind = 'wheel';
    else if (player.bailout?.available && player.credits < G.BET_LEVELS[0] && due('bailout')) kind = 'bailout';
    if (!kind) return false;
    claimTried[kind] = Date.now();
    setStatus(FREEBIES[kind].status);
    const res = await api(FREEBIES[kind].path, {});
    if (!res.ok) log.warn('claim_failed', { kind, status: res.status, error: res.data?.error });
    return true;
  }

  // ---------- auto mode ----------

  // Credits the grinder pays per XP point: the cheapest best bet measured over
  // the games it may pick, or null before any game has one.
  function xpPrice() {
    const { levels, candidates, edges } = grindModel();
    const costs = A.grindReport(candidates, levels, player.level, stats.games, stats.betXp, GRIND_UNLOCKS, edges)
      .flatMap((row) => row.bets)
      .filter((cell) => cell.state === 'best' && cell.cost !== null)
      .map((cell) => cell.cost);
    return costs.length ? Math.min(...costs) : null;
  }

  // Credits a work ticket pays per XP point, or null before any ticket.
  const workPerXp = () => (stats.work.xp > 0 ? Math.max(0, stats.work.net) / stats.work.xp : null);

  // Whether the open loan is going to be dropped by bankruptcy: a loan taken for
  // the bankruptcy cycle, or execution where bankruptcy is cheaper than paying.
  // Bankruptcy resets credits to 500, so until then they are spent, not repaid.
  function bankruptPlanned() {
    if (!settings.autoBankrupt || !player?.loan) return false;
    if (!player.loan.execution) return stats.flags.cycleLoan === true;
    return A.bankruptWorth(player, xpPrice());
  }

  // Limits the grinder and the shop spend within. Past a planned bankruptcy a
  // credit is worth nothing, so they may spend down to the last one.
  const limits = () =>
    bankruptPlanned() ? { ...settings, reserve: 0, grindLimit: 'balance', grindMinBalance: 1 } : settings;

  // The account's sprint standing, fetched again once it is older than ten
  // minutes or its sprint has ended. Null while it cannot be read.
  async function sprintStanding() {
    const now = Date.now();
    const stale = !sprint || now - sprint.at > SPRINT_MAX_AGE_MS || now >= sprint.endAt;
    if (stale && now - (claimTried.sprint ?? 0) > CRASH_POLL_MS) {
      claimTried.sprint = now;
      await api('/api/leaderboard?by=sprint');
    }
    return sprint && Date.now() < sprint.endAt ? sprint : null;
  }

  // Personal bankruptcy once it is planned and execution allows it, after the
  // shop and the grinder have spent the credits the reset would wipe, and
  // unless finishing the current level first costs less than losing its XP. On
  // a sprint podium it waits for the sprint to end, so the prize is paid and
  // the bankruptcy lands on the new sprint's first points.
  async function bankruptStep() {
    if (!player.loan?.execution || !bankruptPlanned()) return false;
    if (Date.now() - (claimTried.bankrupt ?? 0) < CLAIM_RETRY_MS) return false;
    if (shopOffer() || grindReady()) return false;
    const price = xpPrice();
    if (A.waitForLevel(player, price, workPerXp())) return false;
    const standing = await sprintStanding();
    if (!standing || A.sprintHold(standing)) return false;
    claimTried.bankrupt = Date.now();
    const terms = {
      debt: player.loan.debt,
      credits: player.credits,
      xpLost: player.xpInto ?? 0,
      xpPrice: price,
      sprintScore: standing.score,
    };
    setStatus('statusBankrupt', [credits(terms.debt)]);
    const res = await api('/api/loan/bankrupt', {});
    if (!res.ok) log.warn('bankrupt_failed', { ...terms, status: res.status, error: res.data?.error });
    else log.info('bankrupt', terms);
    return true;
  }

  async function repayStep() {
    if (!settings.repayDebt || bankruptPlanned()) return false;
    const amount = A.repayAmount(player, settings.reserve);
    if (amount < 1 || Date.now() - (claimTried.repay ?? 0) < CRASH_POLL_MS) return false;
    claimTried.repay = Date.now();
    setStatus('statusRepay', [credits(amount)]);
    const res = await api('/api/loan/repay', { amount });
    if (!res.ok) log.warn('repay_failed', { status: res.status, error: res.data?.error });
    else if (stats.flags.cycleLoan) {
      // A cycle loan repaid after all was not free income.
      stats.free.loan = (stats.free.loan ?? 0) - amount;
      saveStats();
    }
    return true;
  }

  // A loan taken to be dropped by bankruptcy at execution, when the expected
  // XP lost then (BotterAuto.loanCycle) is worth less than the loan. Waits for
  // the clean-loan achievement, which needs a loan of its own, and on a sprint
  // podium for the last 12 hours of the sprint, so the bankruptcy comes after
  // the prize. The loan is booked as free income, since it is never paid back.
  async function loanCycleStep() {
    if (!player.loan && stats.flags.cycleLoan) {
      stats.flags.cycleLoan = false;
      saveStats();
    }
    if (!settings.loanCycle || !settings.autoBankrupt || player.loan) return false;
    if (player.loanBlockedUntil > Date.now() || (settings.loanTrick && !stats.flags.cleanDone)) return false;
    if (Date.now() - (claimTried.cycle ?? 0) < CLAIM_RETRY_MS) return false;
    claimTried.cycle = Date.now();
    const amount = A.loanAmount(player.loanLimit);
    const plan = A.loanCycle(amount, player.credits, player.xpNeed, xpPrice(), workPerXp());
    if (!plan || plan.value <= 0) {
      log.info('loan_cycle_skip', { amount, credits: player.credits, xpNeed: player.xpNeed, value: plan?.value ?? null });
      return false;
    }
    const standing = await sprintStanding();
    if (!standing || !A.loanSprintSafe(standing)) return false;
    setStatus('statusLoanCycle', [credits(amount)]);
    const res = await api('/api/loan/take', { amount });
    if (!res.ok) {
      log.warn('loan_cycle_failed', { amount, status: res.status, error: res.data?.error });
      return true;
    }
    stats.flags.cycleLoan = true;
    stats.free.loan = (stats.free.loan ?? 0) + amount;
    saveStats();
    log.info('loan_cycle', plan);
    return true;
  }

  // One-time +500 achievement for repaying a loan within its interest-free hour.
  // The done flag is committed only once the loan is actually cleared, so a
  // failed take or repay retries instead of burning the one-time reward.
  async function loanTrickStep() {
    if (!settings.loanTrick || stats.flags.cleanDone) return false;
    if (Date.now() - (claimTried.clean ?? 0) < CRASH_POLL_MS) return false;

    // We already took the trick loan: keep repaying it in full until it clears,
    // then record the achievement. Never touch a loan the bot did not take.
    if (stats.flags.cleanTaken) {
      const debt = player.loan?.debt ?? 0;
      if (debt <= 0) {
        stats.flags.cleanDone = true;
        saveStats();
        return false;
      }
      if (player.credits < debt) return false;
      claimTried.clean = Date.now();
      setStatus('statusLoanTrick');
      const repay = await api('/api/loan/repay', { amount: debt });
      if (repay.ok) {
        stats.flags.cleanDone = true;
        saveStats();
      } else {
        log.warn('loan_repay_failed', { status: repay.status, error: repay.data?.error });
      }
      return true;
    }

    // Do not interfere with a pre-existing real loan, and after a bankruptcy
    // the shark lends nothing for a week.
    if (player.loan || player.loanBlockedUntil > Date.now()) return false;
    claimTried.clean = Date.now();
    setStatus('statusLoanTrick');
    const take = await api('/api/loan/take', { amount: CLEAN_LOAN });
    if (!take.ok) {
      log.warn('loan_take_failed', { status: take.status, error: take.data?.error });
      return true;
    }
    stats.flags.cleanTaken = true;
    saveStats();
    const debt = take.data.player?.loan?.debt ?? CLEAN_LOAN;
    const repay = await api('/api/loan/repay', { amount: debt });
    if (repay.ok) {
      stats.flags.cleanDone = true;
      saveStats();
    } else {
      // Retried on the next tick while the free hour lasts.
      log.warn('loan_repay_failed', { status: repay.status, error: repay.data?.error });
    }
    return true;
  }

  // Why an upgrade from the plan is skipped (see BotterAuto.upgradeVerdict), or null.
  // The grinder is judged as if it were not saving, or saving for global:bets
  // would stop the grinder, uncap its bet and drop the goal again.
  function upgradeSkip(offer) {
    const { levels, candidates, plan } = grindChoice(false);
    const mode = blazeMode();
    return A.upgradeVerdict(offer, {
      games: candidates.filter((game) => player.level >= GRIND_UNLOCKS[game]),
      upgrades: player.upgrades,
      betXp: stats.betXp,
      levels,
      edge: (game, upgrades) => O.edges([game], upgrades, mode)[game] ?? null,
      rest: (keys, upTo) => G.upgradeRest(player.upgrades, offer.game, keys, upTo),
      maxLevels: Object.fromEntries(Object.entries(G.SHOP[offer.game]).map(([key, [max]]) => [key, max])),
      volume: A.grindVolume(limits(), player.credits),
      betCapped: Boolean(plan) && plan.bet >= player.maxBet,
      crashOn: settings.crashEnabled,
    });
  }

  // Judges every upgrade in the plan (G.shopQueue) every SHOP_REVIEW_MS, or at
  // once when what the verdicts depend on changes. The goal is the first one
  // worth buying at this level. Changes are logged, not every review.
  function reviewShop() {
    if (!settings.buyUpgrades || !player) return (shopReview = null);
    const key = JSON.stringify([accountId, player.level, player.maxBet, player.upgrades, bankruptPlanned(), settings.crashEnabled]);
    if (shopReview?.key === key && Date.now() - shopReview.at < SHOP_REVIEW_MS) return shopReview;
    const queue = G.shopQueue(G.UPGRADE_PLAN, player, upgradeSkip);
    const goal = queue.find((offer) => !offer.reason) ?? null;
    const skipped = queue.filter((o) => o.reason && o.reason !== 'level').map((o) => `${o.game}:${o.key} ${o.reason}`);
    if (skipped.join() !== shopReview?.skipped.join() && skipped.length) log.info('upgrades_skipped', { skipped });
    const label = (o) => (o ? `${o.game}:${o.key} ${o.next}` : null);
    if (label(goal) !== label(shopReview?.goal)) {
      log.info('upgrade_goal', goal ? { ...goal, credits: player.credits } : { goal: null });
    }
    shopReview = { at: Date.now(), key, queue, goal, skipped };
    return shopReview;
  }

  // The goal upgrade when it is affordable above the reserve, or null.
  function shopOffer() {
    const goal = reviewShop()?.goal;
    return goal && player.credits - goal.price >= limits().reserve ? goal : null;
  }

  // The goal upgrade the grinder leaves credits for, or null. Its verdict says
  // the credits buy more XP as the upgrade than as grinding, so they are not
  // gambled meanwhile. Not past a planned bankruptcy, which wipes the savings.
  function savingFor() {
    if (!settings.saveForUpgrades || !settings.autoMode || bankruptPlanned()) return null;
    return reviewShop()?.goal ?? null;
  }

  // Buys the goal upgrade as soon as it fits above the reserve. A purchase
  // changes the upgrades, so the next tick reviews the queue and buys the next
  // goal right away if that fits too; only a refused buy waits.
  async function buyStep() {
    if (!settings.buyUpgrades || Date.now() - (claimTried.buy ?? 0) < CRASH_POLL_MS) return false;
    const offer = shopOffer();
    if (!offer) return false;
    setStatus('statusBuying', [`${offer.game}:${offer.key}`, String(offer.next), credits(offer.price)]);
    const res = await api('/api/shop/buy', { game: offer.game, key: offer.key });
    if (!res.ok) {
      claimTried.buy = Date.now();
      log.warn('buy_failed', { ...offer, status: res.status, error: res.data?.error });
    } else {
      log.info('upgrade_bought', offer);
    }
    return true;
  }

  // Opening the boards is what checks the podium achievement (top 3 on any board).
  async function leaderboardStep() {
    const today = A.dayKey();
    if (stats.flags.boardsDay === today) return false;
    stats.flags.boardsDay = today;
    saveStats();
    setStatus('statusLeaderboard');
    for (const by of LEADERBOARDS) await api(`/api/leaderboard?by=${by}`);
    return true;
  }

  // One bet per daily round, only when the round history says it pays.
  async function crashStep() {
    if (!settings.crashEnabled || player.level < CRASH_UNLOCK) return false;
    if (Date.now() - crashPolledAt < CRASH_POLL_MS) return false;
    crashPolledAt = Date.now();
    const res = await api('/api/crash');
    const crash = res.data?.crash;
    if (!res.ok || !crash || crash.status !== 'running' || crash.bets?.some((bet) => bet.me)) return true;

    const entry = A.crashMult(crash.startAt, crash.serverNow ?? Date.now());
    const plan = A.bestCrashTarget(crash.history, entry, crash.rate ?? 1);
    if (!plan || plan.ev < settings.crashMinEv) {
      log.info('crash_skip', { entry, rate: crash.rate, history: crash.history?.length ?? 0, ev: plan?.ev ?? null });
      return true;
    }
    // Size by fractional Kelly on the plan's edge, capped by the user's max
    // crash bet, the table max, and the reserve. A fatter edge bets more.
    const bankroll = Math.max(0, player.credits - settings.reserve);
    const wanted = A.crashStake(plan, bankroll, settings.crashKelly);
    const cap = Math.min(settings.crashBet, player.maxBet);
    const stake = G.betFor(wanted, cap);
    if (player.credits - stake < settings.reserve) return true;
    setStatus('statusCrashBet', [
      credits(stake),
      plan.target === null ? msg('crashHold') : `${plan.target.toFixed(2)}x`,
      signedPct.format(plan.ev - 1),
    ]);
    const bet = await api('/api/crash/bet', { stake, auto: plan.target });
    if (!bet.ok) log.warn('crash_bet_failed', { status: bet.status, error: bet.data?.error });
    else log.info('crash_bet', { stake, entry, target: plan.target, ev: plan.ev, kelly: settings.crashKelly });
    return true;
  }

  // Logged when the set of skipped standup quests changes, not on every tick.
  let skippedQuests = '';

  // Plays the next standup quest worth its reward (BotterAuto.standupPlan) on
  // the game and at the bet where it costs least. It keeps the reserve but not
  // the grinding budget or minimum balance: the reward pays for the rounds.
  async function standupStep() {
    if (!settings.standup || !player?.quests?.length) return false;
    if (Date.now() - (claimTried.standup ?? 0) < CLAIM_RETRY_MS) return false;
    const reserve = limits().reserve;
    const skipped = [];
    const plan = A.standupPlan(
      player.quests,
      {
        level: player.level,
        unlocks: GRIND_UNLOCKS,
        edges: O.edges(G.GAME_KEYS, player.upgrades, blazeMode()),
        wins: O.winRates(G.GAME_KEYS, player.upgrades, blazeMode()),
        levels: G.BET_LEVELS.filter((bet) => bet <= player.maxBet && player.credits - bet >= reserve),
      },
      skipped,
    );
    const note = skipped.map((item) => `${item.key} ${item.reason}`).join();
    if (note !== skippedQuests) {
      skippedQuests = note;
      if (skipped.length) log.info('standup_skipped', { skipped });
    }
    if (!plan) return false;
    const { quest, game, bet } = plan;
    setStatus('statusStandup', [quest.text, msg(`game_${game}`), credits(bet), num.format(quest.progress), num.format(quest.target)]);
    const res = await playRound(game, bet);
    if (!res.ok) {
      log.warn('standup_failed', { quest: quest.key, game, bet, status: res.status, error: res.data?.error });
      claimTried.standup = Date.now();
    }
    await sleep(settings.gameDelayMs);
    return true;
  }

  // Every game loses on average, so gambling only buys XP, within a daily loss
  // budget or down to a minimum account balance.
  const GRIND_UNLOCKS = Object.fromEntries(G.GAME_KEYS.map((game) => [game, G.GAMES[game].unlock]));

  // Scatter rule of the Blaze model, from the recorded spins, rechecked when a
  // new spin is recorded.
  let blazeCheck = { last: undefined, mode: 'reels' };
  function blazeMode() {
    const last = spins.at(-1);
    if (blazeCheck.last !== last) blazeCheck = { last, mode: O.blazeMode(Z.checkSpins(spins)) };
    return blazeCheck.mode;
  }

  // Games and bet levels the grinder may pick from right now, the modelled house
  // edges at the current upgrades, and its pick.
  // Bet levels, candidate games and their modelled edges, before any limit.
  function grindModel() {
    G.expireBetXp(stats.betXp);
    const levels = G.BET_LEVELS.filter((bet) => bet <= player.maxBet);
    const candidates = settings.grindGame === 'auto' ? G.GAME_KEYS : [settings.grindGame];
    const edges = O.edges(candidates, player.upgrades, blazeMode());
    return { levels, candidates, edges };
  }

  // While saving for an upgrade (savingFor), its price is kept on top of the
  // reserve; saving = false judges the grinder without it.
  function grindLimits(saving = true) {
    const limit = limits();
    const goal = saving ? savingFor() : null;
    return goal ? { ...limit, reserve: limit.reserve + goal.price } : limit;
  }

  function grindChoice(saving = true) {
    const lost = Math.max(0, -(stats.grind.day === A.dayKey() ? stats.grind.net : 0));
    const { levels, candidates, edges } = grindModel();
    const limit = grindLimits(saving);
    const bets =
      settings.grindBet === 'auto'
        ? A.grindBets(limit, player.credits, lost, levels)
        : [G.betFor(Number(settings.grindBet), player.maxBet)].filter((bet) =>
            A.grindAllowed(limit, player.credits, lost, bet),
          );
    const plan = A.grindPlan(candidates, bets, player.level, stats.games, stats.betXp, GRIND_UNLOCKS, edges, settings.grindExploreRounds);
    return { lost, levels, candidates, edges, plan };
  }

  async function grindStep() {
    if (Date.now() < grindPausedUntil) return false;
    const today = A.dayKey();
    if (stats.grind.day !== today) stats.grind = { day: today, net: 0 };
    const { lost, plan } = grindChoice();
    if (!plan) return false;
    const { game, bet } = plan;
    const limit = limits();
    if (limit.grindLimit !== 'daily') {
      const floor = limit.grindLimit === 'off' ? limit.reserve : limit.grindMinBalance;
      setStatus('statusGrindingFloor', [msg(`game_${game}`), credits(player.credits), credits(floor), credits(bet)]);
    } else {
      setStatus('statusGrinding', [msg(`game_${game}`), credits(lost), credits(settings.xpBudget), credits(bet)]);
    }
    const res = await playRound(game, bet);
    if (!res.ok) {
      log.warn('grind_failed', { game, status: res.status, error: res.data?.error });
      grindPausedUntil = Date.now() + CLAIM_RETRY_MS;
    }
    await sleep(settings.gameDelayMs);
    return true;
  }

  async function autoStep() {
    if (!player) return loadPlayer();
    if (await bankruptStep()) return;
    if (await claimFreebies()) return;
    if (await rotateStep(true)) return;
    if (await repayStep()) return;
    if (await loanTrickStep()) return;
    if (await loanCycleStep()) return;
    if (await buyStep()) return;
    if (await leaderboardStep()) return;
    if (await crashStep()) return;
    if (await standupStep()) return;
    if (workAvailable()) return workStep();
    if (await grindStep()) return;
    if (await rotateStep()) return;
    return workStep();
  }

  async function step() {
    if (settings.autoMode) return autoStep();
    if (await claimFreebies()) return;
    // The game bot would gamble the other account's credits, so only the work bot leaves.
    if (settings.enabled && !settings.gamesEnabled && (await rotateStep(true))) return;
    if (settings.enabled && workAvailable()) return workStep();
    if (settings.gamesEnabled) return gameStep();
    if (settings.enabled && (await rotateStep())) return;
    if (settings.enabled) return workStep();
  }

  async function tick() {
    if ((!settings.enabled && !settings.gamesEnabled && !settings.autoMode) || busy || switching) return;
    busy = true;
    try {
      await step();
    } catch (err) {
      log.error('step_failed', { error: String(err) });
    } finally {
      busy = false;
    }
  }

  function startWork() {
    saveSettings({ enabled: true });
    setStatus('statusStarting');
  }

  function stopWork(reasonKey = 'statusIdle') {
    saveSettings({ enabled: false });
    setStatus(reasonKey);
  }

  function startGames() {
    sessionBase = G.totalNet(stats.games);
    saveSettings({ gamesEnabled: true });
    setStatus('statusStarting');
  }

  function stopGames(reasonKey = 'statusIdle', subs) {
    saveSettings({ gamesEnabled: false });
    setStatus(reasonKey, subs);
  }

  // ---------- control panel ----------

  function setStatus(key, subs) {
    status = { key, subs };
    render();
  }

  function mountPanel() {
    const host = document.createElement('div');
    host.id = 'botter-panel';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        [hidden] { display: none !important; }
        .panel { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; width: 290px;
          max-height: calc(100vh - 24px); overflow: auto; box-sizing: border-box;
          font: 12px/1.4 system-ui, sans-serif; color: #e8f5c8; background: #101a08f2;
          border: 1px solid #7aa02c; border-radius: 10px; padding: 10px; box-shadow: 0 4px 16px #0008; }
        .row { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
        .title { font-weight: 700; flex: 1; }
        .grow { flex: 1; min-width: 0; }
        button, select { font: inherit; color: inherit; background: #1f3010; border: 1px solid #7aa02c;
          border-radius: 6px; padding: 4px 8px; cursor: pointer; }
        button:focus-visible, select:focus-visible, summary:focus-visible { outline: 2px solid #d4ff6a; outline-offset: 1px; }
        button.on { background: #7aa02c; color: #101a08; }
        .show { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; font-weight: 700;
          background: #101a08f2; box-shadow: 0 4px 16px #0008; }
        .status { min-height: 1.4em; margin-bottom: 4px; }
        .muted { color: #b5c99a; }
        details { margin-top: 6px; }
        summary { cursor: pointer; font-weight: 600; }
        table { width: 100%; border-collapse: collapse; margin-top: 4px; font-variant-numeric: tabular-nums; }
        th, td { padding: 2px 4px; text-align: right; white-space: nowrap; }
        th:first-child, td:first-child { text-align: left; white-space: normal; }
        th { color: #b5c99a; font-weight: 600; border-bottom: 1px solid #3d5420; }
        .pos { color: #a6e05a; }
        .neg { color: #ff8f7a; }
        .xp-note { margin: 4px 0 0; }
        .xp-retest { margin-top: 4px; }
        tr.group td { text-align: left; padding-top: 6px; font-weight: 600; color: #e8f5c8; }
        tr.pick td { color: #d4ff6a; font-weight: 700; }
      </style>
      <div class="panel" role="region">
        <div class="row">
          <span class="title"></span>
          <button type="button" class="auto-toggle"></button>
          <button type="button" class="hide"></button>
        </div>
        <div class="row">
          <label class="muted" for="account"></label>
          <select id="account" class="grow"></select>
          <button type="button" class="add-account"></button>
        </div>
        <div class="row">
          <label class="muted grow" for="type"></label>
          <select id="type">
            <option value="alternate"></option>
            <option value="bughunt"></option>
            <option value="output"></option>
            <option value="ticket"></option>
          </select>
          <button type="button" class="work-toggle"></button>
        </div>
        <div class="row">
          <label class="muted grow" for="game"></label>
          <select id="game"></select>
          <button type="button" class="games-toggle"></button>
        </div>
        <div class="row">
          <span class="muted grow screen-label"></span>
          <button type="button" class="screen-toggle"></button>
        </div>
        <div class="status" role="status" aria-live="polite"></div>
        <div class="stats muted"></div>
        <div class="cost muted"></div>
        <details class="profit">
          <summary></summary>
          <table>
            <thead><tr><th scope="col"></th><th scope="col"></th><th scope="col"></th><th scope="col"></th></tr></thead>
            <tbody></tbody>
          </table>
        </details>
        <details class="xp">
          <summary></summary>
          <p class="muted xp-note"></p>
          <button type="button" class="xp-retest"></button>
          <table>
            <thead><tr><th scope="col"></th><th scope="col"></th><th scope="col"></th><th scope="col"></th><th scope="col"></th></tr></thead>
            <tbody></tbody>
          </table>
        </details>
        <details class="shop">
          <summary></summary>
          <p class="muted xp-note shop-goal"></p>
          <table>
            <thead><tr><th scope="col"></th><th scope="col"></th><th scope="col"></th><th scope="col"></th></tr></thead>
            <tbody></tbody>
          </table>
        </details>
      </div>
      <button type="button" class="show"></button>`;
    const $ = (sel) => shadow.querySelector(sel);
    ui = {
      panel: $('.panel'),
      title: $('.title'),
      typeLabel: $('label[for="type"]'),
      type: $('#type'),
      autoToggle: $('.auto-toggle'),
      hide: $('.hide'),
      accountLabel: $('label[for="account"]'),
      account: $('#account'),
      addAccount: $('.add-account'),
      show: $('.show'),
      workToggle: $('.work-toggle'),
      gameLabel: $('label[for="game"]'),
      game: $('#game'),
      gamesToggle: $('.games-toggle'),
      screenLabel: $('.screen-label'),
      screenToggle: $('.screen-toggle'),
      status: $('.status'),
      stats: $('.stats'),
      cost: $('.cost'),
      summary: $('.profit summary'),
      head: [...shadow.querySelectorAll('.profit th')],
      body: $('.profit tbody'),
      xpSummary: $('.xp summary'),
      xpNote: $('.xp-note'),
      xpRetest: $('.xp-retest'),
      xpHead: [...shadow.querySelectorAll('.xp th')],
      xpBody: $('.xp tbody'),
      shop: $('.shop'),
      shopSummary: $('.shop summary'),
      shopGoal: $('.shop-goal'),
      shopHead: [...shadow.querySelectorAll('.shop th')],
      shopBody: $('.shop tbody'),
    };
    ui.panel.setAttribute('aria-label', msg('extName'));
    ui.title.textContent = msg('extName');
    ui.hide.textContent = msg('panelHide');
    ui.hide.setAttribute('aria-label', msg('panelHideLabel'));
    ui.show.textContent = msg('extName');
    ui.show.setAttribute('aria-label', msg('panelShowLabel'));
    ui.accountLabel.textContent = msg('panelAccount');
    ui.addAccount.textContent = msg('panelAddAccount');
    ui.addAccount.setAttribute('aria-label', msg('panelAddAccountLabel'));
    ui.typeLabel.textContent = msg('panelWork');
    ui.gameLabel.textContent = msg('panelGames');
    ui.screenLabel.textContent = msg('panelOnScreen');
    ui.summary.textContent = msg('panelProfit');
    ['colGame', 'colRounds', 'colNet', 'colRtp'].forEach((key, i) => (ui.head[i].textContent = msg(key)));
    ui.xpSummary.textContent = msg('panelXp');
    ui.xpNote.textContent = msg('panelXpNote');
    ui.xpRetest.textContent = msg('panelXpRetest');
    ['colBet', 'colRounds', 'colXpPerRound', 'colCostPerXp', 'colState'].forEach(
      (key, i) => (ui.xpHead[i].textContent = msg(key)),
    );
    ui.shopSummary.textContent = msg('panelShop');
    ['colUpgrade', 'colLevel', 'colPrice', 'colState'].forEach((key, i) => (ui.shopHead[i].textContent = msg(key)));
    for (const option of ui.type.options) option.textContent = msg(`type_${option.value}`);
    for (const game of G.GAME_KEYS) ui.game.add(new Option(msg(`game_${game}`), game));
    ui.autoToggle.addEventListener('click', () => {
      // The account auto mode is started on is the one rotation returns to.
      saveSettings({ autoMode: !settings.autoMode, ...(accountId && !settings.autoMode ? { homeAccount: accountId } : {}) });
      setStatus(settings.autoMode ? 'statusIdle' : 'statusStarting');
    });
    ui.hide.addEventListener('click', () => setPanelHidden(true));
    ui.account.addEventListener('change', () => {
      saveSettings({ homeAccount: ui.account.value });
      switchAccount(ui.account.value);
    });
    ui.addAccount.addEventListener('click', addAccount);
    ui.show.addEventListener('click', () => setPanelHidden(false));
    ui.workToggle.addEventListener('click', () => (settings.enabled ? stopWork() : startWork()));
    ui.gamesToggle.addEventListener('click', () => (settings.gamesEnabled ? stopGames() : startGames()));
    ui.screenToggle.addEventListener('click', () => saveSettings({ playOnScreen: !settings.playOnScreen }));
    ui.type.addEventListener('change', () => saveSettings({ taskType: ui.type.value }));
    ui.game.addEventListener('change', () => saveSettings({ game: ui.game.value }));
    ui.xpRetest.addEventListener('click', retestGames);
    document.documentElement.appendChild(host);
    render();
  }

  // Applied locally right away so focus can move to the button that stays visible.
  function setPanelHidden(hidden) {
    saveSettings({ panelHidden: hidden });
    settings.panelHidden = hidden;
    render();
    (hidden ? ui.show : ui.hide).focus();
  }

  function cell(text, className) {
    const td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  const tone = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

  function renderProfit() {
    const rows = G.profitRows(stats.games).map((row) => [
      msg(`game_${row.game}`),
      num.format(row.rounds),
      { text: signed.format(row.net), tone: tone(row.net) },
      row.rtp === null ? '-' : pct.format(row.rtp),
    ]);
    if (stats.work.tickets > 0) {
      rows.push([
        msg('panelWork'),
        num.format(stats.work.tickets),
        { text: signed.format(stats.work.net), tone: tone(stats.work.net) },
        '-',
      ]);
    }
    for (const [kind, amount] of Object.entries(stats.free)) {
      if (amount) rows.push([msg(`free_${kind}`), '-', { text: signed.format(amount), tone: tone(amount) }, '-']);
    }
    ui.body.replaceChildren(
      ...rows.map((values) => {
        const tr = document.createElement('tr');
        for (const value of values) tr.append(typeof value === 'object' ? cell(value.text, value.tone) : cell(value));
        return tr;
      }),
    );
  }

  // Forgets the measured XP per bet, so the grinder samples every unlocked game
  // and bet level again before it picks one.
  function retestGames() {
    stats.betXp = {};
    saveStats();
    log.info('xp_retest');
    render();
  }

  // XP grinding measurements per game and bet level, with the grinder's pick.
  function renderXp() {
    if (!player) {
      ui.xpBody.replaceChildren();
      return;
    }
    const { levels, candidates, edges, plan } = grindChoice();
    const report = A.grindReport(candidates, levels, player.level, stats.games, stats.betXp, GRIND_UNLOCKS, edges);
    const rows = [];
    for (const game of report) {
      const head = document.createElement('tr');
      head.className = 'group';
      const td = cell(
        game.locked
          ? msg('xpLocked', [msg(`game_${game.game}`), String(game.unlock)])
          : msg('xpGame', [
              msg(`game_${game.game}`),
              num.format(game.rounds),
              game.modelEdge === null ? '-' : pct.format(game.modelEdge),
              game.measuredEdge === null ? '-' : pct.format(game.measuredEdge),
              game.perRound === null ? '-' : decimal.format(game.perRound),
            ]),
      );
      td.colSpan = 5;
      head.append(td);
      rows.push(head);
      if (game.locked) continue;
      if (game.modelEdge === null && game.rounds < settings.grindExploreRounds) {
        const tr = document.createElement('tr');
        const note = cell(msg('xpExploring', [num.format(game.rounds), num.format(settings.grindExploreRounds)]), 'muted');
        note.colSpan = 5;
        tr.append(note);
        rows.push(tr);
      }
      for (const row of game.bets) {
        const pick = plan?.game === game.game && plan.bet === row.bet;
        const tr = document.createElement('tr');
        if (pick) tr.className = 'pick';
        tr.append(
          cell(credits(row.bet)),
          cell(row.rounds ? num.format(row.rounds) : '-'),
          cell(row.perRound === null ? '-' : decimal.format(row.perRound)),
          cell(row.cost === null ? '-' : decimal.format(row.cost)),
          cell(pick ? msg('xpPick') : row.state ? msg(`xpState_${row.state}`) : ''),
        );
        rows.push(tr);
      }
    }
    ui.xpBody.replaceChildren(...rows);
  }

  // The shop queue from the last review: the goal with the savings toward it,
  // then every upgrade left in the plan and why it waits.
  function renderShop() {
    const review = settings.buyUpgrades && player ? shopReview : null;
    ui.shop.hidden = !review;
    if (!review) return;
    const { goal, queue } = review;
    ui.shopGoal.textContent = goal
      ? msg('shopGoal', [
          `${goal.game}:${goal.key} ${goal.next}`,
          credits(Math.min(player.credits, goal.price)),
          credits(goal.price),
          pct.format(Math.min(1, player.credits / goal.price)),
        ])
      : msg('shopNoGoal');
    ui.shopBody.replaceChildren(
      ...queue.map((offer) => {
        const tr = document.createElement('tr');
        if (offer === goal) tr.className = 'pick';
        let state = msg('shopState_queued');
        if (offer === goal) state = msg('shopState_goal');
        else if (offer.reason === 'level') state = msg('shopNeedsLevel', [String(offer.minLevel)]);
        else if (offer.reason) state = msg(`shopState_${offer.reason}`);
        tr.append(cell(`${offer.game}:${offer.key}`), cell(String(offer.next)), cell(credits(offer.price)), cell(state));
        return tr;
      }),
    );
  }

  // Rebuilt only when the list changes, so a render does not close an open dropdown.
  function renderAccounts() {
    const now = Date.now();
    const list = Object.entries(accounts).map(([id, saved]) => ({
      id,
      login: saved.login ?? id,
      work: id === accountId ? (player?.work ?? saved.work) : saved.work,
      session: Boolean(saved.session),
    }));
    if (accountId && !accounts[accountId] && player) list.push({ id: accountId, login: player.login, work: player.work });
    list.sort((a, b) => a.login.localeCompare(b.login));
    const options = list.map((a) => ({
      value: a.id,
      text: msg(a.id === settings.homeAccount ? 'panelAccountOptionHome' : 'panelAccountOption', [
        a.login,
        String(G.energyNow(a.work, now)),
      ]),
      disabled: a.id !== accountId && !a.session,
    }));
    if (!accountId) options.unshift({ value: '', text: msg('panelNoAccount'), disabled: true });
    const signature = JSON.stringify(options);
    if (signature !== accountOptions) {
      accountOptions = signature;
      ui.account.replaceChildren(
        ...options.map(({ value, text, disabled }) => Object.assign(new Option(text, value), { disabled })),
      );
    }
    ui.account.value = accountId ?? '';
    ui.account.disabled = switching;
    ui.addAccount.disabled = switching;
  }

  function setToggle(button, on) {
    button.textContent = msg(on ? 'panelStop' : 'panelStart');
    button.classList.toggle('on', on);
    button.setAttribute('aria-pressed', String(on));
  }

  function render() {
    if (!ui) return;
    ui.panel.hidden = settings.panelHidden;
    ui.show.hidden = !settings.panelHidden;
    ui.show.classList.toggle('on', workOn() || gamesOn());
    setToggle(ui.autoToggle, settings.autoMode);
    ui.autoToggle.textContent = `${msg('panelAuto')}: ${msg(settings.autoMode ? 'panelOn' : 'panelOff')}`;
    setToggle(ui.workToggle, settings.enabled);
    setToggle(ui.gamesToggle, settings.gamesEnabled);
    ui.workToggle.setAttribute('aria-label', `${msg('panelWork')}: ${ui.workToggle.textContent}`);
    ui.gamesToggle.setAttribute('aria-label', `${msg('panelGames')}: ${ui.gamesToggle.textContent}`);
    ui.screenToggle.textContent = msg(settings.playOnScreen ? 'panelOn' : 'panelOff');
    ui.screenToggle.classList.toggle('on', settings.playOnScreen);
    ui.screenToggle.setAttribute('aria-pressed', String(settings.playOnScreen));
    ui.screenToggle.setAttribute('aria-label', msg('panelOnScreen'));
    renderAccounts();
    ui.type.value = settings.taskType;
    ui.game.value = settings.game;
    ui.status.textContent = msg(status.key, status.subs);
    const sum = (s) => `${s.correct}/${s.correct + s.wrong}`;
    ui.stats.textContent = msg('panelStats', [
      String(Object.keys(bank).length),
      sum(stats.bank),
      sum(stats[settings.aiSolver] ?? stats.local),
      sum(stats.guess),
    ]);
    const { usd: spent, calls } = stats.spend;
    ui.cost.textContent = msg('panelCost', [usd.format(spent), usd.format(calls ? spent / calls : 0)]);
    renderProfit();
    renderXp();
    renderShop();
  }

  // ---------- boot ----------

  load().then(() => {
    for (const response of early.splice(0)) onResponse(response);
    early = null;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountPanel);
    else mountPanel();
    setInterval(tick, TICK_MS);
  });
})();
