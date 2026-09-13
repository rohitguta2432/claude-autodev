#!/usr/bin/env python3
"""
Pre-digest every design reference in a directory, once, so the session that has to match it
reads a small JSON and three crops instead of opening the full picture five times.

    python3 brief.py .autodev/design            # writes brief-<stem>.json + brief-<stem>-{top,mid,bottom}.png

For each reference (any image whose name does not start with compare-/brief-/render-/diff-/score-)
that has no brief yet:

  size, aspect          the picture's own pixels
  device                a guess at what took it (iPhone 15 Pro at 3x, a 390x844 CSS viewport...)
  viewport              the CSS viewport + devicePixelRatio to render the app at so the two
                        pictures are the same shape — the single most common cause of phantom
                        differences is comparing a 2:3 photo with a 0.46 phone screen
  palette               the top colours, sampled from the file, never estimated
  bands                 dominant colour of the top and bottom strips (status bar / footer)
  crops                 top, middle, bottom thirds, written next to the brief

Idempotent and best-effort: a file PIL cannot open is reported and skipped, never fatal.
Requires Pillow (`pip install pillow`).
"""
import json
import os
import re
import sys
from datetime import datetime, timezone

try:
    from PIL import Image
except ImportError:  # pragma: no cover
    print("brief.py: Pillow is not installed (pip install pillow)", file=sys.stderr)
    sys.exit(2)

ARTIFACT = re.compile(r"^(compare|brief|render|diff|score)-", re.I)
IMAGE = re.compile(r"\.(png|jpe?g|webp|gif|avif)$", re.I)

# Physical pixel sizes of screenshots the common devices produce, portrait. (w, h): (name, css w, css h, dpr)
DEVICES = {
    (1179, 2556): ("iPhone 14 Pro / 15 / 15 Pro / 16", 393, 852, 3),
    (1206, 2622): ("iPhone 16 Pro", 402, 874, 3),
    (1290, 2796): ("iPhone 14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus", 430, 932, 3),
    (1320, 2868): ("iPhone 16 Pro Max", 440, 956, 3),
    (1170, 2532): ("iPhone 12 / 13 / 14", 390, 844, 3),
    (1284, 2778): ("iPhone 12 Pro Max / 13 Pro Max / 14 Plus", 428, 926, 3),
    (1125, 2436): ("iPhone X / XS / 11 Pro", 375, 812, 3),
    (1080, 2340): ("iPhone 12 mini / 13 mini", 360, 780, 3),
    (828, 1792): ("iPhone XR / 11", 414, 896, 2),
    (750, 1334): ("iPhone SE (2nd/3rd gen) / 8", 375, 667, 2),
    (1080, 2400): ("Android 360x800 @3x (Pixel 4a/6a class)", 360, 800, 3),
    (1080, 2280): ("Android 360x760 @3x", 360, 760, 3),
    (1440, 3120): ("Android 360x780 @4x (Pixel 6 Pro class)", 360, 780, 4),
    (1344, 2992): ("Pixel 8 Pro", 448, 997, 3),
    (1080, 2424): ("Pixel 8", 412, 915, 2.625),
}


def hexcol(c):
    return "#%02X%02X%02X" % tuple(int(v) for v in c[:3])


def palette(im, k=8):
    small = im.convert("RGB")
    small.thumbnail((256, 256))
    q = small.quantize(colors=k, method=Image.Quantize.MEDIANCUT).convert("RGB")
    n = small.width * small.height
    counts = sorted(q.getcolors(maxcolors=k * 4) or [], reverse=True)[:k]
    return [{"hex": hexcol(c), "pct": round(100 * cnt / n, 1)} for cnt, c in counts]


def dominant(im):
    return palette(im, 3)[0]["hex"]


def device_guess(w, h):
    if (w, h) in DEVICES:
        name, cw, ch, dpr = DEVICES[(w, h)]
        return {"name": name, "match": "exact"}, {"width": cw, "height": ch, "dpr": dpr}
    aspect = w / h
    if 0.40 <= aspect <= 0.58:  # a phone screen
        # Pick the dpr that lands the CSS width nearest the 360-430 band phones actually have.
        best = min((3, 2, 4, 2.625, 1), key=lambda d: abs(w / d - 393))
        cw = round(w / best)
        return ({"name": "phone screenshot (size not in the table)", "match": "aspect"},
                {"width": cw, "height": round(h / best), "dpr": best})
    if aspect > 1.2:
        dpr = 2 if w >= 2000 else 1
        return ({"name": "desktop / landscape capture", "match": "aspect"},
                {"width": round(w / dpr), "height": round(h / dpr), "dpr": dpr})
    return ({"name": "unknown — not a screen capture shape (a photo, a print, an export?)", "match": "none"},
            {"width": w, "height": h, "dpr": 1})


def brief_one(d, name):
    stem = os.path.splitext(name)[0]
    path = os.path.join(d, name)
    im = Image.open(path)
    im.load()
    w, h = im.size
    device, viewport = device_guess(w, h)
    rgb = im.convert("RGB")
    band = max(1, round(h * 0.06))
    crops = {}
    for label, box in (("top", (0, 0, w, h // 3)), ("mid", (0, h // 3, w, 2 * h // 3)), ("bottom", (0, 2 * h // 3, w, h))):
        out = f"brief-{stem}-{label}.png"
        rgb.crop(box).save(os.path.join(d, out))
        crops[label] = out
    brief = {
        "reference": name,
        "size": {"width": w, "height": h},
        "aspect": round(w / h, 4),
        "device": device,
        "viewport": viewport,
        "palette": palette(rgb),
        "bands": {"top": dominant(rgb.crop((0, 0, w, band))), "bottom": dominant(rgb.crop((0, h - band, w, h)))},
        "crops": crops,
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "tool": "autodev-pixel-match/brief.py",
    }
    with open(os.path.join(d, f"brief-{stem}.json"), "w") as f:
        json.dump(brief, f, indent=2)
    return brief


def main(argv):
    if len(argv) != 2:
        print(__doc__)
        return 2
    d = argv[1]
    refs = sorted(f for f in os.listdir(d) if IMAGE.search(f) and not ARTIFACT.match(f))
    if not refs:
        print("brief.py: no design references in", d)
        return 0
    rc = 0
    for name in refs:
        stem = os.path.splitext(name)[0]
        if os.path.exists(os.path.join(d, f"brief-{stem}.json")):
            print(f"brief-{stem}.json already present")
            continue
        try:
            b = brief_one(d, name)
            v = b["viewport"]
            print(f"{name}: {b['size']['width']}x{b['size']['height']} → {b['device']['name']}; "
                  f"render at {v['width']}x{v['height']} @{v['dpr']}x; palette {', '.join(p['hex'] for p in b['palette'][:4])}")
        except Exception as e:  # noqa: BLE001 — one bad file must not stop the others
            print(f"{name}: could not brief — {e}", file=sys.stderr)
            rc = 1
    return rc


if __name__ == "__main__":
    sys.exit(main(sys.argv))
