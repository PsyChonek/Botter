# Botter

Chrome extension (Manifest V3) that solves the work tickets ("Práce") in
[Skeleton Casino](https://skeleton-casino.vercel.app/) automatically.

## How it works

- `src/page-hook.js` runs in the page's own JS world before the app loads and
  wraps `fetch`. It forwards the responses of `/api/me`, `/api/work/start`
  and `/api/work/submit` to the content script. No auth token is read or reused.
- `src/content.js` runs the loop: open the work screen, pick a ticket card,
  choose an answer, click the app's own button, dismiss the result with Escape, repeat.
  There are three ticket types: bug hunt (click the buggy line), "Co to vypíše?"
  (pick the printed output) and "Založ task" (read a help-desk message and pick type,
  priority and team; the app submits it as one number, `type*100 + priority*10 + team`).
  **Alternate** cycles through all three.
  When energy runs out it waits for the refill. It also dismisses the level-up
  and daily-bonus modals, which would otherwise block the screen.
- The answer is chosen in this order:
  1. **Answer bank**: every submit response contains the correct answer
     (`result.answer`), so each ticket is learned the first time it is seen,
     whether the bot or you answered it. Output puzzles are stored by option text,
     so a reshuffled copy of the same puzzle still matches. "Založ task" tickets are
     stored by sender and message.
  2. **AI solver**, chosen in settings:
     - **On-device AI** (default): Chrome's built-in Prompt API with Gemini Nano
       (`src/local-model.js`), JSON-constrained to `{"index": n}` (one index per field for tickets). Free, offline, no key.
       It runs in the service worker if Chrome exposes `LanguageModel` there, otherwise
       in an offscreen document (`src/offscreen.html`). Requires Chrome 138+, about 22 GB
       free disk and a GPU with more than 4 GB VRAM or 16 GB RAM. The first download
       needs a click, so use **Download the model** in the settings (AI tab) once.
       It is a small model: expect noticeably more misses than Claude on tricky
       "what does it print" puzzles.
     - **Claude API**: `src/background.js` calls the Messages API with structured
       output. Default model `claude-opus-5-5` at `medium` effort. Needs an API key.
     - **OpenRouter**: any model ID from openrouter.ai/models (default
       `google/gemini-2.5-flash`). Sends a `json_schema` response format; models
       that ignore it still work because the answer parser accepts a number in prose.

If the on-device model reports "not supported" or "The feature flag gating model
execution was disabled", open `chrome://flags`, set **Enables optimization guide on
device** to **Enabled BypassPerfRequirement** and **Prompt API for Gemini Nano** to
**Enabled**, relaunch Chrome and press **Download the model** again. Download
progress shows at `chrome://on-device-internals`.
  3. **Guess** (optional): a random valid choice. A wrong answer costs energy
     but teaches the bank.
- **Game bot** (`src/games.js`, game loop in `src/content.js`): plays Blaze 20 Wild,
  Skeleton Slots, Slotingi, Roulette (one outside bet, red by default) and Blackjack
  (follows the table's own hint) through the casino API. The page hook performs the
  calls with the session the app already holds (supabase session in localStorage,
  falling back to the last Authorization header the app sent), so the token never
  leaves the page. The game screen does not animate, but after every bot round the
  hook hands the fresh player snapshot to the app's own state, so the credits, XP
  bar and level in the top bar update live. Guardrails: stop-loss and take-profit per
  session, a credit reserve, and the game's unlock level. With both bots on, work
  goes first and games fill the time while energy refills.
- **Auto mode** (`src/auto.js`, one toggle in the panel) runs everything in order of
  value each tick: claim the daily bonus and bailout, repay debt (8 %/h compounding
  until 2.5x, then 50 % of every payout is garnished), take the one-time +500
  clean-loan achievement (borrow 500, repay inside the free hour), open every
  leaderboard once a day (the podium achievement pays +1000 for top 3 on any board,
  debtors included), bet on crash only when the round history gives an expected
  return above the threshold, work every ticket, and gamble other games only to grind
  XP within a daily loss budget (default 0). Measured house edges: blackjack -12.4 %
  base to -2.9 % fully upgraded (exact solver in `src/blackjack.js`), roulette -7.7 %
  to -2.7 %, Blaze about 66 % RTP by simulation. Grinding explores each unlocked game
  for 30 rounds, then sticks to the lowest measured loss per XP.
- **Settings for the rest** (settings, Auto tab): XP grinding game (cheapest
  per XP or a fixed game), bet and exploration rounds; automatic shop purchases from
  a priority plan (`game:key` list, off by default) using the client's price and
  level formulas; a Blaze model check (`src/blaze.js`) that records every Blaze spin
  with its board and the server win, reports which scatter rule reproduces the
  server and simulates the payout rate for current and maxed upgrades; and a debug
  capture of raw loan, crash, shop, leaderboard and bonus responses for export.
- **Profit tracking**: every game response (bot or manual play) is booked per game
  from the credit balance before and after, plus anything the debt collector took
  from the win. The panel shows rounds, net and return rate per game; the settings
  Profit tab shows wagered, returned, net, return rate, net per round and XP, plus credits
  earned per work ticket. Crash bets are booked when they settle, from the round's bet list.
- A small panel in the bottom-left corner of the page has Start/Stop for work and
  for games, the ticket type, the game, accuracy per answer source, AI cost and
  the profit table. **Hide** collapses it to a small Botter button in the same corner
  (highlighted while a bot runs); click it to bring the panel back. The same switch is
  in the settings (Bot tab).

## Install

1. `chrome://extensions` > enable Developer mode > Load unpacked > pick this folder.
2. Click the extension icon to open the settings in Chrome's side panel, next to
   the casino tab. Every change saves as you make it; there is no Save button. For the default on-device solver,
   press **Download the model** once. For Claude, switch the solver and paste an
   Anthropic API key; it is stored only in `chrome.storage.local` of that browser
   profile and is sent only to `api.anthropic.com`.
3. Open the casino, log in, and press **Start** in the panel.

The bank can be exported and imported as JSON from the settings (Data tab), so a
bank learned on one machine can be reused on another.

## Development

```
npm run check
```

This parses every script, checks that both locales (`cs`, `en`) carry the same
message keys and that every key used in code exists, then runs the unit tests
for `src/core.js`. There are no dependencies and no build step. After editing,
press reload on the extension card in `chrome://extensions` and refresh the
casino tab.

Selectors the bot relies on (from the app bundle): `nav.views button` (2nd is
Práce), `.work-screen`, `.work-pick .job-card` (bug hunt, output, then ticket),
`section.task`, `.ticket`, `ol.code.lines > li button`, `.options button`,
`.ticket-field .ticket-options button` and `.ticket-submit` (the triage rules are
copied into `TICKET_FIELDS` in `src/core.js`),
`button.right` / `button.wrong` after a submit, `.modal .sheet.levelup`,
`.modal .sheet.daily`. If the casino UI changes, start there.
