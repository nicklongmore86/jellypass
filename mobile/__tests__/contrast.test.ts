// The PWA's colour-contrast checks (test/app-pwa.test.mjs), ported to the native theme: the same pairs, the same
// thresholds. Text is 4.5:1 (WCAG AA); non-text marks (icons, outlines, waterlines) are 3:1 (WCAG 1.4.11).
import { colors, composite, contrast, water } from '../src/theme';
import { token } from './css-names';

const ratio = (foreground: string, background: string) => contrast(token(foreground), token(background));

describe('Tidepool colours', () => {
  it('are Jellyfin\'s: its navy page and cyan main colour, the purple a small decoration', () => {
    expect(colors.bg).toBe('#000b25');
    expect(colors.accent).toBe('#00a4dc');
    expect(colors.purple).toBe('#aa5cc3');
    expect(ratio('text', 'bg')).toBeGreaterThanOrEqual(12);
    expect(ratio('accent', 'bg')).toBeGreaterThanOrEqual(6);
    expect(ratio('on-accent', 'accent')).toBeGreaterThanOrEqual(6);
    expect(ratio('purple', 'bg')).toBeGreaterThanOrEqual(3);
  });

  it.each([
    // Text on the page, on its glow and on cards.
    ['text', 'bg'], ['text', 'surface'], ['text', 'surface-raised'], ['text', 'accent-tint'],
    ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-raised'],
    // The accent as text (links, the chosen filter) and as the button: dark text on the solid aqua.
    ['accent', 'bg'], ['accent', 'surface'], ['accent-text', 'bg'], ['accent-text', 'surface'], ['accent-text', 'surface-raised'], ['accent-text', 'accent-tint'],
    ['on-accent', 'accent'],
    // Status chips.
    ['pill-ok-text', 'pill-ok-bg'], ['pill-get-text', 'pill-get-bg'], ['pill-bad-text', 'pill-bad-bg'], ['pill-warn-text', 'pill-warn-bg'],
    // Error text on the page and on cards.
    ['pill-bad-text', 'bg'], ['pill-bad-text', 'surface'],
    // A network's or studio's name, shown on its logo tile when there is no logo.
    ['logo-text', 'logo-tile'],
  ])('keep %s on %s at 4.5:1 (text)', (foreground, background) => {
    expect(ratio(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it.each([
    // The back, search and tab icons, and the waterline and tab indicator, against what they sit on.
    ['text', 'surface'], ['text', 'bg'], ['accent-text', 'surface-raised'], ['muted', 'surface'], ['accent', 'surface'], ['purple', 'bg'],
    // The chosen chip's border against its tint and the page (the active tab's outline against the bar is accent on surface, above).
    ['accent', 'accent-tint'], ['accent', 'bg'],
    // The default waterline's purple cap on the card surface (the cyan line and the cap on the page are above).
    ['purple', 'surface'],
  ])('keep %s on %s at 3:1 (non-text)', (graphic, under) => {
    expect(ratio(graphic, under)).toBeGreaterThanOrEqual(3);
  });

  it('give every service its own waterline colour that stands out from the page and the card surface', () => {
    expect(Object.keys(water).sort()).toEqual(['apple', 'disney', 'hbo', 'hulu', 'netflix', 'paramount', 'peacock', 'prime']);
    expect(new Set(Object.values(water)).size).toBe(8);
    for (const accent of Object.keys(water)) {
      for (const under of ['bg', 'surface']) {
        expect({ accent, under, ok: ratio(`water-${accent}`, under) >= 3 }).toEqual({ accent, under, ok: true });
      }
    }
  });

  it('keep each status chip\'s word and dot at 4.5:1, and the chip a visible shape on a white poster', () => {
    for (const pill of ['ok', 'get', 'bad', 'warn']) {
      expect(ratio(`pill-${pill}-text`, `pill-${pill}-bg`)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(`pill-${pill}-bg`), '#ffffff')).toBeGreaterThanOrEqual(3);
    }
  });

  it('keep the hero panel\'s text readable over a pure white and a pure black picture', () => {
    expect(colors.panel).toMatch(/^rgba\(0, 11, 37, 0\.9\d*\)$/);
    for (const backdrop of [255, 0]) {
      const under = composite(colors.panel, backdrop);
      for (const text of ['text', 'muted', 'accent-text']) {
        expect({ text, backdrop, ratio: contrast(token(text), under) >= 4.5 }).toEqual({ text, backdrop, ratio: true });
      }
    }
  });
});
