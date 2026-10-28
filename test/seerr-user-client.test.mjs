import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  MAX_GUARDED_RESPONSE_BYTES,
  SeerrClient,
  SeerrError,
  SeerrMemberClient,
  SeerrUnmappedUserError,
  isSeerrUserId,
  seerrUserId,
} from '../dist/seerr.js';
import { assertNoCanaries, seerrFixture } from './support/seerr-fixtures.mjs';

const BASE_URL = 'http://seerr.test';
const API_KEY = 'test-api-key';
const MEMBER_JELLYFIN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const MEMBER = 42;

/** Seerr's admin view of the member, as GET /api/v1/user/:id answers it. */
function seerrUserRecord(pathname) {
  if (pathname === `/api/v1/user/${MEMBER}`) return { id: MEMBER, permissions: 32, jellyfinUserId: MEMBER_JELLYFIN_ID.replaceAll('-', '') };
  return undefined;
}

/** A resolver that always proposes `user`; the client must still confirm it. */
const proposing = (user) => ({ candidate: async () => seerrUserId(user), forget() {}, version: () => 0 });

let calls;
let respond;
let respondsToAdmin;
let originalFetch;

beforeEach(() => {
  calls = [];
  respond = () => Response.json({});
  respondsToAdmin = false;
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const call = { url, method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.parse(init.body), redirect: init.redirect };
    calls.push(call);
    // Admin calls (no X-API-User) to a user record answer the confirmations, unless a test answers them itself.
    const record = !headers.has('x-api-user') && call.method === 'GET' ? seerrUserRecord(url.pathname) : undefined;
    if (record && !respondsToAdmin) return Response.json(record);
    return respond(call);
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Every public method of the member client, called once with valid arguments. */
const MEMBER_CALLS = {
  confirmRequester: async (client) => (await client.confirmRequester()).createRequest({ mediaType: 'movie', tmdbId: 900001 }),
  createRequest: (client) => client.createRequest({ mediaType: 'tv', tmdbId: 900002, seasons: [1, 2] }),
  ownRequests: (client) => client.ownRequests(20, 0),
  quota: (client) => client.quota(),
  ownUser: (client) => client.ownUser(),
  watchlist: (client) => client.watchlist(1),
  cancelRequest: (client) => client.cancelRequest('7300041'),
};

const memberClient = (baseUrl = BASE_URL, user = MEMBER) =>
  new SeerrMemberClient(new SeerrClient(baseUrl, API_KEY), MEMBER_JELLYFIN_ID, proposing(user));
/** The calls that acted as someone. */
const actingCalls = () => calls.filter((request) => request.headers.has('x-api-user'));

/** Every public method of the admin-key client, called once with valid arguments. */
const ADMIN_CALLS = {
  blocklist: (client) => client.blocklist(100, 0),
  findUserByJellyfinId: (client) => client.findUserByJellyfinId(MEMBER_JELLYFIN_ID),
  jellyfinUserIdOf: (client) => client.jellyfinUserIdOf(seerrUserId(9)),
  getRequest: (client) => client.getRequest('5'),
  titleRequests: (client) => client.titleRequests('movie', 900001),
  requestState: (client) => client.requestState('5'),
  approveRequest: (client) => client.approveRequest('5'),
  declineRequest: (client) => client.declineRequest('5'),
  deleteRequest: (client) => client.deleteRequest('5'),
  removeMovieFromRadarr: (client) => client.removeMovieFromRadarr(7),
  radarrConfigured: (client) => client.radarrConfigured(),
  getJellyfinItemId: (client) => client.getJellyfinItemId('movie', 900001),
  importJellyfinUser: (client) => client.importJellyfinUser(MEMBER_JELLYFIN_ID),
  listRequestsSince: (client) => client.listRequestsSince(new Date('2026-01-01T00:00:00.000Z')),
  getRecentRequests: (client) => client.getRecentRequests(1),
  getPoster: (client) => client.getPoster('/synthetic-poster.jpg'),
  // Last: it stops the title worker, and calls nothing.
  close: (client) => client.close(),
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

describe('acting-user Seerr clients', () => {
  it('cannot be made without a valid Jellyfin user or admin client', () => {
    const admin = new SeerrClient(BASE_URL, API_KEY);
    for (const id of [undefined, null, '', 'alice-id', '42', '../user', 42]) {
      assert.throws(() => new SeerrMemberClient(admin, id), TypeError, String(id));
    }
    for (const fake of [undefined, {}, { findUserByJellyfinId: async () => ({ id: 42 }), jellyfinUserIdOf: async () => MEMBER_JELLYFIN_ID }]) {
      assert.throws(() => new SeerrMemberClient(fake, MEMBER_JELLYFIN_ID), TypeError);
    }
    assert.equal(calls.length, 0);
  });

  it('has a test for every public method', () => {
    assert.deepEqual(publicMethods(SeerrMemberClient.prototype), Object.keys(MEMBER_CALLS).sort());
    assert.deepEqual(publicMethods(SeerrClient.prototype), Object.keys(ADMIN_CALLS).sort());
  });

  for (const [name, call] of Object.entries(MEMBER_CALLS)) {
    it(`member ${name} confirms the member's Seerr user, then acts as it, never the owner`, async () => {
      await call(memberClient());
      assert.equal(calls.length, 2);
      const [check, request] = calls;
      assert.equal(check.url.pathname, `/api/v1/user/${MEMBER}`);
      assert.equal(check.headers.has('x-api-user'), false);
      assert.equal(request.url.origin, BASE_URL);
      assert.equal(request.headers.get('x-api-key'), API_KEY);
      assert.equal(request.headers.get('x-api-user'), String(MEMBER));
      assert.equal(request.redirect, 'manual');
    });
  }

  it('calls only the allowlisted routes, with the acting user in any user path', async () => {
    const member = memberClient();
    for (const call of Object.values(MEMBER_CALLS)) await call(member);
    assert.deepEqual(actingCalls().map((request) => `${request.headers.get('x-api-user')} ${request.method} ${request.url.pathname}${request.url.search}`), [
      '42 POST /api/v1/request',
      '42 POST /api/v1/request',
      '42 GET /api/v1/user/42/requests?take=20&skip=0',
      '42 GET /api/v1/user/42/quota',
      '42 GET /api/v1/auth/me',
      '42 GET /api/v1/discover/watchlist?page=1',
      '42 DELETE /api/v1/request/7300041',
    ]);
    // The member is confirmed before every call.
    assert.equal(calls.filter((request) => request.url.pathname === `/api/v1/user/${MEMBER}`).length, 7);
  });

  it('confirms the requester first, then sends one request later without confirming again, unless its mapping was invalidated', async () => {
    let version = 0;
    const resolver = { ...proposing(MEMBER), version: () => version };
    const member = new SeerrMemberClient(new SeerrClient(BASE_URL, API_KEY), MEMBER_JELLYFIN_ID, resolver);
    const requester = await member.confirmRequester();
    assert.deepEqual(calls.map((request) => request.url.pathname), [`/api/v1/user/${MEMBER}`]);
    await requester.createRequest({ mediaType: 'tv', tmdbId: 900002, seasons: [2, 1, 2], userId: 1, is4k: true });
    assert.deepEqual(actingCalls().map((request) => [request.headers.get('x-api-user'), request.body]), [[String(MEMBER), { mediaType: 'tv', mediaId: 900002, seasons: [2, 1], is4k: false }]]);
    assert.equal(calls.length, 2);
    // Invalid input, and a mapping invalidated since the confirmation, send nothing.
    await assert.rejects(requester.createRequest({ mediaType: 'tv', tmdbId: 1, seasons: [] }), TypeError);
    version += 1;
    await assert.rejects(requester.createRequest({ mediaType: 'movie', tmdbId: 900001 }), SeerrUnmappedUserError);
    assert.equal(calls.length, 2);
  });

  it('requests only the named title in HD, never for another user or with overrides', async () => {
    const member = memberClient();
    await member.createRequest({ mediaType: 'movie', tmdbId: 900001, userId: 1, is4k: true, serverId: 9, rootFolder: '/x' });
    await member.createRequest({ mediaType: 'tv', tmdbId: 900002, seasons: [2, 1, 2], userId: 1, is4k: true });
    assert.deepEqual(actingCalls().map((request) => request.body), [
      { mediaType: 'movie', mediaId: 900001, is4k: false },
      { mediaType: 'tv', mediaId: 900002, seasons: [2, 1], is4k: false },
    ]);
    assert.ok(actingCalls().every((request) => request.headers.get('content-type') === 'application/json'));
  });

  it('rejects malformed input before calling Seerr', async () => {
    const admin = new SeerrClient(BASE_URL, API_KEY);
    const member = memberClient();
    const invalid = [
      () => admin.blocklist(0, 0),
      () => admin.blocklist(101, 0),
      () => admin.blocklist(100, -1),
      () => admin.blocklist('100&filter=manual', 0),
      () => admin.blocklist(100, 1.5),
      () => member.createRequest({ mediaType: 'person', tmdbId: 1 }),
      () => member.createRequest({ mediaType: 'movie', tmdbId: '1' }),
      () => member.createRequest({ mediaType: 'tv', tmdbId: 1 }),
      () => member.createRequest({ mediaType: 'tv', tmdbId: 1, seasons: [] }),
      () => member.createRequest({ mediaType: 'tv', tmdbId: 1, seasons: [0] }),
      () => member.createRequest({ mediaType: 'tv', tmdbId: 1, seasons: ['1'] }),
      () => member.ownRequests(Number.NaN),
      () => member.watchlist(-1),
      () => member.cancelRequest('0'),
      () => admin.approveRequest('5/../settings'),
      () => admin.declineRequest('0'),
      () => admin.deleteRequest(5),
      () => admin.removeMovieFromRadarr(0),
      () => admin.removeMovieFromRadarr('7'),
      () => member.cancelRequest('5/../user'),
      () => member.cancelRequest(5),
      () => admin.titleRequests('person', 1),
      () => admin.titleRequests('movie', 0),
      () => admin.titleRequests('tv', '1'),
      () => admin.requestState('0'),
      () => admin.requestState('5/../user'),
      () => admin.requestState(5),
    ];
    for (const call of invalid) assert.throws(call, TypeError, String(call));
    assert.equal(calls.length, 0);
  });

  it('deletes a request as the member, sending no body and reading Seerr\'s empty 204 as done', async () => {
    respond = () => new Response(null, { status: 204 });
    assert.equal(await memberClient().cancelRequest('7300041'), undefined);
    const [request] = actingCalls();
    assert.deepEqual([request.method, request.url.pathname, request.body, request.headers.get('x-api-user')], ['DELETE', '/api/v1/request/7300041', undefined, String(MEMBER)]);
    // Seerr refuses anything but the member's own pending request (or a manager's): by status and route only.
    respond = () => new Response('canary refused', { status: 401 });
    const refused = await memberClient().cancelRequest('7300042').catch((error) => error);
    assert.ok(refused instanceof SeerrError);
    assert.equal(refused.message, 'Seerr DELETE /api/v1/request/:id returned 401');
  });

  it('returns Seerr JSON unchanged for the caller to shape', async () => {
    const fixture = seerrFixture('requests');
    respond = () => Response.json(fixture);
    assert.deepEqual(await memberClient().ownRequests(), fixture);
  });

  it('reports a failed call by status and route only, never Seerr text or the IDs asked for', async () => {
    const leaky = JSON.stringify(seerrFixture('tv'));
    for (const status of [400, 403, 404, 409, 500, 503]) {
      respond = () => new Response(leaky, { status, headers: { 'Content-Type': 'application/json' } });
      const error = await memberClient().ownRequests(20, 900002).catch((caught) => caught);
      assert.ok(error instanceof SeerrError);
      assert.equal(error.status, status);
      assert.equal(error.message, `Seerr GET /api/v1/user/:self/requests returned ${status}`);
      assertNoCanaries(`${error.message}\n${error.stack}`);
    }
    respond = () => new Response(`not json ${leaky}`, { status: 200 });
    const invalid = await memberClient().quota().catch((caught) => caught);
    assert.ok(invalid instanceof SeerrError);
    assert.equal(invalid.message, 'Seerr GET /api/v1/user/:self/quota returned invalid JSON');
    assertNoCanaries(`${invalid.message}\n${invalid.stack}`);
  });

  it('refuses an oversized response', async () => {
    respond = () => new Response(`"${'x'.repeat(4 * 1024 * 1024)}"`, { status: 200 });
    await assert.rejects(memberClient().ownUser(), (error) => error instanceof SeerrError && /too large/.test(error.message));
  });

  it('counts the size limit in bytes, not characters', async () => {
    assert.equal(MAX_GUARDED_RESPONSE_BYTES, 4 * 1024 * 1024);
    // Two bytes per character: fewer characters than the limit, more bytes.
    const over = 'é'.repeat(MAX_GUARDED_RESPONSE_BYTES / 2);
    respond = () => new Response(`"${over}"`, { status: 200 });
    await assert.rejects(memberClient().ownUser(), (error) => error instanceof SeerrError && /too large/.test(error.message));
    const under = 'é'.repeat(MAX_GUARDED_RESPONSE_BYTES / 2 - 1);
    respond = () => new Response(`"${under}"`, { status: 200 });
    assert.equal(await memberClient().ownUser(), under);
  });

  it('stops reading an oversized body as soon as it passes the limit', async () => {
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let pulled = 0;
    let cancelled = false;
    respond = () => new Response(new ReadableStream({
      // Four times the limit, then the end: a client that reads it all is slow and wrong, but does not hang.
      pull(controller) {
        if (pulled >= 4 * MAX_GUARDED_RESPONSE_BYTES) return controller.close();
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    }), { status: 200 });
    await assert.rejects(memberClient().quota(), (error) => error instanceof SeerrError && /too large/.test(error.message));
    assert.equal(cancelled, true);
    assert.ok(pulled <= MAX_GUARDED_RESPONSE_BYTES + 4 * chunk.byteLength, String(pulled));
  });

  it('refuses a body whose declared length is over the limit without reading it', async () => {
    let pulled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulled = true;
        controller.enqueue(new TextEncoder().encode('{}'));
        controller.close();
      },
    }, { highWaterMark: 0 });
    respond = () => new Response(body, {
      status: 200,
      headers: { 'Content-Length': String(MAX_GUARDED_RESPONSE_BYTES + 1) },
    });
    await assert.rejects(memberClient().quota(), (error) => error instanceof SeerrError && /too large/.test(error.message));
    assert.equal(pulled, false);
  });

  it('reports a body that is not UTF-8 as invalid JSON', async () => {
    respond = () => new Response(new Uint8Array([0x22, 0xff, 0x22]), { status: 200 });
    await assert.rejects(memberClient().quota(), (error) => error instanceof SeerrError && /invalid JSON/.test(error.message));
  });
});

describe('member client', () => {
  it('fails closed without calling as anyone when the proposed Seerr user is not linked to the member', async () => {
    // Seerr user 7 exists but belongs to someone else.
    respond = ({ url }) => url.pathname === '/api/v1/user/7' ? Response.json({ id: 7, permissions: 0, jellyfinUserId: 'f'.repeat(32) }) : Response.json({});
    const forgotten = [];
    const resolver = { ...proposing(7), forget: (id, user) => forgotten.push([id, user]) };
    const member = new SeerrMemberClient(new SeerrClient(BASE_URL, API_KEY), MEMBER_JELLYFIN_ID, resolver);
    for (const call of Object.values(MEMBER_CALLS)) {
      await assert.rejects(call(member), SeerrUnmappedUserError);
    }
    assert.equal(actingCalls().length, 0);
    // Each call confirmed twice, forgetting the candidate both times.
    assert.equal(calls.length, 2 * Object.keys(MEMBER_CALLS).length);
    assert.equal(forgotten.length, 2 * Object.keys(MEMBER_CALLS).length);
  });

  it('fails closed for a member Seerr has no user for', async () => {
    respond = () => Response.json({ message: 'User not found.' }, { status: 404 });
    const member = new SeerrMemberClient(new SeerrClient(BASE_URL, API_KEY), MEMBER_JELLYFIN_ID);
    await assert.rejects(member.quota(), SeerrUnmappedUserError);
    assert.deepEqual(calls.map((request) => request.url.pathname), ['/api/v1/user/jellyfin/aaaaaaaabbbbccccddddeeeeeeeeeeee']);
  });

  it('looks the member up again for every call without a resolver', async () => {
    respond = ({ url }) => url.pathname.startsWith('/api/v1/user/jellyfin/')
      ? Response.json({ id: MEMBER, jellyfinUserId: MEMBER_JELLYFIN_ID })
      : Response.json({});
    const member = new SeerrMemberClient(new SeerrClient(BASE_URL, API_KEY), MEMBER_JELLYFIN_ID.toUpperCase());
    assert.equal(member.jellyfinUserId, 'aaaaaaaabbbbccccddddeeeeeeeeeeee');
    await member.quota();
    await member.quota();
    assert.deepEqual(calls.map((request) => `${request.headers.get('x-api-user')} ${request.url.pathname}`), [
      'null /api/v1/user/jellyfin/aaaaaaaabbbbccccddddeeeeeeeeeeee',
      'null /api/v1/user/42',
      '42 /api/v1/user/42/quota',
      'null /api/v1/user/jellyfin/aaaaaaaabbbbccccddddeeeeeeeeeeee',
      'null /api/v1/user/42',
      '42 /api/v1/user/42/quota',
    ]);
  });
});

/**
 * Two real local servers: Seerr, which redirects everything but the member's record (so the acting-user calls get past
 * their confirmations), and the redirect's target, which records what reaches it.
 */
async function redirectingSeerr() {
  const reached = [];
  const target = createServer((request, response) => {
    reached.push({ url: request.url, headers: request.headers });
    response.writeHead(503, { 'Content-Type': 'text/plain' }).end('canary private upstream error');
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const seerr = createServer((request, response) => {
    const record = request.headers['x-api-user'] === undefined ? seerrUserRecord(request.url) : undefined;
    if (record) return response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(record));
    response.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/redirected` }).end('canary redirect body');
  });
  await new Promise((resolve) => seerr.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${seerr.address().port}`,
    reached,
    close: () => Promise.all([seerr, target].map((server) => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    }))),
  };
}

describe('Seerr calls made for the household app, against a real redirect', () => {
  let servers;

  beforeEach(async () => {
    globalThis.fetch = originalFetch;
    servers = await redirectingSeerr();
  });

  afterEach(() => servers.close());

  const GUARDED_CALLS = {
    findUserByJellyfinId: ({ baseUrl }) => new SeerrClient(baseUrl, API_KEY).findUserByJellyfinId(MEMBER_JELLYFIN_ID),
    jellyfinUserIdOf: ({ baseUrl }) => new SeerrClient(baseUrl, API_KEY).jellyfinUserIdOf(seerrUserId(9)),
    blocklist: ({ baseUrl }) => new SeerrClient(baseUrl, API_KEY).blocklist(100, 0),
    titleRequests: ({ baseUrl }) => new SeerrClient(baseUrl, API_KEY).titleRequests('tv', 900002),
    requestState: ({ baseUrl }) => new SeerrClient(baseUrl, API_KEY).requestState('7300041'),
    ...Object.fromEntries(Object.entries(MEMBER_CALLS).map(([name, call]) => [
      `SeerrMemberClient.${name}`,
      ({ baseUrl }) => call(memberClient(baseUrl)),
    ])),
  };

  for (const [name, call] of Object.entries(GUARDED_CALLS)) {
    it(`${name} never follows a redirect or reports its body`, async () => {
      const error = await call(servers).catch((caught) => caught);
      assert.ok(error instanceof SeerrError, String(error));
      assert.equal(error.status, 302);
      assert.match(error.message, /^Seerr (GET|POST|DELETE) \/api\/v1\/[a-z/:]+ returned 302$/i);
      // The message is the route template only (checked above), so it holds no IDs; nor may anything else in the error.
      assert.doesNotMatch(`${error.message}\n${error.stack}`, /canary|redirected|aaaaaaaa/);
      assert.deepEqual(servers.reached, []);
    });
  }
});

describe('Seerr calls made for the household app, on failure', () => {
  for (const status of [400, 401, 403, 500, 503]) {
    it(`report ${status} by status and route only`, async () => {
      respond = () => new Response('canary private upstream error', { status });
      const admin = new SeerrClient(BASE_URL, API_KEY);
      for (const [call, route] of [
        [() => admin.findUserByJellyfinId(MEMBER_JELLYFIN_ID), '/api/v1/user/jellyfin/:jellyfinUserId'],
        [() => admin.jellyfinUserIdOf(seerrUserId(9)), '/api/v1/user/:id'],
        [() => admin.blocklist(100, 0), '/api/v1/blocklist'],
        [() => admin.titleRequests('movie', 900001), '/api/v1/movie/:id'],
        [() => admin.requestState('7300041'), '/api/v1/request/:id'],
      ]) {
        const error = await call().catch((caught) => caught);
        assert.ok(error instanceof SeerrError);
        assert.equal(error.status, status);
        assert.equal(error.message, `Seerr GET ${route} returned ${status}`);
      }
      assert.ok(calls.every((request) => request.redirect === 'manual'));
    });
  }

  it('leave the existing admin calls as they were', async () => {
    respond = () => new Response('upstream detail', { status: 503 });
    const error = await new SeerrClient(BASE_URL, API_KEY).getRequest('5').catch((caught) => caught);
    assert.equal(error.message, 'Seerr GET /api/v1/request/5 returned 503: upstream detail');
    assert.equal(calls[0].redirect, undefined);
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
      if (url.pathname === '/api/v1/request/5') return Response.json({ id: 5, status: 1 });
      return Response.json({ id: 1, title: 'Synthetic Movie One' });
    };
    const admin = new SeerrClient(BASE_URL, API_KEY);
    for (const call of Object.values(ADMIN_CALLS)) await call(admin);
    assert.ok(calls.length >= Object.keys(ADMIN_CALLS).length - 2);
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

describe('Seerr user link check', () => {
  it('answers the normalized Jellyfin ID Seerr links to a Seerr user, whatever its format', async () => {
    const admin = new SeerrClient(BASE_URL, API_KEY);
    for (const linked of [MEMBER_JELLYFIN_ID, MEMBER_JELLYFIN_ID.toUpperCase(), MEMBER_JELLYFIN_ID.replaceAll('-', '').toUpperCase()]) {
      respond = () => Response.json({ id: 9, jellyfinUserId: linked, email: 'canary@example.invalid' });
      assert.equal(await admin.jellyfinUserIdOf(seerrUserId(9)), 'aaaaaaaabbbbccccddddeeeeeeeeeeee', linked);
    }
    assert.ok(calls.every((request) => request.url.pathname === '/api/v1/user/9' && !request.headers.has('x-api-user')));
  });

  it('answers undefined for a deleted, unlinked or mismatched Seerr user', async () => {
    const admin = new SeerrClient(BASE_URL, API_KEY);
    respond = () => Response.json({ message: 'User not found.' }, { status: 404 });
    assert.equal(await admin.jellyfinUserIdOf(seerrUserId(9)), undefined);
    for (const body of [{ id: 9 }, { id: 9, jellyfinUserId: null }, { id: 9, jellyfinUserId: 'x' }, { id: 10, jellyfinUserId: MEMBER_JELLYFIN_ID }, null]) {
      respond = () => Response.json(body);
      assert.equal(await admin.jellyfinUserIdOf(seerrUserId(9)), undefined, JSON.stringify(body));
    }
  });

  it('refuses an ID that is not a Seerr user ID before calling Seerr', async () => {
    for (const user of [0, -1, '9', undefined]) {
      await assert.rejects(new SeerrClient(BASE_URL, API_KEY).jellyfinUserIdOf(user), TypeError);
    }
    assert.equal(calls.length, 0);
  });
});

describe('Seerr title records for "Get this"', () => {
  it('reads a title\'s requests with the admin key, keeping only what the branches decide from', async () => {
    respond = () => Response.json(seerrFixture('tv'));
    const record = await new SeerrClient(BASE_URL, API_KEY).titleRequests('tv', 900002);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.pathname, '/api/v1/tv/900002');
    assert.equal(calls[0].headers.has('x-api-user'), false);
    assert.equal(calls[0].redirect, 'manual');
    assert.deepEqual(record, {
      // The title's own names and year, for a lookup in Jellyfin by name.
      names: ['Synthetic Series Two'],
      year: 2019,
      mediaId: 7300036,
      jellyfinMediaId: 'c0ffee00c0ffee000000000000000102',
      jellyfinMediaId4k: 'c0ffee00c0ffee000000000000000202',
      requests: [
        { id: '7300041', status: 1, is4k: false, seasons: [1], requesterJellyfinId: 'c0ffee00c0ffee000000000000000001', createdAt: Date.parse('2001-06-06T01:01:01.001Z') },
        { id: '7300049', status: 2, is4k: false, seasons: [2], requesterJellyfinId: 'c0ffee00c0ffee000000000000000002', createdAt: Date.parse('2001-05-05T09:09:09.009Z') },
      ],
    });
    // Nothing else of the answer (names, emails, download state, issues) is kept.
    assert.deepEqual(Object.keys(record.requests[0]).sort(), ['createdAt', 'id', 'is4k', 'requesterJellyfinId', 'seasons', 'status']);
  });

  it('answers undefined for a title Seerr cannot find, and a title with no media record has no requests', async () => {
    const admin = new SeerrClient(BASE_URL, API_KEY);
    respond = () => Response.json({ message: 'canary not found' }, { status: 404 });
    assert.equal(await admin.titleRequests('movie', 900001), undefined);
    respond = () => Response.json({ id: 900001, title: 'Synthetic Movie One' });
    assert.deepEqual(await admin.titleRequests('movie', 900001), { names: ['Synthetic Movie One'], requests: [] });
  });

  it('reads past the household app\'s usual size limit, since every household\'s records are on a title', async () => {
    const fixture = seerrFixture('movie');
    fixture.mediaInfo.requests = Array.from({ length: Math.ceil((5 * 1024 * 1024) / JSON.stringify(fixture.mediaInfo.requests[0]).length) }, () => fixture.mediaInfo.requests[0]);
    respond = () => Response.json(fixture);
    const record = await new SeerrClient(BASE_URL, API_KEY).titleRequests('movie', 900001);
    assert.ok(record.requests.length > 1000);
  });

  it('reads one request\'s status and media record, or undefined once Seerr deleted it', async () => {
    const admin = new SeerrClient(BASE_URL, API_KEY);
    respond = () => Response.json(seerrFixture('requests').results[0]);
    assert.deepEqual(await admin.requestState('7300070'), { status: 1, mediaId: 7300065 });
    assert.equal(calls[0].url.pathname, '/api/v1/request/7300070');
    assert.equal(calls[0].headers.has('x-api-user'), false);
    respond = () => Response.json({ message: 'canary' }, { status: 404 });
    assert.equal(await admin.requestState('7300070'), undefined);
    respond = () => Response.json({ id: 7300071, status: 1 });
    await assert.rejects(admin.requestState('7300070'), (error) => error instanceof SeerrError && !/7300/.test(error.message));
  });
});
