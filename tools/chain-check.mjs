// Check every Twonk's record on Twetch against the record written in its blockchain transaction.
// For each collection: Twetch's token list gives each Twonk's current output; WhatsOnChain gives the raw
// transaction (20 per request, about 2.5 requests a second, under its free limit of 3); public/chain.js reads
// the record out of it. Compared with the data the site ranks by (public/data): every trait value, and the rank
// stored on chain against the rank Twetch prints.
// Transactions are cached in the cache folder, so a stopped run resumes where it was.
// Run: node tools/chain-check.mjs [collection slug,...|all] [--cache D:/_twonk-chain]
// Writes audit/chain-check.json and prints a summary per collection.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chainRecord } from '../public/chain.js';

const args = process.argv.slice(2);
const want = args[0] && !args[0].startsWith('--') ? args[0] : 'all';
const cache = args.includes('--cache') ? args[args.indexOf('--cache') + 1] : 'D:/_twonk-chain';
const DATA = new URL('../public/data/', import.meta.url);
const OUT = new URL('../audit/', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = 8; // value indexes start after 8 fields in a site token row

/** Twetch's list outpoint comes two ways: "txid_vout" (Comfy Sweatpants), or 72 hex characters: the txid in
 *  reversed byte order, then the output number as 4 little-endian bytes (Frog Cartel). */
const outpoint = (s) => {
  const m = String(s).match(/^([0-9a-f]{64})[_:](\d+)$/i);
  if (m) return { tx: m[1].toLowerCase(), vout: +m[2] };
  if (!/^[0-9a-f]{72}$/i.test(s)) throw new Error(`unknown outpoint format: ${s}`);
  return { tx: s.slice(0, 64).match(/../g).reverse().join(''), vout: parseInt(s.slice(64, 72).match(/../g).reverse().join(''), 16) };
};

async function getJson(url, init, tries = 4) {
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

/** Raw hex for each txid, from the cache or WhatsOnChain; null for a txid the chain does not know. */
async function txHex(txids) {
  const out = new Map();
  const missing = [];
  for (const id of txids) {
    const f = `${cache}/${id}.hex`;
    if (existsSync(f)) out.set(id, (await readFile(f, 'utf8')) || null);
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += 20) {
    const batch = missing.slice(i, i + 20);
    const res = await getJson('https://api.whatsonchain.com/v1/bsv/main/txs/hex', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txids: batch }),
    });
    for (const r of res) {
      const hex = r.hex && !r.error ? r.hex : '';
      out.set(r.txid, hex || null);
      await writeFile(`${cache}/${r.txid}.hex`, hex); // empty file = the chain does not know it
    }
    await sleep(400);
  }
  return out;
}

const norm = (v) => String(v ?? '').trim();

async function check(fleet) {
  const d = JSON.parse(await readFile(new URL(`${fleet.c}.json`, DATA), 'utf8'));
  const list = (await getJson(`https://api.twetch.com/v1/market/collections/${fleet.c}/tokens?all=1`)).data;
  const where = new Map(list.filter((t) => t.outpoint).map((t) => [t.number, outpoint(t.outpoint)]));
  const hex = await txHex([...new Set([...where.values()].map((o) => o.tx))]);
  const res = { name: d.name, listed: list.length, onChain: 0, notOnChain: [], noRecord: [], traitDiffs: [], rankDiffs: [], extraTypes: new Set() };
  for (const row of d.tok) {
    const n = row[0], at = where.get(n);
    const h = at && hex.get(at.tx);
    if (!h) { res.notOnChain.push(n); continue; }
    let rec = null;
    try { rec = chainRecord(h, at.vout); } catch { /* unreadable transaction: counted as no record */ }
    if (!rec) { res.noRecord.push(n); continue; }
    res.onChain++;
    const chain = new Map((rec.json.attributes || []).map((a) => [norm(a.trait_type), norm(a.value)]));
    for (let t = 0; t < d.types.length; t++) {
      const v = row[T0 + t];
      const ours = v >= 0 ? norm(d.traits[t][v][0]) : null;
      const theirs = chain.has(norm(d.types[t])) ? chain.get(norm(d.types[t])) : null;
      if (ours !== theirs) res.traitDiffs.push({ n, type: d.types[t], site: ours, chain: theirs });
    }
    for (const k of chain.keys()) if (!d.types.some((t) => norm(t) === k)) res.extraTypes.add(k);
    const printed = row[1] || null, stored = rec.json.rank ?? null;
    if (printed !== stored && !(printed == null && stored == null)) res.rankDiffs.push({ n, twetch: printed, chain: stored });
  }
  res.extraTypes = [...res.extraTypes];
  // a Twonk the chain does not know must also be one Twetch marks pending; anything else is a lookup to re-check
  res.notOnChain = await Promise.all(res.notOnChain.map(async (n, k) => {
    await sleep(k * 300);
    const tok = await getJson(`https://api.twetch.com/v1/tokens/${fleet.c}/${n}`).catch(() => null);
    return { n, pending: tok ? !!tok.pending : null, owner: tok?.ownerUser?.id ?? null };
  }));
  res.unexplained = res.notOnChain.filter((x) => x.pending !== true).map((x) => x.n);
  return res;
}

const index = JSON.parse(await readFile(new URL('index.json', DATA), 'utf8'));
await mkdir(cache, { recursive: true });
await mkdir(OUT, { recursive: true });
const report = { at: new Date().toISOString(), collections: [] };
for (const f of index.fleets) {
  if (want !== 'all' && !want.split(',').includes(f.slug)) continue;
  try {
    const r = await check(f);
    report.collections.push(r);
    console.log(`${r.name.padEnd(18)} listed ${String(r.listed).padStart(5)}  on chain ${String(r.onChain).padStart(5)}  not on chain ${String(r.notOnChain.length).padStart(4)}${r.unexplained.length ? ` (${r.unexplained.length} NOT pending)` : ""}  no record ${String(r.noRecord.length).padStart(4)}  trait diffs ${String(r.traitDiffs.length).padStart(5)}  rank diffs ${String(r.rankDiffs.length).padStart(5)}${r.extraTypes.length ? `  types only on chain: ${r.extraTypes.join(', ')}` : ''}`);
  } catch (e) {
    report.collections.push({ name: f.name, error: e.message });
    console.log(`${f.name.padEnd(18)} ERROR ${e.message}`);
  }
  await writeFile(new URL('chain-check.json', OUT), JSON.stringify(report, null, 1));
  await sleep(1500);
}
