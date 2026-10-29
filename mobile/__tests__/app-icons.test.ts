// The store icons (mobile/scripts/make-store-icons.py): 1024 x 1024, opaque (the App Store refuses an alpha channel),
// the adaptive foreground configured over the navy, and the drawing the web app's own, not a new design.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import config from '../app.config';

const root = path.join(__dirname, '..');
const png = (file: string) => readFileSync(path.join(root, 'assets', file));

/** The IHDR's width, height and colour type (2 = RGB, 6 = RGBA; palette and grey need a look too). */
function header(buffer: Buffer) {
  expect(buffer.subarray(1, 4).toString()).toBe('PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), colourType: buffer[25] };
}

describe('app icons', () => {
  it.each(['icon.png', 'adaptive-icon.png'])('%s is 1024 x 1024 with no alpha channel', (file) => {
    const { width, height, colourType } = header(png(file));
    expect([width, height]).toEqual([1024, 1024]);
    expect(colourType).toBe(2);
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
