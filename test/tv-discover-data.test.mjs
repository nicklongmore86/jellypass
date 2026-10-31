// The TV add-on's Discover data layer (tv/src/api.ts readers, discover-model.ts, discover-data.ts): groundwork for the
// Discover page, which does not draw anything yet. The readers are checked against the real app API and its OpenAPI
// document, the cache and session rules against scripted answers, and the budget file's `tv-discover*` entries against
// the layout. The sources are TypeScript, so they are bundled here (esbuild, ES2017 like the add-on) and imported.
// Assertion messages carry strings and numbers only, never a card list or a DOM node.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { parse } from 'acorn';
import { build } from 'esbuild';
import { ALICE, BOB, HOST_A, startApp, world } from './support/household-app.mjs';
import { validate } from './support/json-schema.mjs';
import { makeTempDir } from './support/temp-dir.mjs';

const ROOT = path.join(import.meta.dirname, '..');
const BUDGET = JSON.parse(readFileSync(path.join(ROOT, 'docs', 'app-api', 'fetch-budget.json'), 'utf8'));
const DOC = JSON.parse(readFileSync(path.join(ROOT, 'docs', 'app-api', 'v1.openapi.json'), 'utf8'));
const PAGE_SCHEMA = { $ref: '#/components/schemas/Page' };
const SOURCES_SCHEMA = { $ref: '#/components/schemas/Sources' };
const ORIGIN = 'https://jelly-grove.example.test';

let mod;
let bundleText;
before(async () => {
  const dir = await makeTempDir(null, 'tv-discover-');
  const entry = ['api', 'discover-model', 'discover-data', 'session-watch'].map((name) => `export * from ${JSON.stringify(path.join(ROOT, 'tv', 'src', `${name}.ts`))};`).join('\n');
  const result = await build({ stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' }, bundle: true, format: 'esm', target: 'es2017', platform: 'browser', write: false });
  bundleText = result.outputFiles[0].text;
  const file = path.join(dir, 'discover.mjs');
  writeFileSync(file, bundleText);
  mod = await import(pathToFileURL(file).href);
});

/** A signed-in Jellyfin web, as the add-on reads it (`window.ApiClient`); `as` changes who is signed in. */
function webScope(userId = 'alice', token = 'token-alice') {
  let current = { userId, token };
  const scope = {
    ApiClient: {
      accessToken: () => current?.token,
      serverAddress: () => ORIGIN,
      getCurrentUserId: () => current?.userId,
    },
    as(next) { current = next; },
  };
  return scope;
}

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const card = (id, state = 'get_this', extra = {}) => ({
  mediaType: 'movie', tmdbId: id, title: `Synthetic ${id}`, year: 2020, overview: `About ${id}`, posterUrl: `https://image.tmdb.org/t/p/w342/p${id}.jpg`,
  backdropUrl: `https://image.tmdb.org/t/p/w780/b${id}.jpg`, rating: 7.5, state, play: null, ...extra,
});
const page = (results, extra = {}) => ({ page: 1, nextPage: null, results, ...extra });

/** A scripted API: `answer(path)` returns a Response (or a promise of one); every call is recorded as `path`. */
function scripted(answer) {
  const calls = [];
  const fetcher = async (url, init) => {
    assert.equal(init.credentials, 'omit');
    assert.ok(url.startsWith(`${ORIGIN}/jellypass/app/v1/`), 'the API on the add-on\'s own origin');
    const pathname = url.slice(`${ORIGIN}/jellypass/app/v1`.length);
    calls.push({ path: pathname, authorization: init.headers.Authorization, method: init.method });
    return answer(pathname, init);
  };
  return { fetcher, calls, paths: () => calls.map((call) => call.path) };
}

/** A DiscoverData over a scripted API, with a clock the test moves. */
function discover(answer = () => json(page([card(1)])), { scope = webScope() } = {}) {
  const api = scripted(answer);
  const clock = { mono: 1_000, wall: 1_700_000_000_000 };
  const watch = new mod.SessionWatch(scope, ORIGIN);
  const data = new mod.DiscoverData(api.fetcher, ORIGIN, watch, () => clock.mono, () => clock.wall);
  const advance = (ms) => { clock.mono += ms; clock.wall += ms; };
  return { data, api, scope, clock, advance };
}

describe('TV Discover data layer: the readers', { timeout: 60_000 }, () => {
  it('is built for the TVs\' Chromium 63: the bundle of the new modules parses as ES2017', () => {
    parse(bundleText, { ecmaVersion: 2017, sourceType: 'module' });
    lacksPattern(bundleText, /\?\.|\?\?|\.\.\.[A-Za-z_]/, 'no optional chaining, nullish or spread left after the ES2017 lowering');
  });

  it('reads every Discover endpoint of the real app API: the answer validates against the OpenAPI document and the readers keep what it says', async (t) => {
    const app = await startApp(t, world());
    const fetcher = async (url, init) => {
      const target = new URL(url);
      const answer = await app.get(`${target.pathname}${target.search}`, { host: HOST_A, user: null, headers: init.headers });
      return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } });
    };
    const raw = async (pathname) => {
      const answer = await app.get(`/jellypass/app/v1${pathname}`, { user: ALICE });
      assert.equal(answer.status, 200, pathname);
      return answer.json();
    };
    const token = 'token-alice';
    const sameCards = (read, expected, name) => {
      assert.ok(read.length <= mod.MAX_CARDS, name);
      assert.equal(read.length, Math.min(expected.length, mod.MAX_CARDS), name);
      read.forEach((shown, index) => {
        const sent = expected[index];
        for (const field of ['mediaType', 'tmdbId', 'title', 'year', 'overview', 'posterUrl', 'backdropUrl', 'rating', 'state']) {
          assert.equal(shown[field], sent[field], `${name}: card ${index} ${field}`);
        }
      });
    };
    let cards = 0;
    for (const list of mod.DISCOVER_LISTS) {
      const sent = await raw(`/discover/${list}`);
      assert.deepEqual(validate(sent, PAGE_SCHEMA, DOC), [], list);
      const answer = await mod.discoverList(fetcher, ORIGIN, token, list);
      assert.ok(answer.ok, list);
      assert.equal(answer.page.page, sent.page);
      assert.equal(answer.page.nextPage, sent.nextPage);
      sameCards(answer.page.cards, sent.results, list);
      cards += answer.page.cards.length;
    }
    assert.ok(cards > 0, 'the lists have cards');
    for (const [name, pathname, read] of [
      ['network series', '/discover/network/213', () => mod.networkList(fetcher, ORIGIN, token, 213, 'series')],
      ['network films', '/discover/network/213/films', () => mod.networkList(fetcher, ORIGIN, token, 213, 'films')],
      ['network all', '/discover/network/213/all', () => mod.networkList(fetcher, ORIGIN, token, 213, 'all')],
      ['studio', '/discover/studio/41077', () => mod.studioList(fetcher, ORIGIN, token, 41077)],
      ['second page', '/discover/upcoming?page=2', () => mod.discoverList(fetcher, ORIGIN, token, 'upcoming', 2)],
      ['studio second page', '/discover/studio/41077?page=2', () => mod.studioList(fetcher, ORIGIN, token, 41077, 2)],
    ]) {
      const sent = await raw(pathname);
      assert.deepEqual(validate(sent, PAGE_SCHEMA, DOC), [], name);
      const answer = await read();
      assert.ok(answer.ok, name);
      assert.equal(answer.page.page, sent.page, name);
      assert.equal(answer.page.nextPage, sent.nextPage, name);
      sameCards(answer.page.cards, sent.results, name);
    }
    const sources = await raw('/discover/sources');
    assert.deepEqual(validate(sources, SOURCES_SCHEMA, DOC), []);
    const read = await mod.discoverSources(fetcher, ORIGIN, token);
    assert.ok(read.ok);
    assert.deepEqual(read.sources, { networks: sources.networks, studios: sources.studios });
    assert.ok(read.sources.networks.length >= 8 && read.sources.studios.length > 0);
  });

  it('asks for the app\'s own addresses with only the token, the first page without a query', async () => {
    const api = scripted(() => json(page([card(1)])));
    await mod.discoverList(api.fetcher, ORIGIN, 'tok"en', 'trending');
    await mod.discoverList(api.fetcher, ORIGIN, 't', 'upcoming-tv', 3);
    await mod.networkList(api.fetcher, ORIGIN, 't', 213, 'series');
    await mod.networkList(api.fetcher, ORIGIN, 't', 213, 'films', 2);
    await mod.networkList(api.fetcher, ORIGIN, 't', 213, 'all');
    await mod.studioList(api.fetcher, ORIGIN, 't', 41077, 2);
    await mod.discoverSources(api.fetcher, ORIGIN, 't');
    assert.deepEqual(api.paths(), ['/discover/trending', '/discover/upcoming-tv?page=3', '/discover/network/213', '/discover/network/213/films?page=2', '/discover/network/213/all', '/discover/studio/41077?page=2', '/discover/sources']);
    assert.equal(api.calls[0].authorization, 'MediaBrowser Token="tok%22en"');
    assert.ok(api.calls.every((call) => call.method === 'GET'));
  });

  it('sends nothing for an address the API does not have', async () => {
    const api = scripted(() => json(page([])));
    const bad = [
      await mod.discoverList(api.fetcher, ORIGIN, 't', 'top-movies'),
      await mod.discoverList(api.fetcher, ORIGIN, 't', 'trending', 0),
      await mod.discoverList(api.fetcher, ORIGIN, 't', 'trending', 501),
      await mod.discoverList(api.fetcher, ORIGIN, 't', 'trending', 1.5),
      await mod.discoverList(api.fetcher, ORIGIN, 't', 'trending', Number.NaN),
      await mod.networkList(api.fetcher, ORIGIN, 't', 0, 'all'),
      await mod.networkList(api.fetcher, ORIGIN, 't', -3, 'all'),
      await mod.networkList(api.fetcher, ORIGIN, 't', 1.5, 'all'),
      await mod.networkList(api.fetcher, ORIGIN, 't', 213, 'movies'),
      await mod.studioList(api.fetcher, ORIGIN, 't', Number.NaN),
      await mod.studioList(api.fetcher, ORIGIN, 't', 5, 0),
    ];
    assert.deepEqual(bad.map((answer) => [answer.ok, answer.status]), bad.map(() => [false, 400]));
    assert.equal(api.calls.length, 0);
  });

  it('reads leniently: unknown states, bad URLs and bad numbers are cleaned, never trusted', async () => {
    const odd = (extra) => card(9, 'get_this', extra);
    const { fetcher } = scripted(() => json({
      page: 'two',
      nextPage: 1,
      results: [
        odd({ state: 'held_elsewhere', posterUrl: 'https://evil.example/p.jpg', backdropUrl: 'https://image.tmdb.org/t/p/w780/../x.jpg', rating: 11, overview: 7, year: 20000 }),
        odd({ tmdbId: 'x' }),
        null,
        'text',
        odd({ mediaType: 'person' }),
        odd({ title: '' }),
        odd({ title: 'T'.repeat(500), overview: 'O'.repeat(5000), rating: 0 }),
      ],
    }));
    const answer = await mod.discoverList(fetcher, ORIGIN, 't', 'trending', 4);
    assert.ok(answer.ok);
    // `page` is the one asked for when the answer's is not a page number; `nextPage` must come after the page.
    assert.deepEqual([answer.page.page, answer.page.nextPage, answer.page.cards.length], [4, null, 2]);
    const [first, second] = answer.page.cards;
    assert.deepEqual([first.state, first.posterUrl, first.backdropUrl, first.rating, first.overview, first.year], ['unavailable', null, null, null, '', null]);
    assert.deepEqual([second.title.length, second.overview.length, second.rating], [300, 2000, 0]);
    for (const body of [null, [], 'x', { results: 'no' }, {}]) {
      const failed = await mod.discoverList(scripted(() => json(body)).fetcher, ORIGIN, 't', 'trending');
      assert.deepEqual([failed.ok, failed.status], [false, 502], JSON.stringify(body));
    }
    const notJson = await mod.discoverList(scripted(() => new Response('<html>', { status: 200 })).fetcher, ORIGIN, 't', 'trending');
    assert.deepEqual([notJson.ok, notJson.status], [false, 502]);
  });

  it('reads the sources leniently, keeps their order and caps them', async () => {
    const networks = [{ id: 213, name: 'Grove Stream', logoUrl: 'https://image.tmdb.org/t/p/w300/n.png', hasFilms: true }, { id: 0, name: 'Zero', logoUrl: null, hasFilms: true }, { id: 7, name: '', logoUrl: null, hasFilms: true }, { id: 9, name: 'N'.repeat(200), logoUrl: 'https://evil.example/n.png', hasFilms: 'yes' }];
    const studios = Array.from({ length: 80 }, (_, index) => ({ id: index + 1, name: `Studio ${index + 1}`, logoUrl: null }));
    const answer = await mod.discoverSources(scripted(() => json({ networks, studios })).fetcher, ORIGIN, 't');
    assert.ok(answer.ok);
    assert.deepEqual(answer.sources.networks.map((network) => [network.id, network.name.length, network.logoUrl === null, network.hasFilms]), [[213, 12, false, true], [9, 100, true, false]]);
    assert.equal(answer.sources.studios.length, mod.MAX_SOURCES);
    assert.equal(answer.sources.studios[0].id, 1);
    const bad = await mod.discoverSources(scripted(() => json({ networks: [] })).fetcher, ORIGIN, 't');
    assert.deepEqual([bad.ok, bad.status], [false, 502]);
  });

  it('reads a 429\'s Retry-After as the search row does, and any other failure by its status', async () => {
    const answer = async (response) => mod.discoverList(scripted(() => response).fetcher, ORIGIN, 't', 'trending');
    assert.deepEqual(await answer(json({}, 429, { 'retry-after': '7' })), { ok: false, status: 429, retryAfterMs: 7000 });
    assert.deepEqual(await answer(json({}, 429)), { ok: false, status: 429 });
    assert.deepEqual(await answer(json({}, 429, { 'retry-after': 'tomorrow' })), { ok: false, status: 429 });
    assert.deepEqual(await answer(json({}, 429, { 'retry-after': '99999' })), { ok: false, status: 429 });
    assert.deepEqual(await answer(json({}, 401)), { ok: false, status: 401 });
    assert.deepEqual(await answer(json({}, 404)), { ok: false, status: 404 });
    const down = await mod.discoverList(async () => { throw new Error('offline'); }, ORIGIN, 't', 'trending');
    assert.deepEqual(down, { ok: false, status: 0 });
  });
});

/** A regexp check that reports the pattern, never the (large) text. */
function lacksPattern(text, pattern, message) {
  assert.ok(!pattern.test(text), message);
}

describe('TV Discover data layer: the model', () => {
  it('caps a row at 14 cards on a TV, keeps the page\'s 20 for a grid, and hides what the household has before capping', () => {
    assert.equal(mod.DISCOVER_ROW_CARDS, 14);
    const cards = Array.from({ length: 20 }, (_, index) => card(index + 1, index % 2 === 0 ? 'in_library' : 'get_this'));
    assert.equal(mod.rowCards(cards).length, 14);
    assert.deepEqual(mod.rowCards(cards).map((shown) => shown.tmdbId), cards.slice(0, 14).map((shown) => shown.tmdbId));
    // Hiding comes first: the ten that can still be got fill the row, not the seven of the first fourteen.
    assert.deepEqual(mod.rowCards(cards, true).map((shown) => shown.tmdbId), [2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    const many = Array.from({ length: 20 }, (_, index) => card(index + 1, 'get_this'));
    assert.equal(mod.rowCards(many, true).length, 14);
    assert.equal(mod.rowCards([]).length, 0);
  });

  it('words the four states as the app does, with a tone that is never the only sign', () => {
    assert.deepEqual(['in_library', 'requested', 'get_this', 'unavailable'].map((state) => mod.badgeOf(state).label), ['In your library', 'Requested', 'Available to get', "Can't request"]);
    assert.deepEqual(['in_library', 'requested', 'get_this', 'unavailable'].map((state) => mod.badgeOf(state).tone), ['owned', 'pending', 'open', 'closed']);
    assert.equal(mod.badgeOf('anything else').label, "Can't request");
    // The app's own words (app/src/render.ts) for three of them; for a title in the library the owner chose "In your library" on the TV.
    const app = readFileSync(path.join(ROOT, 'app', 'src', 'render.ts'), 'utf8');
    for (const line of ["requested: 'Requested'", "get_this: 'Available to get'", `unavailable: "Can't request"`, "in_library: 'Ready to watch'"]) assert.ok(app.includes(line), `the app still has ${line}`);
    const held = ['in_library', 'requested', 'get_this', 'unavailable'].filter((state) => mod.isHeld({ state }));
    assert.deepEqual(held, ['in_library', 'requested']);
  });

  it('picks the hero\'s five slides from the first row\'s cards with a backdrop', () => {
    const cards = [card(1, 'get_this', { backdropUrl: null }), ...Array.from({ length: 8 }, (_, index) => card(index + 2))];
    assert.deepEqual(mod.heroCards(cards).map((shown) => shown.tmdbId), [2, 3, 4, 5, 6]);
    assert.equal(mod.HERO_SLIDES, 5);
    assert.deepEqual(mod.heroCards([card(1, 'get_this', { backdropUrl: null })]), []);
  });

  it('mirrors the app\'s Home layout: the same lists, headings, shapes and order under each chip', () => {
    const source = readFileSync(path.join(ROOT, 'app', 'src', 'main.ts'), 'utf8');
    const block = source.slice(source.indexOf('const HOME_LAYOUT'), source.indexOf('/** What a service\'s row lists'));
    const parts = (name, next) => {
      const from = block.indexOf(`${name}: [`);
      const text = block.slice(from, next ? block.indexOf(`${next}: [`) : block.length);
      return [...text.matchAll(/row\('([a-z-]+)', '([^']+)', '(poster|backdrop)', (true|false)\)|\{ part: '(networks|studios|credit)' \}/g)].map((found) => (
        found[5] ? { part: found[5] } : { part: 'row', list: found[1], heading: found[2], variant: found[3], eager: found[4] === 'true' }
      ));
    };
    const app = { all: parts('all', 'movies'), movies: parts('movies', 'tv'), tv: parts('tv') };
    assert.ok(app.all.length === 9 && app.movies.length === 7 && app.tv.length === 4, 'the app\'s layout was read');
    for (const filter of mod.DISCOVER_FILTERS) assert.deepEqual(mod.DISCOVER_LAYOUT[filter], app[filter], filter);
    assert.deepEqual(mod.NETWORK_LIST_FOR, { all: 'all', movies: 'films', tv: 'series' });
    assert.match(source, /const NETWORK_LIST: Record<HomeFilter, SourceList> = \{ all: 'all', movies: 'films', tv: 'series' \};/);
  });
});

describe('TV Discover data layer: the budget file', () => {
  const NETWORKS = [1024, 213, 2552, 2739, 3186, 3353, 4330, 453].map((id) => ({ id, name: `Service ${id}`, logoUrl: null, hasFilms: true }));
  const withoutMe = (calls) => calls.filter((call) => call !== 'GET /me');

  it('is written in the budget file: the app\'s Home without /me, 5 at once and 10 lazily on All, none on Back', () => {
    for (const [name, filter, home] of [['tv-discover', 'all', 'home-all'], ['tv-discover-movies', 'movies', 'home-movies'], ['tv-discover-tv', 'tv', 'home-tv']]) {
      const screen = BUDGET.screens[name];
      assert.deepEqual(screen.atOnce, withoutMe(BUDGET.screens[home].atOnce), name);
      assert.deepEqual(screen.belowTheFold, BUDGET.screens[home].belowTheFold, name);
      assert.equal(screen.calls, screen.atOnce.length + screen.belowTheFold.length, name);
      const planned = mod.plannedCalls(filter, NETWORKS);
      assert.deepEqual(planned.atOnce, screen.atOnce, `${name} planned at once`);
      assert.deepEqual(planned.belowTheFold, screen.belowTheFold, `${name} planned lazily`);
    }
    assert.equal(BUDGET.screens['tv-discover'].atOnce.length, 5);
    assert.equal(BUDGET.screens['tv-discover'].belowTheFold.length, 10);
    assert.equal(BUDGET.screens['tv-discover'].calls, 15);
    assert.deepEqual(BUDGET.screens['tv-discover'].back, []);
    assert.deepEqual(mod.plannedCalls('all', NETWORKS).back, []);
    assert.deepEqual(BUDGET.screens['tv-discover-network'].atOnce, withoutMe(BUDGET.screens.network.atOnce));
    assert.deepEqual(BUDGET.screens['tv-discover-studio'].atOnce, withoutMe(BUDGET.screens.studio.atOnce));
    // A service without films has its series row only, even under Movies it has none.
    const noFilms = [{ id: 1, name: 'A', logoUrl: null, hasFilms: false }, { id: 2, name: 'B', logoUrl: null, hasFilms: true }];
    assert.deepEqual(mod.plannedCalls('movies', noFilms).belowTheFold, ['GET /discover/network/2/films']);
    assert.deepEqual(mod.plannedCalls('all', noFilms).belowTheFold, ['GET /discover/network/1', 'GET /discover/network/2/all', 'GET /discover/upcoming', 'GET /discover/upcoming-tv']);
  });

  it('is what the data layer does: opening All asks 5, the lazy rows 10 more, Back and a chip back to All none', async (t) => {
    const app = await startApp(t, world());
    const calls = [];
    const watch = new mod.SessionWatch(webScope(), ORIGIN);
    const fetcher = async (url, init) => {
      const target = new URL(url);
      calls.push(`GET ${target.pathname.slice('/jellypass/app/v1'.length)}${target.search}`);
      const answer = await app.get(`${target.pathname}${target.search}`, { host: HOST_A, user: null, headers: init.headers });
      return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } });
    };
    const data = new mod.DiscoverData(fetcher, ORIGIN, watch, () => 1, () => 1);
    const rows = (filter) => mod.DISCOVER_LAYOUT[filter].filter((part) => part.part === 'row');
    const open = async (filter, eager) => {
      const asked = [];
      for (const part of rows(filter).filter((row) => row.eager === eager)) asked.push(await data.get({ kind: 'list', list: part.list }));
      return asked;
    };
    const sources = await data.get({ kind: 'sources' });
    assert.ok(sources.ok);
    await open('all', true);
    assert.deepEqual([...calls].sort(), BUDGET.screens['tv-discover'].atOnce);
    const atOnce = calls.length;
    await open('all', false);
    for (const network of mod.networksFor('all', sources.value.networks)) await data.get({ kind: 'network', id: network.id, list: mod.networkListFor('all', network) });
    assert.deepEqual([...calls.slice(atOnce)].sort(), BUDGET.screens['tv-discover'].belowTheFold);
    assert.equal(calls.length, BUDGET.screens['tv-discover'].calls);
    // Back from a title, or from another chip to All: every row is drawn from what is kept.
    const before = calls.length;
    await open('all', true);
    await open('all', false);
    await data.get({ kind: 'sources' });
    assert.equal(calls.length - before, BUDGET.screens['tv-discover'].back.length);
    // The Movies chip asks for its own lists; the three it shares with All are kept.
    await open('movies', true);
    assert.deepEqual(calls.slice(before), ['GET /discover/trending-movies']);
  });
});

describe('TV Discover data layer: the answer cache', () => {
  it('asks once per address: a kept answer, Back and a second asker at once cost no call', async () => {
    const { data, api } = discover();
    const first = await data.get({ kind: 'list', list: 'trending' });
    assert.ok(first.ok);
    assert.deepEqual(data.peek({ kind: 'list', list: 'trending' }), first);
    const again = await data.get({ kind: 'list', list: 'trending' });
    assert.equal(again.value, first.value, 'the kept answer is given back as it is');
    const [left, right] = await Promise.all([data.get({ kind: 'list', list: 'popular-tv' }), data.get({ kind: 'list', list: 'popular-tv' })]);
    assert.ok(left.ok && right.ok);
    assert.deepEqual(api.paths(), ['/discover/trending', '/discover/popular-tv']);
    assert.equal(data.peek({ kind: 'list', list: 'upcoming' }), undefined, 'nothing is kept for what was not asked');
  });

  it('shares the first page between a Home row and a service\'s page, and keeps each further page apart', async () => {
    const { data, api } = discover();
    await data.get({ kind: 'network', id: 213, list: 'all' });
    await data.get({ kind: 'network', id: 213, list: 'all', page: 1 });
    await data.get({ kind: 'network', id: 213, list: 'all', page: 2 });
    await data.get({ kind: 'network', id: 213, list: 'films' });
    await data.get({ kind: 'network', id: 213, list: 'series' });
    await data.get({ kind: 'studio', id: 7 });
    await data.get({ kind: 'studio', id: 7, page: 2 });
    assert.deepEqual(api.paths(), ['/discover/network/213/all', '/discover/network/213/all?page=2', '/discover/network/213/films', '/discover/network/213', '/discover/studio/7', '/discover/studio/7?page=2']);
    assert.equal(mod.discoverKey({ kind: 'list', list: 'trending', page: 1 }), mod.discoverKey({ kind: 'list', list: 'trending' }));
  });

  it('uses an answer for ten minutes on both clocks: a sleep or a clock set back ends it', async () => {
    const { data, api, advance, clock } = discover();
    const request = { kind: 'list', list: 'trending' };
    await data.get(request);
    advance(mod.DISCOVER_CACHE_TTL_MS - 1);
    await data.get(request);
    assert.equal(api.calls.length, 1);
    advance(1);
    assert.equal(data.peek(request), undefined, 'a peek does not use an expired answer');
    await data.get(request);
    assert.equal(api.calls.length, 2);
    // A wall clock that jumped (a sleep) ends it although the monotonic one has not moved far.
    clock.wall += mod.DISCOVER_CACHE_TTL_MS;
    await data.get(request);
    assert.equal(api.calls.length, 3);
    // A wall clock set back ends it too.
    clock.wall -= 60_000;
    await data.get(request);
    assert.equal(api.calls.length, 4);
  });

  it('keeps at most 60 addresses, the least recently used going first', async () => {
    const { data, api } = discover();
    for (let id = 1; id <= mod.DISCOVER_CACHE_SIZE; id += 1) await data.get({ kind: 'studio', id });
    await data.get({ kind: 'studio', id: 1 });
    await data.get({ kind: 'studio', id: 61 });
    assert.equal(api.calls.length, 61);
    assert.ok(data.peek({ kind: 'studio', id: 1 }), 'the one used again stays');
    assert.equal(data.peek({ kind: 'studio', id: 2 }), undefined, 'the least recently used went');
    assert.ok(data.peek({ kind: 'studio', id: 61 }));
  });

  it('remembers a failure for 30 seconds so a page drawn again does not ask again, and asks again for a "Try again"', async () => {
    let status = 502;
    const { data, api, advance } = discover(() => (status === 200 ? json(page([card(1)])) : json({}, status)));
    const request = { kind: 'list', list: 'trending' };
    assert.deepEqual(await data.get(request), { ok: false, status: 502 });
    assert.deepEqual(await data.get(request), { ok: false, status: 502 });
    assert.equal(api.calls.length, 1, 'never retried by itself');
    advance(mod.DISCOVER_FAILURE_MS - 1);
    await data.get(request);
    assert.equal(api.calls.length, 1);
    status = 200;
    const retried = await data.get(request, { retry: true });
    assert.ok(retried.ok);
    assert.equal(api.calls.length, 2);
    assert.ok((await data.get(request)).ok, 'the answer replaces the failure');
    assert.equal(api.calls.length, 2);
    status = 502;
    const other = { kind: 'list', list: 'popular-tv' };
    await data.get(other);
    advance(mod.DISCOVER_FAILURE_MS);
    status = 200;
    assert.ok((await data.get(other)).ok, 'after 30 seconds it is asked for again');
    assert.equal(api.calls.length, 4);
  });

  it('does not keep what it never sent (a 400 of the reader\'s own)', async () => {
    const { data, api } = discover();
    assert.equal((await data.get({ kind: 'studio', id: 0 })).status, 400);
    assert.equal((await data.get({ kind: 'list', list: 'top-movies' })).status, 400);
    assert.equal(api.calls.length, 0);
    assert.equal(data.peek({ kind: 'studio', id: 0 }), undefined);
  });
});

describe('TV Discover data layer: invalid requests', () => {
  const invalid = [
    ['page 0', { kind: 'list', list: 'trending', page: 0 }],
    ['a negative page', { kind: 'list', list: 'trending', page: -1 }],
    ['a page that is NaN', { kind: 'list', list: 'trending', page: Number.NaN }],
    ['a page past the limit', { kind: 'list', list: 'trending', page: 501 }],
    ['a list the API does not have', { kind: 'list', list: 'top-movies' }],
    ['a network id of 0', { kind: 'network', id: 0, list: 'all' }],
    ['a network list that does not exist', { kind: 'network', id: 213, list: 'movies' }],
    ['a studio page of 1.5', { kind: 'studio', id: 5, page: 1.5 }],
    ['a studio id that is NaN', { kind: 'studio', id: Number.NaN }],
  ];

  it('answers an invalid page 400 even after page one is cached: the two never share an entry', async () => {
    const { data, api } = discover();
    assert.ok((await data.get({ kind: 'list', list: 'trending' })).ok);
    assert.ok((await data.get({ kind: 'studio', id: 5 })).ok);
    assert.ok((await data.get({ kind: 'network', id: 213, list: 'series' })).ok);
    assert.equal(api.calls.length, 3);
    for (const [name, request] of invalid) {
      assert.deepEqual(await data.get(request), { ok: false, status: 400 }, name);
      assert.equal(data.peek(request), undefined, `${name}: nothing is shown for it`);
    }
    assert.deepEqual(await data.get({ kind: 'list', list: 'trending', page: 0 }, { retry: true }), { ok: false, status: 400 });
    assert.equal(api.calls.length, 3, 'no call was made, and the kept answers are still there');
    assert.ok(data.peek({ kind: 'list', list: 'trending' }));
  });

  it('does not let an invalid page join the call in flight for page one, nor page one join an invalid one', { timeout: 5_000 }, async () => {
    const pending = [];
    const { data, api } = discover((pathname) => new Promise((resolve) => { pending.push({ pathname, resolve }); }));
    const valid = data.get({ kind: 'list', list: 'trending' });
    const bad = data.get({ kind: 'list', list: 'trending', page: 0 });
    assert.deepEqual(await bad, { ok: false, status: 400 }, 'answered without waiting for the call');
    await until(() => pending.length === 1);
    pending[0].resolve(json(page([card(1)])));
    assert.ok((await valid).ok);
    assert.equal(api.calls.length, 1);
    // The other way round: the invalid one asked first.
    const first = data.get({ kind: 'list', list: 'upcoming', page: Number.NaN });
    const second = data.get({ kind: 'list', list: 'upcoming' });
    assert.deepEqual(await first, { ok: false, status: 400 });
    await until(() => pending.length === 2);
    pending[1].resolve(json(page([card(2)])));
    assert.ok((await second).ok);
    assert.equal(api.calls.length, 2);
  });

  it('answers an invalid request 400 without a session being asked about: no session is still a 401', async () => {
    const scope = webScope();
    scope.as(undefined);
    const { data, api } = discover(undefined, { scope });
    assert.equal((await data.get({ kind: 'list', list: 'trending', page: 0 })).status, 401);
    assert.equal(api.calls.length, 0);
  });
});

describe('TV Discover data layer: the session', () => {
  it('asks nothing without a signed-in member', async () => {
    const scope = webScope();
    scope.as(undefined);
    const { data, api } = discover(undefined, { scope });
    assert.deepEqual(await data.get({ kind: 'sources' }), { ok: false, status: 401 });
    assert.equal(data.peek({ kind: 'sources' }), undefined);
    assert.equal(api.calls.length, 0);
  });

  it('forgets everything on a sign-out, and asks again for the member who signs in next', async () => {
    const { data, api, scope } = discover();
    const request = { kind: 'list', list: 'trending' };
    await data.get(request);
    scope.as(undefined);
    assert.equal(data.peek(request), undefined);
    assert.equal((await data.get(request)).status, 401);
    scope.as({ userId: 'alice', token: 'token-alice' });
    assert.equal(data.peek(request), undefined, 'the same member signing in again starts with nothing');
    await data.get(request);
    assert.equal(api.calls.length, 2);
  });

  it('empties the cache when another member signs in, and when the same member has a new token', async () => {
    const { data, api, scope } = discover();
    const request = { kind: 'list', list: 'trending' };
    await data.get(request);
    scope.as({ userId: 'ann', token: 'token-ann' });
    assert.equal(data.peek(request), undefined, 'another member sees nothing of the first\'s answers');
    await data.get(request);
    assert.deepEqual(api.calls.map((call) => call.authorization), ['MediaBrowser Token="token-alice"', 'MediaBrowser Token="token-ann"']);
    scope.as({ userId: 'ann', token: 'token-ann-2' });
    assert.equal(data.peek(request), undefined);
    await data.get(request);
    assert.equal(api.calls[2].authorization, 'MediaBrowser Token="token-ann-2"');
    // A token that changes and changes back is still a new session.
    scope.as({ userId: 'ann', token: 'token-ann' });
    assert.equal(data.peek(request), undefined);
  });

  it('drops an answer that comes back after a sign-out: not stored, not shown, and the next session asks for itself', async () => {
    const pending = [];
    const { data, api, scope } = discover((pathname) => new Promise((resolve) => { pending.push({ pathname, resolve }); }));
    const request = { kind: 'list', list: 'trending' };
    const late = data.get(request);
    await until(() => pending.length === 1);
    scope.as(undefined);
    scope.as({ userId: 'ann', token: 'token-ann' });
    pending[0].resolve(json(page([card(1)])));
    assert.deepEqual(await late, { ok: false, stale: true });
    assert.equal(data.peek(request), undefined, 'the old session\'s answer was not kept');
    const next = data.get(request);
    await until(() => pending.length === 2);
    assert.equal(api.calls[1].authorization, 'MediaBrowser Token="token-ann"', 'the call in flight for the old session is not joined');
    pending[1].resolve(json(page([card(2)])));
    const answer = await next;
    assert.ok(answer.ok);
    assert.equal(answer.value.cards[0].tmdbId, 2);
  });

  it('does not act on an old session\'s 401 or 429: the new session\'s cache and calls are untouched', async () => {
    const pending = [];
    const { data, api, scope } = discover((pathname) => new Promise((resolve) => { pending.push({ pathname, resolve }); }));
    const slow = data.get({ kind: 'list', list: 'trending' });
    const limited = data.get({ kind: 'list', list: 'popular-tv' });
    await until(() => pending.length === 2);
    scope.as({ userId: 'ann', token: 'token-ann' });
    const mine = data.get({ kind: 'sources' });
    await until(() => pending.length === 3);
    pending[2].resolve(json({ networks: [], studios: [] }));
    assert.ok((await mine).ok);
    pending[0].resolve(json({}, 401));
    pending[1].resolve(json({}, 429, { 'retry-after': '120' }));
    assert.deepEqual([await slow, await limited], [{ ok: false, stale: true }, { ok: false, stale: true }]);
    assert.ok(data.peek({ kind: 'sources' }), 'a late 401 did not empty the new session\'s cache');
    const next = data.get({ kind: 'list', list: 'trending' });
    await until(() => pending.length === 4);
    assert.equal(api.calls.length, 4, 'a late 429 did not stop the new session\'s calls');
    pending[3].resolve(json(page([card(1)])));
    assert.ok((await next).ok);
  });

  it('keeps the new session\'s answer when the old session\'s call for the same key is still in flight: two calls, the old answer dropped', async () => {
    const pending = [];
    const { data, api, scope } = discover((pathname) => new Promise((resolve) => { pending.push({ pathname, resolve }); }));
    const request = { kind: 'list', list: 'trending' };
    const old = data.get(request);
    await until(() => pending.length === 1);
    scope.as({ userId: 'ann', token: 'token-ann' });
    const current = data.get(request);
    await until(() => pending.length === 2);
    assert.deepEqual(api.calls.map((call) => call.authorization), ['MediaBrowser Token="token-alice"', 'MediaBrowser Token="token-ann"']);
    pending[1].resolve(json(page([card(2)])));
    const answer = await current;
    assert.ok(answer.ok);
    assert.equal(answer.value.cards[0].tmdbId, 2);
    pending[0].resolve(json(page([card(1)])));
    assert.deepEqual(await old, { ok: false, stale: true });
    const kept = data.peek(request);
    assert.ok(kept && kept.ok);
    assert.equal(kept.value.cards[0].tmdbId, 2, 'the old answer did not replace the new one');
    assert.ok((await data.get(request)).ok);
    assert.equal(api.calls.length, 2, 'nothing further was asked');
  });

  it('keeps nothing of the old session when its call ends after the new one\'s, either', async () => {
    const pending = [];
    const { data, scope } = discover((pathname) => new Promise((resolve) => { pending.push({ pathname, resolve }); }));
    const request = { kind: 'sources' };
    const old = data.get(request);
    await until(() => pending.length === 1);
    scope.as({ userId: 'ann', token: 'token-ann' });
    pending[0].resolve(json({ networks: [{ id: 1, name: 'Old', logoUrl: null }], studios: [] }));
    assert.deepEqual(await old, { ok: false, stale: true });
    assert.equal(data.peek(request), undefined);
    const current = data.get(request);
    await until(() => pending.length === 2);
    pending[1].resolve(json({ networks: [{ id: 2, name: 'New', logoUrl: null }], studios: [] }));
    const answer = await current;
    assert.ok(answer.ok);
    assert.equal(answer.value.networks[0].name, 'New');
  });

  it('empties the cache on a 401 of the current session, and keeps nothing of it', async () => {
    let refused = false;
    const { data, api } = discover(() => (refused ? json({}, 401) : json(page([card(1)]))));
    await data.get({ kind: 'list', list: 'trending' });
    refused = true;
    assert.equal((await data.get({ kind: 'list', list: 'popular-tv' })).status, 401);
    assert.equal(data.peek({ kind: 'list', list: 'trending' }), undefined);
    assert.equal(data.peek({ kind: 'list', list: 'popular-tv' }), undefined, 'a 401 is not remembered as the answer');
    refused = false;
    assert.ok((await data.get({ kind: 'list', list: 'popular-tv' })).ok);
    assert.equal(api.calls.length, 3);
  });
});

describe('TV Discover data layer: a 429', () => {
  it('stops every call until its Retry-After is over, never retries by itself, and a retry does not get around it', async () => {
    let limited = true;
    const { data, api, advance } = discover((pathname) => (limited ? json({}, 429, { 'retry-after': '7' }) : pathname === '/discover/sources' ? json({ networks: [], studios: [] }) : json(page([card(1)]))));
    const first = await data.get({ kind: 'list', list: 'trending' });
    assert.deepEqual(first, { ok: false, status: 429, retryAfterMs: 7000 });
    advance(2_000);
    // Any address, a retry included: the same 429 with the time left, and no call.
    assert.deepEqual(await data.get({ kind: 'list', list: 'popular-tv' }), { ok: false, status: 429, retryAfterMs: 5000 });
    assert.deepEqual(await data.get({ kind: 'list', list: 'trending' }, { retry: true }), { ok: false, status: 429, retryAfterMs: 5000 });
    assert.deepEqual(await data.get({ kind: 'sources' }), { ok: false, status: 429, retryAfterMs: 5000 });
    assert.equal(api.calls.length, 1);
    advance(4_999);
    assert.equal((await data.get({ kind: 'sources' })).status, 429);
    assert.equal(api.calls.length, 1, 'one millisecond short of the wait: still no call');
    advance(1);
    limited = false;
    assert.ok((await data.get({ kind: 'sources' }, { retry: true })).ok);
    assert.ok((await data.get({ kind: 'list', list: 'trending' }, { retry: true })).ok);
    assert.equal(api.calls.length, 3);
  });

  it('does not report a stale wait: a 7 s Retry-After is over after 8 s, and the endpoint that works again is called', async () => {
    let limited = true;
    const { data, api, advance } = discover(() => (limited ? json({}, 429, { 'retry-after': '7' }) : json(page([card(1)]))));
    const request = { kind: 'list', list: 'trending' };
    assert.deepEqual(await data.get(request), { ok: false, status: 429, retryAfterMs: 7000 });
    advance(8_000);
    limited = false;
    assert.equal(data.peek(request), undefined, 'the 429 is not kept as the answer past its deadline');
    const answer = await data.get(request);
    assert.ok(answer.ok);
    assert.equal(api.calls.length, 2);
  });

  it('reports the wait that remains for an address that was itself answered 429, never the one first said', async () => {
    const { data, api, advance } = discover(() => json({}, 429, { 'retry-after': '7' }));
    const request = { kind: 'list', list: 'trending' };
    await data.get(request);
    advance(3_000);
    assert.deepEqual(await data.get(request), { ok: false, status: 429, retryAfterMs: 4000 });
    assert.equal(api.calls.length, 1);
  });

  it('does not let a remembered 429 outlast a later, shorter block, nor a failure memo outlast its own 30 seconds', async () => {
    let mode = '429';
    const { data, api, advance } = discover((pathname) => (mode === '429' ? json({}, 429, { 'retry-after': '5' }) : mode === '500' ? json({}, 500) : json(page([card(1)]))));
    await data.get({ kind: 'list', list: 'trending' });
    advance(5_000);
    mode = '500';
    assert.equal((await data.get({ kind: 'list', list: 'popular-tv' })).status, 500);
    advance(10_000);
    assert.equal((await data.get({ kind: 'list', list: 'popular-tv' })).status, 500, 'a 500 is remembered, within its 30 seconds');
    assert.equal(api.calls.length, 2);
    mode = 'ok';
    assert.ok((await data.get({ kind: 'list', list: 'trending' })).ok, 'the 429\'d address is asked again once the block is over');
    advance(20_000);
    assert.ok((await data.get({ kind: 'list', list: 'popular-tv' })).ok, 'the 500 memo is over');
    assert.equal(api.calls.length, 4);
  });

  it('waits 30 seconds when the 429 did not say, and keeps the wait across a sign-in', async () => {
    const { data, api, advance, scope } = discover(() => json({}, 429));
    assert.deepEqual(await data.get({ kind: 'sources' }), { ok: false, status: 429 });
    advance(10_000);
    scope.as({ userId: 'ann', token: 'token-ann' });
    assert.deepEqual(await data.get({ kind: 'sources' }), { ok: false, status: 429, retryAfterMs: mod.DISCOVER_BACKOFF_MS - 10_000 });
    assert.equal(api.calls.length, 1);
    assert.equal(mod.DISCOVER_BACKOFF_MS, 30_000);
  });

  it('does not let a 429 for one in flight cancel the others\': they were already asked', async () => {
    const pending = [];
    const { data } = discover((pathname) => new Promise((resolve) => { pending.push({ pathname, resolve }); }));
    const one = data.get({ kind: 'list', list: 'trending' });
    const two = data.get({ kind: 'list', list: 'popular-tv' });
    await until(() => pending.length === 2);
    pending[0].resolve(json({}, 429, { 'retry-after': '3' }));
    pending[1].resolve(json(page([card(1)])));
    assert.equal((await one).status, 429);
    assert.ok((await two).ok, 'its answer is kept');
    assert.ok(data.peek({ kind: 'list', list: 'popular-tv' }));
  });
});

describe('TV Discover data layer: other households', () => {
  it('answers Alice the same, with the same calls, whatever another household holds or has requested', async (t) => {
    const quiet = await startApp(t, world());
    const sent = await quiet.get('/jellypass/app/v1/discover/trending', { user: ALICE });
    assert.equal(sent.status, 200);
    // One movie and one series from what Trending lists, each as its own media type, held by the other household.
    const listed = (await sent.json()).results;
    const picked = [listed.find((entry) => entry.mediaType === 'movie'), listed.find((entry) => entry.mediaType === 'tv')];
    assert.ok(picked.every(Boolean), 'the fixture lists a movie and a series');
    const busy = await startApp(t, world({
      media: Object.fromEntries(picked.map((entry, index) => [entry.tmdbId, { id: 7390000 + index, mediaType: entry.mediaType, tmdbId: entry.tmdbId, status: 5 }])),
      requests: {
        21: picked.map((entry, index) => ({
          id: 9100 + index, status: 2, type: entry.mediaType, is4k: false, createdAt: new Date().toISOString(), seasons: [],
          media: { id: 7390000 + index, mediaType: entry.mediaType, tmdbId: entry.tmdbId, status: 5 },
          requestedBy: { id: 21, jellyfinUserId: BOB },
        })),
      },
    }));
    const through = (app) => {
      const calls = [];
      const fetcher = async (url, init) => {
        const target = new URL(url);
        calls.push(`${target.pathname}${target.search}`);
        const answer = await app.get(`${target.pathname}${target.search}`, { host: HOST_A, user: null, headers: init.headers });
        return new Response(answer.body, { status: answer.status, headers: { 'content-type': 'application/json' } });
      };
      const watch = new mod.SessionWatch(webScope(), ORIGIN);
      const data = new mod.DiscoverData(fetcher, ORIGIN, watch, () => 1_000, () => 1_700_000_000_000);
      return { data, calls };
    };
    const asks = [
      { kind: 'list', list: 'trending' }, { kind: 'list', list: 'upcoming', page: 2 }, { kind: 'sources' },
      { kind: 'network', id: 213, list: 'all' }, { kind: 'studio', id: 41077 }, { kind: 'list', list: 'trending' },
    ];
    const run = async (app) => {
      const { data, calls } = through(app);
      const answers = [];
      for (const request of asks) answers.push(JSON.stringify(await data.get(request)));
      return { answers, calls };
    };
    const one = await run(quiet);
    const two = await run(busy);
    assert.deepEqual(two.calls, one.calls);
    assert.equal(one.calls.length, 5, 'the repeated address was kept');
    // Every ask was answered with a page (a failure that came out the same both times would prove nothing).
    for (const run of [one, two]) run.answers.forEach((answer, index) => assert.equal(JSON.parse(answer).ok, true, `answer ${index} succeeded`));
    two.answers.forEach((answer, index) => assert.ok(answer === one.answers[index], `answer ${index} is the same whatever another household holds`));
  });
});

async function until(check) {
  for (let turn = 0; turn < 200 && !check(); turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(check(), 'the awaited state was reached');
}


it('does not cache a 403: app access restored is visible on the next call without waiting', async () => {
  let disabled = true;
  const { data, api } = discover(() => disabled ? json({ error: 'app_access_disabled' }, 403) : json(page([card(1)])));
  const request = { kind: 'list', list: 'trending' };
  assert.equal((await data.get(request)).status, 403);
  assert.equal(data.peek(request), undefined);
  disabled = false;
  assert.equal((await data.get(request)).ok, true);
  assert.equal(api.calls.length, 2);
});
