import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AccessService } from '../dist/access-service.js';
import { APP_PERMISSIONS_POLICY } from '../dist/app-assets.js';
import { WebAuth } from '../dist/auth.js';
import { JellyfinClient, JellyfinError } from '../dist/jellyfin.js';
import { makeServer } from '../dist/server.js';
import { GrantStore } from '../dist/store.js';
import { createFakeJellyfin } from './support/fake-jellyfin.mjs';
import { makeTempDir } from './support/temp-dir.mjs';

const LOCAL = '127.0.0.1';
const SIBLING = 'https://jelly-farmhouse.example.test';
const REFUSED = '{"error":"cross_origin_request_refused"}';
const INVALID = '{"error":"invalid_credentials"}';
const MINUTE = 60 * 1000;
const LIMITED = '{"error":"too_many_login_attempts"}';
const TOKENS = { webhook: 'webhook-secret', admin: 'admin-secret' };

// Every state-changing admin endpoint, with the body (if any) a cross-site page could send it without a preflight.
const ENDPOINTS = [
  ['POST', '/v1/users', JSON.stringify({ username: 'Mallory', password: '', groupId: 'farmhouse', importToJellyseerr: true })],
  ['POST', '/v1/reconcile'],
  ['POST', '/v1/library/sync'],
  ['POST', '/v1/grants/item-1/remap', JSON.stringify({ toItemId: 'item-2' })],
  ['PUT', '/v1/groups/mallory', JSON.stringify({ name: 'Mallory', userIds: [] })],
  ['DELETE', '/v1/groups/farmhouse'],
  ['PUT', '/v1/library/access', JSON.stringify({ itemIds: ['item-1'], userIds: ['bob-id'], groupIds: [] })],
  ['PUT', '/v1/users/alice-id/sign-in', JSON.stringify({ passwordless: true })],
  ['POST', '/v1/app/requests/7380001/approve'],
  ['POST', '/v1/app/requests/7380001/decline'],
  ['POST', '/v1/app/requests/7380001/cancel', JSON.stringify({ removeFromRadarr: true })],
  ['POST', '/v1/app/held/7380001/release', JSON.stringify({ householdIds: ['grove'] })],
  ['POST', '/auth/logout'],
];
const CROSS_SITE = [
  ['cross-site Sec-Fetch-Site', { 'sec-fetch-site': 'cross-site', origin: 'https://attacker.test' }],
  ['same-site sibling Sec-Fetch-Site', { 'sec-fetch-site': 'same-site', origin: SIBLING }],
  ['sibling Origin without Sec-Fetch-Site', { origin: SIBLING }],
  ['Origin null', { origin: 'null' }],
  ['neither header', {}],
  ['Sec-Fetch-Site none', { 'sec-fetch-site': 'none' }],
];

describe('admin surface hardening', { timeout: 20_000 }, () => {
  let jellyfin;
  let store;
  let server;
  let port;
  let imports;
  const clock = { now: 1_000_000 };

  before(async () => {
    jellyfin = await createFakeJellyfin();
    store = new GrantStore(path.join(await makeTempDir(null, 'jfa-admin-hardening-'), 'grants.json'));
    await store.load();
    await store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: ['alice-id', 'bob-id'] });
    imports = [];
    const seerr = {
      async importJellyfinUser(jellyfinUserId) {
        imports.push(jellyfinUserId);
        return { status: 'imported', user: { id: 44, jellyfinUserId } };
      },
    };
    const jellyfinClient = new JellyfinClient(jellyfin.url, 'test-key');
    const service = new AccessService(jellyfinClient, store, undefined, seerr);
    const webAuth = new WebAuth(jellyfinClient, { loginFailureDelayMs: 0, now: () => clock.now });
    server = makeServer(service, { webhook: 'webhook-secret', admin: 'admin-secret' }, webAuth, {
      trustedProxies: [LOCAL],
      householdGateway: { jellyfinUrl: jellyfin.url, domain: 'example.test', hostPrefix: 'jelly-' },
    });
    port = await listen(server);
  });

  after(async () => {
    server.closeAllConnections();
    await Promise.all([close(server), jellyfin.close()]);
  });

  const login = async (headers = {}) => {
    const response = await send(port, '/auth/login', {
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      ...headers,
    }, { method: 'POST', body: JSON.stringify({ username: 'Admin', password: 'admin-password' }) });
    assert.equal(response.status, 200, response.body);
    return response.headers['set-cookie'][0].split(';')[0];
  };

  it('refuses a cookie-authenticated state change from anywhere but the admin origin, before any side effect', async () => {
    const cookie = await login();
    const groupsBefore = (await send(port, '/v1/groups', { authorization: 'Bearer admin-secret' })).body;
    const requestsBefore = jellyfin.requestedPaths.length;
    for (const [method, pathname, body] of ENDPOINTS) {
      for (const [label, headers] of CROSS_SITE) {
        const response = await send(port, pathname, { cookie, 'content-type': 'text/plain', ...headers }, { method, body });
        assert.equal(response.status, 403, `${method} ${pathname} with ${label}`);
        assert.equal(response.body, REFUSED, `${method} ${pathname} with ${label}`);
        assert.equal(response.headers['set-cookie'], undefined, `${method} ${pathname} with ${label}`);
      }
    }
    assert.equal(jellyfin.requestedPaths.length, requestsBefore, 'no Jellyfin call was made');
    assert.deepEqual(imports, []);
    assert.equal(jellyfin.user('mallory-id'), undefined);
    assert.equal((await send(port, '/v1/groups', { authorization: 'Bearer admin-secret' })).body, groupsBefore);
    // The logout attempts did not end the session.
    assert.equal((await send(port, '/auth/session', { cookie })).status, 200);
  });

  it('refuses a cross-origin sign-in before Jellyfin is asked', async () => {
    const requestsBefore = jellyfin.requestedPaths.length;
    for (const [label, headers] of CROSS_SITE) {
      const response = await send(port, '/auth/login', { 'content-type': 'text/plain', ...headers }, {
        method: 'POST',
        body: JSON.stringify({ username: 'Admin', password: 'admin-password' }),
      });
      assert.equal(response.status, 403, label);
      assert.equal(response.body, REFUSED, label);
      assert.equal(response.headers['set-cookie'], undefined, label);
    }
    assert.equal(jellyfin.requestedPaths.length, requestsBefore);
  });

  it('accepts the admin origin by Sec-Fetch-Site, or by an Origin naming the host and scheme it arrived at', async () => {
    const cookie = await login();
    const sync = (headers) => send(port, '/v1/library/sync', { cookie, ...headers }, { method: 'POST' });
    assert.equal((await sync({ 'sec-fetch-site': 'same-origin' })).status, 200);
    assert.equal((await sync({ 'sec-fetch-site': 'same-origin', origin: SIBLING })).status, 200, 'Sec-Fetch-Site decides when present');
    assert.equal((await sync({ origin: `http://${LOCAL}:${port}` })).status, 200);
    assert.equal((await sync({ origin: `http://localhost:${port}` })).status, 403, 'another name for the host is another origin');
    assert.equal((await sync({ origin: `http://${LOCAL}:${port + 1}` })).status, 403, 'another port');
    assert.equal((await sync({ origin: `http://${LOCAL}:${port}/` })).status, 403, 'not an origin');
    assert.equal((await sync({ origin: `http://user@${LOCAL}:${port}` })).status, 403, 'not an origin');
    assert.equal((await sync({ 'sec-fetch-site': 'same-site', origin: `http://${LOCAL}:${port}` })).status, 403);

    // Behind the proxy: Host as the browser sent it, scheme from X-Forwarded-Proto.
    const secureCookie = await login({ host: 'admin.example.test', 'x-forwarded-proto': 'https' });
    const proxied = (headers) => send(port, '/v1/library/sync', {
      cookie: secureCookie,
      host: 'admin.example.test',
      'x-forwarded-proto': 'https',
      ...headers,
    }, { method: 'POST' });
    assert.equal((await proxied({ origin: 'https://admin.example.test' })).status, 200);
    assert.equal((await proxied({ origin: 'https://admin.example.test:443' })).status, 403, 'browsers never send a default port');
    assert.equal((await proxied({ origin: 'http://admin.example.test' })).status, 403, 'an HTTPS request needs an https Origin');
    assert.equal((await proxied({ origin: 'https://ADMIN.example.test' })).status, 403, 'browsers send the host in lower case');
    assert.equal((await proxied({ origin: SIBLING })).status, 403);
    // X-Forwarded-Host is never read, even from a trusted proxy (this server trusts the test's address): a proxy that
    // keeps Host may pass a client's own X-Forwarded-Host on, and a sibling page must not widen the admin origin with it.
    assert.equal((await proxied({ 'x-forwarded-host': 'jelly-farmhouse.example.test', origin: SIBLING })).status, 403);
    assert.equal((await proxied({ 'x-forwarded-host': 'jelly-farmhouse.example.test, admin.example.test', origin: SIBLING })).status, 403);
    assert.equal((await proxied({ 'x-forwarded-host': 'jelly-farmhouse.example.test', origin: 'https://admin.example.test' })).status, 200, 'Host decides');
    assert.equal((await proxied({ host: 'jellypass:8787', 'x-forwarded-host': 'admin.example.test', origin: 'https://admin.example.test' })).status, 403);
    const spoofedSignIn = await send(port, '/auth/login', {
      host: 'admin.example.test',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'jelly-farmhouse.example.test',
      origin: SIBLING,
      'content-type': 'application/json',
    }, { method: 'POST', body: JSON.stringify({ username: 'Admin', password: 'admin-password' }) });
    assert.deepEqual([spoofedSignIn.status, spoofedSignIn.body], [403, REFUSED]);
    // A proxy that terminates TLS but reports the plain hop it forwarded over: the https Origin still matches its host.
    const plainHop = await send(port, '/v1/library/sync', { cookie, host: 'admin.example.test', origin: 'https://admin.example.test' }, { method: 'POST' });
    assert.equal(plainHop.status, 200);
  });

  it('ignores X-Forwarded-Host from a peer that is not a trusted proxy too', async () => {
    const webAuth = new WebAuth(new JellyfinClient(jellyfin.url, 'test-key'), { loginFailureDelayMs: 0 });
    const untrusted = makeServer(stubService(), { webhook: 'webhook-secret', admin: 'admin-secret' }, webAuth);
    const untrustedPort = await listen(untrusted);
    try {
      const response = await send(untrustedPort, '/auth/login', {
        host: 'jellypass:8787',
        'x-forwarded-host': 'admin.example.test',
        origin: 'https://admin.example.test',
        'content-type': 'application/json',
      }, { method: 'POST', body: JSON.stringify({ username: 'Admin', password: 'admin-password' }) });
      assert.equal(response.status, 403);
    } finally {
      untrusted.closeAllConnections();
      await close(untrusted);
    }
  });

  it('exempts ADMIN_TOKEN bearer requests, which carry no ambient credential', async () => {
    const response = await send(port, '/v1/library/sync', {
      authorization: 'Bearer admin-secret',
      'sec-fetch-site': 'cross-site',
      origin: 'https://attacker.test',
    }, { method: 'POST' });
    assert.equal(response.status, 200);
    const wrongToken = await send(port, '/v1/library/sync', { authorization: 'Bearer wrong', 'sec-fetch-site': 'cross-site' }, { method: 'POST' });
    assert.equal(wrongToken.status, 401);
  });

  it('answers 415 for a body not declared as JSON, before reading it', async () => {
    const cookie = await login();
    const groupsBefore = (await send(port, '/v1/groups', { authorization: 'Bearer admin-secret' })).body;
    const body = JSON.stringify({ name: 'Plain', userIds: [] });
    for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonx', undefined]) {
      const headers = { cookie, 'sec-fetch-site': 'same-origin', ...(contentType ? { 'content-type': contentType } : {}) };
      const response = await send(port, '/v1/groups/plain', headers, { method: 'PUT', body });
      assert.equal(response.status, 415, String(contentType));
      assert.equal(response.body, '{"error":"unsupported_media_type"}');
      const bearer = await send(port, '/v1/groups/plain', { authorization: 'Bearer admin-secret', ...(contentType ? { 'content-type': contentType } : {}) }, { method: 'PUT', body });
      assert.equal(bearer.status, 415, `bearer ${contentType}`);
      const signIn = await send(port, '/auth/login', { 'sec-fetch-site': 'same-origin', ...(contentType ? { 'content-type': contentType } : {}) }, {
        method: 'POST',
        body: JSON.stringify({ username: 'Admin', password: 'admin-password' }),
      });
      assert.equal(signIn.status, 415, `login ${contentType}`);
    }
    assert.equal((await send(port, '/v1/groups', { authorization: 'Bearer admin-secret' })).body, groupsBefore);
    const withCharset = await send(port, '/v1/groups/plain', { cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'Application/JSON; charset=utf-8' }, { method: 'PUT', body });
    assert.equal(withCharset.status, 200);
    assert.equal((await send(port, '/v1/groups/plain', { cookie, 'sec-fetch-site': 'same-origin' }, { method: 'DELETE' })).status, 200);
  });

  it('answers 415 for a non-JSON body on routes that never read one, before any side effect', async () => {
    const cookie = await login();
    const routes = [
      ...ENDPOINTS.map(([method, pathname]) => [method, pathname]),
      ['DELETE', '/v1/grants/item-1/requests/request-1'],
      ['PUT', '/v1/grants/item-1/groups'],
      ['PUT', '/v1/grants/item-1/manual'],
    ];
    const groupsBefore = (await send(port, '/v1/groups', { authorization: 'Bearer admin-secret' })).body;
    const requestsBefore = jellyfin.requestedPaths.length;
    for (const [method, pathname] of routes) {
      for (const [label, headers] of [
        ['bearer', { authorization: 'Bearer admin-secret' }],
        ['same-origin cookie', { cookie, 'sec-fetch-site': 'same-origin' }],
      ]) {
        if (label === 'bearer' && pathname === '/auth/logout') continue; // Sign-out is origin-checked whatever it carries.
        // Node's client sends a DELETE body without Content-Length unless it is given one.
        for (const extra of [{ 'content-type': 'text/plain', 'content-length': '2' }, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' }, { 'content-length': '2' }]) {
          const response = await send(port, pathname, { ...headers, ...extra }, { method, body: '{}' });
          assert.equal(response.status, 415, `${label} ${method} ${pathname} ${JSON.stringify(extra)}`);
          assert.equal(response.body, '{"error":"unsupported_media_type"}');
        }
      }
    }
    assert.equal(jellyfin.requestedPaths.length, requestsBefore, 'no Jellyfin call was made');
    assert.equal((await send(port, '/v1/groups', { authorization: 'Bearer admin-secret' })).body, groupsBefore);
    // The logout attempts did not end the session.
    assert.equal((await send(port, '/auth/session', { cookie })).status, 200);
  });

  it('still accepts body-less state changes with any Content-Type, and JSON bodies on them', async () => {
    const cookie = await login();
    for (const headers of [{ authorization: 'Bearer admin-secret' }, { cookie, 'sec-fetch-site': 'same-origin' }]) {
      for (const contentType of [undefined, 'text/plain', 'application/json']) {
        const typed = { ...headers, ...(contentType ? { 'content-type': contentType } : {}) };
        assert.equal((await send(port, '/v1/library/sync', typed, { method: 'POST' })).status, 200, `sync ${contentType}`);
        assert.equal((await send(port, '/v1/reconcile?dryRun=true', typed, { method: 'POST' })).status, 200, `reconcile ${contentType}`);
      }
      const json = { ...headers, 'content-type': 'application/json; charset=utf-8' };
      assert.equal((await send(port, '/v1/library/sync', json, { method: 'POST', body: '{}' })).status, 200);
      assert.equal((await send(port, '/v1/reconcile?dryRun=true', json, { method: 'POST', body: '{}' })).status, 200);
    }
    assert.equal((await send(port, '/auth/logout', { cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain' }, { method: 'POST' })).status, 200);
    assert.equal((await send(port, '/auth/session', { cookie })).status, 401);
  });

  it('checks the origin and the credentials before the body\'s type', async () => {
    const cookie = await login();
    const plain = { 'content-type': 'text/plain', 'content-length': '2' };
    for (const [method, pathname] of ENDPOINTS) {
      const crossSite = await send(port, pathname, { cookie, ...plain, 'sec-fetch-site': 'cross-site', origin: 'https://attacker.test' }, { method, body: '{}' });
      assert.deepEqual([crossSite.status, crossSite.body], [403, REFUSED], `${method} ${pathname}`);
    }
    const anonymous = await send(port, '/v1/library/sync', plain, { method: 'POST', body: '{}' });
    assert.equal(anonymous.status, 401);
    const wrongToken = await send(port, '/v1/library/sync', { ...plain, authorization: 'Bearer wrong' }, { method: 'POST', body: '{}' });
    assert.equal(wrongToken.status, 401);
  });

  it('answers unknown admin paths and methods 404 whatever their body, as before', async () => {
    const cookie = await login();
    const unknown = [
      ['POST', '/v1/nonexistent'],
      ['PUT', '/v1/nonexistent'],
      ['DELETE', '/v1/nonexistent'],
      ['PATCH', '/v1/groups/farmhouse'],
      ['POST', '/v1/groups/farmhouse'],
      ['PUT', '/v1/library/sync'],
      ['DELETE', '/v1/reconcile'],
    ];
    const requestsBefore = jellyfin.requestedPaths.length;
    for (const [method, pathname] of unknown) {
      for (const [label, headers] of [
        ['bearer', { authorization: 'Bearer admin-secret' }],
        ['same-origin cookie', { cookie, 'sec-fetch-site': 'same-origin' }],
      ]) {
        for (const extra of [{ 'content-type': 'text/plain', 'content-length': '2' }, { 'content-type': 'text/plain', 'transfer-encoding': 'chunked' }, { 'content-length': '2' }]) {
          const response = await send(port, pathname, { ...headers, ...extra }, { method, body: '{}' });
          assert.deepEqual([response.status, response.body], [404, '{"error":"not_found"}'], `${label} ${method} ${pathname} ${JSON.stringify(extra)}`);
        }
      }
    }
    assert.equal(jellyfin.requestedPaths.length, requestsBefore, 'no Jellyfin call was made');
  });

  it('answers 415 from the headers alone, without waiting for a body that never comes', async () => {
    const groupsBefore = (await send(port, '/v1/groups', { authorization: 'Bearer admin-secret' })).body;
    const requestsBefore = jellyfin.requestedPaths.length;
    for (const [method, pathname] of [['POST', '/v1/library/sync'], ['POST', '/v1/reconcile'], ['DELETE', '/v1/groups/farmhouse']]) {
      for (const framing of ['Content-Length: 5', 'Transfer-Encoding: chunked']) {
        const started = Date.now();
        const response = await sendHeadersOnly(port, `${method} ${pathname} HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer admin-secret\r\nContent-Type: text/plain\r\n${framing}\r\n\r\n`);
        assert.deepEqual([response.status, response.body], [415, '{"error":"unsupported_media_type"}'], `${method} ${pathname} ${framing}`);
        assert.ok(Date.now() - started < 1_000, `${method} ${pathname} ${framing} answered promptly`);
      }
    }
    assert.equal(jellyfin.requestedPaths.length, requestsBefore, 'no handler ran');
    assert.equal((await send(port, '/v1/groups', { authorization: 'Bearer admin-secret' })).body, groupsBefore);
  });

  it('keeps the Seerr webhook, /health and /metrics as they were', async () => {
    const webhook = await send(port, '/webhooks/seerr?token=webhook-secret', { 'content-type': 'text/plain', 'sec-fetch-site': 'cross-site' }, {
      method: 'POST',
      body: JSON.stringify({ notificationType: 'TEST_NOTIFICATION', request: { id: '1' } }),
    });
    assert.equal(webhook.status, 202);
    assert.equal((await send(port, '/health', {})).status, 200);
    const metrics = await send(port, '/metrics', { authorization: 'Bearer admin-secret' });
    assert.equal(metrics.status, 200);
    assert.match(metrics.headers['content-type'], /^text\/plain; version=0\.0\.4/);
    assert.equal((await send(port, '/metrics', {})).status, 401);
  });

  it('serves the admin UI with the household app\'s security headers', async () => {
    for (const pathname of ['/admin/', '/admin/app.js', '/admin/styles.css', '/admin/favicon.svg']) {
      const response = await send(port, pathname, {});
      assert.equal(response.status, 200, pathname);
      assert.equal(response.headers['permissions-policy'], APP_PERMISSIONS_POLICY, pathname);
      assert.equal(response.headers['cross-origin-opener-policy'], 'same-origin', pathname);
      assert.equal(response.headers['cross-origin-resource-policy'], 'same-origin', pathname);
      assert.equal(response.headers['cache-control'], 'no-store', pathname);
      assert.equal(response.headers['x-frame-options'], 'DENY', pathname);
      const csp = response.headers['content-security-policy'];
      assert.match(csp, /(?:^|; )form-action 'none'(?:;|$)/, pathname);
      assert.match(csp, /(?:^|; )frame-ancestors 'none'(?:;|$)/, pathname);
      assert.match(csp, /(?:^|; )default-src 'none'(?:;|$)/, pathname);
    }
    const api = await send(port, '/v1/groups', { authorization: 'Bearer admin-secret' });
    assert.equal(api.headers['cross-origin-resource-policy'], 'same-origin');
    // The UI posts no forms: every form's submit is handled by script, and every body it sends is declared as JSON.
    const script = (await send(port, '/admin/app.js', {})).body;
    const html = (await send(port, '/admin/', {})).body;
    const forms = [...html.matchAll(/<form id="([^"]+)"/g)].map((match) => match[1]);
    assert.ok(forms.length >= 5);
    for (const form of forms) {
      assert.doesNotMatch(html, new RegExp(`<form id="${form}"[^>]*\\b(?:action|method)=`), form);
      assert.match(script, new RegExp(`byId\\('${form}'\\)\\.addEventListener\\('submit'`), form);
    }
    assert.match(script, /if \(config\.body\) headers\.set\('Content-Type', 'application\/json'\)/);
  });

  it('names the session cookie __Host- over HTTPS and reads only the name for the scheme', async () => {
    const secure = await send(port, '/auth/login', {
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-proto': 'https',
    }, { method: 'POST', body: JSON.stringify({ username: 'Admin', password: 'admin-password' }) });
    const [hostCookie, legacy] = secure.headers['set-cookie'];
    assert.match(hostCookie, /^__Host-jellypass_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=43200; Secure$/);
    assert.equal(legacy, 'jellypass_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure');
    const token = hostCookie.split(';')[0].split('=')[1];
    const session = (cookie, headers = {}) => send(port, '/auth/session', { cookie, ...headers });
    assert.equal((await session(`__Host-jellypass_session=${token}`, { 'x-forwarded-proto': 'https' })).status, 200);
    assert.equal((await session(`jellypass_session=${token}`, { 'x-forwarded-proto': 'https' })).status, 401, 'the plain name is ignored over HTTPS');
    assert.equal((await session(`__Host-jellypass_session=${token}`)).status, 401, 'the prefixed name is ignored over HTTP');

    const plain = await login();
    assert.match(plain, /^jellypass_session=/);
    const logout = await send(port, '/auth/logout', { cookie: `__Host-jellypass_session=${token}`, 'x-forwarded-proto': 'https', 'sec-fetch-site': 'same-origin' }, { method: 'POST' });
    assert.equal(logout.status, 200);
    assert.deepEqual(logout.headers['set-cookie'], [
      '__Host-jellypass_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure',
      'jellypass_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure',
    ]);
    assert.equal((await session(`__Host-jellypass_session=${token}`, { 'x-forwarded-proto': 'https' })).status, 401);
  });

  it('re-checks a session\'s administrator every five minutes and ends it once they are demoted or disabled', async () => {
    const cookie = await login();
    const userReads = () => jellyfin.requestedPaths.filter((entry) => entry === '/Users/admin-id').length;
    const groups = () => send(port, '/v1/groups', { cookie });
    const before = userReads();
    clock.now += 4 * MINUTE;
    assert.equal((await groups()).status, 200);
    assert.equal(userReads(), before, 'no check before the interval');
    clock.now += MINUTE;
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => groups()));
    assert.deepEqual(concurrent.map((response) => response.status), [200, 200, 200, 200, 200]);
    assert.equal(userReads(), before + 1, 'one check for many waiting requests');
    assert.equal((await groups()).status, 200);
    assert.equal(userReads(), before + 1);

    jellyfin.user('admin-id').Policy.IsAdministrator = false;
    try {
      clock.now += 5 * MINUTE;
      assert.equal((await groups()).status, 401);
    } finally {
      jellyfin.user('admin-id').Policy.IsAdministrator = true;
    }
    assert.equal((await groups()).status, 401, 'the session stays ended');
    assert.equal((await send(port, '/auth/session', { cookie })).status, 401);

    const second = await login();
    jellyfin.user('admin-id').Policy.IsDisabled = true;
    try {
      clock.now += 5 * MINUTE;
      assert.equal((await send(port, '/auth/session', { cookie: second })).status, 401);
    } finally {
      delete jellyfin.user('admin-id').Policy.IsDisabled;
    }
    assert.equal((await groups()).status, 401);
  });
});

describe('administrator sign-in hardening', { timeout: 20_000 }, () => {
  it('answers every kind of refused sign-in with the same body and status, no sooner than the delay', async () => {
    // A Jellyfin whose sign-in fails in every way but success, including errors that carry text of its own.
    const upstream = createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const credentials = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
      if (request.url === '/Users/AuthenticateByName') {
        if (credentials.Username === 'Broken') {
          response.writeHead(500, { 'Content-Type': 'text/plain' });
          return response.end('System.NullReferenceException at Jellyfin.Server secret-stack-detail');
        }
        if (credentials.Username === 'Forbidden') {
          response.writeHead(403, { 'Content-Type': 'text/plain' });
          return response.end('forbidden-detail');
        }
        if (credentials.Username === 'Viewer' && credentials.Pw === 'viewer-password') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          return response.end(JSON.stringify({ User: { Id: 'viewer-id', Name: 'Viewer' }, AccessToken: 'viewer-token' }));
        }
        response.writeHead(401);
        return response.end();
      }
      if (request.url === '/Sessions/Logout') {
        response.writeHead(204);
        return response.end();
      }
      if (request.url === '/Users/viewer-id') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        return response.end(JSON.stringify({ Id: 'viewer-id', Name: 'Viewer', Policy: { IsAdministrator: false } }));
      }
      response.writeHead(404);
      response.end();
    });
    const upstreamPort = await listen(upstream);
    const DELAY = 300;
    const webAuth = new WebAuth(new JellyfinClient(`http://${LOCAL}:${upstreamPort}`, 'test-key'), { loginFailureDelayMs: DELAY });
    const server = makeServer(stubService(), { webhook: 'webhook-secret', admin: 'admin-secret' }, webAuth, { trustedProxies: [LOCAL] });
    const port = await listen(server);
    try {
      const attempts = [
        ['wrong password', JSON.stringify({ username: 'Admin', password: 'wrong' })],
        ['unknown user', JSON.stringify({ username: 'Nobody', password: 'wrong' })],
        ['not an administrator', JSON.stringify({ username: 'Viewer', password: 'viewer-password' })],
        ['Jellyfin 500 with text', JSON.stringify({ username: 'Broken', password: 'whatever' })],
        ['Jellyfin 403 with text', JSON.stringify({ username: 'Forbidden', password: 'whatever' })],
        ['missing password', JSON.stringify({ username: 'Admin' })],
        ['empty username', JSON.stringify({ username: ' ', password: 'x' })],
        ['not an object', '[1,2]'],
        ['not JSON', '{"username":'],
        ['oversized username', JSON.stringify({ username: 'a'.repeat(300), password: 'x' })],
      ];
      for (const [index, [label, body]] of attempts.entries()) {
        const started = performance.now();
        const response = await send(port, '/auth/login', {
          'content-type': 'application/json',
          'sec-fetch-site': 'same-origin',
          'x-forwarded-for': `198.51.100.${index + 1}`,
        }, { method: 'POST', body });
        const elapsed = performance.now() - started;
        assert.equal(response.status, 401, label);
        assert.equal(response.body, INVALID, label);
        assert.equal(response.headers['set-cookie'], undefined, label);
        assert.ok(elapsed >= DELAY - 5, `${label} took ${Math.round(elapsed)} ms`);
      }
    } finally {
      server.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([close(server), close(upstream)]);
    }
  });

  it('never locks a name out: its owner\'s right password from an address of their own still signs in (Codex\'s repro)', async () => {
    const clock = { now: 0 };
    let calls = 0;
    const webAuth = new WebAuth({
      authenticateAdministrator: async (username, password) => {
        calls += 1;
        return username.toLowerCase() === 'nick' && password === 'right' ? { Id: 'nick-id', Name: 'Nick', Policy: { IsAdministrator: true } } : null;
      },
    }, { loginFailureDelayMs: 0, nameDelayStepMs: 1, nameDelayMaxMs: 4, now: () => clock.now });
    const attackers = ['198.51.100.1', '198.51.100.2'];
    // Ten wrong passwords for the name from two addresses, each under the per-address limit of eight.
    for (let index = 0; index < 10; index += 1) assert.equal(await webAuth.login(index % 2 ? 'nick' : 'NICK', 'wrong', attackers[index % 2]), null);
    assert.equal((await webAuth.login('nick', 'right', '203.0.113.50')).username, 'Nick');

    // The attackers keep going: each address is refused at its own limit, without Jellyfin being asked...
    for (let round = 0; round < 3; round += 1) {
      for (const attacker of attackers) assert.equal(await webAuth.login('nick', 'wrong', attacker), null);
    }
    for (const attacker of attackers) {
      const callsBefore = calls;
      await assert.rejects(webAuth.login('nick', 'wrong', attacker), /too_many_login_attempts/, attacker);
      await assert.rejects(webAuth.login('nick', 'right', attacker), /too_many_login_attempts/, attacker);
      assert.equal(calls, callsBefore, `${attacker} is refused before Jellyfin`);
    }
    // ...and the owner, on yet another address, still signs in at once.
    assert.equal((await webAuth.login(' Nick ', 'right', '203.0.113.51')).username, 'Nick');
    // Still so after more failures from many more addresses.
    for (let index = 0; index < 40; index += 1) assert.equal(await webAuth.login('nick', 'wrong', `192.0.2.${index}`), null);
    assert.equal((await webAuth.login('nick', 'right', '203.0.113.52')).username, 'Nick');
  });

  it('refuses one name from one address after ten failures in 15 minutes, however it is spelled', async () => {
    const clock = { now: 0 };
    let calls = 0;
    const webAuth = new WebAuth({
      authenticateAdministrator: async (username, password) => {
        calls += 1;
        return username.toLowerCase() === 'admin' && password === 'right' ? { Id: 'admin-id', Name: 'Admin', Policy: { IsAdministrator: true } } : null;
      },
    }, { loginFailureDelayMs: 0, nameDelayMaxMs: 0, now: () => clock.now });
    const spellings = ['Admin', 'admin', ' ADMIN ', 'ａｄｍｉｎ'];
    // Eight failures reach the per-address limit; once its five minutes pass, two more reach the per-name-and-address one.
    for (let index = 0; index < 8; index += 1) assert.equal(await webAuth.login(spellings[index % 4], 'wrong', '203.0.113.9'), null);
    clock.now += 5 * MINUTE;
    for (let index = 0; index < 2; index += 1) assert.equal(await webAuth.login(spellings[index % 4], 'wrong', '203.0.113.9'), null);
    const callsBefore = calls;
    await assert.rejects(webAuth.login('admin', 'right', '203.0.113.9'), /too_many_login_attempts/);
    assert.equal(calls, callsBefore, 'not tried at Jellyfin');
    assert.equal(await webAuth.login('someone-else', 'wrong', '203.0.113.9'), null, 'other names from the address are not limited');
    assert.equal((await webAuth.login('admin', 'right', '203.0.113.10')).username, 'Admin', 'nor is the name from other addresses');

    // A name Jellyfin has no user for is limited in exactly the same way.
    for (let index = 0; index < 8; index += 1) assert.equal(await webAuth.login('Nobody', 'wrong', '192.0.2.9'), null);
    clock.now += 5 * MINUTE;
    for (let index = 0; index < 2; index += 1) assert.equal(await webAuth.login('nobody', 'wrong', '192.0.2.9'), null);
    await assert.rejects(webAuth.login('NOBODY', 'wrong', '192.0.2.9'), /too_many_login_attempts/);

    clock.now += 10 * MINUTE;
    assert.equal((await webAuth.login('admin', 'right', '203.0.113.9')).username, 'Admin', 'the window ends');
  });

  it('slows a name down after five failures from anywhere, doubling up to a cap, without ever refusing it', async () => {
    const clock = { now: 0 };
    const webAuth = new WebAuth({
      authenticateAdministrator: async (username, password) => (password === 'right' && username === 'admin'
        ? { Id: 'admin-id', Name: 'admin', Policy: { IsAdministrator: true } }
        : null),
    }, { loginFailureDelayMs: 0, nameDelayStepMs: 40, nameDelayMaxMs: 160, now: () => clock.now });
    const timed = async (username, password, client) => {
      const started = performance.now();
      const result = await webAuth.login(username, password, client);
      return { result, elapsed: performance.now() - started };
    };
    for (const name of ['admin', 'nobody']) {
      for (let index = 0; index < 5; index += 1) {
        const { result, elapsed } = await timed(name, 'wrong', `198.51.100.${index}`);
        assert.equal(result, null);
        assert.ok(elapsed < 35, `${name} failure ${index + 1} took ${Math.round(elapsed)} ms`);
      }
      // 40, 80, 160, then capped at 160.
      for (const [index, least] of [40, 80, 160, 160].entries()) {
        const { result, elapsed } = await timed(name, 'wrong', `198.51.100.${10 + index}`);
        assert.equal(result, null);
        assert.ok(elapsed >= least - 5 && elapsed < least + 150, `${name}: ${Math.round(elapsed)} ms, expected ${least}`);
      }
    }
    // The right password waits too, then succeeds; success clears the name's count.
    const right = await timed('admin', 'right', '203.0.113.1');
    assert.equal(right.result.username, 'admin');
    assert.ok(right.elapsed >= 155, `${Math.round(right.elapsed)} ms`);
    assert.ok((await timed('admin', 'wrong', '203.0.113.2')).elapsed < 35);
    // The count lasts 15 minutes.
    clock.now += 15 * MINUTE;
    assert.ok((await timed('nobody', 'wrong', '203.0.113.3')).elapsed < 35);
  });

  it('answers a limited sign-in with the fixed 429, no sooner than the delay, whatever the name or password', async () => {
    const DELAY = 200;
    const webAuth = new WebAuth({
      authenticateAdministrator: async (username, password) => (password === 'right' ? { Id: 'admin-id', Name: 'Admin', Policy: { IsAdministrator: true } } : null),
    }, { loginFailureDelayMs: DELAY, nameDelayMaxMs: 0 });
    const server = makeServer(stubService(), TOKENS, webAuth, { trustedProxies: [LOCAL] });
    const port = await listen(server);
    const attempt = (username, password) => send(port, '/auth/login', {
      'content-type': 'application/json',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-for': '198.51.100.77',
    }, { method: 'POST', body: JSON.stringify({ username, password }) });
    try {
      for (let index = 0; index < 8; index += 1) assert.equal((await attempt(`user-${index}`, 'wrong')).body, INVALID);
      for (const [username, password] of [['Admin', 'right'], ['Admin', 'wrong'], ['Nobody', 'wrong'], ['', '']]) {
        const started = performance.now();
        const response = await attempt(username, password);
        const elapsed = performance.now() - started;
        assert.deepEqual([response.status, response.body], [429, LIMITED], `${username}/${password}`);
        assert.equal(response.headers['set-cookie'], undefined);
        assert.ok(elapsed >= DELAY - 5, `${username}/${password} took ${Math.round(elapsed)} ms`);
      }
    } finally {
      server.closeAllConnections();
      await close(server);
    }
  });

  it('waits out the delay before answering a limited sign-in', async () => {
    const webAuth = new WebAuth({ authenticateAdministrator: async () => null }, { loginFailureDelayMs: 200, nameDelayMaxMs: 0 });
    for (let index = 0; index < 8; index += 1) await webAuth.login('admin', 'wrong', '203.0.113.9').catch(() => {});
    const started = performance.now();
    await assert.rejects(webAuth.login('admin', 'wrong', '203.0.113.9'), /too_many_login_attempts/);
    assert.ok(performance.now() - started >= 195);
  });

  it('ends a session whose user Jellyfin no longer has, and keeps but refuses one whose check Jellyfin cannot answer', async () => {
    const clock = { now: 0 };
    let answer = 'admin';
    let reads = 0;
    const webAuth = new WebAuth({
      authenticateAdministrator: async () => ({ Id: 'admin-id', Name: 'Admin', Policy: { IsAdministrator: true } }),
      getUser: async (userId) => {
        reads += 1;
        assert.equal(userId, 'admin-id');
        if (answer === 'down') throw new Error('connect ECONNREFUSED');
        if (answer === 'gone') throw new JellyfinError('Jellyfin GET /Users/admin-id returned 404', 404);
        return { Id: 'admin-id', Name: 'Renamed Admin', Policy: { IsAdministrator: true } };
      },
    }, { loginFailureDelayMs: 0, now: () => clock.now });
    const { token } = await webAuth.login('admin', 'right', '203.0.113.1');
    const request = { headers: { cookie: `jellypass_session=${token}` } };

    clock.now += 5 * MINUTE;
    answer = 'down';
    assert.deepEqual(await webAuth.session(request), { status: 'unavailable' });
    assert.deepEqual(await webAuth.session(request), { status: 'unavailable' });
    assert.equal(reads, 1, 'not retried at once');
    clock.now += 30 * 1000;
    answer = 'admin';
    assert.deepEqual(await webAuth.session(request), { status: 'active', username: 'Renamed Admin' });
    assert.equal(reads, 2);

    clock.now += 5 * MINUTE;
    answer = 'gone';
    assert.deepEqual(await webAuth.session(request), { status: 'none' });
    answer = 'admin';
    assert.deepEqual(await webAuth.session(request), { status: 'none' });
  });
});

describe('cross-origin refusal before the session check', { timeout: 20_000 }, () => {
  it('refuses with the fixed 403 before an overdue session is checked: no Jellyfin call, no 503, the session untouched', async () => {
    const clock = { now: 0 };
    let answer = 'down';
    let reads = 0;
    const webAuth = new WebAuth({
      authenticateAdministrator: async () => ({ Id: 'admin-id', Name: 'Admin', Policy: { IsAdministrator: true } }),
      getUser: async () => {
        reads += 1;
        if (answer === 'down') throw new Error('connect ECONNREFUSED');
        return { Id: 'admin-id', Name: 'Admin', Policy: { IsAdministrator: answer === 'admin' } };
      },
    }, { loginFailureDelayMs: 0, now: () => clock.now });
    // The service throws if it is used at all.
    const server = makeServer(stubService(), TOKENS, webAuth);
    const port = await listen(server);
    try {
      const signIn = await send(port, '/auth/login', { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, {
        method: 'POST',
        body: JSON.stringify({ username: 'Admin', password: 'right' }),
      });
      assert.equal(signIn.status, 200);
      const cookie = signIn.headers['set-cookie'][0].split(';')[0];
      clock.now += 6 * MINUTE;

      // Jellyfin unavailable, then the administrator demoted: either way every cross-origin change is the same 403.
      for (const state of ['down', 'demoted']) {
        answer = state;
        for (const [method, pathname, body] of ENDPOINTS) {
          for (const [label, headers] of CROSS_SITE) {
            const response = await send(port, pathname, { cookie, 'content-type': 'application/json', ...headers }, { method, body });
            assert.deepEqual([response.status, response.body], [403, REFUSED], `${state}: ${method} ${pathname} with ${label}`);
            assert.equal(response.headers['set-cookie'], undefined, `${state}: ${method} ${pathname} with ${label}`);
          }
        }
        assert.equal(reads, 0, `${state}: Jellyfin was not asked`);
      }

      // The session was neither checked nor ended: the first same-origin request checks it, once, and it is still there.
      answer = 'admin';
      assert.equal((await send(port, '/auth/session', { cookie })).status, 200);
      assert.equal(reads, 1);
    } finally {
      server.closeAllConnections();
      await close(server);
    }
  });

  it('still answers 401 for a cross-origin change without a session cookie, and checks a same-origin one as before', async () => {
    const clock = { now: 0 };
    let reads = 0;
    const webAuth = new WebAuth({
      authenticateAdministrator: async () => ({ Id: 'admin-id', Name: 'Admin', Policy: { IsAdministrator: true } }),
      getUser: async () => {
        reads += 1;
        throw new Error('connect ECONNREFUSED');
      },
    }, { loginFailureDelayMs: 0, now: () => clock.now });
    const server = makeServer(stubService(), TOKENS, webAuth);
    const port = await listen(server);
    try {
      const anonymous = await send(port, '/v1/library/sync', { 'sec-fetch-site': 'cross-site' }, { method: 'POST' });
      assert.deepEqual([anonymous.status, anonymous.body], [401, '{"error":"unauthorized"}']);
      const signIn = await send(port, '/auth/login', { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, {
        method: 'POST',
        body: JSON.stringify({ username: 'Admin', password: 'right' }),
      });
      const cookie = signIn.headers['set-cookie'][0].split(';')[0];
      clock.now += 6 * MINUTE;
      const sameOrigin = await send(port, '/v1/library/sync', { cookie, 'sec-fetch-site': 'same-origin' }, { method: 'POST' });
      assert.deepEqual([sameOrigin.status, sameOrigin.body], [503, '{"error":"session_check_unavailable"}']);
      assert.equal(reads, 1);
    } finally {
      server.closeAllConnections();
      await close(server);
    }
  });
});

function stubService() {
  return new Proxy({}, { get: () => () => { throw new Error('the service must not be used'); } });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, LOCAL, () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function send(port, pathname, headers, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: LOCAL, port, path: pathname, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

/** Writes a request's head and never its body, then reads the response; fails after two seconds without one. */
function sendHeadersOnly(port, head) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, LOCAL, () => socket.write(head));
    let received = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('no response to the headers alone'));
    }, 2_000);
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      received += chunk;
      const end = received.indexOf('\r\n\r\n');
      if (end === -1) return;
      const length = Number(/\r\ncontent-length: *(\d+)/i.exec(received.slice(0, end))?.[1] ?? 0);
      if (received.length - end - 4 < length) return;
      clearTimeout(timer);
      socket.destroy();
      resolve({ status: Number(received.split(' ')[1]), body: received.slice(end + 4, end + 4 + length) });
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
