// Fast sanity check: every script parses, the manifest and locales are valid JSON,
// and every message key used in code exists in both locales.
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const sources = readdirSync('src').filter((f) => f.endsWith('.js')).map((f) => `src/${f}`);
for (const file of sources) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const locales = readdirSync('_locales');
const messages = Object.fromEntries(
  locales.map((l) => [l, JSON.parse(readFileSync(`_locales/${l}/messages.json`, 'utf8'))]),
);

const used = new Set();
const code = [...sources.map((f) => readFileSync(f, 'utf8')), readFileSync('src/options.html', 'utf8'), JSON.stringify(manifest)];
for (const text of code) {
  for (const m of text.matchAll(/(?:(?:msg|setStatus|stop)\(['`]|data-i18n="|__MSG_)([A-Za-z]\w*)/g)) {
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
}
for (const [locale, table] of Object.entries(messages)) {
  for (const key of used) {
    if (!table[key]) {
      console.error(`missing message "${key}" in _locales/${locale}`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
console.log(`check ok: ${sources.length} scripts, ${used.size} message keys, locales ${locales.join(', ')}`);
