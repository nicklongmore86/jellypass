// The corner badge on a poster must always be whole, on one line, inside the poster. This computes the narrowest poster the
// app really draws (from the same sizing the screens use, at every window width) and the widest the badge can be at its
// capped text size, with a deliberately generous width per character, so a longer badge word or a bigger font fails here
// before it clips on a phone.
import { cardWidths } from '../src/screens/HomeScreen';
import { BADGE_WORDS } from '../src/home/text';
import { POSTER_BADGE, TABLET_WIDTH } from '../src/home/layout';
import { gridCardWidth, gridColumns } from '../src/search/text';
import { layout, spacing } from '../src/theme';

/** A bold sans-serif's average advance is about 0.55 em (SF Pro Bold on "Requested" and "In library" is nearer 0.5); 0.6 em leaves margin. */
const EM_PER_CHAR = 0.6;

/** Every poster width the app draws at a window `width` wide with `inset` pt of safe area on each side, and where. */
function posterWidths(width: number, inset = 0): Array<{ where: string; width: number }> {
  const pad = Math.max(spacing.gutter, inset);
  const column = Math.max(0, Math.min(width, layout.maxContentWidth) - 2 * pad);
  const columns = gridColumns(width, column);
  const tablet = width >= TABLET_WIDTH;
  return [
    { where: `search and service/studio grid, ${columns} columns`, width: gridCardWidth(column, columns) },
    { where: 'Home poster row', width: cardWidths(column, tablet).poster },
  ];
}

/** The widest the badge's text may be on a poster `poster` wide, and the widest it can be (its longest word, at the capped size). */
function badgeAt(poster: number) {
  const pill = POSTER_BADGE.maxWidthRatio * poster;
  const chrome = POSTER_BADGE.paddingLeft + POSTER_BADGE.paddingRight + 2 * POSTER_BADGE.border + POSTER_BADGE.dot + POSTER_BADGE.gap;
  const longest = Math.max(...Object.values(BADGE_WORDS).map((word) => word.length));
  const size = POSTER_BADGE.fontSize * POSTER_BADGE.maxFontScale;
  return { room: pill - chrome, text: longest * EM_PER_CHAR * size, pill, size };
}

describe('the poster badge fits the narrowest poster', () => {
  const windows = Array.from({ length: 1400 - 320 + 1 }, (_, i) => 320 + i);
  const all = windows.flatMap((w) => posterWidths(w).map((poster) => ({ window: w, ...poster })));
  const narrowest = all.reduce((least, one) => (one.width < least.width ? one : least));

  it('finds the narrowest poster at a 337 pt window (three columns just past the two-column switch)', () => {
    expect([narrowest.window, narrowest.width]).toEqual([337, 95]);
    // The two widths the app is most used at.
    expect(posterWidths(320)[0]!.width).toBe(139);
    expect(posterWidths(390)[0]!.width).toBe(112);
  });

  it.each([
    ['the narrowest poster', () => narrowest.width],
    ['a 320 pt window', () => Math.min(...posterWidths(320).map((p) => p.width))],
    ['a 390 pt window', () => Math.min(...posterWidths(390).map((p) => p.width))],
  ])('shows the longest badge word whole at %s', (_name, poster) => {
    const { room, text } = badgeAt(poster());
    expect(text).toBeLessThanOrEqual(room);
  });

  it('keeps every word whole on every poster at every window width, with or without side insets', () => {
    for (let w = 320; w <= 1400; w += 1) {
      // Side insets only come with a landscape phone (at least 568 pt wide).
      for (const inset of w >= 568 ? [0, 47, 59] : [0]) {
        for (const poster of posterWidths(w, inset)) {
          const { room, text } = badgeAt(poster.width);
          if (text > room) throw new Error(`${poster.where} at ${w} pt (inset ${inset}) is ${poster.width} pt wide: badge text ${text} pt > ${room} pt`);
        }
      }
    }
  });

  it('keeps the pill, from its inset, inside the poster', () => {
    const { pill } = badgeAt(narrowest.width);
    expect(POSTER_BADGE.inset + pill).toBeLessThan(narrowest.width);
  });

  it('would fail for a longer word or a larger font', () => {
    const { room } = badgeAt(narrowest.width);
    expect(('Not available'.length * EM_PER_CHAR * POSTER_BADGE.fontSize * POSTER_BADGE.maxFontScale) > room).toBe(true);
    expect(10 * EM_PER_CHAR * POSTER_BADGE.fontSize * 1.3 > room).toBe(true);
    // Reporting the numbers: the longest word's width against the room for it.
    const { text } = badgeAt(narrowest.width);
    expect([Math.round(narrowest.width), Math.round(room * 10) / 10, Math.round(text * 10) / 10]).toEqual([95, 64.5, 60]);
  });
});
