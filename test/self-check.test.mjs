import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { SelfCheck, PROXY_CHECK_PATH, publicProbeUrls } from '../dist/self-check.js';
import { householdRouteAllowed, parseAdditionalPluginRoutes, HOUSEHOLD_RELAY_ROUTES } from '../dist/gateway-route-policy.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const options = { jellyfinUrl: 'http://jellyfin.internal', householdUrls: () => [] };

describe('household relay policy', () => {
  it('allows concrete core templates and static assets, refuses unknown plugins and descendants', () => {
    for (const path of ['/system/info/public', '/items/abc/playbackinfo', '/videos/abc/stream.mp4', '/web/main.js', '/socket', '/jellyfinenhanced/public-config']) assert.ok(householdRouteAllowed(path), path);
    for (const path of ['/unknownplugin/users', '/system/info/public/plugin', '/jellyfinenhanced/reviews', '/jellyfinenhanced/tmdb/search/person', '/streamyfin', '/jellyfinenhancedx/public-config']) assert.equal(householdRouteAllowed(path), false, path);
    assert.equal(new Set(HOUSEHOLD_RELAY_ROUTES).size, HOUSEHOLD_RELAY_ROUTES.length);
  });
  it('requires explicit exact paths for extra plugin access', () => {
    assert.deepEqual(parseAdditionalPluginRoutes('/example/status,/example/status'), ['/example/status']);
    assert.equal(householdRouteAllowed('/example/status', ['/example/status']), true);
    assert.equal(householdRouteAllowed('/example/status/users', ['/example/status']), false);
    for (const path of ['/streamyfin/config', '/jellyfinenhanced/reviews', '/Example/status', '/example/*', '/example/%61', '/example/../status', '/emby/example/status', '/example/status?key=secret']) assert.throws(() => parseAdditionalPluginRoutes(path));
  });
});

describe('admin self-check probes', () => {
  it('reports origin bypass, Quick Connect, Seerr and invalid TMDB without leaking credentials or following redirects', async () => {
    const requests = [];
    const check = new SelfCheck({ ...options, jellyfinPublicUrls: ['https://origin.example.com'], seerrPublicUrl: 'https://seerr.example.com', tmdbApiKey: 'a'.repeat(32), fetch: async (url, init) => {
      requests.push({ url, init });
      if (url.includes('origin.example.com')) return json({ ProductName: 'Jellyfin', Version: '12.4.0' });
      if (url.includes('QuickConnect')) return json(true);
      if (url.includes('seerr.example.com')) return new Response(null, { status: 302, headers: { Location: 'https://other.example.com' } });
      return json({}, 401);
    } });
    const results = await check.run();
    assert.deepEqual(results.map((r) => [r.check, r.status]), [['origin', 'fail'], ['quick_connect', 'fail'], ['proxy', 'warn'], ['seerr', 'warn'], ['version', 'warn'], ['tmdb', 'fail']]);
    assert.equal(await check.run(), undefined, 'global run limit');
    for (const { url, init } of requests) {
      assert.equal(init.redirect, 'manual');
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.credentials, 'omit');
      if (!url.startsWith('https://api.themoviedb.org/')) { assert.ok(!url.includes('a'.repeat(32))); assert.equal(init.headers.Authorization, undefined); }
    }
    assert.ok(!JSON.stringify(results).includes('a'.repeat(32)));
  });
  it('reports disabled Quick Connect and accepted TMDB, and permits another run after a minute', async () => {
    let now = 0;
    const check = new SelfCheck({ ...options, now: () => now, tmdbApiKey: 'read-token', versionStatus: () => ({ check: 'version', status: 'pass', explanation: 'Supported.' }), fetch: async (url, init) => {
      if (url.includes('QuickConnect')) return json(false);
      assert.equal(init.headers.Authorization, 'Bearer read-token');
      return json({ success: true });
    } });
    assert.deepEqual((await check.run()).filter((r) => ['quick_connect', 'version', 'tmdb'].includes(r.check)).map((r) => r.status), ['pass', 'pass', 'pass']);
    now = 60_000;
    assert.ok(await check.run());
  });
  it('handles failed probes and unexpected large responses without exposing their error text', async () => {
    const check = new SelfCheck({ ...options, jellyfinPublicUrls: ['https://origin.example.com'], seerrPublicUrl: 'https://seerr.example.com', tmdbApiKey: 'secret-token', fetch: async (url) => {
      if (url.includes('QuickConnect')) return new Response('x'.repeat(65537));
      throw new Error('secret-token');
    } });
    const results = await check.run();
    assert.ok(results.every((r) => r.status === 'warn'));
    assert.ok(!JSON.stringify(results).includes('secret-token'));
  });
  it('times out a stalled real upstream', async (t) => {
    const upstream = createServer(() => {});
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    t.after(() => { upstream.closeAllConnections(); upstream.close(); });
    const check = new SelfCheck({ ...options, jellyfinUrl: `http://127.0.0.1:${upstream.address().port}`, timeoutMs: 30 });
    assert.equal((await check.run()).find((r) => r.check === 'quick_connect').status, 'warn');
  });
  it('self-requests each household public address and checks Host, forwarding headers and trusted peer', async (t) => {
    let check;
    let sane = true;
    const server = createServer((req, res) => {
      req.headers['x-forwarded-for'] = sane ? '203.0.113.1, 127.0.0.1' : 'spoofed';
      req.headers['x-forwarded-proto'] = 'http';
      if (!check.handleProxyRequest(req, res)) { res.writeHead(404); res.end(); }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const url = `http://127.0.0.1:${server.address().port}`;
    let now = 0;
    check = new SelfCheck({ ...options, now: () => now, jellyfinUrl: url, householdUrls: () => [url, url], trustedProxies: ['127.0.0.1'] });
    assert.equal((await check.run()).find((r) => r.check === 'proxy').status, 'pass');
    sane = false; now = 60_000;
    assert.equal((await check.run()).find((r) => r.check === 'proxy').status, 'warn');
    assert.equal((await fetch(`${url}${PROXY_CHECK_PATH}?challenge=unknown`)).status, 404);
  });
  it('rejects URL credentials and ambiguous configuration', () => {
    for (const url of ['https://user:secret@media.example.com', 'https://media.example.com?key=secret', 'https://media.example.com#fragment', 'file:///tmp/file']) assert.throws(() => publicProbeUrls(url));
    assert.deepEqual(publicProbeUrls('https://media.example.com/'), ['https://media.example.com']);
  });
});

it('requires admin authentication and same-origin cookie POSTs before starting any self-check', async (t) => {
  const { makeServer } = await import('../dist/server.js');
  let runs = 0;
  const server = makeServer({}, { webhook: 'webhook', admin: 'admin' }, {
    session: async (request) => request.headers.cookie ? { status: 'active', username: 'Admin' } : { status: 'none' },
  }, { selfCheck: { run: async () => { runs++; return []; }, handleProxyRequest: () => false } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/v1/self-check`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${url}/v1/self-check`, { method: 'POST', headers: { Cookie: 'jellypass_session=token', Origin: 'https://member.example.com' } })).status, 403);
  assert.equal(runs, 0);
  assert.equal((await fetch(`${url}/v1/self-check`, { method: 'POST', headers: { Cookie: 'jellypass_session=token', Origin: url } })).status, 200);
  assert.equal((await fetch(`${url}/v1/self-check`, { method: 'POST', headers: { Authorization: 'Bearer admin' } })).status, 200);
  assert.equal(runs, 2);
});

it('keeps Jellyfin Enhanced public-config byte-identical through the real HTTP relay', async (t) => {
  const { makeServer } = await import('../dist/server.js');
  const body = '{\n  "custom": "unchanged", "enabled": true\n}\n';
  const upstream = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'X-Plugin-Test': 'kept' }); res.end(body); });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const gateway = makeServer({ canJoinLibrary: () => false, getHouseholdMemberIds: () => [] }, { webhook: 'w', admin: 'a' }, undefined, { householdGateway: { jellyfinUrl: `http://127.0.0.1:${upstream.address().port}`, domain: 'example.com', hostPrefix: 'media-' } });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  t.after(() => { gateway.closeAllConnections(); gateway.close(); upstream.closeAllConnections(); upstream.close(); });
  const { get } = await import('./support/household-app.mjs');
  for (const path of ['/JellyfinEnhanced/public-config', '/emby/JELLYFINENHANCED/%70ublic-config']) {
    const answer = await get(gateway.address().port, path, { Host: 'media-home.example.com' });
    assert.equal(answer.status, 200);
    assert.equal(answer.text, body);
    assert.equal(answer.headers['x-plugin-test'], 'kept');
  }
});
