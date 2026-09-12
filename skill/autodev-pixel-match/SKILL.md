---
name: autodev-pixel-match
description: Build a UI to match a supplied design — a screenshot, an exported mockup, a photo of a printed card — and prove the match with a side-by-side. Use when a ticket carries design references (autodev leaves them in .autodev/design/), when asked to "match this design", "make it look like the screenshot", "pixel perfect", or when a change is judged by how it looks rather than by what it returns.
---

# Matching a design

A design reference is an acceptance criterion. "Looks about right" is not a verdict, and
neither is a description of the design written from memory. The only evidence that a screen
matches a picture is the two pictures beside each other.

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
the app loads; for a page, run the app. Then screenshot it headlessly:

```
chrome --headless=new --disable-gpu --hide-scrollbars --no-first-run \
  --user-data-dir=<temp> --window-size=<w>,<h> --virtual-time-budget=8000 \
  --screenshot=<out.png> <url-or-file-url>
```

Chrome is `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` on macOS,
`google-chrome` or `chromium` on Linux, `C:\Program Files\Google\Chrome\Application\chrome.exe`
on Windows; Edge (`msedge`) takes the same flags. Give web fonts a virtual-time budget or the
screenshot catches the fallback face and you will "fix" type that was never wrong.

**4. Put them side by side and look.**

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

**5. Correct one thing at a time, and go round again.**

Two or three rounds is normal; one is suspicious. Stop when the two halves read as the same
screen, not as one inspired by the other.

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
- Say what still differs. A report that claims a match the side-by-side does not show is
  worse than one that names the gap, because the next person will not look again.

## Leave the evidence

Save every side-by-side as `.autodev/design/compare-<screen>.png`. autodev collects those
into the run's proof and attaches them to the ticket, so the person who asked for the design
can see the comparison without checking anything out.
