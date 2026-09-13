---
name: autodev-pixel-match
description: Build a UI to match a supplied design — a screenshot, an exported mockup, a photo of a printed card — and prove the match with a side-by-side. Use when a ticket carries design references (autodev leaves them in .autodev/design/), when asked to "match this design", "make it look like the screenshot", "pixel perfect", or when a change is judged by how it looks rather than by what it returns.
---

# Matching a design

A design reference is an acceptance criterion. "Looks about right" is not a verdict, and
neither is a description of the design written from memory. The only evidence that a screen
matches a picture is the two pictures beside each other.

## The tools — run these, do not rewrite them

Three scripts ship in this skill's `scripts/` directory (installed at
`~/.claude/skills/autodev-pixel-match/scripts/`; autodev's prompts name them by absolute path).
They exist because every session used to hand-roll the same three things and get the same three
wrong: a viewport that was not the reference's, a colour that was estimated, a "match" nobody
had measured.

| Script | What it does | When |
|---|---|---|
| `brief.py <dir>` | Writes `brief-<name>.json` per reference: size, device guess, **the viewport and DPR to render at**, sampled palette, top/bottom band colours, and `brief-<name>-{top,mid,bottom}.png` crops. | autodev runs it before the first session. Read the brief before the picture. |
| `shot.mjs <url> <out.png> --viewport WxH --dpr N [--cookie k=v] [--scroll-y px] [--full-page]` | Screenshots over the DevTools protocol at an exact CSS viewport and DPR, waits for `document.fonts.ready`, writes an `<out>.json` sidecar with what it did. Zero dependencies, Node ≥ 22. | Every render — unless the repo's `.autodev.json` names a `design.screenshotCmd`, in which case run that, exactly. |
| `score.py --ref <ref> --render <render> --screen <name> [--mask x0,y0,x1,y1]...` | Classifies both pictures to the reference's palette on a grid, diffs the classes, writes `score-<name>.json` (`mismatchPct`, `maskedPct`, the worst blocks with the colour each side has there) and `diff-<name>.png` heat map. Warns when the two are different shapes. | After every render. **The gate reads this file.** Fix the worst block it names, re-render, re-score. |

Plain `chrome --headless --screenshot --window-size=W,H` is not a viewport on macOS: the page lays
out wider and is cropped, and you photograph a layout the app never has. That is why `shot.mjs`
exists; do not go back to the flag.

**The gate.** For every `compare-<screen>.png` you save, autodev requires a `score-<screen>.json`
at or under the repo's `design.maxMismatchPct` (default 10%) with at most `design.maxMaskedPct`
(default 40%) of the screen masked. Over the limit parks the run. Never edit the JSON by hand,
and never mask what you could not match — mask only what is legitimately different (a QR with
another URL, live prices, a real photo), and say so.

## The loop

**1. Read the reference — properly.**

Open the image. Then open it again, in pieces: crop the corners, the header, the type, and
look at each at a size where you can see what it actually does. A background you read as
"some shapes" at full size is three overlapping forms with different colours when you crop it.

```python
from PIL import Image
im = Image.open("reference.png")
print(im.size)
im.crop((0, 0, 320, im.height)).save("/tmp/ref-left.png")   # then read /tmp/ref-left.png
```

**2. Take the colours from the file, never from your eye.**

Estimating a hex value is how a warm cream turns into a cold one. Sample it:

```python
from collections import Counter
q = im.quantize(colors=10).convert("RGB")
for c, n in Counter(q.getdata()).most_common(10):
    print("#%02X%02X%02X" % c, round(100 * n / (im.width * im.height), 1), "%")
print(im.getpixel((512, 1203)))   # a specific element, when you know where it is
```

Do the same for geometry: a measurement is `x / width` of the reference, applied to your own
canvas, not a number that felt right.

**3. Build it, then render it.**

Render the real component — the one that ships — not a mock-up of it in a scratch file. For a
server-rendered component, `renderToStaticMarkup` into a small HTML file with the same fonts
the app loads; for a page, run the app.

**Give the harness the app's CSS context, or it will lie to you.** A scratch HTML file has
none of the resets the app ships, and the difference is not subtle: Tailwind's preflight sets
`box-sizing: border-box` on everything, so a panel declared `width: 104mm; padding: 0 8mm`
is 104mm wide in the app and **120mm wide in your harness**. You will then spend a round
"fixing" a width that was never wrong, and any export built from that harness — a PDF, a
printable sheet — ships the defect even though the app is correct. At minimum:

```css
*, *::before, *::after { box-sizing: border-box; }
```

Better: link or inline the app's own global stylesheet. Whatever the app loads before the
component, load it here, in the same order.

Then screenshot it headlessly:

```
chrome --headless=new --disable-gpu --hide-scrollbars --no-first-run \
  --user-data-dir=<temp> --window-size=<w>,<h> --virtual-time-budget=8000 \
  --screenshot=<out.png> <url-or-file-url>
```

Chrome is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS,
`google-chrome` or `chromium` on Linux, `C:\Program Files\Google\Chrome\Application\chrome.exe`
on Windows; Edge (`msedge`) takes the same flags. Give web fonts a virtual-time budget or the
screenshot catches the fallback face and you will "fix" type that was never wrong.

**4. Find the rendered element's real bounds — never assume the crop.**

Padding, centring, a scrollbar, device pixel ratio: any of them move the thing you rendered.
Crop by arithmetic and every measurement afterwards is offset by the error, which shows up as
a uniform shift you will misread as a design difference. Render onto a colour that cannot
occur in the design and find the bounds:

```python
import numpy as np
from PIL import Image
a = np.asarray(Image.open("shot.png").convert("RGB"))
bg = (a[:,:,0] > 200) & (a[:,:,1] < 80) & (a[:,:,2] > 200)   # magenta sentinel
cols, rows = np.where(~bg.all(0))[0], np.where(~bg.all(1))[0]
box = (cols.min(), rows.min(), cols.max() + 1, rows.max() + 1)
print(box, "px per mm:", (box[2] - box[0]) / 148)
```

A stripe of the sentinel colour surviving along one edge of your side-by-side is the tell that
the crop is wrong. Do not ignore it.

**5. Put them side by side and look.**

```python
from PIL import Image
a, b = Image.open("reference.png"), Image.open("shot.png")
H = 780
a = a.resize((int(a.width * H / a.height), H)); b = b.resize((int(b.width * H / b.height), H))
out = Image.new("RGB", (a.width + b.width + 24, H), "white")
out.paste(a, (0, 0)); out.paste(b, (a.width + 24, 0))
out.save(".autodev/design/compare-<screen>.png")
```

Then read that image and name the differences out loud — position, weight, spacing, hue, one
at a time. Naming them is what stops "it's close" from ending the loop early.

**6. Correct one thing at a time, and go round again.**

Two or three rounds is normal; one is suspicious. Stop when the two halves read as the same
screen, not as one inspired by the other.

## Score the match, don't only look at it

The eye is unreliable about scale and position, and confidently so. Three of the five things
one reviewer "could see" were wrong: the panel width and its crown height already matched to
a fraction of a millimetre, and the side ribbons were where they belonged — the eye was
reading the difference between a 2:3 photograph and a 0.705 card. Measure instead.

Classify both images to the design's own palette and diff the classes, which ignores JPEG
noise and lighting while catching every real difference of shape:

```python
PAL = {"camel": (205,155,99), "rust": (168,70,30), "cream": (241,229,205),
       "dark": (45,22,11), "white": (253,253,253)}
N = (148, 210)   # one cell per millimetre of the real object
def classes(im):
    a = np.asarray(im.resize(N, Image.LANCZOS)).astype(float)
    return np.stack([((a - np.array(c)) ** 2).sum(2) for c in PAL.values()]).argmin(0)
A, B = classes(reference), classes(ours)
mask = np.ones_like(A, bool)
mask[83:150, 38:111] = False        # the QR plate: two different URLs, meaningless to diff
d = (A != B) & mask
print(f"{d.sum() / mask.sum() * 100:.1f}% mismatch")
```

Then report the worst 20mm blocks with their dominant before/after class. That names the next
fix instead of leaving you to guess it, and it gives the ticket a number: 24.7% → 8.0% is an
argument; "looks much closer now" is not.

**Mask what is legitimately different.** A QR code carrying a different URL differs in half its
modules and will dominate the score. So will live copy, a different table number, a real photo.
Exclude those regions explicitly rather than letting them drown the signal.

## When the shapes will not converge, trace them

Two rounds of hand-drawn curves that still do not match is the signal to stop drawing. Trace
the artwork instead: cluster it into its own colours, find each region as a connected
component, walk the boundary, simplify, and emit the outline in the object's real units.

```python
lab = kmeans_labels(image, k=6)                 # the design's own palette, found not assumed
for m in connected_components(lab == rust_k, min_px=700):
    pts = rdp(moore_boundary(m), eps=1.6)       # simplify to ~1.5mm
    print("M" + " L".join(f"{x*MMX:.1f} {y*MMY:.1f}" for y, x in pts) + " Z")
```

This is still drawing — the output is paths in your own coordinate system, themeable,
printable at any size, with your own data inside — and it is how you find what looking cannot:
a ribbon that continues *behind* an overlapping panel rather than stopping at its edge, or a
"third tone" that turns out to be JPEG blending between two real ones and should not be drawn
at all.

Three rules keep a trace honest:

- **Drop what belongs to the content, not the artwork.** Type, buttons and plates cluster as
  dark or accent regions too. Discard components whose bounding box falls wholly inside the
  content area — otherwise you will trace the reference's own words into your background.
- **Trace holes as well as outlines.** A single outer contour fills the gaps between leaves or
  letterforms and the result reads heavy. Flood the complement inside the bounding box; what
  the border cannot reach is a hole, and belongs in the path with `fill-rule: evenodd`.
- **Work at half resolution.** 0.3mm precision, four times faster, and the simplification step
  removes finer detail than that anyway.

## What usually differs, in the order it usually matters

1. **Structure** — what contains what. A panel that holds the whole composition in the
   reference and only part of it in yours is the difference; nothing you do to colour or type
   will close it.
2. **Type** — face, weight, size, letter-spacing. A high-contrast display serif replaced by
   whatever the app already loads is the single most visible miss. If the app's face cannot
   do it, add the right one scoped to this screen rather than settling.
3. **Proportion** — element widths and the vertical rhythm, measured off the reference as
   fractions of its canvas.
4. **Colour** — sampled, not guessed.
5. **Ornament** — the drawn shapes, curves and marks. Usually last, always the part that
   flatters an unfinished match into looking finished.

## Rules

- Content must fit its canvas. A print card is a fixed physical size; overflow is clipped and
  the last line — usually a footer or a credit — is what disappears. Check the bottom edge.
- Keep whatever the tests assert on: markup hooks, literal wording, semantics. Matching a
  picture is not a licence to break a contract.
- Draw it rather than embedding a copy of the reference: a screenshot pasted in as an image
  matches perfectly and is worth nothing. It cannot be themed, printed at another size, or
  given a different table number.
- Anything you export — a PDF, a printable sheet, a hosted page — must be built in the same
  CSS context as the app, for the same reason the harness must. An export generated from a
  bare template can ship a defect the running app does not have, and nobody looks twice at a
  PDF that was "generated from the deployed code".
- Say what still differs. A report that claims a match the side-by-side does not show is
  worse than one that names the gap, because the next person will not look again. Give the
  number: a mismatch percentage with its exclusions stated beats an adjective.

## Leave the evidence

Save every side-by-side as `.autodev/design/compare-<screen>.png`. autodev collects those
into the run's proof and attaches them to the ticket, so the person who asked for the design
can see the comparison without checking anything out.
