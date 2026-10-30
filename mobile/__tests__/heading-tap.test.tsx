// A Home row's whole heading (title, logo and chevron) is one touch target for the row's See all page: the same page, filter,
// New only and row handoff as the chevron, with no call, 44 pt tall with a pressed state, and touch-only so a screen
// reader still gets the heading as a header and the chevron as the one "See all <row>" link, never a duplicate. Queries
// are queryAll* and assertions read single fields, so a failure never prints the component tree.
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { buildResponderGrantEvent, buildResponderReleaseEvent } from '@testing-library/react-native/dist/events';
import { renderRouter } from 'expo-router/testing-library';

import type { FetchLike } from '../src/api/client';
import { API, choose, scrollToEnd, showAll } from './support/home';
import { listGateway } from './support/list';
import { ORIGIN, TOKEN, keepSession, settle, store } from './support/household';
import { ListHeading, NetworkHeading } from '../src/home/components';
import { layout } from '../src/theme';
import { gridNames } from './support/source';
import { buttonNamed, flat, headings, linkNamed, only, pressNode } from './support/title';

jest.setTimeout(30_000);

let mockFetch: FetchLike;
jest.mock('../src/api/transport', () => ({
  ...jest.requireActual('../src/api/transport'),
  householdFetch: (url: string, init: never) => mockFetch(url, init),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: jest.requireActual('../app.config').default } }));
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);

const PHONE = { width: 390, height: 844, scale: 2, fontScale: 1 };
let mockWindow = PHONE;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({ __esModule: true, default: () => mockWindow }));

let gateway: ReturnType<typeof listGateway>;

function serveHousehold(...args: Parameters<typeof listGateway>) {
  gateway = listGateway(...args);
  mockFetch = gateway.fetch;
}

beforeEach(() => {
  mockWindow = PHONE;
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  serveHousehold();
});

/** Home with New only off (unless `hide`); scrolled to its end, every lazy row loaded, only with `scroll`. */
async function start({ hide = false, scroll = false } = {}) {
  const app = await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
  if (!hide) await showAll();
  if (scroll) await scrollToEnd();
  return app;
}

/** Every call from now on, as its address under the API (query kept). */
function since() {
  const before = gateway.calls.length;
  return () => gateway.calls.slice(before).map((call) => call.url.replace(/^https:\/\/[^/]+/, '').replace(API, ''));
}

type Node = NonNullable<ReturnType<typeof screen.queryAllByText>[number]>;

/** The touch-only tap target of the row heading `name` (its header's label or text), found from the header up. */
function tapOf(name: string): Node {
  const header = only(
    screen.queryAllByRole('header').filter((node) => (node.props.accessibilityLabel ?? [node.props.children].flat().join('')) === name),
    `header ${name}`,
  );
  let at: Node | null = header;
  while (at && at.props.testID !== 'row-heading-tap') at = at.parent;
  if (!at) throw new Error(`no tap target around ${name}`);
  return at;
}

const taps = () => screen.queryAllByTestId('row-heading-tap', { includeHiddenElements: true });
const title = () => headings()[0];

describe('the heading row as a touch target', () => {
  it.each([
    ['Trending', 'trending'],
    ['Popular movies', 'popular-movies'],
    ['New movie releases', 'new-movies'],
  ] as const)('opens "%s" from a press on its title, as the chevron does, with no call and New only kept', async (heading, list) => {
    const app = await start({ hide: true, scroll: true });
    const calls = since();
    // A press on the title text itself, not on the chevron.
    const header = only(screen.queryAllByRole('header').filter((node) => [node.props.children].flat().join('') === heading), heading);
    await pressNode(header);
    expect(app.getPathname()).toBe(`/home/list/${list}`);
    expect(title()).toBe(heading);
    expect(only(screen.queryAllByTestId('list-hide'), 'New only chip').props.accessibilityState).toEqual({ checked: true });
    expect(calls()).toEqual([]);
  });

  it('opens the same page and grid from the row as from the chevron', async () => {
    const app = await start({ scroll: true });
    await pressNode(tapOf('Popular series'));
    const viaRow = [app.getPathname(), gridNames()];
    await pressNode(buttonNamed('Back'));
    await pressNode(linkNamed('See all Popular series'));
    expect([app.getPathname(), gridNames()]).toEqual(viaRow);
  });

  it("opens a service's page from a press on its logo line, on the list the row showed, with no call", async () => {
    const app = await start({ scroll: true });
    const calls = since();
    await pressNode(tapOf('Popular on Netflix'));
    expect(app.getPathname()).toBe('/home/network/213');
    expect(title()).toBe('Popular on Netflix');
    expect(calls().filter((call) => call.startsWith('/discover/network'))).toEqual(['/discover/network/213/all']);
  });

  it('keeps the filter: under Movies the row opens its Movies list', async () => {
    const app = await start();
    await choose('Movies');
    await pressNode(tapOf('Trending movies'));
    expect(app.getPathname()).toBe('/home/list/trending-movies');
  });

  it('gives every list row and service row one tap target, at least 44 pt tall', async () => {
    await start({ scroll: true });
    expect(taps()).toHaveLength(6 + 8);
    const problems: string[] = [];
    for (const node of taps()) {
      const size = flat(node);
      if (!(typeof size.minHeight === 'number' && size.minHeight >= layout.touchTarget)) problems.push('under 44 pt');
    }
    expect([...new Set(problems)]).toEqual([]);
  });

  it('is touch-only: no role, no name, not an accessibility element, so no duplicate stop', async () => {
    await start({ scroll: true });
    const problems: string[] = [];
    for (const node of taps()) {
      const { accessible, accessibilityRole, accessibilityLabel, importantForAccessibility, accessibilityElementsHidden } = node.props;
      if (accessible !== false) problems.push('accessible');
      if (accessibilityRole !== undefined || accessibilityLabel !== undefined) problems.push('a role or label');
      if (importantForAccessibility !== 'no') problems.push('Android would focus it');
      if (accessibilityElementsHidden) problems.push('hides its children from VoiceOver');
    }
    expect([...new Set(problems)]).toEqual([]);
    // Exactly one header and one See all link per row, in that reading order: nothing else is announced.
    const order = screen.queryAllByRole(/^(header|link)$/).map((node) => `${String(node.props.accessibilityRole)}: ${String(node.props.accessibilityLabel ?? [node.props.children].flat().join(''))}`);
    expect(order.filter((item) => item === 'header: Trending')).toHaveLength(1);
    expect(order.filter((item) => item === 'link: See all Trending')).toHaveLength(1);
    expect(order.filter((item) => item.startsWith('link: See all '))).toHaveLength(6 + 8);
    const at = order.indexOf('header: Popular on Netflix');
    expect(order[at + 1]).toBe('link: See all Popular on Netflix');
  });

  it('leaves the Studios strip, a row without a See all page, a plain heading', async () => {
    await start({ scroll: true });
    const header = only(screen.queryAllByRole('header').filter((node) => [node.props.children].flat().join('') === 'Studios'), 'Studios heading');
    // Nothing from the heading up to the strip's row is pressable.
    for (let at: Node | null = header; at && at.props.testID !== 'home-scroll'; at = at.parent) {
      expect([at.props.onPress, at.props.onClick, at.props.onResponderRelease].filter((h) => typeof h === 'function')).toEqual([]);
    }
    expect(taps()).toHaveLength(6 + 8);
  });

  it('keeps the chevron its own press, a second target inside the first', async () => {
    const app = await start();
    await pressNode(linkNamed('See all Trending'));
    expect(app.getPathname()).toBe('/home/list/trending');
  });
});

// A finger on the title or on the chevron: the responder goes to whichever was touched (the chevron's own, inside the
// row's), and either way the whole heading dims while it is held, as every other press in the app, then opens on release.
describe('the pressed state', () => {
  const headings = [
    ['a list row', (onOpen: () => void) => <ListHeading title="Trending" onOpen={onOpen} />],
    ['a service row', (onOpen: () => void) => <NetworkHeading prefix="Popular on" network={{ id: 213, name: 'Netflix', logoUrl: null }} onOpen={onOpen} />],
  ] as const;
  const targets = [
    ['the title', 'row-heading-tap'],
    ['the chevron', 'row-heading-link'],
  ] as const;

  /** How dim the whole heading row is drawn: the tap target's opacity, 1 when it sets none. */
  const dim = () => flat(only(screen.queryAllByTestId('row-heading-tap'), 'tap target')).opacity ?? 1;

  describe.each(headings)('on %s', (_, draw) => {
    it.each(targets)('dims the whole heading while %s is held, and opens on release', async (_name, testID) => {
      const onOpen = jest.fn();
      await render(draw(onOpen));
      const target = only(screen.queryAllByTestId(testID), testID);
      expect(dim()).toBe(1);
      await act(async () => target.props.onResponderGrant(buildResponderGrantEvent()));
      expect(dim()).toBe(0.75);
      expect(onOpen).not.toHaveBeenCalled();
      await act(async () => target.props.onResponderRelease(buildResponderReleaseEvent()));
      // A quick tap's press-out waits out Pressable's minimum press (130 ms), so the dim is seen even then.
      await waitFor(() => expect(dim()).toBe(1));
      expect(onOpen).toHaveBeenCalledTimes(1);
    });
  });
});
