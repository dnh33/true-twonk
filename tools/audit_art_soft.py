"""Art vs trait record audit for illustrated (JPEG) collections, where tools/audit_art.py's exact pixel test cannot work.

Same idea and the same decisions as tools/audit_art.py: learn each trait value's footprint from the Twonks that list it,
then flag a Twonk whose art shows another value than its record (or an item its record says it lacks). The difference:
each picture is shrunk to a grid of block averages (JPEG noise averages out), and colours match within a tolerance
instead of exactly. Cells where the picture changes inside a block (outlines, thin lines) rarely agree, so they drop out
of the footprints by themselves; a thin item may get no footprint and is then not judged.
Every flag is a candidate to check by eye, never a finding on its own.

Run: python tools/audit_art_soft.py <collection slug> [--grid 125] [--tol 28] [--cache D:/_twonk-art] [--fetch-only]
Writes audit/<slug>.json and prints a summary.
"""
import json, sys, concurrent.futures as cf
from pathlib import Path
import numpy as np
from PIL import Image
from audit_art import fetch, DATA, MEDIA, T0, AGREE, RARE, MIN_CELLS, HIT, MISS, ROOT

ARGS = sys.argv[1:]
opt = lambda name, default: type(default)(ARGS[ARGS.index(name) + 1]) if name in ARGS else default
GRID = opt('--grid', 125)
TOL = opt('--tol', 28)  # largest RGB distance between two block averages that still counts as the same colour
CACHE = Path(opt('--cache', 'D:/_twonk-art'))


def shrink(path):
    im = Image.open(path).convert('RGB')
    if im.size[0] != im.size[1]:
        return None
    # box filter: each cell is the average of its block
    return np.asarray(im.resize((GRID, GRID), Image.BOX), dtype=np.float32).reshape(-1, 3)


def near(A, colour):
    """Share-ready boolean: which cells of A (tokens x cells x 3) are within TOL of colour (cells x 3)."""
    return ((A - colour[None]) ** 2).sum(axis=2) <= TOL * TOL


def audit(fleet):
    d = json.loads((DATA / f"{fleet['c']}.json").read_text(encoding='utf-8'))
    folder = CACHE / fleet['slug']
    folder.mkdir(parents=True, exist_ok=True)
    rows = [r for r in d['tok'] if r[3]]
    with cf.ThreadPoolExecutor(6) as ex:
        ok = list(ex.map(lambda r: fetch(MEDIA + r[3], folder / f'{r[0]}.img'), rows))
    rows = [r for r, good in zip(rows, ok) if good]
    if '--fetch-only' in ARGS:
        return {'name': d['name'], 'fetched': len(rows)}
    grids = {}
    for r in rows:
        try:
            g = shrink(folder / f'{r[0]}.img')
        except Exception:
            continue
        if g is not None:
            grids[r[0]] = g
    nums = list(grids)
    G = np.stack([grids[n] for n in nums])  # tokens x cells x 3
    row_of = {r[0]: r for r in rows}
    findings = {'name': d['name'], 'checked': len(nums), 'grid': GRID, 'tol': TOL, 'footprints': {}, 'missing': [], 'unlisted': []}
    absent = lambda v: v.lower().startswith('no ') or v.lower() in ('none', 'missingmouthitem')

    prints = {}  # (t, v) -> (loose mask, strict mask or None, colour per cell)
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
            colour = np.median(G[have], axis=0)  # cells x 3
            share = near(G[have], colour).mean(axis=0)
            other_share = near(G[~have], colour).mean(axis=0) if (~have).any() else np.zeros_like(share)
            loose = (share >= AGREE) & (other_share <= RARE)
            sib_share = np.zeros_like(share)
            for s in range(len(d['traits'][t])):
                sib = vals == s
                if s != v and sib.sum() >= 3:
                    sib_share = np.maximum(sib_share, near(G[sib], colour).mean(axis=0))
            strict = loose & (sib_share <= RARE)
            if loose.sum() >= MIN_CELLS:
                prints[(t, v)] = (loose, strict if strict.sum() >= MIN_CELLS else None, colour)
                findings['footprints'][f'{tname}={name}'] = [int(loose.sum()), int(strict.sum())]
        print(f'  learned {tname}', file=sys.stderr, flush=True)

    # --plant N: measure what the scan can catch. After learning, change N random Twonks' record of one trait to
    # another value that has a footprint (a fake misprint: the art stays as it is), and report how many get flagged.
    planted = []
    if '--plant' in ARGS:
        rng = np.random.default_rng(20261029)
        row_of = {n: list(r) for n, r in row_of.items()}
        types_with = sorted({t for t, _ in prints})
        while len(planted) < opt('--plant', 0):
            n = nums[rng.integers(len(nums))]
            t = types_with[rng.integers(len(types_with))]
            rec = row_of[n][T0 + t]
            others = [v for (tt, v) in prints if tt == t and v != rec]
            if rec not in [v for (tt, v) in prints if tt == t] or not others or any(p[0] == n for p in planted):
                continue
            fake = others[rng.integers(len(others))]
            planted.append((n, t, rec, fake))
            row_of[n][T0 + t] = fake

    for t in range(len(d['types'])):
        mine = {v: p for (tt, v), p in prints.items() if tt == t}
        if not mine:
            continue
        hit = lambda m, colour: near(G[:, m], colour[m]).mean(axis=1)
        loose = {v: hit(lo, c) for v, (lo, st, c) in mine.items()}
        strict = {v: hit(st, c) for v, (lo, st, c) in mine.items() if st is not None}
        for i, n in enumerate(nums):
            rec = row_of[n][T0 + t]
            if rec in loose:
                if loose[rec][i] >= MISS:
                    continue
                shown = [(float(s[i]), int(mine[v][1].sum()), v) for v, s in strict.items() if v != rec and s[i] >= HIT]
            elif rec < 0 or absent(str(d['traits'][t][rec][0])):
                shown = [(float(s[i]), int(mine[v][0].sum()), v) for v, s in loose.items() if s[i] >= HIT]
            else:
                continue
            if not shown:
                continue
            best, _, v = max(shown)
            findings['unlisted' if rec not in loose else 'missing'].append({
                'n': n, 'type': d['types'][t], 'art': d['traits'][t][v][0], 'match': round(best, 2),
                'record': d['traits'][t][rec][0] if rec >= 0 else '(none)',
                'record_match': round(float(loose[rec][i]), 2) if rec in loose else None})
    if planted:
        flagged = {(x['n'], x['type']) for x in findings['missing'] + findings['unlisted']}
        caught = [p for p in planted if (p[0], d['types'][p[1]]) in flagged]
        by_type = {}
        for n, t, rec, fake in planted:
            k = d['types'][t]
            by_type.setdefault(k, [0, 0])
            by_type[k][0] += 1
            by_type[k][1] += (n, k) in flagged
        findings['planted'] = {'planted': len(planted), 'caught': len(caught), 'by_type': by_type,
                               'missed': [{'n': n, 'type': d['types'][t], 'art': d['traits'][t][rec][0], 'fake_record': d['traits'][t][fake][0]}
                                          for n, t, rec, fake in planted if (n, d['types'][t]) not in flagged][:40]}
    return findings


def main():
    want = ARGS[0] if ARGS and not ARGS[0].startswith('--') else 'fox-syndicate'
    index = json.loads((DATA / 'index.json').read_text(encoding='utf-8'))
    for f in index['fleets']:
        if f['slug'] not in want.split(','):
            continue
        res = audit(f)
        if 'fetched' in res:
            print(f"{res['name']}: {res['fetched']} images cached", flush=True)
            continue
        (ROOT / 'audit' / f"{f['slug']}.{'plant' if '--plant' in ARGS else 'soft'}.json").write_text(json.dumps(res, indent=1), encoding='utf-8')
        print(f"{res['name']:<20} checked {res['checked']:>5}  grid {GRID}  tol {TOL}  footprints {len(res['footprints']):>4}  "
              f"missing {len(res['missing']):>4}  unlisted {len(res['unlisted']):>4}", flush=True)


if __name__ == '__main__':
    main()
