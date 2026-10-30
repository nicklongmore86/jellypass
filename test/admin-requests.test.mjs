// The administrators' Requests tab's API (docs/app-design.md, "Administrators' Requests tab"): GET /v1/app/requests,
// approving, declining and cancelling a request for every household (with "Also remove from Radarr" for a movie
// Jellyfin does not have), and releasing a title held for no household to chosen households.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  ALICE,
  BOB,
  HOST_A,
  HOST_B,
  HOUSEHOLDS,
  ITEMS,
  T_MOVIE,
  T_TV,
  get,
  seerrRequest,
  startApp,
  world,
} from './support/household-app.mjs';

const APP = '/jellypass/app/v1';
const GET_MOVIE = `${APP}/movie/${T_MOVIE}/get`;
const GET_TV = `${APP}/tv/${T_TV}/get`;
const SEED = { version: 7, grants: {}, groups: {}, catalog: { items: {} }, passwordlessUserIds: [], appIdKey: 'ef'.repeat(32) };
/** The first request the fake Seerr makes. */
const FIRST = 7350001;
const AS_BOB = { host: HOST_B, user: BOB };
const [HOME, OTHER] = HOUSEHOLDS.map((household) => household.id);
const MOVIE_TAG = `jfa:private:${ITEMS.tMovie}`;

const start = (t, state, options = {}) => startApp(t, state, { reconcile: true, stateFile: SEED, libraryTtlMs: 0, ...options });
const movieItem = () => ({ Id: ITEMS.tMovie, Name: 'Synthetic Movie One', Type: 'Movie', ProviderIds: { Tmdb: String(T_MOVIE) }, Tags: [], library: 'shared' });

/** A POST as a household member, then the background work it started. */
async function member(app, pathname, body, options) {
  const answer = await app.post(pathname, body, options);
  await app.background.settled();
  return answer;
}

const getThis = (app, options) => member(app, GET_MOVIE, undefined, options);
const entries = async (app, options) => (await app.get(`${APP}/requests`, options)).json().results;
const movieState = async (app, options) => (await app.get(`${APP}/movie/${T_MOVIE}`, options)).json().state;

const admin = (app, pathname, { method = 'GET', body, headers = { Authorization: 'Bearer admin-secret' }, host = 'jellypass.example.test' } = {}) =>
  get(app.portFor(host), pathname, { Host: host, ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, { method, body: body && JSON.stringify(body) });
const listing = async (app) => (await admin(app, '/v1/app/requests')).json();
const act = (app, requestId, action, body) => admin(app, `/v1/app/requests/${requestId}/${action}`, { method: 'POST', body });

function seerrRequestOf(app, id) {
  return Object.values(app.seerr.state.requests).flat().find((entry) => entry.id === id);
}

const webhook = (app, requestId, requester) => app.webhook({
  notificationType: 'MEDIA_AVAILABLE',
  event: 'Movie Request Now Available',
  media: { mediaType: 'movie', jellyfinMediaId: ITEMS.tMovie },
  request: { id: String(requestId), requestedBy: { jellyfinUserId: requester } },
});

const blocked = (app, userId) => (app.jellyfin.state.jellyfinUsers[userId].Policy.BlockedTags ?? []).includes(MOVIE_TAG);
const statuses = (app) => app.store.listAppRequests().map(([, record]) => [record.householdId, record.branch, record.status]).sort();

/** Alice asks for the movie and Bob's household follows her request. */
async function followed(t, options = {}, startOptions = {}) {
  const app = await start(t, world(options), startOptions);
  await getThis(app);
  await getThis(app, AS_BOB);
  assert.deepEqual(statuses(app), [[HOME, 'request', 'pending'], [OTHER, 'interest', 'pending']]);
  return app;
}

/** A Seerr user no Jellyfin user is linked to (live Seerr has one: user 15), and the pending request it made of the movie. */
const UNLINKED = 15;
const UNLINKED_REQUEST = 7380101;

/** The unlinked Seerr user's request, which both households follow as an interest ("Get this" joins it). */
async function followedUnlinked(t, options = {}, startOptions = {}) {
  const made = seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: options.autoApprove ? 2 : 1 });
  made.id = UNLINKED_REQUEST;
  made.requestedBy = { ...made.requestedBy, id: UNLINKED, jellyfinUserId: null };
  const app = await start(t, world({ ...options, requests: { [UNLINKED]: [made] } }), startOptions);
  await getThis(app);
  await getThis(app, AS_BOB);
  assert.deepEqual(statuses(app), [[HOME, 'interest', 'pending'], [OTHER, 'interest', 'pending']]);
  assert.deepEqual(app.store.listAppRequests().map(([, record]) => record.seerrRequestId), [String(UNLINKED_REQUEST), String(UNLINKED_REQUEST)]);
  return app;
}

describe('admin requests: who may call it', { timeout: 60_000 }, () => {
  it('answers only the administrator, and only on the admin host', async (t) => {
    const app = await followed(t);
    for (const headers of [{}, { Authorization: 'Bearer webhook-secret' }, { Authorization: 'Bearer wrong' }]) {
      assert.equal((await admin(app, '/v1/app/requests', { headers })).status, 401);
      for (const action of ['approve', 'decline', 'cancel']) {
        assert.equal((await admin(app, `/v1/app/requests/${FIRST}/${action}`, { method: 'POST', headers })).status, 401, action);
      }
      assert.equal((await admin(app, `/v1/app/held/${FIRST}/release`, { method: 'POST', headers, body: { householdIds: [OTHER] } })).status, 401);
    }
    for (const host of [HOST_A, HOST_B]) {
      for (const headers of [{ Authorization: 'Bearer admin-secret' }, { Authorization: 'MediaBrowser Token="token-alice"' }, {}]) {
        const answer = await admin(app, '/v1/app/requests', { headers, host });
        assert.notEqual(answer.status, 200, host);
        assert.doesNotMatch(answer.text, /requests|held|radarr/, host);
        const action = await admin(app, `/v1/app/requests/${FIRST}/cancel`, { method: 'POST', headers, host });
        assert.notEqual(action.status, 200, host);
      }
    }
    // Nothing reached Seerr's admin writes, and every household still follows the request.
    assert.deepEqual(app.seerr.adminWrites, []);
    assert.deepEqual(statuses(app), [[HOME, 'request', 'pending'], [OTHER, 'interest', 'pending']]);
  });

  it('refuses a malformed request ID, a body other than JSON, an unknown field and a request no household follows', async (t) => {
    const app = await followed(t);
    for (const id of ['abc', '0', '-1', '1'.repeat(17)]) {
      const answer = await act(app, id, 'approve');
      assert.equal(answer.status, 400, id);
    }
    assert.equal((await act(app, 7389999, 'approve')).status, 404);
    assert.equal((await act(app, 7389999, 'cancel')).status, 404);
    assert.equal((await act(app, FIRST, 'cancel', { removeFromRadarr: 'yes' })).status, 400);
    assert.equal((await act(app, FIRST, 'cancel', { remove: true })).status, 400);
    const plain = await get(app.adminPort, `/v1/app/requests/${FIRST}/cancel`, {
      Host: 'jellypass.example.test', Authorization: 'Bearer admin-secret', 'Content-Type': 'text/plain',
    }, { method: 'POST', body: '{}' });
    assert.equal(plain.status, 415);
    assert.deepEqual(app.seerr.adminWrites, []);
  });

  it('limits the actions to 60 a minute, all administrators together', async (t) => {
    const app = await followed(t, { autoApprove: true });
    for (let index = 0; index < 60; index += 1) assert.equal((await act(app, FIRST, 'approve')).status, 200);
    const limited = await act(app, FIRST, 'approve');
    assert.deepEqual([limited.status, limited.json()], [429, { error: 'too_many_requests' }]);
    // Listing is not an action.
    assert.equal((await admin(app, '/v1/app/requests')).status, 200);
  });
});

describe('admin requests: the listing', { timeout: 60_000 }, () => {
  it('lists each request once, with its title, requester, household, followers and the actions offered, and no secrets', async (t) => {
    const app = await followed(t);
    const listed = await listing(app);
    assert.equal(listed.radarr, true);
    assert.deepEqual(listed.held, []);
    assert.equal(listed.requests.length, 1);
    const [row] = listed.requests;
    assert.deepEqual(row, {
      requestId: String(FIRST),
      mediaType: 'movie',
      tmdbId: T_MOVIE,
      title: 'Synthetic Movie One',
      year: 2020,
      seasons: [],
      status: 'requested',
      seerrStatus: 'pending',
      requester: { id: ALICE, name: 'Alice' },
      householdId: HOME,
      householdName: HOUSEHOLDS[0].name,
      requestedOn: app.store.listAppRequests()[0][1].createdAt.slice(0, 10),
      followers: 1,
      households: [{ id: HOME, name: HOUSEHOLDS[0].name, status: 'requested' }, { id: OTHER, name: HOUSEHOLDS[1].name, status: 'requested' }],
      withdrawn: false,
      held: false,
      actions: { approve: true, decline: true, cancel: true, removeFromRadarr: true },
    });
    assert.match(row.requestedOn, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    assert.doesNotMatch(JSON.stringify(listed), /canary-radarr-key|radarr\.canary|example\.invalid|apiKey|T[0-9]{2}:[0-9]{2}/);
  });

  it('offers "Also remove from Radarr" only for a movie Jellyfin does not have, with an HD Radarr server in Seerr', async (t) => {
    const series = await start(t, world());
    await member(series, GET_TV, { seasons: [1] });
    assert.deepEqual((await listing(series)).requests.map((row) => [row.mediaType, row.actions.cancel, row.actions.removeFromRadarr]), [['tv', true, false]]);

    const noRadarr = await followed(t, { radarrServers: [{ id: 1, is4k: true, isDefault: true, apiKey: 'canary-radarr-key' }] });
    const listed = await listing(noRadarr);
    assert.deepEqual([listed.radarr, listed.requests[0].actions.removeFromRadarr], [false, false]);

    // Jellyfin has the movie (it arrived, and no webhook has granted it yet).
    const present = await followed(t);
    present.jellyfin.state.items.push(movieItem());
    assert.deepEqual((await listing(present)).requests[0].actions, { approve: true, decline: true, cancel: true, removeFromRadarr: false });
  });
});

describe('admin requests: approve and decline', { timeout: 60_000 }, () => {
  it('approves a pending request in Seerr; the households keep following it, and approving again changes nothing', async (t) => {
    const app = await followed(t);
    const answer = await act(app, FIRST, 'approve');
    assert.deepEqual([answer.status, answer.json()], [200, { status: 'approved', changed: true }]);
    assert.equal(seerrRequestOf(app, FIRST).status, 2);
    assert.deepEqual(app.seerr.adminWrites, [`POST /api/v1/request/${FIRST}/approve`]);
    assert.deepEqual(statuses(app), [[HOME, 'request', 'pending'], [OTHER, 'interest', 'pending']]);
    assert.deepEqual((await act(app, FIRST, 'approve')).json(), { status: 'approved', changed: false });
    assert.equal(app.seerr.adminWrites.length, 1);
    assert.deepEqual((await listing(app)).requests[0].actions, { approve: false, decline: false, cancel: true, removeFromRadarr: true });
    for (const options of [{}, AS_BOB]) assert.deepEqual((await entries(app, options)).map((entry) => entry.status), ['requested']);
  });

  it('declines a pending request in Seerr, and every household following it sees "We couldn\'t get this" at once', async (t) => {
    const app = await followed(t);
    const answer = await act(app, FIRST, 'decline');
    assert.deepEqual([answer.status, answer.json()], [200, { status: 'declined', changed: true }]);
    assert.equal(seerrRequestOf(app, FIRST).status, 3);
    assert.deepEqual(statuses(app), [[HOME, 'request', 'declined'], [OTHER, 'interest', 'declined']]);
    for (const options of [{}, AS_BOB]) assert.deepEqual((await entries(app, options)).map((entry) => entry.status), ['failed']);
    assert.deepEqual((await act(app, FIRST, 'decline')).json(), { status: 'declined', changed: false });
    assert.equal(app.seerr.adminWrites.length, 1);
    // A declined request is approved or cancelled no more.
    assert.deepEqual([(await act(app, FIRST, 'approve')).json().code, (await act(app, FIRST, 'cancel')).json().code], ['request_declined', 'request_not_cancellable']);
  });

  it('keeps a declined request\'s households from a title that still arrives through it: held for no household, by every arrival path', async (t) => {
    const app = await followed(t);
    assert.deepEqual((await act(app, FIRST, 'decline')).json(), { status: 'declined', changed: true });
    const [[requestId, withdrawal]] = app.store.listAppWithdrawals();
    assert.deepEqual([requestId, withdrawal.requester, withdrawal.householdIds, withdrawal.requesterId, typeof withdrawal.declinedAt],
      [String(FIRST), true, [HOME, OTHER], ALICE, 'string']);
    // The row is declined, not withdrawn.
    assert.deepEqual((({ status, withdrawn, held: isHeld }) => ({ status, withdrawn, held: isHeld }))((await listing(app)).requests[0]),
      { status: 'declined', withdrawn: false, held: false });
    // A late MEDIA_AVAILABLE (and its replay) for the declined request gives neither household the title.
    app.jellyfin.state.items.push(movieItem());
    await app.requests.refresh();
    assert.ok([200, 202].includes((await webhook(app, FIRST, ALICE)).status));
    assert.ok([200, 202].includes((await webhook(app, FIRST, ALICE)).status));
    const grant = app.store.get(ITEMS.tMovie);
    assert.deepEqual([grant.active, Object.keys(grant.requests), grant.groupIds, grant.owners], [true, [String(FIRST)], [], []]);
    for (const user of [ALICE, BOB]) assert.ok(blocked(app, user), user);
    assert.deepEqual(statuses(app), [[HOME, 'request', 'declined'], [OTHER, 'interest', 'declined']]);
    for (const options of [{}, AS_BOB]) assert.deepEqual((await entries(app, options)).map((entry) => entry.status), ['failed']);
    assert.deepEqual((await listing(app)).held.map((title) => [title.requestId, title.itemId]), [[String(FIRST), ITEMS.tMovie]]);
    await app.requests.refresh();
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, []);
  });

  it('holds a title that arrives through a declined request of a Seerr user no Jellyfin user is linked to, by every arrival path', async (t) => {
    const app = await followedUnlinked(t);
    assert.deepEqual((await act(app, UNLINKED_REQUEST, 'decline')).json(), { status: 'declined', changed: true });
    // Seerr still has the request (declined), and its requester has no Jellyfin ID: the grant records nobody.
    app.jellyfin.state.items.push(movieItem());
    seerrRequestOf(app, UNLINKED_REQUEST).media.jellyfinMediaId = ITEMS.tMovie;
    assert.ok([200, 202].includes((await webhook(app, UNLINKED_REQUEST, '')).status));
    const grant = app.store.get(ITEMS.tMovie);
    assert.deepEqual([grant?.active, grant?.requests, grant?.groupIds, grant?.owners], [true, { [String(UNLINKED_REQUEST)]: '' }, [], []]);
    for (const user of [ALICE, BOB]) assert.ok(blocked(app, user), user);
    assert.deepEqual((await listing(app)).held.map((title) => [title.requestId, title.itemId]), [[String(UNLINKED_REQUEST), ITEMS.tMovie]]);
    await app.requests.refresh();
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, []);

    // The backfill, for a request no webhook came for, does the same.
    const missed = await followedUnlinked(t);
    assert.deepEqual((await act(missed, UNLINKED_REQUEST, 'decline')).json(), { status: 'declined', changed: true });
    missed.jellyfin.state.items.push(movieItem());
    const made = seerrRequestOf(missed, UNLINKED_REQUEST);
    made.status = 2;
    made.media = { ...made.media, status: 5, jellyfinMediaId: ITEMS.tMovie };
    await missed.service.backfillRequests(new Date(0));
    const backfilled = missed.store.get(ITEMS.tMovie);
    assert.deepEqual([backfilled?.requests, backfilled?.groupIds, backfilled?.owners], [{ [String(UNLINKED_REQUEST)]: '' }, [], []]);
    for (const user of [ALICE, BOB]) assert.ok(blocked(missed, user), user);
  });

  // Codex's repro (PR #111): a declined request that an administrator then deletes in Seerr must keep its protection,
  // against the title arriving with no request to scan and against a late MEDIA_AVAILABLE for the request alike.
  describe('a declined request Seerr then forgets', () => {
    const forget = (app, id) => {
      for (const [seerrId, requests] of Object.entries(app.seerr.state.requests)) app.seerr.state.requests[seerrId] = requests.filter((entry) => entry.id !== id);
    };
    /** Alice's request, followed by Bob's household, declined, then deleted in Seerr; the refresh runs 11 minutes on. */
    async function declinedThenForgotten(t) {
      let clock = Date.now();
      const app = await followed(t, {}, { now: () => clock });
      assert.deepEqual((await act(app, FIRST, 'decline')).json(), { status: 'declined', changed: true });
      forget(app, FIRST);
      assert.equal(seerrRequestOf(app, FIRST), undefined);
      clock += 11 * 60 * 1000;
      await app.requests.refresh();
      return app;
    }

    it('becomes a title hold: the title that arrives is held for no household, and a late webhook gives none of them it', async (t) => {
      const app = await declinedThenForgotten(t);
      assert.deepEqual(app.store.listAppWithdrawals().map(([requestId, withdrawal]) => [requestId, withdrawal.requesterId, withdrawal.householdIds, withdrawal.seerrGoneAt !== undefined, typeof withdrawal.declinedAt]),
        [[String(FIRST), ALICE, [HOME, OTHER], true, 'string']]);
      const outstanding = (await admin(app, '/v1/app/outstanding')).json();
      assert.deepEqual([outstanding.clear, outstanding.withdrawals.total, outstanding.withdrawals.titleHolds], [false, 1, 1]);
      app.jellyfin.state.items.push(movieItem());
      await app.requests.refresh();
      const grant = app.store.get(ITEMS.tMovie);
      assert.deepEqual([grant?.active, Object.keys(grant?.requests ?? {}), grant?.groupIds, grant?.owners], [true, [String(FIRST)], [], []]);
      for (const user of [ALICE, BOB]) assert.ok(blocked(app, user), user);
      assert.deepEqual((await listing(app)).held.map((title) => [title.requestId, title.itemId]), [[String(FIRST), ITEMS.tMovie]]);
      // The late MEDIA_AVAILABLE (handled already) changes nothing.
      assert.ok([200, 202].includes((await webhook(app, FIRST, ALICE)).status));
      assert.deepEqual([app.store.get(ITEMS.tMovie).groupIds, app.store.get(ITEMS.tMovie).owners], [[], []]);
      for (const user of [ALICE, BOB]) assert.ok(blocked(app, user), user);
      assert.deepEqual(statuses(app), [[HOME, 'request', 'declined'], [OTHER, 'interest', 'declined']]);
      // The hold is applied: it stays a withdrawal (keeping the requester out), no longer a hold.
      assert.deepEqual(app.store.listAppTitleHolds(), []);
      assert.deepEqual(app.store.listAppWithdrawals().map(([requestId, withdrawal]) => [requestId, withdrawal.seerrGoneAt]), [[String(FIRST), undefined]]);
    });

    it('refuses the declined households a late webhook that comes before any hold is applied', async (t) => {
      const app = await declinedThenForgotten(t);
      app.jellyfin.state.items.push(movieItem());
      assert.ok([200, 202].includes((await webhook(app, FIRST, ALICE)).status));
      const grant = app.store.get(ITEMS.tMovie);
      assert.deepEqual([grant?.active, Object.keys(grant?.requests ?? {}), grant?.groupIds, grant?.owners], [true, [String(FIRST)], [], []]);
      for (const user of [ALICE, BOB]) assert.ok(blocked(app, user), user);
      await app.requests.refresh();
      assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, []);
      assert.deepEqual((await listing(app)).held.map((title) => [title.requestId, title.itemId]), [[String(FIRST), ITEMS.tMovie]]);
    });

    // Codex's repro (PR #111): the requester is a Seerr user no Jellyfin user is linked to, so the hold cannot record
    // them; it must not depend on their Jellyfin ID.
    it('becomes a title hold for a Seerr user no Jellyfin user is linked to, followed by both households', async (t) => {
      let clock = Date.now();
      const app = await followedUnlinked(t, {}, { now: () => clock });
      assert.deepEqual((await act(app, UNLINKED_REQUEST, 'decline')).json(), { status: 'declined', changed: true });
      const [[requestId, withdrawal]] = app.store.listAppWithdrawals();
      assert.deepEqual([requestId, withdrawal.requester, withdrawal.titleHold, withdrawal.requesterId, withdrawal.householdIds],
        [String(UNLINKED_REQUEST), true, true, undefined, [HOME, OTHER]]);
      forget(app, UNLINKED_REQUEST);
      clock += 11 * 60 * 1000;
      await app.requests.refresh();
      assert.deepEqual(app.store.listAppTitleHolds().map(([id, hold]) => [id, hold.seerrGoneAt !== undefined]), [[String(UNLINKED_REQUEST), true]]);
      const outstanding = (await admin(app, '/v1/app/outstanding')).json();
      assert.deepEqual([outstanding.clear, outstanding.withdrawals.total, outstanding.withdrawals.titleHolds], [false, 1, 1]);
      // A late MEDIA_AVAILABLE before the hold is applied (Seerr has no Jellyfin ID for the requester) gives it nobody.
      app.jellyfin.state.items.push(movieItem());
      await webhook(app, UNLINKED_REQUEST, '');
      for (const user of [ALICE, BOB]) assert.ok(blocked(app, user), user);
      const grant = app.store.get(ITEMS.tMovie);
      assert.deepEqual([grant?.active, grant?.requests, grant?.groupIds, grant?.owners], [true, { [String(UNLINKED_REQUEST)]: '' }, [], []]);
      for (const user of [ALICE, BOB]) assert.ok(blocked(app, user), user);
      assert.deepEqual((await listing(app)).held.map((title) => [title.requestId, title.itemId]), [[String(UNLINKED_REQUEST), ITEMS.tMovie]]);
      // A late MEDIA_AVAILABLE after it (handled already) changes nothing either.
      assert.ok([200, 202].includes((await webhook(app, UNLINKED_REQUEST, '')).status));
      assert.deepEqual([app.store.get(ITEMS.tMovie).groupIds, app.store.get(ITEMS.tMovie).owners], [[], []]);
      for (const user of [ALICE, BOB]) assert.ok(blocked(app, user), user);
      assert.deepEqual(statuses(app), [[HOME, 'interest', 'declined'], [OTHER, 'interest', 'declined']]);
      // The hold is applied: it stays a withdrawal (keeping the unknown requester out), no longer a hold.
      assert.deepEqual(app.store.listAppTitleHolds(), []);
      assert.deepEqual(app.store.listAppWithdrawals().map(([id, kept]) => [id, kept.seerrGoneAt]), [[String(UNLINKED_REQUEST), undefined]]);
      // Released to one household, it is that household's only.
      assert.deepEqual((await admin(app, `/v1/app/held/${UNLINKED_REQUEST}/release`, { method: 'POST', body: { householdIds: [OTHER] } })).json(),
        { status: 'released', changed: true, itemId: ITEMS.tMovie });
      assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, [OTHER]);
      assert.ok(blocked(app, ALICE));
      assert.ok(!blocked(app, BOB));
    });

    it('is forgotten for a join request: no title hold, and its grant follows the join rules, never a new grant', async (t) => {
      // Bob's private grant of the series, with season 1; household A asks for season 2, which Jellyfin lacks.
      let clock = Date.now();
      const series = { Id: ITEMS.tSeries, Name: 'Synthetic Series Two', Type: 'Series', ProviderIds: { Tmdb: String(T_TV) }, Tags: [], library: 'shared' };
      const episode = (season) => ({ Id: `4444000044440000444400004444000${season}`, SeriesId: ITEMS.tSeries, ParentIndexNumber: season });
      const app = await start(t, world({
        items: [series],
        episodes: [episode(1)],
        grants: [{ request: { itemId: ITEMS.tSeries, mediaType: 'tv', requestId: '7300502', userId: BOB, groupIds: [OTHER] } }],
      }), { now: () => clock });
      await member(app, GET_TV, { seasons: [2] });
      assert.equal(app.store.listAppRequests()[0][1].joinOnGrant, 'existing-series');
      assert.deepEqual((await act(app, FIRST, 'decline')).json(), { status: 'declined', changed: true });
      assert.deepEqual(app.store.listAppWithdrawals().map(([requestId, withdrawal]) => [requestId, withdrawal.requesterId]), [[String(FIRST), undefined]]);
      forget(app, FIRST);
      clock += 11 * 60 * 1000;
      await app.requests.refresh();
      assert.deepEqual([app.store.listAppWithdrawals(), app.store.listAppTitleHolds()], [[], []]);
      app.jellyfin.state.episodes.push(episode(2));
      await app.requests.refresh();
      assert.ok([200, 202].includes((await app.webhook({
        notificationType: 'MEDIA_AVAILABLE',
        event: 'Series Request Now Available',
        media: { mediaType: 'tv', jellyfinMediaId: ITEMS.tSeries },
        request: { id: String(FIRST), requestedBy: { jellyfinUserId: ALICE } },
      })).status));
      const grant = app.store.get(ITEMS.tSeries);
      assert.deepEqual([Object.keys(grant.requests), grant.groupIds], [['7300502'], [OTHER]]);
      assert.equal((await admin(app, '/v1/app/held')).json().total, 0);
    });
  });

  it('writes the declined marker in the same turn of the write queue as Seerr\'s decline, so no webhook grants in between', async (t) => {
    const app = await followed(t);
    app.jellyfin.state.items.push(movieItem());
    // A MEDIA_AVAILABLE arrives while Seerr is declining the request: it waits for the decline's turn to end.
    let delivered;
    app.seerr.state.onAdminWrite = (method, pathname) => {
      if (method === 'POST' && pathname.endsWith('/decline')) delivered = webhook(app, FIRST, ALICE);
    };
    assert.deepEqual((await act(app, FIRST, 'decline')).json(), { status: 'declined', changed: true });
    assert.ok(delivered);
    assert.ok([200, 202].includes((await delivered).status));
    assert.deepEqual([app.store.get(ITEMS.tMovie).groupIds, app.store.get(ITEMS.tMovie).owners], [[], []]);
    for (const user of [ALICE, BOB]) assert.ok(blocked(app, user), user);
  });

  it('declines only a pending request', async (t) => {
    const app = await followed(t, { autoApprove: true });
    const answer = await act(app, FIRST, 'decline');
    assert.deepEqual([answer.status, answer.json().code], [409, 'request_not_pending']);
    assert.deepEqual(app.seerr.adminWrites, []);
    assert.deepEqual(statuses(app), [[HOME, 'request', 'pending'], [OTHER, 'interest', 'pending']]);
  });
});

describe('admin requests: cancel', { timeout: 60_000 }, () => {
  it('sends every household back to Get this, writes the title hold before Seerr deletes the request, and holds what arrives', async (t) => {
    const app = await followed(t, { autoApprove: true });
    // What the state file holds when Seerr is asked to delete the request.
    let onDisk;
    app.seerr.state.onAdminWrite = (method) => {
      if (method === 'DELETE') onDisk = JSON.parse(readFileSync(app.stateFile, 'utf8'));
    };
    const answer = await act(app, FIRST, 'cancel');
    assert.deepEqual([answer.status, answer.json()], [200, { status: 'cancelled', changed: true, titleHold: true, removedFromRadarr: false }]);
    assert.deepEqual(app.seerr.adminWrites, [`DELETE /api/v1/request/${FIRST}`]);
    assert.equal(seerrRequestOf(app, FIRST), undefined);
    const before = onDisk.appWithdrawals[String(FIRST)];
    assert.deepEqual([before.requester, before.requesterId, before.householdIds, before.seerrGoneAt], [true, ALICE, [HOME, OTHER], undefined]);
    assert.deepEqual(Object.values(onDisk.appRequests).map((record) => record.status).sort(), ['deleted', 'deleted']);
    // Decision 3: every household is back to Get this, with nothing listed.
    assert.deepEqual(statuses(app), [[HOME, 'request', 'deleted'], [OTHER, 'interest', 'deleted']]);
    for (const options of [{}, AS_BOB]) {
      assert.deepEqual(await entries(app, options), []);
      assert.equal(await movieState(app, options), 'get_this');
    }
    const outstanding = (await admin(app, '/v1/app/outstanding')).json();
    assert.deepEqual([outstanding.clear, outstanding.withdrawals.titleHolds], [false, 1]);
    // Repeated: nothing more happens.
    assert.deepEqual((await act(app, FIRST, 'cancel')).json(), { status: 'cancelled', changed: false, titleHold: true, removedFromRadarr: false });
    assert.equal(app.seerr.adminWrites.length, 1);

    // The download went on: the movie arrives with no request, and is held for no household.
    app.jellyfin.state.items.push(movieItem());
    await app.requests.refresh();
    const grant = app.store.get(ITEMS.tMovie);
    assert.deepEqual([grant.active, Object.keys(grant.requests), grant.groupIds, grant.owners], [true, [String(FIRST)], [], []]);
    for (const user of [ALICE, BOB]) assert.ok(blocked(app, user), user);
    const listed = await listing(app);
    assert.deepEqual(listed.held.map(({ requestId, itemId, title, mediaType }) => [requestId, itemId, title, mediaType]),
      [[String(FIRST), ITEMS.tMovie, 'Synthetic Movie One', 'movie']]);
  });

  it('holds what arrives for a Seerr user no Jellyfin user is linked to, followed by both households', async (t) => {
    let clock = Date.now();
    const app = await followedUnlinked(t, { autoApprove: true }, { now: () => clock });
    const answer = await act(app, UNLINKED_REQUEST, 'cancel');
    assert.deepEqual([answer.status, answer.json()], [200, { status: 'cancelled', changed: true, titleHold: true, removedFromRadarr: false }]);
    assert.equal(seerrRequestOf(app, UNLINKED_REQUEST), undefined);
    assert.deepEqual(app.store.listAppTitleHolds().map(([id, hold]) => [id, hold.titleHold, hold.requesterId, hold.householdIds]),
      [[String(UNLINKED_REQUEST), true, undefined, [HOME, OTHER]]]);
    assert.deepEqual(statuses(app), [[HOME, 'interest', 'deleted'], [OTHER, 'interest', 'deleted']]);
    clock += 11 * 60 * 1000;
    await app.requests.refresh();
    assert.equal(app.store.listAppTitleHolds().length, 1);
    app.jellyfin.state.items.push(movieItem());
    await app.requests.refresh();
    const grant = app.store.get(ITEMS.tMovie);
    assert.deepEqual([grant?.active, grant?.requests, grant?.groupIds, grant?.owners], [true, { [String(UNLINKED_REQUEST)]: '' }, [], []]);
    for (const user of [ALICE, BOB]) assert.ok(blocked(app, user), user);
    assert.deepEqual((await listing(app)).held.map((title) => [title.requestId, title.itemId]), [[String(UNLINKED_REQUEST), ITEMS.tMovie]]);
  });

  it('keeps the households withdrawn when Seerr cannot delete the request, so a title that then arrives is held, never given', async (t) => {
    const app = await followed(t, { autoApprove: true });
    app.seerr.state.failAdminWrites = '/api/v1/request/';
    const answer = await act(app, FIRST, 'cancel');
    assert.equal(answer.status, 502);
    assert.doesNotMatch(answer.text, /canary|seerr-key|api\/v1/);
    assert.equal(seerrRequestOf(app, FIRST).status, 2);
    assert.deepEqual(statuses(app), [[HOME, 'request', 'deleted'], [OTHER, 'interest', 'deleted']]);
    const [[requestId, withdrawal]] = app.store.listAppWithdrawals();
    assert.deepEqual([requestId, withdrawal.requester, withdrawal.requesterId], [String(FIRST), true, ALICE]);
    // The request completes and its webhook comes: neither household is given it.
    app.jellyfin.state.items.push(movieItem());
    seerrRequestOf(app, FIRST).status = 5;
    assert.ok([200, 202].includes((await webhook(app, FIRST, ALICE)).status));
    const grant = app.store.get(ITEMS.tMovie);
    assert.deepEqual([grant.groupIds, grant.owners], [[], []]);
    for (const user of [ALICE, BOB]) assert.ok(blocked(app, user), user);
    // Too late to cancel now.
    app.seerr.state.failAdminWrites = undefined;
    assert.deepEqual([(await act(app, FIRST, 'cancel')).status], [409]);
  });

  it('refuses to cancel a request once it was granted: access is revoked in Grants instead', async (t) => {
    const app = await followed(t, { autoApprove: true });
    app.jellyfin.state.items.push(movieItem());
    seerrRequestOf(app, FIRST).status = 5;
    await webhook(app, FIRST, ALICE);
    const answer = await act(app, FIRST, 'cancel');
    assert.deepEqual([answer.status, answer.json().code], [409, 'request_granted']);
    assert.deepEqual(app.seerr.adminWrites, []);
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, [HOME, OTHER]);
    assert.equal((await listing(app)).requests[0].actions.cancel, false);
  });

  it('removes a movie Jellyfin does not have from Radarr before deleting its request, when asked', async (t) => {
    const app = await followed(t, { autoApprove: true });
    const mediaId = seerrRequestOf(app, FIRST).media.id;
    const answer = await act(app, FIRST, 'cancel', { removeFromRadarr: true });
    assert.deepEqual(answer.json(), { status: 'cancelled', changed: true, titleHold: true, removedFromRadarr: true });
    assert.deepEqual(app.seerr.adminWrites, [`DELETE /api/v1/media/${mediaId}/file`, `DELETE /api/v1/request/${FIRST}`]);
    assert.deepEqual(app.seerr.radarrRemovals, [mediaId]);
  });

  it('never removes from Radarr a series, a movie Jellyfin has, or without an HD Radarr server: refused before anything changes', async (t) => {
    const series = await start(t, world({ autoApprove: true }));
    await member(series, GET_TV, { seasons: [1] });
    const refusedSeries = await act(series, FIRST, 'cancel', { removeFromRadarr: true });
    assert.deepEqual([refusedSeries.status, refusedSeries.json().code], [409, 'radarr_removal_not_offered']);

    const present = await followed(t, { autoApprove: true });
    present.jellyfin.state.items.push(movieItem());
    const refusedPresent = await act(present, FIRST, 'cancel', { removeFromRadarr: true });
    assert.deepEqual([refusedPresent.status, refusedPresent.json().code], [409, 'radarr_removal_not_offered']);

    const noRadarr = await followed(t, { autoApprove: true, radarrServers: [] });
    const refusedNoRadarr = await act(noRadarr, FIRST, 'cancel', { removeFromRadarr: true });
    assert.deepEqual([refusedNoRadarr.status, refusedNoRadarr.json().code], [409, 'radarr_removal_not_offered']);

    for (const app of [series, present, noRadarr]) {
      assert.deepEqual(app.seerr.adminWrites, []);
      assert.deepEqual(app.seerr.radarrRemovals, []);
      assert.deepEqual(app.store.listAppWithdrawals(), []);
      assert.ok(app.store.listAppRequests().every(([, record]) => record.status === 'pending'));
    }
  });

  it('holds a title that arrived before the cancel but was not granted yet: never public once Seerr forgets the request', async (t) => {
    const app = await followed(t, { autoApprove: true });
    // The movie is in Jellyfin, but no MEDIA_AVAILABLE webhook granted it yet.
    app.jellyfin.state.items.push(movieItem());
    assert.equal(app.store.get(ITEMS.tMovie), undefined);
    const answer = await act(app, FIRST, 'cancel');
    assert.deepEqual(answer.json(), { status: 'cancelled', changed: true, titleHold: true, removedFromRadarr: false });
    assert.deepEqual(app.store.listAppWithdrawals().map(([requestId, withdrawal]) => [requestId, withdrawal.requesterId, withdrawal.seerrGoneAt !== undefined]),
      [[String(FIRST), ALICE, true]]);
    await app.requests.refresh();
    const grant = app.store.get(ITEMS.tMovie);
    assert.deepEqual([grant.active, Object.keys(grant.requests), grant.groupIds, grant.owners], [true, [String(FIRST)], [], []]);
    for (const user of [ALICE, BOB]) assert.ok(blocked(app, user), user);
    assert.deepEqual((await listing(app)).held.map((title) => [title.requestId, title.itemId]), [[String(FIRST), ITEMS.tMovie]]);
    assert.deepEqual(statuses(app), [[HOME, 'request', 'deleted'], [OTHER, 'interest', 'deleted']]);
  });

  it('keeps no title hold when every item Jellyfin has of the title is on an active grant already', async (t) => {
    const app = await followed(t, { autoApprove: true });
    app.jellyfin.state.items.push(movieItem());
    // Another request granted the movie (to Bob's household) before this one was cancelled.
    await app.store.grant({ itemId: ITEMS.tMovie, requestId: '7389001', userId: BOB, groupIds: [OTHER] });
    const answer = await act(app, FIRST, 'cancel');
    assert.deepEqual(answer.json(), { status: 'cancelled', changed: true, titleHold: false, removedFromRadarr: false });
    assert.deepEqual(app.store.listAppWithdrawals(), []);
    await app.requests.refresh();
    assert.deepEqual(Object.keys(app.store.get(ITEMS.tMovie).requests), ['7389001']);
    assert.deepEqual(statuses(app), [[HOME, 'request', 'deleted'], [OTHER, 'interest', 'deleted']]);
  });
});

describe('admin requests: releasing a held title', { timeout: 60_000 }, () => {
  /** Alice asks (approved at once) and cancels it herself; the movie then arrives and is held for no household. */
  async function held(t) {
    const app = await start(t, world({ autoApprove: true }));
    await getThis(app);
    const [entry] = await entries(app);
    await member(app, `${APP}/requests/${entry.id}/cancel`);
    app.jellyfin.state.items.push(movieItem());
    seerrRequestOf(app, FIRST).status = 5;
    await webhook(app, FIRST, ALICE);
    assert.deepEqual((await listing(app)).held.map((title) => title.requestId), [String(FIRST)]);
    return app;
  }

  it('gives the title to the chosen households only', async (t) => {
    const app = await held(t);
    const answer = await admin(app, `/v1/app/held/${FIRST}/release`, { method: 'POST', body: { householdIds: [OTHER] } });
    assert.deepEqual([answer.status, answer.json()], [200, { status: 'released', changed: true, itemId: ITEMS.tMovie }]);
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, [OTHER]);
    assert.ok(!blocked(app, BOB));
    assert.ok(blocked(app, ALICE));
    assert.equal(await movieState(app, AS_BOB), 'in_library');
    assert.equal(await movieState(app), 'get_this');
    assert.deepEqual((await listing(app)).held, []);
    // Again: the same answer, unchanged; another household is refused (it is no longer held).
    assert.deepEqual((await admin(app, `/v1/app/held/${FIRST}/release`, { method: 'POST', body: { householdIds: [OTHER] } })).json(),
      { status: 'released', changed: false, itemId: ITEMS.tMovie });
    assert.equal((await admin(app, `/v1/app/held/${FIRST}/release`, { method: 'POST', body: { householdIds: [HOME] } })).status, 409);
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, [OTHER]);
  });

  it('lets only the first of two concurrent releases to different households take effect, and refuses the other', async (t) => {
    const app = await held(t);
    const release = (householdIds) => admin(app, `/v1/app/held/${FIRST}/release`, { method: 'POST', body: { householdIds } });
    // The write queue is busy (a webhook, say) while both arrive: both are decided only once it is free.
    let free;
    const busy = app.service.serialized(() => new Promise((resolve) => { free = resolve; }));
    const pending = Promise.all([release([OTHER]), release([HOME])]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    free();
    await busy;
    const answers = await pending;
    const won = answers.findIndex((answer) => answer.status === 200);
    assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 409]);
    assert.deepEqual(answers[won].json(), { status: 'released', changed: true, itemId: ITEMS.tMovie });
    assert.equal(answers[1 - won].json().code, 'title_not_held');
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, [[OTHER], [HOME]][won]);
    // Two concurrent releases to the same household: one changed, the other the same outcome unchanged.
    const again = await Promise.all([release([[OTHER], [HOME]][won]), release([[OTHER], [HOME]][won])]);
    assert.deepEqual(again.map((answer) => [answer.status, answer.json().changed]), [[200, false], [200, false]]);
  });

  it('answers two concurrent releases to the same household with one change', async (t) => {
    const app = await held(t);
    const release = () => admin(app, `/v1/app/held/${FIRST}/release`, { method: 'POST', body: { householdIds: [OTHER] } });
    let free;
    const busy = app.service.serialized(() => new Promise((resolve) => { free = resolve; }));
    const pending = Promise.all([release(), release()]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    free();
    await busy;
    const answers = await pending;
    assert.deepEqual(answers.map((answer) => [answer.status, answer.json().changed]).sort(), [[200, false], [200, true]]);
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, [OTHER]);
  });

  it('refuses no household, an unknown household, and a request that is not held', async (t) => {
    const app = await held(t);
    assert.equal((await admin(app, `/v1/app/held/${FIRST}/release`, { method: 'POST', body: { householdIds: [] } })).status, 400);
    assert.equal((await admin(app, `/v1/app/held/${FIRST}/release`, { method: 'POST', body: { householdIds: ['nowhere'] } })).status, 404);
    assert.equal((await admin(app, '/v1/app/held/7389999/release', { method: 'POST', body: { householdIds: [OTHER] } })).status, 404);
    assert.equal((await admin(app, `/v1/app/held/${FIRST}/release`, { method: 'POST', body: { households: [OTHER] } })).status, 400);
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, []);
  });
});
