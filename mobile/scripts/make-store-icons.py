#!/usr/bin/env python3
"""Draws the app's 1024 x 1024 store icons into mobile/assets (icon.png, adaptive-icon.png). Needs Pillow.

The artwork is the household web app's icon, unchanged: draw() is a copy of draw() in ../../scripts/make-app-icons.py
(which writes app/static/icons/icon-512.png and friends), run at 1024 instead of 512. The ticket sits in the central 80%
of the canvas, inside Android's adaptive-icon safe zone, so the same drawing is the adaptive foreground over the same
navy (app.config.ts's backgroundColor). Both files are opaque RGB: the App Store refuses an icon with an alpha channel.
mobile/__tests__/app-icons.test.ts fails if draw() drifts from the web script's."""
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


if __name__ == '__main__':
    out = Path(__file__).resolve().parent.parent / 'assets'
    for name in ('icon.png', 'adaptive-icon.png'):
        draw(1024).convert('RGB').save(out / name, optimize=True)
