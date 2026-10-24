// The household app's page (step 1b): how it is served, what it may do (CSP, service worker, manifest) and what it
// renders from the API's DTOs. DOM-level tests use linkedom (a small DOM for Node, a dev dependency only) to run the
// real client modules from dist/app against the real API, served from the same fakes as test/app-api.test.mjs.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { APP_CONTENT_SECURITY_POLICY, APP_PERMISSIONS_POLICY } from '../dist/app-assets.js';
import { contentHash } from '../scripts/build-app.mjs';
import { ALICE, HOST_A, HOST_B, OWN_MOVIE, T_MOVIE, T_TV, TOKENS, get, startApp, world } from './support/household-app.mjs';
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
    const css = await app.get(`${PAGE}app.css`, { user: null });
    const etag = css.headers.etag;
    assert.match(etag, /^"[A-Za-z0-9_-]{27}"$/);
    const cached = await app.get(`${PAGE}app.css`, { user: null, headers: { 'If-None-Match': etag } });
    assert.equal(cached.status, 304);
    assert.equal(cached.body.length, 0);
    assert.equal(cached.headers.etag, etag);
    const stale = await app.get(`${PAGE}app.css`, { user: null, headers: { 'If-None-Match': '"other"' } });
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
    for (const file of [PAGE, `${PAGE}sw.js`, `${PAGE}manifest.webmanifest`, `${PAGE}js/main.js`, `${PAGE}app.css`, '/jellypass/app']) {
      assert.deepEqual(shape(await off.get(file, { user: null })), unknownOff, file);
    }
    assert.equal(off.jellyfin.requests.length, 0);
    // Admin host (and an address that is no household's): the app's paths do not exist, whatever the app setting.
    const admin = { Authorization: 'Bearer admin-secret' };
    for (const host of ['jellypass.example.test', '127.0.0.1', 'localhost']) {
      for (const headers of [undefined, admin]) {
        const baseline = shape(await on.get('/jellypass/app-no-such-path', { host, user: null, ...(headers ? { headers } : {}) }));
        assert.equal(baseline.status, headers ? 404 : 401);
        for (const file of [PAGE, `${PAGE}sw.js`, `${PAGE}manifest.webmanifest`, `${PAGE}js/main.js`, '/jellypass/app']) {
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

  it('sets the right content type and cache rule for each kind of file', async (t) => {
    const app = await startApp(t);
    const expected = {
      [PAGE]: ['text/html; charset=utf-8', 'no-cache'],
      [`${PAGE}app.css`]: ['text/css; charset=utf-8', 'no-cache'],
      [`${PAGE}js/main.js`]: ['text/javascript; charset=utf-8', 'no-cache'],
      [`${PAGE}sw.js`]: ['text/javascript; charset=utf-8', 'no-cache'],
      [`${PAGE}manifest.webmanifest`]: ['application/manifest+json; charset=utf-8', 'no-cache'],
      [`${PAGE}icons/icon-192.png`]: ['image/png', 'public, max-age=604800'],
      [`${PAGE}tmdb-logo.svg`]: ['image/svg+xml', 'public, max-age=604800'],
    };
    for (const [served, [type, cache]] of Object.entries(expected)) {
      const { headers } = await app.get(served, { user: null });
      assert.equal(headers['content-type'], type, served);
      assert.equal(headers['cache-control'], cache, served);
    }
    // The API next door is still never cached.
    assert.equal((await app.get('/jellypass/app/v1/me')).headers['cache-control'], 'no-store');
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
    assert.equal(meta('theme-color'), JSON.parse(read('manifest.webmanifest')).theme_color);
    assert.equal(document.querySelector('link[rel="manifest"]').getAttribute('href'), 'manifest.webmanifest');
    assert.equal(document.querySelector('link[rel="apple-touch-icon"]').getAttribute('href'), 'icons/apple-touch-icon.png');
    assert.ok(document.querySelector('main'), 'a main landmark');
    assert.ok(document.querySelector('nav[aria-label]'), 'a labelled nav');
    assert.ok(document.querySelector('a.skip-link'), 'a skip link');
  });

  it('has a manifest that installs the app as standalone, starting at the app, with real icons', () => {
    const manifest = JSON.parse(read('manifest.webmanifest'));
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
    const touch = readFileSync(path.join(DIST_APP, 'icons/apple-touch-icon.png'));
    assert.equal(`${touch.readUInt32BE(16)}x${touch.readUInt32BE(20)}`, '180x180');
  });

  it('bundles the unmodified TMDB logo locally and never loads anything from another origin', () => {
    const logo = read('tmdb-logo.svg');
    assert.match(logo, /^<svg [^>]*viewBox="0 0 273\.42 35\.52"/);
    assert.doesNotMatch(logo, /<script|href=["']https?:|on\w+=/i);
    for (const file of FILES.filter((name) => /\.(js|css|html|webmanifest)$/.test(name))) {
      const source = read(file);
      // The only absolute URLs are links the person follows (TMDB's site), TMDB's image host and the SVG namespace.
      for (const url of source.match(/https?:\/\/[^\s"'`)]+/g) ?? []) {
        assert.match(url, /^https:\/\/(?:www\.themoviedb\.org\/?|image\.tmdb\.org\/t\/p\/.*|image\\\.tmdb.*)$/, `${file} mentions ${url}`);
      }
    }
    assert.doesNotMatch(read('app.css'), /@import|url\(/);
  });

  it('writes nothing it should not: no HTML parsing of text, no eval, no browser storage written, no cookies', () => {
    for (const file of FILES.filter((name) => name.startsWith('js/'))) {
      const source = read(file);
      assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc/, file);
      assert.doesNotMatch(source, /setItem|removeItem|sessionStorage|indexedDB|document\.cookie|caches\./, file);
    }
    // localStorage is only read: it holds Jellyfin web's own sign-in.
    assert.match(read('js/session.js'), /localStorage|getItem/);
  });

  it('keeps every colour pair in the stylesheet at WCAG AA contrast', () => {
    const css = read('app.css');
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
  function runWorker({ network = async () => new Response('fresh', { status: 200 }), failAdd = false } = {}) {
    const listeners = {};
    const stores = new Map();
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
      Response, URL, Promise,
    };
    vm.runInNewContext(SOURCE, context);
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
      `${ORIGIN}/jellypass/app/unknown.js`,
      'https://image.tmdb.org/t/p/w342/synthetic.jpg',
      'https://example.test/jellypass/app/app.css',
    ]) {
      const { handled } = await fetchEvent(worker, url);
      assert.equal(handled, false, url);
    }
    assert.equal((await fetchEvent(worker, `${ORIGIN}${PAGE}app.css`, { method: 'POST' })).handled, false);
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
      `${ORIGIN}/jellypass/app/v1/me`, `${ORIGIN}${PAGE}`, `${ORIGIN}${PAGE}js/main.js`, `${ORIGIN}/jellypass/app/v1/discover/trending`,
      `${ORIGIN}${PAGE}app.css?x=1`, `${ORIGIN}/jellypass/app/V1/me`,
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
    const url = `${ORIGIN}${PAGE}app.css`;
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
    assert.deepEqual([...worker.stores.keys()], [`jellypass-app-static-${hash}`]);

    const copy = mkdtempSync(path.join(os.tmpdir(), 'jellypass-hash-'));
    try {
      cpSync(DIST_APP, copy, { recursive: true });
      assert.equal(contentHash(copy), hash, 'the same files give the same hash');
      writeFileSync(path.join(copy, 'sw.js'), 'changed worker text');
      assert.equal(contentHash(copy), hash, 'the stamped worker\'s own text (which carries the hash) is not part of it');
      const template = readFileSync(path.join(import.meta.dirname, '..', 'app', 'static', 'sw.js'), 'utf8');
      assert.equal(contentHash(copy, template), hash, 'the unstamped worker is what the build hashes');
      assert.notEqual(contentHash(copy, `${template}\n// worker-only change\n`), hash, 'a worker-only change is a new cache name');
      for (const file of ['app.css', 'js/main.js', 'index.html', 'icons/icon-192.png']) {
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

  it('installs a release whole or not at all, and leaves the running release alone when it cannot', async () => {
    const worker = runWorker({ failAdd: true });
    worker.stores.set('jellypass-app-static-previous', new Map([[`${PAGE}app.css`, new Response('old release')]]));
    const waits = [];
    worker.listeners.install({ waitUntil: (promise) => waits.push(promise) });
    await assert.rejects(Promise.all(waits), /network error while precaching/);
    assert.deepEqual([...worker.stores.keys()], ['jellypass-app-static-previous'], 'no partial cache is left behind');
    assert.equal(worker.log.deleted.length, 1);
  });

  it('a worker-only update that fails to install leaves the active release\'s cache and offline fallback intact', async () => {
    // Same cache name is what a release reusing the active hash would get; the old worker's files are all there.
    const ok = runWorker();
    const waits = [];
    ok.listeners.install({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    const [name] = ok.stores.keys();
    const active = ok.stores.get(name);
    const failing = runWorker({ failAdd: true, network: async () => { throw new TypeError('offline'); } });
    failing.stores.set(name, active);
    const more = [];
    failing.listeners.install({ waitUntil: (promise) => more.push(promise) });
    await assert.rejects(Promise.all(more), /network error while precaching/);
    assert.deepEqual([...failing.stores.keys()], [name], 'the existing cache was not deleted');
    assert.deepEqual(failing.log.deleted, []);
    const answer = await fetchEvent(failing, `${ORIGIN}${PAGE}app.css`);
    assert.equal(await answer.response.text(), 'precached', 'offline fallback still works');
  });

  it('removes older releases\' caches (and only those) once the new one is active', async () => {
    const worker = runWorker();
    const waits = [];
    worker.listeners.install({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    const current = [...worker.stores.keys()][0];
    worker.stores.set('jellypass-app-static-v1', new Map());
    worker.stores.set('jellypass-app-static-0123456789abcdef', new Map());
    worker.stores.set('someone-elses-cache', new Map());
    worker.listeners.activate({ waitUntil: (promise) => waits.push(promise) });
    await Promise.all(waits);
    assert.deepEqual([...worker.stores.keys()].sort(), [current, 'someone-elses-cache'].sort());
    assert.deepEqual(worker.log.deleted.sort(), ['jellypass-app-static-0123456789abcdef', 'jellypass-app-static-v1']);
  });

  it('is registered by the page within its own scope', () => {
    const main = read('js/main.js');
    assert.match(main, /serviceWorker\.register\('sw\.js', \{ scope: '\.\/' \}\)/);
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
    const module = await import(pathToFileURL(path.join(DIST_APP, 'js', 'render.js')).href);
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
    assert.match(read('app.css'), /\.poster \{[^}]*aspect-ratio: 2 \/ 3/);
    assert.match(read('app.css'), /\.backdrop \{[^}]*aspect-ratio: 780 \/ 439/);
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
    assert.equal(logo.getAttribute('src'), 'tmdb-logo.svg', 'bundled, not hotlinked');
    assert.ok(logo.getAttribute('alt'));
    const links = [...about.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'));
    assert.deepEqual(links, ['https://www.themoviedb.org/', 'https://www.themoviedb.org/']);
    assert.ok(about.querySelectorAll('h1').length === 1);
    // The logo is less prominent than the app's own name (TMDB's terms): small, in the credits only.
    assert.match(read('app.css'), /\.tmdb-logo \{ width: 9rem/);
  });
});

describe('household app page: running against the API', { timeout: 60_000 }, () => {
  /**
   * Loads the real page and client modules into a DOM, signed in as `user` with Jellyfin web's own stored sign-in, and
   * wires `fetch` to the real API on the test server. One page per test (the client keeps its state in module scope).
   */
  async function openApp(t, app, { user = ALICE, host = HOST_A, signedIn = true, override, hash = '', holdMe } = {}) {
    const origin = `https://${host}`;
    const { document, Event } = parseHTML(read('index.html'));
    const store = new Map(signedIn ? [['jellyfin_credentials', JSON.stringify({
      Servers: [{ ManualAddress: origin, AccessToken: TOKENS[user], UserId: user }],
    })]] : []);
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
          const answer = override?.(url) ?? await get(app.port, url, { Host: host, ...init.headers });
          return new Response(answer.body, { status: answer.status, headers: answer.headers });
        },
      },
      location,
      history: { replaceState(_state, _title, url) { location.hash = String(url).slice(String(url).indexOf('#')); } },
      localStorage: { getItem: (key) => store.get(key) ?? null },
      navigator: {},
    };
    const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    t.after(() => {
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
    });
    await import(`${pathToFileURL(path.join(DIST_APP, 'js', 'main.js')).href}?page=${Math.random()}`);
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

  it('sends a signed-out visitor to the household\'s Jellyfin sign-in, without calling the API', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app, { signedIn: false });
    await page.until(() => page.main().querySelector('[role="alert"]'), 'the signed-out state');
    assert.equal(page.main().querySelector('h1').textContent, 'Sign in to continue');
    assert.equal(page.main().querySelector('a.button').getAttribute('href'), '/web/');
    assert.equal(page.requests.length, 0);
    assert.equal(page.document.getElementById('who').textContent, '');
    // Signing in (Jellyfin web writes its credentials) brings the app back without a reload.
    page.store.set('jellyfin_credentials', JSON.stringify({ Servers: [{ ManualAddress: page.location.origin, AccessToken: TOKENS[ALICE], UserId: ALICE }] }));
    for (const listener of page.listeners.storage ?? []) listener({ key: 'jellyfin_credentials' });
    await page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4, 'the home rows after signing in');
  });

  it('shows the fixed state for an expired sign-in (401), a rate limit (429) and a failure (502), never upstream text', async (t) => {
    const app = await startApp(t, world({ failCatalogue: 500 }));
    // 401: the token Jellyfin web holds is no longer valid.
    const expired = await openApp(t, app, { user: ALICE });
    expired.store.set('jellyfin_credentials', JSON.stringify({ Servers: [{ ManualAddress: expired.location.origin, AccessToken: 'token-revoked', UserId: ALICE }] }));
    expired.go('#/');
    await expired.until(() => expired.main().querySelector('h1')?.textContent === 'Sign in to continue', 'the sign-in state');
    assert.equal(expired.main().querySelector('a.button').getAttribute('href'), '/web/');
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
