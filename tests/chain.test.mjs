import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { chainRecord, outputs } from '../public/chain.js';

// Real transactions, saved from WhatsOnChain on 2026-10-29 (tests/fixtures/<collection>-<number>.json).
const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

test('every saved Twonk transaction yields its record, from the output Twetch names', () => {
  for (const file of readdirSync(new URL('./fixtures/', import.meta.url))) {
    const { hex, vout } = fx(file.replace('.json', ''));
    const n = +file.match(/-(\d+)\.json$/)[1];
    const rec = chainRecord(hex, vout);
    assert.ok(rec, `${file}: no record found`);
    assert.equal(rec.json.number, n, `${file}: record is for #${rec.json.number}`);
    assert.ok(Array.isArray(rec.json.attributes), `${file}: no attributes`);
  }
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
