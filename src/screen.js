// Plays casino games on the app's own game screens instead of through the API,
// so every bot round animates like a manual one: the bot opens the game from
// the lobby, sets the bet with the app's +/- buttons and presses its spin, deal
// or hit/stand/double buttons. Classic script like core.js (globalThis.BotterScreen
// in the extension, require() in Node for the pure helpers).
(function (root) {
  const POLL_MS = 100;
  const NAV_MS = 4000;
  const NAV_STEPS = 4;
  const BET_STEPS = 8;
  const CLICK_PAUSE_MS = 200;
  // Longest a round may animate: free spins, respins and big-win banners included.
  const ROUND_MS = 90_000;

  // Selectors of each game's screen, from the app bundle. Forbes z Chánova
  // reuses Skeleton Slots' screen class with its own on top.
  const SCREENS = {
    blaze: '#hud.blaze',
    skeleton: 'main.table-screen.skeleton:not(.hotfix)',
    slotingi: 'main.table-screen.slotingi',
    hotfix: 'main.table-screen.skeleton.hotfix',
    cases: 'main.table-screen.cases',
    blackjack: 'main.table-screen.blackjack',
    roulette: 'main.table-screen.roulette',
    baccarat: 'main.table-screen.baccarat',
    dice: 'main.table-screen.dice',
    egypt: 'main.table-screen.egypt',
    // Only through the API: the board has no bet buttons the screen bot knows.
    mines: 'main.table-screen.mines',
  };
  // Games played with the bet +/- and one button: its selector and the path it sends.
  const SPIN_PATHS = {
    blaze: '/api/slot/spin',
    skeleton: '/api/skeleton/spin',
    slotingi: '/api/slotingi/spin',
    hotfix: '/api/hotfix/spin',
    cases: '/api/cases/open',
    egypt: '/api/egypt/spin',
  };
  const SPIN_BUTTONS = { cases: 'button.cs-open' };
  // Chip tables: their main button is idle when it is enabled.
  const CHIP_TABLES = ['roulette', 'baccarat', 'dice'];
  // The even-money spots are the last six on the roulette table, in this order.
  const ROULETTE_SPOTS = ['low', 'even', 'red', 'black', 'odd', 'high'];
  // Kostky's main row, in this order; the sums (4 to 17) sit under "Další sázky".
  const DICE_MAIN = ['small', 'odd', 'anytriple', 'even', 'big'];
  const DICE_FIRST_SUM = 4;
  const CHIPS = [500, 100, 50, 10];
  const BJ_BUTTONS = ['hit', 'stand', 'double'];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const failed = (error) => ({ ok: false, status: 0, data: { error } });

  // Credits as the app prints them ("1 000" with a narrow space in cs-CZ).
  function parseCredits(text) {
    const digits = String(text ?? '').replace(/\D/g, '');
    return digits ? Number(digits) : null;
  }

  // Roulette chips that add up to the stake, biggest first, or null when the
  // chips cannot make it.
  function chipsFor(amount) {
    const chips = [];
    let rest = amount;
    for (const chip of CHIPS) {
      while (rest >= chip) {
        chips.push(chip);
        rest -= chip;
      }
    }
    return rest === 0 && chips.length ? chips : null;
  }

  // Whether a game screen is waiting for input. Every control is disabled while
  // a round runs, its animation included.
  function isIdle(game, screen) {
    if (CHIP_TABLES.includes(game)) return screen.querySelector('.roulette-buttons .btn-primary')?.disabled === false;
    const controls = game === 'blackjack' ? '.bj-actions button' : '.betctl button';
    return [...screen.querySelectorAll(controls)].some((button) => !button.disabled);
  }

  // ctx: { waitResponse(path) -> Promise<{ ok, status, data }>, dismissModal(),
  // active() -> whether the bot should go on, decide(hand, data) -> blackjack action }.
  function create(ctx) {
    async function until(check, ms) {
      const end = Date.now() + ms;
      for (;;) {
        const value = check();
        if (value) return value;
        if (Date.now() >= end) return null;
        await sleep(POLL_MS);
      }
    }

    // Blaze draws on a canvas that is created after its HUD, and ignores clicks
    // until it exists. It also stays mounted, hidden, on the work view.
    function ready(game) {
      if (document.querySelector('nav.views button')?.getAttribute('aria-pressed') !== 'true') return null;
      const screen = document.querySelector(SCREENS[game]);
      if (!screen || (game === 'blaze' && !document.querySelector('.stage canvas'))) return null;
      return screen;
    }

    // Level-up modals keep a round busy until they are closed.
    const idle = (game, ms = ROUND_MS) =>
      until(() => {
        ctx.dismissModal();
        const screen = ready(game);
        return screen && isIdle(game, screen) ? screen : null;
      }, ms);

    // Walks to the game: the casino view, back to the lobby, then the game card.
    // The game's own screen can show before it is ready (Blaze's canvas comes
    // later), so it is waited for, never left through its back button. After
    // the card click the card itself is still in the DOM until React renders,
    // so only the game counts as arrived.
    async function open(game) {
      const card = `.lobby-screen button.game-card.${game}`;
      for (let step = 0; step < NAV_STEPS; step++) {
        if (ready(game)) return idle(game);
        ctx.dismissModal();
        const casino = document.querySelector('nav.views button');
        const target = document.querySelector(card);
        const loading = document.querySelector(SCREENS[game]);
        const button =
          casino?.getAttribute('aria-pressed') === 'false'
            ? casino
            : loading
              ? null
              : (target ?? document.querySelector('.pill.back') ?? casino);
        if (!button && !loading) return null;
        button?.click();
        await until(() => ready(game) || (button && button !== target && document.querySelector(card)), NAV_MS);
      }
      return ready(game) && idle(game);
    }

    async function press(button, path) {
      if (!button || button.disabled) return failed('button_missing');
      const reply = ctx.waitResponse(path);
      button.click();
      return reply;
    }

    async function setBet(screen, bet) {
      for (let step = 0; step < BET_STEPS; step++) {
        const value = () => parseCredits(screen.querySelector('.betctl .value')?.textContent);
        const now = value();
        if (now === bet) return true;
        if (now === null) return false;
        const [minus, plus] = screen.querySelectorAll('.betctl button');
        const button = now < bet ? plus : minus;
        if (!button || button.disabled) return false;
        button.click();
        // At the max bet the app only toasts, so an unchanged value ends the walk.
        if (!(await until(() => value() !== now, NAV_MS))) return false;
        await sleep(CLICK_PAUSE_MS);
      }
      return false;
    }

    async function finish(game, res) {
      if (res.ok) await idle(game);
      return res;
    }

    async function slot(game, bet) {
      const screen = await open(game);
      if (!screen) return failed('screen_missing');
      if (!(await setBet(screen, bet))) return failed('bet_unavailable');
      return finish(game, await press(screen.querySelector(SPIN_BUTTONS[game] ?? 'button.spin'), SPIN_PATHS[game]));
    }

    // Forbes z Chánova: a spin, and when it leaves free spins pending
    // (player.hotfixFree) the option `choice` from the pick the app shows once
    // the spin has animated. pending: free spins are already waiting, so only
    // the pick is made. Returns the free spins' response, or the spin's when
    // the pick failed (the free spins then wait for the next round).
    async function hotfix(bet, choice, pending) {
      const screen = await open('hotfix');
      if (!screen) return failed('screen_missing');
      let res = null;
      if (!pending) {
        if (!(await setBet(screen, bet))) return failed('bet_unavailable');
        res = await press(screen.querySelector('button.spin'), SPIN_PATHS.hotfix);
        if (!res.ok || !res.data.player?.hotfixFree) return finish('hotfix', res);
      }
      const option = await until(() => {
        ctx.dismissModal();
        const button = document.querySelectorAll('.hf-choice .hf-options button')[choice];
        return button && !button.disabled ? button : null;
      }, ROUND_MS);
      if (!option) return res ?? failed('choice_missing');
      await sleep(CLICK_PAUSE_MS);
      const paid = await press(option, '/api/hotfix/free');
      return finish('hotfix', paid.ok || !res ? paid : res);
    }

    // Chip tables: clears the table, lays the stake in chips on the spot
    // (spotOf(screen), null when the screen has no such spot) and presses the
    // main button, which sends `path`. clearAt is the Smazat pill's place.
    async function table(game, bet, spotOf, clearAt, path) {
      const screen = await open(game);
      if (!screen) return failed('screen_missing');
      const chips = chipsFor(bet);
      const target = await spotOf(screen);
      if (!chips || !target) return failed('spot_missing');
      const clear = screen.querySelectorAll('.roulette-buttons .pill')[clearAt];
      if (clear && !clear.disabled) {
        clear.click();
        await sleep(CLICK_PAUSE_MS);
      }
      // The app reads the chip value from its last render, so each pick
      // re-renders before the spot is clicked.
      for (const chip of chips) {
        const button = screen.querySelector(`.chips .chip.c${chip}`);
        if (!button) return failed('chip_missing');
        button.click();
        await sleep(CLICK_PAUSE_MS / 2);
        target.click();
        await sleep(CLICK_PAUSE_MS);
      }
      return finish(game, await press(screen.querySelector('.roulette-buttons .btn-primary'), path));
    }

    const roulette = (spot, bet) =>
      table('roulette', bet, (screen) => [...screen.querySelectorAll('.rtable .spot')].slice(-ROULETTE_SPOTS.length)[ROULETTE_SPOTS.indexOf(spot)], 1, '/api/roulette/spin');

    // spot is one of BotterBaccarat.SPOTS, which the spots carry as a class.
    const baccarat = (spot, bet) =>
      table('baccarat', bet, (screen) => screen.querySelector(`.bac-spot.${spot}`), 1, '/api/baccarat/deal');

    // The main row and the sums; other Kostky spots are not laid on the screen.
    async function diceSpot(screen, spot) {
      if (DICE_MAIN.includes(spot)) return screen.querySelectorAll('.sb-main .sb-spot')[DICE_MAIN.indexOf(spot)] ?? null;
      const sum = /^sum(\d+)$/.exec(spot);
      if (!sum) return null;
      const more = screen.querySelector('.sb-more[aria-expanded="false"]');
      if (more) {
        more.click();
        await until(() => screen.querySelector('.sb-sums .sb-spot'), NAV_MS);
      }
      return screen.querySelectorAll('.sb-sums .sb-spot')[Number(sum[1]) - DICE_FIRST_SUM] ?? null;
    }
    const dice = (spot, bet) => table('dice', bet, (screen) => diceSpot(screen, spot), 2, '/api/dice/roll');

    // An open hand is restored by the app on its own, so it is played on from
    // where it stands.
    async function blackjack(bet, openHand) {
      let screen = await open('blackjack');
      if (!screen) return failed('screen_missing');
      let res = { ok: true, status: 200, data: { hand: openHand } };
      if (!openHand) {
        if (!(await setBet(screen, bet))) return failed('bet_unavailable');
        res = await press(screen.querySelector('.bj-actions .btn-primary'), '/api/blackjack/deal');
      }
      while (res.ok && res.data.hand && !res.data.hand.done && ctx.active()) {
        screen = await idle('blackjack');
        if (!screen) return failed('screen_busy');
        await sleep(CLICK_PAUSE_MS);
        const action = ctx.decide(res.data.hand, res.data);
        res = await press(screen.querySelectorAll('.bj-actions .btn-ghost')[BJ_BUTTONS.indexOf(action)], '/api/blackjack/action');
      }
      return finish('blackjack', res);
    }

    return { slot, hotfix, roulette, baccarat, dice, blackjack };
  }

  const api = { SCREENS, ROULETTE_SPOTS, DICE_MAIN, parseCredits, chipsFor, isIdle, create };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterScreen = api;
})(globalThis);
