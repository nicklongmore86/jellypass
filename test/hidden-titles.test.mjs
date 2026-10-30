// Hidden titles ("Not interested", 4.0.0; docs/app-design.md, "Hidden titles"): each member's own, in each household,
// left out of their discovery lists only, flagged in their search results and title pages, and never observable by
// another member or household.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { HIDDEN_PAGE_SIZE } from '../dist/app-api.js';
import { GrantStore, MAX_HIDDEN_TITLES_PER_MEMBER } from '../dist/store.js';
import { ALICE, ANN, BOB, CAROL, HOST_A, HOST_B, OWN_MOVIE, SHARED_HOUSEHOLDS, T_MOVIE, T_TV, startApp, world } from './support/household-app.mjs';
import { makeTempDir } from './support/temp-dir.mjs';

const APP = '/jellypass/app/v1';
const NOW = Date.parse('2026-10-30T12:00:00.000Z');
const AT = new Date(NOW).toISOString();
const HIDDEN_TRUE = '{"hidden":true}';
const HIDDEN_FALSE = '{"hidden":false}';

/** Everything a caller could see of an answer: status, every header and the body, as sent. */
function serialized(answer) {
  const headers = answer.rawHeaders.filter((_, index) => index % 2 === 0)
    .map((name, index) => `${name}: ${answer.rawHeaders[index * 2 + 1]}`)
    .filter((line) => !/^(date|connection|keep-alive):/i.test(line));
  return `${answer.status}\n${headers.join('\n')}\n\n${answer.text}`;
}

const ids = (page) => page.results.map((card) => `${card.mediaType}:${card.tmdbId}`);
const hide = (app, mediaType, tmdbId, options) => app.post(`${APP}/hidden/${mediaType}/${tmdbId}`, undefined, options);
const unhide = (app, mediaType, tmdbId, options) => app.post(`${APP}/hidden/${mediaType}/${tmdbId}`, undefined, { ...options, method: 'DELETE' });
/** TMDB and Seerr calls so far, and Jellyfin's but its token checks. */
const upstreamCalls = (app) => app.tmdb.calls.length + app.seerr.calls.length
  + app.jellyfin.requests.filter((request) => request.pathname !== '/Users/Me').length;

/** The discovery lists, each with the titles of a full answer for household A. */
const LISTS = [
  `${APP}/discover/trending`,
  `${APP}/discover/trending-movies`,
  `${APP}/discover/top-tv`,
  `${APP}/discover/network/213`,
  `${APP}/discover/network/213/films`,
  `${APP}/discover/network/213/all`,
  `${APP}/discover/studio/41077`,
];

describe('hidden titles: the store', () => {
  async function store(t, groups = SHARED_HOUSEHOLDS) {
    const file = path.join(await makeTempDir(t, 'jfa-hidden-'), 'grants.json');
    const grants = new GrantStore(file);
    await grants.load();
    for (const group of groups) await grants.upsertGroup(group);
    return { grants, file };
  }
  const input = (userId, tmdbId, extra = {}) => ({ householdId: 'grove', userId, mediaType: 'movie', tmdbId, at: AT, ...extra });

  it('keeps each member\'s own titles per household, newest first, the first hide\'s time kept', async (t) => {
    const { grants } = await store(t);
    assert.equal(await grants.hideTitle(input(ALICE, 1, { at: '2026-10-30T10:00:00.000Z' })), 'hidden');
    assert.equal(await grants.hideTitle(input(ALICE, 2, { mediaType: 'tv', at: '2026-10-30T11:00:00.000Z' })), 'hidden');
    // Hiding again keeps when it was first hidden; the same ID as another media type is another title.
    assert.equal(await grants.hideTitle(input(ALICE, 1, { at: '2026-10-30T12:00:00.000Z' })), 'hidden');
    assert.equal(await grants.hideTitle(input(ALICE, 2, { at: '2026-10-30T09:00:00.000Z' })), 'hidden');
    // Jellyfin IDs are compared as the app compares them: case and dashes aside.
    assert.deepEqual(grants.listHiddenTitles('GROVE', 'A11CE000-A11C-E000-A11C-E000A11CE000'), [
      { mediaType: 'tv', tmdbId: 2, hiddenAt: '2026-10-30T11:00:00.000Z' },
      { mediaType: 'movie', tmdbId: 1, hiddenAt: '2026-10-30T10:00:00.000Z' },
      { mediaType: 'movie', tmdbId: 2, hiddenAt: '2026-10-30T09:00:00.000Z' },
    ]);
    assert.deepEqual([...grants.hiddenTitleKeys('grove', ALICE)].sort(), ['movie:1', 'movie:2', 'tv:2']);
    // Nobody else's: not another member's, nor the same member's in another household.
    assert.deepEqual(grants.listHiddenTitles('grove', ANN), []);
    assert.deepEqual(grants.listHiddenTitles('mill', CAROL), []);
    await grants.hideTitle(input(CAROL, 7, { householdId: 'mill' }));
    assert.deepEqual(grants.listHiddenTitles('grove', CAROL), []);
    assert.equal(await grants.unhideTitle(input(ALICE, 1)), 'unhidden');
    assert.equal(await grants.unhideTitle(input(ALICE, 1)), 'unhidden', 'the same for a title not hidden');
    assert.deepEqual([...grants.hiddenTitleKeys('grove', ALICE)].sort(), ['movie:2', 'tv:2']);
  });

  it('refuses a new title past 2000 for that member only, never forgetting another, and unhiding frees a place', async (t) => {
    const { grants } = await store(t);
    assert.equal(MAX_HIDDEN_TITLES_PER_MEMBER, 2000);
    const results = await Promise.all(Array.from({ length: 2000 }, (_, index) => grants.hideTitle(input(ALICE, index + 1))));
    assert.ok(results.every((result) => result === 'hidden'));
    assert.equal(await grants.hideTitle(input(ALICE, 2001)), 'limit');
    assert.equal(await grants.hideTitle(input(ALICE, 1, { mediaType: 'tv' })), 'limit');
    assert.equal(await grants.hideTitle(input(ALICE, 5)), 'hidden', 'one already hidden is still accepted');
    assert.equal(grants.listHiddenTitles('grove', ALICE).length, 2000);
    assert.equal(await grants.hideTitle(input(ANN, 2001)), 'hidden', 'another member has a limit of their own');
    await grants.unhideTitle(input(ALICE, 5));
    assert.equal(await grants.hideTitle(input(ALICE, 2001)), 'hidden');
  });

  it('refuses a caller who is not a member now without writing anything', async (t) => {
    const { grants, file } = await store(t);
    const before = await readFile(file, 'utf8');
    assert.equal(await grants.hideTitle(input(BOB, 1)), 'not_member');
    assert.equal(await grants.unhideTitle(input(BOB, 1)), 'not_member');
    assert.equal(await grants.hideTitle(input(ALICE, 1, { householdId: 'nowhere' })), 'not_member');
    assert.equal(await readFile(file, 'utf8'), before);
    assert.deepEqual(grants.listHiddenTitles('grove', BOB), []);
  });

  it('removes a member\'s titles when they leave, and a household\'s when it is deleted; rejoining starts empty', async (t) => {
    const { grants, file } = await store(t);
    await grants.hideTitle(input(ALICE, 1));
    await grants.hideTitle(input(ANN, 2));
    await grants.hideTitle(input(CAROL, 3));
    await grants.hideTitle(input(CAROL, 4, { householdId: 'mill' }));
    await grants.upsertGroup({ id: 'grove', name: 'Grove', userIds: [ANN, CAROL] });
    assert.deepEqual(grants.listHiddenTitles('grove', ALICE), []);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).appHiddenTitles.grove[ALICE], undefined, 'gone from the state file');
    assert.deepEqual(grants.listHiddenTitles('grove', ANN).map((entry) => entry.tmdbId), [2]);
    await grants.upsertGroup({ id: 'grove', name: 'Grove', userIds: [ALICE, ANN, CAROL] });
    assert.deepEqual(grants.listHiddenTitles('grove', ALICE), [], 'rejoining starts with none');
    // Leaving one household keeps a member's titles in the other.
    await grants.upsertGroup({ id: 'mill', name: 'Mill', userIds: [BOB] });
    assert.deepEqual(grants.listHiddenTitles('grove', CAROL).map((entry) => entry.tmdbId), [3]);
    await grants.deleteGroup('grove');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).appHiddenTitles, undefined);
    await grants.upsertGroup({ id: 'grove', name: 'Grove', userIds: [ALICE, ANN, CAROL] });
    assert.deepEqual(grants.listHiddenTitles('grove', ANN), [], 'a household made again under the same ID starts with none');
  });

  it('keeps them across a restart in the 4.0 (v8) state file, and loads a v7 or v8 file without them', async (t) => {
    const { grants, file } = await store(t);
    await grants.hideTitle(input(ALICE, 1));
    await grants.hideTitle(input(CAROL, 2, { householdId: 'mill', mediaType: 'tv' }));
    await grants.close();
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.version, 8);
    assert.deepEqual(saved.appHiddenTitles, { grove: { [ALICE]: { 'movie:1': AT } }, mill: { [CAROL]: { 'tv:2': AT } } });
    const again = new GrantStore(file);
    await again.load();
    assert.deepEqual(again.listHiddenTitles('mill', CAROL), [{ mediaType: 'tv', tmdbId: 2, hiddenAt: AT }]);
    for (const version of [7, 8]) {
      const without = { ...saved, version };
      delete without.appHiddenTitles;
      await writeFile(file, JSON.stringify(without));
      const loaded = new GrantStore(file);
      await loaded.load();
      assert.deepEqual(loaded.listHiddenTitles('grove', ALICE), [], `v${version}`);
      assert.equal(await loaded.hideTitle(input(ALICE, 9)), 'hidden', `v${version}`);
      await loaded.close();
      assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 8);
    }
  });

  it('drops, on load, titles of members and households no longer there, and refuses a malformed field', async (t) => {
    const { grants, file } = await store(t);
    await grants.close();
    const saved = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...saved, appHiddenTitles: { grove: { [ALICE]: { 'movie:1': AT }, [BOB]: { 'movie:2': AT } }, gone: { [ALICE]: { 'tv:3': AT } } } }));
    const loaded = new GrantStore(file);
    await loaded.load();
    await loaded.close();
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).appHiddenTitles, { grove: { [ALICE]: { 'movie:1': AT } } });
    const tooMany = Object.fromEntries(Array.from({ length: 2001 }, (_, index) => [`movie:${index + 1}`, AT]));
    for (const bad of [[], 'x', { grove: [] }, { grove: { [ALICE]: { 'person:1': AT } } }, { grove: { [ALICE]: { 'movie:0': AT } } },
      { grove: { [ALICE]: { 'movie:2147483648': AT } } }, { grove: { [ALICE]: { 'movie:1': 'yesterday' } } }, { grove: { [ALICE]: { 'movie:1': 1 } } },
      { grove: { 'A11CE-000': { 'movie:1': AT } } }, { grove: { [ALICE]: tooMany } }]) {
      await writeFile(file, JSON.stringify({ ...saved, appHiddenTitles: bad }));
      await assert.rejects(new GrantStore(file).load(), /invalid appHiddenTitles/, JSON.stringify(bad).slice(0, 80));
    }
  });
});

describe('hidden titles: the caller\'s own answers', { timeout: 30_000 }, () => {
  it('leaves hidden titles out of every discovery list for the caller only, keeping them in search and title pages', async (t) => {
    const app = await startApp(t, world(), { now: () => NOW });
    const before = Object.fromEntries(await Promise.all(LISTS.map(async (pathname) => [pathname, (await app.get(pathname)).json()])));
    assert.ok(LISTS.every((pathname) => ids(before[pathname]).some((id) => [`movie:${T_MOVIE}`, `tv:${T_TV}`].includes(id))), 'each list shows T');
    const calls = upstreamCalls(app);
    const tmdb = app.tmdb.calls.length;
    for (const [mediaType, tmdbId] of [['movie', T_MOVIE], ['tv', T_TV]]) {
      const answer = await hide(app, mediaType, tmdbId);
      assert.equal(answer.status, 200);
      assert.equal(answer.text, HIDDEN_TRUE);
      assert.equal(answer.headers['cache-control'], 'no-store');
    }
    assert.equal(upstreamCalls(app), calls, 'hiding asks TMDB, Seerr and Jellyfin nothing');
    for (const pathname of LISTS) {
      const page = (await app.get(pathname)).json();
      // The same page and continuation, without T: shorter, never made up from another page.
      assert.deepEqual(page, { ...before[pathname], results: before[pathname].results.filter((card) => card.tmdbId !== T_MOVIE && card.tmdbId !== T_TV) }, pathname);
      assert.ok(page.results.every((card) => card.hidden === false), pathname);
      // Another member of the household sees them, as before.
      assert.deepEqual((await app.get(pathname, { user: ANN })).json(), before[pathname], `${pathname} for Ann`);
    }
    assert.equal(app.tmdb.calls.length, tmdb, 'every list answered from the household\'s cache, as before');
    // Search keeps them, flagged for the caller alone; so do their title pages.
    const search = (await app.get(`${APP}/search?q=synthetic`)).json();
    assert.deepEqual(search.results.map((card) => [card.tmdbId, card.hidden]), [[T_MOVIE, true], [T_TV, true], [OWN_MOVIE, false]]);
    assert.ok((await app.get(`${APP}/search?q=synthetic`, { user: ANN })).json().results.every((card) => card.hidden === false));
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).json().hidden, true);
    assert.equal((await app.get(`${APP}/tv/${T_TV}`)).json().hidden, true);
    assert.equal((await app.get(`${APP}/movie/${OWN_MOVIE}`)).json().hidden, false);
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`, { user: ANN })).json().hidden, false);
    assert.equal('hidden' in (await app.get(`${APP}/tv/${T_TV}/season/1`)).json(), false, 'a season carries no flag of its own');
    // Unhidden, every list is as it was.
    for (const [mediaType, tmdbId] of [['movie', T_MOVIE], ['tv', T_TV]]) assert.equal((await unhide(app, mediaType, tmdbId)).text, HIDDEN_FALSE);
    for (const pathname of LISTS) assert.deepEqual((await app.get(pathname)).json(), before[pathname], pathname);
  });

  it('keeps a page\'s continuation when every title on it is hidden, and reads no other page to fill it', async (t) => {
    const app = await startApp(t, world({ extraResults: 20 }), { now: () => NOW });
    const studio = (await app.get(`${APP}/discover/studio/41077?page=2`)).json();
    assert.equal(studio.nextPage, 3);
    assert.ok(studio.results.length >= 20);
    for (const card of studio.results) await app.store.hideTitle({ householdId: 'grove', userId: ALICE, mediaType: card.mediaType, tmdbId: card.tmdbId, at: AT });
    const tmdb = app.tmdb.calls.length;
    assert.deepEqual((await app.get(`${APP}/discover/studio/41077?page=2`)).json(), { page: 2, nextPage: 3, results: [] });
    assert.equal(app.tmdb.calls.length, tmdb, 'no back-fill');
    // A network's mixed page leaves out hidden films and keeps its series' and films' continuation.
    const all = (await app.get(`${APP}/discover/network/213/all`)).json();
    assert.deepEqual(ids(all), [`tv:${T_TV}`]);
    assert.equal(all.nextPage, 2);
    assert.equal((await app.get(`${APP}/discover/network/213/all`, { user: ANN })).json().results.length, studio.results.length + 1);
  });

  it('answers hiding and unhiding byte for byte the same whether or not the title was hidden', async (t) => {
    const app = await startApp(t, world(), { now: () => NOW });
    const first = serialized(await hide(app, 'movie', T_MOVIE));
    assert.equal(serialized(await hide(app, 'movie', T_MOVIE)), first);
    const unhidden = serialized(await unhide(app, 'movie', T_MOVIE));
    assert.equal(serialized(await unhide(app, 'movie', T_MOVIE)), unhidden);
    assert.equal(serialized(await unhide(app, 'tv', 123456)), unhidden, 'a title never hidden');
    assert.equal(serialized(await hide(app, 'tv', 123456)), first, 'TMDB is not asked whether it exists');
    // `{}` is the same as no body; anything else, a bad ID or another method is refused before anything is written.
    assert.equal((await app.post(`${APP}/hidden/movie/${T_MOVIE}`, {})).text, HIDDEN_TRUE);
    for (const [method, pathname, body] of [['POST', `${APP}/hidden/movie/${T_MOVIE}`, { seasons: [1] }], ['POST', `${APP}/hidden/movie/0`, undefined],
      ['DELETE', `${APP}/hidden/tv/2147483648`, undefined], ['POST', `${APP}/hidden/movie/${'1'.repeat(11)}`, undefined], ['POST', `${APP}/hidden/movie/${T_MOVIE}`, 'x'.repeat(2000)]]) {
      const answer = await app.post(pathname, body, { method });
      assert.equal(answer.status, 400, `${method} ${pathname}`);
      assert.equal(answer.text, '{"error":"invalid_request"}');
    }
    for (const [method, pathname] of [['PUT', `${APP}/hidden/movie/${T_MOVIE}`], ['GET', `${APP}/hidden/movie/${T_MOVIE}`], ['POST', `${APP}/hidden/person/1`],
      ['POST', `${APP}/hidden`], ['DELETE', `${APP}/hidden`], ['DELETE', `${APP}/movie/${T_MOVIE}`], ['POST', `${APP}/hidden/movie/${T_MOVIE}/x`]]) {
      const answer = await app.post(pathname, undefined, { method });
      assert.equal(answer.status, 404, `${method} ${pathname}`);
      assert.equal(answer.text, '{"error":"not_found"}');
    }
    // The app API never hands any of these to Jellyfin.
    assert.ok(app.jellyfin.requests.every((request) => !request.pathname.includes('/hidden')));
    assert.deepEqual(app.store.listHiddenTitles('grove', ALICE).map((entry) => `${entry.mediaType}:${entry.tmdbId}`).sort(), [`movie:${T_MOVIE}`, 'tv:123456']);
  });

  it('pages the caller\'s own list newest first, 50 a page, with IDs and times only', async (t) => {
    let clock = NOW;
    const app = await startApp(t, world(), { now: () => clock });
    assert.equal(HIDDEN_PAGE_SIZE, 50);
    assert.deepEqual((await app.get(`${APP}/hidden`)).json(), { page: 1, nextPage: null, results: [] });
    for (let index = 1; index <= 3; index += 1) {
      clock += 1000;
      assert.equal((await hide(app, index === 2 ? 'tv' : 'movie', index)).status, 200);
    }
    assert.deepEqual((await app.get(`${APP}/hidden`)).json(), {
      page: 1,
      nextPage: null,
      results: [
        { mediaType: 'movie', tmdbId: 3, hiddenAt: new Date(NOW + 3000).toISOString() },
        { mediaType: 'tv', tmdbId: 2, hiddenAt: new Date(NOW + 2000).toISOString() },
        { mediaType: 'movie', tmdbId: 1, hiddenAt: new Date(NOW + 1000).toISOString() },
      ],
    });
    await Promise.all(Array.from({ length: 98 }, (_, index) =>
      app.store.hideTitle({ householdId: 'grove', userId: ALICE, mediaType: 'movie', tmdbId: 1000 + index, at: new Date(NOW - index * 1000).toISOString() })));
    const pages = [];
    for (let page = 1; page <= 4; page += 1) pages.push((await app.get(`${APP}/hidden?page=${page}`)).json());
    assert.deepEqual(pages.map((page) => [page.page, page.nextPage, page.results.length]), [[1, 2, 50], [2, 3, 50], [3, null, 1], [4, null, 0]]);
    const listed = pages.flatMap((page) => page.results);
    assert.equal(new Set(listed.map((entry) => `${entry.mediaType}:${entry.tmdbId}`)).size, 101);
    assert.deepEqual(listed.map((entry) => entry.hiddenAt), listed.map((entry) => entry.hiddenAt).sort().reverse());
    // Another member's list, and the caller's in another household, are their own.
    assert.deepEqual((await app.get(`${APP}/hidden`, { user: ANN })).json(), { page: 1, nextPage: null, results: [] });
    assert.deepEqual((await app.get(`${APP}/hidden`, { host: HOST_B, user: BOB })).json(), { page: 1, nextPage: null, results: [] });
    assert.equal(app.tmdb.calls.length, 0, 'the list asks TMDB nothing');
  });

  it('refuses a new title past the caller\'s 2000 with the fixed 409, and still unhides', async (t) => {
    const app = await startApp(t, world(), { now: () => NOW });
    await Promise.all(Array.from({ length: 2000 }, (_, index) =>
      app.store.hideTitle({ householdId: 'grove', userId: ALICE, mediaType: 'movie', tmdbId: index + 1, at: AT })));
    const refused = await hide(app, 'tv', 1);
    assert.equal(refused.status, 409);
    assert.equal(refused.text, '{"error":"hidden_limit_reached"}');
    assert.equal(refused.headers['cache-control'], 'no-store');
    assert.equal((await hide(app, 'movie', 1)).text, HIDDEN_TRUE, 'one already hidden');
    assert.equal((await hide(app, 'tv', 1, { user: ANN })).text, HIDDEN_TRUE, 'Ann is not limited by Alice\'s');
    assert.equal((await unhide(app, 'movie', 1)).text, HIDDEN_FALSE);
    assert.equal((await hide(app, 'tv', 1)).text, HIDDEN_TRUE);
  });

  it('leaves My requests, Get this and the title\'s state unchanged, and writes nothing but the caller\'s own entry', async (t) => {
    const app = await startApp(t, world(), { now: () => NOW });
    assert.equal((await app.post(`${APP}/movie/${T_MOVIE}/get`, {})).status, 202);
    await app.background.settled();
    const requests = serialized(await app.get(`${APP}/requests`));
    const title = (await app.get(`${APP}/movie/${T_MOVIE}`)).json();
    assert.equal(title.state, 'requested');
    const before = JSON.parse(await readFile(app.stateFile, 'utf8'));
    await hide(app, 'movie', T_MOVIE);
    await hide(app, 'movie', OWN_MOVIE);
    assert.equal(serialized(await app.get(`${APP}/requests`)), requests);
    assert.deepEqual((await app.get(`${APP}/movie/${T_MOVIE}`)).json(), { ...title, hidden: true });
    const after = JSON.parse(await readFile(app.stateFile, 'utf8'));
    assert.deepEqual(after.appHiddenTitles, { grove: { [ALICE]: { [`movie:${T_MOVIE}`]: AT, [`movie:${OWN_MOVIE}`]: AT } } });
    delete after.appHiddenTitles;
    assert.deepEqual(after, before, 'no request, withdrawal, hold or grant');
    // A hidden title can still be asked for, and stays hidden.
    assert.equal((await app.post(`${APP}/movie/${OWN_MOVIE}/get`, {})).status, 202);
    await app.background.settled();
    assert.equal((await app.get(`${APP}/movie/${OWN_MOVIE}`)).json().hidden, true);
  });

  it('refuses a member who left, though their session is still verified, and gives them none back on rejoining', async (t) => {
    const app = await startApp(t, world(), { now: () => NOW });
    await hide(app, 'movie', T_MOVIE);
    await app.store.upsertGroup({ id: 'grove', name: 'Grove', userIds: [ANN] });
    for (const answer of [await hide(app, 'movie', OWN_MOVIE), await unhide(app, 'movie', T_MOVIE), await app.get(`${APP}/hidden`)]) {
      assert.equal(answer.status, 401);
      assert.equal(answer.text, '{"error":"unauthorized"}');
    }
    assert.equal(JSON.parse(await readFile(app.stateFile, 'utf8')).appHiddenTitles, undefined);
    await app.store.upsertGroup({ id: 'grove', name: 'Grove', userIds: [ALICE, ANN] });
    assert.deepEqual((await app.get(`${APP}/hidden`)).json().results, []);
    assert.ok(ids((await app.get(`${APP}/discover/trending`)).json()).includes(`movie:${T_MOVIE}`));
  });
});

describe('hidden titles: nothing of them reaches anyone else', { timeout: 60_000 }, () => {
  // Carol is in both households, so a member's titles in one household are tested against the same member in the other.
  const OBSERVERS = [
    { name: 'Ann in Grove', user: ANN, host: HOST_A, household: 'grove' },
    { name: 'Carol in Grove', user: CAROL, host: HOST_A, household: 'grove' },
    { name: 'Bob in Mill', user: BOB, host: HOST_B, household: 'mill' },
    { name: 'Carol in Mill', user: CAROL, host: HOST_B, household: 'mill' },
  ];
  const READS = [
    `${APP}/me`,
    `${APP}/search?q=synthetic`,
    ...LISTS,
    `${APP}/discover/sources`,
    `${APP}/movie/${T_MOVIE}`,
    `${APP}/movie/${OWN_MOVIE}`,
    `${APP}/tv/${T_TV}`,
    `${APP}/tv/${T_TV}/season/1`,
    `${APP}/requests`,
    `${APP}/hidden`,
  ];
  const T_TITLES = [['movie', T_MOVIE], ['tv', T_TV], ['movie', OWN_MOVIE]];
  /** Worlds that differ from the baseline only in what one member hid in one household. */
  const WORLDS = {
    baseline: [],
    'Alice hid T in Grove': [{ user: ALICE, host: HOST_A, household: 'grove', titles: T_TITLES }],
    'Alice hid 2000 titles in Grove and is at her limit': [{ user: ALICE, host: HOST_A, household: 'grove', titles: T_TITLES, fill: true }],
    'Carol hid T in Mill': [{ user: CAROL, host: HOST_B, household: 'mill', titles: T_TITLES }],
    'Bob hid T in Mill': [{ user: BOB, host: HOST_B, household: 'mill', titles: T_TITLES }],
    'Ann hid then unhid T in Grove': [{ user: ANN, host: HOST_A, household: 'grove', titles: T_TITLES, unhide: true }],
  };

  it('gives every other member and household byte-identical answers, whatever one member hid', async (t) => {
    const seen = {};
    for (const [worldName, hiders] of Object.entries(WORLDS)) {
      const app = await startApp(t, world(), { now: () => NOW, households: SHARED_HOUSEHOLDS });
      const calls = upstreamCalls(app);
      for (const hider of hiders) {
        for (const [mediaType, tmdbId] of hider.titles) assert.equal((await hide(app, mediaType, tmdbId, hider)).status, 200);
        if (hider.unhide) for (const [mediaType, tmdbId] of hider.titles) assert.equal((await unhide(app, mediaType, tmdbId, hider)).status, 200);
        if (hider.fill) {
          await Promise.all(Array.from({ length: 2000 }, (_, index) =>
            app.store.hideTitle({ householdId: hider.household, userId: hider.user, mediaType: 'movie', tmdbId: 500000 + index, at: AT })));
          assert.equal((await hide(app, 'tv', 1, hider)).status, 409);
        }
      }
      assert.equal(upstreamCalls(app), calls, `${worldName}: hiding made no upstream call that could warm or cool a cache`);
      for (const observer of OBSERVERS) {
        if (hiders.some((hider) => hider.user === observer.user && hider.household === observer.household && !hider.unhide)) continue;
        const answers = [];
        for (const pathname of READS) answers.push(`${pathname}\n${serialized(await app.get(pathname, observer))}`);
        // The observer's own hiding and unhiding of the same title, its limit and its list, after.
        answers.push(serialized(await hide(app, 'movie', T_MOVIE, observer)));
        answers.push(serialized(await app.get(`${APP}/hidden`, observer)));
        answers.push(serialized(await app.get(`${APP}/discover/trending`, observer)));
        answers.push(serialized(await unhide(app, 'movie', T_MOVIE, observer)));
        answers.push(serialized(await unhide(app, 'tv', 1, observer)));
        (seen[observer.name] ??= {})[worldName] = answers.join('\n---\n');
        // Undo the observer's own hide so the next observer's world is the same.
        assert.deepEqual(app.store.listHiddenTitles(observer.household, observer.user), []);
      }
    }
    for (const [observer, worlds] of Object.entries(seen)) {
      assert.ok(Object.keys(worlds).length >= 4, observer);
      for (const [worldName, text] of Object.entries(worlds)) assert.equal(text, worlds.baseline, `${observer}: ${worldName}`);
    }
  });

  it('keeps one household\'s TMDB cache shared, filtering each member\'s answer after it', async (t) => {
    const app = await startApp(t, world(), { now: () => NOW });
    await hide(app, 'movie', T_MOVIE);
    for (const pathname of LISTS) await app.get(pathname);
    const after = app.tmdb.calls.length;
    for (const pathname of [`${APP}/discover/trending`, `${APP}/discover/trending-movies`, `${APP}/discover/network/213/films`, `${APP}/discover/studio/41077`]) {
      assert.ok(ids((await app.get(pathname, { user: ANN })).json()).includes(`movie:${T_MOVIE}`), pathname);
    }
    assert.equal(app.tmdb.calls.length, after, 'Ann was answered from the household\'s cache Alice filled, with T');
  });
});
