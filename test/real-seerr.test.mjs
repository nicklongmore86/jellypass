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
const LIFETIME_JELLYFIN_ID = '0000000000000000000000000000000f';
const SERIES_QUOTA_JELLYFIN_ID = '00000000000000000000000000000010';
// A member who may request, with an approved request (5) for The Shawshank Redemption (278).
const CANCELLER_JELLYFIN_ID = '00000000000000000000000000000011';
// A member who may request, with pending requests 6 (12 Angry Men, 389), 7 (The Good, the Bad and the Ugly, 429) and 8
// (The Green Mile, 497), for the administrators' Requests tab.
const ASKER_JELLYFIN_ID = '00000000000000000000000000000012';

describe('real Seerr', { timeout: 60_000, skip: !baseUrl || !apiKey }, () => {
  let calls = [];
  let originalFetch;

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (input, init = {}) => {
      calls.push({ url: new URL(String(input)), method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body });
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

  it('serves household app states from Seerr\'s permissions and blocklist, never from anyone\'s requests', async (t) => {
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
    // Seerr does not record which household a request was for, so no Seerr request is shown as `requested` in step 1,
    // not even one by a member of this household alone (step 2's attribution records will be the only source).
    assert.equal(matrix.state, 'get_this');
    // Another household's pending request is invisible; Seerr's own status for it (pending) is never shown.
    const fightClub = await as('token-requester', '/jellypass/app/v1/movie/550');
    assert.equal(fightClub.json().state, 'get_this');
    assert.equal((await as('token-neighbour', '/jellypass/app/v1/movie/550', 'jelly-mill.example.test')).json().state, 'get_this');
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
    assert.equal(search.json().results.find((card) => card.tmdbId === 603)?.state, 'get_this');
    for (const answer of [first, fightClub, pulpFiction, forrestGump, search]) {
      assertNoCanaries(answer.text);
      assert.doesNotMatch(answer.text, /requester|neighbour|shared|example\.invalid|requestedBy|mediaInfo|jellyfinMediaId/i);
      assert.equal(answer.headers['cache-control'], 'no-store');
    }
    // Seerr was asked only for user lookups and confirmations, the blocklist, and callers' own permissions as them:
    // never a title, never anyone's requests, and never as the shared member.
    const seerrCalls = calls.filter((call) => call.url.origin === baseUrl);
    assert.ok(seerrCalls.length > 0);
    for (const call of seerrCalls) {
      assert.match(call.url.pathname, /^\/api\/v1\/(?:user\/jellyfin\/[0-9a-f]{32}|user\/[0-9]+(?:\/quota)?|auth\/me|blocklist)$/, call.url.pathname);
      assert.notEqual(call.headers.get('x-api-user'), '6');
    }
  });

  it('makes "Get this" a real HD request as the member, attributed to their household', async (t) => {
    const people = [[REQUESTER_JELLYFIN_ID, 'requester', 'Requester'], [SHARED_JELLYFIN_ID, 'shared', 'Shared']];
    const app = await startApp(t, world({
      tokens: Object.fromEntries(people.map(([id, token]) => [id, `token-${token}`])),
      jellyfinUsers: Object.fromEntries(people.map(([id, , name]) => [id, { Name: name, Policy: { BlockedTags: [], EnableAllFolders: true } }])),
    }), {
      seerr: { url: baseUrl, apiKey },
      households: [{ id: 'farmhouse', name: 'Farmhouse', userIds: [REQUESTER_JELLYFIN_ID] }, { id: 'mill', name: 'Mill', userIds: [SHARED_JELLYFIN_ID] }],
    });
    const asRequester = { user: null, headers: { Authorization: 'MediaBrowser Token="token-requester"' } };
    const getThis = async (tmdbId) => {
      const answer = await app.post(`/jellypass/app/v1/movie/${tmdbId}/get`, undefined, asRequester);
      await app.background.settled();
      return answer;
    };
    const admin = (pathname, init = {}) => originalFetch(`${baseUrl}${pathname}`, { ...init, headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-Api-Key': apiKey } });
    const records = () => app.store.listAppRequests().map(([, record]) => record);
    // The requester has no Seerr quota, so "Get this" is offered to them.
    const own = await (await admin('/api/v1/user/4/quota')).json();
    assert.deepEqual([own.movie.limit ?? 0, own.tv.limit ?? 0], [0, 0]);
    calls = [];
    // The Dark Knight: nobody holds or asked for it.
    const first = await getThis(155);
    assert.equal(first.status, 202);
    assert.equal(first.text, '{"status":"accepted"}');
    assert.equal(records().length, 1, JSON.stringify(calls.map((call) => `${call.method} ${call.url.pathname}`)));
    const [made] = records();
    assert.deepEqual([made.branch, made.householdId, made.status], ['request', 'farmhouse', 'pending']);
    // Sent as the member, naming only the title, in HD.
    const posted = calls.filter((call) => call.method === 'POST' && call.url.pathname === '/api/v1/request');
    assert.equal(posted.length, 1);
    assert.equal(posted[0].headers.get('x-api-user'), '4');
    assert.deepEqual(JSON.parse(posted[0].body), { mediaType: 'movie', mediaId: 155, is4k: false });
    const inSeerr = await (await admin(`/api/v1/request/${made.seerrRequestId}`)).json();
    assert.equal(inSeerr.requestedBy.id, 4);
    assert.equal(inSeerr.is4k, false);
    assert.equal(inSeerr.media.tmdbId, 155);
    assert.equal(made.seerrMediaId, inSeerr.media.id);
    // Its intent was written before the request was sent, and is gone now that the request is recorded and settled.
    assert.deepEqual(app.store.listAppRequestIntents(), []);
    // An administrator declines it, and JellyPass's record follows.
    assert.equal((await admin(`/api/v1/request/${made.seerrRequestId}/decline`, { method: 'POST' })).status, 200);
    await app.requests.refresh();
    assert.equal(records()[0].status, 'declined');
    // Pulp Fiction is the other household's member's pending request: the household's interest follows it, unrequested.
    calls = [];
    await getThis(680);
    assert.ok(!calls.some((call) => call.method === 'POST'));
    const interest = records().find((record) => record.tmdbId === 680);
    assert.deepEqual([interest.branch, interest.seerrRequestId, interest.status], ['interest', '3', 'pending']);
    // The household sees its own titles with coarse statuses, nothing of Seerr's.
    const listed = await app.get('/jellypass/app/v1/requests', asRequester);
    assert.deepEqual(listed.json().results.map((entry) => [entry.tmdbId, entry.status, entry.byYou]), [[680, 'requested', true], [155, 'failed', true]]);
    assertNoCanaries(listed.text);
    assert.doesNotMatch(listed.text, /requester|shared|example\.invalid|seerr|"3"|mediaId/i);
    // The other household, whose member made the request followed, sees nothing of it.
    const mill = await app.get('/jellypass/app/v1/requests', { host: 'jelly-mill.example.test', user: null, headers: { Authorization: 'MediaBrowser Token="token-shared"' } });
    assert.deepEqual(mill.json(), { results: [] });
  });

  it('lets a member delete only their own pending request, as themselves, which is what a household app cancel does', async (t) => {
    const admin = (pathname, init = {}) => originalFetch(`${baseUrl}${pathname}`, { ...init, headers: { Accept: 'application/json', 'X-Api-Key': apiKey } });
    const member = new SeerrUserMap(new SeerrClient(baseUrl, apiKey)).member(CANCELLER_JELLYFIN_ID);
    calls = [];
    // Their own approved request, and another member's pending one (Fight Club, user 5's): Seerr refuses both.
    for (const requestId of ['5', '2']) {
      const refused = await member.cancelRequest(requestId).catch((error) => error);
      assert.ok(refused instanceof SeerrError, requestId);
      assert.equal(refused.status, 401, requestId);
      assert.equal(refused.message, 'Seerr DELETE /api/v1/request/:id returned 401');
      assert.equal((await admin(`/api/v1/request/${requestId}`)).status, 200, requestId);
    }
    const deletes = calls.filter((call) => call.method === 'DELETE');
    assert.equal(deletes.length, 2);
    for (const call of deletes) assert.equal(call.headers.get('x-api-user'), '9');

    // "Get this", then cancel it in the app: the pending request is deleted in Seerr, as the member.
    const app = await startApp(t, world({
      tokens: { [CANCELLER_JELLYFIN_ID]: 'token-canceller' },
      jellyfinUsers: { [CANCELLER_JELLYFIN_ID]: { Name: 'Canceller', Policy: { BlockedTags: [], EnableAllFolders: true } } },
    }), {
      seerr: { url: baseUrl, apiKey },
      households: [{ id: 'farmhouse', name: 'Farmhouse', userIds: [CANCELLER_JELLYFIN_ID] }],
    });
    const asCanceller = { user: null, headers: { Authorization: 'MediaBrowser Token="token-canceller"' } };
    // Schindler's List: nobody holds or asked for it.
    assert.equal((await app.post('/jellypass/app/v1/movie/424/get', undefined, asCanceller)).status, 202);
    await app.background.settled();
    const [[, made]] = app.store.listAppRequests();
    assert.deepEqual([made.branch, made.status], ['request', 'pending']);
    assert.equal((await (await admin(`/api/v1/request/${made.seerrRequestId}`)).json()).status, 1);
    const [entry] = (await app.get('/jellypass/app/v1/requests', asCanceller)).json().results;
    assert.deepEqual([entry.tmdbId, entry.status, entry.cancellable], [424, 'requested', true]);
    calls = [];
    const answer = await app.post(`/jellypass/app/v1/requests/${entry.id}/cancel`, undefined, asCanceller);
    assert.deepEqual([answer.status, answer.text], [202, '{"status":"accepted"}']);
    await app.background.settled();
    const deleted = calls.filter((call) => call.method === 'DELETE');
    assert.deepEqual(deleted.map((call) => [call.url.pathname, call.headers.get('x-api-user')]), [[`/api/v1/request/${made.seerrRequestId}`, '9']]);
    assert.equal((await admin(`/api/v1/request/${made.seerrRequestId}`)).status, 404);
    assert.deepEqual((await app.get('/jellypass/app/v1/requests', asCanceller)).json(), { results: [] });
    assert.deepEqual(app.store.listAppWithdrawals(), []);
    // Every member call acted as the member, never the owner.
    for (const call of calls.filter((entry) => entry.url.origin === baseUrl && entry.headers.has('x-api-user'))) assert.equal(call.headers.get('x-api-user'), '9');
  });

  it('approves, declines and deletes requests with the admin key, as the administrators\' Requests tab does, never as a member', async () => {
    const admin = new SeerrClient(baseUrl, apiKey);
    const status = async (requestId) => (await admin.requestState(requestId))?.status;
    calls = [];
    await admin.approveRequest('6');
    assert.equal(await status('6'), 2);
    await admin.declineRequest('7');
    assert.equal(await status('7'), 3);
    // Seerr approves and declines only a pending request.
    for (const call of [() => admin.approveRequest('6'), () => admin.declineRequest('6'), () => admin.approveRequest('7')]) {
      const refused = await call().catch((error) => error);
      assert.ok(refused instanceof SeerrError);
      assert.equal(refused.status, 409);
      assert.doesNotMatch(refused.message, /pending/, 'Seerr\'s text is never relayed');
    }
    assert.equal(await admin.deleteRequest('8'), true);
    assert.equal(await status('8'), undefined);
    assert.equal(await admin.deleteRequest('8'), false, 'a request Seerr no longer has');
    // This Seerr has no Radarr server: the option is never offered, and Seerr itself refuses a removal.
    assert.equal(await admin.radarrConfigured(), false);
    const removal = await admin.removeMovieFromRadarr(6).catch((error) => error);
    assert.ok(removal instanceof SeerrError);
    assert.equal(removal.status, 409);
    for (const call of calls) assert.equal(call.headers.has('x-api-user'), false, `${call.method} ${call.url.pathname}`);
  });

  it('cancels a member\'s request for every household through JellyPass: the hold first, then Seerr\'s delete with the admin key', async (t) => {
    const app = await startApp(t, world({
      tokens: { [ASKER_JELLYFIN_ID]: 'token-asker' },
      jellyfinUsers: { [ASKER_JELLYFIN_ID]: { Name: 'Asker', Policy: { BlockedTags: [], EnableAllFolders: true } } },
    }), {
      seerr: { url: baseUrl, apiKey },
      households: [{ id: 'grove', name: 'Grove', userIds: [ASKER_JELLYFIN_ID] }],
    });
    const asAsker = { user: null, host: 'jelly-grove.example.test', headers: { Authorization: 'MediaBrowser Token="token-asker"' } };
    // Goodfellas: nobody holds or asked for it.
    assert.equal((await app.post('/jellypass/app/v1/movie/769/get', undefined, asAsker)).status, 202);
    await app.background.settled();
    const [[, made]] = app.store.listAppRequests();
    assert.deepEqual([made.branch, made.status], ['request', 'pending']);
    const adminApi = (pathname, init = {}) => app.get(pathname, { user: null, host: 'jellypass.example.test', headers: { Authorization: 'Bearer admin-secret', ...init.headers } });
    const [row] = (await adminApi('/v1/app/requests')).json().requests;
    assert.deepEqual([row.requestId, row.seerrStatus, row.requester.name, row.actions.cancel, row.actions.removeFromRadarr], [made.seerrRequestId, 'pending', 'Asker', true, false]);
    calls = [];
    const answer = await app.post(`/v1/app/requests/${made.seerrRequestId}/cancel`, undefined, { user: null, host: 'jellypass.example.test', headers: { Authorization: 'Bearer admin-secret' } });
    assert.deepEqual([answer.status, answer.json()], [200, { status: 'cancelled', changed: true, titleHold: true, removedFromRadarr: false }]);
    const deletes = calls.filter((call) => call.method === 'DELETE');
    assert.deepEqual(deletes.map((call) => [call.url.pathname, call.headers.has('x-api-user')]), [[`/api/v1/request/${made.seerrRequestId}`, false]]);
    assert.equal(await new SeerrClient(baseUrl, apiKey).requestState(made.seerrRequestId), undefined);
    assert.deepEqual(app.store.listAppRequests().map(([, record]) => record.status), ['deleted']);
    assert.deepEqual(app.store.listAppWithdrawals().map(([requestId, withdrawal]) => [requestId, withdrawal.requesterId, typeof withdrawal.seerrGoneAt]),
      [[made.seerrRequestId, ASKER_JELLYFIN_ID, 'string']]);
    assert.deepEqual((await app.get('/jellypass/app/v1/requests', asAsker)).json(), { results: [] });
  });

  it('offers "Get this" to no caller Seerr gives a quota: every title they cannot play is unavailable, and it runs nothing', async (t) => {
    const people = [[LIFETIME_JELLYFIN_ID, 'lifetime', 'Lifetime'], [SERIES_QUOTA_JELLYFIN_ID, 'series', 'Series'], [REQUESTER_JELLYFIN_ID, 'requester', 'Requester']];
    const app = await startApp(t, world({
      tokens: Object.fromEntries(people.map(([id, token]) => [id, `token-${token}`])),
      jellyfinUsers: Object.fromEntries(people.map(([id, , name]) => [id, { Name: name, Policy: { BlockedTags: [], EnableAllFolders: true } }])),
      tmdbMovies: Object.fromEntries([[155, 'The Dark Knight', '2008-07-16'], [603, 'The Matrix', '1999-03-30']].map(([id, title, date]) => [id, { title, release_date: date }])),
    }), {
      seerr: { url: baseUrl, apiKey },
      households: [{ id: 'farmhouse', name: 'Farmhouse', userIds: people.map(([id]) => id) }],
    });
    // Seerr's own quotas: user 7 a lifetime movie quota already used, user 8 a series quota with nothing used.
    const quota = async (user) => (await (await originalFetch(`${baseUrl}/api/v1/user/${user}/quota`, { headers: { Accept: 'application/json', 'X-Api-Key': apiKey } })).json());
    const lifetime = await quota(7);
    assert.deepEqual([Boolean(lifetime.movie.days), lifetime.movie.limit, lifetime.movie.used], [false, 1, 1]);
    const series = await quota(8);
    assert.deepEqual([series.movie.limit ?? 0, series.tv.limit, series.tv.used], [0, 5, 0]);
    const as = (token) => ({ user: null, headers: { Authorization: `MediaBrowser Token="token-${token}"` } });
    for (const token of ['lifetime', 'series']) {
      // Every title, of either media type, the same: "Can't request".
      for (const pathname of ['/jellypass/app/v1/movie/155', '/jellypass/app/v1/movie/603']) {
        const answer = await app.get(pathname, as(token));
        assert.equal(answer.status, 200, answer.text);
        assert.equal(answer.json().state, 'unavailable', `${token} ${pathname}`);
      }
      calls = [];
      const answer = await app.post('/jellypass/app/v1/movie/155/get', undefined, as(token));
      await app.background.settled();
      assert.equal(answer.text, '{"status":"accepted"}');
      assert.deepEqual(app.store.listAppRequests(), []);
      assert.deepEqual(app.store.listAppRequestIntents(), []);
      // Only their own Seerr user and quota were read: no title, no request.
      for (const call of calls.filter((entry) => entry.url.origin === baseUrl)) {
        assert.match(call.url.pathname, /^\/api\/v1\/(?:user\/jellyfin\/[0-9a-f]{32}|user\/[0-9]+(?:\/quota)?|auth\/me)$/, `${token} ${call.url.pathname}`);
      }
    }
    // A member of the same household with no quota is offered it.
    assert.equal((await app.get('/jellypass/app/v1/movie/155', as('requester'))).json().state, 'get_this');
  });

  it('acts as a Seerr user that does not exist as nobody, never the owner', async () => {
    // No client can be pointed at a Seerr user without Seerr confirming it first; this is Seerr's own answer.
    for (const path of ['/api/v1/user/99/quota', '/api/v1/discover/watchlist']) {
      const response = await originalFetch(`${baseUrl}${path}`, { headers: { 'X-Api-Key': apiKey, 'X-API-User': '99' } });
      assert.equal(response.status, 403, path);
    }
  });
});
