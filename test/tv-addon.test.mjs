// The TV add-on (docs/tv-addon.md): its build (one ES2017 classic script and a stylesheet for the TVs' Chromium 63), how
// the household gateway adds it to Jellyfin web's page (only on the households it is on for, never on the admin host,
// never on anything but that page, once), how it serves its files, and the row itself, run from the built bundle in a
// simulated Jellyfin web (linkedom) against the real app API, and the title page with "Get this" it opens on the page host.
// Real-TV
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
const tvOn = (households = ['grove']) => ({ tvAddon: { households } });
/** What Jellyfin was asked for under /web or /jellypass/tv, as `METHOD path`. */
/**
 * linkedom keeps no focus: the element focus() was last called on, per document, stands in for `activeElement`, and
 * focus() fires `focusin` as a browser does (the page host listens for it).
 */
const FOCUSED = new WeakMap();
let LIVE_FOCUS;
{
  const { HTMLElement, Event } = parseHTML('<html><body></body></html>');
  HTMLElement.prototype.focus = function focus() {
    FOCUSED.set(this.ownerDocument, this);
    this.dispatchEvent(new Event('focusin', { bubbles: true }));
  };
  // A detached element is not focused: activeElement is the last focused one only while it is in the live document.
  const live = (document) => { const el = FOCUSED.get(document); return el && document.documentElement.contains(el) ? el : null; };
  Object.defineProperty(Object.getPrototypeOf(parseHTML('<html><body></body></html>').document), 'activeElement', { configurable: true, get() { return live(this) ?? this.body ?? null; } });
  LIVE_FOCUS = live;
}
/** Whether a title is in the row: it is there only while Available to get (strings, never the card). */
const onRow = (page, tmdbId) => (page.card(tmdbId) ? 'Available to get' : 'not in the row');
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
    // Focus is drawn with :focus, which a remote's focus always is (the row's cards use Jellyfin web's own, `.card:focus`).
    assert.ok(css.includes('.jellypass-tv-title-button:focus'));
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
 * as Jellyfin web does; `clock` holds the add-on's clocks, `now` its `Date.now` and `mono` its `performance.now`.
 */
async function openJellyfinWeb(t, app, { user = ALICE, host = HOST_A, serverAddress = `https://${host}`, override } = {}) {
  const served = await app.get('/web/index.html', { host, user: null });
  const { document, Event, CustomEvent, MutationObserver } = parseHTML(served.text);
  // Every listener the add-on puts on the document, as `type options` (strings, so nothing crosses realms).
  const listeners = [];
  const addListener = document.addEventListener.bind(document);
  document.addEventListener = (type, listener, options) => {
    listeners.push(`${type} ${JSON.stringify(options ?? null)}`);
    return addListener(type, listener, options);
  };
  document.querySelector('.mainAnimatedPages').innerHTML = '<div id="indexPage" data-role="page" class="page homePage libraryPage"><div class="tabContent pageTabContent" id="homeTab" data-index="0"><div class="sections"></div></div></div>';
  const session = { user, serverAddress, token: user ? TOKENS[user] : null };
  const requests = [];
  const logged = [];
  const stored = [];
  let pending = 0;
  const clock = { now: 1_000_000, mono: 5_000 };
  // A timer of a second or more runs on the monotonic clock, as a browser's do (see `advance`), not in real time; shorter
  // ones (the add-on gathering page changes) run as set.
  const held = new Map();
  const storage = new Proxy({}, { get: (_target, name) => (...args) => stored.push([name, ...args]) });
  const location = { href: `https://${host}/web/#/home.html`, origin: `https://${host}`, hash: '#/home.html' };
  const windowListeners = [];
  /** The addresses the member came from, newest last: Jellyfin web's history. */
  const trail = [];
  const scope = {
    document,
    location,
    addEventListener: (type, listener) => windowListeners.push([type, listener]),
    MutationObserver,
    setTimeout: (run, delay = 0) => {
      if (delay < 1000) return setTimeout(run, delay);
      const id = {};
      held.set(id, { due: clock.mono + delay, run });
      return id;
    },
    clearTimeout: (id) => {
      if (!held.delete(id)) clearTimeout(id);
    },
    URL,
    Date: { now: () => clock.now },
    performance: { now: () => clock.mono },
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
    /**
     * Time passing with the page left alone: both clocks move on by `ms`, and each held timer runs when its time comes
     * (one set by another runs too, if it falls within `ms`).
     */
    advance(ms) {
      const end = clock.mono + ms;
      for (;;) {
        const due = [...held].filter(([, timer]) => timer.due <= end).sort(([, a], [, b]) => a.due - b.due)[0];
        const step = (due ? Math.max(due[1].due, clock.mono) : end) - clock.mono;
        clock.mono += step;
        clock.now += step;
        if (!due) return;
        held.delete(due[0]);
        due[1].run();
      }
    },
    /** The TV asleep for `ms`: the wall clock moves on, the monotonic clock and its timers stand still. */
    sleep(ms) {
      clock.now += ms;
    },
    /** How many timers are held on the monotonic clock. */
    timers: () => held.size,
    run,
    listeners,
    trail,
    /** Jellyfin web's router showing the page for the address now set (a card or Play opened it), coming from `from`. */
    follow(from) {
      trail.push(from);
      show(location.hash);
    },
    /** Jellyfin web's router going to `hash`, a history entry. */
    route(hash) {
      trail.push(location.hash);
      location.hash = hash;
      show(hash);
    },
    /** Jellyfin web's Back: the history's last address is shown again. */
    back() {
      location.hash = trail.pop();
      show(location.hash);
    },
    /** Jellyfin web's router going to `hash`: the address changes and `hashchange` reaches the window's listeners. */
    goTo(hash) {
      location.hash = hash;
      location.href = `https://${host}/web/${hash}`;
      for (const [type, listener] of windowListeners) if (type === 'hashchange') listener(new Event('hashchange'));
    },
    /** As `METHOD /path` under /jellypass/app/v1, a title's ID as `{tmdbId}`, sorted. */
    calls: (from = 0) => requests.slice(from).map((request) => `${request.init.method ?? 'GET'} ${new URL(request.url).pathname.replace('/jellypass/app/v1', '').replace(/^\/(movie|tv)\/[0-9]+/, '/$1/{tmdbId}')}`).sort(),
    /** Every call as made, for comparing two runs: address, method, body and headers. */
    trace: (from = 0) => requests.slice(from).map(({ url, init }) => JSON.stringify({ url, method: init.method ?? 'GET', body: init.body ?? null, credentials: init.credentials ?? null, headers: { ...init.headers } })),
    posts: () => requests.filter((request) => request.init.method === 'POST'),
    card: (tmdbId) => document.querySelector(`[data-jellypass-tv-row] button[data-tmdb-id="${tmdbId}"]`),
    view: () => document.querySelector('[data-jellypass-tv-title]'),
    focused: () => LIVE_FOCUS(document),
    /** A key pressed on what has focus (or the page), as a remote sends it: `keyCode` only, as Chromium 63 has it. */
    key(keyCode) {
      const event = new Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'keyCode', { value: keyCode });
      (FOCUSED.get(document) ?? document.body).dispatchEvent(event);
      return event;
    },
    click: (element) => element.dispatchEvent(new Event('click')),
    /** A pointer (or touch) press on what has focus (or the page). */
    press(type) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      (FOCUSED.get(document) ?? document.body).dispatchEvent(event);
      return event;
    },
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
  /**
   * What Jellyfin web does for an address: `hashchange` first, then its page (its fallback page for a JellyPass address,
   * Home laid out again and shown, or some other page, with Home hidden).
   */
  const show = (hash) => {
    location.href = `https://${host}/web/${hash}`;
    for (const [type, listener] of windowListeners) if (type === 'hashchange') listener(new Event('hashchange'));
    leaveFallback(document);
    const index = document.getElementById('indexPage');
    if (/^#\/home/.test(hash)) {
      index.classList.remove('hide');
      page.shown();
      page.home();
    } else {
      index.classList.add('hide');
      if (/^#\/jellypass\//.test(hash)) showFallback(document);
    }
  };
  t.after(() => {
    // The token is never logged, stored or put in the page.
    for (const args of logged) lacks(JSON.stringify(args), new RegExp(Object.values(TOKENS).join('|')), 'logged the token');
    assert.deepEqual(stored, [], 'used storage');
    lacks(document.documentElement.outerHTML, new RegExp(Object.values(TOKENS).join('|')), 'the token is in the page');
  });
  return page;
}

/**
 * Home laid out with Trending's answer changed by `change` (the cards as the API gave them); `override` answers any other
 * call, as `openJellyfinWeb`'s does.
 */
const withTrending = async (t, app, change, override) => {
  const real = (await app.get('/jellypass/app/v1/discover/trending')).json();
  const body = JSON.stringify({ ...real, results: change(real.results) });
  const page = await openJellyfinWeb(t, app, { override: (pathname, init) => (pathname === '/jellypass/app/v1/discover/trending' ? { status: 200, body } : override?.(pathname, init)) });
  page.home();
  await page.settled();
  return page;
};

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
    assert.equal(request.url, 'https://jelly-grove.example.test/jellypass/app/v1/discover/trending');
    assert.equal(request.init.credentials, 'omit');
    assert.deepEqual({ ...request.init.headers }, { Accept: 'application/json', Authorization: `MediaBrowser Token="${TOKENS[ALICE]}"` });

    const rows = page.rows();
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.ok(row.previousElementSibling.classList.contains('section0'), 'after Home\'s first section');
    assert.ok(row.classList.contains('verticalSection'));
    assert.equal(row.querySelector('h2.sectionTitle').textContent, 'Discover');
    // The household's own view, exactly as the API answers it, but only what is Available to get: Synthetic Movie Three
    // is `in_library` and is left out.
    const answer = (await app.get('/jellypass/app/v1/discover/trending')).json();
    assert.ok(answer.results.some((card) => card.state === 'in_library'), 'the world has a title in the library');
    const shown = answer.results.slice(0, 20).filter((card) => card.state === 'get_this');
    assert.ok(shown.length > 0);
    assert.deepEqual(page.cards().map((card) => [card.querySelector('.jellypass-tv-card-title').textContent, card.getAttribute('aria-label').split(', ').pop()]), shown.map((card) => [card.title, 'Available to get']));
    assert.equal(page.document.querySelectorAll('[data-jellypass-tv-row] .jellypass-tv-card-status').length, 0, 'no badge');
    assert.deepEqual(page.cards().map((card) => card.querySelector('img')?.getAttribute('src') ?? null), shown.map((card) => card.posterUrl));
    // Remote-control focus: plain buttons in a row Jellyfin web's focus manager keeps Left and Right within.
    assert.ok(row.querySelector('.jellypass-tv-row-list').classList.contains('focuscontainer-x'));
    for (const card of page.cards()) {
      assert.equal(card.tagName, 'BUTTON');
      assert.equal(card.getAttribute('type'), 'button');
      assert.equal(card.getAttribute('tabindex'), null);
      assert.ok(card.getAttribute('aria-label').startsWith(card.querySelector('.jellypass-tv-card-title').textContent));
    }
    // Its stylesheet, next to the script.
    const links = [...page.document.querySelectorAll('link[data-jellypass-tv]')];
    assert.deepEqual(links.map((link) => link.getAttribute('href')), [`https://jelly-grove.example.test/jellypass/tv/${STYLESHEET}`]);
  });

  it('shows only Available to get: what is in the caller\'s library or Requested is left out, with no badge, and nothing but the caller\'s own answer decides it', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const real = (await app.get('/jellypass/app/v1/discover/trending')).json().results;
    const library = real.filter((card) => card.state === 'in_library').map((card) => card.title);
    assert.ok(library.length > 0 && real.length > library.length + 1);
    // The first card is Requested for the caller: it is not in the row, nor is the one in the library.
    const requested = real[0].title;
    const page = await withTrending(t, app, (results) => results.map((card, index) => (index === 0 ? { ...card, state: 'requested' } : card)));
    const titles = page.cards().map((card) => card.querySelector('.jellypass-tv-card-title').textContent);
    assert.deepEqual(titles, real.slice(1).filter((card) => card.state === 'get_this').map((card) => card.title));
    assert.ok(titles.length > 0 && !titles.includes(requested), 'Requested is not in the row');
    for (const title of library) assert.ok(!titles.includes(title), `${title} is in the library, so not in the row`);
    assert.equal(page.document.querySelectorAll('.jellypass-tv-card-status').length, 0, 'no badge');
    assert.equal(page.requests.length, 1, 'no second page is asked for');
    // Jellyfin web's own card markup, so its classes size, type and focus them.
    for (const card of page.cards()) {
      assert.ok(['card', 'overflowPortraitCard', 'card-hoverable'].every((name) => card.classList.contains(name)), 'card classes');
      assert.ok(card.querySelector('.cardBox .cardScalable .cardPadder-overflowPortrait') && card.querySelector('.cardScalable .cardImageContainer'));
      assert.ok(card.querySelector('.cardText.cardText-first') && card.querySelector('.cardText.cardText-secondary'));
    }
    // The same cards whatever other households hold: the filter reads only the caller's own `state`.
    const labels = async (state) => {
      const other = await openJellyfinWeb(t, await startApp(t, Object.assign(state, { webPage: {} }), tvOn()));
      other.home();
      await other.settled();
      return other.cards().map((card) => card.getAttribute('aria-label'));
    };
    const baseline = await labels(world());
    assert.ok(baseline.length > titles.length, 'what the caller has Requested in the baseline answer is not counted');
    assert.deepEqual(baseline.map((label) => label.split(', ').pop()), baseline.map(() => 'Available to get'));
    for (const [name, state] of Object.entries(otherHouseholdWorlds())) assert.deepEqual(await labels(state), baseline, name);
  });

  it('draws the TV layout\'s focus ring and zoom classes only on a TV, and no row at all when nothing is left to show', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const desktop = await withTrending(t, app, (results) => results);
    assert.ok(desktop.cards().every((card) => !card.classList.contains('show-focus') && !card.classList.contains('show-animation')));
    const tv = await openJellyfinWeb(t, app);
    tv.document.documentElement.classList.add('layout-tv');
    tv.home();
    await tv.settled();
    assert.ok(tv.cards().length > 0 && tv.cards().every((card) => card.classList.contains('show-focus') && card.classList.contains('show-animation')));
    // Nothing left to show: no row, no empty heading, and no second call.
    const empty = await withTrending(t, app, (results) => results.map((card, index) => ({ ...card, state: index % 2 ? 'requested' : 'in_library' })));
    assert.deepEqual([empty.rows().length, empty.requests.length], [0, 1]);
    assert.equal(empty.document.querySelectorAll('.verticalSection').length, 3, 'Home itself is untouched');
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

describe('TV add-on: the title page and "Get this"', { timeout: 120_000 }, () => {
  const CONFIRMATION = "Thanks — we'll get this for your household.";
  const text = (page, selector) => page.view()?.querySelector(selector)?.textContent ?? null;
  const buttons = (page) => [...page.view().querySelectorAll('button')].map((button) => `${button.textContent}${button.disabled ? ' (disabled)' : ''}`);
  /** Home laid out with the row drawn, under Jellyfin web's header, and every call answered. */
  const atHome = async (t, app, options) => {
    const page = await openJellyfinWeb(t, app, options);
    page.document.body.insertAdjacentHTML('afterbegin', HEADER);
    page.home();
    await page.settled();
    assert.equal(page.rows().length, 1);
    return page;
  };
  /** Chooses the row's card for `tmdbId`, Jellyfin web's router follows the address it opened, and the page is read and drawn. */
  const choose = async (page, tmdbId) => {
    const from = page.location.hash;
    page.click(page.card(tmdbId));
    assert.notEqual(page.location.hash, from, 'the card opened an address');
    page.follow(from);
    await page.settled();
    assert.ok(page.view(), 'the page is open');
  };
  /** Seerr held at the request for the test's life, so the household's record is never written: every read says get_this. */
  const startHeld = async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    let release;
    app.seerr.state.holdRequests = new Promise((resolve) => { release = resolve; });
    t.after(async () => { release(); await app.background.settled(); });
    return app;
  };
  /** Back to Home (Jellyfin web's history), the row drawn there again. */
  const home = async (page) => {
    page.back();
    await page.settled();
  };

  it('is written in the budget file: the app\'s title-page calls without /me, and an accepted Get this as its POST and the same reads', () => {
    for (const [name, kind, page] of [['tv-movie', 'movie', 'movie'], ['tv-series', 'tv', 'series']]) {
      const screen = BUDGET.screens[name];
      assert.equal(screen.calls, screen.atOnce.length, name);
      assert.deepEqual(screen.atOnce, BUDGET.screens[page].atOnce.filter((call) => call !== 'GET /me'), name);
      assert.deepEqual(screen.getThis, [...screen.atOnce, `POST /${kind}/{tmdbId}/get`].sort(), name);
    }
    // The page's buttons, toggles included, draw their focus with :focus, as the cards do.
    const css = readFileSync(path.join(DIST_TV, STYLESHEET), 'utf8');
    assert.ok(css.includes('.jellypass-tv-title-button:focus') && css.includes('.jellypass-tv-title-season-pick:focus'));
  });

  it('colours each status by its state: no rule for every status, later in the stylesheet, outweighs the state\'s colour', () => {
    const css = readFileSync(path.join(DIST_TV, STYLESHEET), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body], order) => selectors.split(',').map((selector) => ({ selector: selector.trim(), body, order })));
    // The colour the cascade gives an element: the most specific matching rule (selectors here are classes only), then the last.
    const colour = (element) => {
      const winner = rules
        .filter(({ selector, body }) => /(?:^|;|\s)color:/.test(body) && !/:/.test(selector) && element.matches(selector))
        .map(({ selector, body, order }) => ({ weight: (selector.match(/\./g) ?? []).length, order, value: /(?:^|;|\s)color:\s*([^;]+)/.exec(body)[1].trim() }))
        .sort((a, b) => a.weight - b.weight || a.order - b.order)
        .pop();
      return winner ? winner.value : null;
    };
    const { document } = parseHTML('<html><body><div class="jellypass-tv-title-page"><div class="jellypass-tv-title-text"></div><div class="jellypass-tv-title-season"></div></div></body></html>');
    const states = { in_library: '#7fe0a0', get_this: '#35b8e8', requested: '#f2c35b', unavailable: '#a9bad8', failed: '#ff9b8f' };
    const found = {};
    const expected = {};
    for (const where of ['.jellypass-tv-title-text', '.jellypass-tv-title-season']) {
      for (const [state, value] of Object.entries(states)) {
        const status = document.createElement('span');
        status.className = `mediaInfoItem jellypass-tv-title-status jellypass-tv-title-status-${state}`;
        document.querySelector(where).appendChild(status);
        found[`${where} ${state}`] = colour(status);
        expected[`${where} ${state}`] = value;
      }
    }
    // Strings only: the colours found against the state's own.
    assert.deepEqual(found, expected);
  });

  it('names the page and the row apart: no class of ours is on both, each keeps to its own prefix, and no rule for one reaches the other', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await atHome(t, app);
    page.document.documentElement.classList.add('layout-tv');
    const [row] = page.rows();
    const rowElements = [row, ...row.querySelectorAll('*')];
    // Class names only (strings), never the elements, in what is compared and reported.
    const classes = (elements) => [...new Set(elements.flatMap((element) => [...element.classList]))].sort();
    const rowClasses = classes(rowElements);
    const ours = (names) => names.filter((name) => name.startsWith('jellypass-tv'));
    const isRow = (name) => /^jellypass-tv-(?:row|card)(?:-|$)/.test(name);
    const isView = (name) => name.startsWith('jellypass-tv-title-');
    assert.ok(rowClasses.includes('jellypass-tv-card-title'));
    assert.deepEqual(ours(rowClasses).filter((name) => !isRow(name)), [], 'the row\'s classes outside jellypass-tv-row-* and jellypass-tv-card-*');
    // A movie's page, and a series' with its seasons, toggles and Select all.
    const css = readFileSync(path.join(DIST_TV, STYLESHEET), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) => selectors.split(',').map((selector) => ({ selector: selector.trim(), body })));
    assert.ok(rules.length > 40);
    // A selector tried on elements with its states (:focus, ::-webkit-scrollbar) taken as on.
    const matching = (selector, elements) => {
      const structural = selector.replace(/::?[a-z-]+(?:\([^)]*\))?/g, '').trim();
      return elements.some((element) => element.matches(structural));
    };
    for (const tmdbId of [T_MOVIE, T_TV]) {
      await choose(page, tmdbId);
      const view = page.view();
      const viewElements = [view, ...view.querySelectorAll('*')];
      const viewClasses = classes(viewElements);
      assert.ok(viewClasses.includes('jellypass-tv-title-page') && viewClasses.includes('jellypass-tv-title-status'), String(tmdbId));
      if (tmdbId === T_TV) assert.ok(viewClasses.includes('jellypass-tv-title-season-pick'));
      assert.deepEqual(ours(viewClasses).filter((name) => rowClasses.includes(name)), [], `classes of ours on both the page and the row (${tmdbId})`);
      assert.deepEqual(ours(viewClasses).filter((name) => !isView(name)), [], `the page's classes outside jellypass-tv-title-* (${tmdbId})`);
      assert.deepEqual(rules.filter(({ selector }) => matching(selector, viewElements) && matching(selector, rowElements)).map(({ selector }) => selector), [], `rules that match both (${tmdbId})`);
      assert.deepEqual(rules.filter(({ selector, body }) => /position:\s*fixed/.test(body) && matching(selector, rowElements)).map(({ selector }) => selector), [], 'fixed rules that match the row');
      // The one fixed box on the page is its backdrop, behind everything: nothing of the page's content is fixed.
      assert.deepEqual(rules.filter(({ selector, body }) => /position:\s*fixed/.test(body)).map(({ selector }) => selector), ['.jellypass-tv-title-backdrop']);
      await home(page);
    }
    // Every selector in the built stylesheet names classes of one of the three only (the page host's is `jellypass-tv-hosting`).
    const isHost = (name) => name === 'jellypass-tv-hosting';
    const mixed = rules.map(({ selector }) => selector).filter((selector) => {
      const names = (selector.match(/\.jellypass-tv[a-z0-9_-]*/g) ?? []).map((name) => name.slice(1));
      assert.ok(names.length > 0, selector);
      return !(names.every(isRow) || names.every(isView) || names.every(isHost));
    });
    assert.deepEqual(mixed, [], 'selectors outside, or across, the row, the page and the page host');
    // The old overlay is gone: no stacking rules, no overlay box, and nothing keyed on Jellyfin's backdrop setting.
    lacks(css, /z-index/, 'a z-index rule');
    lacks(css, /jellypass-tv-title-view|jellypass-tv-title-scroller/, 'the overlay\'s classes');
  });

  it('draws the row\'s list without Jellyfin web\'s itemsContainer class: Home calls .pause() on every such element when it is left', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await atHome(t, app);
    assert.equal(page.document.querySelectorAll('[data-jellypass-tv-row] .itemsContainer').length, 0);
    assert.equal(page.document.querySelectorAll('[data-jellypass-tv-row] .jellypass-tv-row-list').length, 1);
  });

  it('opens a movie\'s page at its own address from the card, a history entry in Jellyfin web\'s page under its header, in the app\'s words, with Get this focused, in the budget\'s calls', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await atHome(t, app);
    const before = page.requests.length;
    await choose(page, T_MOVIE);
    assert.equal(page.location.hash, `#/jellypass/title/movie/${T_MOVIE}`);
    assert.deepEqual(page.trail, ['#/home.html'], 'a history entry, so Jellyfin\'s Back returns to Home');
    assert.deepEqual(page.calls(before), BUDGET.screens['tv-movie'].atOnce);
    assert.equal(page.requests.length - before, BUDGET.screens['tv-movie'].calls);
    for (const request of page.requests.slice(before)) {
      assert.ok(request.url.startsWith('https://jelly-grove.example.test/jellypass/app/v1/'));
      assert.equal(request.init.credentials, 'omit');
      assert.deepEqual({ ...request.init.headers }, { Accept: 'application/json', Authorization: `MediaBrowser Token="${TOKENS[ALICE]}"` });
    }
    const view = page.view();
    assert.ok(page.document.querySelector('#fallbackPage > [data-jellypass-tv-page]').contains(view), 'in Jellyfin web\'s own page, not over it');
    const movie = (await app.get(`/jellypass/app/v1/movie/${T_MOVIE}`)).json();
    assert.equal(text(page, 'h1'), movie.title);
    assert.equal(headerTitle(page), movie.title, 'Jellyfin\'s header says what the page is');
    assert.equal(page.document.title, movie.title);
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Available to get');
    assert.equal(text(page, '.jellypass-tv-title-overview'), movie.overview);
    assert.deepEqual(buttons(page), ['Get this']);
    assert.ok(page.focused() === view.querySelector('.jellypass-tv-title-get'), 'focus');
    for (const image of view.querySelectorAll('img')) assert.match(image.getAttribute('src'), /^https:\/\/image\.tmdb\.org\/t\/p\/w(?:342|780)\//);
    assert.equal(view.querySelector('.jellypass-tv-title-poster img').getAttribute('src'), movie.posterUrl);
    // Laid out as Jellyfin web's item details page is, in its own classes.
    assert.ok(view.querySelector('.nameContainer > h1.itemName'));
    assert.ok(view.querySelector('.itemMiscInfo-primary .mediaInfoItem'));
    assert.ok(view.querySelector('.mainDetailButtons button.emby-button.button-submit'), 'Jellyfin\'s own primary button');
    assert.ok(view.querySelector('p.overview'));
    // No Play for a title the household doesn't have, and no season picker for a movie.
    assert.equal(view.querySelector('.jellypass-tv-title-play, .jellypass-tv-title-season') === null, true);
    assert.equal(page.document.querySelectorAll('[data-jellypass-tv-title]').length, 1);
    // The TV layout's own focus ring and zoom classes are on its buttons there only.
    assert.equal(view.querySelector('.jellypass-tv-title-get').classList.contains('show-focus'), false);
  });

  it('draws a TV layout\'s button with Jellyfin\'s focus ring and zoom', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await atHome(t, app);
    page.document.documentElement.classList.add('layout-tv');
    await choose(page, T_MOVIE);
    assert.equal(page.view().querySelector('.jellypass-tv-title-get').classList.contains('show-focus'), true);
  });

  it('draws a title page opened at its address directly, and for an address that names no title says so with no call', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await openJellyfinWeb(t, app);
    page.document.body.insertAdjacentHTML('afterbegin', HEADER);
    page.goTo(`#/jellypass/title/tv/${T_TV}`);
    showFallback(page.document);
    await page.settled();
    assert.deepEqual(page.calls(), BUDGET.screens['tv-series'].atOnce);
    const series = (await app.get(`/jellypass/app/v1/tv/${T_TV}`)).json();
    assert.equal(text(page, 'h1'), series.title);
    assert.equal(headerTitle(page), series.title);
    for (const address of ['movie/abc', 'film/1', 'movie/01', 'movie/12345678901', 'movie/9999999999', 'movie/2147483648', 'movie/-1', 'tv/1.5']) {
      const other = await openJellyfinWeb(t, app);
      other.document.body.insertAdjacentHTML('afterbegin', HEADER);
      other.goTo(`#/jellypass/title/${address}`);
      showFallback(other.document);
      await other.settled();
      assert.equal(text(other, '.jellypass-tv-title-error'), 'Not found', address);
      assert.deepEqual(buttons(other), [], address);
      assert.equal(other.requests.length, 0, `${address}: nothing asked`);
    }
  });

  it('shows the backdrop always, across the whole page, whatever Jellyfin web\'s Backdrops setting says: it reads no setting', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const backdrop = 'https://image.tmdb.org/t/p/w780/backdrop_1-A.jpg';
    const real = (await app.get(`/jellypass/app/v1/movie/${T_MOVIE}`)).json();
    const page = await atHome(t, app, {
      override: (pathname) => (pathname === `/jellypass/app/v1/movie/${T_MOVIE}` ? { status: 200, body: JSON.stringify({ ...real, backdropUrl: backdrop }) } : undefined),
    });
    // Jellyfin web's per-browser setting off (its default) or on, as the classes it sets show: the page is the same.
    for (const on of [false, true]) {
      if (on) page.document.body.classList.add('withBackdrop');
      else page.document.body.classList.remove('withBackdrop');
      await choose(page, T_MOVIE);
      const image = page.view().querySelector('.jellypass-tv-title-backdrop img');
      assert.ok(image, `drawn with the setting ${on ? 'on' : 'off'}`);
      assert.equal(image.getAttribute('src'), backdrop);
      assert.equal(image.getAttribute('referrerpolicy'), 'no-referrer');
      await home(page);
    }
    assert.deepEqual(page.stored, [], 'no setting is read from storage');
    // Without a backdrop image the box is still there (the page's own dark ground).
    const bare = await atHome(t, app, {
      override: (pathname) => (pathname === `/jellypass/app/v1/movie/${T_MOVIE}` ? { status: 200, body: JSON.stringify({ ...real, backdropUrl: null }) } : undefined),
    });
    await choose(bare, T_MOVIE);
    assert.equal(bare.view().querySelectorAll('.jellypass-tv-title-backdrop').length, 1);
    assert.equal(bare.view().querySelectorAll('.jellypass-tv-title-backdrop img').length, 0);
    // The stylesheet lays it across the whole screen, and the bundle knows nothing of Jellyfin's setting.
    const css = readFileSync(path.join(DIST_TV, STYLESHEET), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = /\.jellypass-tv-title-backdrop\s*\{([^{}]*)\}/.exec(css)[1];
    for (const declaration of ['position: fixed', 'top: 0', 'right: 0', 'bottom: 0', 'left: 0']) assert.ok(rule.includes(declaration), declaration);
    lacks(css, /withBackdrop|enableBackdrops/);
    lacks(readFileSync(path.join(DIST_TV, SCRIPT), 'utf8'), /enableBackdrops|withBackdrop|backdropContainer|backgroundContainer/);
  });

  it('returns to Home on Back with the title\'s card focused, and handles no key of its own: Back is Jellyfin web\'s', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await atHome(t, app);
    for (const tmdbId of [T_MOVIE, T_TV, T_MOVIE]) {
      await choose(page, tmdbId);
      assert.ok(hosting(page));
      // Every remote's Back and the d-pad are left to Jellyfin web: nothing is prevented or stopped.
      for (const keyCode of [461, 10009, 27, 8, 37, 38, 39, 40, 13]) assert.equal(page.key(keyCode).defaultPrevented, false, `${keyCode}`);
      assert.ok(page.view(), 'no key closes the page');
      page.back();
      await page.settled();
      assert.equal(page.view() === null, true);
      assert.equal(page.location.hash, '#/home.html');
      assert.ok(!hosting(page));
      assert.ok(page.focused() === page.card(tmdbId), `focus is back on the card of ${tmdbId}`);
    }
  });

  it('takes the largest id the API\'s title paths take, and no call for the next one up', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    for (const [id, calls] of [[2147483647, true], [2147483648, false]]) {
      const page = await openJellyfinWeb(t, app);
      page.document.body.insertAdjacentHTML('afterbegin', HEADER);
      page.goTo(`#/jellypass/title/movie/${id}`);
      showFallback(page.document);
      await page.settled();
      assert.equal(page.requests.length > 0, calls, `${id}`);
      if (!calls) assert.equal(text(page, '.jellypass-tv-title-error'), 'Not found', `${id}`);
    }
  });

  describe('focus after Back', () => {
    /** Home with the title's card focused by Back, then focus moved off it (to Jellyfin web's own card), as a redraw would find it. */
    const backed = async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const page = await atHome(t, app);
      await choose(page, T_MOVIE);
      await home(page);
      assert.ok(page.focused() === page.card(T_MOVIE), 'Back focused the card');
      page.document.querySelector('.verticalSection .card').focus();
      assert.ok(page.focused() !== page.card(T_MOVIE), 'focus has left the card');
      return page;
    };
    const redraw = async (page) => {
      page.home();
      await page.settled();
    };

    it('is given back to the card when Jellyfin web redraws Home within the window and the member has pressed nothing', async (t) => {
      const page = await backed(t);
      await redraw(page);
      assert.ok(page.focused() === page.card(T_MOVIE));
    });

    for (const [name, press] of [
      ['a key press', (page) => page.key(40)],
      ['a pointer press', (page) => page.press('pointerdown')],
    ]) {
      it(`is not given back to the card after ${name}`, async (t) => {
        const page = await backed(t);
        press(page);
        await redraw(page);
        assert.ok(page.focused() !== page.card(T_MOVIE), 'focus stays where the member left it');
      });
    }

    it('is not given back to the card once the window has run out', async (t) => {
      const page = await backed(t);
      page.advance(4_001);
      await redraw(page);
      assert.ok(page.focused() !== page.card(T_MOVIE), 'focus stays where it is');
    });
  });

  it('drops what is in flight when Jellyfin web goes to another page, and Back through it returns to the title page, then Home with the card', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let slow = false;
    const page = await atHome(t, app, {
      override: async (pathname) => {
        if (slow && pathname === `/jellypass/app/v1/movie/${T_MOVIE}`) await held;
        return undefined;
      },
    });
    // Jellyfin web goes to another page while the title is still being read: the answer is dropped.
    slow = true;
    const from = page.location.hash;
    page.click(page.card(T_MOVIE));
    page.follow(from);
    await pause(60);
    assert.ok(page.view(), 'loading');
    assert.equal(text(page, '.jellypass-tv-title-loading'), 'Loading…');
    page.route('#/details?id=someitem');
    release();
    await page.settled();
    assert.equal(page.view() === null, true, 'left with Jellyfin web\'s page');
    assert.ok(!hosting(page));
    assert.equal(page.document.querySelectorAll('[data-jellypass-tv-page]').length, 0);
    // Back: the title page, read again; Back once more: Home, the card focused.
    slow = false;
    page.back();
    await page.settled();
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Available to get');
    await home(page);
    assert.ok(page.focused() === page.card(T_MOVIE), 'focus back on the card');
  });

  it('plays a title in the library through Jellyfin web\'s own details page on this host, and nothing else; Back returns to the page', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    // The row leaves out what is in the library, so its card is one Trending still called Available to get when the
    // title was read: the page says what is true now.
    const page = await withTrending(t, app, (results) => results.map((card) => (card.tmdbId === OWN_MOVIE ? { ...card, state: 'get_this' } : card)));
    page.document.body.insertAdjacentHTML('afterbegin', HEADER);
    assert.ok(page.card(OWN_MOVIE), 'the household\'s own title is in the row');
    await choose(page, OWN_MOVIE);
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Ready to watch');
    assert.deepEqual(buttons(page), ['Play']);
    const play = page.view().querySelector('.jellypass-tv-title-play');
    assert.ok(page.focused() === play, 'focus');
    const before = page.requests.length;
    const from = page.location.hash;
    page.click(play);
    assert.equal(page.location.hash, `#/details?id=${ITEMS.ownMovie}`);
    page.follow(from);
    assert.equal(page.view() === null, true, 'Jellyfin web\'s page is shown, ours is gone');
    await page.settled();
    assert.equal(page.requests.length, before, 'Play calls nothing');
    // Back from Jellyfin's details page: the title page, drawn again.
    page.back();
    await page.settled();
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Ready to watch');
    assert.ok(page.focused() === page.view().querySelector('.jellypass-tv-title-play'), 'focus');
    // A play link for anywhere else is no Play.
    for (const url of [`https://jelly-mill.example.test/web/#/details?id=${ITEMS.ownMovie}`, `https://jelly-grove.example.test/web/#/details?id=${ITEMS.ownMovie}&x=1`]) {
      const real = (await app.get(`/jellypass/app/v1/movie/${OWN_MOVIE}`)).json();
      const forged = await withTrending(t, app, (results) => results.map((card) => (card.tmdbId === OWN_MOVIE ? { ...card, state: 'get_this' } : card)), (pathname) => (pathname === `/jellypass/app/v1/movie/${OWN_MOVIE}` ? { status: 200, body: JSON.stringify({ ...real, play: { itemId: ITEMS.ownMovie, url } }) } : undefined));
      forged.document.body.insertAdjacentHTML('afterbegin', HEADER);
      await choose(forged, OWN_MOVIE);
      assert.deepEqual(buttons(forged), [], url);
    }
  });

  it('gives focus back to what the member had focused when Back returns to a title page', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await atHome(t, app);
    await choose(page, T_TV);
    const toggles = () => [...page.view().querySelectorAll('.jellypass-tv-title-season-pick')];
    const second = toggles()[1].getAttribute('data-season');
    assert.ok(page.focused() === toggles()[0], 'first the first season');
    // The member moves focus with the remote: a key, then focus on the second season.
    page.key(40);
    toggles()[1].focus();
    page.route('#/details?id=someitem');
    assert.equal(page.view() === null, true);
    page.back();
    await page.settled();
    assert.ok(page.focused() === page.view().querySelector(`[data-season="${second}"]`), 'the second season, as it was left');
  });

  it('leaves focus to a member who has pressed a key while the title is still being read', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const page = await atHome(t, app, { override: async (pathname) => { if (pathname === `/jellypass/app/v1/movie/${T_MOVIE}`) await held; return undefined; } });
    const from = page.location.hash;
    page.click(page.card(T_MOVIE));
    page.follow(from);
    await pause(60);
    const header = page.document.querySelector('.skinHeader .headerHomeButton');
    page.key(40);
    header.focus();
    release();
    await page.settled();
    assert.ok(page.focused() === header, 'not taken from the member');
    assert.ok(page.view().querySelector('.jellypass-tv-title-get'), 'but drawn');
  });

  it('asks for a movie once: disabled while out, the fixed confirmation, then the page read again, all in the budget\'s calls', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await atHome(t, app);
    await choose(page, T_MOVIE);
    const before = page.requests.length;
    const get = page.view().querySelector('.jellypass-tv-title-get');
    page.click(get);
    assert.equal(get.disabled, true);
    assert.equal(get.textContent, 'Sending…');
    page.click(get);
    await page.settled();
    assert.equal(page.posts().length, 1, 'a second press while in flight sent nothing');
    const [post] = page.posts();
    assert.equal(post.url, `https://jelly-grove.example.test/jellypass/app/v1/movie/${T_MOVIE}/get`);
    assert.equal(post.init.body, '{}');
    assert.equal(post.init.credentials, 'omit');
    assert.deepEqual({ ...post.init.headers }, { Accept: 'application/json', Authorization: `MediaBrowser Token="${TOKENS[ALICE]}"`, 'Content-Type': 'application/json' });
    assert.deepEqual(page.calls(before), BUDGET.screens['tv-movie'].getThis);
    assert.equal(text(page, '.jellypass-tv-title-message'), CONFIRMATION);
    assert.ok(page.focused() === page.view().querySelector('.jellypass-tv-title-message'), 'focus');
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Requested');
    assert.equal(text(page, '.jellypass-tv-title-note'), 'Check My requests in the JellyPass app to follow it.');
    assert.deepEqual(buttons(page), [], 'nothing left that could send again');
    // The Home row says so too, when Home is shown again.
    await home(page);
    assert.equal(onRow(page, T_MOVIE), 'not in the row');
    assert.ok(page.focused() === page.cards()[0], 'its card left the row, so focus goes to the row\'s first card');
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
    const toggles = [...view.querySelectorAll('.jellypass-tv-title-season-pick')];
    assert.deepEqual(toggles.map((toggle) => Number(toggle.getAttribute('data-season'))), pickable.map((season) => season.seasonNumber));
    assert.deepEqual([...view.querySelectorAll('.jellypass-tv-title-season-name')].map((name) => name.textContent), series.seasons.map((season) => season.name || `Season ${season.seasonNumber}`));
    const get = view.querySelector('.jellypass-tv-title-get');
    assert.equal(get.disabled, true, 'nothing chosen yet');
    assert.equal(text(page, '.jellypass-tv-title-hint'), 'Choose the seasons you want below.');
    assert.ok(page.focused() === toggles[0], 'the first season, since Get this waits for a choice');
    for (const toggle of toggles) assert.equal(toggle.getAttribute('aria-pressed'), 'false');
    const selectAll = view.querySelector('.jellypass-tv-title-select-all');
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
    assert.deepEqual([...page.view().querySelectorAll('.jellypass-tv-title-season-pick')].map((toggle) => Number(toggle.getAttribute('data-season'))), pickable.filter((_, index) => index !== 1).map((season) => season.seasonNumber));
    await home(page);
    assert.equal(onRow(page, T_TV), 'not in the row');
    await app.background.settled();
  });

  it('shows Requested while the server records it, on the page and by the title leaving the row, for two minutes at most, and only for the member who asked', async (t) => {
    const app = await startHeld(t);
    const page = await atHome(t, app);
    await choose(page, T_MOVIE);
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    // The read after the accepted call still said get_this; the page shows Requested all the same.
    assert.equal((await app.get(`/jellypass/app/v1/movie/${T_MOVIE}`)).json().state, 'get_this');
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Requested');
    assert.deepEqual(buttons(page), []);
    await home(page);
    assert.equal(onRow(page, T_MOVIE), 'not in the row', 'Requested leaves the row');
    // Within the two minutes, and Home redrawn: still Requested, so still not in the row.
    page.clock.now += 100_000;
    page.home();
    await page.settled();
    assert.equal(onRow(page, T_MOVIE), 'not in the row');
    // After two minutes the server's own word stands again: back in the row, and on the page, with Get this.
    page.clock.now += 20_000;
    page.home();
    await page.settled();
    assert.equal(onRow(page, T_MOVIE), 'Available to get');
    await choose(page, T_MOVIE);
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Available to get');
    assert.deepEqual(buttons(page), ['Get this']);
    await home(page);

    // Asked again; then another member signs in: their row and page are their own, and the overlay is gone for good.
    await choose(page, T_MOVIE);
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Requested');
    page.session.user = ANN;
    page.session.token = TOKENS[ANN];
    page.home();
    await page.settled();
    assert.equal(page.view() === null, true, 'the page is emptied for another member');
    await home(page);
    assert.equal(onRow(page, T_MOVIE), 'Available to get');
    page.session.user = ALICE;
    page.session.token = TOKENS[ALICE];
    page.home();
    await page.settled();
    assert.equal(onRow(page, T_MOVIE), 'Available to get', 'forgotten, not kept for Alice');
    // Signed out: no row and no page.
    await choose(page, T_MOVIE);
    page.session.token = null;
    page.home();
    await page.settled();
    assert.deepEqual([page.view() === null, page.rows().length], [true, 0]);
  });

  it('lets Requested run out on a page and a row left alone after two minutes, with no call, and clears its timer on sign-out', async (t) => {
    const app = await startHeld(t);
    const page = await atHome(t, app);
    await choose(page, T_MOVIE);
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Requested');
    assert.equal(page.timers(), 1);
    const before = page.requests.length;
    // Nothing is pressed, shown or redrawn by the test: only time passes.
    page.advance(119_999);
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Requested');
    page.advance(1);
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Available to get', 'the open page');
    // Drawn again in place: the confirmation and focus stay, and what was asked for here is not offered again.
    assert.equal(text(page, '.jellypass-tv-title-message'), CONFIRMATION);
    assert.ok(page.focused() === page.view().querySelector('.jellypass-tv-title-message'), 'focus');
    assert.deepEqual(buttons(page), []);
    assert.equal(page.requests.length, before, 'no call');
    assert.equal(page.timers(), 0);
    await page.settled();
    assert.equal(page.requests.length, before, 'no call after');
    // The row behind it, when Home is shown again, has the title back in it.
    await home(page);
    assert.equal(onRow(page, T_MOVIE), 'Available to get', 'the row');
    assert.ok(page.card(T_MOVIE).getAttribute('aria-label').endsWith(', Available to get'));

    // A series' seasons, the page left: the row alone runs out, and seasons ticked on a page left open stay ticked.
    await choose(page, T_TV);
    const toggles = () => [...page.view().querySelectorAll('.jellypass-tv-title-season-pick')];
    const [first, second] = toggles().map((toggle) => Number(toggle.getAttribute('data-season')));
    page.click(toggles()[0]);
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    // The remote moves focus to the next season, and OK ticks it.
    page.view().querySelector(`[data-season="${second}"]`).focus();
    page.click(page.view().querySelector(`[data-season="${second}"]`));
    page.advance(120_000);
    assert.equal(text(page, `.jellypass-tv-title-season:not(.jellypass-tv-title-season-pick) .jellypass-tv-title-status`), 'Available to get', `season ${first}`);
    assert.equal(page.view().querySelector(`[data-season="${second}"]`).getAttribute('aria-pressed'), 'true');
    assert.ok(page.focused() === page.view().querySelector(`[data-season="${second}"]`), 'focus');
    await home(page);
    assert.equal(onRow(page, T_TV), 'Available to get');
    await choose(page, T_MOVIE);
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    await home(page);
    assert.equal(onRow(page, T_MOVIE), 'not in the row');
    page.advance(120_000);
    assert.equal(onRow(page, T_MOVIE), 'Available to get', 'the row, with no page open');

    // Signing out (or another member signing in) forgets the overlay, and its timer with it.
    await choose(page, T_MOVIE);
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    assert.equal(page.timers(), 1);
    page.session.user = ANN;
    page.session.token = TOKENS[ANN];
    page.home();
    await page.settled();
    assert.equal(page.timers(), 0, 'another member');
    page.session.user = ALICE;
    page.session.token = TOKENS[ALICE];
    await home(page);
    await choose(page, T_MOVIE);
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    assert.equal(page.timers(), 1);
    page.session.token = null;
    page.home();
    await page.settled();
    assert.equal(page.timers(), 0, 'signed out');
  });

  it('ends Requested on either clock, as the app does: a TV asleep for two minutes ends it, a wall clock set back does not stretch it', async (t) => {
    const app = await startHeld(t);
    const page = await atHome(t, app);
    await choose(page, T_MOVIE);
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    const before = page.requests.length;
    // Asleep: the wall clock runs on while the monotonic clock and its timers stand still. Once awake, the next look at
    // the clocks (within 15 seconds) ends it on the open page, with no call.
    page.advance(10_000);
    page.sleep(110_000);
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Requested');
    page.advance(5_000);
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Available to get', 'the open page');
    assert.equal(page.timers(), 0);
    assert.equal(page.requests.length, before, 'no call');
    await home(page);
    assert.equal(onRow(page, T_MOVIE), 'Available to get', 'the row');

    // The wall clock set back an hour: the monotonic clock still ends it at two minutes, no sooner and no later.
    await choose(page, T_MOVIE);
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    page.clock.now -= 3_600_000;
    page.advance(119_999);
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Requested');
    page.advance(1);
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Available to get');
    assert.equal(page.timers(), 0);
    await home(page);
    assert.equal(onRow(page, T_MOVIE), 'Available to get');
  });

  it('is byte-for-byte the same whatever other households hold or asked for: the calls, the page and the row', async (t) => {
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
      assert.deepEqual(buttons(page), ['Get this'], name);
      page.click(page.view().querySelector('.jellypass-tv-title-get'));
      await page.settled();
      await app.background.settled();
      await page.settled();
      const view = page.view().outerHTML;
      assertNoCanaries(view, `${name}: the page shows Seerr data planted as a canary`);
      await home(page);
      seen[name] = { calls: page.trace(), view, row: page.rows()[0].outerHTML };
    }
    const { baseline, ...others } = seen;
    assert.ok(baseline.view.includes(CONFIRMATION));
    assert.ok(Object.keys(others).length >= 5);
    for (const [name, outcome] of Object.entries(others)) {
      assert.deepEqual(outcome.calls, baseline.calls, `${name}: the calls the add-on made`);
      assert.ok(outcome.view === baseline.view, `${name}: the page differs`);
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
      const get = page.view().querySelector('.jellypass-tv-title-get');
      page.click(get);
      await page.settled();
      await page.settled();
      assert.equal(page.posts().length, 1, `${words}: asked once`);
      assert.equal(text(page, '.jellypass-tv-title-message'), words);
      assert.ok(page.view().querySelector('.jellypass-tv-title-message').classList.contains('jellypass-tv-title-error'));
      assert.deepEqual([get.textContent, get.disabled], ['Get this', false], 'offered again, for the member to press');
      assert.ok(page.focused() === get, 'focus');
      assert.equal(text(page, '.jellypass-tv-title-status'), 'Available to get');
      lacks(page.view().outerHTML, /canary|upstream/i);
      await home(page);
      assert.equal(onRow(page, T_MOVIE), 'Available to get', 'nothing marked requested');
    }
  });

  it('keeps the confirmation, offers nothing that sends and a retry that only reads, when the call was accepted but the page could not be read again', async (t) => {
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
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    assert.equal(text(page, '.jellypass-tv-title-message'), CONFIRMATION);
    assert.equal(text(page, '.jellypass-tv-title-refresh'), 'Something went wrong. Try again in a moment.');
    assert.deepEqual(buttons(page), ['Try again']);
    lacks(page.view().outerHTML, /canary|upstream/i);
    broken = false;
    const before = page.requests.length;
    page.click(page.view().querySelector('.jellypass-tv-title-retry'));
    await page.settled();
    assert.deepEqual(page.calls(before), BUDGET.screens['tv-movie'].atOnce, 'the retry only reads');
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Requested');
    assert.equal(page.posts().length, 1);
    await app.background.settled();
  });

  it('still lets Requested run out on a page whose read after an accepted Get this failed, with no call, keeping the note and the retry', async (t) => {
    const app = await startHeld(t);
    let posts = 0;
    let broken = true;
    const page = await atHome(t, app, {
      override: (pathname, init) => {
        if (init.method === 'POST') { posts += 1; return undefined; }
        return posts >= 2 && broken && pathname === `/jellypass/app/v1/tv/${T_TV}` ? { status: 502, body: '{"error":"canary upstream text"}' } : undefined;
      },
    });
    await choose(page, T_TV);
    const toggles = () => [...page.view().querySelectorAll('.jellypass-tv-title-season-pick')];
    const [first, second] = toggles().map((toggle) => Number(toggle.getAttribute('data-season')));
    // Each season's status by its place in the list (a season asked for is no longer a toggle with data-season).
    const order = (await app.get(`/jellypass/app/v1/tv/${T_TV}`)).json().seasons.map((season) => season.seasonNumber);
    const seasonStatuses = () => [first, second].map((season) => page.view().querySelectorAll('.jellypass-tv-title-season')[order.indexOf(season)].querySelector('.jellypass-tv-title-status').textContent);
    page.click(page.view().querySelector(`[data-season="${first}"]`));
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    page.click(page.view().querySelector(`[data-season="${second}"]`));
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    assert.equal(posts, 2);
    assert.equal(text(page, '.jellypass-tv-title-refresh'), 'Something went wrong. Try again in a moment.');
    assert.deepEqual(seasonStatuses(), ['Requested', 'Available to get'], 'the page as drawn before the second was sent');
    const before = page.requests.length;
    page.advance(120_000);
    // Both seasons' Requested have run out: the page says what the server last said, drawn again with no call.
    assert.deepEqual(seasonStatuses(), ['Available to get', 'Available to get']);
    assert.equal(text(page, '.jellypass-tv-title-message'), CONFIRMATION);
    assert.equal(text(page, '.jellypass-tv-title-refresh'), 'Something went wrong. Try again in a moment.');
    assert.deepEqual(buttons(page), ['Try again'], 'nothing that sends');
    lacks(page.view().outerHTML, /canary|upstream/i);
    assert.equal(page.requests.length, before, 'no call');
    broken = false;
    page.click(page.view().querySelector('.jellypass-tv-title-retry'));
    await page.settled();
    assert.deepEqual(page.calls(before), BUDGET.screens['tv-series'].atOnce, 'the retry only reads');
    assert.equal(posts, 2);
    await home(page);
    assert.equal(onRow(page, T_TV), 'Available to get');
  });

  it('shows a fixed error when the title can\'t be read, with a retry that reads it again; a refused token says sign in and forgets the overlay', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    let failing = 502;
    const page = await atHome(t, app, { override: (pathname) => (failing && /^\/jellypass\/app\/v1\/(?:movie|tv)\/[0-9]+$/.test(pathname) ? { status: failing, body: '{"error":"canary upstream text"}' } : undefined) });
    await choose(page, T_MOVIE);
    assert.equal(text(page, '.jellypass-tv-title-error'), "Can't load this right now");
    assert.deepEqual(buttons(page), ['Try again']);
    assert.ok(page.focused() === page.view().querySelector('.jellypass-tv-title-retry'), 'focus');
    lacks(page.view().outerHTML, /canary|upstream/i);
    await page.settled();
    const before = page.requests.length;
    failing = 0;
    page.click(page.view().querySelector('.jellypass-tv-title-retry'));
    await page.settled();
    assert.equal(page.requests.length - before, BUDGET.screens['tv-movie'].calls);
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Available to get');
    // Asked for, then Jellyfin web's token refused: the page says so, and Requested is forgotten on the row.
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    await home(page);
    assert.equal(onRow(page, T_MOVIE), 'not in the row');
    failing = 401;
    await choose(page, T_TV); // another title: the one asked for has left the row
    assert.equal(text(page, '.jellypass-tv-title-error'), 'Sign in to continue');
    assert.deepEqual(buttons(page), []);
    await page.settled();
    await home(page);
    assert.equal(onRow(page, T_MOVIE), 'Available to get');
    await app.background.settled();
  });

  it('says sign in and forgets the overlay when the requests read is refused, whatever the title read did', async (t) => {
    const app = await startHeld(t);
    let failing = false;
    const page = await atHome(t, app, {
      override: (pathname) => {
        if (!failing) return undefined;
        if (pathname === `/jellypass/app/v1/tv/${T_TV}`) return { status: 502, body: '{"error":"canary upstream text"}' };
        if (pathname === '/jellypass/app/v1/requests') return { status: 401, body: '{}' };
        return undefined;
      },
    });
    await choose(page, T_MOVIE);
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    await home(page);
    assert.equal(onRow(page, T_MOVIE), 'not in the row');
    failing = true;
    await choose(page, T_TV); // another title: the one asked for has left the row
    assert.equal(text(page, '.jellypass-tv-title-error'), 'Sign in to continue');
    assert.deepEqual(buttons(page), []);
    await page.settled();
    await home(page);
    assert.equal(onRow(page, T_MOVIE), 'Available to get');
    assert.equal(page.timers(), 0);
  });

  it('keeps focus on the card it is on when another title\'s Requested runs out and the row is drawn again', async (t) => {
    const app = await startHeld(t);
    const page = await atHome(t, app);
    await choose(page, T_MOVIE);
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    await home(page);
    assert.equal(onRow(page, T_MOVIE), 'not in the row');
    const other = page.card(T_TV);
    other.focus();
    assert.ok(page.focused() === other, 'focus');
    page.advance(120_000);
    assert.equal(onRow(page, T_MOVIE), 'Available to get');
    assert.ok(page.focused() === page.card(T_TV), 'the same title is focused');
    assert.ok(page.document.documentElement.contains(page.focused()), 'and in the page');
  });

  it('calls only the origin it came from: signed in elsewhere, the page is emptied and nothing is sent there; a card chosen then opens nothing', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await atHome(t, app);
    await choose(page, T_MOVIE);
    page.session.serverAddress = 'https://jelly-mill.example.test';
    page.document.body.appendChild(page.document.createElement('div'));
    await page.settled();
    assert.equal(page.view() === null, true);
    for (const request of page.requests) assert.ok(request.url.startsWith('https://jelly-grove.example.test/'), 'only this origin');
    // A card chosen while signed in elsewhere opens nothing.
    page.session.serverAddress = 'https://jelly-grove.example.test';
    await home(page);
    const card = page.card(T_MOVIE);
    page.session.serverAddress = 'https://jelly-mill.example.test';
    const before = page.requests.length;
    const hash = page.location.hash;
    page.click(card);
    await page.settled();
    assert.deepEqual([page.location.hash, page.requests.length], [hash, before]);
    assert.equal(page.view() === null, true);
    // And an address opened while signed in elsewhere draws nothing and asks nothing.
    page.goTo(`#/jellypass/title/movie/${T_MOVIE}`);
    showFallback(page.document);
    await page.settled();
    assert.deepEqual([page.view() === null, page.requests.length], [true, before]);
  });

  it('has no key listener of its own: every listener on the document is a capturing, passive one, and the bundle neither prevents nor stops an event', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await atHome(t, app);
    assert.ok(page.listeners.length >= 6, page.listeners.join('; '));
    const types = [...new Set(page.listeners.map((entry) => entry.split(' ')[0]))].sort();
    assert.deepEqual(types, ['focusin', 'keydown', 'mousedown', 'pageshow', 'pointerdown', 'touchstart', 'viewshow']);
    // The host's document listeners, the input ones included, are explicitly capturing and passive: they only observe.
    for (const entry of page.listeners) assert.ok(entry.endsWith(' {"capture":true,"passive":true}'), entry);
    const source = readFileSync(path.join(DIST_TV, SCRIPT), 'utf8');
    lacks(source, /\bpreventDefault\b|\bstopPropagation\b|\bstopImmediatePropagation\b/);
    lacks(source, /\bkeyCode\b|\.key\b|isBackKey|["']Escape["']|["']Backspace["']/);
    // Back (every remote's) on Home and on a title page is left to Jellyfin web.
    await choose(page, T_MOVIE);
    for (const keyCode of [461, 10009, 27, 8]) assert.equal(page.key(keyCode).defaultPrevented, false, `${keyCode}`);
    assert.ok(page.view(), 'the page is still there: only Jellyfin web\'s Back leaves it');
  });
});

/**
 * The parts of Jellyfin web 12.3 the page host relies on, as it lays them out (checked against its source:
 * `scripts/libraryMenu.js` for the header, `components/router/FallbackRoute.tsx` and `components/Page.tsx` for the page).
 */
const HEADER = '<div class="skinHeader focuscontainer-x"><button type="button" class="headerButton headerButtonLeft headerBackButton"></button><button type="button" class="headerButton headerHomeButton"></button><h3 class="pageTitle pageTitleWithLogo pageTitleWithDefaultLogo" aria-hidden="true"></h3></div>';
const NOT_FOUND = '<div class="padded-left padded-right"><h1>Page not found</h1><p>The page you requested could not be found.</p><a class="button-link" href="#/home">Go home</a></div>';
/** Jellyfin web's router showing its fallback page (React renders it into the page container). */
const showFallback = (document, { attrs = 'id="fallbackPage" data-role="page" class="page mainAnimatedPage libraryPage" data-title="Page not found" data-backbutton="true" data-menubutton="false"' } = {}) => {
  document.querySelector('.mainAnimatedPages').insertAdjacentHTML('beforeend', `<div ${attrs}>${NOT_FOUND}</div>`);
  return document.querySelector('[data-title="Page not found"]');
};
const leaveFallback = (document) => {
  for (const page of document.querySelectorAll('[data-title]')) page.remove();
};
const hosting = (page) => page.document.documentElement.classList.contains('jellypass-tv-hosting');
const hosted = (page) => page.document.querySelector('[data-jellypass-tv-page]');
const headerTitle = (page) => page.document.querySelector('.skinHeader .pageTitle').textContent;
const headerTitleOf = (box) => box.document.querySelector('.skinHeader .pageTitle').textContent;

describe('TV add-on: the page host', { timeout: 60_000 }, () => {
  const open = async (t, options) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await openJellyfinWeb(t, app, options);
    page.document.body.insertAdjacentHTML('afterbegin', HEADER);
    return page;
  };

  it('fills Jellyfin web\'s "Page not found" page at #/jellypass/about under its own header, with Jellyfin\'s title, and asks for nothing', async (t) => {
    const page = await open(t);
    page.home();
    await page.settled();
    const calls = page.requests.length;
    page.goTo('#/jellypass/about');
    showFallback(page.document);
    await page.settled();
    const box = hosted(page);
    assert.ok(box, 'the JellyPass page is drawn');
    assert.equal(box.parentNode.id, 'fallbackPage', 'in Jellyfin\'s own page');
    assert.deepEqual([...box.querySelectorAll('h1')].map((h) => h.textContent), ['JellyPass']);
    assert.equal(headerTitle(page), 'JellyPass');
    assert.equal(page.document.title, 'JellyPass');
    assert.equal(page.document.getElementById('fallbackPage').getAttribute('data-title'), 'JellyPass', 'so Jellyfin web\'s own pageshow sets the same title');
    // The header's logo look is Jellyfin's: gone, as its own setTitle takes it off.
    assert.equal(page.document.querySelector('.pageTitle').className, 'pageTitle');
    // Jellyfin web's own content is left in the page (React owns it), only hidden by the stylesheet.
    assert.ok(hosting(page));
    assert.ok(page.document.querySelector('#fallbackPage > .padded-left h1'));
    assert.equal(page.requests.length, calls, 'no call is made');
    assert.equal(page.rows().length, 1, 'Home\'s row is as it was, not copied into the page');
    assert.equal(page.document.querySelectorAll('[data-jellypass-tv-page] [data-jellypass-tv-row]').length, 0);
  });

  it('hides "Page not found" before it is drawn: the hiding is set when the address changes, not when the page appears', async (t) => {
    const page = await open(t);
    assert.ok(!hosting(page));
    page.goTo('#/jellypass/about');
    assert.ok(hosting(page), 'set at once by the hash change');
    showFallback(page.document);
    assert.ok(hosting(page), 'still set when the page is drawn, before the add-on has filled it');
    await page.settled();
    assert.ok(hosted(page));
    const css = readFileSync(path.join(DIST_TV, STYLESHEET), 'utf8');
    assert.match(css, /html\.jellypass-tv-hosting #fallbackPage\[data-role="page"\]\.page:not\(\.hide\) > :not\(\[data-jellypass-tv-page\]\)\s*\{\s*display:\s*none !important/);
  });

  it('is already on a JellyPass address when Jellyfin web loads it', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const served = await app.get('/web/index.html', { host: HOST_A, user: null });
    assert.ok(served.text.includes(TAG));
    const page = await open(t);
    page.goTo('#/jellypass/about');
    page.run();
    assert.ok(hosting(page));
  });

  it('draws nothing for a path it has no page for, or an address outside #/jellypass/, and leaves Jellyfin\'s page as it is', async (t) => {
    const page = await open(t);
    for (const hash of ['#/jellypass/nope', '#/jellypass/', '#/jellypass', '#/jellypass/about/more', '#/jellypassx/about', '#/nope', '#!/jellypass/about']) {
      page.goTo(hash);
      showFallback(page.document);
      await page.settled();
      assert.ok(!hosting(page), hash);
      assert.equal(hosted(page), null, hash);
      assert.equal(headerTitle(page), '', hash);
      assert.equal(page.document.getElementById('fallbackPage').getAttribute('data-title'), 'Page not found', hash);
      leaveFallback(page.document);
    }
  });

  it('fails safe: Jellyfin\'s page not as expected means nothing is drawn, nothing is hidden and nothing is touched', async (t) => {
    for (const attrs of [
      'data-role="page" class="page" data-title="Page not found"',
      'id="fallbackPage" class="page" data-title="Page not found"',
      'id="fallbackPage" data-role="page" data-title="Page not found"',
      'id="fallbackPage" data-role="page" class="page hide" data-title="Page not found"',
    ]) {
      const page = await open(t);
      page.goTo('#/jellypass/about');
      showFallback(page.document, { attrs });
      await page.settled();
      assert.equal(hosted(page), null, attrs);
      assert.equal(headerTitle(page), '', attrs);
      assert.equal(page.document.querySelector('[data-title]').getAttribute('data-title'), 'Page not found', attrs);
      if (attrs.startsWith('id=')) assert.ok(!hosting(page), `${attrs}: not hidden`);
    }
  });

  it('still draws when the header is not there (the desktop layout hides Jellyfin\'s own and has no title), setting the document\'s title', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await openJellyfinWeb(t, app);
    page.goTo('#/jellypass/about');
    showFallback(page.document);
    await page.settled();
    assert.ok(hosted(page));
    assert.equal(page.document.title, 'JellyPass');
  });

  it('cleans up when the route is left: to Home, to another page of Jellyfin web\'s, or to an address it has no page for', async (t) => {
    const page = await open(t);
    page.goTo('#/jellypass/about');
    showFallback(page.document);
    await page.settled();
    assert.ok(hosted(page));
    // Jellyfin web's router goes to another unknown address: it keeps the same fallback page.
    page.goTo('#/somewhere-else');
    await page.settled();
    assert.equal(hosted(page), null);
    assert.ok(!hosting(page), 'Jellyfin\'s own "Page not found" is shown again');
    // And back, then away to Home, where its page is gone.
    page.goTo('#/jellypass/about');
    await page.settled();
    assert.ok(hosted(page));
    page.goTo('#/home');
    leaveFallback(page.document);
    await page.settled();
    assert.equal(hosted(page), null);
    assert.ok(!hosting(page));
    // Home is Home again: the row is drawn by the add-on as before.
    page.home();
    page.shown();
    await page.settled();
    assert.equal(page.rows().length, 1);
  });

  it('draws the page again when Jellyfin web returns to it (history Back), on its new page', async (t) => {
    const page = await open(t);
    page.goTo('#/jellypass/about');
    showFallback(page.document);
    await page.settled();
    leaveFallback(page.document);
    page.goTo('#/details?id=abc');
    await page.settled();
    assert.equal(hosted(page), null);
    page.goTo('#/jellypass/about');
    showFallback(page.document);
    await page.settled();
    assert.equal(page.document.querySelectorAll('[data-jellypass-tv-page]').length, 1);
    assert.equal(headerTitle(page), 'JellyPass');
  });

  it('handles no key: Back is Jellyfin web\'s, and nothing is prevented or stopped', async (t) => {
    const page = await open(t);
    page.goTo('#/jellypass/about');
    showFallback(page.document);
    await page.settled();
    const link = page.document.querySelector('[data-jellypass-tv-page] a');
    assert.ok(link);
    link.focus();
    for (const keyCode of [461, 10009, 27, 8, 13, 37, 38, 39, 40]) {
      assert.equal(page.key(keyCode).defaultPrevented, false, `key ${keyCode}`);
    }
    // No key listener decides anything: each is capturing and passive (it can only watch), and the bundle never prevents or stops an event.
    for (const entry of page.listeners.filter((listener) => /^(?:keydown|keyup|keypress) /.test(listener))) assert.equal(entry, 'keydown {"capture":true,"passive":true}');
    const source = readFileSync(path.join(DIST_TV, SCRIPT), 'utf8');
    lacks(source, /\bpreventDefault\b|\bstopPropagation\b|\bstopImmediatePropagation\b/);
  });

  it('does nothing on Home\'s own address', async (t) => {
    const page = await open(t);
    page.home();
    await page.settled();
    page.goTo('#/home.html');
    await page.settled();
    assert.equal(hosted(page), null);
    assert.ok(!hosting(page));
  });
});

describe('TV add-on: the page host\'s router', { timeout: 60_000 }, () => {
  const TV_SRC = path.join(import.meta.dirname, '..', 'tv', 'src');
  const ENTRY = `
    import { FOCUS_ATTR, PageHost } from './page-host.ts';
    const log = [];
    window.__log = log;
    const host = new PageHost(document, () => location.hash);
    window.__host = host;
    host.register('/jellypass/item/:kind/:id', ({ document, container, params }) => {
      log.push('render ' + params.kind + '/' + params.id);
      const one = document.createElement('button');
      one.setAttribute(FOCUS_ATTR, 'one');
      const two = document.createElement('button');
      two.setAttribute(FOCUS_ATTR, 'two');
      container.appendChild(one);
      container.appendChild(two);
      return { title: 'Item ' + params.id, focus: one, cleanup: () => log.push('cleanup ' + params.kind + '/' + params.id) };
    });
    host.register('/jellypass/late/:id', (ctx) => {
      const a = document.createElement('button');
      a.setAttribute(FOCUS_ATTR, 'a');
      const b = document.createElement('button');
      b.setAttribute(FOCUS_ATTR, 'b');
      ctx.container.appendChild(a);
      ctx.container.appendChild(b);
      window.__ctx = ctx;
      window.__late = { a, b };
      return { title: 'Late' };
    });
    host.register('/jellypass/broken', () => { log.push('render broken'); throw new Error('boom'); });
    host.register('/jellypass/throws-on-leave', ({ container }) => ({ title: 'T', cleanup: () => { throw new Error('boom'); } }));
    document.addEventListener('focusin', (e) => host.focusIn(e), true);
    document.addEventListener('pageshow', (e) => host.pageShown(e), true);
  `;
  let code;
  const sandbox = async () => {
    if (!code) {
      const { build } = await import('esbuild');
      const result = await build({ stdin: { contents: ENTRY, resolveDir: TV_SRC, loader: 'ts' }, bundle: true, format: 'iife', target: 'es2017', write: false, logLevel: 'silent' });
      code = result.outputFiles[0].text;
    }
    const { document, Event, CustomEvent } = parseHTML('<html><body><div class="mainAnimatedPages"></div></body></html>');
    document.body.insertAdjacentHTML('afterbegin', HEADER);
    const location = { hash: '#/home' };
    const scope = { document, location, setTimeout, clearTimeout };
    scope.window = scope;
    vm.runInContext(code, vm.createContext(scope));
    const sync = (hash) => {
      location.hash = hash;
      scope.__host.update();
    };
    return {
      document,
      /** The page functions' log, copied out of the sandbox's realm. */
      get log() { return [...scope.__log]; },
      sync,
      /** The member pressing a key or pointer. */
      input: () => scope.__host.userInput(),
      focused: () => LIVE_FOCUS(document),
      /** What the \`late\` page was given and drew (set when it renders). */
      get ctx() { return scope.__ctx; },
      get late() { return scope.__late; },
      /** Jellyfin web showing its page: `pageshow` dispatched on it, then its auto-focus (the next effect, in the same task). */
      shown(pageEl, stealFocus) {
        pageEl.dispatchEvent(new CustomEvent('pageshow', { bubbles: true, detail: { isRestored: false } }));
        if (stealFocus) stealFocus.focus();
      },
    };
  };

  it('matches a pattern with :params, decoded, and gives the page its container, title and cleanup', async () => {
    const box = await sandbox();
    box.sync('#/jellypass/item/movie/12%2034?x=1');
    const fallback = showFallback(box.document);
    box.sync('#/jellypass/item/movie/12%2034?x=1');
    assert.deepEqual(box.log, ['render movie/12 34']);
    assert.equal(box.document.querySelector('.pageTitle').textContent, 'Item 12 34');
    box.sync('#/jellypass/item/movie');
    assert.deepEqual(box.log, ['render movie/12 34', 'cleanup movie/12 34']);
    assert.equal(box.document.querySelector('[data-jellypass-tv-page]'), null);
    assert.ok(fallback.querySelector('h1'), 'Jellyfin\'s own content is untouched');
    box.sync('#/jellypass/item/movie/%E0%A4%A');
    assert.equal(box.log.length, 2, 'a path that does not decode matches nothing');
  });

  it('renders once however often it is asked, and cleans up once when the page changes under it', async () => {
    const box = await sandbox();
    showFallback(box.document);
    for (let i = 0; i < 4; i += 1) box.sync('#/jellypass/item/tv/9');
    assert.deepEqual(box.log, ['render tv/9']);
    // The same fallback page, another JellyPass page: the first is cleaned up, the second drawn.
    box.sync('#/jellypass/item/tv/10');
    assert.deepEqual(box.log, ['render tv/9', 'cleanup tv/9', 'render tv/10']);
    assert.equal(box.document.querySelectorAll('[data-jellypass-tv-page]').length, 1);
    // Jellyfin web removes its page (a new route): cleaned up even though the address is still ours.
    leaveFallback(box.document);
    box.sync('#/jellypass/item/tv/10');
    assert.deepEqual(box.log.slice(-1), ['cleanup tv/10']);
  });

  it('restores focus to what had it when Back returns, else to the page\'s first element', async () => {
    const box = await sandbox();
    const first = showFallback(box.document);
    box.sync('#/jellypass/item/movie/1');
    assert.equal(box.focused().getAttribute('data-jellypass-tv-focus'), 'one', 'first time: the page\'s own');
    box.input();
    box.document.querySelectorAll('[data-jellypass-tv-focus]')[1].focus();
    // To a Jellyfin page, and Back: Jellyfin web draws a new fallback page.
    first.remove();
    box.sync('#/details?id=x');
    showFallback(box.document);
    box.sync('#/jellypass/item/movie/1');
    assert.equal(box.focused().getAttribute('data-jellypass-tv-focus'), 'two', 'back: where it was');
    // Another title has its own memory.
    box.sync('#/jellypass/item/movie/2');
    assert.equal(box.focused().getAttribute('data-jellypass-tv-focus'), 'one');
  });

  it('lets a page set the header\'s title once it knows it, only while it is the page shown', async () => {
    const box = await sandbox();
    const first = showFallback(box.document);
    box.sync('#/jellypass/late/1');
    assert.equal(headerTitleOf(box), 'Late');
    box.ctx.setTitle('Known');
    assert.equal(headerTitleOf(box), 'Known');
    assert.equal(box.document.title, 'Known');
    assert.equal(first.getAttribute('data-title'), 'Known', 'Jellyfin web\'s own pageshow would set the same');
    const ctx = box.ctx;
    // Left for another page: a late answer for the page that is gone sets nothing.
    first.remove();
    box.sync('#/details?id=x');
    ctx.setTitle('Stale');
    assert.notEqual(headerTitleOf(box), 'Stale');
    assert.notEqual(box.document.title, 'Stale');
  });

  it('focuses what a page asks for when it has drawn it, unless the member has pressed something or it was left from another element', async () => {
    const box = await sandbox();
    const first = showFallback(box.document);
    box.sync('#/jellypass/late/1');
    assert.equal(box.focused(), null, 'nothing is focused at first');
    box.ctx.focus(box.late.b);
    assert.equal(box.focused().getAttribute('data-jellypass-tv-focus'), 'b', 'the page\'s own choice');
    // The member presses a key: what the page asks for later is not theirs to take.
    box.input();
    box.late.a.focus();
    box.ctx.focus(box.late.b);
    assert.equal(box.focused().getAttribute('data-jellypass-tv-focus'), 'a', 'the member\'s focus stays');
    // Left from \`a\` and back: what had focus wins over what the page asks for.
    first.remove();
    box.sync('#/details?id=x');
    showFallback(box.document);
    box.sync('#/jellypass/late/1');
    box.ctx.focus(box.late.b);
    assert.equal(box.focused().getAttribute('data-jellypass-tv-focus'), 'a');
    // A page that asks for nothing is not given focus.
    const other = showFallback(box.document);
    box.sync('#/jellypass/late/2');
    box.input();
    box.ctx.focus(null);
    assert.equal(other.contains(box.focused()), false);
  });

  it('puts focus right once more after Jellyfin web\'s own auto-focus on pageshow, and only once', async () => {
    const box = await sandbox();
    const fallback = showFallback(box.document);
    box.sync('#/jellypass/item/movie/1');
    const outside = box.document.querySelector('.headerHomeButton');
    box.shown(fallback, outside);
    await pause(30);
    assert.equal(box.focused().getAttribute('data-jellypass-tv-focus'), 'one');
    // Later, the member moves on; a later pageshow does not pull focus back.
    outside.focus();
    box.shown(fallback, null);
    await pause(30);
    assert.equal(box.focused(), outside);
  });

  it('does not let Jellyfin web\'s programmatic focus replace the remembered element or cancel the correction', async () => {
    const box = await sandbox();
    const first = showFallback(box.document);
    box.sync('#/jellypass/item/movie/1');
    box.input();
    box.document.querySelectorAll('[data-jellypass-tv-focus]')[1].focus();
    first.remove();
    box.sync('#/details?id=x');
    const second = showFallback(box.document);
    box.sync('#/jellypass/item/movie/1');
    assert.equal(box.focused().getAttribute('data-jellypass-tv-focus'), 'two');
    // Jellyfin's pageshow auto-focus picks 'one' (inside the page): the correction still returns to 'two'.
    const one = box.document.querySelectorAll('[data-jellypass-tv-focus]')[0];
    box.shown(second, one);
    await pause(30);
    assert.equal(box.focused().getAttribute('data-jellypass-tv-focus'), 'two');
    // And 'two' is still what Back returns to.
    second.remove();
    box.sync('#/details?id=y');
    showFallback(box.document);
    box.sync('#/jellypass/item/movie/1');
    assert.equal(box.focused().getAttribute('data-jellypass-tv-focus'), 'two');
  });

  it('gives Jellyfin\'s title back when the host leaves a retained fallback page (about -> a genuine missing page)', async () => {
    const box = await sandbox();
    showFallback(box.document);
    box.sync('#/jellypass/item/movie/1');
    const fallback = box.document.getElementById('fallbackPage');
    assert.equal(fallback.getAttribute('data-title'), 'Item 1');
    assert.equal(box.document.title, 'Item 1');
    // Jellyfin web keeps the same fallback component for the next unknown route and does not run pageshow again.
    box.sync('#/genuine-missing');
    assert.equal(box.document.querySelector('[data-jellypass-tv-page]'), null);
    assert.equal(fallback.getAttribute('data-title'), 'Page not found');
    assert.equal(box.document.querySelector('.pageTitle').textContent, 'Page not found');
    assert.equal(box.document.title, 'Page not found');
  });

  it('shows Jellyfin\'s page as it is when a page fails to draw, and does not try again there', async () => {
    const box = await sandbox();
    showFallback(box.document);
    for (let i = 0; i < 3; i += 1) box.sync('#/jellypass/broken');
    assert.deepEqual(box.log, ['render broken']);
    assert.equal(box.document.querySelector('[data-jellypass-tv-page]'), null, 'its container is removed');
    assert.ok(!box.document.documentElement.classList.contains('jellypass-tv-hosting'));
    assert.equal(box.document.querySelector('.pageTitle').textContent, '');
  });

  it('is not stopped by a cleanup that throws', async () => {
    const box = await sandbox();
    showFallback(box.document);
    box.sync('#/jellypass/throws-on-leave');
    assert.ok(box.document.querySelector('[data-jellypass-tv-page]'));
    box.sync('#/jellypass/item/movie/3');
    assert.deepEqual(box.log, ['render movie/3']);
  });
});
