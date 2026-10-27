// The network and studio pages' calls against the server's pinned fetch budget (docs/app-api/fetch-budget.json, read
// from the repo, not copied): the real app through the router, signed in, with a fake gateway. Each page opened on a
// listed ID makes exactly the calls the PWA makes for it (the start-up /me counted as the PWA's own): the sources, then
// its list's first page, and nothing more while it is open. Load more asks for one page per press. A change that makes
// either chattier fails here until the budget file (and the PWA) changes with it.
import { act, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { renderRouter } from 'expo-router/testing-library';

import type { FetchLike } from '../src/api/client';
import { BUDGET } from './support/app-api';
import { budgetRoute } from './support/home';
import { ORIGIN, TOKEN, keepSession, settle, store, type Call } from './support/household';
import { wait } from './support/search';
import { sourceGateway } from './support/source';
import { buttonNamed, pressNode } from './support/title';

jest.setTimeout(30_000);

let mockFetch: FetchLike;
jest.mock('../src/api/transport', () => ({
  ...jest.requireActual('../src/api/transport'),
  householdFetch: (url: string, init: never) => mockFetch(url, init),
}));
jest.mock('expo-constants', () => ({ __esModule: true, default: { expoConfig: jest.requireActual('../app.config').default } }));
jest.mock('react-native-safe-area-context', () => jest.requireActual('react-native-safe-area-context/jest/mock').default);

let gateway: ReturnType<typeof sourceGateway>;

beforeEach(() => {
  store.__items.clear();
  keepSession(TOKEN, ORIGIN);
  gateway = sourceGateway();
  mockFetch = gateway.fetch;
});

/** A call as the budget writes it: the network's or studio's ID as `{id}`, the query string kept. */
const templated = (call: Call) =>
  budgetRoute(`${call.init.method} ${call.url.replace(/^https:\/\/[^/]+/, '')}`).replace(/\/discover\/(network|studio)\/\d+/, '/discover/$1/{id}');
const sorted = (routes: readonly string[]) => [...routes].sort();

/** Opens `path` from Home; `since()` is every call made from then on, as the budget writes it. */
async function open(path: string) {
  await renderRouter({ appDir: 'src/app', overrides: {} }, { initialUrl: '/' });
  await settle();
  const before = gateway.calls.length;
  await act(async () => router.push(path, { withAnchor: true }));
  await settle();
  return { since: () => gateway.calls.slice(before).map(templated) };
}

describe.each([
  ['network', '/home/network/213'],
  ['network-series', '/home/network/213?kind=series'],
  ['network-films', '/home/network/2552?kind=films'],
  ['studio', '/home/studio/420'],
] as const)('%s', (name, path) => {
  const budget = BUDGET.screens[name]!;

  it('is pinned in the budget file with no lazy calls', () => {
    expect({ total: budget.atOnce.length, lazy: budget.belowTheFold ?? [] }).toEqual({ total: budget.calls, lazy: [] });
  });

  it("asks for exactly the budget's calls when opened, and nothing more while it is open", async () => {
    const { since } = await open(path);
    // The member was asked for when the app started: the PWA asks again on each screen, the app once.
    expect(sorted(['GET /me', ...since()])).toEqual(sorted(budget.atOnce));
    await wait(10 * 60_000);
    expect(since()).toHaveLength(budget.calls - 1);
  });
});

it('asks for one page per Load more, and switching tabs one first page each', async () => {
  const { since } = await open('/home/network/213');
  const opened = since().length;
  await pressNode(buttonNamed('Load more'));
  expect(since().slice(opened)).toEqual(['GET /discover/network/{id}/all?page=2']);
  const tab = screen.queryAllByRole('tab', { name: 'Films' }).filter((node) => String(node.props.testID).startsWith('source-tab-'));
  await pressNode(tab[0]!);
  expect(since().slice(opened)).toEqual(['GET /discover/network/{id}/all?page=2', 'GET /discover/network/{id}/films']);
  await wait(10 * 60_000);
  expect(since()).toHaveLength(opened + 2);
});
