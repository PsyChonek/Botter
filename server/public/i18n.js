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
      signinNote: 'Heslo se neukládá, bot si drží jen přihlášení.',
      heroSignin: 'Přihlásit do kasina',
      githubHeading: 'Přihlásit přes GitHub',
      githubNote: 'Otevře přihlášení GitHubem v nové kartě. Po povolení skončíte v kasinu: zkopírujte celou adresu z adresního řádku (obsahuje ?code=) a vložte ji sem. Na GitHubu buďte přihlášeni jako účet, který chcete přidat. Účet pak už nepoužívejte v Chromu s Botterem, přihlášení by se navzájem odhlašovala.',
      githubStart: 'Otevřít přihlášení GitHubem',
      githubUrl: 'Adresa kasina po přihlášení',
      githubFinish: 'Přidat účet',
      githubLink: 'Karta se neotevřela? Otevřete GitHub tady.',
      githubWaiting: 'Přihlaste se v nové kartě a vložte sem adresu, na které skončíte.',
      githubNoCode: 'V adrese chybí ?code=. Zkopírujte celou adresu kasina hned po přihlášení.',
      githubExpired: 'Přihlášení vypršelo, začněte znovu.',
      githubFailed: 'Kód nešel použít. Začněte znovu, každý kód platí jen jednou a krátce.',
      signinOk: 'Přihlášeno.',
      signinInvalid: 'Špatný e-mail nebo heslo.',
      signinFailed: 'Přihlášení se nepovedlo.',
      working: 'Pracuji...',
      progress: 'Průběh',
      range: 'Období',
      range1: '24 h',
      range7: '7 dní',
      range30: '30 dní',
      rangeAll: 'Vše',
      progressEmpty: 'Zatím žádná data. Bot zapisuje level a kredity všech účtů každých 5 minut.',
      creditsChart: 'Kredity v čase',
      levelChart: 'Level v čase',
      total: 'Všechny účty',
      now: 'Teď',
      change: 'Změna za období',
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
      signinNote: 'The password is not stored, the bot only keeps the login.',
      heroSignin: 'Sign in to the casino',
      githubHeading: 'Sign in with GitHub',
      githubNote: 'Opens the GitHub sign-in in a new tab. After you allow it you land on the casino: copy the whole address from the address bar (it has ?code=) and paste it here. Be signed in to GitHub as the account you want to add. Stop using that account in Chrome with Botter afterwards, or the two logins sign each other out.',
      githubStart: 'Open GitHub sign-in',
      githubUrl: 'Casino address after the sign-in',
      githubFinish: 'Add the account',
      githubLink: 'No tab opened? Open GitHub here.',
      githubWaiting: 'Sign in in the new tab and paste the address you land on here.',
      githubNoCode: 'The address has no ?code=. Copy the whole casino address right after the sign-in.',
      githubExpired: 'The sign-in expired, start again.',
      githubFailed: 'The code did not work. Start again, each code works once and only briefly.',
      signinOk: 'Signed in.',
      signinInvalid: 'Wrong e-mail or password.',
      signinFailed: 'Sign in failed.',
      working: 'Working...',
      progress: 'Progress',
      range: 'Range',
      range1: '24 h',
      range7: '7 days',
      range30: '30 days',
      rangeAll: 'All',
      progressEmpty: 'No data yet. The bot records the level and credits of every account every 5 minutes.',
      creditsChart: 'Credits over time',
      levelChart: 'Level over time',
      total: 'All accounts',
      now: 'Now',
      change: 'Change in range',
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
