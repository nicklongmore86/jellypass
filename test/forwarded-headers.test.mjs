import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect as connectSocket } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { WebAuth } from '../dist/auth.js';
import { makeServer } from '../dist/server.js';

const HOUSEHOLD_HOST = 'jelly-grove.example.test';
const LOCAL = '127.0.0.1';
/** The client metadata Jellyfin requires of a sign-in; without it the gateway refuses one before Jellyfin sees it. */
const CLIENT = 'MediaBrowser Client="JellyPass Test", Device="Test", DeviceId="jellypass-forwarded-test", Version="1.0.0"';

describe('forwarded client addresses', { timeout: 10_000 }, () => {
  let upstream;
  const seen = [];
  const servers = [];

  before(async () => {
    // A Jellyfin stand-in that records the headers of every request and upgrade it receives.
    upstream = createServer((request, response) => {
      seen.push({ url: request.url, headers: request.headers });
      request.resume();
      const body = request.url === '/Users/Public'
        ? [{ Id: 'alice-id', Name: 'Alice', HasPassword: true }]
        : request.url === '/Users/AuthenticateByName' ? { error: 'invalid' } : { ok: true };
      response.writeHead(request.url === '/Users/AuthenticateByName' ? 401 : 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(body));
    });
    upstream.on('upgrade', (request, socket) => {
      seen.push({ url: request.url, headers: request.headers, upgrade: true });
      socket.on('error', () => {});
      socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    await listen(upstream);
  });

  after(async () => {
    for (const server of [...servers, upstream]) {
      server.closeAllConnections();
      await close(server);
    }
  });

  async function startGateway(trustedProxies, webAuth) {
    const server = makeServer(stubService(), { webhook: 'w', admin: 'a' }, webAuth, {
      ...(trustedProxies ? { trustedProxies } : {}),
      householdGateway: {
        jellyfinUrl: `http://${LOCAL}:${upstream.address().port}`,
        domain: 'example.test',
        hostPrefix: 'jelly-',
        loginFailureDelayMs: 0,
      },
    });
    servers.push(server);
    await listen(server);
    return server.address().port;
  }

  async function upstreamHeaders(port, path, headers, options = {}) {
    const before = seen.length;
    await send(port, path, { host: HOUSEHOLD_HOST, ...headers }, options);
    const entry = seen.slice(before).find((candidate) => candidate.url === path);
    assert.ok(entry, `upstream never received ${path}`);
    return entry.headers;
  }

  it('appends the gateway peer to X-Forwarded-For on proxied HTTP requests', async () => {
    const port = await startGateway();
    const forwarded = await upstreamHeaders(port, '/System/Info', { 'x-forwarded-for': '203.0.113.5, 198.51.100.7' });
    assert.equal(forwarded['x-forwarded-for'], `203.0.113.5, 198.51.100.7, ${LOCAL}`);
    assert.equal(forwarded['x-forwarded-proto'], 'http');
    assert.equal(forwarded['x-forwarded-host'], HOUSEHOLD_HOST);

    const direct = await upstreamHeaders(port, '/System/Info', {});
    assert.equal(direct['x-forwarded-for'], LOCAL);
    assert.equal(direct['x-real-ip'], LOCAL);
  });

  it('appends to X-Forwarded-For on transformed and buffered login requests', async () => {
    const port = await startGateway();
    const publicUsers = await upstreamHeaders(port, '/Users/Public', { 'x-forwarded-for': '203.0.113.5' });
    assert.equal(publicUsers['x-forwarded-for'], `203.0.113.5, ${LOCAL}`);

    const login = await upstreamHeaders(port, '/Users/AuthenticateByName', {
      'x-forwarded-for': '203.0.113.5',
      'content-type': 'application/json',
      authorization: CLIENT,
    }, { method: 'POST', body: JSON.stringify({ Username: 'Alice', Pw: 'wrong' }) });
    assert.equal(login['x-forwarded-for'], `203.0.113.5, ${LOCAL}`);
  });

  it('keeps an existing X-Forwarded-Proto and X-Real-IP and fills X-Real-IP from the resolved client', async () => {
    const untrusted = await startGateway();
    const kept = await upstreamHeaders(untrusted, '/System/Info', {
      'x-forwarded-for': '203.0.113.5',
      'x-forwarded-proto': 'https',
      'x-real-ip': '203.0.113.5',
    });
    assert.equal(kept['x-forwarded-proto'], 'https');
    assert.equal(kept['x-real-ip'], '203.0.113.5');

    // An untrusted peer cannot choose its X-Real-IP through X-Forwarded-For.
    assert.equal((await upstreamHeaders(untrusted, '/System/Info', { 'x-forwarded-for': '203.0.113.5' }))['x-real-ip'], LOCAL);

    const trusted = await startGateway([LOCAL]);
    assert.equal((await upstreamHeaders(trusted, '/System/Info', { 'x-forwarded-for': '203.0.113.5' }))['x-real-ip'], '203.0.113.5');
  });

  it('appends the gateway peer to X-Forwarded-For on WebSocket upgrades', async () => {
    const port = await startGateway([LOCAL]);
    const before = seen.length;
    const client = connectSocket(port, LOCAL);
    client.on('error', () => {});
    await once(client, 'connect');
    client.write([
      'GET /socket HTTP/1.1',
      `Host: ${HOUSEHOLD_HOST}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Key: dGVzdA==',
      'Sec-WebSocket-Version: 13',
      'X-Forwarded-For: 203.0.113.5',
      'X-Forwarded-Proto: https',
      '', '',
    ].join('\r\n'));
    let response = '';
    while (!response.includes('\r\n\r\n')) response += (await once(client, 'data'))[0].toString('utf8');
    client.destroy();
    assert.match(response, /^HTTP\/1\.1 101/);
    const upgrade = seen.slice(before).find((entry) => entry.upgrade);
    assert.ok(upgrade);
    assert.equal(upgrade.headers['x-forwarded-for'], `203.0.113.5, ${LOCAL}`);
    assert.equal(upgrade.headers['x-forwarded-proto'], 'https');
    assert.equal(upgrade.headers['x-real-ip'], '203.0.113.5');
  });

  it('rate-limits household logins per client behind a trusted proxy', async () => {
    const port = await startGateway([LOCAL]);
    const attempt = (client) => send(port, '/Users/AuthenticateByName', {
      host: HOUSEHOLD_HOST,
      'x-forwarded-for': client,
      'content-type': 'application/json',
      authorization: CLIENT,
    }, { method: 'POST', body: JSON.stringify({ Username: 'Alice', Pw: 'wrong' }) });
    for (let index = 0; index < 20; index += 1) assert.equal((await attempt('203.0.113.5')).status, 401);
    assert.equal((await attempt('203.0.113.5')).status, 429);
    assert.equal((await attempt('203.0.113.6')).status, 401);
  });

  it('shares one household login bucket across spellings of the same IPv6 client', async () => {
    const port = await startGateway([LOCAL]);
    const attempt = (client) => send(port, '/Users/AuthenticateByName', {
      host: HOUSEHOLD_HOST,
      'x-forwarded-for': client,
      'content-type': 'application/json',
      authorization: CLIENT,
    }, { method: 'POST', body: JSON.stringify({ Username: 'Alice', Pw: 'wrong' }) });
    for (let index = 0; index < 10; index += 1) assert.equal((await attempt('2001:DB8::5')).status, 401);
    for (let index = 0; index < 10; index += 1) assert.equal((await attempt('2001:db8:0:0:0:0:0:5')).status, 401);
    assert.equal((await attempt('[2001:db8::5]:4711')).status, 429);
  });

  it('keeps one household login bucket per peer when no proxy is trusted', async () => {
    const port = await startGateway();
    const attempt = (client) => send(port, '/Users/AuthenticateByName', {
      host: HOUSEHOLD_HOST,
      'x-forwarded-for': client,
      'content-type': 'application/json',
      authorization: CLIENT,
    }, { method: 'POST', body: JSON.stringify({ Username: 'Alice', Pw: 'wrong' }) });
    for (let index = 0; index < 20; index += 1) assert.equal((await attempt('203.0.113.5')).status, 401);
    assert.equal((await attempt('203.0.113.6')).status, 429);
  });

  it('rate-limits administrator logins per client behind a trusted proxy', async () => {
    const webAuth = new WebAuth({ authenticateAdministrator: async () => null }, { loginFailureDelayMs: 0, nameDelayMaxMs: 0 });
    const port = await startGateway([LOCAL], webAuth);
    const attempt = (client) => send(port, '/auth/login', {
      host: `${LOCAL}:${port}`,
      origin: `http://${LOCAL}:${port}`,
      'x-forwarded-for': client,
      'content-type': 'application/json',
    }, { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'wrong' }) });
    for (let index = 0; index < 8; index += 1) assert.equal((await attempt('203.0.113.5')).status, 401);
    assert.equal((await attempt('203.0.113.5')).status, 429);
    assert.equal((await attempt('203.0.113.6')).status, 401);
  });

  it('shares one administrator login bucket across IPv4-mapped spellings', async () => {
    const webAuth = new WebAuth({ authenticateAdministrator: async () => null }, { loginFailureDelayMs: 0, nameDelayMaxMs: 0 });
    const port = await startGateway([LOCAL], webAuth);
    const attempt = (client) => send(port, '/auth/login', {
      host: `${LOCAL}:${port}`,
      origin: `http://${LOCAL}:${port}`,
      'x-forwarded-for': client,
      'content-type': 'application/json',
    }, { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'wrong' }) });
    const spellings = ['203.0.113.7', '::ffff:203.0.113.7', '::ffff:cb00:7107', '0:0:0:0:0:FFFF:CB00:7107'];
    for (let index = 0; index < 8; index += 1) assert.equal((await attempt(spellings[index % spellings.length])).status, 401);
    for (const spelling of spellings) assert.equal((await attempt(spelling)).status, 429, spelling);
  });
});

function send(port, path, headers, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: LOCAL, port, path, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

function stubService() {
  return {
    getHouseholdMemberIds: (householdId) => (householdId === 'grove' ? ['alice-id'] : undefined),
    listJellyfinUsers: async () => [{ Id: 'alice-id', Name: 'Alice', Policy: {} }],
    isPasswordless: () => false,
    canJoinLibrary: () => false,
  };
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, (...args) => resolve(args)));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, LOCAL, resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
