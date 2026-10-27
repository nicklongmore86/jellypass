// The titles My requests has named (src/requests/titleCache.ts), the PWA's app/src/titles.ts natively: keyed by kind
// and TMDB ID, kept ten minutes on the monotonic and the wall clock (a clock set back ends it), the 300 used last, only
// the name, year and poster. Then its place in the session: one per sign-in, forgotten on sign-out, a 401, a change of
// household and when the provider goes. The screen's use of it is in requests.test.tsx.
import { act, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { createTitleCache, TITLE_CACHE_SIZE, TITLE_CACHE_TTL_MS } from '../src/requests/titleCache';
import { SessionProvider, useSession, type Session } from '../src/session/SessionProvider';
import { fixture, ORIGIN, TOKEN, answer, fakeGateway, IDENTITY, keepSession, METRICS, settle, store } from './support/household';

const details = (title: string) => ({ title, year: 2020, posterUrl: null });

describe('the cache', () => {
  it('keeps a title ten minutes on both clocks, and ends it if the wall clock goes back', () => {
    const clock = { mono: 1_000, wall: Date.parse('2026-10-27T12:00:00Z') };
    const cache = createTitleCache(
      () => clock.mono,
      () => clock.wall,
    );
    expect(TITLE_CACHE_TTL_MS).toBe(600_000);
    cache.set('movie', 5, details('A'));
    expect(cache.get('movie', 5)?.title).toBe('A');
    expect(cache.get('tv', 5)).toBeUndefined();
    clock.mono += 599_999;
    expect(cache.get('movie', 5)?.title).toBe('A');
    clock.mono += 1;
    expect(cache.get('movie', 5)).toBeUndefined();
    cache.set('movie', 5, details('A'));
    clock.wall += 600_000;
    expect(cache.get('movie', 5)).toBeUndefined();
    cache.set('movie', 5, details('A'));
    clock.wall -= 1;
    expect(cache.get('movie', 5)).toBeUndefined();
  });

  it('keeps the 300 used last, and only the name, year and poster', () => {
    const cache = createTitleCache(
      () => 0,
      () => 0,
    );
    expect(TITLE_CACHE_SIZE).toBe(300);
    for (let id = 1; id <= 300; id += 1) cache.set('movie', id, details(`T${id}`));
    expect(cache.get('movie', 1)?.title).toBe('T1');
    cache.set('movie', 301, details('T301'));
    expect(cache.get('movie', 2)).toBeUndefined();
    expect(cache.get('movie', 1)?.title).toBe('T1');
    expect(cache.get('movie', 301)?.title).toBe('T301');
    cache.set('tv', 9, { ...details('S'), state: 'requested', overview: 'x' } as never);
    expect(Object.keys(cache.get('tv', 9)!).sort().join(',')).toBe('posterUrl,title,year');
    cache.forget();
    expect(cache.get('movie', 1)).toBeUndefined();
  });
});

describe('in the session', () => {
  let session: Session | undefined;
  function Probe() {
    session = useSession();
    return null;
  }

  async function start() {
    const gateway = fakeGateway({
      'GET /jellypass/app/v1/me': () => answer(200, fixture('me')),
      'GET /Users/Public': () => answer(200, []),
      'POST /Sessions/Logout': () => answer(204),
    });
    const view = await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <SessionProvider deps={{ fetch: gateway.fetch, identity: async () => IDENTITY }}>
          <Probe />
        </SessionProvider>
      </SafeAreaProvider>,
    );
    await settle();
    return view;
  }

  beforeEach(() => {
    session = undefined;
    store.__items.clear();
    keepSession(TOKEN, ORIGIN);
  });

  it.each(['sign-out', 'a 401', 'a change of household'] as const)('forgets every title on %s', async (move) => {
    await start();
    const before = session!.titles;
    before.set('movie', 7, details('Kept'));
    expect(before.get('movie', 7)?.title).toBe('Kept');
    await act(async () => (move === 'sign-out' ? session!.signOut() : move === 'a 401' ? session!.expire() : session!.changeHousehold()));
    await settle();
    expect(before.get('movie', 7)).toBeUndefined();
    expect(session!.titles.get('movie', 7)).toBeUndefined();
  });

  it.each([
    ['the same token', TOKEN],
    ['another token', 'synthetic-other-token-0002'],
  ])('starts empty for another sign-in (with %s)', async (_what, token) => {
    await start();
    const before = session!.titles;
    before.set('movie', 7, details('Kept'));
    await act(async () => session!.signOut());
    await settle();
    await act(async () => session!.completeSignIn(session!.household!, { token, userId: 'synthetic-user-0001', name: 'Ana Lima' }, session!.epoch()));
    await settle();
    expect(session!.phase.kind).toBe('signedIn');
    expect(session!.titles === before).toBe(false);
    expect(session!.titles.get('movie', 7)).toBeUndefined();
  });

  it('forgets every title when the provider goes', async () => {
    const view = await start();
    const before = session!.titles;
    before.set('movie', 7, details('Kept'));
    await act(async () => view.unmount());
    expect(before.get('movie', 7)).toBeUndefined();
  });
});
