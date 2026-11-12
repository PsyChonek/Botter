// Fast sanity check: every script parses, the locales are valid JSON with the
// same keys, and every bot message key used in code or in the dashboard
// markup exists in both locales.
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const dir = (path) => readdirSync(path).filter((f) => /\.m?js$/.test(f)).map((f) => `${path}/${f}`);
const sources = dir('src');
const dashboard = dir('server/public');
const server = dir('server/src');
for (const file of [...sources, ...dashboard, ...server]) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });

const locales = readdirSync('_locales');
const messages = Object.fromEntries(locales.map((l) => [l, JSON.parse(readFileSync(`_locales/${l}/messages.json`, 'utf8'))]));

const used = new Set();
const code = [...sources, 'server/public/settings.js', 'server/public/controls.js', 'server/public/app.html'].map((f) => readFileSync(f, 'utf8'));
for (const text of code) {
  for (const m of text.matchAll(/(?:(?:msg|setStatus|stop)\(['`]|data-msg(?:-label)?=")([A-Za-z]\w*)/g)) {
    if (!m[1].endsWith('_')) used.add(m[1]);
  }
  for (const m of text.matchAll(/msg\([^)]*\? '(\w+)' : '(\w+)'/g)) used.add(m[1]).add(m[2]);
  for (const m of text.matchAll(/msg\(`(\w+)_\$\{/g)) {
    for (const key of Object.keys(messages.en)) if (key.startsWith(`${m[1]}_`)) used.add(key);
  }
}

let failed = false;
const enKeys = Object.keys(messages.en).sort().join();
for (const [locale, table] of Object.entries(messages)) {
  if (Object.keys(table).sort().join() !== enKeys) {
    console.error(`_locales/${locale} does not have the same keys as _locales/en`);
    failed = true;
  }
  for (const key of used) {
    if (!table[key]) {
      console.error(`missing message "${key}" in _locales/${locale}`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log(`check ok: ${sources.length + dashboard.length + server.length} scripts, ${used.size} message keys, locales ${locales.join(', ')}`);
