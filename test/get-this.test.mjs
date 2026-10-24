import assert from 'node:assert/strict';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { GrantStore, MAX_APP_REQUESTS_PER_HOUSEHOLD } from '../dist/store.js';
import { assertNoCanaries } from './support/seerr-fixtures.mjs';
import {
  ALICE,
  ANN,
  BOB,
  CAROL,
  HOST_A,
  HOST_B,
  ITEMS,
  OUTSIDER,
  REQUEST,
  REQUEST_MOVIE,
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
/** Another movie TMDB knows, which nobody holds or asked for. */
const OTHER_MOVIE = 900010;
const OTHER_GET = `${APP}/movie/${OTHER_MOVIE}/get`;
/** Every app starts from this state file, so the opaque IDs it derives are the same in every world. */
const SEED = { version: 7, grants: {}, groups: {}, catalog: { items: {} }, passwordlessUserIds: [], appIdKey: 'ab'.repeat(32) };
const ACCEPTED = '{"status":"accepted"}';

/** Everything a household could see of an answer: status, every header and the body, as sent. */
function serialized(answer) {
  const headers = answer.rawHeaders.filter((_, index) => index % 2 === 0)
    .map((name, index) => `${name}: ${answer.rawHeaders[index * 2 + 1]}`)
    .filter((line) => !/^(date|connection|keep-alive):/i.test(line));
  return `${answer.status}\n${headers.join('\n')}\n\n${answer.text}`;
}

/** A Seerr request by `seerrUser`, shaped like the fixtures' (full of canaries), with its own ID. */
function request({ id, seerrUser, type = 'movie', tmdbId = type === 'movie' ? T_MOVIE : T_TV, status = 1, seasons, recent = false }) {
  const made = seerrRequest({ type, tmdbId, status, seasons: type === 'tv' ? seasons : undefined });
  made.id = id;
  if (recent) made.createdAt = new Date().toISOString();
  made.requestedBy = { ...made.requestedBy, id: seerrUser };
  return made;
}

const movieItem = (extra = {}) => ({ Id: ITEMS.tMovie, Name: 'Synthetic Movie One', Type: 'Movie', ProviderIds: { Tmdb: String(T_MOVIE) }, Tags: [], library: 'shared', ...extra });
const seriesItem = (extra = {}) => ({ Id: ITEMS.tSeries, Name: 'Synthetic Series Two', Type: 'Series', ProviderIds: { Tmdb: String(T_TV) }, Tags: [], library: 'shared', ...extra });
const episodesOf = (...seasons) => seasons.map((season) => ({ Id: `4444000044440000444400004444000${season}`, SeriesId: ITEMS.tSeries, ParentIndexNumber: season }));
const tmdbMovies = { [OTHER_MOVIE]: { title: 'Synthetic Movie Ten', release_date: '2021-01-01' } };

/**
 * The worlds "Get this" must not tell apart by its answer: they differ only in whether household B holds T, asked for
 * it, or it is held under an administrator's rule, public, or absent. `branch` is what the doc says happens.
 */
function getThisWorlds(extra = {}) {
  const held = (items, grants, requests = {}) => world({ items, grants, requests, tmdbMovies, ...extra });
  return {
    absent: { state: world({ tmdbMovies, ...extra }), branch: 'request' },
    'requested by household B': {
      state: world({ requests: { [SEERR_IDS[BOB]]: [request({ id: 7300601, seerrUser: SEERR_IDS[BOB], status: 1 })] }, tmdbMovies, ...extra }),
      branch: 'interest',
    },
    'held by household B through its request': {
      state: held([movieItem()], [{ request: { itemId: ITEMS.tMovie, mediaType: 'movie', requestId: '7300501', userId: BOB, groupIds: ['mill'] } }],
        { [SEERR_IDS[BOB]]: [request({ id: 7300501, seerrUser: SEERR_IDS[BOB], status: 5 })] }),
      branch: 'join',
    },
    'held through a manual grant to household B': {
      state: held([movieItem()], [{ manual: { itemId: ITEMS.tMovie, mediaType: 'movie', userIds: [], groupIds: ['mill'] } }]),
      branch: 'none',
    },
    'public outside household A\'s libraries': { state: held([movieItem({ library: 'mill-only' })], []), branch: 'none' },
    'public in household A\'s libraries': { state: held([movieItem()], []), branch: 'visible' },
  };
}

/** Starts the app for `state` with grants applied to Jellyfin and the shared seed state file. */
const start = (t, state, options = {}) => startApp(t, state, { reconcile: true, stateFile: SEED, ...options });

/** The app's records, without their random IDs and times. */
function records(app) {
  return app.store.listAppRequests().map(([, record]) => {
    const { createdAt, updatedAt, checkedAt, ...rest } = record;
    assert.ok(Date.parse(createdAt) > 0 && Date.parse(updatedAt) > 0);
    // A request the app made notes when Jellyfin was read again just before it was sent.
    assert.ok(checkedAt === undefined || (rest.branch === 'request' && Date.parse(checkedAt) > 0));
    return rest;
  }).sort((left, right) => left.branch.localeCompare(right.branch) || left.seasons.join().localeCompare(right.seasons.join()));
}

async function getThis(app, pathname = GET_MOVIE, body = undefined, options = {}) {
  const answer = await app.post(pathname, body, options);
  await app.background.settled();
  return answer;
}

describe('household app "Get this": the immediate answer', { timeout: 60_000 }, () => {
  it('answers the same fixed 202, byte for byte, in every world and whether or not the caller is eligible', async (t) => {
    const answers = {};
    for (const [name, { state }] of Object.entries(getThisWorlds())) {
      const app = await start(t, state);
      answers[name] = serialized(await getThis(app));
      answers[`${name} (series)`] = serialized(await getThis(app, GET_TV, { seasons: [1, 2] }, { user: ANN }));
    }
    for (const [name, changes] of Object.entries({
      'no request permission': { seerrUsers: { [SEERR_IDS[ALICE]]: { jellyfinUserId: ALICE, permissions: 0 } } },
      'no Seerr user': { seerrUsers: { [SEERR_IDS[ALICE]]: { jellyfinUserId: 'f'.repeat(32), permissions: REQUEST } } },
      'quota used up': { quotas: { [SEERR_IDS[ALICE]]: { movie: { limit: 1, days: 7 } } }, requests: { [SEERR_IDS[ALICE]]: [request({ id: 7300701, seerrUser: SEERR_IDS[ALICE], tmdbId: 900020, status: 2, recent: true })] } },
    })) {
      const app = await start(t, world({ tmdbMovies, ...changes }));
      answers[`ineligible: ${name}`] = serialized(await getThis(app));
      assert.deepEqual(app.seerr.posts, [], name);
      assert.deepEqual(records(app), [], name);
    }
    const expected = answers.absent;
    assert.match(expected, /^202\n/);
    assert.ok(expected.endsWith(`\n\n${ACCEPTED}`));
    assert.match(expected, /cache-control: no-store/i);
    for (const [name, answer] of Object.entries(answers)) assert.equal(answer, expected, name);
  });

  it('answers before anything about the caller\'s eligibility or the title is looked up', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    let release;
    app.seerr.state.holdQuota = new Promise((resolve) => { release = resolve; });
    // The answer comes while the caller's quota read is still held: eligibility is read in the background.
    const answer = await app.post(GET_MOVIE);
    assert.equal(answer.text, ACCEPTED);
    assert.deepEqual(app.seerr.posts, []);
    assert.ok(!app.seerr.calls.some((call) => call.pathname === `/api/v1/movie/${T_MOVIE}`));
    release();
    await app.background.settled();
    assert.equal(app.seerr.posts.length, 1);
  });

  it('answers the same fixed 202 when Seerr fails to read the caller\'s eligibility, and runs nothing', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    app.seerr.state.quotaFails = true;
    const answer = await getThis(app);
    assert.equal(answer.text, ACCEPTED);
    assert.deepEqual(app.seerr.posts, []);
    assert.deepEqual(records(app), []);
    assert.match(app.service.renderMetrics(), /jfa_app_get_this_total\{result="error"\} 1/);
  });
});

describe('household app "Get this": branches', { timeout: 60_000 }, () => {
  it('runs the branch the doc gives each world, and never asks Seerr for a title Jellyfin already has', async (t) => {
    for (const [name, { state, branch }] of Object.entries(getThisWorlds())) {
      const app = await start(t, state);
      assert.equal((await getThis(app)).status, 202);
      const made = records(app);
      if (branch === 'request') {
        assert.deepEqual(app.seerr.posts, [{ actingUser: SEERR_IDS[ALICE], body: { mediaType: 'movie', mediaId: T_MOVIE, is4k: false } }], name);
        assert.deepEqual(made, [{ householdId: 'farmhouse', jellyfinUserId: ALICE, mediaType: 'movie', tmdbId: T_MOVIE, seasons: [], branch: 'request', status: 'pending', seerrRequestId: '7350001', seerrMediaId: 7360001 }]);
      } else {
        // Late requests: a title Jellyfin has (or that is requested) never reaches Seerr's request endpoint.
        assert.deepEqual(app.seerr.posts, [], name);
      }
      if (branch === 'interest') {
        assert.deepEqual(made, [{ householdId: 'farmhouse', jellyfinUserId: ALICE, mediaType: 'movie', tmdbId: T_MOVIE, seasons: [], branch: 'interest', status: 'pending', seerrRequestId: '7300601', seerrMediaId: 7360001 }]);
      }
      if (branch === 'join') {
        assert.deepEqual(made, [{ householdId: 'farmhouse', jellyfinUserId: ALICE, mediaType: 'movie', tmdbId: T_MOVIE, seasons: [], branch: 'join', status: 'completed', itemIds: [ITEMS.tMovie], seerrMediaId: 7360001 }]);
        assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, ['farmhouse', 'mill']);
        assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).json().state, 'in_library');
      }
      if (branch === 'none' || branch === 'visible') assert.deepEqual(made, [], name);
      assert.deepEqual(app.seerr.violations, [], name);
    }
  });

  it('never requests a title Jellyfin has, whatever Seerr says about it or who holds it', async (t) => {
    const pending = { [SEERR_IDS[BOB]]: [request({ id: 7300601, seerrUser: SEERR_IDS[BOB], status: 1 }), request({ id: 7300602, seerrUser: SEERR_IDS[BOB], type: 'tv', status: 2, seasons: [1, 2] })] };
    const grants = (groupIds) => [
      { manual: { itemId: ITEMS.tMovie, mediaType: 'movie', userIds: [], groupIds } },
      { manual: { itemId: ITEMS.tSeries, mediaType: 'tv', userIds: [], groupIds } },
    ];
    for (const [name, state] of Object.entries({
      'unknown to Seerr': world({ items: [movieItem(), seriesItem()], episodes: episodesOf(1, 2) }),
      'requested in Seerr too': world({ items: [movieItem(), seriesItem()], episodes: episodesOf(1, 2), requests: pending }),
      'a manual grant': world({ items: [movieItem(), seriesItem()], episodes: episodesOf(1, 2), grants: grants(['mill']), requests: pending }),
      'outside the libraries': world({ items: [movieItem({ library: 'mill-only' }), seriesItem({ library: 'mill-only' })], episodes: episodesOf(1, 2) }),
      'available to the caller': world({ items: [movieItem(), seriesItem()], episodes: episodesOf(1, 2), requests: pending }),
    })) {
      const app = await start(t, state);
      await getThis(app);
      await getThis(app, GET_TV, { seasons: [1, 2] });
      await getThis(app, GET_TV, { seasons: [2] }, { user: ANN });
      assert.deepEqual(app.seerr.posts, [], name);
      assert.ok(!app.seerr.calls.some((call) => call.method === 'POST'), name);
    }
  });

  it('follows the caller\'s own request made outside the app as theirs, without counting it twice', async (t) => {
    const app = await start(t, world({
      tmdbMovies,
      quotas: { [SEERR_IDS[ALICE]]: { movie: { limit: 2, days: 7 } } },
      requests: { [SEERR_IDS[ALICE]]: [request({ id: 7300801, seerrUser: SEERR_IDS[ALICE], status: 1, recent: true })] },
    }));
    await getThis(app);
    assert.deepEqual(app.seerr.posts, []);
    assert.deepEqual(records(app).map((record) => [record.branch, record.seerrRequestId]), [['request', '7300801']]);
    // Seerr counts her request once; the second unit is still hers to use.
    await getThis(app, OTHER_GET);
    assert.equal(app.seerr.posts.length, 1);
  });

  it('does nothing for what the household already asked for', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    await getThis(app);
    await getThis(app, GET_MOVIE, undefined, { user: ANN });
    assert.equal(app.seerr.posts.length, 1);
    assert.equal(records(app).length, 1);
  });

  it('decides a series season by season: held seasons join, requested ones are followed, the rest one real request', async (t) => {
    const app = await start(t, world({
      items: [seriesItem()],
      episodes: episodesOf(1),
      grants: [{ request: { itemId: ITEMS.tSeries, mediaType: 'tv', requestId: '7300502', userId: BOB, groupIds: ['mill'] } }],
      requests: { [SEERR_IDS[BOB]]: [request({ id: 7300502, seerrUser: SEERR_IDS[BOB], type: 'tv', status: 5, seasons: [1] }), request({ id: 7300602, seerrUser: SEERR_IDS[BOB], type: 'tv', status: 1, seasons: [2] })] },
      quotas: { [SEERR_IDS[ALICE]]: { tv: { limit: 3, days: 7 } } },
    }));
    assert.equal((await getThis(app, GET_TV, { seasons: [3, 1, 2] })).status, 202);
    assert.deepEqual(app.seerr.posts, [{ actingUser: SEERR_IDS[ALICE], body: { mediaType: 'tv', mediaId: T_TV, seasons: [3], is4k: false } }]);
    const base = { householdId: 'farmhouse', jellyfinUserId: ALICE, mediaType: 'tv', tmdbId: T_TV, seerrMediaId: 7360002 };
    assert.deepEqual(records(app), [
      { ...base, seasons: [2], branch: 'interest', status: 'pending', seerrRequestId: '7300602' },
      { ...base, seasons: [1], branch: 'join', status: 'completed', itemIds: [ITEMS.tSeries], readySeasons: [1] },
      // Jellyfin has the series: the request is for a season it lacks, and its grant follows the join rules.
      { ...base, seasons: [3], branch: 'request', status: 'pending', seerrRequestId: '7350001', joinOnGrant: 'existing-series' },
    ]);
    const series = (await app.get(`${APP}/tv/${T_TV}`)).json();
    assert.equal(series.state, 'in_library');
    assert.deepEqual(series.seasons.map((season) => [season.seasonNumber, season.state]), [[1, 'in_library'], [2, 'requested']]);
    const listed = (await app.get(`${APP}/requests`)).json().results;
    assert.deepEqual(listed.map(({ id: _, ...entry }) => entry), [{
      mediaType: 'tv', tmdbId: T_TV, status: 'requested', byYou: true,
      seasons: [{ seasonNumber: 1, status: 'ready' }, { seasonNumber: 2, status: 'requested' }, { seasonNumber: 3, status: 'requested' }],
    }]);
    // One unit per season asked for, whichever branch served it: the limit of 3 is used up.
    const before = app.seerr.calls.length;
    await getThis(app, GET_TV, { seasons: [4] });
    assert.equal(app.seerr.posts.length, 1);
    assert.ok(!app.seerr.calls.slice(before).some((call) => call.pathname === `/api/v1/tv/${T_TV}`));
  });

  it('follows a request made meanwhile when Seerr refuses its own as a duplicate (409) or has no season left (202)', async (t) => {
    // Bob asks for the movie, and for season 1, between the branch's lookup and Alice's request reaching Seerr.
    const app = await start(t, world({ tmdbMovies }));
    let release;
    app.seerr.state.holdRequests = new Promise((resolve) => { release = resolve; });
    await app.post(GET_MOVIE);
    await app.post(GET_TV, { seasons: [1, 2] }, { user: ANN });
    while (app.seerr.posts.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    app.seerr.state.requests[SEERR_IDS[BOB]] = [
      request({ id: 7300603, seerrUser: SEERR_IDS[BOB], status: 1 }),
      request({ id: 7300604, seerrUser: SEERR_IDS[BOB], type: 'tv', status: 1, seasons: [1] }),
    ];
    release();
    await app.background.settled();
    assert.deepEqual(records(app).map((record) => [record.mediaType, record.branch, record.seasons, record.seerrRequestId]), [
      ['movie', 'interest', [], '7300603'],
      ['tv', 'interest', [1], '7300604'],
      ['tv', 'request', [2], '7350001'],
    ]);
    // Bob now asks for season 3 just before Ann's request does, which leaves Seerr nothing to request (202).
    app.seerr.state.holdRequests = new Promise((resolve) => { release = resolve; });
    await app.post(GET_TV, { seasons: [3] }, { user: ANN });
    while (app.seerr.posts.length < 3) await new Promise((resolve) => setTimeout(resolve, 5));
    app.seerr.state.requests[SEERR_IDS[BOB]].push(request({ id: 7300605, seerrUser: SEERR_IDS[BOB], type: 'tv', status: 2, seasons: [3] }));
    release();
    await app.background.settled();
    assert.deepEqual(records(app).filter((record) => record.seasons.includes(3)).map((record) => [record.branch, record.seerrRequestId]), [['interest', '7300605']]);
  });

  it('records the request and interest branches at the same time after the answer, however long Seerr takes within it', async (t) => {
    const seen = {};
    for (const name of ['absent', 'requested by household B']) {
      const app = await start(t, getThisWorlds()[name].state, { recordDelayMs: 400 });
      // Seerr takes a while to answer the request branch's call.
      app.seerr.state.holdRequests = new Promise((resolve) => setTimeout(resolve, 150));
      const started = performance.now();
      await app.post(GET_MOVIE);
      while (app.store.listAppRequests().length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      seen[name] = performance.now() - started;
      await app.background.settled();
    }
    for (const [name, elapsed] of Object.entries(seen)) assert.ok(elapsed >= 390 && elapsed < 1000, `${name}: ${elapsed}`);
  });

  it('takes one title\'s branches in turn, so two households asking at once make one Seerr request', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    await Promise.all([app.post(GET_MOVIE), app.post(GET_MOVIE, undefined, { host: HOST_B, user: BOB })]);
    await app.background.settled();
    assert.equal(app.seerr.posts.length, 1);
    // Whichever came first made the request; the other follows it.
    const made = records(app);
    assert.deepEqual(made.map((record) => record.householdId).sort(), ['farmhouse', 'mill']);
    assert.deepEqual(made.map((record) => record.branch).sort(), ['interest', 'request']);
    assert.equal(new Set(made.map((record) => record.seerrRequestId)).size, 1);
  });

  it('does nothing for a blocklisted title', async (t) => {
    const app = await start(t, world({ tmdbMovies, blocklist: [{ mediaType: 'movie', tmdbId: T_MOVIE }] }));
    await getThis(app);
    assert.deepEqual(app.seerr.posts, []);
    assert.deepEqual(records(app), []);
  });
});

describe('household app "Get this": quota before branching', { timeout: 60_000 }, () => {
  for (const [name, { state, branch }] of Object.entries(getThisWorlds({ quotas: { [SEERR_IDS[ALICE]]: { movie: { limit: 1, days: 7 } } } }))) {
    if (branch === 'none' || branch === 'visible') continue;
    it(`runs no branch once the ${branch} branch used the caller's last unit (${name})`, async (t) => {
      const app = await start(t, state);
      const first = await getThis(app);
      const posts = app.seerr.posts.length;
      const made = records(app);
      assert.equal(made.length, 1);
      const seerrCalls = app.seerr.calls.length;
      const jellyfinCalls = app.jellyfin.requests.length;
      const second = await getThis(app, OTHER_GET);
      assert.equal(serialized(second), serialized(first));
      // Nothing about the title was looked up and nothing was recorded, joined or requested.
      assert.equal(app.seerr.posts.length, posts);
      assert.deepEqual(records(app), made);
      assert.deepEqual(app.seerr.calls.slice(seerrCalls).map((call) => call.pathname).filter((pathname) => !/^\/api\/v1\/(user\/(jellyfin\/[0-9a-f]{32}|[0-9]+|11\/quota)|auth\/me)$/.test(pathname)), []);
      assert.deepEqual(app.jellyfin.requests.slice(jellyfinCalls).map((request) => request.pathname).filter((pathname) => pathname !== '/Users/Me'), []);
    });
  }

  it('lets concurrent calls at the limit run at most one branch', async (t) => {
    const app = await start(t, world({ tmdbMovies: { ...tmdbMovies, 900011: { title: 'Synthetic Movie Eleven' } }, quotas: { [SEERR_IDS[ALICE]]: { movie: { limit: 1, days: 7 } } } }));
    const answers = await Promise.all([GET_MOVIE, OTHER_GET, `${APP}/movie/900011/get`].map((pathname) => app.post(pathname)));
    await app.background.settled();
    assert.ok(answers.every((answer) => answer.text === ACCEPTED));
    assert.equal(app.seerr.posts.length, 1);
    assert.equal(records(app).length, 1);
  });

  it('charges a series one unit per season asked for, however many seasons another household asked for', async (t) => {
    for (const requested of [[], [1], [1, 2]]) {
      const app = await start(t, world({
        quotas: { [SEERR_IDS[ALICE]]: { tv: { limit: 2, days: 7 } } },
        requests: requested.length ? { [SEERR_IDS[BOB]]: [request({ id: 7300606, seerrUser: SEERR_IDS[BOB], type: 'tv', status: 1, seasons: requested })] } : {},
      }));
      await getThis(app, GET_TV, { seasons: [1, 2] });
      assert.deepEqual(records(app).flatMap((record) => record.seasons).sort(), [1, 2], String(requested));
      const posts = app.seerr.posts.length;
      await getThis(app, GET_TV, { seasons: [3] });
      assert.equal(app.seerr.posts.length, posts, String(requested));
      assert.equal(records(app).length, requested.length === 1 ? 2 : 1, String(requested));
    }
  });

  it('refuses a caller without request permission for the media type, running no branch', async (t) => {
    const app = await start(t, world({ tmdbMovies, seerrUsers: { [SEERR_IDS[ALICE]]: { jellyfinUserId: ALICE, permissions: REQUEST_MOVIE } } }));
    await getThis(app, GET_TV, { seasons: [1] });
    assert.deepEqual(records(app), []);
    await getThis(app);
    assert.equal(records(app).length, 1);
  });

  it('leaves a caller without a quota limit always eligible, as Seerr does', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    await getThis(app);
    await getThis(app, OTHER_GET);
    assert.equal(app.seerr.posts.length, 2);
  });
});

describe('household app "Get this": every outcome counted as Seerr counts the caller\'s own', { timeout: 60_000 }, () => {
  const quotas = { [SEERR_IDS[ALICE]]: { movie: { limit: 1, days: 7 } } };

  /** Whether Alice may ask for one more movie: a "Get this" for another one reaches Seerr. */
  async function eligible(app) {
    const posts = app.seerr.posts.length;
    const made = app.store.listAppRequests().length;
    await getThis(app, OTHER_GET);
    return app.seerr.posts.length > posts || app.store.listAppRequests().length > made;
  }

  /** Changes the Seerr request a record follows, then brings the records up to date. */
  async function outcome(app, change) {
    change(app.seerr.state);
    await app.requests.refresh();
  }

  const setStatus = (status, seerrUser, id) => (seerr) => {
    seerr.requests[seerrUser].find((entry) => entry.id === id).status = status;
    // A request completes once the title is in Jellyfin.
    if (status === 5) seerr.items.push(movieItem());
  };

  for (const [event, status, freed, shown] of [['declined', 3, true, 'failed'], ['failed', 4, false, 'failed'], ['approved', 2, false, 'requested'], ['completed', 5, false, 'ready']]) {
    it(`frees the unit ${freed ? '' : 'in neither branch '}when the request is ${event}, in the request and interest branches alike`, async (t) => {
      const results = {};
      for (const [branch, state, seerrUser, id] of [
        ['request', world({ tmdbMovies, quotas }), SEERR_IDS[ALICE], 7350001],
        ['interest', world({ tmdbMovies, quotas, requests: { [SEERR_IDS[BOB]]: [request({ id: 7300601, seerrUser: SEERR_IDS[BOB] })] } }), SEERR_IDS[BOB], 7300601],
      ]) {
        const app = await start(t, state);
        await getThis(app);
        await outcome(app, setStatus(status, seerrUser, id));
        const listed = (await app.get(`${APP}/requests`)).json().results;
        results[branch] = { status: listed[0]?.status, eligible: await eligible(app) };
      }
      // A completed interest is "Ready" only once its household joined the grant (see the grant tests).
      const interestShown = event === 'completed' ? 'requested' : shown;
      assert.deepEqual(results, { request: { status: shown, eligible: freed }, interest: { status: interestShown, eligible: freed } });
    });
  }

  it('keeps a failed then retried request counted, following it back to Requested', async (t) => {
    let now = Date.now();
    const app = await start(t, world({ tmdbMovies, quotas, requests: { [SEERR_IDS[BOB]]: [request({ id: 7300601, seerrUser: SEERR_IDS[BOB] })] } }), { now: () => now });
    await getThis(app);
    await outcome(app, setStatus(4, SEERR_IDS[BOB], 7300601));
    assert.equal((await app.get(`${APP}/requests`)).json().results[0].status, 'failed');
    // Read again only once ten minutes have passed.
    await outcome(app, setStatus(2, SEERR_IDS[BOB], 7300601));
    assert.equal((await app.get(`${APP}/requests`)).json().results[0].status, 'failed');
    now += 10 * 60 * 1000;
    await app.requests.refresh();
    assert.equal((await app.get(`${APP}/requests`)).json().results[0].status, 'requested');
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).json().state, 'requested');
    assert.equal(await eligible(app), false);
  });

  it('counts an interest as failed (still counted) once someone deletes its request, and frees it once the title\'s media record goes', async (t) => {
    for (const [what, change, status, freed] of [
      ['the request', (seerr) => {
        seerr.requests[SEERR_IDS[BOB]] = [];
        seerr.media[T_MOVIE] = { id: 7360001, mediaType: 'movie', tmdbId: T_MOVIE, status: 2, requests: [] };
      }, 'failed', false],
      ['the media record', (seerr) => {
        seerr.requests[SEERR_IDS[BOB]] = [];
      }, 'deleted', true],
    ]) {
      const app = await start(t, world({ tmdbMovies, quotas, requests: { [SEERR_IDS[BOB]]: [request({ id: 7300601, seerrUser: SEERR_IDS[BOB] })] } }));
      await getThis(app);
      await outcome(app, change);
      assert.equal(app.store.listAppRequests()[0][1].status, status, what);
      // A deleted request is no longer listed, as Seerr no longer lists it; a failed one shows "We couldn't get this".
      assert.deepEqual((await app.get(`${APP}/requests`)).json().results.map((entry) => entry.status), status === 'deleted' ? [] : ['failed'], what);
      assert.equal(await eligible(app), freed, what);
    }
  });

  it('frees a join once the title\'s Seerr media record is deleted, and counts it until then', async (t) => {
    const { state } = getThisWorlds({ quotas })['held by household B through its request'];
    const app = await start(t, state);
    await getThis(app);
    assert.equal(await eligible(app), false);
    await outcome(app, (seerr) => {
      seerr.requests[SEERR_IDS[BOB]] = [];
    });
    assert.equal(app.store.listAppRequests().find(([, record]) => record.branch === 'join')[1].status, 'deleted');
    assert.equal(await eligible(app), true);
  });

  it('frees the request branch\'s unit when Seerr deletes the caller\'s request with its media', async (t) => {
    const app = await start(t, world({ tmdbMovies, quotas }));
    await getThis(app);
    await outcome(app, (seerr) => {
      seerr.requests[SEERR_IDS[ALICE]] = [];
    });
    assert.equal(app.store.listAppRequests()[0][1].status, 'deleted');
    assert.equal(await eligible(app), true);
  });

  it('counts only virtual requests inside the quota window, as Seerr counts its own', async (t) => {
    let now = Date.now();
    const app = await start(t, world({ tmdbMovies, quotas, requests: { [SEERR_IDS[BOB]]: [request({ id: 7300601, seerrUser: SEERR_IDS[BOB] })] } }), { now: () => now });
    await getThis(app);
    assert.equal(await eligible(app), false);
    now += 8 * 24 * 60 * 60 * 1000;
    assert.equal(await eligible(app), true);
  });
});

describe('household app "Get this": households', { timeout: 60_000 }, () => {
  it('keeps a record with the household it was made for, whatever membership does later', async (t) => {
    const app = await start(t, world({ tmdbMovies }), { households: [
      { id: 'farmhouse', name: 'Farmhouse', userIds: [ALICE, ANN, CAROL] },
      { id: 'mill', name: 'Mill', userIds: [BOB, CAROL] },
    ] });
    // Carol, in both households, asks on Farmhouse's host: the record is Farmhouse's alone.
    await getThis(app, GET_MOVIE, undefined, { user: CAROL });
    const state = async (host, user) => (await app.get(`${APP}/movie/${T_MOVIE}`, { host, user })).json().state;
    const listed = async (host, user) => (await app.get(`${APP}/requests`, { host, user })).json().results.map((entry) => [entry.status, entry.byYou]);
    const check = async (step) => {
      assert.equal(await state(HOST_A, ALICE), 'requested', step);
      assert.deepEqual(await listed(HOST_A, ALICE), [['requested', false]], step);
      assert.equal(await state(HOST_B, BOB), 'get_this', step);
      assert.deepEqual(await listed(HOST_B, BOB), [], step);
    };
    await check('as made');
    assert.equal(await state(HOST_B, CAROL), 'get_this');
    assert.deepEqual(await listed(HOST_A, CAROL), [['requested', true]]);
    // Carol leaves Farmhouse: the household keeps its record and she keeps nothing.
    await app.store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: [ALICE, ANN] });
    await check('Carol left Farmhouse');
    // Ann moves to Mill: her household's record does not follow her.
    await app.store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: [ALICE] });
    await app.store.upsertGroup({ id: 'mill', name: 'Mill', userIds: [BOB, CAROL, ANN] });
    await check('Ann moved to Mill');
    assert.equal(await state(HOST_B, ANN), 'get_this');
    assert.deepEqual(app.store.listAppRequests().map(([, record]) => record.householdId), ['farmhouse']);
  });

  it('joins only the household whose host was used, never the caller\'s other households', async (t) => {
    const { state } = getThisWorlds()['held by household B through its request'];
    const app = await start(t, state, { households: [
      { id: 'farmhouse', name: 'Farmhouse', userIds: [ALICE, ANN] },
      { id: 'mill', name: 'Mill', userIds: [BOB] },
      { id: 'barn', name: 'Barn', userIds: [ALICE, CAROL] },
    ] });
    await getThis(app);
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, ['farmhouse', 'mill']);
  });

  it('joins an interested household when the grant is created, and an administrator\'s removal sticks', async (t) => {
    for (const removed of [false, true]) {
      const app = await start(t, world({ requests: { [SEERR_IDS[BOB]]: [request({ id: 7300601, seerrUser: SEERR_IDS[BOB], status: 2 })] } }));
      await getThis(app);
      assert.equal(records(app)[0].branch, 'interest');
      // The title arrives in Jellyfin.
      app.jellyfin.state.items.push(movieItem());
      if (removed) {
        // An administrator gave the item to both households, then took it away from Farmhouse.
        await app.service.setManualAccess({ itemId: ITEMS.tMovie, mediaType: 'movie', userIds: [], groupIds: ['farmhouse', 'mill'] });
        await app.service.setManualAccess({ itemId: ITEMS.tMovie, mediaType: 'movie', userIds: [], groupIds: ['mill'] });
      }
      app.seerr.state.requests[SEERR_IDS[BOB]][0].status = 5;
      const answer = await app.webhook({
        notificationType: 'MEDIA_AVAILABLE',
        event: 'Movie Request Now Available',
        media: { mediaType: 'movie', jellyfinMediaId: ITEMS.tMovie },
        request: { id: '7300601', requestedBy: { jellyfinUserId: BOB } },
      });
      assert.equal(answer.status, 200, answer.text);
      assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, removed ? ['mill'] : ['farmhouse', 'mill']);
      assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).json().state, removed ? 'get_this' : 'in_library');
      assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`, { user: ANN })).json().state, removed ? 'get_this' : 'in_library');
      assert.deepEqual((await app.get(`${APP}/requests`)).json().results.map((entry) => entry.status), [removed ? 'failed' : 'ready']);
    }
  });

  it('never joins a household an administrator removed, in the join branch or for an interest, even for a member the removal did not mark', async (t) => {
    // The join branch: Farmhouse was given the title, then an administrator took it away; Bob's request still holds it.
    const { state } = getThisWorlds()['held by household B through its request'];
    const held = await start(t, state);
    await held.service.setGrantGroups(ITEMS.tMovie, ['farmhouse', 'mill']);
    await held.service.setGrantGroups(ITEMS.tMovie, ['mill']);
    await getThis(held);
    assert.deepEqual(held.store.get(ITEMS.tMovie).groupIds, ['mill']);
    assert.deepEqual(records(held), []);
    assert.deepEqual(held.seerr.posts, []);
    // An interest: Ann asked while Bob's request was pending, left Farmhouse, and came back after the administrator
    // removed Farmhouse from the title, so only the household carries the mark.
    const app = await start(t, world({ requests: { [SEERR_IDS[BOB]]: [request({ id: 7300601, seerrUser: SEERR_IDS[BOB], status: 2 })] } }));
    await getThis(app, GET_MOVIE, undefined, { user: ANN });
    await app.store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: [ALICE] });
    app.jellyfin.state.items.push(movieItem());
    await app.service.setManualAccess({ itemId: ITEMS.tMovie, mediaType: 'movie', userIds: [], groupIds: ['farmhouse', 'mill'] });
    await app.service.setManualAccess({ itemId: ITEMS.tMovie, mediaType: 'movie', userIds: [], groupIds: ['mill'] });
    await app.store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: [ALICE, ANN] });
    assert.equal(app.store.isAccessRemoved(ITEMS.tMovie, 'userIds', ANN), false);
    app.seerr.state.requests[SEERR_IDS[BOB]][0].status = 5;
    await app.webhook({
      notificationType: 'MEDIA_AVAILABLE',
      event: 'Movie Request Now Available',
      media: { mediaType: 'movie', jellyfinMediaId: ITEMS.tMovie },
      request: { id: '7300601', requestedBy: { jellyfinUserId: BOB } },
    });
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, ['mill']);
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`, { user: ANN })).json().state, 'get_this');
    assert.deepEqual((await app.get(`${APP}/requests`, { user: ANN })).json().results.map((entry) => entry.status), ['failed']);
  });

  it('completes the household\'s own request when its grant is created', async (t) => {
    const app = await start(t, world());
    await getThis(app);
    app.jellyfin.state.items.push(movieItem());
    app.seerr.state.requests[SEERR_IDS[ALICE]][0].status = 5;
    await app.webhook({
      notificationType: 'MEDIA_AVAILABLE',
      event: 'Movie Request Now Available',
      media: { mediaType: 'movie', jellyfinMediaId: ITEMS.tMovie },
      request: { id: '7350001', requestedBy: { jellyfinUserId: ALICE } },
    });
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).json().state, 'in_library');
    assert.deepEqual((await app.get(`${APP}/requests`)).json().results.map((entry) => entry.status), ['ready']);
  });

  it('joins an interest whose request completed on the next refresh, when the webhook was missed', async (t) => {
    const app = await start(t, world({ requests: { [SEERR_IDS[BOB]]: [request({ id: 7300601, seerrUser: SEERR_IDS[BOB], status: 2 })] } }));
    await getThis(app);
    app.jellyfin.state.items.push(movieItem());
    await app.store.grant({ itemId: ITEMS.tMovie, mediaType: 'movie', requestId: '7300601', userId: BOB, groupIds: ['mill'] });
    app.seerr.state.requests[SEERR_IDS[BOB]][0].status = 5;
    await app.requests.refresh();
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, ['farmhouse', 'mill']);
    assert.equal(records(app)[0].status, 'completed');
  });

  it('shows another household nothing of a household\'s records, and a deleted household\'s records to no one', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    await getThis(app);
    assert.deepEqual((await app.get(`${APP}/requests`, { host: HOST_B, user: BOB })).json(), { results: [] });
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`, { host: HOST_B, user: BOB })).json().state, 'get_this');
    await app.service.deleteGroup('farmhouse');
    await app.store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse again', userIds: [ALICE, ANN] });
    assert.deepEqual((await app.get(`${APP}/requests`)).json(), { results: [] });
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).json().state, 'get_this');
    // Still Alice's own: it counts towards her quota as Seerr counts her request.
    assert.equal(app.store.listAppRequests()[0][1].detached, true);
  });
});

describe('household app "Get this": what the household sees afterwards', { timeout: 60_000 }, () => {
  it('shows the same title state and list after a request and after an interest, byte for byte', async (t) => {
    const worlds = getThisWorlds();
    const seen = {};
    for (const name of ['absent', 'requested by household B']) {
      const app = await start(t, worlds[name].state);
      await getThis(app);
      seen[name] = await Promise.all([
        `${APP}/requests`, `${APP}/movie/${T_MOVIE}`, `${APP}/search?q=synthetic`, `${APP}/discover/popular-movies`,
      ].map(async (pathname) => serialized(await app.get(pathname))));
      seen[`${name} (Ann)`] = serialized(await app.get(`${APP}/requests`, { user: ANN }));
    }
    assert.deepEqual(seen.absent, seen['requested by household B']);
    assert.equal(seen['absent (Ann)'], seen['requested by household B (Ann)']);
    assert.match(seen.absent[1], /"state":"requested"/);
    assert.match(seen.absent[0], /"status":"requested"/);
  });

  it('lists only JellyPass records, with opaque IDs and no Seerr data, and never caches', async (t) => {
    for (const [name, { state }] of Object.entries(getThisWorlds())) {
      const app = await start(t, state);
      await getThis(app);
      await getThis(app, GET_TV, { seasons: [1, 2] }, { user: ANN });
      for (const pathname of [`${APP}/requests`, `${APP}/movie/${T_MOVIE}`, `${APP}/tv/${T_TV}`, `${APP}/tv/${T_TV}/season/1`, `${APP}/search?q=synthetic`]) {
        for (const user of [ALICE, ANN]) {
          const answer = await app.get(pathname, { user });
          assert.equal(answer.status, 200, `${name} ${pathname}`);
          assertNoCanaries(serialized(answer), `${name} ${pathname}`);
          assert.equal(answer.headers['cache-control'], 'no-store');
        }
      }
      const listed = (await app.get(`${APP}/requests`)).json();
      for (const entry of listed.results) {
        assert.deepEqual(Object.keys(entry).sort(), ['byYou', 'id', 'mediaType', 'seasons', 'status', 'tmdbId']);
        assert.match(entry.id, /^[A-Za-z0-9_-]{22}$/);
      }
      assert.doesNotMatch(JSON.stringify(listed), /735000|736000|7300[56]0|seerr|request(ed)?By|mill|bob/i);
    }
  });

  it('derives the same opaque ID from the same household and title, and different ones otherwise', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    await getThis(app);
    await getThis(app, GET_MOVIE, undefined, { host: HOST_B, user: BOB });
    await getThis(app, OTHER_GET);
    const farmhouse = (await app.get(`${APP}/requests`)).json().results;
    const mill = (await app.get(`${APP}/requests`, { host: HOST_B, user: BOB })).json().results;
    assert.equal(farmhouse.length, 2);
    assert.notEqual(farmhouse[0].id, farmhouse[1].id);
    assert.notEqual(farmhouse.find((entry) => entry.tmdbId === T_MOVIE).id, mill[0].id);
    assert.equal((await app.get(`${APP}/requests`, { user: ANN })).json().results[0].id, farmhouse[0].id);
  });
});

describe('household app "Get this": input, budgets, shutdown and metrics', { timeout: 60_000 }, () => {
  it('refuses invalid input with the fixed 400 before counting or deciding anything', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    for (const [pathname, body] of [
      [GET_MOVIE, { seasons: [1] }], [GET_MOVIE, []], [GET_MOVIE, 'x'], [GET_MOVIE, 'null'], [GET_MOVIE, `{"a":"${'x'.repeat(1100)}"}`],
      [GET_TV, undefined], [GET_TV, {}], [GET_TV, { seasons: [] }], [GET_TV, { seasons: [0] }], [GET_TV, { seasons: [1, 1] }],
      [GET_TV, { seasons: ['1'] }], [GET_TV, { seasons: [1000] }], [GET_TV, { seasons: [1.5] }], [GET_TV, { seasons: 1 }],
      [GET_TV, { seasons: Array.from({ length: 101 }, (_, index) => index + 1) }], [GET_TV, { seasons: [1], userId: 1 }],
      [`${APP}/movie/0/get`, undefined], [`${APP}/movie/abc/get`, undefined], [`${APP}/tv/2147483648/get`, { seasons: [1] }],
    ]) {
      const answer = await app.post(pathname, body);
      assert.equal(answer.status, 400, `${pathname} ${JSON.stringify(body)}`);
      assert.equal(answer.text, '{"error":"invalid_request"}');
    }
    for (const pathname of [`${APP}/person/1/get`, `${APP}/movie/${T_MOVIE}/get/x`, `${APP}/requests`]) {
      assert.equal((await app.post(pathname)).status, 404, pathname);
    }
    assert.equal((await app.get(GET_MOVIE)).status, 404);
    await app.background.settled();
    assert.deepEqual(app.seerr.posts, []);
    // None of those used the caller's budget.
    for (let index = 0; index < 10; index += 1) assert.equal((await app.post(OTHER_GET)).status, 202);
  });

  it('refuses callers who are not members of the host\'s household, identically, before reading anything', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    const answers = [
      await app.post(GET_MOVIE, undefined, { user: BOB }),
      await app.post(GET_MOVIE, undefined, { user: OUTSIDER }),
      await app.post(GET_MOVIE, undefined, { user: null }),
    ];
    for (const answer of answers) assert.equal(serialized(answer), serialized(answers[0]));
    assert.equal(answers[0].status, 401);
    await app.background.settled();
    assert.ok(!app.seerr.calls.some((call) => call.actingUser !== undefined));
  });

  it('limits submissions per user, per client address and per household, counting each only past the one before', async (t) => {
    const nobody = { seerrUsers: Object.fromEntries([ALICE, ANN, CAROL, OUTSIDER].map((user) => [SEERR_IDS[user], { jellyfinUserId: user, permissions: 0 }])) };
    const app = await start(t, world(nobody), {
      trustedProxies: ['127.0.0.1'],
      households: [{ id: 'farmhouse', name: 'Farmhouse', userIds: [ALICE, ANN, CAROL, OUTSIDER] }, { id: 'mill', name: 'Mill', userIds: [BOB] }],
    });
    const from = (address, user) => app.post(GET_MOVIE, undefined, { user, headers: { 'X-Forwarded-For': address } });
    const statuses = async (count, address, user) => {
      const seen = [];
      for (let index = 0; index < count; index += 1) seen.push((await from(address, user)).status);
      return seen;
    };
    // Ten per user: the eleventh is refused and not counted against the address or the household.
    assert.deepEqual(await statuses(11, '192.0.2.1', ALICE), [...Array(10).fill(202), 429]);
    // Thirty per address: Ann and Carol from the same address use the rest of it.
    assert.deepEqual(await statuses(10, '192.0.2.1', ANN), Array(10).fill(202));
    assert.deepEqual(await statuses(11, '192.0.2.1', CAROL), [...Array(10).fill(202), 429]);
    // The household's thirty are used up too, from any address: its fourth member is refused.
    const refused = await from('192.0.2.2', OUTSIDER);
    assert.equal(refused.status, 429);
    assert.equal(refused.text, '{"error":"too_many_requests"}');
    // Another household is not affected.
    assert.equal((await app.post(GET_MOVIE, undefined, { host: HOST_B, user: BOB, headers: { 'X-Forwarded-For': '192.0.2.3' } })).status, 202);
    await app.background.settled();
  });

  it('stops a branch at shutdown before its next step, recording nothing it did not do', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    const answer = await app.post(GET_MOVIE);
    assert.equal(answer.status, 202);
    await app.background.stop();
    assert.deepEqual(app.seerr.posts, []);
    assert.deepEqual(records(app), []);
    assert.ok(!app.seerr.calls.some((call) => call.pathname === `/api/v1/movie/${T_MOVIE}`));
    // Once shutdown has begun, "Get this" is refused rather than accepted and dropped.
    assert.equal((await app.post(OTHER_GET)).status, 502);
  });

  it('keeps the attribution of a Seerr request already sent when shutdown begins', async (t) => {
    const app = await start(t, world({ tmdbMovies }));
    let release;
    app.seerr.state.holdRequests = new Promise((resolve) => { release = resolve; });
    await app.post(GET_MOVIE);
    while (app.seerr.posts.length < 1) await new Promise((resolve) => setTimeout(resolve, 5));
    const stopped = app.background.stop();
    release();
    await stopped;
    assert.deepEqual(records(app).map((record) => [record.branch, record.seerrRequestId]), [['request', '7350001']]);
  });

  it('counts calls and branches in metrics without titles', async (t) => {
    const app = await start(t, getThisWorlds()['held by household B through its request'].state);
    await getThis(app);
    await getThis(app, OTHER_GET);
    const metrics = app.service.renderMetrics();
    assert.match(metrics, /jfa_app_get_this_total\{result="accepted"\} 2/);
    assert.match(metrics, /jfa_app_get_this_branches_total\{branch="join_joined"\} 1/);
    assert.match(metrics, /jfa_app_get_this_branches_total\{branch="request"\} 1/);
    assert.match(metrics, /jfa_app_requests_total\{endpoint="get",outcome="ok"\} 2/);
    assert.doesNotMatch(metrics, /9000(01|10)|tmdb/i);
  });

  it('answers 404 for "Get this" and the household\'s requests when the app has no request service', async (t) => {
    const app = await start(t, world(), { requests: false });
    assert.equal((await app.post(GET_MOVIE)).status, 404);
    assert.equal((await app.get(`${APP}/requests`)).status, 404);
  });
});

describe('"Get this" records in the store', () => {
  const record = (overrides = {}) => ({
    householdId: 'farmhouse', jellyfinUserId: ALICE, mediaType: 'movie', tmdbId: T_MOVIE, seasons: [], branch: 'interest', status: 'pending',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides,
  });

  it('keeps each household\'s newest settled records, forgets settled records past the retention, and survives a restart', async (t) => {
    const file = path.join(await makeTempDir(t, 'jfa-get-this-'), 'grants.json');
    const store = new GrantStore(file);
    await store.load();
    const old = new Date(Date.now() - 401 * 24 * 60 * 60 * 1000).toISOString();
    await store.writeAppRequests({ add: [record({ createdAt: old, status: 'declined' }), record({ householdId: 'mill' })] });
    assert.deepEqual(store.listAppRequests().map(([, entry]) => entry.householdId), ['mill']);
    const many = Array.from({ length: MAX_APP_REQUESTS_PER_HOUSEHOLD + 5 }, (_, index) => record({ tmdbId: index + 1, status: 'declined', createdAt: new Date(Date.now() - (index + 1) * 1000).toISOString() }));
    await store.writeAppRequests({ add: many });
    const kept = store.listAppRequests().map(([, entry]) => entry);
    assert.equal(kept.filter((entry) => entry.householdId === 'farmhouse').length, MAX_APP_REQUESTS_PER_HOUSEHOLD);
    assert.ok(!kept.some((entry) => entry.householdId === 'farmhouse' && entry.tmdbId > MAX_APP_REQUESTS_PER_HOUSEHOLD));
    // Another household's volume never removes Mill's record.
    assert.equal(kept.filter((entry) => entry.householdId === 'mill').length, 1);
    await store.close();
    const reloaded = new GrantStore(file);
    await reloaded.load();
    assert.equal(reloaded.listAppRequests().length, MAX_APP_REQUESTS_PER_HOUSEHOLD + 1);
    assert.match(reloaded.getAppIdKey(), /^[0-9a-f]{64}$/);
  });

  it('updates a record\'s status and joined items, and refuses changes once closed', async (t) => {
    const store = new GrantStore(path.join(await makeTempDir(t, 'jfa-get-this-'), 'grants.json'));
    await store.load();
    const [id] = await store.writeAppRequests({ add: [record()] });
    await store.writeAppRequests({ update: [{ id, status: 'completed', itemIds: [ITEMS.tMovie.toUpperCase()] }] });
    assert.deepEqual(store.listAppRequests()[0][1].itemIds, [ITEMS.tMovie]);
    assert.equal(store.listAppRequests()[0][1].status, 'completed');
    await store.close();
    await assert.rejects(store.writeAppRequests({ add: [record()] }), /closed/);
  });

  it('leaves a state file without records as it was until the first one', async (t) => {
    const store = new GrantStore(path.join(await makeTempDir(t, 'jfa-get-this-'), 'grants.json'));
    await store.load();
    assert.equal(store.getAppIdKey(), undefined);
    assert.deepEqual(store.listAppRequests(), []);
  });
});
