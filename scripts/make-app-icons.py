#!/usr/bin/env python3
"""Draws the household app's PNG icons into app/static/icons (a ticket with a play triangle). Needs Pillow.

The committed PNGs are the output; this is only here so they can be regenerated. The artwork sits inside the
central 80% of the canvas, so the same files serve as ordinary and as maskable icons."""
from pathlib import Path
from PIL import Image, ImageDraw

BG = (13, 15, 36)  # the app's --bg
GLOW = (27, 23, 64)  # --bg-glow
ACCENT = (139, 123, 255)  # --accent
ACCENT_2 = (95, 168, 255)  # --accent-2
SCALE = 4


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def draw(size: int) -> Image.Image:
    s = size * SCALE
    # The indigo background with a soft glow from the top, like the app's.
    image = Image.new('RGB', (s, s), BG)
    d = ImageDraw.Draw(image)
    for y in range(s):
        d.line((0, y, s, y), fill=lerp(GLOW, BG, min(1.0, y / (s * 0.6))))
    w, h = s * 0.62, s * 0.42
    left, top = (s - w) / 2, (s - h) / 2
    # The ticket: a diagonal gradient from the accent to the second accent, cut to a rounded rectangle.
    ticket = Image.new('RGB', (s, s), ACCENT)
    td = ImageDraw.Draw(ticket)
    for i in range(2 * s):
        td.line((i, 0, i - s, s), fill=lerp(ACCENT, ACCENT_2, i / (2 * s)), width=2)
    mask = Image.new('L', (s, s), 0)
    ImageDraw.Draw(mask).rounded_rectangle((left, top, left + w, top + h), radius=s * 0.06, fill=255)
    image.paste(ticket, (0, 0), mask)
    d = ImageDraw.Draw(image)
    notch = s * 0.05
    for x in (left, left + w):  # the ticket's side notches
        d.ellipse((x - notch, s / 2 - notch, x + notch, s / 2 + notch), fill=lerp(GLOW, BG, 0.5 / 0.6))
    t = s * 0.085
    cx, cy = s / 2, s / 2
    d.polygon([(cx - t * 0.8, cy - t * 1.15), (cx - t * 0.8, cy + t * 1.15), (cx + t * 1.25, cy)], fill=BG)
    return image.resize((size, size), Image.LANCZOS)


out = Path(__file__).resolve().parent.parent / 'app' / 'static' / 'icons'
out.mkdir(parents=True, exist_ok=True)
for name, size in (('icon-192.png', 192), ('icon-512.png', 512), ('apple-touch-icon.png', 180)):
    draw(size).save(out / name, optimize=True)
