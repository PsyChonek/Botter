// Checks the casino's live app bundle (or a saved copy) against the client
// tables the bot's models copy (src/bundle.js) and prints what differs. Exits
// with 1 when a model is stale, so it can gate a model rebuild.
// Usage: node scripts/bundle.mjs [path to a saved index-*.js]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const B = require('../src/bundle.js');
const G = require('../src/games.js');
const O = require('../src/odds.js');
const SITE = 'https://skeleton-casino.vercel.app';

async function load(path) {
  if (path) return { name: B.bundleName(`/assets/${path.split(/[\\/]/).at(-1)}`) ?? path, text: readFileSync(path, 'utf8') };
  const page = await (await fetch(`${SITE}/`)).text();
  const src = /src="(\/assets\/index-[\w-]+\.js)"/.exec(page)?.[1];
  if (!src) throw new Error('no app bundle in the page');
  const res = await fetch(SITE + src);
  if (!res.ok) throw new Error(`${src}: HTTP ${res.status}`);
  return { name: B.bundleName(src), text: await res.text() };
}

const { name, text } = await load(process.argv[2]);
const { facts, problems } = B.check(text, G, O);
console.log(`bundle ${name}, changelog ${facts.changelog ?? 'not found'}`);
console.log(`games: ${Object.entries(facts.games ?? {}).map(([game, unlock]) => `${game} ${unlock}${facts.soon?.includes(game) ? ' (soon)' : ''}`).join(', ')}`);
console.log(`${B.NEEDLES.length} model tables checked`);
if (problems.length) {
  console.log(`${problems.length} differences:`);
  for (const line of problems) console.log(`  ${line}`);
  process.exitCode = 1;
} else {
  console.log('every model table matches');
}
