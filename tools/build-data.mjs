// Build public/data from Tetro's baked fleets: one true-rarity file per collection plus index.json.
// No network: Tetro's bake (tools/bake-twonks.mjs in the Tetro project) already read Twetch once.
// Run: node tools/build-data.mjs [path to tetro]
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { trueFleet } from './true-rank.mjs';
import { SHARE_BUCKET } from '../src/card.mjs';

const TETRO = process.argv[2] || process.env.TETRO || fileURLToPath(new URL('../../tetro', import.meta.url));
const SRC = join(TETRO, 'public/fleet');
const OUT = new URL('../public/data/', import.meta.url);
// Tetro's own logic decides which formula reproduces Twetch's order for each fleet (Node strips the types)
const { decodeFleet, readMethod, slug } = await import(pathToFileURL(join(TETRO, 'src/lib/twonks.ts')).href);

const raws = [];
for (const f of await readdir(SRC)) if (f.endsWith('.json') && f !== 'index.json') raws.push(JSON.parse(await readFile(join(SRC, f), 'utf8')));
const byName = new Map(raws.map((r) => [r.name, r]));

// Burned numbers come from Twetch's own "consumed" flag (tools/bake-burned.mjs). A burned frog that lives on
// in Graveyard or Apu Cartel keeps its number there, so the page can say where it went.
const consumed = JSON.parse(await readFile(new URL('./burned.json', import.meta.url), 'utf8'));
const successors = { 'Frog Cartel': ['Graveyard', 'Apu Cartel'] };
const burnedIn = new Map();
for (const raw of raws) {
  const gone = consumed[raw.c]; if (!gone) continue;
  const next = (successors[raw.name] || []).map((n) => byName.get(n)).filter(Boolean).map((d) => [d.name, new Set(d.tok.map((r) => r[0]))]);
  burnedIn.set(raw.name, new Map(gone.map((num) => [num, next.filter(([, s]) => s.has(num)).map(([n]) => n).join(' + ') || ''])));
}

await mkdir(OUT, { recursive: true });
// Share cards: the Worker on /t/<slug>/<number> reads one small bucket of 100 Twonks, never a whole collection,
// so it stays far inside the free plan's CPU time. A bucket holds only what the card shows, never the true rank.
const SHARE = new URL('../public/s/', import.meta.url);
await rm(SHARE, { recursive: true, force: true });
const index = [];
for (const raw of raws.sort((a, b) => a.name.localeCompare(b.name))) {
  if (!raw.tok.length || !raw.types.length) continue;
  const best = readMethod(decodeFleet(raw)).best;
  const doc = trueFleet(raw, { method: best ? best.method : 'info', burned: burnedIn.get(raw.name) });
  if (doc.n < 2) continue;
  const body = JSON.stringify(doc);
  await writeFile(new URL(`${raw.c}.json`, OUT), body);
  const lead = doc.tok.find((r) => r[0] === doc.top[0]);
  index.push({ c: raw.c, name: raw.name, slug: slug(raw.name), n: doc.n, ranked: doc.twetchOf > 0, method: doc.method, icon: lead ? lead[3] : null });
  const buckets = new Map();
  for (const r of doc.tok) {
    // no true rank and not burned: no traits on Twetch, so the link gets the plain site card
    if (!r[2] && doc.burned[r[0]] === undefined) continue;
    const k = Math.floor(r[0] / SHARE_BUCKET);
    if (!buckets.has(k)) buckets.set(k, {});
    // [name, image, Twetch's place or 0, of how many, burned]
    const label = `${raw.name} #${r[0]}`;
    buckets.get(k)[r[0]] = [doc.names[r[0]] ? `${doc.names[r[0]]} (${label})` : label, r[3] || '', r[4], doc.twetchOf, doc.burned[r[0]] !== undefined ? 1 : 0];
  }
  const dir = new URL(`${slug(raw.name)}/`, SHARE);
  await mkdir(dir, { recursive: true });
  for (const [k, b] of buckets) await writeFile(new URL(`${k}.json`, dir), JSON.stringify(b));
  console.log(`${raw.name.padEnd(20)} ${String(doc.n).padStart(6)} alive  ${doc.method}  top ${doc.top.join(', ')}  ${(body.length / 1024).toFixed(0)} KB`);
}
await writeFile(new URL('index.json', OUT), JSON.stringify({ v: 1, at: Math.max(...raws.map((r) => r.at)), fleets: index }));
