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

  // Selectors of each game's screen, from the app bundle.
  const SCREENS = {
    blaze: '#hud.blaze',
    skeleton: 'main.table-screen.skeleton',
    slotingi: 'main.table-screen.slotingi',
    blackjack: 'main.table-screen.blackjack',
    roulette: 'main.table-screen.roulette',
  };
  const SPIN_PATHS = { blaze: '/api/slot/spin', skeleton: '/api/skeleton/spin', slotingi: '/api/slotingi/spin' };
  // The even-money spots are the last six on the roulette table, in this order.
  const ROULETTE_SPOTS = ['low', 'even', 'red', 'black', 'odd', 'high'];
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
    if (game === 'roulette') return screen.querySelector('.roulette-buttons .btn-primary')?.disabled === false;
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
    // until it exists.
    function ready(game) {
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
    async function open(game) {
      const card = `.lobby-screen button.game-card.${game}`;
      for (let step = 0; step < NAV_STEPS; step++) {
        if (ready(game)) return idle(game);
        ctx.dismissModal();
        const casino = document.querySelector('nav.views button');
        const button =
          casino?.getAttribute('aria-pressed') === 'false'
            ? casino
            : (document.querySelector(card) ?? document.querySelector('.pill.back') ?? casino);
        if (!button) return null;
        button.click();
        await until(() => ready(game) || document.querySelector(card), NAV_MS);
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
      return finish(game, await press(screen.querySelector('button.spin'), SPIN_PATHS[game]));
    }

    async function roulette(spot, bet) {
      const screen = await open('roulette');
      if (!screen) return failed('screen_missing');
      const chips = chipsFor(bet);
      const target = [...screen.querySelectorAll('.rtable .spot')].slice(-ROULETTE_SPOTS.length)[ROULETTE_SPOTS.indexOf(spot)];
      if (!chips || !target) return failed('spot_missing');
      const clear = screen.querySelectorAll('.roulette-buttons .pill')[1];
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
      return finish('roulette', await press(screen.querySelector('.roulette-buttons .btn-primary'), '/api/roulette/spin'));
    }

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

    return { slot, roulette, blackjack };
  }

  const api = { SCREENS, ROULETTE_SPOTS, parseCredits, chipsFor, isIdle, create };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BotterScreen = api;
})(globalThis);
