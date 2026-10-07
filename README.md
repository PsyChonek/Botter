# Botter

Chrome extension (Manifest V3) that solves the work tickets ("Práce") in
[Skeleton Casino](https://skeleton-casino.vercel.app/) automatically.

## How it works

- `src/page-hook.js` runs in the page's own JS world before the app loads and
  wraps `fetch`. It forwards the responses of `/api/me`, `/api/work/start`
  and `/api/work/submit` to the content script. No auth token is read or reused.
- `src/content.js` runs the loop: open the work screen, pick a ticket card,
  choose an answer, click the app's own button, dismiss the result with Escape, repeat.
  When energy runs out it waits for the refill. It also dismisses the level-up
  and daily-bonus modals, which would otherwise block the screen.
- The answer is chosen in this order:
  1. **Answer bank**: every submit response contains the correct answer
     (`result.answer`), so each ticket is learned the first time it is seen,
     whether the bot or you answered it. Output puzzles are stored by option text,
     so a reshuffled copy of the same puzzle still matches.
  2. **AI solver**, chosen in settings:
     - **On-device AI** (default): Chrome's built-in Prompt API with Gemini Nano
       (`src/local-model.js`), JSON-constrained to `{"index": n}`. Free, offline, no key.
       It runs in the service worker if Chrome exposes `LanguageModel` there, otherwise
       in an offscreen document (`src/offscreen.html`). Requires Chrome 138+, about 22 GB
       free disk and a GPU with more than 4 GB VRAM or 16 GB RAM. The first download
       needs a click, so use **Download the model** on the settings page once.
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
  leaves the page. The game screen does not animate and the credit balance on the
  page refreshes on the next app request. Guardrails: stop-loss and take-profit per
  session, a credit reserve, and the game's unlock level. With both bots on, work
  goes first and games fill the time while energy refills.
- **Profit tracking**: every game response (bot or manual play) is booked per game
  from the credit balance before and after, plus anything the debt collector took
  from the win. The panel shows rounds, net and return rate per game; the settings
  page shows wagered, returned, net, return rate, net per round and XP, plus credits
  earned per work ticket. Crash is neither auto-played nor tracked: it is one round a
  day and its auto cash-out is paid without a response.
- A small panel in the bottom-left corner of the page has Start/Stop for work and
  for games, the ticket type, the game, accuracy per answer source, AI cost and
  the profit table.

## Install

1. `chrome://extensions` > enable Developer mode > Load unpacked > pick this folder.
2. Click the extension icon to open the settings. For the default on-device solver,
   press **Download the model** once. For Claude, switch the solver and paste an
   Anthropic API key; it is stored only in `chrome.storage.local` of that browser
   profile and is sent only to `api.anthropic.com`.
3. Open the casino, log in, and press **Start** in the panel.

The bank can be exported and imported as JSON from the settings page, so a
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
Práce), `.work-screen`, `.work-pick .job-card` (bug hunt, then output),
`section.task`, `.ticket`, `ol.code.lines > li button`, `.options button`,
`button.right` / `button.wrong` after a submit, `.modal .sheet.levelup`,
`.modal .sheet.daily`. If the casino UI changes, start there.
