// True rarity for one baked fleet. Pure: takes Tetro's baked file, returns the compact file the page reads.
//
// The true rank is reached in three named steps from Twetch's own order, so the page can say which rule moved a
// Twonk and never passes a rule change off as a Twetch mistake:
//  1. counts: every count recounted from the Twonks themselves (Signature "1 of 1" is held by more than one frog;
//     a pooled fleet such as Graveyard is counted within itself instead of across all frogs);
//  2. every trait: traits Twetch leaves out of its rank (Vaccinations) are scored too;
//  3. burned left out: Twonks Twetch marks consumed no longer count.
// The formula stays the one Twetch uses for the fleet (information content, or rarity score for NOOGIES).

/** method: 'info' | 'inv'. burned: Map<number, string> from token number to the fleet it became ('' when none). */
export function trueFleet(raw, { method = 'info', burned = new Map() } = {}) {
  const T = raw.types.length;
  const has = (row) => { for (let t = 0; t < T; t++) if (row[4 + t] >= 0) return true; return false; };
  const withTraits = raw.tok.filter(has);
  const alive = withTraits.filter((row) => !burned.has(row[0]));
  const anyReported = raw.traits.some((vals) => vals.some((v) => v[2] != null));
  const twetchScores = raw.types.map((_, t) => !anyReported || raw.traits[t].some((v) => v[2] != null));
  // Twetch's reported counts add up to the pool it counted over; more than the fleet means a pooled fleet
  const pool = Math.max(0, ...raw.traits.filter((vals) => vals.some((v) => v[2] != null)).map((vals) => vals.reduce((s, v) => s + (v[2] ?? 0), 0)));
  const pooled = pool > raw.tok.length * 1.05;

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
  const allTypes = raw.types.map(() => true);
  const cAll = countOver(withTraits);
  const s1 = rankOver(withTraits, cAll, twetchScores).rank;
  const s2 = rankOver(withTraits, cAll, allTypes).rank;
  const count = countOver(alive);
  const final = rankOver(alive, count, allTypes);
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
    unscored: raw.types.filter((_, t) => !twetchScores[t]),
    burned: Object.fromEntries([...burned].filter(([num]) => raw.tok.some((row) => row[0] === num))),
    types: raw.types, tiers: raw.tiers, traits, tok, top: final.order.slice(0, 3).map((x) => x.n), names: raw.names || {},
  };
}
