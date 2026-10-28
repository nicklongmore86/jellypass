// The Samsung app (docs/tv-addon.md, "The Samsung app"): the household host's cross-origin rules for it, the add-on's
// manifest, and the loader the app's build adds to its Jellyfin web (tv/samsung), built as it ships, run against fakes
// and against the gateway.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import vm from 'node:vm';
import { parse } from 'acorn';
import { parseHTML } from 'linkedom';
import { buildLoader, injectLoader, parseHosts } from '../tv/samsung/build-loader.mjs';
import { ALICE, HOST_A, HOST_B, T_MOVIE, get, startApp, world } from './support/household-app.mjs';

const DIST_TV = path.join(import.meta.dirname, '..', 'dist', 'tv');
const SCRIPT = readdirSync(DIST_TV).find((name) => name.endsWith('.js'));
const STYLESHEET = readdirSync(DIST_TV).find((name) => name.endsWith('.css'));
const MANIFEST = '/jellypass/tv/manifest.json';
const ADMIN_HOST = 'jellypass.example.test';
const APP_ORIGINS = ['null', 'file://'];
/** Origins that are not the app's: web pages (a household host's own among them) and near misses. */
const OTHER_ORIGINS = ['https://evil.example', `https://${HOST_A}`, 'http://localhost', 'File://', 'FILE://', 'file:///www', 'null, null', 'NULL', 'tizen-app://AprZAARz4r.Jellyfin', 'app://AprZAARz4r'];

const webWorld = (options) => Object.assign(world(options), { webPage: {} });
const tvOn = (households = ['farmhouse']) => ({ tvAddon: { households } });
const preflight = (app, pathname, headers, host = HOST_A) => get(app.port, pathname, { Host: host, ...headers }, { method: 'OPTIONS' });
const corsHeaders = (answer) => Object.keys(answer.headers).filter((name) => name.startsWith('access-control-')).sort();
/** What a request's answer is made of, apart from its date: the same for two requests means the Origin changed nothing. */
const shape = (answer) => {
  const { date: _date, ...headers } = answer.headers;
  return { status: answer.status, text: answer.text, headers };
};

describe('Samsung app: cross-origin rules on a household host', { timeout: 30_000 }, () => {
  it('answers the app\'s preflight for the app API before any token is looked at, allowing only what the add-on sends', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const before = app.jellyfin.requests.length;
    for (const origin of APP_ORIGINS) {
      for (const [method, asked] of [['POST', 'authorization,content-type'], ['GET', 'Authorization'], ['GET', undefined], ['POST', ' Content-Type , AUTHORIZATION ']]) {
        const answer = await preflight(app, '/jellypass/app/v1/movie/550/get', {
          Origin: origin,
          'Access-Control-Request-Method': method,
          ...(asked === undefined ? {} : { 'Access-Control-Request-Headers': asked }),
        });
        assert.equal(answer.status, 204, `${origin} ${method} ${asked}`);
        assert.equal(answer.text, '');
        assert.equal(answer.headers['access-control-allow-origin'], origin);
        assert.equal(answer.headers['access-control-allow-methods'], 'GET, POST');
        assert.equal(answer.headers['access-control-allow-headers'], 'Authorization, Content-Type');
        assert.equal(answer.headers['access-control-max-age'], '600');
        assert.equal(answer.headers['access-control-allow-credentials'], undefined, 'credentials are never allowed');
        assert.equal(answer.headers.vary, 'Origin');
        assert.equal(answer.headers['cache-control'], 'no-store');
        assert.equal(answer.headers['cdn-cache-control'], 'no-store');
      }
    }
    assert.equal(app.jellyfin.requests.length, before, 'a preflight never reaches Jellyfin');
  });

  it('lets the app read every API answer, a refusal included, and never allows credentials', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    for (const origin of APP_ORIGINS) {
      const me = await app.get('/jellypass/app/v1/me', { headers: { Origin: origin } });
      assert.equal(me.status, 200);
      assert.equal(me.headers['access-control-allow-origin'], origin);
      assert.equal(me.headers.vary, 'Origin');
      assert.equal(me.headers['access-control-allow-credentials'], undefined);
      assert.equal(me.headers['cache-control'], 'no-store');
      // The same answer as without the origin, apart from the two headers.
      const plain = await app.get('/jellypass/app/v1/me');
      assert.deepEqual(me.json(), plain.json());
      const refused = await app.get('/jellypass/app/v1/me', { user: null, headers: { Origin: origin } });
      assert.deepEqual([refused.status, refused.text, refused.headers['access-control-allow-origin']], [401, '{"error":"unauthorized"}', origin]);
      const unknown = await app.get('/jellypass/app/v1/nothing', { headers: { Origin: origin } });
      assert.deepEqual([unknown.status, unknown.headers['access-control-allow-origin']], [404, origin]);
      assert.deepEqual(corsHeaders(me), ['access-control-allow-origin']);
    }
    // "Get this", the add-on's one write (a JSON POST, so preflighted above), is taken from the app's origin as from any.
    const asked = await app.post(`/jellypass/app/v1/movie/${T_MOVIE}/get`, undefined, { headers: { Origin: 'null' } });
    await app.background.settled();
    assert.deepEqual([asked.status, asked.json(), asked.headers['access-control-allow-origin']], [202, { status: 'accepted' }, 'null']);
  });

  it('changes nothing for any other origin, or a preflight asking for another method or header', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const askGet = { 'Access-Control-Request-Method': 'GET' };
    const baseline = shape(await preflight(app, '/jellypass/app/v1/me', askGet));
    assert.equal(baseline.status, 401, 'a preflight is a call without a token, as before');
    for (const origin of OTHER_ORIGINS) {
      const answer = await preflight(app, '/jellypass/app/v1/me', { Origin: origin, ...askGet });
      assert.deepEqual(shape(answer), baseline, origin);
      const read = await app.get('/jellypass/app/v1/me', { headers: { Origin: origin } });
      assert.deepEqual(corsHeaders(read), [], origin);
      assert.equal(read.headers.vary, undefined, origin);
    }
    for (const [method, asked] of [['DELETE', undefined], ['PUT', 'authorization'], ['PATCH', undefined], ['post', undefined], ['GET', 'authorization, x-emby-token'], ['GET', 'cookie'], ['POST', 'content-type, x-requested-with']]) {
      const answer = await preflight(app, '/jellypass/app/v1/me', {
        Origin: 'null',
        'Access-Control-Request-Method': method,
        ...(asked === undefined ? {} : { 'Access-Control-Request-Headers': asked }),
      });
      assert.equal(answer.status, 401, `${method} ${asked}`);
      assert.deepEqual(corsHeaders(answer), [], `${method} ${asked}`);
    }
    // An OPTIONS that is not a preflight (no method asked for) is not one either.
    assert.deepEqual(corsHeaders(await preflight(app, '/jellypass/app/v1/me', { Origin: 'null' })), []);
  });

  it('is off unless the add-on is on for the household: off, another household, and the admin host answer as before', async (t) => {
    const off = await startApp(t, webWorld());
    const on = await startApp(t, webWorld(), tvOn());
    const cases = [[off, HOST_A], [on, HOST_B], [on, ADMIN_HOST], [off, ADMIN_HOST]];
    for (const [app, host] of cases) {
      for (const pathname of ['/jellypass/app/v1/me', MANIFEST, `/jellypass/tv/${SCRIPT}`]) {
        const baseline = shape(await preflight(app, pathname, { 'Access-Control-Request-Method': 'GET' }, host));
        const answer = await preflight(app, pathname, { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' }, host);
        assert.deepEqual(corsHeaders(answer), [], `${host} ${pathname}`);
        assert.deepEqual(shape(answer).status, baseline.status, `${host} ${pathname}`);
        const read = await get(app.port, pathname, { Host: host, Origin: 'null', Authorization: `MediaBrowser Token="${ALICE}"` });
        assert.deepEqual(corsHeaders(read), [], `${host} ${pathname}`);
        assert.equal(read.headers.vary, undefined, `${host} ${pathname}`);
      }
    }
    // The admin host never serves the manifest; an unlisted household relays the path to Jellyfin, as before.
    assert.equal((await get(on.port, MANIFEST, { Host: ADMIN_HOST })).status, 401);
    assert.equal((await get(on.port, MANIFEST, { Host: HOST_B })).text, '{}');
  });

  it('gives the add-on\'s files and manifest to the app\'s origin, and the household app\'s own pages to no one', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    for (const origin of APP_ORIGINS) {
      const ask = await preflight(app, MANIFEST, { Origin: origin, 'Access-Control-Request-Method': 'GET' });
      assert.equal(ask.status, 204);
      assert.equal(ask.headers['access-control-allow-origin'], origin);
      assert.equal(ask.headers['access-control-allow-methods'], 'GET, HEAD');
      assert.equal(ask.headers['access-control-allow-headers'], undefined);
      assert.equal(ask.headers['access-control-allow-credentials'], undefined);
      // The files need no request header, and are never written to.
      assert.equal((await preflight(app, MANIFEST, { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' })).status, 404);
      assert.equal((await preflight(app, MANIFEST, { Origin: origin, 'Access-Control-Request-Method': 'POST' })).status, 404);
      const manifest = await app.get(MANIFEST, { user: null, headers: { Origin: origin } });
      assert.equal(manifest.headers['access-control-allow-origin'], origin);
      assert.equal(manifest.headers.vary, 'Origin');
      for (const name of [SCRIPT, STYLESHEET]) {
        const file = await app.get(`/jellypass/tv/${name}`, { user: null, headers: { Origin: origin } });
        assert.equal(file.status, 200);
        assert.equal(file.headers['access-control-allow-origin'], origin);
        // Kept by the CDN for good and the same for everyone, so it doesn't vary.
        assert.equal(file.headers.vary, undefined);
        assert.equal(file.headers['cache-control'], 'public, max-age=31536000, immutable');
      }
      const page = await app.get('/jellypass/app/', { user: null, headers: { Origin: origin } });
      assert.equal(page.status, 200);
      assert.deepEqual(corsHeaders(page), []);
      const missing = await app.get('/jellypass/tv/jellypass-tv.000000000000.js', { user: null, headers: { Origin: origin } });
      assert.deepEqual([missing.status, missing.headers['access-control-allow-origin']], [404, origin]);
    }
  });
});

describe('Samsung app: the add-on\'s manifest', { timeout: 30_000 }, () => {
  it('names the current script, is never stored, and needs no token', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    const manifest = await app.get(MANIFEST, { user: null });
    assert.equal(manifest.status, 200);
    assert.deepEqual(manifest.json(), { script: SCRIPT });
    assert.match(SCRIPT, /^jellypass-tv\.[0-9a-f]{12}\.js$/);
    assert.equal(manifest.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(manifest.headers['x-content-type-options'], 'nosniff');
    for (const name of ['cache-control', 'cdn-cache-control', 'cloudflare-cdn-cache-control']) assert.equal(manifest.headers[name], 'no-store', name);
    assert.equal(manifest.headers.etag, undefined);
    const head = await get(app.port, `${MANIFEST}?v=1`, { Host: HOST_A }, { method: 'HEAD' });
    assert.deepEqual([head.status, head.body.length, head.headers['content-length']], [200, 0, manifest.headers['content-length']]);
    // Only at its exact path, and only read.
    for (const pathname of ['/jellypass/tv/Manifest.json', '/jellypass/tv/manifest', '/jellypass/tv/manifest.json/', '/emby/jellypass/tv/manifest.json']) {
      const other = await app.get(pathname, { user: null });
      assert.deepEqual([other.status, other.text], [404, '{"error":"not_found"}'], pathname);
    }
    assert.equal((await app.post(MANIFEST, {}, { user: null })).status, 404);
    assert.equal(app.jellyfin.requests.filter((request) => request.pathname.includes('/jellypass/tv')).length, 0);
  });
});

const HOSTS = ['jelly-*.example.test', 'exact.example.org'];
const NAME = 'jellypass-tv.0123456789ab.js';
const SAFE_INIT = { method: 'GET', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } };
let built;
const loaderScript = async () => (built ??= await buildLoader({ hosts: HOSTS }));

/**
 * The loader as built, run in its own VM context with a linkedom page, a clock the test moves (`advance`), and `fetch`
 * as `answer(url, init)` says (a Response, a promise of one, or a throw). `server(address)` sets what `ApiClient`
 * names (undefined: no ApiClient).
 */
async function runLoader({ answer = () => jsonResponse({ script: NAME }), page = '<!DOCTYPE html><html><head></head><body></body></html>' } = {}) {
  const { document } = parseHTML(page);
  let now = 0;
  let timers = [];
  const calls = [];
  let address;
  const context = vm.createContext({
    document,
    URL,
    performance: { now: () => now },
    setTimeout: (run, ms) => {
      timers.push({ at: now + ms, run });
      return timers.length;
    },
    fetch: (url, init) => {
      calls.push({ url, init: JSON.parse(JSON.stringify(init)) });
      // As fetch does, a promise; a throw is passed on as it is, for the loader to survive one.
      return Promise.resolve(answer(url, init));
    },
  });
  context.window = context;
  const run = async () => vm.runInContext(await loaderScript(), context);
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const box = {
    document,
    calls,
    context,
    run,
    pending: () => timers.length,
    server: (value) => {
      address = value;
      if (value === undefined) delete context.ApiClient;
      else context.ApiClient = { serverAddress: () => (typeof address === 'function' ? address() : address) };
    },
    /** Moves the clock on by `ms`, running every timer that falls due, in order, and what they start. */
    advance: async (ms) => {
      const until = now + ms;
      for (;;) {
        await settle();
        const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        now = Math.max(now, due.at);
        due.run();
      }
      now = until;
      await settle();
    },
    scripts: () => [...document.querySelectorAll('script')].map((script) => script.getAttribute('src')),
  };
  await run();
  return box;
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('Samsung app: the loader as built', () => {
  it('parses as an ES2017 classic script for Chromium 63, and uses no later browser API, console, storage or HTML parsing', async () => {
    const source = await loaderScript();
    assert.doesNotThrow(() => parse(source, { ecmaVersion: 2017, sourceType: 'script' }));
    for (const api of [/\breplaceChildren\b/, /\bAbortController\b/, /\bqueueMicrotask\b/, /\bstructuredClone\b/, /\bglobalThis\b/, /\.finally\(/, /\.at\(/, /\bfromEntries\b/, /\.flat\(/, /\.replaceAll\(/]) {
      assert.ok(!api.test(source), `the loader uses ${api}`);
    }
    for (const banned of [/\bconsole\./, /\b(?:localStorage|sessionStorage|indexedDB|document\.cookie)\b/, /\binnerHTML\b|\binsertAdjacentHTML\b|\bdocument\.write\b/, /\beval\(|\bnew Function\b/, /accessToken|Authorization/]) {
      assert.ok(!banned.test(source), `the loader uses ${banned}`);
    }
    assert.ok(source.includes(JSON.stringify(HOSTS[0])), 'the hosts are written in');
  });

  it('waits for Jellyfin web\'s server, then loads the add-on from that household host once, with no credentials', async () => {
    const box = await runLoader();
    await box.advance(5000);
    assert.equal(box.calls.length, 0, 'nothing is asked before Jellyfin web names a server');
    box.server(`https://${HOST_A}`);
    await box.advance(1000);
    assert.deepEqual(box.calls, [{ url: `https://${HOST_A}${MANIFEST}`, init: SAFE_INIT }]);
    assert.deepEqual(box.scripts(), [`https://${HOST_A}/jellypass/tv/${NAME}`]);
    const script = box.document.querySelector('script');
    assert.equal(script.parentNode, box.document.head);
    assert.equal(script.hasAttribute('data-jellypass-tv'), true, 'the add-on finds its own script by its marker');
    await box.advance(60 * 60000);
    assert.equal(box.calls.length, 1, 'loaded once, and then it stops looking');
    assert.equal(box.pending(), 0);
    // Started again on the same page, it does nothing.
    await box.run();
    await box.advance(5000);
    assert.deepEqual([box.calls.length, box.scripts().length], [1, 1]);
  });

  it('uses the origin of the address, with a path, a trailing slash or upper case', async () => {
    for (const address of [`https://${HOST_A}/`, `https://${HOST_A.toUpperCase()}/jellyfin`, `https://${HOST_A}:443`, 'https://exact.example.org']) {
      const box = await runLoader();
      box.server(address);
      await box.advance(1000);
      const origin = new URL(address).origin;
      assert.deepEqual(box.calls.map((call) => call.url), [`${origin}${MANIFEST}`], address);
      assert.deepEqual(box.scripts(), [`${origin}/jellypass/tv/${NAME}`], address);
    }
  });

  it('asks nothing of a server the build does not list, or one not on HTTPS at its default port', async () => {
    const box = await runLoader();
    const others = [
      'https://jelly.example.test', `http://${HOST_A}`, `https://${HOST_A}:8443`, `https://user:pw@${HOST_A}`, `https://${HOST_A}.evil.example`,
      `https://evil.example/${HOST_A}`, 'https://jelly-a.b.example.test', 'https://jelly-.example.test', 'https://x.exact.example.org', 'https://exact.example.org.evil',
      'https://10.172.40.88:8096', 'not an address', '', 42, null,
      () => {
        throw new Error('ApiClient broke');
      },
    ];
    for (const address of others) {
      box.server(address);
      await box.advance(2000);
    }
    Object.defineProperty(box.context, 'ApiClient', { configurable: true, get() { throw new Error('no'); } });
    await box.advance(2000);
    assert.deepEqual(box.calls, []);
    assert.deepEqual(box.scripts(), []);
    assert.ok(box.pending() > 0, 'it keeps looking');
    delete box.context.ApiClient;
    box.server(`https://${HOST_A}`);
    await box.advance(1000);
    assert.deepEqual(box.scripts(), [`https://${HOST_A}/jellypass/tv/${NAME}`], 'and loads once a listed server is named');
  });

  it('fails safe on any answer that isn\'t a script name, and asks again later, less and less often', async () => {
    const failures = [
      () => jsonResponse({ error: 'not_found' }, 404),
      () => jsonResponse({ script: NAME }, 500),
      () => jsonResponse({ script: '../evil.js' }),
      () => jsonResponse({ script: 'jellypass-tv.0123456789ab.css' }),
      () => jsonResponse({ script: `https://evil.example/${NAME}` }),
      () => jsonResponse({ script: 'jellypass-tv.0123456789AB.js' }),
      () => jsonResponse([NAME]),
      () => jsonResponse(null),
      () => new Response('<html>', { status: 200 }),
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => {
        throw new TypeError('blocked');
      },
      () => new Promise(() => {}),
    ];
    for (const answer of failures) {
      const box = await runLoader({ answer });
      box.server(`https://${HOST_A}`);
      await box.advance(1000);
      assert.equal(box.calls.length, 1, String(answer));
      await box.advance(10000);
      assert.deepEqual(box.scripts(), [], String(answer));
    }
    // After a failure the same host is asked again after 30 s, then 60 s, 120 s…, up to every 30 minutes.
    let fail = true;
    const box = await runLoader({ answer: () => (fail ? jsonResponse({ error: 'not_found' }, 404) : jsonResponse({ script: NAME })) });
    box.server(`https://${HOST_A}`);
    await box.advance(1000);
    const times = [];
    let last = box.calls.length;
    for (let second = 1; second <= 4000; second += 1) {
      await box.advance(1000);
      if (box.calls.length !== last) {
        times.push(second);
        last = box.calls.length;
      }
    }
    const gaps = times.map((time, index) => time - (index ? times[index - 1] : 0));
    assert.deepEqual(gaps.slice(0, 6), [30, 60, 120, 240, 480, 960]);
    assert.ok(gaps.slice(6).every((gap) => gap === 1800), String(gaps));
    fail = false;
    await box.advance(1800 * 1000);
    assert.deepEqual(box.scripts(), [`https://${HOST_A}/jellypass/tv/${NAME}`]);
  });

  it('asks a newly named server at once, and never loads for a server Jellyfin web left while it was asked', async () => {
    let release;
    const box = await runLoader({
      answer: (url) => (url.startsWith(`https://${HOST_A}`) ? new Promise((resolve) => { release = () => resolve(jsonResponse({ script: NAME })); }) : jsonResponse({ error: 'not_found' }, 404)),
    });
    box.server(`https://${HOST_B}`);
    await box.advance(1000);
    box.server(`https://${HOST_A}`);
    await box.advance(1000);
    assert.deepEqual(box.calls.map((call) => new URL(call.url).host), [HOST_B, HOST_A], 'a new host is not held back by the last one\'s failure');
    box.server(`https://${HOST_B}`);
    release();
    await box.advance(1000);
    assert.deepEqual(box.scripts(), [], 'the answer for a server no longer used is dropped');
  });

  it('does nothing on a page that already has the add-on', async () => {
    const box = await runLoader({ page: `<!DOCTYPE html><html><head><script src="/jellypass/tv/${NAME}" data-jellypass-tv></script></head><body></body></html>` });
    box.server(`https://${HOST_A}`);
    await box.advance(5000);
    assert.deepEqual(box.calls, []);
  });

  it('loads the add-on through the gateway, which the browser lets it read only with the app\'s origin', async (t) => {
    const app = await startApp(t, webWorld(), tvOn());
    // As Chromium does for the app's page: the request carries Origin, and an answer without a matching
    // Access-Control-Allow-Origin is a network error to the page.
    const browserFetch = (origin) => async (url, init) => {
      const target = new URL(url);
      const answer = await get(app.port, target.pathname, { Host: target.host, Origin: origin, ...init.headers });
      if (answer.headers['access-control-allow-origin'] !== origin) throw new TypeError('Failed to fetch');
      return new Response(answer.body, { status: answer.status, headers: { 'Content-Type': answer.headers['content-type'] } });
    };
    for (const origin of APP_ORIGINS) {
      const box = await runLoader({ answer: browserFetch(origin) });
      box.server(`https://${HOST_A}`);
      await box.advance(1000);
      assert.deepEqual(box.scripts(), [`https://${HOST_A}/jellypass/tv/${SCRIPT}`], origin);
    }
    // Where the add-on is off the manifest isn't there (and isn't readable), so nothing is loaded.
    const box = await runLoader({ answer: browserFetch('null') });
    box.server(`https://${HOST_B}`);
    await box.advance(1000);
    assert.deepEqual([box.calls.length, box.scripts().length], [1, 0]);
  });
});

describe('Samsung app: the build tooling', () => {
  it('adds exactly one loader tag to Jellyfin web\'s page, before </head>, and refuses a page it can\'t', () => {
    const page = '<!DOCTYPE html><html><head><title>Jellyfin</title></head><body></body></html>';
    assert.equal(injectLoader(page), '<!DOCTYPE html><html><head><title>Jellyfin</title><script defer src="jellypass-loader.js" data-jellypass-loader></script></head><body></body></html>');
    assert.throws(() => injectLoader(injectLoader(page)), /already has/);
    assert.throws(() => injectLoader('<html><body></body></html>'), /no <\/head>/);
  });

  it('takes only lower-case host names, with at most one * in the first label', () => {
    assert.deepEqual(parseHosts(' jelly-*.starrgroup.io , exact.example.org '), ['jelly-*.starrgroup.io', 'exact.example.org']);
    for (const bad of ['', ' , ', 'Jelly-*.example.org', 'jelly-*', 'localhost', '*.*.example.org', 'jelly.*.example.org', 'jelly-**.example.org', 'https://jelly.example.org', 'jelly.example.org:443', 'jelly.example.org/']) {
      assert.throws(() => parseHosts(bad), /--hosts/, bad);
    }
  });
});
