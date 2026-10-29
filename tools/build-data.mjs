// Build public/data from Tetro's baked fleets: one true-rarity file per collection plus index.json.
// No network: Tetro's bake (tools/bake-twonks.mjs in the Tetro project) already read Twetch once.
// Run: node tools/build-data.mjs [path to tetro]
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { trueFleet, misspelled } from './true-rank.mjs';
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
// { collection address: { number: [[trait type, value on record, value the art shows], ...] } }
const artFlags = JSON.parse(await readFile(new URL('./art-flags.json', import.meta.url), 'utf8'));
const liveFlags = {}; // the flags whose records still match, per collection
// { collection address: { number: [[trait type, value on record, the Twonk's name]] } }: misspellings checked by eye
const spellingFlags = JSON.parse(await readFile(new URL('./spelling-flags.json', import.meta.url), 'utf8'));
// { "<slug>/<number>": { evidence, secondLook, ownerOk } }: a misprint reaches the site only after an independent second
// look agrees (given only the evidence, never the first verdict) and the owner has said yes
// { collection address: { number: [[upper type, value, lower type, value, what is odd]] } }: layer clashes, two parts that
// overlap oddly because of the drawing order. Not misprints (the record matches the art); same review gate.
const layerClashes = JSON.parse(await readFile(new URL('./layer-clashes.json', import.meta.url), 'utf8'));
const reviews = JSON.parse(await readFile(new URL('./misprint-reviews.json', import.meta.url), 'utf8'));
const approved = (fleetName, n) => {
  const r = reviews[`${fleetName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}/${n}`];
  if (r && /^agrees:/.test(r.secondLook || '') && r.ownerOk) return true;
  console.warn(`misprint held back: ${fleetName} #${n} needs an agreeing second look and the owner's OK in tools/misprint-reviews.json`);
  return false;
};
// { checked: date, notOnChain: { collection address: [numbers] } }: Twonks Twetch lists that are not on the blockchain;
// listingOnly: { collection address: [trait types] }: traits no on-chain record holds, shown and never ranked
const chainStatus = JSON.parse(await readFile(new URL('./chain-status.json', import.meta.url), 'utf8'));
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
  const doc = trueFleet(raw, { method: best ? best.method : 'info', burned: burnedIn.get(raw.name), listingOnly: chainStatus.listingOnly?.[raw.c] || [] });
  // art that disagrees with the on-chain record, checked by eye after tools/audit_art.py flagged it; shown, never ranked.
  // A note is kept only while the record still says what the note claims: if Twetch fixes a record, the note goes.
  doc.art = {};
  for (const [n, list] of Object.entries(artFlags[raw.c] || {})) {
    const row = doc.tok.find((r) => r[0] === +n);
    const still = row && list.filter(([type, record]) => {
      const t = doc.types.indexOf(type), v = t < 0 ? -1 : row[8 + t];
      return record === '(none)' ? v < 0 : v >= 0 && String(doc.traits[t][v][0]).trim() === record.trim();
    });
    if (still?.length === list.length && !approved(raw.name, n)) continue;
    if (still?.length === list.length) doc.art[n] = list;
    else console.warn(`art flag dropped: ${raw.name} #${n}, its record no longer says what tools/art-flags.json claims; re-run tools/audit_art.py`);
  }
  liveFlags[raw.c] = doc.art;
  // a record that misspells its own name in a trait (Rare Sirloins #736 "Snow Rabbit", Meat "Sow Rabbit"): shown, never
  // ranked. The rule only finds candidates: a near-miss can be a pun, so a hit is shown only once it is checked by eye
  // and listed in tools/spelling-flags.json, and only while the record still says it. { number: [[type, value, name]] }
  doc.spelling = {};
  for (const [n, name] of Object.entries(doc.names)) {
    const row = doc.tok.find((r) => r[0] === +n);
    const list = row ? doc.types.map((type, t) => [type, row[8 + t] >= 0 ? doc.traits[t][row[8 + t]][0] : null, name])
      .filter(([, value]) => value != null && misspelled(name, value)) : [];
    const reviewed = spellingFlags[raw.c]?.[n] || [];
    const shown = list.filter(([type, value]) => reviewed.some(([rt, rv]) => rt === type && rv === value));
    if (shown.length && approved(raw.name, n)) doc.spelling[n] = shown;
    if (shown.length < list.length) console.warn(`spelling candidate, not shown until checked by eye: ${raw.name} #${n} "${name}": ${list.filter((x) => !shown.includes(x)).map(([t, v]) => `${t} "${v}"`).join(', ')}; add it to tools/spelling-flags.json if it is a misprint`);
  }
  for (const [n, list] of Object.entries(spellingFlags[raw.c] || {})) {
    if (list.length !== (doc.spelling[n] || []).length) console.warn(`spelling flag dropped: ${raw.name} #${n}, its record no longer says what tools/spelling-flags.json claims`);
  }
  doc.clash = {};
  for (const [n, list] of Object.entries(layerClashes[raw.c] || {})) {
    const row = doc.tok.find((r) => r[0] === +n);
    const holds = (type, value) => { const t = doc.types.indexOf(type); return t >= 0 && row[8 + t] >= 0 && String(doc.traits[t][row[8 + t]][0]).trim() === value.trim(); };
    if (!row || !list.every(([a, av, b, bv]) => holds(a, av) && holds(b, bv))) { console.warn(`layer clash dropped: ${raw.name} #${n}, its record no longer holds the pair in tools/layer-clashes.json`); continue; }
    if (approved(raw.name, n)) doc.clash[n] = list;
  }
  doc.offChain = chainStatus.notOnChain[raw.c] || [];
  doc.chainChecked = chainStatus.checked;
  if (doc.n < 2) continue;
  const body = JSON.stringify(doc);
  await writeFile(new URL(`${raw.c}.json`, OUT), body);
  // the rarest one's picture, or the first one with a picture when nothing is ranked (Egg)
  const lead = doc.tok.find((r) => r[0] === doc.top[0]) || doc.tok.find((r) => r[3]);
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

// The misprints gallery: every reviewed record/art mismatch. "wrong" = the record names a trait the art does not show;
// "blank" = the record lists no traits at all while the art is a full Twonk (Twetch still prints a rank for it).
const misprints = [];
for (const [c, toks] of Object.entries(liveFlags)) {
  const fleet = index.find((f) => f.c === c);
  const doc = JSON.parse(await readFile(new URL(`${c}.json`, OUT), 'utf8'));
  for (const [n, list] of Object.entries(toks)) {
    const row = doc.tok.find((r) => r[0] === +n);
    const blank = list.every(([, record]) => record === '(none)');
    misprints.push({
      c, slug: fleet.slug, fleet: fleet.name, n: +n, name: doc.names[n] || `${fleet.name} #${n}`, image: row[3],
      twetch: row[1], kind: blank ? 'blank' : 'wrong', detail: blank ? [] : list,
      // a Signature 1-of-1 is drawn by hand, not from the standard parts: said with the misprint (owner, 29 Oct)
      custom: doc.types.some((type, t) => /signature/i.test(type) && row[8 + t] >= 0),
      // the side-by-side picture anyone can check (tools/evidence.py), when it has been made
      evidence: existsSync(new URL(`../public/evidence/${fleet.slug}-${n}.png`, import.meta.url)) ? `/evidence/${fleet.slug}-${n}.png` : null,
    });
  }
  for (const [n, list] of Object.entries(doc.clash || {})) {
    const row = doc.tok.find((r) => r[0] === +n);
    misprints.push({ c, slug: fleet.slug, fleet: fleet.name, n: +n, name: doc.names[n] || `${fleet.name} #${n}`, image: row[3], twetch: row[1], kind: 'clash', detail: list,
      evidence: existsSync(new URL(`../public/evidence/${fleet.slug}-${n}.png`, import.meta.url)) ? `/evidence/${fleet.slug}-${n}.png` : null });
  }
  // "spelling" = the record misspells its own name in a trait (found over every collection, not only the pixel-art ones)
  for (const [n, list] of Object.entries(doc.spelling || {})) {
    const row = doc.tok.find((r) => r[0] === +n);
    misprints.push({ c, slug: fleet.slug, fleet: fleet.name, n: +n, name: doc.names[n], image: row[3], twetch: row[1], kind: 'spelling', detail: list });
  }
}
const KINDS = ['wrong', 'spelling', 'blank', 'clash'];
misprints.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.fleet.localeCompare(b.fleet) || a.n - b.n);
// Twonks Twetch lists that are not on the blockchain (tools/chain-status.json, from tools/chain-check.mjs): not
// misprints, since there is no on-chain record to misprint; listed apart, with the date they were checked
const offChain = [];
for (const [c, nums] of Object.entries(chainStatus.notOnChain)) {
  const fleet = index.find((f) => f.c === c);
  if (!fleet) continue;
  const doc = JSON.parse(await readFile(new URL(`${c}.json`, OUT), 'utf8'));
  for (const n of nums) {
    const row = doc.tok.find((r) => r[0] === n);
    if (row) offChain.push({ c, slug: fleet.slug, fleet: fleet.name, n, name: doc.names[n] || `${fleet.name} #${n}`, image: row[3], twetch: row[1] });
  }
}
offChain.sort((a, b) => a.fleet.localeCompare(b.fleet) || a.n - b.n);
await writeFile(new URL('misprints.json', OUT), JSON.stringify({
  checked: ['Frog Cartel', 'Graveyard', 'Lizer Corp', 'Planetary Pixels', 'Rare Sirloins'], of: index.length, misprints,
  chainChecked: chainStatus.checked, offChain,
}));
