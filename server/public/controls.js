// The Overview's bot controls: for every running account its own Auto, Work
// and Games switches with the ticket type and game they use, and the account's
// books (profit since the last výpověď, XP per game, the upgrade queue, the
// Forbes z Chánova test). Switches go to that account's bot as commands.
(() => {
  const { t } = window.I18n;
  const msg = (key, subs) => window.BotterStorage.message(key, subs);
  const $ = (id) => document.getElementById(id);
  const TASK_TYPES = ['alternate', 'bughunt', 'output', 'ticket', 'typing'];

  let tabs = [];
  let picked = null; // account whose books are shown
  // Switches flipped here show at once and hold until the report agrees.
  const pending = new Map(); // `${id}:${command}` -> { value, until }
  const PENDING_MS = 6000;

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  async function command(account, name, value) {
    pending.set(`${account}:${name}`, { value, until: Date.now() + PENDING_MS });
    const res = await fetch('/api/bot/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account, command: name, ...(value === undefined ? {} : { value }) }),
    }).catch(() => null);
    if (res?.status === 401) location.assign('/login');
    if (!res?.ok) pending.delete(`${account}:${name}`);
  }

  // The value a switch shows: one just flipped here until the report has it.
  function shown(tab, name, reported) {
    const key = `${tab.id}:${name}`;
    const wait = pending.get(key);
    if (!wait) return reported;
    if (wait.value === reported || Date.now() > wait.until) {
      pending.delete(key);
      return reported;
    }
    return wait.value;
  }

  // ---------- one row per account ----------

  const rows = new Map();

  function switchControl(label, onChange) {
    const wrap = el('label', 'switch-field');
    const input = el('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    input.addEventListener('change', () => onChange(input.checked));
    wrap.append(input, el('span', '', label));
    return { wrap, input };
  }

  function pickControl(label, options, onChange) {
    const select = el('select');
    select.setAttribute('aria-label', label);
    select.addEventListener('change', () => onChange(select.value));
    return { select, fill: () => select.replaceChildren(...options().map(([value, text]) => new Option(text, value))) };
  }

  function buildRow(tab) {
    const id = tab.id;
    const item = el('li', 'ctl');
    const head = el('div', 'ctl-head');
    const dot = el('span', 'dot');
    const name = el('span', 'ctl-name');
    const status = el('span', 'ctl-status');
    head.append(dot, name, status);

    const auto = switchControl(msg('panelAuto'), (on) => {
      command(id, 'auto', on);
      update(rows.get(id), tabOf(id));
    });
    auto.wrap.classList.add('auto-field');
    const work = switchControl(msg('panelWork'), (on) => command(id, 'work', on));
    const type = pickControl(msg('panelWork'), () => TASK_TYPES.map((key) => [key, msg(`type_${key}`)]), (value) => command(id, 'taskType', value));
    const games = switchControl(msg('panelGames'), (on) => command(id, 'games', on));
    const game = pickControl(msg('panelGames'), () => (window.BotterGames?.GAME_KEYS ?? []).map((key) => [key, msg(`game_${key}`)]), (value) => command(id, 'game', value));
    type.fill();
    game.fill();
    const workGroup = el('div', 'ctl-group');
    workGroup.append(work.wrap, type.select);
    const gamesGroup = el('div', 'ctl-group');
    gamesGroup.append(games.wrap, game.select);
    const manual = el('div', 'ctl-manual');
    const note = el('p', 'ctl-note muted small');
    manual.append(workGroup, gamesGroup);
    const controls = el('div', 'ctl-controls');
    controls.append(auto.wrap, manual);
    item.append(head, controls, note);
    return { item, dot, name, status, auto, work, type, games, game, manual, note };
  }

  const tabOf = (id) => tabs.find((tab) => tab.id === id);

  function setValue(select, value) {
    if (select !== document.activeElement && select.value !== value) select.value = value;
  }

  function update(row, tab) {
    if (!row || !tab) return;
    const run = tab.run ?? {};
    row.dot.style.background = window.accountColor?.(tab.login) ?? '';
    row.name.textContent = tab.login ?? tab.id;
    row.status.textContent = tab.status ?? '';
    row.status.title = tab.status ?? '';
    const auto = shown(tab, 'auto', !!run.autoMode);
    row.auto.input.checked = auto;
    row.work.input.checked = shown(tab, 'work', !!run.enabled);
    row.games.input.checked = shown(tab, 'games', !!run.gamesEnabled);
    setValue(row.type.select, run.taskType ?? 'alternate');
    setValue(row.game.select, run.game ?? 'blaze');
    // Auto works and plays by itself; the manual switches wait until it is off.
    row.manual.classList.toggle('off', auto);
    for (const input of [row.work.input, row.games.input, row.type.select, row.game.select]) input.disabled = auto || !tab.player;
    row.auto.input.disabled = !tab.player;
    row.note.textContent = auto ? t('autoRunsAll') : '';
    row.note.hidden = !auto;
  }

  function renderRows() {
    const list = $('controls-list');
    const ids = new Set(tabs.map((tab) => tab.id));
    for (const [id, row] of rows) {
      if (ids.has(id)) continue;
      row.item.remove();
      rows.delete(id);
    }
    tabs.forEach((tab, i) => {
      let row = rows.get(tab.id);
      if (!row) rows.set(tab.id, (row = buildRow(tab)));
      update(row, tab);
      if (list.children[i] !== row.item) list.insertBefore(row.item, list.children[i] ?? null);
    });
    $('controls-empty').hidden = tabs.length > 0;
  }

  // ---------- the picked account's books ----------

  const number = (value) => (typeof value === 'number' ? new Intl.NumberFormat(window.I18n.lang).format(Math.round(value)) : '-');
  const signed = (value) => new Intl.NumberFormat(window.I18n.lang, { maximumFractionDigits: 0, signDisplay: 'exceptZero' }).format(value);
  const percent = (value) => new Intl.NumberFormat(window.I18n.lang, { style: 'percent', maximumFractionDigits: 1 }).format(value);
  const decimal = (value) => new Intl.NumberFormat(window.I18n.lang, { maximumFractionDigits: 2 }).format(value);
  const tone = (n) => (n > 0 ? 'pos' : n < 0 ? 'neg' : '');

  function td(text, className = '') {
    const cell = el('td', className, text);
    return cell;
  }

  function table(head, body, foot = []) {
    const node = el('table', 'data');
    const thead = el('thead');
    const tr = el('tr');
    head.forEach(([key, num]) => {
      const th = el('th', num ? 'num' : '', msg(key));
      th.scope = 'col';
      tr.append(th);
    });
    thead.append(tr);
    const tbody = el('tbody');
    tbody.append(...body);
    node.append(thead, tbody);
    if (foot.length) {
      const tfoot = el('tfoot');
      tfoot.append(...foot);
      node.append(tfoot);
    }
    const wrap = el('div', 'table-wrap');
    wrap.append(node);
    return wrap;
  }

  function block(title, ...content) {
    const section = el('section', 'books-block');
    section.append(el('h3', '', title), ...content);
    return section;
  }

  function renderPicker() {
    const picker = $('books-pick');
    const signature = tabs.map((tab) => `${tab.id}:${tab.login}`).join();
    if (picker.dataset.signature !== signature) {
      picker.dataset.signature = signature;
      picker.replaceChildren(
        ...tabs.map((tab) => {
          const button = el('button', '', tab.login ?? tab.id);
          button.type = 'button';
          button.dataset.id = tab.id;
          button.addEventListener('click', () => {
            picked = tab.id;
            renderBooks();
          });
          return button;
        }),
      );
    }
    for (const button of picker.children) button.setAttribute('aria-pressed', String(button.dataset.id === picked));
    picker.hidden = tabs.length < 2;
  }

  // Rebuilt only when what it shows changes, so a report every two seconds
  // does not restart the page's layout for nothing.
  let booksSignature = '';

  function renderBooks() {
    if (!tabOf(picked)) picked = tabs[0]?.id ?? null;
    renderPicker();
    const tab = tabOf(picked);
    $('books-empty').hidden = !!tab?.player;
    const body = $('books-body');
    if (!tab?.player) {
      body.replaceChildren();
      booksSignature = '';
      return;
    }
    const signature = JSON.stringify([window.I18n.lang, tab.id, tab.profit, tab.xp, tab.shop, tab.hotfix, tab.counters, tab.cost]);
    if (signature === booksSignature) return;
    booksSignature = signature;

    const profit = tab.profit ?? [];
    const total = profit.reduce((sum, item) => sum + item.net, 0);
    const profitRows = profit.map((item) => {
      const tr = el('tr');
      if (item.rounds !== null) tr.title = msg('panelRounds', [number(item.rounds)]);
      tr.append(td(item.name), td(signed(item.net), `num ${tone(item.net)}`), td(item.rtp === null ? '' : percent(item.rtp), 'num'));
      return tr;
    });
    const totalRow = el('tr');
    totalRow.append(td(msg('colTotal')), td(signed(total), `num ${tone(total)}`), td('', 'num'));
    const blocks = [
      block(
        msg('panelProfit'),
        profit.length ? table([['colGame'], ['colNet', true], ['colRtp', true]], profitRows, [totalRow]) : el('p', 'muted', msg('optionsProfitEmpty')),
      ),
    ];

    const xp = tab.xp ?? [];
    if (xp.length) {
      const xpRows = xp.map((item) => {
        const tr = el('tr', item.pick ? 'pick' : '');
        tr.append(
          td(item.name),
          td(item.edge === null ? '-' : percent(item.edge), 'num'),
          td(item.cost === null ? '-' : decimal(item.cost), 'num'),
          td(item.state, item.locked ? 'muted' : ''),
        );
        return tr;
      });
      blocks.push(block(msg('panelXp'), el('p', 'muted small', msg('panelXpNote')), table([['colGame'], ['colEdge', true], ['colCostPerXp', true], ['colState']], xpRows)));
    }

    if (tab.shop) {
      const shopRows = tab.shop.queue.map((offer) => {
        const tr = el('tr', offer.pick ? 'pick' : '');
        tr.append(td(offer.name), td(number(offer.price), 'num'), td(offer.state));
        return tr;
      });
      const goal = el('p', 'books-goal', tab.shop.text);
      if (tab.shop.detail) goal.title = tab.shop.detail;
      blocks.push(block(msg('panelShop'), goal, table([['colUpgrade'], ['colPrice', true], ['colState']], shopRows)));
    }

    const hotfix = tab.hotfix;
    if (hotfix) {
      const button = el('button', hotfix.running ? 'danger' : '', msg(hotfix.running ? 'hotfixTestStop' : 'hotfixTestStart'));
      button.type = 'button';
      button.disabled = !hotfix.available;
      button.title = hotfix.hint;
      button.addEventListener('click', () => command(tab.id, 'hotfixTest'));
      const row = el('div', 'books-action');
      row.append(el('p', 'muted small', hotfix.note), button);
      blocks.push(block(msg('panelHotfixTest'), row));
    }

    blocks.push(el('p', 'books-counters muted small', `${tab.counters ?? ''} ${tab.cost ?? ''}`.trim()));
    body.replaceChildren(...blocks);
  }

  function render(report) {
    tabs = report?.tabs ?? [];
    renderRows();
    renderBooks();
  }

  // Labels are built in the language they were made in, so a switch rebuilds them.
  function relabel() {
    for (const row of rows.values()) row.item.remove();
    rows.clear();
    booksSignature = '';
    $('books-pick').dataset.signature = '';
  }

  window.BotterControls = { render, relabel, command, shown };
})();
