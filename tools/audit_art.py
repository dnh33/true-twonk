"""Art vs trait record audit: does each Twonk's picture show the traits its record lists?

Learns each trait value's pixel footprint from the Twonks that list it (cells where they agree on a colour that
Twonks without it rarely have there), then scores every Twonk's art against every footprint. Flags:
  missing: the record lists a value whose footprint the art does not show;
  unlisted: the art shows a value's footprint that the record does not list (e.g. Stitched Lips on a frog
            recorded "No Mouth Item").
No Twetch API calls except the Twonk images (cached, a few at a time).

Run: python tools/audit_art.py <collection slug or 'all'> [--cache D:/_twonk-art]
Writes audit/<slug>.json and prints a summary.
"""
import json, sys, urllib.request, concurrent.futures as cf
from pathlib import Path
import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / 'public' / 'data'
MEDIA = 'https://api.twetch.com/v1/media/'
T0 = 8  # value indexes start after 8 fields in a token row (see tools/true-rank.mjs)

AGREE = 0.9     # share of holders that must show the same colour in a cell for it to join the footprint
RARE = 0.2      # ...while at most this share of non-holders show that colour there
MIN_CELLS = 3   # footprints smaller than this are too weak to judge
HIT = 0.9       # art "shows" a footprint when this share of its cells match
MISS = 0.5      # art "lacks" a listed footprint when under this share match


def fetch(url, dest):
    if dest.exists() and dest.stat().st_size > 0:
        return True
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'true-twonk-audit'})
        with urllib.request.urlopen(req, timeout=30) as r:
            dest.write_bytes(r.read())
        return True
    except Exception:
        return False


def grid(path):
    """The pixel-art grid: sample the centre of each art pixel, as an int RGB code per cell."""
    im = np.asarray(Image.open(path).convert('RGB'))
    h, w, _ = im.shape
    # cell size = the largest square block that rebuilds the whole picture exactly; None when the art is not pixel art
    # (illustrations and JPEGs never rebuild exactly, and exact colour matching means nothing on them)
    for cell in range(min(h, w) // 8, 1, -1):
        if h % cell or w % cell:
            continue
        c = im[::cell, ::cell]
        if np.array_equal(c.repeat(cell, 0).repeat(cell, 1), im):
            c = c.astype(np.int32)
            return (c[..., 0] << 16) | (c[..., 1] << 8) | c[..., 2], cell
    return None, None


def audit(fleet, cache):
    d = json.loads((DATA / f"{fleet['c']}.json").read_text(encoding='utf-8'))
    folder = cache / fleet['slug']
    folder.mkdir(parents=True, exist_ok=True)
    rows = [r for r in d['tok'] if r[3]]
    with cf.ThreadPoolExecutor(6) as ex:
        ok = list(ex.map(lambda r: fetch(MEDIA + r[3], folder / f'{r[0]}.png'), rows))
    rows = [r for r, good in zip(rows, ok) if good]
    grids, sizes, not_pixel = {}, {}, 0
    for r in rows:
        try:
            g, cell = grid(folder / f'{r[0]}.png')
        except Exception:
            continue
        if g is None:
            not_pixel += 1
            continue
        sizes[g.shape] = sizes.get(g.shape, 0) + 1
        grids[r[0]] = g
    if not_pixel > len(rows) * 0.05 or not sizes:
        return {'name': d['name'], 'skipped': f'not pixel art ({not_pixel} of {len(rows)} images do not rebuild from square cells)'}
    shape = max(sizes, key=sizes.get)
    nums = [n for n, g in grids.items() if g.shape == shape]
    G = np.stack([grids[n] for n in nums])  # tokens x H x W
    row_of = {r[0]: r for r in rows}

    findings = {'name': d['name'], 'checked': len(nums), 'grid': list(shape), 'odd_size': len(grids) - len(nums), 'not_pixel': not_pixel,
                'footprints': {}, 'missing': [], 'unlisted': []}
    absent = lambda v: v.lower().startswith('no ') or v.lower() in ('none', 'missingmouthitem')
    # learn footprints
    prints = {}  # (t, v) -> (mask, colours)
    for t, tname in enumerate(d['types']):
        if 'signature' in tname.lower():
            continue
        vals = np.array([row_of[n][T0 + t] for n in nums])
        for v, val in enumerate(d['traits'][t]):
            name = str(val[0])
            have = vals == v
            k = int(have.sum())
            if k < 3 or absent(name):
                continue
            H = G[have]
            # modal colour per cell among holders, and how many holders share it
            flat = H.reshape(k, -1)
            # where at least 90% of holders agree, the middle value of each sorted column is that colour
            mode = np.sort(flat, axis=0)[k // 2]
            share = (flat == mode).mean(axis=0)
            others = G[~have].reshape(int((~have).sum()), -1)
            other_share = (others == mode).mean(axis=0) if len(others) else np.zeros_like(share)
            loose = (share >= AGREE) & (other_share <= RARE)
            # strict: sibling values of the same trait (six emote shirts share one outline) must not show it either
            sib_share = np.zeros_like(share)
            for s in range(len(d['traits'][t])):
                sib = vals == s
                if s != v and sib.sum() >= 3:
                    sib_share = np.maximum(sib_share, (G[sib].reshape(int(sib.sum()), -1) == mode).mean(axis=0))
            strict = loose & (sib_share <= RARE)
            if loose.sum() >= MIN_CELLS:
                prints[(t, v)] = (loose, strict if strict.sum() >= MIN_CELLS else None, mode)
                findings['footprints'][f'{tname}={name}'] = [int(loose.sum()), int(strict.sum())]
    # score every token, one trait type at a time: flag only when the art clearly shows another value than the
    # record and does not show the recorded one (a listed item hidden under a costume is not a mismatch).
    # A record of "No X Item" (or no value) is checked against the loose footprints: any item showing is news.
    # A record naming an item is checked against the strict ones, so look-alike siblings do not trip it.
    flatG = G.reshape(len(nums), -1)
    for t in range(len(d['types'])):
        mine = {v: p for (tt, v), p in prints.items() if tt == t}
        if not mine:
            continue
        hit = lambda m, mode: (flatG[:, m] == mode[m]).mean(axis=1)
        loose = {v: hit(lo, mode) for v, (lo, st, mode) in mine.items()}
        strict = {v: hit(st, mode) for v, (lo, st, mode) in mine.items() if st is not None}
        for i, n in enumerate(nums):
            rec = row_of[n][T0 + t]
            if rec in loose:
                if loose[rec][i] >= MISS:
                    continue
                shown = [(float(s[i]), int(mine[v][1].sum()), v) for v, s in strict.items() if v != rec and s[i] >= HIT]
            elif rec < 0 or absent(str(d['traits'][t][rec][0])):
                shown = [(float(s[i]), int(mine[v][0].sum()), v) for v, s in loose.items() if s[i] >= HIT]
            else:
                # the record names an item whose look could not be learned (too few clear examples): the art matching
                # another item proves nothing, since the recorded item may share those pixels. Not judged.
                continue
            if not shown:
                continue
            best, _, v = max(shown)  # best match, then the bigger footprint (Stitched Lips over a moustache it contains)
            findings['unlisted' if rec not in loose else 'missing'].append({
                'n': n, 'type': d['types'][t], 'art': d['traits'][t][v][0], 'match': round(best, 2),
                'record': d['traits'][t][rec][0] if rec >= 0 else '(none)',
                'record_match': round(float(loose[rec][i]), 2) if rec in loose else None})
    return findings


def main():
    args = sys.argv[1:]
    cache = Path(args[args.index('--cache') + 1]) if '--cache' in args else Path('D:/_twonk-art')
    want = args[0] if args else 'frog-cartel'
    index = json.loads((DATA / 'index.json').read_text(encoding='utf-8'))
    out = ROOT / 'audit'
    out.mkdir(exist_ok=True)
    for f in index['fleets']:
        if want != 'all' and f['slug'] not in want.split(','):
            continue
        res = audit(f, cache)
        (out / f"{f['slug']}.json").write_text(json.dumps(res, indent=1), encoding='utf-8')
        if 'skipped' in res:
            print(f"{res['name']:<20} skipped: {res['skipped']}", flush=True)
            continue
        print(f"{res['name']:<20} checked {res['checked']:>5}  grid {res['grid']}  footprints {len(res['footprints']):>4}  "
              f"missing {len(res['missing']):>4}  unlisted {len(res['unlisted']):>4}  odd size {res['odd_size']}  "
              f"not pixel {res['not_pixel']}", flush=True)


if __name__ == '__main__':
    main()
