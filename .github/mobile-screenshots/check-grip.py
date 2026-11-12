#!/usr/bin/env python3
# Fails if any iPad screenshot named on the command line shows iPadOS's window resize grip: check-grip.py <png>...
# The grip is drawn in the bottom-right corner when an app opens in a resizable window instead of full screen. The app
# is dark-only, and in full screen that 160x160 corner has no bright pixel (mean of R, G and B 100 or more) in any of
# the eight listing images; with the grip it has about 430 (425 on sign-in, run 43120329669). More than 100 bright
# pixels, a margin well clear of both, counts as the grip.
# Standard library only: reads 8-bit RGB or RGBA, non-interlaced PNGs, which is what strip-alpha.swift writes. Anything
# else, and any damaged file (bad CRC, truncation, wrong amount of image data), is refused, so it can't pass by accident.
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
    # Walk the chunks, failing closed: each must fit in the file with a correct CRC, IHDR must come first, and the file
    # must reach IEND (a truncated file never passes).
    pos = 8
    idat = []
    header = None
    ended = False
    while pos < len(data):
        if pos + 12 > len(data):
            raise ValueError(f"truncated chunk header at byte {pos}")
        length, kind = struct.unpack(">I4s", data[pos : pos + 8])
        end = pos + 12 + length
        if end > len(data):
            raise ValueError(f"{kind!r} chunk at byte {pos} declares {length} bytes, past the end of the file")
        body = data[pos + 8 : pos + 8 + length]
        (crc,) = struct.unpack(">I", data[pos + 8 + length : end])
        if zlib.crc32(kind + body) & 0xFFFFFFFF != crc:
            raise ValueError(f"{kind!r} chunk at byte {pos} has a bad CRC")
        if header is None and kind != b"IHDR":
            raise ValueError(f"first chunk is {kind!r}, not IHDR")
        if kind == b"IHDR":
            if header is not None:
                raise ValueError("more than one IHDR chunk")
            if length != 13:
                raise ValueError(f"IHDR is {length} bytes, not 13")
            header = struct.unpack(">IIBBBBB", body)
        elif kind == b"IDAT":
            idat.append(body)
        elif kind == b"IEND":
            ended = True
            break
        pos = end
    if header is None:
        raise ValueError("no IHDR chunk")
    if not ended:
        raise ValueError("no IEND chunk (truncated file)")
    # Fail closed on anything this decoder doesn't implement, before decoding: only zlib (compression method 0),
    # standard adaptive filtering (filter method 0), no interlace, 8-bit RGB or RGBA.
    width, height, depth, color, compression, filtering, interlace = header
    if depth != 8 or color not in (2, 6) or compression != 0 or filtering != 0 or interlace != 0:
        raise ValueError(
            f"unsupported PNG (bit depth {depth}, color type {color}, compression method {compression}, "
            f"filter method {filtering}, interlace {interlace}); expected 8, 2 or 6, 0, 0, 0"
        )
    if width < CORNER or height < CORNER:
        raise ValueError(f"image is {width}x{height}, smaller than the {CORNER}x{CORNER} corner")
    bpp = 3 if color == 2 else 4
    stride = width * bpp
    # The zlib stream must end exactly at the end of the IDAT data, and hold exactly one filter byte plus one row of
    # pixels per row: missing or extra bytes mean the image isn't what the header says.
    inflater = zlib.decompressobj()
    raw = inflater.decompress(b"".join(idat))
    if not inflater.eof:
        raise ValueError("image data ends before the end of its zlib stream")
    if inflater.unused_data:
        raise ValueError(f"{len(inflater.unused_data)} bytes after the end of the image's zlib stream")
    expected = height * (stride + 1)
    if len(raw) != expected:
        raise ValueError(f"image data is {len(raw)} bytes after decompression, not {expected}")
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
