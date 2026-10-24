import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SeerrClient, SeerrError, seerrUserId } from '../dist/seerr.js';
import { SeerrUserMap } from '../dist/seerr-users.js';

// Set by scripts/test-real-seerr.sh: a fresh Seerr whose user 1 is the owner and user 2 a member with no permissions.
const baseUrl = process.env.SEERR_REAL_URL;
const apiKey = process.env.SEERR_REAL_API_KEY;
const MEMBER_JELLYFIN_ID = '00000000-0000-0000-0000-00000000000b';

describe('real Seerr', { timeout: 60_000, skip: !baseUrl || !apiKey }, () => {
  let calls = [];
  let originalFetch;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init = {}) => {
      calls.push({ url: new URL(String(input)), headers: new Headers(init.headers) });
      return originalFetch(input, init);
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  /** Who Seerr says an API-key call acts as, with the given X-API-User headers (none, or exactly these). */
  async function actingAs(headers) {
    const response = await originalFetch(`${baseUrl}/api/v1/auth/me`, {
      headers: { Accept: 'application/json', 'X-Api-Key': apiKey, ...headers },
    });
    return { status: response.status, id: response.ok ? (await response.json()).id : undefined };
  }

  it('runs an API-key call with a missing or empty X-API-User as the owner (the hazard the client prevents)', async () => {
    assert.deepEqual(await actingAs({}), { status: 200, id: 1 });
    assert.deepEqual(await actingAs({ 'X-API-User': '' }), { status: 200, id: 1 });
    assert.deepEqual(await actingAs({ 'X-API-User': '2' }), { status: 200, id: 2 });
    // An ID Seerr does not know is refused, not run as the owner.
    assert.equal((await actingAs({ 'X-API-User': '99' })).status, 403);
  });

  it('maps the member by Jellyfin ID with the admin key and fails closed for an unknown one', async () => {
    calls = [];
    const admin = new SeerrClient(baseUrl, apiKey);
    assert.deepEqual(await admin.findUserByJellyfinId(MEMBER_JELLYFIN_ID), { id: 2, jellyfinUserId: '0000000000000000000000000000000b' });
    assert.equal(await admin.findUserByJellyfinId('ffffffff-ffff-ffff-ffff-ffffffffffff'), undefined);
    const map = new SeerrUserMap(admin);
    assert.equal((await map.clientFor(MEMBER_JELLYFIN_ID))?.userId, 2);
    assert.equal(await map.clientFor('ffffffffffffffffffffffffffffffff'), undefined);
    assert.equal(calls.length, 4);
    assert.ok(calls.every((call) => !call.headers.has('x-api-user')));
  });

  it('confirms a Seerr user\'s Jellyfin link with the admin key before a verified use', async () => {
    calls = [];
    const admin = new SeerrClient(baseUrl, apiKey);
    assert.equal(await admin.jellyfinUserIdOf(seerrUserId(2)), '0000000000000000000000000000000b');
    assert.equal(await admin.jellyfinUserIdOf(seerrUserId(99)), undefined);
    const map = new SeerrUserMap(admin);
    assert.equal((await map.verifiedClientFor(MEMBER_JELLYFIN_ID))?.userId, 2);
    assert.deepEqual(calls.map((call) => call.url.pathname), [
      '/api/v1/user/2',
      '/api/v1/user/99',
      '/api/v1/user/jellyfin/0000000000000000000000000000000b',
      '/api/v1/user/2',
    ]);
    assert.ok(calls.every((call) => !call.headers.has('x-api-user')));
  });

  it('acts as the member on every call, so Seerr applies the member\'s permissions', async () => {
    calls = [];
    const member = new SeerrClient(baseUrl, apiKey).asUser(seerrUserId(2));

    assert.deepEqual(await member.quota(), { movie: { used: 0, restricted: false }, tv: { used: 0, restricted: false } });
    const own = await member.ownRequests();
    assert.equal(own.pageInfo.results, 0);
    assert.deepEqual((await member.watchlist()).results, []);

    // The member may not request; the owner could, so a 403 shows the call did not run as the owner.
    const refused = await member.createRequest({ mediaType: 'movie', tmdbId: 603 }).catch((error) => error);
    assert.ok(refused instanceof SeerrError);
    assert.equal(refused.status, 403);
    assert.equal(refused.message, 'Seerr POST /api/v1/request returned 403');

    assert.equal(calls.length, 4);
    for (const call of calls) {
      assert.equal(call.url.origin, baseUrl);
      assert.equal(call.headers.get('x-api-user'), '2', call.url.pathname);
    }
  });

  it('acts as a Seerr user that does not exist as nobody, never the owner', async () => {
    const ghost = new SeerrClient(baseUrl, apiKey).asUser(seerrUserId(99));
    await assert.rejects(ghost.quota(), (error) => error instanceof SeerrError && error.status === 403);
    await assert.rejects(ghost.watchlist(), (error) => error instanceof SeerrError && error.status === 403);
  });
});
