import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SeerrCatalogueClient, SeerrCatalogueUserError, SeerrClient, SeerrError, SeerrMemberClient, SeerrUnmappedUserError, seerrUserId } from '../dist/seerr.js';
import { SeerrUserMap } from '../dist/seerr-users.js';

// Set by scripts/test-real-seerr.sh: a fresh Seerr whose user 1 is the owner, user 2 a member with no permissions (and
// a preference for Japanese originals) and user 3 the catalogue user.
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
    assert.equal(await map.candidate(MEMBER_JELLYFIN_ID), 2);
    assert.equal(await map.candidate('ffffffffffffffffffffffffffffffff'), undefined);
    assert.equal(calls.length, 4);
    assert.ok(calls.every((call) => !call.headers.has('x-api-user')));
  });

  it('confirms the member\'s Jellyfin link with the admin key immediately before every member call', async () => {
    calls = [];
    const admin = new SeerrClient(baseUrl, apiKey);
    assert.equal(await admin.jellyfinUserIdOf(seerrUserId(2)), '0000000000000000000000000000000b');
    assert.equal(await admin.jellyfinUserIdOf(seerrUserId(99)), undefined);
    const member = new SeerrUserMap(admin).member(MEMBER_JELLYFIN_ID);
    await member.quota();
    await member.quota();
    assert.deepEqual(calls.map((call) => `${call.headers.get('x-api-user')} ${call.url.pathname}`), [
      'null /api/v1/user/2',
      'null /api/v1/user/99',
      'null /api/v1/user/jellyfin/0000000000000000000000000000000b',
      'null /api/v1/user/2',
      '2 /api/v1/user/2/quota',
      'null /api/v1/user/2',
      '2 /api/v1/user/2/quota',
    ]);
  });

  it('fails a member call closed when Seerr links the Seerr user to someone else', async () => {
    calls = [];
    const forged = { candidate: async () => seerrUserId(2), forget() {}, version: () => 0 };
    const other = new SeerrMemberClient(new SeerrClient(baseUrl, apiKey), 'ffffffffffffffffffffffffffffffff', forged);
    await assert.rejects(other.quota(), SeerrUnmappedUserError);
    assert.ok(calls.every((call) => !call.headers.has('x-api-user')));
  });

  it('acts as the member on every member call, so Seerr applies the member\'s permissions', async () => {
    const member = new SeerrUserMap(new SeerrClient(baseUrl, apiKey)).member(MEMBER_JELLYFIN_ID);
    calls = [];

    assert.deepEqual(await member.quota(), { movie: { used: 0, restricted: false }, tv: { used: 0, restricted: false } });
    const own = await member.ownRequests();
    assert.equal(own.pageInfo.results, 0);
    assert.deepEqual((await member.watchlist()).results, []);

    // The member may not request; the owner could, so a 403 shows the call did not run as the owner.
    const refused = await member.createRequest({ mediaType: 'movie', tmdbId: 603 }).catch((error) => error);
    assert.ok(refused instanceof SeerrError);
    assert.equal(refused.status, 403);
    assert.equal(refused.message, 'Seerr POST /api/v1/request returned 403');

    const acting = calls.filter((call) => call.headers.has('x-api-user'));
    assert.equal(acting.length, 4);
    for (const call of acting) {
      assert.equal(call.url.origin, baseUrl);
      assert.equal(call.headers.get('x-api-user'), '2', call.url.pathname);
    }
  });

  it('accepts only a permissionless, unlinked user other than the owner as the catalogue user', async () => {
    const admin = new SeerrClient(baseUrl, apiKey);
    assert.equal(await admin.catalogueUserProblem(seerrUserId(3)), undefined);
    assert.equal(await admin.catalogueUserProblem(seerrUserId(1)), 'is the owner');
    assert.equal(await admin.catalogueUserProblem(seerrUserId(2)), 'is linked to a Jellyfin user');
    assert.equal(await admin.catalogueUserProblem(seerrUserId(99)), 'does not exist');
    await new SeerrCatalogueClient(admin, seerrUserId(3)).validate();
    await assert.rejects(new SeerrCatalogueClient(admin, seerrUserId(2)).validate(), SeerrCatalogueUserError);
  });

  it('reads the catalogue as the catalogue user, whose results no member\'s Seerr preferences shape', async (t) => {
    // Seerr builds discover queries from the acting user's settings: the member asked for Japanese originals only.
    const asMember = await originalFetch(`${baseUrl}/api/v1/discover/movies?page=1`, {
      headers: { Accept: 'application/json', 'X-Api-Key': apiKey, 'X-API-User': '2' },
    });
    if (asMember.status === 500) return t.skip('Seerr cannot reach TMDB here');
    assert.equal(asMember.status, 200);
    const memberResults = (await asMember.json()).results;
    assert.ok(memberResults.length > 0);
    assert.ok(memberResults.every((result) => result.originalLanguage === 'ja'), 'Seerr applied the member\'s preference');

    calls = [];
    const catalogue = new SeerrCatalogueClient(new SeerrClient(baseUrl, apiKey), seerrUserId(3));
    const catalogueResults = (await catalogue.discover('movies')).results;
    assert.ok(catalogueResults.length > 0);
    assert.ok(catalogueResults.some((result) => result.originalLanguage !== 'ja'), 'the member\'s preference did not apply');
    assert.deepEqual(calls.map((call) => `${call.headers.get('x-api-user')} ${call.url.pathname}`), [
      'null /api/v1/user/3',
      '3 /api/v1/discover/movies',
    ]);
  });

  it('acts as a Seerr user that does not exist as nobody, never the owner', async () => {
    // No client can be pointed at a Seerr user without Seerr confirming it first; this is Seerr's own answer.
    for (const path of ['/api/v1/user/99/quota', '/api/v1/discover/watchlist']) {
      const response = await originalFetch(`${baseUrl}${path}`, { headers: { 'X-Api-Key': apiKey, 'X-API-User': '99' } });
      assert.equal(response.status, 403, path);
    }
  });
});
