// What a member hid in a session (src/hidden/store.ts), and its toast, belong to that one sign-in: through the real
// router and SessionProvider, a title hidden by one member is never left out of another's lists, after a sign-out and
// the same member signing in again, a refused sign-in (a 401) or a change of household, and a hide still out when the
// sign-in changes marks nothing for the next one. The fake server here accepts every hide but forgets it, so a title
// missing from a list after a move can only be the app's own leftover. Queries are queryAll* and assertions read
// single fields, so a failure never prints the component tree.
import { act, fireEvent, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';

import type { FetchLike } from '../src/api/client';
import { showAll } from './support/home';
import { ORIGIN, OTHER_ORIGIN, TOKEN, answer, keepSession, press, settle, store, storedSession, type, type Call } from './support/household';
import { action, cardsNamed, hideGateway, hides, toastText } from './support/hide';
import { held } from './support/source';
import { buttonNamed, pressNode } from './support/title';

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

let gateway: ReturnType<typeof hideGateway>;
/** Answers the next hide, when a test holds it back. */
let nextHide: Promise<ReturnType<typeof answer>> | undefined;
let signIns = 0;

beforeEach(() => {
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  nextHide = undefined;
  signIns = 0;
  gateway = hideGateway({
    // Accepted, never kept: the server's lists never leave the title out.
    setHidden: (_call, hidden) => nextHide ?? answer(200, { hidden }),
    override: (call: Call) => {
      if (call.route === 'GET /Users/Public') return answer(200, MEMBERS);
      if (call.route === 'POST /Sessions/Logout') return answer(204);
      if (call.route !== 'POST /Users/AuthenticateByName') return undefined;
      const name = (JSON.parse(call.init.body!) as { Username: string }).Username;
      const user = MEMBERS.find((member) => member.Name === name)!;
      signIns += 1;
      return answer(200, { AccessToken: `synthetic-token-000${signIns}`, ServerId: 'server-1', User: { Id: user.Id, Name: user.Name } });
    },
  });
  mockFetch = gateway.fetch;
});

async function start() {
  const app = await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
  await showAll();
  return app;
}

async function openTab(name: string) {
  await fireEvent.press(screen.queryAllByRole('tab', { name })[0]!);
  await settle();
}

async function signInAs(member: string) {
  await press(member);
  await settle();
  await showAll();
  expect(screen.queryAllByRole('tab', { name: 'Home' })).toHaveLength(1);
}

/** Ana hides trending 2 from Home's row: it leaves the row and the hero, and the toast says so. */
async function hideOnHome() {
  await action(cardsNamed('trending 2')[0]!, 'hide');
  expect(cardsNamed('trending 2')).toHaveLength(0);
  expect(toastText()).toBe('Hidden trending 2 from Discover');
}

async function signOut() {
  await openTab('Account');
  await press('Sign out');
  await settle();
}

describe('what a member hid in a session', () => {
  it.each([
    ['the same member signing in again', 'Ana Lima', 'u-ana'],
    ['another member of the household', 'Cara Diaz', 'u-cara'],
  ])('is forgotten on a sign-out and %s: the title is back, with no toast', async (_what, member, userId) => {
    const app = await start();
    await hideOnHome();
    await signOut();
    expect(app.getPathname()).toBe('/');
    await signInAs(member);
    expect(storedSession()?.['userId']).toBe(userId);
    await openTab('Home');
    expect(cardsNamed('trending 2')).toHaveLength(2);
    expect(toastText()).toBe('');
    await act(async () => router.push('/home/tv/1002'));
    await settle();
    expect(screen.queryAllByRole('button', { name: 'Hide Series 1002 (Series, 2023) from Discover' })).toHaveLength(1);
  });

  it('is forgotten on a 401', async () => {
    const app = await start();
    await hideOnHome();
    const refuse = gateway.fetch;
    mockFetch = async (url, init) => (url.endsWith('/movie/7') ? answer(401, { error: 'unauthorized' }) : refuse(url, init));
    await act(async () => router.push('/home/movie/7'));
    await settle();
    expect(app.getPathname()).toBe('/');
    expect(storedSession()).toBeUndefined();
    mockFetch = refuse;
    await signInAs('Ana Lima');
    await openTab('Home');
    expect(cardsNamed('trending 2')).toHaveLength(2);
    expect(toastText()).toBe('');
  });

  it('is forgotten on a change of household', async () => {
    await start();
    await hideOnHome();
    await openTab('Account');
    await press('Change household');
    await settle();
    await type('Household address', new URL(OTHER_ORIGIN).host);
    await press('Continue');
    await settle();
    await signInAs('Ana Lima');
    expect(storedSession()?.['address']).toBe(OTHER_ORIGIN);
    await openTab('Home');
    expect(cardsNamed('trending 2')).toHaveLength(2);
    expect(toastText()).toBe('');
  });

  it('marks nothing for the next sign-in when its hide answers after a sign-out', async () => {
    const out = held();
    nextHide = out.promise;
    await start();
    await action(cardsNamed('trending 2')[0]!, 'hide');
    // Still out: nothing has changed yet.
    expect(cardsNamed('trending 2')).toHaveLength(2);
    await signOut();
    nextHide = undefined;
    await signInAs('Cara Diaz');
    out.release(answer(200, { hidden: true }));
    await settle();
    await openTab('Home');
    expect(cardsNamed('trending 2')).toHaveLength(2);
    expect(toastText()).toBe('');
    expect(hides(gateway.calls)).toEqual(['POST tv:1002']);
  });

  it("never shows one member's toast to the next", async () => {
    await start();
    await hideOnHome();
    await signOut();
    await signInAs('Cara Diaz');
    expect(screen.queryAllByTestId('hide-toast')).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: /^Undo hiding / })).toHaveLength(0);
    // Cara's own hide is hers alone.
    await openTab('Home');
    await action(cardsNamed('trending 3')[0]!, 'hide');
    expect(toastText()).toBe('Hidden trending 3 from Discover');
    await pressNode(buttonNamed('Undo hiding trending 3 (Movie, 2022)'));
    expect(cardsNamed('trending 3')).toHaveLength(2);
  });
});
