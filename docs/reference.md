# Botter reference

The full description of every feature, model and setting. The short version is the
[README](../README.md).

## How it works

- `server/src/runner.mjs` runs the bot for every saved account at once. Each account
  gets its own Node vm context with `src/page-hook.js` and the bot scripts in it, pinned
  to that account, with its own localStorage (session, pacing, learned speeds). The
  scripts see `storage` (get, set, remove and onChanged over the shared store in
  `/data/storage.json`), `i18n` (getMessage, locale) and `BotterHeadless` (the account,
  the casino bundle address, `play` for the dashboard's live play, `solve` for the AI
  solver, and `report` / `command` for the dashboard). The server has no dependencies.
- `src/page-hook.js` runs in the account's context before the other scripts and
  wraps `fetch`. It forwards every `/api/` response to `content.js`, tagged with the
  user id (`sub`) decoded from the token the request was sent with, so each response
  is booked to the right account, and it performs the bot's API calls with the
  account's session.
- `src/content.js` runs the loop: start a ticket through `/api/work/start`, choose an
  answer, send it to `/api/work/submit`, repeat. There are four ticket types: bug hunt
  (pick the buggy line), "Co to vypíše?" (pick the printed output), "Založ task" (read a
  help-desk message and pick type, priority and team; the answer is sent as one number,
  `type*100 + priority*10 + team`) and "Přepiš kód" (retype a line of code; the bot
  sends the line from the task as text once a quick typist would have finished it).
  **Alternate** cycles through all four, in auto mode too. "Přepiš kód" is never wrong,
  since its answer is in the task, while a wrong answer on the others spends the energy
  without pay; pick it in the Overview's Bot controls to work only those.
  When energy runs out it waits for the refill.
- **Max speed for work** (the same `maxSpeed` setting as games, since 2026-10-21;
  `workDwell` / `learnWork` in `src/content.js`, `workSpeedLearn` in `src/auto.js`):
  no human delays, reading time or typing pace. A "Přepiš kód" line is sent at once,
  since the server only sees the finished text. Each ticket is submitted once it has been open for the least time learned for
  its type, under `work:<type>` in the same `botter:speed` table as the game waits
  (starting at 0). A submit the server refuses raises that time to just past the one
  refused, by 150 ms, 300 ms, 600 ms and so on for each refusal of the same ticket, and
  is retried up to 6 times; 10 accepted in a row trim 50 ms. Refusals are logged as
  `work_speed_learned`. Off, the bot keeps the human delays and the remembered minimum
  (`stats.dwell`), which only grows.
- **Gap between work starts** (`learnStart` / `onStartRejected` in `src/content.js`):
  the server refuses a ticket picked too soon after the previous one started with
  429 "Zpomal trochu.". The least gap is learned under `work:start` in the same table,
  in both speed modes, with the same steps as the submit wait: a refused pick raises it
  just past the refused gap and is retried as soon as that has passed, 10 accepted in
  a row trim 50 ms. Refusals are logged as `work_start_learned`. Before this the bot
  started the next ticket at once and retried a refusal after a fixed 3 s, so about
  every other start failed.
- **Unloadable accounts**: an account whose profile (`/api/me`) fails three times in a
  row is set aside for 30 minutes (`brokenUntil` on its saved record, shown as set aside
  on the Accounts tab) and its bot waits; the other accounts carry on. A profile that
  loads clears it.
- The answer is chosen in this order:
  1. **Answer bank**: every submit response contains the correct answer
     (`result.answer`), so each ticket is learned the first time it is seen.
     Output puzzles are stored by option text,
     so a reshuffled copy of the same puzzle still matches. "Založ task" tickets are
     stored by sender and message.
  2. **AI solver** (Settings, AI solver; off by default, a stored `local` from the
     old on-device solver counts as off), in `server/src/solver.mjs`:
     - **Claude API**: calls the Messages API with structured output. Default model
       `claude-opus-5-5` at `medium` effort. Needs an API key.
     - **OpenRouter**: any model ID from openrouter.ai/models (default
       `google/gemini-2.5-flash`). Sends a `json_schema` response format; models
       that ignore it still work because the answer parser accepts a number in prose.

     The keys are kept on the server like saved logins: the dashboard only shows a
     placeholder and the key fields take a new key, never show the old one.
  3. **Guess** (optional): a random valid choice. A wrong answer costs energy
     but teaches the bank.
- **Game bot** (`src/games.js`, game loop in `src/content.js`): plays Blaze 20 Wild,
  Skeleton Slots, Slotingi, Forbes z Chánova, Roulette (one outside bet, red by default),
  Blackjack (follows the table's own hint) and Baccarat (Bankéř, see below) through the casino API. The page hook performs the
  calls with the account's supabase session from its localStorage, which the server
  refreshes, so the bot code never handles the token (saved sessions are described
  under Accounts). Guardrails: stop-loss and take-profit per
  session, a credit reserve, and the game's unlock level. With both bots on, work
  goes first and games fill the time while energy refills.
- **Minimum time between game requests** (Settings, Games, 1,500 ms by default,
  `gameDelayMs`): every game request (a round, a blackjack move, Forbes free spins, a
  lottery ticket) starts at least this long after the last one of that account. It is
  enforced in one place (`pace` in `src/content.js`) and the last start is kept in the
  account's own localStorage (`botter:nextGameAt`), so a restart never plays faster.
  The bot ticks every 700 ms, which is the floor below that.
  Since 2026-10-17 the server does not let any game play faster than its animations.
- **Max speed** (Settings, Games, on by default since 2026-10-20, `maxSpeed`):
  instead of that minimum, a game request waits only as long after the last game
  response as the server takes. The wait is learned per path of that response
  (`speedWait` / `speedLearn` in `src/auto.js`, `learnSpeed` in `src/content.js`):
  the app's animation of the response where it is known (`animationLockMs`: roulette,
  Forbes triggers and free spins), plus a learned extra that starts at 0 and may go
  negative down to no wait. A first attempt the server refuses ("počkej na animaci")
  raises the extra to 150 ms past the wait it refused, and every 10 accepted in a row
  trim 50 ms, so the bot settles just above the server's lock. Trimming back down to
  a wait that was refused waits for 20 accepted instead, then 40, 80 and so on up to
  640 with each refusal (since 2026-10-25; before, it walked into a refusal every
  ~30 rounds forever). Every trim at or below that wait keeps waiting for the probe, and
  the probe never resets: until 2026-10-25 the trim onto the refused wait dropped it, so
  each refusal started over at 20 and roulette hit the limit about every 2 minutes.
  Work submit waits and the start gap use the same rule. The casino's general limit
  ("Zpomal trochu.", a 429 whose hint is the real time left in ms) counts as a refusal
  too, and raises the wait by that hint plus 30 ms (`speedHint`); until 2026-10-28 only
  "počkej na animaci" counted, so mines kept trimming its wait and every start, reveal
  and cashout was refused twice. No refusal teaches more than 5 s of extra, nor more
  than 1 s from its hint, and rows past 5 s (the start gap too) are dropped when the
  account's context starts (`speedClean`, since 2026-11-06): a refusal 30 s after a roulette spin had
  taught a 25.8 s floor, and since trimming below a floor waits for up to 640 accepted
  per 50 ms, roulette ran at 29.5 s a spin and levelling all but stopped from 2026-11-03.
  A refused request is retried after its hint plus 30 ms
  when it has one, else after 150 ms, 300 ms, 600 ms and so on (6
  times) instead of the 30 s the server asks for, and only first attempts teach the
  wait, so one long animation does not slow every later round. A step that played
  runs again at once instead of on the next tick. The learned waits sit in each
  account's own localStorage (`botter:speed`), so every account learns its own, and refusals are logged
  as `speed_learned`. Off, the minimum above applies and known animations are held
  1 s longer.
- **Rate limits** (`api` in `src/content.js`, `rateLimitWait` in `src/auto.js`): a bot
  request the server turns away for going too fast (a 429, a `Retry-After` header, or
  an error text about speed) waits what the server asks (`Retry-After`, the body's
  `retryAfterMs` / `retryAfter`, else 1 s, 2 s, 4 s, at most 30 s; the casino puts
  milliseconds in the seconds fields, so a number above 30 is read as ms, since
  2026-10-25 when "Zpomal trochu." with 233 cost every work start 30 s) and is sent again,
  up to 3 times, logged as `rate_limit_retry` and finally `rate_limited`. A game
  request's wait also holds that account's next game request. Before this, such a
  rejection counted as a failed round and paused that step for 10 minutes. The log
  line carries the server's own hint (`hint`: `Retry-After` or the body's field).
- **Animation lock** (`animationLockMs` in `src/games.js`, applied in `onResponse`
  in `src/content.js`): after every roulette spin (the wheel turns 4.2 s, since
  2026-10-20) and on Forbes z Chánova after a spin that triggers free spins and again
  after the free spins, the server turns every game request away until the app would have
  animated them ("počkej na animaci", a 429 whose wait is always 30 s, so it says
  nothing about the real lock). Any such response holds the
  account's next game request for the app's animation time plus 1 s, from the
  app's own timings: about 10 s before the free-spin pick, when the app shows it to
  a player. After free spins the hold stops at 32 s (`ANIM_LOCK_MAX_MS`), because
  the server has always let the next spin through by then while the app's
  animation of a long free-spin game runs past a minute.
- **Speed and server responses** (Statistics, Server speed): game requests in the last
  minute and the average gap between the last 20 against the minimum set, all API
  responses in the last minute, then per path the responses
  seen, the bot's own calls, errors, rate limits / retries and the bot's average
  response time, and the last 20 errors. The bot keeps the figures in
  `net`, saves them every 5 seconds while they change, and **Reset** starts over.
- **Fewer reads**: Produkce padá is read once a minute only while a round runs and the
  bot has no bet in it; with a bet every 10 minutes, and after the round has crashed
  not again until the next 9:00 deploy. The profile (`/api/me`) is read only when
  no response has given the player yet.
- **Auto mode** (`src/auto.js`, one switch per account in the account strip and the
  Overview's Bot controls) runs everything in order of
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
  (`src/odds.js`), not the noisy measured one: blackjack, roulette, baccarat, Kostky, Case opening and Hledání bugů exactly, the slots from a table of every upgrade combination
  generated by `scripts/odds.mjs`. Return to player, unupgraded to fully upgraded:
  Forbes z Chánova about 73 % to 91 % (modelled, see below), Kostky 92.4 % to 97.9 %,
  roulette 92.3 % to 97.3 %, baccarat 90.5 % to 97.8 %, blackjack 87.6 % to 97.1 %,
  Case opening 86.9 % to 96.2 %, Kniha mrtvého kódu about 80 % to 95 %, Hledání bugů 81.8 % to
  94.8 %, Slotingi about 74 % to 93 %,
  Skeleton Slots about 71 % to 94 %, Blaze about 63 % to 94 % (or 68 % to 107 % if the
  star scatter counts symbols; the Blaze model check decides once 50 spins are
  recorded, until then the lower rule is used). A game without a model is
  never picked. XP per round grows with the bet the same way in every game, so the
  grinder plays the unlocked game with the lowest simulated edge. Since 2026-10-15 a
  round pays XP at its real value, sometimes 0 (the 1 XP floor of 2026-10-09 is gone),
  so every bet costs the same per XP and the bet only sets the pace; the
  bet is the one picked in the settings, or **Auto** (the default since 2026-10-20,
  `grindBet` 0): each game may bet at most the credits above the reserve, less what a
  loan still owes, over 185 standard deviations of one round (`A.autoBetCap`), so
  Forbes z Chánova (sd about 6.5 bets) keeps about 1,200 bets behind it and roulette
  185. **Auto bet size risk** (`autoBetBump`, Settings, Auto mode, since 2026-11-06 default one
  level higher): the auto size is moved that many bet levels up (`A.bumpLevel`), never
  past what the limits allow, so roulette on 139,000 credits bets 1,000 instead of 400.
  A game that swings too hard for the credits
  gives way to the next cheapest (`A.autoGrindPlan`), and with nothing that fits the
  grinder waits. Account books show each game's XP per credit and loss per XP
  measured from its tracked rounds, for information only. Near a limit the grinder
  steps down to a smaller bet; under a daily budget it never bets more than what is
  left of it. With **Grind only while the level pays** (`grindPays`, Settings, Auto mode, on by
  default) the grinder holds while the XP left in the level is expected to lose more
  than the next level-up reward (`levelCost` in `src/auto.js`): the XP over the plain
  XP rate (the Hackathon +50 % counted while it is on) times the game's edge. The
  edge is the model's, or the loss measured at the game's current upgrades
  (`stats.combos`) once that is worse than the model by more than two standard
  errors, then its lower bound (`pricedEdge`). The XP curve grows as level^1.35 and
  the reward only linearly, so at about 1 credit per XP leveling stops paying near
  level 38. A held account logs `grind_level_unpaid`, says so in the status and works its
  energy without waiting for the grinder until it levels up some other way (work XP). A planned bankruptcy wipes the credits anyway, so the
  grinder does not hold then. Before the XP rate is measured it grinds to measure it.
- **Daily standup** (Dnešní standup, Settings, Auto mode, on by default): three quests a
  day in `player.quests`, such as spinning a game 25 times, wagering 2,500 credits or
  finishing 10 rounds ahead. The server tracks the progress and pays each reward (about
  480) as soon as a quest is done, plus a bonus for all three and the Standup achievement
  (500 / 2,000 / 5,000 for 1 / 7 / 30 full days). Auto mode reads the game and the kind
  from the quest text and plays it before work when its expected loss is below its
  reward (`standupPlan` in `src/auto.js`): game rounds at the smallest bet, a wager on
  the lowest-edge game at the biggest bet that does not overshoot, rounds ahead on the
  game where the simulated share of rounds that end ahead (see Statistics, Odds)
  makes them cheapest, and a big / mega / super win (a round paying 10x / 25x / 50x the
  bet, as in the client's big_fish achievement) at the smallest bet on the slot where the
  simulated chance of one makes it cheapest; roulette and blackjack never pay one. The
  bonus and the achievement are not counted, so the estimate is
  conservative. It keeps the reserve but not the grinding budget: quest and achievement
  rewards are booked as free income, kept out of game and work profit, and the standup
  reward offsets the day's grinding loss. Quests it cannot read, crash quests and ones
  on a locked game are skipped and logged as `standup_skipped`.
- **Achievement hunt** (Settings, Auto mode, on by default; `huntPlan` in `src/auto.js`):
  goes after the credit achievements the bot can steer, read from `player.achievements`,
  and only while the reward beats the expected loss. Each round is valued at the
  rewards it can unlock times their chance and played at the smallest bet on the game
  where that margin is biggest: a straight bet on 0 in roulette (Nula od nuly, 1,000,
  1 in 39 unupgraded), a baccarat tie bet (Kompromis, 1,000, 9.5 %) and then a player
  pair bet (Pair programming, 1,000, 1 in 13), a Kostky bet on any triple (2,000, 1 in
  36), then on a sum of 4 (2,000, 1 in 72), then on Malá for a triple to take it (500),
  cases for a gold knife (5,000, 0.26 %), the burning Fabia (2,000, 0.21 %) and three
  pens in a row (500), Kniha mrtvého kódu spins for free spins (Dokumentace existuje, 2,000,
  1 in 300) and five books (Kompletní dokumentace, 4,000), Hledání bugů rounds shaped for a
  cleared board (Zero bugs, 5,000, 1 in 25), a 50x win (Velká ryba, all three tiers 500 /
  2,000 / 5,000 at once, about 1 in 65) and a 100x cash-out (Code review bez připomínek,
  5,000, about 1 in 115 to 170), any round on the Halloween weekend (Koledník, 1,000), blackjack hands for a natural (300, 4.8 %) and a five-card win
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
  achievements (wild, star, cascade and jackpot events) are left to the grinder: their
  chances are not modelled yet. Left out on purpose: Bug hned v prvním commitu and Dress
  code pay nothing.
- **Šatna** (wardrobe, since 2026-10-24, `/api/cosmetics/buy` and `/api/cosmetics/equip`,
  `wardrobeStep`, Settings, Šatna): looks only, no effect on any game, catalog copied in
  `G.COSMETICS`. Each kind (frame, name colour, title) wears the item picked for it, by
  default the dearest one owned (`BotterAuto.wardrobePlan`). With **Buy every wardrobe item**
  on (default) the cheapest item not owned is bought, an item picked to wear first, but
  only from credits left after the next upgrade buy (`wardrobeNeed`), never with a loan
  open, and seasonal items only on their weekend. Bought items survive a výpověď.
- **Wheel of fortune** (Kolo štěstí, `/api/wheel/spin`): free once an hour, paid in
  multiples of the player's work pay (100 for Stážista up to 500 for Architekt) or a
  coffee that refills energy. It is spun 5 seconds after `player.wheelNextAt` has passed (a refused spin is retried after a minute), with the other free
  claims (also outside auto mode), and booked as free income. Every account spins its own.
- **Výpověď** (prestige, `/api/profile/prestige`, `prestigeStep`, Settings, Auto mode
  **Hand in a výpověď at level 40**, on by default): handed in as soon as the account
  reaches level 40, before anything else in the auto step, while it has fewer than five
  (the XP bonus stops at +50 %) and no loan open (`G.prestigeReady`). It wipes level,
  credits and every upgrade for +10 % XP for good; the casino tops the credits up to
  the start amount. A refused one is retried after 10 minutes.
  - Once the credits cover the expected loss of grinding to level 40 at the grinder's
    measured credits per XP, less the level rewards paid on the way (`G.prestigeNear`;
    the level 40 reward is wiped with the rest), anything kept is wiped for nothing.
    From there, like a planned bankruptcy, the grinder bets down to the last credit
    (no reserve, daily budget or minimum balance), **Grind only while the level pays**
    and the XP weekend hold are ignored, and no upgrade is bought or saved for and
    no level or cycle loan taken, as a loan open at 40 would hold the výpověď back.
  - With all five handed in (`G.prestigeMaxed`, since 2026-11-09) nothing wipes the
    upgrades again and leveling keeps paying to about level 160 on roulette, so
    upgrades pay back over 30 levels instead of 10 (`A.upgradeHorizon`) and only that
    payback judges them (the per-credit `tooSmall` gate is off). On a level 40
    account with maxed roulette that makes Kostky the final game: maxing it costs
    about 120,000 and drops the edge from 2.7 % to 2.1 %, about 120,000 less loss
    over the 30 levels. Baccarat (2.2 %) comes second; every slot stays above
    roulette even maxed, so they are not bought. The dashboard hides the To výpověď
    bar then.
  - The grinder prices each game at the model's edge, or the loss measured at its
    current upgrades once that is worse by more than two standard errors
    (`A.pricedEdge` in `grindModel`). Grinding the newly upgraded game is the test:
    if the server pays it clearly less than the model, the grinder goes back to
    roulette on its own. A level loan is not taken while an upgrade fits
    (`shopOffer`), so the shop gets its turn between two loans.
- **Personal bankruptcy** (Insolvence, `/api/loan/bankrupt`, Settings, Auto mode, on by
  default): offered only in execution. The debt is wiped and credits are set to 500,
  but the XP into the current level is lost, as are this week's sprint points, and
  the shark lends nothing for a week (the clean-loan trick waits). Paying costs the
  whole debt, so bankruptcy is planned when the debt is bigger than the credits above
  500 plus the lost XP at the grinder's measured credits per XP (`bankruptWorth` in
  `src/auto.js`; before any XP price is measured, only with no XP at stake).
  - Once it is planned, credits are worth nothing past the reset, so the bot stops
    repaying and the grinder bets down to the last credit, ignoring the daily budget
    and minimum balance. It declares when nothing is left to bet. The shop sells
    nothing while a debt is open ("S dluhem u lichváře obchod neprodává", seen
    2026-10-20), so the bot tries no purchase until the debt is repaid or wiped.
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
  - **Level loan** (on by default, `levelLoan` in `src/auto.js`): the shark charges
    nothing in the first hour, then 8 % of the principal for every full hour since
    `loan.takenAt`, compounded (the client's own formula). A partial repayment does
    not lower it, only a full one closes the loan. With no loan, no block and the
    clean-loan trick done, while the grinder is what runs next (no work available, no
    upgrade being saved for, Blaze not being learned), the bot takes the biggest loan
    when the next level-up reward (1,000 per level) beats the expected loss on the XP
    left in the level plus one hour of interest, and the loan lets the grinder bet
    more. Its credits count as the grinder's bankroll. Once the loan is 10 minutes old
    it is repaid in full on the first step the credits above the reserve cover it
    (never in part, which would only cut the bankroll; a refused repayment waits a
    minute), then taken again if it still pays, so each loan starts a new free hour.
    While it waits, `level_loan_wait` logs the debt, the credits and the minutes to
    the next interest tick once a minute. While the loan is open the grinder keeps
    playing down to the last credit: the reserve, the daily budget and the
    level-pays hold do not stop it. A grind that falls behind keeps the loan until a
    level-up or work pay covers it, and only then pays interest. If the credits run
    out, the debt grows to its cap, execution starts and bankruptcy wipes it. Taken before the loan cycle, whose loan is never
    repaid. The shop sells nothing while it is open, so no upgrade is saved for then.
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
  - "Feeling lucky" (Settings, Auto mode, off by default; `luckyPlan`) buys a set number
    of tickets (1 to 5) every draw at a chosen price, or the biggest affordable one
    below it, whatever they are worth. It keeps the reserve and runs without the hunt;
    with the hunt on, the hunt can still add cheap tickets up to five.
  - **Ticket numbers** (Settings, Auto mode; `lotteryNumbers` in `src/auto.js`) apply to
    every ticket the bot buys: random for every ticket (default), my numbers for each
    ticket (one line per ticket in buying order, six different numbers from 1 to 49;
    a blank or invalid line is bought on random numbers and Settings names the bad
    lines), or random weighted toward the numbers drawn most or least often in
    the recent draws the lottery screen lists. Every ticket has the same odds, so this
    only chooses which numbers are held.
- **Auto mode parts** (Settings, Auto mode, all on by default, shared by every account):
  under What Auto does, Work (`autoWork`), Games (`autoGames`: crash, lottery, standup,
  wins-bonus bets, achievement hunt and XP grinding) and Wheel (`autoWheel`, the free
  hourly spin; the daily bonus and bailout stay); the hunt (`achievementHunt`) under
  quests; and the sprint hold (`sprintProtect`, under loans: when off, bankruptcy and the
  loan cycle no longer wait to protect a sprint podium). With Games and Work off the bot
  still claims, repays and buys.
- **Payroll fund** (Mzdový fond, since 2026-10-15): 0.5 % of every bet goes into a
  shared fund that can drop on any bet. Every bet the bot places takes part anyway, so
  there is no separate fund mode (removed 2026-10-19); a fund win is booked as free
  income. The casino pays the 0.5 % on top (the roulette check shows no hidden cost),
  every credit of the fund drops to someone and a bigger bet has a bigger chance, so a
  staked credit wins at least 0.5 % back on average (`G.PAYROLL_RETURN`; the seed adds
  more and is not counted). The XP price (`xpPrice`: bankruptcy, level loans, the
  výpověď plan) and the level check of **Grind only while the level pays**
  (`levelValue`, after the measured-loss check, which leaves fund wins out) take it off
  the game's edge: maxed roulette 2.7 % becomes 2.2 %. By 2026-10-26 the fund had paid
  0.65 % and 1.2 % of everything the two accounts ever wagered, pre-fund rounds included.
- **Weekend events** (`weekendEvent` in `src/auto.js`, same rotation as the client):
  Friday 17:00 to Monday 9:00, Prague time, one per weekend from the week of
  2026-10-05: Hackathon (+50 % XP), Konec kvartálu (+50 % on the net profit of every
  round that ends ahead, up to a weekend limit the client does not show), Teambuilding
  (the wheel pays double) and Placené přesčasy (work pays double credits and XP). A
  weekend whose Friday falls from 28 October to 3 November is Halloween instead (first on
  30 October 2026): +30 % XP from everything, the wheel's empty Porada pays 1x, and
  Koledník (1,000) for playing, which the hunt takes with one smallest bet. For XP it
  counts like a Hackathon (`EVENT_XP`, `xpEvent`, `eventXp`): work saves energy for it,
  the grinder holds in its week and pools the held budgets into the weekend.
  - Konec kvartálu turns the games positive: an even-money roulette bet returns
    about +21.6 % a credit unupgraded. With **Bet when a round pays by itself** on, the bot bets on the
    game where `rtp + 0.5 * gain` is best (gain is the simulated mean net profit per
    credit of the rounds that end ahead), half Kelly on its simulated variance, until a
    winning round comes back without the bonus, which means the limit is reached. The
    bonus is booked as free income so it does not inflate the game's measured return.
    The client says the bonus is for slot wins ("v automatech"), so Hledání bugů gets no
    gain and its wins never mark the limit; a mines round paid a bonus is logged as
    `mines_wins_bonus`. If one shows up, its long shots would return about
    `1.5 * rtp - 1` a credit (+23 % unupgraded) and are worth modelling.
  - The same bets run any time a game's model pays over 100 % by itself (none does
    since Forbes z Chánova's model was corrected on 2026-10-20), logged as `edge_plan` with the
    status "Paying game". Unlike the fund and the weekend bonus, that edge does not
    run out, so these bets never hold work back: tickets go first and the bets fill
    the time while energy refills.
  - Half Kelly on Forbes (+0.7 %, a swing of 10 to 14 bets a round) allows only the
    smallest bet below a few million credits, which levels five times slower than a
    grind bet of 100. So on the game the grinder would play, these bets go up to the
    XP grinding bet whenever the grinder's limits allow it (`floors` in `edgePlan`,
    since 2026-10-19); held for a Hackathon or out of budget, they fall back to Kelly.
    With the Auto bet size they also stay under its cap, the smallest bet included
    (`caps` in `edgePlan`), so a paying game is not played on credits that cannot
    ride out its swings.
  - Before Placené přesčasy, Hackathon and Halloween, work waits while the energy refilling until
    Friday 17:00 still fits under the cap, so the event starts with a full bar. During
    Placené přesčasy work drains energy at once instead of keeping it for the grinder.
  - Hackathon makes grinding XP a third cheaper (Halloween about a quarter), so in its week the grinder holds until
    Friday 17:00 (`grindHold`). Under the daily limit, what each held day left of its
    budget is kept, and on the weekend those budgets plus one per weekend day are
    pooled against the weekend's loss (`grindBudget`). Under the balance or no limit
    the held credits simply wait for the weekend.
    **Hold XP grinding before XP weekends** (`grindEventHold`, Settings, Auto mode, on by default)
    switches this hold off, for when levels are worth more than the credits saved,
    such as racing to a výpověď.
  - Teambuilding needs nothing: the wheel is spun anyway.
- **Settings for the rest**: XP grinding game (cheapest per XP or a fixed game) and
  bet (a fixed level, 20 by default) in Settings, Auto mode; automatic shop purchases
  (Settings, Upgrades) from
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
  the Blaze star rule** (Settings, Auto mode, on by default) the grinder plays Blaze at the
  smallest bet, within its limits, until they do. A tie over 1,000 spins counts as
  settled on per reel: the model expects 1 deciding spin in 110, so none means stars
  do not stack on a reel and both rules pay the same; 2,000 recorded spins showed
  exactly that, so Roulette is the final game), or spending the price on plain grinding gives
  more XP than grinding the rest at the cheaper cost (volume: 14 days of the daily
  budget, or the credits above the minimum balance; judged for the next levels alone
  and for the game's useful upgrades maxed together). Once XP per credit is measured
  (pooled over every game with XP; Hackathon and Halloween weekend rounds are left out once
  100,000 credits have been wagered off them, and until then the pooled rate is divided
  by 1.5, so levels never look cheaper than they are; XP is tracked without the
  výpověď bonus, +10 % per výpověď up to +50 % (`G.prestigeBonus`, `player.prestige`),
  and the account's current bonus is put back on every rate it plans or shows with,
  so rates measured before a výpověď hold after it; the bot hands one in at level 40, see Výpověď), the volume is the XP to the next 10 levels instead,
  from the level curve (`G.xpForLevel`: round(280 × level^1.35), reward 1,000 × (level
  − 1), fitted exactly to recorded levels 14 to 18): an upgrade is bought when the
  credits wagered for that XP times its drop in edge beat its price. A goal is bought
  only when the credits left after it still reach the next level: the reserve, the
  price and the expected loss on the XP left in the level plus two standard deviations
  of the swing at the grind bet (`levelUpCushion`; 0 before the XP rate is measured).
  An upgrade of the game the grinder plays needs no cushion: it makes every later
  round cheaper, and the credits held back would not be ground meanwhile either. On
  Forbes z Chánova, whose rounds swing about 10 bets, the cushion runs to hundreds of
  thousands and would stop both buying and grinding until work paid it.
  Saving for the goal holds the same amount back from the grinder. `crash:sla` is never a goal:
  Produkce padá's daily payout is too small to earn it back. `global:bets` (higher max bet) is not in the plan: XP per round
  is proportional to the bet, so a bigger bet never buys XP cheaper. Every upgrade the plan leaves out
  (`G.UPGRADE_EXTRAS`: those two, `blackjack:hint/double/soft17`, `slotingi:mint`) is queued after it as
  `unplanned` and bought only as a spare upgrade (since 2026-11-12), so an account that earns ends up
  owning every upgrade instead of an empty queue. The whole plan is judged again every 10 minutes and as soon as the level, the
  upgrades or the max bet change (`G.shopQueue` with `reviewShop` in `src/content.js`);
  the first entry worth buying at the current level is the goal, logged as
  `upgrade_goal`. With **Save for the next upgrade** (on by default) the grinder keeps
  the goal's price on top of the reserve, so work pay saves up to it instead of being
  ground away (not past a planned bankruptcy, which wipes the savings). Once bought, the
  next goal is bought on the next tick if it fits too. The **Upgrade queue** in Account books
  shows the next upgrade (the goal, or with none the first spare one), its price, the
  balance it is bought at (the floor, the price and the leveling cushion) and how much is
  still missing, then why every other upgrade waits. With
  **Buy this game's upgrades first** (`firstGame`, none by default since 2026-10-20,
  Forbes z Chánova or Blaze 20 Wild) the goal is the cheapest upgrade of that game the player level
  allows, whatever its verdict, and spare credits also go to it before any other game;
  the plan above takes over once it is maxed or waits for a level. Since Forbes has a
  model (2026-10-19) its upgrades are judged like any other. The grinder saves only for a goal the plan itself would buy, so a first-game
  goal the plan skips is bought when the credits are there and grinding never waits for it. Skips
  are logged as `upgrades_skipped`; a Blaze model check (`src/blaze.js`) that records every Blaze spin
  with its board and the server win, reports which scatter rule reproduces the
  server and simulates the payout rate for current and maxed upgrades; and a debug
  capture of raw loan, crash, shop, leaderboard and bonus responses for export.
- **Profit tracking**: every game response is booked per game
  from the credit balance before and after, plus anything the debt collector took
  from the win. Account books show rounds, net and return rate per game, counted from the
  account's last výpověď and each game from its last upgrade (bought by the bot or by
  hand; the bet limits do not count), so a row shows the return of what is played now
  (`stats.profitBase`, `G.profitBase`, since 2026-10-20; the first base started each
  game at its current upgrade level). Statistics,
  Profit keeps every round, per account or summed over all of them: wagered, returned, net, return rate, net per round and XP, plus credits
  earned per work ticket. Crash bets are booked when they settle, from the round's bet list.
  Every round of a game with an odds model is also booked under the upgrade levels it
  was played with (`stats.combos`, keyed by `BotterOdds.combo`), and the
  **Profit per upgrade level** table under it shows each combination's rounds, wagered, net,
  measured return and the return the model gives it (Blaze on the per reel rule), so an
  upgrade can be checked against what it promised.
  The **Roulette check** (Statistics, Model checks) splits roulette's measured return into its
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
- **Levels** (Statistics, Levels): the XP each level needs (`player.xpNeed`) and
  the credits paid on reaching it (`levelUp.reward`), recorded from every response of
  every account into one shared `levels` table (`G.recordLevel`), with the growth over
  the level below and the daily bonus at a 7-day streak (the client's formula,
  `G.dailyBonus`: each level adds 10 % of the base, 15 % from level 5). The server
  sends both numbers only for the current level, so the curve fills in as accounts
  level up. Level-ups are logged as `level_up`.
- **Odds per upgrade** (Statistics, Odds): for every game and every combination of
  its shop upgrades the return to player, the share of rounds won (more back than the
  bet), the chance that 1,000 rounds end ahead and the return on a Konec kvartálu
  weekend, all from the simulation in `scripts/odds.mjs`. Roulette is an even-money bet, blackjack the bot's own strategy,
  Blaze is listed per scatter rule; once the recorded spins settle the rule, the other
  table is marked as ruled out. The upgrades of the account seen last are marked.
- **Forbes z Chánova** (from level 13): a Megaways slot with cascades, the Hotfix
  wheel of modifiers and free spins on 4+ incidents. When free spins start, the bot
  plays them at once with Postupný rollout (`HOTFIX_CHOICE`), and free spins left
  pending (a pick nobody made, by the bot or by hand) are played as soon as the bot
  sees them, whatever else it plans (`hotfixFreeStep`): they cost nothing and block
  every Forbes spin until they are played. It is played by the
  grinder, by the game bot when picked there, and by the **Forbes z Chánova test**
  (the start button in Account books, per account), started by hand: 500 spins at the smallest bet in auto mode with games
  on, keeping the reserve (`hotfixTestStep`).
  The 2026-10-17 update retuned it: fewer rows (weights 25 / 30 / 20 / 13 / 8 / 4 for 2
  to 7), pays 0.97 x [25-50] up to [110-1400] % of the bet per way, the incident weight
  3.4, the Hotfix wheel 5 %, free spins Postupný rollout 10x1, Canary release 5x6, Big
  bang 4x8, Code review +3.5 / 7 / 10 / 13.5 %, and the client now carries the modifier
  sizes (wilds 2 to 4 cells, mystery 4 to 7). `scripts/hotfix-sim.mjs` simulates it
  from those tables, with the multiplier +1 per winning spin as the 2026-10-13 test
  showed, and `scripts/odds.mjs` puts every upgrade combination into the odds table
  (1.5 million spins each). Until 2026-10-20 the model let any cell be a scatter, which
  gave about 94 % unupgraded and 123 % maxed and made Forbes the grind game from level
  13. The server never puts two scatters on one reel: not one of 6,483 recorded grids
  (spins, cascade steps and free spins) had two, and with that rule the model matches
  the scatters per spin seen in 2,110 spins (0 to 3: 1,079 / 759 / 230 / 42 seen,
  1,075 / 759 / 230 / 39 modelled, against 1,075 / 723 / 242 / 55 and 12 spins with 4+
  before, where none were seen). Free spins then start every 314 spins instead of 150
  (Pohotovost 2, Rychlé hotfixy 1, Code review 2), and the return falls to about 73 %
  unupgraded, 80.5 % there and 91 % maxed, below roulette at every level. The measured
  returns agree: 77.1 % over 5,209 spins at that level, 83.9 % over 4,834 at level 1 of
  each (model 79 %). `scripts/hotfix-check.mjs` counts grids with two scatters on a reel, so a
  server change shows. A round's return has a standard deviation of 6 to 8 bets, so the
  measured profit still swings more than on any other game.
  The 2026-10-19 check (655 spins after the retune, Pohotovost / Rychlé hotfixy / Code
  review 1, `--since 2026-10-17`) matched every one of 997 cascade steps, the row
  heights and the symbol weights, the wheel turned 6.4 % against 5.4 % (1.1
  deviations), and the modifier sizes stayed inside the client's ranges. The
  measured return, 74.3 %, is 0.6 deviations below the model's 100.7 %: luck at that
  sample size, not a mismatch.
  Every spin and free-spin response is
  recorded (`hotfixRounds`, up to 800, free-spin games kept first) and can be exported
  from Settings, Data and backup to settle those against the server.
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
  **Forbes force** (Settings, Games, off by default, `hotfixForce` and `hotfixForceValue`) sends the server's test switch `force` on
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
  for 25,000) but still leaves baccarat behind fully upgraded roulette. Every hand
  is checked against the model per upgrade
  combination (`stats.baccarat`, the **Baccarat check** in Statistics, Model checks): winners
  and pairs seen against the model, the server's return against the client's pays,
  the hidden cost, hands dealt against the drawing rules and payouts off the pays
  (which shows whether the cut is also taken from tie and pair wins).
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
  Both checks are in Statistics, Model checks (**Dice and Case opening check**).
- **Kniha mrtvého kódu** (from level 30, `src/egypt.js`, since 2026-10-21): a Book of
  Ra style slot, 5 reels of 3 and 10 lines left to right. Every cell is drawn on its
  own by weight (scarab and cobra 24, urn 23, cat and eye 19, anubis and horus 6, mummy
  4, pharaoh 3, book 2.7). The book is wild and pays anywhere (3 / 4 / 5 books: 2x /
  20x / 200x the bet); 3 or more start 10 free spins with a special symbol whose weight
  goes up by 9 and that expands over every reel holding it once it is on 2 reels (high
  symbols) or 3 (low), paying on all 10 lines. The pharaoh on all five reels is the
  1,000x jackpot. Archeolog (15,000 / 30,000 / 60,000) adds 0.04 per level to the book,
  Úklid legacy (12,000, x1.8, 4 levels) takes 0.4 per level from the scarab and the
  cobra, Posunutá deadline (25,000 / 50,000) adds a free spin per level. Counting books
  anywhere gives free spins 1 in 300 spins and 1 in 249 with every upgrade, which is
  exactly what the client's stats tooltip says, so that rule and the upgrade effects
  are confirmed. Still open: the special symbol is assumed to be drawn evenly from the
  nine paying symbols, and the boost to be added to its weight. The simulation gives
  about 80 % unupgraded and 95 % with everything (about 320,000 credits of upgrades), so
  it is never the grind game; the hunt spins it for its free-spin and five-book
  achievements, which beat the loss of a minimum bet.
- **Hledání bugů** (from level 9, `src/mines.js`, since 2026-10-24): minesweeper on 25
  cells through `/api/mines/start` (bet and 1, 3, 5, 10, 15, 20 or 24 bugs),
  `/api/mines/reveal` (a cell, 0 to 24) and `/api/mines/cashout`. After n clean cells the
  multiplier is the return over the chance of surviving them, floored to 0.01 and capped
  at 1,000x, and the payout is floored to whole credits, so every shape returns the same
  share of the bet less the flooring: 82 %, plus 2 points per Unit testy level (6,000,
  x1.8, 4 levels) and 5/3 per Gumová kachnička level (9,000 / 18,000 / 36,000), 95 %
  maxed. The bot picks the shape: the grinder takes the best return with the fewest
  reveals (within 0.2 points), a quest or achievement the shape that reaches its
  multiplier with the least loss per hit (10x for a big win quest, 1 bug and 23 cells,
  8 %; 24 bugs and the one clean cell clears the board 1 in 25). Cells are picked at
  random and a round left open is cashed out, or played one cell on, before anything
  else. Rounds go through the API only, 390 ms apart like the app. It is the cheapest
  game at level 9 only (18 % edge against Slotingi's 27 %); blackjack at 10 beats it
  even with its affordable upgrades, and maxed it stays under roulette and Kostky, so
  the plan never buys its upgrades. Its value is the hunt: 17,500 credits of
  achievements for under 1,000 credits of expected loss at the smallest bet.
- **XP per game** (Account books): for each unlocked game and the next one to unlock, the house
  edge the grinder plans with, credits lost per XP point and its state (locked or
  playing at the chosen bet). The row the grinder plays next is highlighted.
- **Dashboard controls**: Auto, Work, Games, the ticket type and the game are kept per
  account under `run:<user id>` (`RUN_KEYS` in `src/content.js`); every other setting is
  shared under `settings`. An account with no run state yet starts from the shared
  values. The Overview's **Bot controls** card has a row per account with its Auto
  switch, Work with the ticket type and Games with the game; the manual switches are off
  while Auto runs. Every account card in the account strip has its Auto switch too, and
  **Auto on every account** switches all of them. The switches go to the account's bot
  through `POST /api/bot/command` (`{account, command, value}`, commands `auto`, `work`,
  `games`, `taskType`, `game` and `hotfixTest`). **Account books** shows one account at a
  time, picked above it: **Profit** (net and return per game since its last upgrade,
  work, bonuses summed, a total, all since the last výpověď), **XP per game**, the
  **Upgrade queue**, the Forbes z Chánova test, the bank and answer counters and the AI
  cost. A bundle a model no longer matches shows as a banner over every tab.
- **Accounts**: stats, profit, achievement flags (clean loan, leaderboards) and the
  daily XP budget are kept per account under `stats:<user id>`; the answer bank and
  settings are shared. Stats from before this existed go to the first account that
  logs in. The bot saves each account's supabase session (the `sb-*-auth-token` entry
  in the account's localStorage) under `account:<user id>` in the shared storage,
  together with a snapshot of its level, credits and energy. Accounts are added with
  the GitHub or e-mail sign-in on the Accounts tab, or from a backup.
  - Every saved account runs at once in its own context, so there is no switching and
    no rotation: each account works its own energy, grinds, claims its wheel, bets on
    Produkce padá and buys its lottery tickets on its own.
  - Never use the casino's own Log out on a saved account: it signs out with scope
    `global`, which revokes every session of that account on the server, including the
    copy the server holds.
  - Supabase rotates the refresh token on every refresh and revokes the whole login
    when a replaced one is used again, so the saved copy must always hold the newest
    token. The server refreshes each session 5 minutes before it runs out, and the bot
    writes every new session into the saved login at once. A saved copy is never
    replaced by one with an earlier `expires_at`. Playing a saved account in a browser
    at the same time makes the two log each other out.
  - Work starts only once energy is above 5 and then works it down to zero, so single
    refilled points do not keep interrupting the grinder. In auto mode, while the
    account can still grind XP, it grinds first and works only to keep energy 2 below
    the cap (at the cap the refill clock stops): tickets pay more at a higher level,
    so the rest of the energy is spent once grinding is done.
  - The Accounts tab lists the saved accounts with level, výpovědi (prestige), credits,
    energy, debt and state (**Forget** drops a saved login, not its stats), and
    Statistics, Profit shows profit per account or summed over all of them.

## Install

Botter runs on the server, in Docker or with `cd server && npm start`; see the
[README](../README.md#install). Settings save as you make them; there is no Save button.

The answer bank can be exported and imported as JSON from Settings, Data and backup, so
a bank learned on one install can be reused on another.

**Backup** (Settings, Data and backup) exports everything to one file: settings, profit
stats of every account, the bank, the level curve, recorded Blaze spins and saved
accounts. The server builds it (`GET /api/backup?secrets=0|1`) and imports it
(`POST /api/backup/import`). API keys and login sessions are left out unless *Include
API keys and saved logins* is on. Importing applies the file's settings and merges the
rest: stats are added up per account, the other data only fills in what is missing.
Each export has an id and names the install it came from, so importing it twice, or
back into the same install, never adds the stats again.

## Development

```
npm run check
```

**App bundle tracking**: the casino ships as one bundle (`/assets/index-<hash>.js`)
whose name changes with every deploy. The server finds the current one when an
account's context starts; when its name has not been seen before, the bot fetches it once and checks it with `src/bundle.js`: every client table
the models copy (slot weights, paytables, upgrade effects, blackjack and roulette
rules, the payroll share, big-win multiples, max bet by level) must still be in it,
and the shop catalog, unlock levels, bet levels and roulette zeros are read out and
compared with `src/games.js` and `src/odds.js`. A game in the lobby or the shop
that the bot does not know is reported too, unless the lobby marks it as coming
(Kostky and Tajemný automat, 2026-10-14; Tajemný automat shipped as Kniha mrtvého
kódu on 2026-10-21). A lobby entry may give its icon as a getter (Skeleton Slots,
which wears a pumpkin on Halloween, since 2026-10-24). The dashboard shows a "Botter needs an update" banner over
every tab and the Changes tab names every difference until a bundle matches again, and
a new bundle that matches is listed there; the log gets `bundle_models_stale`, `bundle_changed` or `bundle_seen`.
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

`npm run check` parses every script (the bot, `server/src` and `server/public`), checks
that both locales (`cs`, `en`) carry the same message keys and that every key used in
the code, `server/public/settings.js`, `server/public/controls.js` and the `data-msg`
attributes of `server/public/app.html` exists, then runs the unit tests for
`src/core.js`. `cd server && npm test` runs the server tests. There are no dependencies
and no build step. After editing, restart the server, or let the updater rebuild the
container.

Casino API calls the bot relies on: `/api/me`, `/api/work/start` and `/api/work/submit`
(the triage rules of "Založ task" are copied into `TICKET_FIELDS` in `src/core.js`), the
game paths in `PATH_GAME` in `src/games.js` (`/api/slot/spin`, `/api/skeleton/spin`,
`/api/slotingi/spin`, `/api/hotfix/spin` and `/api/hotfix/free`, `/api/roulette/spin`,
`/api/blackjack/deal` and `/api/blackjack/action`, `/api/baccarat/deal`,
`/api/dice/roll`, `/api/cases/open`, `/api/egypt/spin`, `/api/mines/start`,
`/api/mines/reveal` and `/api/mines/cashout`), `/api/crash` and `/api/crash/bet`,
`/api/lottery` and `/api/lottery/buy`, `/api/bonus/daily`, `/api/bonus/bailout`,
`/api/wheel/spin`, `/api/loan/take`, `/api/loan/repay`, `/api/loan/bankrupt`,
`/api/shop/buy`, `/api/cosmetics/buy` and `/api/cosmetics/equip`,
`/api/profile/prestige`, `/api/profile/reset` and `/api/leaderboard`. If the casino
changes, start there.
