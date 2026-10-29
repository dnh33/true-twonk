// Follow Twonks from their mint to now on the blockchain alone, and compare where the chain ends with the output
// Twetch calls current. tools/chain-check.mjs reads the output Twetch names; this checks Twetch's pointer itself.
// For each Twonk: start at the mint output (Twetch's collection list; its record must carry the Twonk's number), ask
// WhatsOnChain which transaction spent it, find the output in that transaction whose record carries the same number,
// and repeat until an output is unspent. All Twonks advance one step at a time, so each step is a few bulk calls.
// Still trusted: that the mint transaction in Twetch's list is the collection's real mint (its record is checked, the
// minting key is not).
// Run: node tools/lineage-check.mjs [per collection, default 18] [extra slug/number ...] [--cache D:/_twonk-chain]
// Writes audit/lineage-check.json.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { outputs, scriptRecord } from '../public/chain.js';

const args = process.argv.slice(2);
const cache = args.includes('--cache') ? args[args.indexOf('--cache') + 1] : 'D:/_twonk-chain';
const per = /^\d+$/.test(args[0] || '') ? +args[0] : 18;
const extra = args.filter((a) => /^[a-z0-9-]+\/\d+$/.test(a)); // slug/number, always walked (e.g. the stale ones)
const DATA = new URL('../public/data/', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date().toISOString().slice(0, 10);
const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

async function getJson(url, init, tries = 5) {
  for (let k = 1; ; k++) {
    try {
      const r = await fetch(url, init);
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { final: true });
      return await r.json();
    } catch (e) {
      if (e.final || k >= tries) throw e;
      await sleep(2000 * k);
    }
  }
}
const outpoint = (s) => {
  const m = String(s).match(/^([0-9a-f]{64})[_:](\d+)$/i);
  if (m) return { tx: m[1].toLowerCase(), vout: +m[2] };
  if (!/^[0-9a-f]{72}$/i.test(s)) throw new Error(`unknown outpoint format: ${s}`);
  return { tx: s.slice(0, 64).match(/../g).reverse().join(''), vout: parseInt(s.slice(64, 72).match(/../g).reverse().join(''), 16) };
};

/** Parsed outputs per txid, from the cache or WhatsOnChain (20 per call). */
const parsed = new Map();
async function load(txids) {
  const missing = [];
  for (const id of new Set(txids)) {
    if (parsed.has(id)) continue;
    const f = `${cache}/${id}.hex`;
    if (existsSync(f)) { const h = await readFile(f, 'utf8'); parsed.set(id, h ? outputs(h) : null); } else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 20) {
    const res = await getJson(`${WOC}/txs/hex`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txids: missing.slice(i, i + 20) }) });
    for (const r of res) {
      const hex = r.hex && !r.error ? r.hex : '';
      await writeFile(`${cache}/${r.txid}.hex`, hex);
      parsed.set(r.txid, hex ? outputs(hex) : null);
    }
    await sleep(400);
  }
}

/** The txid that spent each "txid:vout", or '' while unspent (WhatsOnChain; a failed bulk answer is asked alone). */
async function spentBy(points) {
  const out = new Map();
  for (let i = 0; i < points.length; i += 20) {
    const utxos = points.slice(i, i + 20).map((p) => { const [txid, vout] = p.split(':'); return { txid, vout: +vout }; });
    const res = await getJson(`${WOC}/utxos/spent`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ utxos }) });
    for (const r of res) {
      const p = `${r.utxo.txid}:${r.utxo.vout}`;
      if (!r.error) { out.set(p, r.spentIn?.txid || ''); continue; }
      for (let k = 1; ; k++) {
        await sleep(1000 * k);
        const one = await fetch(`${WOC}/tx/${r.utxo.txid}/${r.utxo.vout}/spent`);
        if (one.status === 404) { out.set(p, ''); break; }
        if (one.ok) { out.set(p, (await one.json()).txid); break; }
        if (k >= 4) throw new Error(`spent lookup ${p}: ${r.error}, then HTTP ${one.status}`);
      }
    }
    await sleep(400);
  }
  return out;
}

/** The record in one output, or null. */
const recordAt = (tx, vout) => { const o = parsed.get(tx)?.[vout]; return o ? scriptRecord(o.script)?.json ?? null : null; };
/** The output of tx that carries this Twonk on: the record with its number; for a collection whose records store no
 *  number (Egg), the only output with a record of the same title. */
function carrier(tx, w) {
  const outs = parsed.get(tx) || [];
  const recs = outs.map((o, v) => ({ v, j: scriptRecord(o.script)?.json })).filter((x) => x.j);
  let hit = w.numbered ? recs.filter((x) => +x.j.number === w.n) : recs.filter((x) => x.j.title === w.title);
  // a frog's transformation writes "Dead Frog Cartel #1699" and "Apu Cartel #1699" in one transaction: the collection
  // name before the number tells them apart
  const kin = (title) => String(title).replace(/#\s*\d+\s*$/, '').trim();
  if (hit.length > 1) hit = hit.filter((x) => kin(x.j.title) === kin(w.title));
  return hit.length === 1 ? hit[0].v : hit.length ? -2 : -1; // -1: not carried on (consumed); -2: ambiguous
}

// a fixed sample, the same on every run: every collection, the Twonks with an on-chain record that are not burned
let seed = 20261029;
const rand = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const index = JSON.parse(await readFile(new URL('index.json', DATA), 'utf8'));
const burned = JSON.parse(await readFile(new URL('./burned.json', import.meta.url), 'utf8'));
const status = JSON.parse(await readFile(new URL('./chain-status.json', import.meta.url), 'utf8'));
const walks = [];
for (const f of index.fleets) {
  const list = (await getJson(`https://api.twetch.com/v1/market/collections/${f.c}/tokens?all=1`)).data;
  const skip = new Set([...(burned[f.c] || []), ...(status.notOnChain[f.c] || [])]);
  const pool = list.filter((t) => t.outpoint && !skip.has(t.number));
  const chosen = new Set(extra.filter((e) => e.startsWith(`${f.slug}/`)).map((e) => +e.split('/')[1]));
  const target = Math.min(chosen.size + per, new Set([...chosen, ...pool.map((t) => t.number)]).size);
  while (chosen.size < target) chosen.add(pool[Math.floor(rand() * pool.length)].number);
  for (const n of chosen) {
    const t = list.find((x) => x.number === n);
    walks.push({ c: f.c, slug: f.slug, name: f.name, n, mint: outpoint(t.outpoint), hops: 0, at: null, end: null, note: null });
  }
  await sleep(1500);
}
console.error(`${walks.length} Twonks to walk`);

// the mint: its record must carry the Twonk (its number, or for Egg the title)
await load(walks.map((w) => w.mint.tx));
for (const w of walks) {
  const j = recordAt(w.mint.tx, w.mint.vout);
  if (!j) { w.end = 'no record at mint'; continue; }
  w.numbered = j.number != null;
  w.title = j.title;
  if (w.numbered && +j.number !== w.n) { w.end = `mint record is #${j.number}`; continue; }
  w.at = `${w.mint.tx}:${w.mint.vout}`;
}

// walk, all together, one step at a time
for (let step = 1; step <= 300; step++) {
  const live = walks.filter((w) => !w.end);
  if (!live.length) break;
  const spent = await spentBy(live.map((w) => w.at));
  const moving = live.filter((w) => { if (spent.get(w.at)) return true; w.end = 'unspent'; return false; });
  await load(moving.map((w) => spent.get(w.at)));
  for (const w of moving) {
    const tx = spent.get(w.at), v = carrier(tx, w);
    if (v === -1) { w.end = 'consumed'; w.note = `spent in ${tx} with no output carrying it`; continue; }
    if (v === -2) { w.end = 'ambiguous'; w.note = `${tx} has more than one output that could carry it`; continue; }
    w.at = `${tx}:${v}`;
    w.title = recordAt(tx, v)?.title ?? w.title;
    w.hops++;
  }
  console.error(`step ${step}: ${walks.filter((w) => !w.end).length} still moving`);
}

// compare with Twetch's current output, asked now (a cached answer goes stale as soon as a Twonk is sold)
for (const w of walks) {
  const t = await getJson(`https://api.twetch.com/v1/tokens/${w.c}/${w.n}`, { headers: { Accept: 'application/json' } });
  w.twetch = t.state?.currentOutpoint || null;
  w.agrees = w.end === 'unspent' && w.at === w.twetch;
  await sleep(300);
}
const by = (test) => walks.filter(test);
const summary = {
  at: new Date().toISOString(), walked: walks.length,
  agree: by((w) => w.agrees).length,
  disagree: by((w) => w.end === 'unspent' && !w.agrees).map((w) => ({ slug: w.slug, n: w.n, chain: w.at, twetch: w.twetch, hops: w.hops })),
  stopped: by((w) => w.end !== 'unspent').map((w) => ({ slug: w.slug, n: w.n, end: w.end, note: w.note, at: w.at, twetch: w.twetch, hops: w.hops })),
  hops: { total: walks.reduce((s, w) => s + w.hops, 0), most: Math.max(...walks.map((w) => w.hops)) },
};
await mkdir(new URL('../audit/', import.meta.url), { recursive: true });
await writeFile(new URL('../audit/lineage-check.json', import.meta.url), JSON.stringify({ summary, walks }, null, 1));
console.log(JSON.stringify(summary, null, 1));
