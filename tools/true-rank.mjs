// True rarity for one baked fleet. Pure: takes Tetro's baked file, returns the compact file the page reads.
//
// The true rank is reached in three named steps from Twetch's own order, so the page can say which rule moved a
// Twonk and never passes a rule change off as a Twetch mistake:
//  1. counts: every count recounted from the Twonks themselves (Signature "1 of 1" is held by more than one frog;
//     a pooled fleet such as Graveyard is counted within itself instead of across all frogs);
//  2. every trait: traits Twetch leaves out of its rank (Graveyard's Vaccine Effect) are scored too; counts stored as
//     plain numbers (Vaccinations, Slurps) are shown, never scored;
//  3. burned left out: Twonks Twetch marks consumed no longer count.
// The formula stays the one Twetch uses for the fleet (information content, or rarity score for NOOGIES).

/** One trait written two ways that differ only by stray spaces ("Walrus Moustache " and "Walrus Moustache") is one
 *  trait: merge them and say so. Returns a copy of raw plus the merges made, as [type, [names]]. */
export function mergeTypos(raw) {
  const traits = raw.traits.map((vals) => vals.map((v) => [...v]));
  const remap = raw.traits.map((vals) => vals.map((_, v) => v));
  const merged = [];
  traits.forEach((vals, t) => {
    const first = new Map();
    vals.forEach((val, v) => {
      const key = String(val[0]).trim();
      if (!first.has(key)) { first.set(key, v); return; }
      const keep = first.get(key);
      remap[t][v] = keep;
      if (val[2] != null) vals[keep][2] = (vals[keep][2] ?? 0) + val[2];
      merged.push([raw.types[t], [vals[keep][0], val[0]]]);
      vals[keep][0] = key;
    });
  });
  if (!merged.length) return { raw, merged };
  const tok = raw.tok.map((row) => row.map((x, i) => (i >= 4 && i < 4 + raw.types.length && x >= 0 ? remap[i - 4][x] : x)));
  return { raw: { ...raw, traits, tok }, merged };
}

/** method: 'info' | 'inv'. burned: Map<number, string> from token number to the fleet it became ('' when none).
 *  listingOnly: trait types no on-chain record of the fleet holds (Egg's Color is only in Twetch's listing; found by
 *  tools/chain-check.mjs): shown, never scored, since the on-chain record ranks. With nothing left to score, no ranks. */
export function trueFleet(input, { method = 'info', burned = new Map(), listingOnly = [] } = {}) {
  const { raw, merged } = mergeTypos(input);
  const T = raw.types.length;
  const has = (row) => { for (let t = 0; t < T; t++) if (row[4 + t] >= 0) return true; return false; };
  const withTraits = raw.tok.filter(has);
  const alive = withTraits.filter((row) => !burned.has(row[0]));
  // A count stored as a plain number (Vaccinations: LizerVAXX doses burned into a frog; Astro Apes' Slurps)
  // is shown, never ranked: the rank stored on every Twonk leaves it out, and it keeps changing after mint.
  const numeric = raw.types.map((_, t) => raw.traits[t].length > 0 && raw.traits[t].every((v) => /^\s*\d+\s*$/.test(String(v[0]))));
  const listing = raw.types.map((type) => listingOnly.includes(type));
  const anyReported = raw.traits.some((vals) => vals.some((v) => v[2] != null));
  const twetchScores = raw.types.map((_, t) => !numeric[t] && !listing[t] && (!anyReported || raw.traits[t].some((v) => v[2] != null)));
  // Twetch's reported counts add up to the pool it counted over; a typical trait adding up to far more than the fleet
  // means a pooled fleet (Graveyard, Apu Cartel, Lab Monkes, Special Forces: 1.5 to 15 times). The median, not the
  // largest sum: a few inflated values (Lizer Corp lists 127 on every "None", where 24 to 49 hold it) push one
  // trait about 5% over and must not make a fleet look pooled.
  const sums = raw.traits.filter((vals) => vals.some((v) => v[2] != null)).map((vals) => vals.reduce((s, v) => s + (v[2] ?? 0), 0)).sort((a, b) => a - b);
  const pool = sums.length ? sums[sums.length - 1] : 0;
  const pooled = sums.length > 0 && sums[Math.floor(sums.length / 2)] > raw.tok.length * 1.25;

  const countOver = (rows) => {
    const c = raw.traits.map((vals) => vals.map(() => 0));
    for (const row of rows) for (let t = 0; t < T; t++) { const v = row[4 + t]; if (v >= 0) c[t][v]++; }
    return c;
  };
  const rankOver = (rows, count, scoredTypes) => {
    const N = rows.length;
    const score = (row) => {
      let s = 0;
      for (let t = 0; t < T; t++) {
        const v = row[4 + t]; if (v < 0 || !scoredTypes[t]) continue;
        const c = count[t][v]; if (!c) continue;
        s += method === 'inv' ? N / c : -Math.log2(c / N);
      }
      return s;
    };
    const order = rows.map((row) => ({ n: row[0], s: score(row) })).sort((a, b) => b.s - a.s || a.n - b.n);
    return { order, rank: new Map(order.map((x, i) => [x.n, i + 1])) };
  };

  // step 0: Twetch's own order, restated as a place among this fleet's Twonks with traits
  const twetchRanked = withTraits.filter((row) => row[1] > 0).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const s0 = new Map(twetchRanked.map((row, i) => [row[0], i + 1]));
  const allTypes = raw.types.map((_, t) => !numeric[t] && !listing[t]);
  // nothing on chain to score: rank nobody, rather than order equal scores by number
  const ranked = (rows) => (allTypes.some(Boolean) ? rows : []);
  const cAll = countOver(withTraits);
  const s1 = rankOver(ranked(withTraits), cAll, twetchScores).rank;
  const s2 = rankOver(ranked(withTraits), cAll, allTypes).rank;
  const count = countOver(alive);
  const final = rankOver(ranked(alive), count, allTypes);
  const N = alive.length;

  // Where the designers' label disagrees with the count: higher-labelled traits that more Twonks hold.
  // Signature Series is hand-made, not rolled, and "None" values are an absence: both are left out of the comparison.
  const rolled = (t, v) => !/signature/i.test(raw.types[t]) && !/^no |^none$/i.test(String(raw.traits[t][v][0]));
  const labelled = [];
  for (let t = 0; t < T; t++) raw.traits[t].forEach(([, tier], v) => { if (tier >= 0 && count[t][v] > 0 && rolled(t, v)) labelled.push({ t, v, tier, c: count[t][v] }); });
  const traits = raw.traits.map((vals, t) => vals.map(([value, tier, reported], v) => {
    const c = count[t][v];
    let beats = 0, example = null;
    if (tier >= 0 && c > 0 && rolled(t, v)) {
      for (const o of labelled) {
        // a disagreement worth showing is at least a tenth apart, as in Tetro's room
        if (o.tier <= tier || o.c < c * 1.1 + 1) continue;
        beats++;
        if (!example || o.tier > example.tier || (o.tier === example.tier && o.c < example.c)) example = o;
      }
    }
    // [value, label tier or -1, real count, Twetch's count or null, higher-labelled traits more common,
    //  [type, value, tier, count] of the closest, count over the same Twonks Twetch counts (burned included)]
    return [value, tier, c, reported, beats, example ? [example.t, example.v, example.tier, example.c] : null, cAll[t][v]];
  }));

  // [number, Twetch's printed rank or 0, true rank or 0, image, Twetch's place in this fleet or 0,
  //  places gained by step 1, step 2, step 3 (0 when a step does not apply), value index per type...]
  const tok = raw.tok.map((row) => {
    const n = row[0], p0 = s0.get(n) || 0, p1 = s1.get(n) || 0, p2 = s2.get(n) || 0, p3 = final.rank.get(n) || 0;
    const d1 = p0 && p1 ? p0 - p1 : 0, d2 = p1 && p2 ? p1 - p2 : 0, d3 = p2 && p3 ? p2 - p3 : 0;
    return [n, row[1] || 0, p3, row[3], p0, d1, d2, d3, ...row.slice(4, 4 + T)];
  });

  return {
    v: 2, c: raw.c, name: raw.name, at: raw.at, method, n: N,
    twetchOf: twetchRanked.length, twetchPrintedOf: twetchRanked.reduce((m, r) => Math.max(m, r[1]), 0),
    pooled, pool: pooled ? pool : 0, withTraits: withTraits.length,
    // traits Twetch leaves out that step 2 scores, and counts shown but never scored
    unscored: raw.types.filter((_, t) => !twetchScores[t] && !numeric[t] && !listing[t]),
    counts: raw.types.filter((_, t) => numeric[t]),
    listingOnly: raw.types.filter((_, t) => listing[t]),
    burned: Object.fromEntries([...burned].filter(([num]) => raw.tok.some((row) => row[0] === num))),
    types: raw.types, tiers: raw.tiers, traits, tok, top: final.order.slice(0, 3).map((x) => x.n), names: raw.names || {},
    merged,
  };
}
