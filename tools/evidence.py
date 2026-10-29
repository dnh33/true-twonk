"""Evidence sheets for art misprints (tools/art-flags.json): one picture anyone can check by eye.

Row 1: the Twonk, with what its record says. Row 2: three Twonks whose record holds that same value. Row 3: three whose
record holds what the art seems to show. If the Twonk looks like row 3 and not row 2, the record and the art disagree.
Layer clashes get their own sheet (clash_sheet). Writes public/evidence/<collection slug>-<number>.png. Run: python tools/evidence.py [--cache D:/_twonk-art]
"""
import json, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from audit_art import fetch, DATA, MEDIA, T0, ROOT

ARGS = sys.argv[1:]
CACHE = Path(ARGS[ARGS.index('--cache') + 1]) if '--cache' in ARGS else Path('D:/_twonk-art')
OUT = ROOT / 'public' / 'evidence'
CELL, PAD, CAP = 240, 16, 30
BG, INK, DIM = (14, 13, 12), (240, 234, 222), (160, 152, 140)


def font(size):
    for name in ('arial.ttf', 'DejaVuSans.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()


def picture(slug, row):
    dest = CACHE / slug / f'{row[0]}.png'
    if not (dest.exists() and dest.stat().st_size) and not fetch(MEDIA + row[3], dest):
        dest = CACHE / slug / f'{row[0]}.img'
        fetch(MEDIA + row[3], dest)
    im = Image.open(dest).convert('RGB')
    # pixel art keeps its hard edges; illustrations are smoothed
    small = max(im.size) <= 512
    return im.resize((CELL, CELL), Image.NEAREST if small else Image.LANCZOS)


def sheet(fleet, d, n, type_, record, shown):
    t = d['types'].index(type_)
    value = lambda name: next((v for v, x in enumerate(d['traits'][t]) if str(x[0]).strip() == name.strip()), -1)
    row_of = {r[0]: r for r in d['tok'] if r[3]}
    flagged = {int(k) for k in d.get('art', {})}
    rec_v = value(record) if record != '(none)' else -1
    holders = lambda v: [r for r in d['tok'] if r[3] and r[T0 + t] == v and r[0] != n and r[0] not in flagged][:3]
    rows = [
        (f"{d['names'].get(str(n)) or d['name'] + ' #' + str(n)}: its record says {type_}: {record}", [row_of[n]]),
        (f'Three whose record says {type_}: {record}', holders(rec_v)),
        (f'Three whose record says {type_}: {shown}', holders(value(shown))),
    ]
    W = PAD + 3 * (CELL + PAD)
    H = PAD + sum(CAP + CELL + PAD for _ in rows) + CAP
    img = Image.new('RGB', (W, H), BG)
    draw = ImageDraw.Draw(img)
    f, small = font(17), font(14)
    y = PAD
    for caption, toks in rows:
        draw.text((PAD, y + 4), caption, fill=INK, font=f)
        y += CAP
        for i, r in enumerate(toks):
            x = PAD + i * (CELL + PAD)
            img.paste(picture(fleet['slug'], r), (x, y))
            draw.text((x + 6, y + CELL - 22), f'#{r[0]}', fill=INK, font=small, stroke_width=2, stroke_fill=BG)
        y += CELL + PAD
    draw.text((PAD, y), 'True Twonk: record from the blockchain, art from Twetch. Compare the first with the two rows below.', fill=DIM, font=small)
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{fleet['slug']}-{n}.png"
    img.save(path, optimize=True)
    return path


def clash_sheet(fleet, d, n, top, top_value, under, under_value, crop=(0.15, 0.05, 0.85, 0.6)):
    """Layer clashes (tools/layer-clashes.json): two parts that overlap oddly because of the drawing order.
    Row 1: the Twonk. Row 2: the same lower part with other upper parts, showing which one is drawn on top. Row 3: the
    same upper part on other Twonks, showing where it usually sits. Only the area named by crop is shown, larger."""
    ti, ui = d['types'].index(top), d['types'].index(under)
    value = lambda t, name: next(v for v, x in enumerate(d['traits'][t]) if str(x[0]).strip() == name.strip())
    tv, uv = value(ti, top_value), value(ui, under_value)
    named = lambda t, v: v >= 0 and not str(d['traits'][t][v][0]).lower().startswith('no ')
    row_of = {r[0]: r for r in d['tok'] if r[3]}
    others = [r for r in d['tok'] if r[3] and r[0] != n]
    rows = [
        (f"{d['names'].get(str(n)) or d['name'] + ' #' + str(n)}: {top} {top_value} with {under} {under_value}", [row_of[n]]),
        (f'{under} {under_value} with other {top.lower()} items: which is drawn on top', [r for r in others if r[T0 + ui] == uv and named(ti, r[T0 + ti])][:3]),
        (f'{top} {top_value} on others: where it usually sits', [r for r in others if r[T0 + ti] == tv and named(ui, r[T0 + ui])][:3]),
    ]
    W = PAD + 3 * (CELL + PAD)
    H = PAD + sum(CAP + CELL + PAD for _ in rows) + CAP
    img = Image.new('RGB', (W, H), BG)
    draw = ImageDraw.Draw(img)
    f, small = font(17), font(14)
    y = PAD
    for caption, toks in rows:
        draw.text((PAD, y + 4), caption, fill=INK, font=f)
        y += CAP
        for i, r in enumerate(toks):
            x = PAD + i * (CELL + PAD)
            # crop from the full-size chain copy, so the enlarged area keeps its detail
            full = Image.open(Path('D:/_twonk-chain/b') / f'{r[3]}.bin').convert('RGB')
            box = (int(crop[0] * full.width), int(crop[1] * full.height), int(crop[2] * full.width), int(crop[3] * full.height))
            img.paste(full.crop(box).resize((CELL, CELL), Image.LANCZOS), (x, y))
            draw.text((x + 6, y + CELL - 22), f'#{r[0]}', fill=INK, font=small, stroke_width=2, stroke_fill=BG)
        y += CELL + PAD
    draw.text((PAD, y), 'True Twonk: art from the blockchain. Head area shown, enlarged.', fill=DIM, font=small)
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{fleet['slug']}-{n}.png"
    img.save(path, optimize=True)
    return path


def main():
    flags = json.loads((ROOT / 'tools' / 'art-flags.json').read_text(encoding='utf-8'))
    index = json.loads((DATA / 'index.json').read_text(encoding='utf-8'))
    clashes = json.loads((ROOT / 'tools' / 'layer-clashes.json').read_text(encoding='utf-8'))
    for c, toks in clashes.items():
        fleet = next(f for f in index['fleets'] if f['c'] == c)
        d = json.loads((DATA / f'{c}.json').read_text(encoding='utf-8'))
        for n, items in toks.items():
            for top, top_value, under, under_value, _ in items:
                print(clash_sheet(fleet, d, int(n), top, top_value, under, under_value))
    for c, toks in flags.items():
        fleet = next(f for f in index['fleets'] if f['c'] == c)
        d = json.loads((DATA / f'{c}.json').read_text(encoding='utf-8'))
        for n, items in toks.items():
            for type_, record, shown in items:
                print(sheet(fleet, d, int(n), type_, record, shown))


if __name__ == '__main__':
    main()
