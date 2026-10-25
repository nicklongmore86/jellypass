// The household app's page (step 1b): how it is served, what it may do (CSP, service worker, manifest) and what it
// renders from the API's DTOs. DOM-level tests use linkedom (a small DOM for Node, a dev dependency only) to run the
// real client modules from dist/app against the real API, served from the same fakes as test/app-api.test.mjs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { APP_CONTENT_SECURITY_POLICY, APP_PERMISSIONS_POLICY } from '../dist/app-assets.js';
import { buildApp, contentHash, stampWorker } from '../scripts/build-app.mjs';
import { ALICE, ANN, BOB, CAROL, HOST_A, HOST_B, OUTSIDER, OWN_MOVIE, T_MOVIE, T_TV, TOKENS, get, otherHouseholdWorlds, post, startApp, world } from './support/household-app.mjs';
import { assertNoCanaries } from './support/seerr-fixtures.mjs';

const DIST_APP = path.join(import.meta.dirname, '..', 'dist', 'app');
const PAGE = '/jellypass/app/';
const NOT_FOUND = '{"error":"not_found"}';

function walk(directory, prefix = '') {
  return readdirSync(directory).flatMap((name) => {
    const full = path.join(directory, name);
    const relative = path.posix.join(prefix, name);
    return statSync(full).isDirectory() ? walk(full, relative) : [relative];
  });
}
const FILES = walk(DIST_APP);
const read = (relative) => readFileSync(path.join(DIST_APP, relative), 'utf8');
/** The built, fingerprinted name of a source path: `app.css` is `app.<12 hex digits>.css`. Exactly one file has it. */
const FINGERPRINT = '[0-9a-f]{12}';
function BUILT(logical) {
  const ext = path.posix.extname(logical);
  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = FILES.filter((file) => new RegExp(`^${escape(logical.slice(0, -ext.length))}\\.${FINGERPRINT}${escape(ext)}$`).test(file));
  assert.equal(found.length, 1, `${logical} is built once: ${found}`);
  return found[0];
}

/** What a request answered, minus anything that differs by design between two fixed 404s. */
const shape = (answer) => ({ status: answer.status, text: answer.text, headers: { ...answer.headers, date: undefined } });

describe('household app page: serving', { timeout: 30_000 }, () => {
  it('serves the page and every file it needs on household hosts, with no credentials and no upstream calls', async (t) => {
    const app = await startApp(t);
    for (const host of [HOST_A, HOST_B]) {
      for (const file of FILES) {
        const served = file === 'index.html' ? PAGE : `${PAGE}${file}`;
        const answer = await app.get(served, { host, user: null });
        assert.equal(answer.status, 200, `${host} ${served}`);
        assert.equal(answer.text, read(file), served);
      }
    }
    // The page also answers at its own name, and the path without the slash goes to it.
    assert.equal((await app.get(`${PAGE}index.html`, { user: null })).status, 200);
    const bare = await app.get('/jellypass/app', { user: null });
    assert.equal(bare.status, 308);
    assert.equal(bare.headers.location, PAGE);
    // None of this touched Jellyfin, Seerr or TMDB: the files are static and need no one's identity.
    assert.equal(app.jellyfin.requests.length, 0);
    assert.equal(app.seerr.calls.length, 0);
    assert.equal(app.tmdb.calls.length, 0);
  });

  it('serves the same bytes to everyone: no user data in any file, whoever asks', async (t) => {
    const app = await startApp(t);
    const anonymous = await app.get(PAGE, { user: null });
    const signedIn = await app.get(PAGE, { user: ALICE });
    const otherHousehold = await app.get(PAGE, { host: HOST_B, user: null });
    assert.equal(anonymous.text, signedIn.text);
    assert.equal(anonymous.text, otherHousehold.text);
    for (const file of FILES.filter((name) => !/\.(png)$/.test(name))) {
      assertNoCanaries(read(file), `${file} carries a canary`);
      assert.doesNotMatch(read(file), /farmhouse|mill|alice|token-/i, `${file} carries household or user data`);
    }
  });

  it('answers HEAD without a body and a conditional GET with 304', async (t) => {
    const app = await startApp(t);
    const css = await app.get(`${PAGE}${BUILT('app.css')}`, { user: null });
    const etag = css.headers.etag;
    assert.match(etag, /^"[A-Za-z0-9_-]{27}"$/);
    const cached = await app.get(`${PAGE}${BUILT('app.css')}`, { user: null, headers: { 'If-None-Match': etag } });
    assert.equal(cached.status, 304);
    assert.equal(cached.body.length, 0);
    assert.equal(cached.headers.etag, etag);
    const stale = await app.get(`${PAGE}${BUILT('app.css')}`, { user: null, headers: { 'If-None-Match': '"other"' } });
    assert.equal(stale.status, 200);
    const head = await new Promise((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const call = request({ hostname: '127.0.0.1', port: app.port, path: PAGE, method: 'HEAD', headers: { Host: HOST_A } }, (response) => {
          response.resume();
          response.on('end', () => resolve({ status: response.statusCode, headers: response.headers }));
        });
        call.once('error', reject);
        call.end();
      });
    });
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-length'], String(Buffer.byteLength(read('index.html'))));
  });

  it('is served only on household hosts and only when the app is enabled: every other answer is the same fixed 404', async (t) => {
    const off = await startApp(t, world(), { app: false });
    const on = await startApp(t);
    const unknownOff = shape(await off.get('/jellypass/app/no-such-file', { user: null }));
    assert.equal(unknownOff.status, 404);
    assert.equal(unknownOff.text, NOT_FOUND);
    // App off: no file, and not the page either; byte-for-byte the same as any other app path, never proxied.
    for (const file of [PAGE, `${PAGE}sw.js`, `${PAGE}${BUILT('manifest.webmanifest')}`, `${PAGE}${BUILT('js/main.js')}`, `${PAGE}${BUILT('app.css')}`, '/jellypass/app']) {
      assert.deepEqual(shape(await off.get(file, { user: null })), unknownOff, file);
    }
    assert.equal(off.jellyfin.requests.length, 0);
    // Admin host (and an address that is no household's): the app's paths do not exist, whatever the app setting.
    const admin = { Authorization: 'Bearer admin-secret' };
    for (const host of ['jellypass.example.test', '127.0.0.1', 'localhost']) {
      for (const headers of [undefined, admin]) {
        const baseline = shape(await on.get('/jellypass/app-no-such-path', { host, user: null, ...(headers ? { headers } : {}) }));
        assert.equal(baseline.status, headers ? 404 : 401);
        for (const file of [PAGE, `${PAGE}sw.js`, `${PAGE}${BUILT('manifest.webmanifest')}`, `${PAGE}${BUILT('js/main.js')}`, '/jellypass/app']) {
          const options = { host, user: null, ...(headers ? { headers } : {}) };
          assert.deepEqual(shape(await on.get(file, options)), baseline, `${host} ${file}`);
          assert.deepEqual(shape(await off.get(file, options)), baseline, `${host} ${file} (app off)`);
        }
      }
    }
    // A host for a household that does not exist answers as it does for any path.
    const nowhere = shape(await on.get('/', { host: 'jelly-nowhere.example.test', user: null }));
    assert.equal(shape(await on.get(PAGE, { host: 'jelly-nowhere.example.test', user: null })).text, nowhere.text);
    assert.equal(on.jellyfin.requests.length, 0);
  });

  it('serves the app only at its exact lower-case paths: any other spelling is an unknown app path, never the page', async (t) => {
    const app = await startApp(t);
    const unknown = shape(await app.get('/jellypass/app/no-such-file', { user: null }));
    assert.equal(unknown.status, 401);
    for (const variant of ['/JELLYPASS/APP/', '/Jellypass/App/', '/jellypass/APP/', '/JELLYPASS/APP', '/jellypass/app/SW.JS', '/JELLYPASS/APP/sw.js',
      '/jellypass/app/JS/main.js', '/jellypass/app/App.css', '/jellypass/app/INDEX.HTML']) {
      assert.deepEqual(shape(await app.get(variant, { user: null })), unknown, variant);
    }
    const signedIn = shape(await app.get('/jellypass/app/no-such-file'));
    for (const variant of ['/JELLYPASS/APP/', '/JELLYPASS/APP/sw.js', '/jellypass/app/SW.JS']) {
      assert.deepEqual(shape(await app.get(variant)), signedIn, variant);
    }
    // The API is unaffected: it was always exact-case and still answers where it did.
    assert.equal((await app.get('/jellypass/app/v1/me')).status, 200);
    assert.equal((await app.get(PAGE, { user: null })).status, 200);
  });

  it('leaves the API as it was: files need no sign-in, /v1 and unknown app paths still do', async (t) => {
    const app = await startApp(t);
    assert.equal((await app.get('/jellypass/app/v1/me', { user: null })).status, 401);
    assert.equal((await app.get('/jellypass/app/v1/me')).status, 200);
    assert.equal((await app.get('/jellypass/app/js/', { user: null })).status, 401);
    assert.equal((await app.get('/jellypass/app/js/nope.js')).status, 404);
    // POST to a file path is not a file read.
    const post = await new Promise((resolve, reject) => {
      import('node:http').then(({ request }) => {
        const call = request({ hostname: '127.0.0.1', port: app.port, path: PAGE, method: 'POST', headers: { Host: HOST_A } }, (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        });
        call.once('error', reject);
        call.end();
      });
    });
    assert.equal(post, 401);
  });
});

describe('household app page: headers', { timeout: 30_000 }, () => {
  it('sends a strict CSP and the security headers with every file', async (t) => {
    const app = await startApp(t);
    const directives = Object.fromEntries(APP_CONTENT_SECURITY_POLICY.split('; ').map((directive) => {
      const [name, ...values] = directive.split(' ');
      return [name, values];
    }));
    assert.deepEqual(directives, {
      'default-src': ["'none'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'https://image.tmdb.org'],
      'connect-src': ["'self'"],
      'manifest-src': ["'self'"],
      'worker-src': ["'self'"],
      'base-uri': ["'none'"],
      'form-action': ["'none'"],
      'frame-ancestors': ["'none'"],
    });
    assert.doesNotMatch(APP_CONTENT_SECURITY_POLICY, /unsafe|\*|data:|blob:|http:/);
    for (const file of FILES) {
      const served = file === 'index.html' ? PAGE : `${PAGE}${file}`;
      const { headers } = await app.get(served, { user: null });
      assert.equal(headers['content-security-policy'], APP_CONTENT_SECURITY_POLICY, served);
      assert.equal(headers['x-content-type-options'], 'nosniff', served);
      assert.equal(headers['referrer-policy'], 'no-referrer', served);
      assert.equal(headers['x-frame-options'], 'DENY', served);
      assert.equal(headers['cross-origin-opener-policy'], 'same-origin', served);
      assert.equal(headers['cross-origin-resource-policy'], 'same-origin', served);
      assert.equal(headers['permissions-policy'], APP_PERMISSIONS_POLICY, served);
      assert.equal(headers['set-cookie'], undefined, served);
    }
  });

  it('denies every powerful browser feature the app does not use', () => {
    const features = APP_PERMISSIONS_POLICY.split(', ');
    for (const feature of ['camera', 'microphone', 'geolocation', 'payment', 'usb', 'serial', 'hid', 'bluetooth', 'midi',
      'display-capture', 'accelerometer', 'gyroscope', 'magnetometer', 'screen-wake-lock', 'publickey-credentials-get', 'xr-spatial-tracking']) {
      assert.ok(features.includes(`${feature}=()`), `${feature} is denied`);
    }
    for (const feature of features) assert.match(feature, /^[a-z-]+=\(\)$/, 'every feature is switched off for everyone, itself included');
  });

  const IMMUTABLE = 'public, max-age=31536000, immutable';
  const NEVER_STORED = { 'cache-control': 'no-store', 'cdn-cache-control': 'no-store', 'cloudflare-cdn-cache-control': 'no-store' };

  it('sets the right content type and cache rule for each kind of file', async (t) => {
    const app = await startApp(t);
    const hashed = {
      [BUILT('app.css')]: 'text/css; charset=utf-8',
      [BUILT('js/main.js')]: 'text/javascript; charset=utf-8',
      [BUILT('js/signin.js')]: 'text/javascript; charset=utf-8',
      [BUILT('manifest.webmanifest')]: 'application/manifest+json; charset=utf-8',
      [BUILT('icons/icon-192.png')]: 'image/png',
      [BUILT('tmdb-logo.svg')]: 'image/svg+xml',
    };
    // Fingerprinted files never change under their name: kept for a year, immutable, with a validator.
    for (const [file, type] of Object.entries(hashed)) {
      const { headers } = await app.get(`${PAGE}${file}`, { user: null });
      assert.equal(headers['content-type'], type, file);
      assert.equal(headers['cache-control'], IMMUTABLE, file);
      assert.match(headers.etag, /^"[A-Za-z0-9_-]{27}"$/, file);
      assert.equal(headers['cdn-cache-control'], undefined, file);
    }
    // The page and the worker keep their addresses, so no browser, CDN or other shared cache may keep either; and they
    // carry no validator, so nothing can revalidate a stale copy into use.
    for (const served of [PAGE, `${PAGE}index.html`, `${PAGE}sw.js`, '/jellypass/app']) {
      const { headers } = await app.get(served, { user: null });
      for (const [name, value] of Object.entries(NEVER_STORED)) assert.equal(headers[name], value, `${served} ${name}`);
      assert.equal(headers.etag, undefined, served);
      assert.equal(headers['set-cookie'], undefined, served);
      assert.equal(headers.expires, undefined, served);
    }
    assert.equal((await app.get(PAGE, { user: null })).headers['content-type'], 'text/html; charset=utf-8');
    assert.equal((await app.get(`${PAGE}sw.js`, { user: null })).headers['content-type'], 'text/javascript; charset=utf-8');
    // A conditional request for the page or worker is answered in full, never 304.
    for (const [served, file] of [[PAGE, 'index.html'], [`${PAGE}sw.js`, 'sw.js']]) {
      const etag = `"${createHash('sha256').update(readFileSync(path.join(DIST_APP, file))).digest('base64url').slice(0, 27)}"`;
      assert.equal((await app.get(served, { user: null, headers: { 'If-None-Match': etag } })).status, 200, `${served} is never answered 304`);
    }
    // The API next door is still never cached.
    assert.equal((await app.get('/jellypass/app/v1/me')).headers['cache-control'], 'no-store');
  });

  it('lets no CDN keep any other answer under /jellypass/app: errors, redirects, refusals and failures', async (t) => {
    const app = await startApp(t, world({ failCatalogue: 500 }));
    const neverStored = (answer, what) => {
      for (const [name, value] of Object.entries(NEVER_STORED)) assert.equal(answer.headers[name], value, `${what} ${name}`);
      assert.equal(answer.headers.etag, undefined, what);
    };
    const hashedJs = `${PAGE}js/main.${'0'.repeat(12)}.js`;
    const answers = [
      [await app.get(hashedJs), 404, 'an unknown fingerprinted script, signed in'],
      [await app.get(hashedJs, { user: null }), 401, 'an unknown fingerprinted script, signed out'],
      [await app.get(`${PAGE}no-such-file`, { user: null }), 401, 'an unknown file'],
      [await app.get('/jellypass/app', { user: null }), 308, 'the redirect to the page'],
      [await app.get(`${PAGE}sw.js`, { host: 'jelly-missing.example.test', user: null }), 404, 'the worker on an unknown household'],
      [await app.get(PAGE, { host: 'jelly-missing.example.test', user: null }), 404, 'the page on an unknown household'],
      [await app.get('/jellypass/app/v1/me', { host: 'jelly-missing.example.test' }), 404, 'the API on an unknown household'],
      [await app.get('/jellypass/app/v1/me', { user: null }), 401, 'the API, signed out'],
      [await app.get(`/jellypass/app/v1/movie/${T_MOVIE}`), 502, 'the API while TMDB fails'],
    ];
    for (const [answer, status, what] of answers) {
      assert.equal(answer.status, status, what);
      neverStored(answer, what);
    }
    // The address's own budget for the API, used up.
    let limited;
    for (let index = 0; index < 400 && !limited; index += 1) {
      const answer = await app.get('/jellypass/app/v1/me', { user: null });
      if (answer.status === 429) limited = answer;
    }
    assert.ok(limited, 'the API rate limit');
    neverStored(limited, 'a rate-limited call');
    // A non-file method on a file's path.
    const posted = await post(app.port, PAGE, { Host: HOST_A }, {});
    assert.ok(posted.status >= 400, 'POST to the page');
    neverStored(posted, 'POST to the page');
    // A WebSocket upgrade under /jellypass/app, which is never proxied.
    const upgrade = await new Promise((resolve, reject) => {
      import('node:net').then(({ connect }) => {
        const socket = connect(app.port, '127.0.0.1', () => socket.write(`GET ${PAGE}sw.js HTTP/1.1\r\nHost: ${HOST_A}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`));
        let text = '';
        socket.on('data', (chunk) => { text += chunk; });
        socket.on('end', () => resolve(text));
        socket.on('error', reject);
      });
    });
    assert.match(upgrade, /^HTTP\/1\.1 404 /);
    for (const [name, value] of Object.entries(NEVER_STORED)) assert.match(upgrade, new RegExp(`\r\n${name}: ${value}\r\n`, 'i'), name);
    // Without the app API, its paths are a fixed 404 that no CDN keeps either.
    const off = await startApp(t, world(), { app: false });
    const disabled = await off.get(PAGE, { user: null });
    assert.equal(disabled.status, 404);
    neverStored(disabled, 'the app switched off');
  });

  it('serves a file only under the fingerprint of its content: an old or made-up one is an unknown app path', async (t) => {
    const app = await startApp(t);
    const css = BUILT('app.css');
    assert.equal((await app.get(`${PAGE}${css}`, { user: null })).status, 200);
    const unknown = shape(await app.get('/jellypass/app/no-such-file', { user: null }));
    for (const name of [
      'app.css', 'js/main.js', 'manifest.webmanifest', 'icons/icon-192.png', 'tmdb-logo.svg', 'js/session.js',
      css.replace(/\.[0-9a-f]{12}\./, '.000000000000.'), css.replace(/\.[0-9a-f]{12}\./, '.ffffffffffff.'),
      css.replace('.css', '.js'), `${css}.map`,
    ]) {
      assert.deepEqual(shape(await app.get(`${PAGE}${name}`, { user: null })), unknown, name);
    }
    assert.equal((await app.get(`${PAGE}js/nope.${'0'.repeat(12)}.js`)).status, 404);
  });

  it('fingerprints every file the page loads and names only fingerprinted files', () => {
    const named = FILES.filter((file) => file !== 'index.html' && file !== 'sw.js');
    assert.ok(named.length >= 11);
    for (const file of named) assert.match(file, /^(?:[a-z0-9-]+\/)?[a-z0-9-]+\.[0-9a-f]{12}\.[a-z]+$/, file);
    const { document } = parseHTML(read('index.html'));
    const referenced = [
      ...document.querySelectorAll('script[src], link[href]'),
    ].map((node) => node.getAttribute('src') ?? node.getAttribute('href'));
    assert.deepEqual(referenced.sort(), [
      BUILT('app.css'), BUILT('icons/apple-touch-icon.png'), BUILT('icons/icon-192.png'), BUILT('js/main.js'), BUILT('manifest.webmanifest'),
    ].sort());
    // Every module import reaches a built file, and the sources' own names are gone.
    for (const file of FILES.filter((name) => name.endsWith('.js') && name !== 'sw.js')) {
      for (const match of read(file).matchAll(/(?:from|import)\s*['"](\.\/[^'"]+)['"]/g)) {
        assert.ok(FILES.includes(path.posix.join(path.posix.dirname(file), match[1])), `${file} imports ${match[1]}`);
        assert.match(match[1], new RegExp(`\\.${FINGERPRINT}\\.js$`), `${file} imports ${match[1]}`);
      }
    }
    for (const source of ['app.css', 'js/main.js', 'js/api.js', 'manifest.webmanifest', 'icons/icon-192.png', 'tmdb-logo.svg']) {
      assert.equal(FILES.includes(source), false, `${source} is only served fingerprinted`);
    }
    assert.ok(JSON.parse(read(BUILT('manifest.webmanifest'))).icons.every((icon) => FILES.includes(icon.src)));
    assert.ok(read(BUILT('js/render.js')).includes(`'${BUILT('tmdb-logo.svg')}'`), 'the logo is named by its fingerprint');
    // The logo is TMDB's, unmodified.
    assert.deepEqual(readFileSync(path.join(DIST_APP, BUILT('tmdb-logo.svg'))), readFileSync(path.join(import.meta.dirname, '..', 'app', 'static', 'tmdb-logo.svg')));
  });

  it('gives a file a new name when it, or anything it names, changes, and the same name when nothing does', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'jellypass-fingerprint-'));
    try {
      const staticDir = path.join(root, 'static');
      const jsDir = path.join(root, 'js');
      cpSync(path.join(import.meta.dirname, '..', 'app', 'static'), staticDir, { recursive: true });
      cpSync(path.join(import.meta.dirname, '..', 'dist', 'app-js'), jsDir, { recursive: true });
      const build = (name) => buildApp({ staticDir, jsDir, outDir: path.join(root, name) });
      const before = build('one');
      assert.deepEqual([...build('two')].sort(), [...before].sort(), 'a rebuild gives the same names');
      assert.deepEqual(walk(path.join(root, 'one')), walk(path.join(root, 'two')));
      writeFileSync(path.join(staticDir, 'app.css'), `${readFileSync(path.join(staticDir, 'app.css'), 'utf8')}\n.x { color: red; }\n`);
      const css = build('three');
      assert.notEqual(css.get('app.css'), before.get('app.css'));
      assert.equal(css.get('js/api.js'), before.get('js/api.js'), 'unrelated files keep their names');
      assert.notEqual(read('index.html'), readFileSync(path.join(root, 'three', 'index.html'), 'utf8'), 'the page names the new stylesheet');
      // A module's name follows what it imports: changing api.js renames main.js and signin.js, which import it.
      writeFileSync(path.join(jsDir, 'api.js'), `${readFileSync(path.join(jsDir, 'api.js'), 'utf8')}\n// changed\n`);
      const api = build('four');
      for (const file of ['js/api.js', 'js/signin.js', 'js/main.js']) assert.notEqual(api.get(file), css.get(file), file);
      assert.equal(api.get('js/session.js'), css.get('js/session.js'));
      // The worker's cache name follows the files too.
      const stamp = (name) => /\$\{CACHE_PREFIX\}([0-9a-f]{16})-/.exec(readFileSync(path.join(root, name, 'sw.js'), 'utf8'))?.[1];
      assert.notEqual(stamp('four'), stamp('three'));
      assert.notEqual(stamp('three'), stamp('one'));
      // A reference the build cannot rewrite stops it.
      writeFileSync(path.join(staticDir, 'app.css'), 'body { background: url(x.png); }');
      assert.throws(() => build('five'), /url\(\) or @import/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('household app page: files', () => {
  it('has a page with no inline script or style, no handlers and nothing loaded from elsewhere', () => {
    const { document } = parseHTML(read('index.html'));
    assert.equal(document.documentElement.getAttribute('lang'), 'en');
    for (const script of document.querySelectorAll('script')) {
      assert.equal(script.getAttribute('type'), 'module');
      assert.ok(script.getAttribute('src'), 'inline script');
      assert.equal(script.textContent.trim(), '');
    }
    assert.equal(document.querySelectorAll('style').length, 0, 'inline style element');
    for (const element of document.querySelectorAll('*')) {
      for (const name of element.getAttributeNames()) {
        assert.doesNotMatch(name, /^on/i, `${element.tagName} has ${name}`);
        assert.notEqual(name, 'style', `${element.tagName} has an inline style`);
        assert.doesNotMatch(element.getAttribute(name), /^(?:https?:)?\/\//i, `${element.tagName} ${name} points elsewhere`);
      }
    }
    const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.getAttribute('content');
    assert.match(meta('viewport'), /width=device-width/);
    assert.match(meta('viewport'), /viewport-fit=cover/);
    assert.equal(meta('apple-mobile-web-app-capable'), 'yes');
    assert.equal(meta('mobile-web-app-capable'), 'yes');
    assert.equal(meta('apple-mobile-web-app-title'), 'JellyPass');
    assert.ok(meta('apple-mobile-web-app-status-bar-style'));
    assert.equal(meta('theme-color'), JSON.parse(read(BUILT('manifest.webmanifest'))).theme_color);
    assert.equal(document.querySelector('link[rel="manifest"]').getAttribute('href'), BUILT('manifest.webmanifest'));
    assert.equal(document.querySelector('link[rel="apple-touch-icon"]').getAttribute('href'), BUILT('icons/apple-touch-icon.png'));
    assert.ok(document.querySelector('main'), 'a main landmark');
    assert.ok(document.querySelector('nav[aria-label]'), 'a labelled nav');
    assert.ok(document.querySelector('a.skip-link'), 'a skip link');
  });

  it('has a manifest that installs the app as standalone, starting at the app, with real icons', () => {
    const manifest = JSON.parse(read(BUILT('manifest.webmanifest')));
    assert.equal(manifest.name, 'JellyPass');
    assert.equal(manifest.display, 'standalone');
    // The scope is the whole household host, not just the app: Jellyfin web (sign-in, and what Play opens) then stays inside
    // the installed app, which on iOS has its own storage apart from Safari's, so the sign-in it needs is the app's own.
    assert.equal(manifest.scope, '/');
    assert.equal(manifest.start_url, PAGE);
    assert.ok(manifest.start_url.startsWith(manifest.scope));
    assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
    assert.match(manifest.background_color, /^#[0-9a-f]{6}$/i);
    for (const purpose of ['any', 'maskable']) {
      assert.deepEqual(manifest.icons.filter((icon) => icon.purpose === purpose).map((icon) => icon.sizes).sort(), ['192x192', '512x512']);
    }
    for (const icon of manifest.icons) {
      const png = readFileSync(path.join(DIST_APP, icon.src));
      assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], icon.src);
      assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes, icon.src);
    }
    const touch = readFileSync(path.join(DIST_APP, BUILT('icons/apple-touch-icon.png')));
    assert.equal(`${touch.readUInt32BE(16)}x${touch.readUInt32BE(20)}`, '180x180');
  });

  it('bundles the unmodified TMDB logo locally and never loads anything from another origin', () => {
    const logo = read(BUILT('tmdb-logo.svg'));
    assert.match(logo, /^<svg [^>]*viewBox="0 0 273\.42 35\.52"/);
    assert.doesNotMatch(logo, /<script|href=["']https?:|on\w+=/i);
    for (const file of FILES.filter((name) => /\.(js|css|html|webmanifest)$/.test(name))) {
      const source = read(file);
      // The only absolute URLs are links the person follows (TMDB's site), TMDB's image host and the SVG namespace.
      for (const url of source.match(/https?:\/\/[^\s"'`)]+/g) ?? []) {
        assert.match(url, /^(?:https:\/\/(?:www\.themoviedb\.org\/?|image\.tmdb\.org\/t\/p\/.*|image\\\.tmdb.*)|http:\/\/www\.w3\.org\/2000\/svg)$/, `${file} mentions ${url}`);
      }
    }
    assert.doesNotMatch(read(BUILT('app.css')), /@import|url\(/);
  });

  it('writes nothing it should not: no HTML parsing of text, no eval, no cookies, and storage only in session.js, for two keys', () => {
    for (const file of FILES.filter((name) => name.startsWith('js/'))) {
      const source = read(file);
      assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc/, file);
      assert.doesNotMatch(source, /sessionStorage|indexedDB|document\.cookie|caches\./, file);
      if (!file.startsWith('js/session.')) assert.doesNotMatch(source, /setItem|removeItem|\.clear\(/, `${file} writes browser storage outside session.js`);
    }
    // The only storage the app writes is Jellyfin web's own credentials (its sign-in) and its own random device ID.
    const session = read(BUILT('js/session.js'));
    const keys = new Set([...session.matchAll(/CREDENTIALS_KEY = '([^']+)'|DEVICE_ID_KEY = '([^']+)'/g)].map((match) => match[1] ?? match[2]));
    assert.deepEqual([...keys].sort(), ['jellyfin_credentials', 'jellypass_device_id']);
    assert.deepEqual([...session.matchAll(/setItem\(([A-Z_]+)/g)].map((match) => match[1]).sort(), ['CREDENTIALS_KEY', 'CREDENTIALS_KEY', 'DEVICE_ID_KEY']);
    assert.doesNotMatch(session, /removeItem/);
    // No token, password or user ID reaches a URL, a log or the address bar.
    for (const file of FILES.filter((name) => name.startsWith('js/'))) {
      assert.doesNotMatch(read(file), /console\./, `${file} logs`);
    }
  });

  it('keeps every colour pair in the stylesheet at WCAG AA contrast', () => {
    const css = read(BUILT('app.css'));
    const tokens = Object.fromEntries([...css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6});/gi)].map((match) => [match[1], match[2]]));
    const luminance = (hex) => {
      const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
        .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const contrast = (a, b) => {
      const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (high + 0.05) / (low + 0.05);
    };
    const ratio = (a, b) => contrast(tokens[a], tokens[b]);
    const pairs = [
      // Text on the page, on its glow and on cards.
      ['text', 'bg'], ['text', 'bg-glow'], ['text', 'surface'], ['text', 'surface-raised'],
      ['muted', 'bg'], ['muted', 'bg-glow'], ['muted', 'surface'], ['muted', 'surface-raised'],
      // The accent as text (the active tab, links) and as the button: dark text on both ends of the gradient.
      ['accent', 'bg'], ['accent', 'bg-glow'], ['accent', 'surface'],
      ['on-accent', 'accent'], ['on-accent', 'accent-2'],
      // Status pills.
      ['pill-ok-text', 'pill-ok-bg'], ['pill-neutral-text', 'pill-neutral-bg'], ['pill-bad-text', 'pill-bad-bg'], ['pill-warn-text', 'pill-warn-bg'],
      // Error text on the page and on cards.
      ['pill-bad-text', 'bg'], ['pill-bad-text', 'surface'],
    ];
    for (const [foreground, background] of pairs) {
      assert.ok(tokens[foreground] && tokens[background], `${foreground} on ${background} are tokens`);
      assert.ok(ratio(foreground, background) >= 4.5, `${foreground} on ${background}: ${ratio(foreground, background).toFixed(2)}`);
    }
    // The gradient button is made of exactly the two accents the pairs above were checked against.
    assert.match(css, /--accent-gradient: linear-gradient\(135deg, var\(--accent\), var\(--accent-2\)\)/);
    assert.match(css, /\.button \{[^}]*background: var\(--accent-gradient\); color: var\(--on-accent\)/);

    // The glass: a translucent rgb() token must be its opaque pair's colour, and its text must hold up even on a white poster behind it.
    const glass = Object.fromEntries([...css.matchAll(/--(pill-[a-z]+)-glass:\s*rgb\((\d+) (\d+) (\d+) \/ ([0-9.]+)\);/g)]
      .map((match) => [match[1], { rgb: match.slice(2, 5).map(Number), alpha: Number(match[5]) }]));
    assert.deepEqual(Object.keys(glass).sort(), ['pill-bad', 'pill-neutral', 'pill-ok', 'pill-warn']);
    for (const [name, { rgb, alpha }] of Object.entries(glass)) {
      const hex = `#${rgb.map((value) => value.toString(16).padStart(2, '0')).join('')}`;
      assert.equal(hex, tokens[`${name}-bg`], `${name}-glass is ${name}-bg`);
      const overWhite = `#${rgb.map((value) => Math.round(value * alpha + 255 * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
      assert.ok(contrast(tokens[`${name}-text`], overWhite) >= 4.5, `${name} text over a white poster: ${contrast(tokens[`${name}-text`], overWhite).toFixed(2)}`);
    }
    // The tab bar's glass is the surface colour, so the opaque fallback (no backdrop blur) gives the same pairs.
    const material = /--material:\s*rgb\((\d+) (\d+) (\d+) \/ [0-9.]+\)/.exec(css);
    assert.equal(`#${material.slice(1, 4).map((value) => Number(value).toString(16).padStart(2, '0')).join('')}`, tokens.surface);
    assert.match(css, /@supports not \(\(-webkit-backdrop-filter: blur\(1px\)\) or \(backdrop-filter: blur\(1px\)\)\)[^@]*\.tabbar[^@]*background: var\(--surface\)/);
    // The page's colours are the installed app's: the status bar and the splash.
    const manifest = JSON.parse(read(BUILT('manifest.webmanifest')));
    assert.equal(manifest.background_color, tokens.bg);
    assert.equal(manifest.theme_color, tokens.bg);
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.match(css, /env\(safe-area-inset-bottom\)/);
    assert.match(css, /:focus-visible/);
  });

  it('draws the tab bar as a floating glass pill of 44px targets, with the blur prefixed and a safe-area gap', () => {
    const css = read(BUILT('app.css'));
    const tabbar = /\.tabbar \{([^}]*)\}/.exec(css)[1];
    assert.match(tabbar, /position: fixed/);
    assert.match(tabbar, /bottom: calc\(var\(--tabbar-gap\) \+ env\(safe-area-inset-bottom\)\)/);
    assert.match(tabbar, /border-radius: var\(--radius-pill\)/);
    assert.match(css, /--blur: saturate\(180%\) blur\(20px\)/);
    assert.match(css, /-webkit-backdrop-filter: var\(--blur\); backdrop-filter: var\(--blur\)/);
    // Each tab is at least 44px (2.75rem) tall: 3rem here.
    const tab = /\.tabbar a \{([^}]*)\}/.exec(css)[1];
    assert.ok(Number(/min-height: ([0-9.]+)rem/.exec(tab)[1]) >= 2.75);
    assert.match(css, /\.tabbar a\[aria-current='page'\] \{ color: var\(--accent\); \}/);
    assert.match(css, /\.tabbar a\[aria-current='page'\]::after \{[^}]*border-radius: 50%/, 'the active dot');
    // Status pills sit on the poster's corner; search is three columns, two on a very narrow screen.
    assert.match(css, /\.card > \.badge \{[^}]*position: absolute; top: [0-9.]+rem; right: [0-9.]+rem/);
    assert.match(css, /\.grid, \.skeleton-grid \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
    assert.match(css, /@media \(max-width: 21rem\) \{\s*\.grid, \.skeleton-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(css, /--radius-poster: 10px;[\s\S]*--radius-card: 14px;[\s\S]*--radius-sheet: 20px;[\s\S]*--radius-pill: 999px;/);
    assert.match(css, /--font: -apple-system, /);
  });
});

describe('household app page: service worker', () => {
  const SOURCE = read('sw.js');
  const ORIGIN = 'https://jelly-farmhouse.example.test';

  /** Runs sw.js against fake service-worker globals, returning its listeners and everything it cached or fetched. */
  function runWorker({ network = async () => new Response('fresh', { status: 200 }), failAdd = false, stores = new Map(), source = SOURCE } = {}) {
    const listeners = {};
    const log = { puts: [], added: [], deleted: [], fetched: [] };
    const cacheNamed = (name) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        addAll: async (requests) => {
          if (failAdd) throw new TypeError('network error while precaching');
          for (const request of requests) {
            const key = new URL(request.url ?? request, ORIGIN).pathname;
            log.added.push(key);
            store.set(key, new Response('precached'));
          }
        },
        put: async (key, response) => {
          const pathname = new URL(key.url ?? key, ORIGIN).pathname;
          log.puts.push(pathname);
          store.set(pathname, response);
        },
        match: async (key) => {
          const hit = store.get(new URL(key.url ?? key, ORIGIN).pathname);
          return hit ? hit.clone() : undefined;
        },
      };
    };
    const context = {
      self: {
        location: new URL(`${ORIGIN}/jellypass/app/sw.js`),
        addEventListener: (type, listener) => { listeners[type] = listener; },
        skipWaiting: async () => undefined,
        clients: { claim: async () => undefined },
      },
      caches: {
        open: async (name) => cacheNamed(name),
        keys: async () => [...stores.keys()],
        delete: async (name) => { log.deleted.push(name); return stores.delete(name); },
      },
      fetch: async (request) => {
        log.fetched.push(new URL(request.url).pathname);
        const response = await network(request);
        // Answers to same-origin requests are "basic" in a browser; Node's Response constructor says "default".
        return Object.defineProperty(response, 'type', { value: 'basic' });
      },
      // A browser resolves a relative address against the worker's own; Node's Request does not.
      Request: class extends Request { constructor(input, init) { super(new URL(input.url ?? input, ORIGIN), init); } },
      Response, URL, Promise, crypto: globalThis.crypto,
    };
    vm.runInNewContext(source, context);
    return { listeners, stores, log };
  }

  /** Fires a fetch event; returns whether the worker took the request over, and its answer. */
  async function fetchEvent(worker, url, { method = 'GET' } = {}) {
    let answer;
    let handled = false;
    const waits = [];
    worker.listeners.fetch({
      request: new Request(url, { method }),
      respondWith: (promise) => { handled = true; answer = promise; },
      waitUntil: (promise) => waits.push(promise),
    });
    const response = handled ? await answer : undefined;
    await Promise.all(waits);
    return { handled, response };
  }

  it('precaches exactly the app\'s own files, all of which are served', async (t) => {
    const app = await startApp(t);
    const worker = runWorker();
    const waits = [];
    worker.listeners.install({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    const precached = new Set(worker.log.added);
    // Every file but the worker itself, with the page at its address (index.html is the same file).
    const served = new Set(FILES.filter((file) => file !== 'sw.js' && file !== 'index.html').map((file) => `${PAGE}${file}`));
    served.add(PAGE);
    assert.deepEqual([...precached].sort(), [...served].sort());
    for (const cached of precached) assert.equal((await app.get(cached, { user: null })).status, 200, cached);
    assert.equal([...precached].some((key) => key.startsWith('/jellypass/app/v1')), false);
  });

  it('never touches the API, other origins, other paths or non-GET requests', async () => {
    const worker = runWorker();
    for (const url of [
      `${ORIGIN}/jellypass/app/v1/me`,
      `${ORIGIN}/jellypass/app/v1/discover/trending?page=1`,
      `${ORIGIN}/jellypass/app/v1/search?q=a`,
      `${ORIGIN}/jellypass/app/v1/movie/${T_MOVIE}`,
      `${ORIGIN}/jellypass/app/v1/tv/${T_TV}/season/1`,
      `${ORIGIN}/jellypass/app/v1/`,
      `${ORIGIN}/web/`,
      `${ORIGIN}/Videos/abc/stream`,
      `${ORIGIN}/jellypass/add`,
      // The sign-in calls: they carry passwords and tokens and must always reach the network, never this worker.
      `${ORIGIN}/Users/Public`,
      `${ORIGIN}/Users/AuthenticateByName`,
      `${ORIGIN}/Users/Me`,
      `${ORIGIN}/Sessions/Logout`,
      `${ORIGIN}/QuickConnect/Enabled`,
      `${ORIGIN}/jellypass/app/unknown.js`,
      'https://image.tmdb.org/t/p/w342/synthetic.jpg',
      'https://example.test/jellypass/app/app.css',
    ]) {
      const { handled } = await fetchEvent(worker, url);
      assert.equal(handled, false, url);
    }
    assert.equal((await fetchEvent(worker, `${ORIGIN}${PAGE}${BUILT('app.css')}`, { method: 'POST' })).handled, false);
    for (const url of ['/Users/AuthenticateByName', '/Sessions/Logout']) {
      assert.equal((await fetchEvent(worker, `${ORIGIN}${url}`, { method: 'POST' })).handled, false, `POST ${url}`);
    }
    assert.deepEqual(worker.log.fetched, [], 'the worker fetched something it was not asked to handle');
    assert.deepEqual(worker.log.puts, []);
    assert.deepEqual(worker.log.added, []);
  });

  it('keeps nothing as it goes: only the release\'s precached set is ever stored, and never the API', async () => {
    const worker = runWorker();
    const waits = [];
    worker.listeners.install({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    const stored = () => [...worker.stores.values()].flatMap((store) => [...store.keys()]).sort();
    const before = stored();
    for (const url of [
      `${ORIGIN}/jellypass/app/v1/me`, `${ORIGIN}${PAGE}`, `${ORIGIN}${PAGE}${BUILT('js/main.js')}`, `${ORIGIN}/jellypass/app/v1/discover/trending`,
      `${ORIGIN}${PAGE}${BUILT('app.css')}?x=1`, `${ORIGIN}/jellypass/app/V1/me`,
    ]) {
      await fetchEvent(worker, url);
    }
    assert.deepEqual(worker.log.puts, [], 'nothing is added after install');
    assert.deepEqual(stored(), before);
    for (const key of stored()) assert.doesNotMatch(key, /\/v1(?:\/|$)/i);
  });

  it('answers only an exact allowlist of static files, however an API address is spelled', async () => {
    // Guard against a future "handle everything" change: nothing but the precached paths may be answered by the worker.
    const worker = runWorker();
    for (const url of [
      `${ORIGIN}/jellypass/app/v1/me`, `${ORIGIN}/jellypass/app/v1/me?x=1`, `${ORIGIN}/jellypass/app/v1/`, `${ORIGIN}/jellypass/app/v1`,
      `${ORIGIN}/jellypass/app/V1/me`, `${ORIGIN}/jellypass/app/%76%31/me`, `${ORIGIN}/jellypass/app//v1/me`,
      `${ORIGIN}/jellypass/app/./v1/me`, `${ORIGIN}/jellypass/app/js/../v1/me`, `${ORIGIN}/jellypass/app/js/main.js/`,
      `${ORIGIN}/jellypass/app/js/main.jsx`, `${ORIGIN}/jellypass/app/sw.js`, `${ORIGIN}/jellypass/app/js/`,
    ]) {
      assert.equal((await fetchEvent(worker, url)).handled, false, url);
    }
    // And the allowlist is the precached set, nothing wider.
    const waits = [];
    worker.listeners.install({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    for (const key of worker.log.added) {
      assert.equal((await fetchEvent(worker, `${ORIGIN}${key}`)).handled, true, key);
    }
  });

  it('serves a static file from the network, falling back to the release\'s own copy only when the network fails', async () => {
    let online = true;
    let status = 200;
    const worker = runWorker({ network: async () => {
      if (!online) throw new TypeError('offline');
      return new Response(`network ${status}`, { status });
    } });
    const waits = [];
    worker.listeners.install({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    const url = `${ORIGIN}${PAGE}${BUILT('app.css')}`;
    assert.equal(await (await fetchEvent(worker, url)).response.text(), 'network 200');
    // A newer answer on the network is not mixed into the stored release: offline is always the installed set.
    online = false;
    assert.equal(await (await fetchEvent(worker, url)).response.text(), 'precached');
    online = true;
    status = 500;
    assert.equal((await fetchEvent(worker, url)).response.status, 500);
    online = false;
    assert.equal(await (await fetchEvent(worker, url)).response.text(), 'precached');
    // Nothing installed, nothing to fall back on, no network: an ordinary network error.
    const empty = runWorker({ network: async () => { throw new TypeError('offline'); } });
    assert.equal((await fetchEvent(empty, url)).response.type, 'error');
  });

  it('names its cache for a hash of the built files, and a changed file is a new cache', async () => {
    const hash = contentHash(DIST_APP);
    assert.match(hash, /^[0-9a-f]{16}$/);
    assert.doesNotMatch(SOURCE, /__CONTENT_HASH__/, 'the build fills in the hash');
    assert.ok(SOURCE.includes(`\${CACHE_PREFIX}${hash}`), 'the cache is named for the hash');
    const worker = runWorker();
    const waits = [];
    worker.listeners.install({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    assert.equal(worker.stores.size, 1);
    assert.match([...worker.stores.keys()][0], new RegExp(`^jellypass-app-static-${hash}-[0-9a-f-]{36}$`));

    const copy = mkdtempSync(path.join(os.tmpdir(), 'jellypass-hash-'));
    try {
      cpSync(DIST_APP, copy, { recursive: true });
      assert.equal(contentHash(copy), hash, 'the same files give the same hash');
      writeFileSync(path.join(copy, 'sw.js'), 'changed worker text');
      assert.equal(contentHash(copy), hash, 'the stamped worker\'s own text (which carries the hash) is not part of it');
      const template = readFileSync(path.join(import.meta.dirname, '..', 'app', 'static', 'sw.js'), 'utf8');
      assert.equal(contentHash(copy, template), hash, 'the unstamped worker is what the build hashes');
      assert.notEqual(contentHash(copy, `${template}\n// worker-only change\n`), hash, 'a worker-only change is a new cache name');
      for (const file of [BUILT('app.css'), BUILT('js/main.js'), 'index.html', BUILT('icons/icon-192.png')]) {
        const target = path.join(copy, file);
        const original = readFileSync(target);
        writeFileSync(target, Buffer.concat([original, Buffer.from('\n')]));
        assert.notEqual(contentHash(copy), hash, `${file} changes the hash`);
        writeFileSync(target, original);
      }
      writeFileSync(path.join(copy, 'extra.js'), '');
      assert.notEqual(contentHash(copy), hash, 'a new file changes the hash');
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it('installs a release whole or not at all, and leaves other releases\' caches alone when it cannot', async () => {
    const worker = runWorker({ failAdd: true });
    worker.stores.set('jellypass-app-static-previous', new Map([[`${PAGE}${BUILT('app.css')}`, new Response('old release')]]));
    const waits = [];
    worker.listeners.install({ waitUntil: (promise) => waits.push(promise) });
    await assert.rejects(Promise.all(waits), /network error while precaching/);
    assert.deepEqual([...worker.stores.keys()], ['jellypass-app-static-previous'], 'no partial cache is left behind');
    assert.equal(worker.log.deleted.length, 1);
  });

  it('a concurrent install of the same release that fails leaves the active install\'s cache and offline fallback intact', async () => {
    // Two installers (two registrations) share one CacheStorage; both start before either has cached anything.
    const stores = new Map();
    const a = runWorker({ stores });
    const b = runWorker({ stores, failAdd: true, network: async () => { throw new TypeError('offline'); } });
    const waitsA = [];
    const waitsB = [];
    a.listeners.install({ waitUntil: (promise) => waitsA.push(promise) });
    b.listeners.install({ waitUntil: (promise) => waitsB.push(promise) });
    await Promise.all(waitsA);
    a.listeners.activate({ waitUntil: (promise) => waitsA.push(promise) });
    await Promise.all(waitsA);
    const [name] = stores.keys();
    await assert.rejects(Promise.all(waitsB), /network error while precaching/);
    assert.deepEqual([...stores.keys()], [name], 'only the failed install\'s own cache was deleted');
    assert.deepEqual(a.log.deleted, []);
    const offline = runWorker({ stores, network: async () => { throw new TypeError('offline'); } });
    assert.equal(await (await fetchEvent(offline, `${ORIGIN}${PAGE}${BUILT('app.css')}`)).response.text(), 'precached', 'offline fallback still works');
  });

  it('keeps every install\'s cache separate, and a restarted worker still finds its release\'s copy', async () => {
    const stores = new Map();
    for (const _ of [1, 2]) {
      const worker = runWorker({ stores });
      const waits = [];
      worker.listeners.install({ waitUntil: (promise) => waits.push(promise) });
      await Promise.all(waits);
    }
    assert.equal(stores.size, 2, 'distinct names per install');
    const restarted = runWorker({ stores, network: async () => { throw new TypeError('offline'); } });
    assert.equal(await (await fetchEvent(restarted, `${ORIGIN}${PAGE}${BUILT('js/main.js')}`)).response.text(), 'precached');
  });

  it('stamps the worker with the hash of the files it precaches, and refuses a worker with nothing to stamp', () => {
    const copy = mkdtempSync(path.join(os.tmpdir(), 'jellypass-stamp-'));
    try {
      cpSync(path.join(import.meta.dirname, '..', 'app', 'static'), copy, { recursive: true });
      const template = readFileSync(path.join(copy, 'sw.js'), 'utf8');
      const expected = contentHash(copy, template);
      stampWorker(copy);
      const stamped = readFileSync(path.join(copy, 'sw.js'), 'utf8');
      assert.doesNotMatch(stamped, /__CONTENT_HASH__/);
      assert.ok(stamped.includes(`\${CACHE_PREFIX}${expected}`));
      assert.equal(contentHash(copy, template), expected, 'stamping changes nothing the hash covers');
      assert.throws(() => stampWorker(copy), /no __CONTENT_HASH__/);
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it('removes older releases\' caches (and only those) once the new one is active', async () => {
    const worker = runWorker();
    const waits = [];
    worker.listeners.install({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    const current = [...worker.stores.keys()][0];
    const sibling = `${current}-sibling`.replace(/-[0-9a-f-]{36}-sibling$/, '-00000000-0000-0000-0000-000000000000');
    worker.stores.set(sibling, new Map());
    worker.stores.set('jellypass-app-static-v1', new Map());
    worker.stores.set('jellypass-app-static-0123456789abcdef', new Map());
    worker.stores.set('someone-elses-cache', new Map());
    worker.listeners.activate({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    assert.deepEqual([...worker.stores.keys()].sort(), [current, sibling, 'someone-elses-cache'].sort());
    assert.deepEqual(worker.log.deleted.sort(), ['jellypass-app-static-0123456789abcdef', 'jellypass-app-static-v1']);
  });

  it('is registered by the page at the one canonical absolute URL and scope', () => {
    const main = read(BUILT('js/main.js'));
    assert.match(main, /serviceWorker\.register\('\/jellypass\/app\/sw\.js', \{ scope: '\/jellypass\/app\/', updateViaCache: 'none' \}\)/);
  });
});

describe('household app page: rendering', () => {
  const origin = 'https://jelly-farmhouse.example.test';
  const itemId = '33330000333300003333000033330000';
  const poster = 'https://image.tmdb.org/t/p/w342/synthetic-poster.jpg';
  const card = (overrides = {}) => ({
    mediaType: 'movie', tmdbId: 900003, title: 'Synthetic Movie Three', year: 2021, overview: 'Synthetic overview.',
    posterUrl: poster, backdropUrl: 'https://image.tmdb.org/t/p/w780/synthetic-backdrop.jpg', rating: 7.46, state: 'get_this', play: null,
    ...overrides,
  });
  const play = { itemId, url: `${origin}/web/#/details?id=${itemId}` };

  async function renderer() {
    const { document, Event } = parseHTML('<!doctype html><html><body></body></html>');
    const module = await import(pathToFileURL(path.join(DIST_APP, BUILT('js/render.js'))).href);
    return { document, Event, ...module };
  }

  it('shows each household state as its own coarse badge on the card, and no Play button on any card', async () => {
    const { document, cardItem, STATE_LABELS } = await renderer();
    assert.deepEqual(STATE_LABELS, {
      in_library: 'Ready to watch',
      get_this: 'Available to get',
      unavailable: "Can't request",
      requested: 'Requested',
    });
    // Play stays on the title's own page; a card is one link to it, whatever the DTO carries.
    const cases = [
      ['in_library', play],
      ['get_this', null],
      ['unavailable', null],
      ['requested', null],
      ['get_this', play],
      ['unavailable', play],
    ];
    for (const [state, link] of cases) {
      const item = cardItem(document, card({ state, play: link }));
      const badges = item.querySelectorAll('.badge');
      assert.equal(badges.length, 1, state);
      assert.equal(badges[0].textContent, STATE_LABELS[state]);
      assert.ok(badges[0].classList.contains(`badge-${state}`));
      assert.equal(item.querySelectorAll('a').length, 1, `${state}: only the link to the title`);
      assert.equal([...item.querySelectorAll('a, button')].filter((node) => node.textContent === 'Play').length, 0, `${state} play`);
      assert.equal(item.querySelector('.card-link').getAttribute('href'), '#/movie/900003');
      assert.equal(item.querySelector('.card-meta').textContent, '2021 · Movie');
    }
    assert.doesNotMatch(STATE_LABELS.get_this, /other|household|someone|requested by/i);
  });

  it('never links anywhere but the household host\'s own Jellyfin item, and shows only TMDB images', async () => {
    const { document, cardItem, safePlayUrl, safeImageUrl } = await renderer();
    for (const bad of [
      { itemId, url: `https://evil.example.test/web/#/details?id=${itemId}` },
      { itemId, url: `${origin}/web/#/details?id=other` },
      { itemId, url: `javascript:alert(1)` },
      { itemId: '../x', url: `${origin}/web/#/details?id=../x` },
      { itemId: itemId, url: `http://jelly-farmhouse.example.test/web/#/details?id=${itemId}` },
      { itemId: 7, url: 'x' },
    ]) {
      assert.equal(safePlayUrl(bad, origin), undefined, JSON.stringify(bad));
      assert.equal(cardItem(document, card({ state: 'in_library', play: bad })).querySelectorAll('a').length, 1);
    }
    assert.equal(safePlayUrl(play, origin), play.url);
    for (const bad of ['https://evil.example.test/p.jpg', 'http://image.tmdb.org/t/p/w342/a.jpg', 'https://image.tmdb.org/t/p/original/a.jpg',
      'https://image.tmdb.org/t/p/w342/a.jpg?x=1', 'https://image.tmdb.org.evil.test/t/p/w342/a.jpg', 'data:image/png;base64,AAAA', 'javascript:1', '', null, 7]) {
      assert.equal(safeImageUrl(bad), undefined, String(bad));
    }
    assert.equal(safeImageUrl(poster), poster);
    const item = cardItem(document, card({ posterUrl: 'https://evil.example.test/p.jpg' }), origin);
    assert.equal(item.querySelectorAll('img').length, 0);
    assert.ok(item.querySelector('.poster-empty'), 'the frame keeps its shape');
  });

  it('sets its text as text: markup in a title or overview is never parsed', async () => {
    const { document, cardItem, titleDetail } = await renderer();
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const item = cardItem(document, card({ title: hostile }), origin);
    assert.equal(item.querySelector('.card-title').textContent, hostile);
    assert.equal(item.querySelectorAll('script, [onerror]').length, 0);
    const detail = titleDetail(document, { ...card({ overview: hostile }), genres: [hostile], runtime: 95, seasons: [] }, origin);
    assert.equal(detail.querySelector('.overview').textContent, hostile);
    assert.equal(detail.querySelectorAll('script, [onerror]').length, 0);
    // Posters on a card are decorative beside the title; the detail poster has real alternative text.
    assert.equal(item.querySelector('img').getAttribute('alt'), '');
    assert.equal(detail.querySelector('.poster img').getAttribute('alt'), 'Poster for Synthetic Movie Three');
  });

  it('keeps posters from shifting the page: size attributes, lazy loading and an aspect-ratio frame', async () => {
    const { document, cardItem } = await renderer();
    const image = cardItem(document, card(), origin).querySelector('img');
    assert.equal(image.getAttribute('loading'), 'lazy');
    assert.equal(image.getAttribute('decoding'), 'async');
    assert.equal(image.getAttribute('width'), '342');
    assert.equal(image.getAttribute('height'), '513');
    assert.match(read(BUILT('app.css')), /\.poster \{[^}]*aspect-ratio: 2 \/ 3/);
    assert.match(read(BUILT('app.css')), /\.backdrop \{[^}]*aspect-ratio: 780 \/ 439/);
  });

  it('renders a movie page, a series page with its seasons and states, and a season with its episodes', async () => {
    const { document, titleDetail, seasonView } = await renderer();
    const movie = titleDetail(document, { ...card({ state: 'in_library', play }), genres: ['Drama', 'Mystery'], runtime: 118, seasons: undefined }, origin);
    assert.equal(movie.querySelector('h1').textContent, 'Synthetic Movie Three');
    assert.equal(movie.querySelector('.meta').textContent, '2021 · 1 h 58 min · ★ 7.5');
    assert.deepEqual([...movie.querySelectorAll('.genres li')].map((li) => li.textContent), ['Drama', 'Mystery']);
    assert.equal(movie.querySelector('.badge').textContent, 'Ready to watch');
    assert.equal(movie.querySelector('a.button').getAttribute('href'), play.url);
    assert.ok(movie.querySelector('.seasons') === null);

    const series = titleDetail(document, {
      ...card({ mediaType: 'tv', tmdbId: 900002, title: 'Synthetic Series Two', state: 'get_this' }), genres: [], runtime: 45,
      seasons: [
        { seasonNumber: 1, name: 'Season 1', episodeCount: 8, state: 'in_library' },
        { seasonNumber: 2, name: 'Season 2', episodeCount: 1, state: 'get_this' },
        { seasonNumber: 3, name: '', episodeCount: null, state: 'unavailable' },
      ],
    }, origin);
    assert.ok(series.querySelector('a.button') === null, 'no Play without the title in the library');
    assert.ok(series.querySelector('button') === null, 'and no request button unless the screen can ask');
    const seasons = [...series.querySelectorAll('.season')];
    assert.deepEqual(seasons.map((season) => season.querySelector('.badge').textContent), ['Ready to watch', 'Available to get', "Can't request"]);
    assert.deepEqual(seasons.map((season) => season.querySelector('a').getAttribute('href')),
      ['#/tv/900002/season/1', '#/tv/900002/season/2', '#/tv/900002/season/3']);
    assert.deepEqual(seasons.map((season) => season.querySelector('.card-meta').textContent), ['8 episodes', '1 episode', '']);
    assert.equal(seasons[2].querySelector('.season-name').textContent, 'Season 3');
    assert.ok(series.querySelector('.detail-text .muted') === null, 'no "soon" note any more');

    const season = seasonView(document, {
      tmdbId: 900002, seasonNumber: 1, name: 'Season 1', overview: 'Season text.', state: 'in_library',
      episodes: [{ episodeNumber: 1, name: 'Pilot', overview: 'First.' }, { episodeNumber: 2, name: '', overview: '' }],
    }, 'Synthetic Series Two');
    assert.equal(season.querySelector('a.back').getAttribute('href'), '#/tv/900002');
    assert.equal(season.querySelector('h1').textContent, 'Season 1');
    assert.equal(season.querySelector('.badge').textContent, 'Ready to watch');
    assert.deepEqual([...season.querySelectorAll('.episode-title')].map((title) => title.textContent), ['1. Pilot', '2. Episode 2']);
    assert.ok(season.querySelector('a.button') === null);
  });

  it('shows only fixed text for each error, with a sign-in link for 401 and no upstream text', async () => {
    const { document, Event, errorState, ERROR_TEXT } = await renderer();
    assert.deepEqual(Object.keys(ERROR_TEXT).sort(), ['not_found', 'offline', 'rate_limited', 'unauthorized', 'unavailable']);
    for (const [kind, text] of Object.entries(ERROR_TEXT)) {
      let retried = 0;
      const box = errorState(document, kind, () => { retried += 1; });
      assert.equal(box.getAttribute('role'), 'alert');
      assert.equal(box.querySelector('h1').textContent, text.title);
      assert.equal(box.querySelector('p').textContent, text.body);
      const retry = box.querySelector('button');
      if (kind === 'unauthorized') {
        assert.equal(retry, null);
        assert.equal(box.querySelector('a').getAttribute('href'), '/web/');
      } else if (kind === 'not_found') {
        assert.equal(retry, null);
      } else {
        retry.dispatchEvent(new Event('click'));
        assert.equal(retried, 1, kind);
      }
    }
    // An unknown kind (never sent by the API) falls back to the generic text.
    assert.equal(errorState(document, 'canary-upstream-text').querySelector('h1').textContent, ERROR_TEXT.unavailable.title);
    assert.equal(ERROR_TEXT.rate_limited.title, 'Too many requests');
    assert.equal(ERROR_TEXT.unavailable.body, 'Something went wrong. Try again in a moment.');
  });

  describe('"Get this" and "My requests" markup', () => {
    const series = (overrides = {}) => ({
      ...card({ mediaType: 'tv', tmdbId: 900002, title: 'Synthetic Series Two', state: 'get_this' }), genres: [], runtime: 45,
      seasons: [
        { seasonNumber: 0, name: 'Specials', episodeCount: 2, state: 'get_this' },
        { seasonNumber: 1, name: 'Season 1', episodeCount: 8, state: 'in_library' },
        { seasonNumber: 2, name: 'Season 2', episodeCount: 6, state: 'get_this' },
        { seasonNumber: 3, name: '', episodeCount: null, state: 'get_this' },
        { seasonNumber: 4, name: 'Season 4', episodeCount: 1, state: 'requested' },
        { seasonNumber: 5, name: 'Season 5', episodeCount: 1, state: 'unavailable' },
      ],
      ...overrides,
    });
    const click = (document, Event, node) => node.dispatchEvent(new Event('click'));

    it('offers a button for a requestable movie only when the screen can ask, and none for any other state', async () => {
      const { document, Event, titleDetail, GET_THIS_TEXT } = await renderer();
      const movie = (state, extras) => titleDetail(document, { ...card({ state, play: state === 'in_library' ? play : null }), genres: [], runtime: 90 }, origin, extras);
      const calls = [];
      const onGet = async (seasons) => { calls.push(seasons); return 'accepted'; };
      const detail = movie('get_this', { onGet });
      const button = detail.querySelector('button');
      assert.equal(button.textContent, 'Get this');
      assert.equal(button.getAttribute('aria-label'), 'Get this: Synthetic Movie Three');
      assert.equal(button.getAttribute('type'), 'button');
      assert.ok(detail.querySelector('.get-seasons') === null);
      assert.equal(detail.querySelector('.get-message').getAttribute('role'), 'status');
      assert.equal(detail.querySelector('.get-message').textContent, '');
      click(document, Event, button);
      assert.deepEqual(calls, [[]], 'a movie asks for no seasons');
      for (const state of ['in_library', 'requested', 'unavailable']) assert.ok(movie(state, { onGet }).querySelector('button') === null, state);
      assert.ok(movie('get_this', {}).querySelector('button') === null, 'a screen that cannot ask shows none');
      assert.ok(movie('get_this', {}).querySelector('.get-this') === null);
      assert.equal(GET_THIS_TEXT.button, 'Get this');
    });

    it('disables the button while a call is in flight and shows each failure in its own fixed words', async () => {
      const { document, Event, titleDetail, GET_THIS_TEXT } = await renderer();
      const expected = {
        rate_limited: 'Too many tries, try again in a few minutes.',
        offline: "You're offline. Check your connection, then try again.",
        unavailable: "We couldn't send that just now. Try again in a moment.",
        not_found: "We couldn't send that just now. Try again in a moment.",
      };
      for (const [kind, text] of Object.entries(expected)) {
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const detail = titleDetail(document, { ...card(), genres: [], runtime: 90 }, origin, { onGet: async () => { await gate; return kind; } });
        const button = detail.querySelector('button');
        click(document, Event, button);
        assert.equal(button.disabled, true, `${kind}: in flight`);
        assert.equal(button.textContent, GET_THIS_TEXT.sending);
        assert.equal(button.getAttribute('aria-busy'), 'true');
        click(document, Event, button);
        release();
        await new Promise((resolve) => setTimeout(resolve, 0));
        assert.equal(button.disabled, false, `${kind}: can try again`);
        assert.equal(button.textContent, 'Get this');
        assert.equal(button.getAttribute('aria-busy'), null);
        assert.equal(detail.querySelector('.get-message').textContent, text, kind);
        assert.ok(detail.querySelector('.get-message').classList.contains('get-error'));
      }
      // 401 is not shown here: main replaces the screen with the sign-in state.
      const detail = titleDetail(document, { ...card(), genres: [], runtime: 90 }, origin, { onGet: async () => 'unauthorized' });
      click(document, Event, detail.querySelector('button'));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(detail.querySelector('.get-message').textContent, '');
    });

    it('shows one fixed confirmation, whatever the screen was redrawn for', async () => {
      const { document, titleDetail, seasonView, GET_THIS_TEXT } = await renderer();
      assert.equal(GET_THIS_TEXT.confirmation, "Thanks — we'll get this for your household.");
      const onGet = async () => 'accepted';
      const confirmations = [
        titleDetail(document, { ...card({ state: 'get_this' }), genres: [], runtime: 90 }, origin, { onGet, confirmed: true, asked: new Set() }),
        titleDetail(document, { ...card({ state: 'requested' }), genres: [], runtime: 90 }, origin, { onGet, confirmed: true, asked: new Set([0]) }),
        titleDetail(document, { ...card({ state: 'in_library', play }), genres: [], runtime: 90 }, origin, { onGet, confirmed: true, asked: new Set([0]) }),
        titleDetail(document, series(), origin, { onGet, confirmed: true, asked: new Set([2, 3]) }),
        seasonView(document, { tmdbId: 900002, seasonNumber: 2, name: 'Season 2', overview: '', episodes: [], state: 'requested' }, 'Synthetic Series Two', { onGet, confirmed: true, asked: new Set([2]) }),
      ].map((screen) => screen.querySelector('.get-message').textContent);
      assert.deepEqual(new Set(confirmations), new Set([GET_THIS_TEXT.confirmation]));
      // Without a redraw for an ask, no confirmation is there.
      assert.equal(titleDetail(document, { ...card(), genres: [], runtime: 90 }, origin, { onGet }).querySelector('.get-message').textContent, '');
      // A requested or held title keeps its coarse state and no hint of what an ask did.
      const words = Object.values(GET_THIS_TEXT).join(' ');
      assert.doesNotMatch(words, /already|joined|held|someone|other household|duplicate|existing|in your library|pending|approved|declined/i);
    });

    it('lets a series pick among the seasons the API marks requestable, never a special or a season it does not', async () => {
      const { document, Event, titleDetail } = await renderer();
      const asked = [];
      const detail = titleDetail(document, series(), origin, { onGet: async (seasons) => { asked.push(seasons); return 'accepted'; } });
      const fieldset = detail.querySelector('fieldset.get-seasons');
      assert.equal(fieldset.querySelector('legend').textContent, 'Choose the seasons you want');
      const labels = [...fieldset.querySelectorAll('label.choice')];
      assert.deepEqual(labels.map((label) => label.textContent), ['Season 2', 'Season 3'], 'only season 2 and 3, named; not the special, held, requested or unavailable ones');
      const boxes = [...fieldset.querySelectorAll('input[type="checkbox"]')];
      assert.deepEqual(boxes.map((box) => box.value), ['2', '3']);
      const button = detail.querySelector('button');
      assert.equal(button.disabled, true, 'nothing chosen, nothing to send');
      boxes[1].checked = true;
      boxes[1].dispatchEvent(new Event('change'));
      assert.equal(button.disabled, false);
      boxes[0].checked = true;
      boxes[0].dispatchEvent(new Event('change'));
      click(document, Event, button);
      assert.deepEqual(asked, [[2, 3]]);
      assert.equal(boxes.every((box) => box.disabled), true, 'locked while in flight');
      await new Promise((resolve) => setTimeout(resolve, 0));
      // The series' own state is `get_this` here, and a series `requested` for one season still lets the rest be chosen.
      const partly = titleDetail(document, series({ state: 'requested' }), origin, { onGet: async () => 'accepted' });
      assert.equal(partly.querySelectorAll('input[type="checkbox"]').length, 2);
      assert.equal(partly.querySelectorAll('.season .badge')[0].textContent, 'Available to get');
      // No requestable season, no picker; seasons just asked for are not offered again.
      const none = titleDetail(document, series({ state: 'unavailable', seasons: [{ seasonNumber: 1, name: 'Season 1', episodeCount: 1, state: 'unavailable' }] }), origin, { onGet: async () => 'accepted' });
      assert.ok(none.querySelector('.get-this') === null);
      const again = titleDetail(document, series(), origin, { onGet: async () => 'accepted', asked: new Set([2]) });
      assert.deepEqual([...again.querySelectorAll('input[type="checkbox"]')].map((box) => box.value), ['3']);
    });

    it('asks for one season from its own page, and only when that season is requestable', async () => {
      const { document, Event, seasonView } = await renderer();
      const asked = [];
      const view = (state, extras = {}) => seasonView(document, { tmdbId: 900002, seasonNumber: 2, name: 'Season 2', overview: '', episodes: [], state }, 'Synthetic Series Two',
        { onGet: async (seasons) => { asked.push(seasons); return 'accepted'; }, ...extras });
      const screen = view('get_this');
      const button = screen.querySelector('button');
      assert.equal(button.getAttribute('aria-label'), 'Get this: Synthetic Series Two Season 2');
      assert.ok(screen.querySelector('fieldset') === null, 'one season needs no picker');
      assert.equal(button.disabled, false);
      click(document, Event, button);
      assert.deepEqual(asked, [[2]]);
      for (const state of ['in_library', 'requested', 'unavailable']) assert.ok(view(state).querySelector('button') === null, state);
      assert.ok(view('get_this', { onGet: undefined }).querySelector('button') === null);
    });

    it('shows "We couldn\'t get this" where the household asked and it did not work out, and the other coarse states as the API gives them', async () => {
      const { document, titleDetail, seasonView, requestBadge, REQUEST_LABELS, STATE_LABELS } = await renderer();
      assert.deepEqual(REQUEST_LABELS, { requested: 'Requested', ready: 'Ready to watch', failed: "We couldn't get this" });
      assert.equal(requestBadge(document, 'failed').textContent, "We couldn't get this");
      assert.equal(STATE_LABELS.in_library, 'Ready to watch');
      assert.equal(STATE_LABELS.unavailable, "Can't request");
      assert.equal(STATE_LABELS.requested, 'Requested');
      const onGet = async () => 'accepted';
      const movie = titleDetail(document, { ...card(), genres: [], runtime: 90 }, origin, { onGet, failed: new Set([0]) });
      assert.deepEqual([...movie.querySelectorAll('.badge')].map((badge) => badge.textContent), ["We couldn't get this"]);
      assert.ok(movie.querySelector('button') === null, 'and it is not offered again: the backend holds the failed record');
      assert.equal(movie.querySelector('.failed-note').textContent, 'Ask your JellyPass admin to try again.');
      const seasons = titleDetail(document, series(), origin, { onGet, failed: new Set([3]) });
      assert.deepEqual([...seasons.querySelectorAll('.season .badge')].map((badge) => badge.textContent),
        ['Available to get', 'Ready to watch', 'Available to get', "We couldn't get this", 'Requested', "Can't request"]);
      const season = seasonView(document, { tmdbId: 900002, seasonNumber: 3, name: 'Season 3', overview: '', episodes: [], state: 'get_this' }, 'S', { failed: new Set([3]) });
      assert.equal(season.querySelector('.badge').textContent, "We couldn't get this");
      assert.ok(season.querySelector('button') === null);
      assert.equal(season.querySelector('.failed-note').textContent, 'Ask your JellyPass admin to try again.');
      assert.deepEqual([...seasons.querySelectorAll('input[type="checkbox"]')].map((box) => box.value), ['2'], 'a failed season is not a choice');
      assert.equal(seasons.querySelectorAll('.failed-note').length, 1);
      // A held title is not "couldn't get" even if the household once failed to ask.
      const held = titleDetail(document, { ...card({ state: 'in_library', play }), genres: [], runtime: 90 }, origin, { onGet, failed: new Set([0]) });
      assert.deepEqual([...held.querySelectorAll('.badge')].map((badge) => badge.textContent), ['Ready to watch']);
      assert.equal(held.querySelector('a.button').textContent, 'Play');
    });

    it('lists a request with its coarse status, its seasons and who asked, and sets the title as text', async () => {
      const { document, requestItem, setRequestTitle, REQUESTS_TEXT } = await renderer();
      const entry = { id: 'opaqueidopaqueidopaqueid', mediaType: 'tv', tmdbId: 900002, status: 'requested', byYou: true,
        seasons: [{ seasonNumber: 1, status: 'ready' }, { seasonNumber: 2, status: 'requested' }, { seasonNumber: 3, status: 'failed' }] };
      const item = requestItem(document, entry);
      assert.equal(item.querySelector('.request-link').getAttribute('href'), '#/tv/900002');
      assert.equal(item.querySelector('.card-title').textContent, REQUESTS_TEXT.loading);
      assert.equal(item.querySelector(':scope > .badge').textContent, 'Requested');
      assert.equal(item.querySelector('.request-who').textContent, 'Asked for by you');
      assert.deepEqual([...item.querySelectorAll('.request-season')].map((season) => season.textContent),
        ['Season 1Ready to watch', 'Season 2Requested', "Season 3We couldn't get this"]);
      assert.equal(requestItem(document, { ...entry, byYou: false }).querySelector('.request-who').textContent, 'Asked for by someone in your household');
      const hostile = '<img src=x onerror=alert(1)>';
      setRequestTitle(item, { title: hostile, year: 2020, mediaType: 'tv' });
      assert.equal(item.querySelector('.card-title').textContent, hostile);
      assert.equal(item.querySelector('.card-meta').textContent, '2020 · Series');
      assert.equal(item.querySelectorAll('img, script, [onerror]').length, 0);
      setRequestTitle(item, undefined);
      assert.equal(item.querySelector('.card-title').textContent, 'Title unavailable');
      const movie = requestItem(document, { id: 'x', mediaType: 'movie', tmdbId: 5, status: 'failed', byYou: false, seasons: [] });
      assert.ok(movie.querySelector('.request-seasons') === null);
      assert.equal(movie.querySelector(':scope > .badge').textContent, "We couldn't get this");
      assert.equal(movie.querySelector('.card-meta').textContent, 'Movie');
      // An unknown status (never sent) is shown as the safe one rather than as raw text.
      assert.equal(requestItem(document, { ...entry, status: 'canary-status' }).querySelector(':scope > .badge').textContent, "We couldn't get this");
    });

    it('shows no Seerr ID, name, count, date or progress anywhere in the new markup', async () => {
      const { document, titleDetail, seasonView, requestItem, setRequestTitle } = await renderer();
      const traps = ['canary', 'seerr', 'opaqueidopaqueidopaqueid', '7300', 'jellyseerr'];
      const entry = { id: 'opaqueidopaqueidopaqueid', mediaType: 'tv', tmdbId: 900002, status: 'ready', byYou: false,
        seasons: [{ seasonNumber: 1, status: 'ready' }, { seasonNumber: 2, status: 'failed' }] };
      const item = requestItem(document, entry);
      setRequestTitle(item, { title: 'Synthetic Series Two', year: 2020, mediaType: 'tv' });
      const nodes = [
        item,
        titleDetail(document, series(), origin, { onGet: async () => 'rate_limited', confirmed: true, failed: new Set([2]) }),
        titleDetail(document, { ...card(), genres: [], runtime: 90 }, origin, { onGet: async () => 'accepted', confirmed: true }),
        seasonView(document, { tmdbId: 900002, seasonNumber: 2, name: 'Season 2', overview: '', episodes: [], state: 'get_this' }, 'Synthetic Series Two', { onGet: async () => 'accepted' }),
      ];
      for (const node of nodes) {
        const html = node.outerHTML;
        for (const trap of traps) assert.ok(!html.toLowerCase().includes(trap), `${trap} in ${html.slice(0, 100)}`);
        // No dates, percentages, progress or counts of requests.
        assert.doesNotMatch(node.textContent.replace(/\b(19|20)\d{2}\b/g, ''), /\d{4}-\d{2}|\d+\s*%|progress|\bETA\b|\d+ (?:requests?|people|members)/i);
      }
    });

    it('styles the new states within the stylesheet\'s existing, contrast-checked colours', () => {
      const css = read(BUILT('app.css'));
      for (const rule of ['.badge-request-ready', '.badge-request-failed', '.badge-request-requested', '.get-error', '.get-seasons', '.choice', '.request-list']) {
        assert.ok(css.includes(rule), rule);
      }
      assert.match(css, /\.choice \{[^}]*min-height: 2\.75rem/, '44 px touch target');
      // No new colour literals: the new rules use the checked tokens only.
      const added = css.slice(css.indexOf('.get-this {'), css.indexOf('.credits {'));
      assert.doesNotMatch(added, /#[0-9a-f]{3,6}\b/i);
    });
  });

  it('credits TMDB with its logo, the required notice and a link to themoviedb.org', async () => {
    const { document, aboutView, TMDB_NOTICE } = await renderer();
    const about = aboutView(document);
    assert.equal(TMDB_NOTICE, 'This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.');
    assert.ok([...about.querySelectorAll('p')].some((paragraph) => paragraph.textContent === TMDB_NOTICE));
    const logo = about.querySelector('img.tmdb-logo');
    assert.equal(logo.getAttribute('src'), BUILT('tmdb-logo.svg'), 'bundled, not hotlinked');
    assert.ok(logo.getAttribute('alt'));
    const links = [...about.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'));
    assert.deepEqual(links, ['https://www.themoviedb.org/', 'https://www.themoviedb.org/']);
    assert.ok(about.querySelectorAll('h1').length === 1);
    // The logo is less prominent than the app's own name (TMDB's terms): small, in the credits only.
    assert.match(read(BUILT('app.css')), /\.tmdb-logo \{ width: 9rem/);
  });

  it('puts the account and Sign out in grouped About cards, only while signed in, and keeps the TMDB credit', async () => {
    const { document, aboutView, accountText, TMDB_NOTICE } = await renderer();
    let signedOutBy = 0;
    const view = aboutView(document, { me: { name: 'Alice', household: 'Farmhouse' }, onSignOut: (button) => { if (button.id === 'signout') signedOutBy += 1; } });
    assert.deepEqual([...view.querySelectorAll('h2')].map((heading) => heading.textContent), ['Account', 'About', 'Credits']);
    assert.equal(view.querySelector('.account .account-name').textContent, 'Alice · Farmhouse');
    const signOut = view.querySelector('.account button#signout');
    assert.equal(signOut.textContent, 'Sign out');
    assert.equal(signOut.getAttribute('type'), 'button');
    signOut.dispatchEvent(new (document.defaultView.Event)('click'));
    assert.equal(signedOutBy, 1);
    assert.equal(view.querySelectorAll('.inset-card').length, 3);
    assert.ok([...view.querySelectorAll('p')].some((paragraph) => paragraph.textContent === TMDB_NOTICE), 'the notice is still there');
    assert.ok(view.querySelector('img.tmdb-logo'));
    assert.equal(accountText(undefined), 'Signed in', 'before /me answers');
    assert.equal(accountText({ name: 'Alice', household: '' }), 'Alice');
    // No account: no Account card and no Sign out; signed out, a way back to the sign-in on Home.
    const anonymous = aboutView(document);
    assert.deepEqual([...anonymous.querySelectorAll('h2')].map((heading) => heading.textContent), ['About', 'Credits']);
    assert.equal(anonymous.querySelector('#signout'), null);
    const out = aboutView(document, undefined, true);
    assert.equal(out.querySelector('#signout'), null);
    assert.equal(out.querySelector('.account-out a.button').getAttribute('href'), '#/');
  });

  it('draws a request with a poster-shaped thumbnail that fills in from the title, and only from an allowlisted TMDB image', async () => {
    const { document, requestItem, setRequestTitle, skeletonGrid, skeletonRequests } = await renderer();
    const { icon } = await import(pathToFileURL(path.join(DIST_APP, BUILT('js/icons.js'))).href);
    const entry = { id: 'r1', mediaType: 'movie', tmdbId: 900003, status: 'requested', seasons: [], byYou: true };
    const item = requestItem(document, entry);
    const thumb = item.querySelector(':scope > .request-thumb');
    assert.ok(thumb.classList.contains('poster-empty'), 'a frame of the right shape before the image arrives');
    assert.equal(thumb.querySelector('img'), null);
    assert.equal(item.querySelector(':scope > .badge').textContent, 'Requested');
    assert.equal(item.querySelector('.request-who').textContent, 'Asked for by you');
    setRequestTitle(item, { title: 'Synthetic Movie Three', year: 2021, mediaType: 'movie', posterUrl: poster });
    assert.equal(item.querySelector('.card-title').textContent, 'Synthetic Movie Three');
    assert.equal(item.querySelector('.card-meta').textContent, '2021 · Movie');
    assert.equal(thumb.querySelector('img').getAttribute('src'), poster);
    assert.equal(thumb.querySelector('img').getAttribute('alt'), '');
    assert.ok(!thumb.classList.contains('poster-empty'));
    const other = requestItem(document, { ...entry, byYou: false });
    assert.equal(other.querySelector('.request-who').textContent, 'Asked for by someone in your household');
    for (const posterUrl of ['https://evil.example.test/p.jpg', 'https://image.tmdb.org/t/p/original/a.jpg', 'data:image/png;base64,AAAA', null, undefined]) {
      const bare = requestItem(document, entry);
      setRequestTitle(bare, { title: 'Synthetic Movie Three', year: null, mediaType: 'movie', posterUrl });
      assert.equal(bare.querySelector('.request-thumb img'), null, String(posterUrl));
    }
    // The skeletons for the new shapes are hidden from assistive technology and are not the real lists.
    const grid = skeletonGrid(document);
    assert.equal(grid.getAttribute('aria-hidden'), 'true');
    assert.ok(!grid.classList.contains('grid'));
    assert.equal(grid.querySelectorAll('.skeleton-card').length, 6);
    const requests = skeletonRequests(document);
    assert.equal(requests.getAttribute('aria-hidden'), 'true');
    assert.ok(!requests.classList.contains('request-list') || requests.querySelectorAll('.request').length === 0);
    assert.equal(requests.querySelectorAll('.skeleton-request .skeleton-thumb').length, 4);
    // Icons are built node by node in the SVG namespace, hidden from assistive technology, in the text colour.
    for (const name of ['home', 'search', 'requests', 'info', 'back']) {
      const svg = icon(document, name);
      assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg', name);
      assert.equal(svg.getAttribute('aria-hidden'), 'true');
      assert.equal(svg.getAttribute('viewBox'), '0 0 24 24');
      assert.ok(svg.children.length >= 1, name);
      for (const child of svg.children) assert.equal(child.namespaceURI, 'http://www.w3.org/2000/svg');
      assert.equal(svg.hasAttribute('style'), false);
    }
  });
});

describe('household app page: running against the API', { timeout: 60_000 }, () => {
  /**
   * Loads the real page and client modules into a DOM, signed in as `user` with Jellyfin web's own stored sign-in, and
   * wires `fetch` to the real API on the test server. One page per test (the client keeps its state in module scope).
   */
  async function openApp(t, app, { user = ALICE, host = HOST_A, signedIn = true, override, hash = '', holdMe, store: initialStore, storageFails = false, userAgent = '' } = {}) {
    const origin = `https://${host}`;
    const { document, Event, HTMLElement } = parseHTML(read('index.html'));
    // linkedom keeps no focus (it has no document.activeElement): the last element of this page focus() was called on stands in.
    let focused = null;
    const ownFocus = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'focus');
    const { focus } = HTMLElement.prototype;
    HTMLElement.prototype.focus = function (...args) {
      if (this.ownerDocument === document) focused = this;
      return focus.apply(this, args);
    };
    t.after(() => {
      if (ownFocus) Object.defineProperty(HTMLElement.prototype, 'focus', ownFocus);
      else delete HTMLElement.prototype.focus;
    });
    const store = new Map(initialStore ?? (signedIn ? [['jellyfin_credentials', JSON.stringify({
      Servers: [{ ManualAddress: origin, AccessToken: TOKENS[user], UserId: user }],
    })]] : []));
    const requests = [];
    const location = {
      origin,
      hash,
      // Back's fallback replaces the entry it is on with the parent's address.
      replace(url) { entries[index] = { hash: String(url), state: null }; location.hash = String(url); fire(); },
    };
    const listeners = {};
    // A session history like the browser's: entries with a hash and a state, a cursor, and back/forward events.
    const entries = [{ hash, state: null }];
    let index = 0;
    const fire = () => { for (const listener of listeners.hashchange ?? []) listener({}); };
    const scroll = { y: 0 };
    const sessionWrites = [];
    const globals = {
      document,
      window: {
        scrollTo(_x, y) { scroll.y = y ?? 0; },
        get scrollY() { return scroll.y; },
        addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
        // The page's network is the test server; Node's own fetch (used by the server itself) is left alone.
        fetch: async (url, init = {}) => {
          requests.push({ url, init });
          if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
          if (holdMe && url === '/jellypass/app/v1/me') await holdMe;
          const answer = (await override?.(url, init)) ?? await (init.method === 'POST'
            ? post(app.port, url, { Host: host, ...init.headers }, init.body ? JSON.parse(init.body) : undefined)
            : get(app.port, url, { Host: host, ...init.headers }));
          return new Response(answer.body, { status: answer.status, headers: answer.headers });
        },
      },
      location,
      history: {
        get state() { return entries[index].state; },
        scrollRestoration: 'auto',
        replaceState(state, _title, url) {
          entries[index].state = state;
          if (url !== undefined) {
            location.hash = String(url).slice(String(url).indexOf('#'));
            entries[index].hash = location.hash;
          }
        },
        back() {
          if (index === 0) return;
          index -= 1;
          location.hash = entries[index].hash;
          fire();
        },
      },
      sessionStorage: { setItem: (key, value) => { sessionWrites.push([key, String(value)]); }, getItem: () => null },
      localStorage: {
        getItem: (key) => store.get(key) ?? null,
        setItem: (key, value) => {
          if (storageFails) throw new DOMException('quota', 'QuotaExceededError');
          store.set(key, String(value));
        },
      },
      navigator: { userAgent },
    };
    const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => {
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    });
    await import(`${pathToFileURL(path.join(DIST_APP, BUILT('js/main.js'))).href}?page=${Math.random()}`);
    const until = async (condition, what) => {
      for (let waited = 0; waited < 5000; waited += 10) {
        const value = condition();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`timed out waiting for ${what}\n${document.getElementById('screen').outerHTML.slice(0, 600)}`);
    };
    const go = (hash) => {
      entries.splice(index + 1);
      entries.push({ hash, state: null });
      index += 1;
      location.hash = hash;
      fire();
    };
    const main = () => document.getElementById('screen');
    const back = () => document.getElementById('back');
    return { document, Event, until, go, main, requests, store, location, back, entries, cursor: () => index, scroll, sessionWrites, history: globals.history, window: globals.window, serialize: () => document.documentElement.outerHTML, listeners, focused: () => focused };
  }

  it('shows the four discover rows with each title\'s badge and no Play button on the cards', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app);
    await page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4, 'four discover rows');
    assert.deepEqual([...page.document.querySelectorAll('.row-heading')].map((heading) => heading.textContent),
      ['Trending', 'Popular movies', 'Popular series', 'Upcoming movies']);
    const trending = page.document.querySelector('#row-trending-heading').parentElement;
    const cards = [...trending.querySelectorAll('.card')];
    assert.deepEqual(cards.map((item) => item.querySelector('.card-title').textContent),
      ['Synthetic Movie One', 'Synthetic Series Two', 'Synthetic Movie Three'], 'the person in the results is dropped');
    assert.deepEqual(cards.map((item) => item.querySelector('.badge').textContent),
      ['Available to get', 'Available to get', 'Ready to watch']);
    // The title in the library has its Play button on its own page (below), not on the card.
    assert.equal(page.document.querySelectorAll('.row-list a.button, .row-list button').length, 0, 'no Play on any card');
    assert.equal([...page.document.querySelectorAll('.row-list a')].filter((anchor) => anchor.textContent === 'Play').length, 0);
    assert.ok(page.document.querySelector('[role="alert"]') === null);
    assert.equal(page.document.getElementById('screen').getAttribute('aria-busy'), 'false');
    // Calls: me + four lists, each with the token, never cached by the browser, no cookies.
    assert.deepEqual(page.requests.map((request) => request.url.replace(/\?.*/, '')).sort(), [
      '/jellypass/app/v1/discover/popular-movies', '/jellypass/app/v1/discover/popular-tv', '/jellypass/app/v1/discover/trending',
      '/jellypass/app/v1/discover/upcoming', '/jellypass/app/v1/me',
    ]);
    for (const { init } of page.requests) {
      assert.equal(init.cache, 'no-store');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.headers.Authorization, 'MediaBrowser Token="token-alice"');
    }
    assertNoCanaries(page.serialize(), 'the page shows data that is not in a DTO');
    assert.equal(await accountName(page), 'Alice · Farmhouse', 'the household and name are on About, not in the header');
  });

  it('opens a title, its seasons and a season, and keeps to what the DTOs hold', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app);
    await page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4, 'home');
    page.go(`#/movie/${OWN_MOVIE}`);
    await page.until(() => page.main().querySelector('article.detail'), 'the movie');
    assert.equal(page.main().querySelector('h1').textContent, 'Synthetic Movie Three');
    assert.equal(page.main().querySelector('.badge').textContent, 'Ready to watch');
    assert.equal(page.main().querySelector('a.button').textContent, 'Play');
    assert.equal(page.document.title, 'Synthetic Movie Three – JellyPass');
    assertNoCanaries(page.serialize(), 'movie page');

    page.go(`#/tv/${T_TV}`);
    await page.until(() => page.main().querySelector('.season-list'), 'the series');
    assert.equal(page.main().querySelector('h1').textContent, 'Synthetic Series Two');
    assert.ok(page.main().querySelector('a.button') === null);
    const seasons = [...page.main().querySelectorAll('.season')];
    assert.ok(seasons.length >= 1);
    for (const season of seasons) assert.equal(season.querySelector('.badge').textContent, 'Available to get');
    assertNoCanaries(page.serialize(), 'series page');

    page.go(`#/tv/${T_TV}/season/1`);
    await page.until(() => page.main().querySelector('.episode-list'), 'the season');
    assert.equal(page.main().querySelector('h1').textContent, 'Season 1');
    assert.equal(page.main().querySelector('a.back').getAttribute('href'), `#/tv/${T_TV}`);
    assert.ok(page.main().querySelectorAll('.episode').length >= 1);
    assertNoCanaries(page.serialize(), 'season page');

    page.go('#/about');
    await page.until(() => page.main().querySelector('.tmdb-logo'), 'about');
    assert.match(page.main().textContent, /uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB/);
    assert.equal(page.document.querySelector('nav a[aria-current="page"]'), null, 'About is not a tab, so no tab is marked');
  });

  it('has three labelled tabs, and reaches About (with its TMDB credit) from the (i) button in Home\'s top row', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app);
    await page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4, 'home');
    const tabs = [...page.document.querySelectorAll('nav[aria-label="Main"] a')];
    assert.deepEqual(tabs.map((tab) => tab.textContent), ['Home', 'Search', 'My requests']);
    assert.deepEqual(tabs.map((tab) => tab.getAttribute('href')), ['#/', '#/search', '#/requests']);
    assert.deepEqual(tabs.map((tab) => tab.querySelectorAll('svg[aria-hidden="true"]').length), [1, 1, 1], 'an icon on each tab, hidden from screen readers');
    assert.equal(page.document.querySelector('nav a[data-nav="about"]'), null, 'About is not a tab');
    assert.equal(page.document.querySelector('nav a[aria-current="page"]').dataset.nav, 'home');
    // Home's top row: the brand and the (i) that opens About; nowhere else, and not the signed-in name or Sign out.
    const header = page.document.querySelector('header.app-header');
    const info = header.querySelector('a#about-link');
    assert.equal(info.hidden, false);
    assert.equal(info.getAttribute('href'), '#/about');
    assert.equal(info.getAttribute('aria-label'), 'About and credits');
    assert.equal(info.querySelectorAll('svg').length, 1);
    assert.equal(header.querySelector('.brand').textContent, 'JellyPass');
    assert.equal(header.querySelector('#signout'), null, 'no Sign out in the header');
    assert.equal(header.querySelector('#who'), null);
    assert.equal(/Sign out/.test(header.textContent), false);
    page.go(info.getAttribute('href'));
    await page.until(() => page.main().querySelector('.tmdb-logo'), 'about');
    assert.match(page.main().textContent, /uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB/);
    assert.equal(info.hidden, true, 'the (i) is Home\'s own');
    assert.equal(page.back().hidden, false);
    page.go('#/search');
    await page.until(() => page.main().querySelector('input[type="search"]'), 'search');
    assert.equal(info.hidden, true);
    assert.equal(page.document.querySelector('nav a[aria-current="page"]').dataset.nav, 'search');
    assert.equal(page.main().querySelectorAll('.search-field svg').length, 1, 'the magnifier is inside the field');
  });

  it('shows Sign out only in About\'s Account card, with the name and household, and signed out offers the way back', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app, { hash: '#/about' });
    await page.until(() => page.main().querySelector('.account-name')?.textContent === 'Alice · Farmhouse', 'the account card');
    assert.deepEqual([...page.main().querySelectorAll('h2')].map((heading) => heading.textContent), ['Account', 'About', 'Credits']);
    assert.equal(page.main().querySelectorAll('button#signout').length, 1);
    assert.equal(page.document.querySelector('header #signout'), null);
    assert.equal(page.document.querySelectorAll('#signout').length, 1);
    assert.equal(page.document.querySelector('.tmdb-logo') !== null, true);
    const signedOut = await openApp(t, app, { hash: '#/about', signedIn: false });
    await signedOut.until(() => signedOut.main().querySelector('.tmdb-logo'), 'about, signed out');
    assert.equal(signedOut.main().querySelector('#signout'), null, 'nothing to sign out of');
    assert.equal(signedOut.main().querySelector('.account'), null);
    assert.equal(signedOut.main().querySelector('.account-out a').getAttribute('href'), '#/');
    assert.equal(signedOut.requests.length, 0, 'About asks the API for nothing when signed out');
  });

  it('keeps Play on the title\'s own page when it is in the library, and shows none where it is not', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app);
    await page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4, 'home');
    page.go(`#/movie/${OWN_MOVIE}`);
    await page.until(() => page.main().querySelector('article.detail'), 'the movie');
    const play = [...page.main().querySelectorAll('a.button')].filter((anchor) => anchor.textContent === 'Play');
    assert.equal(play.length, 1);
    assert.equal(play[0].getAttribute('href'), `https://${HOST_A}/web/#/details?id=33330000333300003333000033330000`);
    page.go(`#/tv/${T_TV}`);
    await page.until(() => page.main().querySelector('.season-list'), 'the series');
    assert.equal([...page.main().querySelectorAll('a.button')].filter((anchor) => anchor.textContent === 'Play').length, 0);
  });

  describe('in-app Back and restoring where you were', () => {
    // Plain strings and numbers only are compared here: a failing assertion on a DOM node would try to print the page.
    const homeReady = (page) => page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4, 'home');

    it('shows Back on every screen but Home, as a labelled button of at least 44px that the keyboard reaches', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app);
      await homeReady(page);
      assert.equal(page.back().hidden, true, 'no Back on Home');
      for (const [hash, ready] of [
        [`#/movie/${OWN_MOVIE}`, 'article.detail'],
        [`#/tv/${T_TV}`, '.season-list'],
        [`#/tv/${T_TV}/season/1`, '.episode-list'],
        ['#/search', 'input[type="search"]'],
        ['#/requests', '.request-list, p.muted'],
        ['#/about', '.tmdb-logo'],
      ]) {
        page.go(hash);
        await page.until(() => page.main().querySelector(ready), hash);
        assert.equal(page.back().hidden, false, `Back on ${hash}`);
      }
      const button = page.back();
      assert.equal(button.tagName, 'BUTTON');
      assert.equal(button.getAttribute('type'), 'button');
      assert.equal(button.getAttribute('aria-label'), 'Back');
      assert.equal(button.hasAttribute('tabindex'), false, 'in the tab order');
      assert.match(read(BUILT('app.css')), /\.back-button, \.icon-button \{[^}]*min-width: 2\.75rem; min-height: 2\.75rem/, '44px tap target');
      assert.match(read('index.html'), /<header class="app-header">\s*<button id="back"/, 'first in the header, so first in the tab order');
      page.go('#/');
      await homeReady(page);
      assert.equal(page.back().hidden, true);
    });

    it('goes back through the app\'s own history, and to the logical parent when the app was opened on the screen', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app);
      await homeReady(page);
      page.go(`#/tv/${T_TV}`);
      await page.until(() => page.main().querySelector('.season-list'), 'series');
      page.go(`#/tv/${T_TV}/season/1`);
      await page.until(() => page.main().querySelector('.episode-list'), 'season');
      page.back().dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelector('.season-list'), 'back to the series');
      assert.equal(page.location.hash, `#/tv/${T_TV}`);
      assert.equal(page.cursor(), 1);
      page.back().dispatchEvent(new page.Event('click'));
      await homeReady(page);
      assert.equal(page.location.hash, '');
      assert.equal(page.back().hidden, true);

      // Opened on a season (deep link): Back is its series, without leaving the app, and replaces rather than adds.
      const season = await openApp(t, app, { hash: `#/tv/${T_TV}/season/1` });
      await season.until(() => season.main().querySelector('.episode-list'), 'the season');
      season.back().dispatchEvent(new season.Event('click'));
      await season.until(() => season.main().querySelector('.season-list'), 'the series');
      assert.equal(season.location.hash, `#/tv/${T_TV}`);
      assert.equal(season.entries.length, 1, 'no entry was added');
      season.back().dispatchEvent(new season.Event('click'));
      await homeReady(season);
      assert.equal(season.location.hash, '#/');
      assert.equal(season.entries.length, 1);

      for (const hash of [`#/movie/${OWN_MOVIE}`, '#/requests', '#/about', '#/search']) {
        const deep = await openApp(t, app, { hash });
        await deep.until(() => deep.back().hidden === false && deep.main().getAttribute('aria-busy') === 'false', hash);
        deep.back().dispatchEvent(new deep.Event('click'));
        await homeReady(deep);
        assert.equal(deep.location.hash, '#/', hash);
      }
    });

    it('pops once after Get this: the confirmation adds no history entry', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app);
      await homeReady(page);
      page.go(`#/movie/${T_MOVIE}`);
      const button = await page.until(() => page.main().querySelector('button'), 'Get this');
      const entries = page.entries.length;
      button.dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelector('.get-message')?.textContent, 'the confirmation');
      await app.background.settled();
      assert.equal(page.entries.length, entries, 'no entry added');
      assert.equal(page.cursor(), 1);
      page.back().dispatchEvent(new page.Event('click'));
      await homeReady(page);
      assert.equal(page.cursor(), 0, 'one Back reached Home');
      assert.equal(page.location.hash, '');
    });

    it('puts Home\'s page scroll and each row\'s scroll back after a title and Back', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app);
      await homeReady(page);
      const rows = [...page.document.querySelectorAll('ul.row-list[aria-labelledby]')];
      const lefts = [120, 8, 340, 55];
      rows.forEach((row, index) => { row.scrollLeft = lefts[index]; });
      page.scroll.y = 640;
      page.go(`#/movie/${OWN_MOVIE}`);
      await page.until(() => page.main().querySelector('article.detail'), 'the movie');
      assert.equal(page.scroll.y, 0, 'a new screen starts at the top');
      page.history.back();
      await homeReady(page);
      await page.until(() => page.scroll.y === 640, 'the page scroll');
      assert.deepEqual([...page.document.querySelectorAll('ul.row-list[aria-labelledby]')].map((row) => row.scrollLeft), lefts);
      assert.equal(page.history.scrollRestoration, 'manual', 'the browser does not fight the restore');
      // A detail screen's own scroll comes back too.
      page.go(`#/tv/${T_TV}`);
      await page.until(() => page.main().querySelector('.season-list'), 'the series');
      page.scroll.y = 275;
      page.go(`#/tv/${T_TV}/season/1`);
      await page.until(() => page.main().querySelector('.episode-list'), 'the season');
      page.back().dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelector('.season-list') && page.scroll.y === 275, 'the series scroll');
    });

    it('puts the search query, the pages loaded and the scroll back', async (t) => {
      const app = await startApp(t, world({ extraResults: 45 }));
      const page = await openApp(t, app);
      await homeReady(page);
      page.go('#/search');
      const input = await page.until(() => page.main().querySelector('input[type="search"]'), 'the search box');
      input.value = 'synthetic';
      input.dispatchEvent(new page.Event('input'));
      await page.until(() => page.main().querySelector('button.load-more'), 'results');
      page.main().querySelector('button.load-more').dispatchEvent(new page.Event('click'));
      await page.until(() => page.requests.some((request) => request.url === '/jellypass/app/v1/search?q=synthetic&page=2'), 'page 2');
      await page.until(() => page.main().querySelector('button.load-more:not([disabled])'), 'page 2 shown');
      const shown = page.main().querySelectorAll('.card').length;
      page.scroll.y = 910;
      page.main().querySelector('a.card-link').dispatchEvent(new page.Event('click'));
      page.go(`#/movie/${OWN_MOVIE}`);
      await page.until(() => page.main().querySelector('article.detail'), 'the movie');
      page.back().dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelectorAll('.card').length === shown && page.scroll.y === 910, 'the same results and scroll');
      assert.equal(page.main().querySelector('input[type="search"]').value, 'synthetic');
      assert.equal(page.location.hash, '#/search?q=synthetic');
      const pages = page.requests.filter((request) => request.url.startsWith('/jellypass/app/v1/search')).map((request) => request.url.replace(/.*page=/, ''));
      assert.deepEqual(pages, ['1', '2', '1', '2']);
      assert.equal(page.cursor(), 1, 'typing replaced the entry, it did not add one');
    });

    it('puts My requests\' scroll and the entries shown back', async (t) => {
      const app = await startApp(t);
      const results = Array.from({ length: 25 }, (_, index) => ({
        id: `id${index}`, mediaType: 'movie', tmdbId: index % 2 ? T_MOVIE : OWN_MOVIE, status: 'requested', seasons: [], byYou: true,
      }));
      const page = await openApp(t, app, { hash: '', override: (url) => (url === '/jellypass/app/v1/requests' ? { status: 200, body: Buffer.from(JSON.stringify({ results })), headers: { 'content-type': 'application/json' } } : undefined) });
      await homeReady(page);
      page.go('#/requests');
      await page.until(() => page.main().querySelectorAll('.request').length === 10, 'ten');
      page.main().querySelector('button.load-more').dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelectorAll('.request').length === 20, 'twenty');
      page.scroll.y = 1500;
      page.go(`#/movie/${OWN_MOVIE}`);
      await page.until(() => page.main().querySelector('article.detail'), 'the movie');
      page.back().dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelectorAll('.request').length === 20, 'twenty again');
      await page.until(() => page.scroll.y === 1500, 'the scroll');
    });

    /** A response the test releases by hand; the page's fetch waits on it. */
    const deferred = () => {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      return { promise, release };
    };
    const fire = (page, type) => { for (const listener of page.listeners[type] ?? []) listener({ type }); };
    const pause = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
    const heldTrending = (gate) => (url) => (gate.held && url.startsWith('/jellypass/app/v1/discover/trending') ? gate.held.promise.then(() => undefined) : undefined);
    const heldSearchPage2 = (gate) => (url) => (gate.held && url === '/jellypass/app/v1/search?q=synthetic&page=2' ? gate.held.promise.then(() => undefined) : undefined);

    for (const interaction of ['scroll', 'wheel', 'touchstart', 'keydown']) {
      it(`does not pull Home back when a delayed row arrives after the member used ${interaction}`, async (t) => {
        const app = await startApp(t);
        const gate = { held: undefined };
        const page = await openApp(t, app, { override: heldTrending(gate) });
        await homeReady(page);
        page.scroll.y = 640;
        page.go(`#/movie/${OWN_MOVIE}`);
        await page.until(() => page.main().querySelector('article.detail'), 'the movie');
        gate.held = deferred();
        page.history.back();
        await page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 3, 'three rows, one still on its way');
        // The app's own scroll (and its scroll events) is not the member taking over.
        fire(page, 'scroll');
        page.scroll.y = 200;
        fire(page, interaction);
        gate.held.release();
        await homeReady(page);
        await pause();
        assert.equal(page.scroll.y, 200, 'the member\'s place was kept');
      });
    }

    it('still restores Home when only the app\'s own scroll events arrive while a row is delayed', async (t) => {
      const app = await startApp(t);
      const gate = { held: undefined };
      const page = await openApp(t, app, { override: heldTrending(gate) });
      await homeReady(page);
      page.scroll.y = 640;
      page.go(`#/movie/${OWN_MOVIE}`);
      await page.until(() => page.main().querySelector('article.detail'), 'the movie');
      gate.held = deferred();
      page.history.back();
      await page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 3, 'three rows');
      fire(page, 'scroll');
      gate.held.release();
      await homeReady(page);
      await page.until(() => page.scroll.y === 640, 'the page scroll');
    });

    async function searchTwoPagesThenOpenATitle(t, gate) {
      const app = await startApp(t, world({ extraResults: 45 }));
      const page = await openApp(t, app, { override: heldSearchPage2(gate) });
      await homeReady(page);
      page.go('#/search');
      const input = await page.until(() => page.main().querySelector('input[type="search"]'), 'the search box');
      input.value = 'synthetic';
      input.dispatchEvent(new page.Event('input'));
      await page.until(() => page.main().querySelector('button.load-more'), 'results');
      page.main().querySelector('button.load-more').dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelector('button.load-more:not([disabled])'), 'page 2 shown');
      page.scroll.y = 910;
      page.go(`#/movie/${OWN_MOVIE}`);
      await page.until(() => page.main().querySelector('article.detail'), 'the movie');
      gate.held = deferred();
      page.back().dispatchEvent(new page.Event('click'));
      await page.until(() => page.requests.filter((request) => request.url === '/jellypass/app/v1/search?q=synthetic&page=2').length === 2, 'page 2 asked for again');
      return page;
    }

    it('does not carry a restored search\'s pages or scroll into a different query typed before the restore finished', async (t) => {
      const gate = { held: undefined };
      const page = await searchTwoPagesThenOpenATitle(t, gate);
      page.scroll.y = 0;
      const typed = page.main().querySelector('input[type="search"]');
      typed.value = 'synthetic2';
      typed.dispatchEvent(new page.Event('input'));
      await page.until(() => page.requests.some((request) => request.url === '/jellypass/app/v1/search?q=synthetic2&page=1'), 'the new query');
      gate.held.release();
      await page.until(() => page.main().querySelector('button.load-more:not([disabled])'), 'the new results');
      await pause();
      const asked = page.requests.map((request) => request.url).filter((url) => url.startsWith('/jellypass/app/v1/search?q=synthetic2'));
      assert.deepEqual(asked, ['/jellypass/app/v1/search?q=synthetic2&page=1'], 'only the first page of the new query');
      assert.equal(page.scroll.y, 0, 'the old scroll was not applied');
    });

    it('does not put a search back after the member scrolled while its pages were coming', async (t) => {
      const gate = { held: undefined };
      const page = await searchTwoPagesThenOpenATitle(t, gate);
      page.scroll.y = 120;
      fire(page, 'wheel');
      gate.held.release();
      await page.until(() => page.main().querySelector('button.load-more:not([disabled])'), 'the results');
      await pause();
      assert.equal(page.scroll.y, 120);
    });

    it('keeps at most 50 remembered positions, forgetting the oldest first', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app);
      await homeReady(page);
      page.scroll.y = 333;
      for (let index = 1; index <= 60; index += 1) {
        page.go(`#/about?n=${index}`);
        await page.until(() => page.main().querySelector('.tmdb-logo') && page.location.hash === `#/about?n=${index}`, `entry ${index}`);
        page.scroll.y = 1000 + index;
      }
      page.history.back();
      await page.until(() => page.scroll.y === 1059, 'a recent entry is remembered');
      for (let index = 0; index < 59; index += 1) page.history.back();
      await homeReady(page);
      await pause();
      assert.equal(page.scroll.y, 0, 'Home, the oldest entry, was forgotten');
    });

    it('keeps only scroll and query state in the browser: no API data in storage, and no new storage keys', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app);
      await homeReady(page);
      const keys = [...page.store.keys()];
      page.go(`#/movie/${OWN_MOVIE}`);
      await page.until(() => page.main().querySelector('article.detail'), 'the movie');
      page.history.back();
      await homeReady(page);
      assert.deepEqual([...page.store.keys()], keys, 'localStorage gained no key');
      assert.equal(page.sessionWrites.length, 0, 'sessionStorage was not written');
      // The only thing kept in history.state is the entry's number.
      for (const entry of page.entries) assert.match(JSON.stringify(entry.state), /^(null|\{"jp":\d+\})$/);
      for (const text of [JSON.stringify([...page.store.values()].filter((value) => !value.includes('AccessToken'))), JSON.stringify(page.sessionWrites)]) {
        assert.doesNotMatch(text, /Synthetic|farmhouse|tmdb/i);
      }
    });
  });

  it('searches as you type, once, and loads more with the API\'s nextPage', async (t) => {
    const app = await startApp(t, world({ extraResults: 20 }));
    const page = await openApp(t, app);
    await page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4, 'home');
    page.go('#/search');
    const input = await page.until(() => page.main().querySelector('input[type="search"]'), 'the search box');
    assert.equal(input.getAttribute('id'), 'q');
    assert.ok(page.main().querySelector('label[for="q"]'));
    const before = page.requests.length;
    // Typing fast makes one call, after the pause; a half-typed word is never searched.
    for (const text of ['s', 'sy', 'syn', 'synthetic']) {
      input.value = text;
      input.dispatchEvent(new page.Event('input'));
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    assert.equal(page.requests.length, before, 'no call during the pause');
    await page.until(() => page.main().querySelector('ul.grid'), 'results');
    const searches = page.requests.slice(before).filter((request) => request.url.startsWith('/jellypass/app/v1/search'));
    assert.deepEqual(searches.map((request) => request.url), ['/jellypass/app/v1/search?q=synthetic&page=1']);
    assert.equal(page.location.hash, '#/search?q=synthetic');
    const first = page.main().querySelectorAll('.card').length;
    assert.ok(first >= 20);
    const more = page.main().querySelector('button.load-more');
    assert.equal(more.textContent, 'Load more');
    more.dispatchEvent(new page.Event('click'));
    await page.until(() => page.main().querySelectorAll('.card').length > first, 'the next page');
    assert.ok(page.requests.some((request) => request.url === '/jellypass/app/v1/search?q=synthetic&page=2'));
    assertNoCanaries(page.serialize(), 'search results');

    input.value = 'zzz-nothing';
    // The fake TMDB answers every query alike; an empty box clears the results and the address instead.
    input.value = '';
    input.dispatchEvent(new page.Event('input'));
    await page.until(() => !page.main().querySelector('ul.grid'), 'cleared results');
    assert.equal(page.location.hash, '#/search');
  });

  it('searches without waiting for /me: submitting and typing while it loads both work', async (t) => {
    const app = await startApp(t);
    let release;
    const holdMe = new Promise((resolve) => { release = resolve; });
    const page = await openApp(t, app, { hash: '#/search', holdMe });
    const input = await page.until(() => page.main().querySelector('input[type="search"]'), 'the search box');
    const searches = () => page.requests.filter((request) => request.url.startsWith('/jellypass/app/v1/search')).map((request) => request.url);
    // Submitting (Enter) before /me is back searches at once, instead of throwing.
    input.value = 'synthetic';
    const submit = new page.Event('submit', { cancelable: true });
    assert.doesNotThrow(() => page.main().querySelector('form').dispatchEvent(submit));
    assert.equal(submit.defaultPrevented, true);
    await page.until(() => page.main().querySelector('ul.grid'), 'results while /me is still loading');
    assert.deepEqual(searches(), ['/jellypass/app/v1/search?q=synthetic&page=1']);
    // Typing is not lost either: the box has its listener from the start, and the debounced search runs.
    input.value = 'another';
    input.dispatchEvent(new page.Event('input'));
    await page.until(() => searches().length === 2, 'the typed search');
    assert.equal(searches()[1], '/jellypass/app/v1/search?q=another&page=1');
    assert.equal(page.location.hash, '#/search?q=another');
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(page.main().querySelector('input[type="search"]') === input, 'the screen was not rebuilt');
    assert.equal(input.value, 'another');
  });

  it('keeps a query typed before /me answered when the address already carried one', async (t) => {
    const app = await startApp(t);
    let release;
    const holdMe = new Promise((resolve) => { release = resolve; });
    const page = await openApp(t, app, { hash: '#/search?q=first', holdMe });
    const input = await page.until(() => page.main().querySelector('input[type="search"]'), 'the search box');
    await page.until(() => page.main().querySelector('ul.grid'), 'results for the address\'s query');
    input.value = 'second';
    input.dispatchEvent(new page.Event('input'));
    await page.until(() => page.location.hash === '#/search?q=second', 'the typed query');
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(input.value, 'second');
    assert.equal(page.location.hash, '#/search?q=second', 'the address\'s query did not replace what was typed');
  });

  it('moves focus to the content from the skip link without leaving the screen', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app, { hash: '#/about' });
    await page.until(() => page.main().querySelector('h1'), 'the about screen');
    const screen = page.main();
    const heading = screen.querySelector('h1').textContent;
    let focused = 0;
    const focus = screen.focus.bind(screen);
    screen.focus = (...args) => { focused += 1; return focus(...args); };
    const link = page.document.querySelector('a.skip-link');
    assert.equal(link.getAttribute('href'), '#screen');
    assert.equal(screen.getAttribute('tabindex'), '-1');
    const click = new page.Event('click', { cancelable: true, bubbles: true });
    link.dispatchEvent(click);
    assert.equal(click.defaultPrevented, true, 'the browser does not navigate to #screen');
    assert.equal(focused, 1, 'focus goes to main');
    assert.equal(page.location.hash, '#/about');
    assert.equal(screen.querySelector('h1').textContent, heading);
    // Were the address to change to a non-route hash anyway (scripts off, or another anchor), the screen stays too.
    const requests = page.requests.length;
    page.go('#screen');
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(page.main().querySelector('h1').textContent, heading, 'not replaced by Home');
    assert.equal(page.requests.length, requests);
    // A real route still navigates.
    page.go('#/');
    await page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4, 'home');
  });

  const credentials = (page) => JSON.parse(page.store.get('jellyfin_credentials'));
  const click = (page, node) => node.dispatchEvent(new page.Event('click', { bubbles: true, cancelable: true }));
  /** The signed-in "name · household", read from About's Account card (the header no longer shows it). */
  const accountName = async (page) => {
    page.go('#/about');
    return page.until(() => {
      const name = page.main().querySelector('.account-name');
      return name && name.textContent !== 'Signed in' ? name.textContent : '';
    }, 'the account card');
  };
  /** Signs out the only way the app offers: the Sign out button in About's Account card. Ends on Home's picker. */
  const signOutFromAbout = async (page) => {
    page.go('#/about');
    const button = await page.until(() => page.main().querySelector('#signout'), 'the Sign out button');
    click(page, button);
    await page.until(() => page.main().querySelector('.account-out'), 'About after signing out');
    page.go('#/');
    await page.until(() => page.main().querySelector('ul.profiles'), 'the picker after signing out');
  };
  const profileButton = (page, name) => [...page.main().querySelectorAll('button.profile')].find((button) => button.textContent.includes(name));
  const enterPassword = (page, password) => {
    const input = page.main().querySelector('input[type="password"]');
    input.value = password;
    page.main().querySelector('form').dispatchEvent(new page.Event('submit', { cancelable: true }));
  };
  const homeLoaded = (page) => page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4, 'the home rows');
  const message = (page) => page.main().querySelector('#signin-message')?.textContent ?? '';
  /** Alice has a password at Jellyfin; Ann is marked passwordless in JellyPass and has none. */
  const signInWorld = () => world({ passwords: { [ALICE]: 'alice-pass' } });
  const signInApp = async (t) => {
    const app = await startApp(t, signInWorld());
    await app.store.setUserPasswordless(ANN, true);
    return app;
  };

  it('shows the household\'s own profiles when signed out, without calling the app API', async (t) => {
    const app = await signInApp(t);
    const page = await openApp(t, app, { signedIn: false });
    await page.until(() => page.main().querySelector('ul.profiles'), 'the profile picker');
    assert.equal(page.main().querySelector('h1').textContent, 'Sign in');
    assert.equal(page.document.title, 'Sign in – JellyPass');
    // Only what the gateway lists on this host: this household's members, not Bob, Carol or the outsider.
    assert.deepEqual([...page.main().querySelectorAll('.profile-name')].map((name) => name.textContent), ['Alice', 'Ann']);
    assert.deepEqual([...page.main().querySelectorAll('button.profile')].map((button) => button.getAttribute('type')), ['button', 'button']);
    assert.deepEqual(page.requests.map((request) => [request.init.method ?? 'GET', request.url]), [['GET', '/Users/Public']]);
    assert.equal(page.document.getElementById('signout'), null, 'nothing to sign out of');
    // Jellyfin web is only a fallback, below the picker.
    const links = [...page.main().querySelectorAll('a')];
    assert.deepEqual(links.map((link) => [link.textContent, link.getAttribute('href')]), [['Open Jellyfin to sign in', '/web/']]);
    assert.equal(page.main().querySelectorAll('a.button').length, 0);
    const other = await openApp(t, app, { signedIn: false, host: HOST_B });
    await other.until(() => other.main().querySelector('ul.profiles'), 'household B\'s picker');
    assert.deepEqual([...other.main().querySelectorAll('.profile-name')].map((name) => name.textContent), ['Bob']);
  });

  it('signs in with a password, stores the session where Jellyfin web keeps its own, and then loads the app', async (t) => {
    const app = await signInApp(t);
    const page = await openApp(t, app, { signedIn: false, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' });
    await page.until(() => page.main().querySelector('ul.profiles'), 'the picker');
    click(page, profileButton(page, 'Alice'));
    const input = await page.until(() => page.main().querySelector('input[type="password"]'), 'the password step');
    assert.equal(page.main().querySelector('h1').textContent, 'Sign in as Alice');
    assert.equal(page.main().querySelector('label[for="password"]').textContent, 'Password');
    assert.equal(input.getAttribute('autocomplete'), 'current-password');
    assert.equal(page.main().querySelector('input[name="username"]').getAttribute('value'), 'Alice');
    assert.equal(page.main().querySelector('input[name="username"]').getAttribute('aria-hidden'), 'true');
    assert.equal(page.main().querySelector('[role="alert"]').getAttribute('id'), 'signin-message');
    assert.equal(input.getAttribute('aria-describedby'), 'signin-message');
    const requests = page.requests.length;
    enterPassword(page, 'alice-pass');
    await homeLoaded(page);
    assert.equal(page.document.getElementById('signout'), null, 'Sign out is not in the header');
    assert.equal(await accountName(page), 'Alice · Farmhouse');

    // One call signed in, with the headers Jellyfin web sends; the password is only in that body.
    const login = page.requests[requests];
    assert.equal(login.url, '/Users/AuthenticateByName');
    assert.equal(login.init.method, 'POST');
    assert.deepEqual(JSON.parse(login.init.body), { Username: 'Alice', Pw: 'alice-pass' });
    assert.equal(login.init.credentials, 'omit');
    assert.equal(login.init.cache, 'no-store');
    const deviceId = page.store.get('jellypass_device_id');
    assert.match(deviceId, /^jellypass-[0-9a-f-]{36}$/);
    assert.equal(login.init.headers.Authorization, `MediaBrowser Client="JellyPass", Device="iPhone", DeviceId="${deviceId}", Version="1.0"`);
    assert.equal(app.jellyfin.signIns.length, 1);
    assert.equal(app.jellyfin.signIns[0].header, login.init.headers.Authorization);
    // Stored exactly as Jellyfin web 10.11 stores it (Id, address, user, token, mode, time), where the app and /web/ both read.
    const { token } = app.jellyfin.signIns[0];
    assert.deepEqual(Object.keys(credentials(page)), ['Servers']);
    const [server, ...others] = credentials(page).Servers;
    assert.equal(others.length, 0);
    assert.deepEqual({ ...server, DateLastAccessed: typeof server.DateLastAccessed }, {
      Id: 'server', ManualAddress: page.location.origin, LastConnectionMode: 2, DateLastAccessed: 'number', UserId: ALICE, AccessToken: token,
    });
    assert.ok(Math.abs(server.DateLastAccessed - Date.now()) < 60_000);
    // The app then calls /me and the lists with that token, and with nothing else.
    const calls = page.requests.slice(requests + 1).filter((request) => request.url.startsWith('/jellypass/app/v1/'));
    assert.ok(calls.length >= 5);
    for (const { init } of calls) assert.equal(init.headers.Authorization, `MediaBrowser Token="${token}"`);
    // The password is never in a URL, the page, storage (beyond the credentials above) or another request body.
    for (const request of page.requests) assert.doesNotMatch(String(request.url), /alice-pass|signin-token/);
    assert.doesNotMatch(page.serialize(), /alice-pass|signin-token/);
    assert.doesNotMatch(page.store.get('jellyfin_credentials') + deviceId, /alice-pass/);
    assert.equal(page.location.hash.includes(token), false);
    assert.equal(input.value, '', 'the password field was cleared');
    // Reloading finds the same device ID.
    const again = await openApp(t, app, { store: page.store, user: ALICE });
    await homeLoaded(again);
    assert.equal(again.store.get('jellypass_device_id'), deviceId);
  });

  it('keeps what else Jellyfin web stored, and replaces a stale entry for this address', async (t) => {
    const app = await signInApp(t);
    const origin = `https://${HOST_A}`;
    const before = JSON.stringify({
      Servers: [
        { Id: 'old-server', Name: 'Old', ManualAddress: origin, UserId: BOB, AccessToken: 'token-revoked' },
        { Id: 'server', Name: 'Home Jellyfin', ManualAddress: origin, LocalAddress: 'http://10.0.0.5:8096', UserLinkType: 'Guest', DateLastAccessed: 1 },
        { Id: 'elsewhere', Name: 'Elsewhere', ManualAddress: 'https://elsewhere.example.test' },
      ],
      Extra: { kept: true },
    });
    const page = await openApp(t, app, { store: new Map([['jellyfin_credentials', before]]) });
    await page.until(() => page.main().querySelector('ul.profiles'), 'the picker after a revoked token');
    click(page, profileButton(page, 'Alice'));
    await page.until(() => page.main().querySelector('input[type="password"]'), 'the password step');
    enterPassword(page, 'alice-pass');
    await homeLoaded(page);
    const stored = credentials(page);
    assert.deepEqual(stored.Extra, { kept: true });
    assert.deepEqual(stored.Servers.map((server) => server.Id), ['server', 'elsewhere'], 'the stale entry for this address is gone');
    assert.equal(stored.Servers[0].Name, 'Home Jellyfin');
    assert.equal(stored.Servers[0].LocalAddress, 'http://10.0.0.5:8096');
    assert.equal(stored.Servers[0].UserLinkType, 'Guest');
    assert.equal(stored.Servers[0].UserId, ALICE);
    assert.equal(stored.Servers[0].AccessToken, app.jellyfin.signIns[0].token);
    assert.equal(stored.Servers[1].AccessToken, undefined);
  });

  it('signs in with one tap for a member marked passwordless, as Jellyfin web does', async (t) => {
    const app = await signInApp(t);
    const page = await openApp(t, app, { signedIn: false });
    await page.until(() => page.main().querySelector('ul.profiles'), 'the picker');
    click(page, profileButton(page, 'Ann'));
    await homeLoaded(page);
    assert.ok(page.main().querySelector('input[type="password"]') === null, 'no password step');
    assert.equal(await accountName(page), 'Ann · Farmhouse');
    const login = page.requests.find((request) => request.url === '/Users/AuthenticateByName');
    assert.deepEqual(JSON.parse(login.init.body), { Username: 'Ann', Pw: '' });
    assert.equal(credentials(page).Servers[0].UserId, ANN);
  });

  /** Ann is hidden at Jellyfin (left off every login screen) and has a password; Bob, household B's only member, too. */
  const hiddenApp = (t) => startApp(t, world({
    passwords: { [ALICE]: 'alice-pass', [ANN]: 'ann-pass', [BOB]: 'bob-pass' },
    jellyfinUsers: {
      [ANN]: { Name: 'Ann', Policy: { IsHidden: true, BlockedTags: ['jellypass-held-elsewhere'], EnabledFolders: ['shared'] } },
      [BOB]: { Name: 'Bob', Policy: { IsHidden: true, BlockedTags: [], EnableAllFolders: true } },
    },
  }));
  const enterName = (page, username, password) => {
    page.main().querySelector('#username').value = username;
    page.main().querySelector('#password').value = password;
    page.main().querySelector('form').dispatchEvent(new page.Event('submit', { cancelable: true }));
  };
  const NAME_REFUSED = "That didn't work. Check your name and password and try again.";

  it('signs in a hidden member by name: the picker leaves them off and offers sign-in with a different name', async (t) => {
    const app = await hiddenApp(t);
    const page = await openApp(t, app, { signedIn: false });
    await page.until(() => page.main().querySelector('ul.profiles'), 'the picker');
    assert.deepEqual([...page.main().querySelectorAll('.profile-name')].map((name) => name.textContent), ['Alice']);
    const byName = [...page.main().querySelectorAll('button')].find((button) => button.textContent === 'Sign in with a different name');
    assert.ok(byName, 'sign-in by name is offered');
    assert.equal(byName.getAttribute('type'), 'button');
    click(page, byName);
    const username = await page.until(() => page.main().querySelector('#username'), 'the name form');
    assert.equal(page.main().querySelector('h1').textContent, 'Sign in');
    assert.equal(page.main().querySelector('label[for="username"]').textContent, 'Name');
    assert.equal(page.main().querySelector('label[for="password"]').textContent, 'Password');
    assert.equal(username.getAttribute('autocomplete'), 'username');
    assert.equal(username.getAttribute('autocapitalize'), 'none');
    assert.equal(username.getAttribute('spellcheck'), 'false');
    assert.equal(username.getAttribute('aria-describedby'), 'signin-message');
    assert.equal(page.main().querySelector('#password').getAttribute('autocomplete'), 'current-password');
    assert.equal(page.main().querySelector('#password').getAttribute('aria-describedby'), 'signin-message');
    assert.equal(page.main().querySelector('[role="alert"]').getAttribute('id'), 'signin-message');
    // Never a DOM node in an assertion: a failing one inspects the whole document, at a depth of 1000, until memory runs out.
    assert.ok(page.focused() === username, 'the name field has focus');
    assert.deepEqual([...page.main().querySelectorAll('a')].map((link) => link.getAttribute('href')), ['/web/']);
    const requests = page.requests.length;
    enterName(page, ' ann ', 'ann-pass');
    await homeLoaded(page);
    assert.equal(await accountName(page), 'Ann · Farmhouse');
    const login = page.requests[requests];
    assert.equal(login.url, '/Users/AuthenticateByName');
    assert.deepEqual(JSON.parse(login.init.body), { Username: 'ann', Pw: 'ann-pass' });
    assert.equal(credentials(page).Servers[0].UserId, ANN);
    assert.equal(credentials(page).Servers[0].AccessToken, app.jellyfin.signIns[0].token);
    assert.doesNotMatch(page.serialize(), /ann-pass/);
  });

  it('refuses another household\'s name with the same fixed text as a wrong password, and asks for a name first', async (t) => {
    const app = await hiddenApp(t);
    const page = await openApp(t, app, { signedIn: false });
    await page.until(() => page.main().querySelector('ul.profiles'), 'the picker');
    click(page, [...page.main().querySelectorAll('button')].find((button) => button.textContent === 'Sign in with a different name'));
    await page.until(() => page.main().querySelector('#username'), 'the name form');
    const submit = () => page.main().querySelector('button[type="submit"]');
    // No name: refused before any call.
    const calls = page.requests.length;
    enterName(page, '  ', 'x');
    assert.equal(message(page), 'Enter your name.');
    assert.equal(page.main().querySelector('#username').getAttribute('aria-invalid'), 'true');
    assert.equal(page.requests.length, calls);
    const attempt = async (username, password, expected) => {
      enterName(page, username, password);
      assert.equal(submit().disabled, true, 'one attempt at a time');
      await page.until(() => message(page) === expected && !submit().disabled, expected);
      assert.equal(submit().textContent, 'Sign in');
      assert.equal(page.main().querySelector('#password').value, '');
      assert.doesNotMatch(page.serialize(), /upstream detail|bob-pass|ann-pass/);
    };
    await attempt('Bob', 'bob-pass', NAME_REFUSED);
    assert.equal(page.main().querySelector('#password').getAttribute('aria-invalid'), 'true');
    await attempt('Ann', 'wrong', NAME_REFUSED);
    await attempt('nobody', '', NAME_REFUSED);
    for (let attempts = 0; attempts < 20; attempts += 1) {
      const answer = await post(app.port, '/Users/AuthenticateByName', { Host: HOST_A, Authorization: 'MediaBrowser Client="x", Device="y", DeviceId="zzzzzzzzzzzzzzzz", Version="1"' }, { Username: 'Ann', Pw: 'no' });
      if (answer.status === 429) break;
    }
    await attempt('Ann', 'ann-pass', 'Too many attempts. Wait a few minutes, then try again.');
    assert.equal(app.jellyfin.signIns.length, 0);
    // Back to the picker.
    click(page, [...page.main().querySelectorAll('button')].find((button) => button.textContent === 'Choose a profile'));
    await page.until(() => page.main().querySelector('ul.profiles'), 'the picker again');
  });

  it('starts with sign-in by name when the picker lists nobody', async (t) => {
    const app = await hiddenApp(t);
    const page = await openApp(t, app, { signedIn: false, host: HOST_B });
    const username = await page.until(() => page.main().querySelector('#username'), 'the name form');
    assert.ok(page.main().querySelector('ul.profiles') === null, 'no picker');
    assert.doesNotMatch(page.main().textContent, /No profiles/);
    assert.equal([...page.main().querySelectorAll('button')].some((button) => button.textContent === 'Choose a profile'), false, 'nothing to go back to');
    assert.ok(page.focused() !== username, 'the first screen keeps the page\'s own focus');
    enterName(page, 'Bob', 'bob-pass');
    await homeLoaded(page);
    assert.equal(await accountName(page), 'Bob · Mill');
  });

  it('asks for a password when a one-tap member has gained one, instead of failing', async (t) => {
    const app = await startApp(t, world({ passwords: { [ANN]: 'ann-pass' } }));
    await app.store.setUserPasswordless(ANN, true);
    const page = await openApp(t, app, { signedIn: false });
    await page.until(() => page.main().querySelector('ul.profiles'), 'the picker');
    click(page, profileButton(page, 'Ann'));
    await page.until(() => page.main().querySelector('input[type="password"]'), 'the password step');
    assert.equal(message(page), "That didn't work. Check your password and try again.");
    enterPassword(page, 'ann-pass');
    await homeLoaded(page);
  });

  it('shows fixed text for a wrong password, too many attempts, an outage, being offline and unusable storage', async (t) => {
    const app = await signInApp(t);
    const page = await openApp(t, app, { signedIn: false });
    await page.until(() => page.main().querySelector('ul.profiles'), 'the picker');
    click(page, profileButton(page, 'Alice'));
    await page.until(() => page.main().querySelector('input[type="password"]'), 'the password step');
    const input = () => page.main().querySelector('input[type="password"]');
    const submit = () => page.main().querySelector('button[type="submit"]');
    const attempt = async (password, expected) => {
      enterPassword(page, password);
      assert.equal(submit().disabled, true, 'one attempt at a time');
      await page.until(() => message(page) === expected, expected);
      assert.equal(submit().disabled, false);
      assert.equal(submit().textContent, 'Sign in');
      assert.equal(input().value, '');
      assert.doesNotMatch(page.serialize(), /upstream detail|canary/i);
    };
    await attempt('wrong', "That didn't work. Check your password and try again.");
    assert.equal(input().getAttribute('aria-invalid'), 'true');
    // An empty password is refused before any call.
    const calls = page.requests.length;
    enterPassword(page, '');
    assert.equal(message(page), "That didn't work. Check your password and try again.");
    assert.equal(page.requests.length, calls);
    // The gateway's per-client limit: the household's other sign-in attempts used it up.
    for (let attempts = 0; attempts < 20; attempts += 1) {
      const answer = await post(app.port, '/Users/AuthenticateByName', { Host: HOST_A, Authorization: 'MediaBrowser Client="x", Device="y", DeviceId="zzzzzzzzzzzzzzzz", Version="1"' }, { Username: 'Alice', Pw: 'no' });
      if (answer.status === 429) break;
    }
    await attempt('alice-pass', 'Too many attempts. Wait a few minutes, then try again.');
    assert.equal(app.jellyfin.signIns.length, 0, 'the limited attempt never reached Jellyfin');
    assert.equal(page.store.get('jellyfin_credentials'), undefined);
  });

  it('shows fixed text when Jellyfin is down, the network is gone or storage refuses the sign-in', async (t) => {
    const app = await signInApp(t);
    const outage = await openApp(t, app, { signedIn: false });
    await outage.until(() => outage.main().querySelector('ul.profiles'), 'the picker');
    // Jellyfin goes down after the picker loaded: the gateway cannot check the name, for a member as for anyone.
    app.jellyfin.down = true;
    click(outage, profileButton(outage, 'Ann'));
    await outage.until(() => message(outage), 'the outage message');
    assert.equal(message(outage), "Can't sign in right now. Try again in a moment.");
    assert.ok(outage.main().querySelector('ul.profiles'), 'the picker stays, with its buttons usable again');
    assert.ok([...outage.main().querySelectorAll('button.profile')].every((button) => !button.disabled));
    assert.doesNotMatch(outage.serialize(), /upstream detail/);
    app.jellyfin.down = false;

    const offline = await openApp(t, app, { signedIn: false, override: (url) => { if (url === '/Users/AuthenticateByName') throw new TypeError('network'); } });
    await offline.until(() => offline.main().querySelector('ul.profiles'), 'the picker');
    click(offline, profileButton(offline, 'Ann'));
    await offline.until(() => message(offline), 'the offline message');
    assert.equal(message(offline), 'Check your connection, then try again.');

    const refusing = await openApp(t, app, { signedIn: false, storageFails: true });
    await refusing.until(() => refusing.main().querySelector('ul.profiles'), 'the picker');
    click(refusing, profileButton(refusing, 'Ann'));
    await refusing.until(() => message(refusing), 'the storage message');
    assert.equal(message(refusing), "Can't keep your sign-in on this device. Allow site data for this page in your browser settings, then try again.");
    assert.equal(refusing.requests.some((request) => request.url.startsWith('/jellypass/app/v1/')), false);
  });

  it('shows fixed text and a retry when the profiles cannot be loaded, and still offers Jellyfin web', async (t) => {
    const app = await signInApp(t);
    let fail = true;
    const page = await openApp(t, app, {
      signedIn: false,
      override: (url) => (fail && url === '/Users/Public' ? { status: 502, body: Buffer.from('{"error":"jellyfin_unavailable"}'), headers: {} } : undefined),
    });
    await page.until(() => page.main().querySelector('button'), 'the failure');
    assert.equal(page.main().querySelector('h1').textContent, 'Sign in');
    assert.match(page.main().textContent, /Can't sign in right now\. Try again in a moment\./);
    assert.doesNotMatch(page.main().textContent, /jellyfin_unavailable/);
    assert.equal(page.main().querySelector('a').getAttribute('href'), '/web/');
    fail = false;
    click(page, page.main().querySelector('button'));
    await page.until(() => page.main().querySelector('ul.profiles'), 'the picker after retrying');
  });

  it('says a sign-in has expired when Jellyfin refuses the one it holds, and replaces it on signing in again', async (t) => {
    const app = await signInApp(t);
    const page = await openApp(t, app, { store: new Map([['jellyfin_credentials', JSON.stringify({
      Servers: [{ Id: 'server', ManualAddress: `https://${HOST_A}`, AccessToken: 'token-revoked', UserId: ALICE }],
    })]]) });
    await page.until(() => page.main().querySelector('ul.profiles'), 'the picker');
    assert.match(page.main().textContent, /Your sign-in has expired/);
    assert.equal(page.document.getElementById('signout'), null);
    click(page, profileButton(page, 'Ann'));
    await homeLoaded(page);
    assert.equal(credentials(page).Servers[0].AccessToken, app.jellyfin.signIns[0].token);
    assert.equal(credentials(page).Servers.length, 1);
  });

  it('signs out: revokes the token at Jellyfin, clears the stored sign-in and shows the picker again', async (t) => {
    const app = await signInApp(t);
    const page = await openApp(t, app, { signedIn: false });
    await page.until(() => page.main().querySelector('ul.profiles'), 'the picker');
    click(page, profileButton(page, 'Ann'));
    await homeLoaded(page);
    const { token } = app.jellyfin.signIns[0];
    assert.equal((await app.get('/jellypass/app/v1/me', { headers: { Authorization: `MediaBrowser Token="${token}"` }, user: null })).status, 200);
    await signOutFromAbout(page);
    assert.deepEqual(app.jellyfin.logouts, [token]);
    const logout = page.requests.find((request) => request.url === '/Sessions/Logout');
    assert.equal(logout.init.method, 'POST');
    assert.equal(logout.init.headers.Authorization, `MediaBrowser Token="${token}"`);
    assert.equal(logout.init.credentials, 'omit');
    // What Jellyfin web would find: the server entry stays, without a user or token.
    const [server] = credentials(page).Servers;
    assert.equal(server.Id, 'server');
    assert.equal(server.ManualAddress, page.location.origin);
    assert.equal(server.AccessToken, undefined);
    assert.equal(server.UserId, undefined);
    assert.equal(page.document.getElementById('signout'), null, 'no Sign out once signed out');
    // Dead at Jellyfin, and so for Jellyfin web (the app API keeps trusting a token it has just verified for a few minutes).
    assert.equal((await app.get('/Users/Me', { headers: { Authorization: `MediaBrowser Token="${token}"` }, user: null })).status, 401, 'the token is dead at Jellyfin');
    // The device ID stays, so the next sign-in is the same device.
    assert.match(page.store.get('jellypass_device_id'), /^jellypass-/);
  });

  it('signs out of this browser even when Jellyfin cannot be reached', async (t) => {
    const app = await signInApp(t);
    const page = await openApp(t, app, { override: (url) => { if (url === '/Sessions/Logout') throw new TypeError('network'); } });
    await homeLoaded(page);
    await signOutFromAbout(page);
    assert.equal(credentials(page).Servers[0].AccessToken, undefined);
  });

  it('follows a sign-in or sign-out made elsewhere on this address without a reload', async (t) => {
    const app = await signInApp(t);
    const page = await openApp(t, app, { signedIn: false });
    await page.until(() => page.main().querySelector('ul.profiles'), 'the picker');
    // Jellyfin web (another tab) signs in.
    page.store.set('jellyfin_credentials', JSON.stringify({ Servers: [{ ManualAddress: page.location.origin, AccessToken: TOKENS[ALICE], UserId: ALICE }] }));
    for (const listener of page.listeners.storage ?? []) listener({ key: 'jellyfin_credentials' });
    await homeLoaded(page);
    // And signs out again.
    page.store.set('jellyfin_credentials', JSON.stringify({ Servers: [{ ManualAddress: page.location.origin }] }));
    for (const listener of page.listeners.storage ?? []) listener({ key: 'jellyfin_credentials' });
    await page.until(() => page.main().querySelector('ul.profiles'), 'the picker after signing out elsewhere');
  });

  it('shows the fixed state for an expired sign-in (401), a rate limit (429) and a failure (502), never upstream text', async (t) => {
    const app = await startApp(t, world({ failCatalogue: 500 }));
    // 401: the token Jellyfin web holds is no longer valid.
    const expired = await openApp(t, app, { user: ALICE });
    expired.store.set('jellyfin_credentials', JSON.stringify({ Servers: [{ ManualAddress: expired.location.origin, AccessToken: 'token-revoked', UserId: ALICE }] }));
    expired.go('#/');
    await expired.until(() => expired.main().querySelector('ul.profiles'), 'the sign-in state');
    assert.equal(expired.main().querySelector('h1').textContent, 'Sign in');
    assert.equal(expired.main().querySelector('a').getAttribute('href'), '/web/');

    // 502: TMDB is failing, so every row says so in fixed words (and the app answered 502 with its fixed body).
    const failing = await openApp(t, app);
    await failing.until(() => failing.main().querySelectorAll('.row .notice').length === 4, 'four failed rows');
    for (const title of failing.main().querySelectorAll('.notice-title')) assert.equal(title.textContent, "Can't load this right now");
    assert.equal(failing.main().querySelectorAll('.row-heading').length, 4, 'each row keeps its name');
    assert.equal(failing.main().querySelectorAll('.notice button').length, 4, 'and its own retry');
    assert.doesNotMatch(failing.serialize(), /canary|upstream/i);
    const before = failing.requests.length;
    failing.main().querySelector('.notice button').dispatchEvent(new failing.Event('click'));
    await failing.until(() => failing.requests.length > before, 'a retry');

    // 429 on every call, and a title page that failed.
    const limited = await openApp(t, app, { override: () => ({ status: 429, body: Buffer.from('{"error":"too_many_requests"}'), headers: {} }) });
    await limited.until(() => limited.main().querySelector('h1')?.textContent === 'Too many requests', 'the rate limit state');
    assert.equal(limited.main().querySelector('p').textContent, 'Wait a minute, then try again.');
    limited.go(`#/movie/${OWN_MOVIE}`);
    await limited.until(() => limited.main().querySelector('button'), 'the title error');
    assert.equal(limited.main().querySelector('h1').textContent, 'Too many requests');

    // A title TMDB does not know.
    const healthy = await startApp(t);
    const missing = await openApp(t, healthy);
    missing.go('#/movie/1');
    await missing.until(() => missing.main().querySelector('h1')?.textContent === 'Not found', 'the not-found state');
    assert.ok(missing.main().querySelector('button') === null);
  });

  describe('"Get this" and "My requests" against the API', () => {
    const POST_HEADERS = { Authorization: 'MediaBrowser Token="token-alice"', 'Content-Type': 'application/json' };
    const posts = (page) => page.requests.filter((request) => request.init.method === 'POST');
    const hold = () => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      return { gate, release };
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

    it('asks for a movie: disables the button while the call is in flight, confirms, and shows the state afterwards', async (t) => {
      const app = await startApp(t);
      const { gate, release } = hold();
      const page = await openApp(t, app, { hash: `#/movie/${T_MOVIE}`, override: async (url, init) => { if (init.method === 'POST') await gate; return undefined; } });
      const button = await page.until(() => page.main().querySelector('button'), 'the Get this button');
      assert.equal(button.textContent, 'Get this');
      assert.equal(page.main().querySelector('.badge').textContent, 'Available to get');
      assert.equal(page.main().textContent.includes('soon'), false);
      button.dispatchEvent(new page.Event('click'));
      assert.equal(button.disabled, true);
      assert.equal(button.textContent, 'Sending…');
      button.dispatchEvent(new page.Event('click'));
      await page.until(() => posts(page).length === 1, 'the call');
      release();
      await page.until(() => page.main().querySelector('.get-message')?.textContent, 'the confirmation');
      assert.equal(page.main().querySelector('.get-message').textContent, "Thanks — we'll get this for your household.");
      assert.equal(posts(page).length, 1, 'a second press while in flight sent nothing');
      const [post] = posts(page);
      assert.equal(post.url, `/jellypass/app/v1/movie/${T_MOVIE}/get`);
      assert.equal(post.init.body, '{}');
      assert.equal(post.init.cache, 'no-store');
      assert.equal(post.init.credentials, 'omit');
      assert.deepEqual({ ...post.init.headers }, { Accept: 'application/json', ...POST_HEADERS });
      // The title is read again after the accepted answer.
      assert.ok(page.requests.filter((request) => request.url === `/jellypass/app/v1/movie/${T_MOVIE}`).length >= 2);
      assert.equal(page.focused()?.className, 'get-message');
      await app.background.settled();
      // Once the household has asked, the title says so, in the one coarse word.
      page.go('#/');
      page.go(`#/movie/${T_MOVIE}`);
      await page.until(() => page.main().querySelector('.badge')?.textContent === 'Requested', 'Requested');
      assert.ok(page.main().querySelector('button') === null);
      assert.ok(page.main().querySelector('.get-message') === null);
      assertNoCanaries(page.serialize(), 'after Get this');
    });

    it('gives the same confirmation whatever the household, the title or Seerr already had', async (t) => {
      const worlds = { baseline: world(), ...Object.fromEntries(Object.entries(otherHouseholdWorlds()).filter(([name]) => !name.startsWith('large'))) };
      const seen = {};
      const shapes = {};
      for (const [name, state] of Object.entries(worlds)) {
        const app = await startApp(t, state, { reconcile: true });
        const page = await openApp(t, app, { hash: `#/movie/${T_MOVIE}` });
        const button = await page.until(() => page.main().querySelector('button'), `${name}: the button`);
        button.dispatchEvent(new page.Event('click'));
        await page.until(() => page.main().querySelector('.get-message')?.textContent, `${name}: the confirmation`);
        seen[name] = page.main().querySelector('.get-message').textContent;
        shapes[name] = { role: page.main().querySelector('.get-message').getAttribute('role'), error: page.main().querySelector('.get-error') !== null, posts: posts(page).length };
        await app.background.settled();
      }
      assert.ok(Object.keys(seen).length >= 5, Object.keys(seen).join());
      for (const [name, text] of Object.entries(seen)) assert.equal(text, "Thanks — we'll get this for your household.", name);
      for (const [name, shape] of Object.entries(shapes)) assert.deepEqual(shape, { role: 'status', error: false, posts: 1 }, name);
    });

    it('is indistinguishable for every backend outcome: the same DOM, the same follow-up requests, the same refresh', async (t) => {
      const others = otherHouseholdWorlds();
      const outcomes = {
        'a real request': world(),
        'a join': others['a private grant'],
        'an interest': others['a pending request'],
        'nothing to do': world(),
      };
      // The page's own account of what it did: every request, how it was made, minus the abort signal.
      const trace = (page) => page.requests.map(({ url, init }) => JSON.stringify({
        url, method: init.method ?? 'GET', body: init.body ?? null, cache: init.cache ?? null, credentials: init.credentials ?? null,
        headers: { ...init.headers },
      }));
      // The title as it reads before anything happened, to open a page that still offers Get this for 'nothing to do'.
      const fresh = await startApp(t);
      const stale = await get(fresh.port, `/jellypass/app/v1/movie/${T_MOVIE}`, { Host: HOST_A, Authorization: POST_HEADERS.Authorization });
      assert.equal(stale.status, 200);
      const seen = {};
      for (const [name, state] of Object.entries(outcomes)) {
        const app = await startApp(t, state, { reconcile: true });
        if (name === 'nothing to do') {
          // The household asked a moment ago (another tab); this page was loaded before and still offers the button.
          await post(app.port, `/jellypass/app/v1/movie/${T_MOVIE}/get`, { Host: HOST_A, ...POST_HEADERS }, undefined);
          await app.background.settled();
        }
        // What the server says about the title is its own matter (and tested against the API). The app is held to what
        // it does with an accepted call, so every follow-up read of the title gets the same answer here.
        let asked = false;
        let loaded = name !== 'nothing to do';
        const override = (url, init) => {
          if (init.method === 'POST') { asked = true; return undefined; }
          if (url !== `/jellypass/app/v1/movie/${T_MOVIE}`) return undefined;
          if (asked || !loaded) { loaded = true; return stale; }
          return undefined;
        };
        const page = await openApp(t, app, { hash: `#/movie/${T_MOVIE}`, override });
        const button = await page.until(() => page.main().querySelector('button'), `${name}: the button`);
        const before = page.requests.length;
        button.dispatchEvent(new page.Event('click'));
        await page.until(() => page.main().querySelector('.get-message')?.textContent && page.requests.length > before + 1, `${name}: the confirmation and the refresh`);
        await app.background.settled();
        await settle();
        seen[name] = { html: page.serialize(), calls: trace(page), after: trace(page).slice(before) };
      }
      const [first, ...rest] = Object.entries(seen);
      assert.ok(first[1].after.length >= 2, 'the POST and at least one refresh');
      assert.ok(first[1].after[0].includes('"method":"POST"'));
      assert.ok(first[1].after.slice(1).every((call) => call.includes('"method":"GET"')));
      for (const [name, outcome] of rest) {
        assert.deepEqual(outcome.calls, first[1].calls, `${name}: the requests the app made`);
        assert.deepEqual(outcome.after, first[1].after, `${name}: the follow-up requests`);
        if (outcome.html !== first[1].html) {
          const at = [...outcome.html].findIndex((char, index) => char !== first[1].html[index]);
          assert.fail(`${name}: the rendered DOM differs from ${first[0]} at ${at}: ${outcome.html.slice(at - 200, at + 200)} <> ${first[1].html.slice(at - 200, at + 200)}`);
        }
      }
    });

    it('keeps the confirmation, offers nothing that would send again and a retry when the call was accepted but the refresh failed', async (t) => {
      const app = await startApp(t);
      let accepted = false;
      let broken = true;
      const page = await openApp(t, app, {
        hash: `#/movie/${T_MOVIE}`,
        override: (url, init) => {
          if (init.method === 'POST') { accepted = true; return undefined; }
          if (accepted && broken && url === `/jellypass/app/v1/movie/${T_MOVIE}`) return { status: 502, body: Buffer.from('{"error":"canary upstream text"}'), headers: {} };
          return undefined;
        },
      });
      const button = await page.until(() => page.main().querySelector('button'), 'the button');
      button.dispatchEvent(new page.Event('click'));
      const retry = await page.until(() => page.main().querySelector('.get-refresh') && page.main().querySelector('button'), 'the refresh error and the retry');
      assert.equal(page.main().querySelector('.get-message').textContent, "Thanks — we'll get this for your household.");
      assert.equal(page.main().querySelector('.get-refresh').textContent, 'Something went wrong. Try again in a moment.');
      assert.equal(page.main().querySelector('.get-error'), null);
      assert.equal(page.main().querySelectorAll('button').length, 1, 'only the retry');
      assert.equal(retry.textContent, 'Try again');
      assert.ok(retry !== button && page.main().textContent.includes('Sending') === false);
      assert.doesNotMatch(page.serialize(), /canary|upstream/i);
      assert.equal(posts(page).length, 1);
      broken = false;
      retry.dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelector('.badge') && page.main().querySelector('.get-refresh') === null, 'the page loaded again');
      assert.ok(!page.main().textContent.includes('Thanks'), 'a page loaded again carries no confirmation');
      assert.equal(posts(page).length, 1, 'the retry sent nothing');
      await app.background.settled();
    });

    it('asks for chosen seasons of a series, and only those the API marks requestable', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app, { hash: `#/tv/${T_TV}` });
      await page.until(() => page.main().querySelector('fieldset.get-seasons'), 'the season picker');
      const boxes = [...page.main().querySelectorAll('input[type="checkbox"]')];
      assert.deepEqual(boxes.map((box) => box.value), ['1', '2']);
      const button = page.main().querySelector('button');
      assert.equal(button.disabled, true);
      boxes[1].checked = true;
      boxes[1].dispatchEvent(new page.Event('change'));
      button.dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelector('.get-message')?.textContent, 'the confirmation');
      assert.equal(page.main().querySelector('.get-message').textContent, "Thanks — we'll get this for your household.");
      assert.equal(posts(page).length, 1);
      assert.equal(posts(page)[0].url, `/jellypass/app/v1/tv/${T_TV}/get`);
      assert.equal(posts(page)[0].init.body, '{"seasons":[2]}');
      // Season 2 was just asked for: only season 1 is offered again on this screen.
      assert.deepEqual([...page.main().querySelectorAll('input[type="checkbox"]')].map((box) => box.value), ['1']);
      await app.background.settled();
    });

    it('asks for a season from its page', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app, { hash: `#/tv/${T_TV}/season/1` });
      const button = await page.until(() => page.main().querySelector('button'), 'the season button');
      assert.ok(page.main().querySelector('fieldset') === null);
      button.dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelector('.get-message')?.textContent, 'the confirmation');
      assert.equal(posts(page)[0].init.body, '{"seasons":[1]}');
      assert.equal(page.main().querySelector('h1').textContent, 'Season 1');
      await app.background.settled();
    });

    it('shows no button for a title the caller can already play, and none where the API says it cannot be requested', async (t) => {
      const app = await startApp(t);
      const held = await openApp(t, app, { hash: `#/movie/${OWN_MOVIE}` });
      await held.until(() => held.main().querySelector('a.button'), 'Play');
      assert.ok(held.main().querySelector('button') === null);
      assert.equal(held.main().querySelector('.badge').textContent, 'Ready to watch');
      const blocked = await startApp(t, world({ seerrUsers: { 11: { jellyfinUserId: ALICE, permissions: 0 } } }));
      const page = await openApp(t, blocked, { hash: `#/movie/${T_MOVIE}` });
      await page.until(() => page.main().querySelector('.badge'), 'the badge');
      assert.equal(page.main().querySelector('.badge').textContent, "Can't request");
      assert.ok(page.main().querySelector('button') === null);
      assert.equal(posts(page).length, 0);
    });

    it('answers 401, 429, offline and server errors with fixed words, and lets the person try again', async (t) => {
      const app = await startApp(t);
      const answer = (status) => ({ status, body: Buffer.from('{"error":"canary upstream text"}'), headers: {} });
      let mode = 'limited';
      const page = await openApp(t, app, {
        hash: `#/movie/${T_MOVIE}`,
        override: (url, init) => {
          if (init.method !== 'POST') return undefined;
          if (mode === 'limited') return answer(429);
          if (mode === 'server') return answer(502);
          if (mode === 'invalid') return answer(400);
          if (mode === 'offline') throw new TypeError('network canary');
          if (mode === 'unauthorized') return answer(401);
          return undefined;
        },
      });
      const button = await page.until(() => page.main().querySelector('button'), 'the button');
      const press = async () => {
        const before = posts(page).length;
        page.main().querySelector('button').dispatchEvent(new page.Event('click'));
        await page.until(() => posts(page).length > before, 'the call');
        await page.until(() => !page.main().querySelector('button')?.disabled, 'the answer');
        return page.main().querySelector('.get-message').textContent;
      };
      assert.equal(await press(), 'Too many tries, try again in a few minutes.');
      mode = 'offline';
      assert.equal(await press(), "You're offline. Check your connection, then try again.");
      for (const failing of ['server', 'invalid']) {
        mode = failing;
        assert.equal(await press(), "We couldn't send that just now. Try again in a moment.", failing);
      }
      assert.ok(page.main().querySelector('button') === button, 'the same button, ready again');
      assert.equal(button.textContent, 'Get this');
      assert.doesNotMatch(page.serialize(), /canary|upstream/i);
      // Then it works, with the same confirmation.
      mode = 'ok';
      button.dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelector('.get-message')?.textContent, 'the confirmation');
      assert.equal(page.main().querySelector('.get-message').textContent, "Thanks — we'll get this for your household.");
      await app.background.settled();

      // A 401 sends the person back to sign-in.
      mode = 'unauthorized';
      const signedOut = await openApp(t, await startApp(t), { hash: `#/movie/${T_MOVIE}`, override: (url, init) => (init.method === 'POST' ? answer(401) : undefined) });
      (await signedOut.until(() => signedOut.main().querySelector('button'), 'the button')).dispatchEvent(new signedOut.Event('click'));
      await signedOut.until(() => signedOut.main().querySelector('[data-screen="signin"] h1')?.textContent === 'Sign in', 'the sign-in state');
    });

    it('lists the household\'s requests with coarse states, per season, and who asked', async (t) => {
      const app = await startApp(t);
      const asker = await openApp(t, app, { hash: `#/movie/${T_MOVIE}` });
      (await asker.until(() => asker.main().querySelector('button'), 'the button')).dispatchEvent(new asker.Event('click'));
      await asker.until(() => asker.main().querySelector('.get-message')?.textContent, 'the confirmation');
      asker.go(`#/tv/${T_TV}`);
      const picker = await asker.until(() => asker.main().querySelector('input[type="checkbox"]'), 'the series');
      picker.checked = true;
      picker.dispatchEvent(new asker.Event('change'));
      asker.main().querySelector('button').dispatchEvent(new asker.Event('click'));
      await asker.until(() => asker.main().querySelector('.get-message')?.textContent, 'the series confirmation');
      await app.background.settled();

      const page = await openApp(t, app, { hash: '#/requests' });
      await page.until(() => page.main().querySelectorAll('.request .card-title').length === 2
        && [...page.main().querySelectorAll('.request .card-title')].every((title) => title.textContent !== 'Loading title…'), 'the requests');
      assert.equal(page.main().querySelector('h1').textContent, 'My requests');
      assert.equal(page.document.title, 'My requests – JellyPass');
      assert.equal(page.document.querySelector('nav a[aria-current="page"]').dataset.nav, 'requests');
      assert.equal(page.document.querySelector('nav a[data-nav="requests"]').textContent, 'My requests');
      const items = [...page.main().querySelectorAll('.request')];
      const byTitle = Object.fromEntries(items.map((item) => [item.querySelector('.card-title').textContent, item]));
      assert.deepEqual(Object.keys(byTitle).sort(), ['Synthetic Movie One', 'Synthetic Series Two']);
      const movie = byTitle['Synthetic Movie One'];
      assert.equal(movie.querySelector(':scope > .badge').textContent, 'Requested');
      assert.equal(movie.querySelector('.request-who').textContent, 'Asked for by you');
      assert.equal(movie.querySelector('.request-link').getAttribute('href'), `#/movie/${T_MOVIE}`);
      const series = byTitle['Synthetic Series Two'];
      assert.deepEqual([...series.querySelectorAll('.request-season')].map((season) => season.textContent), ['Season 1Requested']);
      assert.equal(page.main().querySelector('button.load-more').hidden, true, 'one page of two needs no Load more');
      assert.ok(page.requests.some((request) => request.url === '/jellypass/app/v1/requests'));
      assertNoCanaries(page.serialize(), 'My requests');

      // Another member of the household sees the same list, not marked as theirs.
      const ann = await openApp(t, app, { hash: '#/requests', user: ANN });
      await ann.until(() => ann.main().querySelectorAll('.request-who').length === 2, 'Ann\'s list');
      assert.deepEqual([...ann.main().querySelectorAll('.request-who')].map((who) => who.textContent), ['Asked for by someone in your household', 'Asked for by someone in your household']);
    });

    it('shows an empty state, a retry on error, and loads a long list ten titles at a time', async (t) => {
      const app = await startApp(t);
      const empty = await openApp(t, app, { hash: '#/requests' });
      await empty.until(() => empty.main().querySelector('p.muted'), 'the empty state');
      assert.equal(empty.main().querySelector('p.muted').textContent, 'Nothing requested yet. Press Get this on a title to ask for it.');
      assert.equal(empty.main().querySelector('h1').textContent, 'My requests');

      let failing = true;
      const flaky = await openApp(t, app, { hash: '#/requests', override: (url) => (failing && url === '/jellypass/app/v1/requests' ? { status: 502, body: Buffer.from('{"error":"canary"}'), headers: {} } : undefined) });
      await flaky.until(() => flaky.main().querySelector('[role="alert"]'), 'the error');
      assert.equal(flaky.main().querySelector('h1').textContent, "Can't load this right now");
      assert.doesNotMatch(flaky.serialize(), /canary/i);
      failing = false;
      flaky.main().querySelector('.notice button').dispatchEvent(new flaky.Event('click'));
      await flaky.until(() => flaky.main().querySelector('p.muted')?.textContent.startsWith('Nothing requested'), 'the list after a retry');

      const results = Array.from({ length: 25 }, (_, index) => ({
        id: `id${index}`, mediaType: 'movie', tmdbId: index % 2 ? T_MOVIE : OWN_MOVIE, status: ['requested', 'ready', 'failed'][index % 3], seasons: [], byYou: index % 2 === 0,
      }));
      const long = await openApp(t, app, { hash: '#/requests', override: (url) => (url === '/jellypass/app/v1/requests' ? { status: 200, body: Buffer.from(JSON.stringify({ results })), headers: { 'content-type': 'application/json' } } : undefined) });
      await long.until(() => long.main().querySelectorAll('.request').length === 10, 'ten requests');
      await long.until(() => [...long.main().querySelectorAll('.request .card-title')].every((title) => title.textContent !== 'Loading title…'), 'their titles');
      const titleCalls = () => long.requests.filter((request) => /\/movie\/\d+$/.test(request.url)).length;
      assert.equal(titleCalls(), 10, 'titles are read ten at a time');
      assert.deepEqual([...long.main().querySelectorAll(':scope .request > .badge')].slice(0, 3).map((badge) => badge.textContent), ['Requested', 'Ready to watch', "We couldn't get this"]);
      const more = long.main().querySelector('button.load-more');
      assert.equal(more.hidden, false);
      more.dispatchEvent(new long.Event('click'));
      await long.until(() => long.main().querySelectorAll('.request').length === 20, 'twenty requests');
      more.dispatchEvent(new long.Event('click'));
      await long.until(() => long.main().querySelectorAll('.request').length === 25, 'all requests');
      assert.equal(more.hidden, true);
      assert.ok(long.main().querySelectorAll('.request .card-title').length === 25);
      await long.until(() => [...long.main().querySelectorAll('.request .card-title')].every((title) => title.textContent !== 'Loading title…'), 'all titles');
    });

    it('marks a title the household asked for that failed as "We couldn\'t get this", and keeps working without the list', async (t) => {
      const app = await startApp(t);
      const failed = { results: [{ id: 'x', mediaType: 'movie', tmdbId: T_MOVIE, status: 'failed', seasons: [], byYou: true }] };
      const body = (value) => ({ status: 200, body: Buffer.from(JSON.stringify(value)), headers: { 'content-type': 'application/json' } });
      const page = await openApp(t, app, { hash: `#/movie/${T_MOVIE}`, override: (url) => (url === '/jellypass/app/v1/requests' ? body(failed) : undefined) });
      await page.until(() => page.main().querySelector('.failed-note'), 'the note');
      assert.equal(page.main().querySelector('.badge').textContent, "We couldn't get this");
      assert.ok(page.main().querySelector('button') === null, 'no Get this for a failed title');
      // A failing list never breaks the title.
      const broken = await openApp(t, app, { hash: `#/movie/${T_MOVIE}`, override: (url) => (url === '/jellypass/app/v1/requests' ? { status: 502, body: Buffer.from('{}'), headers: {} } : undefined) });
      await broken.until(() => broken.main().querySelector('button'), 'the button');
      assert.equal(broken.main().querySelector('.badge').textContent, 'Available to get');
      assert.ok(broken.main().querySelector('[role="alert"]') === null);
      const seasonsFailed = { results: [{ id: 'y', mediaType: 'tv', tmdbId: T_TV, status: 'failed', seasons: [{ seasonNumber: 2, status: 'failed' }], byYou: false }] };
      const series = await openApp(t, app, { hash: `#/tv/${T_TV}`, override: (url) => (url === '/jellypass/app/v1/requests' ? body(seasonsFailed) : undefined) });
      await series.until(() => series.main().querySelector('.season-list'), 'the series');
      assert.deepEqual([...series.main().querySelectorAll('.season .badge')].map((badge) => badge.textContent), ['Available to get', "We couldn't get this"]);
      assert.deepEqual([...series.main().querySelectorAll('input[type="checkbox"]')].map((box) => box.value), ['1']);
      assert.equal(series.main().querySelector('.failed-note').textContent, 'Ask your JellyPass admin to try again.');
      await settle();
    });

    it('keeps the service worker, scope and API caching rules: nothing under the API is cached or fingerprinted', async (t) => {
      const worker = read('sw.js');
      assert.match(worker, /const API_PREFIX = '\/jellypass\/app\/v1\/'/);
      assert.doesNotMatch(worker, /requests/, 'the worker names no API path');
      assert.match(read('index.html'), /data-nav="requests"/);
      assert.equal(JSON.parse(read(BUILT('manifest.webmanifest'))).scope, '/');
      const sources = FILES.filter((name) => name.startsWith('js/')).map((name) => read(name)).join('\n');
      assert.doesNotMatch(sources, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
      assert.doesNotMatch(sources, /localStorage\.setItem|sessionStorage|indexedDB|caches\./, 'the app still keeps nothing');
      await settle();
      t.diagnostic('checked');
    });
  });
});
