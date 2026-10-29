"""Combination scan: which pairs of items are drawn on top of each other, and on how few Twonks?

A misprint, as Twetch collectors use the word, can be an art quirk that only shows in one trait combination: the
antenna of Fox Syndicate #2996 drawn on top of its eyepiece strap. Such a Twonk follows the normal drawing order, so
the re-render check (render_diff.py) sees nothing wrong. This finds the candidates instead: for every pair of items
held together, whether the areas they draw meet. Rare meeting pairs come first, each with a picture sheet, because only
a person can tell an intended overlap (a hat over a strap) from an odd one. Nothing here is a claim: a pair is listed
only after a blind second look and the owner's OK (tools/layer-clashes.json, tools/misprint-reviews.json).

Each item's drawn area is learned as in render_diff.py: the cells where its holders, not covered by a higher layer,
agree on a colour. An item held by fewer than MIN_SUPPORT + 1 Twonks has no learned area and is counted apart.

Run: python tools/combo_scan.py <slug> [--max-k 2] [--chain D:/_twonk-chain/b] [--out D:/_twonk-combos]
Writes audit/<slug>.combos.json and one sheet per pair held by at most max-k Twonks.
"""
import json, sys, time
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from render_diff import load, layer_order, peel, MIN_SUPPORT, SOFT  # noqa: E402
from evidence import font  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent


def main():
    args = sys.argv[1:]
    opt = lambda k, dflt: type(dflt)(args[args.index(k) + 1]) if k in args else dflt
    slug, max_k = args[0], opt('--max-k', 2)
    chain, out = Path(opt('--chain', 'D:/_twonk-chain/b')), Path(opt('--out', 'D:/_twonk-combos'))
    t0 = time.time()
    d, nums, G, V, K, shape = load(slug, chain, opt)
    T, J, N = len(d['types']), G.shape[1], len(nums)
    _, beats = layer_order(G, V)
    order = sorted(range(T), key=lambda t: -beats[t])
    fp = {t: np.zeros((K[t] + 1, J), bool) for t in range(T)}
    peel(G, V, K, order, (V[:1], np.array([0]), G[:1]), paint_out=fp)
    name = lambda t, v: str(d['traits'][t][v][0])
    # base layers (background, the animal itself) sit under everything: every Twonk holds one and they cover much of the
    # picture, so meeting them says nothing. Signature one-of-ones are custom art. Both are left out.
    base = [t for t in range(T) if (V[:, t] < K[t]).mean() >= 0.98 and fp[t][:K[t]].any(0).mean() > 0.25]
    # counts (Vaccinations, Slurps) are numbers on the record, not drawn parts
    skip = set(base) | {t for t in range(T) if 'signature' in d['types'][t].lower() or d['types'][t] in (d.get('counts') or [])}
    items = [t for t in range(T) if t not in skip]
    print(f"{d['name']}: {N} Twonks; items checked: {', '.join(d['types'][t] for t in items)}; left out: {', '.join(d['types'][t] for t in sorted(skip))}")
    holders = {t: np.bincount(V[:, t], minlength=K[t] + 1) for t in range(T)}
    unlearned = {t: [v for v in range(K[t]) if 0 < holders[t][v] and not fp[t][v].any()] for t in items}
    print('  items with no learned area (too few holders or never drawn alone): ' + str(sum(len(x) for x in unlearned.values())))
    near = 1 if not SOFT['on'] else 2   # cells of reach: "meet" includes touching
    min_cells = 2 if not SOFT['on'] else 3
    pairs = []
    for i, a in enumerate(items):
        for b in items[i + 1:]:
            key = V[:, a] * 1000 + V[:, b]
            keys, counts = np.unique(key[(V[:, a] < K[a]) & (V[:, b] < K[b])], return_counts=True)
            for k_, c in zip(keys, counts):
                va, vb = int(k_ // 1000), int(k_ % 1000)
                A, B = fp[a][va].reshape(shape), fp[b][vb].reshape(shape)
                if not A.any() or not B.any():
                    continue
                over = int((A & B).sum())
                touch = int((ndimage.binary_dilation(A, iterations=near) & B).sum())
                if over < min_cells:  # drawn over each other, not merely side by side
                    continue
                who = [nums[x] for x in np.flatnonzero(key == k_)]
                # where they meet, as a point and a zoom, so a page can show the spot up close in the browser
                ys, xs = np.nonzero(A & B)
                span = max(ys.max() - ys.min() + 1, xs.max() - xs.min() + 1)
                at = [round(float((xs.min() + xs.max() + 1) / 2 / shape[1]), 3), round(float((ys.min() + ys.max() + 1) / 2 / shape[0]), 3)]
                zoom = round(float(min(4.0, max(1.6, shape[0] / (span * 1.8)))), 2)
                pairs.append({'a': [d['types'][a], name(a, va)], 'b': [d['types'][b], name(b, vb)], 'held': int(c),
                              'overlap': over, 'touch': touch, 'twonks': who[:20], 'at': at, 'zoom': zoom, 'ta': a, 'va': va, 'tb': b, 'vb': vb})
    pairs.sort(key=lambda p: (p['held'], -p['overlap']))
    by_k = {}
    for p in pairs:
        by_k[min(p['held'], 10)] = by_k.get(min(p['held'], 10), 0) + 1
    print('  meeting pairs by how many Twonks hold them: ' + ', '.join(f"{k if k < 10 else '10+'}: {v}" for k, v in sorted(by_k.items())))

    # a sheet per rare pair: the Twonks holding it, then holders of each item without the other, cropped to where they meet
    folder = out / slug
    folder.mkdir(parents=True, exist_ok=True)
    row = {r[0]: r for r in d['tok']}
    idx = {n: i for i, n in enumerate(nums)}
    H, W = shape
    CELL = 220
    for k, p in enumerate([p for p in pairs if p['held'] <= max_k][:opt('--limit', 0) if '--limit' in args else None] if '--dry' not in args else []):
        a, va, b, vb = p['ta'], p['va'], p['tb'], p['vb']
        meet = ndimage.binary_dilation(fp[a][va].reshape(shape), iterations=near) & ndimage.binary_dilation(fp[b][vb].reshape(shape), iterations=near)
        ys, xs = np.nonzero(meet)
        cy, cx = (ys.min() + ys.max()) / 2 / H, (xs.min() + xs.max()) / 2 / W
        half = max(0.12, (ys.max() - ys.min()) / H, (xs.max() - xs.min()) / W) * 0.9
        box = (max(0, cx - half), max(0, cy - half), min(1, cx + half), min(1, cy + half))
        only_a = [nums[x] for x in np.flatnonzero((V[:, a] == va) & (V[:, b] != vb) & (V[:, b] < K[b]))][:2]
        only_b = [nums[x] for x in np.flatnonzero((V[:, b] == vb) & (V[:, a] != va) & (V[:, a] < K[a]))][:2]
        rows_ = [(f"Held together by {p['held']}: {p['a'][0]} {p['a'][1]} + {p['b'][0]} {p['b'][1]}", p['twonks'][:3]),
                 (f"{p['a'][1]} with another {p['b'][0].lower()} item", only_a),
                 (f"{p['b'][1]} with another {p['a'][0].lower()} item", only_b)]
        img = Image.new('RGB', (16 + 3 * (CELL + 16), 16 + 3 * (30 + CELL + 16)), (14, 13, 12))
        dr = ImageDraw.Draw(img)
        y = 16
        for cap, ns in rows_:
            dr.text((16, y + 4), cap, fill=(240, 234, 222), font=font(15))
            y += 30
            for i, n in enumerate(ns):
                full = Image.open(chain / f"{row[n][3]}.bin").convert('RGB')
                crop = full.crop(tuple(int(v * s) for v, s in zip(box, (full.width, full.height, full.width, full.height))))
                img.paste(crop.resize((CELL, CELL), Image.NEAREST if not SOFT['on'] else Image.LANCZOS), (16 + i * (CELL + 16), y))
                dr.text((22 + i * (CELL + 16), y + CELL - 20), f'#{n}', fill=(240, 234, 222), font=font(13), stroke_width=2, stroke_fill=(14, 13, 12))
            y += CELL + 16
        p['sheet'] = str(folder / f"{k + 1:04d}.png")
        img.save(p['sheet'])
    for p in pairs:
        for x in ('ta', 'va', 'tb', 'vb'):
            p.pop(x)
    (ROOT / 'audit').mkdir(exist_ok=True)
    (ROOT / 'audit' / f'{slug}.combos.json').write_text(json.dumps({'name': d['name'], 'pairs': pairs}, indent=1))
    # the rare combinations page: pairs held by at most 3 Twonks, rarest first; [type a, value a, type b, value b, held,
    # Twonk numbers, x, y, zoom]. Candidates for people to look at, not misprints.
    pub = ROOT / 'public' / 'data' / 'combos'
    pub.mkdir(parents=True, exist_ok=True)
    rare = [[*p['a'], *p['b'], p['held'], p['twonks'][:3], *p['at'], p['zoom']] for p in pairs if p['held'] <= 3]
    (pub / f'{slug}.json').write_text(json.dumps({'name': d['name'], 'slug': slug, 'pixel': not SOFT['on'], 'checked': time.strftime('%Y-%m-%d'),
                                                   'items': [d['types'][t] for t in items], 'pairs': rare}, separators=(',', ':')))
    print(f"  {len(rare)} rare pairs published to public/data/combos/{slug}.json")
    print(f"  {sum(1 for p in pairs if 'sheet' in p)} sheets (pairs held by at most {max_k}) in {folder}; done in {time.time() - t0:.0f}s")


if __name__ == '__main__':
    main()
