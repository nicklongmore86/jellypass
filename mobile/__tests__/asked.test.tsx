// The Requested overlay (src/title/asked.ts), the PWA's app/src/asked.ts natively: its keys, its two-minute window by
// the monotonic clock or the wall clock moving forward (never stretched by a clock set back), dropped as soon as the
// server says anything but get_this, the latest state the server reported for each key (a fresher answer wins over one
// drawn again from before), and forgotten on demand. Then its place in the session: added only after a 2xx Get this in
// the same session as when it was sent, and gone (both) on sign-out, a 401 and any other sign-in.
import { act, render } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import type { Movie, Page, Season, Series } from '../src/api/types';
import { SessionProvider, useSession, type Session } from '../src/session/SessionProvider';
import { ASKED_TTL_MS, createAsked } from '../src/title/asked';
import { fixture, ORIGIN, TOKEN, answer, fakeGateway, IDENTITY, keepSession, METRICS, settle, store } from './support/household';
import { movieAnswer, seasonAnswer, seriesAnswer } from './support/title';

function clocks() {
  const clock = { mono: 1_000, wall: Date.parse('2026-10-26T12:00:00Z') };
  const asked = createAsked(
    () => clock.mono,
    () => clock.wall,
  );
  return { clock, asked };
}

describe('the overlay', () => {
  it('shows a movie asked for as requested while the server still says get_this, and nothing else', () => {
    const { asked } = clocks();
    asked.add('movie', 7, []);
    expect(asked.state('movie:7', 'get_this')).toBe('requested');
    expect(asked.state('movie:8', 'get_this')).toBe('get_this');
    expect(asked.state('tv:7', 'get_this')).toBe('get_this');
    expect(asked.movie(movieAnswer(7) as Movie).state).toBe('requested');
  });

  it('marks a series and the seasons asked for, keyed tv:<id> and tv:<id>:<season>', () => {
    const { asked } = clocks();
    asked.add('tv', 9, [2, 3]);
    const series = asked.series(seriesAnswer(9, ['get_this', 'get_this', 'get_this']) as Series);
    expect(series.state).toBe('requested');
    expect(series.seasons.map((season) => `${season.seasonNumber}:${season.state}`)).toEqual(['0:unavailable', '1:get_this', '2:requested', '3:requested']);
    expect(asked.season(seasonAnswer(9, 2) as Season).state).toBe('requested');
    expect(asked.season(seasonAnswer(9, 1) as Season).state).toBe('get_this');
  });

  it('overlays a page of cards by their own keys', () => {
    const { asked } = clocks();
    asked.add('tv', 5, [1]);
    const page = { page: 1, nextPage: null, results: [movieAnswer(5), seriesAnswer(5, ['get_this'])] } as unknown as Page;
    expect(asked.page(page).results.map((card) => `${card.mediaType}:${card.state}`)).toEqual(['movie:get_this', 'tv:requested']);
  });

  it('ends once the monotonic clock has run two minutes', () => {
    const { clock, asked } = clocks();
    asked.add('movie', 7, []);
    clock.mono += ASKED_TTL_MS - 1;
    expect(asked.state('movie:7', 'get_this')).toBe('requested');
    clock.mono += 1;
    expect(asked.state('movie:7', 'get_this')).toBe('get_this');
    // Ended for good: the key is gone.
    clock.mono -= 10;
    expect(asked.state('movie:7', 'get_this')).toBe('get_this');
  });

  it('ends once the wall clock has moved forward two minutes, as when the monotonic clock paused in sleep', () => {
    const { clock, asked } = clocks();
    asked.add('movie', 7, []);
    clock.wall += ASKED_TTL_MS;
    expect(asked.state('movie:7', 'get_this')).toBe('get_this');
  });

  it('is never stretched by a wall clock set back', () => {
    const { clock, asked } = clocks();
    asked.add('movie', 7, []);
    clock.wall -= 10 * ASKED_TTL_MS;
    clock.mono += ASKED_TTL_MS / 2;
    expect(asked.state('movie:7', 'get_this')).toBe('requested');
    clock.mono += ASKED_TTL_MS / 2;
    expect(asked.state('movie:7', 'get_this')).toBe('get_this');
  });

  it.each(['requested', 'in_library', 'unavailable'] as const)('is dropped as soon as the server says %s', (server) => {
    const { asked } = clocks();
    asked.add('movie', 7, []);
    expect(asked.state('movie:7', server)).toBe(server);
    expect(asked.state('movie:7', 'get_this')).toBe('get_this');
  });

  it('forgets everything, and tells whoever listens of every add and forget', () => {
    const { asked } = clocks();
    const heard = jest.fn();
    const stop = asked.subscribe(heard);
    asked.add('movie', 7, []);
    asked.add('tv', 9, [1]);
    asked.forget();
    expect(asked.state('movie:7', 'get_this')).toBe('get_this');
    expect(asked.state('tv:9:1', 'get_this')).toBe('get_this');
    expect(heard).toHaveBeenCalledTimes(3);
    stop();
    asked.add('movie', 7, []);
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it('draws a card kept from an older answer in the state of a fresher one for the same key', () => {
    const { asked } = clocks();
    const row = { page: 1, nextPage: null, results: [movieAnswer(7, 'get_this'), movieAnswer(8, 'get_this')] } as unknown as Page;
    asked.seen(row);
    asked.add('movie', 7, []);
    const title = movieAnswer(7, 'requested') as Movie;
    asked.seen(title);
    // The title's page said requested: its key is dropped, and the row kept from before shows requested, not get_this.
    expect(asked.page(row).results.map((card) => `${card.tmdbId}:${card.state}`)).toEqual(['7:requested', '8:get_this']);
    expect(asked.movie(title).state).toBe('requested');
    // A card never seen takes the latest the server said.
    expect(asked.movie(movieAnswer(7, 'get_this') as Movie).state).toBe('requested');
  });

  it('never lets an older answer drawn again overwrite a fresher one', () => {
    const { asked } = clocks();
    const title = movieAnswer(7, 'in_library') as Movie;
    asked.seen(title);
    const row = { page: 1, nextPage: null, results: [movieAnswer(7, 'get_this')] } as unknown as Page;
    asked.seen(row);
    // The row is the fresher answer now: the title page kept from before shows it, and drawing it changes nothing.
    expect(asked.movie(title).state).toBe('get_this');
    expect(asked.page(row).results.map((card) => card.state)).toEqual(['get_this']);
    expect(asked.movie(title).state).toBe('get_this');
  });

  it('keeps the latest for a series\' seasons and a season page, keyed tv:<id>:<season>', () => {
    const { asked } = clocks();
    const series = seriesAnswer(9, ['get_this', 'get_this']) as Series;
    asked.seen(series);
    asked.seen(seasonAnswer(9, 2, 'requested') as Season);
    expect(asked.series(series).seasons.map((season) => `${season.seasonNumber}:${season.state}`)).toEqual(['0:unavailable', '1:get_this', '2:requested']);
  });

  it('shows Requested over a fresher get_this while the key lasts, and drops the key on a fresher anything else', () => {
    const { asked } = clocks();
    const row = { page: 1, nextPage: null, results: [movieAnswer(7, 'get_this')] } as unknown as Page;
    asked.seen(row);
    asked.add('movie', 7, []);
    asked.seen(movieAnswer(7, 'get_this') as Movie);
    expect(asked.page(row).results.map((card) => card.state)).toEqual(['requested']);
    asked.seen(movieAnswer(7, 'unavailable') as Movie);
    expect(asked.page(row).results.map((card) => card.state)).toEqual(['unavailable']);
    asked.seen(movieAnswer(7, 'get_this') as Movie);
    expect(asked.page(row).results.map((card) => card.state)).toEqual(['get_this']);
  });

  it('forgets the latest states too, and tells whoever listens of every answer seen', () => {
    const { asked } = clocks();
    const heard = jest.fn();
    asked.subscribe(heard);
    const row = { page: 1, nextPage: null, results: [movieAnswer(7, 'get_this')] } as unknown as Page;
    asked.seen(row);
    asked.seen(movieAnswer(7, 'in_library') as Movie);
    expect(asked.page(row).results.map((card) => card.state)).toEqual(['in_library']);
    asked.forget();
    expect(asked.page(row).results.map((card) => card.state)).toEqual(['get_this']);
    expect(asked.state('movie:7', 'get_this')).toBe('get_this');
    expect(heard).toHaveBeenCalledTimes(3);
  });

  it('is in memory only: nothing it holds is written to the device', () => {
    const { asked } = clocks();
    asked.add('movie', 7, []);
    expect(store.setItemAsync).not.toHaveBeenCalled();
  });
});

describe('in the session', () => {
  let session: Session | undefined;
  function Probe() {
    session = useSession();
    return null;
  }

  /** A deferred Get this: `answer` lets it through with the given status. */
  function deferred() {
    let release: (status: number) => void = () => undefined;
    const call = new Promise<ReturnType<typeof answer>>((resolve) => {
      release = (status) => resolve(answer(status, status === 202 ? { status: 'accepted' } : { error: 'unauthorized' }));
    });
    return { call, release: (status: number) => release(status) };
  }

  async function start(getThis: () => ReturnType<typeof answer> | Promise<ReturnType<typeof answer>>) {
    const gateway = fakeGateway({
      'GET /jellypass/app/v1/me': () => answer(200, fixture('me')),
      'POST /jellypass/app/v1/movie/7/get': getThis,
      'GET /Users/Public': () => answer(200, []),
      'POST /Sessions/Logout': () => answer(204),
    });
    await render(
      <SafeAreaProvider initialMetrics={METRICS}>
        <SessionProvider deps={{ fetch: gateway.fetch, identity: async () => IDENTITY }}>
          <Probe />
        </SessionProvider>
      </SafeAreaProvider>,
    );
    await settle();
    return gateway;
  }

  beforeEach(() => {
    session = undefined;
    store.__items.clear();
    keepSession(TOKEN, ORIGIN);
  });

  const requested = (asked = session!.asked) => asked.state('movie:7', 'get_this') === 'requested';

  it('adds a title once Get this is accepted, and not before', async () => {
    const pending = deferred();
    await start(() => pending.call);
    expect(session!.phase.kind).toBe('signedIn');
    let sent!: Promise<void>;
    await act(async () => {
      sent = session!.getThis('movie', 7, []);
    });
    expect(requested()).toBe(false);
    pending.release(202);
    await act(async () => sent);
    expect(requested()).toBe(true);
  });

  it('adds nothing for a Get this that was not accepted', async () => {
    await start(() => answer(429, { error: 'too_many_requests' }));
    await act(async () => {
      await session!.getThis('movie', 7, []).catch(() => undefined);
    });
    expect(requested()).toBe(false);
  });

  it('adds nothing when the member signed out while the call was out', async () => {
    const pending = deferred();
    await start(() => pending.call);
    const before = session!.asked;
    let sent!: Promise<void>;
    await act(async () => {
      sent = session!.getThis('movie', 7, []);
    });
    await act(async () => session!.signOut());
    await settle();
    pending.release(202);
    await act(async () => sent);
    expect(session!.phase.kind).toBe('signin');
    expect(requested(before)).toBe(false);
    expect(requested()).toBe(false);
  });

  /** Signs in again at the household, as the profile picker would, and waits for /me. */
  async function signInAgain(token: string) {
    const address = session!.household!;
    await act(async () => session!.completeSignIn(address, { token, userId: 'synthetic-user-0001', name: 'Ana Lima' }, session!.epoch()));
    await settle();
    expect(session!.phase.kind).toBe('signedIn');
  }

  it.each([
    ['the same token', TOKEN],
    ['another token', 'synthetic-other-token-0002'],
  ])('adds nothing, to either session, when another sign-in (with %s) replaced it while the call was out', async (_what, token) => {
    const pending = deferred();
    await start(() => pending.call);
    const before = session!.asked;
    let sent!: Promise<void>;
    await act(async () => {
      sent = session!.getThis('movie', 7, []);
    });
    await act(async () => session!.signOut());
    await settle();
    await signInAgain(token);
    const after = session!.asked;
    const version = after.version();
    pending.release(202);
    await act(async () => sent);
    expect(after === before).toBe(false);
    expect(requested(before)).toBe(false);
    expect(requested(after)).toBe(false);
    // Nothing at all was written to the new session's overlay.
    expect(after.version()).toBe(version);
  });

  it('forgets everything on sign-out', async () => {
    await start(() => answer(202, { status: 'accepted' }));
    const before = session!.asked;
    await act(async () => session!.getThis('movie', 7, []));
    expect(requested()).toBe(true);
    await act(async () => session!.signOut());
    await settle();
    expect(requested(before)).toBe(false);
    expect(requested()).toBe(false);
  });

  it.each(['sign-out', 'a 401', 'a change of household'] as const)('forgets the latest states the server reported too, on %s', async (move) => {
    await start(() => answer(202, { status: 'accepted' }));
    const before = session!.asked;
    const row = { page: 1, nextPage: null, results: [movieAnswer(7, 'get_this')] } as unknown as Page;
    await act(async () => {
      before.seen(row);
      before.seen(movieAnswer(7, 'in_library') as Movie);
      await session!.getThis('movie', 7, []);
    });
    expect(before.page(row).results.map((card) => card.state)).toEqual(['in_library']);
    await act(async () => (move === 'sign-out' ? session!.signOut() : move === 'a 401' ? session!.expire() : session!.changeHousehold()));
    await settle();
    expect(before.page(row).results.map((card) => card.state)).toEqual(['get_this']);
    expect(requested(before)).toBe(false);
    expect(session!.asked.page(row).results.map((card) => card.state)).toEqual(['get_this']);
  });

  it('forgets everything on a 401', async () => {
    await start(() => answer(202, { status: 'accepted' }));
    const before = session!.asked;
    await act(async () => session!.getThis('movie', 7, []));
    await act(async () => session!.expire());
    await settle();
    expect(session!.phase.kind).toBe('signin');
    expect(requested(before)).toBe(false);
    expect(requested()).toBe(false);
  });

  it('forgets everything on a change of household', async () => {
    await start(() => answer(202, { status: 'accepted' }));
    const before = session!.asked;
    await act(async () => session!.getThis('movie', 7, []));
    await act(async () => session!.changeHousehold());
    await settle();
    expect(session!.phase.kind).toBe('address');
    expect(requested(before)).toBe(false);
  });
});
