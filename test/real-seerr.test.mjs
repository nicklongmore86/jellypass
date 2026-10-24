import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SeerrCatalogueClient, SeerrCatalogueUserError, SeerrClient, SeerrError, SeerrMemberClient, SeerrUnmappedUserError, seerrUserId } from '../dist/seerr.js';
import { SeerrUserMap } from '../dist/seerr-users.js';
import { assertNoCanaries } from './support/seerr-fixtures.mjs';
import { startApp, world } from './support/household-app.mjs';

// Set by scripts/test-real-seerr.sh: a fresh Seerr whose user 1 is the owner, user 2 a member with no permissions (and
// a preference for Japanese originals) and user 3 the catalogue user.
const baseUrl = process.env.SEERR_REAL_URL;
const apiKey = process.env.SEERR_REAL_API_KEY;
const MEMBER_JELLYFIN_ID = '00000000-0000-0000-0000-00000000000b';
// Seeded by the script for the household app: a member who may request, with a pending request for The Matrix (603),
// and a member of another household with a pending request for Fight Club (550).
const REQUESTER_JELLYFIN_ID = '0000000000000000000000000000000c';
const NEIGHBOUR_JELLYFIN_ID = '0000000000000000000000000000000d';
// The script's probe of TMDB from inside the Seerr container ("reachable", or "unreachable <reason>"). Only a positive
// "unreachable" lets the TMDB-backed test skip, and never in CI or with SEERR_REQUIRE_TMDB=1.
const tmdbProbe = process.env.SEERR_TMDB_PROBE ?? '';
const tmdbRequired = process.env.CI === 'true' || process.env.SEERR_REQUIRE_TMDB === '1';

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

  it('reads a member\'s own permissions as that member, once Seerr has confirmed it', async () => {
    calls = [];
    const map = new SeerrUserMap(new SeerrClient(baseUrl, apiKey));
    const member = await map.member(MEMBER_JELLYFIN_ID).ownUser();
    assert.equal(member.id, 2);
    assert.equal(member.permissions, 0);
    const requester = await map.member(REQUESTER_JELLYFIN_ID).ownUser();
    assert.equal(requester.id, 4);
    assert.equal(requester.permissions, 32);
    assert.deepEqual(calls.map((call) => `${call.headers.get('x-api-user')} ${call.url.pathname}`), [
      'null /api/v1/user/jellyfin/0000000000000000000000000000000b',
      'null /api/v1/user/2',
      '2 /api/v1/auth/me',
      'null /api/v1/user/jellyfin/0000000000000000000000000000000c',
      'null /api/v1/user/4',
      '4 /api/v1/auth/me',
    ]);
  });

  it('serves household app states from Seerr itself, never from another household\'s requests', async (t) => {
    const MEMBER = MEMBER_JELLYFIN_ID.replaceAll('-', '');
    const state = world({
      tokens: { [REQUESTER_JELLYFIN_ID]: 'token-requester', [MEMBER]: 'token-member', [NEIGHBOUR_JELLYFIN_ID]: 'token-neighbour' },
      jellyfinUsers: Object.fromEntries([[REQUESTER_JELLYFIN_ID, 'Requester'], [MEMBER, 'Member'], [NEIGHBOUR_JELLYFIN_ID, 'Neighbour']]
        .map(([id, name]) => [id, { Name: name, Policy: { BlockedTags: [], EnableAllFolders: true } }])),
    });
    const app = await startApp(t, state, {
      seerr: { url: baseUrl, apiKey },
      catalogueUserId: 3,
      households: [
        { id: 'farmhouse', name: 'Farmhouse', userIds: [REQUESTER_JELLYFIN_ID, MEMBER] },
        { id: 'mill', name: 'Mill', userIds: [NEIGHBOUR_JELLYFIN_ID] },
      ],
    });
    const as = (token, pathname, host = 'jelly-farmhouse.example.test') =>
      app.get(pathname, { host, user: null, headers: { Authorization: `MediaBrowser Token="${token}"` } });
    const first = await as('token-requester', '/jellypass/app/v1/movie/603');
    if (first.status === 502 && !tmdbRequired && tmdbProbe.startsWith('unreachable ')) {
      return t.skip(`Seerr cannot reach TMDB here (${tmdbProbe})`);
    }
    assert.equal(first.status, 200, `${first.text}; TMDB probe: ${tmdbProbe || 'not run'}`);
    const matrix = first.json();
    assert.equal(matrix.title, 'The Matrix');
    assert.equal(matrix.year, 1999);
    assert.equal(matrix.state, 'requested');
    // Another household's pending request is invisible; Seerr's own status for it (pending) is never shown.
    const fightClub = await as('token-requester', '/jellypass/app/v1/movie/550');
    assert.equal(fightClub.json().state, 'get_this');
    assert.equal((await as('token-neighbour', '/jellypass/app/v1/movie/550', 'jelly-mill.example.test')).json().state, 'requested');
    // The member may not request at all, so everything is unavailable for them, their household's request included.
    assert.equal((await as('token-member', '/jellypass/app/v1/movie/603')).json().state, 'unavailable');
    const search = await as('token-requester', '/jellypass/app/v1/search?q=matrix');
    assert.equal(search.status, 200);
    assert.equal(search.json().results.find((card) => card.tmdbId === 603)?.state, 'requested');
    for (const answer of [first, fightClub, search]) {
      assertNoCanaries(answer.text);
      assert.doesNotMatch(answer.text, /requester|neighbour|example\.invalid|requestedBy|mediaInfo|jellyfinMediaId/i);
      assert.equal(answer.headers['cache-control'], 'no-store');
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
    if (asMember.status === 500 && !tmdbRequired && tmdbProbe.startsWith('unreachable ')) {
      return t.skip(`Seerr cannot reach TMDB here (${tmdbProbe})`);
    }
    assert.equal(asMember.status, 200, `Seerr discover failed; TMDB probe: ${tmdbProbe || 'not run'}`);
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
