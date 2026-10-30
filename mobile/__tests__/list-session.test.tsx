// The page a Home row hands its See all page (src/home/rowPages.ts) belongs to one sign-in: through the real router and
// SessionProvider, a handoff left by one member is never drawn after a sign-out, for another member of the household,
// or at another household; the list asks for its own first page instead. And a handoff is used once: the same list
// opened again asks. Every title the fake gateway answers is named after the household and sign-in it answered, so a
// grid drawn from someone else's page shows. Queries are queryAll* and assertions read single fields, so a failure
// never prints the component tree.
import { act, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';

import type { FetchLike } from '../src/api/client';
import { API, showAll } from './support/home';
import { ORIGIN, OTHER_ORIGIN, TOKEN, answer, keepSession, press, settle, signedInAnswer, store, type, type Call } from './support/household';
import { listGateway, listPage } from './support/list';
import { gridNames } from './support/source';
import { buttonNamed, linkNamed, pressNode } from './support/title';

jest.setTimeout(30_000);

let mockFetch: FetchLike;
jest.mock('../src/api/transport', () => ({
  ...jest.requireActual('../src/api/transport'),
  householdFetch: (url: string, init: never) => mockFetch(url, init),
}));
// The device's identity for a sign-in, which Jest's native modules cannot give.
jest.mock('../src/session/identity', () => ({ clientIdentity: async () => jest.requireActual('./support/household').IDENTITY }));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: jest.requireActual('../app.config').default } }));
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 2, fontScale: 1 }),
}));

const MEMBERS = [
  { Id: 'u-ana', Name: 'Ana Lima', HasPassword: false },
  { Id: 'u-cara', Name: 'Cara Diaz', HasPassword: false },
];

// Each sign-in's token and its name in titles: the kept one is Ana's first (ana1), and each sign-in gets a new one.
let signIns: Map<string, string>;

/** Whose a call was: the household (by its origin) and the sign-in (by the token it carried), as `household ana1`. */
function whose(call: Call): string {
  const household = call.url.startsWith(OTHER_ORIGIN) ? 'elsewhere' : 'household';
  const token = /Token="([^"]+)"/.exec(call.init.headers.Authorization ?? '')?.[1] ?? '';
  return `${household} ${signIns.get(token) ?? 'nobody'}`;
}

let gateway: ReturnType<typeof listGateway>;

beforeEach(() => {
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  signIns = new Map([[TOKEN, 'ana1']]);
  gateway = listGateway(
    (list, page, call) => {
      const own = listPage(list, page);
      return answer(200, { ...own, results: own.results.map((card) => ({ ...card, title: `${whose(call)} ${card.title}` })) });
    },
    {
      override: (call) => {
        if (call.route === 'GET /Users/Public') return answer(200, MEMBERS);
        if (call.route === 'POST /Sessions/Logout') return answer(204);
        if (call.route !== 'POST /Users/AuthenticateByName') return undefined;
        const name = (JSON.parse(call.init.body!) as { Username: string }).Username;
        const member = name.split(' ')[0]!.toLowerCase();
        const n = [...signIns.values()].filter((label) => label.startsWith(member)).length + 1;
        const token = `synthetic-${member}-token-000${n}`;
        signIns.set(token, `${member}${n}`);
        return signedInAnswer(name, token);
      },
    },
  );
  mockFetch = gateway.fetch;
});

/** Every call from now on, as its origin and address under the API (query kept). */
function since() {
  const before = gateway.calls.length;
  return () => gateway.calls.slice(before).map((call) => call.url.replace(API, ''));
}

async function start() {
  const app = await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
  await showAll();
  return app;
}

/**
 * Leaves Trending's page in the handoff, as its See all link does, but holds the page itself back (as a sign-out or a
 * 401 landing before it opens would): the page is put and never taken.
 */
async function leaveHandoff() {
  expect(gridNames()).toEqual([]);
  const push = jest.spyOn(router, 'push').mockImplementationOnce(() => undefined);
  try {
    await pressNode(linkNamed('See all Trending'));
    expect(push).toHaveBeenCalledWith('/home/list/trending');
  } finally {
    push.mockRestore();
  }
}

async function openTab(name: string) {
  await fireEvent.press(screen.queryAllByRole('tab', { name })[0]!);
  await settle();
}

/** Signs in as `member` from the profile picker, then waits for Home. */
async function signInAs(member: string) {
  await press(member);
  await settle();
  await showAll();
  expect(screen.queryAllByRole('tab')).toHaveLength(4);
}

/** Opens Trending's See all page by its address, as a link would. */
async function openTrending() {
  await act(async () => router.push('/home/list/trending', { withAnchor: true }));
  await settle();
}

const named = (who: string) => gridNames().filter((name) => name.startsWith(`${who} `));

describe("a Home row's handoff", () => {
  it.each([
    ['a sign-out and the same member signing in again', 'Ana Lima', 'household ana2'],
    ['a sign-out and another member of the household signing in', 'Cara Diaz', 'household cara1'],
  ])('is forgotten on %s: the list asks for its own page', async (_what, member, who) => {
    const app = await start();
    await leaveHandoff();
    await openTab('Account');
    await press('Sign out');
    await settle();
    expect(app.getPathname()).toBe('/');
    await signInAs(member);
    const calls = since();
    await openTrending();
    expect(app.getPathname()).toBe('/home/list/trending');
    expect(calls()).toEqual([`${ORIGIN}/discover/trending`]);
    expect(gridNames()).toHaveLength(20);
    expect(named(who)).toHaveLength(20);
    expect(named('household ana1')).toEqual([]);
  });

  it('is forgotten on a change of household: the other household asks for its own page and never sees the first one', async () => {
    const app = await start();
    await leaveHandoff();
    await openTab('Account');
    await press('Change household');
    await settle();
    await type('Household address', 'jelly-elsewhere.example.test');
    await press('Continue');
    await settle();
    await signInAs('Ana Lima');
    const calls = since();
    await openTrending();
    expect(app.getPathname()).toBe('/home/list/trending');
    expect(calls()).toEqual([`${OTHER_ORIGIN}/discover/trending`]);
    expect(named('elsewhere ana2')).toHaveLength(20);
    expect(gridNames().filter((name) => name.startsWith('household '))).toEqual([]);
    // Nothing went to the first household after the sign-out.
    expect(gateway.calls.filter((call) => call.url.startsWith(ORIGIN)).at(-1)!.route).toBe('POST /Sessions/Logout');
  });

  it('is used once: the same list opened again asks for its page', async () => {
    const app = await start();
    const calls = since();
    await pressNode(linkNamed('See all Trending'));
    expect(app.getPathname()).toBe('/home/list/trending');
    expect(named('household ana1')).toHaveLength(20);
    expect(calls()).toEqual([]);
    await pressNode(buttonNamed('Back'));
    expect(app.getPathname()).toMatch(/^\/(home)?$/);
    await openTrending();
    expect(app.getPathname()).toBe('/home/list/trending');
    expect(calls()).toEqual([`${ORIGIN}/discover/trending`]);
    expect(named('household ana1')).toHaveLength(20);
  });
});
