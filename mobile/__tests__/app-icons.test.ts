// The store icons (mobile/scripts/make-store-icons.py): 1024 x 1024, opaque (the App Store refuses an alpha channel),
// the adaptive foreground configured over the navy, and the drawing the web app's own, not a new design.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { inflateSync } from 'node:zlib';

import config from '../app.config';

const root = path.join(__dirname, '..');
const png = (file: string) => readFileSync(path.join(root, 'assets', file));

/** The IHDR's width, height and colour type (2 = RGB, 6 = RGBA; palette and grey need a look too). */
function header(buffer: Buffer) {
  expect(buffer.subarray(1, 4).toString()).toBe('PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), colourType: buffer[25] };
}

/** Decodes an 8-bit, non-interlaced RGB PNG (what the generator writes) to its pixel bytes. */
function pixels(buffer: Buffer) {
  const { width, height, colourType } = header(buffer);
  expect([buffer[24], colourType, buffer[28]]).toEqual([8, 2, 0]);
  const chunks: Buffer[] = [];
  for (let at = 8; at < buffer.length; ) {
    const length = buffer.readUInt32BE(at);
    if (buffer.subarray(at + 4, at + 8).toString() === 'IDAT') chunks.push(buffer.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 3;
  const out = Buffer.alloc(stride * height);
  const at = (i: number) => out[i] ?? 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    for (let i = 0; i < stride; i++) {
      const x = raw[y * (stride + 1) + 1 + i] ?? 0;
      const left = i >= 3 ? at(y * stride + i - 3) : 0;
      const up = y > 0 ? at((y - 1) * stride + i) : 0;
      const upLeft = y > 0 && i >= 3 ? at((y - 1) * stride + i - 3) : 0;
      const p = left + up - upLeft;
      const [pa, pb, pc] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];
      const paeth = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      out[y * stride + i] = (x + [0, left, up, (left + up) >> 1, paeth][filter]!) & 255;
    }
  }
  return { width, height, data: out };
}

/** The furthest any pixel that is not the navy lies from the centre, and how many lie beyond `limit`. */
function reach(file: string, limit: number) {
  const { width, height, data } = pixels(png(file));
  let max = 0;
  let outside = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      if (data[at] === 0 && data[at + 1] === 11 && data[at + 2] === 37) continue;
      const r = Math.hypot(x + 0.5 - width / 2, y + 0.5 - height / 2);
      max = Math.max(max, r);
      if (r > limit) outside++;
    }
  }
  return { max, outside };
}

// Android's adaptive-icon safe zone: a circle 66dp across on the 108dp canvas.
const SAFE_RADIUS = (1024 * 66) / 108 / 2;

describe('app icons', () => {
  it.each(['icon.png', 'adaptive-icon.png'])('%s is 1024 x 1024 with no alpha channel', (file) => {
    const { width, height, colourType } = header(png(file));
    expect([width, height]).toEqual([1024, 1024]);
    expect(colourType).toBe(2);
  });

  it('keep the adaptive foreground inside the safe circle, and the iOS icon full-bleed', () => {
    const adaptive = reach('adaptive-icon.png', SAFE_RADIUS);
    expect(adaptive.outside).toBe(0);
    expect(adaptive.max).toBeGreaterThan(SAFE_RADIUS * 0.9); // scaled into the zone, not shrunk to a dot
    expect(reach('icon.png', SAFE_RADIUS).outside).toBeGreaterThan(0);
  });

  it('are the ones the app config points at, with the adaptive icon over the same navy', () => {
    expect(config.icon).toBe('./assets/icon.png');
    expect(config.android?.adaptiveIcon?.foregroundImage).toBe('./assets/adaptive-icon.png');
    expect(config.android?.adaptiveIcon?.backgroundColor).toBe('#000b25');
  });

  it("draw the web app's icon: the generator's draw() is a copy of scripts/make-app-icons.py's", () => {
    const fn = (file: string) => /^def draw\(size: int\)[\s\S]*?return image\.resize\(.*\)$/m.exec(readFileSync(file, 'utf8'))?.[0];
    const web = fn(path.join(root, '..', 'scripts', 'make-app-icons.py'));
    expect(web).toBeDefined();
    expect(fn(path.join(root, 'scripts', 'make-store-icons.py'))).toBe(web);
    for (const constant of ['BG = (0, 11, 37)', 'ACCENT = (0, 164, 220)', 'SCALE = 4']) {
      expect(readFileSync(path.join(root, 'scripts', 'make-store-icons.py'), 'utf8')).toContain(constant);
      expect(readFileSync(path.join(root, '..', 'scripts', 'make-app-icons.py'), 'utf8')).toContain(constant);
    }
  });
});
