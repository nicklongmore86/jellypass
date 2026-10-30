// Home's tests: a household whose every Home list answers a synthetic page (example.test addresses and TMDB-shaped
// image URLs only), all eight services and a few studios, and helpers that lay Home out and scroll it the way the
// device would (Jest lays nothing out by itself, so no lazy row comes near the screen until a test says so): each row
// as tall as what it shows, so a short row moves the rows under it as it would on the device, and a scroll as the
// member's drag (begin, move, let go) or its glide, apart from the scroll events the app's own scrolling sends. Queries
// are queryAll* only and assertions read single fields, so a failure never prints the component tree.
import { act, fireEvent, screen, within } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import type { FetchLike, ResponseLike } from '../../src/api/client';
import { answer, fixture, settle, type Call } from './household';

export const API = '/jellypass/app/v1';

/** The eight services the server lists, in its order (docs/app-design.md, "Networks and studios"). */
export const NETWORKS = [
  [213, 'Netflix'],
  [2739, 'Disney+'],
  [2552, 'Apple TV'],
  [1024, 'Prime Video'],
  [3186, 'HBO Max'],
  [453, 'Hulu'],
  [4330, 'Paramount+'],
  [3353, 'Peacock'],
] as const;

export const STUDIOS = [
  [2, 'Disney'],
  [420, 'Marvel Studios'],
  [41077, 'A24'],
] as const;

export function sourcesAnswer(hasFilms: (id: number) => boolean = () => true) {
  return {
    networks: NETWORKS.map(([id, name]) => ({ id, name, logoUrl: `https://image.tmdb.org/t/p/w300/logo-${id}.png`, hasFilms: hasFilms(id) })),
    studios: STUDIOS.map(([id, name]) => ({ id, name, logoUrl: id === 41077 ? null : `https://image.tmdb.org/t/p/w300/studio-${id}.png` })),
  };
}

const STATES = ['in_library', 'get_this', 'unavailable', 'requested'] as const;

/** A page of `count` titles named after the list, so a row's cards say which list they came from. */
export function pageAnswer(list: string, count = 20) {
  return {
    page: 1,
    nextPage: count === 20 ? 2 : null,
    results: Array.from({ length: count }, (_, index) => {
      const n = index + 1;
      const tv = list.includes('tv') || list.endsWith('series') ? true : list.includes('movie') || list === 'upcoming' || list.endsWith('films') ? false : index % 2 === 1;
      return {
        mediaType: tv ? 'tv' : 'movie',
        tmdbId: 1000 + n,
        title: `${list} ${n}`,
        year: 2020 + (index % 6),
        overview: `The overview of ${list} ${n}.`,
        posterUrl: `https://image.tmdb.org/t/p/w342/poster-${n}.jpg`,
        backdropUrl: `https://image.tmdb.org/t/p/w780/backdrop-${n}.jpg`,
        rating: 6 + (index % 4) / 2,
        state: STATES[index % 4],
        play: null,
        hidden: false,
      };
    }),
  };
}

/** The list a Home call asked for, as its page is named: `trending`, `network-213-all`, … */
export function listOf(route: string): string | undefined {
  const discover = /^GET \/jellypass\/app\/v1\/discover\/([a-z-]+)$/.exec(route);
  if (discover && discover[1] !== 'sources') return discover[1];
  const network = /^GET \/jellypass\/app\/v1\/discover\/network\/(\d+)(?:\/(films|all))?$/.exec(route);
  return network ? `network-${network[1]}-${network[2] ?? 'series'}` : undefined;
}

/** Answers every Home call: /me, the sources and any list. `override` answers first when it returns something. */
export function homeHousehold(override: (call: Call) => ResponseLike | Promise<ResponseLike> | undefined = () => undefined, sources = sourcesAnswer()) {
  return (call: Call): ResponseLike | Promise<ResponseLike> => {
    const own = override(call);
    if (own) return own;
    if (call.route === `GET ${API}/me`) return answer(200, fixture('me'));
    if (call.route === `GET ${API}/discover/sources`) return answer(200, sources);
    const list = listOf(call.route);
    return list ? answer(200, pageAnswer(list)) : answer(404, { error: 'not_found' });
  };
}

/** A fake gateway answering every call with `respond`, recording each (as support/household.ts's fakeGateway). */
export function homeGateway(respond: (call: Call) => ResponseLike | Promise<ResponseLike>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const pathname = url.replace(/^https:\/\/[^/]+/, '').replace(/[?#].*$/, '');
    const call: Call = { url, init, route: `${init.method} ${pathname}` };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls, routes: () => calls.map((call) => call.route) };
}

/** A call's route under the API, as fetch-budget.json writes it: `GET /discover/trending`. */
export function budgetRoute(route: string): string {
  return route.replace(` ${API}/`, ' /');
}

/** A screen to lay Home out on: an iPhone's (less its bars) unless a test says otherwise. */
export interface ScreenSize {
  width: number;
  height: number;
}
export const PHONE_SCREEN: ScreenSize = { width: 390, height: 800 };

type Node = NonNullable<ReturnType<typeof screen.queryAllByTestId>[number]>;

/** Where the column starts under the filter band, its top padding and the gap between its parts (HomeScreen's styles). */
const BAND = 60;
const COLUMN_TOP = 16;
const GAP = 28;
/** A row heading and its waterline, a thumb-sized control, a card's words, a failure's notice and the "nothing" line. */
const HEADING = 37;
const ROW_GAP = 12;
const CONTROL = 44;
const CARD_TEXT = 50;
const NOTICE = 140;
const LINE = 22;
const HERO_PANEL = 160;

let shown: ScreenSize = PHONE_SCREEN;
let contentEnd = 0;

/** A slot as one layout pass placed it: its top on the page, and whether it was still a skeleton then. */
interface Placed {
  key: string;
  top: number;
  skeleton: boolean;
}
/** The first and the last pass of the latest layOut(). */
let passes: { first: Placed[]; last: Placed[] } = { first: [], last: [] };

const styleOf = (node: Node): Record<string, unknown> => StyleSheet.flatten(node.props.style) ?? {};
const number = (value: unknown): number => (typeof value === 'number' ? value : 0);

function inside(node: Node, testID: string | RegExp): Node[] {
  return within(node).queryAllByTestId(testID, { includeHiddenElements: true });
}

/** The first node under `node` with an aspect ratio, as tall as it would draw `width` wide (or its own width). */
function frameHeight(node: Node, width?: number): number {
  const visit = (at: Node): number | undefined => {
    const style = styleOf(at);
    const ratio = number(style.aspectRatio);
    const own = typeof style.width === 'number' ? style.width : width;
    if (ratio > 0 && own !== undefined) return own / ratio;
    for (const child of at.children) {
      if (typeof child === 'string') continue;
      const found = visit(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return visit(node) ?? 0;
}

/** How tall a row's slot draws: what it holds now (skeleton, cards, failure or the "nothing" line), or its own minimum. */
function slotHeight(slot: Node): number {
  const skeleton = inside(slot, 'skeleton-row')[0];
  const card = within(slot).queryAllByRole('link').find((node) => node.props.testID !== 'row-heading-link');
  let content: number;
  if (skeleton) content = 26 + ROW_GAP + frameHeight(skeleton) + 4;
  else if (card) content = HEADING + ROW_GAP + frameHeight(card, number(styleOf(card).width)) + CARD_TEXT;
  else if (within(slot).queryAllByRole('alert').length) content = HEADING + ROW_GAP + NOTICE;
  else content = HEADING + ROW_GAP + LINE;
  return Math.max(content, number(styleOf(slot).minHeight));
}

/** How tall the hero draws: its skeleton, or the first slide's picture and panel and its controls (two lines, stacked). */
function heroHeight(): number {
  const skeleton = screen.queryAllByTestId('skeleton-hero', { includeHiddenElements: true })[0];
  if (skeleton) return frameHeight(skeleton, shown.width - 32);
  const slide = screen.queryAllByTestId('hero-slide-first')[0];
  if (!slide) return 0;
  const controls = screen.queryAllByTestId('hero-controls')[0];
  const stacked = controls !== undefined && inside(controls, 'hero-dots').length === 0;
  return frameHeight(slide, number(styleOf(slide).width)) + HERO_PANEL + (controls ? CONTROL + 12 : 0) + (stacked ? CONTROL + 4 : 0);
}

/** What each Home scroller was last laid out as. */
const laidOut = new WeakMap<Node, string>();

/**
 * Lays Home out on `size` the way the device would: each row's slot as tall as what it shows now (never less than the
 * height it reserves), one under the other, and again after every change until nothing moves, as the device lays out
 * after every render. So a row that comes back short pulls the rows under it up, as it would on the device. With
 * `skip`, nothing is laid out (no layout event) if nothing has moved since the last time, as on the device; by default
 * the same layout is sent again, which Home must take as nothing new.
 */
export async function layOut(size: ScreenSize = PHONE_SCREEN, unmoved: 'again' | 'skip' = 'again'): Promise<void> {
  shown = size;
  const scroller = screen.queryAllByTestId('home-scroll')[0];
  let last = scroller && unmoved === 'skip' ? (laidOut.get(scroller) ?? '') : '';
  passes = { first: [], last: [] };
  for (let pass = 0; pass < 20; pass += 1) {
    const slots = screen.queryAllByTestId(/^home-slot-/);
    let y = COLUMN_TOP + heroHeight() + GAP;
    const placed = slots.map((slot) => {
      const height = slotHeight(slot);
      const top = y;
      y += height + GAP;
      return { slot, top, height };
    });
    contentEnd = BAND + y;
    const record = placed.map(({ slot, top }) => ({ key: String(slot.props.testID).replace(/^home-slot-/, ''), top: BAND + top, skeleton: inside(slot, 'skeleton-row').length > 0 }));
    if (pass === 0) passes.first = record;
    passes.last = record;
    const now = `${size.width}x${size.height}|` + placed.map(({ top, height }) => `${top}:${height}`).join(',');
    if (now === last) return;
    last = now;
    if (scroller) laidOut.set(scroller, now);
    await act(async () => {
      for (const node of screen.queryAllByTestId('home-scroll')) fireEvent(node, 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: size.width, height: size.height } } });
      for (const node of screen.queryAllByTestId('screen-column')) fireEvent(node, 'layout', { nativeEvent: { layout: { x: 0, y: BAND, width: size.width, height: y } } });
      for (const { slot, top, height } of placed) fireEvent(slot, 'layout', { nativeEvent: { layout: { x: 0, y: top, width: size.width - 32, height } } });
    });
    await settle();
  }
}

/** Where the scroll view would say it is, at `y` on the screen it was last laid out on. */
const at = (y: number) => ({ nativeEvent: { contentOffset: { x: 0, y }, contentSize: { width: shown.width, height: contentEnd }, layoutMeasurement: shown } });

/** One scroll view event (`scroll`, `scrollBeginDrag`, `momentumScrollEnd`, …) at each offset in turn. */
export async function scrollEvent(name: string, ...offsets: number[]): Promise<void> {
  await act(async () => {
    for (const node of screen.queryAllByTestId('home-scroll')) for (const y of offsets) fireEvent(node, name, at(y));
  });
  await settle();
}

/** The member's drag from where the screen is to `y`, let go there with no glide. */
export async function drag(from: number, y: number): Promise<void> {
  await scrollEvent('scrollBeginDrag', from);
  await scrollEvent('scroll', y);
  await scrollEvent('scrollEndDrag', y);
}

/** The glide after a drag is let go: it begins at `from`, passes each of `offsets` and stops at the last. */
export async function glide(from: number, ...offsets: number[]): Promise<void> {
  await scrollEvent('momentumScrollBegin', from);
  await scrollEvent('scroll', ...offsets);
  await scrollEvent('momentumScrollEnd', offsets.at(-1) ?? from);
}

/** Where each Home scroller's top is, as the member last left it (a new render starts at the top). */
const scrolled = new WeakMap<Node, number>();
const offsetNow = () => {
  const node = screen.queryAllByTestId('home-scroll')[0];
  return node ? (scrolled.get(node) ?? 0) : 0;
};

/**
 * The rows still skeletons on screen at the top, in the first pass of the latest layOut() (what Home's look at rest
 * sees, when it is the first layout of a drawing) or its last (where the rows settled after that).
 */
export function skeletonsOnScreen(pass: 'first' | 'last'): string[] {
  return passes[pass].filter((slot) => slot.skeleton && slot.top < shown.height).map((slot) => slot.key);
}

/** The member drags Home so its top is at `y`, on the screen it was last laid out on, and it is laid out again. */
export async function scrollTo(y: number): Promise<void> {
  await drag(offsetNow(), y);
  for (const node of screen.queryAllByTestId('home-scroll')) scrolled.set(node, y);
  await layOut(shown);
}

/** The furthest down the scroll view can go now: the content's end at the screen's bottom. */
export const scrollEnd = (): number => Math.max(0, contentEnd - shown.height);

/** How far a quick scroll moves between two scroll events: about a frame's worth. */
const STEP = 100;

/**
 * Lays Home out and scrolls it from the top to its end in one go, as a member would (a scroll event every STEP points,
 * laid out as it goes, never past the end the content has then); again once the services' rows are there.
 */
export async function scrollToEnd(size: ScreenSize = shown): Promise<void> {
  for (let round = 0; round < 2; round += 1) {
    await layOut(size);
    await scrollEvent('scrollBeginDrag', offsetNow());
    let y = 0;
    for (; ; y += STEP) {
      y = Math.min(y, scrollEnd());
      const end = y >= scrollEnd();
      await scrollEvent('scroll', y);
      await layOut(size, 'skip');
      // Done once it is at the end; if rows shrank under it, the scroll view goes up to the new end itself, next.
      if (end && y <= scrollEnd()) break;
    }
    await scrollEvent('scrollEndDrag', y);
    for (const node of screen.queryAllByTestId('home-scroll')) scrolled.set(node, y);
  }
}

/** The headings on screen, in order: their words, or their accessible name when drawn with a logo. */
export function headings(): string[] {
  return screen
    .queryAllByRole('header')
    .map((node) => String(node.props.accessibilityLabel ?? [node.props.children].flat().join('')))
    .filter((text) => text !== '');
}

/** Every link's accessible name. */
export function links(): string[] {
  return screen.queryAllByRole('link').map((node) => String(node.props.accessibilityLabel));
}

export async function choose(filter: 'All' | 'Movies' | 'TV'): Promise<void> {
  const found = screen.queryAllByRole('radio', { name: filter });
  if (found.length !== 1) throw new Error(`expected one filter "${filter}", found ${found.length}`);
  await fireEvent.press(found[0]!);
  // Home takes a member who was down the page back to the first row (the top, as Jest never lays the hero out).
  for (const node of screen.queryAllByTestId('home-scroll')) scrolled.set(node, 0);
  await settle();
}

export function chosen(): string[] {
  return screen
    .queryAllByRole('radio')
    .filter((node) => node.props.accessibilityState?.checked === true)
    .map((node) => String(node.props.accessibilityLabel));
}

/**
 * Turns "New only" off where Home is on screen, for the tests of what a row or the hero shows with everything
 * in it (it is on at every sign-in). A no-op where it is already off or Home is not mounted.
 */
export async function showAll(): Promise<void> {
  const chip = screen.queryAllByTestId('home-hide', { includeHiddenElements: true })[0];
  if (chip?.props.accessibilityState?.checked) {
    await fireEvent.press(chip);
    await settle();
    // The hero keeps its title selected through the change; a fresh Home shows its first slide.
    const first = screen.queryAllByLabelText(/^Show title 1 of \d+: /)[0];
    if (first && first.props.accessibilityState?.selected !== true) {
      await fireEvent.press(first);
      await settle();
    }
  }
}
