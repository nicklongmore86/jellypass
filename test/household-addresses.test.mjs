// Household addresses (the address map and the legacy rule) and JellyPass's two listeners: the member listener serves
// household addresses and nothing else, the admin listener the admin site, its API, metrics, the webhook and health.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AccessService } from '../dist/access-service.js';
import { HouseholdAddresses, HouseholdAddressError, hostKey, normalizeEntry, normalizeOrigin } from '../dist/household-addresses.js';
import { makeServers } from '../dist/server.js';
import { GrantStore } from '../dist/store.js';
import { ADMIN_HOST, ALICE, ANN, BOB, HOST_A, HOST_B, ITEMS, OWN_MOVIE, get, halfOpen, startApp, world } from './support/household-app.mjs';
import { makeTempDir } from './support/temp-dir.mjs';

const ENTRYPOINT = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const WEB = 'MediaBrowser Client="Jellyfin Web", Device="Firefox", DeviceId="jellypass-address-test", Version="10.11.3"';
const NOT_A_MEMBER = '{"error":"unauthorized"}';
const UNKNOWN_HOST = '{"error":"unknown_host"}';
const as = (host, token) => ({ Host: host, Authorization: `${WEB}, Token="${token}"` });
const LEGACY = { domain: 'example.test', prefix: 'jelly-' };
const MEDIA = 'media.example.com';
const FILMS = 'films.example.net:8443';
// Household A ("grove") at an ordinary hostname with an alias on a non-default port; B ("mill") keeps only its legacy one.
const ADDRESSES = { grove: { origin: `https://${MEDIA}`, aliases: [`https://${FILMS}`] } };
const BEARER = { Authorization: 'Bearer admin-secret' };
const relayed = (app) => app.jellyfin.requests.filter((request) => request.pathname !== '/Users/Me' && !/Token="jellyfin-key"|api_key=jellyfin-key/.test(`${request.headers.authorization ?? ''} ${request.path}`));

describe('household address map', () => {
  it('normalises origins: case, default ports, a trailing dot or slash; and refuses anything that is not an origin', () => {
    assert.equal(normalizeOrigin('HTTPS://Media.Example.COM/'), 'https://media.example.com');
    assert.equal(normalizeOrigin('https://media.example.com:443'), 'https://media.example.com');
    assert.equal(normalizeOrigin('https://films.example.net:8443'), 'https://films.example.net:8443');
    assert.equal(normalizeOrigin('http://192.168.1.10:8097'), 'http://192.168.1.10:8097');
    assert.equal(normalizeOrigin('https://media.example.com.'), 'https://media.example.com');
    for (const bad of ['media.example.com', 'ftp://media.example.com', 'https://user:pass@media.example.com', 'https://media.example.com/jellyfin',
      'https://media.example.com/?a=1', 'https://media.example.com/#x', 'https://[2001:db8::1]', 'https://media.example.com:80', 'http://media.example.com:443',
      'https://bad_host.example.com', '', 42]) {
      assert.throws(() => normalizeOrigin(bad), (error) => error instanceof HouseholdAddressError && error.code === 'address_invalid', String(bad));
    }
  });

  it('reads a Host as host[:port], case-folded, the default ports dropped, and nothing else', () => {
    assert.equal(hostKey('Media.Example.com'), MEDIA);
    assert.equal(hostKey('media.example.com:443'), MEDIA);
    assert.equal(hostKey('media.example.com:80'), MEDIA);
    assert.equal(hostKey('media.example.com.'), MEDIA);
    assert.equal(hostKey(FILMS.toUpperCase()), FILMS);
    for (const bad of [undefined, '', 'media.example.com:0', 'media.example.com:65536', 'user@media.example.com', 'media.example.com/x', '[::1]:8443', 'a b']) {
      assert.equal(hostKey(bad), undefined, String(bad));
    }
  });

  it('selects a household by its exact address, alias or legacy one, and nothing else', () => {
    const addresses = new HouseholdAddresses(ADDRESSES, LEGACY);
    assert.deepEqual(addresses.resolve(MEDIA), { householdId: 'grove', origin: `https://${MEDIA}` });
    assert.deepEqual(addresses.resolve('MEDIA.example.com:443'), { householdId: 'grove', origin: `https://${MEDIA}` });
    assert.deepEqual(addresses.resolve(FILMS), { householdId: 'grove', origin: `https://${FILMS}` });
    // The legacy rule still gives every household its generated address.
    assert.deepEqual(addresses.resolve(HOST_A), { householdId: 'grove', origin: `https://${HOST_A}` });
    assert.deepEqual(addresses.resolve(HOST_B), { householdId: 'mill', origin: `https://${HOST_B}` });
    for (const other of ['films.example.net', 'films.example.net:8444', 'media.example.com:8443', 'www.media.example.com', 'example.com', 'jelly-grove.example.test:8443', 'jelly.example.test', '127.0.0.1']) {
      assert.equal(addresses.resolve(other), undefined, other);
    }
    assert.equal(addresses.householdUrl('grove'), `https://${MEDIA}`, 'the mapped origin is canonical');
    assert.equal(addresses.householdUrl('mill'), `https://${HOST_B}`);
    assert.deepEqual(addresses.addresses('grove'), { origin: `https://${MEDIA}`, aliases: [`https://${FILMS}`], legacy: `https://${HOST_A}` });
    // Without the legacy rule only the map selects.
    const mapOnly = new HouseholdAddresses(ADDRESSES);
    assert.equal(mapOnly.resolve(HOST_A), undefined);
    assert.equal(mapOnly.householdUrl('mill'), undefined);
  });

  it('refuses duplicates and conflicts, with each other or with the legacy rule, as a configuration error', () => {
    const conflict = (error) => error instanceof HouseholdAddressError && error.code === 'address_conflict';
    assert.throws(() => normalizeEntry({ origin: `https://${MEDIA}`, aliases: [`https://${MEDIA}:443`] }), conflict);
    assert.throws(() => new HouseholdAddresses({ ...ADDRESSES, mill: { origin: `https://${FILMS}`, aliases: [] } }), conflict);
    assert.throws(() => new HouseholdAddresses({ mill: { origin: `https://${MEDIA}`, aliases: [] }, grove: { origin: 'https://other.example.com', aliases: [`HTTPS://media.example.com`] } }), conflict);
    // Another household's legacy address, or the household's own (it already has it).
    assert.throws(() => new HouseholdAddresses({ grove: { origin: `https://${HOST_B}`, aliases: [] } }, LEGACY), /household mill's legacy address/);
    assert.throws(() => new HouseholdAddresses({ grove: { origin: `https://${MEDIA}`, aliases: [`https://${HOST_A}`] } }, LEGACY), /already household grove's legacy address/);
    // A name under the legacy pattern collides even if no such group exists yet: it would be that group's.
    assert.throws(() => new HouseholdAddresses({ grove: { origin: 'https://jelly-later.example.test', aliases: [] } }, LEGACY), conflict);
    // Not under the pattern (another domain, a non-default port): no conflict.
    assert.ok(new HouseholdAddresses({ grove: { origin: 'https://jelly-mill.example.org', aliases: ['https://jelly-mill.example.test:8443'] } }, LEGACY));
    assert.throws(() => new HouseholdAddresses({ grove: { origin: 'https://media.example.com/path', aliases: [] } }), (error) => error.code === 'address_invalid');
  });

  it('stops startup on a stored map that conflicts with the legacy rule', async (t) => {
    const file = path.join(await makeTempDir(t, 'jfa-addresses-'), 'grants.json');
    const store = new GrantStore(file);
    await store.load();
    await store.upsertGroup({ id: 'grove', name: 'Grove', userIds: [] });
    await store.upsertGroup({ id: 'mill', name: 'Mill', userIds: [] });
    await store.setHouseholdAddresses('grove', { origin: `https://${HOST_B}`, aliases: [] });
    const service = new AccessService({}, store);
    const tokens = { webhook: 'w', admin: 'a' };
    assert.throws(() => makeServers(service, tokens, undefined, { householdGateway: { jellyfinUrl: 'http://127.0.0.1:9', ...LEGACY_OPTIONS } }), /household mill's legacy address/);
    // Without the legacy rule the same map is consistent.
    assert.ok(makeServers(service, tokens, undefined, { householdGateway: { jellyfinUrl: 'http://127.0.0.1:9' } }).member);
  });

  it('migrates a 3.9.0 (version 7) state file: every record kept, no map, and the legacy addresses still serve', async (t) => {
    const stateFile = {
      version: 7, grants: {}, catalog: { items: {} }, passwordlessUserIds: [ALICE], handledRequestIds: ['5'],
      groups: {
        grove: { id: 'grove', name: 'Grove', userIds: [ALICE, ANN], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
        mill: { id: 'mill', name: 'Mill', userIds: [BOB], createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' },
      },
      appIdKey: 'ab'.repeat(32),
    };
    const app = await startApp(t, world(), { stateFile, households: [] });
    const migrated = JSON.parse(await readFile(app.stateFile, 'utf8'));
    assert.equal(migrated.version, 8);
    assert.deepEqual({ ...migrated, version: 7 }, stateFile, 'nothing but the version changed');
    const users = await get(app.port, '/Users/Public', { Host: HOST_A });
    assert.deepEqual(users.json().map((user) => user.Name), ['Alice', 'Ann']);
    const groups = (await get(app.adminPort, '/v1/groups', { Host: ADMIN_HOST, ...BEARER })).json().groups;
    assert.deepEqual(groups.map((group) => [group.id, group.householdUrl, group.householdAddresses]), [
      ['grove', `https://${HOST_A}`, [`https://${HOST_A}`]],
      ['mill', `https://${HOST_B}`, [`https://${HOST_B}`]],
    ]);
  });

  it('refuses a state file whose address map is not an object', async (t) => {
    const file = path.join(await makeTempDir(t, 'jfa-addresses-'), 'grants.json');
    await writeFile(file, JSON.stringify({ version: 8, grants: {}, groups: {}, catalog: { items: {} }, passwordlessUserIds: [], householdAddresses: [] }));
    await assert.rejects(new GrantStore(file).load(), /invalid householdAddresses/);
  });
});

const LEGACY_OPTIONS = { domain: 'example.test', hostPrefix: 'jelly-' };

describe('member listener', () => {
  it('serves a household on an arbitrary hostname, an alias on another port, and its legacy address alike', async (t) => {
    const app = await startApp(t, world(), { addresses: ADDRESSES });
    for (const host of [MEDIA, 'Media.Example.com:443', FILMS, HOST_A]) {
      const users = await get(app.port, '/Users/Public', { Host: host });
      assert.equal(users.status, 200, host);
      assert.deepEqual(users.json().map((user) => user.Name), ['Alice', 'Ann'], host);
    }
    assert.deepEqual((await get(app.port, '/Users/Public', { Host: HOST_B })).json().map((user) => user.Name), ['Bob']);
  });

  it('answers a cross-household token on a mapped host as it does an unknown one (401), and a member\'s as usual', async (t) => {
    const app = await startApp(t, world(), { addresses: ADDRESSES });
    for (const host of [MEDIA, FILMS]) {
      for (const token of ['token-bob', 'token-outsider', 'no-such-token']) {
        const answer = await get(app.port, '/System/Info', as(host, token));
        assert.deepEqual([answer.status, answer.text], [401, NOT_A_MEMBER], `${host} ${token}`);
      }
      assert.notEqual((await get(app.port, '/System/Info', as(host, 'token-alice'))).text, NOT_A_MEMBER, host);
    }
    // Bob's token works on his own household's address only.
    assert.notEqual((await get(app.port, '/System/Info', as(HOST_B, 'token-bob'))).text, NOT_A_MEMBER);
  });

  it('keeps the household app\'s Play links on the address the request came in on', async (t) => {
    const app = await startApp(t, world(), { addresses: ADDRESSES });
    for (const host of [MEDIA, FILMS, HOST_A]) {
      const movie = await app.get(`/jellypass/app/v1/movie/${OWN_MOVIE}`, { host });
      assert.equal(movie.status, 200, host);
      assert.deepEqual(movie.json().play, { itemId: ITEMS.ownMovie, url: `https://${host}/web/#/details?id=${ITEMS.ownMovie}` }, host);
    }
  });

  it('relays a member\'s WebSocket on a mapped host and refuses another household\'s token there', async (t) => {
    const app = await startApp(t, world(), { addresses: ADDRESSES });
    for (const host of [MEDIA, FILMS]) {
      assert.match(await upgrade(app.port, '/socket?api_key=token-bob&deviceId=x', host), /^HTTP\/1\.1 401 /, host);
    }
    assert.deepEqual(relayed(app), []);
    await upgrade(app.port, '/socket?api_key=token-alice&deviceId=x', MEDIA);
    await upgrade(app.port, '/socket?api_key=token-alice&deviceId=x', FILMS);
    assert.deepEqual(relayed(app).map((request) => request.pathname), ['/socket', '/socket']);
  });

  it('gives an unknown Host a fixed 421 on every path, never the admin site, the API, metrics, the webhook or health', async (t) => {
    const app = await startApp(t, world(), { addresses: ADDRESSES });
    const paths = [['GET', '/'], ['GET', '/admin/'], ['GET', '/admin/app.js'], ['GET', '/health'], ['GET', '/metrics'], ['GET', '/v1/groups'],
      ['GET', '/v1/groups/grove/addresses'], ['POST', '/auth/login'], ['POST', '/webhooks/seerr'], ['GET', '/Users/Public'], ['GET', '/web/'],
      ['GET', '/jellypass/app/'], ['DELETE', '/v1/groups/grove']];
    for (const host of [ADMIN_HOST, '127.0.0.1', `127.0.0.1:${app.port}`, 'films.example.net', 'media.example.com:8443', 'jelly.example.test', 'jelly-grove.example.test.evil.test']) {
      for (const [method, pathname] of paths) {
        const answer = await get(app.port, pathname, { Host: host, ...BEARER, 'Content-Type': 'application/json' }, { method, body: method === 'GET' ? undefined : '{}' });
        assert.deepEqual([answer.status, answer.text], [421, UNKNOWN_HOST], `${host} ${method} ${pathname}`);
        assert.equal(answer.headers['cache-control'], 'no-store');
      }
      // A WebSocket upgrade is dropped.
      assert.equal(await upgrade(app.port, '/socket?api_key=token-alice', host), '', host);
    }
    // X-Forwarded-Host never selects a household (or the admin site).
    const forwarded = await get(app.port, '/Users/Public', { Host: 'unknown.example.com', 'X-Forwarded-Host': MEDIA });
    assert.deepEqual([forwarded.status, forwarded.text], [421, UNKNOWN_HOST]);
    const spoofed = await get(app.port, '/Users/Public', { Host: HOST_B, 'X-Forwarded-Host': MEDIA });
    assert.deepEqual(spoofed.json().map((user) => user.Name), ['Bob'], 'Host decides, not X-Forwarded-Host');
  });

  it('answers the Seerr webhook on the member listener only with LEGACY_WEBHOOK_ON_MEMBER_PORT, and never on a household host', async (t) => {
    const test = { notificationType: 'TEST_NOTIFICATION', subject: 'Test Notification' };
    const send = (port, host, token = 'webhook-secret') => get(port, '/webhooks/seerr', { Host: host, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, { method: 'POST', body: JSON.stringify(test) });
    const off = await startApp(t, world(), { addresses: ADDRESSES });
    assert.deepEqual([(await send(off.adminPort, 'jellypass:8788')).status, (await send(off.adminPort, 'jellypass:8788')).text], [202, '{"status":"ignored"}']);
    assert.equal((await send(off.adminPort, 'jellypass:8788', 'wrong')).status, 401);
    assert.equal((await send(off.port, 'jellypass:8787')).status, 421);

    const on = await startApp(t, world(), { addresses: ADDRESSES, memberWebhook: true });
    assert.deepEqual([(await send(on.port, 'jellypass:8787')).status, (await send(on.port, '10.0.0.5:8787')).text], [202, '{"status":"ignored"}']);
    assert.deepEqual([(await send(on.port, 'jellypass:8787', 'wrong')).status], [401]);
    // Only POST /webhooks/seerr: everything else on such a Host is still the fixed 421.
    assert.equal((await get(on.port, '/v1/groups', { Host: 'jellypass:8787', ...BEARER })).status, 421);
    assert.equal((await get(on.port, '/health', { Host: 'jellypass:8787' })).status, 421);
    // A household host is the household's: the path goes to the gateway (and so to Jellyfin), never to the webhook.
    for (const host of [MEDIA, HOST_A]) {
      const answer = await send(on.port, host);
      assert.notEqual(answer.text, '{"status":"ignored"}', host);
    }
  });
});

describe('one Host per request', () => {
  const INVALID_HOST = '{"error":"invalid_host"}';
  const users = (answer) => JSON.parse(answer.body).map((user) => user.Name);
  // Each of these is refused with the fixed 400 on either listener, whatever the path; none is relayed.
  const malformed = (host) => [
    ['two Host headers, the household first', [`Host: ${MEDIA}`, `Host: ${HOST_B}`]],
    ['two Host headers, the household last', [`Host: ${HOST_B}`, `Host: ${MEDIA}`]],
    ['an unknown Host, then a household', ['Host: unknown.example.com', `Host: ${HOST_B}`]],
    ['the same Host twice', [`Host: ${host}`, `Host: ${host}`]],
    ['the same Host twice, spelled differently', [`host: ${host}`, `HOST: ${host.toUpperCase()}`]],
    ['no Host', []],
    ['an empty Host', ['Host: ']],
    ['userinfo', [`Host: user@${host}`]],
    ['whitespace inside', [`Host: ${host} x`]],
    ['a path', [`Host: ${host}/x`]],
    ['other characters', [`Host: <${host}`]],
    ['a percent-encoding', [`Host: ${host}%2f`]],
  ];

  it('refuses a request with other than exactly one valid Host on the member listener, for HTTP and WebSocket alike', async (t) => {
    const app = await startApp(t, world(), { addresses: ADDRESSES });
    for (const [what, hosts] of malformed(MEDIA)) {
      const answer = await raw(app.port, 'GET /Users/Public HTTP/1.1', hosts);
      // A missing Host too: JellyPass's fixed answer, not Node's own bare 400.
      assert.deepEqual([answer.status, answer.body, answer.headers['cache-control'], answer.headers.connection], [400, INVALID_HOST, 'no-store', 'close'], what);
      assert.match(await upgrade(app.port, '/socket?api_key=token-alice', hosts), /^HTTP\/1\.1 400 [^]*\r\nCache-Control: no-store\r\n[^]*\r\nConnection: close\r\n\r\n\{"error":"invalid_host"\}$/, what);
    }
    assert.deepEqual(relayed(app), [], 'nothing reached Jellyfin');
    // One Host still selects its household, in either listener's casing of the header name.
    assert.deepEqual(users(await raw(app.port, 'GET /Users/Public HTTP/1.1', [`host: ${HOST_B}`])), ['Bob']);
    assert.deepEqual(users(await raw(app.port, 'GET /Users/Public HTTP/1.1', [`Host: ${MEDIA}`])), ['Alice', 'Ann']);
    // HTTP/1.0 may leave Host out: then no household is named, so it is the fixed 421.
    assert.deepEqual(await raw(app.port, 'GET /Users/Public HTTP/1.0', []).then((answer) => [answer.status, answer.body]), [421, UNKNOWN_HOST]);
  });

  it('refuses an absolute-form target whose authority is not the Host', async (t) => {
    const app = await startApp(t, world(), { addresses: ADDRESSES });
    for (const target of [`http://${HOST_B}/Users/Public`, `https://${HOST_B}/Users/Public`, `http://${MEDIA}:8443/Users/Public`, `http://user@${MEDIA}/Users/Public`, 'http:///Users/Public']) {
      const answer = await raw(app.port, `GET ${target} HTTP/1.1`, [`Host: ${MEDIA}`]);
      assert.deepEqual([answer.status, answer.body], [400, INVALID_HOST], target);
    }
    // One that agrees passes the Host check and is the gateway's to answer, which relays origin-form targets only.
    const agreeing = await raw(app.port, `GET http://${MEDIA.toUpperCase()}/Users/Public HTTP/1.1`, [`Host: ${MEDIA}`]);
    assert.equal(agreeing.status, 400);
    assert.notEqual(agreeing.body, INVALID_HOST);
    assert.deepEqual(relayed(app), [], 'nothing reached Jellyfin');
  });

  it('refuses the same on the admin listener, before the admin token or session is looked at', async (t) => {
    const app = await startApp(t, world(), { addresses: ADDRESSES });
    const admin = 'jellypass:8788';
    for (const [what, hosts] of malformed(admin)) {
      const answer = await raw(app.adminPort, 'GET /v1/groups HTTP/1.1', [...hosts, 'Authorization: Bearer admin-secret']);
      assert.deepEqual([answer.status, answer.body, answer.headers['cache-control'], answer.headers.connection], [400, INVALID_HOST, 'no-store', 'close'], what);
      assert.match(await upgrade(app.adminPort, '/socket', hosts), /^HTTP\/1\.1 400 [^]*\r\nCache-Control: no-store\r\n[^]*\r\nConnection: close\r\n\r\n\{"error":"invalid_host"\}$/, what);
    }
    const absolute = await raw(app.adminPort, `GET http://other.example.com/v1/groups HTTP/1.1`, [`Host: ${admin}`, 'Authorization: Bearer admin-secret']);
    assert.deepEqual([absolute.status, absolute.body], [400, INVALID_HOST]);
    assert.equal((await raw(app.adminPort, `GET http://${admin}/v1/groups HTTP/1.1`, [`Host: ${admin}`, 'Authorization: Bearer admin-secret'])).status, 200);
    assert.equal((await raw(app.adminPort, 'GET /v1/groups HTTP/1.1', [`Host: ${admin}`, 'Authorization: Bearer admin-secret'])).status, 200);
    // A WebSocket upgrade with one Host is still dropped.
    assert.equal(await upgrade(app.adminPort, '/socket', admin), '');
  });

  it('answers HTTP/1.1 with no Host on /health with the whole fixed answer on either listener', async (t) => {
    const app = await startApp(t, world(), { addresses: ADDRESSES });
    for (const port of [app.port, app.adminPort]) {
      const answer = await raw(port, 'GET /health HTTP/1.1', []);
      assert.deepEqual([answer.status, answer.body], [400, INVALID_HOST]);
      assert.equal(answer.headers['cache-control'], 'no-store');
      assert.equal(answer.headers.connection, 'close');
      assert.match(answer.headers['content-type'] ?? '', /^application\/json/);
    }
  });

  it('closes its own end of a refused connection on either listener even when the client keeps its end open', async (t) => {
    const app = await startApp(t, world(), { addresses: ADDRESSES });
    const websocket = 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n';
    for (const [listener, server] of [['member', app.server], ['admin', app.adminServer]]) {
      for (const [what, request, expected] of [
        ['an upgrade with two Hosts', `GET /socket?api_key=token-alice HTTP/1.1\r\nHost: ${MEDIA}\r\nHost: ${HOST_B}\r\n${websocket}\r\n`, /^HTTP\/1\.1 400 [^]*\{"error":"invalid_host"\}$/],
        ['an upgrade with no Host', `GET /socket?api_key=token-alice HTTP/1.1\r\n${websocket}\r\n`, /^HTTP\/1\.1 400 [^]*\{"error":"invalid_host"\}$/],
        ['an upgrade on an unknown Host', `GET /socket?api_key=token-alice HTTP/1.1\r\nHost: unknown.example.com\r\n${websocket}\r\n`, /^$/],
        ['a request with two Hosts', `GET /Users/Public HTTP/1.1\r\nHost: ${MEDIA}\r\nHost: ${HOST_B}\r\n\r\n`, /^HTTP\/1\.1 400 [^]*\{"error":"invalid_host"\}$/],
        ['a request with no Host', 'GET /health HTTP/1.1\r\n\r\n', /^HTTP\/1\.1 400 [^]*\{"error":"invalid_host"\}$/],
        ...(listener === 'member' ? [['an unknown Host, Connection: close', 'GET /health HTTP/1.1\r\nHost: unknown.example.com\r\nConnection: close\r\n\r\n', /^HTTP\/1\.1 421 [^]*\{"error":"unknown_host"\}$/]] : []),
      ]) {
        const { answer, closed } = await halfOpen(server, request);
        assert.match(answer, expected, `${listener}: ${what}`);
        assert.ok(closed, `${listener}: ${what}: the server socket is closed within a second`);
      }
    }
    assert.deepEqual(relayed(app), [], 'nothing reached Jellyfin');
  });

  it('refuses two Hosts on the legacy member-port webhook too, and answers 421 for an unknown Host before parsing the target', async (t) => {
    const test = JSON.stringify({ notificationType: 'TEST_NOTIFICATION', subject: 'Test Notification' });
    const webhook = (port, target, hosts) => raw(port, `POST ${target} HTTP/1.1`, [...hosts, 'Authorization: Bearer webhook-secret', 'Content-Type: application/json'], test);
    const on = await startApp(t, world(), { addresses: ADDRESSES, memberWebhook: true });
    for (const hosts of [['Host: jellypass:8787', `Host: ${MEDIA}`], [`Host: ${MEDIA}`, 'Host: jellypass:8787'], ['Host: jellypass:8787', 'Host: jellypass:8787']]) {
      const answer = await webhook(on.port, '/webhooks/seerr', hosts);
      assert.deepEqual([answer.status, answer.body], [400, INVALID_HOST], hosts.join(', '));
    }
    assert.equal((await webhook(on.port, 'http://other.example.com/webhooks/seerr', ['Host: jellypass:8787'])).status, 400);
    assert.deepEqual(await webhook(on.port, '/webhooks/seerr', ['Host: jellypass:8787']).then((answer) => [answer.status, answer.body]), [202, '{"status":"ignored"}']);
    // A target that is no URL: with the legacy webhook on, a POST's is parsed, and that is a fixed 400; anything else is the 421.
    assert.deepEqual(await webhook(on.port, '//[bad', ['Host: jellypass:8787']).then((answer) => [answer.status, answer.body]), [400, '{"error":"invalid_request_target"}']);
    assert.deepEqual(await raw(on.port, 'GET //[bad HTTP/1.1', ['Host: jellypass:8787']).then((answer) => [answer.status, answer.body]), [421, UNKNOWN_HOST]);
    const off = await startApp(t, world(), { addresses: ADDRESSES });
    for (const request of ['GET //[bad HTTP/1.1', 'POST //[bad HTTP/1.1']) {
      assert.deepEqual(await raw(off.port, request, ['Host: unknown.example.com']).then((answer) => [answer.status, answer.body]), [421, UNKNOWN_HOST], request);
    }
  });
});

describe('admin listener', () => {
  it('serves the admin site, API, metrics and health for any Host, and never a household or WebSocket', async (t) => {
    const app = await startApp(t, world(), { addresses: ADDRESSES });
    for (const host of [ADMIN_HOST, `127.0.0.1:${app.adminPort}`, MEDIA, HOST_A]) {
      assert.equal((await get(app.adminPort, '/admin/', { Host: host })).status, 200, host);
      assert.deepEqual([(await get(app.adminPort, '/health', { Host: host })).status], [200], host);
      assert.equal((await get(app.adminPort, '/v1/groups', { Host: host, ...BEARER })).status, 200, host);
      assert.equal((await get(app.adminPort, '/metrics', { Host: host, ...BEARER })).status, 200, host);
      // Household paths are not proxied: they are admin API paths, so without credentials 401, with them 404.
      assert.equal((await get(app.adminPort, '/Users/Public', { Host: host })).status, 401, host);
      assert.equal((await get(app.adminPort, '/jellypass/app/v1/home', { Host: host, ...BEARER })).status, 404, host);
      assert.equal(await upgrade(app.adminPort, '/socket?api_key=token-alice', host), '', host);
    }
    assert.deepEqual(relayed(app), []);
  });

  it('reads, writes and removes a household\'s addresses, which take effect at once, and refuses conflicts', async (t) => {
    const app = await startApp(t, world());
    const admin = (method, pathname, body, headers = {}) => get(app.adminPort, pathname, { Host: ADMIN_HOST, ...BEARER, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, { method, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    assert.deepEqual((await admin('GET', '/v1/groups/grove/addresses')).json(), { groupId: 'grove', gateway: true, aliases: [], legacy: `https://${HOST_A}`, householdUrl: `https://${HOST_A}` });
    assert.equal((await get(app.port, '/Users/Public', { Host: MEDIA })).status, 421);

    const saved = await admin('PUT', '/v1/groups/Grove/addresses', { origin: 'HTTPS://Media.Example.com/', aliases: ['https://films.example.net:8443'] });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.json(), { status: 'saved', groupId: 'grove', gateway: true, origin: `https://${MEDIA}`, aliases: [`https://${FILMS}`], legacy: `https://${HOST_A}`, householdUrl: `https://${MEDIA}` });
    assert.deepEqual((await get(app.port, '/Users/Public', { Host: MEDIA })).json().map((user) => user.Name), ['Alice', 'Ann']);
    assert.deepEqual(JSON.parse(await readFile(app.stateFile, 'utf8')).householdAddresses, { grove: { origin: `https://${MEDIA}`, aliases: [`https://${FILMS}`] } });
    const groups = (await admin('GET', '/v1/groups')).json().groups;
    assert.deepEqual(groups.find((group) => group.id === 'grove').householdAddresses, [`https://${MEDIA}`, `https://${FILMS}`, `https://${HOST_A}`]);
    assert.equal(groups.find((group) => group.id === 'grove').householdUrl, `https://${MEDIA}`);

    // Conflicts (409), invalid addresses and bodies (400), an unknown group (404), a body not declared as JSON (415).
    for (const [body, status, code] of [
      [{ origin: `https://${MEDIA}`, aliases: [] }, 409, 'address_conflict'],
      [{ origin: 'https://other.example.com', aliases: [`https://${FILMS}`] }, 409, 'address_conflict'],
      [{ origin: `https://${HOST_A}`, aliases: [] }, 409, 'address_conflict'],
      [{ origin: 'https://other.example.com/jellyfin' }, 400, 'address_invalid'],
      [{ origin: 'https://other.example.com', aliases: 'https://x.example.com' }, 400, 'address_invalid'],
    ]) {
      const refused = await admin('PUT', '/v1/groups/mill/addresses', body);
      assert.deepEqual([refused.status, refused.json().code], [status, code], JSON.stringify(body));
    }
    assert.equal((await admin('PUT', '/v1/groups/mill/addresses', { origin: 'https://other.example.com', extra: true })).status, 400);
    assert.equal((await admin('PUT', '/v1/groups/nobody/addresses', { origin: 'https://other.example.com' })).status, 404);
    assert.equal((await admin('GET', '/v1/groups/nobody/addresses')).status, 404);
    assert.equal((await admin('PUT', '/v1/groups/mill/addresses', JSON.stringify({ origin: 'https://other.example.com' }), { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await get(app.adminPort, '/v1/groups/mill/addresses', { Host: ADMIN_HOST, 'Content-Type': 'application/json' }, { method: 'PUT', body: '{"origin":"https://other.example.com"}' })).status, 401);
    assert.equal((await get(app.port, '/Users/Public', { Host: 'other.example.com' })).status, 421, 'nothing refused was stored');

    // Two writes at once never both pass the check.
    const raced = await Promise.all([
      admin('PUT', '/v1/groups/mill/addresses', { origin: 'https://shared.example.com' }),
      admin('PUT', '/v1/groups/grove/addresses', { origin: 'https://shared.example.com' }),
    ]);
    assert.deepEqual(raced.map((answer) => answer.status).sort(), [200, 409]);

    const removed = await admin('DELETE', '/v1/groups/grove/addresses');
    assert.equal(removed.status, 200);
    assert.equal(removed.json().householdUrl, `https://${HOST_A}`, 'the legacy address remains');
    assert.equal((await get(app.port, '/Users/Public', { Host: FILMS })).status, 421);
  });

  it('drops a household\'s addresses with its group, so a group made later under the same ID starts without them', async (t) => {
    const app = await startApp(t, world(), { addresses: ADDRESSES });
    assert.equal((await get(app.adminPort, '/v1/groups/grove', { Host: ADMIN_HOST, ...BEARER }, { method: 'DELETE' })).status, 200);
    assert.equal(JSON.parse(await readFile(app.stateFile, 'utf8')).householdAddresses, undefined);
    assert.equal((await get(app.port, '/Users/Public', { Host: MEDIA })).status, 421);
  });
});

describe('startup', () => {
  it('refuses to start the household gateway without TRUSTED_PROXIES, naming it', async (t) => {
    const directory = await makeTempDir(t, 'jfa-addresses-start-');
    const base = { WEBHOOK_TOKEN: 'w', ADMIN_TOKEN: 'a', JELLYFIN_URL: 'http://127.0.0.1:9', JELLYFIN_API_KEY: 'k', STATE_FILE: path.join(directory, 'grants.json'), HOST: '127.0.0.1', ADMIN_HOST: '127.0.0.1', PORT: '18087', ADMIN_PORT: '18088' };
    for (const env of [{ HOUSEHOLD_DOMAIN: 'example.test' }, { HOUSEHOLD_GATEWAY_ENABLED: 'true' }]) {
      const { code, output } = await run({ ...base, ...env });
      assert.equal(code, 1, output);
      assert.match(output, /TRUSTED_PROXIES is required when the household gateway is on/);
      assert.doesNotMatch(output, /server started/);
    }
  });
});

function run(env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ENTRYPOINT], { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('close', (code) => resolve({ code, output }));
  });
}

/** The status line and headers of a WebSocket upgrade's answer, or '' if the connection was closed without one. */
/** A WebSocket upgrade's answer, up to its end of headers (or the whole of it, if the socket closes first); `host` may be the Host lines. */
function upgrade(port, pathname, host) {
  const hosts = Array.isArray(host) ? host.map((line) => `${line}\r\n`).join('') : `Host: ${host}\r\n`;
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let answer = '';
    socket.once('connect', () => socket.write(`GET ${pathname} HTTP/1.1\r\n${hosts}Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    socket.on('data', (chunk) => {
      answer += chunk.toString('utf8');
      const [head, body = ''] = answer.split('\r\n\r\n');
      const length = /\r\ncontent-length: (\d+)/i.exec(head)?.[1];
      if (answer.includes('\r\n\r\n') && Buffer.byteLength(body) >= Number(length ?? 0)) {
        socket.destroy();
        resolve(answer);
      }
    });
    socket.once('close', () => resolve(answer));
    socket.once('error', (error) => (error.code === 'ECONNRESET' ? resolve(answer) : reject(error)));
  });
}

/** One request written as it is (each of `headers` a line), and its answer read to the end of the connection. */
function raw(port, requestLine, headers, body = '') {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    const lines = [requestLine, ...headers, 'Connection: close', ...(body ? [`Content-Length: ${Buffer.byteLength(body)}`] : [])];
    const chunks = [];
    socket.once('connect', () => socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`));
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('error', reject);
    socket.once('close', () => {
      const answer = Buffer.concat(chunks).toString('utf8');
      const end = answer.indexOf('\r\n\r\n');
      const head = answer.slice(0, end).split('\r\n');
      const headers = Object.fromEntries(head.slice(1).map((line) => [line.slice(0, line.indexOf(':')).toLowerCase(), line.slice(line.indexOf(':') + 1).trim()]));
      let rest = answer.slice(end + 4);
      if (/chunked/i.test(headers['transfer-encoding'] ?? '')) {
        let decoded = '';
        for (let size = parseInt(rest, 16); size > 0; size = parseInt(rest, 16)) {
          const start = rest.indexOf('\r\n') + 2;
          decoded += rest.slice(start, start + size);
          rest = rest.slice(start + size + 2);
        }
        rest = decoded;
      }
      resolve({ status: Number(head[0]?.split(' ')[1]), headers, body: rest });
    });
  });
}
