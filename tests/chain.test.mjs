import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { chainRecord, outputs, scriptRecord, traitsOf } from '../public/chain.js';

// Real transactions, saved from WhatsOnChain on 2026-10-29 (tests/fixtures/<collection>-<number>.json). A fixture
// holds the whole transaction (hex), or only the output script when the transaction is huge (script).
const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const recordOf = ({ hex, script, vout }) => (script ? scriptRecord(script) : chainRecord(hex, vout));

test('every saved Twonk transaction yields its numbered record with traits, from the output Twetch names', () => {
  for (const file of readdirSync(new URL('./fixtures/', import.meta.url))) {
    if (file === 'egg-1.json') continue; // Egg writes no number and no traits: its own test below
    const rec = recordOf(fx(file.replace('.json', '')));
    const n = +file.match(/-(\d+)\.json$/)[1];
    assert.ok(rec, `${file}: no record found`);
    assert.equal(rec.json.number, n, `${file}: record is for #${rec.json.number}`);
    assert.ok(traitsOf(rec.json).length > 0 && traitsOf(rec.json).every((t) => t.type), `${file}: no named traits`);
  }
});

test('NOOGIES #1 on chain: traits under the key "trait", and no stored rank', () => {
  const { json } = recordOf(fx('noogies-1'));
  const traits = traitsOf(json);
  assert.equal(traits.length, 9);
  assert.deepEqual(traits.find((t) => t.type === 'Head item'), { type: 'Head item', value: 'Halo', count: null });
  assert.equal(json.rank, undefined);
});

test('Egg #1 on chain: the record holds no number and no traits (its Color is only in Twetch\'s listing)', () => {
  const { json } = recordOf(fx('egg-1'));
  assert.equal(json.title, 'Egg');
  assert.equal(json.number, undefined);
  assert.deepEqual(traitsOf(json), []);
});

test('Frog Cartel #1: an OP_RETURN byte inside a pushed hash is not mistaken for the opcode', () => {
  const { hex, vout } = fx('frog-cartel-1');
  assert.equal(vout, 1);
  assert.equal(chainRecord(hex, vout).json.title, 'Frog Cartel #1');
  assert.equal(chainRecord(hex, 0), null, 'output 0 holds no record');
});

test('Frog Cartel #1286 on chain: Mouth is "No Mouth Item" and the stored rank is 26', () => {
  const { json } = chainRecord(fx('frog-cartel-1286').hex, 0);
  assert.equal(json.attributes.find((a) => a.trait_type === 'Mouth').value, 'No Mouth Item');
  assert.equal(json.rank, 26);
});

test('Lizer Corp #1364 on chain: Head "None " keeps its trailing space and the stored count 127', () => {
  const { json } = chainRecord(fx('lizer-corp-1364').hex, 0);
  const head = json.attributes.find((a) => a.trait_type === 'Head');
  assert.equal(head.value, 'None ');
  assert.equal(head.count, 127);
});

test('a transaction cut short is an error, not a wrong answer', () => {
  const { hex } = fx('frog-cartel-1286');
  assert.throws(() => outputs(hex.slice(0, 200)));
});
