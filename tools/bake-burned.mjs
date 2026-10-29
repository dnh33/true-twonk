// Which Twonks are burned ("consumed" in Twetch's token list), for the collections that have any.
// Tetro's bake keeps traits and ranks but drops this flag, so it is read here once, at build time:
// one collection list, then one full token list per collection with burns, one at a time with a pause.
// Writes tools/burned.json: { <contract>: [numbers] }. Run: node tools/bake-burned.mjs
import { writeFile } from 'node:fs/promises';

const API = 'https://api.twetch.com/v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(path) {
  for (let a = 0; ; a++) {
    const r = await fetch(API + path);
    if (r.ok) return r.json();
    if (a >= 4 || ![429, 500, 502, 503, 504].includes(r.status)) throw new Error(`${path} answered ${r.status}`);
    await sleep(2000 * 2 ** a);
  }
}

const out = {};
for (const col of (await get('/market/collections?limit=100')).data) {
  if (!(col.burned > 0)) continue;
  const all = (await get(`/market/collections/${col.contractAddress}/tokens?all=1`)).data;
  const gone = all.filter((t) => t.consumed).map((t) => t.number).sort((a, b) => a - b);
  out[col.contractAddress] = gone;
  console.log(`${col.name.padEnd(20)} Twetch says ${col.burned} burned, list marks ${gone.length}`);
  await sleep(1500);
}
await writeFile(new URL('burned.json', import.meta.url), JSON.stringify(out));
