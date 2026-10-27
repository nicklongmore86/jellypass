// Where Home's sideways rows come to rest (snapOffsets): a card centred, the first card at the row's start and the last
// at its end, for the widths the rows really use on a phone and an iPad (HomeScreen's cardWidths, the row's gap, the
// studios' tile). Every assertion compares numbers.
import { CARD_GAP, STUDIO_TILE_WIDTH } from '../src/home/components';
import { snapOffsets, TABLET_WIDTH } from '../src/home/layout';
import { cardWidths } from '../src/screens/HomeScreen';

/** The column inside the 16 pt gutters, as Home lays it out (the iPad's under the 1152 pt cap). */
const column = (width: number) => Math.min(width, 1152) - 32;
const SIZES = { phone: 390, narrow: 320, ipad: 1024, ipadPro: 1366 };
const COUNT = 20;

function offsetsFor(width: number, item: (column: number) => number, count = COUNT) {
  const viewport = column(width);
  return { viewport, item: item(viewport), offsets: snapOffsets(count, item(viewport), CARD_GAP, viewport)! };
}

const rows = {
  backdrop: (viewport: number, width: number) => cardWidths(viewport, width >= TABLET_WIDTH).backdrop,
  poster: (viewport: number, width: number) => cardWidths(viewport, width >= TABLET_WIDTH).poster,
  studios: () => STUDIO_TILE_WIDTH,
};

describe.each(Object.entries(SIZES))('on %s', (_, width) => {
  describe.each(Object.entries(rows))('a %s row', (__, widthOf) => {
    const { viewport, item, offsets } = offsetsFor(width, (view) => widthOf(view, width));
    const step = item + CARD_GAP;
    const end = COUNT * item + (COUNT - 1) * CARD_GAP - viewport;

    it('starts with the first card at the row start and ends with the last card at the row end', () => {
      expect(offsets[0]).toBe(0);
      expect(offsets.at(-1)).toBeCloseTo(end, 6);
    });

    it('rests everywhere else with a card exactly centred', () => {
      const off = offsets.slice(1, -1).map((offset) => {
        const at = (offset + (viewport - item) / 2) / step;
        return Math.abs(at - Math.round(at));
      });
      expect(off.every((distance) => distance < 1e-9)).toBe(true);
      expect(off.length).toBeGreaterThan(0);
    });

    it('goes up a card at a time, never leaving a sliver short of the start or end', () => {
      const moves = offsets.slice(1).map((offset, at) => offset - offsets[at]!);
      expect(moves.every((move) => move >= step / 2 - 1e-9)).toBe(true);
      // Between the centred stops, exactly one card's step.
      expect(moves.slice(1, -1).every((move) => Math.abs(move - step) < 1e-9)).toBe(true);
      expect(offsets.every((offset) => offset >= 0 && offset <= end + 1e-9)).toBe(true);
    });

    it('stops at every card that can be centred', () => {
      const centrable = Array.from({ length: COUNT }, (___, at) => at * step - (viewport - item) / 2).filter(
        (centred) => centred >= step / 2 && end - centred >= step / 2,
      );
      expect(offsets.length).toBe(centrable.length + 2);
    });
  });
});

describe('the numbers on a 390 pt phone', () => {
  it('stops the big cards at the start, then with each next card centred, then at the end', () => {
    const { item, offsets } = offsetsFor(390, (view) => cardWidths(view, false).backdrop);
    expect(item).toBe(329);
    // Card 1 centred: (329 + 12) - (358 - 329) / 2.
    expect(offsets.slice(0, 3)).toEqual([0, 326.5, 667.5]);
    expect(offsets.at(-1)).toBe(20 * 329 + 19 * 12 - 358);
  });

  it('skips the posters\' centred stop that would sit a sliver from the start', () => {
    const { offsets } = offsetsFor(390, (view) => cardWidths(view, false).poster);
    // Card 1 centred would be 144 - 113 = 31 pt in: too close to the start; card 2 is the first centred stop.
    expect(offsets.slice(0, 2)).toEqual([0, 175]);
  });
});

describe('a row with nowhere to go', () => {
  it('has no stops when it fits whole, has one card, or has no width yet', () => {
    expect(snapOffsets(2, 132, CARD_GAP, 358)).toBeUndefined();
    expect(snapOffsets(1, 329, CARD_GAP, 358)).toBeUndefined();
    expect(snapOffsets(0, 329, CARD_GAP, 358)).toBeUndefined();
    expect(snapOffsets(20, 329, CARD_GAP, 0)).toBeUndefined();
  });

  it('keeps just the start and the end when no card can be centred between them', () => {
    expect(snapOffsets(3, 132, CARD_GAP, 358)).toEqual([0, 3 * 132 + 2 * 12 - 358]);
  });
});
