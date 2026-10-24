import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { Agent, createServer, request as httpRequest } from 'node:http';
import { connect as connectSocket, createServer as createNetServer } from 'node:net';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { makeServer } from '../dist/server.js';
import { createShutdown } from '../dist/shutdown.js';
import { GrantStore } from '../dist/store.js';
import { createFakeJellyfin } from './support/fake-jellyfin.mjs';
import { makeTempDir } from './support/temp-dir.mjs';

const HOUSEHOLD_HOST = 'jelly-farmhouse.example.test';
const ENTRYPOINT = fileURLToPath(new URL('../dist/index.js', import.meta.url));
// Docker's default stop timeout is 10 s; shutdown should be done well inside it.
const SHUTDOWN_BUDGET_MS = 3_000;

describe('graceful shutdown', { timeout: 15_000 }, () => {
  let upstream;
  const upstreamSockets = [];
  const servers = [];
  let upstreamRequests = 0;

  before(async () => {
    // A Jellyfin stand-in whose WebSockets never close on their own, like an idle browser tab's.
    upstream = createServer((request, response) => {
      upstreamRequests += 1;
      if (request.url === '/slow') {
        setTimeout(() => {
          response.writeHead(200, { 'Content-Type': 'text/plain' });
          response.end('slow done');
        }, 300);
        return;
      }
      if (request.url === '/hang') return;
      response.writeHead(404);
      response.end();
    });
    upstream.on('upgrade', (request, socket) => {
      socket.on('error', () => {});
      // Answer FIN like a real server; HTTP server sockets allow half-open connections and would otherwise linger.
      socket.on('end', () => socket.end());
      socket.resume();
      upstreamSockets.push(socket);
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    });
    await listen(upstream);
  });

  after(async () => {
    upstreamSockets.forEach((socket) => socket.destroy());
    for (const server of servers) {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    }
    upstream.closeAllConnections();
    await new Promise((resolve) => upstream.close(resolve));
  });

  async function startServer() {
    const server = makeServer(stubService(), { webhook: 'w', admin: 'a' }, undefined, {
      householdGateway: {
        jellyfinUrl: `http://127.0.0.1:${upstream.address().port}`,
        domain: 'example.test',
        hostPrefix: 'jelly-',
      },
    });
    servers.push(server);
    await listen(server);
    return server;
  }

  async function openWebSocket(port) {
    const seen = upstreamSockets.length;
    const client = await openWebSocketClient(port, HOUSEHOLD_HOST);
    await waitFor(() => upstreamSockets.length > seen);
    return { client, upstreamSocket: upstreamSockets.at(-1) };
  }

  async function newStore(t) {
    const file = path.join(await makeTempDir(t, 'jellypass-shutdown-test-'), 'grants.json');
    const store = new GrantStore(file);
    await store.load();
    return { store, file };
  }

  function harness(server, store, overrides = {}) {
    const exits = [];
    const logs = [];
    const shutdown = createShutdown({
      servers: [server],
      closeStore: () => store.close(),
      timers: () => [],
      exit: (code) => exits.push(code),
      log: (level, message, fields) => logs.push({ level, message, ...fields }),
      ...overrides,
    });
    return { shutdown, exits, logs };
  }

  it('closes listeners, WebSockets and idle keep-alive sockets, lets in-flight requests finish, flushes state and exits 0', async (t) => {
    const server = await startServer();
    const port = server.address().port;
    const { store, file } = await newStore(t);
    const { client, upstreamSocket } = await openWebSocket(port);
    const clientClosed = once(client, 'close');
    const upstreamEnded = once(upstreamSocket, 'end');
    const upstreamClosed = once(upstreamSocket, 'close');

    const agent = new Agent({ keepAlive: true });
    const health = await get({ port, path: '/health', agent });
    assert.equal(health.status, 200);
    assert.equal(agent.freeSockets[`127.0.0.1:${port}:`]?.length, 1, 'expected an idle keep-alive socket');
    const idleSocketClosed = once(agent.freeSockets[`127.0.0.1:${port}:`][0], 'close');
    const seenRequests = upstreamRequests;
    const inFlight = get({ port, path: '/slow', headers: { Host: HOUSEHOLD_HOST } });
    await waitFor(() => upstreamRequests > seenRequests);

    let ticks = 0;
    const reconcileTimer = setInterval(() => { ticks += 1; }, 5);
    const catalogTimer = setInterval(() => { ticks += 1; }, 5);
    const pendingWrite = store.upsertGroup({ id: 'late', name: 'Late', userIds: ['alice-id'] });

    const { shutdown, exits, logs } = harness(server, store, { timers: () => [reconcileTimer, catalogTimer, undefined] });
    const startedAt = performance.now();
    await shutdown('SIGTERM');
    const elapsed = performance.now() - startedAt;

    assert.deepEqual(exits, [0]);
    assert.ok(elapsed < SHUTDOWN_BUDGET_MS, `shutdown took ${elapsed.toFixed(0)} ms`);
    assert.equal(server.listening, false);
    await Promise.all([clientClosed, upstreamEnded, upstreamClosed, idleSocketClosed]);
    assert.deepEqual(await inFlight, { status: 200, body: 'slow done' });
    await pendingWrite;
    const state = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(state.groups.late?.name, 'Late');
    await assert.rejects(store.upsertGroup({ id: 'after', name: 'After', userIds: [] }), /state store is closed/);
    const ticksAtExit = ticks;
    await delay(40);
    assert.equal(ticks, ticksAtExit, 'background timers kept firing after shutdown');
    assert.equal(logs.at(-1).message, 'shutdown complete');
    assert.equal(logs.at(-1).webSockets, 1);
    agent.destroy();
  });

  it('closes both sides of an upgrade still waiting for Jellyfin to answer', async (t) => {
    // A Jellyfin stand-in that accepts the upgrade request but withholds the 101.
    let pendingUpstream;
    const withholding = createServer();
    withholding.on('upgrade', (request, socket) => {
      socket.on('error', () => {});
      socket.on('end', () => socket.end());
      socket.resume();
      pendingUpstream = socket;
    });
    await listen(withholding);
    try {
      const server = makeServer(stubService(), { webhook: 'w', admin: 'a' }, undefined, {
        householdGateway: { jellyfinUrl: `http://127.0.0.1:${withholding.address().port}`, domain: 'example.test', hostPrefix: 'jelly-' },
      });
      servers.push(server);
      await listen(server);
      const client = connectSocket(server.address().port, '127.0.0.1');
      client.on('error', () => {});
      await once(client, 'connect');
      client.write(`GET /socket HTTP/1.1\r\nHost: ${HOUSEHOLD_HOST}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
      await waitFor(() => pendingUpstream !== undefined);
      const clientClosed = once(client, 'close');
      const upstreamClosed = once(pendingUpstream, 'close');
      const { store } = await newStore(t);
      const { shutdown, exits, logs } = harness(server, store);
      const startedAt = performance.now();
      // Bounded, so an untracked pending upgrade (which keeps server.close() open) fails here instead of hanging.
      const outcome = await Promise.race([
        Promise.all([shutdown('SIGTERM'), clientClosed, upstreamClosed]).then(() => 'closed'),
        delay(SHUTDOWN_BUDGET_MS).then(() => 'still open'),
      ]);
      const elapsed = performance.now() - startedAt;
      assert.equal(outcome, 'closed');
      assert.deepEqual(exits, [0]);
      assert.ok(elapsed < SHUTDOWN_BUDGET_MS, `shutdown took ${elapsed.toFixed(0)} ms`);
      assert.equal(client.destroyed, true);
      assert.equal(pendingUpstream.destroyed, true);
      assert.equal(logs.at(-1).webSockets, 1);
    } finally {
      pendingUpstream?.destroy();
      withholding.closeAllConnections();
      await new Promise((resolve) => withholding.close(resolve));
    }
  });

  it('cuts off requests still running after the grace period', async (t) => {
    const server = await startServer();
    const { store } = await newStore(t);
    const seenRequests = upstreamRequests;
    const hanging = get({ port: server.address().port, path: '/hang', headers: { Host: HOUSEHOLD_HOST } }).catch((error) => error);
    await waitFor(() => upstreamRequests > seenRequests);
    const { shutdown, exits } = harness(server, store, { graceMs: 200 });
    const startedAt = performance.now();
    await shutdown('SIGTERM');
    const elapsed = performance.now() - startedAt;
    assert.deepEqual(exits, [0]);
    assert.ok(elapsed >= 190 && elapsed < 1_000, `shutdown took ${elapsed.toFixed(0)} ms`);
    assert.ok((await hanging) instanceof Error, 'the hanging request should have been cut off');
  });

  it('is idempotent when a second signal arrives', async (t) => {
    const server = await startServer();
    const { store } = await newStore(t);
    await openWebSocket(server.address().port);
    const { shutdown, exits, logs } = harness(server, store);
    const first = shutdown('SIGTERM');
    const second = shutdown('SIGINT');
    assert.equal(first, second);
    await first;
    assert.deepEqual(exits, [0]);
    assert.equal(logs.filter((entry) => entry.message === 'shutting down').length, 1);
    assert.equal(logs.filter((entry) => entry.message === 'shutdown already in progress').length, 1);
  });

  it('logs and exits non-zero when something still hangs past the hard timeout', async () => {
    const server = await startServer();
    const exits = [];
    const logs = [];
    const shutdown = createShutdown({
      servers: [server],
      closeStore: () => new Promise(() => {}),
      timers: () => [],
      hardTimeoutMs: 150,
      exit: (code) => exits.push(code),
      log: (level, message) => logs.push({ level, message }),
    });
    void shutdown('SIGTERM');
    await waitFor(() => exits.length > 0);
    assert.deepEqual(exits, [1]);
    assert.ok(logs.some((entry) => entry.level === 'error' && entry.message === 'shutdown timed out; exiting'));
  });

  it('keeps the process alive until the hard timeout fires when a step stalls with nothing else pending', async () => {
    // In a child process, where nothing else keeps the event loop running: a stalled promise alone holds no handle.
    const script = `
      import { createShutdown } from ${JSON.stringify(new URL('../dist/shutdown.js', import.meta.url).href)};
      createShutdown({ servers: [], timers: () => [], closeStore: () => new Promise(() => {}), hardTimeoutMs: 200 })('SIGTERM');
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 1, output);
    assert.match(output, /"message":"shutdown timed out; exiting"/);
  });

  it('demonstrates the old behaviour: server.close() alone never completes while a proxied WebSocket is open', async () => {
    const server = await startServer();
    await openWebSocket(server.address().port);
    let closed = false;
    server.close(() => { closed = true; });
    await delay(SHUTDOWN_BUDGET_MS / 3);
    assert.equal(closed, false, 'server.close() completed even though a WebSocket was open');
    await server.closeWebSockets();
    await waitFor(() => closed);
  });

  it('GrantStore.close() waits for the write in flight and the one queued behind it', async (t) => {
    const { store, file } = await newStore(t);
    const first = store.upsertGroup({ id: 'one', name: 'One', userIds: [] });
    const second = store.upsertGroup({ id: 'two', name: 'Two', userIds: [] });
    await store.close();
    const state = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(Object.keys(state.groups).sort(), ['one', 'two']);
    await Promise.all([first, second]);
  });

  it('logs and exits 1 when the final state-file write fails', async (t) => {
    const directory = await makeTempDir(t, 'jellypass-shutdown-test-');
    // A directory where the state file should be: every write fails with EISDIR.
    const file = path.join(directory, 'grants.json');
    await mkdir(file);
    const store = new GrantStore(file);
    // The caller that saved still sees its own failure, as in normal operation.
    const failed = store.upsertGroup({ id: 'lost', name: 'Lost', userIds: [] }).catch((error) => error.code);
    const exits = [];
    const logs = [];
    await createShutdown({
      servers: [],
      closeStore: () => store.close(),
      timers: () => [],
      exit: (code) => exits.push(code),
      log: (level, message, fields) => logs.push({ level, message, ...fields }),
    })('SIGTERM');
    assert.equal(await failed, 'EISDIR');
    assert.deepEqual(exits, [1]);
    assert.ok(logs.some((entry) => entry.level === 'error' && entry.message === 'shutdown failed' && /EISDIR/.test(entry.detail)), JSON.stringify(logs));
    assert.ok(!logs.some((entry) => entry.message === 'shutdown complete'));
  });

  it('GrantStore refuses a save after close() even while a write is queued', async (t) => {
    const { store, file } = await newStore(t);
    const first = store.upsertGroup({ id: 'first', name: 'First', userIds: [] });
    const closing = store.close();
    await assert.rejects(store.upsertGroup({ id: 'late', name: 'Late', userIds: [] }), /state store is closed/);
    await Promise.all([first, closing]);
    assert.equal(store.getGroup('late'), undefined, 'the refused change is still in memory');
    const state = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(Object.keys(state.groups), ['first']);
  });

  it('GrantStore.load() leaves state untouched when close() is called while the file is being read', async (t) => {
    const { store: writer, file } = await newStore(t);
    await writer.upsertGroup({ id: 'saved', name: 'Saved', userIds: [] });
    await writer.close();
    const store = new GrantStore(file);
    const loading = store.load();
    await store.close();
    await assert.rejects(loading, /state store is closed/);
    assert.deepEqual(store.listGroups(), []);
  });

  it('GrantStore leaves memory untouched when it refuses a change after close()', async (t) => {
    const { store } = await newStore(t);
    await store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: ['alice-id'] });
    await store.close();
    await assert.rejects(store.grant({ itemId: 'item-1', requestId: '42', userId: 'alice-id', groupIds: ['farmhouse'] }), /state store is closed/);
    assert.equal(store.get('item-1'), undefined);
    assert.equal(store.hasHandledRequest('42'), false);
    await assert.rejects(store.deleteGroup('farmhouse'), /state store is closed/);
    await assert.rejects(store.setUserPasswordless('alice-id', true), /state store is closed/);
    await assert.rejects(store.replaceCatalog([{ id: 'item-9', name: 'Nine', type: 'Movie' }]), /state store is closed/);
    assert.ok(store.getGroup('farmhouse'));
    assert.deepEqual(store.listPasswordlessUserIds(), []);
    assert.deepEqual(store.getCatalog().items, []);
  });
});

describe('SIGTERM to the JellyPass process', { timeout: 15_000 }, () => {
  let jellyfin;

  before(async () => {
    jellyfin = await createFakeJellyfin();
  });

  after(async () => {
    await jellyfin.close();
  });

  it('exits 0 within the budget with an open proxied WebSocket and an idle keep-alive connection', async (t) => {
    const directory = await makeTempDir(t, 'jellypass-sigterm-test-');
    const stateFile = path.join(directory, 'grants.json');
    const seed = new GrantStore(stateFile);
    await seed.load();
    await seed.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: ['alice-id'] });
    await seed.close();
    const port = await freePort();
    const child = spawn(process.execPath, [ENTRYPOINT], {
      env: {
        PATH: process.env.PATH,
        HOST: '127.0.0.1',
        PORT: String(port),
        WEBHOOK_TOKEN: 'webhook-secret',
        ADMIN_TOKEN: 'admin-secret',
        JELLYFIN_URL: jellyfin.url,
        JELLYFIN_API_KEY: 'test-key',
        STATE_FILE: stateFile,
        HOUSEHOLD_DOMAIN: 'example.test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
    try {
      await waitFor(() => output.includes('server started'), 500);
      const client = await openWebSocketClient(port, HOUSEHOLD_HOST);
      const clientClosed = once(client, 'close');
      const agent = new Agent({ keepAlive: true });
      assert.equal((await get({ port, path: '/health', agent })).status, 200);

      const startedAt = performance.now();
      child.kill('SIGTERM');
      // Before graceful shutdown the process never exited on its own: Docker had to SIGKILL it.
      const result = await Promise.race([exited, delay(2 * SHUTDOWN_BUDGET_MS).then(() => 'still running')]);
      const elapsed = performance.now() - startedAt;
      assert.deepEqual(result, { code: 0, signal: null }, output);
      assert.ok(elapsed < SHUTDOWN_BUDGET_MS, `exited ${elapsed.toFixed(0)} ms after SIGTERM`);
      await clientClosed;
      assert.match(output, /"message":"shutdown complete"/);
      agent.destroy();
    } finally {
      child.kill('SIGKILL');
      // It may still be writing the state file; let it exit before its directory is removed.
      await exited;
    }
  });
});

async function openWebSocketClient(port, host) {
  const client = connectSocket(port, '127.0.0.1');
  client.on('error', () => {});
  await once(client, 'connect');
  client.write(`GET /socket HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGVzdA==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  let response = '';
  while (!response.includes('\r\n\r\n')) response += (await once(client, 'data'))[0].toString('utf8');
  assert.match(response, /^HTTP\/1\.1 101/);
  return client;
}

function get(options) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', method: 'GET', ...options }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}

function stubService() {
  return {
    getHouseholdMemberIds: (householdId) => (householdId === 'farmhouse' ? ['alice-id'] : undefined),
    isPasswordless: () => false,
    canJoinLibrary: () => false,
  };
}

async function freePort() {
  const probe = createNetServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function once(emitter, event) {
  return new Promise((resolve) => emitter.once(event, (...args) => resolve(args)));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition, attempts = 200) {
  for (let attempt = 0; attempt < attempts && !condition(); attempt += 1) await delay(10);
  assert.ok(condition());
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}
