import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MAX_GUARDED_RESPONSE_BYTES } from '../dist/seerr.js';
import {
  TMDB_API_URL, TMDB_DISCOVER_LISTS, TMDB_NETWORKS, TMDB_STUDIOS, TMDB_WATCH_REGION, TmdbClient, TmdbError, isTmdbCredential, tmdbSource,
} from '../dist/tmdb.js';
import { tmdbFixture } from './support/tmdb-fixtures.mjs';

const V3_KEY = 'f00dfeedf00dfeedf00dfeedf00dfeed';
const V4_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJzeW50aGV0aWMiLCJzdWIiOiJ0ZXN0In0.c3ludGhldGljLXNpZ25hdHVyZQ';
const NOW = Date.parse('2026-10-24T23:30:00.000Z');

/** Every public method of the TMDB client, called once with valid arguments. */
const CALLS = {
  validate: (client) => client.validate(),
  search: (client) => client.search('synthetic title', 2),
  discover: (client) => client.discover('trending', 1),
  network: (client) => client.network(213, 2),
  networkFilms: (client) => client.networkFilms(213, 3),
  studio: (client) => client.studio(41077, 1),
  movie: (client) => client.movie(900001),
  tv: (client) => client.tv(900002),
  season: (client) => client.season(900002, 1),
};

let calls;
let respond;
let originalFetch;

beforeEach(() => {
  calls = [];
  respond = () => Response.json({});
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: new URL(String(input)), method: init.method ?? 'GET', headers: new Headers(init.headers), redirect: init.redirect, signal: init.signal };
    calls.push(call);
    return respond(call);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const client = (credential = V3_KEY) => new TmdbClient(credential, { now: () => NOW });

describe('TMDB client', () => {
  it('accepts only a v3 API key or a v4 read access token', () => {
    assert.equal(isTmdbCredential(V3_KEY), true);
    assert.equal(isTmdbCredential(V3_KEY.toUpperCase()), true);
    assert.equal(isTmdbCredential(V4_TOKEN), true);
    for (const value of [undefined, null, '', ' ', 'key', `${V3_KEY}0`, V3_KEY.slice(1), `${V3_KEY} `, 'a.b.c', `${V4_TOKEN}\n`, 42, {}]) {
      assert.equal(isTmdbCredential(value), false, String(value));
      assert.throws(() => new TmdbClient(value), (error) => error instanceof TypeError && error.message === 'TMDB credential is invalid');
    }
  });

  it('has a test for every public method', () => {
    const methods = Object.getOwnPropertyNames(TmdbClient.prototype).filter((name) => name !== 'constructor').sort();
    assert.deepEqual(methods, Object.keys(CALLS).sort());
  });

  it('keeps the credential off the instance', () => {
    const tmdb = client();
    assert.doesNotMatch(JSON.stringify(tmdb), /f00dfeed/);
    assert.deepEqual(Object.keys(tmdb), []);
  });

  it('calls only TMDB\'s v3 API, in English, with the v3 key as api_key, never following a redirect', async () => {
    for (const call of Object.values(CALLS)) await call(client());
    for (const list of TMDB_DISCOVER_LISTS) await client().discover(list, 3);
    assert.deepEqual(calls.map((call) => `${call.method} ${call.url.origin}${call.url.pathname}?${[...call.url.searchParams].filter(([name]) => name !== 'api_key').map(([name, value]) => `${name}=${value}`).join('&')}`), [
      `GET ${TMDB_API_URL}/3/authentication?language=en-US`,
      `GET ${TMDB_API_URL}/3/search/multi?query=synthetic title&page=2&include_adult=false&language=en-US`,
      `GET ${TMDB_API_URL}/3/trending/all/day?page=1&language=en-US`,
      // A network's series and a studio's movies, by popularity, as Seerr 3.5.1 builds them.
      `GET ${TMDB_API_URL}/3/discover/tv?page=2&sort_by=popularity.desc&include_null_first_air_dates=false&with_networks=213&language=en-US`,
      // A network's films: the movies its service streams by subscription in the US, by popularity.
      `GET ${TMDB_API_URL}/3/discover/movie?page=3&sort_by=popularity.desc&include_adult=false&watch_region=US&with_watch_providers=8|1796&with_watch_monetization_types=flatrate&language=en-US`,
      `GET ${TMDB_API_URL}/3/discover/movie?page=1&sort_by=popularity.desc&include_adult=false&with_companies=41077&language=en-US`,
      `GET ${TMDB_API_URL}/3/movie/900001?language=en-US`,
      `GET ${TMDB_API_URL}/3/tv/900002?language=en-US`,
      `GET ${TMDB_API_URL}/3/tv/900002/season/1?language=en-US`,
      `GET ${TMDB_API_URL}/3/trending/all/day?page=3&language=en-US`,
      // Home's Movies and TV filters: today's trending films, today's trending series.
      `GET ${TMDB_API_URL}/3/trending/movie/day?page=3&language=en-US`,
      `GET ${TMDB_API_URL}/3/trending/tv/day?page=3&language=en-US`,
      `GET ${TMDB_API_URL}/3/discover/movie?page=3&sort_by=popularity.desc&include_adult=false&language=en-US`,
      `GET ${TMDB_API_URL}/3/discover/tv?page=3&sort_by=popularity.desc&include_null_first_air_dates=false&language=en-US`,
      // New movie releases: opened in US theatres (release types 2 and 3) in the 60 days up to today (UTC).
      `GET ${TMDB_API_URL}/3/discover/movie?page=3&sort_by=popularity.desc&include_adult=false&region=US&with_release_type=2|3&release_date.gte=2026-08-25&release_date.lte=2026-10-24&language=en-US`,
      // Upcoming: released today (UTC) or later.
      `GET ${TMDB_API_URL}/3/discover/movie?page=3&sort_by=popularity.desc&include_adult=false&primary_release_date.gte=2026-10-24&language=en-US`,
      // Upcoming series: first airing from today (UTC) to a year and a half on, Seerr's default upper bound.
      `GET ${TMDB_API_URL}/3/discover/tv?page=3&sort_by=popularity.desc&include_null_first_air_dates=false&first_air_date.gte=2026-10-24&first_air_date.lte=2028-04-24&language=en-US`,
      // All-time great: TMDB's own top-rated lists.
      `GET ${TMDB_API_URL}/3/movie/top_rated?page=3&language=en-US`,
      `GET ${TMDB_API_URL}/3/tv/top_rated?page=3&language=en-US`,
    ]);
    for (const call of calls) {
      assert.equal(call.url.searchParams.get('api_key'), V3_KEY);
      assert.equal(call.headers.has('authorization'), false);
      assert.equal(call.redirect, 'manual');
    }
  });

  it('sends a v4 token as a bearer token, never in the URL', async () => {
    await client(V4_TOKEN).movie(900001);
    assert.equal(calls[0].headers.get('authorization'), `Bearer ${V4_TOKEN}`);
    assert.equal(calls[0].url.searchParams.has('api_key'), false);
    assert.doesNotMatch(calls[0].url.href, /eyJ/);
  });

  it('returns TMDB JSON unchanged for the caller to shape', async () => {
    const fixture = tmdbFixture('movie');
    respond = () => Response.json(fixture);
    assert.deepEqual(await client().movie(900001), fixture);
  });

  it('lists HBO Max with HBO\'s own series, by TMDB\'s OR of the two networks, and every other network alone', async () => {
    await client().network(3186, 2);
    assert.equal(calls[0].url.searchParams.get('with_networks'), '3186|49');
    assert.match(calls[0].url.search, /[?&]with_networks=3186%7C49&/);
    for (const network of TMDB_NETWORKS.filter((source) => source.id !== 3186)) await client().network(network.id);
    assert.deepEqual(calls.slice(1).map((call) => call.url.searchParams.get('with_networks')), TMDB_NETWORKS.filter((source) => source.id !== 3186).map((source) => String(source.id)));
    assert.deepEqual(TMDB_NETWORKS.filter((source) => source.networkIds).map((source) => [source.id, ...source.networkIds]), [[3186, 3186, 49]]);
    assert.ok(Object.isFrozen(tmdbSource('network', 3186).networkIds));
    assert.equal(TMDB_STUDIOS.some((source) => source.networkIds), false);
  });

  it('lists each service\'s films by its US watch providers (TMDB\'s OR), flatrate only, in the one fixed region', async () => {
    assert.equal(TMDB_WATCH_REGION, 'US');
    assert.deepEqual(TMDB_NETWORKS.map((network) => `${network.name}: ${network.movieProviderIds.join('|')}`), [
      'Netflix: 8|1796', 'Disney+: 337', 'Apple TV: 350', 'Prime Video: 9|2100', 'HBO Max: 1899', 'Hulu: 15', 'Paramount+: 2303|2616', 'Peacock: 386|387',
    ]);
    for (const network of TMDB_NETWORKS) {
      assert.ok(Object.isFrozen(network.movieProviderIds), network.name);
      await client().networkFilms(network.id, 2);
    }
    assert.deepEqual(calls.map((call) => `${call.url.pathname}?${[...call.url.searchParams].filter(([name]) => name !== 'api_key').map(([name, value]) => `${name}=${value}`).join('&')}`),
      TMDB_NETWORKS.map((network) => `/3/discover/movie?page=2&sort_by=popularity.desc&include_adult=false&watch_region=US`
        + `&with_watch_providers=${network.movieProviderIds.join('|')}&with_watch_monetization_types=flatrate&language=en-US`));
    // The pipe is sent encoded, as TMDB's OR.
    assert.match(calls[0].url.search, /[?&]with_watch_providers=8%7C1796&/);
    assert.equal(TMDB_STUDIOS.some((source) => source.movieProviderIds), false);
  });

  it('rejects malformed input before calling TMDB', () => {
    const tmdb = client();
    for (const call of [
      () => tmdb.search(''),
      () => tmdb.search('   '),
      () => tmdb.search('x'.repeat(201)),
      () => tmdb.search('ok', 0),
      () => tmdb.search('ok', 501),
      () => tmdb.discover('movies'),
      () => tmdb.discover('../account'),
      () => tmdb.discover('trending', 1.5),
      () => tmdb.movie(0),
      () => tmdb.movie('1/../../account'),
      () => tmdb.tv(-1),
      () => tmdb.season(1, -1),
      () => tmdb.season(1, '1/../../account'),
      // Only the allowlisted networks and studios, never one passed through.
      () => tmdb.network(1),
      () => tmdb.network(41077),
      // HBO is only part of HBO Max's list, never a list of its own, and never a caller's OR.
      () => tmdb.network(49),
      () => tmdb.network('3186|49'),
      // A service's films only for an allowlisted network, never a studio, a provider ID or a caller's OR.
      () => tmdb.networkFilms(1),
      () => tmdb.networkFilms(49),
      () => tmdb.networkFilms(8),
      () => tmdb.networkFilms(41077),
      () => tmdb.networkFilms('213'),
      () => tmdb.networkFilms('8|1796'),
      () => tmdb.networkFilms(213, 0),
      () => tmdb.networkFilms(213, 501),
      () => tmdb.network('213'),
      () => tmdb.network(213, 0),
      () => tmdb.studio(213),
      () => tmdb.studio(0),
      () => tmdb.studio('2'),
    ]) assert.throws(call, TypeError, String(call));
    assert.equal(calls.length, 0);
  });

  it('allowlists the eight US streamers and Seerr\'s eleven studios, each with an allowlisted TMDB logo file', () => {
    assert.deepEqual(TMDB_NETWORKS.map((network) => `${network.id} ${network.name}`), [
      '213 Netflix', '2739 Disney+', '2552 Apple TV', '1024 Prime Video', '3186 HBO Max', '453 Hulu', '4330 Paramount+', '3353 Peacock',
    ]);
    assert.deepEqual(TMDB_STUDIOS.map((studio) => `${studio.id} ${studio.name}`), [
      '2 Disney', '127928 20th Century Studios', '34 Sony Pictures', '174 Warner Bros. Pictures', '33 Universal', '4 Paramount', '3 Pixar',
      '521 DreamWorks', '420 Marvel Studios', '9993 DC', '41077 A24',
    ]);
    for (const source of [...TMDB_NETWORKS, ...TMDB_STUDIOS]) {
      assert.match(source.logoPath, /^\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp)$/, source.name);
      assert.ok(Object.isFrozen(source), source.name);
    }
    assert.ok(Object.isFrozen(TMDB_NETWORKS) && Object.isFrozen(TMDB_STUDIOS));
    assert.equal(tmdbSource('network', 213)?.name, 'Netflix');
    assert.equal(tmdbSource('studio', 213), undefined);
    assert.equal(tmdbSource('network', 2), undefined);
  });

  it('reports a failure by status and route only, never TMDB\'s text, the IDs asked for or the key', async () => {
    for (const status of [301, 302, 400, 401, 404, 429, 500, 503]) {
      respond = () => new Response(`canary ${V3_KEY}`, { status, headers: status < 400 ? { Location: 'https://elsewhere.example.invalid/' } : {} });
      const error = await client().movie(900001).catch((caught) => caught);
      assert.ok(error instanceof TmdbError);
      assert.equal(error.status, status);
      assert.equal(error.message, `TMDB GET /3/movie/:id returned ${status}`);
      assert.doesNotMatch(`${error.message}\n${error.stack}`, /canary|900001|f00dfeed/);
    }
    // fetch's own error quotes the URL, and with it the key.
    globalThis.fetch = async (input) => {
      throw new TypeError(`fetch failed for ${input}`);
    };
    const unreachable = await client().search('synthetic').catch((caught) => caught);
    assert.ok(unreachable instanceof TmdbError);
    assert.equal(unreachable.message, 'TMDB GET /3/search/multi failed');
    assert.doesNotMatch(`${unreachable.message}\n${unreachable.stack}`, /f00dfeed|synthetic/);
  });

  it('carries how long TMDB asked to wait on a 429, and nothing else', async () => {
    const answers = [
      [429, { 'Retry-After': '3' }, 3000],
      [429, { 'Retry-After': new Date(NOW + 5000).toUTCString() }, 5000],
      [429, { 'Retry-After': new Date(NOW - 5000).toUTCString() }, 0],
      [429, { 'Retry-After': 'soon' }, undefined],
      [429, {}, undefined],
      [503, { 'Retry-After': '3' }, undefined],
    ];
    for (const [status, headers, retryAfterMs] of answers) {
      respond = () => new Response('{"status_message":"canary"}', { status, headers });
      const error = await client().movie(900001).catch((caught) => caught);
      assert.ok(error instanceof TmdbError);
      assert.equal(error.status, status);
      assert.equal(error.retryAfterMs, retryAfterMs, JSON.stringify(headers));
      assert.equal(error.message, `TMDB GET /3/movie/:id returned ${status}`);
    }
  });

  it('refuses an oversized or invalid body', async () => {
    respond = () => new Response(`"${'é'.repeat(MAX_GUARDED_RESPONSE_BYTES / 2)}"`, { status: 200 });
    await assert.rejects(client().search('synthetic'), (error) => error instanceof TmdbError && error.message === 'TMDB GET /3/search/multi response is too large');
    respond = () => new Response('{"canary": ', { status: 200 });
    await assert.rejects(client().movie(1), (error) => error instanceof TmdbError && error.message === 'TMDB GET /3/movie/:id returned invalid JSON');
  });
});

describe('TMDB client, against a real redirect', () => {
  it('abandons a call when the caller\'s signal aborts, and gives every call a timeout of its own', async () => {
    // TMDB never answers: only an abort ends the call.
    respond = (call) => new Promise((_resolve, reject) => {
      call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true });
    });
    const withSignal = {
      search: (signal) => client().search('synthetic title', 2, { signal }),
      discover: (signal) => client().discover('trending', 1, { signal }),
      movie: (signal) => client().movie(900001, { signal }),
      tv: (signal) => client().tv(900002, { signal }),
      season: (signal) => client().season(900002, 1, { signal }),
    };
    for (const [name, call] of Object.entries(withSignal)) {
      const controller = new AbortController();
      const pending = call(controller.signal);
      controller.abort(new Error('caller gave up'));
      // At once, not when the client's own timeout ends the call.
      let timer;
      const late = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} still waiting`)), 1000);
      });
      await assert.rejects(Promise.race([pending, late]).finally(() => clearTimeout(timer)), (error) => error instanceof TmdbError && error.status === 502 && error.message.endsWith('failed'), name);
    }
    // Without a signal of its own, a call still has one: the client's timeout.
    respond = () => Response.json({});
    await client().movie(900001);
    assert.ok(calls.at(-1).signal instanceof AbortSignal);
    assert.equal(calls.at(-1).signal.aborted, false);
  });

  it('never follows a redirect, so the key never reaches anywhere else', async () => {
    globalThis.fetch = originalFetch;
    const reached = [];
    const target = createServer((request, response) => {
      reached.push(request.url);
      response.end('{}');
    });
    await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
    const tmdb = createServer((request, response) => {
      response.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}${request.url}` }).end();
    });
    await new Promise((resolve) => tmdb.listen(0, '127.0.0.1', resolve));
    try {
      const error = await new TmdbClient(V3_KEY, { baseUrl: `http://127.0.0.1:${tmdb.address().port}` }).movie(1).catch((caught) => caught);
      assert.ok(error instanceof TmdbError);
      assert.equal(error.status, 302);
      assert.deepEqual(reached, []);
    } finally {
      await Promise.all([target, tmdb].map((server) => new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      })));
    }
  });
});
