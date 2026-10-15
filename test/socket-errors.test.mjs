import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect as connectSocket, createServer as createNetServer } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { makeServer } from '../dist/server.js';

const HOUSEHOLD_HOST = 'jelly-farmhouse.example.test';
const uncaughtErrors = [];
process.on('uncaughtException', (error) => uncaughtErrors.push(error));

describe('socket error handling', { timeout: 10_000 }, () => {
  let upstream;
  let gateway;
  let gatewayPort;
  const upstreamUpgradeSockets = new Set();
  const heldResponses = new Set();
  const heldBeforeHeaders = new Set();
  const upgradeSeen = [];
  let holdPublicUsers = false;

  before(async () => {
    upstream = createServer((request, response) => {
      if (request.url === '/System/Info/Public') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ ServerName: 'Test Jellyfin' }));
        return;
      }
      if (request.url === '/stream-reset') {
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        response.write(Buffer.alloc(1024));
        setTimeout(() => request.socket.resetAndDestroy(), 20);
        return;
      }
      if (request.url === '/hold-headers' || (request.url === '/Users/Public' && holdPublicUsers)) {
        heldBeforeHeaders.add(response);
        response.once('close', () => heldBeforeHeaders.delete(response));
        return;
      }
      if (request.url === '/stream-hold') {
        heldResponses.add(response);
        response.once('close', () => heldResponses.delete(response));
        response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        response.write(Buffer.alloc(1024));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    upstream.on('upgrade', (request, socket) => {
      socket.on('error', () => {});
      // HTTP server sockets are half-open; finish our side when the gateway closes its end.
      socket.on('end', () => socket.end());
      upstreamUpgradeSockets.add(socket);
      socket.once('close', () => upstreamUpgradeSockets.delete(socket));
      upgradeSeen.push(request.url);
      if (request.url === '/socket-hold') return;
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
      if (request.url === '/socket-reset') setTimeout(() => socket.resetAndDestroy(), 20);
      else socket.on('data', (chunk) => socket.write(chunk));
    });
    await listen(upstream);
    gateway = makeServer(stubService(), { webhook: 'webhook-secret', admin: 'admin-secret' }, undefined, {
      householdGateway: { jellyfinUrl: `http://127.0.0.1:${upstream.address().port}`, domain: 'example.test', hostPrefix: 'jelly-' },
    });
    await listen(gateway);
    gatewayPort = gateway.address().port;
  });

  after(async () => {
    upstreamUpgradeSockets.forEach((socket) => socket.destroy());
    heldResponses.forEach((response) => response.destroy());
    heldBeforeHeaders.forEach((response) => response.destroy());
    gateway.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([close(gateway), close(upstream)]);
  });

  it('survives a client reset after a WebSocket upgrade', async () => {
    const { socket, response } = await upgrade(gatewayPort, '/socket');
    assert.match(response, /^HTTP\/1\.1 101/);
    socket.write('ping');
    await once(socket, 'data');
    const upstreamClosed = Promise.all([...upstreamUpgradeSockets].map((entry) => once(entry, 'close')));
    socket.resetAndDestroy();
    await upstreamClosed;
    await assertStillServing(gatewayPort);
  });

  it('survives an upstream reset after a WebSocket upgrade and closes the client', async () => {
    const { socket, response } = await upgrade(gatewayPort, '/socket-reset');
    assert.match(response, /^HTTP\/1\.1 101/);
    socket.on('error', () => {});
    await once(socket, 'close');
    await assertStillServing(gatewayPort);
  });

  it('survives a client reset while the upstream upgrade is still pending', async () => {
    const seen = upgradeSeen.length;
    const socket = await rawUpgradeRequest(gatewayPort, '/socket-hold');
    await waitFor(() => upgradeSeen.length > seen);
    const pending = [...upstreamUpgradeSockets];
    socket.resetAndDestroy();
    await Promise.all(pending.map((entry) => once(entry, 'close')));
    await assertStillServing(gatewayPort);
  });

  it('aborts the pending upstream upgrade when the client half-closes', async () => {
    const seen = upgradeSeen.length;
    const socket = await rawUpgradeRequest(gatewayPort, '/socket-hold');
    await waitFor(() => upgradeSeen.length > seen);
    const pending = [...upstreamUpgradeSockets];
    const clientClosed = once(socket, 'close');
    socket.end();
    await Promise.all(pending.map((entry) => once(entry, 'close')));
    await clientClosed;
    await assertStillServing(gatewayPort);
  });

  it('answers 502 when the upstream refuses the upgrade connection', async () => {
    const closedPort = await unusedPort();
    const isolated = makeServer(stubService(), { webhook: 'w', admin: 'a' }, undefined, {
      householdGateway: { jellyfinUrl: `http://127.0.0.1:${closedPort}`, domain: 'example.test', hostPrefix: 'jelly-' },
    });
    await listen(isolated);
    try {
      const socket = await rawUpgradeRequest(isolated.address().port, '/socket');
      let received = '';
      socket.on('data', (chunk) => { received += chunk.toString('utf8'); });
      await once(socket, 'close');
      assert.match(received, /^HTTP\/1\.1 502 Bad Gateway/);
    } finally {
      isolated.closeAllConnections();
      await close(isolated);
    }
  });

  it('survives an upstream reset in the middle of a proxied response', async () => {
    await assert.rejects(get(gatewayPort, '/stream-reset'));
    await assertStillServing(gatewayPort);
  });

  it('survives a client reset in the middle of a proxied response and releases the upstream', async () => {
    const socket = connectSocket(gatewayPort, '127.0.0.1');
    socket.on('error', () => {});
    await once(socket, 'connect');
    socket.write(`GET /stream-hold HTTP/1.1\r\nHost: ${HOUSEHOLD_HOST}\r\n\r\n`);
    await once(socket, 'data');
    assert.equal(heldResponses.size, 1);
    const upstreamClosed = once([...heldResponses][0], 'close');
    socket.resetAndDestroy();
    await upstreamClosed;
    await assertStillServing(gatewayPort);
  });

  for (const [name, pathname] of [['a proxied GET', '/hold-headers'], ['a transformed JSON proxy', '/Users/Public']]) {
    it(`releases the upstream when the client disconnects before response headers on ${name}`, async () => {
      holdPublicUsers = true;
      try {
        const socket = connectSocket(gatewayPort, '127.0.0.1');
        socket.on('error', () => {});
        await once(socket, 'connect');
        socket.write(`GET ${pathname} HTTP/1.1\r\nHost: ${HOUSEHOLD_HOST}\r\n\r\n`);
        await waitFor(() => heldBeforeHeaders.size === 1);
        const upstreamClosed = once([...heldBeforeHeaders][0], 'close');
        socket.resetAndDestroy();
        await upstreamClosed;
        assert.equal(heldBeforeHeaders.size, 0);
      } finally {
        holdPublicUsers = false;
      }
      await assertStillServing(gatewayPort);
    });
  }
});

function stubService() {
  return {
    getHouseholdMemberIds: (householdId) => (householdId === 'farmhouse' ? ['alice-id'] : undefined),
    isPasswordless: () => false,
  };
}

async function assertStillServing(port) {
  assert.deepEqual(uncaughtErrors, []);
  const response = await get(port, '/System/Info/Public');
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).ServerName, 'Test Jellyfin');
  const { socket, response: upgradeResponse } = await upgrade(port, '/socket');
  assert.match(upgradeResponse, /^HTTP\/1\.1 101/);
  socket.write('echo');
  assert.equal((await once(socket, 'data'))[0].toString('utf8'), 'echo');
  socket.destroy();
}

function get(port, pathname) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path: pathname, headers: { host: HOUSEHOLD_HOST }, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.once('end', () => resolve({ status: response.statusCode, body }));
      response.once('error', reject);
      response.once('aborted', () => reject(new Error('response aborted')));
    });
    request.once('error', reject);
    request.end();
  });
}

async function rawUpgradeRequest(port, pathname) {
  const socket = connectSocket(port, '127.0.0.1');
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(`GET ${pathname} HTTP/1.1\r\nHost: ${HOUSEHOLD_HOST}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  return socket;
}

async function upgrade(port, pathname) {
  const socket = await rawUpgradeRequest(port, pathname);
  let response = '';
  while (!response.includes('\r\n\r\n')) {
    const [chunk] = await once(socket, 'data');
    response += chunk.toString('utf8');
  }
  return { socket, response };
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, (...args) => resolve(args)));
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(condition());
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function unusedPort() {
  const server = createNetServer();
  await listen(server);
  const { port } = server.address();
  await close(server);
  return port;
}
