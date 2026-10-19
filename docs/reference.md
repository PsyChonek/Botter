# Botter reference

The full description of every feature, model and setting. The short version is the
[README](../README.md).

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
  all four, in auto mode too. "Přepiš kód" is never wrong, since its answer is in the
  task, while a wrong answer on the others spends the energy without pay; pick it in
  the panel to work only those.
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
  Skeleton Slots, Slotingi, Forbes z Chánova, Roulette (one outside bet, red by default),
  Blackjack (follows the table's own hint) and Baccarat (Bankéř, see below) through the casino API. The page hook performs the
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
  (`src/odds.js`), not the noisy measured one: blackjack, roulette, baccarat, Kostky and Case opening exactly, the slots from a table of every upgrade combination
  generated by `scripts/odds.mjs`. Return to player, unupgraded to fully upgraded:
  Forbes z Chánova about 94 % to 123 % (modelled, see below), Kostky 92.4 % to 97.9 %,
  roulette 92.3 % to 97.3 %, baccarat 90.5 % to 97.8 %, blackjack 87.6 % to 97.1 %,
  Case opening 86.9 % to 96.2 %, Slotingi about 74 % to 93 %,
  Skeleton Slots about 71 % to 94 %, Blaze about 63 % to 95 % (or 67 % to 108 % if the
  star scatter counts symbols; the Blaze model check decides once 50 spins are
  recorded, until then the lower rule is used). A game without a model is
  never picked. XP per round grows with the bet the same way in every game, so the
  grinder plays the unlocked game with the lowest simulated edge. Every round pays at
  least 1 XP (since 2026-10-09), so small bets are cheaper per XP but slower (a
  2026-10 test on roulette: 1.4 credits lost per XP at 20, about 2.5 from 100 up); the
  bet is the one picked in the settings. The panel shows each game's XP per credit and loss per XP
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
  makes them cheapest, and a big / mega / super win (a round paying 10x / 25x / 50x the
  bet, as in the client's big_fish achievement) at the smallest bet on the slot where the
  simulated chance of one makes it cheapest; roulette and blackjack never pay one. The
  bonus and the achievement are not counted, so the estimate is
  conservative. It keeps the reserve but not the grinding budget: quest and achievement
  rewards are booked as free income, kept out of game and work profit, and the standup
  reward offsets the day's grinding loss. Quests it cannot read, crash quests and ones
  on a locked game are skipped and logged as `standup_skipped`.
- **Achievement hunt** (settings Auto tab, on by default; `huntPlan` in `src/auto.js`):
  goes after the credit achievements the bot can steer, read from `player.achievements`,
  and only while the reward beats the expected loss. Each round is valued at the
  rewards it can unlock times their chance and played at the smallest bet on the game
  where that margin is biggest: a straight bet on 0 in roulette (Nula od nuly, 1,000,
  1 in 39 unupgraded), a baccarat tie bet (Kompromis, 1,000, 9.5 %) and then a player
  pair bet (Pair programming, 1,000, 1 in 13), a Kostky bet on any triple (2,000, 1 in
  36), then on a sum of 4 (2,000, 1 in 72), then on Malá for a triple to take it (500),
  cases for a gold knife (5,000, 0.26 %), the burning Fabia (2,000, 0.21 %) and three
  pens in a row (500), blackjack hands for a natural (300, 4.8 %) and a five-card win
  (1,000, 0.5 %, both from a simulation of the bot's strategy), any round between 2:00
  and 5:00 (Ponocování, 300), and the next rounds-played tier (1,000 / 5,000 / 25,000
  at 1,000 / 10,000 / 100,000 rounds, up to the tier picked in the settings, 10,000 by
  default) spread over the rounds it still needs. On crash it
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
  coffee that refills energy. It is spun 5 seconds after `player.wheelNextAt` has passed (a refused spin is retried after a minute), with the other free
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
  - "Feeling lucky" (settings, Auto tab, off by default; `luckyPlan`) buys a set number
    of tickets (1 to 5) every draw at a chosen price, or the biggest affordable one
    below it, whatever they are worth. It keeps the reserve and runs without the hunt;
    with the hunt on, the hunt can still add cheap tickets up to five.
  - **Ticket numbers** (settings, Auto tab; `lotteryNumbers` in `src/auto.js`) apply to
    every ticket the bot buys: random for every ticket (default), my numbers for each
    ticket (one line per ticket in buying order, six different numbers from 1 to 49;
    a blank or invalid line is bought on random numbers and the settings page names
    the bad lines), or random weighted toward the numbers drawn most or least often in
    the recent draws the lottery screen lists. Every ticket has the same odds, so this
    only chooses which numbers are held.
- **Auto mode switches** (panel, all on by default): Games (crash, lottery, standup,
  payroll and wins-bonus bets, achievement hunt and XP grinding), Work, Wheel (the free
  hourly spin; the daily bonus and bailout stay), Achievements (the hunt), Payroll fund
  (no fund reads or fund bets when off) and Sprint (when off, bankruptcy and the loan cycle
  no longer wait to protect a sprint podium). With Games and Work off the bot still
  claims, repays, buys and rotates accounts.
- **Payroll fund** (Mzdový fond, settings Auto tab, on by default; `watchPayroll`,
  `payrollWorth` and `edgePlan` in `src/auto.js`): since 2026-10-15, 0.5 % of every bet
  goes into a shared fund that grows up to its cap (12,000) and can drop on any bet, a
  bigger bet more likely. The client does not say how likely, so the bot measures it:
  every fund read is compared with the one before (shared by every account in
  `payrollWatch`), the growth is the credits staked over 0.5 %, and a new "last winner"
  is a drop. The chance one credit drops the fund is the drops seen over the credits
  staked; reads more than 10 minutes apart, or after the fund sat at its cap where the
  stakes do not show, count nothing. Until 5 drops are seen the bot bets nothing for
  the fund. After that each credit staked is worth that chance times the fund, whatever
  the bet size, and once that beats the edge of the lowest-edge game the bot bets
  there at the bet the XP grinder would play right now (the fund is worth more than the
  edge costs and the grinder takes that swing anyway); fund bets keep the grinder's
  floor, daily budget and upgrade savings, and stop when it may not bet. Without a
  grinder bet the size is half Kelly on the game's variance plus the fund's, which
  keeps those bets small. The log gets `payroll_drop` with the tally on every drop
  seen. The fund is read from every response that carries it and from the feed, every
  10 seconds once it pays and every minute otherwise. A fund win is booked as free
  income.
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
  - The same bets run any time a game's model pays over 100 % by itself (Forbes z
    Chánova once a level of each upgrade is bought), logged as `edge_plan` with the
    status "Paying game". Unlike the fund and the weekend bonus, that edge does not
    run out, so these bets never hold work back: tickets go first and the bets fill
    the time while energy refills.
  - Before Placené přesčasy and Hackathon, work waits while the energy refilling until
    Friday 17:00 still fits under the cap, so the event starts with a full bar. During
    Placené přesčasy work drains energy at once instead of keeping it for the grinder.
  - Hackathon makes grinding XP a third cheaper, so in its week the grinder holds until
    Friday 17:00 (`grindHold`). Under the daily limit, what each held day left of its
    budget is kept, and on the weekend those budgets plus one per weekend day are
    pooled against the weekend's loss (`grindBudget`). Under the balance or no limit
    the held credits simply wait for the weekend.
  - Teambuilding needs nothing: the wheel is spun anyway.
- **Settings for the rest** (settings, Auto tab): XP grinding game (cheapest
  per XP or a fixed game), bet (a fixed level, 20 by default); automatic shop purchases from
  a priority plan (`game:key` list, off by default) using the client's price and
  level formulas. A plan entry is skipped when it is not worth its price
  (`upgradeVerdict` in `src/auto.js`): it adds less than 0.5 % return per 10,000
  credits (blackjack hint, double and soft 17, Slotingi mint), the game is not
  the final one (the cheapest game to end on: the price of its upgrades left plus
  the loss at its edge with every upgrade bought, on the credits wagered for the
  XP to the next 10 levels, or before the XP rate is measured the game where the
  grinding volume left after that price buys the most wagering. Baccarat maxed
  has the lowest edge, 2.2 % against roulette's 2.7 %, but its upgrades cost
  109,000 against 52,500, which pays back only over about 11.5 million credits
  wagered; Roulette unless Blaze's
  star scatter counts symbols; until it unlocks the grinder plays the cheapest game
  without buying anything, since an upgrade of a game left behind at the next unlock
  stops paying; while the recorded Blaze spins have not settled the star rule and
  the two rules point at different final games and learning is on, nothing is bought, and with **Learn
  the Blaze star rule** (Auto tab, on by default) the grinder plays Blaze at the
  smallest bet, within its limits, until they do. A tie over 1,000 spins counts as
  settled on per reel: the model expects 1 deciding spin in 110, so none means stars
  do not stack on a reel and both rules pay the same; 2,000 recorded spins showed
  exactly that, so Roulette is the final game), or spending the price on plain grinding gives
  more XP than grinding the rest at the cheaper cost (volume: 14 days of the daily
  budget, or the credits above the minimum balance; judged for the next levels alone
  and for the game's useful upgrades maxed together). Once XP per credit is measured
  (pooled over every game with XP; Hackathon weekend rounds, +50 % XP, are left out once
  100,000 credits have been wagered off them, and until then the pooled rate is divided
  by 1.5, so levels never look cheaper than they are; XP is tracked without the
  výpověď bonus, +10 % per výpověď up to +50 % (`G.prestigeBonus`, `player.prestige`),
  and the account's current bonus is put back on every rate it plans or shows with,
  so rates measured before a výpověď hold after it; the bot never hands one in itself), the volume is the XP to the next 10 levels instead,
  from the level curve (`G.xpForLevel`: round(280 × level^1.35), reward 1,000 × (level
  − 1), fitted exactly to recorded levels 14 to 18): an upgrade is bought when the
  credits wagered for that XP times its drop in edge beat its price. A goal is bought
  only when the credits left after it still reach the next level: the reserve, the
  price and the expected loss on the XP left in the level plus two standard deviations
  of the swing at the grind bet (`levelUpCushion`; 0 before the XP rate is measured).
  Saving for the goal holds the same amount back from the grinder. `crash:sla` is never bought:
  Produkce padá's daily payout is too small to earn it back. `global:bets` (higher max bet) is not in the plan: XP per round
  is proportional to the bet, so a bigger bet never buys XP cheaper. The whole plan is judged again every 10 minutes and as soon as the level, the
  upgrades or the max bet change (`G.shopQueue` with `reviewShop` in `src/content.js`);
  the first entry worth buying at the current level is the goal, logged as
  `upgrade_goal`. With **Save for the next upgrade** (on by default) the grinder keeps
  the goal's price on top of the reserve, so work pay saves up to it instead of being
  ground away (not past a planned bankruptcy, which wipes the savings). Once bought, the
  next goal is bought on the next tick if it fits too. The panel's **Upgrade queue**
  shows the next upgrade (the goal, or with none the first spare one), its price, the
  balance it is bought at (the floor, the price and the leveling cushion) and how much is
  still missing, then why every other upgrade waits. With
  **Buy this game's upgrades first** (`firstGame`, Forbes z Chánova by default, or Blaze
  20 Wild, or none) the goal is the cheapest upgrade of that game the player level
  allows, whatever its verdict, and spare credits also go to it before any other game;
  the plan above takes over once it is maxed or waits for a level. Since Forbes has a
  model (2026-10-19) its upgrades are judged like any other, and as the final game the
  plan buys them anyway. The grinder saves only for a goal the plan itself would buy, so a first-game
  goal the plan skips is bought when the credits are there and grinding never waits for it. Skips
  are logged as `upgrades_skipped`; a Blaze model check (`src/blaze.js`) that records every Blaze spin
  with its board and the server win, reports which scatter rule reproduces the
  server and simulates the payout rate for current and maxed upgrades; and a debug
  capture of raw loan, crash, shop, leaderboard and bonus responses for export.
- **Profit tracking**: every game response (bot or manual play) is booked per game
  from the credit balance before and after, plus anything the debt collector took
  from the win. The panel shows rounds, net and return rate per game; the settings
  Profit tab shows wagered, returned, net, return rate, net per round and XP, plus credits
  earned per work ticket. Crash bets are booked when they settle, from the round's bet list.
  Every round of a game with an odds model is also booked under the upgrade levels it
  was played with (`stats.combos`, keyed by `BotterOdds.combo`), and the Profit tab's
  **Profit per upgrade level** table shows each combination's rounds, wagered, net,
  measured return and the return the model gives it (Blaze on the per reel rule), so an
  upgrade can be checked against what it promised.
  The **Roulette check** table below it splits roulette's measured return into its
  causes, per zeros level (`stats.roulette`, `G.addRouletteSpin`): zero pockets seen
  against the wheel's share, what the server paid against what the client's rules pay
  on that wheel (with how many standard deviations apart, so luck and a changed wheel
  can be told apart), the hidden cost (credits lost beyond the payout the response
  reports, as a share of the stakes; this is where a player-paid 0.5 % payroll fund
  would show) and payouts that break the rules for the pocket that came up.
  A profile reset (Začít úplně od nuly, `/api/profile/reset`) wipes the account on the
  server, so its stats start over too: profit, XP per game, free income and the
  achievement flags, so the clean-loan trick and the podium run again. Only the submit
  dwell times are kept.
- **Levels** (settings, Profit tab): the XP each level needs (`player.xpNeed`) and
  the credits paid on reaching it (`levelUp.reward`), recorded from every response of
  every account into one shared `levels` table (`G.recordLevel`), with the growth over
  the level below and the daily bonus at a 7-day streak (the client's formula,
  `G.dailyBonus`: each level adds 10 % of the base, 15 % from level 5). The server
  sends both numbers only for the current level, so the curve fills in as accounts
  level up. Level-ups are logged as `level_up`.
- **Odds per upgrade** (settings, Games tab): for every game and every combination of
  its shop upgrades the return to player, the share of rounds won (more back than the
  bet), the chance that 1,000 rounds end ahead and the return on a Konec kvartálu
  weekend, all from the simulation in `scripts/odds.mjs`. Roulette is an even-money bet, blackjack the bot's own strategy,
  Blaze is listed per scatter rule; once the recorded spins settle the rule, the other
  table is marked as ruled out. The current account's upgrades are marked.
- **Forbes z Chánova** (from level 13): a Megaways slot with cascades, the Hotfix
  wheel of modifiers and free spins on 4+ incidents. When free spins start, the bot
  plays them at once with Postupný rollout (`HOTFIX_CHOICE`). It is played by the
  grinder, by the game bot when picked there, and by the **Forbes z Chánova test**
  (panel, More), started by hand: 500 spins at the smallest bet in auto mode with games
  on, keeping the reserve (`hotfixTestStep`).
  The 2026-10-17 update retuned it: fewer rows (weights 25 / 30 / 20 / 13 / 8 / 4 for 2
  to 7), pays 0.97 x [25-50] up to [110-1400] % of the bet per way, the incident weight
  3.4, the Hotfix wheel 5 %, free spins Postupný rollout 10x1, Canary release 5x6, Big
  bang 4x8, Code review +3.5 / 7 / 10 / 13.5 %, and the client now carries the modifier
  sizes (wilds 2 to 4 cells, mystery 4 to 7). `scripts/hotfix-sim.mjs` simulates it
  from those tables, with the multiplier +1 per winning spin as the 2026-10-13 test
  showed, and `scripts/odds.mjs` puts every upgrade combination into the odds table
  (1.5 million spins each): about 94 % unupgraded, over 100 % from the first level of
  each upgrade (fix, review, oncall: 24,000 in all, level 13) and about 123 % maxed
  (202,100). That makes Forbes the grind game from level 13 and the final game, which
  holds only if the server matches the client's tables, so run the Forbes test after
  an update and check it (below). A round's return has a standard deviation of 10 to
  14 bets, so the measured profit swings far more than on any other game.
  Every spin and free-spin response, from the bot or played by hand, is
  recorded (`hotfixRounds`, up to 800, free-spin games kept first) and can be exported
  from the settings (Data tab) to settle those against the server.
  `node scripts/hotfix-check.mjs <export>... [--spins N]` does that (several exports
  count each round once): it recomputes every
  cascade step's wins from its grid, checks row heights and symbol weights on clean
  spins, measures how often the Hotfix wheel turns and what it picks, the modifier
  sizes and how the free-spin multiplier grows, then simulates the model at the
  client's and the measured wheel chance. The 2026-10-13 test (491 spins) matched all
  887 cascade steps exactly and showed the multiplier grows +1 per winning spin; the
  modifier sizes it measured (wilds 3 to 6 cells on reels 2-6, mystery 5 to 9 cells,
  sync copies wilds onto reel 6) were used until the client gave its own; it also
  measured the wheel at 9.4 % against the client's 7 % then (46 of 491, 2 deviations
  above), so the server may pay more than the model.
  **Forbes force** (panel, More, off by default) sends the server's test switch `force` on
  every Forbes spin the bot plays (the client has the field but never sets it). The
  value field is read as JSON (`4`, `true`, `"free"`), anything else is sent as text,
  and an empty field sends `true`. Forced spins are booked and recorded like any
  other, with the force in the recorded request, so drop them before checking the model.
- **Baccarat** (Bakarat, from level 20, `src/baccarat.js`): punto banco with the
  client's pays: Hráč 1:1 less the management cut, Bankéř 1:1 less the cut plus 5 %,
  remíza 8:1, each pair 10:1; on a tie the Hráč and Bankéř bets get half back. Two
  upgrades: Vyjednaná provize lowers the cut 8 → 6 → 4 → 2.5 % (12,000 / 24,000 /
  48,000 at levels 20 / 23 / 26) and Smírčí řízení returns the whole bet on a tie
  (25,000, level 20). The server deals, so the model assumes an infinite deck and
  the standard drawing rules, and solves that exactly: Bankéř wins 45.84 %, Hráč
  44.61 %, a tie 9.54 %. Return to player of the Bankéř bet, which beats Hráč by about
  0.1 % at every cut:

  | Cut | No tie refund | Full tie refund |
  | --- | --- | --- |
  | 8 % | 90.50 % | 95.27 % |
  | 6 % | 91.41 % | 96.19 % |
  | 4 % | 92.33 % | 97.10 % |
  | 2.5 % | 93.02 % | 97.79 % |

  The tie bet returns 85.9 % and a pair bet 84.6 % (11 / 13), so they are only
  played for their achievements. Smírčí řízení alone is the cheapest gain (+4.8 %
  for 25,000) but still leaves baccarat behind fully upgraded roulette. Every hand,
  from the bot or played by hand, is checked against the model per upgrade
  combination (`stats.baccarat`, the **Baccarat check** on the Profit tab): winners
  and pairs seen against the model, the server's return against the client's pays,
  the hidden cost, hands dealt against the drawing rules and payouts off the pays
  (which shows whether the cut is also taken from tie and pair wins). Baccarat has
  no screen play yet; with **Play on the game screen** on it still goes through the API.
- **Case opening** (from level 17, `src/cases.js`, since 2026-10-17): the bet buys a
  case and one item always drops, paying max(1, round(bet x its value)). The client
  draws a rarity (blue 79.92 %, purple 15.98 %, pink 3.2 %, red 0.64 %, gold 0.26 %)
  and then an item of it by weight: six blue items at 0.15x to 0.45x, four purple at
  1x to 1.6x, three pink at 3x to 5x, the MacBook (12x, weight 2) and the burning
  Fabia (20x), and three gold knives at 50x / 100x / 250x (weights 6 / 3 / 1). Lepší
  dodavatel (10,000 / 20,000 / 40,000 at levels 17 / 20 / 23) moves 2.02 % per level
  from blue to purple, Známá v kuchyňce (20,000 / 40,000 at 17 / 20) 0.02 % per level
  from blue to gold. That returns 86.9 % unupgraded and 96.2 % with both maxed, so it is
  never the grind game, but its red and gold drops make it the cheapest slot-like game
  for big win standup quests, and the hunt opens cases for its three achievements (★ Z
  kuchyňky 5,000, Ještě doutná 2,000, Nepíše 500 for three pens in a row). Every case is
  checked per upgrade combination (`stats.cases`): red and gold drops against the
  model and payouts off bet x value.
- **Kostky** (Dice, from level 25, `src/dice.js`, since 2026-10-17): sic bo with three
  dice. Malá / Velká / Lichá / Sudá pay 1:1 and lose to any triple, a sum 6:1 to 60:1,
  a number 1:1 per die, two numbers 5:1, a double 10:1, any triple 30:1, a given triple
  180:1. Management takes a commission from every win (Daňový poradce: 10 → 7 → 4 →
  1.5 %, 15,000 / 30,000 / 60,000 at levels 25 / 28 / 31), which the model takes from
  the net win as in baccarat, and Pojištění proti trojici (30,000, level 25) returns half
  of the even-money stakes on a triple. The model enumerates the 216 rolls exactly. The
  even-money spots win 105 rolls in 216 and beat every other spot at every upgrade, so
  the bot bets Malá: 92.4 % unupgraded, 96.5 % with the commission maxed and 97.9 %
  with the insurance too, the best maxed return in the casino after a modelled Forbes
  (baccarat 97.8 %, roulette 97.3 %), but its 135,000 of upgrades pay back only over
  millions of credits wagered. The hunt bets any triple (Tři stejní, 2,000), then a sum
  of 4 (Krajní případ, 2,000), then Malá for a triple to take it (Kasino bere vše,
  500). Every roll is checked per upgrade combination (`stats.dice`): triples against 1
  in 36, faces per die and payouts off the model's commission rule, logged as
  `dice_payout_mismatch` when a roll pays more than a credit off.
  Neither game has screen play; with **Play on the game screen** on they go through
  the API. Both checks are on the Profit tab (**Dice and Case opening check**).
- **XP per game** (panel): for each unlocked game and the next one to unlock, the house
  edge the grinder plans with, credits lost per XP point and its state (locked or
  playing at the chosen bet). The row the grinder plays next is highlighted.
- A small panel in the bottom-left corner of the page (300 px wide, no table wider
  than four columns) has the auto switch, the account, the status line, Start/Stop
  for work and for games with the ticket type and the game, and the auto mode parts
  as chips. Below them are collapsible sections, which stay open or closed across
  reloads (`panelOpen`): **Profit** (net and return per game, work, bonuses summed,
  a total; rounds in the row tooltip), **XP per game** (unlocked games and the next
  unlock only), **Upgrade queue** and **More** (play on the game
  screen, the Forbes z Chánova test, Forbes force, answer accuracy and AI cost).
  Longer explanations are tooltips. A bundle update shows as one small line at the
  bottom. **Hide** collapses it to a small Botter button in the same corner
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
  - **Crash and lottery visits** (settings, Auto tab, both on by default, need auto mode
    with Games on; `roundsDue` in `src/auto.js`): each saved login records the crash
    round it bet in (`crashRound`) and the lottery draw it finished buying for with the
    tickets it held (`lotteryDraw`, `lotteryBought`). The rounds themselves are shared
    under the `rounds` storage key. When an account bets on a running Produkce padá
    round because it pays, the round stays open to the others for 10 minutes (each bet
    there extends it), and every account from level 3 that has not entered it is
    visited first, before accounts not seen today. Each one checks the round again
    and closes it when entering no longer pays. Lottery visits go to every account
    from level 4 that has not finished buying for the next draw, while "Feeling lucky"
    or the hunt buys tickets, after accounts not seen today and before a ready wheel,
    and stop 2 minutes before the draw. An account the hunt bought nothing for last
    draw is skipped unless "Feeling lucky" is on. Both check the reserve against the
    smallest stake or price. An account that still owes a bet or tickets is not left
    for up to 5 minutes.
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

**Backup** (Data tab) exports everything to one file: settings, profit stats of
every account, the bank, the level curve, recorded Blaze spins and saved accounts.
API keys and login sessions are left out unless the switch to include them is on.
Importing applies the file's settings and merges the rest: stats are added up per
account, the other data only fills in what is missing. Each export has an id and
names the install it came from, so importing it twice, or back into the same
browser, never adds the stats again.

## Development

```
npm run check
```

**App bundle tracking**: the casino ships as one bundle (`/assets/index-<hash>.js`)
whose name changes with every deploy. When a page loads a name not seen before, the
content script fetches it once and checks it with `src/bundle.js`: every client table
the models copy (slot weights, paytables, upgrade effects, blackjack and roulette
rules, the payroll share, big-win multiples, max bet by level) must still be in it,
and the shop catalog, unlock levels, bet levels and roulette zeros are read out and
compared with `src/games.js` and `src/odds.js`. A game in the lobby or the shop
that the bot does not know is reported too, unless the lobby marks it as coming
(Kostky and Tajemný automat, 2026-10-14). The panel shows a red line naming
every difference until a bundle matches again, and a new bundle that matches for a
day; the log gets `bundle_models_stale`, `bundle_changed` or `bundle_seen`.
`node scripts/bundle.mjs [saved bundle]` runs the same check on the live site (or a
saved copy) and exits with 1 when a model is stale. When a table changes, update the
model, its needle in `src/bundle.js` and rerun the simulation below.

`node scripts/odds.mjs [spins] [--only game,game]` regenerates `src/odds-table.js`
(about 30 minutes at the default 300,000 spins per combination, 20 of them for
Forbes z Chánova's 80 combinations at five times the spins; `--only baccarat`
redoes just that game and keeps the rest). Besides the slot returns it records, for
every game and upgrade combination (roulette, blackjack and baccarat included), the share of
rounds that return more than the bet, the share of 10,000 sessions of 1,000 rounds,
drawn from those spins, that end ahead, the mean net profit per credit of the rounds
that end ahead (what the Konec kvartálu bonus pays on), the variance of one round's
return (for Kelly sizing) and the share of rounds paying 10x / 25x / 50x the bet (big win
standup quests). Rerun it when the casino changes a slot's
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
`button.right` / `button.wrong` and `section.work-result` after a submit, `.modal .sheet.levelup`,
`.modal .sheet.daily`. If the casino UI changes, start there.
