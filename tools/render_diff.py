"""Re-render and diff: does each Twonk's art look like what its own record predicts?

A Twonk is drawn in layers: background, body, mouth, eyes, hat, hand item... This learns that from the collection
itself, with no layer files:
  1. Per pixel cell, each trait value "votes" the colour that the OTHER Twonks with that value show there (leave-one-out,
     so a Twonk never predicts itself). A vote counts only when at least MIN_SUPPORT others hold the value and SHARE of
     them agree on one colour: then the value paints that cell.
  2. Where two of a Twonk's values both paint a cell in different colours, one covers the other. Which one wins is
     counted over the whole collection (a balloon covers the background), giving a layer order.
  3. A Twonk's record is "re-rendered": each cell takes the colour of its top painting value. Where no single value
     paints, a pair of values may (a collar shows the frog's skin colour: Body and Frog together decide it).
A Twonk is flagged when a connected patch of judged cells disagrees with its own re-render. That covers a wrong trait
(the record says one mouth, the art shows another) and a drawing glitch (a shifted, missing or pasted part), when the
patch is big enough. Planted fakes of both kinds measure how often it catches them. Nothing here is a claim until a
flag passes the review gate (tools/misprint-reviews.json).

The art is read from the blockchain copies tools/art-chain.mjs keeps (byte-identical to Twetch's, checked there).

Run: python tools/render_diff.py <slug> [--plant 300] [--seed 1] [--top 40] [--chain D:/_twonk-chain/b] [--sheets D:/_twonk-diff]
Writes audit/<slug>.diff.json and an actual | expected | difference picture for the top patches.
"""
import json, sys, time
from itertools import combinations
from pathlib import Path
import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, str(Path(__file__).resolve().parent))
from audit_art import grid, DATA, T0  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MIN_SUPPORT = 4   # others holding the value, at least
SHARE = 0.9       # ...and this share of them agree on the colour
# Painted art (JPEG, soft edges) is read as a coarse grid: each block's average colour, binned LEVELS steps per channel.
# A colour one bin away in every channel counts as the same, so JPEG noise at a bin edge is not a disagreement.
SOFT = {'on': False, 'levels': 6}


def soft_grid(path, n, levels):
    a = np.asarray(Image.open(path).convert('RGB').resize((n, n), Image.BOX)).astype(np.int32) * levels // 256
    return (a[..., 0] * levels + a[..., 1]) * levels + a[..., 2]


def differ(a, b):
    """Colours that disagree: exactly for pixel art; for painted art, more than one bin apart in some channel."""
    if not SOFT['on']:
        return a != b
    L = SOFT['levels']
    return (np.abs(a // (L * L) - b // (L * L)) > 1) | (np.abs(a // L % L - b // L % L) > 1) | (np.abs(a % L - b % L) > 1)


def to_rgb(g):
    if not SOFT['on']:
        return np.stack([(g >> 16) & 255, (g >> 8) & 255, g & 255], -1)
    L = SOFT['levels']
    return np.stack([g // (L * L), g // L % L, g % L], -1) * 256 // L + 128 // L


def votes(G, V, j, cols, Q):
    """For one cell and one trait (cols = one type, or two types read together): per query, the colour the others
    with the same value(s) show, and whether that vote counts. Q = (records, own records, own real art)."""
    QV, QO, QA = Q
    pal, c = np.unique(G[:, j], return_inverse=True)
    C = len(pal)
    key = lambda R: R[:, cols[0]] * 1000 + (R[:, cols[1]] if len(cols) > 1 else 0)
    keys, k = np.unique(key(V), return_inverse=True)
    counts = np.bincount(k * C + c, minlength=len(keys) * C).reshape(len(keys), C)
    a1 = counts.argmax(1)
    n1 = counts[np.arange(len(keys)), a1]
    rest = counts.copy()
    rest[np.arange(len(keys)), a1] = 0
    a2 = rest.argmax(1)
    n2 = rest[np.arange(len(keys)), a2]
    tot = counts.sum(1)
    kq = key(QV)
    pos = np.clip(np.searchsorted(keys, kq), 0, len(keys) - 1)
    found = keys[pos] == kq
    own = found & (key(QO) == kq)  # the Twonk sits in this group itself: leave it out
    oc = np.searchsorted(pal, QA[:, j])
    m1 = n1[pos] - (own & (oc == a1[pos]))
    m2 = n2[pos] - (own & (oc == a2[pos]))
    t = tot[pos] - own
    col = np.where(m2 > m1, pal[a2[pos]], pal[a1[pos]])
    top = np.maximum(m1, m2)
    ok = found & (t >= MIN_SUPPORT) & (top >= SHARE * np.maximum(t, 1))
    return col, ok, top / np.maximum(t, 1)


def layer_order(G, V):
    """Which trait covers which: wins[a, b] = cells where a and b both paint, differ, and the art shows a's colour."""
    T = V.shape[1]
    Q = (V, V, G)
    wins = np.zeros((T, T), np.int64)
    for j in range(G.shape[1]):
        if len(np.unique(G[:, j])) == 1:
            continue
        vs = [votes(G, V, j, (t,), Q)[:2] for t in range(T)]
        for a in range(T):
            for b in range(T):
                if a != b:
                    ca, oa = vs[a]
                    cb, ob = vs[b]
                    wins[a, b] += int((oa & ob & (ca != cb) & (G[:, j] == ca)).sum())
    beats = (wins > wins.T).sum(1)  # how many traits each one covers
    return wins, beats


def peel(G, V, K, order, Q, first=None, paint_out=None):
    """Re-render every query record, peeling layers top-down per cell: (colour, judged) per cell.
    A value paints a cell when the Twonks holding it, and not already covered there by a higher layer, agree on one
    colour (opaque), or agree once a lower trait is known (see-through: a visor tinted by the frog under it).
    "(none)" never paints. Q = (records, the Twonk each record belongs to, the art being judged); each Twonk is left out
    of every group it sits in itself.
    A value too rare to learn may cover a cell or not. first = a first pass over every Twonk with rare values read as
    see-through: a rare value is taken to cover a cell where some other holder's art departs from that first pass there,
    or where no other holder could be checked, but only where its trait ever paints at all (a one-of-one background never sits on the frog). Cells it may cover are left
    unjudged. Without first, rare values are see-through."""
    QV, own, _ = Q
    N, J = G.shape
    q = len(QV)
    pred = np.zeros((q, J), G.dtype)
    judged = np.zeros((q, J), bool)
    rows = np.arange(N)
    for j in range(J):
        pal, c = np.unique(G[:, j], return_inverse=True)
        C = len(pal)
        if C == 1:
            pred[:, j], judged[:, j] = pal[0], True
            continue
        oc = c[own]
        if first is not None:
            seen = first[1][:, j]                          # the first pass judged this Twonk here
            off = seen & differ(first[0][:, j], G[:, j])     # ...and its art departs from it
        covered = np.zeros(N, bool)  # a higher layer already paints this Twonk here
        done = np.zeros(q, bool)
        for li, t in enumerate(order):
            Kt = K[t] + 1
            S = ~covered & (V[:, t] < K[t])  # holders of a real value, not covered above
            vt = V[:, t]
            counts = np.bincount(vt[S] * C + c[S], minlength=Kt * C).reshape(Kt, C)
            tot = counts.sum(1)
            a1 = counts.argmax(1)
            n1 = counts[np.arange(Kt), a1]
            opaque = (tot >= MIN_SUPPORT + 1) & (n1 >= SHARE * np.maximum(tot, 1))
            opaque[K[t]] = False
            # see-through: the value's colour here is fixed once one lower trait is known
            blend_u = np.full(Kt, -1)
            best = np.zeros(Kt)
            shows = np.zeros(N, bool)  # the Twonk's colour here is some lower trait's usual colour here
            for u in order[li + 1:]:
                own_col = np.bincount(V[:, u] * C + c, minlength=(K[u] + 1) * C).reshape(K[u] + 1, C).argmax(1)
                shows |= (V[:, u] < K[u]) & (own_col[V[:, u]] == c)
                key = vt * 1000 + V[:, u]
                keys, k = np.unique(key[S], return_inverse=True)
                if not len(keys):
                    continue
                gc = np.bincount(k * C + c[S], minlength=len(keys) * C).reshape(len(keys), C)
                g1 = gc.max(1)
                rest = gc.copy()
                rest[np.arange(len(keys)), gc.argmax(1)] = 0
                right = np.where(g1 - 1 > rest.max(1), g1, 0)  # leave-one-out correct
                share = np.bincount(keys // 1000, weights=right, minlength=Kt) / np.maximum(tot, 1)
                # only a real tint counts: when the colour is just the lower trait's own colour showing through (a
                # background around the frog), the value does not paint here at all
                tinted = gc.argmax(1) != own_col[keys % 1000]
                tint = np.bincount(keys // 1000, weights=gc.sum(1) * tinted, minlength=Kt) / np.maximum(tot, 1)
                take = ~opaque & (tot >= MIN_SUPPORT + 1) & (share >= SHARE) & (share > best) & (tint >= 0.5)
                blend_u[take], best[take] = u, share[take]
            blend_u[K[t]] = -1
            paints = opaque | (blend_u >= 0)
            if paint_out is not None:
                paint_out[t][:, j] = paints  # the cells each value draws (its footprint)
            # see-through is a claim too: the holders must show what lies under them. A value that neither paints nor
            # lets the layers below show (a tinted glass with too few examples per frog colour) leaves the cell unjudged
            clear = np.bincount(vt[S], weights=shows[S], minlength=Kt) >= SHARE * np.maximum(tot, 1)
            unsure = (tot >= MIN_SUPPORT + 1) & ~paints & ~clear
            unsure[K[t]] = False
            # render the queries whose top painting layer is this one
            qv = QV[:, t]
            mine = (V[own, t] == qv) & S[own]  # the Twonk sits in this group itself
            # a value too rare to learn (fewer than MIN_SUPPORT others uncovered here) may or may not cover this cell:
            # nothing below it can be judged, so the cell is left unjudged rather than guessed
            if first is not None and paints.any():
                has = V[own, t] == qv
                odd = np.bincount(vt, weights=off, minlength=Kt)[qv] - (has & off[own])
                looked = np.bincount(vt, weights=seen, minlength=Kt)[qv] - (has & seen[own])
                # covers it when no other holder could be checked here, or one departs from the first pass here
                blind = ~done & (qv < K[t]) & ~paints[qv] & (tot[qv] - mine < MIN_SUPPORT) & ((looked == 0) | (odd > 0))
                done |= blind
            fog = ~done & unsure[qv]
            done |= fog
            hit = ~done & paints[qv]
            op = hit & opaque[qv]
            if op.any():
                cnt = counts[qv[op]].copy()
                cnt[np.arange(op.sum()), oc[op]] -= mine[op]
                ttl = cnt.sum(1)
                m1 = cnt.argmax(1)
                ok = (ttl >= MIN_SUPPORT) & (cnt[np.arange(op.sum()), m1] >= SHARE * np.maximum(ttl, 1))
                idx = np.flatnonzero(op)
                pred[idx, j], judged[idx, j] = pal[m1], ok
            bl = hit & ~opaque[qv]
            for u in np.unique(blend_u[qv[bl]]):
                sel = np.flatnonzero(bl & (blend_u[qv] == u))
                gS = S & (V[:, t] < K[t])
                key = vt * 1000 + V[:, u]
                keys, k = np.unique(key[gS], return_inverse=True)
                gc = np.bincount(k * C + c[gS], minlength=len(keys) * C).reshape(len(keys), C)
                kq = qv[sel] * 1000 + QV[sel, u]
                pos = np.clip(np.searchsorted(keys, kq), 0, len(keys) - 1)
                found = keys[pos] == kq
                cnt = gc[pos].copy()
                me = mine[sel] & (V[own[sel], u] == QV[sel, u])
                cnt[np.arange(len(sel)), oc[sel]] -= me
                ttl = cnt.sum(1)
                m1 = cnt.argmax(1)
                ok = found & (ttl >= MIN_SUPPORT) & (cnt[np.arange(len(sel)), m1] >= SHARE * np.maximum(ttl, 1))
                pred[sel, j], judged[sel, j] = pal[m1], ok
            done |= hit
            covered |= paints[vt]
    return pred, judged


PAIR_MIN = 2  # others sharing a Twonk's exact pair of values, at least, for the pair to clear a disagreement


def pair_clear(G, V, Q, wrong):
    """Clears a disagreeing cell when the other Twonks holding the same PAIR of values (a jacket and a tail colour, an
    axe and a mouth) all show the art's colour there: the drawing order changes per item, not per trait type, in
    painted collections. It only clears: it never makes a cell disagree, so it cannot invent a flag. It also means an
    error repeated on every holder of a pair looks normal. Q = (records, own Twonk, art judged)."""
    QV, own, art = Q
    T = V.shape[1]
    pairs = [(a, b) for a in range(T) for b in range(a + 1, T)]
    out = wrong.copy()
    for j in np.flatnonzero(wrong.any(0)):
        qs = np.flatnonzero(out[:, j])
        if not len(qs):
            continue
        pal, c = np.unique(G[:, j], return_inverse=True)
        C = len(pal)
        oc = c[own[qs]]
        for a, b in pairs:
            key = V[:, a] * 1000 + V[:, b]
            keys, k = np.unique(key, return_inverse=True)
            counts = np.bincount(k * C + c, minlength=len(keys) * C).reshape(len(keys), C)
            kq = QV[qs, a] * 1000 + QV[qs, b]
            pos = np.clip(np.searchsorted(keys, kq), 0, len(keys) - 1)
            found = keys[pos] == kq
            cnt = counts[pos].copy()
            me = found & (key[own[qs]] == kq)
            cnt[np.arange(len(qs)), oc] -= me
            tot = cnt.sum(1)
            top = cnt.argmax(1)
            agree = cnt[np.arange(len(qs)), top]
            ok = found & (tot >= PAIR_MIN) & (agree >= np.maximum(PAIR_MIN, SHARE * tot)) & ~differ(pal[top], art[qs, j])
            out[qs[ok], j] = False
            qs = qs[~ok]
            oc = oc[~ok]
            if not len(qs):
                break
    return out


def worst_patch(wrong, shape):
    lab, n = ndimage.label(wrong.reshape(shape))
    if not n:
        return 0
    return int(np.bincount(lab.ravel())[1:].max())


def sheet(path, art, pred, judged, wrong, shape, cell=12):
    """actual | what the record predicts (grey = not judged) | the cells that disagree, in red."""
    rgb = lambda g: to_rgb(g).reshape(*shape, 3).astype(np.uint8)
    a = rgb(art)
    e = rgb(np.where(judged, pred, 0))
    e[~judged.reshape(shape)] = (128, 128, 128)
    diff = (a * 0.35 + 255 * 0.65).astype(np.uint8)
    diff[wrong.reshape(shape)] = (220, 30, 30)
    gap = np.full((shape[0], 2, 3), 255, np.uint8)
    Image.fromarray(np.concatenate([a, gap, e, gap, diff], 1).repeat(cell, 0).repeat(cell, 1)).save(path)


def load(slug, chain, opt):
    """One collection's art and records: (d, nums, G cells per Twonk, V value per trait, K values per trait, grid shape)."""
    index = json.loads((DATA / 'index.json').read_text(encoding='utf-8'))
    fleet = next(f for f in index['fleets'] if f['slug'] == slug)
    d = json.loads((DATA / f"{fleet['c']}.json").read_text(encoding='utf-8'))
    t0 = time.time()
    grids, sizes = {}, {}
    for r in d['tok']:
        p = chain / f'{r[3]}.bin' if r[3] else None
        if not p or not p.exists():
            continue
        g, _ = grid(p)
        if g is not None:
            grids[r[0]] = g
            sizes[g.shape] = sizes.get(g.shape, 0) + 1
    if not sizes or sum(sizes.values()) < len(d['tok']) * 0.95:
        # painted art: the coarse, tolerant grid
        n_soft = opt('--soft', 100)
        SOFT['on'], SOFT['levels'] = True, opt('--levels', 6)
        rows_ = [r for r in d['tok'] if r[3] and (chain / f'{r[3]}.bin').exists()]
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(8) as ex:
            gs = list(ex.map(lambda r: soft_grid(chain / f'{r[3]}.bin', n_soft, SOFT['levels']), rows_))
        grids = {r[0]: g for r, g in zip(rows_, gs)}
        sizes = {(n_soft, n_soft): len(grids)}
        print(f"{d['name']}: painted art, read as a {n_soft}x{n_soft} grid of block colours, {SOFT['levels']} steps per channel")
    shape = max(sizes, key=sizes.get)
    row = {r[0]: r for r in d['tok']}
    nums = sorted(n for n, g in grids.items() if g.shape == shape)
    G = np.stack([grids[n].ravel() for n in nums]).astype(np.int32 if SOFT['on'] else np.int64)
    T = len(d['types'])
    K = [len(d['traits'][t]) for t in range(T)]
    name = lambda t, v: '(none)' if v >= K[t] else str(d['traits'][t][v][0])
    # no value is a value too: "(none)" gets index K[t]
    # a value that says the item is absent ("No Mouth Item", "None") is the same as no value: it draws nothing
    absent = [{v for v, val in enumerate(d['traits'][t]) if str(val[0]).strip().lower().startswith('no ') or str(val[0]).strip().lower() == 'none'} for t in range(T)]
    V = np.array([[row[n][T0 + t] if row[n][T0 + t] >= 0 and row[n][T0 + t] not in absent[t] else K[t] for t in range(T)] for n in nums], np.int64)
    print('  read as absent: ' + ', '.join(f"{d['types'][t]} \"{d['traits'][t][v][0]}\"" for t in range(T) for v in sorted(absent[t])))
    print(f"{d['name']}: {len(nums)} Twonks, grid {shape}, loaded in {time.time() - t0:.0f}s")
    return d, nums, G, V, K, shape


def main():
    args = sys.argv[1:]
    opt = lambda k, dflt: type(dflt)(args[args.index(k) + 1]) if k in args else dflt
    slug = args[0]
    plant, seed, ntop = opt('--plant', 300), opt('--seed', 1), opt('--top', 40)
    chain, sheets = Path(opt('--chain', 'D:/_twonk-chain/b')), Path(opt('--sheets', 'D:/_twonk-diff'))
    t0 = time.time()
    d, nums, G, V, K, shape = load(slug, chain, opt)
    T = len(d['types'])
    name = lambda t, v: '(none)' if v >= K[t] else str(d['traits'][t][v][0])

    wins, beats = layer_order(G, V)
    order = sorted(range(T), key=lambda t: -beats[t])
    print(f"  layer order learned (top first): " + ' > '.join(f"{d['types'][t]}({beats[t]})" for t in order) + f"  [{time.time() - t0:.0f}s]")

    holders = [dict(zip(*np.unique(V[:, t], return_counts=True))) for t in range(T)]
    rng = np.random.default_rng(seed)
    # planted fakes. Wrong trait: the art stays, the record names another value of one trait (only values that
    # paint somewhere, else no picture could show the swap). Glitch: the record stays, the art is damaged.
    fakes_w = []
    while len(fakes_w) < plant:
        i, t = int(rng.integers(len(nums))), int(rng.integers(T))
        opts = [v for v, k in holders[t].items() if v != V[i, t] and k >= MIN_SUPPORT + 1]
        if opts:
            r = V[i].copy()
            r[t] = int(rng.choice(opts))
            fakes_w.append((i, r, t))
    H, W = shape
    kinds = ['erase', 'shift', 'paste']
    # glitch sizes, in cells: a single cell, 2 by 2, and 3 to 6 wide; each size with each kind of damage
    sizes = [(1, 1), (2, 2), (3, 6)]
    fakes_g = []
    while len(fakes_g) < plant:
        i, kind = int(rng.integers(len(nums))), kinds[len(fakes_g) % 3]
        lo, hi = sizes[(len(fakes_g) // 3) % 3]
        art = G[i].reshape(shape).copy()
        h, w = int(rng.integers(lo, hi + 1)), int(rng.integers(lo, hi + 1))
        y, x = int(rng.integers(1, H - h - 1)), int(rng.integers(1, W - w - 1))
        if kind == 'erase':
            art[y:y + h, x:x + w] = art[0, 0]
        elif kind == 'shift':
            art[y:y + h, x:x + w] = G[i].reshape(shape)[y + 1:y + h + 1, x + 1:x + w + 1]
        else:
            art[y:y + h, x:x + w] = G[int(rng.integers(len(nums)))].reshape(shape)[y:y + h, x:x + w]
        if int(differ(art.ravel(), G[i]).sum()) >= 1:  # a real change, beyond the tolerance
            fakes_g.append((i, art.ravel(), kind, max(h, w) if hi < 3 else 3))
    wi = [i for i, _, _ in fakes_w]
    gi = [i for i, _, _, _ in fakes_g]
    QV = np.concatenate([V, np.array([r for _, r, _ in fakes_w]), V[gi]])
    own = np.concatenate([np.arange(len(nums)), wi, gi])  # the Twonk each record belongs to: left out of its groups
    judge = np.concatenate([G, G[wi], np.array([a for _, a, _, _ in fakes_g])])  # the art being judged
    first = peel(G, V, K, order, (V, np.arange(len(nums)), G))
    pred, judged = peel(G, V, K, order, (QV, own, judge), first)
    print(f"  re-rendered {len(QV)} records [{time.time() - t0:.0f}s]")
    wrong = judged & differ(pred, judge)
    if SOFT['on'] or '--pairs' in args:
        before = int(wrong.sum())
        wrong = pair_clear(G, V, (QV, own, judge), wrong)
        print(f"  pair check cleared {before - int(wrong.sum())} of {before} disagreeing cells [{time.time() - t0:.0f}s]")
    patch = np.array([worst_patch(w, shape) for w in wrong])
    N, P = len(nums), plant
    real, pw, pg = patch[:N], patch[N:N + P], patch[N + P:]
    # a swap whose two values render the same art everywhere cannot show in any picture: counted apart
    same_art = np.array([not (judged[N + k] & judged[i] & differ(pred[N + k], pred[i])).any() and pw[k] == 0 for k, i in enumerate(wi)])

    # custom one-of-ones (a "Signature Series" value): drawn by hand, not from the parts, so a part-by-part re-render
    # says nothing about them. Listed apart, never flagged.
    sig = [t for t in range(T) if 'signature' in d['types'][t].lower()]
    custom = np.array([any(V[i, t] < K[t] for t in sig) for i in range(N)])
    real = np.where(custom, 0, real)
    print(f"  patch >= | real flags | wrong-trait fakes caught | glitch fakes caught (erase/shift/paste)")
    table = []
    for s in range(1, 16):
        rf = int(((real >= s) & ~custom).sum())
        wf = int(((pw >= s) & ~same_art).sum())
        gk = {k: int(sum(1 for x, g in zip(pg, fakes_g) if g[2] == k and x >= s)) for k in kinds}
        table.append({'patch': s, 'real': rf, 'wrong': wf, 'glitch': gk})
        print(f"  {s:>8} | {rf:>10} | {wf:>4}/{int((~same_art).sum())} | {sum(gk.values()):>4}/{P} ({gk['erase']}/{gk['shift']}/{gk['paste']})")
    print("  glitch fakes caught by size (patch >= 1 / 2 / 3 / 4 / 5):")
    for z, label in [(1, 'single cell'), (2, '2 by 2'), (3, '3 to 6 wide')]:
        sel = [k for k, g in enumerate(fakes_g) if g[3] == z]
        print(f"    {label:>11}: " + ' / '.join(f"{int((pg[sel] >= t).sum())}" for t in range(1, 6)) + f"  of {len(sel)}")
    cov = judged[:N].mean(1)
    print(f"  custom one-of-ones (not judged): {int(custom.sum())}; Twonks judged on under half their cells: {int(((cov < 0.5) & ~custom).sum())}, under 90%: {int(((cov < 0.9) & ~custom).sum())}")
    print(f"  cells judged per Twonk: median {np.median(cov):.0%}, lowest {cov.min():.0%}; {int(same_art.sum())} planted swaps change nothing in the picture (not counted)")

    # the top patches, explained: which single record change makes the art fit best
    top = [int(i) for i in np.argsort(-real, kind='stable')[:ntop] if real[i] > 0]
    alts, owner = [], []
    for i in top:
        for t in range(T):
            for v, k in holders[t].items():
                if v != V[i, t] and k >= MIN_SUPPORT + 1:
                    r = V[i].copy()
                    r[t] = v
                    alts.append(r)
                    owner.append((i, t, v))
    expl = {}
    if alts:
        oi = [i for i, _, _ in owner]
        ap, aj = peel(G, V, K, order, (np.array(alts), np.array(oi), G[oi]), first)
        for k, (i, t, v) in enumerate(owner):
            before_bad = wrong[i]
            fixed = int((before_bad & aj[k] & ~differ(ap[k], G[i])).sum())
            broke = int((~before_bad & judged[i] & aj[k] & differ(ap[k], G[i])).sum())
            gain = fixed - broke
            if gain > expl.get(i, (0,))[0]:
                expl[i] = (gain, t, v)
    (sheets / slug).mkdir(parents=True, exist_ok=True)
    flags = []
    print("  biggest disagreeing patches:")
    for i in top:
        n = nums[i]
        sheet(sheets / slug / f'{n}.png', G[i], pred[i], judged[i], wrong[i], shape, cell=5 if SOFT['on'] else 12)
        e = expl.get(i)
        why = {'type': d['types'][e[1]], 'record': name(e[1], V[i, e[1]]), 'art fits': name(e[1], e[2]), 'cells fixed': e[0]} if e else None
        flags.append({'n': n, 'patch': int(real[i]), 'cells': int(wrong[i].sum()), 'explain': why})
        print(f"    #{n}: patch {real[i]}, {int(wrong[i].sum())} cells" + (f"; art fits {why['type']} \"{why['art fits']}\", record \"{why['record']}\" ({why['cells fixed']} cells fixed)" if why else '; no single trait change explains it'))
    out = {'name': d['name'], 'checked': N, 'custom': [nums[i] for i in range(N) if custom[i]], 'grid': list(shape), 'layers': [d['types'][t] for t in order],
           'judged_median': float(np.median(cov)), 'judged_min': float(cov.min()), 'same_art_swaps': int(same_art.sum()),
           'planted': P, 'table': table, 'top': flags,
           'patches': {str(nums[i]): int(real[i]) for i in range(N) if real[i] > 0}}
    (ROOT / 'audit').mkdir(exist_ok=True)
    (ROOT / 'audit' / f'{slug}.diff.json').write_text(json.dumps(out, indent=1))
    print(f"  done in {time.time() - t0:.0f}s; sheets in {sheets / slug}")


if __name__ == '__main__':
    main()
