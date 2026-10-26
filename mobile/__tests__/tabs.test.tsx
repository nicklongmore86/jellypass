// The signed-in app through the real router (src/app): the four tabs and which one is active, moving between them, a
// pushed screen's Back, Android's back button, the Account screen's member card, Sign out and Change household, the
// credits, that every pressable is named and a thumb's size, that a link into the tabs while signed out lands on
// sign-in, and that nothing but the start-up /me goes out. A fake gateway answers every call the app makes (through
// src/api/transport); queries never print the component tree (support/household.ts).
import { act, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';
import { Linking, StyleSheet, Text } from 'react-native';

import type { FetchLike } from '../src/api/client';
import { JUSTWATCH_CREDIT, JUSTWATCH_URL, TMDB_NOTICE, TMDB_SOURCE, TMDB_URL, type LinkedSentence } from '../src/credits';
import { PLACEHOLDER_TEXT } from '../src/screens/PlaceholderScreen';
import { colors, contrast, layout } from '../src/theme';
import { ORIGIN, OTHER_ORIGIN, TOKEN, answer, button, fakeGateway, fixture, keepSession, press, settle, shows, store, storedSession } from './support/household';

let mockFetch: FetchLike;
jest.mock('../src/api/transport', () => ({
  ...jest.requireActual('../src/api/transport'),
  householdFetch: (url: string, init: never) => mockFetch(url, init),
}));
// The app config the build embeds, which Jest has no copy of.
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: jest.requireActual('../app.config').default } }));
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);

// Home's own calls (the lazy rows never come near the screen here: Jest lays nothing out).
const HOME_AT_ONCE = ['trending', 'popular-movies', 'popular-tv', 'new-movies'].map((list) => `GET /jellypass/app/v1/discover/${list}`);

const HOUSEHOLD = {
  'GET /jellypass/app/v1/me': () => answer(200, fixture('me')),
  'GET /jellypass/app/v1/discover/sources': () => answer(200, fixture('sources')),
  ...Object.fromEntries(HOME_AT_ONCE.map((route) => [route, () => answer(200, fixture('page'))])),
  'GET /Users/Public': () => answer(200, []),
  'POST /Sessions/Logout': () => answer(204),
};

// A screen pushed on the Account tab's stack, standing in for the title pages that come with 3.2.
function Pushed() {
  return <Text>Pushed screen</Text>;
}

let gateway: ReturnType<typeof fakeGateway>;
let openURL: jest.SpyInstance;

beforeEach(() => {
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  gateway = fakeGateway(HOUSEHOLD);
  mockFetch = gateway.fetch;
  openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
});

afterEach(() => openURL.mockRestore());

async function start(initialUrl = '/') {
  const result = await renderRouter({ appDir: 'src/app', overrides: { '(tabs)/account/pushed': Pushed } }, { initialUrl });
  await settle();
  return result;
}

/** The calls made but Home's discover calls. */
function notHome(): string[] {
  return gateway.routes().filter((route) => !route.startsWith('GET /jellypass/app/v1/discover/'));
}

function tabs() {
  return screen.queryAllByRole('tab');
}

function tabNamed(name: string) {
  const found = screen.queryAllByRole('tab', { name });
  if (found.length !== 1) throw new Error(`expected one tab "${name}", found ${found.length}`);
  return found[0]!;
}

function selectedTabs(): string[] {
  return tabs()
    .filter((tab) => tab.props.accessibilityState?.selected === true)
    .map((tab) => String(tab.props.accessibilityLabel));
}

async function openTab(name: string) {
  await fireEvent.press(tabNamed(name));
  await settle();
}

const sentenceOf = (sentence: LinkedSentence) => `${sentence.before}${sentence.link}${sentence.after}`;

function link(sentence: LinkedSentence) {
  const found = screen.queryAllByRole('link', { name: sentenceOf(sentence) });
  if (found.length !== 1) throw new Error(`expected one link "${sentence.link}", found ${found.length}`);
  return found[0]!;
}

function headers(): string[] {
  return screen.queryAllByRole('header').map((node) => [node.props.children].flat().join(''));
}

describe('the tab bar', () => {
  it('has four labelled tabs in the PWA order, in one tab list, with Home active after sign-in', async () => {
    const app = await start();
    expect(app.getPathname()).toBe('/home');
    expect(tabs().map((tab) => tab.props.accessibilityLabel)).toEqual(['Home', 'Search', 'My requests', 'Account']);
    const bar = screen.queryAllByTestId('tabbar');
    expect(bar.map((node) => [node.props.accessibilityRole, node.props.accessibilityLabel])).toEqual([['tablist', 'Main']]);
    for (const label of ['Home', 'Search', 'My requests', 'Account']) expect(shows(label)).toBe(true);
    expect(selectedTabs()).toEqual(['Home']);
    expect(tabs().map((tab) => tab.props.accessibilityHint)).toEqual(['Tab 1 of 4', 'Tab 2 of 4', 'Tab 3 of 4', 'Tab 4 of 4']);
  });

  it('draws each tab with its own icon, the key for Account', async () => {
    await start();
    for (const icon of ['home', 'search', 'requests', 'account']) {
      expect(screen.queryAllByTestId(`icon-${icon}`, { includeHiddenElements: true })).toHaveLength(1);
    }
  });

  it('marks the active tab with the tint and a cyan outline, and the others not', async () => {
    await start();
    const style = (name: string) => Object.assign({}, ...[tabNamed(name).props.style].flat(Infinity).filter(Boolean));
    expect(style('Home')).toMatchObject({ backgroundColor: '#06304d', borderColor: '#00a4dc', borderWidth: 1.5 });
    expect(style('Search')).toMatchObject({ borderColor: 'transparent', borderWidth: 1.5 });
    expect(style('Search').backgroundColor).toBeUndefined();
  });

  it('moves between the tabs, each with its title in the header (Home has none, as in the PWA)', async () => {
    const app = await start();
    expect(headers().filter((text) => text !== '')).toEqual(['Trending', 'Popular movies', 'Popular series', 'New movie releases', 'Studios']);
    expect(screen.queryAllByRole('radio').map((node) => node.props.accessibilityLabel)).toEqual(['All', 'Movies', 'TV']);

    await openTab('Search');
    expect(app.getPathname()).toBe('/search');
    expect(selectedTabs()).toEqual(['Search']);
    expect(headers()).toEqual(['Search']);
    expect(shows(PLACEHOLDER_TEXT.search)).toBe(true);

    await openTab('My requests');
    expect(app.getPathname()).toBe('/requests');
    expect(selectedTabs()).toEqual(['My requests']);
    expect(headers()).toContain('My requests');

    await openTab('Account');
    expect(app.getPathname()).toBe('/account');
    expect(selectedTabs()).toEqual(['Account']);
    expect(headers()).toContain('Account');

    await openTab('Home');
    expect(app.getPathname()).toBe('/home');
    expect(selectedTabs()).toEqual(['Home']);
  });

  it('has no Back button on a tab\'s first screen', async () => {
    await start();
    for (const name of ['Home', 'Search', 'My requests', 'Account']) {
      await openTab(name);
      expect(screen.queryAllByRole('button', { name: 'Back' })).toHaveLength(0);
    }
  });
});

describe('a pushed screen', () => {
  it('keeps its tab, and its Back button goes back', async () => {
    const app = await start();
    await openTab('Account');
    await act(async () => router.push('/account/pushed'));
    await settle();
    expect(app.getPathname()).toBe('/account/pushed');
    expect(selectedTabs()).toEqual(['Account']);
    expect(shows('Pushed screen')).toBe(true);
    await press('Back');
    await settle();
    expect(app.getPathname()).toBe('/account');
    expect(screen.queryAllByRole('button', { name: 'Back' })).toHaveLength(0);
  });
});

describe("Android's back button", () => {
  it('from a screen opened from another tab goes to its own tab\'s first screen (with its anchor)', async () => {
    const app = await start();
    await act(async () => router.push('/account/pushed', { withAnchor: true }));
    await settle();
    expect(selectedTabs()).toEqual(['Account']);
    await act(async () => router.back());
    await settle();
    expect(app.getPathname()).toBe('/account');
  });

  // React Navigation answers the hardware back button with GO_BACK while something can go back, and lets the system
  // close the app when nothing can: router.back() and canGoBack() are those two.
  it('pops a pushed screen, then goes to Home, then leaves the app', async () => {
    const app = await start();
    await openTab('Account');
    await act(async () => router.push('/account/pushed'));
    await settle();
    await act(async () => router.back());
    await settle();
    expect(app.getPathname()).toBe('/account');
    expect(router.canGoBack()).toBe(true);
    await act(async () => router.back());
    await settle();
    expect(selectedTabs()).toEqual(['Home']);
    expect(router.canGoBack()).toBe(false);
  });

  it('never goes back to the sign-in screens from Home', async () => {
    await start();
    expect(router.canGoBack()).toBe(false);
    expect(shows('Choose your profile to sign in.')).toBe(false);
  });
});

describe('the Account screen', () => {
  it('shows the member and household from /me', async () => {
    await start();
    await openTab('Account');
    expect(shows('Synthetic Member · Synthetic Household')).toBe(true);
    expect(shows('ACCOUNT')).toBe(true);
    expect(shows('ABOUT & CREDITS')).toBe(true);
  });

  it('shows the TMDB logo and its exact notice, the sources and the JustWatch credit', async () => {
    await start();
    await openTab('Account');
    expect(screen.queryAllByTestId('tmdb-logo', { includeHiddenElements: true })).toHaveLength(1);
    expect(screen.queryAllByRole('link', { name: 'The Movie Database (TMDB)' })).toHaveLength(1);
    expect(shows(TMDB_NOTICE)).toBe(true);
    expect(shows(sentenceOf(TMDB_SOURCE))).toBe(true);
    expect(shows(sentenceOf(JUSTWATCH_CREDIT))).toBe(true);
  });

  it('shows the app version and build, and the API version from /me', async () => {
    await start();
    await openTab('Account');
    expect(shows('JellyPass 0.1.0 (build 1)')).toBe(true);
    expect(shows('Household API version 1')).toBe(true);
  });

  it('opens TMDB and JustWatch in the system browser', async () => {
    await start();
    await openTab('Account');
    await fireEvent.press(screen.queryAllByRole('link', { name: 'The Movie Database (TMDB)' })[0]!);
    await fireEvent.press(link(TMDB_SOURCE));
    await fireEvent.press(link(JUSTWATCH_CREDIT));
    expect(openURL.mock.calls).toEqual([[TMDB_URL], [TMDB_URL], [JUSTWATCH_URL]]);
  });

  it('Sign out uses the session sign-out: the gateway forgets it, the device clears, and the picker shows', async () => {
    const app = await start();
    await openTab('Account');
    await press('Sign out');
    await settle();
    expect(notHome()).toEqual(['GET /jellypass/app/v1/me', 'POST /Sessions/Logout', 'GET /Users/Public']);
    expect(storedSession()).toBeUndefined();
    expect(app.getPathname()).toBe('/');
    expect(tabs()).toHaveLength(0);
  });

  it('Change household signs out first, then asks for an address', async () => {
    const app = await start();
    await openTab('Account');
    expect(button('Change household')).toBeTruthy();
    await press('Change household');
    await settle();
    expect(notHome()).toEqual(['GET /jellypass/app/v1/me', 'POST /Sessions/Logout']);
    expect(storedSession()).toBeUndefined();
    expect(app.getPathname()).toBe('/');
    expect(shows('Connect to your household')).toBe(true);
  });
});

describe('signed out', () => {
  // Nothing kept on the device: a link straight into the tabs (or a screen pushed on one) lands on the sign-in screen's
  // first step, and nothing goes out, not even a /me.
  it.each(['/home', '/search', '/requests', '/account', '/account/pushed'])('opening %s directly lands on sign-in with no call', async (path) => {
    store.__items.clear();
    const global = jest.spyOn(globalThis, 'fetch');
    try {
      const app = await start(path);
      expect(app.getPathname()).toBe('/');
      expect(shows('Connect to your household')).toBe(true);
      expect(tabs()).toHaveLength(0);
      expect(shows('Pushed screen')).toBe(false);
      expect(gateway.calls).toHaveLength(0);
      expect(global).not.toHaveBeenCalled();
    } finally {
      global.mockRestore();
    }
  });
});

describe('a setup link while signed in', () => {
  it('to another household asks first, over the tabs, and Cancel goes back to them', async () => {
    const app = await start();
    await openTab('Search');
    await act(async () => router.push(`/connect?address=${encodeURIComponent(OTHER_ORIGIN)}`));
    await settle();
    expect(shows('Connect to this household?')).toBe(true);
    expect(tabs()).toHaveLength(0);
    await press('Cancel');
    await settle();
    expect(app.getPathname()).toBe('/home');
    expect(selectedTabs()).toEqual(['Home']);
    expect(screen.queryAllByRole('tab')).toHaveLength(4);
    expect(storedSession()).toMatchObject({ address: ORIGIN });
    expect(notHome()).toEqual(['GET /jellypass/app/v1/me']);
    expect(router.canGoBack()).toBe(false);
  });

  it('to the household already signed in to stays in the tabs', async () => {
    const app = await start();
    await act(async () => router.push(`/connect?address=${encodeURIComponent(ORIGIN)}`));
    await settle();
    expect(app.getPathname()).toBe('/home');
    expect(tabs()).toHaveLength(4);
    expect(router.canGoBack()).toBe(false);
  });
});

describe('network', () => {
  // Home's own calls are pinned against docs/app-api/fetch-budget.json by home-budget.test.tsx.
  it('makes no call but the start-up /me and Home\'s first rows, once, through every tab and the Account screen', async () => {
    const global = jest.spyOn(globalThis, 'fetch');
    try {
      await start();
      for (const name of ['Search', 'My requests', 'Account', 'Home', 'Account']) await openTab(name);
      expect(gateway.routes().sort()).toEqual(['GET /jellypass/app/v1/me', 'GET /jellypass/app/v1/discover/sources', ...HOME_AT_ONCE].sort());
      expect(global).not.toHaveBeenCalled();
    } finally {
      global.mockRestore();
    }
  });
});

type Node = NonNullable<ReturnType<typeof screen.queryAllByText>[number]>;

const flat = (node: Node) => StyleSheet.flatten(node.props.style) ?? {};

/** The ancestors of `node` up to (and with) the nearest one whose testID is in `stops`; none if it is outside them all. */
function within(node: Node, stops: readonly string[]): Node[] {
  const chain: Node[] = [];
  for (let at: Node | null = node.parent; at; at = at.parent) {
    chain.push(at);
    if (stops.includes(at.props.testID)) return chain;
  }
  return [];
}

/** The text a node holds, its own and its descendants'. */
function textOf(node: Node): string {
  return node.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}

const OURS = ['header', 'screen-column', 'home-switch', 'tabbar'] as const;

/** Every host node on screen that answers a press, hidden or not, whatever role it has (or none). */
function pressables(): Node[] {
  const found: Node[] = [];
  const visit = (node: Node) => {
    const { onPress, onClick, onResponderRelease } = node.props;
    if ([onPress, onClick, onResponderRelease].some((handler) => typeof handler === 'function')) found.push(node);
    for (const child of node.children) if (typeof child !== 'string') visit(child);
  };
  visit(screen.root as Node);
  return found;
}

/** Every text the header, the screen and the tab bar draw, and what each sits in. */
function texts() {
  return screen
    .queryAllByText(/[\s\S]/, { includeHiddenElements: true })
    .map((node) => ({ node, chain: within(node, OURS) }))
    .filter(({ chain }) => chain.length > 0);
}

describe('accessibility', () => {
  it('reads in order: the header, the screen, then the tab bar', async () => {
    await start();
    await openTab('Account');
    const order = screen
      .queryAllByRole(/^(header|button|link|tab)$/)
      .map((node) => `${node.props.accessibilityRole}:${node.props.accessibilityLabel ?? textOf(node)}`);
    expect(order).toEqual([
      'header:Account',
      'header:ACCOUNT',
      'button:Sign out',
      'button:Change household',
      'header:ABOUT & CREDITS',
      'link:The Movie Database (TMDB)',
      `link:${sentenceOf(TMDB_SOURCE)}`,
      `link:${sentenceOf(JUSTWATCH_CREDIT)}`,
      'tab:Home',
      'tab:Search',
      'tab:My requests',
      'tab:Account',
    ]);
  });

  it('names the Back button', async () => {
    await start();
    await openTab('Account');
    await act(async () => router.push('/account/pushed'));
    await settle();
    expect(screen.queryAllByRole('button').map((node) => node.props.accessibilityLabel)).toContain('Back');
  });

  // Every pressable (anything that answers a press, whatever its role), not just the buttons and tabs: each is a
  // button, link or tab with a name, and at least a thumb's height.
  // Home stays mounted under the other tabs: its 3 filter chips, the hero's 3 slides, Previous, Next and 3 dots, and the
  // first four rows' 3 cards each (the fixture page has 3 titles).
  const HOME = 3 + 3 + 2 + 3 + 4 * 3;
  it.each([
    ['Home', 'Home', 4 + HOME],
    ['Search', 'Search', 4 + HOME],
    ['My requests', 'My requests', 4 + HOME],
    ['Account', 'Account', 9 + HOME],
    // Back, and the Account screen still mounted underneath it.
    ['a pushed screen', '/account/pushed', 10 + HOME],
  ] as const)('keeps every pressable on %s named and a thumb\'s size', async (_name, to, count) => {
    await start();
    if (to.startsWith('/')) {
      await act(async () => router.push(to, { withAnchor: true }));
      await settle();
    } else {
      await openTab(to);
    }
    const found = pressables();
    expect(found).toHaveLength(count);
    for (const node of found) {
      const what = node.props.accessibilityLabel ?? textOf(node);
      const role = node.props.accessibilityRole;
      const height = flat(node).minHeight;
      expect({ what, role: ['button', 'link', 'tab', 'radio'].includes(role), named: what.length > 0, height: typeof height === 'number' && height >= layout.touchTarget }).toEqual({
        what,
        role: true,
        named: true,
        height: true,
      });
    }
  });

  it('counts the Account screen\'s links among its pressables', async () => {
    await start();
    await openTab('Account');
    const labels = pressables().map((node) => node.props.accessibilityLabel ?? textOf(node));
    expect(labels).toEqual(
      expect.arrayContaining(['Sign out', 'Change household', 'The Movie Database (TMDB)', sentenceOf(TMDB_SOURCE), sentenceOf(JUSTWATCH_CREDIT)]),
    );
  });

  it.each(['Home', 'Search', 'My requests', 'Account'])('lets every text on %s grow with the font size, wrapping, never clipped', async (name) => {
    await start();
    await openTab(name);
    const found = texts();
    expect(found.length).toBeGreaterThan(4);
    for (const { node, chain } of found) {
      const text = [node.props.children].flat().join('');
      const problems = [
        node.props.allowFontScaling === false && 'no font scaling',
        node.props.numberOfLines !== undefined && 'a line limit',
        node.props.adjustsFontSizeToFit && 'shrinks to fit',
        typeof node.props.maxFontSizeMultiplier === 'number' && node.props.maxFontSizeMultiplier > 0 && node.props.maxFontSizeMultiplier < 3 && 'a low size cap',
        ...[node, ...chain].map((at) => {
          const style = flat(at);
          if (typeof style.height === 'number' || typeof style.maxHeight === 'number') return `a fixed height on ${at.type}`;
          if (style.overflow === 'hidden') return `overflow hidden on ${at.type}`;
          return false;
        }),
      ].filter(Boolean);
      expect({ text, problems }).toEqual({ text, problems: [] });
    }
  });

  it('stops widening on iPad: the PWA\'s 72rem for a screen, 40rem for Account', async () => {
    await start();
    expect(screen.queryAllByTestId('screen-column').map((node) => flat(node).maxWidth)).toEqual([layout.maxContentWidth]);
    await openTab('Account');
    expect(screen.queryAllByTestId('screen-column').map((node) => flat(node).maxWidth)).toContain(640);
  });

  // The pairs the header, the tab bar and the Account screen draw, through the theme's contrast helper (the same one
  // contrast.test.ts uses for the PWA's pairs). Text 4.5:1, icons and outlines 3:1.
  it.each([
    ['header title', colors.text, colors.bg, 4.5],
    ['Back icon', colors.text, colors.surface, 3],
    ['tab label', colors.muted, colors.surface, 4.5],
    ['tab icon', colors.muted, colors.surface, 3],
    ['active tab label', colors.accentText, colors.accentTint, 4.5],
    ['active tab icon', colors.accentText, colors.accentTint, 3],
    ['active tab outline on the bar', colors.accent, colors.surface, 3],
    ['active tab outline on its tint', colors.accent, colors.accentTint, 3],
    ['group label', colors.muted, colors.bg, 4.5],
    ['member name and notice', colors.text, colors.surface, 4.5],
    ['credits and version', colors.muted, colors.surface, 4.5],
    ['links', colors.accentText, colors.surface, 4.5],
  ] as const)('keeps the %s readable', (_what, foreground, background, minimum) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(minimum);
  });
});
