// Every HTML page JellyPass serves or relays is marked Cache-Control no-transform, so a CDN in front of it adds no
// script to it (Cloudflare Web Analytics' automatic setup), and compressed by JellyPass, as such a CDN no longer
// compresses it. Nothing but HTML is touched (src/html-response.ts).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { htmlAnswer, negotiatedCoding, strongIfNoneMatch, withNoTransform, withVaryAcceptEncoding } from '../dist/html-response.js';
import { JELLYFIN_WEB_PAGE, startApp, world } from './support/household-app.mjs';

const DIST_APP = path.join(import.meta.dirname, '..', 'dist', 'app');
const PAGE = '/jellypass/app/';
const webWorld = (webPage = {}) => Object.assign(world(), { webPage });
const tvOn = { tvAddon: true, tvHouseholds: ['grove'] };
const request = (acceptEncoding, method = 'GET') => ({ method, headers: acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding } });
const decoded = (answer) => {
  const coding = answer.headers['content-encoding'];
  if (coding === 'gzip') return gunzipSync(answer.body).toString('utf8');
  if (coding === 'br') return brotliDecompressSync(answer.body).toString('utf8');
  assert.equal(coding, undefined);
  return answer.text;
};

describe('HTML no-transform: the header rules', () => {
  it('adds no-transform to Cache-Control, keeping every other directive, never twice', () => {
    const table = [
      [undefined, 'no-transform'],
      ['', 'no-transform'],
      ['no-store', 'no-store, no-transform'],
      ['no-cache', 'no-cache, no-transform'],
      ['public, max-age=0', 'public, max-age=0, no-transform'],
      ['private, max-age=60', 'private, max-age=60, no-transform'],
      ['no-store, no-transform', 'no-store, no-transform'],
      ['No-Transform, max-age=5', 'No-Transform, max-age=5'],
      ['no-cache="Set-Cookie", ', 'no-cache="Set-Cookie", no-transform'],
      [['no-store', 'private'], 'no-store, private, no-transform'],
    ];
    for (const [value, expected] of table) assert.equal(withNoTransform(value), expected, JSON.stringify(value));
  });

  it('adds Accept-Encoding to Vary unless it is there or Vary is *', () => {
    const table = [
      [undefined, 'Accept-Encoding'],
      ['Origin', 'Origin, Accept-Encoding'],
      ['accept-encoding', 'accept-encoding'],
      ['Origin, Accept-Encoding', 'Origin, Accept-Encoding'],
      ['*', '*'],
    ];
    for (const [value, expected] of table) assert.equal(withVaryAcceptEncoding(value), expected, JSON.stringify(value));
  });

  it('picks br, then gzip, from what the client accepts, then unencoded, and nothing it refuses', () => {
    const table = [
      [undefined, 'identity'],
      ['', 'identity'],
      ['identity', 'identity'],
      ['deflate', 'identity'],
      ['gzip', 'gzip'],
      ['x-gzip', 'gzip'],
      ['gzip, deflate, br', 'br'],
      ['br;q=0.5, gzip', 'gzip'],
      ['br;q=0, gzip;q=0', 'identity'],
      ['br;q=0, gzip;q=0, identity;q=0', undefined],
      ['*;q=0', undefined],
      ['identity;q=0', undefined],
      ['deflate, identity;q=0', undefined],
      ['*;q=0, identity', 'identity'],
      ['*;q=0, gzip', 'gzip'],
      ['*;q=0.5', 'br'],
      ['identity;q=0, gzip', 'gzip'],
      ['GZIP;Q=0.8', 'gzip'],
      ['*', 'br'],
      ['*, br;q=0', 'gzip'],
      [['gzip', 'br'], 'br'],
    ];
    for (const [value, expected] of table) assert.equal(negotiatedCoding(value), expected, JSON.stringify(value));
  });

  it('forwards If-None-Match with every weak tag in its strong form', () => {
    const table = [
      [undefined, undefined],
      ['"abc"', '"abc"'],
      ['W/"abc"', '"abc"'],
      ['W/"abc", "def"', '"abc", "def"'],
      ['W/"abc", "abc"', '"abc"'],
      ['"a,W/b"', '"a,W/b"'],
      ['*', '*'],
      [['W/"abc"', 'W/"def"'], '"abc", "def"'],
    ];
    for (const [value, expected] of table) assert.equal(strongIfNoneMatch(value), expected, JSON.stringify(value));
  });

  it('touches only HTML: scripts, styles, JSON, images, video and HLS keep their headers', () => {
    for (const type of ['text/javascript', 'text/css; charset=utf-8', 'application/json', 'image/png', 'video/mp4', 'application/vnd.apple.mpegurl', 'text/plain', 'application/xhtml+xml']) {
      const headers = { 'Content-Type': type, 'Cache-Control': 'public, max-age=60', 'Content-Length': '10' };
      assert.deepEqual(htmlAnswer(request('gzip, br'), 200, headers, true), { headers }, type);
    }
    for (const type of ['text/html', 'text/html; charset=utf-8', 'TEXT/HTML;charset=utf-8']) {
      const answer = htmlAnswer(request(undefined), 200, { 'content-type': type, 'cache-control': 'no-cache', 'content-length': '10' }, true);
      assert.deepEqual(answer, { headers: { 'content-type': type, 'Cache-Control': 'no-cache, no-transform', Vary: 'Accept-Encoding', 'content-length': '10' } }, type);
    }
  });

  it('encodes only a whole, unencoded HTML body with something in it, and weakens its ETag', () => {
    const html = { 'Content-Type': 'text/html', ETag: '"abc"', 'Content-Length': '10', 'Accept-Ranges': 'bytes' };
    const encoded = htmlAnswer(request('gzip'), 200, html, true);
    assert.equal(encoded.coding, 'gzip');
    assert.deepEqual(encoded.headers, { 'Content-Type': 'text/html', 'Cache-Control': 'no-transform', Vary: 'Accept-Encoding', 'Content-Encoding': 'gzip', ETag: 'W/"abc"' });
    assert.equal(htmlAnswer(request('gzip'), 404, html, true).coding, 'gzip', 'an HTML error page too');
    assert.deepEqual(htmlAnswer(request('gzip', 'HEAD'), 200, html, true), encoded, 'a HEAD alike');
    for (const [status, headers, hasBody, what] of [
      [200, html, false, 'no body'],
      [206, { ...html, 'Content-Range': 'bytes 0-9/20' }, true, 'a range'],
      [200, { ...html, 'Content-Range': 'bytes 0-9/20' }, true, 'a Content-Range'],
      [204, html, true, 'no content'],
      [200, { ...html, 'Content-Encoding': 'br' }, true, 'already encoded'],
    ]) {
      const answer = htmlAnswer(request('gzip'), status, headers, hasBody);
      assert.equal(answer.coding, undefined, what);
      assert.equal(answer.headers['Cache-Control'], 'no-transform', what);
    }
    const already = htmlAnswer(request('gzip'), 200, { ...html, 'Content-Encoding': 'br' }, true);
    assert.deepEqual([already.headers['Content-Encoding'], already.headers.ETag, already.headers['Content-Length']], ['br', '"abc"', '10'], 'left as it was');
  });

  it('refuses a successful page the client accepts nothing of, and sends unencoded when it accepts that', () => {
    const html = { 'Content-Type': 'text/html', ETag: '"abc"', 'Content-Length': '10' };
    for (const accept of ['*;q=0', 'br;q=0, gzip;q=0, identity;q=0', 'identity;q=0']) {
      for (const method of ['GET', 'HEAD']) assert.equal(htmlAnswer(request(accept, method), 200, html, true).refused, true, `${method} ${accept}`);
      assert.equal(htmlAnswer(request(accept), 404, html, true).refused, undefined, `${accept}: an error page is sent as it is`);
      assert.equal(htmlAnswer(request(accept), 200, { ...html, 'Content-Encoding': 'gzip' }, true).refused, undefined, `${accept}: already encoded`);
      assert.equal(htmlAnswer(request(accept), 200, { 'Content-Type': 'text/css' }, true).refused, undefined, `${accept}: not HTML`);
    }
    const identity = htmlAnswer(request('br;q=0, gzip;q=0'), 200, html, true);
    assert.deepEqual([identity.coding, identity.refused, identity.headers.ETag, identity.headers['Content-Length']], [undefined, undefined, '"abc"', '10']);
  });

  it('marks a 304 like the page it revalidates, with the weak tag back when the client held the encoded page', () => {
    const ask = (ifNoneMatch) => ({ method: 'GET', headers: { 'accept-encoding': 'gzip', 'if-none-match': ifNoneMatch } });
    const jellyfin = { 'Content-Type': 'text/html', ETag: '"abc"', 'Cache-Control': 'no-cache' };
    assert.deepEqual(htmlAnswer(ask('W/"abc"'), 304, jellyfin, false), { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache, no-transform', Vary: 'Accept-Encoding', ETag: 'W/"abc"' } });
    assert.deepEqual(htmlAnswer(ask('"abc"'), 304, jellyfin, false).headers.ETag, '"abc"', 'the unencoded page keeps its strong tag');
    // With no type, only a weakened tag says the 304 is for an HTML page; Cache-Control is never added to a 304.
    assert.deepEqual(htmlAnswer(ask('W/"abc"'), 304, { ETag: '"abc"' }, false), { headers: { Vary: 'Accept-Encoding', ETag: 'W/"abc"' } });
    assert.deepEqual(htmlAnswer(ask('"abc"'), 304, { ETag: '"abc"' }, false), { headers: { ETag: '"abc"' } });
    assert.deepEqual(htmlAnswer(ask('W/"abc"'), 304, { 'Content-Type': 'text/html' }, false), { headers: { 'Content-Type': 'text/html', Vary: 'Accept-Encoding' } });
    assert.equal(htmlAnswer(ask('W/"abc"'), 304, jellyfin, false).coding, undefined);
  });
});

describe('HTML no-transform: what the gateway serves and relays', { timeout: 30_000 }, () => {
  it('marks and compresses the household app\'s page, and leaves its other files alone', async (t) => {
    const app = await startApp(t);
    const page = readFileSync(path.join(DIST_APP, 'index.html'), 'utf8');
    for (const [accept, coding] of [['gzip', 'gzip'], ['gzip, deflate, br', 'br'], [undefined, undefined], ['identity', undefined]]) {
      for (const served of [PAGE, `${PAGE}index.html`]) {
        const answer = await app.get(served, { user: null, headers: accept ? { 'Accept-Encoding': accept } : {} });
        const what = `${served} ${accept}`;
        assert.equal(answer.status, 200, what);
        assert.equal(answer.headers['cache-control'], 'no-store, no-transform', what);
        assert.equal(answer.headers['cdn-cache-control'], 'no-store', what);
        assert.equal(answer.headers.vary, 'Accept-Encoding', what);
        assert.equal(answer.headers['content-encoding'], coding, what);
        assert.equal(Number(answer.headers['content-length']), answer.body.length, what);
        assert.equal(decoded(answer), page, what);
      }
    }
    const worker = await app.get(`${PAGE}sw.js`, { user: null, headers: { 'Accept-Encoding': 'gzip, br' } });
    assert.deepEqual([worker.headers['cache-control'], worker.headers['content-encoding'], worker.headers.vary], ['no-store', undefined, undefined]);
  });

  it('marks and compresses Jellyfin web\'s page with the TV add-on\'s tag added, and its HEAD alike', async (t) => {
    const app = await startApp(t, webWorld(), tvOn);
    for (const [accept, coding] of [['gzip', 'gzip'], ['br', 'br'], [undefined, undefined]]) {
      const answer = await app.get('/web/index.html', { user: null, headers: accept ? { 'Accept-Encoding': accept } : {} });
      assert.equal(answer.status, 200, accept);
      assert.equal(answer.headers['cache-control'], 'no-store, no-transform', accept);
      assert.equal(answer.headers['content-encoding'], coding, accept);
      assert.equal(answer.headers.vary, 'Accept-Encoding', accept);
      assert.equal(Number(answer.headers['content-length']), answer.body.length, accept);
      assert.match(decoded(answer), /<script defer src="\/jellypass\/tv\/[^"]+" data-jellypass-tv><\/script><\/head>/, accept);
    }
    assert.equal(app.jellyfin.requests.at(-1).headers['accept-encoding'], 'identity', 'Jellyfin is still asked for it unencoded');
  });

  it('relays Jellyfin web\'s page marked: compressed by Jellyfin when it does, by JellyPass when it does not', async (t) => {
    // The add-on off: the page is relayed as it streams in, with the client's Accept-Encoding.
    const app = await startApp(t, webWorld());
    const byJellyfin = await app.get('/web/index.html', { user: null, headers: { 'Accept-Encoding': 'gzip' } });
    assert.deepEqual([byJellyfin.headers['content-encoding'], byJellyfin.headers['cache-control'], byJellyfin.headers.etag], ['gzip', 'no-cache, no-transform', '"jellyfin-web-etag"']);
    assert.equal(gunzipSync(byJellyfin.body).toString('utf8'), JELLYFIN_WEB_PAGE, 'not encoded twice');
    // The fake Jellyfin only gzips: asked for br, it sends the page unencoded, and JellyPass encodes it on the way.
    const byJellyPass = await app.get('/web/index.html', { user: null, headers: { 'Accept-Encoding': 'br' } });
    assert.deepEqual([byJellyPass.headers['content-encoding'], byJellyPass.headers['cache-control'], byJellyPass.headers.etag], ['br', 'no-cache, no-transform', 'W/"jellyfin-web-etag"']);
    assert.equal(byJellyPass.headers['content-length'], undefined);
    assert.equal(byJellyPass.headers['accept-ranges'], undefined);
    assert.equal(brotliDecompressSync(byJellyPass.body).toString('utf8'), JELLYFIN_WEB_PAGE);
    const identity = await app.get('/web/index.html', { user: null, headers: { 'Accept-Encoding': 'identity' } });
    assert.deepEqual([identity.headers['content-encoding'], identity.headers['cache-control'], identity.text], [undefined, 'no-cache, no-transform', JELLYFIN_WEB_PAGE]);
    // A 304 has no body and no type: nothing to mark.
    assert.equal((await app.get('/web/', { user: null, headers: { 'If-None-Match': '"jellyfin-web-etag"' } })).status, 304);
  });

  it('marks any other HTML Jellyfin sends, with no-transform alone when it has no Cache-Control, and nothing else', async (t) => {
    const app = await startApp(t, webWorld());
    const other = await app.get('/web/other.html', { user: null, headers: { 'Accept-Encoding': 'gzip' } });
    assert.deepEqual([other.status, other.headers['cache-control'], other.headers['content-encoding'], other.headers.vary], [200, 'no-transform', 'gzip', 'Accept-Encoding']);
    assert.equal(gunzipSync(other.body).toString('utf8'), '<html><head></head><body>other</body></html>');
    const script = await app.get('/web/main.jellyfin.bundle.js', { user: null, headers: { 'Accept-Encoding': 'gzip, br' } });
    assert.deepEqual([script.status, script.headers['cache-control'], script.headers['content-encoding'], script.headers.vary], [200, undefined, undefined, undefined]);
    assert.equal(Number(script.headers['content-length']), script.body.length);
  });

  it('streams a page too large for the add-on through an encoder, and passes an encoded one through as it is', async (t) => {
    const large = `<html><head></head><body>${'x'.repeat(1024 * 1024)}</body></html>`;
    const big = await startApp(t, webWorld({ body: large }), tvOn);
    const streamed = await big.get('/web/index.html', { user: null, headers: { 'Accept-Encoding': 'gzip' } });
    assert.deepEqual([streamed.status, streamed.headers['content-encoding'], streamed.headers['cache-control']], [200, 'gzip', 'no-cache, no-transform']);
    assert.ok(streamed.body.length < 64 * 1024, `${streamed.body.length} bytes`);
    assert.equal(gunzipSync(streamed.body).toString('utf8'), large);
    const encoded = await startApp(t, webWorld({ gzipAlways: true }), tvOn);
    for (const accept of ['br', undefined]) {
      const answer = await encoded.get('/web/index.html', { user: null, headers: accept ? { 'Accept-Encoding': accept } : {} });
      assert.deepEqual([answer.headers['content-encoding'], answer.headers['cache-control'], answer.headers.etag], ['gzip', 'no-cache, no-transform', '"jellyfin-web-etag"'], accept);
      assert.equal(gunzipSync(answer.body).toString('utf8'), JELLYFIN_WEB_PAGE, accept);
    }
  });
  it('negotiates a HEAD as its GET: the household app\'s page and Jellyfin web\'s page with the add-on, with the exact length', async (t) => {
    for (const [app, pathname] of [[await startApp(t), PAGE], [await startApp(t, webWorld(), tvOn), '/web/index.html']]) {
      for (const accept of ['gzip', 'br', 'gzip, deflate, br', undefined]) {
        const headers = accept ? { 'Accept-Encoding': accept } : {};
        const get = await app.get(pathname, { user: null, headers });
        const head = await app.head(pathname, { user: null, headers });
        const what = `${pathname} ${accept}`;
        assert.equal(head.status, 200, what);
        assert.equal(head.body.length, 0, what);
        for (const name of ['content-encoding', 'content-length', 'etag', 'vary', 'cache-control', 'content-type', 'accept-ranges']) {
          assert.equal(head.headers[name], get.headers[name], `${what}: ${name}`);
        }
        if (accept) assert.match(head.headers['content-encoding'] ?? '', /^(?:br|gzip)$/, what);
      }
    }
  });

  it('negotiates a relayed page\'s HEAD as its GET, with no length or ranges when JellyPass encodes it', async (t) => {
    for (const app of [await startApp(t, webWorld()), await startApp(t, webWorld({ body: `<html><head></head><body>${'x'.repeat(1024 * 1024)}</body></html>` }), tvOn)]) {
      for (const [accept, coding] of [['br', 'br'], ['gzip', 'gzip'], ['identity', undefined]]) {
        const get = await app.get('/web/index.html', { user: null, headers: { 'Accept-Encoding': accept } });
        const head = await app.head('/web/index.html', { user: null, headers: { 'Accept-Encoding': accept } });
        assert.equal(head.status, 200, accept);
        assert.equal(head.body.length, 0, accept);
        assert.equal(head.headers['content-encoding'], coding, accept);
        for (const name of ['content-encoding', 'etag', 'vary', 'cache-control', 'accept-ranges']) assert.equal(head.headers[name], get.headers[name], `${accept}: ${name}`);
        if (accept === 'br') {
          // Encoded by JellyPass (the fake Jellyfin only gzips): the length of its encoded body is not known.
          assert.deepEqual([head.headers['content-length'], head.headers['accept-ranges'], head.headers.etag], [undefined, undefined, 'W/"jellyfin-web-etag"']);
        }
      }
    }
  });

  it('answers a 406 when the client accepts the page in no coding at all, and the page unencoded when it accepts that', async (t) => {
    const notAcceptable = (answer, what, method = 'GET') => {
      assert.equal(answer.status, 406, what);
      assert.equal(answer.headers['cache-control'], 'no-store', what);
      assert.equal(answer.headers['content-type'], 'text/plain; charset=utf-8', what);
      assert.equal(answer.headers['content-encoding'], undefined, what);
      assert.equal(answer.headers.etag, undefined, what);
      assert.equal(answer.text, method === 'HEAD' ? '' : 'Not Acceptable: this page is sent br, gzip or unencoded.\n', what);
    };
    const app = await startApp(t);
    const tv = await startApp(t, webWorld(), tvOn);
    const relay = await startApp(t, webWorld());
    for (const accept of ['*;q=0', 'br;q=0, gzip;q=0, identity;q=0', 'identity;q=0']) {
      for (const method of ['get', 'head']) {
        notAcceptable(await app[method](PAGE, { user: null, headers: { 'Accept-Encoding': accept } }), `app ${method} ${accept}`, method.toUpperCase());
        notAcceptable(await tv[method]('/web/index.html', { user: null, headers: { 'Accept-Encoding': accept } }), `tv ${method} ${accept}`, method.toUpperCase());
      }
    }
    // Relayed: the fake Jellyfin gzips whenever "gzip" is named, q=0 or not, so only a refusal that does not name it reaches JellyPass unencoded.
    for (const accept of ['*;q=0', 'identity;q=0']) {
      for (const method of ['get', 'head']) notAcceptable(await relay[method]('/web/index.html', { user: null, headers: { 'Accept-Encoding': accept } }), `relay ${method} ${accept}`, method.toUpperCase());
    }
    // Only the page: the household app's script is sent as it is.
    assert.equal((await app.get(`${PAGE}sw.js`, { user: null, headers: { 'Accept-Encoding': '*;q=0' } })).status, 200);
    for (const [target, pathname] of [[app, PAGE], [tv, '/web/index.html']]) {
      const identity = await target.get(pathname, { user: null, headers: { 'Accept-Encoding': 'br;q=0, gzip;q=0' } });
      assert.deepEqual([identity.status, identity.headers['content-encoding']], [200, undefined], pathname);
      assert.equal(Number(identity.headers['content-length']), identity.body.length, pathname);
    }
  });

  it('revalidates a page JellyPass encoded: its weak tag is asked of Jellyfin as the strong one, and the 304 carries it back', async (t) => {
    const app = await startApp(t, webWorld());
    const page = await app.get('/web/index.html', { user: null, headers: { 'Accept-Encoding': 'br' } });
    assert.deepEqual([page.status, page.headers['content-encoding'], page.headers.etag], [200, 'br', 'W/"jellyfin-web-etag"']);
    for (const method of ['get', 'head']) {
      const again = await app[method]('/web/index.html', { user: null, headers: { 'Accept-Encoding': 'br', 'If-None-Match': page.headers.etag } });
      assert.equal(again.status, 304, method);
      assert.equal(app.jellyfin.requests.at(-1).headers['if-none-match'], '"jellyfin-web-etag"', `${method}: asked with the strong tag`);
      assert.equal(again.headers.etag, 'W/"jellyfin-web-etag"', method);
      assert.equal(again.headers.vary, 'Accept-Encoding', method);
      assert.equal(again.headers['cache-control'], 'no-cache, no-transform', method);
      assert.equal(again.headers['content-encoding'], undefined, method);
      assert.equal(again.headers['content-length'], undefined, method);
      assert.equal(again.body.length, 0, method);
    }
    // The page Jellyfin encoded keeps its strong tag, and revalidates with it.
    const gzipped = await app.get('/web/index.html', { user: null, headers: { 'Accept-Encoding': 'gzip' } });
    const strong = await app.get('/web/index.html', { user: null, headers: { 'Accept-Encoding': 'gzip', 'If-None-Match': gzipped.headers.etag } });
    assert.deepEqual([strong.status, strong.headers.etag], [304, '"jellyfin-web-etag"']);
    // A changed page is sent whole again.
    const stale = await app.get('/web/index.html', { user: null, headers: { 'Accept-Encoding': 'br', 'If-None-Match': 'W/"older"' } });
    assert.deepEqual([stale.status, stale.headers.etag], [200, 'W/"jellyfin-web-etag"']);
    assert.equal(brotliDecompressSync(stale.body).toString('utf8'), JELLYFIN_WEB_PAGE);
  });
});
