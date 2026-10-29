// Check every Twonk's record on Twetch against the record written in its blockchain transaction.
// For each collection: Twetch's token API gives each Twonk's current output (--mint: the collection list's mint
// output instead); WhatsOnChain gives the raw
// transaction (20 per request, about 2.5 requests a second, under its free limit of 3); public/chain.js reads
// the record out of it. Compared with the data the site ranks by (public/data): every trait value, and the rank
/// stored on chain against the rank Twetch prints. Twetch's pointer is checked too: the output it calls current
// must be unspent on chain (WhatsOnChain's spent lookup) and its record must carry the Twonk's number.
// Transactions are cached in the cache folder, so a stopped run resumes where it was.
// Run: node tools/chain-check.mjs [collection slug,...|all] [--cache D:/_twonk-chain]
// Writes audit/chain-check.json and prints a summary per collection.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { outputs, scriptRecord, traitsOf } from '../public/chain.js';

const args = process.argv.slice(2);
const want = args[0] && !args[0].startsWith('--') ? args[0] : 'all';
const cache = args.includes('--cache') ? args[args.indexOf('--cache') + 1] : 'D:/_twonk-chain';
const DATA = new URL('../public/data/', import.meta.url);
const OUT = new URL('../audit/', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const T0 = 8; // value indexes start after 8 fields in a site token row
const current = !args.includes('--mint'); // default: each Twonk's current record; --mint reads the minted ones
const today = new Date().toISOString().slice(0, 10);

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

/** For each outpoint "txid:vout", the txid that spent it on chain, or '' while unspent: WhatsOnChain's own answer,
 *  not Twetch's. An output Twetch calls current that is already spent means Twetch points at a stale record.
 *  Cached per day and collection. */
async function spentBy(c, points) {
  const f = `${cache}/spent-${today}-${c}.json`;
  const out = existsSync(f) ? new Map(Object.entries(JSON.parse(await readFile(f, 'utf8')))) : new Map();
  const todo = points.filter((p) => !out.has(p));
  for (let i = 0; i < todo.length; i += 20) {
    const utxos = todo.slice(i, i + 20).map((p) => { const [txid, vout] = p.split(':'); return { txid, vout: +vout }; });
    const res = await getJson('https://api.whatsonchain.com/v1/bsv/main/utxos/spent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ utxos }),
    });
    for (const r of res) {
      const p = `${r.utxo.txid}:${r.utxo.vout}`;
      if (!r.error) { out.set(p, r.spentIn?.txid || ''); continue; }
      // the bulk call sometimes answers "Unable to get spent info" for one output; ask for it alone (404 = unspent)
      for (let k = 1; ; k++) {
        await sleep(1000 * k);
        const one = await fetch(`https://api.whatsonchain.com/v1/bsv/main/tx/${r.utxo.txid}/${r.utxo.vout}/spent`);
        if (one.status === 404) { out.set(p, ''); break; }
        if (one.ok) { out.set(p, (await one.json()).txid); break; }
        if (k >= 4) throw new Error(`spent lookup ${p}: ${r.error}, then HTTP ${one.status}`);
      }
    }
    await sleep(400);
  }
  await writeFile(f, JSON.stringify(Object.fromEntries(out)));
  return out;
}

/** Twetch's token record for each number: { o: current outpoint "txid:vout", pending, owner }, or null when the
 *  lookup failed. Cached per day (a Twonk's output moves when it changes hands), so a stopped run resumes.
 *  Four lookups in flight, each worker pausing between calls: about 5 a second. */
async function tokenStates(c, nums) {
  const dir = `${cache}/tok-${today}/${c}`;
  await mkdir(dir, { recursive: true });
  const out = new Map();
  let next = 0, done = 0;
  const work = async () => {
    while (next < nums.length) {
      const n = nums[next++], f = `${dir}/${n}.json`;
      if (existsSync(f)) { out.set(n, JSON.parse(await readFile(f, 'utf8'))); continue; }
      const tok = await getJson(`https://api.twetch.com/v1/tokens/${c}/${n}`, { headers: { Accept: 'application/json' } }).catch(() => null);
      const s = tok ? { o: tok.state?.currentOutpoint || null, pending: !!tok.pending, owner: tok.ownerUser?.id ?? null } : null;
      out.set(n, s);
      if (s) await writeFile(f, JSON.stringify(s));
      if (++done % 500 === 0) console.error(`  ${c.slice(0, 8)}: ${done} looked up`);
      await sleep(600);
    }
  };
  await Promise.all([work(), work(), work(), work()]);
  return out;
}

async function check(fleet) {
  const d = JSON.parse(await readFile(new URL(`${fleet.c}.json`, DATA), 'utf8'));
  const list = (await getJson(`https://api.twetch.com/v1/market/collections/${fleet.c}/tokens?all=1`)).data;
  // the list's outpoint is where the Twonk was minted; once it changes hands its record lives in a later output
  const where = new Map(list.filter((t) => t.outpoint).map((t) => [t.number, outpoint(t.outpoint)]));
  const state = new Map();
  if (current) {
    const got = await tokenStates(fleet.c, d.tok.map((r) => r[0]));
    for (const [n, s] of got) {
      state.set(n, s);
      if (s?.o) { const [tx, vout] = s.o.split(':'); where.set(n, { tx, vout: +vout }); } else if (s) where.delete(n); // Twetch names no output
    }
  }
  const hex = await txHex([...new Set([...where.values()].map((o) => o.tx))]);
  const res = {
    c: fleet.c, name: d.name, read: current ? 'current output (Twetch token API)' : 'mint output (Twetch collection list)',
    listed: list.length, onChain: 0, notOnChain: [], noRecord: [], lookupFailed: d.tok.filter((r) => current && !state.get(r[0])).map((r) => r[0]),
    traitDiffs: [], // both have the trait, with different values
    offChainTraits: {}, // per trait type: how many Twonks have it on the site but not in their on-chain record
    rankDiffs: [], noStoredRank: 0, extraTypes: new Set(),
    wrongTwonk: [], // the record in the output Twetch names carries another number
    noNumber: 0, // records that store no number (Egg), so the output cannot be tied to the Twonk by its record
    spent: [], spentBurned: 0, // outputs Twetch calls current that the chain says are already spent
  };
  if (current) {
    const alive = d.tok.map((r) => r[0]).filter((n) => where.has(n) && hex.get(where.get(n).tx));
    const spent = await spentBy(fleet.c, alive.map((n) => `${where.get(n).tx}:${where.get(n).vout}`));
    const gone = new Set(burned[fleet.c] || []);
    for (const n of alive) {
      const by = spent.get(`${where.get(n).tx}:${where.get(n).vout}`);
      if (!by) continue;
      if (gone.has(n)) res.spentBurned++;
      else res.spent.push({ n, by });
    }
  }
  const parsed = new Map();
  for (const row of d.tok) {
    const n = row[0], at = where.get(n);
    const h = at && hex.get(at.tx);
    if (!h) { res.notOnChain.push(n); continue; }
    let rec = null;
    try {
      // parse each transaction once: one NOOGIES transaction (5.8 MB) holds all 10,000
      if (!parsed.has(at.tx)) parsed.set(at.tx, outputs(h));
      const out = parsed.get(at.tx)[at.vout];
      rec = out ? scriptRecord(out.script) : null;
    } catch { /* unreadable transaction: counted as no record */ }
    if (!rec) { res.noRecord.push(n); continue; }
    res.onChain++;
    if (rec.json.number == null) res.noNumber++;
    else if (+rec.json.number !== n) res.wrongTwonk.push({ n, record: rec.json.number });
    const chain = new Map(traitsOf(rec.json).map((a) => [norm(a.type), norm(a.value)]));
    for (let t = 0; t < d.types.length; t++) {
      const v = row[T0 + t];
      const ours = v >= 0 ? norm(d.traits[t][v][0]) : null;
      const theirs = chain.has(norm(d.types[t])) ? chain.get(norm(d.types[t])) : null;
      if (ours === theirs) continue;
      if (ours !== null && theirs === null) res.offChainTraits[d.types[t]] = (res.offChainTraits[d.types[t]] || 0) + 1;
      else res.traitDiffs.push({ n, type: d.types[t], site: ours, chain: theirs });
    }
    for (const k of chain.keys()) if (!d.types.some((t) => norm(t) === k)) res.extraTypes.add(k);
    const printed = row[1] || null, stored = rec.json.rank ?? null;
    if (stored == null) res.noStoredRank++;
    else if (printed !== stored) res.rankDiffs.push({ n, twetch: printed, chain: stored });
  }
  res.extraTypes = [...res.extraTypes];
  // trait types the site shows that no on-chain record in the collection holds (Egg's Color): never ranked
  res.listingOnly = Object.entries(res.offChainTraits).filter(([, k]) => res.onChain > 0 && k === res.onChain).map(([t]) => t);
  // a Twonk the chain does not know must also be one Twetch marks pending; anything else is a lookup to re-check
  const known = current ? state : await tokenStates(fleet.c, res.notOnChain);
  // a burned Twonk (Twetch: consumed, e.g. used up in a vaccination) can have no current output either: it was on
  // chain, so it is not "not on chain". The site already shows it as burned (tools/burned.json).
  const gone = new Set(burned[fleet.c] || []);
  res.burnedNoOutput = res.notOnChain.filter((n) => gone.has(n));
  res.notOnChain = res.notOnChain.filter((n) => !gone.has(n))
    .map((n) => ({ n, pending: known.get(n)?.pending ?? null, owner: known.get(n)?.owner ?? null }));
  res.unexplained = res.notOnChain.filter((x) => x.pending !== true).map((x) => x.n);
  return res;
}

const index = JSON.parse(await readFile(new URL('index.json', DATA), 'utf8'));
const burned = JSON.parse(await readFile(new URL('./burned.json', import.meta.url), 'utf8'));
await mkdir(cache, { recursive: true });
await mkdir(OUT, { recursive: true });
const report = { at: new Date().toISOString(), collections: [] };
for (const f of index.fleets) {
  if (want !== 'all' && !want.split(',').includes(f.slug)) continue;
  try {
    const r = await check(f);
    report.collections.push(r);
    const off = Object.entries(r.offChainTraits).map(([t, k]) => `${t} ${k}`).join(', ');
    console.log(`${r.name.padEnd(18)} listed ${String(r.listed).padStart(5)}  on chain ${String(r.onChain).padStart(5)}  not on chain ${String(r.notOnChain.length).padStart(4)}${r.unexplained.length ? ` (${r.unexplained.length} NOT pending)` : ''}${r.burnedNoOutput.length ? `  burned, no output ${r.burnedNoOutput.length}` : ''}  no record ${String(r.noRecord.length).padStart(4)}${r.lookupFailed.length ? `  LOOKUP FAILED ${r.lookupFailed.length}` : ''}  value diffs ${String(r.traitDiffs.length).padStart(4)}  rank diffs ${String(r.rankDiffs.length).padStart(4)}${r.noStoredRank ? `  no stored rank ${r.noStoredRank}` : ''}${r.spent?.length ? `  STALE (output already spent) ${r.spent.length}` : ''}${r.spentBurned ? `  burned, output spent ${r.spentBurned}` : ''}${r.wrongTwonk.length ? `  WRONG TWONK ${r.wrongTwonk.length}` : ''}${r.noNumber ? `  no number on record ${r.noNumber}` : ''}${off ? `  site-only traits: ${off}` : ''}${r.extraTypes.length ? `  types only on chain: ${r.extraTypes.map((t) => JSON.stringify(t)).join(', ')}` : ''}`);
  } catch (e) {
    report.collections.push({ c: f.c, name: f.name, error: e.message });
    console.log(`${f.name.padEnd(18)} ERROR ${e.message}`);
  }
  await writeFile(new URL('chain-check.json', OUT), JSON.stringify(report, null, 1));
  await sleep(1500);
}

// A complete, clean run refreshes the list the site shows (tools/chain-status.json): every Twonk the chain does not
// know and Twetch marks pending. A run with errors or unexplained misses leaves the list as it was.
const clean = want === 'all' && report.collections.every((c) => !c.error && !c.unexplained.length && !c.lookupFailed.length && !c.wrongTwonk.length);
// a stale pointer (Twetch names an output the chain says is spent: Egg #1193 since 2023, or a Twonk sold during the
// hours a run takes) is a finding to report, not a reason to keep the not-on-chain list from updating
const stale = report.collections.flatMap((c) => (c.spent || []).map((s) => `${c.name} #${s.n}`));
if (stale.length) console.log(`stale pointers (Twetch names a spent output; re-check, sales during the run show here too): ${stale.join(', ')}`);
if (clean) {
  const notOnChain = {}, listingOnly = {};
  for (const c of report.collections) {
    const nums = c.notOnChain.filter((x) => x.pending).map((x) => x.n);
    if (nums.length) notOnChain[c.c] = nums;
    if (c.listingOnly.length) listingOnly[c.c] = c.listingOnly;
  }
  await writeFile(new URL('./chain-status.json', import.meta.url), `${JSON.stringify({
    checked: report.at.slice(0, 10),
    how: 'Twetch token API marks it pending with no owner, and WhatsOnChain does not know its transaction (tools/chain-check.mjs)',
    notOnChain,
    // trait types in Twetch's listing that no on-chain record of the collection holds: shown, never ranked
    listingOnly,
  }, null, 1)}\n`);
  console.log(`tools/chain-status.json refreshed: ${Object.values(notOnChain).flat().length} Twonks not on chain`);
} else if (want === 'all') console.log('tools/chain-status.json NOT refreshed: the run had errors, unexplained misses, failed lookups or records carrying another number');
