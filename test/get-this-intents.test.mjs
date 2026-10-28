// "Get this": late requests, as Codex's review of 6e129e6 found them (docs/app-design.md, "Late requests"). Each test
// here fails on 6e129e6: a webhook arriving before Seerr answers the request, a restart while a request was being made,
// a settle-time read that fails, a title Jellyfin holds without TMDB metadata or a Seerr link, and the order of the
// request branch's last steps.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { makeTempDir } from './support/temp-dir.mjs';
import { APP_INTENT_TIMEOUT_MS, APP_SETTLE_DEADLINE_MS } from '../dist/household-requests.js';
import { GrantStore } from '../dist/store.js';
import {
  ALICE,
  BOB,
  ITEMS,
  SEERR_IDS,
  T_MOVIE,
  T_TV,
  UNSAVED_INTENT,
  seerrRequest,
  startApp,
  world,
} from './support/household-app.mjs';

const APP = '/jellypass/app/v1';
const GET_MOVIE = `${APP}/movie/${T_MOVIE}/get`;
const GET_TV = `${APP}/tv/${T_TV}/get`;
const OTHER_MOVIE = 900010;
const SEED = { version: 7, grants: {}, groups: {}, catalog: { items: {} }, passwordlessUserIds: [], appIdKey: 'ab'.repeat(32) };
const tmdbMovies = { [OTHER_MOVIE]: { title: 'Synthetic Movie Ten', release_date: '2021-01-01' } };

function request({ id, seerrUser, type = 'movie', tmdbId = type === 'movie' ? T_MOVIE : T_TV, status = 1, seasons }) {
  const made = seerrRequest({ type, tmdbId, status, seasons: type === 'tv' ? seasons : undefined });
  made.id = id;
  made.createdAt = new Date().toISOString();
  made.requestedBy = { ...made.requestedBy, id: seerrUser };
  return made;
}

const movieItem = (extra = {}) => ({ Id: ITEMS.tMovie, Name: 'Synthetic Movie One', Type: 'Movie', ProviderIds: { Tmdb: String(T_MOVIE) }, Tags: [], library: 'shared', ...extra });
const seriesItem = (extra = {}) => ({ Id: ITEMS.tSeries, Name: 'Synthetic Series Two', Type: 'Series', ProviderIds: { Tmdb: String(T_TV) }, Tags: [], library: 'shared', ...extra });
const episode = (season) => ({ Id: `4444000044440000444400004444000${season}`, SeriesId: ITEMS.tSeries, ParentIndexNumber: season });
const bobsMovieGrant = { request: { itemId: ITEMS.tMovie, mediaType: 'movie', requestId: '7300501', userId: BOB, groupIds: ['mill'] } };
const bobsSeriesGrant = { request: { itemId: ITEMS.tSeries, mediaType: 'tv', requestId: '7300502', userId: BOB, groupIds: ['mill'] } };

const start = (t, state, options = {}) => startApp(t, state, { reconcile: true, stateFile: SEED, ...options });

async function getThis(app, pathname = GET_MOVIE, body = undefined, options = {}) {
  const answer = await app.post(pathname, body, options);
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

/** Holds Seerr's answer to the next request after Seerr has made it; resolves the release once it has. */
async function holdAfterMade(app) {
  let release;
  app.seerr.state.holdCreated = new Promise((resolve) => { release = resolve; });
  return {
    made: () => until(() => (app.seerr.state.requests[SEERR_IDS[ALICE]] ?? []).length === 1, 'Seerr to make the request'),
    release: () => {
      app.seerr.state.holdCreated = undefined;
      release();
    },
  };
}

const deferred = (app) => app.store.listDeferredWebhooks().map((event) => event.request.id);
const requestRecord = (app) => app.store.listAppRequests().map(([, record]) => record).find((record) => record.branch === 'request');

describe('"Get this": a webhook that arrives before Seerr answers the request (Codex 1)', { timeout: 60_000 }, () => {
  it('defers it, then grants it by the join rules: a public title stays public, a held one is joined', async (t) => {
    for (const held of [false, true]) {
      const app = await start(t, world({ tmdbMovies, autoApprove: true }));
      const hold = await holdAfterMade(app);
      await app.post(GET_MOVIE);
      await hold.made();
      // The title arrives while Seerr has not answered yet, and Seerr reports the request available at once.
      app.jellyfin.state.items.push(movieItem());
      if (held) await app.store.grant(bobsMovieGrant.request);
      app.seerr.state.requests[SEERR_IDS[ALICE]][0].status = 5;
      assert.equal((await webhook(app, 'movie', 7350001, ALICE)).status, 202);
      assert.deepEqual(app.store.get(ITEMS.tMovie)?.groupIds, held ? ['mill'] : undefined);
      assert.equal(app.store.hasHandledRequest('7350001'), false);
      assert.deepEqual(deferred(app), ['7350001']);
      assert.match(app.service.renderMetrics(), /jfa_webhooks_total\{result="deferred"\} 1/);
      hold.release();
      await app.background.settled();
      assert.equal(requestRecord(app).joinOnGrant, 'present-at-settle');
      assert.deepEqual(app.store.listAppRequestIntents(), []);
      // Granted once settled: never a new private grant, and never Alice's own request on Bob's grant.
      assert.deepEqual(deferred(app), []);
      assert.equal(app.store.hasHandledRequest('7350001'), true, String(held));
      assert.deepEqual(app.store.get(ITEMS.tMovie)?.groupIds, held ? ['grove', 'mill'] : undefined, String(held));
      assert.ok(!Object.keys(app.store.get(ITEMS.tMovie)?.requests ?? {}).includes('7350001'));
    }
  });

  it('defers another member\'s request for the title only until the intent is resolved, then grants it as before', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    let release;
    app.seerr.state.holdRequests = new Promise((resolve) => { release = resolve; });
    await app.post(GET_MOVIE);
    await until(() => app.seerr.posts.length === 1, 'the request');
    // Bob requested the movie just before Alice's request reached Seerr; it is available already.
    app.seerr.state.requests[SEERR_IDS[BOB]] = [request({ id: 7300603, seerrUser: SEERR_IDS[BOB], status: 5 })];
    app.jellyfin.state.items.push(movieItem());
    assert.equal((await webhook(app, 'movie', 7300603, BOB)).status, 202);
    assert.equal(app.store.get(ITEMS.tMovie), undefined);
    release();
    await app.background.settled();
    // Seerr refused Alice's as a duplicate (nothing made): Bob's is granted to his household, and Alice's household
    // joins it through her interest.
    assert.deepEqual(app.store.listAppRequestIntents(), []);
    assert.deepEqual(Object.keys(app.store.get(ITEMS.tMovie).requests), ['7300603']);
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, ['grove', 'mill']);
  });

  it('skips the request in the backfill until it is settled, then grants it by the join rules', async (t) => {
    const app = await start(t, world({ tmdbMovies, autoApprove: true }));
    const hold = await holdAfterMade(app);
    await app.post(GET_MOVIE);
    await hold.made();
    app.jellyfin.state.items.push(movieItem());
    const made = app.seerr.state.requests[SEERR_IDS[ALICE]][0];
    made.media = { ...made.media, status: 5, jellyfinMediaId: ITEMS.tMovie };
    const first = await app.service.backfillRequests(new Date(0));
    assert.deepEqual([first.granted, app.store.hasHandledRequest('7350001')], [[], false]);
    assert.match(app.service.renderMetrics(), /jfa_request_backfill_total\{result="deferred"\} 1/);
    hold.release();
    await app.background.settled();
    const second = await app.service.backfillRequests(new Date(0));
    assert.deepEqual([second.granted, app.store.hasHandledRequest('7350001'), app.store.get(ITEMS.tMovie)], [[], true, undefined]);
  });
});

describe('"Get this": a restart while a request is being made (Codex 2)', { timeout: 60_000 }, () => {
  /** A state file as JellyPass leaves it when it stops after Seerr made Alice's request and before it answered. */
  async function stoppedMidRequest(t, state) {
    const first = await start(t, state);
    const hold = await holdAfterMade(first);
    await first.post(GET_MOVIE);
    await hold.made();
    const saved = JSON.parse(await readFile(first.stateFile, 'utf8'));
    t.after(async () => {
      hold.release();
      await first.background.settled();
    });
    return saved;
  }

  it('finds the intent on disk, defers the request\'s webhook, and records the request by the join rules', async (t) => {
    const state = world({ tmdbMovies, autoApprove: true });
    const saved = await stoppedMidRequest(t, state);
    assert.deepEqual(Object.values(saved.appRequestIntents).map((intent) => [intent.status, intent.jellyfinUserId, intent.tmdbId]), [['submitting', ALICE, T_MOVIE]]);
    assert.equal(saved.appRequests, undefined);
    const app = await start(t, state, { stateFile: saved });
    state.items.push(movieItem());
    state.requests[SEERR_IDS[ALICE]][0].status = 5;
    // Before the intent is reconciled, the webhook grants nothing.
    assert.equal((await webhook(app, 'movie', 7350001, ALICE)).status, 202);
    assert.equal(app.store.get(ITEMS.tMovie), undefined);
    await app.requests.refresh();
    // The request Seerr made is recorded for the household, and the title is there now: its grant follows the join rules.
    const record = requestRecord(app);
    assert.deepEqual([record.householdId, record.seerrRequestId, record.joinOnGrant], ['grove', '7350001', 'present-at-settle']);
    assert.deepEqual(app.store.listAppRequestIntents(), []);
    assert.equal(app.store.hasHandledRequest('7350001'), true);
    assert.equal(app.store.get(ITEMS.tMovie), undefined);
    assert.equal(metric(app, 'jfa_app_get_this_branches_total', 'branch="intent_recovered"'), 1);
  });

  it('records a recovered request whose title is still absent as genuine, granted when it arrives', async (t) => {
    const state = world({ tmdbMovies });
    const app = await start(t, state, { stateFile: await stoppedMidRequest(t, state) });
    await app.requests.refresh();
    assert.equal(requestRecord(app).joinOnGrant, undefined);
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).json().state, 'requested');
    state.items.push(movieItem());
    state.requests[SEERR_IDS[ALICE]][0].status = 5;
    assert.equal((await webhook(app, 'movie', 7350001, ALICE)).status, 200);
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, ['grove']);
  });

  it('removes an intent whose request Seerr never made, once the request could no longer arrive', async (t) => {
    let now = Date.now();
    const intent = {
      householdId: 'grove', jellyfinUserId: ALICE, mediaType: 'movie', tmdbId: T_MOVIE, seasons: [],
      observedAbsentAt: new Date(now).toISOString(), createdAt: new Date(now).toISOString(), status: 'submitting',
    };
    const app = await start(t, world({ tmdbMovies }), { stateFile: { ...SEED, appRequestIntents: { lost: intent } }, now: () => now });
    await app.requests.refresh();
    assert.equal(app.store.listAppRequestIntents().length, 1);
    // Meanwhile the household's "Get this" for the title does nothing: the request may still be on its way.
    await getThis(app);
    assert.deepEqual(app.seerr.posts, []);
    now += APP_INTENT_TIMEOUT_MS + 1000;
    await app.requests.refresh();
    assert.deepEqual(app.store.listAppRequestIntents(), []);
    assert.deepEqual(app.store.listAppRequests(), []);
    await getThis(app);
    assert.equal(app.seerr.posts.length, 1);
  });

  it('leaves an intent for the next run when Seerr cannot be read', async (t) => {
    const now = Date.now() + APP_INTENT_TIMEOUT_MS * 10;
    const intent = {
      householdId: 'grove', jellyfinUserId: ALICE, mediaType: 'movie', tmdbId: T_MOVIE, seasons: [],
      observedAbsentAt: new Date().toISOString(), createdAt: new Date().toISOString(), status: 'submitting',
    };
    const app = await start(t, world({ tmdbMovies }), { stateFile: { ...SEED, appRequestIntents: { lost: intent } }, now: () => now });
    app.seerr.state.titlesFail = true;
    await app.requests.refresh();
    assert.equal(app.store.listAppRequestIntents().length, 1);
  });
});

describe('"Get this": a settle-time read that fails (Codex 3)', { timeout: 60_000 }, () => {
  /** Alice's request is made while the title arrives, and Jellyfin cannot answer when it settles. */
  async function unsettled(t, { arrives = true } = {}) {
    let now = Date.now();
    const app = await start(t, world({ tmdbMovies }), { now: () => now });
    const hold = await holdAfterMade(app);
    await app.post(GET_MOVIE);
    await hold.made();
    if (arrives) app.jellyfin.state.items.push(movieItem());
    app.jellyfin.down = true;
    hold.release();
    await app.background.settled();
    return { app, advance: (ms) => { now += ms; } };
  }

  it('records the request but never grants it privately: deferred while it is retried, then by the join rules', async (t) => {
    const { app, advance } = await unsettled(t);
    const record = requestRecord(app);
    assert.deepEqual([record.seerrRequestId, record.joinOnGrant], ['7350001', undefined]);
    assert.deepEqual(app.store.listAppRequestIntents().map(([, intent]) => [intent.status, intent.seerrRequestId]), [['settling', '7350001']]);
    app.seerr.state.requests[SEERR_IDS[ALICE]][0].status = 5;
    assert.equal((await webhook(app, 'movie', 7350001, ALICE)).status, 202);
    assert.equal(app.store.get(ITEMS.tMovie), undefined);
    // Still unreadable before the deadline: nothing changes.
    await app.requests.refresh();
    assert.equal(app.store.listAppRequestIntents().length, 1);
    assert.equal(app.store.get(ITEMS.tMovie), undefined);
    // Past the deadline, still unreadable: the join rules, so the public title stays public.
    advance(APP_SETTLE_DEADLINE_MS + 1000);
    await app.requests.refresh();
    assert.equal(requestRecord(app).joinOnGrant, 'unverified');
    assert.deepEqual(app.store.listAppRequestIntents(), []);
    assert.equal(app.store.hasHandledRequest('7350001'), true);
    assert.equal(app.store.get(ITEMS.tMovie), undefined);
    assert.equal(metric(app, 'jfa_app_get_this_branches_total', 'branch="settle_unverified"'), 1);
  });

  it('settles the request on the next refresh once Jellyfin answers: by the join rules if the title is there', async (t) => {
    const { app } = await unsettled(t);
    app.jellyfin.down = false;
    await app.requests.refresh();
    assert.equal(requestRecord(app).joinOnGrant, 'present-at-settle');
    assert.deepEqual(app.store.listAppRequestIntents(), []);
  });

  it('settles a request whose title is still absent as genuine', async (t) => {
    const { app } = await unsettled(t, { arrives: false });
    app.jellyfin.down = false;
    await app.requests.refresh();
    assert.equal(requestRecord(app).joinOnGrant, undefined);
    assert.deepEqual(app.store.listAppRequestIntents(), []);
    app.jellyfin.state.items.push(movieItem());
    app.seerr.state.requests[SEERR_IDS[ALICE]][0].status = 5;
    assert.equal((await webhook(app, 'movie', 7350001, ALICE)).status, 200);
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, ['grove']);
  });

  it('leaves an intent to be reconciled when Seerr may have made the request without answering', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    let release;
    app.seerr.state.holdCreated = new Promise((resolve) => { release = resolve; });
    app.seerr.state.failCreated = true;
    await app.post(GET_MOVIE);
    await until(() => (app.seerr.state.requests[SEERR_IDS[ALICE]] ?? []).length === 1, 'the request');
    release();
    await app.background.settled();
    // Seerr answered 500 after making it: nothing recorded yet, and the intent stays.
    assert.deepEqual(app.store.listAppRequests(), []);
    assert.equal(app.store.listAppRequestIntents().length, 1);
    assert.equal(metric(app, 'jfa_app_get_this_branches_total', 'branch="request_uncertain"'), 1);
    await app.requests.refresh();
    assert.equal(requestRecord(app).seerrRequestId, '7350001');
    assert.deepEqual(app.store.listAppRequestIntents(), []);
  });
});

describe('"Get this": titles without TMDB metadata or a Seerr link (Codex 4)', { timeout: 60_000 }, () => {
  it('never requests a title Jellyfin holds without either: found by name (and year), it goes to the join branch', async (t) => {
    for (const held of [false, true]) {
      const app = await start(t, world({
        items: [movieItem({ ProviderIds: {}, ProductionYear: 2020 }), seriesItem({ ProviderIds: {} })],
        episodes: [episode(1)],
        grants: held ? [bobsMovieGrant, bobsSeriesGrant] : [],
      }));
      await getThis(app);
      await getThis(app, GET_TV, { seasons: [1] });
      assert.deepEqual(app.seerr.posts, [], String(held));
      assert.deepEqual(app.store.listAppRequestIntents(), []);
      if (held) {
        assert.deepEqual(app.store.listAppRequests().map(([, record]) => [record.mediaType, record.branch]).sort(), [['movie', 'join'], ['tv', 'join']]);
        assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, ['grove', 'mill']);
      } else {
        // Public: there is no grant to join, and nothing to request either.
        assert.equal(metric(app, 'jfa_app_get_this_branches_total', 'branch="join_ungranted"'), 2);
      }
    }
  });

  it('takes an item of another year, or with another TMDB ID, as another title, and requests this one', async (t) => {
    for (const item of [movieItem({ ProviderIds: {}, ProductionYear: 1990 }), movieItem({ ProviderIds: { Tmdb: '424242' } })]) {
      const app = await start(t, world({ items: [item] }));
      await getThis(app);
      assert.equal(app.seerr.posts.length, 1, JSON.stringify(item.ProviderIds));
    }
  });
});

describe('"Get this": the request branch\'s last steps (Codex 5)', { timeout: 60_000 }, () => {
  it('writes the intent and confirms the caller first: the Jellyfin read is the last step before the request is sent', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    const events = [];
    const seerrPush = app.seerr.calls.push.bind(app.seerr.calls);
    app.seerr.calls.push = (call) => {
      events.push(`seerr ${call.method} ${call.pathname}`);
      return seerrPush(call);
    };
    app.jellyfin.state.onAdminRead = (pathname) => events.push(`jellyfin ${pathname}`);
    let atRequest;
    const postsPush = app.seerr.posts.push.bind(app.seerr.posts);
    app.seerr.posts.push = (post) => {
      atRequest = { memory: app.store.listAppRequestIntents(), disk: readFile(app.stateFile, 'utf8') };
      return postsPush(post);
    };
    await getThis(app);
    const sent = events.indexOf('seerr POST /api/v1/request');
    assert.ok(sent > 0);
    const lastSeerr = events.slice(0, sent).findLastIndex((event) => event.startsWith('seerr '));
    // The caller's Seerr user was confirmed, then Jellyfin read, and nothing else before the request.
    assert.equal(events[lastSeerr], `seerr GET /api/v1/user/${SEERR_IDS[ALICE]}`);
    const between = events.slice(lastSeerr + 1, sent);
    assert.ok(between.length > 0 && between.every((event) => event.startsWith('jellyfin ')), JSON.stringify(between));
    // The intent was in memory and on disk when the request reached Seerr.
    assert.deepEqual(atRequest.memory.map(([, intent]) => intent.status), ['submitting']);
    assert.deepEqual(Object.values(JSON.parse(await atRequest.disk).appRequestIntents).map((intent) => intent.status), ['submitting']);
    assert.deepEqual(app.store.listAppRequestIntents(), []);
  });

  it('sends no request when its intent cannot be written to disk', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    // The state file's path is now a directory with something in it: the store's rename over it fails.
    await rm(app.stateFile);
    await mkdir(app.stateFile);
    await writeFile(path.join(app.stateFile, 'in-the-way'), '');
    await getThis(app);
    assert.deepEqual(app.seerr.posts, []);
    assert.equal(metric(app, 'jfa_app_get_this_branches_total', 'branch="error"'), 1);
  });

  it('sends nothing when the caller\'s Seerr mapping is invalidated after they were confirmed', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    let reads = 0;
    app.jellyfin.state.onAdminRead = (pathname) => {
      // The branch's first read is two lookups; the next one is the re-check before the request.
      if (pathname === '/Items' && ++reads === 3) app.members.invalidate(ALICE);
    };
    await getThis(app);
    assert.deepEqual(app.seerr.posts, []);
    assert.deepEqual(app.store.listAppRequestIntents(), []);
    assert.deepEqual(app.store.listAppRequests(), []);
    assert.equal(metric(app, 'jfa_app_get_this_branches_total', 'branch="request_refused"'), 1);
  });
});

describe('"Get this": the intent is on disk before its request is sent', { timeout: 60_000 }, () => {
  const intent = () => ({
    householdId: 'grove', jellyfinUserId: ALICE, mediaType: 'movie', tmdbId: T_MOVIE, seasons: [],
    observedAbsentAt: new Date().toISOString(), createdAt: new Date().toISOString(), status: 'submitting',
  });

  it('knows which intents the state file holds: none while a write is in flight or failed, each once it is renamed into place', async (t) => {
    const stateFile = path.join(await makeTempDir(t, 'jfa-intents-'), 'grants.json');
    const store = new GrantStore(stateFile);
    await store.load();
    const writing = store.addAppRequestIntent(intent());
    const [[id]] = store.listAppRequestIntents();
    assert.equal(store.isAppRequestIntentDurable(id), false);
    assert.equal(await writing, id);
    assert.equal(store.isAppRequestIntentDurable(id), true);
    // Loaded from disk, it is there.
    const reloaded = new GrantStore(stateFile);
    await reloaded.load();
    assert.equal(reloaded.isAppRequestIntentDurable(id), true);
    // A write that fails leaves the new intent in memory only.
    await rm(stateFile);
    await mkdir(stateFile);
    await writeFile(path.join(stateFile, 'in-the-way'), '');
    await assert.rejects(reloaded.addAppRequestIntent(intent()));
    const unsaved = reloaded.listAppRequestIntents().map(([entry]) => entry).find((entry) => entry !== id);
    assert.equal(reloaded.isAppRequestIntentDurable(unsaved), false);
    assert.equal(reloaded.isAppRequestIntentDurable(id), true);
  });

  it('sends nothing if the intent\'s write was not awaited and did not reach the disk', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    // The regression this guards against: the intent's write is no longer awaited (and here it fails).
    const write = app.store.addAppRequestIntent.bind(app.store);
    app.store.addAppRequestIntent = async (entry, claim) => {
      const before = new Set(app.store.listAppRequestIntents().map(([id]) => id));
      write(entry, claim).catch(() => undefined);
      return app.store.listAppRequestIntents().map(([id]) => id).find((id) => !before.has(id));
    };
    await rm(app.stateFile);
    await mkdir(app.stateFile);
    await writeFile(path.join(app.stateFile, 'in-the-way'), '');
    await getThis(app);
    assert.deepEqual(app.seerr.posts, []);
    assert.equal(metric(app, 'jfa_app_get_this_branches_total', 'branch="request_unsaved"'), 1);
    assert.deepEqual(app.store.listAppRequests(), []);
  });

  it('fails any test in which a request reaches Seerr before an intent for its title is on disk', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    // A request sent as the member with no intent at all, as a regression in the request branch would.
    const sender = await app.members.member(ALICE).confirmRequester();
    await sender.createRequest({ mediaType: 'movie', tmdbId: T_MOVIE });
    assert.deepEqual(app.seerr.violations, [UNSAVED_INTENT]);
    // Cleared, or this test would fail as the check means it to.
    app.seerr.violations.length = 0;
    // A request "Get this" sends is checked the same way, and passes.
    await getThis(app, `${APP}/movie/${OTHER_MOVIE}/get`);
    assert.equal(app.seerr.posts.length, 2);
    assert.deepEqual(app.seerr.violations, []);
  });

  it('checks a request that reaches Seerr as the test ends against the state file, still there', async () => {
    // A test context of its own, whose hooks run as node:test runs them: in the order they were registered.
    const hooks = [];
    const context = { name: 'late request', fullName: 'late request', after: (hook) => hooks.push(hook) };
    const app = await start(context, world({ tmdbMovies }));
    await app.store.addAppRequestIntent(intent());
    const sender = await app.members.member(ALICE).confirmRequester();
    // A branch still in flight when the test body ends: its request reaches Seerr while the app is being shut down.
    const close = app.seerr.close;
    app.seerr.close = async () => {
      await sender.createRequest({ mediaType: 'movie', tmdbId: T_MOVIE });
      return close();
    };
    for (const hook of hooks) await hook();
    assert.equal(app.seerr.posts.length, 1);
    assert.deepEqual(app.seerr.violations, []);
    assert.equal(existsSync(path.dirname(app.stateFile)), false);
  });
});

describe('"Get this": a reconciliation that runs while a call\'s intent is being written', { timeout: 60_000 }, () => {
  // Each test here fails on 19d193c, where a call claimed its intent only once the state file had it: a reconciliation
  // that listed it meanwhile retired it, and the call then sent nothing (`request_unsaved`).
  /**
   * Holds the call's intent write until released, once the intent is in memory: a reconciliation run meanwhile lists
   * it. Resolves `written` with the intent's ID.
   */
  function holdIntentWrite(app) {
    const write = app.store.addAppRequestIntent.bind(app.store);
    let release;
    let written;
    const gate = new Promise((resolve) => { release = resolve; });
    const entered = new Promise((resolve) => { written = resolve; });
    app.store.addAppRequestIntent = (entry, claim) => {
      app.store.addAppRequestIntent = write;
      const before = new Set(app.store.listAppRequestIntents().map(([id]) => id));
      const writing = write(entry, claim);
      written(app.store.listAppRequestIntents().map(([id]) => id).find((id) => !before.has(id)));
      return gate.then(() => writing);
    };
    return { written: entered, release };
  }

  const declined = (id) => request({ id, seerrUser: SEERR_IDS[ALICE], status: 3 });
  const variants = {
    'Seerr has a declined request by the caller for the title': { requests: [declined(7300701)] },
    'Seerr has several requests by the caller for the title': { requests: [declined(7300701), declined(7300702)] },
    'the household was replaced meanwhile': { requests: [declined(7300701)], replace: true },
  };

  for (const [kind, variant] of Object.entries(variants)) {
    it(`leaves the call's intent alone when ${kind}: one request is sent and recorded`, async (t) => {
      const app = await start(t, world({ tmdbMovies, requests: { [SEERR_IDS[ALICE]]: variant.requests } }));
      let atRequest;
      const postsPush = app.seerr.posts.push.bind(app.seerr.posts);
      app.seerr.posts.push = (post) => {
        atRequest = { memory: app.store.listAppRequestIntents().map(([id]) => id), disk: readFile(app.stateFile, 'utf8') };
        return postsPush(post);
      };
      const hold = holdIntentWrite(app);
      await app.post(GET_MOVIE);
      const intentId = await hold.written;
      assert.deepEqual(app.store.listAppRequestIntents().map(([id]) => id), [intentId]);
      if (variant.replace) {
        const household = app.store.getGroup('grove');
        await app.store.deleteGroup('grove');
        await app.store.upsertGroup({ id: household.id, name: household.name, userIds: household.userIds });
      }
      // The scheduled reconciliation (or startup's) runs to the end before the call's write completes.
      await app.requests.refresh();
      assert.deepEqual(app.store.listAppRequestIntents().map(([id]) => id), [intentId], kind);
      assert.deepEqual(app.store.listAppSafetyTombstones(), [], kind);
      hold.release();
      await app.background.settled();
      // Sent once, with its intent in memory and on disk.
      assert.equal(app.seerr.posts.length, 1, kind);
      assert.deepEqual(atRequest.memory, [intentId], kind);
      assert.ok(Object.keys(JSON.parse(await atRequest.disk).appRequestIntents ?? {}).includes(intentId), kind);
      for (const branch of ['request_unsaved', 'intent_ambiguous', 'intent_detached', 'intent_cancelled']) {
        assert.equal(metric(app, 'jfa_app_get_this_branches_total', `branch="${branch}"`), 0, `${kind}: ${branch}`);
      }
      const record = requestRecord(app);
      assert.deepEqual([record.status, record.seerrRequestId, record.householdId], ['pending', '7350001', 'grove'], kind);
      assert.equal(record.detached, variant.replace ? true : undefined, kind);
      if (!variant.replace) assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).json().state, 'requested', kind);
      assert.deepEqual(app.store.listAppRequestIntents(), [], kind);
      // A later reconciliation finds nothing to do.
      await app.requests.refresh();
      assert.deepEqual(requestRecord(app), record, kind);
    });
  }
});
