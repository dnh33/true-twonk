// Runs only for /t/<slug>/<number> (run_worker_first in wrangler.jsonc); every other request is a free static asset.
// It serves the same page as /, with the link-preview tags rewritten for that one Twonk, so a pasted link
// unfurls as that Twonk and opens on it.
import { card, SHARE_BUCKET } from './card.mjs';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const page = await env.ASSETS.fetch(new URL('/', url));
    const m = url.pathname.match(/^\/t\/([a-z0-9-]+)\/(\d{1,7})\/?$/);
    if (!m) return page;
    let entry = null;
    try {
      const r = await env.ASSETS.fetch(new URL(`/s/${m[1]}/${Math.floor(+m[2] / SHARE_BUCKET)}.json`, url));
      if (r.ok) entry = (await r.json())[+m[2]] || null;
    } catch {}
    const c = card(entry, m[1], +m[2]);
    if (!c) return page;
    const set = (value) => ({ element(el) { el.setAttribute('content', value); } });
    return new HTMLRewriter()
      .on('title', { element(el) { el.setInnerContent(c.title); } })
      .on('meta[name="description"]', set(c.description))
      .on('meta[property="og:title"]', set(c.title))
      .on('meta[property="og:description"]', set(c.description))
      .on('meta[property="og:url"]', set(c.url))
      .on('meta[property="og:image"]', set(c.image))
      .on('meta[property="og:image:width"]', set(c.square ? '760' : '1200'))
      .on('meta[property="og:image:height"]', set(c.square ? '760' : '630'))
      .on('meta[property="og:image:alt"]', set(entry[0]))
      // a square Twonk would be cropped to a strip by the large card, so it gets the square one
      .on('meta[name="twitter:card"]', set(c.square ? 'summary' : 'summary_large_image'))
      .on('link[rel="canonical"]', { element(el) { el.setAttribute('href', c.url); } })
      .transform(page);
  },
};
