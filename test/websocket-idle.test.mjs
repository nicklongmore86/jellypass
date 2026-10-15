import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect as connectSocket, Socket } from 'node:net';
import { after, before, describe, it, mock } from 'node:test';
import { makeServer } from '../dist/server.js';

const HOUSEHOLD_HOST = 'jelly-farmhouse.example.test';
const IDLE_TIMEOUT_MS = 150;
const uncaughtErrors = [];
process.on('uncaughtException', (error) => uncaughtErrors.push(error));

describe('WebSocket idle timeout', { timeout: 10_000 }, () => {
  let upstream;
  const upstreamSockets = [];
  const gateways = [];

  before(async () => {
    // A silent Jellyfin stand-in: completes the upgrade and never writes unless a test pushes bytes itself.
    upstream = createServer((request, response) => {
      response.writeHead(404);
      response.end();
    });
    upstream.on('upgrade', (request, socket) => {
      socket.on('error', () => {});
      socket.on('end', () => socket.end());
      socket.resume();
      upstreamSockets.push(socket);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    await listen(upstream);
  });

  after(async () => {
    upstreamSockets.forEach((socket) => socket.destroy());
    for (const gateway of gateways) {
      gateway.closeAllConnections();
      await close(gateway);
    }
    upstream.closeAllConnections();
    await close(upstream);
    assert.deepEqual(uncaughtErrors, []);
  });

  async function startGateway(webSocketIdleTimeoutMs) {
    const gateway = makeServer(stubService(), { webhook: 'w', admin: 'a' }, undefined, {
      householdGateway: {
        jellyfinUrl: `http://127.0.0.1:${upstream.address().port}`,
        domain: 'example.test',
        hostPrefix: 'jelly-',
        webSocketIdleTimeoutMs,
      },
    });
    gateways.push(gateway);
    await listen(gateway);
    return gateway.address().port;
  }

  async function openSocket(port) {
    const seen = upstreamSockets.length;
    const client = connectSocket(port, '127.0.0.1');
    client.on('error', () => {});
    await once(client, 'connect');
    client.write(`GET /socket HTTP/1.1\r\nHost: ${HOUSEHOLD_HOST}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    let response = '';
    while (!response.includes('\r\n\r\n')) response += (await once(client, 'data'))[0].toString('utf8');
    assert.match(response, /^HTTP\/1\.1 101/);
    await waitFor(() => upstreamSockets.length > seen);
    return { client, server: upstreamSockets.at(-1) };
  }

  it('closes both sides of an idle connection after the timeout', async () => {
    const port = await startGateway(IDLE_TIMEOUT_MS);
    const openedAt = Date.now();
    const { client, server } = await openSocket(port);
    await Promise.all([once(client, 'close'), once(server, 'close')]);
    assert.ok(Date.now() - openedAt >= IDLE_TIMEOUT_MS - 10, 'closed before the idle timeout elapsed');
    assert.deepEqual(uncaughtErrors, []);
  });

  it('keeps a Jellyfin client that sends KeepAlive frames more often than the timeout', async () => {
    const port = await startGateway(IDLE_TIMEOUT_MS);
    const { client, server } = await openSocket(port);
    let closed = false;
    client.once('close', () => { closed = true; });
    // Jellyfin clients answer ForceKeepAlive(60) with a KeepAlive every 30 s; scaled down, every IDLE_TIMEOUT_MS / 3.
    const keepAlive = setInterval(() => client.write(maskedTextFrame('{"MessageType":"KeepAlive"}')), IDLE_TIMEOUT_MS / 3);
    await delay(IDLE_TIMEOUT_MS * 4);
    clearInterval(keepAlive);
    assert.equal(closed, false);
    assert.equal(server.destroyed, false);
    // Once the client goes quiet the timer runs out as usual.
    await Promise.all([once(client, 'close'), once(server, 'close')]);
  });

  it('resets the timer on traffic from Jellyfin to the client', async () => {
    const port = await startGateway(IDLE_TIMEOUT_MS);
    const { client, server } = await openSocket(port);
    client.resume();
    let closed = false;
    client.once('close', () => { closed = true; });
    const push = setInterval(() => server.write(Buffer.from([0x81, 0x02, 0x7b, 0x7d])), IDLE_TIMEOUT_MS / 3);
    await delay(IDLE_TIMEOUT_MS * 4);
    clearInterval(push);
    assert.equal(closed, false);
    await Promise.all([once(client, 'close'), once(server, 'close')]);
  });

  it('never closes idle connections when the timeout is 0', async () => {
    const port = await startGateway(0);
    const { client, server } = await openSocket(port);
    let closed = false;
    client.once('close', () => { closed = true; });
    await delay(IDLE_TIMEOUT_MS * 4);
    assert.equal(closed, false);
    assert.equal(server.destroyed, false);
    const serverClosed = once(server, 'close');
    client.destroy();
    await serverClosed;
  });

  it('enables TCP keepalive on both proxied sockets', async () => {
    const setKeepAlive = mock.method(Socket.prototype, 'setKeepAlive');
    try {
      const port = await startGateway(0);
      const { client, server } = await openSocket(port);
      const enabled = setKeepAlive.mock.calls.filter((call) => call.arguments[0] === true);
      // The gateway enables it on its client-facing and its Jellyfin-facing socket.
      assert.ok(enabled.length >= 2, `expected setKeepAlive(true) on both sockets, saw ${enabled.length}`);
      const serverClosed = once(server, 'close');
      client.destroy();
      await serverClosed;
    } finally {
      setKeepAlive.mock.restore();
    }
  });
});

function maskedTextFrame(text) {
  const payload = Buffer.from(text);
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

function stubService() {
  return {
    getHouseholdMemberIds: (householdId) => (householdId === 'farmhouse' ? ['alice-id'] : undefined),
    isPasswordless: () => false,
  };
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, (...args) => resolve(args)));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition) {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) await delay(10);
  assert.ok(condition());
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}
