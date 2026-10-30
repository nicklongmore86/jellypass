// The API client's promises beyond the schema: what it sends (and never sends), lenient decoding, the fixed error
// kinds for every other answer, aborts and timeouts, no retries, and no secret in an error. No network: every call
// goes to a fake fetch.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { ApiError, createApiClient, isAbortError, type ApiClient } from '../src/api';
import {
  ADDRESS,
  API,
  OPERATIONS,
  ORIGIN,
  REDIRECT_STATUSES,
  REDIRECT_TARGETS,
  TOKEN,
  answer,
  clientWith,
  fixture,
  redirectingNetwork,
  type Json,
} from './support/app-api';

async function failure(promise: Promise<unknown>): Promise<ApiError> {
  const caught = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(caught instanceof ApiError)) throw new Error(`expected an ApiError, got ${String(caught)}`);
  return caught;
}

/** `value` with an unknown field added to every object in it. */
function withUnknownFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withUnknownFields);
  if (typeof value !== 'object' || value === null) return value;
  return { ...Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, withUnknownFields(nested)])), futureField: { nested: [1, 'two'] } };
}

describe('what the client sends', () => {
  it('calls the household address only, with the token header, Accept and no cookies', async () => {
    const { api, calls } = clientWith(() => answer(200, fixture('me')));
    await api.me();
    expect(calls).toHaveLength(1);
    const [{ url, init }] = calls as [(typeof calls)[number]];
    expect(url).toBe(`${ORIGIN}/jellypass/app/v1/me`);
    expect(init.method).toBe('GET');
    expect(init.headers).toEqual({ Accept: 'application/json', Authorization: `MediaBrowser Token="${TOKEN}"` });
    expect(init.credentials).toBe('omit');
    // No `cache` option: React Native's fetch would add `?_=<time>` to the URL for `no-store`.
    expect(Object.keys(init).sort()).toEqual(['credentials', 'headers', 'method', 'redirect', 'signal']);
    expect(init.redirect).toBe('manual');
    expect(init.body).toBeUndefined();
  });

  it('sends a POST with a JSON body: {} for a movie, the seasons for a series', async () => {
    const { api, calls } = clientWith(() => answer(202, { status: 'accepted' }));
    await api.getThis('movie', 900001);
    await api.getThis('tv', 900002, [2, 1]);
    expect(calls.map(({ url, init }) => [url, init.method, init.headers['Content-Type'], init.body])).toEqual([
      [`${API}/movie/900001/get`, 'POST', 'application/json', '{}'],
      [`${API}/tv/900002/get`, 'POST', 'application/json', '{"seasons":[2,1]}'],
    ]);
  });

  it('percent-encodes the token, so it can never end the header field early', async () => {
    const { api, calls } = clientWith(() => answer(200, fixture('me')), { token: 'a"b, c' });
    await api.me();
    expect(calls[0]!.init.headers.Authorization).toBe('MediaBrowser Token="a%22b%2C%20c"');
  });

  it('makes no call without a token: unauthorized', async () => {
    const { api, calls } = clientWith(() => answer(200, fixture('me')), { token: undefined });
    expect((await failure(api.me())).kind).toBe('unauthorized');
    expect(calls).toEqual([]);
  });

  it.each<[string, (api: ApiClient) => Promise<unknown>]>([
    ['a blank search', (api) => api.search('   ')],
    ['a search over 100 characters', (api) => api.search('x'.repeat(101))],
    ['page 0', (api) => api.search('x', 0)],
    ['page 501', (api) => api.discover('trending', 501)],
    ['a fractional page', (api) => api.network(213, undefined, 1.5)],
    ['an unknown list', (api) => api.discover('everything' as 'trending')],
    ['an unknown network list', (api) => api.network(213, 'series' as 'all')],
    ['network 0', (api) => api.network(0)],
    ['studio -1', (api) => api.studio(-1)],
    ['TMDB ID 0', (api) => api.movie(0)],
    ['TMDB ID 2^31', (api) => api.tv(2147483648)],
    ['TMDB ID NaN', (api) => api.movie(Number.NaN)],
    ['season 1000', (api) => api.season(900002, 1000)],
    ['a series asked for with no seasons', (api) => api.getThis('tv', 900002, [])],
    ['season 0 asked for', (api) => api.getThis('tv', 900002, [0])],
    ['a season asked for twice', (api) => api.getThis('tv', 900002, [1, 1])],
    ['101 seasons asked for', (api) => api.getThis('tv', 900002, Array.from({ length: 101 }, (_, index) => index + 1))],
    ['a movie with seasons', (api) => api.getThis('movie', 900001, [1])],
    ['an unknown media type', (api) => api.getThis('person' as 'movie', 1)],
  ])('refuses %s without a call: invalid_request', async (_name, call) => {
    const { api, calls } = clientWith(() => answer(200, {}));
    expect((await failure(call(api))).kind).toBe('invalid_request');
    expect(calls).toEqual([]);
  });

  it('sends page only after the first, as the PWA does, and always for search', async () => {
    const { api, calls } = clientWith(() => answer(200, fixture('page')));
    await api.discover('trending');
    await api.discover('trending', 2);
    await api.studio(2, 1);
    await api.search('x');
    expect(calls.map(({ url }) => url.slice(API.length))).toEqual(['/discover/trending', '/discover/trending?page=2', '/discover/studio/2', '/search?q=x&page=1']);
  });
});

describe('decoding, lenient only where the contract says', () => {
  it.each([
    ['me', (api: ApiClient) => api.me()],
    ['page', (api: ApiClient) => api.discover('trending')],
    ['sources', (api: ApiClient) => api.sources()],
    ['movie', (api: ApiClient) => api.movie(900001)],
    ['series', (api: ApiClient) => api.tv(900002)],
    ['season', (api: ApiClient) => api.season(900002, 1)],
    ['requests', (api: ApiClient) => api.requests()],
  ])('ignores unknown fields at every level of %s', async (name, call) => {
    const { api } = clientWith(() => answer(200, withUnknownFields(fixture(name))));
    expect(await call(api)).toEqual(fixture(name));
  });

  it('treats an unknown state as unavailable, everywhere a state is', async () => {
    const page = fixture('page');
    (page.results as Json[])[1]!.state = 'archived';
    const series = fixture('series');
    series.state = 'archived';
    (series.seasons as Json[])[1]!.state = 'archived';
    const season = { ...fixture('season'), state: 'archived' };
    const { api } = clientWith((url) => answer(200, url.endsWith('/season/1') ? season : url.includes('/tv/') ? series : page));
    expect((await api.discover('trending')).results.map((card) => card.state)).toEqual(['in_library', 'unavailable', 'unavailable']);
    const decoded = await api.tv(900002);
    expect([decoded.state, ...decoded.seasons.map((entry) => entry.state)]).toEqual(['unavailable', 'unavailable', 'unavailable', 'get_this']);
    expect((await api.season(900002, 1)).state).toBe('unavailable');
  });

  it('treats an unknown request status as requested, a season\'s too', async () => {
    const requests = fixture('requests');
    const [first, second] = requests.results as [Json, Json];
    first.status = 'paused';
    (first.seasons as Json[])[0]!.status = 'paused';
    second.status = 'deleted';
    const { api } = clientWith(() => answer(200, requests));
    const decoded = await api.requests();
    expect(decoded.results.map((entry) => [entry.status, ...entry.seasons.map((season) => season.status)])).toEqual([
      ['requested', 'requested', 'failed'],
      ['requested'],
    ]);
  });

  it('drops images off the TMDB allowlist and a Play link anywhere but the household', async () => {
    const page = fixture('page');
    const [inLibrary, other, third] = page.results as [Json, Json, Json];
    inLibrary.posterUrl = 'https://evil.example.test/p.jpg';
    inLibrary.backdropUrl = 'https://image.tmdb.org/t/p/original/a.jpg';
    inLibrary.play = { itemId: '0123456789abcdef0123456789abcdef', url: 'https://films.example.net/web/#/details?id=0123456789abcdef0123456789abcdef' };
    // A Play link for a title not in the library is dropped too.
    other.play = { itemId: 'abc', url: `${ORIGIN}/web/#/details?id=abc` };
    third.posterUrl = 'https://image.tmdb.org/t/p/w300/a.jpg';
    const sources = fixture('sources');
    (sources.networks as Json[])[0]!.logoUrl = 'https://image.tmdb.org/t/p/w342/a.png';
    const { api } = clientWith((url) => answer(200, url.endsWith('/sources') ? sources : page));
    const decoded = await api.discover('trending');
    expect(decoded.results.map((card) => [card.posterUrl, card.backdropUrl, card.play])).toEqual([
      [null, null, null],
      [null, null, null],
      [null, 'https://image.tmdb.org/t/p/w780/c.webp', null],
    ]);
    expect((await api.sources()).networks.map((network) => network.logoUrl)).toEqual([null, null]);
  });

  it('reads a /me without apiVersion as revision 0 (3.1.1 and earlier)', async () => {
    const { api } = clientWith(() => answer(200, { name: 'Synthetic Member', household: 'Synthetic Household' }));
    expect(await api.me()).toEqual({ name: 'Synthetic Member', household: 'Synthetic Household', apiVersion: 0 });
  });

  const malformed: [string, string, unknown][] = [
    ['not JSON', 'page', '<html>oops</html>'],
    ['empty', 'page', ''],
    ['JSON null', 'page', 'null'],
    ['an array', 'page', '[]'],
    ['a missing field', 'page', { page: 1, nextPage: null }],
    ['a card missing its title', 'page', { page: 1, nextPage: null, results: [{ ...(fixture('page').results as Json[])[0], title: undefined }] }],
    ['a string for a number', 'page', { page: '1', nextPage: null, results: [] }],
    ['a fractional TMDB ID', 'page', { page: 1, nextPage: null, results: [{ ...(fixture('page').results as Json[])[0], tmdbId: 1.5 }] }],
    ['an unknown media type', 'page', { page: 1, nextPage: null, results: [{ ...(fixture('page').results as Json[])[0], mediaType: 'person' }] }],
    ['a number for a state', 'page', { page: 1, nextPage: null, results: [{ ...(fixture('page').results as Json[])[0], state: 3 }] }],
    ['a series for a movie', 'movie', fixture('series')],
    ['a movie for a series', 'series', fixture('movie')],
    // Each inside its JSON type but outside the schema's limits.
    ['page 501', 'page', { ...fixture('page'), page: 501 }],
    ['nextPage 502', 'page', { ...fixture('page'), nextPage: 502 }],
    ['year 10000', 'movie', { ...fixture('movie'), year: 10000 }],
    ['rating -1', 'movie', { ...fixture('movie'), rating: -1 }],
    ['runtime 0', 'movie', { ...fixture('movie'), runtime: 0 }],
    ['an empty genre', 'movie', { ...fixture('movie'), genres: [''] }],
    ['a body over the size cap', 'page', `{"page":1,"nextPage":null,"results":[],"pad":"${'x'.repeat(5 * 1024 * 1024)}"}`],
  ];
  it.each(malformed)('turns %s into unexpected', async (_name, kind, body) => {
    const { api, calls } = clientWith(() => answer(200, body));
    const call = kind === 'movie' ? api.movie(900001) : kind === 'series' ? api.tv(900002) : api.discover('trending');
    expect((await failure(call)).kind).toBe('unexpected');
    expect(calls).toHaveLength(1);
  });
});

describe('error answers', () => {
  it.each<[number, unknown, string]>([
    [401, { error: 'something_new' }, 'unauthorized'],
    [404, '<html>Not Found</html>', 'not_found'],
    [400, '', 'invalid_request'],
    [429, { error: 'too_many_login_attempts' }, 'too_many_requests'],
    [401, { error: 'unavailable' }, 'unauthorized'],
    [403, { error: 'forbidden' }, 'unavailable'],
    [500, 'Internal Server Error', 'unavailable'],
    [503, { error: 'unavailable' }, 'unavailable'],
    [504, '', 'unavailable'],
    [302, '', 'unavailable'],
    [418, { error: 'not_found' }, 'unavailable'],
  ])('maps %i with body %j by its status: %s', async (status, body, kind) => {
    const { api } = clientWith(() => answer(status, body));
    const error = await failure(api.movie(900001));
    expect([error.kind, error.status, error.householdNotFound]).toEqual([kind, status, false]);
  });

  it('says household_not_found only for a 404 that says so', async () => {
    const { api } = clientWith((url) => answer(url.endsWith('/me') ? 404 : 401, { error: 'household_not_found' }));
    expect((await failure(api.me())).householdNotFound).toBe(true);
    expect((await failure(api.requests())).householdNotFound).toBe(false);
  });

  it('carries a 429\'s Retry-After, in seconds or as a date, capped at an hour', async () => {
    const now = Date.UTC(2026, 9, 26, 12, 0, 0);
    const retryAfter = async (header: string | undefined) => {
      const { api } = clientWith(() => answer(429, { error: 'too_many_requests' }, header === undefined ? {} : { 'Retry-After': header }), { now: () => now });
      return (await failure(api.me())).retryAfterSeconds;
    };
    expect(await retryAfter(undefined)).toBeUndefined();
    expect(await retryAfter('30')).toBe(30);
    expect(await retryAfter(' 0 ')).toBe(0);
    expect(await retryAfter('999999')).toBe(3600);
    expect(await retryAfter(new Date(now + 90_500).toUTCString())).toBe(90);
    expect(await retryAfter(new Date(now - 60_000).toUTCString())).toBe(0);
    expect(await retryAfter('soon')).toBeUndefined();
    expect(await retryAfter('-5')).toBeUndefined();
    // Only a 429 carries one.
    const { api } = clientWith(() => answer(502, { error: 'unavailable' }, { 'Retry-After': '30' }));
    expect((await failure(api.me())).retryAfterSeconds).toBeUndefined();
  });

  it('never retries: one call for each failure', async () => {
    for (const respond of [() => answer(429, { error: 'too_many_requests' }), () => answer(502, { error: 'unavailable' }), () => answer(200, 'nope'), () => Promise.reject(new TypeError('Network request failed'))]) {
      const { api, calls } = clientWith(respond);
      await failure(api.me());
      await failure(api.requests());
      expect(calls).toHaveLength(2);
    }
  });

  it('reads nothing from an answer that came from somewhere other than the household', async () => {
    const redirected = answer(200, fixture('me'), {}, 'https://elsewhere.example.test/jellypass/app/v1/me');
    const { api } = clientWith(() => redirected);
    expect((await failure(api.me())).kind).toBe('unexpected');
    expect(redirected.text).not.toHaveBeenCalled();
    const { api: same } = clientWith(() => answer(200, fixture('me'), {}, `${API}/me`));
    expect(await same.me()).toEqual(fixture('me'));
  });

  it('never reads "Get this"\'s answer', async () => {
    const accepted = answer(202, 'whatever it says');
    const { api } = clientWith(() => accepted);
    await expect(api.getThis('movie', 900001)).resolves.toBeUndefined();
    expect(accepted.text).not.toHaveBeenCalled();
  });
});

describe('no answer', () => {
  it('is network when the fetch fails', async () => {
    const { api } = clientWith(() => Promise.reject(new TypeError('Network request failed')));
    const error = await failure(api.me());
    expect([error.kind, error.timedOut, error.status]).toEqual(['network', false, undefined]);
  });

  /** A fetch that never answers until its signal aborts, as React Native's does. */
  const hanging = (_url: string, init: { signal: AbortSignal }) =>
    new Promise<never>((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
    });

  it('is network, timed out, after timeoutMs', async () => {
    jest.useFakeTimers();
    try {
      const { api } = clientWith(hanging, { timeoutMs: 1000 });
      const pending = failure(api.me());
      jest.advanceTimersByTime(999);
      await Promise.resolve();
      jest.advanceTimersByTime(1);
      const error = await pending;
      expect([error.kind, error.timedOut]).toEqual(['network', true]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('times out a body that never finishes too', async () => {
    jest.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const { api } = clientWith((_url, init) => {
        signal = init.signal;
        return { ...answer(200), text: () => new Promise<string>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new Error('Aborted')))) };
      }, { timeoutMs: 1000 });
      const pending = failure(api.me());
      await Promise.resolve();
      jest.advanceTimersByTime(1000);
      expect([(await pending).kind, signal?.aborted]).toEqual(['network', true]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops at the caller\'s AbortSignal with an AbortError, not an ApiError', async () => {
    const { api, calls } = clientWith(hanging);
    const controller = new AbortController();
    const pending = api.search('x', 1, { signal: controller.signal }).catch((error: unknown) => error);
    controller.abort();
    const error = await pending;
    expect(error).not.toBeInstanceOf(ApiError);
    expect(isAbortError(error)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.signal.aborted).toBe(true);
  });

  it('makes no call for a signal already aborted', async () => {
    const { api, calls } = clientWith(() => answer(200, fixture('me')));
    const error = await api.me({ signal: AbortSignal.abort() }).catch((caught: unknown) => caught);
    expect(isAbortError(error)).toBe(true);
    expect(calls).toEqual([]);
  });

  it('lets go of the caller\'s signal and the timer once the call is done', async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      const remove = jest.spyOn(controller.signal, 'removeEventListener');
      const { api, calls } = clientWith(() => answer(200, fixture('me')));
      await api.me({ signal: controller.signal });
      expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
      expect(jest.getTimerCount()).toBe(0);
      expect(calls[0]!.init.signal.aborted).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('secrets', () => {
  it('puts no token, URL or answer text in an error', async () => {
    const answers = [
      () => answer(401, { error: 'unauthorized', detail: 'secret-detail' }),
      () => answer(200, 'secret-detail'),
      () => Promise.reject(new TypeError(`failed ${API}/me secret-detail`)),
      () => answer(429, { error: 'too_many_requests' }, { 'Retry-After': '5' }),
    ];
    for (const respond of answers) {
      const { api } = clientWith(respond);
      const error = await failure(api.search('secret-query'));
      const everything = [error.message, String(error), error.stack ?? '', JSON.stringify(error), JSON.stringify(Object.entries(error))].join('\n');
      for (const secret of [TOKEN, ORIGIN, 'media.example', 'secret-detail', 'secret-query']) expect(everything).not.toContain(secret);
    }
  });

  it('logs nothing: no console call in the client', () => {
    const dir = path.join(__dirname, '..', 'src', 'api');
    for (const file of readdirSync(dir)) expect({ file, console: /\bconsole\./.test(readFileSync(path.join(dir, file), 'utf8')) }).toEqual({ file, console: false });
  });
});

describe('redirects', () => {
  // The token is in every call's Authorization header: a redirect is never followed, to the household or anywhere
  // else, and its answer is never read.
  const cases = Object.entries(OPERATIONS).flatMap(([name, operation]) =>
    REDIRECT_STATUSES.flatMap((status) => Object.entries(REDIRECT_TARGETS).map(([where, target]) => [name, status, where, operation, target] as const)),
  );

  it.each(cases)('%s: a %i (%s) is unavailable, with no second request', async (_name, status, _where, operation, target) => {
    let redirect: ReturnType<typeof answer> | undefined;
    const network = redirectingNetwork((url) => (redirect = answer(status, fixture(operation.fixture), { Location: target(url) })));
    const api = createApiClient({ address: ADDRESS, token: () => TOKEN, fetch: network.fetch });
    const error = await failure(operation.call(api));
    expect(error.kind).toBe('unavailable');
    expect(error.status).toBe(status);
    expect(network.requests).toHaveLength(1);
    expect(network.requests[0]!.url.startsWith(`${API}/`)).toBe(true);
    expect(network.requests[0]!.init.redirect).toBe('manual');
    expect(redirect!.text).not.toHaveBeenCalled();
  });

  it('reads nothing from an answer the platform says it reached by a redirect, or from an opaque one', async () => {
    for (const response of [{ ...answer(200, fixture('me'), {}, `${API}/me`), redirected: true }, answer(0, '')]) {
      const { api } = clientWith(() => response);
      expect((await failure(api.me())).kind).toBe('unexpected');
      expect(response.text).not.toHaveBeenCalled();
    }
  });
});
