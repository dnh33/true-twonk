# True Twonk

Put in a Twonk (a Twetch link, or "Frog Cartel 514") and see its true rank next to the three rarest in its collection.

## What "true" means

Same formula Twetch uses per collection (information content; rarity score for NOOGIES), with three named steps, each shown on the page with the places it moved the Twonk:

1. **Counts:** recounted from the Twonks themselves (Twetch counts Signature "1 of 1" as 1; 33 frogs carry it). Pooled collections (Graveyard, Apu Cartel, Lab Monkes, Special Forces) are counted within themselves.
2. **Every trait:** traits Twetch leaves out of its rank (Vaccinations, Vaccine Effect) count.
3. **Burned left out:** Twonks Twetch marks `consumed` no longer count (Frog Cartel 808, LizerVAXX 2,029, Slurp Juice 2,517).

Both ranks show "of N". Twetch's rank is restated as its place within the collection, so the two compare like for like.

## Data

- Traits and ranks: Tetro's baked files (`public/fleet` in the Tetro project, made by its `tools/bake-twonks.mjs`). `npm run data` looks for Tetro in `../tetro`; pass another path as an argument or set `TETRO`.
- Burned numbers: `tools/burned.json`, from `npm run burned` (one token list per collection with burns).
- `npm run data` writes `public/data/`. The page makes no API calls except Twonk images.

## Run

- `npm test`
- `npm run serve` (`wrangler dev`), then open http://127.0.0.1:8765/
- `npm run deploy` (rebuilds data, then `wrangler deploy`).
- `npm run card` re-renders the default link preview `public/card.png` from `tools/card.html` (headless Edge).

## Shared links

`/t/frog-cartel/1286` opens on that Twonk, and a pasted link unfurls as it: the Twonk's art, and "Twetch says #26 of 3,681. Final answer?" (the true rank stays for the click). `src/worker.js` runs only on `/t/*` (`run_worker_first`); it reads one 100-Twonk bucket from `public/s/` and rewrites the preview tags. Everything else is free static assets, so only clicks on shared links spend Worker requests (100,000 a day on the free plan). Old `/#frog-cartel/1286` links still open and switch to the `/t/` form. Twonks with no traits get the plain site card.
