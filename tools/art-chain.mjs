// Read every Twonk's art from the blockchain and check Twetch's copy against it.
// A record's image is "b://<txid>": a B protocol file (OP_RETURN pushes: the B prefix, the file bytes, its media
// type, encoding, name) stored in that transaction. This reads the file from WhatsOnChain (20 transactions per
// call), takes its sha256, and compares it with the image Twetch serves for the same id (api.twetch.com/v1/media).
// The art scans then read the chain's bytes, and public/data/art/<slug>.json publishes { number: sha256 } so anyone
// can confirm which picture was judged.
// Run: node tools/art-chain.mjs <slug,...|all> [--cache D:/_twonk-chain]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { outputs, returnPushes } from '../public/chain.js';

const args = process.argv.slice(2);
const want = args[0] && !args[0].startsWith('--') ? args[0] : 'all';
const cache = args.includes('--cache') ? args[args.indexOf('--cache') + 1] : 'D:/_twonk-chain';
const B = '19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut';
const DATA = new URL('../public/data/', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash('sha256').update(b).digest('hex');
const dec = new TextDecoder();

async function getJson(url, init, tries = 5) {
  for (let k = 1; ; k++) {
    try {
      const r = await fetch(url, init);
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { final: true });
      return await r.json();
    } catch (e) {
      if (e.final || k >= tries) throw e;
      await sleep(3000 * k);
    }
  }
}

/** The B file in a raw transaction: { bytes, type, name } or null when the transaction holds none. */
export function bFile(txHex) {
  for (const o of outputs(txHex)) {
    const p = returnPushes(o.script);
    const at = p.findIndex((x) => dec.decode(x) === B);
    if (at >= 0 && p[at + 1]) return { bytes: p[at + 1], type: p[at + 2] ? dec.decode(p[at + 2]) : null, name: p[at + 4] ? dec.decode(p[at + 4]) : null };
  }
  return null;
}

/** The art for each txid, from the cache (D:/_twonk-chain/b/<txid>.bin + .json) or WhatsOnChain. */
async function chainArt(txids) {
  const dir = `${cache}/b`;
  await mkdir(dir, { recursive: true });
  const missing = txids.filter((id) => !existsSync(`${dir}/${id}.json`));
  for (let i = 0; i < missing.length; i += 20) {
    const res = await getJson('https://api.whatsonchain.com/v1/bsv/main/txs/hex', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txids: missing.slice(i, i + 20) }),
    });
    for (const r of res) {
      const f = r.hex && !r.error ? bFile(r.hex) : null;
      if (f) await writeFile(`${dir}/${r.txid}.bin`, f.bytes);
      await writeFile(`${dir}/${r.txid}.json`, JSON.stringify(f ? { sha256: sha(f.bytes), size: f.bytes.length, type: f.type, name: f.name } : { missing: r.error || 'no B file' }));
    }
    if ((i / 20) % 25 === 0) console.error(`  ${Math.min(i + 20, missing.length)} of ${missing.length} read from chain`);
    await sleep(450);
  }
  const out = new Map();
  for (const id of txids) out.set(id, JSON.parse(await readFile(`${dir}/${id}.json`, 'utf8')));
  return out;
}

/** sha256 of Twetch's copy, from the art scans' cache when present, else downloaded (not kept). */
async function twetchSha(slug, n, id) {
  for (const ext of ['png', 'img']) {
    const f = `D:/_twonk-art/${slug}/${n}.${ext}`;
    if (existsSync(f)) return sha(await readFile(f));
  }
  for (let k = 1; k <= 4; k++) {
    const r = await fetch(`https://api.twetch.com/v1/media/${id}`);
    if (r.ok) return sha(Buffer.from(await r.arrayBuffer()));
    await sleep(2000 * k);
  }
  return null;
}

const index = JSON.parse(await readFile(new URL('index.json', DATA), 'utf8'));
await mkdir(new URL('art/', DATA), { recursive: true });
for (const f of index.fleets) {
  if (want !== 'all' && !want.split(',').includes(f.slug)) continue;
  const d = JSON.parse(await readFile(new URL(`${f.c}.json`, DATA), 'utf8'));
  const rows = d.tok.filter((r) => r[3]);
  const art = await chainArt([...new Set(rows.map((r) => r[3]))]);
  const manifest = {}, differ = [], missing = [];
  let compared = 0;
  for (const r of rows) {
    const a = art.get(r[3]);
    if (!a.sha256) { missing.push(r[0]); continue; }
    manifest[r[0]] = a.sha256;
    const t = await twetchSha(f.slug, r[0], r[3]);
    if (t == null) continue;
    compared++;
    if (t !== a.sha256) differ.push(r[0]);
  }
  await writeFile(new URL(`art/${f.slug}.json`, DATA), JSON.stringify({ checked: new Date().toISOString().slice(0, 10), sha256: manifest }));
  console.log(`${f.name.padEnd(18)} images ${String(rows.length).padStart(5)}  on chain ${String(Object.keys(manifest).length).padStart(5)}  compared with Twetch ${String(compared).padStart(5)}  DIFFERENT ${differ.length}${differ.length ? ` (${differ.slice(0, 10).join(', ')})` : ''}  not on chain ${missing.length}${missing.length ? ` (${missing.slice(0, 10).join(', ')})` : ''}`);
}
