// "Get this": safety tombstones, as Codex's review of bbc3163 found the gaps (docs/app-design.md, "Safety tombstones").
// Each test here fails on bbc3163: a recovery that recorded the wrong request, an intent that timed out before Seerr
// made its request, a name lookup cut short, a household replaced before its intent was recovered, deferred webhooks
// replayed in the order that loses a household's join, a safety decision pruned with its record, and an intent that
// held up another household's genuine grant for as long as Seerr could not be read.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { APP_INTENT_TIMEOUT_MS, APP_SETTLE_DEADLINE_MS } from '../dist/household-requests.js';
import { MAX_NAME_SEARCH_ITEMS } from '../dist/jellyfin.js';
import { MAX_APP_REQUESTS_PER_HOUSEHOLD } from '../dist/store.js';
import {
  ALICE,
  BOB,
  HOST_A,
  HOST_B,
  ITEMS,
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
const SEED = {
  version: 7, grants: {}, groups: {}, catalog: { items: {} }, passwordlessUserIds: [], appIdKey: 'ab'.repeat(32),
  householdEpochs: { grove: 1, mill: 2 }, nextHouseholdEpoch: 3,
};

function request({ id, seerrUser, type = 'movie', status = 1, seasons, createdAt = Date.now() }) {
  const made = seerrRequest({ type, tmdbId: type === 'movie' ? T_MOVIE : T_TV, status, seasons: type === 'tv' ? seasons : undefined });
  made.id = id;
  made.createdAt = new Date(createdAt).toISOString();
  made.requestedBy = { ...made.requestedBy, id: seerrUser };
  return made;
}

const movieItem = (extra = {}) => ({ Id: ITEMS.tMovie, Name: 'Synthetic Movie One', Type: 'Movie', ProviderIds: { Tmdb: String(T_MOVIE) }, Tags: [], library: 'shared', ...extra });
const seriesItem = () => ({ Id: ITEMS.tSeries, Name: 'Synthetic Series Two', Type: 'Series', ProviderIds: { Tmdb: String(T_TV) }, Tags: [], library: 'shared' });
const episode = (season) => ({ Id: `4444000044440000444400004444000${season}`, SeriesId: ITEMS.tSeries, ParentIndexNumber: season });

/** Alice's "Get this" for the movie as JellyPass left it when it stopped before Seerr answered: a `submitting` intent. */
function lostIntent(createdAt, extra = {}) {
  return {
    householdId: 'grove', jellyfinUserId: ALICE, mediaType: 'movie', tmdbId: T_MOVIE, seasons: [],
    observedAbsentAt: new Date(createdAt).toISOString(), createdAt: new Date(createdAt).toISOString(), status: 'submitting',
    householdEpoch: 1, ...extra,
  };
}

const start = (t, state, options = {}) => startApp(t, state, { reconcile: true, stateFile: SEED, ...options });

async function getThis(app, pathname = GET_MOVIE, body = undefined) {
  const answer = await app.post(pathname, body);
  await app.background.settled();
  return answer;
}

function metric(app, name, labels) {
  const line = app.service.renderMetrics().split('\n').find((entry) => entry.startsWith(`${name}{${labels}} `));
  return line ? Number(line.split(' ').at(-1)) : 0;
}

async function until(condition, what = 'condition') {
  const deadline = Date.now() + 10_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const webhook = (app, type, requestId, user) => app.webhook({
  notificationType: 'MEDIA_AVAILABLE',
  event: type === 'movie' ? 'Movie Request Now Available' : 'Series Request Now Available',
  media: { mediaType: type, jellyfinMediaId: type === 'movie' ? ITEMS.tMovie : ITEMS.tSeries },
  request: { id: String(requestId), requestedBy: { jellyfinUserId: user } },
});

/** Holds Seerr's answer to the next request after Seerr has made it. */
function holdAfterMade(app) {
  let release;
  app.seerr.state.holdCreated = new Promise((resolve) => { release = resolve; });
  return {
    made: () => until(() => (app.seerr.state.requests[SEERR_IDS[ALICE]] ?? []).some((entry) => entry.id >= 7350001), 'Seerr to make the request'),
    release: () => {
      app.seerr.state.holdCreated = undefined;
      release();
    },
  };
}

const deferred = (app) => app.store.listDeferredWebhooks().map((event) => event.request.id);
const requestRecord = (app) => app.store.listAppRequests().map(([, record]) => record).find((record) => record.branch === 'request');
/** Seerr makes a request as Alice now (the one her intent sent, late), available at once. */
const madeLate = (app, id) => app.seerr.state.requests[SEERR_IDS[ALICE]].push(request({ id, seerrUser: SEERR_IDS[ALICE], status: 5 }));

describe('"Get this": a recovery that cannot tell which request its intent made (Codex 1)', { timeout: 60_000 }, () => {
  it('attaches no declined or ambiguous candidate: a tombstone covers the member\'s requests, so the real one, made late, is a join', async (t) => {
    const now = Date.now();
    const candidates = {
      declined: [request({ id: 7300111, seerrUser: SEERR_IDS[ALICE], status: 3, createdAt: now - 60_000 })],
      ambiguous: [request({ id: 7300111, seerrUser: SEERR_IDS[ALICE], status: 1, createdAt: now - 60_000 }), request({ id: 7300112, seerrUser: SEERR_IDS[ALICE], status: 1 })],
    };
    for (const [kind, found] of Object.entries(candidates)) {
      // A public movie; the intent's own request has not reached Seerr's list yet.
      const app = await start(t, world({ items: [movieItem()], requests: { [SEERR_IDS[ALICE]]: found } }), {
        stateFile: { ...SEED, appRequestIntents: { lost: lostIntent(now) } },
      });
      await app.requests.refresh();
      assert.deepEqual(app.store.listAppRequestIntents(), [], kind);
      // Nothing is guessed: no record for the household.
      assert.deepEqual(app.store.listAppRequests(), [], kind);
      const [tombstone] = app.store.listAppSafetyTombstones();
      assert.deepEqual([tombstone.jellyfinUserId, tombstone.requestIds], [ALICE, found.map((entry) => String(entry.id))], kind);
      assert.equal(metric(app, 'jfa_app_get_this_branches_total', 'branch="intent_ambiguous"'), 1, kind);
      // Seerr makes the intent's request late; it is granted by the join rules: the public movie stays public.
      madeLate(app, 7300222);
      assert.equal((await webhook(app, 'movie', 7300222, ALICE)).status, 202, kind);
      assert.equal(app.store.get(ITEMS.tMovie), undefined, kind);
      assert.equal(app.store.hasHandledRequest('7300222'), true, kind);
    }
  });

  it('still records the one request found for the household, and covers a later one by the member all the same', async (t) => {
    const now = Date.now();
    const app = await start(t, world({ requests: { [SEERR_IDS[ALICE]]: [request({ id: 7300111, seerrUser: SEERR_IDS[ALICE], status: 1 })] } }), {
      stateFile: { ...SEED, appRequestIntents: { lost: lostIntent(now) } },
    });
    await app.requests.refresh();
    const record = requestRecord(app);
    assert.deepEqual([record.seerrRequestId, record.joinOnGrant, record.detached], ['7300111', undefined, undefined]);
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).json().state, 'requested');
    // The one found is genuine (exempt); another request by Alice for the title, from then on, is a join.
    app.jellyfin.state.items.push(movieItem());
    app.seerr.state.requests[SEERR_IDS[ALICE]][0].status = 5;
    madeLate(app, 7300222);
    assert.equal((await webhook(app, 'movie', 7300222, ALICE)).status, 202);
    assert.equal(app.store.get(ITEMS.tMovie), undefined);
    assert.equal((await webhook(app, 'movie', 7300111, ALICE)).status, 200);
    assert.deepEqual(Object.keys(app.store.get(ITEMS.tMovie).requests), ['7300111']);
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, ['grove']);
  });
});

describe('"Get this": an intent whose request Seerr made only after it timed out (Codex 2)', { timeout: 60_000 }, () => {
  it('gives way to a tombstone, not to nothing: the delayed request is a join, the public movie stays public', async (t) => {
    let now = Date.now();
    const app = await start(t, world({ items: [movieItem()] }), {
      stateFile: { ...SEED, appRequestIntents: { lost: lostIntent(now) } },
      now: () => now,
    });
    now += APP_INTENT_TIMEOUT_MS + 1000;
    await app.requests.refresh();
    assert.deepEqual(app.store.listAppRequestIntents(), []);
    assert.deepEqual(app.store.listAppSafetyTombstones().map((tombstone) => [tombstone.jellyfinUserId, tombstone.tmdbId]), [[ALICE, T_MOVIE]]);
    assert.equal(metric(app, 'jfa_app_get_this_branches_total', 'branch="intent_cancelled"'), 1);
    app.seerr.state.requests[SEERR_IDS[ALICE]] = [];
    madeLate(app, 7300333);
    assert.equal((await webhook(app, 'movie', 7300333, ALICE)).status, 202);
    assert.equal(app.store.get(ITEMS.tMovie), undefined);
    assert.equal(app.store.hasHandledRequest('7300333'), true);
  });

  it('covers neither another member\'s request nor the member\'s own genuine "Get this" made afterwards', async (t) => {
    let now = Date.now();
    const app = await start(t, world({}), { stateFile: { ...SEED, appRequestIntents: { lost: lostIntent(now) } }, now: () => now });
    now += APP_INTENT_TIMEOUT_MS + 1000;
    await app.requests.refresh();
    assert.equal(app.store.listAppSafetyTombstones().length, 1);
    // Alice asks again: the title is absent, her request is genuine.
    await getThis(app);
    assert.deepEqual([requestRecord(app).seerrRequestId, requestRecord(app).joinOnGrant], ['7350001', undefined]);
    assert.deepEqual(app.store.listAppSafetyTombstones()[0].exemptRequestIds, ['7350001']);
    app.jellyfin.state.items.push(movieItem());
    app.seerr.state.requests[SEERR_IDS[ALICE]][0].status = 5;
    assert.equal((await webhook(app, 'movie', 7350001, ALICE)).status, 200);
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, ['grove']);
  });
});

describe('"Get this": a name lookup with more items than one page (Codex 3)', { timeout: 60_000 }, () => {
  // Movies whose names contain the title's, each another title (another TMDB ID).
  const others = (count) => Array.from({ length: count }, (_, index) => ({
    Id: `7${index.toString(16).padStart(31, '0')}`, Name: `Synthetic Movie One Part ${index}`, Type: 'Movie',
    ProviderIds: { Tmdb: String(800000 + index) }, Tags: [], library: 'shared',
  }));

  it('pages through every item the search finds, and joins the one without TMDB metadata past the first 200', async (t) => {
    const app = await start(t, world({ items: [...others(250), movieItem({ ProviderIds: {}, ProductionYear: 2020 })] }));
    await getThis(app);
    assert.deepEqual(app.seerr.posts, []);
    assert.equal(metric(app, 'jfa_app_get_this_branches_total', 'branch="join_ungranted"'), 1);
  });

  it('takes the title as present when the search finds more than it reads', async (t) => {
    const app = await start(t, world({ items: others(MAX_NAME_SEARCH_ITEMS) }));
    await getThis(app);
    assert.deepEqual(app.seerr.posts, []);
    assert.deepEqual(app.store.listAppRequestIntents(), []);
  });

  it('joins rather than requests a title Jellyfin may hold without TMDB metadata under a longer name', async (t) => {
    const app = await start(t, world({ items: [movieItem({ Name: 'Synthetic Movie One (Director\'s Cut)', ProviderIds: {}, ProductionYear: 2020 })] }));
    await getThis(app);
    assert.deepEqual(app.seerr.posts, []);
  });
});

describe('"Get this": a household replaced before its intent is recovered (Codex 4)', { timeout: 60_000 }, () => {
  it('keeps the tombstone but gives the request to no household: the new one under the same ID never sees it', async (t) => {
    const now = Date.now();
    const state = world({ requests: { [SEERR_IDS[ALICE]]: [request({ id: 7300444, seerrUser: SEERR_IDS[ALICE], status: 1 })] } });
    const app = await start(t, state, { stateFile: { ...SEED, appRequestIntents: { lost: lostIntent(now) } } });
    const household = app.store.getGroup('grove');
    await app.store.deleteGroup('grove');
    await app.store.upsertGroup({ id: household.id, name: household.name, userIds: household.userIds });
    assert.notEqual(app.store.householdEpoch('grove'), 1);
    await app.requests.refresh();
    assert.deepEqual(app.store.listAppRequestIntents(), []);
    assert.deepEqual(app.store.listAppRequests(), []);
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).json().state, 'get_this');
    assert.deepEqual(app.store.listAppSafetyTombstones().map((tombstone) => tombstone.requestIds), [['7300444']]);
    assert.equal(metric(app, 'jfa_app_get_this_branches_total', 'branch="intent_detached"'), 1);
  });

  it('keeps each household\'s epoch in the state file, and gives a household created again another', async (t) => {
    const app = await start(t, world({}), { stateFile: { version: 7, grants: {}, groups: {}, catalog: { items: {} }, passwordlessUserIds: [] } });
    const first = app.store.householdEpoch('grove');
    await getThis(app);
    const again = await start(t, world({}), { stateFile: JSON.parse(await readFile(app.stateFile, 'utf8')) });
    // Asked for in another order after the restart, each household keeps its own.
    const before = [first, again.store.householdEpoch('mill')];
    assert.equal(again.store.householdEpoch('grove'), first);
    await again.store.deleteGroup('grove');
    await again.store.upsertGroup({ id: 'grove', name: 'Grove', userIds: [ALICE] });
    assert.ok(!before.includes(again.store.householdEpoch('grove')));
  });
});

describe('"Get this": a household\'s join and another household\'s genuine grant of the same series (Codex 5)', { timeout: 60_000 }, () => {
  /**
   * Bob's genuine request for season 1 is available; Alice's "Get this" for season 2 is made while the series arrives,
   * and settles as `existing-series` (its grant follows the join rules). `order` says how the two webhooks arrive.
   */
  async function bothGranted(t, order) {
    const state = world({ requests: { [SEERR_IDS[BOB]]: [request({ id: 7300502, seerrUser: SEERR_IDS[BOB], type: 'tv', status: 5, seasons: [1] })] } });
    const app = await start(t, state);
    const hold = holdAfterMade(app);
    await app.post(GET_TV, { seasons: [2] });
    await hold.made();
    state.items.push(seriesItem());
    state.episodes.push(episode(1));
    const alice = () => webhook(app, 'tv', 7350001, ALICE);
    const bob = () => webhook(app, 'tv', 7300502, BOB);
    if (order.startsWith('deferred')) {
      // Jellyfin cannot be read at settle time: both webhooks are deferred, in the order given, until it can.
      app.jellyfin.down = true;
      hold.release();
      await app.background.settled();
      app.jellyfin.down = false;
      for (const send of order === 'deferred: Alice first' ? [alice, bob] : [bob, alice]) assert.equal((await send()).status, 202);
      assert.deepEqual(deferred(app).length, 2);
      await app.requests.refresh();
      assert.deepEqual(deferred(app), []);
    } else {
      hold.release();
      await app.background.settled();
      assert.equal((await alice()).status, 202);
      // No grant to join yet: the record waits for one, never completed against the public series.
      assert.deepEqual([requestRecord(app).status, requestRecord(app).awaitingGrant], ['pending', true]);
      if (order === 'live: Alice first') assert.equal((await bob()).status, 200);
      else {
        // A grant made without a webhook for it (say, restored by an administrator): the next refresh joins it.
        await app.store.grant({ itemId: ITEMS.tSeries, mediaType: 'tv', requestId: '7300502', userId: BOB, groupIds: ['mill'] });
        await app.requests.refresh();
      }
    }
    assert.equal(requestRecord(app).joinOnGrant, 'existing-series', order);
    return app;
  }

  for (const order of ['deferred: Alice first', 'deferred: Bob first', 'live: Alice first', 'refresh']) {
    it(`gives both households the series (${order})`, async (t) => {
      const app = await bothGranted(t, order);
      const grant = app.store.get(ITEMS.tSeries);
      assert.deepEqual(Object.keys(grant.requests), ['7300502'], order);
      assert.deepEqual(grant.groupIds, ['grove', 'mill'], order);
      assert.equal(requestRecord(app).awaitingGrant, undefined, order);
    });
  }

  it('shows a join whose title stayed public as ready, while it awaits a grant', async (t) => {
    const app = await start(t, world({ autoApprove: true }));
    const hold = holdAfterMade(app);
    await app.post(GET_MOVIE);
    await hold.made();
    app.jellyfin.state.items.push(movieItem());
    hold.release();
    await app.background.settled();
    app.seerr.state.requests[SEERR_IDS[ALICE]][0].status = 5;
    assert.equal((await webhook(app, 'movie', 7350001, ALICE)).status, 202);
    assert.deepEqual([requestRecord(app).status, requestRecord(app).awaitingGrant, requestRecord(app).readySeasons], ['pending', true, [0]]);
    assert.deepEqual((await app.get(`${APP}/requests`)).json().results.map((entry) => entry.status), ['ready']);
  });
});

describe('"Get this": a safety decision whose record is pruned (Codex 6)', { timeout: 60_000 }, () => {
  it('keeps the request on the join rules after its record is pruned by newer ones: retried in Seerr, the movie stays public', async (t) => {
    const app = await start(t, world({}));
    const hold = holdAfterMade(app);
    await app.post(GET_MOVIE);
    await hold.made();
    app.jellyfin.state.items.push(movieItem());
    hold.release();
    await app.background.settled();
    assert.equal(requestRecord(app).joinOnGrant, 'present-at-settle');
    // Seerr's request fails, and the household makes the most records kept after it.
    app.seerr.state.requests[SEERR_IDS[ALICE]][0].status = 4;
    await app.requests.refresh();
    assert.equal(requestRecord(app).status, 'failed');
    const later = Date.now() + 60_000;
    await app.store.writeAppRequests({
      add: Array.from({ length: MAX_APP_REQUESTS_PER_HOUSEHOLD }, (_, index) => ({
        householdId: 'grove', jellyfinUserId: ALICE, mediaType: 'movie', tmdbId: 810000 + index, seasons: [],
        createdAt: new Date(later + index).toISOString(), updatedAt: new Date(later + index).toISOString(), branch: 'join', status: 'completed',
      })),
    });
    assert.equal(requestRecord(app), undefined);
    // An administrator retries the request in Seerr, and it completes.
    app.seerr.state.requests[SEERR_IDS[ALICE]][0].status = 5;
    assert.equal((await webhook(app, 'movie', 7350001, ALICE)).status, 202);
    assert.equal(app.store.get(ITEMS.tMovie), undefined);
    assert.equal(app.store.hasHandledRequest('7350001'), true);
  });
});

describe('"Get this": an intent that cannot be reconciled for long (Codex 7)', { timeout: 60_000 }, () => {
  it('stops holding up another household\'s genuine grant once the deadline has passed, and keeps the member\'s request a join', async (t) => {
    let now = Date.now();
    const state = world({
      items: [movieItem()],
      requests: {
        [SEERR_IDS[BOB]]: [request({ id: 7300603, seerrUser: SEERR_IDS[BOB], status: 5 })],
        [SEERR_IDS[ALICE]]: [request({ id: 7300777, seerrUser: SEERR_IDS[ALICE], status: 5 })],
      },
    });
    const app = await start(t, state, { stateFile: { ...SEED, appRequestIntents: { lost: lostIntent(now) } }, now: () => now });
    // Seerr's title answers cannot be read, so the intent cannot be looked up.
    state.titlesFail = true;
    assert.equal((await webhook(app, 'movie', 7300603, BOB)).status, 202);
    assert.equal((await webhook(app, 'movie', 7300777, ALICE)).status, 202);
    await app.requests.refresh();
    assert.deepEqual(deferred(app).sort(), ['7300603', '7300777']);
    assert.equal(app.store.listAppRequestIntents().length, 1);
    now += APP_SETTLE_DEADLINE_MS + 1000;
    await app.requests.refresh();
    assert.deepEqual(app.store.listAppRequestIntents(), []);
    assert.equal(metric(app, 'jfa_app_get_this_branches_total', 'branch="intent_abandoned"'), 1);
    assert.deepEqual(deferred(app), []);
    // Bob's is granted to his household as before; Alice's (her intent's, maybe) follows the join rules.
    const grant = app.store.get(ITEMS.tMovie);
    assert.deepEqual([Object.keys(grant.requests), grant.groupIds], [['7300603'], ['mill']]);
    assert.equal(app.store.hasHandledRequest('7300777'), true);
  });
});

describe('"Get this": the administrator\'s readout of what is outstanding', { timeout: 60_000 }, () => {
  const DAY = 24 * 60 * 60 * 1000;
  const at = (offset) => new Date(Date.now() + offset).toISOString();
  const marker = (created, expires, requestIds, extra = {}) => ({ mediaType: 'movie', tmdbId: T_MOVIE, requestIds, createdAt: at(created), expiresAt: at(expires), ...extra });
  const OUTSTANDING = {
    ...SEED,
    handledRequestIds: ['7400002', '7400004'],
    appSafetyTombstones: {
      // Past its 30 days, but its request is not handled yet: it still decides that grant.
      unhandled: marker(-40 * DAY, -10 * DAY, ['7400001']),
      // Its request is handled: it decides nothing any more.
      handled: marker(-DAY, 29 * DAY, ['7400002']),
      // Member-wide, within its 30 days: it covers the member's later requests.
      member: marker(-2 * DAY, 28 * DAY, [], { mediaType: 'tv', tmdbId: T_TV, jellyfinUserId: ALICE, since: at(-2 * DAY) }),
      // Member-wide, expired, and its candidate handled.
      expired: marker(-31 * DAY, -DAY, ['7400004'], { jellyfinUserId: BOB, since: at(-31 * DAY) }),
      // Never handled, but older than the 400 days anything is kept.
      ancient: marker(-401 * DAY, -371 * DAY, ['7400005']),
    },
    appRequestIntents: {
      one: lostIntent(Date.now() - 60 * 60 * 1000),
      two: { ...lostIntent(Date.now() - 60 * 1000), householdId: 'mill', jellyfinUserId: BOB, mediaType: 'tv', tmdbId: T_TV, seasons: [1], status: 'settling', seerrRequestId: '7400006', householdEpoch: 2 },
    },
    deferredWebhooks: [{ notificationType: 'MEDIA_AVAILABLE', request: { id: '7400006' } }],
  };
  const admin = (app, pathname, headers = { Authorization: 'Bearer admin-secret' }, host = 'jellypass.example.test') =>
    get(app.portFor(host), pathname, { Host: host, ...headers });

  it('counts the safety markers that still decide a grant and the unsettled requests, by kind, with their oldest age', async (t) => {
    const app = await start(t, world(), { stateFile: OUTSTANDING });
    const answer = await admin(app, '/v1/app/outstanding');
    assert.equal(answer.status, 200);
    const readout = answer.json();
    assert.equal(readout.clear, false);
    assert.deepEqual(readout.safetyMarkers.byKind, { request: 1, member: 1 });
    assert.equal(readout.safetyMarkers.total, 2);
    assert.ok(Math.abs(readout.safetyMarkers.oldestAgeSeconds - 40 * 86_400) < 60);
    assert.deepEqual(readout.safetyMarkers.entries.map((entry) => [entry.kind, entry.mediaType, entry.tmdbId]), [['request', 'movie', T_MOVIE], ['member', 'tv', T_TV]]);
    assert.deepEqual(readout.requestIntents.byKind, { submitting: 1, settling: 1 });
    assert.ok(Math.abs(readout.requestIntents.oldestAgeSeconds - 3600) < 60);
    assert.deepEqual(readout.requestIntents.entries.map((entry) => [entry.kind, entry.mediaType, entry.tmdbId, entry.householdId]), [
      ['submitting', 'movie', T_MOVIE, 'grove'], ['settling', 'tv', T_TV, 'mill'],
    ]);
    assert.deepEqual(readout.deferredWebhooks, { total: 1 });
    // Titles and households, never a member or a Seerr request.
    assert.doesNotMatch(answer.text, new RegExp(`${ALICE}|${BOB}|74000`));
    // The metrics carry the counts only.
    const metrics = app.service.renderMetrics();
    for (const line of ['jfa_app_safety_markers{kind="request"} 1', 'jfa_app_safety_markers{kind="member"} 1',
      'jfa_app_request_intents{status="submitting"} 1', 'jfa_app_request_intents{status="settling"} 1', 'jfa_app_deferred_webhooks 1']) {
      assert.ok(metrics.split('\n').includes(line), line);
    }
    assert.doesNotMatch(metrics.split('\n').filter((line) => line.startsWith('jfa_app_')).join('\n'), new RegExp(`${T_MOVIE}|${T_TV}|grove|mill`));
  });

  it('is clear, with every count 0, once nothing is outstanding', async (t) => {
    const app = await start(t, world());
    const readout = (await admin(app, '/v1/app/outstanding')).json();
    assert.deepEqual(readout, {
      clear: true,
      safetyMarkers: { total: 0, byKind: { request: 0, member: 0 }, oldestAgeSeconds: null, entries: [] },
      requestIntents: { total: 0, byKind: { submitting: 0, settling: 0 }, oldestAgeSeconds: null, entries: [] },
      deferredWebhooks: { total: 0 },
      withdrawals: { total: 0, byKind: { waiting: 0, granted: 0 }, titleHolds: 0, held: 0, oldestAgeSeconds: null, entries: [] },
    });
    assert.match(app.service.renderMetrics(), /^jfa_app_safety_markers\{kind="member"\} 0$/m);
    assert.match(app.service.renderMetrics(), /^jfa_app_withdrawals\{kind="waiting"\} 0$/m);
    assert.match(app.service.renderMetrics(), /^jfa_app_held_titles 0$/m);
  });

  it('answers only the administrator, and only on the admin host', async (t) => {
    const app = await start(t, world(), { stateFile: OUTSTANDING });
    assert.equal((await admin(app, '/v1/app/outstanding', {})).status, 401);
    assert.equal((await admin(app, '/v1/app/outstanding', { Authorization: 'Bearer webhook-secret' })).status, 401);
    assert.equal((await admin(app, '/v1/app/outstanding', { Authorization: 'Bearer admin-secret' })).status, 200);
    // A household host never serves it, nor the metrics, whoever asks: with the admin token, as a member, or as no one.
    for (const host of [HOST_A, HOST_B]) {
      for (const pathname of ['/v1/app/outstanding', '/jellypass/app/v1/outstanding', '/metrics']) {
        for (const headers of [{ Authorization: 'Bearer admin-secret' }, { Authorization: 'MediaBrowser Token="token-alice"' }, {}]) {
          const answer = await admin(app, pathname, headers, host);
          assert.notEqual(answer.status, 200, `${host} ${pathname}`);
          assert.doesNotMatch(answer.text, /safetyMarkers|requestIntents|jfa_app_/, `${host} ${pathname}`);
        }
      }
    }
  });
});
