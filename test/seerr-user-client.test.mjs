import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  SEERR_DISCOVER_LISTS,
  SeerrClient,
  SeerrError,
  SeerrUserClient,
  isSeerrUserId,
  seerrUserId,
} from '../dist/seerr.js';
import { assertNoCanaries, seerrFixture } from './support/seerr-fixtures.mjs';

const BASE_URL = 'http://seerr.test';
const API_KEY = 'test-api-key';
const MEMBER_JELLYFIN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let calls;
let respond;
let originalFetch;

beforeEach(() => {
  calls = [];
  respond = () => Response.json({});
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const call = { url, method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.parse(init.body), redirect: init.redirect };
    calls.push(call);
    return respond(call);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Every public method of the acting-user client, called once with valid arguments. */
const USER_CALLS = {
  search: (client) => client.search('synthetic', 2),
  discover: (client) => client.discover('trending', 1),
  movie: (client) => client.movie(900001),
  tv: (client) => client.tv(900002),
  season: (client) => client.season(900002, 1),
  createRequest: (client) => client.createRequest({ mediaType: 'tv', tmdbId: 900002, seasons: [1, 2] }),
  ownRequests: (client) => client.ownRequests(20, 0),
  quota: (client) => client.quota(),
  watchlist: (client) => client.watchlist(1),
};

/** Every public method of the admin-key client, called once with valid arguments. */
const ADMIN_CALLS = {
  asUser: (client) => client.asUser(seerrUserId(2)),
  findUserByJellyfinId: (client) => client.findUserByJellyfinId(MEMBER_JELLYFIN_ID),
  getRequest: (client) => client.getRequest('5'),
  getJellyfinItemId: (client) => client.getJellyfinItemId('movie', 900001),
  importJellyfinUser: (client) => client.importJellyfinUser(MEMBER_JELLYFIN_ID),
  listRequestsSince: (client) => client.listRequestsSince(new Date('2026-01-01T00:00:00.000Z')),
  getRecentRequests: (client) => client.getRecentRequests(1),
  getPoster: (client) => client.getPoster('/synthetic-poster.jpg'),
};

function publicMethods(prototype) {
  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor' && typeof Object.getOwnPropertyDescriptor(prototype, name).value === 'function')
    .sort();
}

describe('Seerr user IDs', () => {
  it('accepts only positive safe integers', () => {
    for (const value of [1, 2, 1000, Number.MAX_SAFE_INTEGER]) {
      assert.equal(isSeerrUserId(value), true, String(value));
      assert.equal(seerrUserId(value), value);
    }
    for (const value of [0, -1, 1.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', '', ' ', null, undefined, 2n, {}, [2], true]) {
      assert.equal(isSeerrUserId(value), false, String(value));
      assert.throws(() => seerrUserId(value), TypeError, String(value));
    }
  });
});

describe('acting-user Seerr client', () => {
  const client = () => new SeerrUserClient(BASE_URL, API_KEY, seerrUserId(42));

  it('cannot be made without a valid Seerr user', () => {
    for (const user of [undefined, null, 0, -3, 1.5, Number.NaN, '', '42', ' 42', '1e1', {}, [42]]) {
      assert.throws(() => new SeerrUserClient(BASE_URL, API_KEY, user), TypeError, String(user));
      assert.throws(() => new SeerrClient(BASE_URL, API_KEY).asUser(user), TypeError, String(user));
    }
    assert.throws(() => new SeerrUserClient(BASE_URL, API_KEY), TypeError);
    assert.equal(calls.length, 0);
  });

  it('has a test for every public method', () => {
    assert.deepEqual(publicMethods(SeerrUserClient.prototype), Object.keys(USER_CALLS).sort());
    assert.deepEqual(publicMethods(SeerrClient.prototype), Object.keys(ADMIN_CALLS).sort());
  });

  for (const [name, call] of Object.entries(USER_CALLS)) {
    it(`${name} acts as the client's user, never the owner`, async () => {
      await call(client());
      assert.equal(calls.length, 1);
      const [request] = calls;
      assert.equal(request.url.origin, BASE_URL);
      assert.equal(request.headers.get('x-api-key'), API_KEY);
      assert.equal(request.headers.get('x-api-user'), '42');
      assert.equal(request.redirect, 'error');
    });
  }

  it('answers through asUser exactly as when made directly', async () => {
    const admin = new SeerrClient(BASE_URL, API_KEY);
    const acting = admin.asUser(seerrUserId(7));
    assert.ok(acting instanceof SeerrUserClient);
    assert.equal(acting.userId, 7);
    await acting.quota();
    assert.equal(calls[0].headers.get('x-api-user'), '7');
    assert.equal(calls[0].url.pathname, '/api/v1/user/7/quota');
  });

  it('calls only the allowlisted routes, with the acting user in any user path', async () => {
    const acting = client();
    for (const call of Object.values(USER_CALLS)) await call(acting);
    for (const list of SEERR_DISCOVER_LISTS) await acting.discover(list);
    assert.deepEqual(calls.map((request) => `${request.method} ${request.url.pathname}${request.url.search}`), [
      'GET /api/v1/search?query=synthetic&page=2',
      'GET /api/v1/discover/trending?page=1',
      'GET /api/v1/movie/900001',
      'GET /api/v1/tv/900002',
      'GET /api/v1/tv/900002/season/1',
      'POST /api/v1/request',
      'GET /api/v1/user/42/requests?take=20&skip=0',
      'GET /api/v1/user/42/quota',
      'GET /api/v1/discover/watchlist?page=1',
      'GET /api/v1/discover/trending?page=1',
      'GET /api/v1/discover/movies?page=1',
      'GET /api/v1/discover/movies/upcoming?page=1',
      'GET /api/v1/discover/tv?page=1',
      'GET /api/v1/discover/tv/upcoming?page=1',
    ]);
  });

  it('requests only the named title in HD, never for another user or with overrides', async () => {
    const acting = client();
    await acting.createRequest({ mediaType: 'movie', tmdbId: 900001, userId: 1, is4k: true, serverId: 9, rootFolder: '/x' });
    await acting.createRequest({ mediaType: 'tv', tmdbId: 900002, seasons: [2, 1, 2], userId: 1, is4k: true });
    assert.deepEqual(calls.map((request) => request.body), [
      { mediaType: 'movie', mediaId: 900001, is4k: false },
      { mediaType: 'tv', mediaId: 900002, seasons: [2, 1], is4k: false },
    ]);
    assert.ok(calls.every((request) => request.headers.get('content-type') === 'application/json'));
  });

  it('rejects malformed input before calling Seerr', async () => {
    const acting = client();
    const invalid = [
      () => acting.search(''),
      () => acting.search('   '),
      () => acting.search('x'.repeat(201)),
      () => acting.search('ok', 0),
      () => acting.search('ok', 501),
      () => acting.discover('../user'),
      () => acting.discover('movies/genre/1'),
      () => acting.movie(0),
      () => acting.movie('1/../../user'),
      () => acting.movie(1.5),
      () => acting.tv(-1),
      () => acting.season(1, -1),
      () => acting.season(1, '1/../../user'),
      () => acting.createRequest({ mediaType: 'person', tmdbId: 1 }),
      () => acting.createRequest({ mediaType: 'movie', tmdbId: '1' }),
      () => acting.createRequest({ mediaType: 'tv', tmdbId: 1 }),
      () => acting.createRequest({ mediaType: 'tv', tmdbId: 1, seasons: [] }),
      () => acting.createRequest({ mediaType: 'tv', tmdbId: 1, seasons: [0] }),
      () => acting.createRequest({ mediaType: 'tv', tmdbId: 1, seasons: ['1'] }),
      () => acting.ownRequests(Number.NaN),
      () => acting.watchlist(-1),
    ];
    for (const call of invalid) assert.throws(call, TypeError, String(call));
    assert.equal(calls.length, 0);
  });

  it('returns Seerr JSON unchanged for the caller to shape', async () => {
    const fixture = seerrFixture('movie');
    respond = () => Response.json(fixture);
    assert.deepEqual(await client().movie(900001), fixture);
  });

  it('reports a failed call by status and route only, never Seerr text or the IDs asked for', async () => {
    const leaky = JSON.stringify(seerrFixture('tv'));
    for (const status of [400, 403, 404, 409, 500, 503]) {
      respond = () => new Response(leaky, { status, headers: { 'Content-Type': 'application/json' } });
      const error = await client().tv(900002).catch((caught) => caught);
      assert.ok(error instanceof SeerrError);
      assert.equal(error.status, status);
      assert.equal(error.message, `Seerr GET /api/v1/tv/:id returned ${status}`);
      assertNoCanaries(`${error.message}\n${error.stack}`);
    }
    respond = () => new Response(`not json ${leaky}`, { status: 200 });
    const invalid = await client().quota().catch((caught) => caught);
    assert.ok(invalid instanceof SeerrError);
    assert.equal(invalid.message, 'Seerr GET /api/v1/user/:self/quota returned invalid JSON');
    assertNoCanaries(`${invalid.message}\n${invalid.stack}`);
  });

  it('refuses an oversized response', async () => {
    respond = () => new Response(`"${'x'.repeat(4 * 1024 * 1024)}"`, { status: 200 });
    await assert.rejects(client().search('synthetic'), (error) => error instanceof SeerrError && /too large/.test(error.message));
  });
});

describe('admin-key Seerr client', () => {
  it('never sends X-API-User, so it is never mistaken for a member', async () => {
    respond = ({ url }) => {
      if (url.pathname === '/api/v1/user/import-from-jellyfin') return Response.json([{ id: 9, jellyfinUserId: MEMBER_JELLYFIN_ID }]);
      if (url.pathname.startsWith('/api/v1/user/jellyfin/')) return Response.json({ id: 9, jellyfinUserId: MEMBER_JELLYFIN_ID.replaceAll('-', '') });
      if (url.pathname === '/api/v1/request') {
        return Response.json({ pageInfo: { results: 1 }, results: [{ id: 1, type: 'movie', createdAt: '2026-06-01T00:00:00.000Z', media: { tmdbId: 900001, jellyfinMediaId: 'item-1' } }] });
      }
      if (url.hostname === 'image.tmdb.org') return new Response(new Uint8Array([1]), { headers: { 'Content-Type': 'image/jpeg' } });
      return Response.json({ id: 1, title: 'Synthetic Movie One' });
    };
    const admin = new SeerrClient(BASE_URL, API_KEY);
    for (const call of Object.values(ADMIN_CALLS)) await call(admin);
    assert.ok(calls.length >= Object.keys(ADMIN_CALLS).length - 1);
    for (const request of calls) {
      assert.equal(request.headers.has('x-api-user'), false, `${request.method} ${request.url}`);
    }
    assert.ok(calls.filter((request) => request.url.origin === BASE_URL).every((request) => request.headers.get('x-api-key') === API_KEY));
  });
});

describe('Jellyfin user lookup', () => {
  it('finds the linked Seerr user by normalized Jellyfin ID with the admin key', async () => {
    respond = () => Response.json({ id: 12, jellyfinUserId: 'AAAAAAAABBBBCCCCDDDDEEEEEEEEEEEE', email: 'canary@example.invalid' });
    assert.deepEqual(await new SeerrClient(BASE_URL, API_KEY).findUserByJellyfinId(MEMBER_JELLYFIN_ID), {
      id: 12,
      jellyfinUserId: 'aaaaaaaabbbbccccddddeeeeeeeeeeee',
    });
    assert.equal(calls[0].url.pathname, '/api/v1/user/jellyfin/aaaaaaaabbbbccccddddeeeeeeeeeeee');
  });

  it('answers undefined for an unknown user, an ID that is not a Jellyfin ID, or a mismatched answer', async () => {
    const admin = new SeerrClient(BASE_URL, API_KEY);
    respond = () => Response.json({ status: 404, message: 'User not found.' }, { status: 404 });
    assert.equal(await admin.findUserByJellyfinId(MEMBER_JELLYFIN_ID), undefined);
    for (const id of ['', 'alice-id', '../1', `${MEMBER_JELLYFIN_ID}/requests`]) {
      assert.equal(await admin.findUserByJellyfinId(id), undefined, id);
    }
    assert.equal(calls.length, 1);
    for (const body of [
      { id: 12, jellyfinUserId: 'ffffffffffffffffffffffffffffffff' },
      { id: 12 },
      { id: '12', jellyfinUserId: MEMBER_JELLYFIN_ID },
      { id: 0, jellyfinUserId: MEMBER_JELLYFIN_ID },
      { jellyfinUserId: MEMBER_JELLYFIN_ID },
    ]) {
      respond = () => Response.json(body);
      assert.equal(await admin.findUserByJellyfinId(MEMBER_JELLYFIN_ID), undefined, JSON.stringify(body));
    }
  });

  it('throws when Seerr fails, rather than treating the user as unmapped', async () => {
    respond = () => new Response('down', { status: 503 });
    await assert.rejects(new SeerrClient(BASE_URL, API_KEY).findUserByJellyfinId(MEMBER_JELLYFIN_ID), (error) => error.status === 503);
  });
});
