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

/** The objects the page's globals hang off (a reference through one, or through a name bound to one, is a reference to the global). */
const GLOBAL_OBJECTS = new Set(['window', 'self', 'globalThis', 'top', 'parent', 'frames']);
const typeofAbortController = (node) => node.type === 'UnaryExpression' && node.operator === 'typeof' && node.argument.type === 'Identifier' && node.argument.name === 'AbortController';
const isString = (node, text) => (node.type === 'Literal' && node.value === text) || (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis[0].value.cooked === text);
const namesAbortController = (node) => node.type === 'Identifier' ? node.name === 'AbortController' : node.type === 'Literal' || node.type === 'TemplateLiteral' ? isString(node, 'AbortController') : false;
/**
 * Whether `test` being true (`then`) or false (`otherwise`) proves AbortController exists: only a positive availability
 * check does (`typeof AbortController !== 'undefined'` or `=== 'function'`, `!` of the opposite, `&&` of one, `||` of one
 * the other way). An inverted check proves it in the other branch only, and anything unrecognised proves nothing.
 */
function availability(test) {
  const none = { then: false, otherwise: false };
  if (test.type === 'UnaryExpression' && test.operator === '!') {
    const inner = availability(test.argument);
    return { then: inner.otherwise, otherwise: inner.then };
  }
  if (test.type === 'LogicalExpression') {
    const left = availability(test.left);
    const right = availability(test.right);
    return test.operator === '&&' ? { then: left.then || right.then, otherwise: false } : test.operator === '||' ? { then: false, otherwise: left.otherwise || right.otherwise } : none;
  }
  if (test.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(test.operator)) {
    const [operand, text] = typeofAbortController(test.left) ? [test.left, test.right] : typeofAbortController(test.right) ? [test.right, test.left] : [];
    if (!operand) return none;
    const equal = test.operator === '===' || test.operator === '==';
    const present = isString(text, 'function') ? equal : isString(text, 'undefined') ? !equal : undefined;
    if (present === undefined) return none;
    return present ? { then: true, otherwise: false } : { then: false, otherwise: true };
  }
  return none;
}

/**
 * Every use of AbortController in `source` that is not (a) the operand of a `typeof`, or (b) reachable only where a
 * positive `typeof AbortController` check holds (an `if`/`?:` branch, or the right of `&&`/`||`); plus every way round
 * the name: a member named AbortController on anything (`window['AbortController']`, `self.AbortController`), a
 * destructured one (`const { AbortController } = window`), computed access to a global object, and names bound to one.
 */
function unguardedAbortControllers(source) {
  const found = [];
  const tree = parse(source, { ecmaVersion: 2017, sourceType: 'script' });
  const visit = (node, fn) => {
    if (!node || typeof node.type !== 'string') return;
    fn(node);
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) for (const one of child) visit(one, fn);
      else if (child && typeof child === 'object') visit(child, fn);
    }
  };
  // Names bound to a global object (`var w = window`), followed through further bindings in source order.
  const globals = new Set(GLOBAL_OBJECTS);
  const isGlobal = (node) => node && ((node.type === 'Identifier' && globals.has(node.name)) || (node.type === 'ThisExpression') || (node.type === 'SequenceExpression' && isGlobal(node.expressions[node.expressions.length - 1])) || (node.type === 'LogicalExpression' && (isGlobal(node.left) || isGlobal(node.right))) || (node.type === 'ConditionalExpression' && (isGlobal(node.consequent) || isGlobal(node.alternate))));
  visit(tree, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && isGlobal(node.init)) globals.add(node.id.name);
    if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && isGlobal(node.right)) globals.add(node.left.name);
  });
  const walk = (node, guarded) => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'Identifier' && node.name === 'AbortController' && !guarded) found.push(node.start);
    if (typeofAbortController(node)) return;
    if (node.type === 'MemberExpression') {
      const named = node.computed ? namesAbortController(node.property) : node.property.name === 'AbortController';
      // Computed access to a global object is not followed (what is looked up cannot be known); `this` is only a global outside functions, but is refused everywhere.
      if (named || (node.computed && isGlobal(node.object) && node.property.type !== 'Literal')) found.push(node.start);
    }
    if (node.type === 'ObjectPattern') {
      for (const one of node.properties) {
        if (one.type === 'RestElement' || (one.type === 'Property' && (namesAbortController(one.key) || one.computed))) found.push(one.start);
      }
    }
    if (node.type === 'IfStatement' || node.type === 'ConditionalExpression') {
      const proves = availability(node.test);
      walk(node.test, guarded);
      walk(node.consequent, guarded || proves.then);
      walk(node.alternate, guarded || proves.otherwise);
      return;
    }
    if (node.type === 'LogicalExpression' && (node.operator === '&&' || node.operator === '||')) {
      const proves = availability(node.left);
      walk(node.left, guarded);
      walk(node.right, guarded || (node.operator === '&&' ? proves.then : proves.otherwise));
      return;
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) for (const one of child) walk(one, guarded);
      else if (child && typeof child === 'object') walk(child, guarded);
    }
  };
  walk(tree, false);
  return found;
}

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
    for (const api of [/\breplaceChildren\b/, /\bResizeObserver\b/, /\bfromEntries\b/, /\.flatMap\(/, /\.flat\(/, /\bqueueMicrotask\b/, /\bstructuredClone\b/, /\brandomUUID\b/, /\.replaceAll\(/, /\.matchAll\(/, /\ballSettled\b/, /\bglobalThis\b/, /\.finally\(/, /\.at\(/, /\btoSorted\b/, /\bscrollTo\(\{/, /preventScroll/]) {
      lacks(source, api, `the bundle uses ${api}`);
    }
    // AbortController (Chromium 66) is only ever used where the browser has it: every use sits behind a `typeof` check.
    assert.deepEqual(unguardedAbortControllers(source), [], 'AbortController is feature-detected');
    // The gate itself: positive availability checks guard, in every form the product may take them.
    for (const accepted of [
      "var c = typeof AbortController === 'function' ? new AbortController() : void 0;",
      "var c = typeof AbortController !== 'undefined' ? new AbortController() : void 0;",
      "var c = typeof AbortController == 'function' ? new AbortController() : void 0;",
      "var c = 'function' === typeof AbortController ? new AbortController() : void 0;",
      "var c = typeof AbortController === 'undefined' ? void 0 : new AbortController();",
      "var c = typeof AbortController !== 'function' ? void 0 : new AbortController();",
      "var c = !(typeof AbortController === 'undefined') ? new AbortController() : void 0;",
      "if (typeof AbortController === 'function') { var c = new AbortController(); }",
      "if (typeof AbortController !== 'undefined') { var c = new AbortController(); } else { var d = 1; }",
      "if (typeof AbortController === 'undefined') { var d = 1; } else { var c = new AbortController(); }",
      "var c = typeof AbortController === 'function' && new AbortController();",
      "var c = typeof AbortController !== 'undefined' && ready && new AbortController();",
      "var c = typeof AbortController === 'undefined' || new AbortController();",
      "var c = typeof AbortController === 'function' && typeof x === 'function' ? new AbortController() : 0;",
    ]) assert.deepEqual(unguardedAbortControllers(accepted), [], accepted);
    // Inverted, partial or unrelated checks, and uses outside the branch, are found.
    for (const [rejected, why] of [
      ["var c = typeof AbortController === 'undefined' ? new AbortController() : void 0;", 'then-branch of an `=== undefined` check'],
      ["var c = typeof AbortController !== 'function' ? new AbortController() : void 0;", 'then-branch of a `!== function` check'],
      ["var c = typeof AbortController !== 'undefined' ? void 0 : new AbortController();", 'else-branch of a `!== undefined` check'],
      ["var c = typeof AbortController === 'function' ? 0 : new AbortController();", 'else-branch'],
      ["if (typeof AbortController === 'undefined') { var c = new AbortController(); }", 'if-branch of an `=== undefined` check'],
      ["if (typeof AbortController !== 'undefined') { } else { var c = new AbortController(); }", 'else-branch of an `if`'],
      ["var c = typeof AbortController === 'undefined' && new AbortController();", '`&&` after an `=== undefined` check'],
      ["var c = typeof AbortController !== 'undefined' || new AbortController();", '`||` after a `!== undefined` check'],
      ["var c = typeof AbortController === 'function' || ready ? new AbortController() : 0;", '`||` proves nothing in the then-branch'],
      ["var c = typeof AbortController ? new AbortController() : 0;", 'a bare typeof is not an availability check'],
      ["var c = typeof AbortController === 'object' ? new AbortController() : 0;", 'a typeof compared with something else'],
      ["var ok = typeof AbortController === 'function' ? 1 : 0; var c = new AbortController();", 'unguarded constructor, with a typeof elsewhere'],
      ["if (typeof AbortController === 'function') { } var c = new AbortController();", 'constructor after the guarded block'],
      ['var s = AbortController.prototype;', 'any other reference'],
      ["var c = typeof AbortController === 'function' ? window['AbortController'] : 0;", 'computed access, even guarded'],
      ["var c = window['AbortController'];", 'computed access'],
      ['var c = window.AbortController;', 'window.AbortController'],
      ['var c = self.AbortController;', 'self.AbortController'],
      ['var c = globalThis.AbortController;', 'globalThis.AbortController'],
      ['var c = new window.AbortController();', 'new window.AbortController'],
      ['const { AbortController } = window; var c = new AbortController();', 'destructured from window'],
      ["const { AbortController: AC } = self; var c = new AC();", 'renamed destructuring'],
      ["const { ['AbortController']: AC } = window; var c = new AC();", 'computed destructuring'],
      ['var w = window; var c = new w.AbortController();', 'an alias of window'],
      ["var w = window; var k = 'Abort' + 'Controller'; var c = new w[k]();", 'computed access through an alias'],
      ['var AC = window.AbortController; var c = new AC();', 'a name bound from window'],
      ["var c = typeof window.AbortController === 'function' ? new window.AbortController() : 0;", 'a member check is not a bare-name check'],
    ]) assert.ok(unguardedAbortControllers(rejected).length > 0, `${why}: ${rejected}`);
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
async function openJellyfinWeb(t, app, { user = ALICE, host = HOST_A, serverAddress = `https://${host}`, override, scopeExtras, startHash = '#/home.html' } = {}) {
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
  const location = { href: `https://${host}/web/${startHash}`, origin: `https://${host}`, hash: startHash };
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
    // Jellyfin web's history: Back is the trail's last address (nothing when the member has come from nowhere).
    history: { back: () => { if (trail.length > 0) page.back(); } },
    // A `Date` whose `now` is the test's clock (the add-on also builds dates, for the day a request was made).
    Date: class extends Date { static now() { return clock.now; } },
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
        const replaced = override ? await override(target.pathname, init, target) : undefined;
        if (replaced) return new Response(replaced.body, { status: replaced.status, headers: { 'content-type': 'application/json', ...replaced.headers } });
        const answer = await get(app.port, `${target.pathname}${target.search}`, { Host: target.host, ...init.headers }, { method: init.method ?? 'GET', body: init.body });
        return new Response(answer.body, { status: answer.status, headers: { 'content-type': answer.headers['content-type'] ?? 'application/json' } });
      } finally {
        pending -= 1;
      }
    },
  };
  scope.window = scope;
  Object.assign(scope, scopeExtras);
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
    cards: () => [...document.querySelectorAll('[data-jellypass-tv-row] button[data-tmdb-id]')],
    /** The Discover row's last card, "My requests" (not a title). */
    requestsLink: () => document.querySelector('[data-jellypass-tv-row] [data-jellypass-tv-link]'),
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
    // Jellyfin web sizes a row's cards on a TV by `.itemsContainer-tv > .overflowPortraitCard` (card.scss): the list has the class there only.
    for (const link of [desktop.rows()[0], tv.rows()[0]]) assert.equal(link.querySelector('.jellypass-tv-row-list').classList.contains('itemsContainer-tv'), link === tv.rows()[0]);
    assert.ok(tv.cards().every((card) => card.parentNode.classList.contains('itemsContainer-tv') && card.classList.contains('overflowPortraitCard') && card.getAttribute('style') === null));
    // Nothing left to show: no title cards, no second call, and only the "My requests" card in a small row of the same look.
    const empty = await withTrending(t, app, (results) => results.map((card, index) => ({ ...card, state: index % 2 ? 'requested' : 'in_library' })));
    assert.deepEqual([empty.rows().length, empty.requests.length, empty.cards().length], [1, 1, 0]);
    assert.equal(empty.document.querySelectorAll('.verticalSection').length, 4, 'Home itself is untouched, with the one row added');
  });

  describe('the fallback row (only the My requests card)', () => {
    const links = (page) => [...page.document.querySelectorAll('[data-jellypass-tv-link]')];
    const sameLook = (page) => page.rows()[0].className;

    it('is drawn, with the same look and place, when nothing is left to get, and nothing is asked for it', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const full = await withTrending(t, app, (results) => results);
      const empty = await withTrending(t, app, () => []);
      assert.equal(empty.rows().length, 1);
      assert.equal(sameLook(empty), sameLook(full));
      assert.equal(links(empty).length, 1);
      assert.equal(empty.cards().length, 0);
      assert.equal(empty.rows()[0].previousElementSibling === empty.document.querySelector('.verticalSection.section0'), true, 'after Home\'s first section, as the Discover row is');
      assert.equal(links(empty)[0].tagName, 'BUTTON');
      assert.equal(links(empty)[0].getAttribute('aria-label'), 'My requests');
      assert.equal(empty.requests.length, BUDGET.screens['tv-home-row'].calls, 'the budget is unchanged: one call, the Discover row\'s');
      // Choosing it opens the page, as the Discover row's end card does.
      const from = empty.location.hash;
      empty.click(links(empty)[0]);
      assert.equal(empty.location.hash, '#/jellypass/requests');
      assert.notEqual(empty.location.hash, from);
    });

    it('is drawn when the Discover row\'s load failed, and the next Home visit within a minute asks nothing', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const page = await openJellyfinWeb(t, app, { override: (pathname) => (pathname === '/jellypass/app/v1/discover/trending' ? { status: 500, body: '{}' } : undefined) });
      page.home();
      await page.settled();
      assert.deepEqual([page.rows().length, links(page).length, page.cards().length, page.requests.length], [1, 1, 0, 1]);
      page.home();
      await page.settled();
      assert.deepEqual([page.rows().length, page.requests.length], [1, 1]);
    });

    it('is never drawn with the Discover row: its own end card stays, and there is one row and one link', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const page = await withTrending(t, app, (results) => results);
      assert.deepEqual([page.rows().length, links(page).length], [1, 1]);
      assert.ok(page.cards().length > 0);
    });

    it('becomes the Discover row\'s end card and back as titles are asked for or run out, without a call', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const page = await withTrending(t, app, (results) => results.slice(0, 1).map((card) => ({ ...card, state: 'get_this' })));
      assert.deepEqual([page.cards().length, links(page).length], [1, 1]);
      const calls = page.requests.length;
      page.session.token = null;
      page.home();
      await page.settled();
      assert.deepEqual([page.rows().length, links(page).length], [0, 0], 'signed out: nothing left behind');
      assert.equal(page.requests.length, calls);
    });

    it('is drawn for no one signed out, nor on another member, and nothing is left behind', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const page = await withTrending(t, app, () => []);
      assert.equal(page.rows().length, 1);
      page.session.user = ANN;
      page.session.token = TOKENS[ANN];
      page.home();
      await page.settled();
      assert.equal(page.rows().length <= 1, true, 'never two rows');
      page.session.token = null;
      page.session.user = null;
      page.home();
      await page.settled();
      assert.deepEqual([page.rows().length, links(page).length], [0, 0]);
    });

    it('is not drawn, and asks nothing, until Jellyfin web\'s Home is laid out as expected', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const page = await openJellyfinWeb(t, app, { override: (pathname) => (pathname === '/jellypass/app/v1/discover/trending' ? { status: 200, body: JSON.stringify({ results: [] }) } : undefined) });
      await page.settled();
      assert.deepEqual([page.rows().length, links(page).length, page.requests.length], [0, 0, 0]);
    });
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

  it('fails closed: a refused token draws no row, and is not asked again until Home is next shown after a minute', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await openJellyfinWeb(t, app);
    page.session.token = 'not-a-token';
    page.home();
    await page.settled();
    assert.deepEqual([page.requests.length, page.rows().length, page.cards().length], [1, 0, 0], 'a refused token draws no row at all');
    page.home();
    page.shown();
    await page.settled();
    assert.equal(page.requests.length, 1);
    assert.deepEqual(page.document.querySelectorAll('.verticalSection').length, 3, 'Home itself is untouched, with no row added');
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

/**
 * The built stylesheet draws a focus ring on `image`, the image container of one of the add-on's cards, and not on Jellyfin's
 * own: a :focus rule with an inset box-shadow, 0.25em, white where no theme colour is set. Only booleans reach the assertions.
 */
function assertFocusRing(page, image, name) {
  const css = readFileSync(path.join(DIST_TV, STYLESHEET), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) => selectors.split(',').map((selector) => ({ selector: selector.trim(), body })));
  const asOn = (selector) => selector.replace(/::after/g, '').replace(/:focus/g, '');
  const jellyfins = page.document.createElement('button');
  jellyfins.className = 'card overflowPortraitCard card-hoverable';
  jellyfins.innerHTML = '<div class="cardBox"><div class="cardScalable"><div class="cardImageContainer coveredImage cardContent"></div></div></div>';
  page.document.body.appendChild(jellyfins);
  const drawn = (node) => rules.filter(({ selector, body }) => /:focus/.test(selector) && /box-shadow/.test(body) && node.matches(asOn(selector)));
  const ring = drawn(image);
  const others = drawn(jellyfins.querySelector('.cardImageContainer'));
  jellyfins.remove();
  assert.equal(ring.length >= 1, true, `a :focus rule draws a box-shadow on the ${name}`);
  assert.equal(others.length, 0, 'no ring rule reaches a card of Jellyfin\'s own');
  for (const { selector, body } of ring) {
    const shadows = body.match(/box-shadow:\s*[^;]+/g) ?? [];
    // Inside the card (Jellyfin's `.card` contains its paint: an outer ring is cut off in the desktop layout), at least 0.2em
    // thick, white where no theme colour is set: 15:1 on Jellyfin's near-black, above the 3:1 an indicator needs.
    assert.equal(shadows.every((shadow) => /inset\s+0\s+0\s+0\s+0?\.(?:2|25|3)\d*em\s+(?:#fff\b|var\(--jf-palette-text-primary,\s*#fff\))/.test(shadow)), true, 'the ring is an inset 0.25em white shadow');
    // The plain colour comes first, so a browser without var() keeps it.
    assert.equal(shadows.length === 2 && !/var\(/.test(shadows[0]) && /var\(/.test(shadows[1]), true, 'a fallback before the themed value');
    // Over a poster: a pseudo-element, which a child image does not hide.
    assert.equal(/::after/.test(selector), true, 'painted by a pseudo-element');
    // The pseudo-element exists and covers the whole image box, without taking a click or a touch from the card under it.
    assert.equal(/(?:^|;)\s*content:\s*(?:''|"")\s*(?:;|$)/.test(body), true, 'the pseudo-element has (empty) content, or it is not drawn');
    assert.equal(/(?:^|;)\s*position:\s*absolute\s*(?:;|$)/.test(body), true, 'positioned over the box');
    for (const side of ['top', 'right', 'bottom', 'left']) assert.equal(new RegExp(`(?:^|;)\\s*${side}:\\s*0(?:px)?\\s*(?:;|$)`).test(body), true, `offset ${side} is 0`);
    assert.equal(/(?:^|;)\s*pointer-events:\s*none\s*(?:;|$)/.test(body), true, 'the ring takes no pointer events');
  }
  // Only :focus (Chromium 63 has no :focus-visible).
  assert.equal(/:focus-visible/.test(css), false, 'no :focus-visible');
}

describe('TV add-on: the Search row', { timeout: 120_000 }, () => {
  const SEARCH = 'https://jelly-grove.example.test/jellypass/app/v1/search';
  const RESULTS = '<div class="searchResults padded-top padded-bottom-page"><div class="verticalSection"><h2 class="sectionTitle">Movies</h2><button type="button" class="card">In the library</button></div></div>';
  /** Jellyfin web's Search page (routes/search.tsx) mounted with `query` in its field, as its router does, Home hidden. */
  const mount = (page, query = '', { results = query ? RESULTS : '' } = {}) => {
    const { document } = page;
    document.getElementById('searchPage')?.remove();
    document.getElementById('indexPage').classList.add('hide');
    document.querySelector('.mainAnimatedPages').insertAdjacentHTML('beforeend', `<div id="searchPage" data-role="page" class="page mainAnimatedPage libraryPage allLibraryPage noSecondaryNavPage"><div class="padded-left padded-right searchFields"><div class="searchFieldsInner"><div class="inputContainer"><input id="searchTextInput" class="searchfields-txtSearch" type="text" value=""></div></div></div>${results}</div>`);
    const input = document.getElementById('searchTextInput');
    input.value = query;
    input.focus();
    document.getElementById('searchPage').dispatchEvent(new page.Event('viewshow', { bubbles: true }));
    return input;
  };
  /** The member typing: the field's value changes and `input` is dispatched, as a keyboard does. */
  const type = (page, text) => {
    const input = page.document.getElementById('searchTextInput');
    input.value = text;
    input.dispatchEvent(new page.Event('input', { bubbles: true }));
  };
  /** The field settled: Jellyfin web's debounce and ours have passed and the call has been answered. */
  const settle = async (page) => {
    await pause(600 + 120);
    await page.settled();
  };
  const searches = (page) => page.requests.map((request) => request.url).filter((url) => url.startsWith(SEARCH)).map((url) => decodeURIComponent(url.slice(SEARCH.length)));
  const row = (page) => page.document.querySelector('[data-jellypass-tv-search-row]');
  const titles = (page) => [...page.document.querySelectorAll('[data-jellypass-tv-search-row] .jellypass-tv-card-title')].map((node) => node.textContent);
  /** What the API answers for a search, the cards that can be had in its order. */
  const canBeHad = async (app, query) => (await app.get(`/jellypass/app/v1/search?q=${encodeURIComponent(query)}&page=1`)).json().results.slice(0, 20).filter((card) => card.state === 'get_this');
  const open = async (t, app, options) => {
    const page = await openJellyfinWeb(t, app, options);
    page.document.body.insertAdjacentHTML('afterbegin', HEADER);
    page.home();
    await page.settled();
    return page;
  };

  it('is written in the budget file: one call per settled query, the app\'s search without /me', () => {
    assert.deepEqual(BUDGET.screens['tv-search-row'], { calls: 1, atOnce: ['GET /search?q={query}&page=1'] });
    assert.ok(BUDGET.screens.search.atOnce.includes('GET /search?q={query}&page=1'));
  });

  it('draws one Discover row below Jellyfin\'s results with only what can be had, in the Home row\'s cards, in one call', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await open(t, app);
    mount(page, '');
    await page.settled();
    assert.equal(row(page), null, 'no row for an empty field');
    assert.deepEqual(searches(page), []);
    const calls = page.requests.length;

    type(page, 'synthetic');
    mount(page, 'synthetic');
    await settle(page);
    assert.deepEqual(searches(page), ['?q=synthetic&page=1']);
    assert.equal(page.requests.length - calls, BUDGET.screens['tv-search-row'].calls);
    const request = page.requests.at(-1);
    assert.equal(request.init.credentials, 'omit');
    assert.deepEqual({ ...request.init.headers }, { Accept: 'application/json', Authorization: `MediaBrowser Token="${TOKENS[ALICE]}"` });

    const shown = await canBeHad(app, 'synthetic');
    const all = (await app.get('/jellypass/app/v1/search?q=synthetic&page=1')).json().results;
    assert.ok(shown.length > 0 && all.length > shown.length, 'the answer holds titles that can\'t be had');
    assert.deepEqual(titles(page), shown.map((card) => card.title));
    const searchPage = page.document.getElementById('searchPage');
    assert.equal(searchPage.querySelectorAll('[data-jellypass-tv-search-row]').length, 1);
    assert.ok(row(page) === searchPage.lastElementChild, 'below Jellyfin\'s own results');
    assert.equal(row(page).querySelector('h2.sectionTitle').textContent, 'Discover');
    assert.ok(row(page).classList.contains('verticalSection'));
    // Never Jellyfin's itemsContainer (it is paused through a custom element's method), and Left/Right stay in the row.
    assert.equal(row(page).querySelector('.itemsContainer'), null);
    assert.ok(row(page).querySelector('.jellypass-tv-row-list').classList.contains('focuscontainer-x'));
    // Cards in Jellyfin web's own markup and classes (the next test compares them with the Home row's), no badge.
    const searchCard = row(page).querySelector('button');
    for (const name of ['card', 'overflowPortraitCard', 'card-hoverable', 'jellypass-tv-card']) assert.ok(searchCard.classList.contains(name), name);
    assert.ok(searchCard.querySelector('.cardBox .cardScalable .cardPadder-overflowPortrait') && searchCard.querySelector('.cardImageContainer img'));
    assert.equal(searchCard.getAttribute('aria-label').split(', ').pop(), 'Available to get');
    assert.equal(page.document.querySelectorAll('.jellypass-tv-card-status').length, 0);
    assert.deepEqual([...row(page).querySelectorAll('img')].map((img) => img.getAttribute('src')), shown.map((card) => card.posterUrl));
    assertFocusRing(page, searchCard.querySelector('.cardImageContainer'), 'Search title card');
  });

  it('draws a Home card and a Search card from one component: the same markup for the same title', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await open(t, app);
    const home = page.cards()[0].outerHTML;
    const first = (await canBeHad(app, 'x'))[0];
    const trending = (await app.get('/jellypass/app/v1/discover/trending')).json().results[0];
    assert.equal(first.tmdbId, trending.tmdbId, 'the fake answers both with the same titles');
    mount(page, 'x');
    await settle(page);
    assert.equal(row(page).querySelector('button').outerHTML, home);
  });

  it('asks nothing while the field is empty or blank, and once per settled query however many keys were pressed', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await open(t, app);
    mount(page, '');
    type(page, '   ');
    await settle(page);
    assert.deepEqual(searches(page), []);
    // Keys within the debounce are one query.
    for (const text of ['d', 'du', 'dun', 'dune']) {
      type(page, text);
      await pause(100);
    }
    assert.deepEqual(searches(page), [], 'asked before the field was still');
    await settle(page);
    assert.deepEqual(searches(page), ['?q=dune&page=1']);
    // The same words typed again, and surrounding blanks, ask nothing more.
    type(page, ' dune ');
    await settle(page);
    assert.deepEqual(searches(page), ['?q=dune&page=1']);
    assert.equal(titles(page).length > 0, true);
  });

  it('takes the row away as soon as the words change and cancels what is out for them, dropping its answer', async (t) => {
    const aborted = [];
    class Controller {
      constructor() { this.signal = { aborted: false }; aborted.push(this.signal); }
      abort() { this.signal.aborted = true; }
    }
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const app = await startApp(t, webWorld(), tvOn());
    const real = (await app.get('/jellypass/app/v1/search?q=a&page=1')).json();
    const page = await open(t, app, {
      scopeExtras: { AbortController: Controller },
      override: async (pathname, init) => {
        if (!pathname.endsWith('/search')) return undefined;
        const query = new URL(page.requests.at(-1).url).searchParams.get('q');
        if (query === 'slow') {
          await held;
          return { status: 200, body: JSON.stringify({ ...real, results: real.results.slice(0, 2).map((card) => ({ ...card, title: 'STALE', state: 'get_this' })) }) };
        }
        return undefined;
      },
    });
    mount(page, 'quick');
    await settle(page);
    assert.ok(row(page));
    type(page, 'slow');
    assert.equal(row(page), null, 'the old words\' row goes at once');
    await settle(page);
    // Held in flight; the member types on.
    page.advance(1000);
    assert.deepEqual(searches(page), ['?q=quick&page=1', '?q=slow&page=1']);
    assert.equal(aborted.length, 2);
    assert.equal(aborted[1].aborted, false);
    type(page, 'fresh');
    assert.equal(aborted[1].aborted, true, 'cancelled');
    release();
    await page.settled();
    assert.deepEqual(titles(page), [], 'the stale answer is not drawn');
    assert.equal(page.document.body.textContent.includes('STALE'), false);
    // The new words are asked at least a second after the last call.
    assert.deepEqual(searches(page), ['?q=quick&page=1', '?q=slow&page=1']);
    page.advance(1000);
    await page.settled();
    assert.deepEqual(searches(page), ['?q=quick&page=1', '?q=slow&page=1', '?q=fresh&page=1']);
    assert.ok(titles(page).length > 0);
  });

  it('drops a stale answer even where the browser has no AbortController, and cancels nothing there', async (t) => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const app = await startApp(t, webWorld(), tvOn());
    const page = await open(t, app, { override: async (pathname) => (pathname.endsWith('/search') && new URL(page.requests.at(-1).url).searchParams.get('q') === 'slow' ? (await held, { status: 200, body: JSON.stringify({ results: [{ mediaType: 'movie', tmdbId: 7, title: 'STALE', year: 2020, posterUrl: null, state: 'get_this' }] }) }) : undefined) });
    mount(page, 'slow');
    await pause(600 + 120);
    assert.equal(page.requests.at(-1).init.signal, undefined, 'asked, and held in flight');
    type(page, 'other');
    release();
    await page.settled();
    assert.equal(page.document.body.textContent.includes('STALE'), false);
  });

  it('draws nothing when nothing can be had or the call failed, and asks the same words only once', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const none = JSON.stringify({ results: (await app.get('/jellypass/app/v1/search?q=a&page=1')).json().results.map((card) => ({ ...card, state: card.state === 'get_this' ? 'requested' : card.state })) });
    let mode = 'none';
    const page = await open(t, app, { override: (pathname) => (pathname.endsWith('/search') ? (mode === 'none' ? { status: 200, body: none } : mode === 'garbage' ? { status: 200, body: '[]' } : { status: 500, body: '{}' }) : undefined) });
    mount(page, 'one');
    await settle(page);
    assert.deepEqual([row(page), searches(page).length], [null, 1], 'all Requested, in the library or not for sale: no row');
    mode = 'garbage';
    type(page, 'two');
    page.advance(1000);
    await settle(page);
    mode = 'error';
    type(page, 'three');
    page.advance(1000);
    await settle(page);
    assert.deepEqual([row(page), searches(page).length], [null, 3]);
    // A failure is kept like an answer: more page changes ask nothing.
    page.document.getElementById('searchPage').insertAdjacentHTML('beforeend', '<div>more</div>');
    await settle(page);
    assert.equal(searches(page).length, 3);
  });

  it('waits out a 429 for as long as the server asked, then asks only for new words', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    let limited = true;
    const page = await open(t, app, { override: (pathname) => (pathname.endsWith('/search') && limited ? { status: 429, body: '{}', headers: { 'retry-after': '45' } } : undefined) });
    mount(page, 'busy');
    await settle(page);
    assert.deepEqual([row(page), searches(page).length], [null, 1]);
    limited = false;
    type(page, 'busier');
    await settle(page);
    page.advance(30_000);
    await page.settled();
    assert.equal(searches(page).length, 1, 'still within the 45 seconds the server asked for');
    page.advance(15_000);
    await page.settled();
    assert.deepEqual(searches(page), ['?q=busy&page=1', '?q=busier&page=1']);
    assert.ok(titles(page).length > 0);
  });

  it('keeps several answers: alpha, beta, alpha asks twice', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await open(t, app);
    mount(page, 'alpha');
    await settle(page);
    type(page, 'beta');
    page.advance(1000);
    await settle(page);
    type(page, 'alpha');
    await settle(page);
    assert.deepEqual(searches(page), ['?q=alpha&page=1', '?q=beta&page=1'], 'alpha is answered from memory');
    assert.ok(titles(page).length > 0, 'and drawn');
  });

  it('keeps no more than 20 answers: the least recently used is asked for again', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await open(t, app);
    mount(page, 'w0');
    await settle(page);
    for (let i = 1; i <= 20; i += 1) {
      type(page, `w${i}`);
      page.advance(1000);
      await settle(page);
    }
    type(page, 'w0');
    page.advance(1000);
    await settle(page);
    assert.equal(searches(page).length, 22, 'w0 was the 21st answer back: dropped');
    type(page, 'w20');
    page.advance(1000);
    await settle(page);
    assert.equal(searches(page).length, 22, 'a recent one is still kept');
  });

  it('honours a 429 that comes back for words already left: the next search waits for what the server asked', async (t) => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const app = await startApp(t, webWorld(), tvOn());
    const page = await open(t, app, {
      override: async (pathname) => {
        if (!pathname.endsWith('/search')) return undefined;
        if (new URL(page.requests.at(-1).url).searchParams.get('q') === 'slow') {
          await held;
          return { status: 429, body: '{}', headers: { 'retry-after': '45' } };
        }
        return undefined;
      },
    });
    mount(page, 'slow');
    await pause(600 + 120);
    type(page, 'fresh');
    release();
    await page.settled();
    assert.equal(page.document.body.textContent.includes('STALE'), false);
    page.advance(30_000);
    await page.settled();
    assert.deepEqual(searches(page), ['?q=slow&page=1'], 'still within the 45 seconds');
    page.advance(15_000);
    await page.settled();
    assert.deepEqual(searches(page), ['?q=slow&page=1', '?q=fresh&page=1']);
  });

  it('opens the title page from a card and returns on Back to the query and the card, with no new call', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await open(t, app);
    mount(page, 'synthetic');
    await settle(page);
    const shown = await canBeHad(app, 'synthetic');
    const target = shown[shown.length - 1];
    const card = row(page).querySelector(`button[data-tmdb-id="${target.tmdbId}"]`);
    const from = '#/search?query=synthetic';
    page.location.hash = from;
    page.click(card);
    assert.equal(page.location.hash, `#/jellypass/title/${target.mediaType}/${target.tmdbId}`);
    page.document.getElementById('searchPage').remove();
    page.follow(from);
    await page.settled();
    assert.ok(page.view(), 'the title page is open');
    assert.equal(row(page), null);
    page.back();
    assert.equal(page.location.hash, from);
    mount(page, 'synthetic');
    await page.settled();
    assert.equal(page.view(), null);
    assert.deepEqual(searches(page), ['?q=synthetic&page=1'], 'the same words are not asked again');
    assert.equal(titles(page).length, shown.length);
    assert.ok(page.focused() === page.document.querySelector(`[data-jellypass-tv-search-row] button[data-tmdb-id="${target.tmdbId}"]`), 'focus is on the card');
    assert.equal(page.document.getElementById('searchTextInput').value, 'synthetic');
  });

  it('leaves focus to the member once they press a key after Back', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await open(t, app);
    mount(page, 'synthetic');
    await settle(page);
    const card = row(page).querySelector('button');
    page.location.hash = '#/search?query=synthetic';
    page.click(card);
    page.document.getElementById('searchPage').remove();
    page.follow('#/search?query=synthetic');
    await page.settled();
    page.back();
    const input = mount(page, 'synthetic');
    page.key(40);
    input.focus();
    await page.settled();
    assert.ok(page.focused() === input, 'the field keeps the focus the member had');
  });

  it('handles no key and adds only passive capturing listeners (the focus manager moves between the cards)', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await open(t, app);
    mount(page, 'synthetic');
    await settle(page);
    for (const keyCode of [461, 10009, 27, 8, 37, 38, 39, 40, 13]) assert.equal(page.key(keyCode).defaultPrevented, false, `${keyCode}`);
    for (const listener of page.listeners) assert.ok(listener.endsWith('{"capture":true,"passive":true}'), listener);
  });

  it('draws nothing and asks nothing when Jellyfin web\'s Search page is not as expected', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    for (const [name, change] of [
      ['no field', (page) => page.document.getElementById('searchTextInput').remove()],
      ['another field id', (page) => page.document.getElementById('searchTextInput').setAttribute('id', 'q')],
      ['not a page', (page) => page.document.getElementById('searchPage').setAttribute('data-role', 'dialog')],
      ['hidden', (page) => page.document.getElementById('searchPage').classList.add('hide')],
      ['field outside the fields', (page) => page.document.getElementById('searchPage').appendChild(page.document.getElementById('searchTextInput'))],
    ]) {
      const page = await open(t, app);
      const input = mount(page, 'synthetic');
      change(page);
      input.value = 'synthetic again';
      input.dispatchEvent(new page.Event('input', { bubbles: true }));
      await settle(page);
      assert.deepEqual([name, searches(page), row(page)], [name, [], null]);
    }
  });

  it('removes the row and asks nothing when the page is left, and draws nothing on another page', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await open(t, app);
    mount(page, 'synthetic');
    await settle(page);
    assert.ok(row(page));
    type(page, 'synthetic two');
    page.document.getElementById('searchPage').remove();
    page.home();
    await settle(page);
    assert.deepEqual(searches(page), ['?q=synthetic&page=1'], 'the pending words were never asked');
    assert.equal(row(page), null);
    // Clearing the field takes the row away and asks nothing.
    mount(page, 'synthetic');
    await page.settled();
    type(page, '');
    await settle(page);
    assert.equal(row(page), null);
  });

  it('follows the member signed in: signed out or signed in elsewhere there is no row and no call, and another member asks with their token', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await open(t, app);
    mount(page, 'synthetic');
    await settle(page);
    assert.ok(row(page));
    page.session.user = ANN;
    page.session.token = TOKENS[ANN];
    type(page, 'synthetic');
    assert.equal(row(page), null, 'the member before\'s row goes at once');
    page.advance(1000);
    await settle(page);
    assert.equal(searches(page).length, 2, 'another member\'s words are asked for with their own token');
    assert.equal(page.requests.at(-1).init.headers.Authorization, `MediaBrowser Token="${TOKENS[ANN]}"`);
    page.session.token = null;
    type(page, 'something else');
    await settle(page);
    assert.deepEqual([row(page), searches(page).length], [null, 2]);
    page.session.token = TOKENS[ALICE];
    page.session.user = ALICE;
    page.session.serverAddress = 'https://elsewhere.example.test';
    type(page, 'something');
    await settle(page);
    assert.deepEqual([row(page), searches(page).length], [null, 2]);
    assert.ok(page.requests.every((request) => request.url.startsWith('https://jelly-grove.example.test/')), 'never sent elsewhere');
  });

  /** Caches `synthetic`, leaves Search, and applies `away` while the page is absent; then back on Search, the calls made. */
  const awayAndBack = async (t, away, back) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await open(t, app);
    mount(page, 'synthetic');
    await settle(page);
    assert.deepEqual(searches(page), ['?q=synthetic&page=1']);
    page.document.getElementById('searchPage').remove();
    page.home();
    await page.settled();
    away(page);
    // Something happens on the page (as it does all the time): update() runs with Search absent.
    page.document.body.insertAdjacentHTML('beforeend', '<div></div>');
    await page.settled();
    back(page);
    page.advance(1000);
    mount(page, 'synthetic');
    await settle(page);
    return searches(page);
  };

  it('forgets the answers when the member signs out while Search is absent: the same member signing back in asks again', async (t) => {
    const calls = await awayAndBack(t, (page) => { page.session.token = null; }, (page) => { page.session.token = TOKENS[ALICE]; });
    assert.deepEqual(calls, ['?q=synthetic&page=1', '?q=synthetic&page=1']);
  });

  it('forgets the answers when another member is signed in while Search is absent, even if the first member returns', async (t) => {
    const calls = await awayAndBack(t, (page) => { page.session.user = ANN; page.session.token = TOKENS[ANN]; }, (page) => { page.session.user = ALICE; page.session.token = TOKENS[ALICE]; });
    assert.deepEqual(calls, ['?q=synthetic&page=1', '?q=synthetic&page=1']);
  });

  it('keeps the answers while the same member stays signed in and Search is absent', async (t) => {
    const calls = await awayAndBack(t, () => {}, () => {});
    assert.deepEqual(calls, ['?q=synthetic&page=1']);
  });

  it('draws a title the member asked for as gone, and a Requested that ran out as back, with no call', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await open(t, app);
    mount(page, 'synthetic');
    await settle(page);
    const before = titles(page);
    assert.ok(before.length > 1);
    const calls = page.requests.length;
    page.document.getElementById('searchPage').insertAdjacentHTML('beforeend', '<div></div>');
    await page.settled();
    assert.deepEqual([titles(page), page.requests.length], [before, calls], 'redrawn pages change nothing');
  });

  it('is byte-for-byte the same whatever other households hold or asked for: the calls and the row', async (t) => {
    const snapshot = async (state) => {
      const app = await startApp(t, Object.assign(state, { webPage: {} }), tvOn());
      const page = await open(t, app);
      mount(page, 'synthetic');
      await settle(page);
      assert.ok(row(page));
      assertNoCanaries(row(page).outerHTML, 'the row shows Seerr data planted as a canary');
      assertNoCanaries(page.document.body.outerHTML, 'the page holds Seerr data planted as a canary');
      return JSON.stringify({ trace: page.trace(), row: row(page).outerHTML });
    };
    const baseline = await snapshot(world());
    for (const [name, state] of Object.entries(otherHouseholdWorlds())) assert.ok(await snapshot(state) === baseline, name);
  });

  it('sets text with textContent only: a title that is markup stays text', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const evil = '<img src=x onerror=alert(1)><b>bold</b>';
    const real = (await app.get('/jellypass/app/v1/search?q=a&page=1')).json();
    const page = await open(t, app, { override: (pathname) => (pathname.endsWith('/search') ? { status: 200, body: JSON.stringify({ ...real, results: real.results.map((card) => ({ ...card, state: 'get_this', title: evil, posterUrl: 'https://evil.example.test/x.jpg' })) }) } : undefined) });
    mount(page, 'a');
    await settle(page);
    assert.ok(titles(page).every((title) => title === evil));
    assert.equal(row(page).querySelectorAll('b').length, 0);
    assert.equal(row(page).querySelectorAll('img').length, 0, 'only a TMDB image is ever drawn');
  });
});

describe('TV add-on: the title page and "Get this"', { timeout: 120_000 }, () => {
  const CONFIRMATION = "Thanks — we'll get this for your household.";
  const text = (page, selector) => page.view()?.querySelector(selector)?.textContent ?? null;
  // (Not interested is the title page's one more button on a server with hiding; the hiding tests are their own.)
  const buttons = (page) => [...page.view().querySelectorAll('button:not(.jellypass-tv-title-hide)')].map((button) => `${button.textContent}${button.disabled ? ' (disabled)' : ''}`);
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
    // The My requests page's own (tv/src/requests.ts): it is neither the title page nor the row.
    const isRequests = (name) => /^jellypass-tv-(?:requests?|hidden|views?)(?:-|$)/.test(name);
    // The service and studio pages (tv/src/discover-source.ts) are the Discover page's family: they share its classes.
    const isDiscover = (name) => /^jellypass-tv-(?:discover|source)(?:-|$)/.test(name);
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
    // Every selector in the built stylesheet names classes of one of the three only (the page host's are `jellypass-tv-hosting` and its Back button's `jellypass-tv-back*`).
    const isHost = (name) => name === 'jellypass-tv-hosting' || name.startsWith('jellypass-tv-back');
    const mixed = rules.map(({ selector }) => selector).filter((selector) => {
      const names = (selector.match(/\.jellypass-tv[a-z0-9_-]*/g) ?? []).map((name) => name.slice(1));
      assert.ok(names.length > 0, selector);
      return !(names.every(isRow) || names.every(isView) || names.every(isRequests) || names.every(isDiscover) || names.every(isHost));
    });
    assert.deepEqual(mixed, [], 'selectors outside, or across, the row, the pages and the page host');
    // The old overlay is gone: no stacking rules, no overlay box, and nothing keyed on Jellyfin's backdrop setting.
    // The one stacking rule is the desktop Back button's bar, which must sit above the title page's fixed backdrop.
    assert.deepEqual(rules.filter(({ body }) => /z-index/.test(body)).map(({ selector }) => selector), ['.jellypass-tv-back-bar'], 'stacking rules');
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
    assert.equal(text(page, '.jellypass-tv-title-note'), 'Follow it in My requests.');
    assert.deepEqual(buttons(page), ['My requests'], 'nothing left that could send again');
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
    assert.deepEqual(buttons(page), ['My requests']);
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

  /** A title page open as Alice with her Get this call held (the server's Seerr record is held too, so every read says get_this). */
  const holdingGet = async (t, status = undefined) => {
    const app = await startHeld(t);
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    t.after(() => release());
    const override = async (pathname, init) => {
      // The server knows one token per member: the new session's calls are let through as Alice's.
      if (init.headers?.Authorization?.includes('a-new-token-for-alice')) init.headers = { ...init.headers, Authorization: init.headers.Authorization.replace('a-new-token-for-alice', TOKENS[ALICE]) };
      if (init.method !== 'POST' || !pathname.endsWith('/get')) return undefined;
      await held;
      return status ? { status, body: '{"error":"private"}' } : undefined;
    };
    const page = await atHome(t, app, { override });
    await choose(page, T_MOVIE);
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await pause(40);
    return { app, page, release };
  };
  /** Leaves the page, signs out, signs back in as the same member with a new token (the page has seen each step). */
  const signInAgain = async (page) => {
    page.route('#/details?id=someitem');
    await pause(40);
    page.session.token = null;
    page.session.user = null;
    page.document.body.insertAdjacentHTML('beforeend', '<i></i>');
    await pause(40);
    page.session.user = ALICE;
    page.session.token = 'a-new-token-for-alice';
    page.document.body.insertAdjacentHTML('beforeend', '<i></i>');
    await pause(40);
  };

  it('drops a Get this accepted after a sign-out and a new sign-in as the same member: the new session shows the server\'s word', async (t) => {
    const { app, page, release } = await holdingGet(t);
    await signInAgain(page);
    release();
    await page.settled();
    await pause(40);
    // Back to the title's page, which is read afresh for the new session; then Home.
    page.back();
    await page.settled();
    assert.equal(text(page, '.jellypass-tv-title-status'), 'Available to get', 'the old session\'s Get this does not mark the new session as Requested');
    assert.deepEqual(buttons(page), ['Get this']);
    await home(page);
    assert.equal(onRow(page, T_MOVIE), 'Available to get');
    await app.background.settled();
  });

  it('drops a Get this accepted after a new token with no sign-out between', async (t) => {
    const { page, release } = await holdingGet(t);
    page.session.token = 'a-new-token-for-alice';
    release();
    await page.settled();
    await pause(40);
    page.back();
    await page.settled();
    assert.equal(onRow(page, T_MOVIE), 'Available to get');
  });

  for (const status of [401, 429, 502]) {
    it(`ignores a Get this that fails with ${status} after a new token: the new session's overlay, page and host are untouched`, async (t) => {
      const { page, release } = await holdingGet(t, status);
      page.session.token = 'a-new-token-for-alice';
      release();
      await page.settled();
      await pause(40);
      assert.equal(text(page, '.jellypass-tv-title-error'), null, 'no error for a call the new session did not make');
      assert.notEqual(text(page, '.jellypass-tv-title-note'), 'Sign in to continue');
      assert.equal(text(page, '.jellypass-tv-title-status'), 'Available to get');
      assert.deepEqual(buttons(page), ['Get this'], 'the page is read again for the new session');
    });
  }

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
    assert.deepEqual(buttons(page), ['My requests']);
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
    assert.deepEqual(buttons(page), ['My requests', 'Try again'], 'nothing that sends');
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

  /** Trending answering one title only, Available to get. */
  const soleTitle = (app) => async (pathname) => {
    if (pathname !== '/jellypass/app/v1/discover/trending') return undefined;
    const real = (await app.get(pathname)).json();
    const only = real.results.find((card) => card.tmdbId === T_MOVIE);
    return { status: 200, body: JSON.stringify({ ...real, results: [{ ...only, state: 'get_this' }] }) };
  };

  it('gives focus to the My requests card on returning Home when the title opened has left the row', async (t) => {
    const app = await startHeld(t);
    const trending = await soleTitle(app)('/jellypass/app/v1/discover/trending');
    const page = await atHome(t, app, { override: (pathname) => (pathname === '/jellypass/app/v1/discover/trending' ? trending : undefined) });
    assert.equal(page.cards().length, 1);
    await choose(page, T_MOVIE);
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    await home(page);
    assert.equal(page.cards().length, 0, 'only the My requests card is left');
    assert.equal(page.requestsLink() !== null, true);
    assert.equal(page.focused() === page.requestsLink(), true, 'the link has focus');
  });

  it('keeps focus on the My requests card when the row is drawn again under it', async (t) => {
    const app = await startHeld(t);
    const page = await atHome(t, app);
    await choose(page, T_MOVIE);
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    await home(page);
    assert.equal(onRow(page, T_MOVIE), 'not in the row');
    page.requestsLink().focus();
    assert.equal(page.focused() === page.requestsLink(), true);
    page.advance(120_000); // the Requested runs out: the title is back in the row, which is drawn again
    assert.equal(onRow(page, T_MOVIE), 'Available to get');
    assert.equal(page.focused() === page.requestsLink(), true, 'the link still has focus');
    assert.equal(page.document.documentElement.contains(page.focused()), true, 'and is in the page');
  });

  it('moves focus to the My requests card, never off the page, when a redraw removes the only title card that has it', async (t) => {
    const app = await startHeld(t);
    let gone = false;
    const page = await atHome(t, app, {
      override: async (pathname) => {
        if (pathname !== '/jellypass/app/v1/discover/trending') return undefined;
        const real = (await app.get(pathname)).json();
        const only = real.results.find((card) => card.tmdbId === T_MOVIE);
        return { status: 200, body: JSON.stringify({ ...real, results: gone ? [] : [{ ...only, state: 'get_this' }] }) };
      },
    });
    assert.equal(page.cards().length, 1);
    page.card(T_MOVIE).focus();
    assert.equal(page.focused() === page.card(T_MOVIE), true, 'the only title card has focus');
    // The title leaves the answer (asked for elsewhere); Home is shown again after the answer is old: the row is drawn again.
    gone = true;
    page.advance(60_001); // the row's REUSE_MS
    page.shown();
    await page.settled();
    assert.equal(page.cards().length, 0, 'the title card is gone');
    assert.equal(page.requestsLink() !== null, true, 'the My requests card is drawn');
    assert.equal(page.focused() === page.requestsLink(), true, 'the My requests card has focus');
    assert.equal(page.document.documentElement.contains(page.focused()), true, 'and it is in the page');
  });

  it('draws a ring on the focused My requests card and on a Discover title card in the stylesheet: inside, from :focus, in the page\'s text colour', async (t) => {
    const page = await atHome(t, await startApp(t, webWorld(), tvOn()));
    const face = page.requestsLink().querySelector('.jellypass-tv-card-link-face');
    assert.equal(face !== null, true, 'the card has its face');
    assertFocusRing(page, face, 'My requests face');
    assertFocusRing(page, page.card(T_MOVIE).querySelector('.cardImageContainer'), 'Home title card');
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
    assert.deepEqual(types, ['focusin', 'input', 'keydown', 'mousedown', 'pageshow', 'pointerdown', 'touchstart', 'viewshow']);
    // The host's document listeners, the search field's input one included, are explicitly capturing and passive: they only observe.
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

describe('TV add-on: My requests', { timeout: 180_000 }, () => {
  const A = 'AAAAAAAAAAAAAAAAAAAAAA';
  const B = 'BBBBBBBBBBBBBBBBBBBBBB';
  const json = (body, status = 200) => ({ status, body: JSON.stringify(body) });
  const entry = (id, tmdbId, extras = {}) => ({ id, mediaType: tmdbId === T_TV ? 'tv' : 'movie', tmdbId, status: 'requested', seasons: [], byYou: true, ...extras });
  const tvEntry = (id, tmdbId, seasons, extras = {}) => ({ id, mediaType: 'tv', tmdbId, status: 'requested', seasons: seasons.map(([seasonNumber, status]) => ({ seasonNumber, status })), byYou: true, ...extras });
  const tmdbOf = (n) => 910_000 + n;
  /** A server whose list is `state.list` and whose cancel answers `state.cancel` (and takes the entry off the list when it is 202). */
  const server = (state) => async (pathname, init) => {
    if (pathname === '/jellypass/app/v1/requests' && (init.method ?? 'GET') === 'GET') {
      state.reads = (state.reads ?? 0) + 1;
      const failure = state.listFails?.(state.reads);
      if (failure) return failure;
      return json({ results: state.list });
    }
    if (init.method === 'POST' && /\/requests\/[A-Za-z0-9_-]{22}\/cancel$/.test(pathname)) {
      state.posts.push({ pathname, body: init.body, headers: { ...init.headers } });
      if (state.hold) await state.hold;
      if (state.cancel === 'offline') throw new TypeError('Failed to fetch');
      if (state.cancel === 202) {
        state.list = state.list.filter((item) => !pathname.includes(item.id));
        return json({ status: 'accepted' }, 202);
      }
      return { status: state.cancel, body: '{"error":"upstream said something private"}' };
    }
    if (state.titles && /^\/jellypass\/app\/v1\/(?:movie|tv)\/[0-9]+$/.test(pathname)) return state.titles(pathname);
    return state.other?.(pathname, init);
  };
  const open = async (t, app, state, options) => {
    state.posts ??= [];
    const page = await openJellyfinWeb(t, app, { override: server(state), ...options });
    page.document.body.insertAdjacentHTML('afterbegin', HEADER);
    page.home();
    await page.settled();
    return page;
  };
  /** Jellyfin web's router showing My requests (as a card or link opens it). */
  const goToRequests = async (page) => {
    page.route('#/jellypass/requests');
    await page.settled();
  };
  const root = (page) => page.document.querySelector('[data-jellypass-tv-requests]');
  const items = (page) => [...page.document.querySelectorAll('.jellypass-tv-request')];
  const shown = (page) => items(page).filter((item) => !item.hidden);
  const part = (item, selector) => item.querySelector(selector)?.textContent ?? null;
  const pills = (item) => [...item.querySelectorAll('.jellypass-tv-request-pill')].map((pill) => pill.textContent);
  const names = (page) => shown(page).map((item) => part(item, '.jellypass-tv-request-name'));
  const openButton = (item) => item.querySelector('.jellypass-tv-request-open');
  const chip = (page, group, value) => page.document.querySelector(`.jellypass-tv-requests-chip[data-filter-group="${group}"][data-filter="${value}"]`);
  const pressed = (page) => [...page.document.querySelectorAll('.jellypass-tv-requests-chip[aria-pressed="true"]')].map((button) => `${button.getAttribute('data-filter-group')}:${button.getAttribute('data-filter')}`);
  const cancelOpen = (item) => item.querySelector('.jellypass-tv-requests-cancel-open');
  const panel = (item) => item.querySelector('.jellypass-tv-requests-cancel-panel');
  const panelButtons = (item) => [...panel(item).querySelectorAll('button')];
  const confirmOf = (item) => item.querySelector('.jellypass-tv-requests-cancel-confirm');
  const message = (page) => page.document.querySelector('.jellypass-tv-requests-message');

  it('is written in the budget file: the app\'s My requests calls without /me, with Load more, a revisit and a cancel', () => {
    const screen = BUDGET.screens['tv-requests'];
    assert.equal(screen.calls, screen.atOnce.length);
    assert.deepEqual(screen.atOnce, BUDGET.screens.requests.atOnce.filter((call) => call !== 'GET /me'));
    assert.deepEqual(screen.revisit, BUDGET.screens.requests.revisit);
    assert.deepEqual(screen.cancel, BUDGET.screens.requests.cancel);
    assert.equal(screen.titlesAtOnce, BUDGET.screens.requests.titlesAtOnce);
    assert.deepEqual(screen.loadMore, screen.atOnce.filter((call) => call !== 'GET /requests'));
  });

  it('draws the household\'s requests in Jellyfin web\'s fallback page under its own header: the coarse statuses, who asked, the day, the poster, and the calls the budget names', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const state = { cancel: 202, list: [
      entry(A, T_MOVIE, { cancellable: true, requestedOn: '2026-10-27' }),
      tvEntry(B, T_TV, [[1, 'ready']], { status: 'ready', byYou: false, requestedOn: '2026-10-26' }),
      entry('CCCCCCCCCCCCCCCCCCCCCC', OWN_MOVIE),
    ] };
    const page = await open(t, app, state);
    const before = page.requests.length;
    await goToRequests(page);
    assert.ok(hosting(page));
    assert.equal(root(page).closest('#fallbackPage').id, 'fallbackPage', 'in Jellyfin\'s own page');
    assert.equal(headerTitle(page), 'My requests');
    assert.equal(page.document.getElementById('fallbackPage').getAttribute('data-title'), 'My requests');
    assert.deepEqual(page.calls(before), BUDGET.screens['tv-requests'].atOnce.concat(['GET /movie/{tmdbId}']).sort(), 'the list, then one title call for each request shown');
    assert.equal(page.requests.slice(before).filter((request) => new URL(request.url).pathname.endsWith('/requests')).length, 1);
    assert.equal(part(root(page), 'h1'), 'My requests');
    assert.deepEqual(names(page), ['Synthetic Movie One', 'Synthetic Series Two', 'Synthetic Movie Three']);
    assert.deepEqual(items(page).map(pills), [['Requested'], ['Ready to watch'], ['Requested']]);
    assert.deepEqual(items(page).map((item) => part(item, '.jellypass-tv-request-who')), ['Asked for by you', 'Asked for by someone in your household', 'Asked for by you']);
    assert.deepEqual(items(page).map((item) => part(item, '.jellypass-tv-request-on')), ['Requested on Oct 27, 2026', 'Requested on Oct 26, 2026', null], 'the day, no time; none when the server sent none');
    assert.match(part(items(page)[0], '.jellypass-tv-request-meta'), /Movie$/);
    assert.match(part(items(page)[1], '.jellypass-tv-request-meta'), /Series · Season 1$/);
    // Posters are the API's TMDB URLs only.
    const images = [...root(page).querySelectorAll('img')].map((image) => image.getAttribute('src'));
    assert.ok(images.length > 0);
    for (const src of images) assert.match(src, /^https:\/\/image\.tmdb\.org\/t\/p\/w342\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/);
    // Cancel is offered only where the server says the caller may.
    assert.deepEqual(items(page).map((item) => cancelOpen(item) !== null), [true, false, false]);
    assert.equal(cancelOpen(items(page)[0]).getAttribute('aria-label'), 'Cancel request: Synthetic Movie One');
    // Focus: the first entry, a plain button in Jellyfin web's focus manager's reach; no key is handled by the add-on.
    assert.ok(page.focused() === openButton(items(page)[0]));
    for (const entryButton of items(page).map(openButton)) {
      assert.equal(entryButton.tagName, 'BUTTON');
      assert.equal(entryButton.getAttribute('type'), 'button');
    }
    assert.equal(page.posts().length, 0, 'nothing is sent by opening it');
    lacks(root(page).outerHTML, /canary|upstream|MediaBrowser|token-/i);
  });

  it('shows each request\'s status once: the one season on the details line, shared-status seasons as text, a pill per season when they differ, and a failed note', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const state = { cancel: 202, list: [
      tvEntry(A, tmdbOf(1), [[2, 'requested']]),
      tvEntry(B, tmdbOf(2), [[1, 'ready'], [2, 'ready'], [3, 'ready']], { status: 'requested' }),
      tvEntry('CCCCCCCCCCCCCCCCCCCCCC', tmdbOf(3), [[1, 'ready'], [2, 'requested']]),
      tvEntry('DDDDDDDDDDDDDDDDDDDDDD', tmdbOf(4), [[1, 'failed'], [2, 'requested']]),
      entry('EEEEEEEEEEEEEEEEEEEEEE', tmdbOf(5), { status: 'failed' }),
      entry('FFFFFFFFFFFFFFFFFFFFFF', tmdbOf(6), { status: 'something-new' }),
      tvEntry('GGGGGGGGGGGGGGGGGGGGGG', tmdbOf(7), [[1, 'ready'], [2, 'ready'], [4, 'ready'], [5, 'ready']], { status: 'ready' }),
    ] };
    const page = await open(t, app, state);
    await goToRequests(page);
    const all = items(page);
    assert.deepEqual(all.map(pills), [
      ['Requested'],
      ['Ready to watch'],
      ['Ready to watch', 'Requested'],
      ["We couldn't get this", 'Requested'],
      ["We couldn't get this"],
      ["We couldn't get this"],
      ['Ready to watch'],
    ]);
    assert.deepEqual(all.map((item) => part(item, '.jellypass-tv-request-meta')), ['Series · Season 2', 'Series · Seasons 1–3', 'Series', 'Series', 'Movie', 'Movie', 'Series · Seasons 1, 2, 4, 5']);
    assert.deepEqual([...all[2].querySelectorAll('.jellypass-tv-request-season')].map((line) => line.textContent), ['Season 1Ready to watch', 'Season 2Requested']);
    assert.deepEqual([...all[3].querySelectorAll('.jellypass-tv-request-season')].map((line) => line.textContent), ["Season 1We couldn't get thisAsk your JellyPass admin to try again.", 'Season 2Requested']);
    assert.deepEqual(all.map((item) => item.querySelectorAll('.jellypass-tv-request-note').length), [0, 0, 0, 1, 1, 1, 0], 'the admin note sits under the failed status, once');
    assert.equal(all[0].querySelectorAll('.jellypass-tv-request-seasons').length, 0);
    assert.equal(all[2].querySelectorAll('.jellypass-tv-request-seasons').length, 1);
  });

  it('filters by status, type and "Asked by me" with no call, keeps the choice across a title and Back, and says what is missing', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const state = { cancel: 202, list: [
      entry(A, T_MOVIE),
      entry(B, OWN_MOVIE, { status: 'ready', byYou: false }),
      tvEntry('CCCCCCCCCCCCCCCCCCCCCC', T_TV, [[1, 'requested']]),
      tvEntry('DDDDDDDDDDDDDDDDDDDDDD', tmdbOf(1), [[1, 'ready'], [2, 'requested']], { byYou: false }),
    ] };
    const page = await open(t, app, state);
    await goToRequests(page);
    await page.settled();
    const calls = page.requests.length;
    assert.equal(shown(page).length, 4);
    assert.deepEqual(pressed(page), ['status:all', 'kind:all']);
    page.click(chip(page, 'status', 'ready'));
    assert.deepEqual(shown(page).map((item) => part(item, '.jellypass-tv-request-who')), ['Asked for by someone in your household', 'Asked for by someone in your household'], 'a series with a ready season is in Ready to watch');
    assert.equal(shown(page).length, 2);
    page.click(chip(page, 'status', 'requested'));
    assert.equal(shown(page).length, 3, 'the mixed series is in Requested too');
    page.click(chip(page, 'kind', 'tv'));
    assert.equal(shown(page).length, 2);
    page.click(chip(page, 'byYou', 'byYou'));
    assert.equal(shown(page).length, 1);
    assert.deepEqual(pressed(page), ['status:requested', 'kind:tv', 'byYou:byYou']);
    assert.equal(part(page.document.querySelector('.jellypass-tv-requests-announce'), ''), null);
    assert.equal(page.document.querySelector('.jellypass-tv-requests-announce').textContent, '1 shown.');
    // A combination with nothing: the empty text for it, and a way back.
    page.click(chip(page, 'status', 'failed'));
    assert.equal(shown(page).length, 0);
    const none = page.document.querySelector('.jellypass-tv-requests-none');
    assert.equal(none.hidden, false);
    assert.equal(none.querySelector('p').textContent, "No series we couldn't get, asked for by you.");
    // The choice stays across a title and Back.
    page.click(chip(page, 'status', 'requested'));
    assert.equal(shown(page).length, 1);
    page.press('pointerdown');
    page.click(openButton(shown(page)[0]));
    page.follow('#/jellypass/requests');
    await page.settled();
    assert.ok(page.view(), 'the title page');
    page.back();
    await page.settled();
    assert.deepEqual(pressed(page), ['status:requested', 'kind:tv', 'byYou:byYou']);
    assert.equal(shown(page).length, 1);
    // Show all requests.
    page.click(chip(page, 'status', 'failed'));
    page.click(page.document.querySelector('.jellypass-tv-requests-show-all'));
    assert.equal(shown(page).length, 4);
    assert.deepEqual(pressed(page), ['status:all', 'kind:all']);
    assert.ok(page.focused() === chip(page, 'status', 'all'), 'focus goes to the first chip');
    // Choosing a filter read nothing (opening a title and Back are their own calls, counted apart).
    page.click(chip(page, 'kind', 'movie'));
    const before = page.requests.length;
    page.click(chip(page, 'kind', 'all'));
    page.click(chip(page, 'byYou', 'byYou'));
    assert.equal(page.requests.length, before);
    assert.ok(page.requests.length >= calls);
  });

  it('forgets the filters and the names on sign-out and when another member signs in, and ends the page without a call', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const state = { cancel: 202, list: [entry(A, T_MOVIE), entry(B, OWN_MOVIE, { byYou: false })] };
    const page = await open(t, app, state);
    await goToRequests(page);
    page.click(chip(page, 'byYou', 'byYou'));
    assert.equal(shown(page).length, 1);
    const calls = page.requests.length;
    // Another member signs in: the page goes, nothing more is read for it.
    page.session.user = ANN;
    page.session.token = TOKENS[ANN];
    page.goTo(page.location.hash);
    page.document.body.insertAdjacentHTML('beforeend', '<i></i>');
    await page.settled();
    assert.equal(root(page), null, 'emptied');
    assert.equal(page.requests.length, calls, 'no call for the new member by the old page');
    // Back on the page as that member: unfiltered, and the titles are read again with their token.
    page.route('#/details?id=someitem');
    await page.settled();
    page.route('#/jellypass/requests');
    await page.settled();
    assert.deepEqual(pressed(page), ['status:all', 'kind:all']);
    assert.equal(shown(page).length, 2);
    const reads = page.requests.slice(calls).filter((request) => /\/(?:movie|tv)\//.test(request.url));
    assert.ok(reads.length >= 2, 'the titles named for the other member are not reused');
    for (const request of page.requests.slice(calls)) assert.equal(request.init.headers.Authorization, `MediaBrowser Token="${TOKENS[ANN]}"`);
    // Signed out.
    page.click(chip(page, 'byYou', 'byYou'));
    page.session.token = null;
    page.session.user = null;
    page.document.body.insertAdjacentHTML('beforeend', '<i></i>');
    await page.settled();
    assert.equal(root(page), null);
    page.session.user = ANN;
    page.session.token = TOKENS[ANN];
    page.route('#/details?id=someitem');
    await page.settled();
    page.route('#/jellypass/requests');
    await page.settled();
    assert.deepEqual(pressed(page), ['status:all', 'kind:all'], 'a sign-out starts the filters afresh');
  });

  it('forgets the filters and the names when the member changes while the page is closed', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const state = { cancel: 202, list: [entry(A, T_MOVIE), entry(B, OWN_MOVIE, { byYou: false })] };
    const page = await open(t, app, state);
    await goToRequests(page);
    page.click(chip(page, 'byYou', 'byYou'));
    assert.equal(shown(page).length, 1);
    page.route('#/details?id=someitem');
    await page.settled();
    // Another member, then Alice again, each seen by the add-on while the page is closed.
    page.session.user = ANN;
    page.session.token = TOKENS[ANN];
    page.document.body.insertAdjacentHTML('beforeend', '<i></i>');
    await page.settled();
    page.session.user = ALICE;
    page.session.token = TOKENS[ALICE];
    page.document.body.insertAdjacentHTML('beforeend', '<i></i>');
    await page.settled();
    const calls = page.requests.length;
    await goToRequests(page);
    assert.deepEqual(pressed(page), ['status:all', 'kind:all'], 'the filter did not follow the member back');
    assert.equal(shown(page).length, 2);
    assert.ok(page.requests.slice(calls).some((request) => /\/(?:movie|tv)\//.test(request.url)), 'the names are read again, not reused from the earlier session');
  });

  it('names the requests ten at a time with a few calls at once, and Load more names the next ten', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    let inFlight = 0;
    let most = 0;
    const state = {
      cancel: 202,
      list: Array.from({ length: 25 }, (_, n) => entry(`${'R'.repeat(20)}${String(n).padStart(2, '0')}`, tmdbOf(n + 1))),
      titles: async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await pause(15);
        inFlight -= 1;
        return undefined;
      },
    };
    const page = await open(t, app, state);
    const before = page.requests.length;
    await goToRequests(page);
    const titleCalls = (from = 0) => page.requests.slice(from).filter((request) => /\/jellypass\/app\/v1\/movie\//.test(request.url)).map((request) => Number(new URL(request.url).pathname.split('/').pop()));
    assert.deepEqual(titleCalls(before), Array.from({ length: 10 }, (_, n) => tmdbOf(n + 1)), 'the first ten, each once');
    assert.ok(most <= 4 && most >= 2, `at most four at once (${most})`);
    assert.equal(items(page).length, 10);
    assert.deepEqual(names(page), Array(10).fill('Title unavailable'), 'a title that can\'t be read leaves the request with its status');
    assert.deepEqual(items(page).map(pills), Array(10).fill(['Requested']));
    const more = page.document.querySelector('.jellypass-tv-requests-more');
    assert.equal(more.hidden, false);
    assert.equal(more.textContent, 'Load more');
    const second = page.requests.length;
    page.click(more);
    await page.settled();
    assert.deepEqual(titleCalls(second), Array.from({ length: 10 }, (_, n) => tmdbOf(n + 11)), 'the next ten, each once');
    assert.deepEqual(page.calls(second).filter((call) => call !== 'GET /movie/{tmdbId}'), []);
    assert.equal(items(page).length, 20);
    assert.ok(page.focused() === openButton(items(page)[10]), 'focus goes to the first new request');
    page.click(more);
    await page.settled();
    assert.equal(items(page).length, 25);
    assert.equal(more.hidden, true);
    assert.equal(titleCalls().filter((id) => id === tmdbOf(1)).length, 1, 'no title is read twice');
    // With a filter on and more to load, the page says more may match.
    const hint = page.document.querySelector('.jellypass-tv-requests-hint');
    assert.equal(hint.hidden, true, 'everything is loaded');
  });

  it('says more may match while requests are still to load, and a filter applies to what Load more adds', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const list = Array.from({ length: 12 }, (_, n) => entry(`${'S'.repeat(20)}${String(n).padStart(2, '0')}`, tmdbOf(n + 1), n === 11 ? { status: 'ready' } : {}));
    const state = { cancel: 202, list, titles: () => json({}, 404) };
    const page = await open(t, app, state);
    await goToRequests(page);
    page.click(chip(page, 'status', 'ready'));
    const none = page.document.querySelector('.jellypass-tv-requests-none');
    assert.equal(none.hidden, false);
    assert.equal(none.querySelector('p').textContent, 'No requests ready to watch. More may match — Load more to look further.');
    page.click(page.document.querySelector('.jellypass-tv-requests-more'));
    await page.settled();
    assert.equal(shown(page).length, 1);
    assert.equal(none.hidden, true);
  });

  it('reads only the list when shown again within ten minutes, with the names kept; reads the titles again after that and for another sign-in', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const state = { cancel: 202, list: [entry(A, T_MOVIE), tvEntry(B, T_TV, [[1, 'requested']])] };
    const page = await open(t, app, state);
    await goToRequests(page);
    assert.deepEqual(names(page), ['Synthetic Movie One', 'Synthetic Series Two']);
    page.route('#/details?id=someitem');
    await page.settled();
    let before = page.requests.length;
    page.back();
    await page.settled();
    assert.deepEqual(page.calls(before), BUDGET.screens['tv-requests'].revisit);
    assert.deepEqual(names(page), ['Synthetic Movie One', 'Synthetic Series Two'], 'named at once from the kept titles');
    page.advance(10 * 60 * 1000 + 1);
    page.route('#/details?id=someitem');
    await page.settled();
    before = page.requests.length;
    page.back();
    await page.settled();
    assert.deepEqual(page.calls(before), BUDGET.screens['tv-requests'].atOnce, 'ten minutes on: the titles are read again');
  });

  it('opens the title page for an entry and Back returns with the same entry focused, with the entries that were showing drawn at once', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const state = { cancel: 202, list: [entry(A, T_MOVIE), tvEntry(B, T_TV, [[1, 'requested']]), entry('CCCCCCCCCCCCCCCCCCCCCC', OWN_MOVIE)] };
    const page = await open(t, app, state);
    await goToRequests(page);
    const from = page.location.hash;
    // The member moves focus down to the second entry (a key press), then chooses it.
    page.key(40);
    openButton(items(page)[1]).focus();
    page.click(openButton(items(page)[1]));
    assert.equal(page.location.hash, `#/jellypass/title/tv/${T_TV}`);
    page.follow(from);
    await page.settled();
    assert.ok(page.view(), 'the JellyPass title page');
    assert.equal(root(page), null, 'the requests page is left');
    assert.equal(headerTitle(page), 'Synthetic Series Two');
    page.back();
    await page.settled();
    assert.equal(page.location.hash, '#/jellypass/requests');
    assert.ok(page.focused() === openButton(items(page)[1]), 'the same entry has focus');
    assert.deepEqual(names(page), ['Synthetic Movie One', 'Synthetic Series Two', 'Synthetic Movie Three']);
  });

  it('draws nothing and calls nothing when no one is signed in to this origin or Jellyfin\'s page is not as expected', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const state = { cancel: 202, list: [entry(A, T_MOVIE)] };
    const elsewhere = await open(t, app, state, { serverAddress: 'https://other.example.test' });
    const before = elsewhere.requests.length;
    await goToRequests(elsewhere);
    assert.equal(root(elsewhere), null);
    assert.equal(elsewhere.requests.length, before);
    // No fallback page: nothing to host.
    const page = await open(t, app, state);
    const calls = page.requests.length;
    page.location.hash = '#/jellypass/requests';
    page.goTo('#/jellypass/requests');
    await page.settled();
    assert.equal(root(page), null);
    assert.equal(page.requests.length, calls);
  });

  it('shows an empty list, and fixed words for every failure, never the answer\'s text, with a retry that only reads', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const state = { cancel: 202, list: [] };
    const page = await open(t, app, state);
    await goToRequests(page);
    assert.equal(part(root(page), '.jellypass-tv-requests-note'), 'Nothing requested yet. Choose Get this on a title to ask for it.');
    for (const [status, title, body, retry] of [
      [429, 'Too many requests', 'Wait a minute, then try again.', true],
      [502, "Can't load this right now", 'Something went wrong. Try again in a moment.', true],
      [401, 'Sign in to continue', 'Your Jellyfin sign-in is missing or has expired.', false],
      ['offline', "You're offline", 'Check your connection, then try again.', true],
    ]) {
      state.listFails = () => {
        if (status === 'offline') throw new TypeError('Failed to fetch');
        return { status, body: '{"error":"canary upstream text"}' };
      };
      page.route('#/details?id=someitem');
      await page.settled();
      page.back();
      await page.settled();
      assert.equal(part(root(page), '.jellypass-tv-requests-error'), title, String(status));
      assert.equal(part(root(page), '.jellypass-tv-requests-note'), body, String(status));
      assert.equal(root(page).querySelectorAll('.jellypass-tv-requests-retry').length, retry ? 1 : 0, String(status));
      lacks(root(page).outerHTML, /canary|upstream/i);
    }
    // The retry only reads the list.
    state.listFails = undefined;
    state.list = [entry(A, T_MOVIE)];
    page.route('#/details?id=someitem');
    await page.settled();
    state.listFails = () => ({ status: 502, body: '{}' });
    page.back();
    await page.settled();
    state.listFails = undefined;
    const before = page.requests.length;
    page.click(root(page).querySelector('.jellypass-tv-requests-retry'));
    await page.settled();
    assert.equal(page.posts().length, 0);
    assert.deepEqual(page.calls(before), BUDGET.screens['tv-requests'].atOnce.slice().filter((call) => call !== 'GET /tv/{tmdbId}'));
    assert.deepEqual(names(page), ['Synthetic Movie One']);
  });

  describe('Cancel request', () => {
    it('asks first: the group says what cancelling does, Keep sends nothing and puts focus back, and the add-on handles no key', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const state = { cancel: 202, list: [entry(A, T_MOVIE, { cancellable: true, requestedOn: '2026-10-27' })] };
      const page = await open(t, app, state);
      await goToRequests(page);
      const item = items(page)[0];
      assert.equal(panel(item).hidden, true);
      page.click(cancelOpen(item));
      assert.equal(panel(item).hidden, false);
      assert.equal(cancelOpen(item).hidden, true);
      assert.equal(panel(item).getAttribute('role'), 'group');
      assert.equal(part(panel(item), '.jellypass-tv-requests-cancel-heading'), 'Cancel this request?');
      assert.equal(part(panel(item), '.jellypass-tv-requests-note'), "This withdraws your household's request. If it has already been approved, the download may still finish, but it won't be added for your household.");
      assert.deepEqual(panelButtons(item).map((button) => button.textContent), ['Keep request', 'Cancel request']);
      assert.ok(page.focused() === panelButtons(item)[0], 'the safe answer has focus');
      page.click(panelButtons(item)[0]);
      assert.equal(panel(item).hidden, true);
      assert.ok(page.focused() === cancelOpen(item));
      assert.equal(state.posts.length, 0, 'nothing sent until confirmed');
      // Not one key listener of the add-on's can stop or prevent an event, and none is added for this page.
      for (const entryOf of page.listeners.filter((listener) => /^(?:keydown|keyup|keypress) /.test(listener))) assert.equal(entryOf, 'keydown {"capture":true,"passive":true}');
    });

    it('confirming sends one POST with an empty object, drops the entry, says Request cancelled, reads the list again, and puts the title back to Get this on Home with no call', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      // The server still lists the movie as requested everywhere: the cancel is settled in the background.
      const asRequested = async (pathname) => {
        const real = (await app.get(pathname)).json();
        return json(Array.isArray(real.results) ? { ...real, results: real.results.map((card) => (card.tmdbId === T_MOVIE ? { ...card, state: 'requested' } : card)) } : { ...real, state: 'requested' });
      };
      const state = {
        cancel: 202,
        list: [entry(A, T_MOVIE, { cancellable: true, requestedOn: '2026-10-27' }), tvEntry(B, T_TV, [[1, 'requested']], { cancellable: true, requestedOn: '2026-10-26' })],
        other: (pathname) => (pathname === '/jellypass/app/v1/discover/trending' ? asRequested(pathname) : undefined),
        titles: (pathname) => (pathname === `/jellypass/app/v1/movie/${T_MOVIE}` ? asRequested(pathname) : undefined),
      };
      const page = await open(t, app, state);
      assert.equal(onRow(page, T_MOVIE), 'not in the row', 'Requested is not in the Discover row');
      await goToRequests(page);
      const [item, other] = items(page);
      let release;
      state.hold = new Promise((resolve) => { release = resolve; });
      const before = page.requests.length;
      page.click(cancelOpen(item));
      page.click(confirmOf(item));
      assert.equal(confirmOf(item).textContent, 'Cancelling…');
      assert.equal(confirmOf(item).disabled, true);
      assert.equal(panelButtons(item)[0].disabled, true, 'Keep is disabled while the call is out');
      page.click(confirmOf(item));
      await pause(40);
      assert.equal(state.posts.length, 1, 'a second press sends nothing');
      release();
      await page.settled();
      assert.equal(state.posts.length, 1);
      assert.equal(state.posts[0].pathname, `/jellypass/app/v1/requests/${A}/cancel`);
      assert.equal(state.posts[0].body, '{}');
      assert.deepEqual(state.posts[0].headers, { Accept: 'application/json', Authorization: `MediaBrowser Token="${TOKENS[ALICE]}"`, 'Content-Type': 'application/json' });
      assert.deepEqual(page.calls(before), BUDGET.screens['tv-requests'].cancel.map((call) => call.replace('{id}', 'ID')).map((call) => (call === 'POST /requests/ID/cancel' ? 'POST /requests/' + A + '/cancel' : call)).sort());
      assert.equal(items(page).length, 1);
      assert.equal(items(page)[0].querySelector('.jellypass-tv-request-open').getAttribute('data-jellypass-tv-focus'), `entry-tv-${T_TV}`);
      assert.equal(message(page).textContent, 'Request cancelled');
      assert.equal(message(page).getAttribute('role'), 'status');
      assert.ok(page.focused() === message(page), 'the confirmation has focus');
      assert.equal(part(items(page)[0], '.jellypass-tv-request-name'), 'Synthetic Series Two', 'the other request stays named, with no title call');
      assert.ok(other.isConnected === false || items(page)[0] !== other, 'drawn again from the list read');
      // Home: the title is Available to get again, with no call (the trending answer is kept).
      const home = page.requests.length;
      page.back();
      await page.settled();
      assert.equal(onRow(page, T_MOVIE), 'Available to get');
      assert.deepEqual(page.calls(home), [], 'Home\'s row, from the overlay, made no call');
    });

    it('shows the title as Get this on its page after a cancel, while the server still says requested', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const asRequested = async (pathname) => json({ ...(await app.get(pathname)).json(), state: 'requested' });
      const state = { cancel: 202, list: [entry(A, T_MOVIE, { cancellable: true })], titles: (pathname) => (pathname === `/jellypass/app/v1/movie/${T_MOVIE}` ? asRequested(pathname) : undefined) };
      const page = await open(t, app, state);
      page.route(`#/jellypass/title/movie/${T_MOVIE}`);
      await page.settled();
      assert.equal(part(page.view(), '.jellypass-tv-title-status'), 'Requested');
      page.back();
      await goToRequests(page);
      page.click(cancelOpen(items(page)[0]));
      page.click(confirmOf(items(page)[0]));
      await page.settled();
      assert.equal(message(page).textContent, 'Request cancelled');
      page.route(`#/jellypass/title/movie/${T_MOVIE}`);
      await page.settled();
      assert.equal(part(page.view(), '.jellypass-tv-title-status'), 'Available to get');
      assert.deepEqual([...page.view().querySelectorAll('button:not(.jellypass-tv-title-hide)')].map((button) => button.textContent), ['Get this']);
      // After two minutes the server's word stands again.
      page.advance(120_000);
      assert.equal(part(page.view(), '.jellypass-tv-title-status'), 'Requested');
    });

    it('drops a cancel answered after a sign-out and a new sign-in as the same member: the new session shows the server\'s Requested', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const asRequested = async (pathname) => json({ ...(await app.get(pathname)).json(), state: 'requested' });
      const state = { cancel: 202, list: [entry(A, T_MOVIE, { cancellable: true })], titles: (pathname) => (pathname === `/jellypass/app/v1/movie/${T_MOVIE}` ? asRequested(pathname) : undefined) };
      const page = await open(t, app, state);
      await goToRequests(page);
      let release;
      state.hold = new Promise((resolve) => { release = resolve; });
      page.click(cancelOpen(items(page)[0]));
      page.click(confirmOf(items(page)[0]));
      await pause(40);
      assert.equal(state.posts.length, 1);
      // Leave, sign out, sign back in as the same member with a new token, then the old answer comes.
      page.route('#/details?id=someitem');
      await pause(40);
      page.session.token = null;
      page.session.user = null;
      page.document.body.insertAdjacentHTML('beforeend', '<i></i>');
      await pause(40);
      page.session.user = ALICE;
      page.session.token = 'a-new-token-for-alice';
      page.document.body.insertAdjacentHTML('beforeend', '<i></i>');
      await pause(40);
      release();
      await page.settled();
      await pause(40);
      page.route(`#/jellypass/title/movie/${T_MOVIE}`);
      await page.settled();
      assert.equal(part(page.view(), '.jellypass-tv-title-status'), 'Requested', 'the old session\'s cancel does not cover the new session');
    });

    it('drops a cancel answered after a new token without a sign-out call in between', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const asRequested = async (pathname) => json({ ...(await app.get(pathname)).json(), state: 'requested' });
      const state = { cancel: 202, list: [entry(A, T_MOVIE, { cancellable: true })], titles: (pathname) => (pathname === `/jellypass/app/v1/movie/${T_MOVIE}` ? asRequested(pathname) : undefined) };
      const page = await open(t, app, state);
      await goToRequests(page);
      let release;
      state.hold = new Promise((resolve) => { release = resolve; });
      page.click(cancelOpen(items(page)[0]));
      page.click(confirmOf(items(page)[0]));
      await pause(40);
      page.route('#/details?id=someitem');
      await pause(40);
      page.session.token = 'a-new-token-for-alice';
      release();
      await page.settled();
      await pause(40);
      page.route(`#/jellypass/title/movie/${T_MOVIE}`);
      await page.settled();
      assert.equal(part(page.view(), '.jellypass-tv-title-status'), 'Requested');
    });

    it('reads the list once for the new session when two old cancels both come back refused after a new token', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const state = { cancel: 401, list: [entry(A, T_MOVIE, { cancellable: true }), entry(B, OWN_MOVIE, { cancellable: true })] };
      const page = await open(t, app, state);
      await goToRequests(page);
      let release;
      state.hold = new Promise((resolve) => { release = resolve; });
      for (const item of items(page)) {
        page.click(cancelOpen(item));
        page.click(confirmOf(item));
      }
      await pause(40);
      assert.equal(state.posts.length, 2);
      page.session.token = 'a-new-token-for-alice';
      page.document.body.insertAdjacentHTML('beforeend', '<i></i>');
      await pause(40);
      release();
      await page.settled();
      await pause(40);
      const reads = page.requests.filter((request) => request.url.endsWith('/jellypass/app/v1/requests') && String(request.init?.headers?.Authorization).includes('a-new-token-for-alice'));
      assert.equal(reads.length, 1, 'one list read for the new session');
      assert.equal(items(page).length, 2);
    });

    for (const [answer, label] of [[401, 'a refused token'], [429, 'a rate limit'], [502, 'a server error'], ['offline', 'no network']]) {
      it(`ignores a cancel that fails with ${label} after a new token with the page open: the new session's overlay, host and page are untouched`, async (t) => {
        const app = await startApp(t, webWorld(), tvOn());
        const state = { cancel: answer, list: [entry(A, T_MOVIE, { cancellable: true })] };
        const page = await open(t, app, state);
        await goToRequests(page);
        let release;
        state.hold = new Promise((resolve) => { release = resolve; });
        page.click(cancelOpen(items(page)[0]));
        page.click(confirmOf(items(page)[0]));
        await pause(40);
        assert.equal(state.posts.length, 1);
        // Same member, a new token, the page still open and told so by a page change.
        page.session.token = 'a-new-token-for-alice';
        page.document.body.insertAdjacentHTML('beforeend', '<i></i>');
        await pause(40);
        release();
        await page.settled();
        await pause(40);
        assert.ok(root(page), 'the page stays open for the new session');
        assert.equal(page.document.querySelector('.jellypass-tv-requests-error') === null, true, 'no error for a call the new session did not make');
        assert.ok(!page.document.body.textContent.includes('Sign in to continue'));
        assert.equal(page.document.querySelector('.jellypass-tv-requests-error-text') === null, true, 'no failure words for a call the new session did not make');
        assert.equal(items(page).length, 1, 'the entry is still listed: nothing was cancelled for the new session');
        assert.equal(page.requests.some((request) => String(request.init?.headers?.Authorization).includes('a-new-token-for-alice')), true, 'the list is read with the new token');
      });
    }

    for (const [answer, words] of [
      [429, 'Too many tries, try again in a few minutes.'],
      [502, "We couldn't cancel that just now. Try again in a moment."],
      [404, "We couldn't cancel that just now. Try again in a moment."],
      ['offline', "You're offline. Check your connection, then try again."],
    ]) {
      it(`says ${JSON.stringify(words)} when the cancel fails with ${answer}, never shows the answer's text, and never asks again by itself`, async (t) => {
        const app = await startApp(t, webWorld(), tvOn());
        const state = { cancel: answer, list: [entry(A, T_MOVIE, { cancellable: true }), entry(B, OWN_MOVIE, { cancellable: true })] };
        const page = await open(t, app, state);
        await goToRequests(page);
        const item = items(page)[0];
        page.click(cancelOpen(item));
        page.click(confirmOf(item));
        await page.settled();
        assert.equal(part(panel(item), '.jellypass-tv-requests-cancel-message'), words);
        assert.equal(confirmOf(item).textContent, 'Cancel request');
        assert.equal(confirmOf(item).disabled, false);
        assert.equal(panelButtons(item)[0].disabled, false);
        assert.ok(page.focused() === confirmOf(item));
        assert.equal(items(page).length, 2, 'the request stays');
        assert.equal(message(page), null, 'no confirmation');
        lacks(page.document.documentElement.outerHTML, /upstream said something private|canary/i);
        page.advance(120_000);
        await page.settled();
        assert.equal(state.posts.length, 1, 'never repeated by itself');
        // The member may try again, and that is one more call.
        page.click(confirmOf(item));
        await page.settled();
        assert.equal(state.posts.length, 2);
      });
    }

    it('ends the session on a 401: sign in to continue, and what was shown as requested or named is forgotten', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const state = { cancel: 401, list: [entry(A, T_MOVIE, { cancellable: true })] };
      const page = await open(t, app, state);
      await goToRequests(page);
      page.click(cancelOpen(items(page)[0]));
      page.click(confirmOf(items(page)[0]));
      await page.settled();
      assert.equal(part(root(page), '.jellypass-tv-requests-error'), 'Sign in to continue');
      assert.equal(root(page).querySelectorAll('.jellypass-tv-requests-retry').length, 0);
      assert.equal(state.posts.length, 1);
      lacks(root(page).outerHTML, /upstream said something private/);
      // The names are forgotten: the page, opened again, reads the titles.
      state.cancel = 202;
      page.route('#/details?id=someitem');
      await page.settled();
      const before = page.requests.length;
      page.back();
      await page.settled();
      assert.deepEqual(page.calls(before), BUDGET.screens['tv-requests'].atOnce.filter((call) => call !== 'GET /tv/{tmdbId}'));
    });

    it('keeps the confirmation, with the fixed refresh note and a retry that only reads, when the list can\'t be read again after an accepted cancel', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const state = { cancel: 202, list: [entry(A, T_MOVIE, { cancellable: true }), entry(B, OWN_MOVIE)], listFails: (read) => (read === 2 ? { status: 502, body: '{"error":"canary upstream text"}' } : undefined) };
      const page = await open(t, app, state);
      await goToRequests(page);
      page.click(cancelOpen(items(page)[0]));
      page.click(confirmOf(items(page)[0]));
      await page.settled();
      assert.equal(message(page).textContent, 'Request cancelled');
      assert.equal(part(root(page), '.jellypass-tv-requests-note'), 'Something went wrong. Try again in a moment.');
      lacks(root(page).outerHTML, /canary|upstream/);
      assert.equal(state.posts.length, 1);
      const before = page.requests.length;
      page.click(root(page).querySelector('.jellypass-tv-requests-retry'));
      await page.settled();
      assert.equal(state.posts.length, 1, 'the retry only reads');
      assert.deepEqual(page.calls(before).filter((call) => !call.startsWith('GET /movie/')), ['GET /requests']);
      assert.equal(items(page).length, 1);
      assert.equal(message(page).textContent, 'Request cancelled', 'the confirmation stays');
    });
  });

  describe('how it is reached', () => {
    it('adds a "My requests" card at the end of the Discover row that opens the page, and Back returns focus to it', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const state = { cancel: 202, list: [entry(A, T_MOVIE)] };
      const page = await open(t, app, state);
      page.document.documentElement.classList.add('layout-tv');
      const link = page.requestsLink();
      assert.ok(link, 'the link card');
      assert.equal(link.tagName, 'BUTTON');
      assert.equal(link.getAttribute('type'), 'button');
      assert.equal(link.getAttribute('aria-label'), 'My requests');
      assert.equal(link.textContent, 'My requests');
      const list = page.rows()[0].querySelector('.jellypass-tv-row-list');
      assert.ok(list.lastElementChild === link, 'the last card of the strip');
      assert.ok(list.classList.contains('focuscontainer-x'));
      assert.equal(page.cards().includes(link), false, 'not a title\'s card');
      assert.equal(page.rows()[0].querySelectorAll('.jellypass-tv-card-link').length, 1);
      const calls = page.requests.length;
      const from = page.location.hash;
      page.click(link);
      assert.equal(page.location.hash, '#/jellypass/requests');
      page.follow(from);
      await page.settled();
      assert.ok(root(page));
      assert.equal(page.requests.length > calls, true);
      page.back();
      await page.settled();
      assert.ok(page.focused() === page.requestsLink(), 'Back to Home focuses the link');
      assert.equal(page.rows().length, 1);
    });

    it('opens nothing from the link while Jellyfin web is signed in elsewhere', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const page = await open(t, app, { cancel: 202, list: [] });
      const from = page.location.hash;
      page.session.serverAddress = 'https://other.example.test';
      page.click(page.requestsLink());
      assert.equal(page.location.hash, from);
    });

    it('links the title page to My requests where the household is following the title, and nowhere else', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const asState = (state) => async (pathname) => json({ ...(await app.get(pathname)).json(), state });
      const of = async (state, tmdbId) => {
        const page = await open(t, app, { cancel: 202, list: [], titles: (pathname) => (pathname === `/jellypass/app/v1/movie/${tmdbId}` ? asState(state)(pathname) : undefined) });
        page.route(`#/jellypass/title/movie/${tmdbId}`);
        await page.settled();
        return page;
      };
      for (const [state, linked] of [['requested', true], ['get_this', false], ['in_library', false], ['unavailable', false]]) {
        const page = await of(state, T_MOVIE);
        const texts = [...page.view().querySelectorAll('button:not(.jellypass-tv-title-hide)')].map((button) => button.textContent);
        assert.equal(texts.includes('My requests'), linked, state);
        if (state === 'requested') {
          assert.equal(part(page.view(), '.jellypass-tv-title-note'), 'Follow it in My requests.');
          const from = page.location.hash;
          page.click(page.view().querySelector('.jellypass-tv-title-requests'));
          assert.equal(page.location.hash, '#/jellypass/requests');
          page.follow(from);
          await page.settled();
          assert.ok(root(page), 'the page opens from the title page');
          assert.equal(page.view(), null);
        }
      }
    });

    it('links to My requests after an accepted Get this, beside nothing that sends', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      let release;
      app.seerr.state.holdRequests = new Promise((resolve) => { release = resolve; });
      t.after(async () => { release(); await app.background.settled(); });
      const page = await openJellyfinWeb(t, app);
      page.document.body.insertAdjacentHTML('afterbegin', HEADER);
      page.home();
      await page.settled();
      page.route(`#/jellypass/title/movie/${T_MOVIE}`);
      await page.settled();
      assert.deepEqual([...page.view().querySelectorAll('button:not(.jellypass-tv-title-hide)')].map((button) => button.textContent), ['Get this']);
      page.click(page.view().querySelector('.jellypass-tv-title-get'));
      await page.settled();
      assert.deepEqual([...page.view().querySelectorAll('button:not(.jellypass-tv-title-hide)')].map((button) => button.textContent), ['My requests']);
    });
  });

  it('keeps the privacy of the app: the page and its calls are byte-for-byte the same whatever other households hold or asked for', async (t) => {
    const seen = {};
    for (const [name, state] of Object.entries({ baseline: world(), ...otherHouseholdWorlds() })) {
      const app = await startApp(t, Object.assign(state, { webPage: {} }), { ...tvOn(), reconcile: true });
      const list = { cancel: 202, list: [entry(A, T_MOVIE, { cancellable: true, requestedOn: '2026-10-27' }), tvEntry(B, T_TV, [[1, 'ready'], [2, 'requested']], { byYou: false })] };
      const page = await open(t, app, list);
      await goToRequests(page);
      const view = root(page).outerHTML;
      assertNoCanaries(view, `${name}: the page shows Seerr data planted as a canary`);
      seen[name] = { calls: page.trace(), view };
    }
    const { baseline, ...others } = seen;
    assert.ok(Object.keys(others).length >= 5);
    for (const [name, outcome] of Object.entries(others)) {
      assert.deepEqual(outcome.calls, baseline.calls, `${name}: the calls the add-on made`);
      assert.ok(outcome.view === baseline.view, `${name}: the page differs`);
    }
  });

  it('works end to end against the real API: a title asked for with Get this is listed, cancellable, and a cancel takes it off', async (t) => {
    const app = await startApp(t, webWorld(), { ...tvOn(), reconcile: true });
    const page = await openJellyfinWeb(t, app);
    page.document.body.insertAdjacentHTML('afterbegin', HEADER);
    page.home();
    await page.settled();
    page.route(`#/jellypass/title/movie/${T_MOVIE}`);
    await page.settled();
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    await app.background.settled();
    page.back();
    await goToRequests(page);
    assert.deepEqual(names(page), ['Synthetic Movie One']);
    assert.deepEqual(pills(items(page)[0]), ['Requested']);
    assert.equal(part(items(page)[0], '.jellypass-tv-request-who'), 'Asked for by you');
    assert.match(part(items(page)[0], '.jellypass-tv-request-on'), /^Requested on [A-Z][a-z]{2} \d{1,2}, \d{4}$/);
    assert.ok(cancelOpen(items(page)[0]), 'the real server offers Cancel for the caller\'s own pending request');
    page.click(cancelOpen(items(page)[0]));
    page.click(confirmOf(items(page)[0]));
    // The real cancel settles with Seerr before it answers, which takes longer than the simulated ones.
    for (let round = 0; round < 100 && !message(page); round += 1) await pause(50);
    await page.settled();
    await app.background.settled();
    assert.equal(message(page).textContent, 'Request cancelled');
    assert.equal(page.posts().filter((post) => /\/cancel$/.test(post.url)).length, 1);
    // The server withdraws it in the background; once it has, the list no longer has the request.
    page.route('#/details?id=someitem');
    await page.settled();
    page.back();
    await page.settled();
    assert.equal(items(page).length, 0);
    assert.equal(part(root(page), '.jellypass-tv-requests-note'), 'Nothing requested yet. Choose Get this on a title to ask for it.');
  });
});

describe('TV add-on: My requests, the parts', { timeout: 60_000 }, () => {
  const TV_SRC = path.join(import.meta.dirname, '..', 'tv', 'src');
  const ENTRY = `
    import { Asked } from './asked.ts';
    import { TitleCache } from './titles.ts';
    import { requestPills, requestStatuses, matchesRequestFilter, requestFilterEmptyText, requestSeasonsText, requestedOnText } from './requests-model.ts';
    window.parts = { Asked, TitleCache, requestPills, requestStatuses, matchesRequestFilter, requestFilterEmptyText, requestSeasonsText, requestedOnText };
  `;
  let code;
  const load = async () => {
    if (!code) {
      const { build } = await import('esbuild');
      code = (await build({ stdin: { contents: ENTRY, resolveDir: TV_SRC, loader: 'ts' }, bundle: true, format: 'iife', target: 'es2017', write: false, logLevel: 'silent' })).outputFiles[0].text;
    }
    const timers = [];
    const scope = { setTimeout: (run, ms) => { timers.push({ run, ms }); return timers.length; }, clearTimeout: () => undefined, Date };
    scope.window = scope;
    vm.runInContext(code, vm.createContext(scope));
    return { parts: scope.parts, timers };
  };
  const clock = () => { const c = { mono: 0, wall: 1_000_000 }; return { c, now: () => c.mono, wall: () => c.wall, advance: (ms) => { c.mono += ms; c.wall += ms; } }; };

  it('withdraws a title: it reads as Get this while the server still says requested, each key ending on its own, and for two minutes at most', async () => {
    const { parts } = await load();
    const time = clock();
    let expired = 0;
    const asked = new parts.Asked(time.now, time.wall, () => { expired += 1; });
    asked.sync('alice');
    asked.add('alice', 'tv', 7, [1, 2]);
    assert.equal(asked.state('tv', 7, 'get_this'), 'requested');
    asked.withdraw('alice', 'tv', 7);
    assert.equal(asked.state('tv', 7, 'requested'), 'get_this', 'the title');
    assert.equal(asked.state('tv', 7, 'requested', 1), 'get_this', 'a season');
    assert.equal(asked.state('tv', 7, 'get_this'), 'get_this', 'an earlier Get this no longer shows Requested');
    // The server says something but requested for the title: that key ends for good, the season's own goes on.
    assert.equal(asked.state('tv', 7, 'requested'), 'requested', 'the title key ended when the server said get_this');
    assert.equal(asked.state('tv', 7, 'requested', 2), 'get_this');
    assert.equal(asked.state('tv', 8, 'requested'), 'requested', 'another title is untouched');
    time.advance(119_999);
    assert.equal(asked.state('tv', 7, 'requested', 2), 'get_this');
    time.advance(1);
    assert.equal(asked.state('tv', 7, 'requested', 2), 'requested', 'two minutes on, the server\'s word stands');
    asked.forget();
    assert.equal(expired, 0);
  });

  it('ends a withdrawal when the title is asked for again, on the wall clock too, and ignores another member\'s', async () => {
    const { parts, timers } = await load();
    const time = clock();
    let expired = 0;
    const asked = new parts.Asked(time.now, time.wall, () => { expired += 1; });
    asked.sync('alice');
    asked.withdraw('bob', 'movie', 1);
    assert.equal(asked.state('movie', 1, 'requested'), 'requested', 'not the member signed in');
    asked.withdraw('alice', 'movie', 1);
    assert.equal(asked.state('movie', 1, 'requested'), 'get_this');
    asked.add('alice', 'movie', 1, []);
    assert.equal(asked.state('movie', 1, 'get_this'), 'requested', 'asked for again');
    assert.equal(asked.state('movie', 1, 'requested'), 'requested');
    asked.withdraw('alice', 'movie', 2);
    time.c.wall += 120_000; // the TV asleep: only the wall clock moved
    assert.equal(asked.state('movie', 2, 'requested'), 'requested');
    // A timer ends it with nothing pressed, and says so.
    asked.withdraw('alice', 'movie', 3);
    const last = timers[timers.length - 1];
    time.advance(120_000);
    last.run();
    assert.equal(expired >= 1, true);
    assert.equal(asked.state('movie', 3, 'requested'), 'requested');
    // Another member signing in forgets everything.
    asked.withdraw('alice', 'movie', 4);
    asked.sync('ann');
    assert.equal(asked.state('movie', 4, 'requested'), 'requested');
  });

  it('keeps titles for ten minutes on both clocks, least recently used first, and forgets them', async () => {
    const { parts } = await load();
    const time = clock();
    const cache = new parts.TitleCache(time.now, time.wall);
    cache.set('movie', 1, { title: 'One', year: 2000, posterUrl: null });
    assert.equal(cache.get('movie', 1).title, 'One');
    assert.equal(cache.get('tv', 1), undefined, 'the kind is part of the key');
    time.advance(599_999);
    assert.equal(cache.get('movie', 1).title, 'One');
    time.advance(1);
    assert.equal(cache.get('movie', 1), undefined);
    cache.set('movie', 2, { title: 'Two', year: null, posterUrl: null });
    time.c.wall += 600_000; // asleep
    assert.equal(cache.get('movie', 2), undefined, 'the wall clock ends it too');
    cache.set('movie', 3, { title: 'Three', year: null, posterUrl: null });
    time.c.wall -= 5_000; // set back
    assert.equal(cache.get('movie', 3), undefined, 'a wall clock set back ends it');
    for (let n = 0; n < 305; n += 1) cache.set('movie', 100 + n, { title: String(n), year: null, posterUrl: null });
    assert.equal(cache.get('movie', 100), undefined, 'the oldest went at 300');
    assert.equal(cache.get('movie', 404).title, '304');
    cache.forget();
    assert.equal(cache.get('movie', 404), undefined);
  });

  it('words a request\'s statuses as the app does: one pill, seasons as text, a pill per season when they differ', async () => {
    const { parts } = await load();
    const seasons = (...pairs) => pairs.map(([seasonNumber, status]) => ({ seasonNumber, status }));
    const plain = (value) => JSON.parse(JSON.stringify(value));
    assert.deepEqual(plain(parts.requestPills({ status: 'failed', seasons: [] })), { status: 'failed', seasonsText: '', perSeason: false });
    assert.deepEqual(plain(parts.requestPills({ status: 'requested', seasons: seasons([1, 'ready'], [2, 'ready']) })), { status: 'ready', seasonsText: 'Seasons 1, 2', perSeason: false });
    assert.deepEqual(plain(parts.requestPills({ status: 'ready', seasons: seasons([1, 'ready'], [2, 'failed']) })), { perSeason: true, seasonsText: '' });
    assert.equal(parts.requestSeasonsText([3, 1, 2, 5]), 'Seasons 1–3, 5');
    assert.equal(parts.requestSeasonsText([2]), 'Season 2');
    assert.deepEqual(plain(parts.requestStatuses({ status: 'failed', seasons: seasons([1, 'ready'], [2, 'requested']) })), ['ready', 'requested', 'failed']);
    const filter = (status, kind = 'all', byYou = false) => ({ status, kind, byYou });
    const mixed = { mediaType: 'tv', byYou: false, status: 'requested', seasons: seasons([1, 'ready'], [2, 'requested']) };
    assert.equal(parts.matchesRequestFilter(mixed, filter('ready')), true);
    assert.equal(parts.matchesRequestFilter(mixed, filter('requested')), true);
    assert.equal(parts.matchesRequestFilter(mixed, filter('failed')), false);
    assert.equal(parts.matchesRequestFilter(mixed, filter('all', 'movie')), false);
    assert.equal(parts.matchesRequestFilter(mixed, filter('all', 'all', true)), false);
    assert.equal(parts.requestFilterEmptyText(filter('ready', 'movie', true)), 'No films ready to watch, asked for by you.');
    assert.equal(parts.requestFilterEmptyText(filter('all'), true), 'No requests. More may match — Load more to look further.');
  });

  it('writes the day the server sent, as a UTC day with no time, and nothing for a malformed or impossible one', async () => {
    const { parts } = await load();
    assert.equal(parts.requestedOnText('2026-10-27'), 'Oct 27, 2026');
    assert.equal(parts.requestedOnText('2026-12-31'), 'Dec 31, 2026');
    for (const bad of [undefined, '', '2026-02-30', '2026-13-01', '27/10/2026', '2026-10-27T00:00:00Z', 'canary']) assert.equal(parts.requestedOnText(bad), undefined, String(bad));
    // Chromium 63 has no `dateStyle`; the fields are named instead.
    lacks(readFileSync(path.join(TV_SRC, 'requests-model.ts'), 'utf8').replace(/\/\/.*$/gm, ''), /dateStyle/);
  });
});

/**
 * Jellyfin web 12.3's two headers, as its source and a running 12.3 and 10.11.3 draw them (docs/tv-addon.md, "The Discover
 * page"): the TV layout shows the legacy one (`.skinHeader`, with `show-focus` on its buttons); the desktop layout hides that
 * one (0 by 0) and shows a React toolbar (`header.MuiAppBar-root`) whose actions box holds the Search link, with a Search icon
 * of one path.
 */
const LEGACY_HEADER = '<div class="skinHeader focuscontainer-x"><div class="headerTop"><div class="headerLeft"><button type="button" class="headerButton headerButtonLeft headerBackButton"></button><button type="button" class="headerButton headerHomeButton"></button><h3 class="pageTitle pageTitleWithLogo pageTitleWithDefaultLogo" aria-hidden="true"></h3></div><div class="headerRight"><button class="headerSyncButton syncButton headerButton headerButtonRight paper-icon-button-light show-focus" title="SyncPlay"></button><span class="headerSelectedPlayer"></span><button class="headerCastButton castButton headerButton headerButtonRight hide paper-icon-button-light show-focus" title="Cast to Device"></button><button type="button" class="headerButton headerButtonRight headerSearchButton paper-icon-button-light show-focus" title="Search"><span class="material-icons search" aria-hidden="true"></span></button><button class="headerButton headerButtonRight headerUserButton paper-icon-button-light show-focus" title="user"></button></div></div></div>';
const TOOLBAR = '<header class="MuiPaper-root MuiAppBar-root MuiAppBar-colorTransparent mui-fixed css-1u7mpsp"><div class="MuiToolbar-root"><div class="MuiStack-root"><a class="MuiButtonBase-root MuiButton-root" href="#/">Server</a></div><div class="MuiBox-root css-1riowxi"><button class="MuiButtonBase-root MuiIconButton-root MuiIconButton-sizeLarge css-i2hxb6" type="button" aria-label="SyncPlay"><svg class="MuiSvgIcon-root" data-testid="GroupsIcon"><path d="M0 0h24v24H0z"></path></svg></button><button class="MuiButtonBase-root MuiIconButton-root MuiIconButton-sizeLarge css-i2hxb6" type="button" aria-label="Cast to Device"></button><a class="MuiButtonBase-root MuiIconButton-root MuiIconButton-colorInherit MuiIconButton-sizeLarge css-i2hxb6" aria-label="Search" href="#/search"><svg class="MuiSvgIcon-root MuiSvgIcon-fontSizeMedium css-vubbuv" focusable="false" aria-hidden="true" viewBox="0 0 24 24" data-testid="SearchIcon"><path d="M15.5 14h-.79l-.28-.27z"></path></svg></a></div><div class="MuiBox-root css-2uchni"><button class="MuiButtonBase-root MuiIconButton-root" type="button" aria-label="User Menu"></button></div></div></header>';

describe('TV add-on: the Discover page', { timeout: 240_000 }, () => {
  const DATA_MARGIN = '700px 0px';
  const IMAGE_MARGIN = '25% 0px';
  const HASH = '#/jellypass/discover';
  /** An IntersectionObserver the test drives: nothing is near the screen until `cross` says so. */
  const watchers = () => {
    const all = [];
    class IntersectionObserver {
      constructor(callback, options) { this.callback = callback; this.options = options; this.watching = new Set(); all.push(this); }
      observe(element) { this.watching.add(element); }
      unobserve(element) { this.watching.delete(element); }
      disconnect() { this.watching.clear(); }
    }
    return {
      IntersectionObserver,
      all,
      /** `element` comes near (or leaves) the screen, as the observers of `margin` that watch it see it. */
      cross(element, on, margin) {
        for (const watcher of all) if (watcher.watching.has(element) && watcher.options.rootMargin === margin) watcher.callback([{ target: element, isIntersecting: on }]);
      },
    };
  };
  // "New only" is on when the page opens. Each test says which it wants: `hide: 'on'` leaves it as shipped; `hide: 'off'` turns
  // it off as each drawing's toggle appears (before any answer is drawn), for the tests that are about something else.
  const hideOff = (page) => {
    const { MutationObserver } = page.document.defaultView;
    const watch = new MutationObserver(() => {
      const chips = page.document.querySelectorAll('[data-jellypass-tv-focus="chip:hide"][aria-pressed="true"]');
      for (const one of chips) one.click();
    });
    watch.observe(page.document.body, { childList: true, subtree: true });
  };
  const open = async (t, app, { header = LEGACY_HEADER, tv = true, observers = watchers(), hide, ...options } = {}) => {
    assert.ok(hide === 'on' || hide === 'off', 'the test says whether "New only" is on');
    const page = await openJellyfinWeb(t, app, { scopeExtras: observers ? { IntersectionObserver: observers.IntersectionObserver } : undefined, ...options });
    if (hide === 'off') hideOff(page);
    if (tv) page.document.documentElement.classList.add('layout-tv');
    page.document.body.insertAdjacentHTML('afterbegin', header);
    page.home();
    await page.settled();
    page.watchers = observers;
    return page;
  };
  const root = (page) => page.document.querySelector('[data-jellypass-tv-discover]');
  const goTo = async (page) => {
    page.route(HASH);
    await page.settled();
  };
  const rows = (page) => [...page.document.querySelectorAll('.jellypass-tv-discover-row')];
  const heading = (row) => row.querySelector('.sectionTitle').textContent;
  const headings = (page) => rows(page).map(heading);
  const cardsOf = (row) => [...row.querySelectorAll('button.card')];
  const rowNamed = (page, name) => rows(page).find((row) => heading(row) === name);
  const chip = (page, key) => page.document.querySelector(`[data-jellypass-tv-focus="chip:${key}"]`);
  const pressed = (page) => [...page.document.querySelectorAll('.jellypass-tv-discover-chip[aria-pressed="true"]')].map((button) => button.getAttribute('data-jellypass-tv-focus'));
  const focusKey = (page) => page.focused()?.closest('[data-jellypass-tv-focus]')?.getAttribute('data-jellypass-tv-focus') ?? null;
  const discoverCalls = (page, from = 0) => page.calls(from).filter((call) => call.startsWith('GET /discover/'));
  /** Every row that is still waiting comes near the screen, one after the other, so each asks for itself. */
  const scrollThrough = async (page) => {
    for (const row of rows(page)) {
      page.watchers.cross(row, true, DATA_MARGIN);
      await page.settled();
    }
  };
  const badges = (row) => cardsOf(row).map((card) => card.querySelector('.jellypass-tv-discover-badge').textContent);

  // ---- scripted API: the household app's Discover answers, shaped as the API sends them ----
  const json = (body, status = 200, headers) => ({ status, body: JSON.stringify(body), headers });
  const LISTS = ['trending', 'trending-movies', 'trending-tv', 'popular-movies', 'popular-tv', 'new-movies', 'upcoming', 'upcoming-tv'];
  const NETWORKS = [[213, 'Netflix'], [2739, 'Disney+'], [1024, 'Prime Video']].map(([id, name]) => ({ id, name, logoUrl: `https://image.tmdb.org/t/p/w300/l${id}.png`, hasFilms: true }));
  const STUDIOS = [[3, 'Pixar'], [41077, 'A24']].map(([id, name]) => ({ id, name, logoUrl: `https://image.tmdb.org/t/p/w300/s${id}.png` }));
  const STATES = ['in_library', 'requested', 'get_this', 'unavailable', 'get_this'];
  const synth = (id, state = 'get_this', extra = {}) => ({
    mediaType: 'movie', tmdbId: id, title: `Synthetic ${id}`, year: 2020, overview: `About ${id}`, posterUrl: `https://image.tmdb.org/t/p/w342/p${id}.jpg`,
    backdropUrl: `https://image.tmdb.org/t/p/w780/b${id}.jpg`, rating: 7.5, state, play: null, ...extra,
  });
  /** `count` cards for the address `rel`, their ids their own (each address has its own range), states in a fixed rotation. */
  const cardsFor = (rel, count) => {
    const base = 100_000 + [...rel].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) % 8_000, 0) * 100;
    return Array.from({ length: count }, (_, index) => synth(base + index, STATES[index % STATES.length], { mediaType: index % 3 === 2 ? 'tv' : 'movie' }));
  };
  /**
   * A server for the Discover addresses only (anything else goes on to the real app): `cards` is how many cards a list has,
   * `gates` holds an address until its promise is resolved, `failures` answers an address with a status, `seen` lists what was asked.
   */
  const fakeApi = (state = {}) => async (pathname, _init, target) => {
    const rel = pathname.replace('/jellypass/app/v1', '');
    if (!rel.startsWith('/discover/')) return undefined;
    // A further page is its own address (`?page=2`); the first is the plain one.
    const page = Number(target?.searchParams.get('page') ?? 1);
    const asked = page > 1 ? `${rel}?page=${page}` : rel;
    (state.seen ??= []).push(asked);
    if (state.gates?.[asked]) await state.gates[asked];
    if (state.failures?.[asked]) return json({ error: 'x' }, state.failures[asked], state.failureHeaders);
    if (rel === '/discover/sources') return json({ networks: state.networks ?? NETWORKS, studios: STUDIOS });
    const total = state.pages?.[rel] ?? 1;
    // `allAs` makes every card of an address (with its page query) one state: a page the household has all of.
    const results = cardsFor(asked, state.cards ?? 6).map((card) => (state.allAs?.[asked] ? { ...card, state: state.allAs[asked] } : card));
    return json({ page, nextPage: page < total ? page + 1 : null, results });
  };
  const openScripted = async (t, state, options) => open(t, await startApp(t, webWorld(), tvOn()), { override: fakeApi(state), ...options });

  it('is written in the budget file as the page makes it: 5 calls on opening, 10 more as the rows come near the screen, none on Back', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    // With "New only" on, as it is when the page opens: the budget is the same.
    const page = await open(t, app, { hide: 'on' });
    const before = page.requests.length;
    await goTo(page);
    assert.equal(chip(page, 'hide').getAttribute('aria-pressed'), 'true');
    assert.ok(hosting(page));
    assert.equal(root(page).closest('#fallbackPage').id, 'fallbackPage', 'in Jellyfin\'s own page');
    assert.equal(headerTitle(page), 'Discover');
    assert.equal(page.document.getElementById('fallbackPage').getAttribute('data-title'), 'Discover');
    const screen = BUDGET.screens['tv-discover'];
    // No row below the first four has been near the screen: only the eager rows and the sources are asked for.
    assert.deepEqual(discoverCalls(page, before), screen.atOnce, 'on opening');
    assert.equal(screen.atOnce.length, 5);
    await scrollThrough(page);
    assert.deepEqual(discoverCalls(page, before), [...screen.atOnce, ...screen.belowTheFold].sort(), 'once every row has been near the screen');
    assert.equal(discoverCalls(page, before).length, screen.calls, 'each asked once, however often a row comes near');
    assert.deepEqual(headings(page).slice(0, 6), ['Trending', 'Popular movies', 'Popular series', 'New movie releases', 'Upcoming movies', 'Upcoming series']);
    assert.equal(headings(page).filter((name) => name.startsWith('Popular on ')).length, 8, 'the eight services');
    // Back from a title costs the title page's own calls and nothing of Discover's.
    const card = cardsOf(rowNamed(page, 'Popular movies'))[0];
    page.press('keydown');
    card.focus();
    const from = page.location.hash;
    page.click(card);
    assert.equal(page.location.hash, `#/jellypass/title/${card.getAttribute('data-media-type')}/${card.getAttribute('data-tmdb-id')}`);
    page.follow(from);
    await page.settled();
    assert.ok(page.view(), 'the title page is open');
    const mark = page.requests.length;
    page.back();
    await page.settled();
    assert.deepEqual(discoverCalls(page, mark), [], 'no Discover call on Back');
    assert.deepEqual(BUDGET.screens['tv-discover'].back, []);
    assert.ok(root(page), 'the page is back');
  });

  it('is written in the budget file for the chips: Movies and TV ask for their own rows, the kept answers cost nothing, and back to All asks nothing', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await open(t, app, { hide: 'off' });
    const before = page.requests.length;
    await goTo(page);
    assert.deepEqual(pressed(page), ['chip:all']);
    const made = () => new Set(discoverCalls(page, before));
    const afterOpen = [...made()];
    // Movies: what its budget lists, less what All already made (popular, new, the sources: kept).
    page.click(chip(page, 'movies'));
    await page.settled();
    assert.deepEqual(pressed(page), ['chip:movies']);
    const movies = BUDGET.screens['tv-discover-movies'];
    assert.deepEqual(discoverCalls(page, before), [...new Set([...afterOpen, ...movies.atOnce])].sort(), 'Movies at once');
    assert.deepEqual(headings(page).slice(0, 4), ['Trending movies', 'Popular movies', 'New movie releases', 'Upcoming movies']);
    await scrollThrough(page);
    assert.deepEqual(discoverCalls(page, before), [...new Set([...afterOpen, ...movies.atOnce, ...movies.belowTheFold])].sort(), 'Movies, every row near the screen');
    assert.ok(headings(page).slice(4).every((name) => name.startsWith('Popular on ')));
    // Back to All: its eager rows are kept, its lazy ones are not asked for until they come near.
    const mark = page.requests.length;
    page.click(chip(page, 'all'));
    await page.settled();
    assert.deepEqual(discoverCalls(page, mark), [], 'back to All asks nothing');
    assert.deepEqual(pressed(page), ['chip:all']);
    // TV: its three rows and the services, no studios.
    const tvMark = page.requests.length;
    page.click(chip(page, 'tv'));
    await page.settled();
    const tv = BUDGET.screens['tv-discover-tv'];
    assert.deepEqual(headings(page).slice(0, 3), ['Trending series', 'Popular series', 'Upcoming series']);
    assert.ok(discoverCalls(page, tvMark).every((call) => tv.atOnce.includes(call)), 'only what the TV budget lists at once');
    assert.equal(page.document.querySelector('.jellypass-tv-discover-logos'), null, 'no studios on TV');
    // The chips are not sticky: they are in the page, with the hero and the rows.
    assert.equal(chip(page, 'tv').closest('[data-jellypass-tv-discover]'), root(page));
    lacks(readFileSync(path.join(DIST_TV, STYLESHEET), 'utf8'), /position:\s*sticky/, 'a sticky rule');
  });

  // Card sizes are Jellyfin web's, not ours: a card carries its shape's class and padder (card.scss sizes both), its list carries the
  // class Jellyfin's TV sizes are keyed on, and nothing of the add-on's sets a card's width or height. Class names only in what is compared.
  const classesOf = (element) => [...element.classList].sort().join(' ');
  const SHAPES = {
    poster: { card: 'overflowPortraitCard', padder: 'cardPadder-overflowPortrait' },
    backdrop: { card: 'overflowBackdropCard', padder: 'cardPadder-overflowBackdrop' },
  };
  for (const tv of [true, false]) {
    it(`sizes the Discover page's cards with Jellyfin web's own classes in the ${tv ? 'TV' : 'desktop'} layout: posters and wide cards by the shape of their row, in a list that has itemsContainer-tv only on a TV, and loading cards of the same shapes`, async (t) => {
      const page = await open(t, await startApp(t, webWorld(), tvOn()), { hide: 'off', tv });
      await goTo(page);
      // Still loading: the rows below the fold are skeletons in the cards' own markup, before anything is asked.
      const waiting = rows(page).filter((row) => row.querySelector('.jellypass-tv-discover-skeleton'));
      assert.ok(waiting.length > 0, 'some row is loading');
      for (const row of waiting) {
        const list = row.querySelector('.jellypass-tv-row-list');
        assert.equal(list.classList.contains('itemsContainer-tv'), tv, `${heading(row)} loading list`);
        for (const card of list.children) {
          assert.ok(card.classList.contains('card') && (card.classList.contains('overflowPortraitCard') || card.classList.contains('overflowBackdropCard')), classesOf(card));
          const shape = card.classList.contains('overflowPortraitCard') ? SHAPES.poster : SHAPES.backdrop;
          assert.ok(card.querySelector(`.cardBox .cardScalable .cardPadder.${shape.padder}`), `${heading(row)} loading padder`);
          assert.equal(card.getAttribute('style'), null, 'no inline size');
        }
      }
      await scrollThrough(page);
      const seen = new Set();
      for (const row of rows(page)) {
        const list = row.querySelector('.jellypass-tv-row-list');
        if (!list) continue;
        // Jellyfin's TV card sizes are `.itemsContainer-tv > .overflow…Card`: the cards are the list's own children.
        assert.equal(list.classList.contains('itemsContainer-tv'), tv, `${heading(row)} list`);
        assert.equal(list.classList.contains('itemsContainer'), false, `${heading(row)} is not Jellyfin's itemsContainer`);
        for (const card of cardsOf(row)) {
          assert.equal(card.parentNode, list, 'a direct child of the list');
          const shape = card.classList.contains('overflowBackdropCard') ? SHAPES.backdrop : SHAPES.poster;
          seen.add(shape.card);
          assert.equal(card.classList.contains(SHAPES.backdrop.card) !== card.classList.contains(SHAPES.poster.card), true, 'one shape');
          assert.ok(card.querySelector(`.cardBox.cardBox-bottompadded .cardScalable .cardPadder.${shape.padder}`), `${heading(row)} padder`);
          assert.equal(card.getAttribute('style'), null, 'no inline size on the card');
          assert.equal(card.querySelector('.cardScalable').getAttribute('style'), null, 'no inline size on the picture');
          assert.ok(card.querySelector('.cardText.cardText-first') && card.classList.contains('jellypass-tv-card'), 'Jellyfin\'s text classes and the shared ring');
        }
      }
      assert.deepEqual([...seen].sort(), ['overflowBackdropCard', 'overflowPortraitCard'], 'both shapes are on the page');
      // Popular movies / series / new releases are the wide rows, as the layout says; the others are posters.
      assert.ok(cardsOf(rowNamed(page, 'Popular movies')).every((card) => card.classList.contains('overflowBackdropCard')));
      assert.ok(cardsOf(rowNamed(page, 'Trending')).every((card) => card.classList.contains('overflowPortraitCard')));
    });
  }

  it('keeps the add-on\'s stylesheet out of card sizes: no rule sets a width, height, flex-basis or padder of Jellyfin\'s cards or of the add-on\'s loading cards, and Jellyfin\'s own margin rule for a list\'s cards is kept for the row and the grid', () => {
    const css = readFileSync(path.join(DIST_TV, STYLESHEET), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) => selectors.split(',').map((selector) => ({ selector: selector.trim(), body })));
    const sizing = /(?:^|;)\s*(?:width|height|min-width|max-width|min-height|max-height|flex|flex-basis|padding-bottom|padding-top)\s*:/;
    const touchesCard = /(?:\.card\b|Card\b|\.cardPadder|\.cardScalable|\.cardBox|\.jellypass-tv-discover-skeleton-card|\.jellypass-tv-card\b(?!-))/;
    const offenders = rules.filter((rule) => touchesCard.test(rule.selector) && sizing.test(rule.body)).map((rule) => rule.selector);
    // The loading card (jellypass-tv-discover-skeleton-card) and the poster image's fill are the only card rules, and neither sets a size.
    assert.deepEqual(offenders, [], 'a rule sizes a card');
    const margin = rules.find((rule) => rule.selector === '.jellypass-tv-row-list > .card > .cardBox');
    assert.ok(margin && /margin-left:\s*0/.test(margin.body) && /margin-right:\s*1\.2em/.test(margin.body), 'the row keeps Jellyfin\'s margin for a list\'s cards');
    const grid = rules.find((rule) => rule.selector === '.jellypass-tv-source-grid > .card > .cardBox');
    assert.ok(grid && grid.body === margin.body, 'and so does the grid, the same rule');
    for (const old of ['source-skeleton-card', 'discover-skeleton-poster', 'discover-skeleton-backdrop']) assert.equal(css.includes(old), false, `no ${old} rule left`);
    assert.equal(/\.jellypass-tv-source-grid\s*>\s*\.card\s*\{/.test(css), false, 'no grid card size of the add-on\'s');
  });

  it('keeps the status badge a small pill like Jellyfin\'s own indicators: short words, a corner box well under the poster, 88% type, 4.5:1 text on every colour, and the whole sentence in the card\'s name', async (t) => {
    const css = readFileSync(path.join(DIST_TV, STYLESHEET), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) => selectors.split(',').map((selector) => ({ selector: selector.trim(), body })));
    const bodyOf = (selector) => rules.filter((rule) => rule.selector === selector).map((rule) => rule.body).join(';');
    const badge = bodyOf('.jellypass-tv-discover-badge');
    const px = (property) => badge.match(new RegExp(`(?:^|;)\\s*${property}:\\s*([\\d.]+)(em|%)`));
    assert.match(badge, /position:\s*absolute/);
    assert.match(badge, /white-space:\s*nowrap/);
    assert.match(badge, /border-radius:\s*100em/);
    // Type: Jellyfin's `.countIndicator` is 88%; never larger than the card's own secondary text (86%) by more than a hair, never smaller than 80%.
    const font = Number(px('font-size')[1]);
    assert.ok(font >= 80 && font <= 90, `font-size ${font}%`);
    // Padding: a pill, not a banner.
    const padding = badge.match(/padding:\s*([\d.]+)em\s+([\d.]+)em/);
    assert.ok(padding && Number(padding[1]) <= 0.25 && Number(padding[2]) <= 0.6, 'padding');
    // Never wider than most of the poster, and set in from the corner by at most a ring's width and a bit.
    assert.ok(Number(px('max-width')[1]) <= 90 && px('max-width')[2] === '%', 'max-width');
    for (const side of ['top', 'right']) assert.ok(Number(px(side)[1]) <= 0.5 && px(side)[2] === 'em', side);
    assert.equal(/(?:^|;)\s*(?:width|height|min-width|min-height|display)\s*:/.test(badge), false, 'no fixed size or block');
    assert.equal(/(?:^|;)\s*z-index/.test(badge), false);
    // Words: short (so the pill stays small at 10 feet), one per state, and the sentence stays in the card's name.
    const page = await openScripted(t, { cards: 20 }, { hide: 'off' });
    await goTo(page);
    const byState = new Map();
    for (const card of cardsOf(rowNamed(page, 'Trending'))) {
      const sentence = card.getAttribute('aria-label').split(', ').pop();
      byState.set(sentence, card.querySelector('.jellypass-tv-discover-badge').textContent);
    }
    assert.deepEqual([...byState.keys()].sort(), ['Available to get', "Can't request", 'In your library', 'Requested'], 'every state is on the row');
    assert.equal(new Set(byState.values()).size, 4, 'one word each');
    for (const [sentence, words] of byState) {
      assert.ok(words.length <= 10, `${sentence} badge is short`);
      assert.notEqual(words, sentence === 'Requested' ? '' : sentence, 'the badge is not the sentence');
    }
    // Contrast of white text (the pill's own colour) on each tone's background, WCAG 2.x relative luminance.
    const luminance = (hex) => {
      const channel = (index) => { const v = parseInt(hex.slice(1 + index * 2, 3 + index * 2), 16) / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
    };
    for (const tone of ['owned', 'pending', 'open', 'closed']) {
      const background = bodyOf(`.jellypass-tv-discover-badge-${tone}`).match(/background:\s*(#[0-9a-f]{6})/);
      assert.ok(background, `${tone} has a colour`);
      const ratio = 1.05 / (luminance(background[1]) + 0.05);
      assert.ok(ratio >= 4.5, `${tone} contrast ${ratio.toFixed(2)}`);
    }
  });

  it('shows at most 14 cards per row, the household\'s own state on each as words (and a name that says it), and nothing of what is not asked for', async (t) => {
    const state = { cards: 20 };
    const page = await openScripted(t, state, { hide: 'off' });
    await goTo(page);
    await scrollThrough(page);
    for (const row of rows(page)) assert.equal(cardsOf(row).length, 14, heading(row));
    // The rotation of states in the fixture, as the four badges' words; the card's name says it too.
    const row = rowNamed(page, 'Trending');
    assert.deepEqual(badges(row).slice(0, 5), ['In library', 'Requested', 'Get this', "Can't get", 'Get this']);
    const label = cardsOf(row)[0].getAttribute('aria-label');
    assert.match(label, /^Synthetic \d+, 2020, In your library$/);
    // Poster rows draw Jellyfin's portrait card, the three wide rows its backdrop card; both carry the shared focus ring class.
    assert.ok(cardsOf(row).every((card) => card.classList.contains('overflowPortraitCard') && card.classList.contains('jellypass-tv-card') && card.classList.contains('show-focus')));
    assert.ok(cardsOf(rowNamed(page, 'Popular movies')).every((card) => card.classList.contains('overflowBackdropCard')));
    assert.ok(cardsOf(rowNamed(page, 'New movie releases')).every((card) => card.classList.contains('overflowBackdropCard')));
    assert.ok(cardsOf(rowNamed(page, 'Upcoming movies')).every((card) => card.classList.contains('overflowPortraitCard')));
    // Each card is its own focus key, so Back finds it again.
    const keys = cardsOf(row).map((card) => card.getAttribute('data-jellypass-tv-focus'));
    assert.equal(new Set(keys).size, 14);
    assert.ok(keys.every((key) => /^trending:(?:movie|tv):\d+$/.test(key)));
    // The page is the household's view: every string on it is a fixed word or a field set as text (no markup is parsed).
    lacks(readFileSync(path.join(DIST_TV, SCRIPT), 'utf8'), /\binnerHTML\b|insertAdjacentHTML|outerHTML/);
  });

  it('hides what the household has with one chip, no call: in the library and requested go, the row is filled from what is left, and showing them again needs no call either', async (t) => {
    // The API's page has 20 cards (the add-on keeps no more); three of each five are not the household's, so 12 are left.
    const state = { cards: 20 };
    const page = await openScripted(t, state, { hide: 'off' });
    await goTo(page);
    await scrollThrough(page);
    const seen = state.seen.length;
    const before = badges(rowNamed(page, 'Trending'));
    assert.equal(before.length, 14);
    assert.equal(before.filter((words) => words === 'In library' || words === 'Requested').length, 6);
    assert.ok(before.includes('In library') && before.includes('Requested'));
    assert.deepEqual(pressed(page), ['chip:all']);
    page.click(chip(page, 'hide'));
    assert.equal(chip(page, 'hide').getAttribute('aria-pressed'), 'true');
    for (const row of rows(page)) {
      // The 14 shown had 8 that are not held; the row now shows all 12 of the 20 that are: it is filled from the rest of the answer.
      assert.equal(cardsOf(row).length, 12, `${heading(row)} is filled from the rest of the 20`);
      assert.ok(badges(row).every((words) => words === 'Get this' || words === "Can't get"), heading(row));
    }
    assert.equal(state.seen.length, seen, 'no call');
    page.click(chip(page, 'hide'));
    assert.equal(chip(page, 'hide').getAttribute('aria-pressed'), 'false');
    assert.deepEqual(badges(rowNamed(page, 'Trending')), before);
    assert.equal(state.seen.length, seen, 'no call');
    // A row whose every card is held says so, instead of an empty strip.
    const held = await openScripted(t, { cards: 2 }, { hide: 'off' });
    await goTo(held);
    held.click(chip(held, 'hide'));
    const note = rowNamed(held, 'Trending').querySelector('.jellypass-tv-discover-row-note-text');
    assert.equal(note.textContent, 'You already have everything here.');
    assert.equal(cardsOf(rowNamed(held, 'Trending')).length, 0);
  });

  it('draws a hero of up to five slides with Previous, View and Next and dots: no auto-advance, no swipe, View opens the title, and Back keeps the slide', async (t) => {
    const state = { cards: 8 };
    const app = await startApp(t, webWorld(), tvOn());
    const fake = fakeApi(state);
    // The second card has no backdrop: it is not a slide.
    const page = await open(t, app, { hide: 'off', override: async (pathname) => {
      const answer = await fake(pathname);
      if (answer && pathname.endsWith('/discover/trending')) {
        const body = JSON.parse(answer.body);
        body.results[1].backdropUrl = null;
        return json(body);
      }
      return answer;
    } });
    await goTo(page);
    const hero = () => page.document.querySelector('.jellypass-tv-discover-hero');
    const slide = () => hero().querySelector('.jellypass-tv-discover-hero-title').textContent;
    const dots = () => hero().querySelector('.jellypass-tv-discover-hero-dots').textContent;
    const trending = cardsFor('/discover/trending', 8);
    assert.deepEqual(trending.map((card) => card.title).filter((_, index) => index !== 1).slice(0, 5).includes(slide()), true);
    assert.equal(slide(), trending[0].title);
    assert.equal(dots(), '● ○ ○ ○ ○', 'five slides');
    const named = (name) => hero().querySelector(`[data-jellypass-tv-focus="${name}"]`);
    assert.deepEqual([...hero().querySelectorAll('button')].map((button) => button.getAttribute('data-jellypass-tv-focus')), ['hero:previous', 'hero', 'hero:next']);
    assert.equal(named('hero:previous').getAttribute('aria-label'), 'Previous title');
    assert.equal(named('hero:next').getAttribute('aria-label'), 'Next title');
    assert.equal(named('hero').getAttribute('aria-label'), `View ${trending[0].title}`);
    page.click(named('hero:next'));
    assert.equal(slide(), trending[2].title, 'the card without a backdrop is skipped');
    assert.equal(dots(), '○ ● ○ ○ ○');
    page.click(named('hero:previous'));
    page.click(named('hero:previous'));
    assert.equal(slide(), trending[5].title, 'Previous wraps round');
    assert.match(hero().querySelector('.jellypass-tv-discover-hero-facts').textContent, /^(?:Movie|Series)  ·  2020  ·  ★ 7\.5 TMDB  ·  /);
    // No auto-advance: time passing changes nothing and asks nothing.
    const mark = page.requests.length;
    page.advance(10 * 60 * 1000);
    await page.settled();
    assert.equal(slide(), trending[5].title);
    assert.equal(page.requests.length, mark);
    assert.equal(page.timers(), 0, 'no timer of the page\'s is waiting');
    lacks(readFileSync(path.join(DIST_TV, SCRIPT), 'utf8'), /setInterval|touchmove|swipe/);
    // View opens the shown title; Back returns to the same slide.
    const from = page.location.hash;
    page.press('keydown');
    named('hero').focus();
    page.click(named('hero'));
    assert.equal(page.location.hash, `#/jellypass/title/${trending[5].mediaType}/${trending[5].tmdbId}`);
    page.follow(from);
    await page.settled();
    page.back();
    await page.settled();
    assert.equal(slide(), trending[5].title, 'the slide is kept');
    assert.equal(focusKey(page), 'hero', 'and View has focus');
  });

  it('asks for a row when it comes near the screen, sets its images only while it is near and takes them away when it is far, and never uses loading=lazy', async (t) => {
    const state = { cards: 14 };
    const page = await openScripted(t, state, { hide: 'off' });
    await goTo(page);
    const srcs = (node) => [...node.querySelectorAll('img')].filter((image) => image.hasAttribute('src')).length;
    assert.equal(srcs(root(page)), 0, 'no image has a source before anything is near');
    assert.equal(state.seen.filter((rel) => /upcoming/.test(rel)).length, 0, 'a lazy row is not asked for yet');
    const trending = rowNamed(page, 'Trending');
    assert.equal(trending.querySelectorAll('img').length, 14);
    // Near the screen: its images get their sources, a poster row's posters and a backdrop row's backdrops.
    page.watchers.cross(trending, true, IMAGE_MARGIN);
    assert.deepEqual([...trending.querySelectorAll('img')].map((image) => image.getAttribute('src')), cardsFor('/discover/trending', 14).map((card) => card.posterUrl));
    const wide = rowNamed(page, 'Popular movies');
    page.watchers.cross(wide, true, IMAGE_MARGIN);
    assert.deepEqual([...wide.querySelectorAll('img')].map((image) => image.getAttribute('src')), cardsFor('/discover/popular-movies', 14).map((card) => card.backdropUrl));
    // Far from the screen again: the sources go (the boxes stay, so nothing moves).
    page.watchers.cross(trending, false, IMAGE_MARGIN);
    assert.equal(srcs(trending), 0);
    assert.equal(trending.querySelectorAll('button.card').length, 14);
    page.watchers.cross(trending, true, IMAGE_MARGIN);
    assert.equal(srcs(trending), 14, 'and they come back');
    assert.equal(srcs(wide), 14, 'the other row is as it was');
    // A lazy row that is near when its answer arrives is drawn with its images; one that is not, without.
    const upcoming = rowNamed(page, 'Upcoming movies');
    page.watchers.cross(upcoming, true, IMAGE_MARGIN);
    page.watchers.cross(upcoming, true, DATA_MARGIN);
    await page.settled();
    assert.equal(srcs(upcoming), 14);
    const further = rowNamed(page, 'Upcoming series');
    page.watchers.cross(further, true, DATA_MARGIN);
    await page.settled();
    assert.equal(further.querySelectorAll('button.card').length, 14);
    assert.equal(srcs(further), 0);
    // The hero's picture is windowed the same way.
    const picture = page.document.querySelector('.jellypass-tv-discover-hero');
    assert.equal(srcs(picture), 0);
    page.watchers.cross(picture, true, IMAGE_MARGIN);
    assert.equal(picture.querySelector('img').getAttribute('src'), cardsFor('/discover/trending', 14)[0].backdropUrl);
    const source = readFileSync(path.join(DIST_TV, SCRIPT), 'utf8');
    lacks(source, /loading["']?\s*[,:=]\s*["']lazy|\bloading=/, 'loading=lazy');
    for (const image of root(page).querySelectorAll('img')) assert.equal(image.getAttribute('loading'), null);
    for (const image of root(page).querySelectorAll('img')) assert.equal(image.getAttribute('referrerpolicy'), 'no-referrer');
  });

  it('answers only the hero and row cards on the page: those a Hide redraw replaced do nothing, and the index never leaves the slides', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const fake = fakeApi({ cards: 6 });
    // The first five of Trending are held: five slides with Hide off, one with it on.
    const page = await open(t, app, { hide: 'off', override: async (pathname) => {
      const answer = await fake(pathname);
      if (answer && pathname.endsWith('/discover/trending')) {
        const body = JSON.parse(answer.body);
        for (let i = 0; i < 5; i += 1) body.results[i].state = 'in_library';
        body.results[5].state = 'get_this';
        return json(body);
      }
      return answer;
    } });
    await goTo(page);
    const hero = () => page.document.querySelector('.jellypass-tv-discover-hero');
    const named = (name) => hero().querySelector(`[data-jellypass-tv-focus="${name}"]`);
    const title = () => hero().querySelector('.jellypass-tv-discover-hero-title').textContent;
    const trending = cardsFor('/discover/trending', 6);
    for (let i = 0; i < 4; i += 1) page.click(named('hero:next'));
    assert.equal(title(), trending[4].title);
    const old = { previous: named('hero:previous'), view: named('hero'), next: named('hero:next') };
    const oldCards = cardsOf(rowNamed(page, 'Trending'));
    assert.equal(oldCards.length, 6);
    page.click(chip(page, 'hide'));
    assert.equal(hero().querySelector('.jellypass-tv-discover-hero-dots').textContent, '●', 'one slide left');
    const hash = page.location.hash;
    for (const one of [old.view, old.previous, old.next, ...oldCards]) {
      page.click(one);
      assert.equal(page.location.hash, hash, 'a control the redraw replaced opens nothing');
    }
    assert.equal(cardsOf(rowNamed(page, 'Trending')).length, 1);
    assert.equal(title(), trending[5].title, 'the slide did not move');
    const target = `#/jellypass/title/${trending[5].mediaType}/${trending[5].tmdbId}`;
    page.click(cardsOf(rowNamed(page, 'Trending'))[0]);
    assert.equal(page.location.hash, target, 'the new card works');
    page.location.hash = hash;
    page.click(named('hero'));
    assert.equal(page.location.hash, target, 'the new View opens the one slide');
  });

  it('without an IntersectionObserver every row is asked for at once and every image is set', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await open(t, app, { hide: 'off', observers: null });
    const before = page.requests.length;
    await goTo(page);
    assert.equal(discoverCalls(page, before).length, BUDGET.screens['tv-discover'].calls);
    assert.ok([...root(page).querySelectorAll('img')].every((image) => image.hasAttribute('src')));
  });

  it('puts the TMDB notice at the foot of every chip, the JustWatch line on All and Movies, the studios above it as links: the notice is one block the remote can reach', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const page = await open(t, app, { hide: 'off' });
    await goTo(page);
    const foot = () => page.document.querySelector('.jellypass-tv-discover-foot');
    const notice = 'This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.';
    const justWatch = 'Where to watch: US streaming availability from JustWatch, via TMDB.';
    assert.equal(foot().getAttribute('tabindex'), '0', 'a focus stop, so the page can scroll to its foot');
    assert.equal(foot().getAttribute('data-jellypass-tv-focus'), 'foot');
    assert.ok(foot().classList.contains('focusable'), 'Jellyfin\'s own class for a custom focus stop');
    assert.equal(foot().querySelectorAll('button, a, [tabindex]').length, 0, 'the foot holds only words');
    const studios = () => [...page.document.querySelectorAll('.jellypass-tv-discover-logo')];
    const text = () => foot().textContent;
    assert.ok(text().includes(notice) && text().includes(justWatch));
    assert.equal(studios().length > 0, true);
    assert.ok(studios().every((tile) => tile.tagName === 'BUTTON' && tile.getAttribute('role') === 'link' && !foot().contains(tile)), 'the studios are links, above the foot');
    const logo = page.document.querySelector('.jellypass-tv-discover-logo-image');
    assert.equal(logo.closest('button').getAttribute('aria-label') !== '', true, 'a logo\'s tile is named');
    // The last thing on the page is the notice.
    assert.equal(foot().lastElementChild.textContent, notice);
    page.click(chip(page, 'movies'));
    await page.settled();
    assert.ok(text().includes(notice) && text().includes(justWatch) && studios().length > 0, 'Movies');
    page.click(chip(page, 'tv'));
    await page.settled();
    assert.ok(text().includes(notice), 'TV: the notice');
    assert.equal(text().includes(justWatch), false, 'TV: no JustWatch line');
    assert.equal(studios().length, 0, 'TV: no studios');
  });

  it('answers only the Try again on show: a retained one, after the retry has worked, does nothing (a row, and the sources call)', async (t) => {
    const state = { failures: { '/discover/popular-tv': 500, '/discover/sources': 500 } };
    const page = await openScripted(t, state, { hide: 'off' });
    await goTo(page);
    const rowRetry = rowNamed(page, 'Popular series').querySelector('.jellypass-tv-discover-row-note button');
    const sourcesRetry = [...root(page).querySelectorAll('button')].find((button) => button.textContent === 'Try again' && button !== rowRetry);
    assert.ok(rowRetry && sourcesRetry, 'both failures offer Try again');
    delete state.failures['/discover/popular-tv'];
    delete state.failures['/discover/sources'];
    page.click(rowRetry);
    page.click(sourcesRetry);
    await page.settled();
    assert.equal(cardsOf(rowNamed(page, 'Popular series')).length, 6, 'the row was drawn');
    const html = root(page).innerHTML;
    const calls = page.requests.length;
    page.click(rowRetry);
    page.click(sourcesRetry);
    await page.settled();
    assert.equal(page.requests.length, calls, 'no call');
    assert.ok(root(page).innerHTML === html, 'the page is as it was');
    // A retry pressed twice before the answer asks once.
    const again = { failures: { '/discover/popular-tv': 500 } };
    const second = await openScripted(t, again, { hide: 'off' });
    await goTo(second);
    const retry = rowNamed(second, 'Popular series').querySelector('.jellypass-tv-discover-row-note button');
    delete again.failures['/discover/popular-tv'];
    second.click(retry);
    second.click(retry);
    await second.settled();
    assert.equal(again.seen.filter((rel) => rel === '/discover/popular-tv').length, 2, 'one retry');
  });

  it('lets go of every picture and control when the page is left: a kept card opens nothing, a kept image window sets nothing', async (t) => {
    const page = await openScripted(t, { cards: 6 }, { hide: 'off' });
    await goTo(page);
    await scrollThrough(page);
    const row = rowNamed(page, 'Trending');
    const cards = cardsOf(row);
    for (const card of cards) page.watchers.cross(card, true, IMAGE_MARGIN);
    page.watchers.cross(row, true, IMAGE_MARGIN);
    const images = [...root(page).querySelectorAll('img')];
    assert.ok(images.filter((image) => image.hasAttribute('src')).length > 0, 'pictures were set');
    page.route('#/jellypass/service/213');
    await page.settled();
    assert.equal(images.filter((image) => image.hasAttribute('src')).length, 0, 'every picture was let go');
    const hash = page.location.hash;
    page.click(cards[0]);
    page.watchers.cross(cards[0], true, IMAGE_MARGIN);
    assert.equal(page.location.hash, hash, 'the kept card opens nothing');
    assert.equal(images.filter((image) => image.hasAttribute('src')).length, 0, 'a kept image window sets nothing');
  });

  it('leaves a row dead when its Try again meets a refused sign-in: the kept Try again asks nothing', async (t) => {
    const state = { failures: { '/discover/popular-tv': 500 } };
    const page = await openScripted(t, state, { hide: 'off' });
    await goTo(page);
    const retry = rowNamed(page, 'Popular series').querySelector('.jellypass-tv-discover-row-note button');
    state.failures['/discover/popular-tv'] = 401;
    page.click(retry);
    await page.settled();
    assert.match(rowNamed(page, 'Popular series').textContent, /Sign in to continue/);
    const calls = page.requests.length;
    page.click(retry);
    await page.settled();
    assert.equal(page.requests.length, calls, 'the kept Try again asks nothing');
    assert.equal(rowNamed(page, 'Popular series').querySelector('.jellypass-tv-discover-row-note button'), null, 'no Try again for a refused sign-in');
  });

  it('shows a failed row with Try again, which asks once more and only when chosen; a refused sign-in says so; a rate limit says so', async (t) => {
    const state = { failures: { '/discover/popular-tv': 500 } };
    const page = await openScripted(t, state, { hide: 'off' });
    await goTo(page);
    const row = rowNamed(page, 'Popular series');
    assert.match(row.querySelector('.jellypass-tv-discover-row-note-text').textContent, /^Can't load this right now\. /);
    const retry = row.querySelector('.jellypass-tv-discover-row-note button');
    assert.equal(retry.textContent, 'Try again');
    assert.equal(retry.getAttribute('data-jellypass-tv-focus'), 'retry:popular-tv');
    assert.equal(cardsOf(rowNamed(page, 'Trending')).length, 6, 'the other rows are drawn');
    assert.equal(state.seen.filter((rel) => rel === '/discover/popular-tv').length, 1);
    page.advance(5 * 60 * 1000);
    await page.settled();
    assert.equal(state.seen.filter((rel) => rel === '/discover/popular-tv').length, 1, 'nothing retries by itself');
    // The failure is remembered for 30 seconds; the member's retry passes it (the server now answers).
    delete state.failures['/discover/popular-tv'];
    page.click(retry);
    await page.settled();
    assert.equal(state.seen.filter((rel) => rel === '/discover/popular-tv').length, 2);
    assert.equal(cardsOf(rowNamed(page, 'Popular series')).length, 6);
    // Refused (401) and rate limited (429).
    const refused = await openScripted(t, { failures: Object.fromEntries(LISTS.map((list) => [`/discover/${list}`, 401])) }, { hide: 'off' });
    await goTo(refused);
    assert.match(rowNamed(refused, 'Trending').textContent, /Sign in to continue/);
    assert.equal(rowNamed(refused, 'Trending').querySelector('.jellypass-tv-discover-row-note button'), null, 'no Try again for a refused sign-in');
    const limited = await openScripted(t, { failures: { '/discover/popular-tv': 429 }, failureHeaders: { 'retry-after': '3' } }, { hide: 'off' });
    await goTo(limited);
    assert.match(rowNamed(limited, 'Popular series').textContent, /Too many requests/);
  });

  it('draws what is kept when it comes back without asking, and times the answers on the monotonic clock (a clock that moved on alone, or a sleep, ends them)', async (t) => {
    const state = {};
    const page = await openScripted(t, state, { hide: 'off' });
    await goTo(page);
    const from = page.location.hash;
    const away = async () => {
      const card = cardsOf(rowNamed(page, 'Trending'))[0];
      page.click(card);
      page.follow(from);
      await page.settled();
    };
    const back = async () => {
      const mark = state.seen.length;
      page.back();
      await page.settled();
      assert.equal(cardsOf(rowNamed(page, 'Trending')).length, 6, 'drawn');
      return state.seen.length - mark;
    };
    await away();
    assert.equal(await back(), 0, 'kept answers cost nothing');
    // Nine minutes on both clocks: still kept.
    await away();
    page.advance(9 * 60 * 1000);
    assert.equal(await back(), 0);
    // The monotonic clock alone passes ten minutes (the wall clock does not move): the answers are gone and asked for again.
    await away();
    page.clock.mono += 11 * 60 * 1000;
    assert.ok((await back()) > 0, 'the monotonic clock ends them');
    // A long sleep moves only the wall clock: that ends them too.
    await away();
    page.sleep(11 * 60 * 1000);
    assert.ok((await back()) > 0, 'a sleep ends them');
  });

  it('draws a title asked for in the meantime as Requested, from the overlay and with no call', async (t) => {
    const app = await startApp(t, webWorld(), { ...tvOn(), reconcile: true });
    const page = await open(t, app, { hide: 'off' });
    await goTo(page);
    const row = rowNamed(page, 'Trending');
    const target = cardsOf(row).find((card) => card.getAttribute('data-tmdb-id') === String(T_MOVIE));
    assert.ok(target, 'the fixture lists the synthetic movie');
    assert.match(target.getAttribute('aria-label'), /Available to get$/);
    const from = page.location.hash;
    page.click(target);
    page.follow(from);
    await page.settled();
    page.click(page.view().querySelector('.jellypass-tv-title-get'));
    await page.settled();
    const mark = page.requests.length;
    page.back();
    await page.settled();
    const again = cardsOf(rowNamed(page, 'Trending')).find((card) => card.getAttribute('data-tmdb-id') === String(T_MOVIE));
    assert.match(again.getAttribute('aria-label'), /Requested$/);
    assert.equal(again.querySelector('.jellypass-tv-discover-badge').textContent, 'Requested');
    assert.deepEqual(discoverCalls(page, mark), []);
    // And once the two minutes are over the overlay lets go (no call): the server's own word is shown again.
    await app.background.settled();
  });

  describe('"New only": on by default, and the hero follows it', () => {
    const hero = (page) => page.document.querySelector('.jellypass-tv-discover-hero');
    const slideOf = (page) => hero(page).querySelector('.jellypass-tv-discover-hero-title').textContent;
    const dotsOf = (page) => hero(page).querySelector('.jellypass-tv-discover-hero-dots').textContent;
    const slot = (page) => page.document.querySelector('.jellypass-tv-discover-hero-slot');
    const hideChip = (page) => chip(page, 'hide');
    // `/discover/trending` as the scripted API answers it: states in the rotation in_library, requested, get_this, unavailable, get_this, ...
    const trending = (count) => cardsFor('/discover/trending', count);

    it('is on when the page opens, with the same calls as before: the held titles are not in the hero or the rows, the toggle says so, and nothing more is asked', async (t) => {
      const state = { cards: 20 };
      const page = await openScripted(t, state, { hide: 'on' });
      const before = page.requests.length;
      await goTo(page);
      assert.equal(hideChip(page).getAttribute('aria-pressed'), 'true');
      assert.deepEqual(discoverCalls(page, before), BUDGET.screens['tv-discover'].atOnce, 'the budget is as it was');
      // The first two of the answer are in the library and requested: the first slide is the third, and five slides fill from the rest.
      const cards = trending(20);
      assert.equal(slideOf(page), cards[2].title);
      assert.equal(dotsOf(page), '● ○ ○ ○ ○');
      assert.ok(badges(rowNamed(page, 'Trending')).every((words) => words !== 'In library' && words !== 'Requested'));
      assert.equal(discoverCalls(page, before).length, 5);
    });

    it('is called "New only" on the Discover page, named for a screen reader by what it does, and still a toggle button', async (t) => {
      const page = await openScripted(t, { cards: 20 }, { hide: 'on' });
      await goTo(page);
      const toggle = hideChip(page);
      assert.equal(toggle.textContent, 'New only');
      assert.equal(toggle.getAttribute('aria-label'), "New only: show only titles you don't have or haven't requested");
      assert.equal(toggle.getAttribute('aria-pressed'), 'true');
      assert.equal(page.document.body.textContent.includes('Hide what I have'), false);
    });

    it('fills the hero from the next titles with a wide picture, skipping those without one, from the same answer and with no call', async (t) => {
      const state = { cards: 20 };
      const fake = fakeApi(state);
      const page = await open(t, await startApp(t, webWorld(), tvOn()), { hide: 'on', override: async (pathname) => {
        const answer = await fake(pathname);
        if (answer && pathname.endsWith('/discover/trending')) {
          const body = JSON.parse(answer.body);
          body.results[2].backdropUrl = null;
          return json(body);
        }
        return answer;
      } });
      await goTo(page);
      const cards = trending(20);
      const next = () => page.click(hero(page).querySelector('[data-jellypass-tv-focus="hero:next"]'));
      const seen = [slideOf(page)];
      for (let i = 0; i < 4; i += 1) { next(); seen.push(slideOf(page)); }
      // Eligible are 3, 4, 7, 8, 9 (2 has no picture); the page asked for nothing to find them.
      assert.deepEqual(seen, [3, 4, 7, 8, 9].map((index) => cards[index].title));
      assert.equal(dotsOf(page).split(' ').length, 5);
    });

    it('shows them again when it is switched off, and hides them again when it is switched on, with no call and the toggle\'s state in aria-pressed', async (t) => {
      const state = { cards: 20 };
      const page = await openScripted(t, state, { hide: 'on' });
      await goTo(page);
      const cards = trending(20);
      const mark = state.seen.length;
      page.click(hideChip(page));
      assert.equal(hideChip(page).getAttribute('aria-pressed'), 'false');
      assert.equal(slideOf(page), cards[0].title, 'as before: the first of the answer');
      assert.equal(dotsOf(page), '● ○ ○ ○ ○');
      assert.ok(badges(rowNamed(page, 'Trending')).includes('In library'));
      page.click(hideChip(page));
      assert.equal(hideChip(page).getAttribute('aria-pressed'), 'true');
      assert.equal(slideOf(page), cards[2].title);
      assert.equal(state.seen.length, mark, 'no call');
    });

    it('keeps the slide in range when the set shrinks: the index is clamped, and a hero with fewer slides shows fewer dots', async (t) => {
      // Six cards: in the library, requested, get, unavailable, get, in the library. Off: six slides (five shown); on: three.
      const page = await openScripted(t, { cards: 6 }, { hide: 'on' });
      await goTo(page);
      page.click(hideChip(page));
      assert.equal(dotsOf(page), '● ○ ○ ○ ○');
      for (let i = 0; i < 4; i += 1) page.click(hero(page).querySelector('[data-jellypass-tv-focus="hero:next"]'));
      assert.equal(dotsOf(page), '○ ○ ○ ○ ●');
      page.click(hideChip(page));
      assert.equal(dotsOf(page), '○ ○ ●', 'clamped to the last of three');
      assert.equal(slideOf(page), trending(6)[4].title);
    });

    it('hides the hero when no slide is left and draws it again when something is, and focus never falls off the page', async (t) => {
      // Two cards, both held: nothing for the hero while it is on.
      const page = await openScripted(t, { cards: 2 }, { hide: 'on' });
      await goTo(page);
      assert.equal(hero(page), null, 'no empty hero');
      assert.equal(slot(page).children.length, 0);
      page.click(hideChip(page));
      assert.ok(hero(page), 'switched off: the hero is there');
      // Focus is on the hero's View when the choice is made from there (a remote's OK on a button is a click): it moves to the toggle.
      hero(page).querySelector('[data-jellypass-tv-focus="hero"]').focus();
      page.click(hideChip(page));
      assert.equal(hero(page), null);
      assert.equal(focusKey(page), 'chip:hide', 'focus is on the toggle, not nowhere');
      page.click(hideChip(page));
      assert.ok(hero(page), 'and back again');
    });

    it('leaves a title just asked for out of the hero, from the overlay and with no call', async (t) => {
      const app = await startApp(t, webWorld(), { ...tvOn(), reconcile: true });
      const wide = (id, title) => ({ mediaType: 'movie', tmdbId: id, title, year: 2020, overview: '', posterUrl: null, backdropUrl: `https://image.tmdb.org/t/p/w780/b${id}.jpg`, rating: null, state: 'get_this', play: null });
      const answer = { page: 1, nextPage: null, results: [{ ...wide(T_MOVIE, 'Hero One'), title: 'Hero One' }, wide(910_001, 'Hero Two'), wide(910_002, 'Hero Three')] };
      const page = await open(t, app, { hide: 'on', override: (pathname) => (pathname === '/jellypass/app/v1/discover/trending' ? json(answer) : undefined) });
      await goTo(page);
      assert.equal(slideOf(page), 'Hero One');
      assert.equal(dotsOf(page), '● ○ ○');
      const from = page.location.hash;
      page.click(hero(page).querySelector('[data-jellypass-tv-focus="hero"]'));
      page.follow(from);
      await page.settled();
      page.click(page.view().querySelector('.jellypass-tv-title-get'));
      await page.settled();
      const mark = page.requests.length;
      page.back();
      await page.settled();
      assert.equal(slideOf(page), 'Hero Two', 'what was just asked for is no longer in the hero');
      assert.equal(dotsOf(page), '● ○');
      assert.deepEqual(discoverCalls(page, mark), []);
      page.click(hideChip(page));
      assert.equal(dotsOf(page), '● ○ ○');
      assert.equal(slideOf(page), 'Hero One', 'shown again with its new state when switched off');
      await app.background.settled();
    });

    it('puts the default back for the next member or sign-in, remembers a choice only in memory, and stores nothing', async (t) => {
      const state = {};
      const page = await openScripted(t, state, { hide: 'on' });
      await goTo(page);
      page.click(hideChip(page));
      assert.equal(hideChip(page).getAttribute('aria-pressed'), 'false');
      // Away and back (a title and Back): the choice is as left.
      const from = page.location.hash;
      page.click(cardsOf(rowNamed(page, 'Trending'))[0]);
      page.follow(from);
      await page.settled();
      page.back();
      await page.settled();
      assert.equal(hideChip(page).getAttribute('aria-pressed'), 'false', 'remembered for the session');
      // Another member: the default, on.
      page.session.user = ANN;
      page.session.token = TOKENS[ANN];
      page.document.body.appendChild(page.document.createElement('div'));
      await page.settled();
      page.goTo('#/home.html');
      await goTo(page);
      assert.equal(hideChip(page).getAttribute('aria-pressed'), 'true');
      // Nothing of it is stored.
      lacks(readFileSync(path.join(DIST_TV, SCRIPT), 'utf8'), /localStorage|sessionStorage|indexedDB/);
    });
  });

  const SESSION_CHANGES = {
    'a sign-out': (page) => { page.session.user = null; page.session.token = null; },
    'another member': (page) => { page.session.user = ANN; page.session.token = TOKENS[ANN]; },
    'a new token for the same member': (page) => { page.session.token = 'token-after-a-new-sign-in'; },
  };

  describe('signed in, session and member', () => {
    it('ends the page when no one is signed in or another member is, asks nothing more, and forgets the chip and the toggle', async (t) => {
      const state = {};
      const page = await openScripted(t, state, { hide: 'on' });
      await goTo(page);
      page.click(chip(page, 'movies'));
      page.click(chip(page, 'hide'));
      assert.equal(chip(page, 'hide').getAttribute('aria-pressed'), 'false', 'switched off');
      await page.settled();
      const asked = state.seen.length;
      page.session.user = null;
      page.session.token = null;
      page.document.body.appendChild(page.document.createElement('div'));
      await page.settled();
      assert.equal(root(page), null, 'emptied');
      page.session.user = ALICE;
      page.session.token = TOKENS[ALICE];
      page.document.body.appendChild(page.document.createElement('div'));
      await page.settled();
      assert.equal(state.seen.length, asked, 'nothing was asked meanwhile');
      // Another member opens it: it starts as All, with nothing hidden, and none of the first member's answers.
      page.session.user = ANN;
      page.session.token = TOKENS[ANN];
      page.document.body.appendChild(page.document.createElement('div'));
      await page.settled();
      page.goTo('#/home.html');
      await goTo(page);
      assert.deepEqual(pressed(page), ['chip:all', 'chip:hide']);
      assert.equal(chip(page, 'hide').getAttribute('aria-pressed'), 'true', 'the default is back: on');
      assert.equal(state.seen.length > asked, true, 'asked afresh');
    });

    it('drops an answer that comes back after a sign-out: nothing is drawn, and nothing is asked for it', async (t) => {
      let release;
      // Home's own row asks for Trending too, so the held call is another eager row's.
      const state = { gates: { '/discover/popular-movies': new Promise((resolve) => { release = resolve; }) } };
      const page = await openScripted(t, state, { hide: 'off' });
      page.route(HASH);
      await pause(200);
      assert.equal(cardsOf(rowNamed(page, 'Popular movies')).length, 0, 'the row is waiting');
      assert.equal(cardsOf(rowNamed(page, 'Trending')).length, 6, 'the others are drawn');
      page.session.user = null;
      page.session.token = null;
      page.document.body.appendChild(page.document.createElement('div'));
      await pause(200);
      assert.equal(root(page), null, 'ended');
      const mark = page.requests.length;
      release();
      await page.settled();
      assert.equal(root(page), null);
      assert.equal(page.document.querySelectorAll('.jellypass-tv-discover-row').length, 0, 'nothing from the late answer');
      assert.equal(page.requests.length, mark, 'nothing more was asked');
    });

    it('signed in again with a new token, a late answer of the old session is not shown: the page is drawn afresh from the new session\'s own calls', async (t) => {
      let release;
      const state = { gates: { '/discover/popular-movies': new Promise((resolve) => { release = resolve; }) } };
      const calls = [];
      const fake = fakeApi(state);
      const page = await open(t, await startApp(t, webWorld(), tvOn()), { hide: 'off', override: async (pathname, init) => { calls.push(JSON.stringify(init.headers)); return fake(pathname); } });
      page.route(HASH);
      await pause(200);
      page.session.token = 'token-after-a-new-sign-in';
      page.document.body.appendChild(page.document.createElement('div'));
      release();
      await page.settled();
      // The old session's answer was dropped whole; the page asked again under the new token, and drew that.
      assert.equal(cardsOf(rowNamed(page, 'Popular movies')).length, 6);
      assert.ok(calls.some((headers) => headers.includes('token-after-a-new-sign-in')), 'a call under the new token');
      assert.equal(state.seen.filter((rel) => rel === '/discover/popular-movies').length, 2, 'asked again for the new session');
    });

    it('drawn afresh under a new token, what the earlier drawing left is dead: a kept card, hero button, chip, hide toggle or Try again does nothing, and the new ones work', async (t) => {
      const state = { failures: { '/discover/popular-tv': 500 } };
      const page = await openScripted(t, state, { hide: 'off' });
      await goTo(page);
      const keep = () => ({
        card: cardsOf(rowNamed(page, 'Trending'))[0],
        hero: page.document.querySelector('[data-jellypass-tv-focus="hero"]'),
        next: page.document.querySelector('[data-jellypass-tv-focus="hero:next"]'),
        movies: chip(page, 'movies'),
        hide: chip(page, 'hide'),
        retry: rowNamed(page, 'Popular series').querySelector('.jellypass-tv-discover-row-note button'),
      });
      const old = keep();
      assert.ok(Object.values(old).every((one) => one), 'every kind of element was found');
      page.session.token = 'token-after-a-new-sign-in';
      page.document.body.appendChild(page.document.createElement('div'));
      await page.settled();
      const fresh = keep();
      for (const name of Object.keys(old)) assert.ok(old[name] !== fresh[name], `${name} was drawn again`);
      const html = root(page).innerHTML;
      const hash = page.location.hash;
      const calls = page.requests.length;
      for (const one of Object.values(old)) page.click(one);
      await page.settled();
      assert.ok(root(page).innerHTML === html, 'the page is as it was');
      assert.equal(page.location.hash, hash, 'no title opened');
      assert.equal(page.requests.length, calls, 'no call');
      // The new elements work.
      page.click(fresh.movies);
      await page.settled();
      assert.equal(fresh.movies.getAttribute('aria-pressed'), 'true');
      page.click(cardsOf(rowNamed(page, 'Popular movies'))[0]);
      assert.notEqual(page.location.hash, hash, 'a new card opens its title');
    });

    /** What changes under the page with no page change in between: `update` (the cleanup) has not run when the callback is delivered. */
    const imagesWithSrc = (page) => root(page).querySelectorAll('img[src]').length;

    for (const [name, change] of Object.entries(SESSION_CHANGES)) {
      describe(`a callback delivered right after ${name}, before the page has been cleaned up`, () => {
        it('sets no image: the image window moving does nothing (no src, no call)', async (t) => {
          const state = {};
          const page = await openScripted(t, state, { hide: 'off' });
          await goTo(page);
          const row = rowNamed(page, 'Popular movies');
          assert.ok(cardsOf(row).length > 0);
          assert.equal(imagesWithSrc(page), 0, 'nothing is near the screen yet');
          const html = root(page).innerHTML;
          const calls = page.requests.length;
          change(page);
          page.watchers.cross(row, true, IMAGE_MARGIN);
          page.watchers.cross(page.document.querySelector('.jellypass-tv-discover-hero'), true, IMAGE_MARGIN);
          assert.equal(imagesWithSrc(page), 0, 'no image got a src');
          assert.ok(root(page).innerHTML === html, 'the page is as it was');
          assert.equal(page.requests.length, calls, 'no call');
        });

        it('asks for no row: the data window moving does nothing', async (t) => {
          const state = {};
          const page = await openScripted(t, state, { hide: 'off' });
          await goTo(page);
          const waiting = rows(page).filter((row) => cardsOf(row).length === 0 && row.querySelector('.jellypass-tv-discover-skeleton'));
          assert.ok(waiting.length > 3);
          const html = root(page).innerHTML;
          const seen = state.seen.length;
          const calls = page.requests.length;
          change(page);
          for (const row of waiting) page.watchers.cross(row, true, DATA_MARGIN);
          await page.settled();
          assert.equal(state.seen.length, seen, 'nothing asked');
          assert.equal(page.requests.length, calls, 'no call');
          assert.ok(root(page).innerHTML === html, 'the page is as it was');
        });

        it('does nothing for the chips, the hide toggle, the hero\'s buttons or a card', async (t) => {
          const state = {};
          const page = await openScripted(t, state, { hide: 'off' });
          await goTo(page);
          const html = root(page).innerHTML;
          const hash = page.location.hash;
          const calls = page.requests.length;
          change(page);
          page.click(chip(page, 'movies'));
          page.click(chip(page, 'hide'));
          page.click(page.document.querySelector('[data-jellypass-tv-focus="hero:next"]'));
          page.click(page.document.querySelector('[data-jellypass-tv-focus="hero"]'));
          page.click(cardsOf(rowNamed(page, 'Trending'))[0]);
          await page.settled();
          assert.ok(root(page).innerHTML === html, 'the page is as it was');
          assert.equal(page.location.hash, hash, 'no title opened');
          assert.equal(page.requests.length, calls, 'no call');
        });

        it('draws no answer: a held row\'s answer delivered after the change adds nothing and asks nothing', async (t) => {
          let release;
          const state = { gates: { '/discover/popular-movies': new Promise((resolve) => { release = resolve; }) } };
          const page = await openScripted(t, state, { hide: 'off' });
          page.route(HASH);
          await pause(200);
          assert.equal(cardsOf(rowNamed(page, 'Popular movies')).length, 0, 'the row is waiting');
          const html = root(page).innerHTML;
          change(page);
          const calls = page.requests.length;
          release();
          await pause(200);
          assert.ok(root(page).innerHTML === html, 'the page is as it was');
          assert.equal(page.requests.length, calls, 'no call');
        });
      });
    }

    it('calls only the origin it came from: signed in elsewhere nothing is sent, and a card chosen then opens nothing', async (t) => {
      const state = {};
      const page = await openScripted(t, state, { hide: 'off' });
      await goTo(page);
      const card = cardsOf(rowNamed(page, 'Trending'))[0];
      page.session.serverAddress = 'https://jelly-mill.example.test';
      const before = [page.requests.length, page.location.hash];
      page.click(card);
      assert.deepEqual([page.requests.length, page.location.hash], before);
      for (const request of page.requests) assert.ok(request.url.startsWith('https://jelly-grove.example.test/'), 'only this origin');
    });
  });

  it('renders the same page, with the same calls, whatever other households hold or asked for', async (t) => {
    const seen = {};
    for (const [name, state] of Object.entries({ baseline: world(), ...otherHouseholdWorlds() })) {
      const app = await startApp(t, Object.assign(state, { webPage: {} }), { ...tvOn(), reconcile: true });
      const page = await open(t, app, { hide: 'off' });
      const before = page.requests.length;
      await goTo(page);
      await scrollThrough(page);
      const view = root(page).outerHTML;
      assertNoCanaries(view, `${name}: the page shows Seerr data planted as a canary`);
      seen[name] = { calls: page.trace(before), view };
    }
    const { baseline, ...others } = seen;
    assert.ok(Object.keys(others).length >= 5);
    assert.ok(baseline.calls.length >= 15);
    for (const [name, outcome] of Object.entries(others)) {
      assert.deepEqual(outcome.calls, baseline.calls, `${name}: the calls the add-on made`);
      assert.ok(outcome.view === baseline.view, `${name}: the page differs`);
    }
  });

  describe('the header button', () => {
    const entries = (page) => [...page.document.querySelectorAll('[data-jellypass-tv-discover-entry]')];
    const right = (page) => page.document.querySelector('.skinHeader .headerRight');
    const names = (parent) => [...parent.children].map((child) => (child.hasAttribute('data-jellypass-tv-discover-entry') ? 'DISCOVER' : child.getAttribute('title') || child.getAttribute('aria-label') || child.className.split(' ')[0]));
    const mutate = async (page) => {
      page.document.body.appendChild(page.document.createElement('div'));
      await page.settled();
    };

    it('is a compass button immediately before Search in the TV layout\'s header, in Jellyfin\'s own header-button classes, and opens the page', async (t) => {
      const page = await open(t, await startApp(t, webWorld(), tvOn()), { hide: 'off' });
      assert.equal(entries(page).length, 1);
      const [button] = entries(page);
      assert.deepEqual(names(right(page)), ['SyncPlay', 'headerSelectedPlayer', 'Cast to Device', 'DISCOVER', 'Search', 'user']);
      assert.equal(button.nextElementSibling, right(page).querySelector('.headerSearchButton'));
      assert.equal(button.tagName, 'BUTTON');
      assert.equal(button.getAttribute('type'), 'button');
      assert.equal(button.className, 'headerButton headerButtonRight paper-icon-button-light show-focus', 'Search\'s classes less its own');
      assert.equal(button.getAttribute('aria-label'), 'Discover');
      assert.equal(button.getAttribute('title'), 'Discover');
      assert.equal(button.querySelector('.material-icons').className, 'material-icons explore');
      // Opens the page (the address is set; Jellyfin web's router does the rest).
      page.click(button);
      assert.equal(page.location.hash, HASH);
      // Not drawn twice, whatever changes on the page.
      await mutate(page);
      await mutate(page);
      assert.equal(entries(page).length, 1);
    });

    it('is the only way in: Home\'s row has no Discover heading link and no Discover card', async (t) => {
      const page = await open(t, await startApp(t, webWorld(), tvOn()), { hide: 'off' });
      const [row] = page.rows();
      assert.equal(row.querySelector('h2').children.length, 0, 'the heading is text');
      assert.equal(row.querySelectorAll('a, h2 button').length, 0);
      assert.deepEqual([...row.querySelectorAll('[data-jellypass-tv-link]')].map((link) => link.getAttribute('aria-label')), ['My requests']);
      assert.ok([...row.querySelectorAll('button')].every((button) => !/discover/i.test(button.getAttribute('aria-label') ?? '')), 'no card that says Discover');
    });

    it('is in the desktop layout\'s toolbar, before its Search link, in the toolbar\'s own classes and icon, whose Search page state it does not copy', async (t) => {
      const page = await open(t, await startApp(t, webWorld(), tvOn()), { hide: 'off', header: LEGACY_HEADER + TOOLBAR, tv: false });
      assert.equal(entries(page).length, 1);
      const [button] = entries(page);
      assert.equal(button.parentNode.className, 'MuiBox-root css-1riowxi');
      assert.deepEqual(names(button.parentNode), ['SyncPlay', 'Cast to Device', 'DISCOVER', 'Search']);
      assert.equal(button.nextElementSibling.getAttribute('aria-label'), 'Search');
      assert.equal(button.className, 'MuiButtonBase-root MuiIconButton-root MuiIconButton-colorInherit MuiIconButton-sizeLarge css-i2hxb6 jellypass-tv-discover-entry');
      const icon = button.querySelector('svg');
      assert.equal(icon.getAttribute('class'), 'MuiSvgIcon-root MuiSvgIcon-fontSizeMedium css-vubbuv');
      assert.equal(icon.getAttribute('data-testid'), null);
      assert.match(icon.querySelector('path').getAttribute('d'), /^M12 10\.9c/);
      assert.equal(icon.querySelectorAll('path').length, 1);
      assert.equal(right(page).querySelector('[data-jellypass-tv-discover-entry]'), null, 'the hidden legacy header gets none');
      // The Search link of the Search page is disabled; the button never is.
      page.document.querySelector('header a[aria-label="Search"]').className += ' Mui-disabled';
      page.document.querySelector('[data-jellypass-tv-discover-entry]').remove();
      await mutate(page);
      assert.equal(entries(page)[0].className.includes('Mui-disabled'), false);
      page.click(entries(page)[0]);
      assert.equal(page.location.hash, HASH);
    });

    it('uses the TV layout\'s legacy header when it is the layout, even with a toolbar in the page', async (t) => {
      const page = await open(t, await startApp(t, webWorld(), tvOn()), { hide: 'off', header: LEGACY_HEADER + TOOLBAR, tv: true });
      assert.equal(entries(page).length, 1);
      assert.equal(entries(page)[0].parentNode, right(page));
    });

    it('is put back when Jellyfin draws its header again without it, and goes with the sign-in: removed on sign-out, drawn for another member', async (t) => {
      const page = await open(t, await startApp(t, webWorld(), tvOn()), { hide: 'off' });
      entries(page)[0].remove();
      await mutate(page);
      assert.equal(entries(page).length, 1, 'put back');
      const first = entries(page)[0].getAttribute('data-jellypass-tv-discover-entry');
      assert.equal(first, TOKENS[ALICE] ? ALICE : first);
      page.session.user = null;
      page.session.token = null;
      await mutate(page);
      assert.equal(entries(page).length, 0, 'removed on sign-out');
      page.session.user = ANN;
      page.session.token = TOKENS[ANN];
      await mutate(page);
      assert.equal(entries(page).length, 1);
      assert.equal(entries(page)[0].getAttribute('data-jellypass-tv-discover-entry'), ANN, 'drawn for the member now signed in');
      // A click of a button drawn for a member since gone opens nothing.
      const stale = entries(page)[0];
      page.session.user = ALICE;
      page.session.token = TOKENS[ALICE];
      const hash = page.location.hash;
      page.click(stale);
      assert.equal(page.location.hash, hash);
    });

    it('survives the desktop toolbar being drawn again, as React does: replaced by a copy that carries the button, by a pristine one, or removed and restored, never twice', async (t) => {
      const page = await open(t, await startApp(t, webWorld(), tvOn()), { hide: 'off', header: LEGACY_HEADER + TOOLBAR, tv: false });
      const bar = () => page.document.querySelector('header.MuiAppBar-root');
      const here = () => entries(page).filter((button) => button.closest('header.MuiAppBar-root')).length;
      assert.equal(entries(page).length, 1);
      // Focus on the button, then the whole toolbar is replaced by a deep copy (which carries a second button with it).
      entries(page)[0].focus();
      bar().replaceWith(bar().cloneNode(true));
      await mutate(page);
      assert.deepEqual([entries(page).length, here()], [1, 1], 'a copy that carried the button: still one');
      const link = () => bar().querySelector('a[aria-label="Search"]');
      assert.equal(entries(page)[0].nextElementSibling, link(), 'before Search');
      // The copy's button still opens Discover, once (a cloned button has lost its listener, so it was drawn again).
      const opened = [];
      const first = page.location.hash;
      page.click(entries(page)[0]);
      assert.equal(page.location.hash, HASH, 'the compass of a cloned toolbar opens Discover');
      page.route(HASH);
      await page.settled();
      opened.push(page.document.querySelectorAll('[data-jellypass-tv-discover]').length);
      assert.deepEqual(opened, [1], 'one page');
      page.location.hash = first;
      await page.settled();
      // A pristine toolbar (React drew it afresh): the button is put back.
      const pristine = bar().cloneNode(true);
      for (const button of pristine.querySelectorAll('[data-jellypass-tv-discover-entry]')) button.remove();
      bar().replaceWith(pristine);
      await mutate(page);
      assert.deepEqual([entries(page).length, here()], [1, 1], 'a pristine copy: put back once');
      assert.equal(entries(page)[0].nextElementSibling, link());
      // Removed: nothing is drawn anywhere (the hidden legacy header is not a place for it); restored: back.
      const saved = pristine.cloneNode(true);
      for (const button of saved.querySelectorAll('[data-jellypass-tv-discover-entry]')) button.remove();
      bar().remove();
      await mutate(page);
      assert.equal(entries(page).length, 0, 'no toolbar, no button, not in the legacy header either');
      page.document.body.insertBefore(saved, page.document.body.firstChild);
      await mutate(page);
      assert.deepEqual([entries(page).length, here()], [1, 1], 'restored: back once');
      // Jellyfin's own Search link is untouched by all of it, and a click still reaches it.
      assert.equal(link().getAttribute('href'), '#/search');
    });

    it('draws nothing, and nothing breaks, when the header is not as expected: no actions box, no Search, Search hidden, a toolbar without its Search link or with a different icon', async (t) => {
      const cases = {
        'no actions box': LEGACY_HEADER.replace('class="headerRight"', 'class="somethingElse"'),
        'no Search button': LEGACY_HEADER.replace('headerSearchButton', 'headerFindButton'),
        'Search hidden': LEGACY_HEADER.replace('headerSearchButton paper', 'headerSearchButton hide paper'),
        'Search not a direct child': LEGACY_HEADER.replace('<button type="button" class="headerButton headerButtonRight headerSearchButton paper-icon-button-light show-focus" title="Search"><span class="material-icons search" aria-hidden="true"></span></button>', '<span><button type="button" class="headerSearchButton"></button></span>'),
      };
      for (const [name, header] of Object.entries(cases)) {
        const page = await open(t, await startApp(t, webWorld(), tvOn()), { hide: 'off', header });
        assert.equal(entries(page).length, 0, name);
        // The page itself is still there by its address (there is then no way in from the header).
        await goTo(page);
        assert.ok(root(page), `${name}: the address still opens the page`);
      }
      const toolbars = {
        'no href': TOOLBAR.replace(' href="#/search"', ''),
        'two paths': TOOLBAR.replace('<path d="M15.5 14h-.79l-.28-.27z"></path>', '<path d="M0 0z"></path><path d="M1 1z"></path>'),
        'no icon': TOOLBAR.replace(/<svg class="MuiSvgIcon-root MuiSvgIcon-fontSizeMedium[\s\S]*?<\/svg>/, ''),
        'no toolbar class': TOOLBAR.replace('MuiAppBar-root', 'SomethingElse'),
      };
      // The desktop layout keeps the legacy header in the page, hidden and intact: a toolbar whose Search is gone is not a reason to use it.
      for (const [name, toolbar] of Object.entries({ 'Search renamed': TOOLBAR.replace('aria-label="Search"', 'aria-label="Find"'), ...toolbars})) {
        const page = await open(t, await startApp(t, webWorld(), tvOn()), { hide: 'off', header: LEGACY_HEADER + toolbar, tv: false });
        assert.equal(entries(page).length, 0, `${name}, with the legacy header intact`);
      }
      for (const [name, toolbar] of Object.entries(toolbars)) {
        const page = await open(t, await startApp(t, webWorld(), tvOn()), { hide: 'off', header: LEGACY_HEADER.replace('headerSearchButton', 'headerFindButton') + toolbar, tv: false });
        assert.equal(entries(page).length, 0, name);
      }
    });
  });

  describe('service and studio pages', () => {
    const SERVICE = '#/jellypass/service/213';
    const STUDIO = '#/jellypass/studio/3';
    const sourceRoot = (page) => page.document.querySelector('[data-jellypass-tv-source]');
    const gridCards = (page) => [...page.document.querySelectorAll('.jellypass-tv-source-grid button.card')];
    const tabKeys = (page) => [...page.document.querySelectorAll('[data-jellypass-tv-focus^="tab:"]')].map((button) => button.getAttribute('data-jellypass-tv-focus').slice(4));
    const tab = (page, list) => page.document.querySelector(`[data-jellypass-tv-focus="tab:${list}"]`);
    const tabPressed = (page) => [...page.document.querySelectorAll('[data-jellypass-tv-focus^="tab:"][aria-pressed="true"]')].map((button) => button.getAttribute('data-jellypass-tv-focus').slice(4));
    const more = (page) => page.document.querySelector('[data-jellypass-tv-focus="more"]');
    const h1 = (page) => sourceRoot(page).querySelector('h1').textContent;
    /** The Discover addresses asked since `from`, with their page query. */
    const asked = (page, from = 0) => page.requests.slice(from).map((request) => new URL(request.url)).filter((url) => url.pathname.includes('/discover/')).map((url) => url.pathname.replace('/jellypass/app/v1', '') + url.search);
    const NOTICE = 'This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.';
    const JUSTWATCH = 'Where to watch: US streaming availability from JustWatch, via TMDB.';
    const toHash = async (page, hash) => {
      page.route(hash);
      await page.settled();
    };

    it('is written in the budget file as the page makes it: a service opened directly asks for the sources and its All list, a studio for the sources and its movies', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const page = await open(t, app, { hide: 'off' });
      const before = page.requests.length;
      await toHash(page, SERVICE);
      const service = BUDGET.screens['tv-discover-network'];
      assert.deepEqual(discoverCalls(page, before), service.atOnce.map((call) => call.replace('{id}', '213')).sort());
      assert.equal(discoverCalls(page, before).length, service.calls);
      assert.ok(hosting(page));
      assert.equal(sourceRoot(page).closest('#fallbackPage').id, 'fallbackPage', 'in Jellyfin\'s own page');
      assert.equal(headerTitle(page), 'Netflix');
      assert.equal(h1(page), 'Popular on Netflix');
      assert.ok(gridCards(page).length > 0);
      const mark = page.requests.length;
      await toHash(page, STUDIO);
      const studio = BUDGET.screens['tv-discover-studio'];
      // The sources are kept: only the studio's own list is asked for.
      assert.deepEqual(discoverCalls(page, mark), studio.atOnce.filter((call) => !call.endsWith('/sources')).map((call) => call.replace('{id}', '3')).sort());
      assert.equal(headerTitle(page), 'Pixar movies');
      assert.equal(studio.calls, 2);
    });

    it('costs nothing more when the service\'s row was loaded: the heading link opens it on the list the row shows, under every chip', async (t) => {
      const state = { cards: 20 };
      const page = await openScripted(t, state, { hide: 'off' });
      await goTo(page);
      await scrollThrough(page);
      const from = page.location.hash;
      const link = rowNamed(page, 'Popular on Netflix').querySelector('h2 button');
      const mark = page.requests.length;
      page.click(link);
      assert.equal(page.location.hash, SERVICE);
      page.follow(from);
      await page.settled();
      assert.deepEqual(asked(page, mark), [], 'the row\'s page 1 and the sources are kept');
      assert.deepEqual(tabPressed(page), ['all']);
      assert.equal(gridCards(page).length, 20);
      // On the Movies chip the row lists films, so the page opens on Films, still with no call.
      page.back();
      await page.settled();
      page.click(chip(page, 'movies'));
      await page.settled();
      await scrollThrough(page);
      const films = rowNamed(page, 'Popular on Netflix').querySelector('h2 button');
      const next = page.requests.length;
      page.click(films);
      page.follow(page.location.hash === SERVICE ? '#/jellypass/discover' : page.location.hash);
      await page.settled();
      assert.deepEqual(tabPressed(page), ['films']);
      assert.deepEqual(asked(page, next), [], 'the Films row\'s page 1 is kept');
      assert.equal(h1(page), 'Films on Netflix');
    });

    it('has All, Series and Films tabs for a service with films and its series only for one without; the lists are asked for once each, and the JustWatch line is under All and Films', async (t) => {
      const state = { cards: 20, networks: [...NETWORKS, { id: 9, name: 'Series Only', logoUrl: null, hasFilms: false }] };
      const page = await openScripted(t, state, { hide: 'off' });
      await toHash(page, SERVICE);
      assert.deepEqual(tabKeys(page), ['all', 'series', 'films']);
      assert.deepEqual(tabPressed(page), ['all']);
      const text = () => sourceRoot(page).textContent;
      assert.ok(text().includes(JUSTWATCH) && text().includes(NOTICE));
      const mark = page.requests.length;
      page.click(tab(page, 'series'));
      await page.settled();
      assert.deepEqual(asked(page, mark), ['/discover/network/213']);
      assert.deepEqual(tabPressed(page), ['series']);
      assert.equal(h1(page), 'Series on Netflix');
      assert.equal(text().includes(JUSTWATCH), false, 'no JustWatch line under Series');
      page.click(tab(page, 'films'));
      await page.settled();
      assert.deepEqual(asked(page, mark), ['/discover/network/213', '/discover/network/213/films']);
      assert.equal(h1(page), 'Films on Netflix');
      assert.ok(text().includes(JUSTWATCH));
      page.click(tab(page, 'all'));
      await page.settled();
      assert.equal(asked(page, mark).length, 2, 'back to All asks nothing');
      assert.equal(h1(page), 'Popular on Netflix');
      assert.equal(gridCards(page).length, 20);
      // A service with no films has its series only, no tabs, no JustWatch line.
      await toHash(page, '#/jellypass/service/9');
      assert.deepEqual(tabKeys(page), []);
      assert.equal(h1(page), 'Series on Series Only');
      assert.equal(sourceRoot(page).textContent.includes(JUSTWATCH), false);
      assert.equal(asked(page).includes('/discover/network/9'), true);
      assert.equal(asked(page).includes('/discover/network/9/all'), false);
      assert.equal(sourceRoot(page).querySelector('.jellypass-tv-source-logo').textContent, 'Series Only', 'the name where there is no logo');
    });

    it('loads 20 cards a press: Load more asks for the next page, the first new card takes focus, the last page ends it, and a failure keeps the cards and asks again only when chosen', async (t) => {
      const state = { cards: 20, pages: { '/discover/network/213/all': 3 }, failures: { '/discover/network/213/all?page=3': 500 } };
      const page = await openScripted(t, state, { hide: 'off' });
      await toHash(page, SERVICE);
      assert.equal(gridCards(page).length, 20);
      assert.equal(more(page).textContent, 'Load more');
      const mark = page.requests.length;
      more(page).focus();
      page.click(more(page));
      assert.equal(more(page).textContent, 'Loading…', 'while it is asked');
      page.click(more(page));
      await page.settled();
      assert.deepEqual(asked(page, mark), ['/discover/network/213/all?page=2'], 'one call for the press (and none for a second press while it is asked)');
      assert.equal(gridCards(page).length, 40);
      assert.equal(page.focused(), gridCards(page)[20], 'the first new card has focus');
      assert.equal(page.document.querySelector('[role=status]').textContent, 'More results loaded.');
      assert.equal(new Set(gridCards(page).map((card) => card.getAttribute('data-jellypass-tv-focus'))).size, 40, 'each card its own focus key');
      // The third page fails: the 40 stay, the words say why, and Load more asks again only when chosen.
      page.click(more(page));
      await page.settled();
      assert.equal(gridCards(page).length, 40);
      assert.match(sourceRoot(page).textContent, /Can't load this right now/);
      assert.equal(more(page).textContent, 'Load more');
      assert.equal(asked(page, mark).filter((one) => one.endsWith('page=3')).length, 1, 'nothing retries by itself');
      delete state.failures['/discover/network/213/all?page=3'];
      page.click(more(page));
      await page.settled();
      assert.equal(asked(page, mark).filter((one) => one.endsWith('page=3')).length, 2);
      assert.equal(gridCards(page).length, 60);
      assert.equal(more(page), null, 'the last page: no Load more');
      assert.doesNotMatch(sourceRoot(page).textContent, /Can't load this/);
    });

    it('remembers the tab and the pages across Back from a title: the same card is focused, with no list call', async (t) => {
      const state = { cards: 20, pages: { '/discover/network/213/films': 2 } };
      const page = await openScripted(t, state, { hide: 'off' });
      await toHash(page, SERVICE);
      page.click(tab(page, 'films'));
      await page.settled();
      page.press('keydown');
      more(page).focus();
      page.click(more(page));
      await page.settled();
      assert.equal(gridCards(page).length, 40);
      const card = gridCards(page)[25];
      page.press('keydown');
      card.focus();
      const from = page.location.hash;
      page.click(card);
      assert.equal(page.location.hash, `#/jellypass/title/${card.getAttribute('data-media-type')}/${card.getAttribute('data-tmdb-id')}`);
      page.follow(from);
      await page.settled();
      assert.ok(page.view(), 'the title page');
      const mark = page.requests.length;
      page.back();
      await page.settled();
      assert.deepEqual(asked(page, mark), [], 'no list call on Back');
      assert.deepEqual(tabPressed(page), ['films']);
      assert.equal(gridCards(page).length, 40, 'the pages that were showing');
      assert.equal(focusKey(page), card.getAttribute('data-jellypass-tv-focus'), 'the same card');
      assert.equal(more(page), null, 'the last page was loaded');
      assert.equal(h1(page), 'Films on Netflix');
    });

    it('asks for the first page again when what was kept has expired, and shows it', async (t) => {
      const state = { cards: 20, pages: { '/discover/network/213/all': 2 } };
      const page = await openScripted(t, state, { hide: 'off' });
      await toHash(page, SERVICE);
      more(page).focus();
      page.click(more(page));
      await page.settled();
      assert.equal(gridCards(page).length, 40);
      const card = gridCards(page)[0];
      const from = page.location.hash;
      page.click(card);
      page.follow(from);
      await page.settled();
      page.advance(11 * 60 * 1000);
      const mark = page.requests.length;
      page.back();
      await page.settled();
      assert.deepEqual(asked(page, mark), ['/discover/sources', '/discover/network/213/all']);
      assert.equal(gridCards(page).length, 20);
      assert.equal(more(page).textContent, 'Load more');
    });

    it('is called "New only" on a studio page too, with the same name and state', async (t) => {
      const state = { cards: 20, pages: { '/discover/studio/41077': 2 } };
      const page = await openScripted(t, state, { hide: 'on' });
      for (const hash of ['#/jellypass/studio/41077']) {
        await toHash(page, hash);
        const toggle = page.document.querySelector('[data-jellypass-tv-focus="chip:hide"]');
        assert.equal(toggle.textContent, 'New only', hash);
        assert.equal(toggle.getAttribute('aria-label'), "New only: show only titles you don't have or haven't requested", hash);
        assert.equal(toggle.getAttribute('aria-pressed'), 'true', hash);
      }
    });

    it('is a studio\'s movies in a grid with Load more and no tabs and no JustWatch line, with the studio\'s logo and the notice', async (t) => {
      const state = { cards: 20, pages: { '/discover/studio/41077': 2 } };
      const page = await openScripted(t, state, { hide: 'off' });
      await toHash(page, '#/jellypass/studio/41077');
      assert.equal(h1(page), 'A24 movies');
      assert.equal(headerTitle(page), 'A24 movies');
      assert.deepEqual(tabKeys(page), []);
      assert.equal(gridCards(page).length, 20);
      const logo = sourceRoot(page).querySelector('.jellypass-tv-source-logo');
      assert.equal(logo.getAttribute('aria-hidden'), 'true', 'the heading says the name');
      assert.equal(sourceRoot(page).textContent.includes(JUSTWATCH), false);
      assert.ok(sourceRoot(page).textContent.includes(NOTICE));
      more(page).focus();
      page.click(more(page));
      await page.settled();
      assert.equal(state.seen.filter((rel) => rel.startsWith('/discover/studio/41077')).join(' '), '/discover/studio/41077 /discover/studio/41077?page=2');
      assert.equal(gridCards(page).length, 40);
    });

    it('has a page only for the services and studios the API lists: any other address is Not found, and an address that cannot be one asks nothing', async (t) => {
      const state = {};
      const page = await openScripted(t, state, { hide: 'off' });
      // Nothing is asked for an address that is not a number the API could have: no sources, no list.
      for (const hash of ['#/jellypass/service/abc', '#/jellypass/service/0', '#/jellypass/service/007', '#/jellypass/service/1e3', '#/jellypass/service/-1', '#/jellypass/service/99999999999', '#/jellypass/studio/%20', '#/jellypass/studio/3.5', '#/jellypass/studio/x']) {
        const mark = page.requests.length;
        await toHash(page, hash);
        assert.equal(page.requests.length, mark, `${hash}: no call`);
        assert.match(sourceRoot(page).textContent, /Not found/, hash);
        assert.equal(headerTitle(page), 'Not found');
        assert.equal(gridCards(page).length, 0);
      }
      // A number the sources do not list: the sources are asked once, no list ever is, and a studio's number is no service's.
      for (const hash of ['#/jellypass/service/7', '#/jellypass/service/3', '#/jellypass/studio/213', '#/jellypass/studio/9999']) {
        await toHash(page, hash);
        assert.match(sourceRoot(page).textContent, /Not found/, hash);
        assert.equal(gridCards(page).length, 0);
      }
      assert.deepEqual(state.seen.filter((rel) => rel !== '/discover/trending'), ['/discover/sources'], 'the sources once (kept), and no list');
    });

    it('shows a failed first page with Try again, which asks once more and only when chosen; a failed sources call too; a refused sign-in says so', async (t) => {
      const state = { cards: 4, failures: { '/discover/network/213/all': 500 } };
      const page = await openScripted(t, state, { hide: 'off' });
      await toHash(page, SERVICE);
      assert.match(sourceRoot(page).textContent, /Can't load this right now/);
      assert.equal(gridCards(page).length, 0);
      const retry = [...sourceRoot(page).querySelectorAll('button')].find((button) => button.textContent === 'Try again');
      assert.equal(state.seen.filter((rel) => rel === '/discover/network/213/all').length, 1);
      delete state.failures['/discover/network/213/all'];
      page.click(retry);
      await page.settled();
      assert.equal(state.seen.filter((rel) => rel === '/discover/network/213/all').length, 2);
      assert.equal(gridCards(page).length, 4);
      const refused = await openScripted(t, { failures: { '/discover/sources': 401 } }, { hide: 'off' });
      await toHash(refused, SERVICE);
      assert.match(sourceRoot(refused).textContent, /Sign in to continue/);
      assert.equal([...sourceRoot(refused).querySelectorAll('button')].some((button) => button.textContent === 'Try again'), false, 'no retry for a refused sign-in');
    });

    it('draws each card with the household\'s state in words, hides what the household has with the one choice Discover shares, and asks nothing for it', async (t) => {
      const state = { cards: 20 };
      const page = await openScripted(t, state, { hide: 'on' });
      await goTo(page);
      assert.equal(chip(page, 'hide').getAttribute('aria-pressed'), 'true', 'on when Discover opens');
      await scrollThrough(page);
      const from = page.location.hash;
      page.click(rowNamed(page, 'Popular on Netflix').querySelector('h2 button'));
      page.follow(from);
      await page.settled();
      const hide = () => page.document.querySelector('[data-jellypass-tv-focus="chip:hide"]');
      assert.equal(hide().getAttribute('aria-pressed'), 'true', 'the choice came with the member');
      const words = () => gridCards(page).map((card) => card.querySelector('.jellypass-tv-discover-badge').textContent);
      assert.equal(words().length, 12);
      assert.ok(words().every((one) => one === 'Get this' || one === "Can't get"));
      const mark = page.requests.length;
      page.click(hide());
      assert.equal(gridCards(page).length, 20);
      assert.deepEqual(words().slice(0, 5), ['In library', 'Requested', 'Get this', "Can't get", 'Get this']);
      assert.match(gridCards(page)[0].getAttribute('aria-label'), /^Synthetic \d+, 2020, In your library$/);
      assert.deepEqual(asked(page, mark), [], 'no call');
      // And back on Discover it is as the member left it.
      page.back();
      await page.settled();
      assert.equal(chip(page, 'hide').getAttribute('aria-pressed'), 'false');
    });

    it('draws a title asked for in the meantime as Requested, from the overlay and with no call', async (t) => {
      const app = await startApp(t, webWorld(), { ...tvOn(), reconcile: true });
      const card = { mediaType: 'movie', tmdbId: T_MOVIE, title: 'Synthetic', year: 2020, overview: '', posterUrl: null, backdropUrl: null, rating: null, state: 'get_this', play: null };
      const page = await open(t, app, { hide: 'off', override: (pathname) => (pathname === '/jellypass/app/v1/discover/network/213/all' ? json({ page: 1, nextPage: null, results: [card] }) : undefined) });
      await toHash(page, SERVICE);
      const target = () => gridCards(page).find((one) => one.getAttribute('data-tmdb-id') === String(T_MOVIE));
      assert.match(target().getAttribute('aria-label'), /Available to get$/);
      const from = page.location.hash;
      page.click(target());
      page.follow(from);
      await page.settled();
      page.click(page.view().querySelector('.jellypass-tv-title-get'));
      await page.settled();
      const mark = page.requests.length;
      page.back();
      await page.settled();
      assert.match(target().getAttribute('aria-label'), /Requested$/);
      assert.equal(target().querySelector('.jellypass-tv-discover-badge').textContent, 'Requested');
      assert.deepEqual(asked(page, mark), [], 'no call');
      await app.background.settled();
    });

    it('opens a title from a card, and nothing from a card of a session that has gone', async (t) => {
      const page = await openScripted(t, { cards: 6 }, { hide: 'off' });
      await toHash(page, SERVICE);
      const card = gridCards(page)[0];
      page.click(card);
      assert.equal(page.location.hash, `#/jellypass/title/${card.getAttribute('data-media-type')}/${card.getAttribute('data-tmdb-id')}`);
    });

    describe('on Discover', () => {
      it('makes each service row\'s heading a link to its page, still a heading, named for a screen reader, and a studio\'s tile a link named as the app names it', async (t) => {
        const page = await openScripted(t, { cards: 4 }, { hide: 'off' });
        await goTo(page);
        const headings = [...page.document.querySelectorAll('.jellypass-tv-discover-row h2.sectionTitle')];
        const services = headings.filter((one) => one.textContent.startsWith('Popular on '));
        assert.equal(services.length, 3);
        for (const one of services) {
          assert.equal(one.querySelectorAll('button').length, 1, 'one link in the heading');
          assert.equal(one.firstElementChild.tagName, 'BUTTON');
          assert.equal(one.querySelector('button').textContent, one.textContent);
        }
        const link = services[0].querySelector('button');
        assert.equal(services[0].textContent, 'Popular on Netflix');
        assert.equal(link.getAttribute('role'), 'link');
        assert.equal(link.getAttribute('aria-label'), 'Popular on Netflix, see all');
        assert.equal(link.getAttribute('data-jellypass-tv-focus'), 'link:net213');
        assert.ok(link.classList.contains('show-focus'), 'Jellyfin\'s own focus on a TV');
        // The rows that are not a service's keep a plain heading.
        assert.equal(headings.filter((one) => one.querySelector('button')).length, 3);
        const tiles = [...page.document.querySelectorAll('button.jellypass-tv-discover-logo')];
        assert.deepEqual(tiles.map((tile) => tile.getAttribute('aria-label')), ['Pixar movies', 'A24 movies']);
        assert.deepEqual(tiles.map((tile) => tile.getAttribute('role')), ['link', 'link']);
        assert.deepEqual(tiles.map((tile) => tile.getAttribute('data-jellypass-tv-focus')), ['studio:3', 'studio:41077']);
        const mark = page.requests.length;
        page.click(tiles[1]);
        assert.equal(page.location.hash, '#/jellypass/studio/41077');
        assert.equal(page.requests.length, mark, 'choosing it asks nothing itself');
      });

      it('returns to the same heading link or studio tile on Back, with no Discover call', async (t) => {
        const page = await openScripted(t, { cards: 4 }, { hide: 'off' });
        await goTo(page);
        await scrollThrough(page);
        for (const [selector, key] of [['.jellypass-tv-discover-row h2 button', 'link:net2739'], ['button.jellypass-tv-discover-logo', 'studio:41077']]) {
          const target = [...page.document.querySelectorAll(selector)].find((one) => one.getAttribute('data-jellypass-tv-focus') === key);
          page.press('keydown');
          target.focus();
          const from = page.location.hash;
          page.click(target);
          page.follow(from);
          await page.settled();
          assert.ok(sourceRoot(page), 'the page is open');
          const mark = page.requests.length;
          page.back();
          await page.settled();
          assert.deepEqual(discoverCalls(page, mark), [], `${key}: no Discover call on Back`);
          assert.equal(focusKey(page), key, 'the same link');
        }
      });
    });

    it('sets a card\'s image only while it is near the screen and takes it away when it is far, never loading=lazy, and sets every image where there is no observer', async (t) => {
      const page = await openScripted(t, { cards: 20 }, { hide: 'off' });
      await toHash(page, SERVICE);
      const srcs = () => sourceRoot(page).querySelectorAll('img[src]').length;
      assert.equal(srcs(), 0, 'nothing is near the screen yet');
      const cards = gridCards(page);
      for (const card of cards.slice(0, 7)) page.watchers.cross(card, true, IMAGE_MARGIN);
      assert.equal(srcs(), 7);
      page.watchers.cross(cards[0], false, IMAGE_MARGIN);
      assert.equal(srcs(), 6);
      assert.equal(cards[0].querySelector('img').hasAttribute('src'), false);
      page.watchers.cross(cards[0], true, IMAGE_MARGIN);
      assert.equal(cards[0].querySelector('img').getAttribute('src'), 'https://image.tmdb.org/t/p/w342/p' + cards[0].getAttribute('data-tmdb-id') + '.jpg');
      assert.equal(sourceRoot(page).querySelectorAll('[loading]').length, 0);
      // The logo is near too once it is; a card drawn by Load more is its own unit.
      const bare = await open(t, await startApp(t, webWorld(), tvOn()), { hide: 'off', override: fakeApi({ cards: 5 }), observers: null });
      await toHash(bare, SERVICE);
      assert.equal(sourceRoot(bare).querySelectorAll('img[src]').length, 5 + 1, 'every image, the logo too');
    });

    it('lets go of the pictures of the cards a tab switch replaces where there is no IntersectionObserver', async (t) => {
      const page = await open(t, await startApp(t, webWorld(), tvOn()), { hide: 'off', override: fakeApi({ cards: 5 }), observers: null });
      await toHash(page, SERVICE);
      const old = [...sourceRoot(page).querySelectorAll('.jellypass-tv-source-grid img')];
      assert.equal(old.length, 5);
      assert.ok(old.every((image) => image.hasAttribute('src')), 'every picture is set');
      page.click(tab(page, 'films'));
      await page.settled();
      assert.ok(old.every((image) => !image.hasAttribute('src')), 'the replaced cards hold no picture');
      assert.ok([...sourceRoot(page).querySelectorAll('.jellypass-tv-source-grid img')].every((image) => image.hasAttribute('src')), 'the new ones are set');
    });

    it('draws the same page, with the same calls, whatever other households hold or asked for', async (t) => {
      const seen = {};
      for (const [name, state] of Object.entries({ baseline: world(), ...otherHouseholdWorlds() })) {
        const app = await startApp(t, Object.assign(state, { webPage: {} }), { ...tvOn(), reconcile: true });
        const page = await open(t, app, { hide: 'off' });
        const before = page.requests.length;
        await toHash(page, SERVICE);
        const service = sourceRoot(page).outerHTML;
        await toHash(page, STUDIO);
        const studio = sourceRoot(page).outerHTML;
        assertNoCanaries(service + studio, `${name}: the pages show Seerr data planted as a canary`);
        seen[name] = { calls: page.trace(before), view: service + studio };
      }
      const { baseline, ...others } = seen;
      assert.ok(Object.keys(others).length >= 5);
      assert.ok(baseline.calls.length >= 3);
      for (const [name, outcome] of Object.entries(others)) {
        assert.deepEqual(outcome.calls, baseline.calls, `${name}: the calls the add-on made`);
        assert.ok(outcome.view === baseline.view, `${name}: the pages differ`);
      }
    });

    for (const tv of [true, false]) {
      it(`sizes the service and studio grids with Jellyfin web's own classes in the ${tv ? 'TV' : 'desktop'} layout: its wrapping grid of portraitCards, itemsContainer-tv only on a TV, and loading cards in the same markup`, async (t) => {
        const page = await openScripted(t, { cards: 20, pages: { '/discover/network/213/all': 2 } }, { hide: 'off', tv });
        const pageGate = page.requests.length;
        await toHash(page, SERVICE);
        assert.ok(page.requests.length > pageGate);
        for (const hash of [SERVICE, STUDIO]) {
          if (hash === STUDIO) await toHash(page, STUDIO);
          const grid = sourceRoot(page).querySelector('.jellypass-tv-source-grid');
          assert.ok(grid.classList.contains('vertical-wrap'), 'Jellyfin\'s wrapping grid');
          assert.equal(grid.classList.contains('itemsContainer-tv'), tv);
          assert.equal(grid.classList.contains('itemsContainer'), false);
          assert.ok(gridCards(page).length > 0);
          for (const card of gridCards(page)) {
            assert.equal(card.parentNode, grid, 'a direct child of the grid');
            assert.ok(card.classList.contains('portraitCard') && !card.classList.contains('overflowPortraitCard'), classesOf(card));
            assert.ok(card.querySelector('.cardBox.cardBox-bottompadded .cardScalable .cardPadder.cardPadder-portrait'));
            assert.equal(card.getAttribute('style'), null, 'no inline size');
          }
        }
      });
    }

    it('draws a service grid\'s loading cards in the same markup as its cards, so nothing jumps when they come', async (t) => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const page = await openScripted(t, { cards: 20, gates: { '/discover/network/213/all': gate } }, { hide: 'off' });
      page.route(SERVICE);
      for (let i = 0; i < 20 && !sourceRoot(page); i += 1) await pause(25);
      const skeleton = sourceRoot(page).querySelector('.jellypass-tv-source-grid.jellypass-tv-discover-skeleton');
      assert.ok(skeleton && skeleton.children.length > 0, 'loading');
      assert.ok(skeleton.classList.contains('vertical-wrap'));
      for (const card of skeleton.children) {
        assert.ok(card.classList.contains('portraitCard') && card.querySelector('.cardBox .cardScalable .cardPadder-portrait'), classesOf(card));
      }
      release();
      await page.settled();
      assert.ok(gridCards(page).length > 0);
    });

    it('draws the shared focus ring on a service page\'s card, gives its tabs and Load more their own :focus rules, and keeps its classes to its own and the shared ones', async (t) => {
      const page = await openScripted(t, { cards: 20, pages: { '/discover/network/213/all': 2 } }, { hide: 'off' });
      await toHash(page, SERVICE);
      assertFocusRing(page, gridCards(page)[0].querySelector('.cardImageContainer'), 'service page card');
      const css = readFileSync(path.join(DIST_TV, STYLESHEET), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) => selectors.split(',').map((selector) => ({ selector: selector.trim(), body })));
      const focusable = [...sourceRoot(page).querySelectorAll('button, a, [tabindex]')];
      assert.ok(focusable.length > 20);
      for (const element of focusable) {
        const classes = element.className.split(/\s+/);
        assert.equal(classes.includes('jellypass-tv-card') || classes.includes('jellypass-tv-discover-chip') || classes.includes('jellypass-tv-discover-button') || classes.includes('jellypass-tv-discover-foot'), true, element.className);
        if (!classes.includes('jellypass-tv-card')) {
          const own = classes.filter((name) => name === 'jellypass-tv-discover-chip' || name === 'jellypass-tv-discover-button' || name === 'jellypass-tv-discover-foot');
          assert.equal(own.some((name) => rules.some((rule) => rule.selector === `.${name}:focus` && /box-shadow/.test(rule.body))), true, `${element.className} has a ring`);
        }
      }
      const names = new Set([...sourceRoot(page).querySelectorAll('*')].flatMap((element) => (element.getAttribute('class') ?? '').split(/\s+/)).filter((name) => name.startsWith('jellypass-tv-')));
      for (const name of names) assert.match(name, /^jellypass-tv-(?:discover(?:-|$)|source-|card(?:-|$))/, name);
      lacks(css, /position:\s*sticky/, 'a sticky rule');
    });

    describe('session and member', () => {
      it('ends the page when no one is signed in or another member is, and forgets the tab and the pages of the first member', async (t) => {
        const state = { cards: 20, pages: { '/discover/network/213/films': 2 } };
        const page = await openScripted(t, state, { hide: 'off' });
        await toHash(page, SERVICE);
        page.click(tab(page, 'films'));
        await page.settled();
        const asked_ = state.seen.length;
        page.session.user = null;
        page.session.token = null;
        page.document.body.appendChild(page.document.createElement('div'));
        await page.settled();
        assert.equal(sourceRoot(page), null, 'emptied');
        assert.equal(state.seen.length, asked_, 'nothing asked meanwhile');
        page.session.user = ANN;
        page.session.token = TOKENS[ANN];
        page.document.body.appendChild(page.document.createElement('div'));
        await page.settled();
        page.goTo('#/home.html');
        await toHash(page, SERVICE);
        assert.deepEqual(tabPressed(page), ['all'], 'another member starts on All');
        assert.equal(state.seen.length > asked_, true, 'asked afresh');
      });

      it('drops a first page that comes back after a sign-out, and one that comes back under a new token (the new session asks for its own)', async (t) => {
        let release;
        const state = { gates: { '/discover/network/213/all': new Promise((resolve) => { release = resolve; }) } };
        const page = await openScripted(t, state, { hide: 'off' });
        page.route(SERVICE);
        await pause(200);
        page.session.token = 'token-after-a-new-sign-in';
        page.document.body.appendChild(page.document.createElement('div'));
        release();
        await page.settled();
        assert.equal(gridCards(page).length, 6);
        assert.equal(state.seen.filter((rel) => rel === '/discover/network/213/all').length, 2, 'asked again for the new session');
        let hold;
        const second = { gates: { '/discover/network/213/all': new Promise((resolve) => { hold = resolve; }) } };
        const other = await openScripted(t, second, { hide: 'off' });
        other.route(SERVICE);
        await pause(200);
        other.session.user = null;
        other.session.token = null;
        other.document.body.appendChild(other.document.createElement('div'));
        await pause(200);
        const mark = other.requests.length;
        hold();
        await other.settled();
        assert.equal(sourceRoot(other), null);
        assert.equal(other.requests.length, mark);
      });

      for (const [name, change] of Object.entries(SESSION_CHANGES)) {
        it(`does nothing after ${name} but before the page has been cleaned up: a card, a tab, Hide, Load more, a studio link, an image window`, async (t) => {
          const state = { cards: 20, pages: { '/discover/network/213/all': 2 } };
          const page = await openScripted(t, state, { hide: 'off' });
          await toHash(page, SERVICE);
          const html = sourceRoot(page).innerHTML;
          const hash = page.location.hash;
          const calls = page.requests.length;
          const card = gridCards(page)[0];
          change(page);
          page.click(card);
          page.click(tab(page, 'films'));
          page.click(page.document.querySelector('[data-jellypass-tv-focus="chip:hide"]'));
          page.click(more(page));
          page.watchers.cross(card, true, IMAGE_MARGIN);
          await page.settled();
          assert.ok(sourceRoot(page).innerHTML === html, 'the page is as it was');
          assert.equal(page.location.hash, hash, 'nothing opened');
          assert.equal(page.requests.length, calls, 'no call');
          assert.equal(sourceRoot(page).querySelectorAll('img[src]').length, 0, 'no image');
        });

        it(`draws no Load more answer delivered after ${name}`, async (t) => {
          let release;
          const state = { cards: 20, pages: { '/discover/network/213/all': 2 }, gates: {} };
          const page = await openScripted(t, state, { hide: 'off' });
          await toHash(page, SERVICE);
          state.gates['/discover/network/213/all?page=2'] = new Promise((resolve) => { release = resolve; });
          page.click(more(page));
          await pause(100);
          const html = sourceRoot(page).innerHTML;
          change(page);
          const calls = page.requests.length;
          release();
          await pause(200);
          assert.ok(sourceRoot(page).innerHTML === html, 'the page is as it was');
          assert.equal(page.requests.length, calls, 'no call');
        });
      }

      it('drawn afresh under a new token, what the earlier drawing left is dead: a kept card, tab, Hide or Load more does nothing, and the new ones work', async (t) => {
        const state = { cards: 20, pages: { '/discover/network/213/all': 3 } };
        const page = await openScripted(t, state, { hide: 'off' });
        await toHash(page, SERVICE);
        const keep = () => ({ card: gridCards(page)[0], films: tab(page, 'films'), hide: page.document.querySelector('[data-jellypass-tv-focus="chip:hide"]'), more: more(page) });
        const old = keep();
        page.session.token = 'token-after-a-new-sign-in';
        page.document.body.appendChild(page.document.createElement('div'));
        await page.settled();
        const fresh = keep();
        for (const key of Object.keys(old)) assert.ok(old[key] !== fresh[key], `${key} was drawn again`);
        const html = sourceRoot(page).innerHTML;
        const hash = page.location.hash;
        const calls = page.requests.length;
        for (const one of Object.values(old)) page.click(one);
        await page.settled();
        assert.ok(sourceRoot(page).innerHTML === html);
        assert.equal(page.location.hash, hash);
        assert.equal(page.requests.length, calls, 'no call');
        page.click(fresh.more);
        await page.settled();
        assert.equal(gridCards(page).length, 40, 'the new Load more works');
      });
    });
    describe('with "New only" on, as shipped', () => {
      const connected = (page) => {
        const focused = page.focused();
        assert.ok(focused !== null && focused !== page.document.body && focused.isConnected, 'focus is on an element that is in the page');
        return focused;
      };

      it('keeps focus on Load more through a page whose cards are all hidden, and moves it to the first new card when one is shown', async (t) => {
        const all = '/discover/network/213/all';
        const state = { cards: 20, pages: { [all]: 4 }, allAs: { [`${all}?page=2`]: 'in_library', [`${all}?page=3`]: 'requested' } };
        const page = await openScripted(t, state, { hide: 'on' });
        await toHash(page, SERVICE);
        const shown = gridCards(page).length;
        assert.ok(shown > 0 && shown < 20, 'the first page is drawn with the held cards left out');
        for (const number of [2, 3]) {
          more(page).focus();
          page.click(more(page));
          await page.settled();
          assert.equal(gridCards(page).length, shown, `page ${number} is all hidden: no card is added`);
          assert.ok(more(page), 'Load more is offered again');
          assert.equal(connected(page), more(page), 'focus is on the new Load more');
        }
        more(page).focus();
        page.click(more(page));
        await page.settled();
        assert.ok(gridCards(page).length > shown);
        assert.equal(connected(page), gridCards(page)[shown], 'the first new card has focus');
      });

      it('puts focus on the tab, even after the remote has been used, when nothing is left to show and Load more goes', async (t) => {
        const all = '/discover/network/213/all';
        const state = { cards: 20, pages: { [all]: 2 }, allAs: { [all]: 'in_library', [`${all}?page=2`]: 'in_library' } };
        const page = await openScripted(t, state, { hide: 'on' });
        await toHash(page, SERVICE);
        assert.equal(gridCards(page).length, 0, 'both pages are entirely hidden');
        page.press('keydown');
        more(page).focus();
        page.click(more(page));
        await page.settled();
        assert.equal(more(page), null, 'the last page');
        assert.equal(gridCards(page).length, 0);
        assert.equal(connected(page), tab(page, 'all'), 'the tab has focus');
      });

      it('answers only the Try again on show: a retained one, after the retry has worked, does nothing', async (t) => {
        const all = '/discover/network/213/all';
        const state = { cards: 1, failures: { [all]: 500 } };
        const page = await openScripted(t, state, { hide: 'off' });
        await toHash(page, SERVICE);
        const retry = [...sourceRoot(page).querySelectorAll('button')].find((button) => button.textContent === 'Try again');
        assert.ok(retry);
        delete state.failures[all];
        page.click(retry);
        await page.settled();
        assert.equal(gridCards(page).length, 1);
        const html = sourceRoot(page).innerHTML;
        const calls = page.requests.length;
        page.click(retry);
        await page.settled();
        assert.equal(page.requests.length, calls, 'no call');
        assert.equal(gridCards(page).length, 1, 'the card stays');
        assert.equal(sourceRoot(page).querySelector('.jellypass-tv-discover-skeleton'), null, 'no skeleton is stranded');
        assert.ok(sourceRoot(page).innerHTML === html, 'the page is as it was');
      });

      it('puts focus on the Films tab, not All, when the films that are left are all hidden and Load more goes', async (t) => {
        const films = '/discover/network/213/films';
        const state = { cards: 20, pages: { [films]: 2 }, allAs: { [films]: 'in_library', [`${films}?page=2`]: 'in_library' } };
        const page = await openScripted(t, state, { hide: 'on' });
        await toHash(page, SERVICE);
        page.click(tab(page, 'films'));
        await page.settled();
        assert.equal(gridCards(page).length, 0, 'both film pages are entirely hidden');
        page.press('keydown');
        more(page).focus();
        page.click(more(page));
        await page.settled();
        assert.equal(more(page), null, 'the last page');
assert.equal(connected(page), tab(page, 'films'), 'the Films tab has focus');
      });

      it('puts focus on the last card when the final page is all hidden and Load more goes', async (t) => {
        const all = '/discover/network/213/all';
        const state = { cards: 20, pages: { [all]: 2 }, allAs: { [`${all}?page=2`]: 'in_library' } };
        const page = await openScripted(t, state, { hide: 'on' });
        await toHash(page, SERVICE);
        const cards = gridCards(page);
        more(page).focus();
        page.click(more(page));
        await page.settled();
        assert.equal(more(page), null, 'the last page');
        assert.equal(gridCards(page).length, cards.length);
        assert.equal(connected(page), gridCards(page)[cards.length - 1], 'the last card has focus');
      });

      it('does nothing from a card, tab, Hide or Load more that an earlier list, tab or drawing left behind', async (t) => {
        const state = { cards: 20, pages: { '/discover/network/213/all': 3, '/discover/network/213/films': 3 } };
        const page = await openScripted(t, state, { hide: 'off' });
        await toHash(page, SERVICE);
        const oldCard = gridCards(page)[0];
        const oldMore = more(page);
        const hash = page.location.hash;
        page.click(tab(page, 'films'));
        await page.settled();
        page.click(oldCard);
        assert.equal(page.location.hash, hash, 'a card of All does nothing on Films');
        const films = gridCards(page)[0];
        // The grid drawn again (Hide) leaves the card before it dead; the new card works.
        page.click(page.document.querySelector('[data-jellypass-tv-focus="chip:hide"]'));
        page.click(films);
        assert.equal(page.location.hash, hash, 'a card the grid replaced does nothing');
        const calls = page.requests.length;
        page.click(oldMore);
        await page.settled();
        assert.equal(page.requests.length, calls, 'the Load more of All asks nothing');
        page.click(gridCards(page)[0]);
        assert.notEqual(page.location.hash, hash, 'a card of the grid shown works');
      });
    });

    describe('when a 401 removes the panel', () => {
      const near = (page, cards) => {
        for (const card of cards.slice(0, 3)) page.watchers.cross(card, true, IMAGE_MARGIN);
        return cards.slice(0, 3).map((card) => card.querySelector('img'));
      };

      it('leaves nothing live after a 401 on Load more: a kept card and Load more do nothing and the pictures are let go', async (t) => {
        const state = { cards: 20, pages: { '/discover/network/213/all': 3 }, failures: { '/discover/network/213/all?page=2': 401 } };
        const page = await openScripted(t, state, { hide: 'off' });
        await toHash(page, SERVICE);
        const card = gridCards(page)[0];
        const oldMore = more(page);
        const images = near(page, gridCards(page));
        assert.equal(images.filter((image) => image.hasAttribute('src')).length, 3, 'the pictures were set');
        page.click(oldMore);
        await page.settled();
        assert.match(sourceRoot(page).textContent, /Sign in to continue/);
        assert.equal(gridCards(page).length, 0, 'the cards are gone');
        const hash = page.location.hash;
        const calls = page.requests.length;
        page.click(card);
        page.click(oldMore);
        page.watchers.cross(card, true, IMAGE_MARGIN);
        await page.settled();
        assert.equal(page.location.hash, hash, 'the kept card opens nothing');
        assert.equal(page.requests.length, calls, 'the kept Load more asks nothing');
        assert.equal(images.filter((image) => image.hasAttribute('src')).length, 0, 'the pictures were let go');
        assert.equal(more(page), null, 'no Load more is offered');
      });

      it('leaves nothing live after a 401 on a tab switch: a kept card, Load more and picture do nothing', async (t) => {
        const state = { cards: 20, pages: { '/discover/network/213/all': 3, '/discover/network/213/films': 3 }, failures: { '/discover/network/213/films': 401 } };
        const page = await openScripted(t, state, { hide: 'off' });
        await toHash(page, SERVICE);
        const card = gridCards(page)[0];
        const oldMore = more(page);
        const images = near(page, gridCards(page));
        page.click(tab(page, 'films'));
        await page.settled();
        assert.match(sourceRoot(page).textContent, /Sign in to continue/);
        const hash = page.location.hash;
        const calls = page.requests.length;
        page.click(card);
        page.click(oldMore);
        await page.settled();
        assert.equal(page.location.hash, hash, 'the kept card opens nothing');
        assert.equal(page.requests.length, calls, 'the kept Load more asks nothing');
        assert.equal(images.filter((image) => image.hasAttribute('src')).length, 0, 'the pictures were let go');
        assert.equal(more(page), null);
      });

      it('lets go of the pictures and the controls of the whole page when the sources are refused after cards were drawn', async (t) => {
        const state = { cards: 20, pages: { '/discover/network/213/all': 3 } };
        const page = await openScripted(t, state, { hide: 'off' });
        await toHash(page, SERVICE);
        const card = gridCards(page)[0];
        const oldMore = more(page);
        const images = near(page, gridCards(page));
        page.session.token = 'token-after-a-new-sign-in';
        state.failures = { '/discover/sources': 401 };
        page.document.body.appendChild(page.document.createElement('div'));
        await page.settled();
        const hash = page.location.hash;
        const calls = page.requests.length;
        page.click(card);
        page.click(oldMore);
        await page.settled();
        assert.equal(page.location.hash, hash, 'the kept card opens nothing');
        assert.equal(page.requests.length, calls, 'the kept Load more asks nothing');
        assert.equal(images.filter((image) => image.hasAttribute('src')).length, 0, 'the pictures were let go');
      });
    });

    describe('the images', () => {
      it('keeps one hero and its picture however often "New only" is pressed', async (t) => {
        const page = await openScripted(t, { cards: 6 }, { hide: 'on' });
        await goTo(page);
        const seen = new Set();
        const heroImage = () => page.document.querySelector('.jellypass-tv-discover-hero-image');
        for (let time = 0; time < 20; time += 1) {
          const image = heroImage();
          if (image) seen.add(image);
          page.click(chip(page, 'hide'));
          await page.settled();
        }
        const live = heroImage();
        const watched = new Set();
        for (const watcher of page.watchers.all) for (const element of watcher.watching) if (element.classList.contains('jellypass-tv-discover-hero')) watched.add(element);
        assert.ok(watched.size <= 1, 'one hero is watched');
        assert.ok(page.document.querySelectorAll('.jellypass-tv-discover-hero').length <= 1);
        assert.ok(seen.size >= 2, 'the hero was drawn more than once');
        for (const image of seen) if (image !== live) assert.equal(image.hasAttribute('src'), false, 'a hero picture that was replaced has no source');
      });

      it('lets go of the pictures of the cards a grid replaced', async (t) => {
        const page = await openScripted(t, { cards: 20, pages: { '/discover/network/213/all': 2 } }, { hide: 'off' });
        await toHash(page, SERVICE);
        const near = (element) => { page.watchers.cross(element, true, IMAGE_MARGIN); };
        for (const card of gridCards(page)) near(card);
        const old = gridCards(page).map((card) => card.querySelector('img')).filter(Boolean);
        assert.ok(old.some((image) => image.hasAttribute('src')));
        page.click(page.document.querySelector('[data-jellypass-tv-focus="chip:hide"]'));
        await page.settled();
        const live = new Set(gridCards(page).map((card) => card.querySelector('img')));
        for (const image of old) if (!live.has(image)) assert.equal(image.hasAttribute('src'), false, 'a replaced picture has no source');
      });
    });
  });

  describe('"see all" pages of the list rows', () => {
    const LIST = (list) => `#/jellypass/list/${list}`;
    const listRoot = (page) => page.document.querySelector('[data-jellypass-tv-source="list"]');
    const gridCards = (page) => [...page.document.querySelectorAll('.jellypass-tv-source-grid button.card')];
    const more = (page) => page.document.querySelector('[data-jellypass-tv-focus="more"]');
    const seeAll = (row) => row.querySelector('button.jellypass-tv-discover-see-all');
    const asked = (page, from = 0) => page.requests.slice(from).map((request) => new URL(request.url)).filter((url) => url.pathname.includes('/discover/')).map((url) => url.pathname.replace('/jellypass/app/v1', '') + url.search);
    const toHash = async (page, hash) => {
      page.route(hash);
      await page.settled();
    };
    const SEE_ALL = [['Trending', 'trending'], ['Popular movies', 'popular-movies'], ['Popular series', 'popular-tv'], ['New movie releases', 'new-movies'], ['Upcoming movies', 'upcoming'], ['Upcoming series', 'upcoming-tv']];

    it('gives each list row a button of its own beside the heading: the heading stays a heading, the button is named "<heading>, see all", and a service row has none beside its link', async (t) => {
      const page = await openScripted(t, {}, { hide: 'off' });
      await goTo(page);
      await scrollThrough(page);
      for (const [name] of SEE_ALL) {
        const row = rowNamed(page, name);
        const button = seeAll(row);
        assert.ok(button, `${name} has a see all button`);
        assert.equal(button.getAttribute('aria-label'), `${name}, see all`);
        assert.equal(button.textContent, 'See all');
        assert.equal(row.querySelector('h2').textContent, name, 'the heading is only its words');
        assert.equal(row.querySelector('h2').contains(button), false, 'the button is not inside the heading');
        assert.equal(button.parentNode, row.querySelector('h2').parentNode, 'beside the heading');
        assert.equal(row.querySelectorAll('button.jellypass-tv-discover-see-all').length, 1);
        assert.equal(button.tagName, 'BUTTON');
        assert.ok(button.classList.contains('show-focus'), 'a TV draws its focus ring');
      }
      assert.equal(seeAll(rowNamed(page, 'Popular on Netflix')), null, 'a service row has its heading link only');
      // Under the other chips: every list row has one, for its own list.
      for (const [key, names] of [['movies', ['Trending movies', 'Popular movies', 'New movie releases', 'Upcoming movies']], ['tv', ['Trending series', 'Popular series', 'Upcoming series']]]) {
        page.click(chip(page, key));
        await page.settled();
        for (const name of names) assert.equal(seeAll(rowNamed(page, name)).getAttribute('aria-label'), `${name}, see all`, `${key}: ${name}`);
      }
    });

    it('is written in the budget file: opened from its row it asks nothing, Load more asks the next page once, and Back (to Discover, from a title) asks nothing', async (t) => {
      const state = { cards: 20, pages: { '/discover/popular-movies': 3 } };
      const page = await openScripted(t, state, { hide: 'off' });
      await goTo(page);
      await scrollThrough(page);
      const screen = BUDGET.screens['tv-discover-list'];
      assert.equal(screen.calls, 1);
      const button = seeAll(rowNamed(page, 'Popular movies'));
      page.press('keydown');
      button.focus();
      const from = page.location.hash;
      const mark = page.requests.length;
      page.click(button);
      assert.equal(page.location.hash, LIST('popular-movies'));
      page.follow(from);
      await page.settled();
      assert.deepEqual(asked(page, mark), [], 'the row\'s first page is the grid\'s: no call');
      assert.equal(headerTitle(page), 'Popular movies');
      assert.equal(listRoot(page).closest('#fallbackPage').id, 'fallbackPage', 'in Jellyfin\'s own page');
      assert.equal(listRoot(page).querySelector('h1').textContent, 'Popular movies');
      assert.equal(gridCards(page).length, 20, 'a full page, not the row\'s 14');
      // Load more: one call, the next page.
      const next = page.requests.length;
      page.press('keydown');
      more(page).focus();
      page.click(more(page));
      await page.settled();
      assert.deepEqual(asked(page, next), screen.loadMore.map((call) => call.replace('GET ', '').replace('{list}', 'popular-movies')));
      assert.equal(gridCards(page).length, 40);
      // A card opens the title; Back returns to the same card, with the pages that were showing, and asks nothing.
      const card = gridCards(page)[30];
      page.press('keydown');
      card.focus();
      const away = page.location.hash;
      page.click(card);
      assert.equal(page.location.hash, `#/jellypass/title/${card.getAttribute('data-media-type')}/${card.getAttribute('data-tmdb-id')}`);
      page.follow(away);
      await page.settled();
      assert.ok(page.view(), 'the title page');
      const before = page.requests.length;
      page.back();
      await page.settled();
      assert.deepEqual(asked(page, before), [], 'Back asks nothing');
      assert.equal(gridCards(page).length, 40);
      assert.equal(focusKey(page), card.getAttribute('data-jellypass-tv-focus'), 'the same grid card');
      // Back from the grid: Discover, with the row's see all button focused, and nothing asked.
      const last = page.requests.length;
      page.back();
      await page.settled();
      assert.ok(root(page), 'Discover');
      assert.deepEqual(discoverCalls(page, last), [], 'no call');
      assert.equal(focusKey(page), 'see:popular-movies', 'the same row\'s button');
    });

    it('opened by its own address asks for that list\'s first page and nothing else (not the sources)', async (t) => {
      const page = await openScripted(t, {}, { hide: 'off' });
      const mark = page.requests.length;
      await toHash(page, LIST('upcoming-tv'));
      const screen = BUDGET.screens['tv-discover-list'];
      assert.deepEqual(asked(page, mark), screen.atOnce.map((call) => call.replace('GET ', '').replace('{list}', 'upcoming-tv')));
      assert.equal(headerTitle(page), 'Upcoming series');
      assert.equal(gridCards(page).length, 6);
    });

    it('has every list the rows show a page, titled as its row is, and no other address has one: nothing is asked for it', async (t) => {
      const page = await openScripted(t, {}, { hide: 'off' });
      const titles = { trending: 'Trending', 'trending-movies': 'Trending movies', 'trending-tv': 'Trending series', 'popular-movies': 'Popular movies', 'popular-tv': 'Popular series', 'new-movies': 'New movie releases', upcoming: 'Upcoming movies', 'upcoming-tv': 'Upcoming series' };
      for (const [list, title] of Object.entries(titles)) {
        await toHash(page, LIST(list));
        assert.equal(headerTitle(page), title, list);
        assert.equal(listRoot(page).querySelector('h1').textContent, title);
      }
      // The rows' headings are these titles, under every chip.
      await goTo(page);
      assert.deepEqual(headings(page).slice(0, 6), ['Trending', 'Popular movies', 'Popular series', 'New movie releases', 'Upcoming movies', 'Upcoming series']);
      const mark = page.requests.length;
      for (const bad of ['Trending', 'top-movies', '__proto__', 'constructor', '', 'trending/', '1']) {
        await toHash(page, LIST(bad));
        const view = listRoot(page);
        if (view) assert.equal(view.textContent.includes('Not found'), true, bad);
      }
      assert.deepEqual(asked(page, mark), [], 'no call for an address that is no list');
    });

    it('shows the Load more grid as the service page does: "New only" on by default and shared, short corner badges, Jellyfin-sized cards, no tabs, no logo, the TMDB notice', async (t) => {
      const page = await openScripted(t, { cards: 20, pages: { '/discover/trending': 2 } }, { hide: 'on' });
      await toHash(page, LIST('trending'));
      assert.equal(chip(page, 'hide').getAttribute('aria-pressed'), 'true', 'on by default');
      assert.equal(page.document.querySelectorAll('[data-jellypass-tv-focus^="tab:"]').length, 0);
      assert.equal(listRoot(page).querySelector('.jellypass-tv-source-logo'), null);
      const cards = gridCards(page);
      assert.ok(cards.length > 0 && cards.length < 20, 'what is in the library or asked for is hidden');
      for (const card of cards) {
        assert.ok(card.classList.contains('portraitCard'), 'Jellyfin\'s own grid card');
        assert.ok(['Get this', "Can't get"].includes(card.querySelector('.jellypass-tv-discover-badge').textContent), 'a short word in the corner');
      }
      assert.ok(listRoot(page).querySelector('.vertical-wrap'));
      assert.equal(listRoot(page).textContent.includes('This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.'), true);
      assert.equal(listRoot(page).textContent.includes('JustWatch'), false, 'the JustWatch line is for a service');
      // The one choice is shared with Discover: switch it off here, it is off there.
      page.click(chip(page, 'hide'));
      assert.equal(gridCards(page).length, 20);
      await toHash(page, '#/jellypass/discover');
      assert.equal(chip(page, 'hide').getAttribute('aria-pressed'), 'false');
    });

    it('asks for a poster only near the screen, and lets go of it when it leaves', async (t) => {
      const page = await openScripted(t, { cards: 20 }, { hide: 'off' });
      await toHash(page, LIST('trending'));
      const images = () => [...listRoot(page).querySelectorAll('.jellypass-tv-source-grid img')];
      assert.ok(images().length > 0);
      assert.equal(images().filter((image) => image.hasAttribute('src')).length, 0, 'nothing is near the screen yet');
      const card = gridCards(page)[0];
      page.watchers.cross(card, true, IMAGE_MARGIN);
      assert.equal(card.querySelector('img').hasAttribute('src'), true);
      assert.equal(images().filter((image) => image.hasAttribute('src')).length, 1, 'only that card\'s');
      page.watchers.cross(card, false, IMAGE_MARGIN);
      assert.equal(card.querySelector('img').hasAttribute('src'), false);
    });

    it('is cleaned up the one way whatever removes it: leaving, a sign-out and another member, with the old buttons dead', async (t) => {
      const state = { cards: 20, pages: { '/discover/trending': 3 } };
      const page = await openScripted(t, state, { hide: 'off' });
      await toHash(page, LIST('trending'));
      const card = gridCards(page)[0];
      const button = more(page);
      const seen = () => state.seen.length;
      // Leaving: the observers watch nothing, the pictures are let go, nothing remains.
      await toHash(page, '#/home.html');
      assert.equal(listRoot(page), null);
      assert.equal(page.document.querySelectorAll('.jellypass-tv-source-grid').length, 0);
      for (const watcher of page.watchers.all) if (watcher.options.rootMargin === IMAGE_MARGIN) assert.equal(watcher.watching.size, 0, 'no card is still watched');
      const afterLeave = seen();
      page.click(button);
      page.click(card);
      await page.settled();
      assert.equal(seen(), afterLeave, 'a button of the page since left asks nothing');
      assert.equal(page.location.hash, '#/home.html', 'and opens nothing');
      // A sign-out ends the page.
      await toHash(page, LIST('trending'));
      const open = gridCards(page)[1];
      const load = more(page);
      page.session.user = null;
      page.session.token = null;
      page.document.body.appendChild(page.document.createElement('div'));
      await page.settled();
      assert.equal(listRoot(page), null, 'emptied');
      const asking = seen();
      const hashNow = page.location.hash;
      page.click(load);
      page.click(open);
      await page.settled();
      assert.equal(seen(), asking, 'Load more of a sign-in since ended asks nothing');
      assert.equal(page.location.hash, hashNow, 'and a card opens nothing');
      // Another member signing in is not the first member's page either.
      page.session.user = ANN;
      page.session.token = TOKENS[ANN];
      page.document.body.appendChild(page.document.createElement('div'));
      await page.settled();
      page.click(load);
      assert.equal(seen(), asking);
    });

    it('draws the Discover row\'s button dead after a sign-out: it opens nothing', async (t) => {
      const page = await openScripted(t, {}, { hide: 'off' });
      await goTo(page);
      await scrollThrough(page);
      const button = seeAll(rowNamed(page, 'Trending'));
      page.session.token = 'a-new-token-for-the-same-member';
      const mark = page.location.hash;
      page.click(button);
      assert.equal(page.location.hash, mark, 'a button of the drawing under the old token does nothing');
    });

    it('draws the same page, with the same calls, whatever other households hold or asked for', async (t) => {
      const seen = {};
      for (const [name, state] of Object.entries({ baseline: world(), ...otherHouseholdWorlds() })) {
        const app = await startApp(t, Object.assign(state, { webPage: {} }), { ...tvOn(), reconcile: true });
        const page = await open(t, app, { hide: 'off' });
        const before = page.requests.length;
        await toHash(page, LIST('popular-tv'));
        const view = listRoot(page).outerHTML;
        assertNoCanaries(view, `${name}: the page shows Seerr data planted as a canary`);
        seen[name] = { calls: page.trace(before), view };
      }
      const { baseline, ...others } = seen;
      assert.ok(Object.keys(others).length >= 5);
      assert.ok(baseline.calls.length >= 1);
      for (const [name, outcome] of Object.entries(others)) {
        assert.deepEqual(outcome.calls, baseline.calls, `${name}: the calls`);
        assert.ok(outcome.view === baseline.view, `${name}: the pages differ`);
      }
    });
  });

  describe('the Back button on JellyPass pages', () => {
    const backs = (page) => [...page.document.querySelectorAll('[data-jellypass-tv-back]')];
    const more = (page) => page.document.querySelector('[data-jellypass-tv-focus="more"]');
    const toHash = async (page, hash) => {
      page.route(hash);
      await page.settled();
    };
    const PAGES = ['#/jellypass/discover', '#/jellypass/list/trending', '#/jellypass/service/213', '#/jellypass/studio/3', '#/jellypass/title/movie/603', '#/jellypass/requests'];

    it('is on every JellyPass page in the desktop layout: one focusable button named "Back", first on the page, never twice across redraws, gone when the page is left', async (t) => {
      const page = await openScripted(t, { cards: 20, pages: { '/discover/trending': 2 } }, { hide: 'off', tv: false });
      for (const hash of PAGES) {
        await toHash(page, hash);
        const found = backs(page);
        assert.equal(found.length, 1, hash);
        const [button] = found;
        assert.equal(button.tagName, 'BUTTON');
        assert.equal(button.getAttribute('type'), 'button');
        assert.equal(button.getAttribute('aria-label'), 'Back');
        assert.equal(button.textContent, 'Back');
        assert.ok(button.classList.contains('emby-button'), 'Jellyfin\'s own button');
        assert.equal(button.hasAttribute('tabindex') && button.getAttribute('tabindex') !== '0', false, 'in the tab order');
        assert.equal(hosted(page).firstElementChild.contains(button), true, `${hash}: first on the page`);
        // Redraws: the page's own, and Jellyfin's page changing under it.
        page.document.body.appendChild(page.document.createElement('div'));
        await page.settled();
        assert.equal(backs(page).length, 1, `${hash}: not twice`);
      }
      // Redraws of the page's own parts leave it at one.
      await toHash(page, '#/jellypass/discover');
      page.click(chip(page, 'movies'));
      page.click(chip(page, 'hide'));
      await page.settled();
      assert.equal(backs(page).length, 1);
      await toHash(page, '#/jellypass/list/trending');
      page.click(chip(page, 'hide'));
      page.click(more(page));
      await page.settled();
      assert.equal(backs(page).length, 1);
      // Leaving JellyPass pages takes it away; Jellyfin's own pages never have it.
      await toHash(page, '#/home.html');
      assert.equal(backs(page).length, 0);
      assert.equal(page.document.querySelectorAll('.jellypass-tv-back-bar').length, 0);
    });

    it('is not in the TV layout: Jellyfin\'s header Back and the remote cover it', async (t) => {
      const page = await openScripted(t, { cards: 20 }, { hide: 'off', tv: true });
      for (const hash of PAGES) {
        await toHash(page, hash);
        assert.equal(backs(page).length, 0, hash);
        assert.ok(hosted(page), `${hash} is drawn`);
      }
    });

    it('goes back in history when the member came from another page of Jellyfin web, and to Home when they did not', async (t) => {
      const page = await openScripted(t, {}, { hide: 'off', tv: false });
      await goTo(page);
      await toHash(page, '#/jellypass/list/trending');
      assert.equal(page.location.hash, '#/jellypass/list/trending');
      page.click(backs(page)[0]);
      await page.settled();
      assert.equal(page.location.hash, '#/jellypass/discover', 'one step back');
      assert.ok(root(page));
      page.click(backs(page)[0]);
      await page.settled();
      assert.equal(page.location.hash, '#/home.html', 'and back to where it began');
      // Opened by its own address (nothing before it in Jellyfin web): Home.
      const direct = await openScripted(t, {}, { hide: 'off', tv: false, startHash: '#/jellypass/discover' });
      direct.follow('#/home.html');
      await direct.settled();
      assert.equal(backs(direct).length, 1);
      direct.click(backs(direct)[0]);
      assert.equal(direct.location.hash, '#/home', 'Jellyfin Home');
    });

    it('does nothing from a button of a page since left', async (t) => {
      const page = await openScripted(t, {}, { hide: 'off', tv: false });
      await toHash(page, '#/jellypass/discover');
      const stale = backs(page)[0];
      await toHash(page, '#/jellypass/list/trending');
      const now = page.location.hash;
      page.click(stale);
      assert.equal(page.location.hash, now);
    });

    describe('when the session changes under the page (same route)', () => {
      const changes = {
        'a sign-out': (page) => { page.session.token = null; },
        'another member': (page) => { page.session.user = ANN; page.session.token = TOKENS[ANN]; },
        'a new token': (page) => { page.session.token = `${TOKENS[ALICE]}-renewed`; },
      };
      for (const [name, change] of Object.entries(changes)) {
        it(`leaves the old Back button inert, empties the trail and sends the next Back to Home after ${name}`, async (t) => {
          const page = await openScripted(t, {}, { hide: 'off', tv: false });
          await goTo(page);
          await toHash(page, '#/jellypass/list/trending');
          const old = backs(page)[0];
          change(page);
          // Pressed at once, before the host has looked: the session stamp is checked on the press.
          page.click(old);
          assert.equal(page.location.hash, '#/jellypass/list/trending', 'the old button does nothing');
          // Nothing on the page moved, so the host looks when the member next touches something, or the page changes.
          page.document.body.appendChild(page.document.createElement('div'));
          await page.settled();
          assert.equal(page.location.hash, '#/jellypass/list/trending');
          page.click(old);
          assert.equal(page.location.hash, '#/jellypass/list/trending', 'inert after the host looked too');
          assert.equal(old.isConnected, false, 'taken away');
          const fresh = backs(page);
          assert.equal(fresh.length, 1, 'one button, drawn for the new session');
          page.click(fresh[0]);
          assert.equal(page.location.hash, '#/home', 'the trail is empty: Home, not the old member\'s Discover');
        });
      }
    });
  });

  describe('the stylesheet', () => {
    const rulesOf = () => {
      const css = readFileSync(path.join(DIST_TV, STYLESHEET), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      return [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].flatMap(([, selectors, body]) => selectors.split(',').map((selector) => ({ selector: selector.trim(), body })));
    };

    it('draws the shared focus ring on a Discover poster card and a backdrop card, and every other thing the remote can focus has its own :focus rule', async (t) => {
      const page = await openScripted(t, {}, { hide: 'off' });
      await goTo(page);
      assertFocusRing(page, cardsOf(rowNamed(page, 'Trending'))[0].querySelector('.cardImageContainer'), 'Discover poster card');
      assertFocusRing(page, cardsOf(rowNamed(page, 'Popular movies'))[0].querySelector('.cardImageContainer'), 'Discover backdrop card');
      const rules = rulesOf();
      for (const selector of ['.jellypass-tv-discover-button:focus', '.jellypass-tv-discover-chip:focus', '.jellypass-tv-discover-foot:focus', '.jellypass-tv-discover-entry:focus', '.jellypass-tv-discover-link:focus', '.jellypass-tv-discover-logo:focus']) {
        const found = rules.filter((rule) => rule.selector === selector);
        assert.equal(found.length >= 1 && found.every((rule) => /box-shadow:\s*(?:inset\s+)?0\s+0\s+0\s+0?\.\d+em/.test(rule.body)), true, `${selector} draws a ring`);
      }
      // Every focusable element of the page is one of those: chips, hero buttons, retry, the foot, a card, a service's heading link or a studio's tile.
      const focusable = [...root(page).querySelectorAll('button, a, [tabindex]')];
      assert.ok(focusable.length > 20);
      for (const element of focusable) {
        const classes = element.className.split(/\s+/);
        assert.equal(classes.includes('jellypass-tv-card') || classes.includes('jellypass-tv-discover-chip') || classes.includes('jellypass-tv-discover-button') || classes.includes('jellypass-tv-discover-foot') || classes.includes('jellypass-tv-discover-link') || classes.includes('jellypass-tv-discover-logo'), true, element.className);
      }
    });

    it('keeps the page\'s classes to its own and the shared row and card ones, and no rule of the page\'s reaches the title page or the row', async (t) => {
      const page = await openScripted(t, {}, { hide: 'off' });
      await goTo(page);
      const names = new Set([...root(page).querySelectorAll('*')].flatMap((element) => (element.getAttribute('class') ?? '').split(/\s+/)).filter((name) => name.startsWith('jellypass-tv-')));
      for (const name of names) assert.match(name, /^jellypass-tv-(?:discover(?:-|$)|source-|row-|card(?:-|$))/, name);
      for (const { selector } of rulesOf()) {
        const classes = (selector.match(/\.jellypass-tv[a-z0-9_-]*/g) ?? []).map((name) => name.slice(1));
        if (classes.some((name) => name.startsWith('jellypass-tv-discover'))) assert.equal(classes.every((name) => name.startsWith('jellypass-tv-discover')), true, selector);
        if (classes.some((name) => name.startsWith('jellypass-tv-source'))) assert.equal(classes.every((name) => name.startsWith('jellypass-tv-source') || name.startsWith('jellypass-tv-discover') || name === 'jellypass-tv-card'), true, selector);
      }
    });
  });
});

describe('TV add-on: hidden titles ("Not interested")', { timeout: 240_000 }, () => {
  const APP = '/jellypass/app/v1';
  const HIDDEN = `${APP}/hidden`;
  const COST = BUDGET.hiding;
  const json = (body, status = 200) => ({ status, body: JSON.stringify(body) });
  const part = (node, selector) => node.querySelector(selector)?.textContent ?? null;
  const generic = (call) => call.replace(/\/hidden\/(movie|tv)\/[0-9]+$/, '/hidden/{mediaType}/{tmdbId}').replace(/^(GET|POST|DELETE) \/(movie|tv)\/[0-9]+/, '$1 /$2/{tmdbId}');
  const open = async (t, app, options) => {
    const page = await openJellyfinWeb(t, app, options);
    page.document.documentElement.classList.add('layout-tv');
    page.document.body.insertAdjacentHTML('afterbegin', HEADER);
    page.home();
    await page.settled();
    return page;
  };
  const toTitle = async (page, tmdbId, mediaType = 'movie') => {
    page.route(`#/jellypass/title/${mediaType}/${tmdbId}`);
    await page.settled();
    assert.ok(page.view(), 'the title page');
  };
  const hideButton = (page) => page.view().querySelector('.jellypass-tv-title-hide');
  const hideMessage = (page) => page.view().querySelector('.jellypass-tv-title-hide-message').textContent;
  const hiddenCalls = (page, from = 0) => page.requests.slice(from).filter((request) => new URL(request.url).pathname.startsWith(HIDDEN)).map((request) => `${request.init.method ?? 'GET'} ${new URL(request.url).pathname.replace(APP, '')}${new URL(request.url).search}`);
  const rowTitles = (page) => page.cards().map((card) => card.querySelector('.jellypass-tv-card-title').textContent);
  /** A server before apiVersion 3: no card or title carries `hidden`, and the hiding endpoints are not there (their calls are recorded). */
  const withoutHiding = (app, seen = []) => async (pathname, init, target) => {
    if (!pathname.startsWith(`${APP}/`)) return undefined;
    if (pathname.startsWith(HIDDEN)) {
      seen.push(`${init.method ?? 'GET'} ${pathname}`);
      return { status: 404, body: '{"error":"not_found"}' };
    }
    const answer = await get(app.port, `${pathname}${target.search}`, { Host: target.host, ...init.headers }, { method: init.method ?? 'GET', body: init.body });
    const strip = (value) => (Array.isArray(value) ? value.map(strip) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'hidden').map(([key, inner]) => [key, strip(inner)])) : value);
    return { status: answer.status, body: JSON.stringify(strip(answer.json())) };
  };

  it('is written in the budget file: a hide is one POST, an unhide (and an undo) one DELETE, the Hidden view a list and ten titles', () => {
    assert.deepEqual(COST.hide, ['POST /hidden/{mediaType}/{tmdbId}']);
    assert.deepEqual(COST.unhide, ['DELETE /hidden/{mediaType}/{tmdbId}']);
    assert.deepEqual(COST.undo, COST.unhide);
    assert.equal(COST.hiddenTab.titlesAtOnce, BUDGET.screens['tv-requests'].titlesAtOnce);
  });

  describe('the title page', () => {
    it('offers Not interested among the page\'s buttons with what it does; one press is one POST, then Unhide stays focused, and Home\'s row leaves the title with no call', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const page = await open(t, app);
      assert.ok(rowTitles(page).includes('Synthetic Movie One'));
      const rowCalls = page.requests.length;
      const origin = page.location.hash;
      page.click(page.card(T_MOVIE));
      page.follow(origin);
      await page.settled();
      const button = hideButton(page);
      assert.equal(button.textContent, 'Not interested');
      assert.equal(button.getAttribute('aria-label'), 'Not interested: Synthetic Movie One');
      assert.ok(button.closest('.mainDetailButtons.focuscontainer-x'), 'in the focus container with the other buttons');
      assert.ok(button.classList.contains('emby-button') && button.classList.contains('show-focus'));
      assert.equal(button.getAttribute('data-jellypass-tv-focus'), 'hide');
      assert.equal(part(page.view(), '.jellypass-tv-title-hide-box .jellypass-tv-title-note'), 'Only for you in this household. This does not cancel requests or remove downloads.');
      assert.equal(page.view().querySelector('.jellypass-tv-title-hidden-fact'), null);
      const before = page.requests.length;
      page.click(button);
      assert.equal(button.disabled, true, 'while the call is out');
      assert.equal(button.textContent, 'Sending…');
      page.click(button);
      await page.settled();
      assert.deepEqual(page.requests.slice(before).map((request) => `${request.init.method} ${new URL(request.url).pathname}`), [`POST ${HIDDEN}/movie/${T_MOVIE}`]);
      assert.deepEqual(page.requests.slice(before).map((request) => generic(`${request.init.method} ${new URL(request.url).pathname.replace(APP, '')}`)), COST.hide);
      assert.equal(page.requests[before].init.body, '{}');
      assert.equal(button.textContent, 'Unhide');
      assert.equal(button.getAttribute('aria-label'), 'Unhide Synthetic Movie One');
      assert.equal(button.disabled, false);
      assert.equal(page.focused(), button, 'focus stays on the button as its label changes');
      assert.equal(hideMessage(page), 'Hidden from Discover. Choose Unhide to undo.');
      assert.equal(part(page.view(), '.jellypass-tv-title-hidden-fact'), 'Hidden from Discover');
      assert.equal(page.view().querySelector('.jellypass-tv-title-hide-message').getAttribute('role'), 'status');
      // Back to Home: the row is drawn from the answer it holds, without the title and without a call.
      page.back();
      await page.settled();
      assert.ok(!rowTitles(page).includes('Synthetic Movie One'));
      assert.equal(page.requests.length, before + 1, 'nothing was read to leave it out');
      assert.ok(page.requests.length > rowCalls);
      // Unhide: one DELETE, the label comes back, and the row has the title again.
      await toTitle(page, T_MOVIE);
      const after = page.requests.length;
      assert.equal(hideButton(page).textContent, 'Unhide', 'a hidden title opens with Unhide');
      assert.equal(part(page.view(), '.jellypass-tv-title-hidden-fact'), 'Hidden from Discover');
      const readCalls = page.requests.length;
      page.click(hideButton(page));
      await page.settled();
      assert.deepEqual(hiddenCalls(page, readCalls), [`DELETE /hidden/movie/${T_MOVIE}`]);
      assert.equal(hideButton(page).textContent, 'Not interested');
      assert.equal(hideMessage(page), 'Unhidden.');
      assert.equal(page.view().querySelector('.jellypass-tv-title-hidden-fact'), null);
      assert.ok(after > 0);
      page.back();
      await page.settled();
      assert.ok(rowTitles(page).includes('Synthetic Movie One'), 'the row has it again');
      assert.equal(page.logged.length, 0);
    });

    it('draws a title the server says is hidden with Unhide, in the library or asked for too, and hiding touches no request', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      assert.equal((await app.post(`${HIDDEN}/movie/${OWN_MOVIE}`)).status, 200);
      const page = await open(t, app);
      await toTitle(page, OWN_MOVIE);
      assert.ok(page.view().querySelector('.jellypass-tv-title-play'), 'Play is still the primary');
      assert.equal(hideButton(page).textContent, 'Unhide');
      assert.deepEqual(app.seerr.calls.filter((call) => /request/i.test(JSON.stringify(call))).length, 0);
    });

    it('says each failure in fixed words, offers the button again with focus on it, and never repeats a call or shows upstream text', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const cases = [
        [409, "You've hidden as many titles as you can (2,000). Unhide some to hide more."],
        [429, 'Too many tries, try again in a few minutes.'],
        [502, "We couldn't change that just now. Try again in a moment."],
        [500, "We couldn't change that just now. Try again in a moment."],
      ];
      for (const [status, words] of cases) {
        const seen = [];
        const page = await open(t, app, { override: (pathname, init) => {
          if (!pathname.startsWith(HIDDEN)) return undefined;
          seen.push(`${init.method} ${pathname}`);
          return { status, body: '{"error":"upstream said something private"}' };
        } });
        await toTitle(page, T_MOVIE);
        page.click(hideButton(page));
        await page.settled();
        assert.equal(hideMessage(page), words, String(status));
        assert.ok(page.view().querySelector('.jellypass-tv-title-hide-message').classList.contains('jellypass-tv-title-error'));
        assert.equal(hideButton(page).textContent, 'Not interested', 'nothing was hidden');
        assert.equal(hideButton(page).disabled, false);
        assert.equal(page.focused(), hideButton(page));
        assert.deepEqual(seen, [`POST ${HIDDEN}/movie/${T_MOVIE}`], 'sent once');
        lacks(page.document.documentElement.outerHTML, /private/);
        // Nothing left the row, because nothing was hidden.
        page.back();
        await page.settled();
        assert.ok(rowTitles(page).includes('Synthetic Movie One'));
      }
      const offline = await open(t, app, { override: (pathname) => { if (pathname.startsWith(HIDDEN)) throw new TypeError('Failed to fetch'); return undefined; } });
      await toTitle(offline, T_MOVIE);
      offline.click(hideButton(offline));
      await offline.settled();
      assert.equal(hideMessage(offline), "You're offline. Check your connection, then try again.");
    });

    it('a refused token (401) forgets what it knew and says sign in; the late answer of an old sign-in touches nothing of the new one', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const refuse = await open(t, app, { override: (pathname) => (pathname.startsWith(HIDDEN) ? { status: 401, body: '{"error":"unauthorized"}' } : undefined) });
      await toTitle(refuse, T_MOVIE);
      refuse.click(hideButton(refuse));
      await refuse.settled();
      assert.equal(part(refuse.view(), '.jellypass-tv-title-error'), 'Sign in to continue');
      assert.equal(refuse.view().querySelector('.jellypass-tv-title-hide'), null);

      // A POST held while the member signs in again (as the same member, with a new token): its answer is dropped whole.
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const page = await open(t, app, { override: async (pathname, init) => {
        if (pathname.startsWith(HIDDEN) && init.method === 'POST') await held;
        return undefined;
      } });
      await toTitle(page, T_MOVIE);
      const button = hideButton(page);
      page.click(button);
      page.session.token = TOKENS[ANN];
      page.session.user = ANN;
      page.document.dispatchEvent(new page.Event('pageshow'));
      release();
      await page.settled();
      // The old answer is ignored; the page is ended (another member) and the Home row still holds every title.
      assert.equal(page.view(), null);
      assert.equal(page.requests.filter((request) => request.init.method === 'POST').length, 1);
    });

    it('draws nothing of it for a server before apiVersion 3, and asks for nothing', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const seen = [];
      const page = await open(t, app, { override: withoutHiding(app, seen) });
      await toTitle(page, T_MOVIE);
      assert.equal(hideButton(page), null);
      assert.equal(page.view().querySelector('.jellypass-tv-title-hide-box'), null);
      assert.equal(page.view().querySelector('.jellypass-tv-title-hidden-fact'), null);
      page.route('#/jellypass/requests');
      await page.settled();
      assert.equal(page.document.querySelector('[data-jellypass-tv-views]'), null, 'no Requests | Hidden bar');
      page.route('#/jellypass/requests/hidden');
      await page.settled();
      assert.deepEqual(seen.filter((call) => !call.startsWith('GET /jellypass/app/v1/hidden')), []);
    });
  });

  describe('where hidden titles go', () => {
    it('Home\'s row leaves out a title the server says is hidden, and Search keeps it, marked, with Unhide on its page', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      assert.equal((await app.post(`${HIDDEN}/movie/${T_MOVIE}`)).status, 200);
      const page = await open(t, app);
      assert.ok(!rowTitles(page).includes('Synthetic Movie One'));
      assert.equal(hiddenCalls(page).length, 0, 'no list is read to filter');
      // Search: the same title is found again, marked.
      const mount = () => {
        const { document } = page;
        document.getElementById('indexPage').classList.add('hide');
        document.querySelector('.mainAnimatedPages').insertAdjacentHTML('beforeend', '<div id="searchPage" data-role="page" class="page mainAnimatedPage libraryPage"><div class="padded-left padded-right searchFields"><div class="inputContainer"><input id="searchTextInput" type="text" value=""></div></div></div>');
        const input = document.getElementById('searchTextInput');
        input.value = 'synthetic';
        input.focus();
        document.getElementById('searchPage').dispatchEvent(new page.Event('viewshow', { bubbles: true }));
        input.dispatchEvent(new page.Event('input', { bubbles: true }));
      };
      mount();
      await pause(600 + 120);
      await page.settled();
      const searchTitles = () => [...page.document.querySelectorAll('[data-jellypass-tv-search-row] button')].map((card) => [card.querySelector('.jellypass-tv-card-title').textContent, card.querySelector('.jellypass-tv-card-hidden')?.textContent ?? null, card.getAttribute('aria-label')]);
      const found = searchTitles().find(([title]) => title === 'Synthetic Movie One');
      assert.deepEqual(found.slice(0, 2), ['Synthetic Movie One', 'Hidden from Discover']);
      assert.match(found[2], /, Available to get, Hidden from Discover$/);
      assert.equal(searchTitles().filter(([, tag]) => tag).length, 1, 'only the hidden one is marked');
      // Its page offers Unhide; unhiding there marks it no more when Search is shown again, with no new search call.
      const searchHash = page.location.hash;
      page.click(page.document.querySelector(`[data-jellypass-tv-search-row] button[data-tmdb-id="${T_MOVIE}"]`));
      page.follow(searchHash);
      await page.settled();
      assert.equal(hideButton(page).textContent, 'Unhide');
      page.click(hideButton(page));
      await page.settled();
      const searchCalls = page.requests.filter((request) => new URL(request.url).pathname === `${APP}/search`).length;
      page.document.getElementById('searchPage').remove();
      page.back();
      await page.settled();
      assert.ok(page.requests.filter((request) => new URL(request.url).pathname === `${APP}/search`).length === searchCalls);
    });

    it('the Discover page and the service page leave a title out from what they hold when it is hidden, with no call', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const page = await open(t, app, { scopeExtras: { IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} } } });
      page.route('#/jellypass/discover');
      await page.settled();
      const cards = () => [...page.document.querySelectorAll('[data-jellypass-tv-discover] .jellypass-tv-discover-row button.card')].map((card) => card.getAttribute('aria-label'));
      const named = cards().filter((label) => label.startsWith('Synthetic Movie One'));
      assert.ok(named.length > 0, 'the title is on the Discover page');
      // Hidden from its page: Back shows the Discover page again, without the title, from the answers it holds.
      await toTitle(page, T_MOVIE);
      page.click(hideButton(page));
      await page.settled();
      const calls = page.requests.length;
      page.back();
      await page.settled();
      assert.equal(cards().filter((label) => label.startsWith('Synthetic Movie One')).length, 0, 'gone from every row');
      assert.equal(page.requests.length, calls, 'and nothing was read');
    });
  });

  describe('the Hidden view', () => {
    const entries = (from, count, type = 'movie') => Array.from({ length: count }, (_, index) => ({ mediaType: type, tmdbId: from + index, hiddenAt: '2026-10-30T12:00:00.000Z' }));
    const view = (page) => page.document.querySelector('[data-jellypass-tv-hidden]');
    const rows = (page) => [...page.document.querySelectorAll('[data-jellypass-tv-hidden] .jellypass-tv-request')];
    const named = (page) => rows(page).map((row) => row.querySelector('.jellypass-tv-request-name').textContent);
    const toHidden = async (page) => {
      page.route('#/jellypass/requests/hidden');
      await page.settled();
    };

    it('is a separate view beside Requests, reached by a button once an answer showed the server has hiding, and not a filter', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const page = await open(t, app);
      page.route('#/jellypass/requests');
      await page.settled();
      const bar = page.document.querySelector('[data-jellypass-tv-views]');
      assert.ok(bar, 'the bar is drawn (the Home row already showed hiding)');
      assert.equal(bar.getAttribute('aria-label'), 'My requests views');
      assert.ok(bar.classList.contains('focuscontainer-x'));
      const buttons = [...bar.querySelectorAll('button')];
      assert.deepEqual(buttons.map((button) => [button.textContent, button.getAttribute('aria-pressed'), button.getAttribute('data-jellypass-tv-focus')]), [['Requests', 'true', 'view-requests'], ['Hidden', 'false', 'view-hidden']]);
      assert.equal(bar.querySelectorAll('[data-filter-group]').length, 0, 'the bar holds no filter chip');
      const from = page.location.hash;
      page.click(buttons[1]);
      assert.equal(page.location.hash, '#/jellypass/requests/hidden');
      page.follow(from);
      await page.settled();
      assert.ok(view(page));
      assert.equal(page.document.querySelector('.jellypass-tv-views button[aria-pressed="true"]').textContent, 'Hidden');
      assert.equal(part(page.document, '.jellypass-tv-requests-heading'), 'My requests');
      // The Hidden button of the view shown does nothing; Requests goes back.
      const before = page.requests.length;
      page.click(page.document.querySelector('.jellypass-tv-views button[aria-pressed="true"]'));
      assert.equal(page.requests.length, before);
      assert.equal(page.location.hash, '#/jellypass/requests/hidden');
    });

    it('says nothing is hidden, with one call', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const page = await open(t, app);
      await toHidden(page);
      assert.equal(part(page.document, '[data-jellypass-tv-hidden] .jellypass-tv-requests-note:not([hidden])'), 'Nothing hidden. Titles you mark Not interested are listed here, so you can bring them back.');
      assert.deepEqual(hiddenCalls(page), ['GET /hidden']);
      assert.equal(page.document.querySelector('.jellypass-tv-requests-more').hidden, true);
    });

    it('lists the member\'s own hides, names each from its title, and Unhide drops one with one DELETE, focus on the next', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      await app.post(`${HIDDEN}/movie/${T_MOVIE}`);
      await app.post(`${HIDDEN}/tv/${T_TV}`);
      const page = await open(t, app);
      const before = page.requests.length;
      await toHidden(page);
      assert.deepEqual([...named(page)].sort(), ['Synthetic Movie One', 'Synthetic Series Two']);
      assert.match(part(rows(page)[0], '.jellypass-tv-request-on'), /^Hidden on /);
      assert.deepEqual(page.calls(before).filter((call) => !/^GET \/discover/.test(call)), COST.hiddenTab.atOnce);
      const buttons = rows(page).map((row) => row.querySelector('.jellypass-tv-hidden-unhide'));
      assert.deepEqual(buttons.map((button) => button.getAttribute('aria-label')).sort(), ['Unhide Synthetic Movie One', 'Unhide Synthetic Series Two']);
      const dropped = rows(page)[0].querySelector('.jellypass-tv-request-name').textContent;
      const kept = rows(page)[1].querySelector('.jellypass-tv-request-name').textContent;
      const calls = page.requests.length;
      page.click(buttons[0]);
      assert.equal(buttons[0].disabled, true);
      await page.settled();
      assert.deepEqual(page.requests.slice(calls).map((request) => generic(`${request.init.method} ${new URL(request.url).pathname.replace(APP, '')}`)), COST.unhide);
      assert.deepEqual(named(page), [kept]);
      assert.notEqual(dropped, kept);
      assert.equal(page.focused(), buttons[1], 'focus moves to the next entry\'s Unhide');
      assert.equal(part(page.document, '[data-jellypass-tv-hidden] .jellypass-tv-requests-announce'), 'Unhidden.');
      page.click(buttons[1]);
      await page.settled();
      assert.deepEqual(named(page), []);
      assert.equal(page.document.querySelector('.jellypass-tv-requests-note:not([hidden])').textContent.slice(0, 14), 'Nothing hidden');
      assert.equal(page.focused()?.classList.contains('jellypass-tv-view'), true, 'focus is never lost');
      // Home\'s row was read while they were hidden: nothing is fetched to put them back (rows may be shorter) until it is read again.
      const trendingCalls = () => page.requests.filter((request) => new URL(request.url).pathname === `${APP}/discover/trending`).length;
      const reads = trendingCalls();
      page.route('#/home');
      await page.settled();
      assert.ok(!rowTitles(page).includes('Synthetic Movie One'));
      assert.equal(trendingCalls(), reads);
      page.advance(61_000);
      page.shown();
      await page.settled();
      assert.equal(trendingCalls(), reads + 1);
      assert.ok(rowTitles(page).includes('Synthetic Movie One'), 'the row read again has it');
    });

    it('names ten at a time, four calls at once, and reads the next page only when the 50 read are all shown (the pinned budget)', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const pages = { 1: { page: 1, nextPage: 2, results: entries(900_100, 50) }, 2: { page: 2, nextPage: null, results: entries(900_200, 3) } };
      let atOnce = 0;
      let most = 0;
      const page = await open(t, app, { override: async (pathname, init, target) => {
        if (pathname === HIDDEN) return json(pages[target.searchParams.get('page') ?? 1]);
        const title = /^\/jellypass\/app\/v1\/movie\/(9\d{5})$/.exec(pathname);
        if (title) {
          atOnce += 1;
          most = Math.max(most, atOnce);
          await pause(5);
          atOnce -= 1;
          return json({ mediaType: 'movie', tmdbId: Number(title[1]), title: `T${title[1]}`, year: 2026, overview: '', posterUrl: null, backdropUrl: null, rating: null, state: 'get_this', play: null, hidden: true, genres: [], runtime: null, seasons: [] });
        }
        return undefined;
      } });
      await toHidden(page);
      const titleCalls = () => page.requests.filter((request) => /\/movie\/9\d{5}$/.test(request.url)).length;
      assert.equal(rows(page).length, 10);
      assert.equal(titleCalls(), 10);
      assert.ok(most <= 4, `at most four at once (${most})`);
      assert.deepEqual(hiddenCalls(page), ['GET /hidden']);
      for (let round = 2; round <= 5; round += 1) {
        page.click(page.document.querySelector('.jellypass-tv-requests-more'));
        await page.settled();
        assert.equal(rows(page).length, round * 10);
        assert.equal(page.focused()?.classList.contains('jellypass-tv-request-open'), true, 'focus on the first new entry');
      }
      assert.deepEqual(hiddenCalls(page), ['GET /hidden'], 'no second page while the first still has titles to show');
      page.click(page.document.querySelector('.jellypass-tv-requests-more'));
      await page.settled();
      assert.deepEqual(hiddenCalls(page), ['GET /hidden', 'GET /hidden?page=2']);
      assert.deepEqual(hiddenCalls(page).slice(1).map((call) => call.replace(/page=\d+/, 'page={page}')), COST.hiddenTab.loadMore);
      assert.equal(rows(page).length, 53);
      assert.equal(page.document.querySelector('.jellypass-tv-requests-more').hidden, true);
      assert.equal(most <= 4, true);
    });

    it('opens a title and Back returns with the same entry focused, with the names kept (no title call again)', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      await app.post(`${HIDDEN}/movie/${T_MOVIE}`);
      const page = await open(t, app);
      await toHidden(page);
      const entry = rows(page)[0].querySelector('.jellypass-tv-request-open');
      entry.focus();
      const from = page.location.hash;
      page.click(entry);
      assert.equal(page.location.hash, `#/jellypass/title/movie/${T_MOVIE}`);
      page.follow(from);
      await page.settled();
      assert.equal(hideButton(page).textContent, 'Unhide');
      const calls = page.requests.length;
      page.back();
      await page.settled();
      assert.equal(page.focused()?.getAttribute('data-jellypass-tv-focus'), `entry-movie-${T_MOVIE}`);
      assert.deepEqual(page.calls(calls).filter((call) => /\/(movie|tv)\//.test(call)), [], 'the name was kept');
    });

    it('says a failed Unhide in fixed words under the entry, offers it again and sends once; a late answer after a new sign-in touches nothing', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      await app.post(`${HIDDEN}/movie/${T_MOVIE}`);
      const seen = [];
      let status = 429;
      const page = await open(t, app, { override: (pathname, init) => {
        if (pathname.startsWith(HIDDEN) && init.method === 'DELETE') {
          seen.push(pathname);
          return { status, body: '{"error":"upstream said something private"}' };
        }
        return undefined;
      } });
      await toHidden(page);
      const button = rows(page)[0].querySelector('.jellypass-tv-hidden-unhide');
      page.click(button);
      await page.settled();
      assert.equal(part(rows(page)[0], '.jellypass-tv-hidden-message'), 'Too many tries, try again in a few minutes.');
      assert.equal(button.disabled, false);
      assert.equal(button.textContent, 'Unhide');
      assert.equal(page.focused(), button);
      assert.equal(seen.length, 1);
      lacks(page.document.documentElement.outerHTML, /private/);
      status = 502;
      page.click(button);
      await page.settled();
      assert.equal(part(rows(page)[0], '.jellypass-tv-hidden-message'), "We couldn't change that just now. Try again in a moment.");
      assert.equal(named(page).length, 1, 'the entry stays');
    });

    it('is emptied and asks nothing more when the member signs out or another signs in', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      await app.post(`${HIDDEN}/movie/${T_MOVIE}`);
      const page = await open(t, app);
      await toHidden(page);
      assert.equal(rows(page).length, 1);
      const calls = page.requests.length;
      page.session.token = null;
      page.session.user = null;
      page.document.body.appendChild(page.document.createElement('span'));
      await page.settled();
      assert.equal(view(page), null);
      assert.equal(page.requests.length, calls);
    });
  });

  describe('privacy', () => {
    it('another member\'s or household\'s hides change nothing the member sees: the same calls, rows, title page and Hidden view', async (t) => {
      const run = async (hides) => {
        const app = await startApp(t, webWorld(), tvOn());
        for (const [user, mediaType, id, host] of hides) await app.post(`${HIDDEN}/${mediaType}/${id}`, undefined, { user, ...(host ? { host } : {}) });
        const page = await open(t, app);
        const rowsNow = rowTitles(page);
        await toTitle(page, T_MOVIE);
        const title = page.view().outerHTML;
        page.route('#/jellypass/requests/hidden');
        await page.settled();
        return { calls: page.trace(), rows: rowsNow, title, hidden: page.document.querySelector('[data-jellypass-tv-hidden]').outerHTML, cleaned: assertNoCanaries(page.document.documentElement.outerHTML, 'canary') };
      };
      const baseline = await run([]);
      // Ann, in Alice's household, and Carol in another one, hid titles: Alice sees exactly what she saw with nobody hiding.
      const others = await run([[ANN, 'movie', T_MOVIE], [ANN, 'tv', T_TV]]);
      assert.deepEqual(others.rows, baseline.rows);
      assert.equal(others.title, baseline.title);
      assert.equal(others.hidden, baseline.hidden);
      assert.deepEqual(others.calls, baseline.calls);
    });

    it('keeps nothing: no storage, no address or header beyond the member\'s own call, and the token is never in the page', async (t) => {
      const app = await startApp(t, webWorld(), tvOn());
      const page = await open(t, app);
      await toTitle(page, T_MOVIE);
      page.click(hideButton(page));
      await page.settled();
      page.route('#/jellypass/requests/hidden');
      await page.settled();
      for (const request of page.requests) {
        assert.equal(request.init.credentials, 'omit');
        assert.deepEqual(Object.keys(request.init.headers).filter((name) => !['Accept', 'Authorization', 'Content-Type'].includes(name)), []);
        assert.doesNotMatch(request.url, /hidden=|hide=/);
      }
      assert.deepEqual(page.stored, []);
    });
  });
});
