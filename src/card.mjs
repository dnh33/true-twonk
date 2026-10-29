// The link preview for one shared Twonk. Pure, so tests can run it without a Worker.
// A tease, not the answer: it names Twetch's rank and holds back the true one.

export const SHARE_BUCKET = 100;
export const SITE = 'https://true-twonk.buidler.workers.dev';
const MEDIA = 'https://api.twetch.com/v1/media/';
const fmt = (n) => n.toLocaleString('en-US');

/** entry: [name, image, Twetch's place or 0, of how many, burned] from public/s; null when the Twonk is unknown. */
export function card(entry, slugName, number) {
  const url = `${SITE}/t/${slugName}/${number}`;
  if (!entry) return null;
  const [name, image, place, of, burned] = entry;
  const title = burned ? `${name} was burned. Where did it go?`
    : place ? `${name}: Twetch says #${fmt(place)} of ${fmt(of)}. Final answer?`
    : `${name}: Twetch shows no rank. Here is the real one.`;
  const description = burned ? 'Burned Twonks drop out of the count. See what became of this one.'
    : 'Twetch lists some trait counts wrong and still counts burned Twonks. Tap to see where this one really ranks.';
  return { title, description, url, image: image ? MEDIA + image : `${SITE}/card.png`, square: !!image };
}
