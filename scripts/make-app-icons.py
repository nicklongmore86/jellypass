#!/usr/bin/env python3
"""Draws the household app's PNG icons into app/static/icons (a ticket with a play triangle). Needs Pillow.

The committed PNGs are the output; this is only here so they can be regenerated. The artwork sits inside the
central 80% of the canvas, so the same files serve as ordinary and as maskable icons. Jellyfin navy and cyan, flat:
no gradient."""
from pathlib import Path
from PIL import Image, ImageDraw

BG = (0, 11, 37)  # the app's --bg, #000b25
ACCENT = (0, 164, 220)  # --accent, #00a4dc
SCALE = 4


def draw(size: int) -> Image.Image:
    s = size * SCALE
    image = Image.new('RGB', (s, s), BG)
    d = ImageDraw.Draw(image)
    w, h = s * 0.62, s * 0.42
    left, top = (s - w) / 2, (s - h) / 2
    d.rounded_rectangle((left, top, left + w, top + h), radius=s * 0.06, fill=ACCENT)
    notch = s * 0.05
    for x in (left, left + w):  # the ticket's side notches
        d.ellipse((x - notch, s / 2 - notch, x + notch, s / 2 + notch), fill=BG)
    t = s * 0.085
    cx, cy = s / 2, s / 2
    d.polygon([(cx - t * 0.8, cy - t * 1.15), (cx - t * 0.8, cy + t * 1.15), (cx + t * 1.25, cy)], fill=BG)
    return image.resize((size, size), Image.LANCZOS)


out = Path(__file__).resolve().parent.parent / 'app' / 'static' / 'icons'
out.mkdir(parents=True, exist_ok=True)
for name, size in (('icon-192.png', 192), ('icon-512.png', 512), ('apple-touch-icon.png', 180)):
    draw(size).save(out / name, optimize=True)
