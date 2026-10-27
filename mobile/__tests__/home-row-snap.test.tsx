// How a sideways card row comes to rest, on each platform. iOS snaps natively (snapToOffsets). Android is never given
// snap stops, as React Native would turn them into native paging, which stops Tab reaching a card off screen and a
// focused card being scrolled into view; there, once a touch's glide stops, the row is moved to the nearest stop with
// scrollTo, and nothing else (a focus or screen-reader scroll, the snap's own scroll) moves it. On either, a change of
// width moves the row to the stop that keeps the same card in view. Every assertion compares numbers or strings.
import { fireEvent, render, screen, within } from '@testing-library/react-native';
import { AccessibilityInfo, Platform, ScrollView } from 'react-native';

import type { Card } from '../src/api/types';
import { CARD_GAP, CardRow } from '../src/home/components';
import { nearestStop, resnapOffset, snapOffsets } from '../src/home/layout';

jest.setTimeout(30_000);

/** A 390 pt phone's column and its big cards: stops at 0, 326.5, 667.5, … and the end. */
const VIEWPORT = 358;
const ITEM = 329;
const COUNT = 20;
const STOPS = snapOffsets(COUNT, ITEM, CARD_GAP, VIEWPORT)!;

const cards: Card[] = Array.from({ length: COUNT }, (_, at) => ({
  mediaType: 'movie',
  tmdbId: at + 1,
  title: `Title ${at + 1}`,
  year: 2020,
  overview: '',
  posterUrl: null,
  backdropUrl: null,
  rating: null,
  state: 'get_this',
  play: null,
}));

type Node = NonNullable<ReturnType<typeof screen.queryAllByTestId>[number]>;

let scrolls: jest.SpyInstance;
beforeEach(() => {
  // The mock ScrollView's scrollTo is already a jest.fn, shared by every row and test: start each test with no calls.
  scrolls = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => undefined);
  scrolls.mockClear();
});
afterEach(() => {
  jest.restoreAllMocks();
});

/** Every scrollTo the row asked for, as "x animated". */
const asked = () =>
  scrolls.mock.calls.map(([to]) => {
    const { x, animated } = to as { x: number; animated: boolean };
    return `${x} ${animated}`;
  });

const row = (): Node => {
  const found = screen.queryAllByTestId('card-row');
  if (found.length !== 1) throw new Error(`expected one card row, found ${found.length}`);
  return found[0]!;
};

const view = (item = ITEM, viewport = VIEWPORT) => (
  <CardRow cards={cards} variant="backdrop" cardWidth={item} viewport={viewport} onOpen={() => undefined} />
);

async function show(item = ITEM, viewport = VIEWPORT) {
  return render(view(item, viewport));
}

const at = (x: number) => ({ nativeEvent: { contentOffset: { x, y: 0 }, velocity: { x: 0, y: 0 } } });

async function event(name: string, x: number) {
  await fireEvent(row(), name, at(x));
}

async function layout(width: number) {
  await fireEvent(row(), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width, height: 240 } } });
}

/** A finger drags the row from `from` to `to` and lets go; Android then glides through `glide`, and says it stopped. */
async function swipe(from: number, to: number, ...glide: number[]) {
  await event('scrollBeginDrag', from);
  await event('scroll', to);
  await event('scrollEndDrag', to);
  for (const x of glide) await event('scroll', x);
  await event('momentumScrollEnd', glide.at(-1) ?? to);
}

describe('on Android', () => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'android');
  });

  it('gives the row no snap stops or paging, so focus can reach and reveal every card, and keeps momentum free', async () => {
    await show();
    const props = row().props;
    expect(props.snapToOffsets).toBeUndefined();
    expect(props.snapToInterval).toBeUndefined();
    expect(props.pagingEnabled).toBeUndefined();
    expect(String(props.decelerationRate)).toBe('normal');
    expect(typeof props.onMomentumScrollEnd).toBe('function');
  });

  it('moves the row to the nearest stop once a touch glide stops', async () => {
    await show();
    await swipe(0, 200, 300, 360);
    expect(asked()).toEqual([`${STOPS[1]} true`]);
  });

  it('snaps a drag let go with no glide, as Android still says the row came to rest', async () => {
    await show();
    await swipe(0, 600);
    expect(asked()).toEqual([`${STOPS[2]} true`]);
  });

  it('lets a fast flick travel several cards, snapping only where it stops', async () => {
    await show();
    await swipe(0, 300, 1500, 2600, 3050);
    expect(asked()).toEqual([`${nearestStop(STOPS, 3050)} true`]);
    expect(STOPS.indexOf(nearestStop(STOPS, 3050))).toBeGreaterThan(3);
  });

  it('leaves a row scrolled by focus or a screen reader where it was put', async () => {
    await show();
    await event('scroll', 500);
    await event('scroll', 610);
    // A scroll not begun by a finger: even if a momentum end were sent, nothing snaps.
    await event('momentumScrollEnd', 610);
    expect(asked()).toEqual([]);
  });

  it('does not snap away from a card the keyboard focused while the row was still gliding', async () => {
    await show();
    await event('scrollBeginDrag', 0);
    await event('scroll', 200);
    await event('scrollEndDrag', 200);
    await fireEvent(within(row()).queryAllByRole('link')[3]!, 'focus');
    await event('scroll', 1000);
    await event('momentumScrollEnd', 1000);
    expect(asked()).toEqual([]);
  });

  it('ignores the end of its own snap, and the one sent when a new touch stops a glide, so it never loops', async () => {
    await show();
    await swipe(0, 200, 300);
    expect(asked()).toEqual([`${STOPS[1]} true`]);
    // The snap's own animation ends with a momentum end at the stop.
    await event('momentumScrollEnd', STOPS[1]!);
    // A finger stops the row mid-glide: the cancelled animation sends a momentum end while the finger is down.
    await event('scrollBeginDrag', 400);
    await event('momentumScrollEnd', 400);
    expect(asked()).toEqual([`${STOPS[1]} true`]);
    await event('scroll', 700);
    await event('scrollEndDrag', 700);
    await event('momentumScrollEnd', 700);
    await event('momentumScrollEnd', STOPS[2]!);
    expect(asked()).toEqual([`${STOPS[1]} true`, `${STOPS[2]} true`]);
  });

  it('does not move a row that already came to rest on a stop', async () => {
    await show();
    await swipe(0, STOPS[2]!);
    expect(asked()).toEqual([]);
  });

  it('snaps without animation with Reduce Motion on', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    await show();
    await swipe(0, 200, 300);
    expect(asked()).toEqual([`${STOPS[1]} false`]);
  });
});

describe('on iOS', () => {
  it('snaps natively at the same stops, with free momentum, and never scrolls the row itself', async () => {
    await show();
    const props = row().props;
    expect((props.snapToOffsets as number[]).join(',')).toBe(STOPS.join(','));
    expect(String(props.decelerationRate)).toBe('normal');
    expect(props.pagingEnabled).toBeUndefined();
    expect(props.onMomentumScrollEnd).toBeUndefined();
    await swipe(0, 200, 300);
    expect(asked()).toEqual([]);
  });
});

describe.each(['ios', 'android'] as const)('on %s, when the row changes width', (os) => {
  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', os);
  });

  /** A 390 pt phone turned to 844 pt wide: the column and big card both grow. */
  const WIDE = { viewport: 812, item: 600 };

  it('keeps the same card centred, at the new stop, without animation', async () => {
    const app = await show();
    await layout(VIEWPORT);
    // Resting with card 2 centred.
    await event('scroll', STOPS[2]!);
    await app.rerender(view(WIDE.item, WIDE.viewport));
    await layout(WIDE.viewport);
    const expected = 2 * (WIDE.item + CARD_GAP) - (WIDE.viewport - WIDE.item) / 2;
    expect(snapOffsets(COUNT, WIDE.item, CARD_GAP, WIDE.viewport)!.includes(expected)).toBe(true);
    expect(asked()).toEqual([`${expected} false`]);
  });

  it('keeps a row at its start or its end there', async () => {
    const app = await show();
    await layout(VIEWPORT);
    await event('scroll', STOPS.at(-1)!);
    await app.rerender(view(WIDE.item, WIDE.viewport));
    await layout(WIDE.viewport);
    expect(asked()).toEqual([`${snapOffsets(COUNT, WIDE.item, CARD_GAP, WIDE.viewport)!.at(-1)} false`]);
  });

  it('does nothing on its first layout, or a layout at the same width', async () => {
    await show();
    await event('scroll', 500);
    await layout(VIEWPORT);
    await layout(VIEWPORT);
    expect(asked()).toEqual([]);
  });
});

describe('resnapOffset', () => {
  const phone = { count: COUNT, item: ITEM, gap: CARD_GAP, viewport: VIEWPORT };

  it('goes to the nearest stop when only the width changed, and nowhere when the row now fits whole', () => {
    expect(resnapOffset(700, phone, phone)).toBe(STOPS[2]);
    expect(resnapOffset(700, phone, { ...phone, count: 1 })).toBeUndefined();
    expect(resnapOffset(0, { ...phone, count: 1 }, phone)).toBe(0);
  });
});
