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
import { ALICE, ANN, BOB, CAROL, HOST_A, HOST_B, OUTSIDER, OWN_MOVIE, T_MOVIE, T_TV, TOKENS, get, post, startApp, world } from './support/household-app.mjs';
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
const shape = (answer) => ({ status: answer.status, text: answer.text, headers: answer.headers });

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
        assert.match(url, /^https:\/\/(?:www\.themoviedb\.org\/?|image\.tmdb\.org\/t\/p\/.*|image\\\.tmdb.*)$/, `${file} mentions ${url}`);
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
    const tokens = Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*(#[0-9a-f]{6});/gi)].map((match) => [match[1], match[2]]));
    const luminance = (hex) => {
      const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255)
        .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
      return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
    };
    const ratio = (a, b) => {
      const [high, low] = [luminance(tokens[a]), luminance(tokens[b])].sort((x, y) => y - x);
      return (high + 0.05) / (low + 0.05);
    };
    const pairs = [
      ['text', 'bg'], ['text', 'surface'], ['text', 'surface-raised'], ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-raised'],
      ['accent', 'bg'], ['accent', 'surface'], ['on-accent', 'accent'],
      ['badge-library-text', 'badge-library-bg'], ['badge-soon-text', 'badge-soon-bg'], ['badge-no-text', 'badge-no-bg'],
      ['badge-requested-text', 'badge-requested-bg'],
    ];
    for (const [foreground, background] of pairs) {
      assert.ok(tokens[foreground] && tokens[background], `${foreground} on ${background} are tokens`);
      assert.ok(ratio(foreground, background) >= 4.5, `${foreground} on ${background}: ${ratio(foreground, background).toFixed(2)}`);
    }
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.match(css, /env\(safe-area-inset-bottom\)/);
    assert.match(css, /:focus-visible/);
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

  it('shows each household state as its own coarse badge, and Play only for a title in the library', async () => {
    const { document, cardItem, STATE_LABELS } = await renderer();
    assert.deepEqual(STATE_LABELS, {
      in_library: 'In your library',
      get_this: 'Available to request soon',
      unavailable: "Can't request",
      requested: 'Requested',
    });
    const cases = [
      ['in_library', play, true],
      ['get_this', null, false],
      ['unavailable', null, false],
      ['requested', null, false],
      // A link the API never builds for a state that has none is not shown, whatever the DTO carries.
      ['get_this', play, false],
      ['unavailable', play, false],
    ];
    for (const [state, link, expectPlay] of cases) {
      const item = cardItem(document, card({ state, play: link }), origin);
      const badges = item.querySelectorAll('.badge');
      assert.equal(badges.length, 1, state);
      assert.equal(badges[0].textContent, STATE_LABELS[state]);
      assert.ok(badges[0].classList.contains(`badge-${state}`));
      const button = [...item.querySelectorAll('a')].find((anchor) => anchor.textContent === 'Play');
      assert.equal(Boolean(button), expectPlay, `${state} play`);
      if (button) {
        assert.equal(button.getAttribute('href'), `${origin}/web/#/details?id=${itemId}`);
        assert.equal(button.getAttribute('aria-label'), 'Play Synthetic Movie Three');
        assert.equal(button.getAttribute('rel'), 'noopener');
      }
      assert.equal(item.querySelector('.card-link').getAttribute('href'), '#/movie/900003');
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
      assert.equal(cardItem(document, card({ state: 'in_library', play: bad }), origin).querySelectorAll('a').length, 1);
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
    assert.equal(movie.querySelector('.badge').textContent, 'In your library');
    assert.equal(movie.querySelector('a.button').getAttribute('href'), play.url);
    assert.equal(movie.querySelector('.seasons'), null);

    const series = titleDetail(document, {
      ...card({ mediaType: 'tv', tmdbId: 900002, title: 'Synthetic Series Two', state: 'get_this' }), genres: [], runtime: 45,
      seasons: [
        { seasonNumber: 1, name: 'Season 1', episodeCount: 8, state: 'in_library' },
        { seasonNumber: 2, name: 'Season 2', episodeCount: 1, state: 'get_this' },
        { seasonNumber: 3, name: '', episodeCount: null, state: 'unavailable' },
      ],
    }, origin);
    assert.equal(series.querySelector('a.button'), null, 'no Play, and no request button, without the title in the library');
    assert.equal(series.querySelector('button'), null);
    const seasons = [...series.querySelectorAll('.season')];
    assert.deepEqual(seasons.map((season) => season.querySelector('.badge').textContent), ['In your library', 'Available to request soon', "Can't request"]);
    assert.deepEqual(seasons.map((season) => season.querySelector('a').getAttribute('href')),
      ['#/tv/900002/season/1', '#/tv/900002/season/2', '#/tv/900002/season/3']);
    assert.deepEqual(seasons.map((season) => season.querySelector('.card-meta').textContent), ['8 episodes', '1 episode', '']);
    assert.equal(seasons[2].querySelector('.season-name').textContent, 'Season 3');
    assert.match(series.querySelector('.detail-text .muted').textContent, /Requesting isn't switched on yet/);

    const season = seasonView(document, {
      tmdbId: 900002, seasonNumber: 1, name: 'Season 1', overview: 'Season text.', state: 'in_library',
      episodes: [{ episodeNumber: 1, name: 'Pilot', overview: 'First.' }, { episodeNumber: 2, name: '', overview: '' }],
    }, 'Synthetic Series Two');
    assert.equal(season.querySelector('a.back').getAttribute('href'), '#/tv/900002');
    assert.equal(season.querySelector('h1').textContent, 'Season 1');
    assert.equal(season.querySelector('.badge').textContent, 'In your library');
    assert.deepEqual([...season.querySelectorAll('.episode-title')].map((title) => title.textContent), ['1. Pilot', '2. Episode 2']);
    assert.equal(season.querySelector('a.button'), null);
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
});

describe('household app page: running against the API', { timeout: 60_000 }, () => {
  /**
   * Loads the real page and client modules into a DOM, signed in as `user` with Jellyfin web's own stored sign-in, and
   * wires `fetch` to the real API on the test server. One page per test (the client keeps its state in module scope).
   */
  async function openApp(t, app, { user = ALICE, host = HOST_A, signedIn = true, override, hash = '', holdMe, store: initialStore, storageFails = false, userAgent = '' } = {}) {
    const origin = `https://${host}`;
    const { document, Event } = parseHTML(read('index.html'));
    const store = new Map(initialStore ?? (signedIn ? [['jellyfin_credentials', JSON.stringify({
      Servers: [{ ManualAddress: origin, AccessToken: TOKENS[user], UserId: user }],
    })]] : []));
    const requests = [];
    const location = { origin, hash };
    const listeners = {};
    const globals = {
      document,
      window: {
        scrollTo() {},
        addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
        // The page's network is the test server; Node's own fetch (used by the server itself) is left alone.
        fetch: async (url, init = {}) => {
          requests.push({ url, init });
          if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
          if (holdMe && url === '/jellypass/app/v1/me') await holdMe;
          const answer = override?.(url, init) ?? await (init.method === 'POST'
            ? post(app.port, url, { Host: host, ...init.headers }, init.body ? JSON.parse(init.body) : undefined)
            : get(app.port, url, { Host: host, ...init.headers }));
          return new Response(answer.body, { status: answer.status, headers: answer.headers });
        },
      },
      location,
      history: { replaceState(_state, _title, url) { location.hash = String(url).slice(String(url).indexOf('#')); } },
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
      location.hash = hash;
      for (const listener of listeners.hashchange ?? []) listener({});
    };
    const main = () => document.getElementById('screen');
    return { document, Event, until, go, main, requests, store, location, serialize: () => document.documentElement.outerHTML, listeners };
  }

  it('shows the household and the four discover rows with each title\'s badge and Play link', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app);
    await page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4, 'four discover rows');
    assert.equal(page.document.getElementById('who').textContent, 'Alice · Farmhouse');
    assert.deepEqual([...page.document.querySelectorAll('.row-heading')].map((heading) => heading.textContent),
      ['Trending', 'Popular movies', 'Popular series', 'Upcoming movies']);
    const trending = page.document.querySelector('#row-trending-heading').parentElement;
    const cards = [...trending.querySelectorAll('.card')];
    assert.deepEqual(cards.map((item) => item.querySelector('.card-title').textContent),
      ['Synthetic Movie One', 'Synthetic Series Two', 'Synthetic Movie Three'], 'the person in the results is dropped');
    assert.deepEqual(cards.map((item) => item.querySelector('.badge').textContent),
      ['Available to request soon', 'Available to request soon', 'In your library']);
    const own = cards[2];
    const playLink = [...own.querySelectorAll('a')].find((anchor) => anchor.textContent === 'Play');
    assert.equal(playLink.getAttribute('href'), `https://${HOST_A}/web/#/details?id=33330000333300003333000033330000`);
    assert.equal(cards.flatMap((item) => [...item.querySelectorAll('a')]).filter((anchor) => anchor.textContent === 'Play').length, 1);
    assert.equal(page.document.querySelector('[role="alert"]'), null);
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
  });

  it('opens a title, its seasons and a season, and keeps to what the DTOs hold', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app);
    await page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4, 'home');
    page.go(`#/movie/${OWN_MOVIE}`);
    await page.until(() => page.main().querySelector('article.detail'), 'the movie');
    assert.equal(page.main().querySelector('h1').textContent, 'Synthetic Movie Three');
    assert.equal(page.main().querySelector('.badge').textContent, 'In your library');
    assert.equal(page.main().querySelector('a.button').textContent, 'Play');
    assert.equal(page.document.title, 'Synthetic Movie Three – JellyPass');
    assertNoCanaries(page.serialize(), 'movie page');

    page.go(`#/tv/${T_TV}`);
    await page.until(() => page.main().querySelector('.season-list'), 'the series');
    assert.equal(page.main().querySelector('h1').textContent, 'Synthetic Series Two');
    assert.equal(page.main().querySelector('a.button'), null);
    const seasons = [...page.main().querySelectorAll('.season')];
    assert.ok(seasons.length >= 1);
    for (const season of seasons) assert.equal(season.querySelector('.badge').textContent, 'Available to request soon');
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
    assert.equal(page.document.querySelector('nav a[aria-current="page"]').dataset.nav, 'about');
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
    assert.equal(page.document.getElementById('who').textContent, '', '/me has not answered');
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
    await page.until(() => page.document.getElementById('who').textContent.length > 0, 'the header once /me is back');
    assert.equal(page.main().querySelector('input[type="search"]'), input, 'the screen was not rebuilt');
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
    await page.until(() => page.document.getElementById('who').textContent.length > 0, 'the header');
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
    assert.equal(page.document.getElementById('signout').hidden, true, 'nothing to sign out of');
    // Jellyfin web is only a fallback, below the picker.
    const links = [...page.main().querySelectorAll('a')];
    assert.deepEqual(links.map((link) => [link.textContent, link.getAttribute('href')]), [['Open Jellyfin to sign in', '/web/']]);
    assert.equal(page.main().querySelectorAll('a.button').length, 0);
    assert.equal(page.document.getElementById('who').textContent, '');
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
    assert.equal(page.document.getElementById('who').textContent, 'Alice · Farmhouse');
    assert.equal(page.document.getElementById('signout').hidden, false);

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
    assert.equal(page.main().querySelector('input[type="password"]'), null, 'no password step');
    assert.equal(page.document.getElementById('who').textContent, 'Ann · Farmhouse');
    const login = page.requests.find((request) => request.url === '/Users/AuthenticateByName');
    assert.deepEqual(JSON.parse(login.init.body), { Username: 'Ann', Pw: '' });
    assert.equal(credentials(page).Servers[0].UserId, ANN);
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
    app.jellyfin.state.signInDown = true;
    click(outage, profileButton(outage, 'Ann'));
    await outage.until(() => message(outage), 'the outage message');
    assert.equal(message(outage), "Can't sign in right now. Try again in a moment.");
    assert.ok(outage.main().querySelector('ul.profiles'), 'the picker stays, with its buttons usable again');
    assert.ok([...outage.main().querySelectorAll('button.profile')].every((button) => !button.disabled));
    assert.doesNotMatch(outage.serialize(), /upstream detail/);
    app.jellyfin.state.signInDown = false;

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
    assert.equal(refusing.document.getElementById('who').textContent, '');
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
    assert.equal(page.document.getElementById('signout').hidden, true);
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
    click(page, page.document.getElementById('signout'));
    await page.until(() => page.main().querySelector('ul.profiles'), 'the picker after signing out');
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
    assert.equal(page.document.getElementById('who').textContent, '');
    assert.equal(page.document.getElementById('signout').hidden, true);
    // Dead at Jellyfin, and so for Jellyfin web (the app API keeps trusting a token it has just verified for a few minutes).
    assert.equal((await app.get('/Users/Me', { headers: { Authorization: `MediaBrowser Token="${token}"` }, user: null })).status, 401, 'the token is dead at Jellyfin');
    // The device ID stays, so the next sign-in is the same device.
    assert.match(page.store.get('jellypass_device_id'), /^jellypass-/);
  });

  it('signs out of this browser even when Jellyfin cannot be reached', async (t) => {
    const app = await signInApp(t);
    const page = await openApp(t, app, { override: (url) => { if (url === '/Sessions/Logout') throw new TypeError('network'); } });
    await homeLoaded(page);
    click(page, page.document.getElementById('signout'));
    await page.until(() => page.main().querySelector('ul.profiles'), 'the picker after signing out');
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
    assert.equal(expired.document.getElementById('who').textContent, '');

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
    assert.equal(missing.main().querySelector('button'), null);
  });
});
