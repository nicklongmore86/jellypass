// "Get this": the rules Codex's reviews of PR #34 asked for (see docs/app-design.md, "Get this" as implemented): the
// re-check before a request, items without TMDB metadata, completed records dropped with their media, a household
// deleted while a call ran, pruning, new seasons of a series Jellyfin has, and per-season readiness. The late-request
// rules (request intents, the settle-time read, title lookups by name and the order of the request branch's last
// steps) are in get-this-intents.test.mjs.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { readFile, writeFile } from 'node:fs/promises';
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
const listed = async (app, options) => (await app.get(`${APP}/requests`, options)).json().results.map(({ id: _, requestedOn, ...entry }) => {
  assert.match(requestedOn, /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
  return entry;
});

describe('"Get this": Jellyfin is read again right before a request', { timeout: 60_000 }, () => {
  it('joins a movie, or a season, that arrives after the branch\'s first read, and never requests it', async (t) => {
    // The branch's first read of a movie is two lookups (by TMDB ID and by name), of a series one per item.
    for (const [name, state, path, body, firstRead, firstReads, arrive] of [
      ['movie', world({ tmdbMovies }), GET_MOVIE, undefined, '/Items', 2, (jellyfin) => jellyfin.items.push(movieItem())],
      ['season', world({ items: [seriesItem()], episodes: [episode(1)] }), GET_TV, { seasons: [2] }, `/Shows/${ITEMS.tSeries}/Episodes`, 1, (jellyfin) => jellyfin.episodes.push(episode(2))],
    ]) {
      const app = await start(t, state);
      let reads = 0;
      // It arrives as soon as the branch's first Jellyfin read has been answered.
      app.jellyfin.state.onAdminRead = (pathname) => {
        if (pathname === firstRead) reads += 1;
        if (pathname === firstRead && reads === firstReads) arrive(app.jellyfin.state);
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
      assert.deepEqual(app.store.get(ITEMS.tMovie)?.groupIds, held ? ['grove', 'mill'] : undefined, String(held));
      assert.equal(app.store.hasHandledRequest('7350001'), true);
      assert.equal(await state(app, `${APP}/movie/${T_MOVIE}`, { host: HOST_B, user: BOB }), 'in_library');
      assert.deepEqual((await listed(app)).map((entry) => entry.status), ['ready']);
    }
  });

  it('defers a webhook that arrives before the request\'s record is written, then grants it as a join', async (t) => {
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
    assert.equal((await webhook(app, 'movie', 7350001, ALICE)).status, 202);
    assert.equal(app.store.get(ITEMS.tMovie), undefined);
    assert.deepEqual(app.store.listDeferredWebhooks().map((event) => event.request.id), ['7350001']);
    await app.background.settled();
    assert.equal(app.store.get(ITEMS.tMovie), undefined);
    assert.equal(app.store.hasHandledRequest('7350001'), true);
    assert.deepEqual(app.store.listDeferredWebhooks(), []);
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
    assert.deepEqual(app.store.get(ITEMS.tMovie).groupIds, ['grove', 'mill']);
    assert.deepEqual(app.store.get(ITEMS.tSeries).groupIds, ['grove', 'mill']);
  });
});

describe('"Get this": completed records and their media', { timeout: 60_000 }, () => {
  it('drops a completed record once the title\'s media record is deleted, in every branch, and stops listing it', async (t) => {
    const results = {};
    for (const branch of ['request', 'interest', 'join']) {
      const app = await start(t, branch === 'join'
        ? world({ tmdbMovies, items: [movieItem()], grants: [bobsMovieGrant], requests: { [SEERR_IDS[BOB]]: [request({ id: 7300501, seerrUser: SEERR_IDS[BOB], status: 5 })] } })
        : world({ tmdbMovies, requests: branch === 'interest' ? { [SEERR_IDS[BOB]]: [request({ id: 7300601, seerrUser: SEERR_IDS[BOB], status: 2 })] } : {} }));
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
      // An administrator deletes the title's media record in Seerr, with every request on it.
      app.seerr.state.requests = {};
      await app.requests.refresh();
      results[branch] = { status: app.store.listAppRequests().find(([, record]) => record.tmdbId === T_MOVIE)[1].status, listed: await listed(app) };
    }
    for (const branch of ['request', 'interest', 'join']) assert.deepEqual(results[branch], { status: 'deleted', listed: [] }, branch);
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
      await app.service.deleteGroup('grove');
      await app.store.upsertGroup({ id: 'grove', name: 'Grove again', userIds: [ALICE, ANN] });
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
      assert.ok(!(app.store.get(ITEMS.tMovie)?.groupIds ?? []).includes('grove'), branch);
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
    assert.deepEqual(await listed(app), [{ mediaType: 'tv', tmdbId: T_TV, status: 'ready', seasons: [{ seasonNumber: 2, status: 'ready' }], byYou: true, cancellable: false }]);
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
        await app.service.setGrantGroups(ITEMS.tSeries, ['grove', 'mill']);
        await app.service.setGrantGroups(ITEMS.tSeries, ['mill']);
      }
      await getThis(app, GET_TV, { seasons: [2] });
      assert.deepEqual(app.seerr.posts.map((post) => post.body.seasons), [[2]]);
      app.jellyfin.state.episodes.push(episode(2));
      app.seerr.state.requests[SEERR_IDS[ALICE]][0].status = 5;
      await webhook(app, 'tv', 7350001, ALICE);
      const grant = app.store.get(ITEMS.tSeries);
      assert.deepEqual(grant.groupIds, removed ? ['mill'] : ['grove', 'mill'], String(removed));
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
    assert.deepEqual(app.store.get(ITEMS.tSeries).groupIds, ['grove', 'mill']);
    assert.deepEqual(await listed(app), [{ mediaType: 'tv', tmdbId: T_TV, status: 'requested', seasons: [{ seasonNumber: 1, status: 'ready' }, { seasonNumber: 2, status: 'requested' }], byYou: true, cancellable: false }]);
    assert.equal(app.store.listAppRequests()[0][1].status, 'pending');
    assert.ok(app.requests.activeKeys('grove').has(`tv:${T_TV}:2`));
    assert.ok(!app.requests.activeKeys('grove').has(`tv:${T_TV}:1`));
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
    householdId: 'grove', jellyfinUserId: ALICE, mediaType: 'movie', tmdbId: T_MOVIE, seasons: [], branch: 'interest', status: 'pending',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...overrides,
  });

  it('keeps every pending record, whatever its age or number', async (t) => {
    const store = new GrantStore(path.join(await makeTempDir(t, 'jfa-get-this-'), 'grants.json'));
    await store.load();
    const old = new Date(Date.now() - 500 * DAY).toISOString();
    await store.writeAppRequests({ add: [record({ createdAt: old }), ...Array.from({ length: MAX_APP_REQUESTS_PER_HOUSEHOLD + 5 }, (_, index) => record({ tmdbId: index + 1 }))] });
    assert.equal(store.listAppRequests().length, MAX_APP_REQUESTS_PER_HOUSEHOLD + 6);
  });

  it('prunes settled records by age and per household, never a pending one', async (t) => {
    const store = new GrantStore(path.join(await makeTempDir(t, 'jfa-get-this-'), 'grants.json'));
    await store.load();
    const at = (days) => new Date(Date.now() - days * DAY).toISOString();
    await store.writeAppRequests({ add: [
      ...['completed', 'declined', 'deleted', 'failed'].map((status) => record({ status, createdAt: at(401) })),
      record({ status: 'pending', createdAt: at(401) }),
      record({ householdId: 'mill', status: 'completed', createdAt: at(1) }),
    ] });
    assert.deepEqual(store.listAppRequests().map(([, entry]) => [entry.householdId, entry.status]).sort(), [['grove', 'pending'], ['mill', 'completed']]);
  });

  it('loads a state file an earlier build of "Get this" wrote with a quota ledger, and drops the ledger', async (t) => {
    const file = path.join(await makeTempDir(t, 'jfa-get-this-'), 'grants.json');
    await writeFile(file, JSON.stringify({
      version: 7, grants: {}, groups: {}, catalog: { items: {} }, passwordlessUserIds: [],
      appRequests: { kept: record({ status: 'completed' }) },
      appQuotaLedger: { [ALICE]: { movie: { entries: [[Date.now() - DAY, 1]], older: { units: 2, oldest: 1, newest: 2 } } } },
    }));
    const store = new GrantStore(file);
    await store.load();
    assert.deepEqual(store.listAppRequests().map(([id]) => id), ['kept']);
    await store.writeAppRequests({ add: [record()] });
    await store.close();
    const written = JSON.parse(await readFile(file, 'utf8'));
    assert.equal('appQuotaLedger' in written, false);
    assert.equal(Object.keys(written.appRequests).length, 2);
  });
});
