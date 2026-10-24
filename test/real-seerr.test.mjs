import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { SeerrClient, SeerrError, SeerrMemberClient, SeerrUnmappedUserError, seerrUserId } from '../dist/seerr.js';
import { SeerrUserMap } from '../dist/seerr-users.js';
import { assertNoCanaries } from './support/seerr-fixtures.mjs';
import { startApp, world } from './support/household-app.mjs';

// Set by scripts/test-real-seerr.sh: a fresh Seerr whose user 1 is the owner and user 2 a member with no permissions.
const baseUrl = process.env.SEERR_REAL_URL;
const apiKey = process.env.SEERR_REAL_API_KEY;
const MEMBER_JELLYFIN_ID = '00000000-0000-0000-0000-00000000000b';
// Seeded by the script for the household app: a member who may request, with a pending request for The Matrix (603),
// a member of another household with a pending request for Fight Club (550), and a member of both households with a
// pending request for Pulp Fiction (680).
const REQUESTER_JELLYFIN_ID = '0000000000000000000000000000000c';
const NEIGHBOUR_JELLYFIN_ID = '0000000000000000000000000000000d';
const SHARED_JELLYFIN_ID = '0000000000000000000000000000000e';

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

  it('reads the blocklist with the admin key, and Seerr joins no media record or request to it', async () => {
    // Blocklisting needs no TMDB; Seerr records the title and marks its media record BLOCKLISTED.
    const added = await originalFetch(`${baseUrl}/api/v1/blocklist`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': apiKey },
      body: JSON.stringify({ tmdbId: 13, mediaType: 'movie', title: 'Forrest Gump', user: 1 }),
    });
    assert.equal(added.status, 201);
    calls = [];
    const page = await new SeerrClient(baseUrl, apiKey).blocklist(100, 0);
    assert.deepEqual(calls.map((call) => `${call.headers.get('x-api-user')} ${call.url.pathname}${call.url.search}`), ['null /api/v1/blocklist?take=100&skip=0']);
    assert.equal(page.results.length, 1);
    const [entry] = page.results;
    assert.equal(entry.tmdbId, 13);
    assert.equal(entry.mediaType, 'movie');
    // The entry's keys: its own columns and the administrator who added it; nothing about any household's requests.
    assert.deepEqual(Object.keys(entry).filter((key) => !['id', 'mediaType', 'title', 'tmdbId', 'blocklistedTags', 'createdAt', 'user'].includes(key)), []);
    assert.equal(entry.user.id, 1);
  });

  it('serves household app states from Seerr itself, never from another household\'s requests', async (t) => {
    const MEMBER = MEMBER_JELLYFIN_ID.replaceAll('-', '');
    const people = [[REQUESTER_JELLYFIN_ID, 'requester', 'Requester'], [MEMBER, 'member', 'Member'], [NEIGHBOUR_JELLYFIN_ID, 'neighbour', 'Neighbour'], [SHARED_JELLYFIN_ID, 'shared', 'Shared']];
    const state = world({
      tokens: Object.fromEntries(people.map(([id, token]) => [id, `token-${token}`])),
      jellyfinUsers: Object.fromEntries(people.map(([id, , name]) => [id, { Name: name, Policy: { BlockedTags: [], EnableAllFolders: true } }])),
      // The fake TMDB knows these titles; Seerr is never asked for one.
      tmdbMovies: Object.fromEntries([[603, 'The Matrix', '1999-03-30'], [550, 'Fight Club', '1999-10-15'], [680, 'Pulp Fiction', '1994-09-10'], [13, 'Forrest Gump', '1994-06-23']]
        .map(([id, title, date]) => [id, { title, release_date: date }])),
    });
    const app = await startApp(t, state, {
      seerr: { url: baseUrl, apiKey },
      households: [
        { id: 'farmhouse', name: 'Farmhouse', userIds: [REQUESTER_JELLYFIN_ID, MEMBER, SHARED_JELLYFIN_ID] },
        { id: 'mill', name: 'Mill', userIds: [NEIGHBOUR_JELLYFIN_ID, SHARED_JELLYFIN_ID] },
      ],
    });
    calls = [];
    const as = (token, pathname, host = 'jelly-farmhouse.example.test') =>
      app.get(pathname, { host, user: null, headers: { Authorization: `MediaBrowser Token="${token}"` } });
    const first = await as('token-requester', '/jellypass/app/v1/movie/603');
    assert.equal(first.status, 200, first.text);
    const matrix = first.json();
    assert.equal(matrix.title, 'The Matrix');
    assert.equal(matrix.year, 1999);
    assert.equal(matrix.state, 'requested');
    // Another household's pending request is invisible; Seerr's own status for it (pending) is never shown.
    const fightClub = await as('token-requester', '/jellypass/app/v1/movie/550');
    assert.equal(fightClub.json().state, 'get_this');
    assert.equal((await as('token-neighbour', '/jellypass/app/v1/movie/550', 'jelly-mill.example.test')).json().state, 'requested');
    // Codex's repro: a pending request by a member of both households could be either's, so it shows in neither.
    const pulpFiction = await as('token-requester', '/jellypass/app/v1/movie/680');
    assert.equal(pulpFiction.json().state, 'get_this');
    assert.equal((await as('token-neighbour', '/jellypass/app/v1/movie/680', 'jelly-mill.example.test')).json().state, 'get_this');
    // Seerr's blocklist (seeded by the previous test) makes a title unavailable for everyone.
    const forrestGump = await as('token-requester', '/jellypass/app/v1/movie/13');
    assert.equal(forrestGump.json().state, 'unavailable');
    // The member may not request at all, so everything they cannot play is unavailable, their household's request included.
    assert.equal((await as('token-member', '/jellypass/app/v1/movie/603')).json().state, 'unavailable');
    const search = await as('token-requester', '/jellypass/app/v1/search?q=matrix');
    assert.equal(search.status, 200);
    assert.equal(search.json().results.find((card) => card.tmdbId === 603)?.state, 'requested');
    for (const answer of [first, fightClub, pulpFiction, forrestGump, search]) {
      assertNoCanaries(answer.text);
      assert.doesNotMatch(answer.text, /requester|neighbour|shared|example\.invalid|requestedBy|mediaInfo|jellyfinMediaId/i);
      assert.equal(answer.headers['cache-control'], 'no-store');
    }
    // Seerr was asked only for user lookups and confirmations, the blocklist, and members' own data as them: never a
    // title, and never as the shared member.
    const seerrCalls = calls.filter((call) => call.url.origin === baseUrl);
    assert.ok(seerrCalls.length > 0);
    for (const call of seerrCalls) {
      assert.match(call.url.pathname, /^\/api\/v1\/(?:user\/jellyfin\/[0-9a-f]{32}|user\/[0-9]+|user\/[0-9]+\/requests|auth\/me|blocklist)$/, call.url.pathname);
      assert.notEqual(call.headers.get('x-api-user'), '6');
    }
  });

  it('acts as a Seerr user that does not exist as nobody, never the owner', async () => {
    // No client can be pointed at a Seerr user without Seerr confirming it first; this is Seerr's own answer.
    for (const path of ['/api/v1/user/99/quota', '/api/v1/discover/watchlist']) {
      const response = await originalFetch(`${baseUrl}${path}`, { headers: { 'X-Api-Key': apiKey, 'X-API-User': '99' } });
      assert.equal(response.status, 403, path);
    }
  });
});
