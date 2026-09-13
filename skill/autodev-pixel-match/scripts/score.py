#!/usr/bin/env python3
"""
Score how far a rendered screen is from its design reference, and say where.

    python3 score.py --ref .autodev/design/home.png --render .autodev/design/render-home.png --screen home \
        [--out-dir .autodev/design] [--mask x0,y0,x1,y1]... [--colors 8] [--grid 48x96]

Writes  <out-dir>/score-<screen>.json   the number the pipeline gates on, plus the worst blocks
        <out-dir>/diff-<screen>.png     the reference with every mismatching cell painted red

Method: both images are resized onto the same grid (the reference's aspect, so a render taken
at the wrong viewport shows up as a warning rather than being silently stretched), every cell is
classified to the reference's own palette, and the classes are diffed. Classifying first ignores
JPEG noise, lighting and anti-aliasing while catching every real difference of shape or colour.

Masks are fractions of the image (0-1) — x0,y0,x1,y1 — for regions that are legitimately
different: a QR code carrying another URL, live prices, a real photo. State every mask; the
JSON records them and how much of the picture they cover, and the gate refuses a score that
masked most of the screen.

Exit code is 0 when the score was written, whatever the number is: the threshold is the
pipeline's decision (.autodev.json "design.maxMismatchPct"), not this script's.
"""
import argparse
import json
import os
import sys
from datetime import datetime, timezone

try:
    import numpy as np
    from PIL import Image, ImageDraw
except ImportError:  # pragma: no cover
    print("score.py: needs Pillow and numpy (pip install pillow numpy)", file=sys.stderr)
    sys.exit(2)


def hexcol(c):
    return "#%02X%02X%02X" % tuple(int(v) for v in c[:3])


def ref_palette(im, k):
    small = im.convert("RGB")
    small.thumbnail((256, 256))
    q = small.quantize(colors=k, method=Image.Quantize.MEDIANCUT)
    pal = q.getpalette()[: 3 * k]
    return np.array([pal[i:i + 3] for i in range(0, len(pal), 3)], dtype=float)


def classify(im, grid, pal):
    a = np.asarray(im.convert("RGB").resize(grid, Image.LANCZOS)).astype(float)  # (rows, cols, 3)
    d = ((a[:, :, None, :] - pal[None, None, :, :]) ** 2).sum(-1)               # (rows, cols, k)
    return d.argmin(-1), a


def main(argv):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--ref", required=True)
    p.add_argument("--render", required=True)
    p.add_argument("--screen", required=True, help="name used in compare-<screen>.png")
    p.add_argument("--out-dir", default=None, help="default: the reference's directory")
    p.add_argument("--mask", action="append", default=[], help="x0,y0,x1,y1 as fractions 0-1; repeatable")
    p.add_argument("--colors", type=int, default=8)
    p.add_argument("--grid", default="48x96", help="cells across x down; default 48x96")
    p.add_argument("--blocks", default="6x12", help="report grid for the worst blocks")
    a = p.parse_args(argv[1:])

    out_dir = a.out_dir or os.path.dirname(os.path.abspath(a.ref))
    ref = Image.open(a.ref).convert("RGB")
    ren = Image.open(a.render).convert("RGB")
    cols, rows = (int(v) for v in a.grid.lower().split("x"))
    bx, by = (int(v) for v in a.blocks.lower().split("x"))

    ref_aspect, ren_aspect = ref.width / ref.height, ren.width / ren.height
    aspect_delta = abs(ref_aspect - ren_aspect) / ref_aspect
    warnings = []
    if aspect_delta > 0.03:
        warnings.append(f"aspect mismatch: reference {ref_aspect:.3f} vs render {ren_aspect:.3f} "
                        f"({aspect_delta * 100:.0f}%) — render at the reference's viewport before trusting this score")

    pal = ref_palette(ref, a.colors)
    A, ra = classify(ref, (cols, rows), pal)
    B, rb = classify(ren, (cols, rows), pal)

    mask = np.ones((rows, cols), bool)
    masks = []
    for m in a.mask:
        x0, y0, x1, y1 = (float(v) for v in m.split(","))
        mask[int(y0 * rows):max(int(y0 * rows) + 1, round(y1 * rows)),
             int(x0 * cols):max(int(x0 * cols) + 1, round(x1 * cols))] = False
        masks.append([x0, y0, x1, y1])
    masked_pct = 100 * (1 - mask.mean())
    diff = (A != B) & mask
    mismatch_pct = 100 * diff.sum() / max(1, mask.sum())

    # Worst blocks: where to look first, with the colour each side actually has there.
    worst = []
    bh, bw = rows / by, cols / bx
    for j in range(by):
        for i in range(bx):
            r0, r1, c0, c1 = round(j * bh), round((j + 1) * bh), round(i * bw), round((i + 1) * bw)
            cell_mask = mask[r0:r1, c0:c1]
            if not cell_mask.any():
                continue
            pct = 100 * diff[r0:r1, c0:c1].sum() / cell_mask.sum()
            if pct <= 0:
                continue
            sel = diff[r0:r1, c0:c1]
            worst.append({
                "block": {"col": i, "row": j, "x0": round(i / bx, 3), "y0": round(j / by, 3),
                          "x1": round((i + 1) / bx, 3), "y1": round((j + 1) / by, 3)},
                "mismatchPct": round(pct, 1),
                "reference": hexcol(ra[r0:r1, c0:c1][sel].mean(0)),
                "render": hexcol(rb[r0:r1, c0:c1][sel].mean(0)),
            })
    worst.sort(key=lambda b: -b["mismatchPct"])

    # The heat map: the reference, mismatching cells painted red, masked cells hatched grey.
    heat = ref.copy().convert("RGBA")
    layer = Image.new("RGBA", heat.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    cw, ch = heat.width / cols, heat.height / rows
    for r in range(rows):
        for c in range(cols):
            box = [c * cw, r * ch, (c + 1) * cw, (r + 1) * ch]
            if not mask[r, c]:
                d.rectangle(box, fill=(120, 120, 120, 110))
            elif diff[r, c]:
                d.rectangle(box, fill=(230, 30, 30, 150))
    heat = Image.alpha_composite(heat, layer).convert("RGB")
    diff_name = f"diff-{a.screen}.png"
    heat.save(os.path.join(out_dir, diff_name))

    score = {
        "screen": a.screen,
        "reference": os.path.basename(a.ref),
        "render": os.path.basename(a.render),
        "mismatchPct": round(float(mismatch_pct), 1),
        "maskedPct": round(float(masked_pct), 1),
        "masks": masks,
        "grid": {"cols": cols, "rows": rows},
        "palette": [hexcol(c) for c in pal],
        "worstBlocks": worst[:8],
        "warnings": warnings,
        "diff": diff_name,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tool": "autodev-pixel-match/score.py",
    }
    out = os.path.join(out_dir, f"score-{a.screen}.json")
    with open(out, "w") as f:
        json.dump(score, f, indent=2)

    print(f"{a.screen}: {score['mismatchPct']}% mismatch ({score['maskedPct']}% masked) → {out}")
    for w in warnings:
        print("  warning:", w)
    for b in worst[:5]:
        bb = b["block"]
        print(f"  block col {bb['col']} row {bb['row']} (x {bb['x0']}-{bb['x1']}, y {bb['y0']}-{bb['y1']}): "
              f"{b['mismatchPct']}%  reference {b['reference']} → render {b['render']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
