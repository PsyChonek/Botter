# Botter

Chrome extension (Manifest V3) that solves the work tickets ("Práce") in
[Skeleton Casino](https://skeleton-casino.vercel.app/) automatically.

## How it works

- `src/page-hook.js` runs in the page's own JS world before the app loads and
  wraps `fetch`. It forwards every `/api/` response to the content script, tagged
  with the user id (`sub`) decoded from the token the request was sent with, so
  each response is booked to the right account.
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
  falling back to the last Authorization header the app sent), so the bot never
  sends the token anywhere itself (saved sessions for account switching are
  described under Accounts). The game screen does not animate, but after every bot
  round the hook hands the fresh player snapshot to the app's own state, so the
  credits, XP bar and level in the top bar update live. Guardrails: stop-loss and take-profit per
  session, a credit reserve, and the game's unlock level. With both bots on, work
  goes first and games fill the time while energy refills.
- **Play on the game screen** (panel toggle, also in the settings Games tab, off by
  default; `src/screen.js`): every round the bot plays (game bot, grinder, standup)
  goes through the app's own game screen instead of the API. It opens the game from
  the lobby, sets the bet with the +/- buttons (roulette: clears the table and lays
  chips on the even-money spot), presses spin, deal or hit/stand/double, and waits
  until the screen is idle again, so reels, cards and the wheel animate as if you
  played. The result is the app's own response, booked like a manual round. It is
  several times slower per round than the API, so leave it off for grinding.
- **Auto mode** (`src/auto.js`, one toggle in the panel) runs everything in order of
  value each tick: declare personal bankruptcy when it is cheaper than paying (see
  below), claim the daily bonus, the free hourly wheel of fortune and the bailout,
  repay debt (8 %/h compounding
  until 2.5x, then 50 % of every payout is garnished), take the one-time +500
  clean-loan achievement (borrow 500, repay inside the free hour), open every
  leaderboard once a day (the podium achievement pays +1000 for top 3 on any board,
  debtors included), bet on crash only when the round history gives an expected
  return above the threshold, work every ticket, and gamble other games only to grind
  XP within a daily loss budget or down to a minimum account balance (off by
  default). The grinder plans with the long-run house edge of each game at the
  account's current upgrades (`src/odds.js`), not the noisy measured one: blackjack
  and roulette exactly, the slots from a table of every upgrade combination
  generated by `scripts/odds.mjs`. Return to player, unupgraded to fully upgraded:
  roulette 92.3 % to 97.3 %, blackjack 87.6 % to 97.1 %, Slotingi about 74 % to 93 %,
  Skeleton Slots about 71 % to 94 %, Blaze about 63 % to 95 % (or 67 % to 108 % if the
  star scatter counts symbols; the Blaze model check decides once 50 spins are
  recorded, until then the lower rule is used). Games without a model (none today)
  are explored for 30 rounds and use the measured edge. Loss per XP is the edge times
  bet / XP per round; XP per round is measured per bet level (10 rounds each), and a
  game's samples are dropped when its upgrades change, because upgrades lower XP per
  round, and every sample expires after 3 days, so games and bet levels that were
  ruled out get measured again. The auto bet only moves to the next level while XP per credit wagered keeps
  up, so it settles on the bet with the lowest loss per XP; under a daily budget it
  never bets more than what is left of it.
- **Daily standup** (Dnešní standup, settings Auto tab, on by default): three quests a
  day in `player.quests`, such as spinning a game 25 times, wagering 2,500 credits or
  finishing 10 rounds ahead. The server tracks the progress and pays each reward (about
  480) as soon as a quest is done, plus a bonus for all three and the Standup achievement
  (500 / 2,000 / 5,000 for 1 / 7 / 30 full days). Auto mode reads the game and the kind
  from the quest text and plays it before work when its expected loss is below its
  reward (`standupPlan` in `src/auto.js`): game rounds at the smallest bet, a wager on
  the lowest-edge game at the biggest bet that does not overshoot, rounds ahead on
  roulette's even-money bet or blackjack (slots are assumed to end ahead a quarter of
  the time). The bonus and the achievement are not counted, so the estimate is
  conservative. It keeps the reserve but not the grinding budget: quest and achievement
  rewards are booked as free income, kept out of game and work profit, and the standup
  reward offsets the day's grinding loss. Quests it cannot read, crash quests and ones
  on a locked game are skipped and logged as `standup_skipped`.
- **Wheel of fortune** (Kolo štěstí, `/api/wheel/spin`): free once an hour, paid in
  multiples of a base set by the player's title (100 to 300) or a coffee that refills
  energy. It is spun as soon as `player.wheelNextAt` has passed, with the other free
  claims (also outside auto mode), and booked as free income. Account rotation visits
  another account whose wheel is ready, right after accounts not seen today.
- **Personal bankruptcy** (Insolvence, `/api/loan/bankrupt`, settings Auto tab, on by
  default): offered only in execution. The debt is wiped and credits are set to 500,
  but the XP into the current level is lost, as are this week's sprint points, and
  the shark lends nothing for a week (the clean-loan trick waits). Paying costs the
  whole debt, so bankruptcy is planned when the debt is bigger than the credits above
  500 plus the lost XP at the grinder's measured credits per XP (`bankruptWorth` in
  `src/auto.js`; before any XP price is measured, only with no XP at stake).
  - Once it is planned, credits are worth nothing past the reset, so the bot stops
    repaying, the shop plan buys with no reserve and the grinder bets down to the last
    credit, ignoring the daily budget and minimum balance. It declares when nothing is
    left to buy or bet.
  - Near the end of a level it waits for the level-up when the XP into the level is
    worth more than the garnish on the work pay that finishes it (half of the missing
    XP times credits per work XP, `waitForLevel`). Otherwise it declares right away
    rather than hand half of every payout to a debt that will be wiped.
  - **Loan cycle** (on by default, needs bankruptcy on): with no loan, no block and the
    clean-loan trick done, the bot takes the biggest loan when dropping it pays
    (`loanCycle`). The loan is spent like above, and 12 hours later the debt hits its
    cap, execution starts and bankruptcy wipes it. The expected cost is the XP into the
    level at that point, uniform over the level, each point at the cheaper of losing
    it or waiting for the level, plus the account's credits above 500, which go with
    it. A test checks the formula against a Monte Carlo run. At most once a week,
    because of the block. The loan is booked as free income.
  - **Sprint**: story points are the XP earned since Monday 9:00, and the top three
    are paid 10,000 / 5,000 / 2,500 when the sprint ends. Bankruptcy wipes the week's
    points. Off the podium that is only this week's progress, so it is ignored. On the
    podium (read from the sprint leaderboard, refreshed every 10 minutes) the
    bankruptcy waits for the sprint to end and lands on the new sprint's first
    points, and a cycle loan is taken only in the last 12 hours of the sprint, so its
    execution comes after the prize. Each bankruptcy marks the name on the
    leaderboards for a week. The sprint board is also opened with the others for the
    podium achievement.
- **Settings for the rest** (settings, Auto tab): XP grinding game (cheapest
  per XP or a fixed game), bet (cheapest per XP or a fixed level) and exploration rounds; automatic shop purchases from
  a priority plan (`game:key` list, off by default) using the client's price and
  level formulas. A plan entry is skipped when it is not worth its price
  (`upgradeVerdict` in `src/auto.js`): it adds less than 0.5 % return per 10,000
  credits (blackjack hint, double and soft 17, Slotingi mint), the grinder would not
  pick the game even fully upgraded, or spending the price on plain grinding gives
  more XP than grinding the rest at the cheaper cost (volume: 14 days of the daily
  budget, or the credits above the minimum balance; judged for the next levels alone
  and for the game's useful upgrades maxed together). `global:bets` is bought only
  while the grinder's bet is at the max bet, `crash:sla` only while crash betting is
  on. The whole plan is judged again every 10 minutes and as soon as the level, the
  upgrades or the max bet change (`G.shopQueue` with `reviewShop` in `src/content.js`);
  the first entry worth buying at the current level is the goal, logged as
  `upgrade_goal`. With **Save for the next upgrade** (on by default) the grinder keeps
  the goal's price on top of the reserve, so work pay saves up to it instead of being
  ground away (not past a planned bankruptcy, which wipes the savings). Once bought, the
  next goal is bought on the next tick if it fits too. The panel's **Upgrade queue**
  shows the goal with the savings toward it and why every other upgrade waits. Skips
  are logged as `upgrades_skipped`; a Blaze model check (`src/blaze.js`) that records every Blaze spin
  with its board and the server win, reports which scatter rule reproduces the
  server and simulates the payout rate for current and maxed upgrades; and a debug
  capture of raw loan, crash, shop, leaderboard and bonus responses for export.
- **Profit tracking**: every game response (bot or manual play) is booked per game
  from the credit balance before and after, plus anything the debt collector took
  from the win. The panel shows rounds, net and return rate per game; the settings
  Profit tab shows wagered, returned, net, return rate, net per round and XP, plus credits
  earned per work ticket. Crash bets are booked when they settle, from the round's bet list.
- **XP per bet** (panel): for each game the tracked rounds, measured house edge and
  average XP per round, then per bet level the sampled rounds, XP per round, credits lost
  per XP point and the level's ladder state (testing, best, worse, skipped). The row the
  grinder plays next is highlighted, so you can check it really tried every option.
- A small panel in the bottom-left corner of the page has Start/Stop for work and
  for games, the ticket type, the game, accuracy per answer source, AI cost and
  the profit table. **Hide** collapses it to a small Botter button in the same corner
  (highlighted while a bot runs); click it to bring the panel back. The same switch is
  in the settings (Bot tab).
- **Accounts**: stats, profit, achievement flags (clean loan, leaderboards) and the
  daily XP budget are kept per account under `stats:<user id>`; the answer bank and
  settings are shared. Stats from before this existed go to the first account that
  logs in. The content script saves each account's supabase session (the
  `sb-*-auth-token` entry in the page's localStorage) under `account:<user id>` in
  `chrome.storage.local`, together with a snapshot of its level, credits and energy.
  - **Add** in the panel saves the current session, removes it from the page without
    logging out and reloads to the login screen. Never use the casino's own Log out
    to switch: supabase revokes the session on the server, so the saved copy dies too.
  - The account dropdown in the panel writes the chosen session back and reloads.
    If that login has expired, auto mode forgets it and switches back.
  - **Rotate accounts** (settings, Auto tab, on by default): when the current
    account is out of energy and has nothing else to do, auto mode (or the work bot
    alone) switches to an account not visited today, otherwise to the one with the
    most projected energy (more than 15), so every account's energy gets used. In
    auto mode, once the current account can no longer grind XP (out of credits or
    budget), it also switches to the richest account that still can and bets there.
    When that account is done it returns to the **home** account: the one picked in
    the dropdown, or the one auto mode was started on (marked in the dropdown). It
    stays at least a minute on each account. With one saved account it does nothing.
  - Work starts only once energy is above 5 and then works it down to zero, so single
    refilled points do not keep interrupting the grinder. In auto mode, while the
    account can still grind XP, it grinds first and works only to keep energy 2 below
    the cap (at the cap the refill clock stops): tickets pay more at a higher level,
    so the rest of the energy is spent once grinding is done.
  - Use one casino tab per account. Two tabs on the same origin share one supabase
    session, so a second tab can write its old session back. To run two accounts at
    once, open the second in an incognito window with Botter allowed in incognito;
    both share the bank and settings and keep separate stats.
  - The Profit tab in the settings lists the saved accounts (Forget drops a saved
    login, not its stats) and shows profit per account or summed over all of them.

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

`node scripts/odds.mjs [spins]` regenerates `src/odds-table.js` (about 6 minutes at
the default 300,000 spins per combination). Rerun it when the casino changes a slot's
weights, paytable or upgrade effects. Skeleton Slots and Slotingi are evaluated on the
server, so their models follow the client's rules text where it leaves details open:
Skeleton counts rockets after the last cascade and lets free spins retrigger, Slotingi
lands each respin coin independently per empty cell.

`npm run check` parses every script, checks that both locales (`cs`, `en`) carry the same
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
