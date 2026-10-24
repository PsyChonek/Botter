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
      statusNone: 'Panel Botteru zatím není na stránce kasina. Otevřete kasino a přihlaste se.',
      account: 'Účet',
      auto: 'Auto',
      work: 'Práce',
      games: 'Hry',
      tabs: 'Karty',
      openCasino: '+ Kasino',
      openSettings: '+ Nastavení Botteru',
      closeTab: 'Zavřít kartu',
      back: 'Zpět',
      forward: 'Vpřed',
      reload: 'Načíst znovu',
      address: 'Adresa',
      go: 'Otevřít',
      screen: 'Obrazovka prohlížeče. Klikněte a pište jako v běžném okně.',
      screenHint: 'Klikněte do obrazovky a pište. Vložení přes Ctrl+V funguje.',
      typeText: 'Vložit text',
      typeTextPlaceholder: 'Text, který se napíše do vybraného pole',
      send: 'Napsat',
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
      statusNone: 'The Botter panel is not on the casino page yet. Open the casino and log in.',
      account: 'Account',
      auto: 'Auto',
      work: 'Work',
      games: 'Games',
      tabs: 'Tabs',
      openCasino: '+ Casino',
      openSettings: '+ Botter settings',
      closeTab: 'Close tab',
      back: 'Back',
      forward: 'Forward',
      reload: 'Reload',
      address: 'Address',
      go: 'Go',
      screen: 'Browser screen. Click and type as in a normal window.',
      screenHint: 'Click the screen and type. Pasting with Ctrl+V works.',
      typeText: 'Type text',
      typeTextPlaceholder: 'Text to type into the focused field',
      send: 'Type',
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
