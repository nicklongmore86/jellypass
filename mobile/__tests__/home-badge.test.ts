// Where a card draws its status: a compact corner pill when the pill is estimated to fit on one line inside the poster at
// the user's text size, else below the image as ordinary scalable text. This sweeps the card widths the app really draws
// (from the same sizing the screens use, at whole and fractional window widths, with and without side insets, for poster
// and backdrop cards) and the text scales, and checks both placements are chosen where they should be. The fit is an
// estimate (a generous 0.6 em per character), not a measurement: it errs toward "below".
import { cardWidths } from '../src/screens/HomeScreen';
import { BADGE_WORDS } from '../src/home/text';
import { BADGE_EM_PER_CHAR, badgeFits, POSTER_BADGE, TABLET_WIDTH } from '../src/home/layout';
import { gridCardWidth, gridColumns } from '../src/search/text';
import { layout, spacing } from '../src/theme';

const LONGEST = Object.values(BADGE_WORDS).reduce((a, b) => (b.length > a.length ? b : a));
const SCALES = [1, 1.15, 1.3, 1.6, 2, 3];

/** The pill's width: its fixed parts, plus the longest word at `scale` (the estimate the placement uses, written out again). */
function pillWidth(scale: number): number {
  const fixed = POSTER_BADGE.paddingLeft + POSTER_BADGE.paddingRight + 2 * POSTER_BADGE.border + POSTER_BADGE.dot + POSTER_BADGE.gap;
  return fixed + LONGEST.length * BADGE_EM_PER_CHAR * POSTER_BADGE.fontSize * scale;
}

/** Every card width the app draws at a window `width` wide with `inset` pt of safe area on each side, and where. */
function cardsAt(width: number, inset = 0): { where: string; width: number }[] {
  const pad = Math.max(spacing.gutter, inset);
  const column = Math.max(0, Math.min(width, layout.maxContentWidth) - 2 * pad);
  const columns = gridColumns(width, column);
  const tablet = width >= TABLET_WIDTH;
  const rows = cardWidths(column, tablet);
  return [
    { where: `grid, ${columns} columns`, width: gridCardWidth(column, columns) },
    { where: 'Home poster row', width: rows.poster },
    { where: 'Home backdrop row', width: rows.backdrop },
  ];
}

/** Whole widths 320..1400 plus tenths around the breakpoints the sizing switches at (the two/three column switch at 336/337, the tablet at 768). */
const windows = [
  ...Array.from({ length: 1400 - 320 + 1 }, (_, i) => 320 + i),
  ...Array.from({ length: 20 }, (_, i) => 336 + (i + 1) / 10),
  ...Array.from({ length: 20 }, (_, i) => 767 + (i + 1) / 10),
];

describe('the status badge placement', () => {
  const all = windows.flatMap((w) => cardsAt(w).map((card) => ({ window: w, ...card })));
  const narrowest = all.reduce((least, one) => (one.width < least.width ? one : least));

  it('finds the narrowest card at a 336.1 pt window (three columns just past the two-column switch)', () => {
    expect(narrowest.width).toBe(94);
    // A fractional window width is a point narrower than the whole 337 pt one; the sweep covers both.
    expect(narrowest.window).toBe(336.1);
    expect(cardsAt(336.5)[0]!.width).toBe(95);
    expect(cardsAt(337.9)[0]!.width).toBe(95);
    expect(cardsAt(337)[0]!.width).toBe(95);
    expect(cardsAt(320)[0]!.width).toBe(139);
    expect(cardsAt(390)[0]!.width).toBe(112);
  });

  it('keeps the compact corner pill at ordinary text size on the narrowest card, with margin', () => {
    expect(badgeFits(narrowest.width, 1, LONGEST)).toBe(true);
    expect(pillWidth(1)).toBeLessThanOrEqual(POSTER_BADGE.maxWidthRatio * narrowest.width);
    // The pill, from its inset, stays inside the poster.
    expect(POSTER_BADGE.inset + POSTER_BADGE.maxWidthRatio * narrowest.width).toBeLessThan(narrowest.width);
    // The base text is at least Apple's 11 pt minimum.
    expect(POSTER_BADGE.fontSize).toBeGreaterThanOrEqual(11);
  });

  it('moves the status below the image on the narrowest card at large text sizes (2 and 3), never capping the text', () => {
    for (const scale of [1.6, 2, 3]) expect(badgeFits(narrowest.width, scale, LONGEST)).toBe(false);
    expect(Object.keys(POSTER_BADGE)).not.toContain('maxFontScale');
  });

  it('chooses each placement where the estimate says, on every card at every window width, scale and inset', () => {
    let overlay = 0;
    let below = 0;
    for (const w of windows) {
      // Side insets only come with a landscape phone (at least 568 pt wide).
      for (const inset of w >= 568 ? [0, 47, 59] : [0]) {
        for (const card of cardsAt(w, inset)) {
          let fitted = true;
          for (const scale of SCALES) {
            const fits = badgeFits(card.width, scale, LONGEST);
            // Overlay only when the whole pill is inside the room the poster gives it; below otherwise.
            if (fits !== pillWidth(scale) <= POSTER_BADGE.maxWidthRatio * card.width) {
              throw new Error(`${card.where} at ${w} pt (inset ${inset}), scale ${scale}: placed ${fits ? 'overlay' : 'below'}, pill ${pillWidth(scale)} vs ${POSTER_BADGE.maxWidthRatio * card.width}`);
            }
            // A bigger text size never goes back into the corner.
            if (fits && !fitted) throw new Error(`${card.where} at ${w} pt: fits at scale ${scale} but not at a smaller one`);
            fitted = fits;
            if (fits) overlay += 1;
            else below += 1;
          }
        }
      }
    }
    expect(overlay).toBeGreaterThan(0);
    expect(below).toBeGreaterThan(0);
  });

  it('puts every card the app draws in the corner at ordinary text size', () => {
    for (const card of all) expect(`${card.where} at ${card.window}: ${badgeFits(card.width, 1, LONGEST)}`).toBe(`${card.where} at ${card.window}: true`);
  });

  it('keeps the corner pill on a phone\'s backdrop card even at the largest text, and moves a 132 pt poster below the image there', () => {
    expect(badgeFits(cardsAt(390)[2]!.width, 3, LONGEST)).toBe(true);
    expect(badgeFits(132, 1.3, LONGEST)).toBe(true);
    expect(badgeFits(132, 3, LONGEST)).toBe(false);
  });

  it('treats a text scale below 1 as 1 and a longer word as needing more room', () => {
    expect(badgeFits(94, 0.5, LONGEST)).toBe(badgeFits(94, 1, LONGEST));
    expect(badgeFits(94, 1, 'Not available now')).toBe(false);
  });
});
