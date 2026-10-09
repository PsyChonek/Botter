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
  There are four ticket types: bug hunt (click the buggy line), "Co to vypíše?"
  (pick the printed output), "Založ task" (read a help-desk message and pick type,
  priority and team; the app submits it as one number, `type*100 + priority*10 + team`)
  and "Přepiš kód" (retype a line of code character by character; the app blocks
  pasting, so the bot types the line from the task at a quick typist's pace through the
  input's native value setter and sends it with Enter). **Alternate** cycles through
  all four. In auto mode **Alternate** works only "Přepiš kód": its answer is in the
  task, so it is never wrong, and a wrong answer spends the energy without pay. Pick a
  type in the panel to override that.
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
  return above the threshold (stakes up to 10x the slot max bet, 10,000 from level 15), work every ticket, and gamble other games only to grind
  XP within a daily loss budget, down to a minimum account balance, or with the
  limit off down to the reserve (grinding is off by default). The grinder plans
  with the long-run house edge of each game at the account's current upgrades
  (`src/odds.js`), not the noisy measured one: blackjack and roulette exactly, the slots from a table of every upgrade combination
  generated by `scripts/odds.mjs`. Return to player, unupgraded to fully upgraded:
  roulette 92.3 % to 97.3 %, blackjack 87.6 % to 97.1 %, Slotingi about 74 % to 93 %,
  Skeleton Slots about 71 % to 94 %, Blaze about 63 % to 95 % (or 67 % to 108 % if the
  star scatter counts symbols; the Blaze model check decides once 50 spins are
  recorded, until then the lower rule is used). A game without a model is
  never picked. XP per round is proportional
  to the bet the same way in every game, so the grinder plays the unlocked game with the
  lowest simulated edge, every bet level costs the same per XP and the bet is simply the
  one picked in the settings. The panel shows each game's XP per credit and loss per XP
  measured from its tracked rounds, for information only. Near a limit the grinder
  steps down to a smaller bet; under a daily budget it never bets more than what is
  left of it.
- **Daily standup** (Dnešní standup, settings Auto tab, on by default): three quests a
  day in `player.quests`, such as spinning a game 25 times, wagering 2,500 credits or
  finishing 10 rounds ahead. The server tracks the progress and pays each reward (about
  480) as soon as a quest is done, plus a bonus for all three and the Standup achievement
  (500 / 2,000 / 5,000 for 1 / 7 / 30 full days). Auto mode reads the game and the kind
  from the quest text and plays it before work when its expected loss is below its
  reward (`standupPlan` in `src/auto.js`): game rounds at the smallest bet, a wager on
  the lowest-edge game at the biggest bet that does not overshoot, rounds ahead on the
  game where the simulated share of rounds that end ahead (see Odds in the settings)
  makes them cheapest. The bonus and the achievement are not counted, so the estimate is
  conservative. It keeps the reserve but not the grinding budget: quest and achievement
  rewards are booked as free income, kept out of game and work profit, and the standup
  reward offsets the day's grinding loss. Quests it cannot read, crash quests and ones
  on a locked game are skipped and logged as `standup_skipped`.
- **Achievement hunt** (settings Auto tab, on by default; `huntPlan` in `src/auto.js`):
  goes after the credit achievements the bot can steer, read from `player.achievements`,
  and only while the reward beats the expected loss. Each round is valued at the
  rewards it can unlock times their chance and played at the smallest bet on the game
  where that margin is biggest: a straight bet on 0 in roulette (Nula od nuly, 1,000,
  1 in 39 unupgraded), blackjack hands for a natural (300, 4.8 %) and a five-card win
  (1,000, 0.5 %, both from a simulation of the bot's strategy), any round between 2:00
  and 5:00 (Ponocování, 300), and the next rounds-played tier (1,000 / 5,000 / 25,000
  at 1,000 / 10,000 / 100,000 rounds) spread over the rounds it still needs. On crash it
  bets the smallest stake with auto cash-out at 10x (Uptime hrdina, 2,000) when the
  round history gives a chance that pays with the reward counted, even with crash
  betting off. It works one ticket on Friday after 17:00 (Deploy v pátek, 200) and
  answers a banked bug or output ticket inside 3 seconds (Rychloprsťák, 200) unless the
  server has rejected that fast a submit. Like the standup it keeps the reserve but not
  the grinding budget, and achievement rewards offset the day's grinding loss. The slot
  achievements (wild, star, cascade and jackpot events, big wins) are left to the
  grinder: their chances are not modelled yet.
- **Wheel of fortune** (Kolo štěstí, `/api/wheel/spin`): free once an hour, paid in
  multiples of the player's work pay (100 for Stážista up to 500 for Architekt) or a
  coffee that refills energy. It is spun as soon as `player.wheelNextAt` has passed, with the other free
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
    are paid 5,000 / 3,500 / 2,000 when the sprint ends. Bankruptcy wipes the week's
    points. Off the podium that is only this week's progress, so it is ignored. On the
    podium (read from the sprint leaderboard, refreshed every 10 minutes) the
    bankruptcy waits for the sprint to end and lands on the new sprint's first
    points, and a cycle loan is taken only in the last 12 hours of the sprint, so its
    execution comes after the prize. Each bankruptcy marks the name on the
    leaderboards for a week. The sprint board is also opened with the others for the
    podium achievement.
- **Lottery** (Loterie, from level 4, part of the achievement hunt; `lotteryPlan` in
  `src/auto.js`): 6 of 49, drawn every day at 20:00, at most five tickets per draw. A
  ticket pays 1 / 20 / 200 / 2,000 / 10,000 times its price for 2 to 6 numbers, the
  same odds at every price, so it returns about 71.7 % and never pays on its own. Its
  achievements do: 3+ numbers (1,000), 4 numbers (5,000), 5 numbers (20,000, secret),
  all five tickets on one draw (300) and tickets on 1 / 7 / 30 draws (300 / 2,000 /
  5,000). Each ticket is valued at those rewards times their chance against its
  expected loss, always at the cheapest price. That means five tickets a draw until 3
  numbers hit once, then one ticket a draw for the draws-played tiers, then none. Ticket
  purchases and the payouts of each draw are booked as the Lottery game.
- **Payroll fund** (Mzdový fond, settings Auto tab, on by default; `edgePlan` in
  `src/auto.js`): 1 % of every bet goes into a shared fund that must drop by its cap
  (12,000), and the bet that drops it takes it all. The bot reads the fund from every
  response that carries it and polls the feed once a minute otherwise. It models the
  drop point as uniform between the fund and the cap, so a bet of `b` drops it with
  chance `0.01 b / (cap - fund)`, worth that chance times the fund. Near the cap that
  beats the house edge (from about 10,600 of 12,000 on roulette), and the bot bets on
  the lowest-edge game. The bet is sized by half Kelly on the game's own variance only:
  the fund can only add, so it is no risk. The client shows no sign that the player
  pays the 1 %, so the house most likely funds it. A fund win is booked as free income.
- **Weekend events** (`weekendEvent` in `src/auto.js`, same rotation as the client):
  Friday 17:00 to Monday 9:00, Prague time, one per weekend from the week of
  2026-10-05: Hackathon (+50 % XP), Konec kvartálu (+50 % on the net profit of every
  round that ends ahead, up to a weekend limit the client does not show), Teambuilding
  (the wheel pays double) and Placené přesčasy (work pays double credits and XP).
  - Konec kvartálu turns the games positive: an even-money roulette bet returns
    about +21.6 % a credit unupgraded. With the payroll setting on, the bot bets on the
    game where `rtp + 0.5 * gain` is best (gain is the simulated mean net profit per
    credit of the rounds that end ahead), half Kelly on its simulated variance, until a
    winning round comes back without the bonus, which means the limit is reached. The
    bonus is booked as free income so it does not inflate the game's measured return.
  - Before Placené přesčasy, work waits while the energy refilling until Friday 17:00
    still fits under the cap, so the event starts with a full bar, and during it work
    drains energy at once instead of keeping it for the grinder.
  - Hackathon and Teambuilding need nothing: XP per credit improves by the same factor
    in every game, and the wheel is spun anyway.
- **Settings for the rest** (settings, Auto tab): XP grinding game (cheapest
  per XP or a fixed game), bet (a fixed level, 20 by default); automatic shop purchases from
  a priority plan (`game:key` list, off by default) using the client's price and
  level formulas. A plan entry is skipped when it is not worth its price
  (`upgradeVerdict` in `src/auto.js`): it adds less than 0.5 % return per 10,000
  credits (blackjack hint, double and soft 17, Slotingi mint), the grinder would not
  pick the game even fully upgraded, or spending the price on plain grinding gives
  more XP than grinding the rest at the cheaper cost (volume: 14 days of the daily
  budget, or the credits above the minimum balance; judged for the next levels alone
  and for the game's useful upgrades maxed together). `crash:sla` is never bought:
  Produkce padá's daily payout is too small to earn it back. `global:bets` (higher max bet) is not in the plan: XP per round
  is proportional to the bet, so a bigger bet never buys XP cheaper. The whole plan is judged again every 10 minutes and as soon as the level, the
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
  A profile reset (Začít úplně od nuly, `/api/profile/reset`) wipes the account on the
  server, so its stats start over too: profit, XP per game, free income and the
  achievement flags, so the clean-loan trick and the podium run again. Only the submit
  dwell times are kept.
- **Odds per upgrade** (settings, Games tab): for every game and every combination of
  its shop upgrades the return to player, the share of rounds won (more back than the
  bet), the chance that 1,000 rounds end ahead and the return on a Konec kvartálu
  weekend, all from the simulation in `scripts/odds.mjs`. Roulette is an even-money bet, blackjack the bot's own strategy,
  Blaze is listed per scatter rule. The current account's upgrades are marked.
- **XP per game** (panel): for each game the house edge the grinder plans with, XP per
  100 credits wagered, credits lost per XP point and its state (locked or playing at
  the chosen bet). The row the grinder plays next is highlighted.
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
    to switch: it signs out with scope `global`, which revokes every session of that
    account on the server, so the saved copy dies too.
  - Supabase rotates the refresh token on every refresh and revokes the whole login
    when a replaced one is used again, so the saved copy must always hold the newest
    token. The page hook reports every `/auth/v1/token` response and the content
    script writes it into the saved login at once, even when supabase-js discards it
    (it does when localStorage changes mid-refresh, as on a switch) or the page
    reloads first. A saved copy is never replaced by one with an earlier
    `expires_at`, and a switch waits until no refresh is in flight.
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

`node scripts/odds.mjs [spins]` regenerates `src/odds-table.js` (about 10 minutes at
the default 300,000 spins per combination). Besides the slot returns it records, for
every game and upgrade combination (roulette and blackjack included), the share of
rounds that return more than the bet, the share of 10,000 sessions of 1,000 rounds,
drawn from those spins, that end ahead, the mean net profit per credit of the rounds
that end ahead (what the Konec kvartálu bonus pays on) and the variance of one round's
return (for Kelly sizing). Rerun it when the casino changes a slot's
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
Práce), `.work-screen`, `.work-pick .job-card` (bug hunt, output, ticket, then typing), `.typing-input`,
`section.task`, `.ticket`, `ol.code.lines > li button`, `.options button`,
`.ticket-field .ticket-options button` and `.ticket-submit` (the triage rules are
copied into `TICKET_FIELDS` in `src/core.js`),
`button.right` / `button.wrong` after a submit, `.modal .sheet.levelup`,
`.modal .sheet.daily`. If the casino UI changes, start there.
