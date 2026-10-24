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
      panel: 'Panel',
      panelNone: 'Bot se spouští.',
      settings: 'Nastavení',
      signinHeading: 'Přidat účet s e-mailem',
      email: 'E-mail',
      signinNote: 'Heslo se neukládá, bot si drží jen přihlášení. Účty přes GitHub přidejte zálohou v Nastavení, karta Data, se zapnutým „Přidat API klíče a uložená přihlášení“, a v Chromu je pak už nepoužívejte.',
      signin: 'Přihlásit do kasina',
      signinOk: 'Přihlášeno.',
      signinInvalid: 'Špatný e-mail nebo heslo.',
      signinFailed: 'Přihlášení se nepovedlo.',
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
      panel: 'Panel',
      panelNone: 'The bot is starting.',
      settings: 'Settings',
      signinHeading: 'Add an e-mail account',
      email: 'E-mail',
      signinNote: 'The password is not stored, the bot only keeps the login. Add GitHub accounts with a backup in Settings, Data tab, exported with "Include API keys and saved logins" on, and stop using them in Chrome after that.',
      signin: 'Sign in to the casino',
      signinOk: 'Signed in.',
      signinInvalid: 'Wrong e-mail or password.',
      signinFailed: 'Sign in failed.',
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
    for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
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
