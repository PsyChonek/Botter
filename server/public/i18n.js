// Dashboard copy in cs and en. Elements carry data-i18n (text),
// data-i18n-placeholder or data-i18n-label (aria-label) with a key from here.
(function () {
  const MESSAGES = {
    cs: {
      title: 'Botter',
      loginHeading: 'Přihlášení',
      user: 'Uživatel',
      password: 'Heslo',
      signIn: 'Přihlásit',
      loginInvalid: 'Špatné jméno nebo heslo.',
      loginRateLimited: 'Příliš mnoho pokusů. Zkuste to za 15 minut.',
      loginError: 'Přihlášení se nepovedlo. Zkuste to znovu.',
      logout: 'Odhlásit',
      language: 'English',
      connected: 'Připojeno',
      disconnected: 'Odpojeno, připojuji znovu',
      status: 'Stav bota',
      statusNone: 'Bot se spouští.',
      controls: 'Ovládání bota',
      auto: 'Auto',
      work: 'Práce',
      games: 'Hry',
      account: 'Účet',
      level: 'Level',
      credits: 'Kredity',
      energy: 'Energie',
      bank: 'Banka odpovědí',
      answers: 'Správné odpovědi',
      workDone: 'Tikety (výdělek)',
      gamesNet: 'Hry celkem',
      notLoggedIn: 'Nepřihlášen',
      source_bank: 'banka',
      source_ai: 'AI',
      source_guess: 'tip',
      bundleStale: 'Kasino změnilo hry, modely jsou zastaralé',
      accounts: 'Účty v kasinu',
      accountsEmpty: 'Zatím žádný účet. Načtěte zálohu s přihlášeními, nebo se přihlaste e-mailem níže.',
      actions: 'Akce',
      current: 'Právě hraje',
      noSession: 'Bez přihlášení',
      use: 'Použít',
      signinHeading: 'Přidat účet s e-mailem',
      email: 'E-mail',
      signinNote: 'Heslo se neukládá, bot si drží jen přihlášení. Účty přes GitHub přidejte zálohou.',
      signin: 'Přihlásit do kasina',
      signinOk: 'Přihlášeno.',
      signinInvalid: 'Špatný e-mail nebo heslo.',
      signinFailed: 'Přihlášení se nepovedlo.',
      backup: 'Záloha',
      backupNote: 'Záloha z karty Data v rozšíření. Aby bot mohl hrát, exportujte ji se zapnutým „Přidat API klíče a uložená přihlášení“ a pak tyto účty v Chromu už nepoužívejte.',
      backupImport: 'Načíst zálohu',
      backupSecrets: 'Včetně přihlášení a API klíčů',
      backupExport: 'Stáhnout zálohu',
      backupSecretsConfirm: 'Soubor bude obsahovat přihlášení a API klíče v čitelné podobě. Pokračovat?',
      backupInvalid: 'Tohle není záloha Botteru.',
      backupFailed: 'Zálohu se nepovedlo načíst.',
      backupDone: 'Načteno. Účty / odpovědi / statistiky:',
      backupNoSessions: 'Záloha neobsahuje přihlášení, takže bot zatím nemůže hrát.',
      ai: 'AI na neznámé tikety',
      solver: 'Řešitel',
      solverOff: 'Vypnuto',
      solverLocal: 'Gemini Nano (v Dockeru nefunguje)',
      solverKey: 'API klíč',
      solverKeyPlaceholder: 'Nechte prázdné pro zachování uloženého',
      save: 'Uložit',
      saved: 'Uloženo.',
      saveFailed: 'Uložení se nepovedlo.',
      working: 'Pracuji...',
      activity: 'Aktivita',
      activityEmpty: 'Zatím nic. Záznamy se objeví, jakmile bot začne pracovat.',
    },
    en: {
      title: 'Botter',
      loginHeading: 'Sign in',
      user: 'User',
      password: 'Password',
      signIn: 'Sign in',
      loginInvalid: 'Wrong user or password.',
      loginRateLimited: 'Too many attempts. Try again in 15 minutes.',
      loginError: 'Sign in failed. Try again.',
      logout: 'Sign out',
      language: 'Česky',
      connected: 'Connected',
      disconnected: 'Disconnected, reconnecting',
      status: 'Bot status',
      statusNone: 'The bot is starting.',
      controls: 'Bot controls',
      auto: 'Auto',
      work: 'Work',
      games: 'Games',
      account: 'Account',
      level: 'Level',
      credits: 'Credits',
      energy: 'Energy',
      bank: 'Answer bank',
      answers: 'Right answers',
      workDone: 'Tickets (earned)',
      gamesNet: 'Games net',
      notLoggedIn: 'Not logged in',
      source_bank: 'bank',
      source_ai: 'AI',
      source_guess: 'guess',
      bundleStale: 'The casino changed its games, the models are stale',
      accounts: 'Casino accounts',
      accountsEmpty: 'No accounts yet. Load a backup with logins, or sign in with an e-mail below.',
      actions: 'Actions',
      current: 'Playing now',
      noSession: 'No login',
      use: 'Use',
      signinHeading: 'Add an e-mail account',
      email: 'E-mail',
      signinNote: 'The password is not stored, the bot only keeps the login session. Add GitHub accounts with a backup.',
      signin: 'Sign in to the casino',
      signinOk: 'Signed in.',
      signinInvalid: 'Wrong e-mail or password.',
      signinFailed: 'Sign in failed.',
      backup: 'Backup',
      backupNote: 'A backup from the Data tab of the extension. For the bot to play, export it with "Include API keys and saved logins" on, then stop using those accounts in Chrome.',
      backupImport: 'Load a backup',
      backupSecrets: 'Include logins and API keys',
      backupExport: 'Download a backup',
      backupSecretsConfirm: 'The file will hold logins and API keys in plain text. Continue?',
      backupInvalid: 'This is not a Botter backup.',
      backupFailed: 'The backup could not be loaded.',
      backupDone: 'Loaded. Accounts / answers / stats:',
      backupNoSessions: 'The backup has no logins, so the bot cannot play yet.',
      ai: 'AI for unknown tickets',
      solver: 'Solver',
      solverOff: 'Off',
      solverLocal: 'Gemini Nano (does not run in Docker)',
      solverKey: 'API key',
      solverKeyPlaceholder: 'Leave empty to keep the saved one',
      save: 'Save',
      saved: 'Saved.',
      saveFailed: 'Saving failed.',
      working: 'Working...',
      activity: 'Activity',
      activityEmpty: 'Nothing yet. Entries appear once the bot starts working.',
    },
  };

  function storedLang() {
    try {
      return localStorage.getItem('lang');
    } catch {
      return null;
    }
  }

  let lang = storedLang() || (navigator.language?.toLowerCase().startsWith('en') ? 'en' : 'cs');
  if (!MESSAGES[lang]) lang = 'cs';

  function t(key) {
    return MESSAGES[lang][key] ?? MESSAGES.en[key] ?? key;
  }

  function apply(root = document) {
    document.documentElement.lang = lang;
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
    for (const el of root.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel));
  }

  function toggle() {
    lang = lang === 'cs' ? 'en' : 'cs';
    try {
      localStorage.setItem('lang', lang);
    } catch {}
    apply();
  }

  window.I18n = { t, apply, toggle, get lang() { return lang; } };
})();
