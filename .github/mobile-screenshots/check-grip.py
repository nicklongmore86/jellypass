#!/usr/bin/env python3
# Fails if any iPad screenshot named on the command line shows iPadOS's window resize grip: check-grip.py <png>...
# The grip is drawn in the bottom-right corner when an app opens in a resizable window instead of full screen. The app
# is dark-only, and in full screen that 160x160 corner has no bright pixel (mean of R, G and B 100 or more) in any of
# the eight listing images; with the grip it has about 430 (425 on sign-in, run 43120329669). More than 100 bright
# pixels, a margin well clear of both, counts as the grip.
# Standard library only: reads 8-bit RGB or RGBA, non-interlaced PNGs, which is what strip-alpha.swift writes.
import struct
import sys
import zlib

CORNER = 160
BRIGHT = 100
LIMIT = 100


def corner_bright_pixels(path):
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos = 8
    idat = []
    header = None
    while pos < len(data):
        length, kind = struct.unpack(">I4s", data[pos : pos + 8])
        body = data[pos + 8 : pos + 8 + length]
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            break
        pos += 12 + length
    width, height, depth, color, _, _, interlace = header
    if depth != 8 or color not in (2, 6) or interlace != 0:
        raise ValueError(f"unsupported PNG (depth {depth}, color type {color}, interlace {interlace})")
    bpp = 3 if color == 2 else 4
    stride = width * bpp
    raw = zlib.decompress(b"".join(idat))
    prev = bytearray(stride)
    bright = 0
    for y in range(height):
        start = y * (stride + 1)
        kind = raw[start]
        line = bytearray(raw[start + 1 : start + 1 + stride])
        # Undo the row's filter; every row is needed, because each depends on the one above.
        if kind == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif kind == 2:
            line = bytearray((a + b) & 0xFF for a, b in zip(line, prev))
        elif kind == 3:
            for i in range(stride):
                left = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif kind == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if pa <= pb and pa <= pc else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xFF
        elif kind != 0:
            raise ValueError(f"bad filter {kind} on row {y}")
        if y >= height - CORNER:
            for x in range(width - CORNER, width):
                o = x * bpp
                if line[o] + line[o + 1] + line[o + 2] >= 3 * BRIGHT:
                    bright += 1
        prev = line
    return bright


failed = False
for path in sys.argv[1:]:
    try:
        count = corner_bright_pixels(path)
    except (OSError, ValueError, zlib.error, struct.error, TypeError) as error:
        print(f"::error::Can't check {path} for the resize grip: {error}")
        failed = True
        continue
    print(f"{path}: {count} bright pixels in the bottom-right {CORNER}x{CORNER} corner")
    if count > LIMIT:
        print(f"::error::{path} shows the iPadOS window resize grip (Full Screen Apps was not chosen)")
        failed = True
sys.exit(1 if failed else 0)
