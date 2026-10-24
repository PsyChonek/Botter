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
      account: 'Účet',
      notLoggedIn: 'Nepřihlášen',
      level: 'Level',
      credits: 'Kredity',
      energy: 'Energie',
      auto: 'Auto',
      on: 'zapnuto',
      off: 'vypnuto',
      sections: 'Části',
      overview: 'Přehled',
      settings: 'Nastavení',
      accounts: 'Účty',
      activity: 'Aktivita',
      panel: 'Bot',
      panelNone: 'Bot se spouští.',
      recent: 'Poslední aktivita',
      showAll: 'Zobrazit vše',
      onlyProblems: 'Jen varování a chyby',
      activityEmpty: 'Zatím nic. Záznamy se objeví, jakmile bot začne pracovat.',
      accountsSaved: 'Uložené účty',
      accountsEmpty: 'Zatím žádný účet. Přihlaste se e-mailem, nebo načtěte zálohu v Nastavení, karta Data.',
      actions: 'Akce',
      current: 'Právě hraje',
      setAside: 'Odložen',
      noSession: 'Bez přihlášení',
      use: 'Použít',
      signinHeading: 'Přidat účet s e-mailem',
      email: 'E-mail',
      signin: 'Přihlásit do kasina',
      signinNote: 'Heslo se neukládá, bot si drží jen přihlášení. Účty přes GitHub přidáte zálohou z Chromu (karta Data, zapnuté „Přidat API klíče a uložená přihlášení“) a v Chromu je pak už nepoužívejte.',
      signinOk: 'Přihlášeno.',
      signinInvalid: 'Špatný e-mail nebo heslo.',
      signinFailed: 'Přihlášení se nepovedlo.',
      working: 'Pracuji...',
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
      account: 'Account',
      notLoggedIn: 'Not logged in',
      level: 'Level',
      credits: 'Credits',
      energy: 'Energy',
      auto: 'Auto',
      on: 'on',
      off: 'off',
      sections: 'Sections',
      overview: 'Overview',
      settings: 'Settings',
      accounts: 'Accounts',
      activity: 'Activity',
      panel: 'Bot',
      panelNone: 'The bot is starting.',
      recent: 'Recent activity',
      showAll: 'Show all',
      onlyProblems: 'Only warnings and errors',
      activityEmpty: 'Nothing yet. Entries appear once the bot starts working.',
      accountsSaved: 'Saved accounts',
      accountsEmpty: 'No accounts yet. Sign in with an e-mail, or load a backup in Settings, Data tab.',
      actions: 'Actions',
      current: 'Playing now',
      setAside: 'Set aside',
      noSession: 'No login',
      use: 'Use',
      signinHeading: 'Add an e-mail account',
      email: 'E-mail',
      signin: 'Sign in to the casino',
      signinNote: 'The password is not stored, the bot only keeps the login. Add GitHub accounts with a backup from Chrome (Data tab, "Include API keys and saved logins" on), and stop using them in Chrome after that.',
      signinOk: 'Signed in.',
      signinInvalid: 'Wrong e-mail or password.',
      signinFailed: 'Sign in failed.',
      working: 'Working...',
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
    for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  }

  function toggle() {
    lang = lang === 'cs' ? 'en' : 'cs';
    try {
      localStorage.setItem('lang', lang);
    } catch {}
    apply();
  }

  // Picks a language without remembering it in this browser: the dashboard
  // takes the server's, which the panel is rendered in.
  function set(next) {
    if (MESSAGES[next]) lang = next;
  }

  window.I18n = { t, apply, toggle, set, get lang() { return lang; } };
})();
