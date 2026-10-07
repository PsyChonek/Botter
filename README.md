# Botter

Chrome extension (Manifest V3) that solves the work tickets ("Práce") in
[Skeleton Casino](https://skeleton-casino.vercel.app/) automatically.

## How it works

- `src/page-hook.js` runs in the page's own JS world before the app loads and
  wraps `fetch`. It forwards the responses of `/api/me`, `/api/work/start`
  and `/api/work/submit` to the content script. No auth token is read or reused.
- `src/content.js` runs the loop: open the work screen, pick a ticket card,
  choose an answer, click the app's own button, dismiss the result with Escape, repeat.
  When energy runs out it waits for the refill. It also dismisses the level-up
  and daily-bonus modals, which would otherwise block the screen.
- The answer is chosen in this order:
  1. **Answer bank**: every submit response contains the correct answer
     (`result.answer`), so each ticket is learned the first time it is seen,
     whether the bot or you answered it. Output puzzles are stored by option text,
     so a reshuffled copy of the same puzzle still matches.
  2. **Claude** (optional): `src/background.js` calls the Messages API with
     structured output (`{"index": n}`). Default model is `claude-opus-5-5`
     at `medium` effort.
  3. **Guess** (optional): a random valid choice. A wrong answer costs energy
     but teaches the bank.
- A small panel in the bottom-left corner of the page has Start/Stop, the
  ticket type (alternate, bug hunt, output) and accuracy per answer source.

## Install

1. `chrome://extensions` > enable Developer mode > Load unpacked > pick this folder.
2. Click the extension icon to open the settings. Optionally paste an Anthropic API
   key. It is stored only in `chrome.storage.local` of that browser profile and
   never leaves the extension except in calls to `api.anthropic.com`.
3. Open the casino, log in, and press **Start** in the panel.

The bank can be exported and imported as JSON from the settings page, so a
bank learned on one machine can be reused on another.

## Development

```
npm run check
```

This parses every script, checks that both locales (`cs`, `en`) carry the same
message keys and that every key used in code exists, then runs the unit tests
for `src/core.js`. There are no dependencies and no build step. After editing,
press reload on the extension card in `chrome://extensions` and refresh the
casino tab.

Selectors the bot relies on (from the app bundle): `nav.views button` (2nd is
Práce), `.work-screen`, `.work-pick .job-card` (bug hunt, then output),
`section.task`, `.ticket`, `ol.code.lines > li button`, `.options button`,
`button.right` / `button.wrong` after a submit, `.modal .sheet.levelup`,
`.modal .sheet.daily`. If the casino UI changes, start there.
