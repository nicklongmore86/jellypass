// "Get this": the rules Codex's review of PR #34 asked for. Each test here fails on 76485ea (see docs/app-design.md,
// "Get this" as implemented): the re-check before a request, items without TMDB metadata, quota accounting at every
// instant whichever branch ran, lifetime quotas, completed records freed with their media, a household deleted while a
// call ran, pruning that never changes a count, new seasons of a series Jellyfin has, per-season readiness, and the
// per-user lock.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { GrantStore, MAX_APP_REQUESTS_PER_HOUSEHOLD } from '../dist/store.js';
import {
  ALICE,
  ANN,
  BOB,
  HOST_B,
  ITEMS,
  SEERR_IDS,
  T_MOVIE,
  T_TV,
  seerrRequest,
  startApp,
  world,
} from './support/household-app.mjs';
import { makeTempDir } from './support/temp-dir.mjs';

const APP = '/jellypass/app/v1';
const GET_MOVIE = `${APP}/movie/${T_MOVIE}/get`;
const GET_TV = `${APP}/tv/${T_TV}/get`;
const OTHER_MOVIE = 900010;
const THIRD_MOVIE = 900011;
const OTHER_GET = `${APP}/movie/${OTHER_MOVIE}/get`;
const THIRD_GET = `${APP}/movie/${THIRD_MOVIE}/get`;
const SEED = { version: 7, grants: {}, groups: {}, catalog: { items: {} }, passwordlessUserIds: [], appIdKey: 'ab'.repeat(32) };
const DAY = 24 * 60 * 60 * 1000;
const tmdbMovies = {
  [OTHER_MOVIE]: { title: 'Synthetic Movie Ten', release_date: '2021-01-01' },
  [THIRD_MOVIE]: { title: 'Synthetic Movie Eleven', release_date: '2021-01-01' },
};

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

/** A metric's value, 0 when absent. */
function metric(app, name, labels) {
  const line = app.service.renderMetrics().split('\n').find((entry) => entry.startsWith(`${name}{${labels}} `));
  return line ? Number(line.split(' ').at(-1)) : 0;
}

const decided = (app) => metric(app, 'jfa_app_get_this_total', 'result="accepted"') + metric(app, 'jfa_app_get_this_total', 'result="ineligible"');

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

const state = async (app, pathname, options) => (await app.get(pathname, options)).json().state;
const listed = async (app, options) => (await app.get(`${APP}/requests`, options)).json().results.map(({ id: _, ...entry }) => entry);

describe('"Get this": Jellyfin is read again right before a request', { timeout: 60_000 }, () => {
  it('joins a movie, or a season, that arrives after the branch\'s first read, and never requests it', async (t) => {
    for (const [name, state, path, body, firstRead, arrive] of [
      ['movie', world({ tmdbMovies }), GET_MOVIE, undefined, '/Items', (jellyfin) => jellyfin.items.push(movieItem())],
      ['season', world({ items: [seriesItem()], episodes: [episode(1)] }), GET_TV, { seasons: [2] }, `/Shows/${ITEMS.tSeries}/Episodes`, (jellyfin) => jellyfin.episodes.push(episode(2))],
    ]) {
      const app = await start(t, state);
      let reads = 0;
      // It arrives as soon as the branch's first Jellyfin read has been answered.
      app.jellyfin.state.onAdminRead = (pathname) => {
        if (pathname === firstRead) reads += 1;
        if (pathname === firstRead && reads === 1) arrive(app.jellyfin.state);
      };
      await getThis(app, path, body);
      assert.deepEqual(app.seerr.posts, [], name);
      assert.equal(metric(app, 'jfa_app_get_this_branches_total', 'branch="request_late"'), 1, name);
    }
  });

  it('grants a request whose title arrived while it was being made as a join: a public title stays public, a held one is joined', async (t) => {
    for (const held of [false, true]) {
      const app = await start(t, world({ tmdbMovies }));
      let release;
      app.seerr.state.holdRequests = new Promise((resolve) => { release = resolve; });
      await app.post(GET_MOVIE);
      await until(() => app.seerr.posts.length === 1, 'the request');
      // The title arrives between the re-check and Seerr making the request.
      app.jellyfin.state.items.push(movieItem());
      release();
      await app.background.settled();
      const [[, record]] = app.store.listAppRequests();
      assert.equal(record.joinOnGrant, 'present-at-settle');
      // Held: it is Bob's, granted through his own request.
      if (held) await app.store.grant(bobsMovieGrant.request);
      app.seerr.state.requests[SEERR_IDS[ALICE]][0].status = 5;
      // Granted as a join: Bob's grant when there is one, otherwise nothing to grant (202).
      assert.equal((await webhook(app, 'movie', 7350001, ALICE)).status, held ? 200 : 202);
      // Never a new private grant: no grant for a public title, and only the household joined to Bob's.
      assert.deepEqual(app.store.get(ITEMS.tMovie)?.groupIds, held ? ['farmhouse', 'mill'] : undefined, String(held));
      assert.equal(app.store.hasHandledRequest('7350001'), true);
      assert.equal(await state(app, `${APP}/movie/${T_MOVIE}`, { host: HOST_B, user: BOB }), 'in_library');
      assert.deepEqual((await listed(app)).map((entry) => entry.status), ['ready']);
    }
  });

  it('grants a request as a join when Seerr reports it available before its record is written', async (t) => {
    const app = await start(t, world({ tmdbMovies }), { recordDelayMs: 1500 });
    let release;
    app.seerr.state.holdRequests = new Promise((resolve) => { release = resolve; });
    await app.post(GET_MOVIE);
    await until(() => app.seerr.posts.length === 1, 'the request');
    app.jellyfin.state.items.push(movieItem());
    release();
    await until(() => metric(app, 'jfa_app_get_this_branches_total', 'branch="request"') === 1, 'the request branch');
    assert.deepEqual(app.store.listAppRequests(), []);
    app.seerr.state.requests[SEERR_IDS[ALICE]][0].status = 5;
    await webhook(app, 'movie', 7350001, ALICE);
    assert.equal(app.store.get(ITEMS.tMovie), undefined);
    await app.background.settled();
    assert.equal(app.store.get(ITEMS.tMovie), undefined);
  });
});

describe('"Get this": items without TMDB metadata', { timeout: 60_000 }, () => {
  it('finds a title Jellyfin holds without a TMDB ID through the item Seerr links to it, and joins it instead of requesting it', async (t) => {
    const media = (tmdbId, mediaType, itemId) => ({ id: 7360000 + (tmdbId % 10000), mediaType, tmdbId, status: 5, jellyfinMediaId: itemId, requests: [] });
    const app = await start(t, world({
      items: [movieItem({ ProviderIds: {} }), seriesItem({ ProviderIds: {} })],
      episodes: [episode(1)],
      media: { [T_MOVIE]: media(T_MOVIE, 'movie', ITEMS.tMovie), [T_TV]: media(T_TV, 'tv', ITEMS.tSeries) },
      grants: [bobsMovieGrant, bobsSeriesGrant],
    }));
    await getThis(app);
    await getThis(app, GET_TV, { seasons: [1] });
    assert.deepEqual(app.seerr.posts, []);
    assert.deepEqual(app.store.listAppRequests().map(([, record]) => [record.mediaType, record.branch]).sort(), [['movie', 'join'], ['tv', 'join']]);
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, ['farmhouse', 'mill']);
    assert.deepEqual(app.store.get(ITEMS.tSeries).groupIds, ['farmhouse', 'mill']);
  });
});

describe('"Get this": every instant counts the same whichever branch the earlier call took', { timeout: 120_000 }, () => {
  const worlds = {
    request: (quotas) => world({ tmdbMovies, quotas }),
    interest: (quotas) => world({ tmdbMovies, quotas, requests: { [SEERR_IDS[BOB]]: [request({ id: 7300601, seerrUser: SEERR_IDS[BOB] })] } }),
    join: (quotas) => world({
      tmdbMovies,
      quotas,
      items: [movieItem()],
      grants: [bobsMovieGrant],
      requests: { [SEERR_IDS[BOB]]: [request({ id: 7300501, seerrUser: SEERR_IDS[BOB], status: 5 })] },
    }),
  };
  const branchMetric = { request: 'request', interest: 'interest', join: 'join_joined' };

  for (const limit of [1, 2]) {
    it(`decides a second call the same at a limit of ${limit}: while the first is pending, during its record delay, and after its record`, async (t) => {
      const seen = {};
      for (const [branch, make] of Object.entries(worlds)) {
        for (const phase of ['pending', 'delay', 'written']) {
          const app = await start(t, make({ [SEERR_IDS[ALICE]]: { movie: { limit, days: 7 } } }), { recordDelayMs: 1500 });
          let release;
          if (phase === 'pending') app.seerr.state.holdTitles = new Promise((resolve) => { release = resolve; });
          await app.post(GET_MOVIE);
          await until(() => decided(app) === 1, 'the first call\'s eligibility');
          if (phase === 'delay') await until(() => metric(app, 'jfa_app_get_this_branches_total', `branch="${branchMetric[branch]}"`) === 1, 'the first call\'s branch');
          if (phase === 'written') await app.background.settled();
          await app.post(OTHER_GET);
          await until(() => decided(app) === 2, 'the second call\'s eligibility');
          assert.equal(app.store.listAppRequests().length, phase === 'written' ? 1 : 0, `${branch} ${phase}`);
          seen[`${branch} ${phase}`] = metric(app, 'jfa_app_get_this_total', 'result="ineligible"') === 1 ? 'ineligible' : 'eligible';
          release?.();
          await app.background.settled();
        }
      }
      const expected = limit === 1 ? 'ineligible' : 'eligible';
      assert.deepEqual(seen, Object.fromEntries(Object.keys(seen).map((key) => [key, expected])));
    });
  }

  it('never reads the caller\'s quota while a request is being made as them, so the request is counted once', async (t) => {
    const app = await start(t, world({ tmdbMovies, quotas: { [SEERR_IDS[ALICE]]: { movie: { limit: 2, days: 7 } } } }));
    let release;
    // Seerr has made the request (its quota counts it) but has not answered yet.
    app.seerr.state.holdCreated = new Promise((resolve) => { release = resolve; });
    await app.post(GET_MOVIE);
    await until(() => app.seerr.state.requests[SEERR_IDS[ALICE]]?.length === 1, 'the request');
    await app.post(OTHER_GET);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(decided(app), 1);
    app.seerr.state.holdCreated = undefined;
    release();
    await app.background.settled();
    assert.equal(metric(app, 'jfa_app_get_this_total', 'result="accepted"'), 2);
    assert.equal(app.seerr.posts.length, 2);
  });

  it('decides concurrent calls one at a time under the caller\'s lock: two calls at a limit of one never both run', async (t) => {
    const app = await start(t, world({ tmdbMovies, quotas: { [SEERR_IDS[ALICE]]: { movie: { limit: 1, days: 7 } } } }));
    let release;
    app.seerr.state.holdQuota = new Promise((resolve) => { release = resolve; });
    await Promise.all([app.post(GET_MOVIE), app.post(OTHER_GET)]);
    const quotaReads = () => app.seerr.calls.filter((call) => call.pathname === '/api/v1/user/11/quota').length;
    await until(() => quotaReads() >= 1, 'a quota read');
    await new Promise((resolve) => setTimeout(resolve, 100));
    // The second call's read waits for the first call's decision, so it sees the unit the first one holds.
    assert.equal(quotaReads(), 1);
    release();
    await app.background.settled();
    assert.equal(app.seerr.posts.length, 1);
    assert.equal(metric(app, 'jfa_app_get_this_total', 'result="accepted"'), 1);
    assert.equal(metric(app, 'jfa_app_get_this_total', 'result="ineligible"'), 1);
  });
});

describe('"Get this": quota windows and freed units', { timeout: 60_000 }, () => {
  /** Whether Alice may ask for one more movie: a "Get this" for another one runs a branch. */
  async function eligible(app, pathname = OTHER_GET) {
    const before = metric(app, 'jfa_app_get_this_total', 'result="accepted"');
    await getThis(app, pathname);
    return metric(app, 'jfa_app_get_this_total', 'result="accepted"') > before;
  }

  it('counts every request ever made when Seerr\'s quota has no window (days 0), in the request and interest branches alike', async (t) => {
    const quotas = { [SEERR_IDS[ALICE]]: { movie: { limit: 1, days: 0 } } };
    for (const [branch, state] of [
      ['request', world({ tmdbMovies, quotas })],
      ['interest', world({ tmdbMovies, quotas, requests: { [SEERR_IDS[BOB]]: [request({ id: 7300601, seerrUser: SEERR_IDS[BOB] })] } })],
    ]) {
      let now = Date.now();
      const app = await start(t, state, { now: () => now });
      await getThis(app);
      now += 400 * DAY;
      assert.equal(await eligible(app), false, branch);
    }
  });

  it('frees a completed record\'s unit once the title\'s media record is deleted, in every branch, and stops listing it', async (t) => {
    const quotas = { [SEERR_IDS[ALICE]]: { movie: { limit: 1, days: 7 } } };
    const results = {};
    for (const branch of ['request', 'interest', 'join']) {
      const app = await start(t, branch === 'join'
        ? world({ tmdbMovies, quotas, items: [movieItem()], grants: [bobsMovieGrant], requests: { [SEERR_IDS[BOB]]: [request({ id: 7300501, seerrUser: SEERR_IDS[BOB], status: 5 })] } })
        : world({ tmdbMovies, quotas, requests: branch === 'interest' ? { [SEERR_IDS[BOB]]: [request({ id: 7300601, seerrUser: SEERR_IDS[BOB], status: 2 })] } : {} }));
      await getThis(app);
      if (branch !== 'join') {
        // The title arrives, its request completes, and its grant is created.
        const [seerrUser, requestId, user] = branch === 'request' ? [SEERR_IDS[ALICE], 7350001, ALICE] : [SEERR_IDS[BOB], 7300601, BOB];
        app.jellyfin.state.items.push(movieItem());
        app.seerr.state.requests[seerrUser][0].status = 5;
        await webhook(app, 'movie', requestId, user);
      }
      assert.deepEqual(app.store.listAppRequests().map(([, record]) => record.status), ['completed'], branch);
      assert.deepEqual((await listed(app)).map((entry) => entry.status), ['ready'], branch);
      const before = await eligible(app);
      // An administrator deletes the title's media record in Seerr, with every request on it.
      app.seerr.state.requests = {};
      await app.requests.refresh();
      results[branch] = { before, after: await eligible(app), status: app.store.listAppRequests().find(([, record]) => record.tmdbId === T_MOVIE)[1].status, listed: (await listed(app)).filter((entry) => entry.tmdbId === T_MOVIE) };
    }
    for (const branch of ['request', 'interest', 'join']) assert.deepEqual(results[branch], { before: false, after: true, status: 'deleted', listed: [] }, branch);
  });

  it('never prunes a record that still counts: more than 2,000 virtual requests in the window are all counted', async (t) => {
    const count = MAX_APP_REQUESTS_PER_HOUSEHOLD + 5;
    for (const [limit, expected] of [[count, [false, false]], [count + 1, [true, false]]]) {
      const app = await start(t, world({ tmdbMovies, quotas: { [SEERR_IDS[ALICE]]: { movie: { limit, days: 7 } } } }));
      const made = new Date(Date.now() - DAY).toISOString();
      await app.store.writeAppRequests({ add: Array.from({ length: count }, (_, index) => ({
        householdId: 'farmhouse', jellyfinUserId: ALICE, mediaType: 'movie', tmdbId: 800000 + index, seasons: [],
        branch: index % 2 ? 'interest' : 'join', status: 'completed', createdAt: made, updatedAt: made,
      })) });
      assert.deepEqual([await eligible(app), await eligible(app, THIRD_GET)], expected, String(limit));
    }
  });
});

describe('"Get this": households deleted while a call runs', { timeout: 60_000 }, () => {
  for (const [branch, make] of [
    ['request', () => world({ tmdbMovies })],
    ['interest', () => world({ tmdbMovies, requests: { [SEERR_IDS[BOB]]: [request({ id: 7300601, seerrUser: SEERR_IDS[BOB], status: 2 })] } })],
    ['join', () => world({ tmdbMovies, items: [movieItem()], grants: [bobsMovieGrant], requests: { [SEERR_IDS[BOB]]: [request({ id: 7300501, seerrUser: SEERR_IDS[BOB], status: 5 })] } })],
  ]) {
    it(`never gives a household created again under the same ID the ${branch} branch's record or join`, async (t) => {
      const app = await start(t, make());
      let release;
      app.seerr.state.holdTitles = new Promise((resolve) => { release = resolve; });
      await app.post(GET_MOVIE);
      await until(() => app.seerr.calls.some((call) => call.pathname === `/api/v1/movie/${T_MOVIE}`), 'the branch');
      await app.service.deleteGroup('farmhouse');
      await app.store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse again', userIds: [ALICE, ANN] });
      release();
      await app.background.settled();
      assert.ok(app.store.listAppRequests().every(([, record]) => record.detached), branch);
      assert.deepEqual(await listed(app), [], branch);
      assert.equal(await state(app, `${APP}/movie/${T_MOVIE}`), branch === 'join' ? 'get_this' : 'get_this', branch);
      if (branch === 'interest') {
        app.jellyfin.state.items.push(movieItem());
        app.seerr.state.requests[SEERR_IDS[BOB]][0].status = 5;
        await webhook(app, 'movie', 7300601, BOB);
        await app.requests.refresh();
      }
      assert.ok(!(app.store.get(ITEMS.tMovie)?.groupIds ?? []).includes('farmhouse'), branch);
    });
  }
});

describe('"Get this": new seasons of a series Jellyfin has', { timeout: 60_000 }, () => {
  it('requests the missing season, and keeps a public series public when it arrives', async (t) => {
    const app = await start(t, world({ items: [seriesItem()], episodes: [episode(1)] }));
    await getThis(app, GET_TV, { seasons: [1, 2] });
    assert.deepEqual(app.seerr.posts.map((post) => post.body.seasons), [[2]]);
    const [[, record]] = app.store.listAppRequests();
    assert.equal(record.joinOnGrant, 'existing-series');
    app.jellyfin.state.episodes.push(episode(2));
    app.seerr.state.requests[SEERR_IDS[ALICE]][0].status = 5;
    assert.equal((await webhook(app, 'tv', 7350001, ALICE)).status, 202);
    assert.equal(app.store.get(ITEMS.tSeries), undefined);
    assert.equal(await state(app, `${APP}/tv/${T_TV}`, { host: HOST_B, user: BOB }), 'in_library');
    assert.deepEqual(await listed(app), [{ mediaType: 'tv', tmdbId: T_TV, status: 'ready', seasons: [{ seasonNumber: 2, status: 'ready' }], byYou: true }]);
  });

  it('joins the household to a private series\' grant when the season arrives, and an administrator\'s removal sticks', async (t) => {
    for (const removed of [false, true]) {
      const app = await start(t, world({
        items: [seriesItem()],
        episodes: [episode(1)],
        grants: [bobsSeriesGrant],
        requests: { [SEERR_IDS[BOB]]: [request({ id: 7300502, seerrUser: SEERR_IDS[BOB], type: 'tv', status: 5, seasons: [1] })] },
      }));
      if (removed) {
        await app.service.setGrantGroups(ITEMS.tSeries, ['farmhouse', 'mill']);
        await app.service.setGrantGroups(ITEMS.tSeries, ['mill']);
      }
      await getThis(app, GET_TV, { seasons: [2] });
      assert.deepEqual(app.seerr.posts.map((post) => post.body.seasons), [[2]]);
      app.jellyfin.state.episodes.push(episode(2));
      app.seerr.state.requests[SEERR_IDS[ALICE]][0].status = 5;
      await webhook(app, 'tv', 7350001, ALICE);
      const grant = app.store.get(ITEMS.tSeries);
      assert.deepEqual(grant.groupIds, removed ? ['mill'] : ['farmhouse', 'mill'], String(removed));
      // Never Alice's own request on the grant, which would make her its owner whatever the removal.
      assert.ok(!Object.keys(grant.requests).includes('7350001'));
      assert.equal(await state(app, `${APP}/tv/${T_TV}`), removed ? 'get_this' : 'in_library', String(removed));
    }
  });
});

describe('"Get this": series ready season by season', { timeout: 60_000 }, () => {
  it('is ready only once every season asked for has episodes, partly ready until then, and refreshed until it is', async (t) => {
    let now = Date.now();
    const app = await start(t, world({ requests: { [SEERR_IDS[BOB]]: [request({ id: 7300602, seerrUser: SEERR_IDS[BOB], type: 'tv', status: 2, seasons: [1, 2] })] } }), { now: () => now });
    await getThis(app, GET_TV, { seasons: [1, 2] });
    assert.equal(app.store.listAppRequests()[0][1].branch, 'interest');
    // Season 1 arrives, and Bob's request is granted.
    app.jellyfin.state.items.push(seriesItem());
    app.jellyfin.state.episodes.push(episode(1));
    await webhook(app, 'tv', 7300602, BOB);
    assert.deepEqual(app.store.get(ITEMS.tSeries).groupIds, ['farmhouse', 'mill']);
    assert.deepEqual(await listed(app), [{ mediaType: 'tv', tmdbId: T_TV, status: 'requested', seasons: [{ seasonNumber: 1, status: 'ready' }, { seasonNumber: 2, status: 'requested' }], byYou: true }]);
    assert.equal(app.store.listAppRequests()[0][1].status, 'pending');
    assert.ok(app.requests.activeKeys('farmhouse').has(`tv:${T_TV}:2`));
    assert.ok(!app.requests.activeKeys('farmhouse').has(`tv:${T_TV}:1`));
    // Refreshed meanwhile, it still waits for season 2.
    now += 10 * 60 * 1000;
    await app.requests.refresh();
    assert.deepEqual([app.store.listAppRequests()[0][1].status, app.store.listAppRequests()[0][1].readySeasons], ['pending', [1]]);
    // Season 2 arrives later; the next refresh sees it.
    app.jellyfin.state.episodes.push(episode(2));
    now += 10 * 60 * 1000;
    await app.requests.refresh();
    assert.equal(app.store.listAppRequests()[0][1].status, 'completed');
    assert.deepEqual((await listed(app))[0].status, 'ready');
  });
});

describe('"Get this" records in the store: pruning never changes a count', () => {
  const record = (overrides = {}) => ({
    householdId: 'farmhouse', jellyfinUserId: ALICE, mediaType: 'movie', tmdbId: T_MOVIE, seasons: [], branch: 'interest', status: 'pending',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides,
  });

  it('keeps every pending record, whatever its age or number', async (t) => {
    const store = new GrantStore(path.join(await makeTempDir(t, 'jfa-get-this-'), 'grants.json'));
    await store.load();
    const old = new Date(Date.now() - 500 * DAY).toISOString();
    await store.writeAppRequests({ add: [record({ createdAt: old }), ...Array.from({ length: MAX_APP_REQUESTS_PER_HOUSEHOLD + 5 }, (_, index) => record({ tmdbId: index + 1 }))] });
    assert.equal(store.listAppRequests().length, MAX_APP_REQUESTS_PER_HOUSEHOLD + 6);
  });

  it('moves a pruned record that still counts into its member\'s ledger: exact in any window, summed past the horizon', async (t) => {
    const file = path.join(await makeTempDir(t, 'jfa-get-this-'), 'grants.json');
    const store = new GrantStore(file);
    await store.load();
    const at = (days) => new Date(Date.now() - days * DAY).toISOString();
    await store.writeAppRequests({ add: [
      // Past the retention: counted ones go to the ledger, the others are forgotten.
      record({ status: 'completed', createdAt: at(450) }),
      record({ status: 'failed', branch: 'join', createdAt: at(420), mediaType: 'tv', seasons: [1, 2] }),
      record({ status: 'declined', createdAt: at(430) }),
      record({ status: 'completed', branch: 'request', createdAt: at(440) }),
      // Settled beyond the household's cap, all inside a week.
      ...Array.from({ length: MAX_APP_REQUESTS_PER_HOUSEHOLD + 3 }, (_, index) => record({ status: 'completed', tmdbId: index + 1, createdAt: new Date(Date.now() - DAY - index * 1000).toISOString() })),
    ] });
    assert.equal(store.listAppRequests().length, MAX_APP_REQUESTS_PER_HOUSEHOLD);
    const units = (mediaType, start) => store.prunedAppQuotaUnits(ALICE, mediaType, start);
    // The 3 oldest of the week's records were pruned: each still counts, at its own time.
    assert.equal(units('movie', Date.now() - 7 * DAY), 3);
    assert.equal(units('movie', Date.now() - DAY - (MAX_APP_REQUESTS_PER_HOUSEHOLD + 1) * 1000 + 500), 1);
    // A lifetime quota counts the summed ones too; a window shorter than the horizon never does.
    assert.equal(units('movie', -Infinity), 4);
    assert.equal(units('tv', -Infinity), 2);
    assert.equal(units('tv', Date.now() - 365 * DAY), 0);
    await store.close();
    const reloaded = new GrantStore(file);
    await reloaded.load();
    assert.equal(reloaded.prunedAppQuotaUnits(ALICE, 'movie', -Infinity), 4);
  });
});
