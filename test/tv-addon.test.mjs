// The TV add-on (docs/tv-addon.md): its build (one ES2017 classic script and a stylesheet for the TVs' Chromium 63), how
// the household gateway adds it to Jellyfin web's page (only on the households it is on for, never on the admin host,
// never on anything but that page, once), how it serves its files, and the row itself, run from the built bundle in a
// simulated Jellyfin web (linkedom) against the real app API. Real-TV checks are listed in docs/tv-addon.md.
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
import { ALICE, ANN, HOST_A, HOST_B, TOKENS, get, otherHouseholdWorlds, startApp, world } from './support/household-app.mjs';
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
async function openJellyfinWeb(t, app, { user = ALICE, host = HOST_A, serverAddress = `https://${host}` } = {}) {
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
  const scope = {
    document,
    location: { href: `https://${host}/web/#/home.html`, origin: `https://${host}` },
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
        const answer = await get(app.port, `${target.pathname}${target.search}`, { Host: target.host, ...init.headers });
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
    session,
    requests,
    logged,
    stored,
    clock,
    run,
    /** As `METHOD /path` under /jellypass/app/v1, sorted. */
    calls: (from = 0) => requests.slice(from).map((request) => `${request.init.method ?? 'GET'} ${new URL(request.url).pathname.replace('/jellypass/app/v1', '')}`).sort(),
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

  it('opens nothing yet: choosing a card says title pages are coming, and leaves Jellyfin web where it is', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await openJellyfinWeb(t, app);
    page.home();
    await page.settled();
    const [card] = page.cards();
    card.dispatchEvent(new page.Event('click'));
    assert.equal(page.document.querySelector('.jellypass-tv-note').textContent, 'Coming soon to the TV. To get a title now, use the JellyPass app on your phone.');
    await page.settled();
    assert.equal(page.requests.length, 1);
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
