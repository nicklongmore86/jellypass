// The Account screen's credits and the app's icons stay the PWA's: TMDB's logo drawn from the same path and gradient as
// app/static/tmdb-logo.svg, the notice and credits word for word as app/src/render.ts shows them, and the tab and Back
// icons shape for shape as app/src/icons.ts draws them. Also the version line, and that only the credits' own links open.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Linking } from 'react-native';

import { ABOUT_TEXT, apiVersionText, CREDIT_URLS, JUSTWATCH_CREDIT, JUSTWATCH_URL, TMDB_NOTICE, TMDB_SOURCE, TMDB_URL, installedVersion, versionText } from '../src/credits';
import { SHAPES } from '../src/icons';
import { openCredit } from '../src/screens/AccountScreen';
import { TMDB_LOGO_PATH, TMDB_LOGO_STOPS, TMDB_LOGO_VIEWBOX } from '../src/TmdbLogo';

const PWA = path.join(__dirname, '..', '..', 'app');
const read = (file: string) => readFileSync(path.join(PWA, file), 'utf8');

describe('the TMDB logo', () => {
  const svg = read('static/tmdb-logo.svg');

  it('is the PWA\'s file: the same view box, path and gradient', () => {
    expect(svg).toContain(`viewBox="${TMDB_LOGO_VIEWBOX}"`);
    expect([...svg.matchAll(/<path [^>]*d="([^"]+)"/g)].map((match) => match[1])).toEqual([TMDB_LOGO_PATH]);
    expect([...svg.matchAll(/<stop offset="([^"]+)" stop-color="([^"]+)"\/>/g)].map(([, offset, stopColor]) => ({ offset, stopColor }))).toEqual(
      TMDB_LOGO_STOPS.map((stop) => ({ ...stop })),
    );
    expect(svg).toMatch(/<linearGradient id="linear-gradient" y1="17\.76" x2="273\.42" y2="17\.76" gradientUnits="userSpaceOnUse">/);
  });

  it('is bundled, never fetched: nothing in it names a URL or loads a file', () => {
    const source = readFileSync(path.join(__dirname, '..', 'src', 'TmdbLogo.tsx'), 'utf8');
    expect(source).not.toMatch(/https?:\/\//);
    expect(source).not.toMatch(/\buri\b|require\(/);
  });
});

describe('the credits', () => {
  const render = read('src/render.ts');

  it('use the PWA\'s words', () => {
    expect(render).toContain(`'${TMDB_NOTICE}'`);
    expect(render).toContain(`'${ABOUT_TEXT}'`);
    for (const sentence of [TMDB_SOURCE, JUSTWATCH_CREDIT]) {
      expect(render).toContain(`doc.createTextNode('${sentence.before}')`);
      expect(render).toContain(`el(doc, 'a', { text: '${sentence.link}', attrs: { href: '${sentence.url}'`);
      expect(render).toContain(`doc.createTextNode('${sentence.after}')`);
    }
    expect(render).toContain(`href: '${TMDB_URL}', rel: 'noopener noreferrer', 'aria-label': 'The Movie Database (TMDB)'`);
  });

  it('carry TMDB\'s notice exactly as its terms give it', () => {
    expect(TMDB_NOTICE).toBe('This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.');
  });

  it('open only TMDB and JustWatch, in the system browser', () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    try {
      expect(CREDIT_URLS).toEqual([TMDB_URL, JUSTWATCH_URL]);
      openCredit(TMDB_URL);
      openCredit(JUSTWATCH_URL);
      openCredit('https://elsewhere.example.test/');
      expect(open.mock.calls).toEqual([[TMDB_URL], [JUSTWATCH_URL]]);
    } finally {
      open.mockRestore();
    }
  });

  it('never fail when no browser can open a link', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no browser'));
    try {
      expect(() => openCredit(TMDB_URL)).not.toThrow();
      await Promise.resolve();
    } finally {
      open.mockRestore();
    }
  });
});

describe('the version line', () => {
  const config = { name: 'JellyPass', slug: 'jellypass', version: '1.2.3' };

  it("gives the installed app's own version and build number", () => {
    expect(versionText({ version: '1.2.3', build: '7' }, config)).toBe('JellyPass 1.2.3 (build 7)');
    expect(versionText({ version: '1.2.4', build: '12' }, config)).toBe('JellyPass 1.2.4 (build 12)');
  });

  it("falls back to the config's version, with no build, where the OS reports none", () => {
    expect(versionText({ version: null, build: null }, config)).toBe('JellyPass 1.2.3');
    expect(versionText({ version: '', build: '' }, config)).toBe('JellyPass 1.2.3');
    expect(versionText({ version: null, build: null }, undefined)).toBe('JellyPass unknown');
  });

  it('reads the native build number through expo-application, never the app config', () => {
    const Application = jest.requireActual('expo-application') as { nativeApplicationVersion: string | null; nativeBuildVersion: string | null };
    expect(installedVersion()).toEqual({ version: Application.nativeApplicationVersion, build: Application.nativeBuildVersion });
    const app = jest.requireActual('../app.config').default as { version: string; ios: Record<string, unknown>; android: Record<string, unknown> };
    // EAS keeps the build numbers (eas.json: appVersionSource "remote", autoIncrement), so the config has none to drift.
    expect(Object.keys(app.ios)).not.toContain('buildNumber');
    expect(Object.keys(app.android)).not.toContain('versionCode');
    expect(app.version).toBe((jest.requireActual('../package.json') as { version: string }).version);
  });

  it('gives the API revision from /me', () => {
    expect(apiVersionText(1)).toBe('Household API version 1');
    expect(apiVersionText(0)).toBe('Household API version 0');
  });
});

describe('the icons', () => {
  const icons = read('src/icons.ts');

  it.each(Object.keys(SHAPES))('draw %s as the PWA does', (name) => {
    const shapes = SHAPES[name as keyof typeof SHAPES] as readonly (readonly [string, Record<string, string>])[];
    const block = new RegExp(`\\n  ${name}: \\[([\\s\\S]*?)\\n?  \\],?\\n|\\n  ${name}: \\[(.*)\\],\\n`).exec(icons);
    expect(block).not.toBeNull();
    const pwa = (block![1] ?? block![2] ?? '').replace(/\s+/g, ' ');
    const ours = shapes.map(([tag, attrs]) => `['${tag}', { ${Object.entries(attrs).map(([key, value]) => `${key}: '${value}'`).join(', ')} }]`);
    expect(pwa.replace(/,\s*$/, '').trim()).toBe(ours.join(', '));
  });
});
