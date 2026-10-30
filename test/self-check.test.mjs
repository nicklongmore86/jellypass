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
    for (const path of ['/plugins/abc/configuration', '/auth/keys', '/system/configuration/encoding', '/startup/user', '/library/virtualfolders', '/users/abc/policy', '/items/abc/refresh', '/streamyfin/config', '/jellyfinenhanced/reviews', '/Example/status', '/example/*', '/example/%61', '/example/../status', '/emby/example/status', '/example/status?key=secret']) assert.throws(() => parseAdditionalPluginRoutes(path));
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
    const seerr = (await new SelfCheck({ ...options, fetch: async () => json(false) }).run()).find((r) => r.check === 'seerr');
    assert.equal(seerr.status, 'warn');
    assert.match(seerr.explanation, /member network/);
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
    const check = new SelfCheck({ ...options, jellyfinUrl: `http://127.0.0.1:${upstream.address().port}`, seerrPublicUrl: `http://127.0.0.1:${upstream.address().port}`, timeoutMs: 30 });
    const results = await check.run();
    for (const name of ['quick_connect', 'seerr']) assert.equal(results.find((r) => r.check === name).status, 'warn');
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
  assert.equal((await fetch(`${url}/v1/self-check`, { method: 'POST', headers: { Authorization: 'Bearer admin', 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
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

it('never relays elevated methods, including paths shared with member reads', async () => {
  const { readFile } = await import('node:fs/promises');
  const elevated = JSON.parse(await readFile(new URL('./fixtures/gateway-elevated-routes.json', import.meta.url)));
  for (const [template, methods] of Object.entries(elevated)) {
    const path = template.replace(/\{[^}]+\}/g, 'abc123');
    for (const method of methods) assert.equal(householdRouteAllowed(path, [], method), false, `${method} ${path}`);
  }
  assert.equal(householdRouteAllowed('/system/configuration'), true);
  assert.equal(householdRouteAllowed('/system/configuration/encoding'), true);
  assert.equal(householdRouteAllowed('/system/configuration/secrets'), false);
});

it('preserves audited member routes from both pinned jellyfin-web bundles', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixture = JSON.parse(await readFile(new URL('./fixtures/jellyfin-web-member-routes.json', import.meta.url)));
  for (const route of fixture.memberRoutes) assert.ok(householdRouteAllowed(route), route);
  for (const route of fixture.excludedRoutes) {
    for (const method of ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS']) assert.equal(householdRouteAllowed(route, [], method), false, `${method} ${route}`);
  }
});

it('bounds concurrent household probes and the overall proxy duration', async () => {
  let active = 0, peak = 0, calls = 0;
  const check = new SelfCheck({ ...options, timeoutMs: 30, householdUrls: () => Array.from({ length: 64 }, (_, i) => `https://house${i}.example.com`), fetch: async (url, init) => {
    if (url.includes('QuickConnect')) return json(false);
    calls++; active++; peak = Math.max(peak, active);
    try { await new Promise((resolve, reject) => { const timer = setTimeout(resolve, 1000); init.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')); }, { once: true }); }); }
    finally { active--; }
    return json({});
  } });
  const start = Date.now();
  await check.run();
  assert.equal(peak, 4);
  assert.ok(calls < 64);
  assert.ok(Date.now() - start < 500);
});

it('logs every additional plugin template at startup and uses the live version gate for self-check', { timeout: 15000 }, async (t) => {
  const { spawn } = await import('node:child_process');
  const { once } = await import('node:events');
  const { makeTempDir } = await import('./support/temp-dir.mjs');
  const upstream = createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(req.url === '/System/Info/Public' ? '{"Version":"12.4.0"}' : 'false'); });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const directory = await makeTempDir(t, 'jfa-startup-policy-');
  const child = spawn(process.execPath, [new URL('../dist/index.js', import.meta.url).pathname], { env: {
    PATH: process.env.PATH, HOST: '127.0.0.1', PORT: String(port),
    WEBHOOK_TOKEN: 'webhook', ADMIN_TOKEN: 'admin', JELLYFIN_API_KEY: 'key',
    JELLYFIN_URL: `http://127.0.0.1:${upstream.address().port}`, STATE_FILE: `${directory}/state.json`,
    HOUSEHOLD_PLUGIN_ROUTES: '/example/status,/example/config', RECONCILE_INTERVAL_SECONDS: '0',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(output)), 10000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); });
    const collect = (chunk) => { output += chunk; if (output.includes('server started') && output.includes('read the Jellyfin version')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
  });
  const entries = output.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const warning = entries.find((entry) => entry.message?.includes('HOUSEHOLD_PLUGIN_ROUTES'));
  assert.equal(warning.level, 'warn');
  assert.deepEqual(warning.templates, ['/example/status', '/example/config']);
  const answer = await fetch(`http://127.0.0.1:${port}/v1/self-check`, { method: 'POST', headers: { Authorization: 'Bearer admin' } });
  assert.equal(answer.status, 200);
  const results = (await answer.json()).results;
  assert.equal(results.find((r) => r.check === 'version').status, 'pass');
  assert.equal(results.find((r) => r.check === 'seerr').status, 'warn');
});

it('warns whenever public Seerr responds, including large non-JSON pages', async () => {
  const check = new SelfCheck({ ...options, seerrPublicUrl: 'https://seerr.example.com', fetch: async (url) => url.includes('seerr') ? new Response('<html>' + 'x'.repeat(100000)) : json(false) });
  assert.equal((await check.run()).find((r) => r.check === 'seerr').status, 'warn');
});

it('allows audited member write actions and refuses metadata-editor routes and unsupported methods', () => {
  const writes = {
    POST: ['/userplayeditems/abc', '/users/abc/playeditems/abc', '/userfavoriteitems/abc', '/users/abc/favoriteitems/abc', '/useritems/abc/rating', '/users/abc/items/abc/rating', '/useritems/abc/userdata', '/users/abc/items/abc/userdata', '/playlists', '/playlists/abc/items', '/playlists/abc/items/abc/move/0', '/displaypreferences/abc', '/sessions/playing', '/sessions/playing/progress', '/sessions/playing/stopped', '/videos/abc/subtitles', '/items/abc/remotesearch/subtitles/eng', ...['buffering', 'join', 'leave', 'moveplaylistitem', 'new', 'nextitem', 'pause', 'ping', 'previousitem', 'queue', 'ready', 'removefromplaylist', 'seek', 'setignorewait', 'setnewqueue', 'setplaylistitem', 'setrepeatmode', 'setshufflemode', 'stop', 'unpause'].map((action) => `/syncplay/${action}`)],
    DELETE: ['/userplayeditems/abc', '/users/abc/playeditems/abc', '/userfavoriteitems/abc', '/users/abc/favoriteitems/abc', '/useritems/abc/rating', '/users/abc/items/abc/rating', '/playlists/abc/items'],
  };
  for (const [method, paths] of Object.entries(writes)) for (const path of paths) assert.ok(householdRouteAllowed(path, [], method), `${method} ${path}`);
  for (const path of [...['movie', 'series', 'trailer', 'boxset', 'book', 'musicalbum', 'musicartist', 'musicvideo'].map((type) => `/items/remotesearch/${type}`), '/items/abc/remoteimages', '/items/abc/remoteimages/providers', '/items/abc/remoteimages/download']) {
    for (const method of ['GET', 'HEAD', 'POST', 'DELETE', 'OPTIONS']) assert.equal(householdRouteAllowed(path, [], method), false, `${method} ${path}`);
    assert.throws(() => parseAdditionalPluginRoutes(path));
  }
  for (const method of ['PUT', 'PATCH', 'TRACE', 'CONNECT', 'CUSTOM']) assert.equal(householdRouteAllowed('/items', [], method), false, method);
});
