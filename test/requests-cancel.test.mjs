// Cancelling a request (docs/app-design.md, "Cancelling (step 2c)"): POST /jellypass/app/v1/requests/:id/cancel, the
// withdrawal it records, the grant rule that follows it (webhooks, their replay and the backfill), the titles it holds
// for no household, what an administrator deleting a request in Seerr does, and that the canceller sees the same in
// every world.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  ALICE,
  ANN,
  BOB,
  HOST_A,
  HOST_B,
  ITEMS,
  MANAGE_REQUESTS,
  REQUEST,
  SEERR_IDS,
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
/** The first request the fake Seerr makes, and the next. */
const FIRST = 7350001;
const SECOND = 7350002;
const AS_BOB = { host: HOST_B, user: BOB };
const AS_ANN = { user: ANN };
const MOVIE_TAG = `jfa:private:${ITEMS.tMovie}`;

const start = (t, state, options = {}) => startApp(t, state, { reconcile: true, stateFile: SEED, libraryTtlMs: 0, ...options });
const movieItem = (extra = {}) => ({ Id: ITEMS.tMovie, Name: 'Synthetic Movie One', Type: 'Movie', ProviderIds: { Tmdb: String(T_MOVIE) }, Tags: [], library: 'shared', ...extra });
const seriesItem = () => ({ Id: ITEMS.tSeries, Name: 'Synthetic Series Two', Type: 'Series', ProviderIds: { Tmdb: String(T_TV) }, Tags: [], library: 'shared' });
const episode = (season) => ({ Id: `4444000044440000444400004444000${season}`, SeriesId: ITEMS.tSeries, ParentIndexNumber: season });

/** A POST, then the background work it started. */
async function post(app, pathname, body, options) {
  const answer = await app.post(pathname, body, options);
  await app.background.settled();
  return answer;
}

const getThis = (app, options) => post(app, GET_MOVIE, undefined, options);
const entries = async (app, options) => (await app.get(`${APP}/requests`, options)).json().results;
const movieState = async (app, options) => (await app.get(`${APP}/movie/${T_MOVIE}`, options)).json().state;
const cancelId = (app, id, options) => post(app, `${APP}/requests/${id}/cancel`, undefined, options);

/** Cancels the caller's only listed entry. */
async function cancel(app, options) {
  const [entry] = await entries(app, options);
  return cancelId(app, entry.id, options);
}

/** A Seerr request the fake holds, by ID. */
function seerrRequestOf(app, id) {
  return Object.values(app.seerr.state.requests).flat().find((entry) => entry.id === id);
}

const webhook = (app, requestId, requester, type = 'movie') => app.webhook({
  notificationType: 'MEDIA_AVAILABLE',
  event: type === 'movie' ? 'Movie Request Now Available' : 'Series Request Now Available',
  media: { mediaType: type, jellyfinMediaId: type === 'movie' ? ITEMS.tMovie : ITEMS.tSeries },
  request: { id: String(requestId), requestedBy: { jellyfinUserId: requester } },
});

/** The movie arrives in Jellyfin and Seerr's request completes, then its webhook comes. */
async function arrive(app, requestId = FIRST, requester = ALICE) {
  app.jellyfin.state.items.push(movieItem());
  seerrRequestOf(app, requestId).status = 5;
  const answer = await webhook(app, requestId, requester);
  assert.ok([200, 202].includes(answer.status), answer.text);
}

const admin = (app, pathname, { method = 'GET', body, headers = { Authorization: 'Bearer admin-secret' }, host = 'jellypass.example.test' } = {}) =>
  get(app.port, pathname, { Host: host, ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, { method, body: body && JSON.stringify(body) });

/** A metric's value, 0 when absent. */
function metric(app, name, labels) {
  const line = app.service.renderMetrics().split('\n').find((entry) => entry.startsWith(`${name}{${labels}} `));
  return line ? Number(line.split(' ').at(-1)) : 0;
}

const branch = (app, name) => metric(app, 'jfa_app_get_this_branches_total', `branch="${name}"`);

/** Whether Jellyfin now blocks the movie's grant tag for the user (they cannot see it). */
const blocked = (app, userId) => (app.jellyfin.state.jellyfinUsers[userId].Policy.BlockedTags ?? []).includes(MOVIE_TAG);

async function until(condition, what = 'condition') {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Holds AccessService's write queue (where grants are decided) until `release()` is called. */
function holdGrants(app) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  void app.service.serialized(() => held);
  return () => release();
}

describe('cancelling: the endpoint', { timeout: 60_000 }, () => {
  it('answers the same fixed 202 for an entry it cancels, one the caller may not cancel, and an ID the household does not list', async (t) => {
    const app = await start(t, world());
    await getThis(app);
    const [entry] = await entries(app);
    const answers = [
      await cancelId(app, entry.id, AS_ANN),
      await cancelId(app, 'Q'.repeat(22)),
      await cancelId(app, entry.id),
    ];
    for (const answer of answers) {
      assert.equal(answer.status, 202);
      assert.equal(answer.text, '{"status":"accepted"}');
      assert.equal(answer.headers['content-type'], 'application/json; charset=utf-8');
      assert.equal(answer.headers['cache-control'], answers[0].headers['cache-control']);
      assert.equal(answer.headers['content-length'], answers[0].headers['content-length']);
    }
    assert.deepEqual(await entries(app), []);
  });

  it('refuses a malformed ID or body with the fixed 400, a caller without a session with 401, and shares the "Get this" budgets', async (t) => {
    const app = await start(t, world());
    for (const [id, body] of [['A'.repeat(21), undefined], ['A'.repeat(23), undefined], [`${'A'.repeat(21)}.`, undefined], ['A'.repeat(22), { seasons: [1] }], ['A'.repeat(22), '[]']]) {
      const answer = await post(app, `${APP}/requests/${id}/cancel`, body);
      assert.equal(answer.status, 400, id);
      assert.equal(answer.text, '{"error":"invalid_request"}');
    }
    assert.equal((await post(app, `${APP}/requests/${'A'.repeat(22)}/cancel`, undefined, { user: null })).status, 401);
    assert.equal((await post(app, `${APP}/requests/${'A'.repeat(22)}/cancel`, undefined, AS_BOB)).status, 202);
    // 10 a member in 10 minutes, cancels and "Get this" together.
    for (let index = 0; index < 9; index += 1) assert.equal((await post(app, `${APP}/requests/${'B'.repeat(22)}/cancel`, {})).status, 202);
    assert.equal((await getThis(app)).status, 202);
    assert.equal((await post(app, `${APP}/requests/${'B'.repeat(22)}/cancel`, {})).status, 429);
    assert.equal((await getThis(app)).status, 429);
    assert.equal(metric(app, 'jfa_app_requests_total', 'endpoint="cancel",outcome="rate_limited"'), 1);
  });
});

describe('cancelling a request nobody else follows', { timeout: 60_000 }, () => {
  it('deletes a pending request in Seerr as the member who made it, and the title can be asked for again', async (t) => {
    const app = await start(t, world());
    await getThis(app);
    const [entry] = await entries(app);
    assert.deepEqual([entry.status, entry.byYou, entry.cancellable], ['requested', true, true]);
    assert.match(entry.requestedOn, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    assert.equal(entry.requestedOn, app.store.listAppRequests()[0][1].createdAt.slice(0, 10));
    assert.equal((await cancel(app)).status, 202);
    assert.deepEqual(app.seerr.deletes, [{ actingUser: SEERR_IDS[ALICE], id: FIRST, status: 204 }]);
    assert.equal(seerrRequestOf(app, FIRST), undefined);
    const [[, record]] = app.store.listAppRequests();
    assert.deepEqual([record.status, record.withdrawn], ['deleted', true]);
    assert.deepEqual(await entries(app), []);
    assert.equal(await movieState(app), 'get_this');
    assert.equal(branch(app, 'cancel_deleted'), 1);
    // Seerr no longer has it, so nothing is left to decide a grant: nothing holds up a rollback.
    const outstanding = (await admin(app, '/v1/app/outstanding')).json();
    assert.equal(outstanding.clear, true);
    assert.equal(outstanding.withdrawals.total, 0);
    // Asked for again: a new request.
    await getThis(app);
    assert.deepEqual(app.seerr.posts.map((entry) => entry.actingUser), [SEERR_IDS[ALICE], SEERR_IDS[ALICE]]);
    assert.deepEqual((await entries(app)).map((listed) => [listed.status, listed.cancellable]), [['requested', true]]);
  });

  it('never deletes as a member who manages requests in Seerr, who may delete any request', async (t) => {
    const app = await start(t, world({ seerrUsers: { [SEERR_IDS[ALICE]]: { jellyfinUserId: ALICE, permissions: REQUEST | MANAGE_REQUESTS } } }));
    await getThis(app);
    await cancel(app);
    assert.deepEqual(app.seerr.deletes, []);
    assert.equal(seerrRequestOf(app, FIRST).status, 1);
    assert.deepEqual(await entries(app), []);
    assert.equal(branch(app, 'cancel_kept'), 1);
  });

  it('keeps an approved request, which Seerr would not let the member delete, and holds the title for no household when it arrives', async (t) => {
    const app = await start(t, world({ autoApprove: true }));
    await getThis(app);
    await cancel(app);
    assert.deepEqual(app.seerr.deletes, []);
    assert.equal(seerrRequestOf(app, FIRST).status, 2);
    assert.deepEqual(await entries(app), []);
    assert.equal(await movieState(app), 'get_this');
    let outstanding = (await admin(app, '/v1/app/outstanding')).json();
    assert.deepEqual([outstanding.clear, outstanding.withdrawals.byKind, outstanding.withdrawals.held], [false, { waiting: 1, granted: 0 }, 0]);
    assert.deepEqual(outstanding.withdrawals.entries.map((entry) => [entry.kind, entry.mediaType, entry.tmdbId]), [['waiting', 'movie', T_MOVIE]]);

    await arrive(app);
    // Private to nobody: the request is recorded, its requester is no owner, and no household has it.
    const grant = app.store.get(ITEMS.tMovie);
    assert.equal(grant.active, true);
    assert.deepEqual(Object.keys(grant.requests), [String(FIRST)]);
    assert.deepEqual([grant.groupIds, grant.manualUserIds, grant.owners], [[], [], []]);
    for (const user of [ALICE, ANN, BOB]) assert.ok(blocked(app, user), user);
    assert.equal(await movieState(app), 'get_this');
    assert.equal(await movieState(app, AS_BOB), 'get_this');
    const held = (await admin(app, '/v1/app/held')).json();
    assert.equal(held.total, 1);
    assert.deepEqual(held.titles.map(({ itemId, requestId, mediaType, tmdbId }) => ({ itemId, requestId, mediaType, tmdbId })),
      [{ itemId: ITEMS.tMovie, requestId: String(FIRST), mediaType: 'movie', tmdbId: T_MOVIE }]);
    assert.match(held.titles[0].grantedAt, /^[0-9]{4}-/);
    outstanding = (await admin(app, '/v1/app/outstanding')).json();
    assert.deepEqual([outstanding.clear, outstanding.withdrawals.byKind, outstanding.withdrawals.held], [false, { waiting: 0, granted: 1 }, 1]);
    assert.match(app.service.renderMetrics(), /^jfa_app_held_titles 1$/m);

    // An administrator gives it to household A: it is no longer held, but the requester's withdrawal still decides
    // who the request gives access to until the request is revoked.
    assert.equal((await admin(app, `/v1/grants/${ITEMS.tMovie}/groups`, { method: 'PUT', body: { groupIds: ['farmhouse'] } })).status, 200);
    assert.deepEqual((await admin(app, '/v1/app/held')).json(), { total: 0, titles: [] });
    assert.equal(await movieState(app), 'in_library');
    outstanding = (await admin(app, '/v1/app/outstanding')).json();
    assert.deepEqual([outstanding.clear, outstanding.withdrawals.byKind], [false, { waiting: 0, granted: 1 }]);
    assert.equal((await admin(app, `/v1/grants/${ITEMS.tMovie}/requests/${FIRST}`, { method: 'DELETE' })).status, 200);
    outstanding = (await admin(app, '/v1/app/outstanding')).json();
    assert.deepEqual([outstanding.clear, outstanding.withdrawals.total], [true, 0]);
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, ['farmhouse']);
  });

  it('joins the household when the member asks again after cancelling, and the request is granted', async (t) => {
    const app = await start(t, world({ autoApprove: true }));
    await getThis(app);
    await cancel(app);
    await getThis(app);
    // The member's own request is followed again, not made again.
    assert.equal(app.seerr.posts.length, 1);
    assert.deepEqual((await entries(app)).map((entry) => [entry.status, entry.cancellable]), [['requested', true]]);
    await arrive(app);
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, ['farmhouse']);
    assert.equal(await movieState(app), 'in_library');
    assert.deepEqual((await entries(app)).map((entry) => [entry.status, entry.cancellable]), [['ready', false]]);
    assert.deepEqual((await admin(app, '/v1/app/held')).json().total, 0);
  });
});

describe('cancelling a request another household follows', { timeout: 60_000 }, () => {
  it('keeps the request, which the other household gets when it arrives, and the canceller does not', async (t) => {
    const app = await start(t, world());
    await getThis(app);
    await getThis(app, AS_BOB);
    assert.equal(app.store.listAppRequests().find(([, record]) => record.householdId === 'mill')[1].branch, 'interest');
    const bobBefore = [await entries(app, AS_BOB), await movieState(app, AS_BOB)];
    await cancel(app);
    assert.deepEqual(app.seerr.deletes, []);
    assert.equal(seerrRequestOf(app, FIRST).status, 1);
    assert.deepEqual([await entries(app, AS_BOB), await movieState(app, AS_BOB)], bobBefore);
    await arrive(app);
    const grant = app.store.get(ITEMS.tMovie);
    assert.deepEqual(grant.groupIds, ['mill']);
    assert.ok(!grant.owners.includes(ALICE) && !grant.owners.includes(ANN));
    assert.equal(await movieState(app, AS_BOB), 'in_library');
    assert.equal(await movieState(app), 'get_this');
    assert.deepEqual((await admin(app, '/v1/app/held')).json().total, 0);
  });

  it('withdraws an interest without touching the request it follows, and the request\'s own household still gets it', async (t) => {
    const app = await start(t, world());
    await getThis(app, AS_BOB);
    await getThis(app);
    assert.equal(app.store.listAppRequests().find(([, record]) => record.householdId === 'farmhouse')[1].branch, 'interest');
    const bobBefore = [await entries(app, AS_BOB), await movieState(app, AS_BOB)];
    await cancel(app);
    assert.deepEqual(app.seerr.deletes, []);
    assert.deepEqual([await entries(app, AS_BOB), await movieState(app, AS_BOB)], bobBefore);
    assert.deepEqual(await entries(app), []);
    await arrive(app, FIRST, BOB);
    const grant = app.store.get(ITEMS.tMovie);
    assert.deepEqual(grant.groupIds, ['mill']);
    assert.ok(grant.owners.includes(BOB));
    assert.ok(!grant.owners.includes(ALICE));
    assert.equal(await movieState(app), 'get_this');
  });
});

describe('cancelling: who and what', { timeout: 60_000 }, () => {
  it('lets only the member who asked cancel: a household-mate is never offered it, and their cancel changes nothing', async (t) => {
    const app = await start(t, world());
    await getThis(app);
    const [annSees] = await entries(app, AS_ANN);
    assert.deepEqual([annSees.byYou, annSees.cancellable], [false, false]);
    await cancelId(app, annSees.id, AS_ANN);
    assert.deepEqual(app.seerr.deletes, []);
    assert.equal(app.store.listAppRequests()[0][1].status, 'pending');
    assert.deepEqual((await entries(app)).map((entry) => [entry.status, entry.byYou, entry.cancellable]), [['requested', true, true]]);
  });

  it('cancels nothing once the caller can watch it: a ready movie, or a series with a season ready, keeps everything', async (t) => {
    const app = await start(t, world({ autoApprove: true }));
    await getThis(app);
    await arrive(app);
    assert.deepEqual((await entries(app)).map((entry) => [entry.status, entry.cancellable]), [['ready', false]]);
    await cancel(app);
    assert.equal(app.store.listAppRequests()[0][1].status, 'completed');
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, ['farmhouse']);
    assert.equal(await movieState(app), 'in_library');

    const series = await start(t, world({ autoApprove: true }));
    await post(series, GET_TV, { seasons: [1, 2] });
    series.jellyfin.state.items.push(seriesItem());
    series.jellyfin.state.episodes.push(episode(1));
    assert.ok([200, 202].includes((await webhook(series, FIRST, ALICE, 'tv')).status));
    const [entry] = await entries(series);
    assert.deepEqual([entry.status, entry.seasons, entry.cancellable], ['requested', [{ seasonNumber: 1, status: 'ready' }, { seasonNumber: 2, status: 'requested' }], false]);
    await cancelId(series, entry.id);
    assert.equal(series.store.listAppRequests()[0][1].status, 'pending');
    assert.deepEqual(series.store.get(ITEMS.tSeries).groupIds, ['farmhouse']);
    assert.deepEqual(series.seerr.deletes, []);
  });

  it('cancels a title that arrived where the caller cannot see it as if it had not, and takes no access back', async (t) => {
    const limited = { [ALICE]: { Name: 'Alice', Policy: { BlockedTags: [], EnabledFolders: ['shared'], MaxParentalRating: 12 } } };
    const seen = {};
    for (const arrived of [false, true]) {
      const app = await start(t, world({ autoApprove: true, jellyfinUsers: limited }));
      await getThis(app);
      if (arrived) {
        app.jellyfin.state.items.push(movieItem({ ParentalRating: 18 }));
        seerrRequestOf(app, FIRST).status = 5;
        await webhook(app, FIRST, ALICE);
        assert.equal(app.store.listAppRequests()[0][1].status, 'completed');
        assert.equal(await movieState(app, AS_ANN), 'in_library');
      }
      const before = await entries(app);
      const answer = await cancel(app);
      seen[arrived] = { before, answer: [answer.status, answer.text], after: await entries(app), state: await movieState(app) };
      if (arrived) {
        // Too late to change the grant: the household keeps it, and no withdrawal is recorded.
        assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, ['farmhouse']);
        assert.equal(await movieState(app, AS_ANN), 'in_library');
        assert.equal((await admin(app, '/v1/app/outstanding')).json().withdrawals.total, 0);
        assert.equal(branch(app, 'cancel_too_late'), 1);
      }
    }
    assert.deepEqual(seen[true], seen[false]);
    assert.deepEqual(seen[false].before.map((entry) => [entry.status, entry.cancellable]), [['requested', true]]);
    assert.deepEqual(seen[false].after, []);
  });

  it('keeps a cancelled request whose grant follows the join rules a join: no new grant, and the household is not joined', async (t) => {
    // Bob's private grant of the series, with season 1; household A asks for season 2, which Jellyfin lacks.
    const app = await start(t, world({
      autoApprove: true,
      items: [seriesItem()],
      episodes: [episode(1)],
      grants: [{ request: { itemId: ITEMS.tSeries, mediaType: 'tv', requestId: '7300502', userId: BOB, groupIds: ['mill'] } }],
    }));
    await post(app, GET_TV, { seasons: [2] });
    assert.equal(app.store.listAppRequests()[0][1].joinOnGrant, 'existing-series');
    await cancel(app);
    app.jellyfin.state.episodes.push(episode(2));
    seerrRequestOf(app, FIRST).status = 5;
    assert.ok([200, 202].includes((await webhook(app, FIRST, ALICE, 'tv')).status));
    const grant = app.store.get(ITEMS.tSeries);
    assert.deepEqual(grant.groupIds, ['mill']);
    assert.deepEqual(Object.keys(grant.requests), ['7300502']);
    assert.equal(metric(app, 'jfa_webhooks_total', 'result="joined"'), 1);
    assert.deepEqual((await admin(app, '/v1/app/held')).json().total, 0);
  });
});

describe('cancelling: delayed webhooks and the backfill', { timeout: 60_000 }, () => {
  it('replays a webhook deferred for a "Get this" intent through the withdrawal', async (t) => {
    const app = await start(t, world({ autoApprove: true }));
    await getThis(app);
    await cancel(app);
    // Another household's request for the title is being sent: the webhook waits for it.
    const intent = await app.store.addAppRequestIntent({
      householdId: 'mill', jellyfinUserId: BOB, mediaType: 'movie', tmdbId: T_MOVIE, seasons: [],
      observedAbsentAt: new Date().toISOString(), createdAt: new Date().toISOString(), status: 'submitting',
      householdEpoch: app.store.householdEpoch('mill'),
    });
    await arrive(app);
    assert.equal(metric(app, 'jfa_webhooks_total', 'result="deferred"'), 1);
    assert.equal(app.store.get(ITEMS.tMovie), undefined);
    await app.store.writeAppRequests({ removeIntents: [intent] });
    await app.service.retryDeferredRequests();
    const grant = app.store.get(ITEMS.tMovie);
    assert.deepEqual([grant.groupIds, grant.owners], [[], []]);
    assert.equal((await admin(app, '/v1/app/held')).json().total, 1);
    assert.deepEqual(app.store.listDeferredWebhooks(), []);
  });

  it('has the backfill grant a cancelled request by its withdrawal', async (t) => {
    const app = await start(t, world({ autoApprove: true }));
    await getThis(app);
    await cancel(app);
    app.jellyfin.state.items.push(movieItem());
    const made = seerrRequestOf(app, FIRST);
    made.media = { ...made.media, status: 5, jellyfinMediaId: ITEMS.tMovie };
    const result = await app.service.backfillRequests(new Date(0));
    assert.deepEqual(result.granted, [ITEMS.tMovie]);
    const grant = app.store.get(ITEMS.tMovie);
    assert.deepEqual([grant.groupIds, grant.owners], [[], []]);
    assert.ok(blocked(app, ALICE));
    assert.equal((await admin(app, '/v1/app/held')).json().total, 1);
  });
});

describe('cancelling: races', { timeout: 60_000 }, () => {
  const event = { notificationType: 'MEDIA_AVAILABLE', media: { mediaType: 'movie', jellyfinMediaId: ITEMS.tMovie }, request: { id: String(FIRST), is4k: false, requestedBy: { jellyfinUserId: ALICE } } };

  it('lets a webhook decided before the cancel\'s withdrawal keep what it granted', async (t) => {
    const app = await start(t, world({ autoApprove: true }));
    await getThis(app);
    app.jellyfin.state.items.push(movieItem());
    seerrRequestOf(app, FIRST).status = 5;
    const release = holdGrants(app);
    const granted = app.service.processWebhook(event);
    const cancelled = cancel(app);
    // The cancel reads the caller's view and waits its turn behind the webhook.
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await Promise.all([granted, cancelled]);
    await app.background.settled();
    const grant = app.store.get(ITEMS.tMovie);
    assert.deepEqual(grant.groupIds, ['farmhouse']);
    assert.ok(grant.owners.includes(ALICE));
    assert.ok(!blocked(app, ALICE));
    assert.equal(await movieState(app), 'in_library');
    assert.equal((await admin(app, '/v1/app/outstanding')).json().withdrawals.total, 0);
  });

  it('grants a webhook that arrives while the cancel waits its turn by the withdrawal', async (t) => {
    const app = await start(t, world({ autoApprove: true }));
    await getThis(app);
    app.jellyfin.state.items.push(movieItem());
    seerrRequestOf(app, FIRST).status = 5;
    const release = holdGrants(app);
    const serialized = app.service.serialized.bind(app.service);
    let entered;
    const queued = new Promise((resolve) => { entered = resolve; });
    app.service.serialized = (work) => {
      entered();
      return serialized(work);
    };
    const cancelled = cancel(app);
    await queued;
    const granted = app.service.processWebhook(event);
    release();
    await Promise.all([granted, cancelled]);
    await app.background.settled();
    const grant = app.store.get(ITEMS.tMovie);
    assert.deepEqual([grant.groupIds, grant.owners], [[], []]);
    assert.ok(blocked(app, ALICE));
    assert.equal((await admin(app, '/v1/app/held')).json().total, 1);
  });

  it('takes turns with another household\'s "Get this" for the title: a follower recorded first keeps the request', async (t) => {
    const app = await start(t, world());
    await getThis(app);
    let release;
    app.seerr.state.holdTitles = new Promise((resolve) => { release = resolve; });
    const titleReads = () => app.seerr.calls.filter((call) => call.pathname === `/api/v1/movie/${T_MOVIE}`).length;
    const before = titleReads();
    const following = app.post(GET_MOVIE, undefined, AS_BOB);
    await until(() => titleReads() > before, 'Bob\'s title read');
    const [entry] = await entries(app);
    const cancelled = app.post(`${APP}/requests/${entry.id}/cancel`, undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    app.seerr.state.holdTitles = undefined;
    await Promise.all([following, cancelled]);
    await app.background.settled();
    // Cancelled, but kept in Seerr for Bob's household, which still follows it.
    assert.deepEqual(await entries(app), []);
    assert.deepEqual(app.seerr.deletes, []);
    assert.equal(seerrRequestOf(app, FIRST).status, 1);
    assert.equal(branch(app, 'cancel_kept'), 1);
    const bobs = app.store.listAppRequests().find(([, record]) => record.householdId === 'mill')[1];
    assert.deepEqual([bobs.branch, bobs.status, bobs.seerrRequestId], ['interest', 'pending', String(FIRST)]);
    assert.deepEqual((await entries(app, AS_BOB)).map((listed) => listed.status), ['requested']);
  });

  it('takes turns with another household\'s "Get this" for the title: one recorded after the delete makes its own request', async (t) => {
    const app = await start(t, world());
    await getThis(app);
    const release = holdGrants(app);
    const serialized = app.service.serialized.bind(app.service);
    let entered;
    const queued = new Promise((resolve) => { entered = resolve; });
    app.service.serialized = (work) => {
      entered();
      return serialized(work);
    };
    const [entry] = await entries(app);
    const cancelled = app.post(`${APP}/requests/${entry.id}/cancel`, undefined);
    // The cancel holds the title's turn while it waits for the write queue; Bob's call waits for the title.
    await queued;
    const following = app.post(GET_MOVIE, undefined, AS_BOB);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(app.store.listAppRequests().length, 1);
    release();
    await Promise.all([following, cancelled]);
    await app.background.settled();
    assert.deepEqual(app.seerr.deletes, [{ actingUser: SEERR_IDS[ALICE], id: FIRST, status: 204 }]);
    const bobs = app.store.listAppRequests().find(([, record]) => record.householdId === 'mill')[1];
    assert.deepEqual([bobs.branch, bobs.status, bobs.seerrRequestId], ['request', 'pending', String(SECOND)]);
    assert.deepEqual((await entries(app, AS_BOB)).map((listed) => listed.status), ['requested']);
  });
});

describe('cancelling: what the canceller sees does not depend on anyone else', { timeout: 60_000 }, () => {
  it('answers, lists and shows the same, before and after cancelling, whatever another household holds or follows', async (t) => {
    const worlds = {
      'nobody else asked (pending, deleted in Seerr)': { state: () => world() },
      'approved at once (kept in Seerr)': { state: () => world({ autoApprove: true }) },
      'another household follows it': { state: () => world(), after: (app) => getThis(app, AS_BOB) },
      'another household asked first': {
        state: () => world({ requests: { [SEERR_IDS[BOB]]: [Object.assign(seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: 1 }), { id: 7300601, createdAt: new Date().toISOString() })] } }),
      },
    };
    const seen = {};
    for (const [name, { state, after }] of Object.entries(worlds)) {
      const app = await start(t, state());
      await getThis(app);
      await after?.(app);
      const bob = async () => [await entries(app, AS_BOB), await movieState(app, AS_BOB)];
      const bobBefore = await bob();
      const before = { alice: await entries(app), ann: await entries(app, AS_ANN), state: await movieState(app) };
      const answer = await cancel(app);
      seen[name] = {
        before,
        answer: [answer.status, answer.text, answer.headers['content-type'], answer.headers['content-length'], answer.headers['cache-control']],
        alice: await entries(app),
        ann: await entries(app, AS_ANN),
        state: await movieState(app),
        annState: await movieState(app, AS_ANN),
      };
      // The other household sees nothing change.
      assert.deepEqual(await bob(), bobBefore, name);
    }
    const [first, ...others] = Object.keys(seen);
    for (const name of others) assert.deepEqual(seen[name], seen[first], name);
    assert.deepEqual([seen[first].alice, seen[first].state], [[], 'get_this']);
  });
});

describe('an administrator deletes a request in Seerr', { timeout: 60_000 }, () => {
  it('drops the requester\'s record and every follower\'s alike, and each household can ask for the title again', async (t) => {
    const app = await start(t, world());
    await getThis(app);
    await getThis(app, AS_BOB);
    // The request goes; Seerr keeps the title's media record.
    app.seerr.state.requests[SEERR_IDS[ALICE]] = [];
    app.seerr.state.media[T_MOVIE] = { id: 7360001, mediaType: 'movie', tmdbId: T_MOVIE, status: 2, requests: [] };
    await app.requests.refresh();
    assert.deepEqual(app.store.listAppRequests().map(([, record]) => [record.householdId, record.branch, record.status]).sort(),
      [['farmhouse', 'request', 'deleted'], ['mill', 'interest', 'deleted']]);
    for (const options of [{}, AS_BOB]) {
      assert.deepEqual(await entries(app, options), []);
      assert.equal(await movieState(app, options), 'get_this');
    }
  });
});

describe('cancelling: the administrator\'s readouts', { timeout: 60_000 }, () => {
  it('answers the held titles only to the administrator, and only on the admin host', async (t) => {
    const app = await start(t, world());
    assert.equal((await admin(app, '/v1/app/held', { headers: {} })).status, 401);
    assert.equal((await admin(app, '/v1/app/held', { headers: { Authorization: 'Bearer webhook-secret' } })).status, 401);
    assert.deepEqual((await admin(app, '/v1/app/held')).json(), { total: 0, titles: [] });
    for (const host of [HOST_A, HOST_B]) {
      for (const headers of [{ Authorization: 'Bearer admin-secret' }, { Authorization: 'MediaBrowser Token="token-alice"' }, {}]) {
        const answer = await admin(app, '/v1/app/held', { headers, host });
        assert.notEqual(answer.status, 200, host);
        assert.doesNotMatch(answer.text, /titles|total/, host);
      }
    }
  });

  it('dates an entry by its day only', async (t) => {
    const app = await start(t, world(), { now: () => Date.parse('2031-02-03T23:59:58.123Z') });
    await getThis(app);
    const [entry] = await entries(app);
    assert.equal(entry.requestedOn, '2031-02-03');
    assert.doesNotMatch(JSON.stringify(entry), /23:59|T2/);
  });
});

describe('cancelling: what the state file keeps', { timeout: 60_000 }, () => {
  it('forgets a withdrawal once Seerr no longer has its request, so it no longer holds up a rollback', async (t) => {
    const app = await start(t, world({ autoApprove: true }));
    await getThis(app);
    await cancel(app);
    assert.equal((await admin(app, '/v1/app/outstanding')).json().withdrawals.total, 1);
    await app.requests.refresh();
    assert.equal((await admin(app, '/v1/app/outstanding')).json().withdrawals.total, 1);
    // An administrator deletes it in Seerr; after a restart (each request is read at most every 10 minutes) the refresh
    // finds it gone.
    app.seerr.state.requests[SEERR_IDS[ALICE]] = [];
    const later = await start(t, app.seerr.state, { stateFile: JSON.parse(await readFile(app.stateFile, 'utf8')) });
    await later.requests.refresh();
    const outstanding = (await admin(later, '/v1/app/outstanding')).json();
    assert.deepEqual([outstanding.clear, outstanding.withdrawals.total], [true, 0]);
    assert.equal(JSON.parse(await readFile(later.stateFile, 'utf8')).appWithdrawals, undefined);
  });

  it('keeps the requester out of a held grant when it moves to another item, and drops the withdrawal once the request is revoked', async (t) => {
    const app = await start(t, world({ autoApprove: true }));
    await getThis(app);
    await cancel(app);
    await arrive(app);
    const moved = '22220000222200002222000022220000';
    await app.store.mergeGrants(ITEMS.tMovie, [{ itemId: moved, requests: { [FIRST]: ALICE }, manualUserIds: [], groupIds: [], mediaType: 'movie' }]);
    await app.store.retireMovedGrant(ITEMS.tMovie);
    const grant = app.store.get(moved);
    assert.deepEqual(Object.keys(grant.requests), [String(FIRST)]);
    assert.deepEqual([grant.owners, app.store.resolveOwners(grant)], [[], []]);
    assert.equal((await admin(app, '/v1/app/held')).json().titles[0].itemId, moved);
    await app.store.revokeRequest(moved, String(FIRST));
    assert.deepEqual(app.store.listAppWithdrawals(), []);
  });
});
