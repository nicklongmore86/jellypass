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
import { APP_BUDGET_WINDOW_MS, APP_BURST_WINDOW_MS, MAX_APP_REQUESTS_PER_CLIENT, MAX_APP_REQUESTS_PER_HOUSEHOLD_BURST, MAX_APP_REQUESTS_PER_USER } from '../dist/app-api.js';
import { APP_CONTENT_SECURITY_POLICY, APP_PERMISSIONS_POLICY } from '../dist/app-assets.js';
import { buildApp, contentHash, stampWorker } from '../scripts/build-app.mjs';
import { ALICE, ANN, BOB, CAROL, HOST_A, HOST_B, OUTSIDER, OWN_MOVIE, T_MOVIE, T_TV, TOKENS, get, otherHouseholdWorlds, post, startApp, world } from './support/household-app.mjs';
import { assertNoCanaries } from './support/seerr-fixtures.mjs';

const DIST_APP = path.join(import.meta.dirname, '..', 'dist', 'app');
const PAGE = '/jellypass/app/';
const NOT_FOUND = '{"error":"not_found"}';
/** Regexp checks that report the pattern, never the (large) text: a failing assert.match prints its whole input. */
const matches = (text, pattern, message) => assert.ok(pattern.test(text), message ?? `expected to match ${pattern}`);
const lacks = (text, pattern, message) => assert.ok(!pattern.test(text), message ?? `expected not to match ${pattern}`);
const pause = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

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

const STORAGE_WRITE = /\b(?:localStorage|sessionStorage|storage|store|caches|indexedDB)\b[^;\n]*\.(?:clear|removeItem|setItem)\(|\.(?:setItem|removeItem)\(/;

describe('household app page: serving', { timeout: 30_000 }, () => {
  it('styles Home\'s filter chips and the rows\' waterlines from tokens, with contrast, and no inline style', async () => {
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
    const { ROW_ACCENTS, NETWORK_ACCENTS, homeHref } = await import(pathToFileURL(path.join(DIST_APP, BUILT('js/render.js'))).href);
    // Every accent but the default has a class and a colour token; the waterlines are decorative, but still stand out from the page and the card surface (3:1).
    assert.deepEqual([...ROW_ACCENTS].sort(), ['apple', 'default', 'disney', 'hbo', 'hulu', 'netflix', 'paramount', 'peacock', 'prime']);
    for (const accent of ROW_ACCENTS.filter((name) => name !== 'default')) {
      assert.ok(tokens[`water-${accent}`], `--water-${accent} is a token`);
      matches(css, new RegExp(`\\.row-heading\\.water-${accent}::after \\{ background: var\\(--water-${accent}\\); \\}`), accent);
      for (const under of ['bg', 'surface']) {
        assert.ok(contrast(tokens[`water-${accent}`], tokens[under]) >= 3, `${accent} waterline on ${under}: ${contrast(tokens[`water-${accent}`], tokens[under]).toFixed(2)}`);
      }
    }
    // The default waterline is a cyan line with a short purple end-cap, two separate segments (never a gradient); both stand out from the page (3:1), and the purple is never text.
    for (const end of ['accent', 'purple']) assert.ok(contrast(tokens[end], tokens.bg) >= 3 && contrast(tokens[end], tokens.surface) >= 3, `${end} waterline end`);
    matches(css, /\.row-heading::after \{[^}]*width: 2\.1rem; height: 0\.25rem;[^}]*background: var\(--accent\)/);
    matches(css, /\.row-heading::before \{[^}]*height: 0\.25rem;[^}]*background: var\(--purple\)/);
    lacks(css, /--waterline|color: var\(--purple\)/);
    // Eight services, eight different colours, none of them the default waterline.
    assert.deepEqual(Object.keys(NETWORK_ACCENTS).map(Number).sort((a, b) => a - b), [213, 453, 1024, 2552, 2739, 3186, 3353, 4330]);
    assert.equal(new Set(Object.values(NETWORK_ACCENTS)).size, 8);
    assert.equal(new Set(Object.values(NETWORK_ACCENTS).map((name) => tokens[`water-${name}`])).size, 8, 'no two services share a colour');
    assert.ok(!Object.values(NETWORK_ACCENTS).includes('default'));
    // No text is ever drawn in a waterline colour: it is a background, and only on a heading's ::after.
    for (const [, property] of css.matchAll(/([a-z-]+): var\(--water-/g)) assert.equal(property, 'background');
    // The filter: a solid band that sticks just under the solid header and the status bar, below the header's own layer.
    matches(css, /\.home-switch \{[^}]*position: sticky;[^}]*z-index: 5;[^}]*top: var\(--header-box\)/);
    matches(css, /\.home-switch \{[^}]*background: var\(--bg\)/);
    matches(css, /\.app-header \{[^}]*position: sticky;[^}]*z-index: 10;[^}]*background: var\(--bg\)/);
    // Outlined squircle chips; the chosen one is tinted cyan with an accent border and its tick, text on the tint at 4.5:1.
    matches(css, /\.segment \{[^}]*border: 1\.5px solid var\(--hairline\); border-radius: var\(--radius-chip\); background: transparent;/);
    matches(css, /\.segment\[aria-selected='true'\], \.segment\[aria-checked='true'\] \{ background: var\(--accent-tint\); border-color: var\(--accent\); color: var\(--accent-text\); \}/);
    matches(css, /\.segment\[aria-checked='true'\] \.icon \{ display: block; \}/);
    for (const [foreground, background] of [['accent-text', 'accent-tint'], ['muted', 'bg'], ['on-accent', 'accent']]) {
      assert.ok(contrast(tokens[foreground], tokens[background]) >= 4.5, `${foreground} on ${background}: ${contrast(tokens[foreground], tokens[background]).toFixed(2)}`);
    }
    // The chosen chip's border and the chips' outline stand out from the page as non-text (3:1): the accent border; the muted text carries the rest.
    assert.ok(contrast(tokens.accent, tokens['accent-tint']) >= 3 && contrast(tokens.accent, tokens.bg) >= 3);
    matches(css, /\.segment \{[^}]*min-height: 2\.75rem/, 'a touch target of at least 44px');
    // A focused card clears the header, and on Home the band under it too (#42's scroll padding, plus the band).
    matches(css, /--header-height: 3\.75rem;/);
    matches(css, /--switch-height: 3\.875rem;/);
    matches(css, /scroll-padding-top: calc\(var\(--header-box\) \+ 0\.5rem\)/);
    matches(css, /:root:has\(body\[data-home-switch\]\) \{ scroll-padding-top: calc\(var\(--header-box\) \+ var\(--switch-height\) \+ 0\.5rem\); \}/);
    lacks(css, /backdrop-filter/, 'no glass');
    assert.equal(homeHref('all'), '#/');
    assert.equal(homeHref('movies'), '#/?kind=movies');
    assert.equal(homeHref('tv'), '#/?kind=tv');
    // The scripts set no style attribute, as the CSP forbids: every waterline colour is a class. No style attributes are written via markup or setAttribute; the root's custom properties are set via the CSSOM, which style-src allows. The one exemption is the root-measurement helper in main.js (measure) and only the three properties --header-box, --tabbar-box and --switch-height.
    for (const file of FILES.filter((name) => name.startsWith('js/'))) {
      let rest = read(file);
      if (/^js\/main\./.test(file)) {
        const helper = rest.match(/function measure\(property, element\) \{[^]*?\n\}\n/);
        assert.ok(helper, 'the measure helper');
        assert.equal(helper[0].match(/\.style\b/g).length, 2, 'only the remove and set calls');
        assert.equal((helper[0].match(/\bstyle\.(?:setProperty|removeProperty)\(property\b/g) || []).length, 2);
        rest = rest.replace(helper[0], '');
        const callers = [...rest.matchAll(/\bmeasure\((['"])([^'"]+)\1/g)].map((hit) => hit[2]).sort();
        assert.deepEqual(callers, ['--header-box', '--switch-height', '--tabbar-box']);
      }
      assert.doesNotMatch(rest, /\.style\b|setAttribute\(['"]style/, file);
    }
  });

  it('is the Tidepool look and nothing left of the old one: no indigo, purple, glass, gradient capsule, accent bar or dot', () => {
    const css = read(BUILT('app.css'));
    for (const old of ['#8b7bff', '#0d0f24', '#c4bbff', '#5fa8ff', '#1b1740', '#b25cff']) assert.ok(!css.toLowerCase().includes(old), `${old} is gone`);
    lacks(css, /--(?:accent-gradient|accent-2|bg-glow|material|material-header|blur|radius-pill|scrim-top|bar-[a-z]+|pill-neutral-[a-z]+|pill-[a-z]+-glass):/);
    lacks(css, /accent-gradient|var\(--blur\)|var\(--material|radius-pill|\.accent-[a-z]+|-glass\b/);
    // No gradient on any control: the button is solid aqua with on-accent text; gradients are the waterline, the brand mark, scrims, skeletons and image fallbacks only.
    matches(css, /\.button \{[^}]*background: var\(--accent\); color: var\(--on-accent\)/);
    matches(css, /\.button-secondary \{ background: transparent; color: var\(--accent-text\); border: 1\.5px solid var\(--accent\); \}/);
    lacks(css, /\.(?:button|segment|badge|chip|tabbar|home-switch)[^{]*\{[^}]*gradient/);
    // The tab bar is not a floating pill and carries no dot; the page has no glow behind it.
    lacks(css, /\.tabbar a\[aria-current='page'\]::after|body::before/);
    // Heavy titles and squircle radii.
    matches(css, /--radius-chip: 12px;\s*--radius-poster: 20px;\s*--radius-card: 20px;\s*--radius-backdrop: 24px;\s*--radius-sheet: 30px;/);
    matches(css, /\.screen-title \{[^}]*font-weight: 800/);
    matches(css, /\.row-heading \{[^}]*font-weight: 800/);
  });

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
      assert.doesNotMatch(read(file), /grove|mill|alice|token-/i, `${file} carries household or user data`);
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
      // The only absolute URLs are links the person follows (TMDB's site, JustWatch's for its where-to-watch credit),
      // TMDB's image host and the SVG namespace.
      for (const url of source.match(/https?:\/\/[^\s"'`)]+/g) ?? []) {
        assert.match(url, /^(?:https:\/\/(?:www\.themoviedb\.org\/?|www\.justwatch\.com\/|image\.tmdb\.org\/t\/p\/.*|image\\\.tmdb.*)|http:\/\/www\.w3\.org\/2000\/svg)$/, `${file} mentions ${url}`);
      }
    }
    assert.doesNotMatch(read(BUILT('app.css')), /@import|url\(/);
  });

  it('the storage-write check matches storage APIs only, not other .clear( calls', () => {
    assert.match('localStorage.clear()', STORAGE_WRITE);
    assert.match('window.localStorage.setItem(k, v)', STORAGE_WRITE);
    assert.match('const s = localStorage; s.removeItem(k)', STORAGE_WRITE);
    assert.match('storage.setItem(k, v)', STORAGE_WRITE);
    assert.doesNotMatch('this.targets.clear(); map.clear()', STORAGE_WRITE);
  });

  it('writes nothing it should not: no HTML parsing of text, no eval, no cookies, and storage only in session.js, for two keys', () => {
    for (const file of FILES.filter((name) => name.startsWith('js/'))) {
      const source = read(file);
      assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|srcdoc/, file);
      assert.doesNotMatch(source, /sessionStorage|indexedDB|document\.cookie|caches\./, file);
      if (!file.startsWith('js/session.')) assert.doesNotMatch(source, STORAGE_WRITE, `${file} writes browser storage outside session.js`);
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
      ['text', 'bg'], ['text', 'surface'], ['text', 'surface-raised'], ['text', 'accent-tint'],
      ['muted', 'bg'], ['muted', 'surface'], ['muted', 'surface-raised'],
      // The accent as text (links, the chosen filter) and as the button: dark text on the solid aqua.
      ['accent', 'bg'], ['accent', 'surface'], ['accent-text', 'bg'], ['accent-text', 'surface'], ['accent-text', 'surface-raised'], ['accent-text', 'accent-tint'],
      ['on-accent', 'accent'],
      // Status chips.
      ['pill-ok-text', 'pill-ok-bg'], ['pill-get-text', 'pill-get-bg'], ['pill-bad-text', 'pill-bad-bg'], ['pill-warn-text', 'pill-warn-bg'],
      // Error text on the page and on cards.
      ['pill-bad-text', 'bg'], ['pill-bad-text', 'surface'],
      // A network's or studio's name, shown on its logo tile when there is no logo.
      ['logo-text', 'logo-tile'],
    ];
    for (const [foreground, background] of pairs) {
      assert.ok(tokens[foreground] && tokens[background], `${foreground} on ${background} are tokens`);
      assert.ok(ratio(foreground, background) >= 4.5, `${foreground} on ${background}: ${ratio(foreground, background).toFixed(2)}`);
    }
    // The button is solid aqua with dark text: no gradient.
    matches(css, /\.button \{[^}]*background: var\(--accent\); color: var\(--on-accent\)/);

    // The status chips are solid, so they hold their text pair over any poster or backdrop, white or black (nothing shows through).
    lacks(css, /--pill-[a-z]+-(?:bg|text):\s*rgb/);
    for (const [selector, pill] of [['badge-in_library, .badge-request-ready', 'ok'], ['badge-get_this', 'get'], ['badge-unavailable, .badge-request-failed', 'bad'], ['badge-requested, .badge-request-requested', 'warn']]) {
      matches(css, new RegExp(`\\.${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{ background: var\\(--pill-${pill}-bg\\); color: var\\(--pill-${pill}-text\\); \\}`), pill);
      // The dot is the text colour, so the chip's one non-text mark has the same ratio as its word.
      assert.ok(ratio(`pill-${pill}-text`, `pill-${pill}-bg`) >= 4.5, `${pill} dot and word`);
    }
    matches(css, /\.badge::before \{[^}]*border-radius: 50%; background: currentColor;/);
    // Over a white poster, the chip still stands out from it as a shape (3:1); over a black one its hairline and light text carry it.
    for (const pill of ['ok', 'get', 'bad', 'warn']) assert.ok(contrast(tokens[`pill-${pill}-bg`], '#ffffff') >= 3, `${pill} chip against a white poster`);
    // The chip sits at the image's top-left, on poster cards and on backdrop cards.
    matches(css, /\.card > \.badge \{[^}]*position: absolute; top: [0-9.]+rem; left: [0-9.]+rem/);
    matches(css, /\.card-backdrop > \.badge \{[^}]*top: [0-9.]+rem; left: [0-9.]+rem/);

    // The header, the filter band, the docked tab bar and the hero's text panel are navy and (nearly) opaque, so their text and icons hold the plain pairs checked above;
    // the hero panel is composited over a pure white and a pure black picture, so its text never depends on the image.
    const composite = (name, backdrop) => {
      const found = new RegExp(`--${name}:\\s*rgb\\((\\d+) (\\d+) (\\d+) / ([0-9.]+)\\)`).exec(css);
      assert.ok(found, `${name} is a translucent rgb() token`);
      const alpha = Number(found[4]);
      return `#${found.slice(1, 4).map((value) => Math.round(Number(value) * alpha + backdrop * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`;
    };
    for (const backdrop of [255, 0]) {
      const under = composite('panel', backdrop);
      for (const text of ['text', 'muted', 'accent-text']) {
        assert.ok(contrast(tokens[text], under) >= 4.5, `${text} on the hero panel over ${backdrop ? 'white' : 'black'} (${under}): ${contrast(tokens[text], under).toFixed(2)}`);
      }
    }
    // The colours are Jellyfin's: its navy page and cyan main colour, the purple a small decoration.
    assert.equal(tokens.bg, '#000b25');
    assert.equal(tokens.accent, '#00a4dc');
    assert.equal(tokens.purple, '#aa5cc3');
    assert.ok(ratio('text', 'bg') >= 12, `body text on navy: ${ratio('text', 'bg').toFixed(2)}`);
    assert.ok(ratio('accent', 'bg') >= 6, `cyan on navy: ${ratio('accent', 'bg').toFixed(2)}`);
    assert.ok(ratio('on-accent', 'accent') >= 6, `navy on cyan: ${ratio('on-accent', 'accent').toFixed(2)}`);
    assert.ok(ratio('purple', 'bg') >= 3, `the purple cap on navy: ${ratio('purple', 'bg').toFixed(2)}`);
    // Non-text: the back, search and tab icons, and the waterline and tab indicator, against what they sit on.
    for (const [graphic, under] of [['text', 'surface'], ['text', 'bg'], ['accent-text', 'surface-raised'], ['muted', 'surface'], ['accent', 'surface'], ['purple', 'bg']]) {
      assert.ok(ratio(graphic, under) >= 3, `${graphic} icon on ${under}: ${ratio(graphic, under).toFixed(2)}`);
    }
    // The active tab is an aqua-tint squircle with an aqua outline: the outline is the non-text indicator and must be 3:1 against the bar (WCAG 1.4.11); the tint is not relied on. Its label and icon are 4.5:1 on the tint (above).
    assert.ok(ratio('accent', 'surface') >= 3, `the active tab's outline against the bar: ${ratio('accent', 'surface').toFixed(2)}`);
    assert.ok(ratio('accent-text', 'accent-tint') >= 4.5);
    // Active vs inactive is told apart by more than colour: an outline the inactive tabs lack (transparent) and a heavier icon stroke.
    matches(css, /\.tabbar a \{[^}]*border: 1\.5px solid transparent/);
    matches(css, /\.tabbar a\[aria-current='page'\] \{ background: var\(--accent-tint\); border-color: var\(--accent\); color: var\(--accent-text\); \}/);
    matches(css, /\.tabbar a\[aria-current='page'\] \.icon \{ stroke-width: 2\.4; \}/);
    // A service page's All | Series | Films control shares the chips: muted on the page, the selected one aqua on its tint (pairs above).
    matches(css, /\.segment \{[^}]*background: transparent;[^}]*color: var\(--muted\)/);
    matches(css, /\.tabbar a \{[^}]*color: var\(--muted\)/);
    // The tab bar is the surface colour, solid, so it needs no blur fallback.
    matches(css, /\.tabbar \{[^}]*background: var\(--surface\)/);
    // The page's colours are the installed app's: the status bar and the splash.
    const manifest = JSON.parse(read(BUILT('manifest.webmanifest')));
    assert.equal(manifest.background_color, tokens.bg);
    assert.equal(manifest.theme_color, tokens.bg);
    matches(css, /prefers-reduced-motion: reduce/);
    matches(css, /env\(safe-area-inset-bottom\)/);
    matches(css, /:focus-visible/);
  });

  it('draws no text over a picture except in the hero\'s navy panel, and no scrim, gradient between the brand colours, teal or coral', () => {
    const css = read(BUILT('app.css'));
    // The big cards and the detail pages put their text below the image, on the page's own navy: no scrim is left.
    lacks(css, /scrim|--overlay/);
    lacks(css, /\.backdrop-text \{[^}]*position: absolute/);
    matches(css, /\.backdrop-text \.card-title \{[^}]*color: var\(--text\)/);
    matches(css, /\.backdrop-text \.card-meta \{[^}]*color: var\(--muted\)/);
    // The hero's text sits in a panel of the page colour at 0.92 opacity or more (composited over white and black in the contrast test).
    const panel = /--panel:\s*rgb\(0 11 37 \/ ([0-9.]+)\)/.exec(css);
    assert.ok(panel && Number(panel[1]) >= 0.9, 'the panel is navy and nearly opaque');
    matches(css, /\.hero-panel \{[^}]*background: var\(--panel\)/);
    matches(css, /\.hero-link \{ color: var\(--text\)/);
    matches(css, /\.hero-overview \{[^}]*color: var\(--muted\)/);
    matches(css, /\.chip \{[^}]*background: var\(--surface\); color: var\(--text\)/);
    matches(css, /\.back \{[^}]*color: var\(--accent-text\)/);
    // The big card is a 16:9 image 24px round, nearly a screen wide on a phone, with its chip at the top-left.
    matches(css, /\.backdrop-frame \{[^}]*aspect-ratio: 16 \/ 9[^}]*border-radius: var\(--radius-backdrop\)/);
    matches(css, /--radius-backdrop: 24px;/);
    matches(css, /\.row-list-backdrop > \.card \{ flex: 0 0 min\(92%, calc\(100% - var\(--gutter-end\)\)\); \}/);
    matches(css, /\.backdrop-link:focus-visible \.backdrop-frame::after \{[^}]*border: 3px solid var\(--accent\)/);
    assert.equal(/\.backdrop[a-z-]* \{[^}]*url\(/.test(css), false, 'no CSS url()');
    lacks(css, /\.app-header::before/);
    // Past the header, a focused element still stops clear of it.
    matches(css, /scroll-padding-top: calc\(var\(--header-box\) \+ 0\.5rem\)/);
    // The hero is an inset 4:5 card on a phone, never full bleed; the detail backdrop an inset 16:9 card.
    matches(css, /\.hero-card \{[^}]*aspect-ratio: 4 \/ 5/);
    matches(css, /\.detail-hero \{[^}]*aspect-ratio: 16 \/ 9/);
    matches(css, /\.detail-hero \{[^}]*border-radius: var\(--radius-sheet\)/);
  });

  it('is Jellyfin navy and cyan: no teal or coral, purple only as a small decoration, never a purple-to-blue gradient', () => {
    const css = read(BUILT('app.css'));
    const ts = read(BUILT('js/render.js'));
    // Colours are tokens; the old teal and coral hexes and names are gone everywhere (stylesheet, page, manifest, code).
    const OLD = ['#06161b', '#0e262d', '#153540', '#0f3a38', '#eafaf6', '#9fc3c0', '#4fe3c1', '#7ff0d6', '#04201b', '#ff8a73', '#e6b422', '#0d3a46', '#bdf0ff'];
    for (const file of [css, read('index.html'), read(BUILT('manifest.webmanifest')), ts]) {
      for (const hex of OLD) assert.equal(file.toLowerCase().includes(hex), false, hex);
      assert.doesNotMatch(file, /\b(?:teal|coral|aqua)\b/i);
    }
    // The purple is used in exactly one rule: the waterline's end-cap pseudo-element. Never as text, a border, a control or a fill of anything else.
    const uses = css.split('\n').filter((line) => /var\(--purple\)|#aa5cc3/i.test(line)).filter((line) => !/^\s*--purple:/.test(line));
    assert.equal(uses.length, 1, `purple is used on one line: ${uses.join(' | ')}`);
    assert.match(uses[0], /^\.row-heading::before \{[^}]*background: var\(--purple\); \}$/);
    lacks(css, /(?:^|[^-])color:\s*var\(--purple\)|(?:border|outline)[a-z-]*:[^;}]*var\(--purple\)/);
    // No gradient mixes the cyan and the purple (or either with the blue): the gradients left are navy surface ramps and the loading shimmer.
    for (const gradient of css.match(/(?:linear|radial|conic)-gradient\([^;{}]*\)/g) ?? []) {
      assert.doesNotMatch(gradient, /--purple|--accent|#aa5cc3|#00a4dc|--water-/, gradient);
    }
    // The two segments of the waterline are separate boxes with a gap between them, not one blended bar.
    const cyan = /\.row-heading::after \{[^}]*left: 0; bottom: 0; width: ([0-9.]+)rem/.exec(css);
    const cap = /\.row-heading::before \{[^}]*left: ([0-9.]+)rem; bottom: 0; width: ([0-9.]+)rem/.exec(css);
    assert.ok(cyan && cap, 'the waterline is two segments');
    assert.ok(Number(cap[1]) > Number(cyan[1]), 'a gap between the cyan line and the purple cap');
    assert.ok(Number(cap[2]) <= 0.75, 'the purple cap is short');
    // The old tokens are gone.
    lacks(css, /--gold|--coral|--aqua|--teal|water-gold/);
  });

  it('keeps a focused card clear of the solid header and the docked tab bar', () => {
    const css = read(BUILT('app.css'));
    const html = /(?:^|\n)html \{([^}]*)\}/.exec(css)[1];
    const bottom = /scroll-padding-bottom: ([^;]+);/.exec(html)[1];
    const top = /scroll-padding-top: ([^;]+);/.exec(html)[1];
    assert.ok(bottom.includes('var(--tabbar-box)'), `bottom clearance follows the bar's box: ${bottom}`);
    assert.ok(top.includes('var(--header-box)'), `top clearance follows the header's box: ${top}`);
    // The boxes default to the rem estimates with the safe areas; main.ts replaces them with the measured heights.
    matches(css, /--header-box: calc\(var\(--header-height\) \+ env\(safe-area-inset-top\)\);/);
    matches(css, /--tabbar-box: calc\(var\(--tabbar-height\) \+ var\(--tabbar-gap\) \+ env\(safe-area-inset-bottom\)\);/);
    // Never less than the bar itself: the clearance is the bar's height plus a margin, never the padding alone.
    assert.match(bottom, /\+ 0\.[0-9]+rem\)$/);
    matches(css, /--tabbar-height: 4\.5rem;/);
    matches(css, /--tabbar-gap: 0rem;/, 'docked: no gap under the bar');
    // The bar is 0.5rem of padding either side of a 3.5rem tab; the header is 0.5rem, a 2.75rem button and 0.5rem; the band is 0.5rem, a 2.75rem chip and 0.625rem.
    matches(css, /\.tabbar a \{[^}]*min-height: 3\.5rem/);
    matches(css, /\.tabbar \{[^}]*padding: 0\.5rem max\(0\.75rem, env\(safe-area-inset-right\)\) calc\(0\.5rem \+ env\(safe-area-inset-bottom\)\)/);
    matches(css, /--header-height: 3\.75rem;/);
    matches(css, /--switch-height: 3\.875rem;/);
    matches(css, /\.home-switch \{[^}]*padding: 0\.5rem [^;]* 0\.625rem /);
    matches(css, /main \{[^}]*padding: 0\.75rem var\(--gutter-end\) calc\(var\(--tabbar-box\) \+ 1\.5rem\)/);
  });

  it('draws the tab bar docked and full width: rounded top corners, 56px labelled tabs, a filled squircle for the active one, a safe-area foot, no dot', () => {
    const css = read(BUILT('app.css'));
    const tabbar = /\.tabbar \{([^}]*)\}/.exec(css)[1];
    assert.match(tabbar, /position: fixed; left: 0; right: 0; bottom: 0;/);
    assert.match(tabbar, /border-radius: var\(--radius-sheet\) var\(--radius-sheet\) 0 0/);
    assert.match(tabbar, /env\(safe-area-inset-bottom\)/);
    assert.doesNotMatch(tabbar, /width:|margin:|box-shadow|backdrop/);
    // Each tab is at least 44px (2.75rem) tall: 3.5rem here, an icon over a label, the active one filled.
    const tab = /\.tabbar a \{([^}]*)\}/.exec(css)[1];
    assert.ok(Number(/min-height: ([0-9.]+)rem/.exec(tab)[1]) >= 2.75);
    assert.match(tab, /flex-direction: column/);
    assert.match(tab, /border-radius: var\(--radius-card\)/);
    matches(css, /\.tabbar a\[aria-current='page'\] \{ background: var\(--accent-tint\); border-color: var\(--accent\);/);
    lacks(css, /\.tabbar a\[aria-current='page'\]::after/, 'no dot under the active tab');
    // Status chips sit on the image's top-left corner; search is three columns, two on a very narrow screen.
    matches(css, /\.card > \.badge \{[^}]*position: absolute; top: [0-9.]+rem; left: [0-9.]+rem/);
    matches(css, /\.grid, \.skeleton-grid \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
    matches(css, /@media \(max-width: 21rem\) \{\s*\.grid, \.skeleton-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    matches(css, /--radius-chip: 12px;[\s\S]*--radius-poster: 20px;[\s\S]*--radius-card: 20px;[\s\S]*--radius-backdrop: 24px;[\s\S]*--radius-sheet: 30px;/);
    matches(css, /--font: -apple-system, /);
  });
});

describe('household app page: service worker', () => {
  const SOURCE = read('sw.js');
  const ORIGIN = 'https://jelly-grove.example.test';

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
  const origin = 'https://jelly-grove.example.test';
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

  it('names each card link with its title, facts and status exactly once, and hides the sibling pill from assistive technology', async () => {
    const { document, cardItem, backdropCardItem, STATE_LABELS } = await renderer();
    for (const state of Object.keys(STATE_LABELS)) {
      const poster = cardItem(document, card({ state }));
      assert.equal(poster.querySelector('.card-link').getAttribute('aria-label'), `Synthetic Movie Three, 2021 · Movie, ${STATE_LABELS[state]}`, state);
      assert.equal(poster.querySelector(':scope > .badge').getAttribute('aria-hidden'), 'true', state);
      const wide = backdropCardItem(document, card({ state }));
      const facts = wide.querySelector('.card-meta').textContent;
      assert.match(facts, /^2021 · .*7\.5 TMDB$/);
      assert.equal(wide.querySelector('.card-link').getAttribute('aria-label'), `Synthetic Movie Three, ${facts}, ${STATE_LABELS[state]}`, state);
      assert.equal(wide.querySelector(':scope > .badge').getAttribute('aria-hidden'), 'true', state);
    }
    const bare = backdropCardItem(document, card({ year: null, rating: null, state: 'in_library' }));
    assert.equal(bare.querySelector('.card-link').getAttribute('aria-label'), `Synthetic Movie Three, ${STATE_LABELS.in_library}`);
  });

  it('brings a focused card fully into its row: the handler is wired and the rows still snap to a card\'s start', () => {
    const main = read(BUILT('js/main.js'));
    assert.match(main, /addEventListener\('focusin', showFocusedCard\)/);
    assert.match(main, /list\.scrollLeft \+= rowFocusShift\(box, view, /);
    assert.match(main, /closest\('\.row-list \.card-link, \.logo-list \.logo-link'\)/, 'the Studios logo tiles are included');
    assert.doesNotMatch(main.slice(main.indexOf('function showFocusedCard'), main.indexOf('function showFocusedCard') + 1100), /restoreCancelled/, 'a focus scroll is not the member\'s input');
    assert.match(read(BUILT('app.css')), /\.row-list > \.card \{[^}]*scroll-snap-align: center/);
  });

  it('clamps a focused card into its row: centred when it fits, leading edge at the snapport start when wider', async () => {
    const { rowFocusShift } = await import(pathToFileURL(path.join(DIST_APP, BUILT('js/render.js'))).href);
    const view = { left: 16, width: 358 };
    // Fits (300 wide in a 326 snapport): centre 150 + 16 + 163 -> shift to the port centre.
    assert.equal(rowFocusShift({ left: 200, right: 500 }, view, 32), 350 - (16 + 163));
    // Exactly the snapport: centred and flush are the same.
    assert.equal(rowFocusShift({ left: 40, right: 366 }, view, 32), 40 - 16);
    // Wider (329.36 > 326): the leading edge lands on the row start, not 1.7px past it.
    assert.equal(rowFocusShift({ left: 100, right: 429.36 }, view, 32), 84);
    // A bad padding reads as none.
    assert.equal(rowFocusShift({ left: 16, right: 374 }, view, NaN), 0);
    const css = read(BUILT('app.css'));
    assert.match(css, /\.row-list-backdrop > \.card \{ flex: 0 0 min\(92%, calc\(100% - var\(--gutter-end\)\)\)/);
    assert.match(css, /\.row-list > \.card \{[^}]*max-width: calc\(100% - var\(--gutter-end\)\)/);
  });

  it('snaps every horizontal card row to a centred card, first at the start, last at the end, never stopping a flick', () => {
    const css = read(BUILT('app.css'));
    const rule = (selector) => css.match(new RegExp(`${selector.replace(/[.>]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';
    for (const list of ['.row-list', '.logo-list']) {
      assert.match(rule(list), /scroll-snap-type: x mandatory/, list);
      assert.match(rule(list), /scroll-padding-inline: 0 var\(--gutter-end\)/, list);
    }
    for (const [card, first, last] of [['.row-list > .card', '.row-list > .card:first-child', '.row-list > .card:last-child'], ['.logo-card', '.logo-card:first-child', '.logo-card:last-child']]) {
      assert.match(rule(card), /scroll-snap-align: center/, card);
      assert.match(rule(first), /scroll-snap-align: start/, first);
      assert.match(rule(last), /scroll-snap-align: end/, last);
      assert.match(rule(last), /scroll-margin-right: var\(--gutter-end\)/, last);
    }
    // Backdrop rows are .row-list too, and the service rows use the same class names.
    assert.match(read(BUILT('js/render.js')), /'row-list row-list-backdrop' : 'row-list'/);
    assert.equal((css.match(/scroll-snap-stop:/g) ?? []).length, 1, 'only the hero pages one slide at a time');
    assert.match(css, /\.hero-slide \{[^}]*scroll-snap-stop: always/);
    // Reduced motion adds no animation and leaves the snap in place.
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    assert.doesNotMatch(reduced, /scroll-snap-type|scroll-behavior: smooth/);
  });

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
      { itemId: itemId, url: `http://jelly-grove.example.test/web/#/details?id=${itemId}` },
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
    const { document, cardItem, titleDetail } = await renderer();
    const image = cardItem(document, card(), origin).querySelector('img');
    assert.equal(image.getAttribute('loading'), 'lazy');
    assert.equal(image.getAttribute('decoding'), 'async');
    assert.equal(image.getAttribute('width'), '342');
    assert.equal(image.getAttribute('height'), '513');
    assert.match(read(BUILT('app.css')), /\.poster \{[^}]*aspect-ratio: 2 \/ 3/);
    // A backdrop is an <img> with its own size attributes inside a 16:9 frame.
    const backdrop = titleDetail(document, { ...card(), genres: [], runtime: 90 }, origin).querySelector('.detail-hero img');
    assert.equal(backdrop.getAttribute('width'), '780');
    assert.equal(backdrop.getAttribute('height'), '439');
    assert.equal(backdrop.getAttribute('loading'), 'eager');
    const css = read(BUILT('app.css'));
    matches(css, /\.detail-hero \{[^}]*aspect-ratio: 16 \/ 9/, 'the backdrop card keeps its 16:9 shape before the image arrives');
  });

  it('renders a movie page, a series page with its seasons and states, and a season with its episodes', async () => {
    const { document, titleDetail, seasonView } = await renderer();
    const movie = titleDetail(document, { ...card({ state: 'in_library', play }), genres: ['Drama', 'Mystery'], runtime: 118, seasons: undefined }, origin);
    assert.equal(movie.querySelector('h1').textContent, 'Synthetic Movie Three');
    assert.deepEqual([...movie.querySelectorAll('.chips .chip')].map((chip) => chip.textContent), ['2021', '1 h 58 min', '★ 7.5 TMDB']);
    assert.equal(movie.querySelector('.chip-rating').getAttribute('aria-label'), 'TMDB rating 7.5 out of 10');
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

  describe('backdrop cards', () => {
    const page = (results) => ({ page: 1, nextPage: null, results });
    const WIDTHS = /^https:\/\/image\.tmdb\.org\/t\/p\/w(?:780|1280)\/[A-Za-z0-9_-]+\.jpg$/;

    it('draws a backdrop with srcset from the two allowed sizes only, the title, "year · ★ rating TMDB" and the pill, all inside one link', async () => {
      const { document, titleRow } = await renderer();
      // A w342 or w1280 URL from the API still yields only the derived w780 / w1280 pair; the first card is lazy like the rest.
      const row = titleRow(document, 'row-popular-movies', 'Popular movies', page([
        card({ backdropUrl: 'https://image.tmdb.org/t/p/w1280/synthetic-wide.jpg' }),
        card({ tmdbId: 900004, title: 'Synthetic Movie Four', backdropUrl: 'https://image.tmdb.org/t/p/w780/synthetic-four.jpg', rating: null, year: null }),
      ]), 'backdrop');
      const list = row.querySelector('ul');
      assert.equal(list.className, 'row-list row-list-backdrop');
      assert.equal(list.getAttribute('tabindex'), '0');
      assert.equal(list.getAttribute('aria-labelledby'), 'row-popular-movies-heading');
      const items = [...list.querySelectorAll('li.card-backdrop')];
      assert.equal(items.length, 2);
      const img = items[0].querySelector('img');
      assert.equal(img.getAttribute('src'), 'https://image.tmdb.org/t/p/w780/synthetic-wide.jpg');
      assert.equal(img.getAttribute('srcset'), 'https://image.tmdb.org/t/p/w780/synthetic-wide.jpg 780w, https://image.tmdb.org/t/p/w1280/synthetic-wide.jpg 1280w');
      for (const url of img.getAttribute('srcset').split(',').map((part) => part.trim().split(' ')[0])) assert.match(url, WIDTHS);
      assert.equal(img.getAttribute('sizes'), '(min-width: 48rem) 36vw, 92vw');
      assert.equal(img.getAttribute('alt'), '');
      for (const item of items) assert.equal(item.querySelector('img').getAttribute('loading'), 'lazy');
      assert.equal(items[0].querySelectorAll('a').length, 1, 'the whole card is the one link');
      assert.equal(items[0].querySelector('a').getAttribute('href'), '#/movie/900003');
      assert.ok(items[0].querySelector('a').contains(items[0].querySelector('.card-title')));
      assert.equal(items[0].querySelector('.card-title').textContent, 'Synthetic Movie Three');
      assert.equal(items[0].querySelector('.card-meta').textContent, '2021 · ★ 7.5 TMDB');
      assert.equal(items[0].querySelector('.badge').textContent, 'Available to get');
      assert.equal(items[1].querySelector('.card-meta'), null, 'no year and no rating: no empty line');
      assert.equal(items[0].querySelectorAll('button, a.button').length, 0);
      // Title and "year · ★ rating TMDB" are BELOW the image, never inside the picture's frame; the solid chip is on the image.
      const link = items[0].querySelector('a');
      const frame = link.querySelector(':scope > .backdrop-frame');
      const text = link.querySelector(':scope > .backdrop-text');
      assert.ok(frame && text, 'a frame and a text block');
      assert.deepEqual([...link.children].map((child) => child.className), ['backdrop-frame', 'backdrop-text'], 'the text follows the image');
      assert.equal(frame.querySelectorAll('.card-title, .card-meta').length, 0, 'no text over the picture');
      assert.equal(frame.querySelectorAll('img').length, 1);
      assert.equal(text.querySelector('.card-title').textContent, 'Synthetic Movie Three');
      assert.equal(items[0].querySelector(':scope > .badge').textContent, 'Available to get', 'the chip is a sibling positioned on the image corner');
    });

    it('falls back to the poster, then to a plain gradient card, and drops a URL that is not TMDB\'s', async () => {
      const { document, titleRow } = await renderer();
      const row = titleRow(document, 'row-popular-tv', 'Popular series', page([
        card({ tmdbId: 1, backdropUrl: null }),
        card({ tmdbId: 2, backdropUrl: null, posterUrl: null }),
        card({ tmdbId: 3, backdropUrl: 'https://evil.example/t/p/w780/x.jpg', posterUrl: 'https://evil.example/p.jpg' }),
        card({ tmdbId: 4, backdropUrl: 'https://image.tmdb.org/t/p/original/x.jpg', posterUrl: null }),
      ]), 'backdrop');
      const items = [...row.querySelectorAll('li.card-backdrop')];
      assert.equal(items[0].querySelector('img').getAttribute('src'), poster);
      assert.equal(items[0].querySelector('img').getAttribute('srcset'), null, 'a poster has no backdrop sizes');
      assert.equal(items[0].querySelector('img').className, 'backdrop-img');
      for (const item of items.slice(1)) {
        assert.equal(item.querySelector('img'), null);
        assert.equal(item.querySelectorAll('.backdrop-frame').length, 1, 'the plain card keeps its 16:9 frame');
        assert.ok(item.querySelector('.card-title').textContent);
      }
    });

    it('leaves the other rows as poster cards and sets text only through textContent', async () => {
      const { document, titleRow } = await renderer();
      const hostile = '<img src=x onerror=alert(1)>';
      const posters = titleRow(document, 'row-upcoming', 'Upcoming movies', page([card()]));
      assert.equal(posters.querySelector('ul').className, 'row-list');
      assert.equal(posters.querySelectorAll('li.card-backdrop, .backdrop-link').length, 0);
      assert.equal(posters.querySelector('.poster-card img').getAttribute('src'), poster);
      const backdrops = titleRow(document, 'row-popular-movies', 'Popular movies', page([card({ title: hostile })]), 'backdrop');
      assert.equal(backdrops.querySelector('.card-title').textContent, hostile);
      assert.equal(backdrops.querySelectorAll('img').length, 1, 'the title was not parsed as markup');
      assert.equal(backdrops.querySelectorAll('[style]').length, 0);
    });
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
      // Seasons that differ: a pill each, none for the entry, and the admin note under the one that failed.
      assert.equal(item.querySelectorAll(':scope > .badge').length, 0);
      assert.equal(item.querySelector('.request-who').textContent, 'Asked for by you');
      assert.deepEqual([...item.querySelectorAll('.request-season')].map((season) => season.textContent),
        ['Season 1Ready to watch', 'Season 2Requested', "Season 3We couldn't get thisAsk your JellyPass admin to try again."]);
      assert.equal(item.querySelectorAll('.badge').length, 3);
      assert.equal(item.querySelectorAll('.failed-note').length, 1);
      assert.equal(item.querySelector('.card-meta').textContent, 'Series');
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
      assert.equal(movie.querySelectorAll('.badge').length, 1);
      assert.equal(movie.querySelector(':scope > .failed-note').textContent, 'Ask your JellyPass admin to try again.');
      // An unknown status (never sent) is shown as the safe one rather than as raw text.
      assert.equal(requestItem(document, { ...entry, status: 'canary-status', seasons: [] }).querySelector(':scope > .badge').textContent, "We couldn't get this");
    });

    it('shows one status pill per request: a single season or seasons sharing one status say them on the meta line', async () => {
      const { document, requestItem, setRequestTitle, requestSeasonsText, requestPills } = await renderer();
      const base = { id: 'opaqueidopaqueidopaqueid', mediaType: 'tv', tmdbId: 900002, status: 'requested', byYou: true };
      const pills = (item) => [...item.querySelectorAll('.badge')].map((badge) => badge.textContent);
      // One season: one pill, the season on the meta line, no season row.
      const single = requestItem(document, { ...base, seasons: [{ seasonNumber: 1, status: 'requested' }] });
      assert.deepEqual(pills(single), ['Requested']);
      assert.equal(single.querySelector(':scope > .badge').textContent, 'Requested');
      assert.equal(single.querySelector('.card-meta').textContent, 'Series · Season 1');
      assert.equal(single.querySelectorAll('.request-season, .request-seasons').length, 0);
      setRequestTitle(single, { title: 'Synthetic Series Two', year: 2027, mediaType: 'tv' });
      assert.equal(single.querySelector('.card-meta').textContent, '2027 · Series · Season 1');
      setRequestTitle(single, { title: 'Synthetic Series Two', year: 2027, mediaType: 'tv' });
      assert.equal(single.querySelector('.card-meta').textContent, '2027 · Series · Season 1');
      assert.equal(single.querySelector('.request-link').textContent, 'Synthetic Series Two2027 · Series · Season 1');
      // Several seasons sharing one status: one pill, the seasons as text.
      const shared = requestItem(document, { ...base, status: 'ready', seasons: [1, 2, 3].map((seasonNumber) => ({ seasonNumber, status: 'ready' })) });
      assert.deepEqual(pills(shared), ['Ready to watch']);
      assert.equal(shared.querySelector('.card-meta').textContent, 'Series · Seasons 1–3');
      assert.equal(shared.querySelectorAll('.request-season').length, 0);
      const gap = requestItem(document, { ...base, status: 'failed', seasons: [3, 1].map((seasonNumber) => ({ seasonNumber, status: 'failed' })) });
      assert.deepEqual(pills(gap), ["We couldn't get this"]);
      assert.equal(gap.querySelector('.card-meta').textContent, 'Series · Seasons 1, 3');
      assert.equal(gap.querySelectorAll('.failed-note').length, 1);
      assert.equal(gap.querySelector(':scope > .failed-note').textContent, 'Ask your JellyPass admin to try again.');
      // Differing: a pill per season only.
      const mixed = requestItem(document, { ...base, seasons: [{ seasonNumber: 1, status: 'ready' }, { seasonNumber: 2, status: 'requested' }] });
      assert.deepEqual(pills(mixed), ['Ready to watch', 'Requested']);
      assert.equal(mixed.querySelectorAll(':scope > .badge').length, 0);
      assert.equal(mixed.querySelectorAll('.request-season .badge').length, 2);
      assert.equal(mixed.querySelector('.card-meta').textContent, 'Series');
      assert.equal(mixed.querySelectorAll('.failed-note').length, 0);
      // Each status said once in what a screen reader reads.
      for (const [item, status] of [[single, 'Requested'], [shared, 'Ready to watch'], [gap, "We couldn't get this"]]) {
        assert.equal(item.textContent.split(status).length - 1, 1, status);
      }
      assert.deepEqual([requestSeasonsText([1]), requestSeasonsText([1, 2]), requestSeasonsText([3, 1, 2]), requestSeasonsText([1, 3]), requestSeasonsText([5, 1, 2, 3, 7, 8])],
        ['Season 1', 'Seasons 1, 2', 'Seasons 1–3', 'Seasons 1, 3', 'Seasons 1–3, 5, 7, 8']);
      assert.deepEqual(requestPills({ status: 'ready', seasons: [] }), { status: 'ready', seasonsText: '', perSeason: false });
      assert.deepEqual(requestPills({ status: 'requested', seasons: [{ seasonNumber: 2, status: 'requested' }] }), { status: 'requested', seasonsText: 'Season 2', perSeason: false });
      assert.deepEqual(requestPills({ status: 'requested', seasons: [{ seasonNumber: 1, status: 'ready' }, { seasonNumber: 2, status: 'failed' }] }), { status: undefined, seasonsText: '', perSeason: true });
    });

    it('puts a series request\'s status pill sensibly at the edges: overall status, duplicates, season 0, many seasons', async () => {
      const { document, requestItem, requestSeasonsText, requestPills } = await renderer();
      const base = { id: 'opaqueidopaqueidopaqueid', mediaType: 'tv', tmdbId: 900002, byYou: true };
      const pills = (item) => [...item.querySelectorAll('.badge')].map((badge) => badge.textContent);
      // The seasons' shared status is the pill, not the request's own overall status.
      const overall = requestItem(document, { ...base, status: 'requested', seasons: [1, 2].map((seasonNumber) => ({ seasonNumber, status: 'ready' })) });
      assert.deepEqual(pills(overall), ['Ready to watch']);
      assert.equal(overall.querySelector('.card-meta').textContent, 'Series · Seasons 1, 2');
      const notFailed = requestItem(document, { ...base, status: 'failed', seasons: [{ seasonNumber: 4, status: 'requested' }] });
      assert.deepEqual(pills(notFailed), ['Requested']);
      assert.equal(notFailed.querySelectorAll('.failed-note').length, 0);
      // A season listed twice is said once; listed twice with two statuses, each keeps its pill.
      assert.equal(requestSeasonsText([2, 1, 2, 1]), 'Seasons 1, 2');
      const twice = requestItem(document, { ...base, status: 'ready', seasons: [{ seasonNumber: 1, status: 'ready' }, { seasonNumber: 1, status: 'ready' }] });
      assert.deepEqual(pills(twice), ['Ready to watch']);
      assert.equal(twice.querySelector('.card-meta').textContent, 'Series · Season 1');
      assert.equal(requestPills({ status: 'ready', seasons: [{ seasonNumber: 1, status: 'ready' }, { seasonNumber: 1, status: 'failed' }] }).perSeason, true);
      // Season 0 (specials) is a season like any other.
      assert.deepEqual([requestSeasonsText([0]), requestSeasonsText([0, 1, 2]), requestSeasonsText([0, 2])], ['Season 0', 'Seasons 0–2', 'Seasons 0, 2']);
      const specials = requestItem(document, { ...base, status: 'requested', seasons: [{ seasonNumber: 0, status: 'requested' }] });
      assert.equal(specials.querySelector('.card-meta').textContent, 'Series · Season 0');
      // A long list stays one line of runs, under one pill.
      const many = Array.from({ length: 40 }, (_, index) => index + 1);
      assert.equal(requestSeasonsText(many), 'Seasons 1–40');
      assert.equal(requestSeasonsText(many.filter((number) => number % 10 !== 0)), 'Seasons 1–9, 11–19, 21–29, 31–39');
      const long = requestItem(document, { ...base, status: 'ready', seasons: many.map((seasonNumber) => ({ seasonNumber, status: 'ready' })) });
      assert.deepEqual(pills(long), ['Ready to watch']);
      assert.equal(long.querySelector('.card-meta').textContent, 'Series · Seasons 1–40');
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
      matches(css, /\.choice \{[^}]*min-height: 2\.75rem/, '44 px touch target');
      // No new colour literals: the new rules use the checked tokens only.
      const added = css.slice(css.indexOf('.get-this {'), css.indexOf('.credits {'));
      assert.doesNotMatch(added, /#[0-9a-f]{3,6}\b/i);
    });
  });

  describe('hero, full-bleed detail pages and season cards', () => {
    const heroCards = (count, over = () => ({})) => Array.from({ length: count }, (_, index) => card({
      tmdbId: 700000 + index, title: `Synthetic Hero ${index + 1}`, year: 2020 + index, rating: 7.8 - index, overview: `Synthetic hero overview ${index + 1}.`,
      backdropUrl: `https://image.tmdb.org/t/p/w780/synthetic-hero-${index}.jpg`, state: ['get_this', 'in_library', 'requested', 'unavailable', 'get_this'][index % 5],
      ...over(index),
    }));
    const tv = (overrides = {}) => ({
      ...card({ mediaType: 'tv', tmdbId: 900002, title: 'Synthetic Series Two', state: 'get_this' }), genres: ['Drama'], runtime: 45,
      seasons: [
        { seasonNumber: 0, name: 'Specials', episodeCount: 2, state: 'get_this' },
        { seasonNumber: 1, name: 'Season 1', episodeCount: 8, state: 'in_library' },
        { seasonNumber: 2, name: 'Season 2', episodeCount: 6, state: 'get_this' },
        { seasonNumber: 3, name: 'Season 3', episodeCount: 1, state: 'get_this' },
        { seasonNumber: 4, name: 'Season 4', episodeCount: 4, state: 'requested' },
      ],
      ...overrides,
    });
    const click = (node, Event) => node.dispatchEvent(new Event('click'));

    it('lays the detail head out in two columns only where there is a poster to put in the first', async () => {
      const { document, titleDetail, seasonView } = await renderer();
      const css = readFileSync(path.join(DIST_APP, BUILT('app.css')), 'utf8');
      matches(css, /\.detail-head-poster \{ display: grid; grid-template-columns: 9rem minmax\(0, 1fr\)/);
      assert.equal(/\.detail-head \{ display: grid/.test(css), false, 'the bare head is never a grid');
      const headOf = (node) => node.querySelector('.detail-head');
      for (const posterUrl of [poster, null]) {
        const head = headOf(titleDetail(document, { ...card({ posterUrl }), genres: [], runtime: 90 }, origin));
        assert.ok(head.classList.contains('detail-head-poster'), `movie, poster ${posterUrl}`);
        assert.equal(head.querySelectorAll(':scope > .poster').length, 1, 'a poster frame (empty or not) fills the first column');
      }
      const seasonHead = headOf(seasonView(document, { tmdbId: 900002, seasonNumber: 2, name: 'Season 2', overview: '', episodes: [], state: 'get_this' }, 'Synthetic Series Two', {}));
      assert.equal(seasonHead.classList.contains('detail-head-poster'), false);
      assert.equal(seasonHead.children.length, 1, 'one child, so it spans the whole width');
      assert.equal(seasonHead.querySelectorAll('.poster').length, 0);
    });

    it('styles the header from the scroll offset at most once a frame, writing the body only when it crosses 40px', () => {
      const main = readFileSync(path.join(import.meta.dirname, '..', 'app', 'src', 'main.ts'), 'utf8');
      assert.match(main, /window\.addEventListener\('scroll', onScroll, \{ passive: true \}\)/);
      assert.equal(/addEventListener\('scroll', markScrolled/.test(main), false);
      assert.match(main, /function onScroll\(\): void \{\s*if \(scrollFrame\) return;[^]*?scrollFrame = window\.requestAnimationFrame/);
      assert.match(main, /if \(scrolled === scrolledState\) return;/);
      assert.equal((main.match(/setAttribute\('data-scrolled'/g) ?? []).length, 1);
    });

    it('accepts TMDB images at w342, w780 and w1280 only', async () => {
      const { safeImageUrl } = await renderer();
      for (const size of ['w342', 'w780', 'w1280']) {
        const url = `https://image.tmdb.org/t/p/${size}/synthetic-a_B-1.jpg`;
        assert.equal(safeImageUrl(url), url, size);
      }
      for (const bad of ['w500', 'w185', 'w300', 'w1920', 'w12800', 'w128', 'original', 'w1280x', 'W1280', '1280']) {
        assert.equal(safeImageUrl(`https://image.tmdb.org/t/p/${bad}/a.jpg`), undefined, bad);
      }
      for (const bad of ['https://image.tmdb.org/t/p/w1280/a.jpg?x=1', 'https://image.tmdb.org/t/p/w1280/a/b.jpg', 'https://image.tmdb.org/t/p/w1280/a.gif',
        'http://image.tmdb.org/t/p/w1280/a.jpg', 'https://image.tmdb.org.evil.test/t/p/w1280/a.jpg', 'https://evil.test/t/p/w1280/a.jpg']) {
        assert.equal(safeImageUrl(bad), undefined, bad);
      }
    });

    it('draws a backdrop as an img offering w780 and w1280, never as a CSS url or an inline style', async () => {
      const { document, titleDetail, heroCarousel } = await renderer();
      const w780 = 'https://image.tmdb.org/t/p/w780/synthetic-backdrop.jpg';
      const w1280 = 'https://image.tmdb.org/t/p/w1280/synthetic-backdrop.jpg';
      for (const backdropUrl of [w780, w1280]) {
        const detail = titleDetail(document, { ...card({ backdropUrl }), genres: [], runtime: 90 }, origin);
        const image = detail.querySelector('.detail-hero img');
        assert.equal(image.getAttribute('src'), w780, 'the fallback is the smaller file');
        assert.equal(image.getAttribute('srcset'), `${w780} 780w, ${w1280} 1280w`);
        assert.equal(image.getAttribute('sizes'), '(min-width: 64rem) 960px, calc(100vw - 2rem)', 'a phone asks for the inset card\'s width');
        assert.equal(image.getAttribute('alt'), '');
        assert.equal(detail.querySelectorAll('[style]').length, 0);
        const hero = heroCarousel(document, [card({ backdropUrl })]);
        assert.equal(hero.querySelector('img').getAttribute('srcset'), `${w780} 780w, ${w1280} 1280w`);
        assert.equal(hero.querySelector('img').getAttribute('sizes'), '(min-width: 75rem) 1100px, calc(100vw - 2rem)');
        assert.equal(hero.querySelectorAll('[style]').length, 0);
      }
      // Posters stay at w342.
      assert.equal(titleDetail(document, { ...card(), genres: [], runtime: 90 }, origin).querySelector('.poster img').getAttribute('src'), poster);
      // Anything else is not drawn at all.
      for (const backdropUrl of ['https://image.tmdb.org/t/p/original/a.jpg', 'https://image.tmdb.org/t/p/w500/a.jpg', 'https://evil.example.test/a.jpg', null]) {
        assert.equal(titleDetail(document, { ...card({ backdropUrl }), genres: [], runtime: 90 }, origin).querySelectorAll('.detail-hero img').length, 0, String(backdropUrl));
      }
      lacks(read(BUILT('app.css')), /url\(|@import/);
    });

    it('draws the hero from up to five titles, with a labelled button for each control and a plain slide where there is no backdrop', async () => {
      const { document, heroCarousel, HERO_TEXT, HERO_MAX } = await renderer();
      assert.equal(HERO_MAX, 5);
      const shown = heroCarousel(document, heroCards(8, (index) => (index === 2 ? { backdropUrl: null } : {})));
      const slides = [...shown.querySelectorAll('.hero-slide')];
      assert.equal(slides.length, 5);
      assert.equal(shown.getAttribute('aria-label'), HERO_TEXT.label);
      assert.equal(shown.getAttribute('aria-roledescription'), 'carousel');
      assert.deepEqual(slides.map((slide) => slide.querySelector('.hero-link').textContent), [1, 2, 3, 4, 5].map((n) => `Synthetic Hero ${n}`));
      assert.deepEqual(slides.map((slide) => slide.querySelector('.hero-link').getAttribute('href')), [0, 1, 2, 3, 4].map((n) => `#/movie/${700000 + n}`));
      assert.deepEqual(slides.map((slide) => slide.getAttribute('aria-label')), ['1 of 5', '2 of 5', '3 of 5', '4 of 5', '5 of 5']);
      assert.deepEqual(slides.map((slide) => slide.querySelector('.hero-year').textContent), ['2020', '2021', '2022', '2023', '2024']);
      assert.deepEqual(slides.map((slide) => slide.querySelector('.hero-rating').textContent), ['★ 7.8 TMDB', '★ 6.8 TMDB', '★ 5.8 TMDB', '★ 4.8 TMDB', '★ 3.8 TMDB']);
      assert.deepEqual(slides.map((slide) => slide.querySelector('.hero-rating').getAttribute('aria-label')), ['TMDB rating 7.8 out of 10', 'TMDB rating 6.8 out of 10', 'TMDB rating 5.8 out of 10', 'TMDB rating 4.8 out of 10', 'TMDB rating 3.8 out of 10']);
      assert.deepEqual(slides.map((slide) => slide.querySelector('.hero-overview').textContent), [1, 2, 3, 4, 5].map((n) => `Synthetic hero overview ${n}.`));
      assert.deepEqual(slides.map((slide) => slide.querySelector('.badge').textContent), ['Available to get', 'Ready to watch', 'Requested', "Can't request", 'Available to get']);
      assert.deepEqual(slides.map((slide) => slide.querySelectorAll('img').length), [1, 1, 0, 1, 1], 'no backdrop, no image');
      assert.equal(slides[2].querySelectorAll('.hero-card .hero-media img').length, 0, 'the plain card is navy with its panel');
      assert.deepEqual(slides.map((slide) => slide.querySelectorAll('.hero-card > .hero-panel .hero-link, .hero-card > .hero-panel .badge').length), Array(5).fill(2), 'title and status chip sit in the text panel');
      assert.equal(slides[0].querySelector('img').getAttribute('loading'), 'eager');
      assert.equal(slides[1].querySelector('img').getAttribute('loading'), 'lazy');
      // Controls: real buttons, each named.
      assert.equal(shown.querySelector('.hero-prev').getAttribute('aria-label'), 'Previous title');
      assert.equal(shown.querySelector('.hero-next').getAttribute('aria-label'), 'Next title');
      const dots = [...shown.querySelectorAll('button.hero-dot')];
      assert.equal(dots.length, 5);
      assert.deepEqual(dots.map((dot) => dot.tagName), Array(5).fill('BUTTON'));
      assert.deepEqual(dots.map((dot) => dot.getAttribute('type')), Array(5).fill('button'));
      assert.deepEqual(dots.map((dot) => dot.getAttribute('aria-label')), [1, 2, 3, 4, 5].map((n) => `Show title ${n} of 5: Synthetic Hero ${n}`));
      assert.deepEqual(dots.map((dot) => dot.getAttribute('aria-current')), ['true', null, null, null, null]);
      assert.equal(shown.querySelectorAll('[style]').length, 0);
      // Each slide is an inset card: the picture fills it and the text sits in a panel after the picture, with the pager outside the card.
      for (const slide of slides) {
        assert.deepEqual([...slide.children].map((child) => child.className), ['hero-card']);
        assert.deepEqual([...slide.querySelector('.hero-card').children].map((child) => child.className), ['hero-media', 'hero-panel']);
        assert.equal(slide.querySelector('.hero-panel .hero-title') !== null && slide.querySelector('.hero-panel .hero-facts') !== null && slide.querySelector('.hero-panel .hero-overview') !== null, true);
        assert.equal(slide.querySelector('.hero-media').querySelectorAll('a, button, p').length, 0, 'no text in the picture');
      }
      assert.equal(shown.querySelectorAll('.hero-card button').length, 0, 'the pager is outside the cards');
      assert.equal(shown.querySelector('.hero-controls').querySelectorAll('button').length, 7, 'Previous, five bubbles and Next');
      // A single title needs no controls; no title, no hero.
      assert.equal(heroCarousel(document, heroCards(1)).querySelectorAll('button').length, 0);
      assert.equal(heroCarousel(document, []), undefined);
    });

    it('moves only when told to: no timers, buttons and dots scroll the track, and reduced motion scrolls without animating', async () => {
      const { document, Event, heroCarousel } = await renderer();
      const timers = [];
      const names = ['setTimeout', 'setInterval', 'requestAnimationFrame'];
      const real = Object.fromEntries(names.map((name) => [name, globalThis[name]]));
      for (const name of names) globalThis[name] = (...args) => { timers.push(name); return real[name]?.(...args); };
      try {
        const shown = heroCarousel(document, heroCards(5));
        const track = shown.querySelector('.hero-track');
        Object.defineProperty(track, 'clientWidth', { value: 390 });
        const scrolls = [];
        track.scrollTo = (options) => scrolls.push(`${options.left}:${options.behavior}`);
        const current = () => [...shown.querySelectorAll('.hero-dot')].map((dot) => dot.getAttribute('aria-current') === 'true' ? 1 : 0).join('');
        click(shown.querySelector('.hero-next'), Event);
        click(shown.querySelector('.hero-next'), Event);
        click(shown.querySelector('.hero-prev'), Event);
        click(shown.querySelectorAll('.hero-dot')[4], Event);
        click(shown.querySelector('.hero-next'), Event);
        assert.deepEqual(scrolls, ['390:smooth', '780:smooth', '390:smooth', '1560:smooth', '0:smooth'], 'next and previous wrap round');
        assert.equal(current(), '10000');
        assert.equal(shown.querySelector('[aria-live]').textContent, 'Showing 1 of 5: Synthetic Hero 1');
        // Swiping moves the track, and the dot follows the slide mostly in view.
        track.scrollLeft = 780;
        track.dispatchEvent(new Event('scroll'));
        assert.equal(current(), '00100');
        assert.equal(shown.querySelector('[aria-live]').textContent, 'Showing 3 of 5: Synthetic Hero 3');
        // Reduced motion: the same move, instantly.
        document.defaultView.matchMedia = (query) => ({ matches: query === '(prefers-reduced-motion: reduce)' });
        scrolls.length = 0;
        click(shown.querySelector('.hero-next'), Event);
        assert.deepEqual(scrolls, ['1170:auto']);
        assert.deepEqual(timers, [], 'nothing was scheduled: no autoplay');
      } finally {
        for (const name of names) globalThis[name] = real[name];
        delete document.defaultView.matchMedia;
      }
      // The built client has no timer or animation frame at all in the rendering code, and the stylesheet no autoplay either.
      assert.doesNotMatch(read(BUILT('js/render.js')), /setInterval|setTimeout|requestAnimationFrame|autoplay/i);
      const css = read(BUILT('app.css'));
      matches(css, /@media \(prefers-reduced-motion: reduce\) \{[^@]*animation: none !important; transition: none !important; scroll-behavior: auto !important/);
      matches(css, /\.hero-track \{[^}]*scroll-snap-type: x mandatory/);
      lacks(css, /\.hero[^{]*\{[^}]*animation:/, 'the hero itself animates nothing');
    });

    it('shows Play for a title in the library, Get this for one available to get, and neither (a pill and a note) for the rest', async () => {
      const { document, titleDetail, seasonView, STATE_LABELS } = await renderer();
      const onGet = async () => 'accepted';
      const movie = (state, extras = { onGet }, overrides = {}) => titleDetail(document, { ...card({ state, play: state === 'in_library' ? play : null, ...overrides }), genres: ['Drama'], runtime: 90 }, origin, extras);
      const primaries = (detail) => [...detail.querySelectorAll('.button-primary')].map((node) => `${node.tagName} ${node.textContent}`);
      assert.deepEqual(primaries(movie('in_library')), ['A Play']);
      assert.equal(movie('in_library').querySelector('a.button-primary').getAttribute('href'), play.url);
      assert.equal(movie('in_library').querySelector('a.button-primary').getAttribute('aria-label'), 'Play Synthetic Movie Three');
      assert.deepEqual(primaries(movie('get_this')), ['BUTTON Get this']);
      for (const state of ['requested', 'unavailable']) {
        const detail = movie(state);
        assert.deepEqual(primaries(detail), [], state);
        assert.equal(detail.querySelectorAll('button, a.button').length, 0, `${state}: no button`);
        assert.equal(detail.querySelector('.badge').textContent, STATE_LABELS[state]);
        assert.equal(detail.querySelectorAll('.detail-text .muted').length, 1, `${state}: a muted note`);
      }
      assert.equal(movie('unavailable').querySelector('.detail-text .muted').textContent, "This title can't be requested.");
      assert.equal(movie('requested').querySelector('.detail-text .muted').textContent, 'Check My requests to follow it.');
      // A title the household asked for that failed: the pill and the one fixed note, no button.
      const failed = movie('get_this', { onGet, failed: new Set([0]) });
      assert.deepEqual(primaries(failed), []);
      assert.equal(failed.querySelectorAll('button').length, 0);
      assert.equal(failed.querySelector('.badge').textContent, "We couldn't get this");
      assert.equal(failed.querySelector('.detail-text .muted').textContent, 'Ask your JellyPass admin to try again.');
      // Without a way to ask, a requestable title has no action either; Play needs the household's own Jellyfin link.
      assert.deepEqual(primaries(movie('get_this', {})), []);
      assert.deepEqual(primaries(titleDetail(document, { ...card({ state: 'in_library', play: { itemId, url: 'https://evil.example.test/x' } }), genres: [], runtime: 90 }, origin)), []);
      // The action sits under the title and above the overview; one primary per page.
      const detail = movie('get_this');
      const order = [...detail.querySelectorAll('h1, .chips, .genres, .badge, .detail-action, .overview')].map((node) => node.className.split(' ')[0] || node.tagName);
      assert.deepEqual(order, ['screen-title', 'chips', 'genres', 'badge', 'detail-action', 'overview']);
      // A series: Get this when seasons can be asked for; a series partly held has Play as its one primary and Get this steps back.
      assert.deepEqual(primaries(titleDetail(document, tv(), origin, { onGet })), ['BUTTON Get this']);
      const held = titleDetail(document, tv({ state: 'in_library', play }), origin, { onGet });
      assert.deepEqual(primaries(held), ['A Play']);
      assert.equal(held.querySelector('.detail-action button').textContent, 'Get this');
      assert.ok(held.querySelector('.detail-action button').classList.contains('button-secondary'));
      // A season page: Get this only for a season that can be asked for.
      const season = (state, extras = { onGet }) => seasonView(document, { tmdbId: 900002, seasonNumber: 2, name: 'Season 2', overview: '', episodes: [], state }, 'Synthetic Series Two', extras);
      assert.deepEqual(primaries(season('get_this')), ['BUTTON Get this']);
      for (const state of ['in_library', 'requested', 'unavailable']) assert.deepEqual(primaries(season(state)), [], state);
    });

    it('lays a title out as chips (year, runtime or seasons, TMDB rating), genre pills and the status pill, with the poster kept off phones', async () => {
      const { document, titleDetail, seasonView } = await renderer();
      const chips = (detail) => [...detail.querySelectorAll('.chips .chip')].map((chip) => chip.textContent);
      assert.deepEqual(chips(titleDetail(document, { ...card(), genres: [], runtime: 118 }, origin)), ['2021', '1 h 58 min', '★ 7.5 TMDB']);
      assert.deepEqual(chips(titleDetail(document, tv(), origin)), ['2021', '4 seasons', '★ 7.5 TMDB'], 'specials are not a season');
      assert.deepEqual(chips(titleDetail(document, tv({ seasons: [{ seasonNumber: 1, name: 'Season 1', episodeCount: 8, state: 'get_this' }] }), origin)), ['2021', '1 season', '★ 7.5 TMDB']);
      assert.deepEqual(chips(titleDetail(document, { ...card({ year: null, rating: null }), genres: [], runtime: null }, origin)), []);
      assert.equal(titleDetail(document, { ...card({ year: null, rating: null }), genres: [], runtime: null }, origin).querySelector('.chips'), null);
      assert.deepEqual(chips(seasonView(document, { tmdbId: 900002, seasonNumber: 1, name: 'Season 1', overview: '', state: 'in_library',
        episodes: [{ episodeNumber: 1, name: 'Pilot', overview: '' }, { episodeNumber: 2, name: '', overview: '' }] }, 'S')), ['2 episodes']);
      const css = read(BUILT('app.css'));
      matches(css, /\.poster-detail \{ display: none; \}/, 'no poster on a phone');
      matches(css, /@media \(min-width: 48rem\) \{[^@]*\.poster-detail \{ display: block; \}/, 'a small one on a wide screen');
      lacks(css, /--detail-overlap|margin: calc\(-1 \*/, 'the title block starts below the backdrop card, never over it');
      matches(css, /\.detail-hero \{[^}]*margin-bottom: [0-9.]+rem/, 'the title block sits below the backdrop card');
      matches(css, /\.detail-title \{[^}]*font-weight: 800/);
      matches(css, /\.button-primary \{ width: 100%; min-height: 3\.5rem/, 'a full-width squircle button');
    });

    it('draws seasons as cards with a round checkbox inside one fieldset, and Select all only moves the checkmarks', async () => {
      const { document, Event, titleDetail, GET_THIS_TEXT } = await renderer();
      const asked = [];
      const detail = titleDetail(document, tv(), origin, { onGet: async (seasons) => { asked.push(seasons); return 'accepted'; } });
      const cards = [...detail.querySelectorAll('.season')];
      assert.deepEqual(cards.map((item) => item.querySelector('.season-name').textContent), ['Specials', 'Season 1', 'Season 2', 'Season 3', 'Season 4']);
      assert.deepEqual(cards.map((item) => item.querySelector('.card-meta').textContent), ['2 episodes', '8 episodes', '6 episodes', '1 episode', '4 episodes']);
      assert.deepEqual(cards.map((item) => item.querySelector('.badge').textContent), ['Available to get', 'Ready to watch', 'Available to get', 'Available to get', 'Requested']);
      // Real checkboxes, in the fieldset with its legend, in the cards of the seasons that can be asked for (never a special).
      const fieldset = detail.querySelector('fieldset.get-seasons');
      assert.equal(fieldset.querySelector('legend').textContent, GET_THIS_TEXT.chooseSeasons);
      assert.equal(fieldset.querySelectorAll('.season').length, 5, 'all the cards are in the fieldset');
      const boxes = [...fieldset.querySelectorAll('input[type="checkbox"]')];
      assert.deepEqual(boxes.map((box) => box.value), ['2', '3']);
      assert.deepEqual(boxes.map((box) => box.closest('.season').querySelector('.season-name').textContent), ['Season 2', 'Season 3']);
      assert.deepEqual([...fieldset.querySelectorAll('label.choice')].map((label) => label.textContent), ['Season 2', 'Season 3'], 'each one is named');
      assert.equal(fieldset.querySelectorAll('[style]').length, 0);
      const all = fieldset.querySelector('button.select-all');
      assert.equal(all.textContent, 'Select all');
      assert.equal(all.getAttribute('type'), 'button');
      const get = detail.querySelector('.detail-action button');
      assert.equal(get.disabled, true, 'nothing chosen yet');
      assert.equal(detail.querySelector('.get-hint').hidden, false);
      const checked = () => boxes.map((box) => (box.checked ? 1 : 0)).join('');
      click(all, Event);
      assert.equal(checked(), '11');
      assert.equal(all.textContent, 'Clear all');
      assert.equal(get.disabled, false);
      assert.equal(detail.querySelector('.get-hint').hidden, true);
      click(all, Event);
      assert.equal(checked(), '00');
      assert.equal(all.textContent, 'Select all');
      assert.equal(get.disabled, true);
      boxes[0].checked = true;
      boxes[0].dispatchEvent(new Event('change'));
      click(all, Event);
      assert.equal(checked(), '11', 'from some to all');
      assert.deepEqual(asked, [], 'toggling asked for nothing');
      assert.equal(get.textContent, 'Get this');
      // Get this is the one thing that asks, with exactly the chosen seasons.
      click(get, Event);
      assert.deepEqual(asked, [[2, 3]]);
      assert.deepEqual(boxes.map((box) => box.disabled), [true, true]);
      assert.equal(all.disabled, true, 'locked while in flight');
      await new Promise((resolve) => setTimeout(resolve, 0));
      // One requestable season has nothing to select all of; a held-back one is no choice at all.
      const one = titleDetail(document, tv({ seasons: [{ seasonNumber: 2, name: 'Season 2', episodeCount: 6, state: 'get_this' }] }), origin, { onGet: async () => 'accepted' });
      assert.equal(one.querySelectorAll('input[type="checkbox"]').length, 1);
      assert.equal(one.querySelector('.select-all'), null);
      const none = titleDetail(document, tv({ state: 'requested', seasons: [{ seasonNumber: 1, name: 'Season 1', episodeCount: 8, state: 'in_library' }] }), origin, { onGet: async () => 'accepted' });
      assert.equal(none.querySelector('fieldset'), null);
      assert.equal(none.querySelector('.select-all'), null);
      assert.equal(none.querySelectorAll('.season').length, 1);
      // The control is a custom rounded-square one built on the real checkbox.
      const css = read(BUILT('app.css'));
      matches(css, /\.choice input \{[^}]*appearance: none;[^}]*border-radius: 0\.5rem/);
      matches(css, /\.choice input:checked \{[^}]*background: var\(--accent\)/);
      matches(css, /\.choice input:focus-visible \{ outline: 3px solid var\(--accent\)/);
      matches(css, /\.choice \{[^}]*min-width: 2\.75rem; min-height: 2\.75rem/);
    });

    it('gives the hero and a detail page their own skeletons, hidden from assistive technology and free of controls', async () => {
      const { document, skeletonHero, skeletonDetail } = await renderer();
      for (const [name, node] of [['hero', skeletonHero(document)], ['detail', skeletonDetail(document)]]) {
        assert.equal(node.getAttribute('aria-hidden'), 'true', name);
        assert.equal(node.querySelectorAll('a, button, input, img, h1, h2').length, 0, `${name}: nothing to focus or announce`);
        assert.ok(node.querySelectorAll('.skeleton').length >= 1, name);
        assert.equal(node.querySelectorAll('[style]').length, 0, name);
      }
      assert.equal(skeletonHero(document).querySelectorAll('.hero-slide').length, 0, 'not the real hero');
      assert.ok(skeletonDetail(document).querySelector('.detail-hero.skeleton'), 'the backdrop\'s shape');
      const css = read(BUILT('app.css'));
      matches(css, /\.hero-skeleton-card \{[^}]*aspect-ratio: 4 \/ 5/, 'the same shape as the hero card');
    });
  });

  it('credits TMDB with its logo, the required notice and a link to themoviedb.org', async () => {
    const { document, accountView, TMDB_NOTICE } = await renderer();
    const about = accountView(document);
    assert.equal(TMDB_NOTICE, 'This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.');
    assert.ok([...about.querySelectorAll('p')].some((paragraph) => paragraph.textContent === TMDB_NOTICE));
    const logo = about.querySelector('img.tmdb-logo');
    assert.equal(logo.getAttribute('src'), BUILT('tmdb-logo.svg'), 'bundled, not hotlinked');
    assert.ok(logo.getAttribute('alt'));
    const links = [...about.querySelectorAll('a')].map((anchor) => anchor.getAttribute('href'));
    assert.deepEqual(links, ['https://www.themoviedb.org/', 'https://www.themoviedb.org/', 'https://www.justwatch.com/']);
    // Where-to-watch data is JustWatch's (TMDB's terms for it): credited by name, with its US-only scope.
    assert.equal(about.querySelector('.justwatch-credit').textContent,
      'Which films each streaming service has (US availability only, the same for every household) comes from JustWatch, through TMDB.');
    assert.ok(about.querySelectorAll('h1').length === 1);
    assert.match(about.querySelector('.app-version').textContent, /^JellyPass \d+\.\d+\.\d+/, 'the version is in About & credits');
    // The logo is less prominent than the app's own name (TMDB's terms): small, in the credits only.
    matches(read(BUILT('app.css')), /\.tmdb-logo \{ width: 9rem/);
  });

  it('puts the member card with Sign out first, then About & credits, only while signed in, and keeps the TMDB credit', async () => {
    const { document, accountView, accountText, TMDB_NOTICE } = await renderer();
    let signedOutBy = 0;
    const view = accountView(document, { me: { name: 'Alice', household: 'Grove' }, onSignOut: (button) => { if (button.id === 'signout') signedOutBy += 1; } });
    assert.deepEqual([...view.querySelectorAll('h2')].map((heading) => heading.textContent), ['Account', 'About & credits']);
    assert.equal(view.querySelector('h1').textContent, 'Account');
    assert.ok(view.querySelector('h1').classList.contains('visually-hidden'), 'the header shows the title');
    assert.equal(view.querySelector('.account .account-name').textContent, 'Alice · Grove');
    const signOut = view.querySelector('.account button#signout');
    assert.equal(signOut.textContent, 'Sign out');
    assert.equal(signOut.getAttribute('type'), 'button');
    signOut.dispatchEvent(new (document.defaultView.Event)('click'));
    assert.equal(signedOutBy, 1);
    assert.equal(view.querySelectorAll('.inset-card').length, 2);
    assert.ok(view.querySelector('.account').compareDocumentPosition(view.querySelector('.credits')) & 4, 'the member card comes first');
    assert.ok([...view.querySelectorAll('p')].some((paragraph) => paragraph.textContent === TMDB_NOTICE), 'the notice is still there');
    assert.ok(view.querySelector('img.tmdb-logo'));
    assert.ok(view.querySelector('.justwatch-credit'));
    assert.equal(accountText(undefined), 'Signed in', 'before /me answers');
    assert.equal(accountText({ name: 'Alice', household: '' }), 'Alice');
    // No account: no member card and no Sign out; signed out, a way back to the sign-in on Home.
    const anonymous = accountView(document);
    assert.deepEqual([...anonymous.querySelectorAll('h2')].map((heading) => heading.textContent), ['About & credits']);
    assert.equal(anonymous.querySelector('#signout'), null);
    const out = accountView(document, undefined, true);
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
    for (const name of ['home', 'search', 'requests', 'account', 'back']) {
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
  async function openApp(t, app, { user = ALICE, host = HOST_A, signedIn = true, override, hash = '', holdMe, store: initialStore, storageFails = false, userAgent = '', clamp = false, intersection = true, rect } = {}) {
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
    // With `rect`, where each element is on the screen (only its `top` is read): for the lazy rows' scroll fallback.
    if (rect) {
      const ownRect = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect');
      HTMLElement.prototype.getBoundingClientRect = function () { return { top: rect(this), bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0 }; };
      t.after(() => {
        if (ownRect) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', ownRect);
        else delete HTMLElement.prototype.getBoundingClientRect;
      });
    }
    const store = new Map(initialStore ?? (signedIn ? [['jellyfin_credentials', JSON.stringify({
      Servers: [{ ManualAddress: origin, AccessToken: TOKENS[user], UserId: user }],
    })]] : []));
    const requests = [];
    // Calls not yet answered, and answers whose body the page is still reading: none means nothing is under way.
    let pending = 0;
    let meRead = false;
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
    // With `clamp`, the page is as tall as what is drawn (300 for a skeleton, 100 a card, 1000 a title's detail screen).
    const pageHeight = () => (document.querySelector('article.detail') ? 1000 : 300 + 100 * document.querySelectorAll('#screen .card').length);
    const clampScroll = () => {
      const limit = pageHeight();
      if (scroll.y > limit) {
        scroll.y = limit;
        for (const listener of listeners.scroll ?? []) listener({ type: 'scroll', target: document });
      }
    };
    // Home's lazy rows: an IntersectionObserver that reports a slot as near the screen only when the test says so
    // (`reveal`). With `intersection: false` there is none, and the page falls back to checking on scroll.
    const observers = [];
    class FakeIntersectionObserver {
      constructor(callback, options) { this.callback = callback; this.options = options; this.targets = new Set(); observers.push(this); }
      observe(target) { this.targets.add(target); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
    }
    /** The lazy slots being watched now, by key (strings only). */
    const watched = () => observers.flatMap((observer) => [...observer.targets].map((target) => target.getAttribute('data-key'))).sort();
    /** Says the lazy slot with this key has come near the screen. */
    const reveal = (key) => {
      for (const observer of observers) {
        for (const target of [...observer.targets]) {
          if (target.getAttribute('data-key') === key) observer.callback([{ target, isIntersecting: true }], observer);
        }
      }
    };
    // The sticky band's height, as a browser would measure it (it grows when the chips wrap); a ResizeObserver tells the page when it changes.
    const band = { height: 62 };
    const resizers = [];
    class FakeResizeObserver {
      constructor(callback) { this.callback = callback; this.targets = new Set(); resizers.push(this); }
      observe(target) { this.targets.add(target); }
      unobserve(target) { this.targets.delete(target); }
      disconnect() { this.targets.clear(); }
    }
    /** The band is now this tall (px): the observers fire, as on a resize. */
    const resizeBand = (height) => {
      band.height = height;
      for (const observer of resizers) if (observer.targets.size) observer.callback([...observer.targets].map((target) => ({ target })), observer);
    };
    const ownBandRect = rect ? undefined : Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect');
    if (!rect) {
      HTMLElement.prototype.getBoundingClientRect = function () { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: this.classList.contains('home-switch') ? band.height : this.classList.contains('app-header') ? 76 : this.classList.contains('tabbar') ? 90 : 0, x: 0, y: 0 }; };
      t.after(() => {
        if (ownBandRect) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', ownBandRect);
        else delete HTMLElement.prototype.getBoundingClientRect;
      });
    }
    const globals = {
      ...(intersection ? { IntersectionObserver: FakeIntersectionObserver } : {}),
      ResizeObserver: FakeResizeObserver,
      document,
      window: {
        scrollTo(_x, y) {
          scroll.y = y ?? 0;
          // A browser cannot scroll past the end of the page: it clamps, and says so with a scroll event.
          if (clamp) clampScroll();
        },
        get scrollY() { return scroll.y; },
        innerHeight: 844,
        addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
        // The page's network is the test server; Node's own fetch (used by the server itself) is left alone.
        fetch: async (url, init = {}) => {
          requests.push({ url, init });
          if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
          pending += 1;
          let answer;
          try {
            if (holdMe && url === '/jellypass/app/v1/me') await holdMe;
            answer = (await override?.(url, init)) ?? await (init.method === 'POST'
              ? post(app.port, url, { Host: host, ...init.headers }, init.body ? JSON.parse(init.body) : undefined)
              : get(app.port, url, { Host: host, ...init.headers }));
          } finally {
            pending -= 1;
          }
          const response = new Response(answer.body, { status: answer.status, headers: answer.headers });
          const read = response.json.bind(response);
          response.json = async () => {
            pending += 1;
            try {
              return await read();
            } finally {
              pending -= 1;
            }
          };
          if (url === '/jellypass/app/v1/me') {
            // The signal that /me is fully back: the page has read its body. `until` polls on timers, so the page's continuation has run by the time it sees this.
            const json = response.json.bind(response);
            response.json = async () => { const value = await json(); meRead = true; return value; };
          }
          return response;
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
    if (clamp) {
      const screen = main();
      const replace = screen.replaceChildren;
      screen.replaceChildren = function (...nodes) { replace.apply(this, nodes); clampScroll(); };
    }
    const back = () => document.getElementById('back');
    return { document, Event, until, go, main, requests, resizeBand, resizers, watched, reveal, observers, meRead: () => meRead, pending: () => pending, store, location, back, entries, cursor: () => index, scroll, sessionWrites, history: globals.history, window: globals.window, serialize: () => document.documentElement.outerHTML, listeners, focused: () => focused };
  }

  it('shows the four discover rows with each title\'s badge and no Play button on the cards', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app);
    await page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4 && page.document.querySelector('ul.logo-list'), 'four discover rows and the studios');
    assert.deepEqual([...page.document.querySelectorAll('.row-heading')].map((heading) => heading.textContent),
      ['Trending', 'Popular movies', 'Popular series', 'New movie releases', 'Studios']);
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
    // Calls: me, four lists and the networks and studios (no TMDB call), each with the token, never cached by the
    // browser, no cookies. The rows further down wait until they come near the screen.
    await page.until(() => page.requests.some((request) => request.url === '/jellypass/app/v1/discover/sources'), 'the sources');
    assert.deepEqual(page.requests.map((request) => request.url.replace(/\?.*/, '')).sort(), [
      '/jellypass/app/v1/discover/new-movies', '/jellypass/app/v1/discover/popular-movies', '/jellypass/app/v1/discover/popular-tv',
      '/jellypass/app/v1/discover/sources', '/jellypass/app/v1/discover/trending', '/jellypass/app/v1/me',
    ]);
    for (const { init } of page.requests) {
      assert.equal(init.cache, 'no-store');
      assert.equal(init.credentials, 'omit');
      assert.equal(init.headers.Authorization, 'MediaBrowser Token="token-alice"');
    }
    assertNoCanaries(page.serialize(), 'the page shows data that is not in a DTO');
    assert.equal(await accountName(page), 'Alice · Grove', 'the household and name are on About, not in the header');
  });

  it('draws Popular movies, Popular series and New movie releases as backdrop cards and every other row as posters, with no extra call', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app);
    await page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4 && page.watched().length === 10, 'Home');
    const kinds = {};
    for (const list of page.document.querySelectorAll('ul.row-list[aria-labelledby]')) {
      kinds[list.getAttribute('aria-labelledby')] = list.className;
    }
    assert.deepEqual(kinds, {
      'row-trending-heading': 'row-list',
      'row-popular-movies-heading': 'row-list row-list-backdrop',
      'row-popular-tv-heading': 'row-list row-list-backdrop',
      'row-new-movies-heading': 'row-list row-list-backdrop',
    });
    for (const id of ['row-popular-movies-heading', 'row-popular-tv-heading', 'row-new-movies-heading']) {
      const items = [...page.document.getElementById(id).parentElement.querySelectorAll('li.card-backdrop')];
      assert.ok(items.length > 0, id);
      for (const item of items) {
        const img = item.querySelector('img');
        if (!img) continue;
        for (const url of (img.getAttribute('srcset') ?? '').split(',').map((part) => part.trim().split(' ')[0]).filter(Boolean)) {
          assert.match(url, /^https:\/\/image\.tmdb\.org\/t\/p\/w(?:780|1280)\//);
        }
        assert.equal(img.getAttribute('loading'), 'lazy');
        assert.equal(item.querySelectorAll('a').length, 1);
      }
    }
    assert.equal(page.document.querySelectorAll('#row-trending-heading ~ .row-list li.card-backdrop').length, 0);
    assert.ok(page.document.querySelectorAll('.network-row li.card-backdrop, .logo-list li.card-backdrop').length === 0);
    assert.deepEqual(page.requests.map((request) => request.url.replace(/\?.*/, '')).sort(), [
      '/jellypass/app/v1/discover/new-movies', '/jellypass/app/v1/discover/popular-movies', '/jellypass/app/v1/discover/popular-tv',
      '/jellypass/app/v1/discover/sources', '/jellypass/app/v1/discover/trending', '/jellypass/app/v1/me',
    ]);
    assert.equal(app.tmdb.calls.filter((call) => call.pathname !== '/3/authentication').length, 4);
    // The rows below the fold draw as they are revealed: the upcoming rows are posters, and there are no All-time great rows.
    for (const key of ['row-upcoming', 'row-upcoming-tv']) {
      page.reveal(key);
      await page.until(() => page.document.querySelector(`#${key}-heading`), key);
    }
    for (const [id, className] of Object.entries({
      'row-upcoming-heading': 'row-list', 'row-upcoming-tv-heading': 'row-list',
    })) {
      assert.equal(page.document.querySelector(`ul[aria-labelledby="${id}"]`).className, className, id);
    }
    assert.deepEqual([...page.document.querySelectorAll('.row-heading')].map((heading) => heading.textContent).filter(Boolean),
      ['Trending', 'Popular movies', 'Popular series', 'New movie releases', 'Upcoming movies', 'Upcoming series', 'Studios']);
    assert.equal(page.document.querySelector('#row-top-movies-heading'), null);
    assert.equal(page.document.querySelector('#row-top-tv-heading'), null);
    assert.equal(app.tmdb.calls.some((call) => /top_rated/.test(call.pathname)), false, 'the all-time lists are not asked of TMDB');
    assertNoCanaries(page.serialize(), 'backdrop cards');
  });

  // One test (and so one page) per world: a page patches the test DOM's prototypes until its test ends.
  describe('backdrop rows against other households', () => {
    const worlds = { baseline: world(), ...Object.fromEntries(Object.entries(otherHouseholdWorlds())) };
    const seen = {};
    for (const [name, state] of Object.entries(worlds)) {
      it(`draws the popular rows with ${name === 'baseline' ? 'nothing else going on' : name}`, async (t) => {
        const app = await startApp(t, state);
        const page = await openApp(t, app);
        await page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4, `${name}: Home`);
        seen[name] = ['row-popular-movies-heading', 'row-popular-tv-heading', 'row-new-movies-heading'].map((id) => page.document.getElementById(id).parentElement.outerHTML).join('\n');
      });
    }
    it('draws them byte for byte the same in every world', () => {
      assert.ok(Object.keys(seen).length >= 5, Object.keys(seen).join());
      assert.ok(seen.baseline.includes('card-backdrop'));
      for (const [name, html] of Object.entries(seen)) assert.equal(html, seen.baseline, name);
    });
  });

  it('fetches Home\'s rows below the fold only as they come near the screen, one call each', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app);
    await page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4 && page.watched().length === 10, 'Home');
    const urls = () => page.requests.map((request) => request.url).sort();
    const tmdb = () => app.tmdb.calls.filter((call) => call.pathname !== '/3/authentication').length;
    // First load: the same four TMDB calls as before the network rows; the networks and studios cost none.
    assert.deepEqual(urls(), [
      '/jellypass/app/v1/discover/new-movies', '/jellypass/app/v1/discover/popular-movies', '/jellypass/app/v1/discover/popular-tv',
      '/jellypass/app/v1/discover/sources', '/jellypass/app/v1/discover/trending', '/jellypass/app/v1/me',
    ]);
    assert.equal(tmdb(), 4);
    assert.deepEqual(page.watched(), [
      'row-network-1024', 'row-network-213', 'row-network-2552', 'row-network-2739', 'row-network-3186', 'row-network-3353',
      'row-network-4330', 'row-network-453', 'row-upcoming', 'row-upcoming-tv',
    ]);
    assert.equal(page.observers.at(-1).options.rootMargin, '400px 0px', 'a row starts loading a little before it scrolls in');
    // Each waiting row holds a row-shaped skeleton, hidden from assistive technology.
    assert.equal(page.main().querySelectorAll('[data-lazy="waiting"] section.row[aria-hidden="true"] .skeleton').length, 10 * 13);
    // The Studios strip needs no title: it is drawn at once, each logo a link with the studio's name.
    assert.deepEqual([...page.main().querySelectorAll('ul.logo-list a')].map((link) => `${link.getAttribute('href')} ${link.getAttribute('aria-label')}`).slice(0, 3),
      ['#/studio/2 Disney movies', '#/studio/127928 20th Century Studios movies', '#/studio/34 Sony Pictures movies']);
    for (const image of page.main().querySelectorAll('ul.logo-list img')) {
      assert.match(image.getAttribute('src'), /^https:\/\/image\.tmdb\.org\/t\/p\/w300\/[A-Za-z0-9_-]+\.png$/);
      assert.equal(image.getAttribute('loading'), 'lazy');
    }

    page.reveal('row-upcoming-tv');
    await page.until(() => page.document.querySelector('#row-upcoming-tv-heading'), 'Upcoming series');
    assert.equal(page.document.querySelector('#row-upcoming-tv-heading').textContent, 'Upcoming series');
    page.reveal('row-network-213');
    const heading = await page.until(() => page.document.querySelector('#row-network-213-heading'), 'Popular on Netflix');
    const link = heading.querySelector('a');
    assert.equal(link.getAttribute('href'), '#/network/213');
    // The heading reads "Popular on Netflix": the visible words, then the logo's text alternative.
    assert.equal(link.querySelector('span').textContent, 'Popular on');
    assert.equal(link.querySelector('img').getAttribute('alt'), 'Netflix');
    assert.equal(link.querySelector('img').getAttribute('src'), 'https://image.tmdb.org/t/p/w300/wwemzKWzjKYJFfCeiB57q3r4Bcm.png');
    // One mixed row: the service's films and series, film first, each card saying which it is.
    const netflix = page.document.querySelector('ul[aria-labelledby="row-network-213-heading"]');
    assert.deepEqual([...netflix.querySelectorAll('.card')].map((card) => `${card.querySelector('.card-title').textContent} | ${card.querySelector('.card-meta').textContent}`),
      ['Synthetic Movie One | 2020 · Movie', 'Synthetic Series Two | 2019 · Series', 'Synthetic Movie Three | 2024 · Movie']);
    // Revealed again (or watched by an observer that fires twice), a row is never fetched twice.
    page.reveal('row-network-213');
    await pause(50);
    assert.equal(page.requests.filter((request) => request.url === '/jellypass/app/v1/discover/network/213/all').length, 1);
    assert.equal(page.requests.filter((request) => request.url === '/jellypass/app/v1/discover/upcoming-tv').length, 1);
    assert.equal(page.requests.length, 8);
    // Upcoming series is one TMDB call; a service's mixed row is two, its series and its films.
    assert.equal(tmdb(), 7);
    assert.deepEqual(app.tmdb.calls.slice(-2).map((call) => call.query.get('with_networks') ?? `${call.query.get('with_watch_providers')} ${call.query.get('watch_region')}`).sort(),
      ['213', '8|1796 US']);
    assert.equal(page.watched().length, 8);
    assertNoCanaries(page.serialize(), 'the page shows data that is not in a DTO');
  });

  it('without IntersectionObserver, fetches a lazy row once a scroll brings it near the screen', async (t) => {
    const app = await startApp(t);
    const tops = new Map();
    const page = await openApp(t, app, { intersection: false, rect: (element) => tops.get(element.getAttribute('data-key')) ?? 3000 });
    await page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4 && page.main().querySelectorAll('[data-lazy]').length === 10, 'Home');
    await pause(50);
    assert.equal(page.requests.length, 6, 'nothing below the fold yet');
    tops.set('row-upcoming-tv', 1200);
    for (const listener of page.listeners.scroll ?? []) listener({ type: 'scroll' });
    await page.until(() => page.document.querySelector('#row-upcoming-tv-heading'), 'Upcoming series, within 400px of the 844px screen');
    // Just past the margin (844 + 400): still waiting.
    tops.set('row-network-213', 1250);
    for (const listener of page.listeners.scroll ?? []) listener({ type: 'scroll' });
    await pause(50);
    assert.equal(page.requests.length, 7);
    tops.set('row-network-213', 1240);
    for (const listener of page.listeners.scroll ?? []) listener({ type: 'scroll' });
    await page.until(() => page.document.querySelector('#row-network-213-heading'), 'Netflix');
    await pause(50);
    assert.deepEqual(page.requests.slice(6).map((request) => request.url), ['/jellypass/app/v1/discover/upcoming-tv', '/jellypass/app/v1/discover/network/213/all']);
  });

  describe('fetch budget', () => {
    // How many app API calls each screen makes when opened, pinned in docs/app-api/fetch-budget.json: a household's
    // devices share one address's budget (300 calls in 5 minutes), so a change that makes the app chattier fails here
    // and has to change that file, where a native client reads the same numbers.
    const BUDGET = JSON.parse(readFileSync(path.join(import.meta.dirname, '..', 'docs', 'app-api', 'fetch-budget.json'), 'utf8'));
    // As `METHOD /path` without the prefix, a title's ID as `{tmdbId}` and a season's number as `{n}`, sorted (rows load in parallel).
    const calls = (page, from = 0) => page.requests.slice(from).map((request) => `${request.init.method ?? 'GET'} ${request.url.replace('/jellypass/app/v1', '').replace(/^\/(movie|tv)\/[0-9]+/, '/$1/{tmdbId}').replace(/^\/requests\/[A-Za-z0-9_-]{22}\/cancel$/, '/requests/{id}/cancel').replace(/\/season\/[0-9]+$/, '/season/{n}').replace(/^\/search\?q=[^&]*&/, '/search?q={query}&')}`).sort();
    const settled = async (page) => {
      // Every call answered and read, and nothing more asked for once the page has drawn what it read.
      let count;
      do {
        count = page.requests.length;
        await page.until(() => page.pending() === 0, 'every call answered and read');
        await new Promise((resolve) => setImmediate(resolve));
      } while (page.requests.length !== count || page.pending() !== 0);
    };
    async function revealAll(page) {
      const waiting = () => [...page.main().querySelectorAll('[data-lazy="waiting"]')];
      await page.until(() => waiting().every((slot) => page.watched().includes(slot.getAttribute('data-key'))), 'every waiting row observed');
      for (const slot of waiting()) page.reveal(slot.getAttribute('data-key'));
      await page.until(() => page.main().querySelectorAll('[data-lazy="waiting"], [data-lazy="loading"]').length === 0, 'every lazy row drawn');
    }

    it('is written down for every screen it pins, and only those, with the server\'s own budgets', () => {
      assert.deepEqual(BUDGET.limits, {
        perAddress: { calls: MAX_APP_REQUESTS_PER_CLIENT, windowSeconds: APP_BUDGET_WINDOW_MS / 1000 },
        perMember: { calls: MAX_APP_REQUESTS_PER_USER, windowSeconds: APP_BUDGET_WINDOW_MS / 1000 },
        perHousehold: { calls: MAX_APP_REQUESTS_PER_HOUSEHOLD_BURST, windowSeconds: APP_BURST_WINDOW_MS / 1000 },
      });
      assert.deepEqual(Object.keys(BUDGET.screens).sort(), ['home-all', 'home-movies', 'home-tv', 'movie', 'network', 'network-films', 'network-series', 'requests', 'search', 'season', 'series', 'studio', 'tv-discover', 'tv-discover-list', 'tv-discover-movies', 'tv-discover-network', 'tv-discover-studio', 'tv-discover-tv', 'tv-home-row', 'tv-movie', 'tv-requests', 'tv-search-row', 'tv-series']);
      for (const [name, screen] of Object.entries(BUDGET.screens)) {
        assert.equal(screen.calls, screen.atOnce.length + (screen.belowTheFold?.length ?? 0), name);
      }
    });

    for (const [name, hash] of [['home-all', '#/'], ['home-movies', '#/?kind=movies'], ['home-tv', '#/?kind=tv']]) {
      it(`Home (${name.slice(5)}), opened directly: the calls at once, then each lazy row once`, async (t) => {
        const app = await startApp(t);
        const page = await openApp(t, app, { hash });
        await page.until(() => page.main().querySelector('.hero-slide') && page.main().querySelectorAll('[data-lazy]').length > 0, 'Home');
        await settled(page);
        const atOnce = calls(page);
        await revealAll(page);
        await settled(page);
        const expected = BUDGET.screens[name];
        assert.deepEqual(atOnce, expected.atOnce);
        assert.deepEqual(calls(page, atOnce.length), expected.belowTheFold);
        assert.equal(page.requests.length, expected.calls);
      });
    }

    for (const [name, hash] of [['movie', `#/movie/${T_MOVIE}`], ['series', `#/tv/${T_TV}`], ['season', `#/tv/${T_TV}/season/1`]]) {
      it(`a ${name} page, opened directly`, async (t) => {
        const app = await startApp(t);
        const page = await openApp(t, app, { hash });
        await page.until(() => page.main().querySelector('article.detail, .season-list, .episode-list'), name);
        await settled(page);
        assert.deepEqual(calls(page), BUDGET.screens[name].atOnce);
        assert.equal(page.requests.length, BUDGET.screens[name].calls);
      });
    }

    it('Search, opened directly on a query', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app, { hash: '#/search?q=synthetic' });
      await page.until(() => page.main().querySelector('ul.grid, .search-results p.muted'), 'the results');
      await settled(page);
      assert.deepEqual(calls(page), BUDGET.screens.search.atOnce);
      assert.equal(page.requests.length, BUDGET.screens.search.calls);
    });

    // A network's or studio's listed ID as `{id}` (Home's own rows name theirs, so the shared `calls` keeps them).
    for (const [name, hash] of [['network', '#/network/213'], ['network-series', '#/network/213?kind=series'], ['network-films', '#/network/213?kind=films'], ['studio', '#/studio/3']]) {
      it(`a ${name.replace('-', "'s ")} page, opened directly: the sources, then the list's first page`, async (t) => {
        const app = await startApp(t);
        const page = await openApp(t, app, { hash });
        await page.until(() => page.main().querySelector('.source-panel ul.grid, .source-panel p.muted'), name);
        await settled(page);
        assert.deepEqual(calls(page).map((call) => call.replace(/\/discover\/(network|studio)\/[0-9]+/, '/discover/$1/{id}')).sort(), BUDGET.screens[name].atOnce);
        assert.equal(page.requests.length, BUDGET.screens[name].calls);
      });
    }

    it('My requests, opened directly: the list, then one call to name each request shown, a page at a time', async (t) => {
      const app = await startApp(t);
      const list = (results) => (url) => (url === '/jellypass/app/v1/requests' ? { status: 200, body: Buffer.from(JSON.stringify({ results })), headers: { 'content-type': 'application/json' } } : undefined);
      const named = (page) => page.until(() => page.main().querySelectorAll('.request').length > 0
        && [...page.main().querySelectorAll('.request .card-title')].every((title) => title.textContent !== 'Loading title…'), 'the titles');
      const two = [
        { id: 'a', mediaType: 'movie', tmdbId: T_MOVIE, status: 'requested', seasons: [], byYou: true },
        { id: 'b', mediaType: 'tv', tmdbId: T_TV, status: 'ready', seasons: [{ seasonNumber: 1, status: 'ready' }], byYou: false },
      ];
      const page = await openApp(t, app, { hash: '#/requests', override: list(two) });
      await named(page);
      await settled(page);
      assert.deepEqual(calls(page), BUDGET.screens.requests.atOnce);
      assert.equal(page.requests.length, BUDGET.screens.requests.calls);

      // Each its own title (a title read once in this sign-in is not read again).
      const many = Array.from({ length: 25 }, (_, index) => ({ id: `id${index}`, mediaType: 'movie', tmdbId: 910_000 + index, status: 'requested', seasons: [], byYou: true }));
      const long = await openApp(t, app, { hash: '#/requests', override: list(many) });
      await named(long);
      await settled(long);
      assert.equal(long.requests.length, 2 + BUDGET.screens.requests.titlesAtOnce);
    });

    it('My requests, shown again within ten minutes: the list only, its titles reused', async (t) => {
      const app = await startApp(t);
      const two = [
        { id: 'a', mediaType: 'movie', tmdbId: T_MOVIE, status: 'requested', seasons: [], byYou: true },
        { id: 'b', mediaType: 'tv', tmdbId: T_TV, status: 'ready', seasons: [{ seasonNumber: 1, status: 'ready' }], byYou: false },
      ];
      const page = await openApp(t, app, { hash: '#/requests', override: (url) => (url === '/jellypass/app/v1/requests' ? { status: 200, body: Buffer.from(JSON.stringify({ results: two })), headers: { 'content-type': 'application/json' } } : undefined) });
      await page.until(() => page.main().querySelectorAll('.request .card-title').length === 2
        && [...page.main().querySelectorAll('.request .card-title')].every((title) => title.textContent !== 'Loading title…'), 'the titles');
      await settled(page);
      assert.equal(page.requests.length, BUDGET.screens.requests.calls);
      page.go('#/account');
      await page.until(() => page.main().querySelector('.account'), 'Account');
      await settled(page);
      const before = page.requests.length;
      page.go('#/requests');
      await page.until(() => page.main().querySelectorAll('.request .card-title').length === 2
        && [...page.main().querySelectorAll('.request .card-title')].every((title) => title.textContent !== 'Loading title…'), 'the titles again');
      await settled(page);
      assert.deepEqual(calls(page, before), BUDGET.screens.requests.revisit);
      assert.deepEqual([...page.main().querySelectorAll('.request .card-title')].map((title) => title.textContent), ['Synthetic Movie One', 'Synthetic Series Two']);
    });
    describe('My requests: Cancel request', () => {
      const ID = 'AAAAAAAAAAAAAAAAAAAAAA';
      const ID2 = 'BBBBBBBBBBBBBBBBBBBBBB';
      const json = (body, status = 200) => ({ status, body: Buffer.from(JSON.stringify(body)), headers: { 'content-type': 'application/json' } });
      const entry = (id, tmdbId, extras = {}) => ({ id, mediaType: tmdbId === T_TV ? 'tv' : 'movie', tmdbId, status: 'requested', seasons: [], byYou: true, ...extras });
      const named = (page, count) => page.until(() => page.main().querySelectorAll('.request').length === count
        && [...page.main().querySelectorAll('.request .card-title')].every((title) => title.textContent !== 'Loading title…'), 'the titles');
      const click = (page, node) => node.dispatchEvent(new page.Event('click', { bubbles: true }));
      /** A server whose list is `state.list` and whose cancel answers `state.cancel` (and takes the entry off the list when it is 202). */
      const server = (state) => (url, init) => {
        if (url === '/jellypass/app/v1/requests') return json({ results: state.list });
        if (init?.method === 'POST' && /\/requests\/[A-Za-z0-9_-]{22}\/cancel$/.test(url)) {
          state.posts.push({ url, body: init.body });
          if (state.cancel === 202) {
            state.list = state.list.filter((item) => !url.includes(item.id));
            return json({ status: 'accepted' }, 202);
          }
          return { status: state.cancel, body: Buffer.from('{"error":"upstream said something private"}'), headers: { 'content-type': 'application/json' } };
        }
        return undefined;
      };

      it('offers Cancel request only on entries the server says are cancellable, and shows the day asked, no time', async (t) => {
        const app = await startApp(t);
        const state = { posts: [], cancel: 202, list: [
          entry(ID, T_MOVIE, { cancellable: true, requestedOn: '2026-10-27' }),
          entry(ID2, T_TV, { cancellable: false, requestedOn: '2026-01-02' }),
          entry('CCCCCCCCCCCCCCCCCCCCCC', 910_003),
        ] };
        const page = await openApp(t, app, { hash: '#/requests', override: server(state) });
        await named(page, 3);
        const items = [...page.main().querySelectorAll('.request')];
        assert.deepEqual(items.map((item) => item.querySelectorAll('button.request-cancel').length), [1, 0, 0], 'an older server (no cancellable) has none');
        const button = items[0].querySelector('button.request-cancel');
        assert.equal(button.textContent, 'Cancel request');
        assert.equal(button.getAttribute('aria-label'), 'Cancel request: ' + items[0].querySelector('.card-title').textContent);
        assert.deepEqual(items.map((item) => item.querySelector('.request-on')?.textContent), ['Requested on Oct 27, 2026', 'Requested on Jan 2, 2026', undefined]);
        assert.equal(state.posts.length, 0);
      });

      it('asks first: the confirmation says what Cancel does, Keep (or Escape) sends nothing and puts focus back', async (t) => {
        const app = await startApp(t);
        const state = { posts: [], cancel: 202, list: [entry(ID, T_MOVIE, { cancellable: true, requestedOn: '2026-10-27' })] };
        const page = await openApp(t, app, { hash: '#/requests', override: server(state) });
        await named(page, 1);
        const item = page.main().querySelector('.request');
        const panel = item.querySelector('.request-cancel-panel');
        assert.equal(panel.hidden, true);
        click(page, item.querySelector('.request-cancel'));
        assert.equal(panel.hidden, false);
        assert.equal(panel.getAttribute('role'), 'group');
        assert.equal(panel.querySelector('.request-cancel-body').textContent, "This withdraws your household's request. If it has already been approved, the download may still finish, but it won't be added for your household.");
        assert.deepEqual([...panel.querySelectorAll('button')].map((button) => button.textContent), ['Cancel request', 'Keep request']);
        assert.equal(page.focused()?.textContent, 'Cancel this request?');
        click(page, [...panel.querySelectorAll('button')][1]);
        assert.equal(panel.hidden, true);
        assert.equal(page.focused()?.classList.contains('request-cancel'), true);
        click(page, item.querySelector('.request-cancel'));
        panel.dispatchEvent(Object.assign(new page.Event('keydown', { bubbles: true }), { key: 'Escape' }));
        assert.equal(panel.hidden, true);
        assert.equal(state.posts.length, 0, 'nothing sent until confirmed');
        assert.equal(page.requests.filter((request) => request.init.method === 'POST').length, 0);
      });

      it('confirming sends one POST with an empty object, drops the entry, says Request cancelled, and reads the list again (the pinned budget)', async (t) => {
        const app = await startApp(t);
        const state = { posts: [], cancel: 202, list: [entry(ID, T_MOVIE, { cancellable: true, requestedOn: '2026-10-27' }), entry(ID2, T_TV, { cancellable: true, requestedOn: '2026-10-26' })] };
        const page = await openApp(t, app, { hash: '#/requests', override: server(state) });
        await named(page, 2);
        await settled(page);
        const before = page.requests.length;
        const item = page.main().querySelector('.request');
        click(page, item.querySelector('.request-cancel'));
        click(page, item.querySelector('.request-cancel-actions button'));
        await page.until(() => page.main().querySelectorAll('.request').length === 1 && page.main().querySelector('.get-message')?.textContent === 'Request cancelled', 'the entry gone and the confirmation');
        await settled(page);
        assert.equal(state.posts.length, 1);
        assert.equal(state.posts[0].url, `/jellypass/app/v1/requests/${ID}/cancel`);
        assert.equal(state.posts[0].body, '{}');
        assert.deepEqual(calls(page, before), BUDGET.screens.requests.cancel);
        assert.equal(page.main().querySelector('.request .request-link').getAttribute('href'), `#/tv/${T_TV}`);
        assert.equal(page.focused()?.textContent, 'Request cancelled');
        assert.equal(page.main().querySelector('.request .card-title').textContent !== 'Loading title…', true, 'the other entry stays named without a title call');
      });

      it('overlapping cancel refreshes: an older list answering last never brings a cancelled entry back', async (t) => {
        const app = await startApp(t);
        const ID3 = 'CCCCCCCCCCCCCCCCCCCCCC';
        const all = [entry(ID, T_MOVIE, { cancellable: true }), entry(ID2, T_TV, { cancellable: true }), entry(ID3, T_MOVIE, { cancellable: true })];
        const state = { posts: [], cancel: 202, list: all };
        const reads = [];
        const inner = server(state);
        const override = (url, init) => {
          if (url === '/jellypass/app/v1/requests') {
            reads.push(reads.length);
            // The first read opens the screen; the second (A's refresh) is held and answers with the list from before both cancels.
            if (reads.length === 2) return new Promise((resolve) => { state.release = () => resolve(json({ results: all })); });
          }
          return inner(url, init);
        };
        const page = await openApp(t, app, { hash: '#/requests', override });
        await named(page, 3);
        await settled(page);
        const items = [...page.main().querySelectorAll('.request')];
        click(page, items[0].querySelector('.request-cancel'));
        click(page, items[0].querySelector('.request-cancel-actions button'));
        await page.until(() => reads.length === 2, 'A refresh in flight');
        click(page, items[1].querySelector('.request-cancel'));
        click(page, items[1].querySelector('.request-cancel-actions button'));
        await page.until(() => reads.length === 3 && page.main().querySelectorAll('.request').length === 1, 'B refresh answered first');
        state.release();
        await settled(page);
        await settled(page);
        assert.equal(page.main().querySelectorAll('.request').length, 1, 'only the third entry is left');
        assert.equal(state.posts.length, 2);
      });

      it('overlapping cancel refreshes: an older list failing last never replaces the newer list with an error', async (t) => {
        const app = await startApp(t);
        const ID3 = 'CCCCCCCCCCCCCCCCCCCCCC';
        const all = [entry(ID, T_MOVIE, { cancellable: true }), entry(ID2, T_TV, { cancellable: true }), entry(ID3, T_MOVIE, { cancellable: true })];
        const state = { posts: [], cancel: 202, list: all };
        const reads = [];
        const inner = server(state);
        const override = (url, init) => {
          if (url === '/jellypass/app/v1/requests') {
            reads.push(reads.length);
            // A's refresh is held and then fails; B's refresh answers first with the list that has one entry left.
            if (reads.length === 2) return new Promise((resolve) => { state.release = () => resolve(json({ error: 'x' }, 500)); });
          }
          return inner(url, init);
        };
        const page = await openApp(t, app, { hash: '#/requests', override });
        await named(page, 3);
        await settled(page);
        const items = [...page.main().querySelectorAll('.request')];
        click(page, items[0].querySelector('.request-cancel'));
        click(page, items[0].querySelector('.request-cancel-actions button'));
        await page.until(() => reads.length === 2, 'A refresh in flight');
        click(page, items[1].querySelector('.request-cancel'));
        click(page, items[1].querySelector('.request-cancel-actions button'));
        await page.until(() => reads.length === 3 && page.main().querySelectorAll('.request').length === 1, 'B refresh answered first');
        state.release();
        await settled(page);
        await settled(page);
        assert.equal(page.main().querySelectorAll('.request').length, 1, 'the list with one entry stays');
        assert.equal(page.main().querySelector('.get-refresh'), null, 'no error screen');
        assert.equal(page.main().querySelector('.get-message')?.textContent, 'Request cancelled');
      });

      it('cancelling the last request leaves the confirmation and the empty message', async (t) => {
        const app = await startApp(t);
        const state = { posts: [], cancel: 202, list: [entry(ID, T_MOVIE, { cancellable: true, requestedOn: '2026-10-27' })] };
        const page = await openApp(t, app, { hash: '#/requests', override: server(state) });
        await named(page, 1);
        const item = page.main().querySelector('.request');
        click(page, item.querySelector('.request-cancel'));
        click(page, item.querySelector('.request-cancel-actions button'));
        await page.until(() => page.main().querySelector('.get-message')?.textContent === 'Request cancelled' && page.main().querySelector('p.muted')?.textContent.startsWith('Nothing requested yet'), 'confirmation and empty');
        assert.equal(page.main().querySelectorAll('.request').length, 0);
      });

      for (const [status, text] of [[429, 'Too many tries, try again in a few minutes.'], [500, "We couldn't cancel that just now. Try again in a moment."], [404, "We couldn't cancel that just now. Try again in a moment."]]) {
        it(`a ${status} is its one fixed message, nothing from the response, no retry; the entry stays and can be tried again`, async (t) => {
          const app = await startApp(t);
          const state = { posts: [], cancel: status, list: [entry(ID, T_MOVIE, { cancellable: true, requestedOn: '2026-10-27' })] };
          const page = await openApp(t, app, { hash: '#/requests', override: server(state) });
          await named(page, 1);
          const item = page.main().querySelector('.request');
          click(page, item.querySelector('.request-cancel'));
          const [confirm, keep] = item.querySelectorAll('.request-cancel-actions button');
          click(page, confirm);
          await page.until(() => item.querySelector('.request-cancel-panel .get-message')?.textContent === text, 'the fixed message');
          await pause(80);
          assert.equal(state.posts.length, 1, 'never repeated by the app');
          assert.equal(page.main().querySelectorAll('.request').length, 1);
          assert.equal(confirm.disabled, false);
          assert.equal(keep.disabled, false);
          assert.equal(confirm.textContent, 'Cancel request');
          assert.ok(!page.serialize().includes('upstream said'));
          state.cancel = 202;
          click(page, confirm);
          await page.until(() => page.main().querySelectorAll('.request').length === 0, 'cancelled on the second try');
          assert.equal(state.posts.length, 2);
        });
      }

      it('shows the same thing whatever the server did with a cancel it accepted: the same 202 leaves the same page', async (t) => {
        const run = async (list) => {
          const app = await startApp(t);
          const state = { posts: [], cancel: 202, list };
          const page = await openApp(t, app, { hash: '#/requests', override: server(state) });
          await named(page, 1);
          const item = page.main().querySelector('.request');
          click(page, item.querySelector('.request-cancel'));
          click(page, item.querySelector('.request-cancel-actions button'));
          await page.until(() => page.main().querySelector('.get-message')?.textContent === 'Request cancelled', 'cancelled');
          return page.main().textContent;
        };
        const a = await run([entry(ID, T_MOVIE, { cancellable: true, requestedOn: '2026-10-27' })]);
        const b = await run([entry(ID, T_MOVIE, { cancellable: true, requestedOn: '2026-10-27', byYou: false })]);
        assert.equal(a, b);
      });
    });

    describe('My requests filters', () => {
      const entry = (id, mediaType, status, byYou, seasons = []) => ({ id, mediaType, tmdbId: 910_000 + Number(id.slice(1)), status, seasons, byYou });
      const LIST = [
        entry('r1', 'movie', 'requested', true),
        entry('r2', 'movie', 'ready', false),
        entry('r3', 'tv', 'requested', true, [{ seasonNumber: 1, status: 'ready' }, { seasonNumber: 2, status: 'requested' }]),
        entry('r4', 'tv', 'failed', false),
        entry('r5', 'movie', 'failed', true),
        entry('r6', 'tv', 'ready', false, [{ seasonNumber: 1, status: 'ready' }]),
      ];
      const list = (results) => (url) => (url === '/jellypass/app/v1/requests' ? { status: 200, body: Buffer.from(JSON.stringify({ results })), headers: { 'content-type': 'application/json' } } : undefined);
      const named = (page, count) => page.until(() => page.main().querySelectorAll('.request').length === count
        && [...page.main().querySelectorAll('.request .card-title')].every((title) => title.textContent !== 'Loading title…'), 'the titles');
      const ids = (page) => [...page.main().querySelectorAll('.request')].filter((item) => !item.hidden).map((item) => item.querySelector('.request-link').getAttribute('href').replace(/^#\/(movie|tv)\/91000/, 'r'));
      const chip = (page, group, value) => page.main().querySelector(`button[data-filter-group="${group}"][data-filter="${value}"]`);
      const press = (page, group, value) => chip(page, group, value).dispatchEvent(new page.Event('click', { bubbles: true }));
      const pressed = (page) => [...page.main().querySelectorAll('.request-filters button')].filter((button) => button.getAttribute('aria-pressed') === 'true').map((button) => button.textContent);
      const emptyText = (page) => { const box = page.main().querySelector('.request-none'); return box.hidden ? null : box.querySelector('p').textContent; };
      const open = async (t, results = LIST) => {
        const app = await startApp(t);
        const page = await openApp(t, app, { hash: '#/requests', override: list(results) });
        await named(page, results.length);
        await settled(page);
        return { app, page };
      };

      it('is Status, Type and Asked by me: named groups of real buttons, All chosen, 44px chips from the Home chips', async (t) => {
        const { page } = await open(t);
        const groups = [...page.main().querySelectorAll('.request-filters [role="group"]')];
        assert.deepEqual(groups.map((group) => group.getAttribute('aria-label')), ['Status', 'Type', 'Who']);
        assert.deepEqual([...groups[0].querySelectorAll('button')].map((button) => button.textContent), ['All', 'Requested', 'Ready to watch', "Couldn't get this"]);
        assert.deepEqual([...groups[1].querySelectorAll('button')].map((button) => button.textContent), ['All', 'Films', 'Series']);
        assert.deepEqual([...groups[2].querySelectorAll('button')].map((button) => button.textContent), ['Asked by me']);
        for (const button of page.main().querySelectorAll('.request-filters button')) {
          assert.equal(button.getAttribute('type'), 'button');
          assert.equal(button.className, 'segment');
        }
        assert.deepEqual(pressed(page), ['All', 'All']);
        assert.deepEqual(ids(page), ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
        assert.equal(emptyText(page), null);
        const css = read(BUILT('app.css'));
        matches(css, /\.segment\{[^}]*min-height:\s*2\.75rem|\.segment \{[^}]*min-height:\s*2\.75rem/, 'a chip is 44px tall at least');
        matches(css, /\.segment\[aria-pressed='true'\]/, 'a pressed chip is styled like a chosen one');
      });

      it('filters by status, type and Asked by me, alone and together, and a series matches a status any of its seasons shows', async (t) => {
        const { page } = await open(t);
        press(page, 'status', 'requested');
        assert.deepEqual(ids(page), ['r1', 'r3'], 'r3 has a season still requested');
        press(page, 'status', 'ready');
        assert.deepEqual(ids(page), ['r2', 'r3', 'r6'], 'r3 has a season ready too');
        press(page, 'status', 'failed');
        assert.deepEqual(ids(page), ['r4', 'r5']);
        assert.equal(page.main().querySelectorAll('.request:not([hidden]) .failed-note').length, 2, 'the admin note stays under each failed entry');
        press(page, 'status', 'all');
        press(page, 'kind', 'tv');
        assert.deepEqual(ids(page), ['r3', 'r4', 'r6']);
        press(page, 'kind', 'movie');
        assert.deepEqual(ids(page), ['r1', 'r2', 'r5']);
        press(page, 'kind', 'all');
        press(page, 'byYou', 'byYou');
        assert.deepEqual(ids(page), ['r1', 'r3', 'r5']);
        assert.deepEqual(pressed(page), ['All', 'All', 'Asked by me']);
        press(page, 'status', 'requested');
        press(page, 'kind', 'tv');
        assert.deepEqual(ids(page), ['r3']);
        assert.deepEqual(pressed(page), ['Requested', 'Series', 'Asked by me']);
        press(page, 'byYou', 'byYou');
        assert.deepEqual(ids(page), ['r3']);
        press(page, 'kind', 'movie');
        press(page, 'status', 'ready');
        assert.deepEqual(ids(page), ['r2']);
      });

      it('makes no call when a filter changes: the same calls, the same titles, the cache untouched', async (t) => {
        const { app, page } = await open(t);
        const before = page.requests.length;
        const tmdb = app.tmdb.calls.length;
        for (const [group, value] of [['status', 'ready'], ['kind', 'tv'], ['byYou', 'byYou'], ['status', 'failed'], ['kind', 'movie'], ['status', 'all'], ['kind', 'all'], ['byYou', 'byYou']]) {
          press(page, group, value);
          await settled(page);
        }
        assert.equal(page.requests.length, before, 'no call to the API');
        assert.equal(app.tmdb.calls.length, tmdb, 'no call to TMDB');
        assert.equal(before, 2 + LIST.length, 'Me, the list, then one call to name each');
        assert.deepEqual(ids(page), ['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
      });

      it('leaves the reuse of read titles alone: with a filter chosen, a revisit reads the list only', async (t) => {
        const known = [
          { id: 'a', mediaType: 'movie', tmdbId: T_MOVIE, status: 'requested', seasons: [], byYou: true },
          { id: 'b', mediaType: 'tv', tmdbId: T_TV, status: 'ready', seasons: [{ seasonNumber: 1, status: 'ready' }], byYou: false },
        ];
        const { page } = await open(t, known);
        press(page, 'status', 'ready');
        await settled(page);
        assert.equal(page.requests.length, BUDGET.screens.requests.calls);
        page.go('#/account');
        await page.until(() => page.main().querySelector('.account'), 'Account');
        await settled(page);
        const mark = page.requests.length;
        page.go('#/requests');
        await named(page, 2);
        await settled(page);
        assert.deepEqual(calls(page, mark), BUDGET.screens.requests.revisit);
        assert.deepEqual(pressed(page), ['Ready to watch', 'All']);
        assert.deepEqual([...page.main().querySelectorAll('.request:not([hidden]) .card-title')].map((title) => title.textContent), ['Synthetic Series Two']);
      });

      it('says what a filter left nothing of, for each filter, and Show all requests clears them', async (t) => {
        const only = [entry('r1', 'movie', 'requested', false), entry('r2', 'tv', 'ready', false, [{ seasonNumber: 1, status: 'ready' }])];
        const { page } = await open(t, only);
        const text = (status, kind, byYou) => {
          press(page, 'status', status);
          press(page, 'kind', kind);
          if (byYou !== (pressed(page).includes('Asked by me'))) press(page, 'byYou', 'byYou');
          return emptyText(page);
        };
        assert.equal(text('failed', 'all', false), "No requests we couldn't get.");
        assert.equal(text('ready', 'movie', false), 'No films ready to watch.');
        assert.equal(text('requested', 'tv', false), 'No series still requested.');
        assert.equal(text('all', 'all', true), 'No requests asked for by you.');
        assert.equal(text('all', 'tv', true), 'No series asked for by you.');
        assert.equal(text('ready', 'tv', true), 'No series ready to watch, asked for by you.');
        assert.equal(text('failed', 'movie', true), "No films we couldn't get, asked for by you.");
        assert.deepEqual(ids(page), []);
        assert.ok(!page.main().querySelector('.request-none button').hidden);
        page.main().querySelector('.request-none button').dispatchEvent(new page.Event('click', { bubbles: true }));
        assert.equal(emptyText(page), null);
        assert.deepEqual(pressed(page), ['All', 'All']);
        assert.deepEqual(ids(page), ['r1', 'r2']);
        assert.ok(page.main().querySelector('.request-none button').hidden, 'nothing to clear');
        // Some matches: no empty text.
        assert.equal(text('ready', 'all', false), null);
      });

      it('says more may match, under the entries that pass, while a filter is on and entries are still to load', async (t) => {
        const twelve = Array.from({ length: 12 }, (_, index) => entry(`r${index + 1}`, 'movie', index % 2 ? 'ready' : 'requested', false));
        const app = await startApp(t);
        const page = await openApp(t, app, { hash: '#/requests', override: list(twelve) });
        await named(page, 10);
        await settled(page);
        const hint = () => { const node = page.main().querySelector('.request-more-hint'); return node && !node.hidden ? node.textContent : null; };
        assert.equal(hint(), null);
        press(page, 'status', 'ready');
        assert.equal(ids(page).length, 5);
        assert.equal(hint(), 'More may match — Load more to look further.');
        assert.equal(emptyText(page), null);
        page.main().querySelector('.load-more').dispatchEvent(new page.Event('click', { bubbles: true }));
        await named(page, 12);
        assert.equal(ids(page).length, 6);
        assert.equal(hint(), null);
      });

      it('drops the filters on a 401, even when the same token signs in again', async (t) => {
        let refuse = false;
        const serve = list(LIST);
        const app = await startApp(t);
        const page = await openApp(t, app, { hash: '#/requests', override: (url) => (refuse && url === '/jellypass/app/v1/requests' ? { status: 401, body: Buffer.from('{"error":"unauthorized"}'), headers: { 'content-type': 'application/json' } } : serve(url)) });
        await named(page, LIST.length);
        press(page, 'status', 'ready');
        press(page, 'kind', 'movie');
        press(page, 'byYou', 'byYou');
        assert.deepEqual(pressed(page), ['Ready to watch', 'Films', 'Asked by me']);
        page.go('#/account');
        await page.until(() => page.main().querySelector('.account'), 'Account');
        refuse = true;
        page.go('#/requests');
        await page.until(() => page.main().querySelector('h1')?.textContent === 'Sign in', 'the sign-in state');
        // The same token is still stored, so the person is back on My requests with it: the filters are not.
        refuse = false;
        page.go('#/account');
        await page.until(() => page.main().querySelector('.account'), 'Account again');
        page.go('#/requests');
        await named(page, LIST.length);
        assert.deepEqual(pressed(page), ['All', 'All']);
        assert.deepEqual(ids(page), LIST.map((item) => item.id));
      });

      it('keeps the filters while the app is open (leaving and coming back) and drops them for another member or a sign-out', async (t) => {
        const { app, page } = await open(t);
        press(page, 'status', 'ready');
        press(page, 'kind', 'movie');
        press(page, 'byYou', 'byYou');
        assert.deepEqual(ids(page), []);
        page.go('#/account');
        await page.until(() => page.main().querySelector('.account'), 'Account');
        page.go('#/requests');
        await named(page, LIST.length);
        assert.deepEqual(pressed(page), ['Ready to watch', 'Films', 'Asked by me'], 'remembered');
        assert.deepEqual(ids(page), []);
        assert.ok(emptyText(page));
        // Another member signs in (Jellyfin web in another tab): the screen is drawn again for them, unfiltered.
        const signIn = (user) => {
          page.store.set('jellyfin_credentials', JSON.stringify({ Servers: [{ ManualAddress: page.location.origin, AccessToken: TOKENS[user], UserId: user }] }));
          for (const listener of page.listeners.storage ?? []) listener({ key: 'jellyfin_credentials' });
        };
        signIn(ANN);
        await page.until(() => ids(page).length === LIST.length, 'the list again, unfiltered');
        assert.deepEqual(pressed(page), ['All', 'All']);
        // Chosen again, then signed out elsewhere and back in as the same member: still dropped.
        press(page, 'kind', 'tv');
        assert.deepEqual(ids(page), ['r3', 'r4', 'r6']);
        page.store.set('jellyfin_credentials', JSON.stringify({ Servers: [{ ManualAddress: page.location.origin }] }));
        for (const listener of page.listeners.storage ?? []) listener({ key: 'jellyfin_credentials' });
        await page.until(() => page.main().querySelector('ul.profiles'), 'signed out');
        signIn(ANN);
        await page.until(() => ids(page).length === LIST.length, 'the list again');
        assert.deepEqual(pressed(page), ['All', 'All']);
        assert.ok(app);
      });
    });
  });

  describe('Home\'s All | Movies | TV switch', () => {
    const tmdbCount = (app) => app.tmdb.calls.filter((call) => call.pathname !== '/3/authentication').length;
    const urls = (page) => page.requests.map((request) => request.url.replace(/\?.*/, '').replace('/jellypass/app/v1', ''));
    const headings = (page) => [...page.document.querySelectorAll('.row-heading')].map((heading) => heading.textContent).filter(Boolean);
    const radios = (page) => [...page.main().querySelectorAll('[role="radiogroup"] [role="radio"]')];
    const state = (page) => radios(page).map((radio) => `${radio.textContent} ${radio.getAttribute('aria-checked')} ${radio.getAttribute('tabindex')}`);
    const key = (page, name) => {
      const event = new page.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'key', { value: name });
      page.focused().dispatchEvent(event);
      return event;
    };
    const ready = (page, label, count = 4) => page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === count && page.main().querySelector('.hero-slide'), label);
    /** Reveals every lazy row that is waiting, and waits for each to draw. */
    async function revealAll(page) {
      // A slot can be waiting before the page has started observing it, and revealing it then would be lost.
      const waiting = () => [...page.main().querySelectorAll('[data-lazy="waiting"]')];
      await page.until(() => waiting().every((slot) => page.watched().includes(slot.getAttribute('data-key'))), 'every waiting row observed');
      for (const slot of waiting()) page.reveal(slot.getAttribute('data-key'));
      await page.until(() => page.main().querySelectorAll('[data-lazy="waiting"], [data-lazy="loading"]').length === 0, 'every lazy row drawn');
    }

    it('is a radio group of three real buttons under the header, above the hero: one choice, roving tabindex, named by its label', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app);
      await ready(page, 'Home');
      const group = page.main().querySelector('[role="radiogroup"]');
      assert.equal(group.getAttribute('aria-label'), 'Show');
      assert.deepEqual(state(page), ['All true 0', 'Movies false -1', 'TV false -1']);
      assert.deepEqual(radios(page).map((radio) => `${radio.tagName} ${radio.getAttribute('type')} ${radio.getAttribute('aria-controls')}`), Array(3).fill('BUTTON button home-panel'));
      // Under the header and above the hero (a plain div) and the rows, as direct children of the page's main region so it can stick while the rows scroll.
      const order = [...page.main().children].map((node) => node.className || node.id || node.tagName);
      assert.deepEqual(order.slice(-3), ['home-switch', 'DIV', 'home-panel']);
      assert.equal(group.parentElement.className, 'home-switch');
      assert.equal(group.parentElement.parentElement, page.main());
      const panel = page.main().querySelector('#home-panel');
      assert.equal(panel.getAttribute('role'), 'group');
      assert.equal(panel.getAttribute('aria-labelledby'), 'home-filter-all');
      assert.equal(page.document.getElementById('home-filter-all').textContent, 'All');
      // Each chip carries a tick, drawn by the app and hidden from assistive technology, so a name is still the plain word; the stylesheet shows it on the chosen chip only.
      for (const radio of radios(page)) {
        const ticks = radio.querySelectorAll('svg.icon');
        assert.equal(ticks.length, 1);
        assert.equal(ticks[0].getAttribute('aria-hidden'), 'true');
        assert.equal(ticks[0].getAttribute('focusable'), 'false');
      }
      assert.doesNotMatch(page.serialize().replace(/<style[^]*?<\/style>/gi, '').replace(/<html style="(?:--(?:switch-height|header-box|tabbar-box):[0-9.]+px;?\s*)+"/, '<html'), /\sstyle=/);
    });

    it('All is today\'s Home: the same four TMDB calls at first load, rows in the order the design gives', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app);
      await ready(page, 'Home');
      await page.until(() => page.watched().length === 10, 'the lazy rows');
      assert.equal(tmdbCount(app), 4);
      assert.deepEqual(urls(page).sort(), ['/discover/new-movies', '/discover/popular-movies', '/discover/popular-tv', '/discover/sources', '/discover/trending', '/me']);
      await revealAll(page);
      assert.deepEqual(headings(page), ['Trending', 'Popular movies', 'Popular series', 'New movie releases', 'Upcoming movies', 'Upcoming series',
        'Popular on', 'Popular on', 'Popular on', 'Popular on', 'Popular on', 'Popular on', 'Popular on', 'Popular on', 'Studios']);
      // Rows in the order given: the services' rows come before the studios' strip, then the all-time lists, then the JustWatch credit.
      const slots = [...page.main().querySelectorAll('#home-panel > *')].map((slot) => slot.getAttribute('data-key')
        ?? (slot.querySelector('[data-key^="row-network-"]') ? 'networks' : slot.querySelector('.source-note') ? 'credit' : slot.querySelector('.hero, ul.logo-list') ? 'studios' : slot.querySelector('ul.row-list') ? 'row' : 'empty'));
      assert.deepEqual(slots, ['row', 'row', 'row', 'row', 'row-upcoming', 'row-upcoming-tv', 'networks', 'studios', 'credit']);
      assert.equal(page.main().querySelectorAll('#home-panel [data-key^="row-network-"]').length, 8);
      assert.equal(page.main().querySelectorAll('.source-note').length, 1);
      assert.equal(slots.at(-1), 'credit', 'the credit closes Home');
      // The waterlines: cyan with a purple end-cap (no class) by default, a brand colour per service. A class, never a style.
      const accents = Object.fromEntries([...page.main().querySelectorAll('.row-heading')].map((heading) => [heading.id.replace(/^row-|-heading$/g, ''), [...heading.classList].filter((name) => name.startsWith('water-')).join()]));
      assert.deepEqual(accents, {
        trending: '', 'popular-movies': '', 'popular-tv': '', 'new-movies': '', upcoming: '', 'upcoming-tv': '', studios: '',
        'network-213': 'water-netflix', 'network-2739': 'water-disney', 'network-2552': 'water-apple', 'network-1024': 'water-prime',
        'network-3186': 'water-hbo', 'network-453': 'water-hulu', 'network-4330': 'water-paramount', 'network-3353': 'water-peacock',
      });
      assert.doesNotMatch(page.serialize().replace(/<style[^]*?<\/style>/gi, '').replace(/<html style="(?:--(?:switch-height|header-box|tabbar-box):[0-9.]+px;?\s*)+"/, '<html'), /\sstyle=/);
    });

    it('Movies: reveals every lazy row even when a list is slow to arrive (new-movies delayed 250 ms)', async (t) => {
      const app = await startApp(t);
      let slow = false;
      const page = await openApp(t, app, { override: (url) => (slow && url.startsWith('/jellypass/app/v1/discover/new-movies') ? new Promise((resolve) => setTimeout(resolve, 250)) : undefined) });
      await ready(page, 'Home');
      slow = true;
      radios(page)[1].dispatchEvent(new page.Event('click'));
      await page.until(() => page.document.querySelector('#row-trending-movies-heading'), 'Movies');
      await revealAll(page);
      assert.deepEqual(headings(page).slice(0, 4), ['Trending movies', 'Popular movies', 'New movie releases', 'Upcoming movies']);
    });

    it('Movies: films only, replaced in the address, from per-kind lists (a service\'s films), no series-only row', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app);
      await ready(page, 'Home');
      const entries = page.entries.length;
      const before = page.requests.length;
      radios(page)[1].dispatchEvent(new page.Event('click'));
      await page.until(() => page.document.querySelector('#row-trending-movies-heading') && page.document.querySelector('#row-upcoming-heading'), 'Movies');
      assert.equal(page.location.hash, '#/?kind=movies');
      assert.equal(page.entries.length, entries, 'switching replaces the entry, so Back still leaves Home');
      assert.deepEqual(state(page), ['All false -1', 'Movies true 0', 'TV false -1']);
      assert.equal(page.main().querySelector('#home-panel').getAttribute('aria-labelledby'), 'home-filter-movies');
      assert.equal(page.main().querySelector('.hero').getAttribute('aria-label'), 'Trending movies');
      await revealAll(page);
      assert.deepEqual(headings(page), ['Trending movies', 'Popular movies', 'New movie releases', 'Upcoming movies',
        ...Array(8).fill('Films on'), 'Studios']);
      // Only the movie lists, and a service's films alone: nothing was fetched and then thrown away.
      const asked = urls(page).slice(before);
      assert.deepEqual(asked.filter((url) => !url.includes('/network/')).sort(), ['/discover/new-movies', '/discover/popular-movies', '/discover/trending-movies', '/discover/upcoming']);
      assert.deepEqual(asked.filter((url) => url.includes('/network/')).sort(), [213, 2739, 2552, 1024, 3186, 453, 4330, 3353].sort().map((id) => `/discover/network/${id}/films`).sort());
      for (const list of page.main().querySelectorAll('ul.row-list')) {
        for (const link of list.querySelectorAll('a.card-link')) assert.match(link.getAttribute('href'), /^#\/movie\//, list.getAttribute('aria-labelledby'));
      }
      // A service's heading says films and goes to its Films tab.
      const netflix = page.document.querySelector('#row-network-213-heading a');
      assert.equal(netflix.getAttribute('href'), '#/network/213?kind=films');
      assert.equal(netflix.querySelector('span').textContent, 'Films on');
      assert.equal(page.main().querySelectorAll('.source-note').length, 1, 'where-to-watch data is films: the credit stays');
      assert.equal(page.document.querySelector('#row-popular-tv-heading'), null);
      assert.equal(page.document.querySelector('#row-upcoming-tv-heading'), null);
      assert.equal(page.document.querySelector('#row-top-tv-heading'), null);
      assertNoCanaries(page.serialize(), 'the page shows data that is not in a DTO');
    });

    it('TV: series only, a service\'s series, no film row, no studios, no where-to-watch credit', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app);
      await ready(page, 'Home');
      const before = page.requests.length;
      radios(page)[2].dispatchEvent(new page.Event('click'));
      await page.until(() => page.document.querySelector('#row-trending-tv-heading') && page.document.querySelector('#row-upcoming-tv-heading'), 'TV');
      assert.equal(page.location.hash, '#/?kind=tv');
      assert.deepEqual(state(page), ['All false -1', 'Movies false -1', 'TV true 0']);
      assert.equal(page.main().querySelector('.hero').getAttribute('aria-label'), 'Trending series');
      await revealAll(page);
      assert.deepEqual(headings(page), ['Trending series', 'Popular series', 'Upcoming series', ...Array(8).fill('Series on')]);
      const asked = urls(page).slice(before);
      assert.deepEqual(asked.filter((url) => !url.includes('/network/')).sort(), ['/discover/popular-tv', '/discover/trending-tv', '/discover/upcoming-tv']);
      assert.deepEqual(asked.filter((url) => url.includes('/network/')).sort(), [213, 2739, 2552, 1024, 3186, 453, 4330, 3353].sort().map((id) => `/discover/network/${id}`).sort());
      for (const list of page.main().querySelectorAll('ul.row-list')) {
        for (const link of list.querySelectorAll('a.card-link')) assert.match(link.getAttribute('href'), /^#\/tv\//, list.getAttribute('aria-labelledby'));
      }
      assert.equal(page.document.querySelector('#row-network-213-heading a').getAttribute('href'), '#/network/213?kind=series');
      assert.equal(page.main().querySelector('ul.logo-list'), null, 'the studios make movies');
      assert.equal(page.main().querySelector('.source-note'), null, 'no where-to-watch data on series');
      for (const gone of ['row-popular-movies', 'row-new-movies', 'row-upcoming', 'row-top-movies', 'row-top-tv']) assert.equal(page.document.querySelector(`#${gone}-heading`), null, gone);
    });

    it('opens on the filter named in the address, and anything else is All', async (t) => {
      const app = await startApp(t);
      const movies = await openApp(t, app, { hash: '#/?kind=movies' });
      await ready(movies, 'Movies');
      assert.deepEqual(state(movies), ['All false -1', 'Movies true 0', 'TV false -1']);
      assert.equal(movies.main().querySelectorAll('[data-lazy]').length, 8, 'the eight services wait');
      const tv = await openApp(t, app, { hash: '#/?kind=tv' });
      await ready(tv, 'TV', 3);
      assert.deepEqual(state(tv), ['All false -1', 'Movies false -1', 'TV true 0']);
      for (const hash of ['#/?kind=bogus', '#/?kind=', '#/?kind=Movies', '#/?other=tv', '#/?kind=all']) {
        const other = await openApp(t, app, { hash });
        await ready(other, hash);
        assert.deepEqual(state(other), ['All true 0', 'Movies false -1', 'TV false -1'], hash);
      }
    });

    it('costs the same first-load TMDB calls as before under All, and no more under Movies or TV', async (t) => {
      const first = async (hash, rows) => {
        const app = await startApp(t);
        const page = await openApp(t, app, { hash });
        await ready(page, hash, rows);
        await page.until(() => page.main().querySelector('[data-lazy="waiting"]'), 'lazy rows waiting');
        await pause(50);
        return tmdbCount(app);
      };
      assert.equal(await first('', 4), 4);
      assert.equal(await first('#/?kind=movies', 4), 4);
      assert.equal(await first('#/?kind=tv', 3), 3);
    });

    it('moves with the arrow keys, Home and End, choosing as it goes, and leaves other keys alone', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app);
      await ready(page, 'Home');
      radios(page)[0].focus();
      assert.equal(key(page, 'ArrowRight').defaultPrevented, true);
      await page.until(() => page.location.hash === '#/?kind=movies', 'Movies');
      assert.equal(page.focused().textContent, 'Movies', 'focus follows the choice');
      assert.deepEqual(state(page), ['All false -1', 'Movies true 0', 'TV false -1']);
      key(page, 'ArrowDown');
      await page.until(() => page.location.hash === '#/?kind=tv', 'TV');
      key(page, 'ArrowRight');
      await page.until(() => page.location.hash === '#/', 'wraps to All');
      assert.equal(page.focused().textContent, 'All');
      key(page, 'ArrowLeft');
      await page.until(() => page.location.hash === '#/?kind=tv', 'wraps back to TV');
      key(page, 'Home');
      await page.until(() => page.location.hash === '#/', 'Home is All');
      key(page, 'End');
      await page.until(() => page.location.hash === '#/?kind=tv', 'End is TV');
      key(page, 'ArrowUp');
      await page.until(() => page.location.hash === '#/?kind=movies', 'Up is Movies');
      assert.equal(key(page, 'a').defaultPrevented, false);
      assert.equal(key(page, 'Enter').defaultPrevented, false, 'Enter and Space press the focused button, as a button does');
      assert.equal(page.location.hash, '#/?kind=movies');
      assert.equal(page.cursor(), 0, 'no history entry was ever added');
    });

    it('announces the choice, redraws the hero and keeps the sticky control where it is', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app);
      await ready(page, 'Home');
      const control = page.main().querySelector('.home-switch');
      radios(page)[1].dispatchEvent(new page.Event('click'));
      assert.equal(page.document.getElementById('status').textContent, 'Loading…');
      await page.until(() => page.document.getElementById('status').textContent === 'Movies shown.', 'the announcement');
      await page.until(() => page.document.querySelector('#row-upcoming-heading'), 'the last row asked for at once');
      assert.equal(page.main().querySelector('.home-switch'), control, 'the control is the same node: focus is never lost');
      assert.equal(page.document.body.getAttribute('data-chrome'), 'home');
      // Choosing the choice already made does nothing.
      const calls = page.requests.length;
      radios(page)[1].dispatchEvent(new page.Event('click'));
      await pause(50);
      assert.equal(page.requests.length, calls);
      assert.equal(page.main().querySelectorAll('#home-panel [data-lazy="loading"]').length, 0);
    });

    it('comes back to the filter that was chosen: Back from a title restores Movies, and only the member can cancel the restore', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app);
      await ready(page, 'Home');
      radios(page)[1].dispatchEvent(new page.Event('click'));
      await page.until(() => page.document.querySelector('#row-trending-movies-heading'), 'Movies');
      await ready(page, 'Movies rows', 4);
      page.scroll.y = 720;
      const rows = [...page.document.querySelectorAll('ul.row-list[aria-labelledby]')];
      rows[1].scrollLeft = 90;
      page.go(`#/movie/${OWN_MOVIE}`);
      await page.until(() => page.main().querySelector('article.detail'), 'the movie');
      page.back().dispatchEvent(new page.Event('click'));
      await page.until(() => page.document.querySelector('#row-trending-movies-heading') && page.scroll.y === 720, 'Movies and the scroll');
      assert.equal(page.location.hash, '#/?kind=movies');
      assert.deepEqual(state(page), ['All false -1', 'Movies true 0', 'TV false -1']);
      assert.equal(page.document.querySelector('ul[aria-labelledby="row-popular-movies-heading"]').scrollLeft, 90);
      // Switching is the member's own doing: nothing of the other filter's position is put back on the new one.
      page.scroll.y = 400;
      radios(page)[2].dispatchEvent(new page.Event('click'));
      await page.until(() => page.document.querySelector('#row-trending-tv-heading'), 'TV');
      await pause(60);
      assert.ok(page.scroll.y <= 400, 'not moved back to where Movies was');
    });

    it('opens Home at #/ from the Home tab even on a filter, and Back from the first screen leaves the filter alone', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app, { hash: '#/?kind=tv' });
      await ready(page, 'TV', 3);
      assert.equal(page.document.querySelector('nav a[aria-current="page"]').dataset.nav, 'home');
      assert.equal(page.back().hidden, true);
      page.go('#/');
      await page.until(() => page.document.querySelector('#row-trending-heading'), 'All');
      assert.deepEqual(state(page), ['All true 0', 'Movies false -1', 'TV false -1']);
    });

    it('draws the same bytes for the same filter whatever other households hold, ask for or wait on', async (t) => {
      const seen = {};
      for (const [name, worldState] of Object.entries({ baseline: world(), ...otherHouseholdWorlds() })) {
        const app = await startApp(t, worldState);
        const page = await openApp(t, app, { hash: '#/?kind=movies' });
        await ready(page, `${name}: Movies`);
        await revealAll(page);
        seen[name] = page.main().outerHTML;
      }
      assert.ok(Object.keys(seen).length >= 5);
      assert.match(seen.baseline, /Films on/);
      for (const [name, html] of Object.entries(seen)) assert.equal(html, seen.baseline, name);
    });
  });

  it('shows a network\'s page with its logo and the grid, and refuses one the API does not list without asking for titles', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app, { hash: '#/network/213' });
    await page.until(() => page.main().querySelector('ul.grid .card'), 'the network page');
    assert.equal(page.main().querySelector('h1').textContent, 'Popular on Netflix');
    const logo = page.main().querySelector('.source-head img');
    assert.equal(logo.getAttribute('alt'), '', 'the heading already names the network');
    assert.equal(logo.getAttribute('src'), 'https://image.tmdb.org/t/p/w300/wwemzKWzjKYJFfCeiB57q3r4Bcm.png');
    // All: the service's films and series mixed, as on Home.
    assert.deepEqual([...page.main().querySelectorAll('ul.grid .card .badge')].map((badge) => badge.textContent), ['Available to get', 'Available to get', 'Ready to watch']);
    assert.deepEqual(page.requests.map((request) => request.url).filter((url) => url.includes('/network/')), ['/jellypass/app/v1/discover/network/213/all']);
    assert.equal(page.main().querySelector('button.load-more'), null, 'no next page after a short one');
    assert.equal(page.document.querySelector('nav a[aria-current="page"]').dataset.nav, 'home');
    for (const hash of ['#/network/49', '#/studio/213', '#/network/41077']) {
      const missing = await openApp(t, app, { hash });
      await missing.until(() => missing.main().querySelector('h1')?.textContent === 'Not found', hash);
      assert.deepEqual(missing.requests.map((request) => request.url).filter((url) => url !== '/jellypass/app/v1/me'), ['/jellypass/app/v1/discover/sources'], hash);
    }
  });

  it('switches a service\'s page between All, Series and Films: real tabs, keyboard, the address replaced in place', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app, { hash: '#/network/213' });
    await page.until(() => page.main().querySelector('ul.grid .card'), 'the network page');
    const tabs = () => [...page.main().querySelectorAll('[role="tablist"] [role="tab"]')];
    const describe = () => tabs().map((tab) => `${tab.tagName} ${tab.getAttribute('type')} ${tab.textContent} ${tab.getAttribute('aria-selected')} ${tab.getAttribute('tabindex')} ${tab.getAttribute('aria-controls')}`);
    assert.equal(page.main().querySelector('[role="tablist"]').getAttribute('aria-label'), 'Show');
    assert.deepEqual(describe(), ['BUTTON button All true 0 source-panel', 'BUTTON button Series false -1 source-panel', 'BUTTON button Films false -1 source-panel']);
    const panel = () => page.main().querySelector('#source-panel');
    assert.equal(panel().getAttribute('role'), 'tabpanel');
    assert.equal(panel().getAttribute('aria-labelledby'), 'source-tab-all');
    const credit = 'Where to watch: US streaming availability from JustWatch, via TMDB.';
    assert.equal(panel().querySelector('.source-note').textContent, credit);
    const entries = page.entries.length;
    const metas = () => [...panel().querySelectorAll('.card-meta')].map((meta) => meta.textContent.replace(/^\d{4} · /, ''));
    assert.deepEqual(metas(), ['Movie', 'Series', 'Movie']);

    tabs()[2].dispatchEvent(new page.Event('click'));
    await page.until(() => page.main().querySelector('h1').textContent === 'Films on Netflix' && panel().querySelector('ul.grid .card'), 'Films');
    assert.equal(page.location.hash, '#/network/213?kind=films');
    assert.equal(page.entries.length, entries, 'switching replaces the entry, so Back still leaves the page');
    assert.equal(page.document.title, 'Films on Netflix – JellyPass');
    assert.deepEqual(describe().map((text) => text.split(' ').slice(2, 5).join(' ')), ['All false -1', 'Series false -1', 'Films true 0']);
    assert.equal(panel().getAttribute('aria-labelledby'), 'source-tab-films');
    assert.deepEqual(metas(), ['Movie', 'Movie']);
    assert.equal(panel().querySelector('.source-note').textContent, credit);

    const key = (name) => {
      const event = new page.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'key', { value: name });
      page.focused().dispatchEvent(event);
      return event;
    };
    page.focused();
    tabs()[2].focus();
    assert.equal(key('ArrowLeft').defaultPrevented, true);
    await page.until(() => page.main().querySelector('h1').textContent === 'Series on Netflix' && panel().querySelector('ul.grid .card'), 'Series');
    assert.equal(page.focused().textContent, 'Series', 'focus follows the selected tab');
    assert.equal(page.location.hash, '#/network/213?kind=series');
    assert.deepEqual(metas(), ['Series']);
    assert.equal(panel().querySelector('.source-note'), null, 'no where-to-watch data on Series');
    key('End');
    await page.until(() => page.location.hash === '#/network/213?kind=films' && panel().querySelector('ul.grid .card'), 'End is Films');
    key('ArrowRight');
    await page.until(() => page.location.hash === '#/network/213' && panel().querySelector('ul.grid .card'), 'past the end wraps to All');
    assert.equal(page.focused().textContent, 'All');
    assert.equal(key('a').defaultPrevented, false, 'other keys are left alone');
    assert.deepEqual(page.requests.map((request) => request.url).filter((url) => url.includes('/network/')), [
      '/jellypass/app/v1/discover/network/213/all', '/jellypass/app/v1/discover/network/213/films', '/jellypass/app/v1/discover/network/213',
      '/jellypass/app/v1/discover/network/213/films', '/jellypass/app/v1/discover/network/213/all',
    ]);
    assert.equal(page.entries.length, entries);
    assertNoCanaries(page.serialize(), 'the page shows data that is not in a DTO');
    // A network the API lists no films for has no tabs, and its Films address is "Not found".
    const sources = { networks: [{ id: 213, name: 'Netflix', logoUrl: null, hasFilms: false }], studios: [] };
    const override = (url) => (url === '/jellypass/app/v1/discover/sources' ? { status: 200, body: Buffer.from(JSON.stringify(sources)), headers: { 'content-type': 'application/json' } } : undefined);
    const plain = await openApp(t, app, { hash: '#/network/213', override });
    await plain.until(() => plain.main().querySelector('ul.grid .card'), 'series only');
    assert.equal(plain.main().querySelector('h1').textContent, 'Series on Netflix');
    assert.equal(plain.main().querySelector('[role="tablist"]'), null);
    assert.deepEqual(plain.requests.map((request) => request.url).filter((url) => url.includes('/network/')), ['/jellypass/app/v1/discover/network/213']);
    const none = await openApp(t, app, { hash: '#/network/213?kind=films', override });
    await none.until(() => none.main().querySelector('h1')?.textContent === 'Not found', 'no films');
  });

  it('credits JustWatch once on Home, under the services\' rows', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app);
    await page.until(() => page.watched().length === 10, 'Home');
    const notes = [...page.main().querySelectorAll('.source-note')];
    assert.deepEqual(notes.map((note) => note.textContent), ['Where to watch: US streaming availability from JustWatch, via TMDB.']);
    const slots = [...page.main().querySelectorAll('[data-key^="row-network-"]')];
    assert.equal(slots.length, 8);
    assert.ok(slots.at(-1).compareDocumentPosition(notes[0]) & 4, 'after the last service row');
  });

  it('shows only allowlisted TMDB logos: anything else is the name as text, and markup in a name is never parsed', async (t) => {
    const app = await startApp(t);
    const bad = ['https://image.tmdb.org/t/p/original/x.png', 'https://image.tmdb.org/t/p/w342/x.png', 'https://evil.example/t/p/w300/x.png',
      'https://image.tmdb.org/t/p/w300/x.svg', 'https://image.tmdb.org/t/p/w300/../x.png', 'javascript:alert(1)', null];
    const sources = {
      networks: bad.map((logoUrl, index) => ({ id: 213 + index, name: `<b>Net ${index}</b>`, logoUrl })),
      studios: [{ id: 2, name: 'Good', logoUrl: 'https://image.tmdb.org/t/p/w300/abc_DEF-1.png' }],
    };
    const page = await openApp(t, app, {
      override: (url) => (url === '/jellypass/app/v1/discover/sources' ? { status: 200, body: Buffer.from(JSON.stringify(sources)), headers: { 'content-type': 'application/json' } } : undefined),
    });
    await page.until(() => page.main().querySelector('ul.logo-list') && page.watched().length === bad.length + 2, 'Home');
    page.reveal('row-network-213');
    const heading = await page.until(() => page.document.querySelector('#row-network-213-heading'), 'the first network row');
    assert.equal(heading.querySelector('img'), null);
    assert.equal(heading.querySelector('.logo-text').textContent, '<b>Net 0</b>');
    assert.equal(heading.querySelectorAll('b').length, 0);
    assert.deepEqual([...page.main().querySelectorAll('ul.logo-list img')].map((image) => image.getAttribute('src')), ['https://image.tmdb.org/t/p/w300/abc_DEF-1.png']);
    const { safeLogoUrl } = await import(pathToFileURL(path.join(DIST_APP, BUILT('js/render.js'))).href);
    for (const url of bad) assert.equal(safeLogoUrl(url), undefined, String(url));
    assert.equal(safeLogoUrl('https://image.tmdb.org/t/p/w300/wwemzKWzjKYJFfCeiB57q3r4Bcm.png'), 'https://image.tmdb.org/t/p/w300/wwemzKWzjKYJFfCeiB57q3r4Bcm.png');
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
    assert.equal(page.document.querySelector('nav a[aria-current="page"]').dataset.nav, 'account', 'About is the Account tab');
    assert.equal(page.location.hash, '#/account', 'the old address is replaced in place');
  });

  it('has four labelled tabs, a header without the wordmark or (i), and Account (with the TMDB credit) as the fourth', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app);
    await page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4, 'home');
    const tabs = [...page.document.querySelectorAll('nav[aria-label="Main"] a')];
    assert.deepEqual(tabs.map((tab) => tab.textContent), ['Home', 'Search', 'My requests', 'Account']);
    assert.deepEqual(tabs.map((tab) => tab.getAttribute('href')), ['#/', '#/search', '#/requests', '#/account']);
    assert.deepEqual(tabs.map((tab) => tab.querySelectorAll('svg[aria-hidden="true"]').length), [1, 1, 1, 1], 'an icon on each tab, hidden from screen readers');
    assert.equal(page.document.querySelector('nav a[aria-current="page"]').dataset.nav, 'home');
    // Account has its own pass/key icon, not a person in a circle.
    const { icon } = await import(pathToFileURL(path.join(DIST_APP, BUILT('js/icons.js'))).href);
    const pass = icon(page.document, 'account');
    assert.ok(pass.querySelector('circle') && pass.querySelectorAll('line').length >= 3, 'a key: a bow and a shaft with teeth');
    assert.equal(pass.querySelector('path'), null, 'no head-and-shoulders path');
    // The header: no wordmark, no (i). Home has neither Back nor a title, so it is only the status bar's safe area.
    const header = page.document.querySelector('header.app-header');
    assert.equal(header.querySelector('.brand'), null);
    assert.equal(header.querySelector('#about-link'), null);
    assert.equal(/JellyPass/.test(header.textContent), false, 'no wordmark');
    assert.equal(header.hasAttribute('data-bare'), true);
    assert.equal(header.querySelector('#header-title').textContent, '');
    assert.equal(header.querySelector('#signout'), null, 'no Sign out in the header');
    assert.equal(/Sign out/.test(header.textContent), false);
    page.go('#/account');
    await page.until(() => page.main().querySelector('.tmdb-logo'), 'account');
    assert.match(page.main().textContent, /uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB/);
    assert.equal(page.document.querySelector('nav a[aria-current="page"]').dataset.nav, 'account');
    assert.equal(header.querySelector('#header-title').textContent, 'Account', 'a titled screen shows its title in the header');
    assert.equal(header.hasAttribute('data-bare'), false);
    assert.equal(page.back().hidden, false);
    page.go('#/search');
    await page.until(() => page.main().querySelector('input[type="search"]'), 'search');
    assert.equal(header.querySelector('#header-title').textContent, 'Search');
    assert.equal(page.document.querySelector('nav a[aria-current="page"]').dataset.nav, 'search');
    assert.equal(page.main().querySelectorAll('.search-field svg').length, 1, 'the magnifier is inside the field');
    page.go(`#/movie/${OWN_MOVIE}`);
    await page.until(() => page.main().querySelector('article.detail'), 'the movie');
    assert.equal(header.querySelector('#header-title').textContent, 'Synthetic Movie Three');
  });

  it('shows the member card with Sign out first, then About & credits, and signed out offers the way back', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app, { hash: '#/account' });
    await page.until(() => page.main().querySelector('.account-name')?.textContent === 'Alice · Grove', 'the account card');
    assert.deepEqual([...page.main().querySelectorAll('h2')].map((heading) => heading.textContent), ['Account', 'About & credits']);
    assert.equal(page.main().querySelectorAll('button#signout').length, 1);
    assert.equal(page.document.querySelector('header #signout'), null);
    assert.equal(page.document.querySelectorAll('#signout').length, 1);
    assert.equal(page.document.querySelector('.tmdb-logo') !== null, true);
    assert.match(page.main().querySelector('.app-version').textContent, /^JellyPass \d+\.\d+\.\d+/);
    const legacy = await openApp(t, app, { hash: '#/about' });
    await legacy.until(() => legacy.main().querySelector('.account-name')?.textContent === 'Alice · Grove', 'the old About address');
    assert.equal(legacy.location.hash, '#/account', '#/about is the Account tab');
    const signedOut = await openApp(t, app, { hash: '#/account', signedIn: false });
    await signedOut.until(() => signedOut.main().querySelector('.tmdb-logo'), 'account, signed out');
    assert.equal(signedOut.main().querySelector('#signout'), null, 'nothing to sign out of');
    assert.equal(signedOut.main().querySelector('.account'), null);
    assert.equal(signedOut.main().querySelector('.account-out a').getAttribute('href'), '#/');
    assert.equal(signedOut.requests.length, 0, 'Account asks the API for nothing when signed out');
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

  describe('hero and full-bleed pages against the API', () => {
    const homeReady = (page) => page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4, 'home');
    const pause = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));
    const trendingCards = (count) => Array.from({ length: count }, (_, index) => ({
      mediaType: 'movie', tmdbId: 710000 + index, title: `Synthetic Trend ${index + 1}`, year: 2020, overview: 'Synthetic.', posterUrl: null,
      backdropUrl: index === 2 ? null : `https://image.tmdb.org/t/p/w780/synthetic-trend-${index}.jpg`, rating: 8, state: 'get_this', play: null,
    }));
    const trending = (count) => (url) => (url.startsWith('/jellypass/app/v1/discover/trending')
      ? { status: 200, body: Buffer.from(JSON.stringify({ page: 1, nextPage: null, results: trendingCards(count) })), headers: { 'content-type': 'application/json' } }
      : undefined);
    const chrome = (page) => page.document.body.getAttribute('data-chrome');

    it('draws Home\'s hero from the first row\'s own answer: five titles, no extra calls, nothing that moves by itself', async (t) => {
      const app = await startApp(t);
      const intervals = [];
      const realInterval = globalThis.setInterval;
      globalThis.setInterval = (...args) => { intervals.push(1); return realInterval(...args); };
      t.after(() => { globalThis.setInterval = realInterval; });
      const page = await openApp(t, app, { override: trending(8) });
      await homeReady(page);
      const slides = [...page.document.querySelectorAll('.hero-slide')];
      assert.deepEqual(slides.map((slide) => slide.querySelector('.hero-link').textContent), [1, 2, 3, 4, 5].map((n) => `Synthetic Trend ${n}`));
      assert.deepEqual(slides.map((slide) => slide.querySelectorAll('img').length), [1, 1, 0, 1, 1]);
      assert.equal(page.document.querySelectorAll('button.hero-dot').length, 5);
      assert.deepEqual([...page.document.querySelectorAll('.hero-nav')].map((button) => button.getAttribute('aria-label')), ['Previous title', 'Next title']);
      // The row beneath still lists every title, and the hero cost nothing: me, the four lists and the (TMDB-free) sources.
      assert.equal(page.document.querySelector('#row-trending-heading').parentElement.querySelectorAll('.card').length, 8);
      assert.equal(page.requests.length, 6);
      assert.deepEqual(page.requests.map((request) => request.url.replace(/\?.*/, '')).sort(), [
        '/jellypass/app/v1/discover/new-movies', '/jellypass/app/v1/discover/popular-movies', '/jellypass/app/v1/discover/popular-tv',
        '/jellypass/app/v1/discover/sources', '/jellypass/app/v1/discover/trending', '/jellypass/app/v1/me',
      ]);
      assert.equal(chrome(page), 'home');
      const active = () => [...page.document.querySelectorAll('.hero-dot')].map((dot) => dot.getAttribute('aria-current') === 'true' ? 1 : 0).join('');
      assert.equal(active(), '10000');
      await pause(1500);
      assert.equal(active(), '10000', 'still on the first title: no autoplay');
      assert.equal(page.requests.length, 6);
      assert.equal(intervals.length, 0);
      // The hero's title opens the title's page.
      assert.equal(slides[0].querySelector('.hero-link').getAttribute('href'), '#/movie/710000');
      // The hero reads like Home's own rows when the page is serialised: no inline style, no script.
      // (The root's measured --header-box, --tabbar-box and --switch-height are set via the CSSOM, which `style-src 'self'` allows, and so do appear as the root's style attribute.)
      assert.doesNotMatch(page.serialize().replace(/<style[^]*?<\/style>/gi, '').replace(/<html style="(?:--(?:switch-height|header-box|tabbar-box):[0-9.]+px;?\s*)+"/, '<html'), /\sstyle=|<script[^>]*>[^<]/i);
    });

    it('measures the sticky band into --switch-height, follows it as the chips wrap, and lets go off Home', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app, { override: trending(0) });
      await page.until(() => page.main().querySelector('.home-switch'), 'the band');
      const root = page.document.documentElement;
      const switchHeight = () => root.style.getPropertyValue('--switch-height');
      assert.equal(switchHeight(), '62px', 'the band as measured, not a one-row guess');
      assert.equal(root.style.getPropertyValue('--header-box'), '76px', 'the header as measured (its safe-area padding included)');
      assert.equal(root.style.getPropertyValue('--tabbar-box'), '90px', 'the tab bar as measured');
      assert.equal(page.resizers.filter((observer) => observer.targets.size).length, 3, 'header, tab bar and band watched');
      // Large text or zoom: the chips wrap to a second row and the band grows; the clearance follows with no new render.
      page.resizeBand(118);
      assert.equal(switchHeight(), '118px');
      page.resizeBand(62);
      assert.equal(switchHeight(), '62px');
      // Another screen has no band: the property is dropped (the stylesheet's fallback is not used either, the rule is keyed to the band) and nothing is watched.
      page.go('#/search');
      await page.until(() => !page.document.body.hasAttribute('data-home-switch'), 'a screen without the band');
      assert.equal(switchHeight(), '');
      assert.equal(page.resizers.filter((observer) => observer.targets.size).length, 2, 'only the header and tab bar watched off Home');
      assert.equal(root.style.getPropertyValue('--header-box'), '76px');
      // No style attributes are written via markup or setAttribute; the root's custom properties are set via the CSSOM, allowed by style-src (the root's style attribute then reflects them).
      const css = read(BUILT('app.css'));
      matches(css, /:root:has\(body\[data-home-switch\]\) \{ scroll-padding-top: calc\([^;]*var\(--switch-height\)/);
      assert.match(APP_CONTENT_SECURITY_POLICY, /style-src 'self'(?!.*unsafe-inline)/);
      const source = read(BUILT('js/main.js'));
      assert.match(source, /measure\(["']--switch-height["']/);
      assert.match(source, /measure\(["']--header-box["']/);
      assert.match(source, /measure\(["']--tabbar-box["']/);
      assert.match(source, /style\.setProperty\(property, /);
      assert.doesNotMatch(source, /setAttribute\(['"]style['"]|\.cssText/);
    });

    it('brings the chosen Home chip, focus ring included, fully into the chip row after the selection settles', () => {
      const source = read(BUILT('js/main.js'));
      const css = read(BUILT('app.css'));
      const reveal = source.match(/function revealChip\(chip\) \{[^]*?\n\}\n/);
      assert.ok(reveal, 'revealChip');
      // Measured after two frames (the browser's focus scroll and the tick's width change have settled), the ring (4px) counted in, reduced motion jumps.
      assert.match(reveal[0], /requestAnimationFrame\(\(\) => window\.requestAnimationFrame\(settle\)\)/);
      assert.match(source, /CHIP_RING = 4/);
      assert.match(reveal[0], /prefers-reduced-motion: reduce[^]*behavior: reduced \? ['"]auto['"] : ['"]smooth['"]/);
      // On the initial render (?kind=tv), on a click or key choice, and when the choice is unchanged.
      assert.match(source, /show\(heading, switcher, heroSlot, panel\);\s*revealChip\(switcher\.querySelector\(['"]\[aria-checked="true"\]['"]\)\)/);
      assert.match(source, /if \(next === chosen\)\s*return revealChip\(button\)/);
      assert.match(source, /radio\.setAttribute\(['"]tabindex['"][^]*?\}\s*revealChip\(button\)/);
      matches(css, /\.segmented-home \{[^}]*scroll-padding-inline: 4px/);
    });

    it('has no hero, and the header is its own bar, when the first row is empty or fails', async (t) => {
      const app = await startApp(t);
      const empty = await openApp(t, app, { override: trending(0) });
      await empty.until(() => empty.main().getAttribute('aria-busy') === 'false' && [...empty.document.querySelectorAll('.skeleton')].every((node) => node.closest('[data-lazy]')) && empty.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 3, 'Home without a first row');
      assert.equal(empty.document.querySelectorAll('.hero, .hero-slide').length, 0);
      assert.equal(chrome(empty), null);
      const failing = await openApp(t, app, { override: (url) => (url.startsWith('/jellypass/app/v1/discover/trending') ? { status: 502, body: Buffer.from('{"error":"unavailable"}'), headers: {} } : undefined) });
      await failing.until(() => failing.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 3 && failing.main().querySelector('.notice'), 'three rows and one failure');
      assert.equal(failing.document.querySelectorAll('.hero, .hero-slide').length, 0);
      assert.equal(chrome(failing), null);
      // The sticky switch is still on the page, so the scroll padding that clears it stays on (it is keyed to the switch, not the hero).
      for (const page of [empty, failing]) assert.equal(page.document.body.getAttribute('data-home-switch'), '');
      const css = read(BUILT('app.css'));
      matches(css, /:root:has\(body\[data-home-switch\]\) \{ scroll-padding-top: calc\([^;]*var\(--switch-height\)/);
      assert.ok(!/data-chrome='home'\]\) \{ scroll-padding/.test(css));
    });

    it('runs Home\'s filter band full width and gives every other screen, detail pages included, the page\'s own gutters', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app);
      await homeReady(page);
      assert.equal(chrome(page), 'home');
      for (const [hash, expected] of [[`#/movie/${OWN_MOVIE}`, null], [`#/tv/${T_TV}`, null], [`#/tv/${T_TV}/season/1`, null], ['#/search', null], ['#/requests', null], ['#/account', null], ['#/', 'home']]) {
        page.go(hash);
        await page.until(() => chrome(page) === expected && page.main().getAttribute('aria-busy') === 'false', `${hash}: ${expected}`);
        assert.equal(chrome(page), expected, hash);
      }
      // Scrolling past the top marks the page scrolled (the header is solid either way now); the app's own scroll to the top clears it.
      page.scroll.y = 400;
      for (const listener of page.listeners.scroll ?? []) listener({ type: 'scroll' });
      assert.equal(page.document.body.hasAttribute('data-scrolled'), true);
      page.scroll.y = 0;
      for (const listener of page.listeners.scroll ?? []) listener({ type: 'scroll' });
      assert.equal(page.document.body.hasAttribute('data-scrolled'), false);
      // An error on a detail page is an ordinary screen.
      const missing = await openApp(t, app, { hash: '#/movie/999999' });
      await missing.until(() => missing.main().querySelector('[role="alert"]'), 'the error');
      assert.equal(chrome(missing), null);
    });

    it('draws a movie, a series and a season with an inset backdrop card, the title below it, the one action and the seasons as cards', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app, { hash: `#/movie/${T_MOVIE}` });
      await page.until(() => page.main().querySelector('article.detail'), 'the movie');
      assert.equal(page.main().querySelector('.detail-hero img').getAttribute('src'), `https://image.tmdb.org/t/p/w780/synthetic-backdrop-${T_MOVIE}.jpg`);
      assert.equal(page.main().querySelector('.detail-hero img').getAttribute('srcset'), `https://image.tmdb.org/t/p/w780/synthetic-backdrop-${T_MOVIE}.jpg 780w, https://image.tmdb.org/t/p/w1280/synthetic-backdrop-${T_MOVIE}.jpg 1280w`);
      assert.equal(page.main().querySelectorAll('.button-primary').length, 1);
      assert.equal(page.main().querySelector('.button-primary').textContent, 'Get this');
      assert.equal(page.main().querySelector('h1').textContent, 'Synthetic Movie One');
      const own = await openApp(t, app, { hash: `#/movie/${OWN_MOVIE}` });
      await own.until(() => own.main().querySelector('a.button-primary'), 'Play');
      assert.equal(own.main().querySelector('a.button-primary').textContent, 'Play');
      assert.equal(own.main().querySelectorAll('.button-primary').length, 1);
      // The backdrop card holds only the picture: the title block is a sibling after it, on the page's navy.
      const hero = own.main().querySelector('article.detail > .detail-hero');
      assert.ok(hero, 'an inset backdrop card');
      assert.equal(hero.children.length, 1, 'nothing is drawn over the picture');
      assert.equal(hero.querySelector('h1, .badge, a, button'), null);
      assert.equal(own.main().querySelector('article.detail > .detail-main h1').textContent, 'Synthetic Movie Three');
      assert.equal(own.main().querySelector('article.detail-full'), null);
      assert.equal(own.main().querySelector('.detail-main .chips') !== null, true, 'chips below the backdrop');
      assert.equal(own.main().querySelector('.detail-main .detail-action a.button-primary').textContent, 'Play');
      const series = await openApp(t, app, { hash: `#/tv/${T_TV}` });
      await series.until(() => series.main().querySelector('fieldset.get-seasons'), 'the series');
      assert.ok(series.main().querySelectorAll('fieldset .season').length >= 2);
      assert.equal(series.main().querySelectorAll('.button-primary').length, 1);
      // A season page draws its series' backdrop.
      const season = await openApp(t, app, { hash: `#/tv/${T_TV}/season/1` });
      await season.until(() => season.main().querySelector('.episode-list'), 'the season');
      assert.equal(season.main().querySelector('.detail-hero img').getAttribute('src'), `https://image.tmdb.org/t/p/w780/synthetic-backdrop-${T_TV}.jpg`);
      assert.equal(season.main().querySelector('h1').textContent, 'Season 1');
    });

    it('selects all seasons without asking for anything, then asks exactly as before and says the same fixed thing', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app, { hash: `#/tv/${T_TV}` });
      await page.until(() => page.main().querySelector('fieldset.get-seasons'), 'the series');
      const boxes = () => [...page.main().querySelectorAll('input[type="checkbox"]')];
      const values = boxes().map((box) => box.value);
      assert.ok(values.length >= 2, values.join());
      const before = page.requests.length;
      const all = page.main().querySelector('button.select-all');
      all.dispatchEvent(new page.Event('click'));
      assert.deepEqual(boxes().map((box) => box.checked), values.map(() => true));
      all.dispatchEvent(new page.Event('click'));
      assert.deepEqual(boxes().map((box) => box.checked), values.map(() => false));
      all.dispatchEvent(new page.Event('click'));
      assert.equal(page.requests.length, before, 'select all made no call');
      assert.equal(page.requests.filter((request) => request.init.method === 'POST').length, 0);
      page.main().querySelector('.detail-action button').dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelector('.get-message')?.textContent, 'the confirmation');
      const posts = page.requests.filter((request) => request.init.method === 'POST');
      assert.equal(posts.length, 1);
      assert.equal(posts[0].init.body, JSON.stringify({ seasons: values.map(Number) }));
      assert.equal(page.main().querySelector('.get-message').textContent, "Thanks — we'll get this for your household.");
      await app.background.settled();
    });
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
        ['#/account', '.tmdb-logo'],
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
      assert.match(read(BUILT('app.css')), /\.back-button, \.icon-button, \.hero-nav \{[^}]*min-width: 2\.75rem; min-height: 2\.75rem/, '44px tap target');
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

      for (const hash of [`#/movie/${OWN_MOVIE}`, '#/requests', '#/account', '#/search']) {
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
      assert.deepEqual(rows.map((row) => row.classList.contains('row-list-backdrop')), [false, true, true, true], 'the backdrop rows are among those restored');
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

    it('fetches a lazy row again at once on coming back, and puts its scroll and the page\'s back', async (t) => {
      const app = await startApp(t);
      const page = await openApp(t, app);
      await homeReady(page);
      await page.until(() => page.watched().length === 10, 'the lazy rows watched');
      page.reveal('row-network-213');
      const netflix = await page.until(() => page.document.querySelector('ul.row-list[aria-labelledby="row-network-213-heading"]'), 'the Netflix row');
      netflix.scrollLeft = 210;
      page.scroll.y = 1900;
      page.go(`#/tv/${T_TV}`);
      await page.until(() => page.main().querySelector('.season-list'), 'the series');
      const before = page.requests.length;
      page.back().dispatchEvent(new page.Event('click'));
      await page.until(() => page.scroll.y === 1900, 'the page scroll');
      const fetched = page.requests.slice(before).map((request) => request.url).sort();
      // The Netflix row was showing, so it is fetched with Home at once; the rows never reached are still waiting.
      assert.deepEqual(fetched, [
        '/jellypass/app/v1/discover/network/213/all', '/jellypass/app/v1/discover/new-movies', '/jellypass/app/v1/discover/popular-movies',
        '/jellypass/app/v1/discover/popular-tv', '/jellypass/app/v1/discover/sources', '/jellypass/app/v1/discover/trending',
      ]);
      assert.equal(page.document.querySelector('ul.row-list[aria-labelledby="row-network-213-heading"]').scrollLeft, 210, 'the row is where it was');
      assert.equal(page.main().querySelector('[data-key="row-network-213"]').getAttribute('data-lazy'), 'loaded');
      await page.until(() => page.watched().length === 9, 'the other lazy rows watched again');
      assert.equal(page.watched().includes('row-network-213'), false);
    });

    it('opens a studio\'s page from the strip, loads more, and puts the pages and scroll back after a title', async (t) => {
      const app = await startApp(t, world({ extraResults: 45 }));
      const page = await openApp(t, app);
      await homeReady(page);
      const pixar = await page.until(() => page.main().querySelector('ul.logo-list a[href="#/studio/3"]'), 'the studios strip');
      assert.equal(pixar.getAttribute('aria-label'), 'Pixar movies');
      page.go('#/studio/3');
      await page.until(() => page.main().querySelector('button.load-more'), 'the studio page');
      assert.equal(page.main().querySelector('h1').textContent, 'Pixar movies');
      assert.equal(page.document.title, 'Pixar movies – JellyPass');
      assert.equal(page.back().hidden, false);
      assert.equal(page.main().querySelectorAll('ul.grid .card').length, 47);
      page.main().querySelector('button.load-more').dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelectorAll('ul.grid .card').length === 94 && page.main().querySelector('button.load-more:not([disabled])'), 'page 2');
      page.scroll.y = 1234;
      page.go(`#/movie/${OWN_MOVIE}`);
      await page.until(() => page.main().querySelector('article.detail'), 'the movie');
      const before = page.requests.length;
      page.back().dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelectorAll('ul.grid .card').length === 94 && page.scroll.y === 1234, 'both pages and the scroll');
      assert.deepEqual(page.requests.slice(before).map((request) => request.url), [
        '/jellypass/app/v1/discover/sources', '/jellypass/app/v1/discover/studio/3', '/jellypass/app/v1/discover/studio/3?page=2',
      ]);
      // Opened on the page itself, Back is Home.
      const deep = await openApp(t, app, { hash: '#/network/2552' });
      await deep.until(() => deep.main().querySelector('h1')?.textContent === 'Popular on Apple TV', 'the network page');
      deep.back().dispatchEvent(new deep.Event('click'));
      await homeReady(deep);
      assert.equal(deep.location.hash, '#/');
    });

    it('puts a service\'s Films tab, its pages and the scroll back after a title, and opens its address on that tab', async (t) => {
      const app = await startApp(t, world({ extraResults: 45 }));
      const page = await openApp(t, app);
      await homeReady(page);
      page.go('#/network/213');
      await page.until(() => page.main().querySelector('[role="tab"][data-list="films"]') && page.main().querySelector('ul.grid .card'), 'the Netflix page');
      page.main().querySelector('[role="tab"][data-list="films"]').dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelector('h1').textContent === 'Films on Netflix' && page.main().querySelector('button.load-more:not([disabled])'), 'Films');
      assert.equal(page.main().querySelectorAll('ul.grid .card').length, 47);
      page.main().querySelector('button.load-more').dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelectorAll('ul.grid .card').length === 94 && page.main().querySelector('button.load-more:not([disabled])'), 'page 2');
      page.scroll.y = 1234;
      page.go(`#/movie/${OWN_MOVIE}`);
      await page.until(() => page.main().querySelector('article.detail'), 'the movie');
      const before = page.requests.length;
      page.back().dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelectorAll('ul.grid .card').length === 94 && page.scroll.y === 1234, 'both pages and the scroll');
      assert.equal(page.location.hash, '#/network/213?kind=films');
      assert.equal(page.main().querySelector('h1').textContent, 'Films on Netflix');
      assert.equal(page.main().querySelector('[role="tab"][aria-selected="true"]').textContent, 'Films');
      assert.deepEqual(page.requests.slice(before).map((request) => request.url), [
        '/jellypass/app/v1/discover/sources', '/jellypass/app/v1/discover/network/213/films', '/jellypass/app/v1/discover/network/213/films?page=2',
      ]);
      // Back again leaves the page for Home (switching tabs added no entry).
      page.back().dispatchEvent(new page.Event('click'));
      await homeReady(page);
      assert.equal(page.cursor(), 0, 'back where the app was opened');
      // All keeps its own pages: one page of All is a page of films and one of series.
      page.go('#/network/213');
      await page.until(() => page.main().querySelector('button.load-more:not([disabled])'), 'All');
      assert.equal(page.main().querySelectorAll('ul.grid .card').length, 48);
      // Opened on its address, the page is on that tab.
      const deep = await openApp(t, app, { hash: '#/network/213?kind=series' });
      await deep.until(() => deep.main().querySelector('h1')?.textContent === 'Series on Netflix', 'the Series tab');
      assert.equal(deep.main().querySelector('[role="tab"][aria-selected="true"]').textContent, 'Series');
      assert.deepEqual(deep.requests.map((request) => request.url).filter((url) => url.includes('/network/')), ['/jellypass/app/v1/discover/network/213']);
      const odd = await openApp(t, app, { hash: '#/network/213?kind=bogus' });
      await odd.until(() => odd.main().querySelector('h1')?.textContent === 'Popular on Netflix', 'an unknown kind is All');
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

    for (const interaction of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
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

    it('still restores Home when only scroll events arrive while a row is delayed', async (t) => {
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

    it('puts the hero\'s swipe position back with Home, unless the member took over first', async (t) => {
      const heroTrending = (count) => (url) => (url.startsWith('/jellypass/app/v1/discover/trending')
        ? { status: 200, body: Buffer.from(JSON.stringify({ page: 1, nextPage: null, results: Array.from({ length: count }, (_, index) => ({
          mediaType: 'movie', tmdbId: 720000 + index, title: `Synthetic Swipe ${index + 1}`, year: 2020, overview: 'x', posterUrl: null, backdropUrl: null, rating: 7, state: 'get_this', play: null,
        })) })), headers: { 'content-type': 'application/json' } }
        : undefined);
      const app = await startApp(t);
      const page = await openApp(t, app, { override: heroTrending(6) });
      await homeReady(page);
      const rows = [...page.document.querySelectorAll('ul.row-list[aria-labelledby]')];
      rows.forEach((row, index) => { row.scrollLeft = [120, 8, 340, 55][index]; });
      page.document.querySelector('.hero-track').scrollLeft = 780;
      page.scroll.y = 520;
      page.go(`#/movie/${OWN_MOVIE}`);
      await page.until(() => page.main().querySelector('article.detail'), 'the movie');
      page.history.back();
      await homeReady(page);
      await page.until(() => page.scroll.y === 520, 'the page scroll');
      assert.equal(page.document.querySelector('.hero-track').scrollLeft, 780, 'the hero is where it was');
      assert.deepEqual([...page.document.querySelectorAll('ul.row-list[aria-labelledby]')].map((row) => row.scrollLeft), [120, 8, 340, 55], 'and so are the rows');
      assert.equal(page.requests.filter((request) => request.url.startsWith('/jellypass/app/v1/discover/trending')).length, 2, 'the data was fetched again, not kept');
      // A member who touches the page before the hero is back keeps their own place (the rule is the rows' rule, unchanged).
      const gate = { held: undefined };
      const held = await openApp(t, app, { override: (url, init) => (gate.held && url.startsWith('/jellypass/app/v1/discover/trending') ? gate.held.promise.then(() => heroTrending(6)(url, init)) : heroTrending(6)(url, init)) });
      await homeReady(held);
      held.document.querySelector('.hero-track').scrollLeft = 780;
      held.go(`#/movie/${OWN_MOVIE}`);
      await held.until(() => held.main().querySelector('article.detail'), 'the movie');
      gate.held = deferred();
      held.history.back();
      await held.until(() => held.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 3, 'three rows');
      fire(held, 'touchstart');
      gate.held.release();
      await homeReady(held);
      await held.until(() => held.document.querySelector('.hero-track'), 'the hero');
      await pause();
      assert.equal(held.document.querySelector('.hero-track').scrollLeft || 0, 0, 'the member took over: the hero stays at the start');
    });

    it('restores a search whose first attempts the browser clamps, with the detail page left scrolled', async (t) => {
      const app = await startApp(t, world({ extraResults: 45 }));
      const page = await openApp(t, app, { clamp: true });
      await homeReady(page);
      page.go('#/search');
      const input = await page.until(() => page.main().querySelector('input[type="search"]'), 'the search box');
      input.value = 'synthetic';
      input.dispatchEvent(new page.Event('input'));
      await page.until(() => page.main().querySelector('button.load-more'), 'results');
      page.main().querySelector('button.load-more').dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelector('button.load-more:not([disabled])'), 'page 2 shown');
      const shown = page.main().querySelectorAll('.card').length;
      assert.ok(shown > 20, 'two pages are showing');
      page.scroll.y = 900;
      page.go(`#/movie/${OWN_MOVIE}`);
      await page.until(() => page.main().querySelector('article.detail'), 'the movie');
      page.scroll.y = 250;
      page.back().dispatchEvent(new page.Event('click'));
      await page.until(() => page.main().querySelectorAll('.card').length === shown, 'both pages again');
      await page.until(() => page.scroll.y === 900, 'the scroll, not cut short by the clamping');
      assert.equal(page.main().querySelectorAll('.card').length, shown);
    });

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
        page.go(`#/account?n=${index}`);
        await page.until(() => page.main().querySelector('.tmdb-logo') && page.location.hash === `#/account?n=${index}`, `entry ${index}`);
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
        assert.doesNotMatch(text, /Synthetic|grove|tmdb/i);
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
    await page.until(() => page.meRead(), '/me read by the page');
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
    await page.until(() => page.meRead(), '/me read by the page');
    assert.equal(input.value, 'second');
    assert.equal(page.location.hash, '#/search?q=second', 'the address\'s query did not replace what was typed');
  });

  it('moves focus to the content from the skip link without leaving the screen', async (t) => {
    const app = await startApp(t);
    const page = await openApp(t, app, { hash: '#/account' });
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
    assert.equal(page.location.hash, '#/account');
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
  /** The signed-in "name · household", read from Account's member card (the header no longer shows it). */
  const accountName = async (page) => {
    page.go('#/account');
    return page.until(() => {
      const name = page.main().querySelector('.account-name');
      return name && name.textContent !== 'Signed in' ? name.textContent : '';
    }, 'the account card');
  };
  /** Signs out the only way the app offers: the Sign out button in Account's member card. Ends on Home's picker. */
  const signOutFromAccount = async (page) => {
    page.go('#/account');
    const button = await page.until(() => page.main().querySelector('#signout'), 'the Sign out button');
    click(page, button);
    // Signing out itself lands on the sign-in screen, in place of Account's entry.
    await page.until(() => page.main().querySelector('ul.profiles'), 'the picker after signing out');
    assert.equal(page.location.hash, '#/', 'the sign-in screen, not Account');
    assert.equal(page.main().querySelector('.account'), null, 'no Account card left on screen');
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
    assert.equal(await accountName(page), 'Alice · Grove');

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
    assert.equal(await accountName(page), 'Ann · Grove');
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
    assert.equal(await accountName(page), 'Ann · Grove');
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
    await signOutFromAccount(page);
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
    await signOutFromAccount(page);
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
    assert.equal([...failing.main().querySelectorAll('.row')].filter((row) => row.querySelector('.notice') && row.querySelector('.row-heading')).length, 4, 'each row keeps its name');
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
    const jsonAnswer = (value) => ({ status: 200, body: Buffer.from(JSON.stringify(value)), headers: { 'content-type': 'application/json' } });
    /** Any film 910000 and up: "Film <id>", 2024, get_this. */
    const syntheticTitle = (url) => {
      const id = Number(/\/movie\/(91\d{4})$/.exec(url)?.[1]);
      return id ? jsonAnswer({ mediaType: 'movie', tmdbId: id, title: `Film ${id}`, year: 2024, overview: '', posterUrl: null, backdropUrl: null, rating: null, state: 'get_this', play: null, genres: [], runtime: null }) : undefined;
    };

    describe('reuses the titles it has read in this sign-in, never their state', () => {
      const entry = (index, status = 'requested') => ({ id: `id${index}`, mediaType: 'movie', tmdbId: 910_000 + index, status, seasons: [], byYou: true });
      const titleCalls = (page, from = 0) => page.requests.slice(from).map((request) => request.url).filter((url) => /\/(movie|tv)\/\d+$/.test(url));
      const listCalls = (page, from = 0) => page.requests.slice(from).filter((request) => request.url === '/jellypass/app/v1/requests').length;
      const named = (page, count) => page.until(() => page.main().querySelectorAll('.request').length === count
        && [...page.main().querySelectorAll('.request .card-title')].every((title) => title.textContent !== 'Loading title…'), `${count} titles`);
      async function openList(t, list) {
        const app = await startApp(t);
        const page = await openApp(t, app, { hash: '#/requests', override: (url) => (url === '/jellypass/app/v1/requests' ? jsonAnswer({ results: list.value }) : syntheticTitle(url)) });
        return page;
      }
      async function visitAgain(page, count) {
        page.go('#/account');
        await page.until(() => page.main().querySelector('.account'), 'Account');
        await settle();
        const before = page.requests.length;
        page.go('#/requests');
        await named(page, count);
        await settle();
        return before;
      }

      it('reads the list and each title once, then only the list on each visit, with the statuses the list says now', async (t) => {
        const list = { value: [entry(0), entry(1), entry(2)] };
        const page = await openList(t, list);
        await named(page, 3);
        await settle();
        assert.equal(titleCalls(page).length, 3);
        assert.equal(listCalls(page), 1);
        list.value = [entry(0, 'ready'), entry(1, 'failed'), entry(2)];
        const before = await visitAgain(page, 3);
        assert.equal(titleCalls(page, before).length, 0);
        assert.equal(listCalls(page, before), 1);
        assert.deepEqual([...page.main().querySelectorAll('.request .card-title')].map((title) => title.textContent), ['Film 910000', 'Film 910001', 'Film 910002']);
        assert.deepEqual([...page.main().querySelectorAll('.request > .badge')].map((badge) => badge.textContent), ['Ready to watch', "We couldn't get this", 'Requested']);
        assert.equal(page.main().querySelector('.request .card-meta').textContent, '2024 · Movie');
      });

      it('reads only the titles it has not read: a new request, and those Load more shows', async (t) => {
        const list = { value: Array.from({ length: 12 }, (_, index) => entry(index)) };
        const page = await openList(t, list);
        await named(page, 10);
        await settle();
        assert.equal(titleCalls(page).length, 10);
        list.value = [entry(99), ...list.value];
        const before = await visitAgain(page, 10);
        assert.deepEqual(titleCalls(page, before), ['/jellypass/app/v1/movie/910099']);
        const more = page.main().querySelector('button.load-more');
        more.dispatchEvent(new page.Event('click'));
        await named(page, 13);
        await settle();
        // Shown again, it named 99 and 0–8; Load more names 9 (read already), 10 and 11.
        assert.deepEqual(titleCalls(page, before), ['/jellypass/app/v1/movie/910099', '/jellypass/app/v1/movie/910010', '/jellypass/app/v1/movie/910011']);
      });

      it('does not keep a title that could not be read', async (t) => {
        const list = { value: [entry(0)] };
        let failing = true;
        const app = await startApp(t);
        const page = await openApp(t, app, { hash: '#/requests', override: (url) => (url === '/jellypass/app/v1/requests' ? jsonAnswer({ results: list.value }) : failing && url.endsWith('/movie/910000') ? { status: 502, body: Buffer.from('{}'), headers: {} } : syntheticTitle(url)) });
        await page.until(() => page.main().querySelector('.request .card-title')?.textContent === 'Title unavailable', 'unavailable');
        failing = false;
        const before = await visitAgain(page, 1);
        assert.deepEqual(titleCalls(page, before), ['/jellypass/app/v1/movie/910000']);
        assert.equal(page.main().querySelector('.request .card-title').textContent, 'Film 910000');
      });
    });

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

    describe('shows Requested right after an accepted Get this, while the server records it', () => {
      // The server writes the household's record a moment after it accepts the call. These tests hold that record back
      // for their whole life (startHeld), so every read in them still says get_this: the page's own overlay has to carry it.
      // Seerr is held at the request, so the household's record cannot be written until the test is over.
      const startHeld = async (t) => {
        const app = await startApp(t);
        let release;
        app.seerr.state.holdRequests = new Promise((resolve) => { release = resolve; });
        t.after(async () => { release(); await app.background.settled(); });
        return app;
      };
      const homeReady = (page) => page.until(() => page.document.querySelectorAll('ul.row-list[aria-labelledby]').length === 4, 'home');
      const cardFor = (page, name) => [...page.main().querySelectorAll('li.card')].find((card) => card.textContent.includes(name));
      const statusOf = (card) => card.querySelector('.badge').textContent;
      const nameOf = (card) => card.querySelector('a').getAttribute('aria-label');
      const searchFor = async (page, name) => {
        page.go('#/search?q=synthetic');
        return page.until(() => cardFor(page, name), `${name} in the search results`);
      };
      const ask = async (page) => {
        const button = await page.until(() => page.main().querySelector('button'), 'the Get this button');
        assert.equal(page.main().querySelector('.badge').textContent, 'Available to get');
        button.dispatchEvent(new page.Event('click'));
        await page.until(() => page.main().querySelector('.get-message')?.textContent, 'the confirmation');
        // The confirmation is up before the title is read again; wait for the redraw (it focuses the confirmation).
        await page.until(() => page.focused()?.className === 'get-message' && page.pending() === 0, 'the redraw');
      };

      it('on the title page at once, and on Home and Search after Back, with the status said once in the name', async (t) => {
        const app = await startHeld(t);
        const page = await openApp(t, app);
        await homeReady(page);
        const before = await searchFor(page, 'Synthetic Movie One');
        assert.equal(statusOf(before), 'Available to get');
        page.go(`#/movie/${T_MOVIE}`);
        await ask(page);
        // The refetch after the accepted call still said get_this; the page shows Requested all the same.
        assert.equal(page.main().querySelector('.badge').textContent, 'Requested');
        assert.ok(page.main().querySelector('button') === null, 'no Get this button');
        page.back().dispatchEvent(new page.Event('click'));
        const card = await page.until(() => cardFor(page, 'Synthetic Movie One'), 'the search results again');
        assert.equal(statusOf(card), 'Requested');
        const name = nameOf(card);
        assert.ok(name.startsWith('Synthetic Movie One'), name);
        assert.equal(name.split('Requested').length - 1, 1, name);
        assert.equal(name.includes('Available to get'), false, name);
        // A card for another title is untouched.
        assert.equal(statusOf(cardFor(page, 'Synthetic Series Two')), 'Available to get');
        // The page keeps nothing about it.
        assert.deepEqual(page.sessionWrites, []);
        assert.equal([...page.store.keys()].some((key) => key !== 'jellyfin_credentials' && /ask|request/i.test(key)), false);
        page.go('#/');
        await homeReady(page);
        page.go(`#/movie/${T_MOVIE}`);
        await page.until(() => page.main().querySelector('.badge')?.textContent === 'Requested', 'Requested');
        assert.ok(page.main().querySelector('button') === null);
      });

      it('expires after two minutes, then the server\'s answer shows', async (t) => {
        let elapsed = 5_000;
        t.mock.method(performance, 'now', () => elapsed);
        const app = await startHeld(t);
        const page = await openApp(t, app, { hash: `#/movie/${T_MOVIE}` });
        await ask(page);
        assert.equal(page.main().querySelector('.badge').textContent, 'Requested');
        const tick = (ms) => { elapsed += ms; };
        tick(119_000);
        page.go('#/');
        page.go(`#/movie/${T_MOVIE}`);
        await page.until(() => page.main().querySelector('.badge'), 'the title');
        assert.equal(page.main().querySelector('.badge').textContent, 'Requested', 'still inside the window');
        tick(2_000);
        page.go('#/');
        page.go(`#/movie/${T_MOVIE}`);
        await page.until(() => page.main().querySelector('.badge')?.textContent === 'Available to get', 'server truth');
        assert.equal(page.main().querySelector('button').textContent, 'Get this');
      });

      it('marks the seasons asked for, and the series as the server will', async (t) => {
        const app = await startHeld(t);
        const page = await openApp(t, app, { hash: `#/tv/${T_TV}/season/1` });
        await ask(page);
        assert.equal(page.main().querySelector('.badge').textContent, 'Requested');
        assert.ok(page.main().querySelector('button') === null);
        page.go(`#/tv/${T_TV}`);
        await page.until(() => page.main().querySelector('.badge'), 'the series');
        assert.equal(page.main().querySelector('.detail-hero ~ * .badge, .badge').textContent, 'Requested');
        const seasons = [...page.main().querySelectorAll('li.season')];
        const numberOf = (item) => item.querySelector('a').getAttribute('href').split('/').pop();
        assert.ok(seasons.length >= 1);
        for (const item of seasons) {
          assert.equal(item.querySelector('.badge').textContent, numberOf(item) === '1' ? 'Requested' : 'Available to get', numberOf(item));
        }
      });

      it('does not carry Requested to another member who signs in while Account was showing (credentials removed elsewhere)', async (t) => {
        const app = await startHeld(t);
        const page = await openApp(t, app, { hash: `#/movie/${T_MOVIE}` });
        await ask(page);
        assert.equal(page.main().querySelector('.badge').textContent, 'Requested');
        const storage = () => { for (const listener of page.listeners.storage ?? []) listener({ key: 'jellyfin_credentials' }); };
        const origin = page.location.origin;
        page.go('#/account');
        await page.until(
          () => page.main().querySelector('.account-name')?.textContent === 'Alice · Grove'
            && page.pending() === 0,
          'Alice’s Account fully loaded',
        );
        // Jellyfin web (another tab) signs out: the credentials go; this tab stays on Account and only redraws it.
        page.store.set('jellyfin_credentials', JSON.stringify({ Servers: [{ ManualAddress: origin }] }));
        storage();
        await page.until(() => page.main().querySelector('.account') === null, 'Account without a member card');
        // A different member signs in there.
        page.store.set('jellyfin_credentials', JSON.stringify({ Servers: [{ ManualAddress: origin, AccessToken: TOKENS[ANN], UserId: ANN }] }));
        storage();
        await page.until(
          () => page.main().querySelector('.account-name')?.textContent === 'Ann · Grove'
            && page.pending() === 0,
          'Ann’s Account fully loaded',
        );
        const card = await searchFor(page, 'Synthetic Movie One');
        assert.equal(statusOf(card), 'Available to get', 'nothing carried over from the previous member');
        page.go(`#/movie/${T_MOVIE}`);
        await page.until(() => page.main().querySelector('.detail .badge') && page.pending() === 0, 'the title fully loaded');
        assert.equal(page.main().querySelector('.badge').textContent, 'Available to get');
        assert.ok(page.main().querySelector('button') !== null, 'Get this is offered again');
        // The server itself still says get_this for Ann (Alice's record is held back), so only the overlay could have said otherwise.
        const answer = await get(app.port, `/jellypass/app/v1/movie/${T_MOVIE}`, { Host: HOST_A, Authorization: `MediaBrowser Token="${TOKENS[ANN]}"` });
        assert.equal(JSON.parse(answer.body).state, 'get_this', 'the server has not recorded Alice\'s request');
      });

      it('redraws the current screen when one member\'s token is replaced by another\'s, without any navigation', async (t) => {
        const app = await startHeld(t);
        const page = await openApp(t, app, { hash: `#/movie/${T_MOVIE}` });
        await ask(page);
        assert.equal(page.main().querySelector('.badge').textContent, 'Requested');
        page.store.set('jellyfin_credentials', JSON.stringify({ Servers: [{ ManualAddress: page.location.origin, AccessToken: TOKENS[ANN], UserId: ANN }] }));
        for (const listener of page.listeners.storage ?? []) listener({ key: 'jellyfin_credentials' });
        await page.until(() => page.main().querySelector('.badge')?.textContent === 'Available to get', 'the title redrawn for the new member');
        assert.equal(page.location.hash, `#/movie/${T_MOVIE}`, 'no navigation');
      });

      it('redraws Account with the new member\'s name when the token is replaced, without any navigation', async (t) => {
        const app = await startHeld(t);
        const page = await openApp(t, app, { hash: '#/account' });
        await page.until(() => page.main().querySelector('.account-name')?.textContent === 'Alice · Grove', 'Alice\'s card');
        page.store.set('jellyfin_credentials', JSON.stringify({ Servers: [{ ManualAddress: page.location.origin, AccessToken: TOKENS[ANN], UserId: ANN }] }));
        for (const listener of page.listeners.storage ?? []) listener({ key: 'jellyfin_credentials' });
        await page.until(
          () => page.main().querySelector('.account-name')?.textContent === 'Ann · Grove'
            && page.pending() === 0,
          'Ann’s Account fully loaded',
        );
        assert.equal(page.main().querySelector('.account-name').textContent.includes('Alice'), false);
        assert.equal(page.location.hash, '#/account', 'no navigation');
      });

      it('clears when the sign-in changes without any storage event or route change (the next read decides)', async (t) => {
        const app = await startHeld(t);
        const page = await openApp(t, app, { hash: `#/movie/${T_MOVIE}` });
        await ask(page);
        page.store.set('jellyfin_credentials', JSON.stringify({ Servers: [{ ManualAddress: page.location.origin, AccessToken: TOKENS[ANN], UserId: ANN }] }));
        const card = await searchFor(page, 'Synthetic Movie One');
        assert.equal(statusOf(card), 'Available to get');
      });

      it('is not added by a call the API refused', async (t) => {
        const app = await startHeld(t);
        const page = await openApp(t, app, {
          hash: `#/movie/${T_MOVIE}`,
          override: (url, init) => (init.method === 'POST' ? { status: 502, body: Buffer.from('{}'), headers: {} } : undefined),
        });
        const button = await page.until(() => page.main().querySelector('button'), 'the button');
        button.dispatchEvent(new page.Event('click'));
        await page.until(() => page.main().querySelector('.get-error'), 'the error');
        const card = await searchFor(page, 'Synthetic Movie One');
        assert.equal(statusOf(card), 'Available to get');
      });

      it('makes no extra call', async (t) => {
        const app = await startHeld(t);
        const page = await openApp(t, app, { hash: `#/movie/${T_MOVIE}` });
        await page.until(() => page.main().querySelector('button'), 'the button');
        await new Promise((resolve) => setTimeout(resolve, 50));
        const start = page.requests.length;
        await ask(page);
        await new Promise((resolve) => setTimeout(resolve, 50));
        const made = page.requests.slice(start).map((request) => `${request.init.method ?? 'GET'} ${request.url}`).sort();
        assert.deepEqual(made, [`GET /jellypass/app/v1/movie/${T_MOVIE}`, 'GET /jellypass/app/v1/requests', `POST /jellypass/app/v1/movie/${T_MOVIE}/get`].sort());
      });
    });

    it('gives the same confirmation whatever the household, the title or Seerr already had', async (t) => {
      const worlds = { baseline: world(), ...Object.fromEntries(Object.entries(otherHouseholdWorlds())) };
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
      await page.until(() => [...page.main().querySelectorAll('input[type="checkbox"]')].map((box) => box.value).join() === '1', 'only season 1 offered again');
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
      // One season: one pill, the season on the meta line.
      assert.equal(series.querySelectorAll('.request-season').length, 0);
      assert.deepEqual([...series.querySelectorAll('.badge')].map((badge) => badge.textContent), ['Requested']);
      assert.match(series.querySelector('.card-meta').textContent, /^(\d{4} · )?Series · Season 1$/);
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
        id: `id${index}`, mediaType: 'movie', tmdbId: 910_000 + index, status: ['requested', 'ready', 'failed'][index % 3], seasons: [], byYou: index % 2 === 0,
      }));
      const long = await openApp(t, app, { hash: '#/requests', override: (url) => (url === '/jellypass/app/v1/requests' ? jsonAnswer({ results }) : syntheticTitle(url)) });
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

describe('household app: what this member just asked for', { timeout: 30_000 }, () => {
  const asked = () => import(pathToFileURL(path.join(DIST_APP, BUILT('js/asked.js'))).href);
  const apiModule = () => import(pathToFileURL(path.join(DIST_APP, BUILT('js/api.js'))).href);
  const movieCard = (state) => ({ mediaType: 'movie', tmdbId: 5, title: 'T', year: 2020, overview: '', posterUrl: null, backdropUrl: null, rating: null, state, play: null });

  it('adds a key for two minutes, and drops it once the server says anything but get_this', async () => {
    const { createAsked, ASKED_TTL_MS } = await asked();
    let now = 1000;
    const overlay = createAsked(() => now);
    assert.equal(overlay.card(movieCard('get_this')).state, 'get_this', 'nothing asked yet');
    overlay.add('movie', 5, []);
    assert.equal(overlay.card(movieCard('get_this')).state, 'requested');
    assert.equal(ASKED_TTL_MS, 120_000);
    now += 119_999;
    assert.equal(overlay.card(movieCard('get_this')).state, 'requested');
    now += 2;
    assert.equal(overlay.card(movieCard('get_this')).state, 'get_this', 'expired');
    overlay.add('movie', 5, []);
    assert.equal(overlay.card(movieCard('unavailable')).state, 'unavailable');
    assert.equal(overlay.card(movieCard('get_this')).state, 'get_this', 'dropped by another state');
    overlay.add('movie', 5, []);
    assert.equal(overlay.card(movieCard('in_library')).state, 'in_library');
    assert.equal(overlay.card(movieCard('get_this')).state, 'get_this');
  });

  it('a cancelled title is shown as available to get while the server still says requested, until it says anything else, and again after asking', async () => {
    const { createAsked, ASKED_TTL_MS } = await asked();
    let now = 1000;
    const overlay = createAsked(() => now);
    overlay.add('movie', 5, []);
    overlay.withdraw('movie', 5);
    assert.equal(overlay.card(movieCard('requested')).state, 'get_this', 'cancelled, the server not caught up');
    assert.equal(overlay.card(movieCard('get_this')).state, 'get_this', 'the asked key was dropped with it');
    assert.equal(overlay.card(movieCard('in_library')).state, 'in_library', 'a title that arrived is shown as it is');
    overlay.withdraw('movie', 5);
    overlay.add('movie', 5, []);
    assert.equal(overlay.card(movieCard('requested')).state, 'requested', 'asked for again');
    overlay.withdraw('movie', 5);
    now += ASKED_TTL_MS + 1;
    assert.equal(overlay.card(movieCard('requested')).state, 'requested', 'ended: the server alone');
    overlay.withdraw('tv', 7);
    const series = { ...movieCard('requested'), mediaType: 'tv', tmdbId: 7, seasons: [{ seasonNumber: 1, state: 'requested' }, { seasonNumber: 2, state: 'in_library' }] };
    assert.deepEqual(overlay.series(series).seasons.map((season) => season.state), ['get_this', 'in_library'], 'its seasons too');
    overlay.forget();
    assert.equal(overlay.card(movieCard('requested')).state, 'requested');
    assert.equal(overlay.series(series).state, 'requested', 'forgotten with the rest');
  });

  it('a cancelled series ends per key: a season that moved off requested does not end the others or the title', async () => {
    const { createAsked } = await asked();
    const overlay = createAsked(() => 1000);
    const series = (states) => ({ ...movieCard('requested'), mediaType: 'tv', tmdbId: 7, seasons: states.map((state, i) => ({ seasonNumber: i + 1, state })) });
    overlay.withdraw('tv', 7);
    assert.deepEqual(overlay.series(series(['get_this', 'requested'])).seasons.map((season) => season.state), ['get_this', 'get_this']);
    assert.equal(overlay.series(series(['get_this', 'requested'])).state, 'get_this', 'the title too');
    assert.equal(overlay.series(series(['requested', 'requested'])).seasons[1].state, 'get_this', 'season 2 still withdrawn');
    assert.equal(overlay.series(series(['requested', 'requested'])).seasons[0].state, 'requested', 'season 1 ended on its own get_this');
    assert.equal(overlay.series(series(['requested', 'in_library'])).state, 'get_this', 'the title key has its own state');
  });

  it('a withdrawal ends for good on any state but requested: withdraw, in_library, then requested shows Requested', async () => {
    const { createAsked } = await asked();
    for (const other of ['in_library', 'failed', 'unavailable', 'get_this']) {
      const overlay = createAsked(() => 1000);
      overlay.withdraw('movie', 5);
      assert.equal(overlay.card(movieCard('requested')).state, 'get_this');
      assert.equal(overlay.card(movieCard(other)).state, other);
      assert.equal(overlay.card(movieCard('requested')).state, 'requested', `after ${other}`);
    }
  });

  it('a 202 for Cancel withdraws the title in the overlay; any other answer, and a changed sign-in, does not', async (t) => {
    const { createApi } = await apiModule();
    const { createAsked } = await asked();
    const calls = [];
    let status = 202;
    let token = 'token-a';
    const overlay = createAsked();
    const api = createApi({
      token: () => token,
      asked: overlay,
      fetch: async (url, init) => { calls.push({ url, init }); return new Response(status === 202 ? '{"status":"accepted"}' : '{}', { status }); },
    });
    const target = { id: 'AAAAAAAAAAAAAAAAAAAAAA', mediaType: 'movie', tmdbId: 5 };
    status = 500;
    await assert.rejects(api.cancelRequest(target));
    assert.equal(overlay.card(movieCard('requested')).state, 'requested');
    status = 202;
    await api.cancelRequest(target);
    assert.equal(calls.at(-1).url, '/jellypass/app/v1/requests/AAAAAAAAAAAAAAAAAAAAAA/cancel');
    assert.equal(calls.at(-1).init.method, 'POST');
    assert.equal(calls.at(-1).init.body, '{}');
    assert.equal(overlay.card(movieCard('requested')).state, 'get_this');
    const other = createAsked();
    const switching = createApi({ token: () => token, asked: other, fetch: async () => { token = 'token-b'; return new Response('{}', { status: 202 }); } });
    await switching.cancelRequest(target);
    assert.equal(other.card(movieCard('requested')).state, 'requested', 'not for whoever signed in while the call was out');
  });

  it('ends on the monotonic clock, or on the wall clock moving forward (sleep); a clock set back never extends it', async (t) => {
    const { createAsked, ASKED_TTL_MS } = await asked();
    let monotonic = 10_000;
    let wall = 1_700_000_000_000;
    t.mock.method(performance, 'now', () => monotonic);
    t.mock.method(Date, 'now', () => wall);
    const overlay = createAsked();
    overlay.add('movie', 5, []);
    // The wall clock is set back an hour: the window is not stretched.
    wall -= 3_600_000;
    monotonic += ASKED_TTL_MS;
    assert.equal(overlay.card(movieCard('get_this')).state, 'get_this', 'expired on elapsed time, whatever the wall clock says');
    overlay.add('movie', 5, []);
    // Backward jump alone: still inside, and not extended past the monotonic limit either.
    wall -= 3_600_000;
    monotonic += ASKED_TTL_MS - 1;
    assert.equal(overlay.card(movieCard('get_this')).state, 'requested', 'a backward jump does not end it');
    monotonic += 1;
    assert.equal(overlay.card(movieCard('get_this')).state, 'get_this', 'a backward jump does not extend it');
    // Sleep: the wall clock advances while performance.now() stays put.
    overlay.add('movie', 5, []);
    wall += ASKED_TTL_MS - 1;
    assert.equal(overlay.card(movieCard('get_this')).state, 'requested', 'just inside');
    wall += 1;
    assert.equal(overlay.card(movieCard('get_this')).state, 'get_this', 'ended by the wall clock');
  });

  it('keeps season keys apart and marks the series', async () => {
    const { createAsked } = await asked();
    const overlay = createAsked(() => 0);
    overlay.add('tv', 9, [2]);
    const series = { ...movieCard('get_this'), mediaType: 'tv', tmdbId: 9, genres: [], runtime: null, seasons: [1, 2, 3].map((seasonNumber) => ({ seasonNumber, name: '', episodeCount: 1, state: 'get_this' })) };
    const shown = overlay.series(series);
    assert.equal(shown.state, 'requested');
    assert.deepEqual(shown.seasons.map((season) => season.state), ['get_this', 'requested', 'get_this']);
    assert.equal(overlay.season({ tmdbId: 9, seasonNumber: 2, name: '', overview: '', episodes: [], state: 'get_this' }).state, 'requested');
    assert.equal(overlay.season({ tmdbId: 9, seasonNumber: 3, name: '', overview: '', episodes: [], state: 'get_this' }).state, 'get_this');
    assert.equal(overlay.card(movieCard('get_this')).state, 'get_this', 'a movie with the same ID is another key');
  });

  describe('through the API client', () => {
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    async function client(handler) {
      const { createApi } = await apiModule();
      const { createAsked } = await asked();
      const overlay = createAsked();
      const api = createApi({ fetch: async (url, init) => handler(String(url), init ?? {}), token: () => 'token', asked: overlay });
      return api;
    }
    const sample = (state) => ({ ...movieCard(state), genres: [], runtime: null });

    it('adds a key only for an accepted call, and never for a refusal or an error', async () => {
      for (const status of [400, 401, 404, 429, 500]) {
        const api = await client((url, init) => (init.method === 'POST' ? json({}, status) : json(sample('get_this'))));
        await assert.rejects(api.getThis('movie', 5, []));
        assert.equal((await api.movie(5)).state, 'get_this', String(status));
      }
      const offline = await client((url, init) => { if (init.method === 'POST') throw new TypeError('down'); return json(sample('get_this')); });
      await assert.rejects(offline.getThis('movie', 5, []));
      assert.equal((await offline.movie(5)).state, 'get_this');
      const ok = await client((url, init) => (init.method === 'POST' ? json({}, 202) : json(sample('get_this'))));
      await ok.getThis('movie', 5, []);
      assert.equal((await ok.movie(5)).state, 'requested');
    });

    it('overlays every kind of answer and forgets on sign-out', async () => {
      const page = { page: 1, nextPage: null, results: [movieCard('get_this')] };
      const api = await client((url, init) => (init.method === 'POST' ? json({}, 202) : url.includes('/movie/') ? json(sample('get_this')) : json(page)));
      await api.getThis('movie', 5, []);
      assert.equal((await api.search('x', 1)).results[0].state, 'requested');
      assert.equal((await api.discover('trending')).results[0].state, 'requested');
      assert.equal((await api.source('studio', 1, 1)).results[0].state, 'requested');
      api.forgetAsked();
      assert.equal((await api.search('x', 1)).results[0].state, 'get_this');
      assert.equal((await api.movie(5)).state, 'get_this');
    });

    it('drops the key when the server answers with another state, and clears it for another household', async () => {
      let state = 'get_this';
      let household = 'a';
      const api = await client((url, init) => {
        if (init.method === 'POST') return json({}, 202);
        if (url.endsWith('/me')) return json({ name: 'n', household, apiVersion: 1 });
        return json(sample(state));
      });
      await api.me();
      await api.getThis('movie', 5, []);
      state = 'requested';
      assert.equal((await api.movie(5)).state, 'requested');
      state = 'get_this';
      assert.equal((await api.movie(5)).state, 'get_this', 'dropped once the server said requested');
      await api.getThis('movie', 5, []);
      assert.equal((await api.movie(5)).state, 'requested');
      household = 'b';
      await api.me();
      assert.equal((await api.movie(5)).state, 'get_this', 'another household');
    });
    describe("My requests' titles", () => {
      const titlesModule = () => import(pathToFileURL(path.join(DIST_APP, BUILT('js/titles.js'))).href);
      const details = (title) => ({ title, year: 2020, mediaType: 'movie', posterUrl: null });

      it('keeps a title ten minutes on both clocks, ends it if the wall clock goes back, and keeps the 300 used last', async () => {
        const { createTitleCache, TITLE_CACHE_TTL_MS, TITLE_CACHE_SIZE } = await titlesModule();
        assert.equal(TITLE_CACHE_TTL_MS, 600_000);
        assert.equal(TITLE_CACHE_SIZE, 300);
        let mono = 1000;
        let wall = 1_700_000_000_000;
        const cache = createTitleCache(() => mono, () => wall);
        cache.set({ ...details('A'), tmdbId: 5 });
        assert.equal(cache.get('movie', 5)?.title, 'A');
        assert.equal(cache.get('tv', 5), undefined, 'a series with the same ID is another title');
        mono += 599_999;
        assert.equal(cache.get('movie', 5)?.title, 'A');
        mono += 1;
        assert.equal(cache.get('movie', 5), undefined, 'ended on the monotonic clock');
        cache.set({ ...details('A'), tmdbId: 5 });
        wall += 600_000;
        assert.equal(cache.get('movie', 5), undefined, 'ended by the wall clock (a sleep)');
        cache.set({ ...details('A'), tmdbId: 5 });
        wall -= 1;
        assert.equal(cache.get('movie', 5), undefined, 'ended by a wall clock set back');
        for (let id = 1; id <= 300; id += 1) cache.set({ ...details(`T${id}`), tmdbId: id });
        assert.equal(cache.get('movie', 1)?.title, 'T1', 'used again: now the most recent');
        cache.set({ ...details('T301'), tmdbId: 301 });
        assert.equal(cache.get('movie', 2), undefined, 'the least recently used went');
        assert.equal(cache.get('movie', 1)?.title, 'T1');
        assert.equal(cache.get('movie', 301)?.title, 'T301');
        cache.forget();
        assert.equal(cache.get('movie', 1), undefined);
      });

      async function counted({ token = { value: 'token' }, who = () => ({ name: 'n', household: 'a', apiVersion: 1 }), state = () => 'get_this', refuse = () => false, clock } = {}) {
        const { createApi } = await apiModule();
        const { createTitleCache } = await titlesModule();
        const reads = [];
        const api = createApi({
          fetch: async (url, init = {}) => {
            if (refuse()) return json({}, 401);
            if (init.method === 'POST') return json({}, 202);
            if (String(url).endsWith('/me')) return json(who());
            reads.push(String(url).replace('/jellypass/app/v1', ''));
            return json({ ...sample(state()), title: `Read ${reads.length}`, seasons: [] });
          },
          token: () => token.value,
          ...(clock ? { titles: createTitleCache(() => clock.mono, () => clock.wall) } : {}),
        });
        return { api, reads };
      }

      it('reads a title once, and again once ten minutes have passed', async () => {
        const clock = { mono: 0, wall: 1_700_000_000_000 };
        const { api, reads } = await counted({ clock });
        assert.deepEqual(await api.requestTitle('movie', 5), { title: 'Read 1', year: 2020, mediaType: 'movie', posterUrl: null });
        assert.equal((await api.requestTitle('movie', 5)).title, 'Read 1');
        assert.deepEqual(reads, ['/movie/5']);
        await api.requestTitle('tv', 5);
        assert.deepEqual(reads, ['/movie/5', '/tv/5']);
        clock.mono += 600_000;
        clock.wall += 600_000;
        assert.equal((await api.requestTitle('movie', 5)).title, 'Read 3');
        assert.deepEqual(reads, ['/movie/5', '/tv/5', '/movie/5']);
      });

      it('starts empty for another token, after a 401, for another member or household, and on sign-out', async () => {
        const token = { value: 'token' };
        let refused = false;
        let who = { name: 'n', household: 'a', apiVersion: 1 };
        const { api, reads } = await counted({ token, who: () => who, refuse: () => refused });
        await api.me();
        const read = async () => { await api.requestTitle('movie', 5); return reads.length; };
        assert.equal(await read(), 1);
        assert.equal(await read(), 1, 'kept');
        token.value = 'other';
        assert.equal(await read(), 2, 'another token');
        refused = true;
        await assert.rejects(api.requests());
        refused = false;
        assert.equal(await read(), 3, 'after a 401');
        await api.me();
        assert.equal(await read(), 3, 'the same member asked again');
        who = { name: 'm2', household: 'a', apiVersion: 1 };
        await api.me();
        assert.equal(await read(), 4, 'another member');
        who = { name: 'm2', household: 'b', apiVersion: 1 };
        await api.me();
        assert.equal(await read(), 5, 'another household');
        api.forgetAsked();
        assert.equal(await read(), 6, 'sign-out');
      });

      it('does not keep a title read for a sign-in that changed while it was out', async () => {
        const token = { value: 'token' };
        const { api, reads } = await counted({ token });
        const pending = api.requestTitle('movie', 5);
        token.value = 'other';
        await pending;
        await api.requestTitle('movie', 5);
        assert.equal(reads.length, 2);
      });

      it('never hands a kept title\'s state to the overlay', async () => {
        let state = 'in_library';
        const { api, reads } = await counted({ state: () => state });
        await api.requestTitle('movie', 5);
        await api.getThis('movie', 5, []);
        // Reused: the in_library read before must not end what the member just asked for.
        await api.requestTitle('movie', 5);
        assert.equal(reads.length, 1);
        state = 'get_this';
        assert.equal((await api.movie(5)).state, 'requested');
      });
    });

    describe('belongs to one sign-in', () => {
      const apiFor = async (handler, tokenRef, asked = undefined) => {
        const { createApi } = await apiModule();
        return createApi({ fetch: async (url, init) => handler(String(url), init ?? {}), token: () => tokenRef.value, ...(asked ? { asked } : {}) });
      };
      const serve = (state = () => 'get_this', me = () => ({ name: 'n', household: 'a', apiVersion: 1 })) => (url, init) => {
        if (init.method === 'POST') return json({}, 202);
        if (url.endsWith('/me')) return json(me());
        return json(sample(state()));
      };

      it('drops everything when the token changes, or goes, even with no other signal', async () => {
        for (const next of ['other-token', undefined]) {
          const token = { value: 'token' };
          const api = await apiFor(serve(), token);
          await api.getThis('movie', 5, []);
          assert.equal((await api.movie(5)).state, 'requested');
          token.value = next;
          if (next) assert.equal((await api.movie(5)).state, 'get_this', 'another sign-in');
          else await assert.rejects(api.movie(5));
          // Whoever signs in next, the first member included, starts empty.
          token.value = 'token';
          assert.equal((await api.movie(5)).state, 'get_this', `after ${next ?? 'no credentials'}`);
        }
      });

      it('does not apply an answer to a member who signed in while it was in flight', async () => {
        const token = { value: 'token' };
        const api = await apiFor(serve(), token);
        await api.getThis('movie', 5, []);
        const pending = api.movie(5);
        token.value = 'other-token';
        assert.equal((await pending).state, 'get_this');
      });

      it('does not add a key for a call that was accepted after the sign-in changed', async () => {
        const token = { value: 'token' };
        const api = await apiFor((url, init) => {
          if (init.method === 'POST') { token.value = 'other-token'; return json({}, 202); }
          return json(sample('get_this'));
        }, token);
        await api.getThis('movie', 5, []);
        assert.equal((await api.movie(5)).state, 'get_this');
      });

      it('clears on a 401 from any call', async () => {
        for (const call of [(api) => api.movie(5), (api) => api.search('x', 1), (api) => api.requests(), (api) => api.me(), (api) => api.getThis('movie', 6, [])]) {
          let refuse = false;
          const token = { value: 'token' };
          const api = await apiFor((url, init) => (refuse ? json({}, 401) : serve()(url, init)), token);
          await api.getThis('movie', 5, []);
          assert.equal((await api.movie(5)).state, 'requested');
          refuse = true;
          await assert.rejects(call(api));
          refuse = false;
          assert.equal((await api.movie(5)).state, 'get_this', 'the same token, accepted again, still starts empty');
        }
      });

      it('clears when /me names another member of the same household, or another household', async () => {
        for (const [name, household] of [['m2', 'a'], ['n', 'b']]) {
          let who = { name: 'n', household: 'a', apiVersion: 1 };
          const token = { value: 'token' };
          const api = await apiFor(serve(() => 'get_this', () => who), token);
          await api.me();
          await api.getThis('movie', 5, []);
          assert.equal((await api.movie(5)).state, 'requested');
          who = { name, household, apiVersion: 1 };
          await api.me();
          assert.equal((await api.movie(5)).state, 'get_this', `${name} in ${household}`);
        }
      });

      it('keeps the overlay for the same member asked again', async () => {
        const token = { value: 'token' };
        const api = await apiFor(serve(), token);
        await api.me();
        await api.getThis('movie', 5, []);
        await api.me();
        assert.equal((await api.movie(5)).state, 'requested');
      });
    });
  });
});
