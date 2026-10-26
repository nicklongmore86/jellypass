// The theme is a port of the PWA's stylesheet, not a fork of it: every colour token the stylesheet declares has
// the same value here, so a change to Tidepool on the web shows up as a failing test until the app follows.
// (The mobile CI workflow also runs when app/static/app.css changes.)
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { radii } from '../src/theme';
import { cssTokens } from './css-names';

const css = readFileSync(path.join(__dirname, '..', '..', 'app', 'static', 'app.css'), 'utf8');
const root = /:root \{([^]*?)\n\}/.exec(css)?.[1] ?? '';

describe('the theme matches app/static/app.css', () => {
  it('has every hex colour token, with the same value', () => {
    const hex = Object.fromEntries([...root.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)].map((match) => [match[1], match[2]!.toLowerCase()]));
    expect(Object.keys(hex).length).toBeGreaterThan(20);
    const theirs = Object.fromEntries(Object.keys(hex).map((name) => [name, cssTokens[name]]));
    expect(theirs).toEqual(hex);
  });

  it('has the translucent tokens, with the same channels and alpha', () => {
    for (const [, name, r, g, b, alpha] of root.matchAll(/--([a-z-]+):\s*rgb\((\d+) (\d+) (\d+) \/ ([0-9.]+)\);/g)) {
      expect({ name, value: cssTokens[name!] }).toEqual({ name, value: `rgba(${r}, ${g}, ${b}, ${alpha})` });
    }
  });

  it('has the same squircle radii', () => {
    const cssRadii = Object.fromEntries([...root.matchAll(/--radius-([a-z]+):\s*(\d+)px;/g)].map((match) => [match[1], Number(match[2])]));
    expect(cssRadii).toEqual(radii);
  });
});
