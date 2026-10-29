import { test } from 'node:test';
import assert from 'node:assert/strict';
import { card } from '../src/card.mjs';

test('a ranked Twonk teases Twetch\'s rank and never the true one', () => {
  const c = card(['Frog Cartel #1286', 'abc', 26, 2873, 0], 'frog-cartel', 1286);
  assert.equal(c.title, 'Frog Cartel #1286: Twetch says #26 of 2,873. Final answer?');
  assert.equal(c.url, 'https://true-twonk.buidler.workers.dev/t/frog-cartel/1286');
  assert.equal(c.image, 'https://api.twetch.com/v1/media/abc');
  assert.equal(c.square, true);
});

test('no Twetch rank, burned, no image and unknown Twonks each get their own card', () => {
  assert.match(card(['Astro Apes #5', 'x', 0, 0, 0], 'astro-apes', 5).title, /no rank/);
  assert.match(card(['Frog Cartel #7', 'x', 3, 10, 1], 'frog-cartel', 7).title, /burned/);
  const bare = card(['Frog Cartel #8', '', 3, 10, 0], 'frog-cartel', 8);
  assert.equal(bare.image, 'https://true-twonk.buidler.workers.dev/card.png');
  assert.equal(bare.square, false);
  assert.equal(card(null, 'frog-cartel', 99999), null);
});
