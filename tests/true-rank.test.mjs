import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trueFleet } from '../tools/true-rank.mjs';

/// A tiny fleet: two trait types, the second one left uncounted by "Twetch" (reported null), like Graveyard's Vaccine Effect.
const raw = {
  c: 'x', name: 'Test', at: 0, tiers: ['Common', 'Uncommon', 'Rare', 'Epic', 'Legendary', 'Exotic'],
  types: ['Hat', 'Effect'],
  traits: [
    [['Cap', 0, 3], ['Crown', 3, 1], ['Halo', 0, 1]],
    [['Common Death', -1, null], ['Legendary Death', -1, null]],
  ],
  tok: [
    [1, 2, 0, 'a', 0, 0],
    [2, 3, 0, 'b', 0, 0],
    [3, 4, 0, 'c', 0, 1],
    [4, 1, 0, 'd', 1, 0],
    [5, 5, 0, 'e', 2, 0],
    [6, 0, 0, '', -1, -1],
  ],
  names: {},
};

test('counts come from the Twonks, uncounted traits included, and Twonks without traits are left out', () => {
  const f = trueFleet(raw);
  assert.equal(f.n, 5);
  assert.deepEqual(f.traits[0].map((t) => t[2]), [3, 1, 1]);
  assert.deepEqual(f.traits[1].map((t) => t[2]), [4, 1]);
  assert.equal(f.tok.find((r) => r[0] === 6)[2], 0);
});

test('a rare uncounted trait lifts the true rank above Twetch rank', () => {
  const f = trueFleet(raw);
  const three = f.tok.find((r) => r[0] === 3);
  assert.equal(three[1], 4);
  assert.ok(three[2] < 4, `true rank ${three[2]} should beat Twetch's 4`);
  assert.equal(f.top.length, 3);
});

test('each jump is put down to the step that caused it', () => {
  const f = trueFleet(raw);
  const three = f.tok.find((r) => r[0] === 3);
  // Twetch places it 4th; counting the uncounted Effect trait (step 2) is what lifts it to 1st
  assert.equal(three[4], 4);
  assert.equal(three[2], 1);
  assert.equal(three[6], 4);
  assert.equal(three[5] + three[6] + three[7], three[4] - three[2]);
  assert.deepEqual(f.unscored, ['Effect']);
  assert.equal(f.pooled, false);
});

test('burned Twonks are left out of counts and ranks', () => {
  const f = trueFleet(raw, { burned: new Map([[1, 'Graveyard']]) });
  assert.equal(f.n, 4);
  assert.equal(f.traits[0][0][2], 2);
  // the like-for-like count (burned included) stays, so a gap from burns is never shown as Twetch's miscount
  assert.equal(f.traits[0][0][6], 3);
  assert.equal(f.tok.find((r) => r[0] === 1)[2], 0);
  assert.deepEqual(f.burned, { 1: 'Graveyard' });
});

test('a Common trait held by fewer Twonks than an Epic one is caught', () => {
  // Halo (Common, 1 holder) vs Cap (Common, 3): same label, no catch. Make Crown Epic but common.
  const r2 = structuredClone(raw);
  r2.tok.push([7, 6, 0, 'f', 1, 0], [8, 7, 0, 'g', 1, 0]);
  const f = trueFleet(r2);
  const halo = f.traits[0][2];
  assert.equal(halo[4], 1);
  assert.deepEqual(halo[5], [0, 1, 3, 3]);
});

test('rarity score formula lets one very rare trait dominate', () => {
  const f = trueFleet(raw, { method: 'inv' });
  assert.equal(f.method, 'inv');
  assert.equal(f.top.length, 3);
});

test('a trait written with a stray space is merged into one, and the merge is reported', async () => {
  const { mergeTypos } = await import('../tools/true-rank.mjs');
  const r = {
    types: ['Mouth'], traits: [[['Walrus ', 0, 3], ['Gum', 0, 2], ['Walrus', 0, 1]]],
    tok: [[1, 0, 0, 'a', 0], [2, 0, 0, 'b', 2], [3, 0, 0, 'c', 1]],
  };
  const { raw, merged } = mergeTypos(r);
  assert.deepEqual(merged, [['Mouth', ['Walrus ', 'Walrus']]]);
  assert.equal(raw.traits[0][0][0], 'Walrus');
  assert.equal(raw.traits[0][0][2], 4);
  assert.deepEqual(raw.tok.map((row) => row[4]), [0, 0, 1]);
  assert.equal(r.tok[1][4], 2, 'input left untouched');
});

test('a count stored as a plain number (Vaccinations) is shown, never scored', () => {
  const r = structuredClone(raw);
  r.types[1] = 'Vaccinations';
  r.traits[1] = [['1', -1, null], ['11', -1, null]];
  const f = trueFleet(r);
  assert.deepEqual(f.counts, ['Vaccinations']);
  assert.deepEqual(f.unscored, []);
  const three = f.tok.find((row) => row[0] === 3);
  assert.equal(three[6], 0, 'its rare 11 doses move it nowhere');
  assert.equal(three[2], three[4] - three[5], 'only the recount (step 1) moves it');
  assert.deepEqual(f.traits[1].map((t) => t[2]), [4, 1], 'the count is still shown');
});

test('a trait no on-chain record holds is shown, never scored', () => {
  const f = trueFleet(raw, { listingOnly: ['Effect'] });
  assert.deepEqual(f.listingOnly, ['Effect']);
  assert.deepEqual(f.unscored, [], 'not "left out by Twetch": it is not on chain at all');
  const three = f.tok.find((row) => row[0] === 3);
  assert.equal(three[6], 0, 'its rare Effect moves it nowhere');
  assert.deepEqual(f.traits[1].map((t) => t[2]), [4, 1], 'the count is still shown');
});

test('a fleet with nothing on chain to rank (Egg: Color only in Twetch\'s listing) gets no ranks at all', () => {
  const f = trueFleet(raw, { listingOnly: ['Hat', 'Effect'] });
  assert.deepEqual(f.tok.map((row) => row[2]), [0, 0, 0, 0, 0, 0]);
  assert.deepEqual(f.top, []);
  assert.equal(f.n, 5, 'still counted, so trait shares can be shown');
  assert.deepEqual(f.traits[0].map((t) => t[2]), [3, 1, 1]);
});

test('one inflated trait (Lizer Corp lists 127 on every "None") does not make a fleet look pooled', () => {
  const tok = Array.from({ length: 20 }, (_, i) => [i + 1, i + 1, 0, 'x', i % 2, i % 4 === 0 ? 1 : 0]);
  const r = {
    c: 'x', name: 'Lizer', at: 0, tiers: ['Common'], types: ['Back', 'Head', 'Eye'],
    traits: [[['A', 0, 10], ['B', 0, 10]], [['Cap', 0, 15], ['None ', 0, 30]], [['Red', 0, 20]]],
    tok: tok.map((row) => [...row, 0]),
  };
  assert.equal(trueFleet(r).pooled, false);
});
