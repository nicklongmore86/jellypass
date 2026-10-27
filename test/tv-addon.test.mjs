// The TV add-on (docs/tv-addon.md): its build (one ES2017 classic script and a stylesheet for the TVs' Chromium 63), how
// the household gateway adds it to Jellyfin web's page (only on the households it is on for, never on the admin host,
// never on anything but that page, once), how it serves its files, and the row itself, run from the built bundle in a
// simulated Jellyfin web (linkedom) against the real app API, and the title view with "Get this" it opens. Real-TV
// checks are listed in docs/tv-addon.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { parseHTML } from 'linkedom';
import { TvAssets } from '../dist/tv-assets.js';
import { buildTv } from '../scripts/build-tv.mjs';
import { ALICE, ANN, HOST_A, HOST_B, ITEMS, OWN_MOVIE, T_MOVIE, T_TV, TOKENS, get, otherHouseholdWorlds, startApp, world } from './support/household-app.mjs';
import { JELLYFIN_WEB_PAGE } from './support/household-app.mjs';
import { assertNoCanaries } from './support/seerr-fixtures.mjs';
import { makeTempDir } from './support/temp-dir.mjs';

const DIST_TV = path.join(import.meta.dirname, '..', 'dist', 'tv');
const BUDGET = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'docs', 'app-api', 'fetch-budget.json'), 'utf8'));
const FILES = readdirSync(DIST_TV).sort();
const SCRIPT = FILES.find((name) => name.endsWith('.js'));
const STYLESHEET = FILES.find((name) => name.endsWith('.css'));
const SCRIPT_PATH = `/jellypass/tv/${SCRIPT}`;
const TAG = `<script defer src="${SCRIPT_PATH}" data-jellypass-tv></script>`;
const NEVER_STORE = { 'cache-control': 'no-store', 'cdn-cache-control': 'no-store', 'cloudflare-cdn-cache-control': 'no-store' };
const ADMIN_HOST = 'jellypass.example.test';
/** Regexp checks that report the pattern, never the (large) text: a failing assert.match prints its whole input. */
const lacks = (text, pattern, message) => assert.ok(!pattern.test(text), message ?? `expected not to match ${pattern}`);
const count = (text, part) => text.split(part).length - 1;
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
/** A world whose Jellyfin serves Jellyfin web's page (see createFakeJellyfinForApp). */
const webWorld = (options) => Object.assign(world(options), { webPage: {} });
const tvOn = (households = ['farmhouse']) => ({ tvAddon: { households } });
/** What Jellyfin was asked for under /web or /jellypass/tv, as `METHOD path`. */
/**
 * linkedom keeps no focus: the element focus() was last called on, per document, stands in for `activeElement`, and
 * focus() fires `focusin` as a browser does (the title view listens for it).
 */
const FOCUSED = new WeakMap();
{
  const { HTMLElement, Event } = parseHTML('<html><body></body></html>');
  HTMLElement.prototype.focus = function focus() {
    FOCUSED.set(this.ownerDocument, this);
    this.dispatchEvent(new Event('focusin', { bubbles: true }));
  };
}
const webCalls = (app) => app.jellyfin.requests.filter((request) => /^\/(?:emby\/)?(?:web|jellypass\/tv)\b/i.test(request.pathname)).map((request) => `${request.method} ${request.path}`);

describe('TV add-on: the build', () => {
  it('is one script and one stylesheet, each named for a hash of its content, and the script names the stylesheet', () => {
    assert.equal(FILES.length, 2);
    for (const name of FILES) {
      const hash = createHash('sha256').update(readFileSync(path.join(DIST_TV, name))).digest('hex').slice(0, 12);
      assert.match(name, new RegExp(`^jellypass-tv\\.${hash}\\.(?:js|css)$`));
    }
    assert.equal(count(readFileSync(path.join(DIST_TV, SCRIPT), 'utf8'), JSON.stringify(STYLESHEET)), 1);
    assert.deepEqual(TvAssets.load(DIST_TV).paths().sort(), FILES.map((name) => `/jellypass/tv/${name}`));
  });

  it('parses as an ES2017 classic script, so Chromium 63 runs it: no modules, no `?.`, `??`, optional catch binding or object spread', () => {
    const source = readFileSync(path.join(DIST_TV, SCRIPT), 'utf8');
    assert.doesNotThrow(() => parse(source, { ecmaVersion: 2017, sourceType: 'script' }));
    // The gate itself refuses what Chromium 63 cannot parse.
    for (const later of ['a?.b', 'a ?? b', 'try {} catch {}', 'x = {...y}', 'import x from "y"', 'class A { #p = 1 }']) {
      assert.throws(() => parse(later, { ecmaVersion: 2017, sourceType: 'script' }), SyntaxError, later);
    }
  });

  it('calls no browser API that Chromium 63 lacks, and polyfills none', () => {
    const source = readFileSync(path.join(DIST_TV, SCRIPT), 'utf8');
    for (const api of [/\breplaceChildren\b/, /\bAbortController\b/, /\bResizeObserver\b/, /\bfromEntries\b/, /\.flatMap\(/, /\.flat\(/, /\bqueueMicrotask\b/, /\bstructuredClone\b/, /\brandomUUID\b/, /\.replaceAll\(/, /\.matchAll\(/, /\ballSettled\b/, /\bglobalThis\b/, /\.finally\(/, /\.at\(/, /\btoSorted\b/, /\bscrollTo\(\{/, /preventScroll/]) {
      lacks(source, api, `the bundle uses ${api}`);
    }
    // Nothing is logged, and nothing is kept in storage.
    lacks(source, /\bconsole\./);
    lacks(source, /\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/);
    lacks(source, /\binnerHTML\b|\binsertAdjacentHTML\b|\bouterHTML\b/);
  });

  it('styles only with what Chromium 63 draws: no gap, :focus-visible, aspect-ratio, inset, logical properties, :has() or min()/max()/clamp()', () => {
    const css = readFileSync(path.join(DIST_TV, STYLESHEET), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const banned of [/(?:^|[\s;{])(?:row-|column-)?gap\s*:/, /:focus-visible/, /aspect-ratio/, /(?:^|[\s;{])inset\s*:/, /-(?:inline|block)(?:-start|-end)?\s*:/, /:has\(/, /\b(?:min|max|clamp)\(/, /url\(|@import/]) {
      lacks(css, banned, `the stylesheet uses ${banned}`);
    }
    // Focus is drawn with :focus, which a remote's focus always is.
    assert.ok(css.includes('.jellypass-tv-card:focus'));
  });

  it('builds the same files from the same source', async (t) => {
    const outDir = await makeTempDir(t, 'jfa-tv-build-');
    const built = await buildTv({ outDir });
    assert.deepEqual([built.script, built.stylesheet].sort(), FILES);
  });
});

describe('TV add-on: the gateway', { timeout: 30_000 }, () => {
  it('changes nothing while it is off: Jellyfin web\'s page and /jellypass/tv are relayed to Jellyfin as before', async (t) => {
    const app = await startApp(t, webWorld());
    const page = await app.get('/web/index.html', { user: null, headers: { 'Accept-Encoding': 'identity' } });
    assert.equal(page.status, 200);
    assert.equal(page.text, JELLYFIN_WEB_PAGE);
    assert.equal(page.headers.etag, '"jellyfin-web-etag"');
    assert.equal(page.headers['cache-control'], 'no-cache');
    const conditional = await app.get('/web/', { user: null, headers: { 'If-None-Match': '"jellyfin-web-etag"' } });
    assert.equal(conditional.status, 304);
    const tv = await app.get(SCRIPT_PATH, { user: null });
    assert.deepEqual([tv.status, tv.text], [401, '{}'], 'answered by Jellyfin (which asks this fake\'s unknown paths for a token)');
    assert.deepEqual(webCalls(app), ['GET /web/index.html', 'GET /web/', `GET ${SCRIPT_PATH}`]);
  });

  it('changes nothing on a household it is not on for, nor on the admin host', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const mill = await app.get('/web/index.html', { host: HOST_B, user: null, headers: { 'Accept-Encoding': 'identity' } });
    assert.deepEqual([mill.status, mill.text, mill.headers.etag], [200, JELLYFIN_WEB_PAGE, '"jellyfin-web-etag"']);
    assert.deepEqual([(await app.get(SCRIPT_PATH, { host: HOST_B, user: null })).text], ['{}']);
    // The admin host never relays anything to Jellyfin, and never serves the add-on.
    for (const pathname of ['/web/index.html', '/web/', SCRIPT_PATH]) {
      const admin = await app.get(pathname, { host: ADMIN_HOST, user: null });
      assert.equal(admin.status, 401, pathname);
      lacks(admin.text, /jellypass-tv/);
    }
    assert.deepEqual(webCalls(app), ['GET /web/index.html', `GET ${SCRIPT_PATH}`]);
  });

  it('adds exactly one script tag, before </head>, to Jellyfin web\'s page in every spelling Jellyfin serves it at', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const expected = JELLYFIN_WEB_PAGE.replace('</head>', `${TAG}</head>`);
    for (const pathname of ['/web/index.html', '/web/', '/web', '/web/index.html?v=1', '/WEB/Index.HTML', '/web/%69ndex.html', '/emby/web/']) {
      const page = await app.get(pathname, { user: null });
      assert.equal(page.status, 200, pathname);
      assert.equal(page.text, expected, pathname);
      assert.equal(Number(page.headers['content-length']), Buffer.byteLength(expected), pathname);
      assert.equal(page.headers['content-type'], 'text/html; charset=utf-8', pathname);
    }
    // Signed in or not, the page is the same: nothing user-specific is added.
    assert.equal((await app.get('/web/index.html', { user: ALICE })).text, expected);
    // An ambiguous spelling of the page is refused, as any is, rather than relayed without the add-on.
    const ambiguous = await app.get('/web/index%252Ehtml', { user: null });
    assert.equal(ambiguous.status, 400);
  });

  it('asks Jellyfin for the whole, unencoded page and never relays a 304, range or encoding that would skip the tag', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await app.get('/web/index.html', {
      user: null,
      headers: { 'Accept-Encoding': 'gzip, deflate, br', 'If-None-Match': '"jellyfin-web-etag"', 'If-Modified-Since': 'Tue, 21 Oct 2025 10:00:00 GMT', Range: 'bytes=0-9', 'If-Range': '"jellyfin-web-etag"' },
    });
    assert.equal(page.status, 200);
    assert.equal(count(page.text, TAG), 1);
    assert.equal(page.headers['content-encoding'], undefined);
    const sent = app.jellyfin.requests.at(-1).headers;
    assert.equal(sent['accept-encoding'], 'identity');
    for (const name of ['if-none-match', 'if-modified-since', 'range', 'if-range']) assert.equal(sent[name], undefined, name);
  });

  it('sends the page no-store, without Jellyfin\'s validators, and with Jellyfin\'s other headers (its CSP among them) as Jellyfin sent them', async (t) => {
    const state = webWorld();
    state.webPage = { headers: { 'Content-Security-Policy': "default-src 'self'; img-src *", 'X-Frame-Options': 'SAMEORIGIN', 'X-Jellyfin-Test': 'kept', Vary: 'Accept-Encoding', Expires: 'Tue, 21 Oct 2025 10:00:00 GMT' } };
    const app = await startApp(t, state, tvOn());
    const page = await app.get('/web/index.html', { user: null });
    assert.equal(count(page.text, TAG), 1);
    for (const [name, value] of Object.entries(NEVER_STORE)) assert.equal(page.headers[name], value, name);
    for (const name of ['etag', 'last-modified', 'accept-ranges', 'expires']) assert.equal(page.headers[name], undefined, name);
    assert.equal(page.headers['content-security-policy'], "default-src 'self'; img-src *");
    assert.equal(page.headers['x-frame-options'], 'SAMEORIGIN');
    assert.equal(page.headers['x-jellyfin-test'], 'kept');
    assert.equal(page.headers.vary, 'Accept-Encoding');
    assert.equal(page.rawHeaders.filter((name) => name.toLowerCase() === 'cache-control').length, 1);
  });

  it('answers HEAD with the GET\'s headers and no body', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const get_ = await app.get('/web/index.html', { user: null });
    const head = await get(app.port, '/web/index.html', { Host: HOST_A }, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], get_.headers['content-length']);
    assert.equal(head.headers['cache-control'], 'no-store');
    assert.equal(app.jellyfin.requests.at(-1).method, 'GET');
  });

  it('relays anything but a whole HTML page unchanged: another status, another type, an encoding Jellyfin insisted on, no </head>, too large', async (t) => {
    const cases = [
      [{ status: 500, body: 'oops</head>' }, 500],
      [{ status: 302, body: '', headers: { Location: '/web/' } }, 302],
      [{ type: 'application/json', body: '{"x":"</head>"}' }, 200],
      [{ body: '<html><body>no head</body></html>' }, 200],
      [{ body: `<html><head></head><body>${'x'.repeat(1024 * 1024)}</body></html>` }, 200],
    ];
    for (const [webPage, status] of cases) {
      const state = webWorld();
      state.webPage = webPage;
      const app = await startApp(t, state, tvOn());
      const page = await app.get('/web/index.html', { user: null });
      assert.equal(page.status, status);
      assert.equal(page.text, webPage.body);
      lacks(page.text, /data-jellypass-tv/);
      if (status === 200 && !webPage.type) assert.equal(page.headers.etag, '"jellyfin-web-etag"', 'with Jellyfin\'s own headers');
    }
    const state = webWorld();
    state.webPage = { gzipAlways: true };
    const app = await startApp(t, state, tvOn());
    const page = await app.get('/web/index.html', { user: null });
    assert.equal(page.headers['content-encoding'], 'gzip');
    assert.equal(page.headers.etag, '"jellyfin-web-etag"', 'relayed as Jellyfin sent it');
  });

  it('never adds a second tag, and leaves Jellyfin web\'s other files, HTML ones included, alone', async (t) => {
    const state = webWorld();
    state.webPage = { body: JELLYFIN_WEB_PAGE.replace('</head>', `${TAG}</head>`) };
    const app = await startApp(t, state, tvOn());
    const page = await app.get('/web/index.html', { user: null });
    assert.equal(count(page.text, 'data-jellypass-tv'), 1);
    assert.equal(page.text, state.webPage.body);
    for (const pathname of ['/web/main.jellyfin.bundle.js', '/web/other.html']) {
      const other = await app.get(pathname, { user: null });
      assert.equal(other.status, 200, pathname);
      lacks(other.text, /data-jellypass-tv/, pathname);
    }
  });

  it('serves its files fingerprinted, for good, at their exact paths only; any other /jellypass/tv path is a fixed 404 that never reaches Jellyfin', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    for (const name of FILES) {
      const file = await app.get(`/jellypass/tv/${name}`, { user: null });
      assert.equal(file.status, 200, name);
      assert.ok(file.body.equals(readFileSync(path.join(DIST_TV, name))), name);
      assert.equal(file.headers['cache-control'], 'public, max-age=31536000, immutable');
      assert.equal(file.headers['x-content-type-options'], 'nosniff');
      assert.equal(file.headers['content-type'], name.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8');
      const again = await app.get(`/jellypass/tv/${name}`, { user: null, headers: { 'If-None-Match': file.headers.etag } });
      assert.deepEqual([again.status, again.body.length], [304, 0]);
    }
    for (const pathname of ['/jellypass/tv/', '/jellypass/tv/jellypass-tv.000000000000.js', SCRIPT_PATH.toUpperCase(), '/jellypass/tv/main.js', '/emby/jellypass/tv/x']) {
      const answer = await app.get(pathname, { user: null });
      assert.deepEqual([answer.status, answer.text, answer.headers['cache-control']], [404, '{"error":"not_found"}', 'no-store'], pathname);
    }
    const posted = await app.post(SCRIPT_PATH, {}, { user: null });
    assert.equal(posted.status, 404);
    assert.deepEqual(webCalls(app), []);
  });

  it('is on for every household with `all`', async (t) => {
    const app = await startApp(t, webWorld(), tvOn('all'));
    for (const host of [HOST_A, HOST_B]) assert.equal(count((await app.get('/web/', { host, user: null })).text, TAG), 1, host);
  });
});

/**
 * Jellyfin web's page as the household host serves it, with the add-on's script run in it from the host (a linkedom
 * DOM, in its own VM context), signed in as `user`. Its network is the test server. `home()` lays out Home's sections
 * as Jellyfin web does; `clock` is the add-on's `Date.now`.
 */
async function openJellyfinWeb(t, app, { user = ALICE, host = HOST_A, serverAddress = `https://${host}`, override } = {}) {
  const served = await app.get('/web/index.html', { host, user: null });
  const { document, Event, CustomEvent, MutationObserver } = parseHTML(served.text);
  document.querySelector('.mainAnimatedPages').innerHTML = '<div id="indexPage" data-role="page" class="page homePage libraryPage"><div class="tabContent pageTabContent" id="homeTab" data-index="0"><div class="sections"></div></div></div>';
  const session = { user, serverAddress, token: user ? TOKENS[user] : null };
  const requests = [];
  const logged = [];
  const stored = [];
  let pending = 0;
  const clock = { now: 1_000_000 };
  const storage = new Proxy({}, { get: (_target, name) => (...args) => stored.push([name, ...args]) });
  const location = { href: `https://${host}/web/#/home.html`, origin: `https://${host}`, hash: '#/home.html' };
  const scope = {
    document,
    location,
    MutationObserver,
    setTimeout,
    clearTimeout,
    URL,
    Date: { now: () => clock.now },
    console: new Proxy({}, { get: () => (...args) => logged.push(args) }),
    localStorage: storage,
    sessionStorage: storage,
    ApiClient: {
      accessToken: () => session.token,
      serverAddress: () => session.serverAddress,
      getCurrentUserId: () => session.user,
    },
    async fetch(url, init = {}) {
      requests.push({ url, init });
      pending += 1;
      try {
        const target = new URL(url);
        // `override` may answer a call itself ({ status, body }), or throw for no network.
        const replaced = override ? await override(target.pathname, init) : undefined;
        if (replaced) return new Response(replaced.body, { status: replaced.status, headers: { 'content-type': 'application/json' } });
        const answer = await get(app.port, `${target.pathname}${target.search}`, { Host: target.host, ...init.headers }, { method: init.method ?? 'GET', body: init.body });
        return new Response(answer.body, { status: answer.status, headers: { 'content-type': answer.headers['content-type'] ?? 'application/json' } });
      } finally {
        pending -= 1;
      }
    },
  };
  scope.window = scope;
  const context = vm.createContext(scope);
  const source = (await app.get(document.querySelector('script[data-jellypass-tv]').getAttribute('src'), { host, user: null })).text;
  const run = () => vm.runInContext(source, context);
  run();
  const sections = document.querySelector('#homeTab .sections');
  const page = {
    document,
    Event,
    location,
    session,
    requests,
    logged,
    stored,
    clock,
    run,
    /** As `METHOD /path` under /jellypass/app/v1, a title's ID as `{tmdbId}`, sorted. */
    calls: (from = 0) => requests.slice(from).map((request) => `${request.init.method ?? 'GET'} ${new URL(request.url).pathname.replace('/jellypass/app/v1', '').replace(/^\/(movie|tv)\/[0-9]+/, '/$1/{tmdbId}')}`).sort(),
    /** Every call as made, for comparing two runs: address, method, body and headers. */
    trace: (from = 0) => requests.slice(from).map(({ url, init }) => JSON.stringify({ url, method: init.method ?? 'GET', body: init.body ?? null, credentials: init.credentials ?? null, headers: { ...init.headers } })),
    posts: () => requests.filter((request) => request.init.method === 'POST'),
    card: (tmdbId) => document.querySelector(`[data-jellypass-tv-row] button[data-tmdb-id="${tmdbId}"]`),
    view: () => document.querySelector('[data-jellypass-tv-title]'),
    focused: () => FOCUSED.get(document) ?? null,
    /** A key pressed on what has focus (or the page), as a remote sends it: `keyCode` only, as Chromium 63 has it. */
    key(keyCode) {
      const event = new Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'keyCode', { value: keyCode });
      (FOCUSED.get(document) ?? document.body).dispatchEvent(event);
      return event;
    },
    click: (element) => element.dispatchEvent(new Event('click')),
    /** Jellyfin web laying out Home's sections (its home tab does this on first show and on a settings change). */
    home() {
      sections.classList.add('homeSectionsContainer');
      sections.innerHTML = '<div class="verticalSection section0"><h2 class="sectionTitle">My Media</h2><button type="button" class="card">Movies</button></div><div class="verticalSection section1"></div><div class="verticalSection section2"></div>';
    },
    /** Jellyfin web showing Home again (its view manager's `viewshow`, which bubbles). */
    shown() {
      document.getElementById('indexPage').dispatchEvent(new CustomEvent('viewshow', { bubbles: true, detail: { params: {} } }));
    },
    rows: () => [...document.querySelectorAll('[data-jellypass-tv-row]')],
    cards: () => [...document.querySelectorAll('[data-jellypass-tv-row] button')],
    /** Every call answered and every page change seen (the add-on gathers changes for 50 ms). */
    async settled() {
      for (let round = 0; round < 3; round += 1) {
        do await pause(); while (pending > 0);
        await pause(80);
      }
    },
  };
  t.after(() => {
    // The token is never logged, stored or put in the page.
    for (const args of logged) lacks(JSON.stringify(args), new RegExp(Object.values(TOKENS).join('|')), 'logged the token');
    assert.deepEqual(stored, [], 'used storage');
    lacks(document.documentElement.outerHTML, new RegExp(Object.values(TOKENS).join('|')), 'the token is in the page');
  });
  return page;
}

describe('TV add-on: the Home row', { timeout: 60_000 }, () => {
  it('waits for Home, then adds one JellyPass row after Home\'s first section with the household\'s Trending, in one call', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await openJellyfinWeb(t, app);
    await page.settled();
    assert.deepEqual(page.requests, [], 'asked before Home was laid out');
    page.home();
    await page.settled();
    assert.deepEqual(page.calls(), BUDGET.screens['tv-home-row'].atOnce);
    assert.equal(page.requests.length, BUDGET.screens['tv-home-row'].calls);
    const [request] = page.requests;
    assert.equal(request.url, 'https://jelly-farmhouse.example.test/jellypass/app/v1/discover/trending');
    assert.equal(request.init.credentials, 'omit');
    assert.deepEqual({ ...request.init.headers }, { Accept: 'application/json', Authorization: `MediaBrowser Token="${TOKENS[ALICE]}"` });

    const rows = page.rows();
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.ok(row.previousElementSibling.classList.contains('section0'), 'after Home\'s first section');
    assert.ok(row.classList.contains('verticalSection'));
    assert.equal(row.querySelector('h2.sectionTitle').textContent, 'JellyPass: Trending');
    // The household's own view, exactly as the API answers it, worded as the app words its statuses.
    const answer = (await app.get('/jellypass/app/v1/discover/trending')).json();
    const labels = { in_library: 'Ready to watch', get_this: 'Available to get', requested: 'Requested', unavailable: "Can't request" };
    const shown = answer.results.slice(0, 20);
    assert.ok(shown.length > 0);
    assert.deepEqual(page.cards().map((card) => [card.querySelector('.jellypass-tv-title').textContent, card.querySelector('.jellypass-tv-status').textContent]), shown.map((card) => [card.title, labels[card.state]]));
    assert.deepEqual(page.cards().map((card) => card.querySelector('img')?.getAttribute('src') ?? null), shown.map((card) => card.posterUrl));
    // Remote-control focus: plain buttons in a row Jellyfin web's focus manager keeps Left and Right within.
    assert.ok(row.querySelector('.jellypass-tv-list').classList.contains('focuscontainer-x'));
    for (const card of page.cards()) {
      assert.equal(card.tagName, 'BUTTON');
      assert.equal(card.getAttribute('type'), 'button');
      assert.equal(card.getAttribute('tabindex'), null);
      assert.ok(card.getAttribute('aria-label').startsWith(card.querySelector('.jellypass-tv-title').textContent));
    }
    // Its stylesheet, next to the script.
    const links = [...page.document.querySelectorAll('link[data-jellypass-tv]')];
    assert.deepEqual(links.map((link) => link.getAttribute('href')), [`https://jelly-farmhouse.example.test/jellypass/tv/${STYLESHEET}`]);
  });

  it('keeps within its budget: Home redrawn or shown again within a minute asks nothing; shown again after one, it asks once', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await openJellyfinWeb(t, app);
    page.home();
    await page.settled();
    assert.equal(page.requests.length, 1);
    page.home();
    await page.settled();
    assert.equal(page.rows().length, 1, 'put back once Jellyfin web redrew Home');
    page.shown();
    page.clock.now += 59_000;
    page.shown();
    await page.settled();
    assert.equal(page.requests.length, 1);
    // Staying on Home asks nothing, however the page changes.
    page.clock.now += 120_000;
    page.document.querySelector('.section1').appendChild(page.document.createElement('div'));
    await page.settled();
    assert.equal(page.requests.length, 1);
    page.shown();
    await page.settled();
    assert.deepEqual(page.calls(1), BUDGET.screens['tv-home-row'].atOnce);
    assert.equal(page.rows().length, 1);
  });

  it('draws only the household\'s own view: the same row whatever other households hold or asked for', async (t) => {
    const snapshot = async (state) => {
      const app = await startApp(t, Object.assign(state, { webPage: {} }), tvOn());
      const page = await openJellyfinWeb(t, app);
      page.home();
      await page.settled();
      const [row] = page.rows();
      assertNoCanaries(row.outerHTML, 'the row shows Seerr data planted as a canary');
      return row.outerHTML;
    };
    const baseline = await snapshot(world());
    for (const [name, state] of Object.entries(otherHouseholdWorlds())) assert.ok(await snapshot(state) === baseline, name);
  });

  it('draws nothing and asks nothing when no one is signed in, Jellyfin web is signed in elsewhere, or Home is not shown', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const signedOut = await openJellyfinWeb(t, app, { user: null });
    signedOut.home();
    await signedOut.settled();
    const elsewhere = await openJellyfinWeb(t, app, { serverAddress: 'https://jelly-mill.example.test' });
    elsewhere.home();
    await elsewhere.settled();
    const hidden = await openJellyfinWeb(t, app);
    hidden.document.getElementById('indexPage').classList.add('hide');
    hidden.home();
    await hidden.settled();
    for (const page of [signedOut, elsewhere, hidden]) {
      assert.deepEqual([page.requests.length, page.rows().length], [0, 0]);
    }
    // Shown, it appears.
    hidden.document.getElementById('indexPage').classList.remove('hide');
    hidden.shown();
    await hidden.settled();
    assert.deepEqual([hidden.requests.length, hidden.rows().length], [1, 1]);
  });

  it('fails closed: an answer it cannot use draws no row, and is not asked again until Home is next shown after a minute', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await openJellyfinWeb(t, app);
    page.session.token = 'not-a-token';
    page.home();
    await page.settled();
    assert.deepEqual([page.requests.length, page.rows().length], [1, 0]);
    page.home();
    page.shown();
    await page.settled();
    assert.equal(page.requests.length, 1);
    assert.deepEqual(page.document.querySelectorAll('.verticalSection').length, 3, 'Home itself is untouched');
  });

  it('follows the member signed in: another member\'s row goes at once and is read again with their token', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await openJellyfinWeb(t, app);
    page.home();
    await page.settled();
    page.session.user = ANN;
    page.session.token = TOKENS[ANN];
    page.home();
    await page.settled();
    assert.equal(page.requests.length, 2);
    assert.equal(page.requests[1].init.headers.Authorization, `MediaBrowser Token="${TOKENS[ANN]}"`);
    assert.equal(page.rows().length, 1);
    page.session.token = null;
    page.home();
    await page.settled();
    assert.equal(page.rows().length, 0, 'signed out');
  });

  it('runs once however often it is loaded', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await openJellyfinWeb(t, app);
    page.run();
    page.home();
    await page.settled();
    assert.deepEqual([page.requests.length, page.rows().length, page.document.querySelectorAll('link[data-jellypass-tv]').length], [1, 1, 1]);
  });
});

describe('TV add-on: the title view and "Get this"', { timeout: 120_000 }, () => {
  const CONFIRMATION = "Thanks — we'll get this for your household.";
  const text = (page, selector) => page.view()?.querySelector(selector)?.textContent ?? null;
  const buttons = (page) => [...page.view().querySelectorAll('button')].map((button) => `${button.textContent}${button.disabled ? ' (disabled)' : ''}`);
  /** Home laid out with the row drawn, and every call answered. */
  const atHome = async (t, app, options) => {
    const page = await openJellyfinWeb(t, app, options);
    page.home();
    await page.settled();
    assert.equal(page.rows().length, 1);
    return page;
  };
  /** Chooses the row's card for `tmdbId` and waits for its view to be read and drawn. */
  const choose = async (page, tmdbId) => {
    page.click(page.card(tmdbId));
    await page.settled();
    assert.ok(page.view(), 'the view is open');
  };
  /** Seerr held at the request for the test's life, so the household's record is never written: every read says get_this. */
  const startHeld = async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    let release;
    app.seerr.state.holdRequests = new Promise((resolve) => { release = resolve; });
    t.after(async () => { release(); await app.background.settled(); });
    return app;
  };

  it('is written in the budget file: the app\'s title-page calls without /me, and an accepted Get this as its POST and the same reads', () => {
    for (const [name, kind, page] of [['tv-movie', 'movie', 'movie'], ['tv-series', 'tv', 'series']]) {
      const screen = BUDGET.screens[name];
      assert.equal(screen.calls, screen.atOnce.length, name);
      assert.deepEqual(screen.atOnce, BUDGET.screens[page].atOnce.filter((call) => call !== 'GET /me'), name);
      assert.deepEqual(screen.getThis, [...screen.atOnce, `POST /${kind}/{tmdbId}/get`].sort(), name);
    }
    // The view's buttons, toggles included, draw their focus with :focus, as the cards do.
    const css = readFileSync(path.join(DIST_TV, STYLESHEET), 'utf8');
    assert.ok(css.includes('.jellypass-tv-button:focus') && css.includes('.jellypass-tv-season-pick:focus'));
  });

  it('opens a movie over Home from its card, in the app\'s words, with Get this focused and the d-pad kept in the view, in the budget\'s calls', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await atHome(t, app);
    const before = page.requests.length;
    await choose(page, T_MOVIE);
    assert.deepEqual(page.calls(before), BUDGET.screens['tv-movie'].atOnce);
    assert.equal(page.requests.length - before, BUDGET.screens['tv-movie'].calls);
    for (const request of page.requests.slice(before)) {
      assert.ok(request.url.startsWith('https://jelly-farmhouse.example.test/jellypass/app/v1/'));
      assert.equal(request.init.credentials, 'omit');
      assert.deepEqual({ ...request.init.headers }, { Accept: 'application/json', Authorization: `MediaBrowser Token="${TOKENS[ALICE]}"` });
    }
    const view = page.view();
    assert.equal(view.parentNode, page.document.body, 'over Home, not in it');
    assert.ok(view.classList.contains('focuscontainer'), 'Jellyfin web\'s focus manager keeps the d-pad within it');
    assert.equal(view.getAttribute('role'), 'dialog');
    const movie = (await app.get(`/jellypass/app/v1/movie/${T_MOVIE}`)).json();
    assert.equal(text(page, 'h1'), movie.title);
    assert.equal(view.getAttribute('aria-labelledby'), view.querySelector('h1').id);
    assert.equal(text(page, '.jellypass-tv-status'), 'Available to get');
    assert.equal(text(page, '.jellypass-tv-title-overview'), movie.overview);
    assert.deepEqual(buttons(page), ['Back', 'Get this']);
    assert.equal(page.focused(), view.querySelector('.jellypass-tv-get'));
    for (const image of view.querySelectorAll('img')) assert.match(image.getAttribute('src'), /^https:\/\/image\.tmdb\.org\/t\/p\/w(?:342|780)\//);
    assert.equal(view.querySelector('.jellypass-tv-poster img').getAttribute('src'), movie.posterUrl);
    // No Play for a title the household doesn't have, and no season picker for a movie.
    assert.equal(view.querySelector('.jellypass-tv-play, .jellypass-tv-season'), null);
    assert.equal(page.document.querySelectorAll('[data-jellypass-tv-title]').length, 1);
  });

  it('closes on Back (each remote\'s key, and the Back button) before Jellyfin web sees it, and puts focus back on the card', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await atHome(t, app);
    for (const keyCode of [461, 10009, 27, 8]) {
      await choose(page, T_MOVIE);
      const event = page.key(keyCode);
      assert.equal(event.defaultPrevented, true, `${keyCode} is not left to Jellyfin web`);
      assert.equal(page.view(), null, `${keyCode} closes the view`);
      assert.equal(page.focused(), page.card(T_MOVIE), `${keyCode} puts focus back on the card`);
    }
    await choose(page, T_MOVIE);
    page.click(page.view().querySelector('.jellypass-tv-back'));
    assert.equal(page.view(), null);
    assert.equal(page.focused(), page.card(T_MOVIE));
    // With the view closed, Back is Jellyfin web's again; other keys never were the view's.
    assert.equal(page.key(461).defaultPrevented, false);
    await choose(page, T_MOVIE);
    for (const keyCode of [37, 38, 39, 40, 13]) assert.equal(page.key(keyCode).defaultPrevented, false, keyCode);
    assert.ok(page.view());
  });

  it('keeps focus in the view while it is open, and closes it when Jellyfin web goes to another page', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await atHome(t, app);
    await choose(page, T_MOVIE);
    const get = page.view().querySelector('.jellypass-tv-get');
    // Jellyfin web refocusing Home behind the view: focus is given back.
    page.document.querySelector('#indexPage .card').focus();
    assert.equal(page.focused(), get);
    // Jellyfin web shows another page (its own Back, a menu): the view goes with Home, and focus is Jellyfin web's.
    const other = page.document.createElement('div');
    other.id = 'itemDetailPage';
    page.document.querySelector('.mainAnimatedPages').appendChild(other);
    other.dispatchEvent(new page.Event('viewshow', { bubbles: true }));
    assert.equal(page.view(), null);
    assert.equal(page.focused(), get, 'focus not moved to the card');
  });

  it('plays a title in the library through Jellyfin web\'s own details page on this host, and nothing else', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await atHome(t, app);
    assert.ok(page.card(OWN_MOVIE), 'the household\'s own title is in Trending');
    await choose(page, OWN_MOVIE);
    assert.equal(text(page, '.jellypass-tv-status'), 'Ready to watch');
    assert.deepEqual(buttons(page), ['Back', 'Play']);
    const play = page.view().querySelector('.jellypass-tv-play');
    assert.equal(page.focused(), play);
    const before = page.requests.length;
    page.click(play);
    assert.equal(page.location.hash, `#/details?id=${ITEMS.ownMovie}`);
    assert.equal(page.view(), null);
    await page.settled();
    assert.equal(page.requests.length, before, 'Play calls nothing');
    // A play link for anywhere else is no Play.
    for (const url of [`https://jelly-mill.example.test/web/#/details?id=${ITEMS.ownMovie}`, `https://jelly-farmhouse.example.test/web/#/details?id=${ITEMS.ownMovie}&x=1`]) {
      const real = (await app.get(`/jellypass/app/v1/movie/${OWN_MOVIE}`)).json();
      const forged = await openJellyfinWeb(t, app, { override: (pathname) => (pathname === `/jellypass/app/v1/movie/${OWN_MOVIE}` ? { status: 200, body: JSON.stringify({ ...real, play: { itemId: ITEMS.ownMovie, url } }) } : undefined) });
      forged.home();
      await forged.settled();
      await choose(forged, OWN_MOVIE);
      assert.deepEqual(buttons(forged), ['Back'], url);
    }
  });

  it('asks for a movie once: disabled while out, the fixed confirmation, then the view read again, all in the budget\'s calls', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await atHome(t, app);
    await choose(page, T_MOVIE);
    const before = page.requests.length;
    const get = page.view().querySelector('.jellypass-tv-get');
    page.click(get);
    assert.equal(get.disabled, true);
    assert.equal(get.textContent, 'Sending…');
    page.click(get);
    await page.settled();
    assert.equal(page.posts().length, 1, 'a second press while in flight sent nothing');
    const [post] = page.posts();
    assert.equal(post.url, `https://jelly-farmhouse.example.test/jellypass/app/v1/movie/${T_MOVIE}/get`);
    assert.equal(post.init.body, '{}');
    assert.equal(post.init.credentials, 'omit');
    assert.deepEqual({ ...post.init.headers }, { Accept: 'application/json', Authorization: `MediaBrowser Token="${TOKENS[ALICE]}"`, 'Content-Type': 'application/json' });
    assert.deepEqual(page.calls(before), BUDGET.screens['tv-movie'].getThis);
    assert.equal(text(page, '.jellypass-tv-title-message'), CONFIRMATION);
    assert.equal(page.focused(), page.view().querySelector('.jellypass-tv-title-message'));
    assert.equal(text(page, '.jellypass-tv-status'), 'Requested');
    assert.equal(text(page, '.jellypass-tv-title-note'), 'Check My requests in the JellyPass app to follow it.');
    assert.deepEqual(buttons(page), ['Back'], 'nothing left that could send again');
    // The Home row says so too, in place.
    assert.equal(page.card(T_MOVIE).querySelector('.jellypass-tv-status').textContent, 'Requested');
    page.key(461);
    assert.equal(page.focused(), page.card(T_MOVIE));
    await app.background.settled();
  });

  it('asks for the seasons chosen of a series: a season picker, Select all, Get this only once something is chosen', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await atHome(t, app);
    const before = page.requests.length;
    await choose(page, T_TV);
    assert.deepEqual(page.calls(before), BUDGET.screens['tv-series'].atOnce);
    const series = (await app.get(`/jellypass/app/v1/tv/${T_TV}`)).json();
    const pickable = series.seasons.filter((season) => season.state === 'get_this' && season.seasonNumber >= 1);
    assert.ok(pickable.length >= 2, 'the fixture series has seasons to pick');
    const view = page.view();
    const toggles = [...view.querySelectorAll('.jellypass-tv-season-pick')];
    assert.deepEqual(toggles.map((toggle) => Number(toggle.getAttribute('data-season'))), pickable.map((season) => season.seasonNumber));
    assert.deepEqual([...view.querySelectorAll('.jellypass-tv-season-name')].map((name) => name.textContent), series.seasons.map((season) => season.name || `Season ${season.seasonNumber}`));
    const get = view.querySelector('.jellypass-tv-get');
    assert.equal(get.disabled, true, 'nothing chosen yet');
    assert.equal(text(page, '.jellypass-tv-title-hint'), 'Choose the seasons you want below.');
    assert.equal(page.focused(), toggles[0], 'the first season, since Get this waits for a choice');
    for (const toggle of toggles) assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    const selectAll = view.querySelector('.jellypass-tv-select-all');
    page.click(selectAll);
    assert.ok(toggles.every((toggle) => toggle.getAttribute('aria-pressed') === 'true'));
    assert.equal(selectAll.textContent, 'Clear all');
    page.click(selectAll);
    assert.ok(toggles.every((toggle) => toggle.getAttribute('aria-pressed') === 'false'));
    await page.settled();
    assert.equal(page.posts().length, 0, 'choosing asks for nothing');
    page.click(toggles[1]);
    assert.equal(get.disabled, false);
    assert.equal(view.querySelector('.jellypass-tv-title-hint').hidden, true);
    const asking = page.requests.length;
    page.click(get);
    await page.settled();
    assert.deepEqual(page.calls(asking), BUDGET.screens['tv-series'].getThis);
    assert.equal(page.posts()[0].init.body, JSON.stringify({ seasons: [pickable[1].seasonNumber] }));
    assert.equal(text(page, '.jellypass-tv-title-message'), CONFIRMATION);
    // The season asked for is not offered again; the others still are.
    assert.deepEqual([...page.view().querySelectorAll('.jellypass-tv-season-pick')].map((toggle) => Number(toggle.getAttribute('data-season'))), pickable.filter((_, index) => index !== 1).map((season) => season.seasonNumber));
    assert.equal(page.card(T_TV).querySelector('.jellypass-tv-status').textContent, 'Requested');
    await app.background.settled();
  });

  it('shows Requested while the server records it, on the view and the row, for two minutes at most, and only for the member who asked', async (t) => {
    const app = await startHeld(t);
    const page = await atHome(t, app);
    await choose(page, T_MOVIE);
    page.click(page.view().querySelector('.jellypass-tv-get'));
    await page.settled();
    // The read after the accepted call still said get_this; the view shows Requested all the same.
    assert.equal((await app.get(`/jellypass/app/v1/movie/${T_MOVIE}`)).json().state, 'get_this');
    assert.equal(text(page, '.jellypass-tv-status'), 'Requested');
    assert.deepEqual(buttons(page), ['Back']);
    page.key(10009);
    assert.equal(page.card(T_MOVIE).querySelector('.jellypass-tv-status').textContent, 'Requested');
    assert.ok(page.card(T_MOVIE).getAttribute('aria-label').endsWith(', Requested'));
    // Opened again within the two minutes, and Home redrawn: still Requested.
    page.clock.now += 100_000;
    await choose(page, T_MOVIE);
    assert.equal(text(page, '.jellypass-tv-status'), 'Requested');
    page.key(461);
    page.home();
    await page.settled();
    assert.equal(page.card(T_MOVIE).querySelector('.jellypass-tv-status').textContent, 'Requested');
    // After two minutes the server's own word stands again: on the row, and in the view, with Get this.
    page.clock.now += 20_000;
    page.home();
    await page.settled();
    assert.equal(page.card(T_MOVIE).querySelector('.jellypass-tv-status').textContent, 'Available to get');
    await choose(page, T_MOVIE);
    assert.equal(text(page, '.jellypass-tv-status'), 'Available to get');
    assert.deepEqual(buttons(page), ['Back', 'Get this']);
    page.key(461);

    // Asked again; then another member signs in: their row and view are their own, and the overlay is gone for good.
    await choose(page, T_MOVIE);
    page.click(page.view().querySelector('.jellypass-tv-get'));
    await page.settled();
    assert.equal(text(page, '.jellypass-tv-status'), 'Requested');
    page.session.user = ANN;
    page.session.token = TOKENS[ANN];
    page.home();
    await page.settled();
    assert.equal(page.view(), null, 'the view closed for another member');
    assert.equal(page.card(T_MOVIE).querySelector('.jellypass-tv-status').textContent, 'Available to get');
    page.session.user = ALICE;
    page.session.token = TOKENS[ALICE];
    page.home();
    await page.settled();
    assert.equal(page.card(T_MOVIE).querySelector('.jellypass-tv-status').textContent, 'Available to get', 'forgotten, not kept for Alice');
    // Signed out: no row and no view.
    await choose(page, T_MOVIE);
    page.session.token = null;
    page.home();
    await page.settled();
    assert.deepEqual([page.view(), page.rows().length], [null, 0]);
  });

  it('is byte-for-byte the same whatever other households hold or asked for: the calls, the view and the row', async (t) => {
    // What the server says about the title afterwards is its own matter (tested against the API); the add-on is held to
    // what it does with an accepted call, so every read of the title after it gets the same answer here, as in the app's test.
    const fresh = await startApp(t, webWorld(), tvOn());
    const stale = (await fresh.get(`/jellypass/app/v1/movie/${T_MOVIE}`)).text;
    const seen = {};
    for (const [name, state] of Object.entries({ baseline: world(), ...otherHouseholdWorlds() })) {
      const app = await startApp(t, Object.assign(state, { webPage: {} }), { ...tvOn(), reconcile: true });
      let asked = false;
      const override = (pathname, init) => {
        if (init.method === 'POST') { asked = true; return undefined; }
        return asked && pathname === `/jellypass/app/v1/movie/${T_MOVIE}` ? { status: 200, body: stale } : undefined;
      };
      const page = await atHome(t, app, { override });
      await choose(page, T_MOVIE);
      assert.deepEqual(buttons(page), ['Back', 'Get this'], name);
      page.click(page.view().querySelector('.jellypass-tv-get'));
      await page.settled();
      await app.background.settled();
      await page.settled();
      const view = page.view().outerHTML;
      assertNoCanaries(view, `${name}: the view shows Seerr data planted as a canary`);
      seen[name] = { calls: page.trace(), view, row: page.rows()[0].outerHTML };
    }
    const { baseline, ...others } = seen;
    assert.ok(baseline.view.includes(CONFIRMATION));
    assert.ok(Object.keys(others).length >= 5);
    for (const [name, outcome] of Object.entries(others)) {
      assert.deepEqual(outcome.calls, baseline.calls, `${name}: the calls the add-on made`);
      assert.ok(outcome.view === baseline.view, `${name}: the view differs`);
      assert.ok(outcome.row === baseline.row, `${name}: the row differs`);
    }
  });

  it('says each failure in its fixed words, never shows the answer\'s text, and never asks again by itself', async (t) => {
    const cases = [
      [{ status: 429, body: '{"error":"too_many_requests","canary":"upstream text"}' }, 'Too many tries, try again in a few minutes.'],
      [{ status: 502, body: '{"error":"canary upstream text"}' }, "We couldn't send that just now. Try again in a moment."],
      [{ status: 404, body: '{"error":"not_found"}' }, "We couldn't send that just now. Try again in a moment."],
      ['offline', "You're offline. Check your connection, then try again."],
    ];
    const app = await startApp(t, webWorld(), tvOn());
    for (const [answer, words] of cases) {
      const page = await atHome(t, app, {
        override: (_pathname, init) => {
          if (init.method !== 'POST') return undefined;
          if (answer === 'offline') throw new TypeError('Failed to fetch');
          return answer;
        },
      });
      await choose(page, T_MOVIE);
      const get = page.view().querySelector('.jellypass-tv-get');
      page.click(get);
      await page.settled();
      await page.settled();
      assert.equal(page.posts().length, 1, `${words}: asked once`);
      assert.equal(text(page, '.jellypass-tv-title-message'), words);
      assert.ok(page.view().querySelector('.jellypass-tv-title-message').classList.contains('jellypass-tv-title-error'));
      assert.deepEqual([get.textContent, get.disabled], ['Get this', false], 'offered again, for the member to press');
      assert.equal(page.focused(), get);
      assert.equal(text(page, '.jellypass-tv-status'), 'Available to get');
      lacks(page.view().outerHTML, /canary|upstream/i);
      assert.equal(page.card(T_MOVIE).querySelector('.jellypass-tv-status').textContent, 'Available to get', 'nothing marked requested');
    }
  });

  it('keeps the confirmation, offers nothing that sends and a retry that only reads, when the call was accepted but the view could not be read again', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    let accepted = false;
    let broken = true;
    const page = await atHome(t, app, {
      override: (pathname, init) => {
        if (init.method === 'POST') { accepted = true; return undefined; }
        return accepted && broken && pathname === `/jellypass/app/v1/movie/${T_MOVIE}` ? { status: 502, body: '{"error":"canary upstream text"}' } : undefined;
      },
    });
    await choose(page, T_MOVIE);
    page.click(page.view().querySelector('.jellypass-tv-get'));
    await page.settled();
    assert.equal(text(page, '.jellypass-tv-title-message'), CONFIRMATION);
    assert.equal(text(page, '.jellypass-tv-title-refresh'), 'Something went wrong. Try again in a moment.');
    assert.deepEqual(buttons(page), ['Back', 'Try again']);
    lacks(page.view().outerHTML, /canary|upstream/i);
    broken = false;
    const before = page.requests.length;
    page.click(page.view().querySelector('.jellypass-tv-retry'));
    await page.settled();
    assert.deepEqual(page.calls(before), BUDGET.screens['tv-movie'].atOnce, 'the retry only reads');
    assert.equal(text(page, '.jellypass-tv-status'), 'Requested');
    assert.equal(page.posts().length, 1);
    await app.background.settled();
  });

  it('shows a fixed error when the title can\'t be read, with a retry that reads it again; a refused token says sign in and forgets the overlay', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    let failing = 502;
    const page = await atHome(t, app, { override: (pathname) => (failing && pathname === `/jellypass/app/v1/movie/${T_MOVIE}` ? { status: failing, body: '{"error":"canary upstream text"}' } : undefined) });
    await choose(page, T_MOVIE);
    assert.equal(text(page, '.jellypass-tv-title-error'), "Can't load this right now");
    assert.deepEqual(buttons(page), ['Back', 'Try again']);
    assert.equal(page.focused(), page.view().querySelector('.jellypass-tv-retry'));
    lacks(page.view().outerHTML, /canary|upstream/i);
    await page.settled();
    const before = page.requests.length;
    failing = 0;
    page.click(page.view().querySelector('.jellypass-tv-retry'));
    await page.settled();
    assert.equal(page.requests.length - before, BUDGET.screens['tv-movie'].calls);
    assert.equal(text(page, '.jellypass-tv-status'), 'Available to get');
    // Asked for, then Jellyfin web's token refused: the view says so, and Requested is forgotten on the row.
    page.click(page.view().querySelector('.jellypass-tv-get'));
    await page.settled();
    assert.equal(page.card(T_MOVIE).querySelector('.jellypass-tv-status').textContent, 'Requested');
    page.key(461);
    failing = 401;
    await choose(page, T_MOVIE);
    assert.equal(text(page, '.jellypass-tv-title-error'), 'Sign in to continue');
    assert.deepEqual(buttons(page), ['Back']);
    await page.settled();
    assert.equal(page.card(T_MOVIE).querySelector('.jellypass-tv-status').textContent, 'Available to get');
    await app.background.settled();
  });

  it('calls only the origin it came from: signed in elsewhere, the view closes and nothing is sent there', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await atHome(t, app);
    await choose(page, T_MOVIE);
    page.session.serverAddress = 'https://jelly-mill.example.test';
    page.document.body.appendChild(page.document.createElement('div'));
    await page.settled();
    assert.equal(page.view(), null);
    for (const request of page.requests) assert.ok(request.url.startsWith('https://jelly-farmhouse.example.test/'), 'only this origin');
    // A card chosen while signed in elsewhere opens nothing.
    page.session.serverAddress = 'https://jelly-farmhouse.example.test';
    page.home();
    await page.settled();
    const card = page.card(T_MOVIE);
    page.session.serverAddress = 'https://jelly-mill.example.test';
    const before = page.requests.length;
    page.click(card);
    await page.settled();
    assert.deepEqual([page.view(), page.requests.length], [null, before]);
  });
});
