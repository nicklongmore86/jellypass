import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AccessService } from '../dist/access-service.js';
import { JellyfinClient } from '../dist/jellyfin.js';
import { makeServer } from '../dist/server.js';
import { BackgroundTasks, createShutdown } from '../dist/shutdown.js';
import { GrantStore } from '../dist/store.js';
import { createFakeJellyfin } from './support/fake-jellyfin.mjs';
import { makeTempDir } from './support/temp-dir.mjs';

const HOUSEHOLD_HOST = 'jelly-grove.example.test';
const JOIN_PATH = '/jellypass/add';

describe('household "Add to my library"', { timeout: 10_000 }, () => {
  // TMDB movie 603 is item-1, movie 604 is item-2, movie 404 is not in the library and movie 500 fails to resolve.
  // `lookupGate`, if given, holds every Seerr lookup until it resolves.
  async function gateway(t, { seerr = true, trustedProxies, lookupGate } = {}) {
    const jellyfin = await createFakeJellyfin();
    t.after(() => jellyfin.close());
    const store = new GrantStore(path.join(await makeTempDir(t, 'jfa-join-test-'), 'grants.json'));
    await store.load();
    const client = new JellyfinClient(jellyfin.url, 'test-key');
    const carol = await client.createUser('Carol', 'user-password');
    const dave = await client.createUser('Dave', 'user-password');
    await store.upsertGroup({ id: 'grove', name: 'Grove', userIds: ['alice-id', 'bob-id'] });
    await store.upsertGroup({ id: 'cottage', name: 'Cottage', userIds: [carol.Id] });
    const lookups = [];
    const seerrClient = seerr ? {
      async getJellyfinItemId(mediaType, tmdbId) {
        lookups.push(`${mediaType}/${tmdbId}`);
        await lookupGate;
        if (tmdbId === 500) throw new Error('Seerr GET /api/v1/movie/500 returned 500');
        return { 'movie/603': 'item-1', 'movie/604': 'item-2' }[`${mediaType}/${tmdbId}`];
      },
    } : undefined;
    const service = new AccessService(client, store, undefined, seerrClient);
    // Every background join is recorded, so a test can wait for the ones it started.
    const background = new BackgroundTasks();
    const started = [];
    const tracked = {
      run(task) {
        const running = background.run(task);
        if (running) started.push(running);
        return running;
      },
    };
    const server = makeServer(service, { webhook: 'webhook-secret', admin: 'admin-secret' }, undefined, {
      ...(trustedProxies ? { trustedProxies } : {}),
      background: tracked,
      householdGateway: { jellyfinUrl: jellyfin.url, domain: 'example.test', hostPrefix: 'jelly-' },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    // Household members sign in on their household hostname; Dave, in no household, signs in on Jellyfin itself.
    const login = async (username) => {
      const host = { Alice: HOUSEHOLD_HOST, Bob: HOUSEHOLD_HOST, Carol: 'jelly-cottage.example.test' }[username];
      const response = await send(host ? baseUrl : jellyfin.url, '/Users/AuthenticateByName', {
        method: 'POST',
        headers: { Authorization: jellyfinAuthorization(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ Username: username, Pw: 'user-password' }),
      }, host ?? new URL(jellyfin.url).host);
      assert.equal(response.status, 200, username);
      return JSON.parse(response.body).AccessToken;
    };
    const join = (token, body = { mediaType: 'movie', tmdbId: 603 }, headers = {}) => send(baseUrl, JOIN_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: jellyfinAuthorization(token) } : {}), ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    const grantForAlice = async (itemId = 'item-1', requestId = '17') => {
      const response = await fetch(`${baseUrl}/webhooks/seerr`, {
        method: 'POST',
        headers: { Authorization: 'Bearer webhook-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          notificationType: 'MEDIA_AVAILABLE',
          event: 'Movie Request Now Available',
          media: { jellyfinMediaId: itemId, mediaType: 'movie' },
          request: { id: requestId, requestedBy: { jellyfinUserId: 'alice-id' } },
        }),
      });
      assert.equal(response.status, 200);
      await response.arrayBuffer();
    };
    // Each join runs in the background after its response.
    const settled = () => Promise.all(started);
    return { jellyfin, client, store, service, server, background, baseUrl, login, join, grantForAlice, settled, started, lookups, carol, dave };
  }

  it('requires a Jellyfin-confirmed sign-in and ignores a user ID sent by the client', async (t) => {
    const { jellyfin, store, login, join, grantForAlice, settled, carol } = await gateway(t);
    await grantForAlice();

    const anonymous = await join(undefined);
    assert.equal(anonymous.status, 401);
    assert.deepEqual(JSON.parse(anonymous.body), { error: 'unauthorized' });
    const forged = await join('not-a-real-token');
    assert.equal(forged.status, 401);
    assert.ok(jellyfin.requestedPaths.includes('/Users/Me'), 'the token is checked with Jellyfin');
    assert.deepEqual(store.get('item-1').groupIds, ['grove']);

    // Carol's own token decides who joins, whatever user ID the body names.
    const token = await login('Carol');
    const accepted = await join(token, { mediaType: 'movie', tmdbId: 603, userId: 'bob-id', groupIds: ['grove'] });
    assert.equal(accepted.status, 202);
    await settled();
    const grant = store.get('item-1');
    assert.deepEqual(grant.groupIds, ['cottage', 'grove']);
    assert.equal(grant.joins[0].userId, carol.Id);
    assert.deepEqual(jellyfin.user(carol.Id).Policy.BlockedTags, []);
  });

  it('rejects the server API key, which belongs to no user', async (t) => {
    const { baseUrl, store, grantForAlice } = await gateway(t);
    await grantForAlice();
    for (const [pathname, headers] of [
      [`${JOIN_PATH}?api_key=test-key`, {}],
      [JOIN_PATH, { Authorization: `MediaBrowser Client="x", DeviceId="y", Token="test-key"` }],
    ]) {
      const response = await send(baseUrl, pathname, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ mediaType: 'movie', tmdbId: 603 }),
      });
      assert.equal(response.status, 401, pathname);
    }
    assert.equal(store.get('item-1').joins, undefined);
  });

  it('joins a request grant for a caller in no household as a user and leaves manual-only grants alone', async (t) => {
    const { jellyfin, store, service, login, join, grantForAlice, settled, dave } = await gateway(t);
    await grantForAlice();
    await service.setManualAccess({ itemId: 'item-2', mediaType: 'movie', userIds: [], groupIds: ['grove'] });
    const manual = store.get('item-2');
    const token = await login('Dave');

    assert.equal((await join(token)).status, 202);
    assert.equal((await join(token, { mediaType: 'movie', tmdbId: 604 })).status, 202);
    await settled();
    assert.deepEqual(store.get('item-1').manualUserIds, [dave.Id]);
    assert.deepEqual(jellyfin.user(dave.Id).Policy.BlockedTags, ['jfa:private:item-2']);
    assert.deepEqual(store.get('item-2'), manual);

    // Repeats are harmless and record nothing new.
    const joined = store.get('item-1');
    assert.equal((await join(token)).status, 202);
    await settled();
    assert.deepEqual(store.get('item-1'), joined);
  });

  it('answers every case with the same status, headers and body, revealing nothing about the title', async (t) => {
    const { store, service, login, join, grantForAlice, settled, carol } = await gateway(t);
    await grantForAlice();
    const alice = await login('Alice');
    const carolToken = await login('Carol');
    const cases = [];
    const record = async (label, token, body) => {
      const response = await join(token, body);
      await settled();
      cases.push({ label, response });
    };
    await record('not in the library', carolToken, { mediaType: 'movie', tmdbId: 404 });
    await record('Seerr lookup fails', carolToken, { mediaType: 'movie', tmdbId: 500 });
    await record('public title', carolToken, { mediaType: 'movie', tmdbId: 604 });
    await record('already accessible (requester)', alice, { mediaType: 'movie', tmdbId: 603 });
    await record('privately held by another household', carolToken, { mediaType: 'movie', tmdbId: 603 });
    await record('already accessible (joined)', carolToken, { mediaType: 'movie', tmdbId: 603 });
    await service.setManualAccess({ itemId: 'item-2', userIds: [], groupIds: ['grove'] });
    await record('not request-derived', carolToken, { mediaType: 'movie', tmdbId: 604 });
    await record('television lookup', carolToken, { mediaType: 'tv', tmdbId: 603 });
    assert.equal(store.get('item-1').joins[0].userId, carol.Id, 'the cases include a real join');

    const [first] = cases;
    assert.equal(first.response.status, 202);
    assert.equal(first.response.body, '{"status":"accepted"}');
    for (const { label, response } of cases) {
      assert.equal(response.status, first.response.status, label);
      assert.equal(response.body, first.response.body, label);
      assert.deepEqual(comparableHeaders(response.headers), comparableHeaders(first.response.headers), label);
      for (const secret of ['alice', 'grove', 'cottage', 'item-1', 'item-2', '17', carol.Id]) {
        assert.ok(!response.body.toLowerCase().includes(secret), `${label} must not mention ${secret}`);
      }
    }
    const metrics = service.renderMetrics();
    assert.match(metrics, /jfa_library_joins_total\{result="joined"\} 1\n/);
    assert.match(metrics, /jfa_library_joins_total\{result="unchanged"\} 6\n/);
    assert.match(metrics, /jfa_library_joins_total\{result="error"\} 1\n/);
    assert.doesNotMatch(metrics.split('\n').filter((line) => line.startsWith('jfa_library_joins_total')).join('\n'), /item|tmdb|grove|cottage/);
  });

  it('answers before the Seerr lookup settles, so the time taken cannot depend on the title', async (t) => {
    let release;
    const { store, login, join, grantForAlice, settled, lookups } = await gateway(t, { lookupGate: new Promise((resolve) => { release = resolve; }) });
    await grantForAlice();
    const token = await login('Carol');
    // At most three per user run at once; see the next tests for the rest.
    for (const tmdbId of [404, 500, 603]) {
      const response = await within(2_000, join(token, { mediaType: 'movie', tmdbId }));
      assert.equal(response.status, 202, String(tmdbId));
      assert.equal(response.body, '{"status":"accepted"}');
    }
    assert.deepEqual(lookups, ['movie/404', 'movie/500', 'movie/603'], 'every lookup started and none has finished');
    assert.equal(store.get('item-1').joins, undefined);
    release();
    await settled();
    assert.deepEqual(store.get('item-1').groupIds, ['cottage', 'grove'], 'the join still happens afterwards');
  });

  it('answers without waiting for the write queue, however long it is held', async (t) => {
    const world = await gateway(t);
    const { store, login, join, grantForAlice, settled } = world;
    await grantForAlice();
    const token = await login('Carol');
    const release = holdWriteQueue(world);
    const response = await within(2_000, join(token));
    assert.equal(response.status, 202);
    assert.equal(store.get('item-1').joins, undefined, 'the join is still waiting for the queue');
    await release();
    await settled();
    assert.deepEqual(store.get('item-1').groupIds, ['cottage', 'grove']);
  });

  it('classifies a join that changes nothing without waiting for the write queue', async (t) => {
    const world = await gateway(t);
    const { login, join, grantForAlice, started } = world;
    await grantForAlice();
    const alice = await login('Alice');
    const carol = await login('Carol');
    const release = holdWriteQueue(world);
    // A public title, a title already in the caller's library, and one not in the library.
    assert.equal((await join(carol, { mediaType: 'movie', tmdbId: 604 })).status, 202);
    assert.equal((await join(alice, { mediaType: 'movie', tmdbId: 603 })).status, 202);
    assert.equal((await join(carol, { mediaType: 'movie', tmdbId: 404 })).status, 202);
    await within(2_000, Promise.all(started));
    await release();
  });

  // Codex's probe: three calls for a target T while the write queue is held, then one for a title P the caller can
  // join. Whether P is started must not depend on what T is.
  for (const [label, tmdbId] of [['public, so resolved but unchanged', 604], ['not in the library', 404]]) {
    it(`starts a probe after three calls for a target that is ${label}`, async (t) => {
      const world = await gateway(t);
      const { store, service, login, join, grantForAlice, settled, lookups } = world;
      await grantForAlice();
      const token = await login('Carol');
      const release = holdWriteQueue(world);
      for (let call = 0; call < 3; call += 1) assert.equal((await join(token, { mediaType: 'movie', tmdbId })).status, 202);
      assert.equal((await join(token)).status, 202);
      await release();
      await settled();
      assert.deepEqual(lookups, [`movie/${tmdbId}`, `movie/${tmdbId}`, `movie/${tmdbId}`, 'movie/603']);
      assert.deepEqual(store.get('item-1').groupIds, ['cottage', 'grove'], 'the probe joined');
      assert.doesNotMatch(service.renderMetrics(), /result="dropped"/);
    });
  }

  it('admits calls by count alone: ten per user per window, whatever the titles resolve to', async (t) => {
    const outcomes = [];
    for (const tmdbId of [604, 404]) {
      const world = await gateway(t);
      const { store, service, login, join, grantForAlice, settled, lookups } = world;
      await grantForAlice();
      const token = await login('Carol');
      const dave = await login('Dave');
      const release = holdWriteQueue(world);
      for (let call = 0; call < 10; call += 1) assert.equal((await join(token, { mediaType: 'movie', tmdbId })).status, 202);
      const probe = await join(token);
      assert.equal(probe.status, 202, 'a dropped call gets the same answer');
      assert.equal(probe.body, '{"status":"accepted"}');
      assert.equal((await join(dave)).status, 202, 'another user has their own budget');
      await release();
      await settled();
      outcomes.push({
        lookups: lookups.length,
        carolJoined: store.get('item-1').groupIds.includes('cottage'),
        daveJoined: store.get('item-1').manualUserIds.length === 1,
        dropped: /jfa_library_joins_total\{result="dropped"\} (\d+)/.exec(service.renderMetrics())?.[1],
      });
    }
    assert.deepEqual(outcomes, [
      { lookups: 11, carolJoined: false, daveJoined: true, dropped: '1' },
      { lookups: 11, carolJoined: false, daveJoined: true, dropped: '1' },
    ]);
  });

  it('counts only calls a user\'s budget admits against the shared budget, from however many addresses', async (t) => {
    const { client, service, login, join, settled, lookups } = await gateway(t, { trustedProxies: ['127.0.0.1'] });
    const from = (address) => ({ 'X-Forwarded-For': address });
    const notInLibrary = { mediaType: 'movie', tmdbId: 404 };
    const carol = await login('Carol');
    // 240 calls from eight addresses, past the shared budget of 200: only Carol's own ten are started.
    for (let address = 0; address < 8; address += 1) {
      for (let call = 0; call < 30; call += 1) {
        assert.equal((await join(carol, notInLibrary, from(`203.0.113.${address}`))).status, 202);
      }
    }
    assert.equal((await join(await login('Dave'), notInLibrary, from('198.51.100.1'))).status, 202);
    await settled();
    assert.equal(lookups.length, 11, 'Carol started ten and Dave was admitted');
    // Exactly 189 of the shared budget are left: nineteen more users get 189 started and one dropped.
    for (let user = 0; user < 19; user += 1) {
      await client.createUser(`Member${user}`, 'user-password');
      const token = await login(`Member${user}`);
      for (let call = 0; call < 10; call += 1) {
        assert.equal((await join(token, notInLibrary, from(`198.51.100.${user + 10}`))).status, 202);
      }
    }
    await settled();
    assert.equal(lookups.length, 200);
    assert.match(service.renderMetrics(), /jfa_library_joins_total\{result="dropped"\} 231\b/);
  });

  it('is drained by shutdown before the store closes, and applies nothing once shutdown began', async (t) => {
    let release;
    const { jellyfin, store, server, background, login, join, grantForAlice, started, carol } = await gateway(t, {
      lookupGate: new Promise((resolve) => { release = resolve; }),
    });
    await grantForAlice();
    const token = await login('Carol');
    assert.equal((await join(token)).status, 202);
    const events = [];
    void started[0].then(() => events.push('join settled'));
    const exits = [];
    const shutdown = createShutdown({
      servers: [server],
      timers: () => [],
      background,
      closeStore: async () => {
        events.push('store closing');
        await store.close();
      },
      graceMs: 2_000,
      exit: (code) => exits.push(code),
      log: () => {},
    })('SIGTERM');
    setTimeout(release, 50);
    await shutdown;
    assert.deepEqual(events, ['join settled', 'store closing']);
    assert.deepEqual(exits, [0]);
    assert.deepEqual(store.get('item-1').groupIds, ['grove'], 'the lookup finished after shutdown began, so nothing was joined');
    assert.deepEqual(jellyfin.user(carol.Id).Policy.BlockedTags, ['jfa:private:item-1']);
  });

  it('rejects malformed input with one generic 400', async (t) => {
    const { login, join, lookups } = await gateway(t);
    const token = await login('Carol');
    for (const body of ['not json', '[]', { mediaType: 'music', tmdbId: 1 }, { mediaType: 'movie', tmdbId: '603' },
      { mediaType: 'movie', tmdbId: 0 }, { mediaType: 'movie', tmdbId: 1.5 }, { mediaType: 'movie', tmdbId: 603, pad: 'x'.repeat(2048) }]) {
      const response = await join(token, body);
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 60));
      assert.deepEqual(JSON.parse(response.body), { error: 'invalid_request' });
    }
    assert.deepEqual(lookups, []);
  });

  it('rate-limits each real client address, behind a trusted proxy too', async (t) => {
    const { join, login } = await gateway(t, { trustedProxies: ['127.0.0.1'] });
    const token = await login('Carol');
    const from = (client) => ({ 'X-Forwarded-For': client });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      // Unauthenticated attempts count too, so tokens cannot be guessed past the limit.
      const response = await join(attempt % 2 ? token : undefined, undefined, from('203.0.113.7'));
      assert.notEqual(response.status, 429, `attempt ${attempt + 1}`);
    }
    const limited = await join(token, undefined, from('203.0.113.7'));
    assert.equal(limited.status, 429);
    assert.deepEqual(JSON.parse(limited.body), { error: 'too_many_requests' });
    assert.equal((await join(token, undefined, from('203.0.113.8'))).status, 202, 'another client has its own budget');
  });

  it('ignores X-Forwarded-For from an untrusted peer when rate-limiting', async (t) => {
    const { join, login } = await gateway(t);
    const token = await login('Carol');
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await join(token, undefined, { 'X-Forwarded-For': `198.51.100.${attempt}` });
    }
    assert.equal((await join(token, undefined, { 'X-Forwarded-For': '198.51.100.250' })).status, 429);
  });

  it('refuses joins once shutdown has started', async (t) => {
    const { server, store, login, join, grantForAlice } = await gateway(t);
    await grantForAlice();
    const token = await login('Carol');
    await server.closeWebSockets();
    const response = await join(token);
    assert.equal(response.status, 503);
    assert.deepEqual(JSON.parse(response.body), { error: 'shutting_down' });
    assert.equal(store.get('item-1').joins, undefined);
  });

  it('serves the page on household hostnames with a strict content security policy', async (t) => {
    const { baseUrl } = await gateway(t);
    const page = await send(baseUrl, JOIN_PATH, {});
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /^text\/html/);
    assert.match(page.headers['content-security-policy'], /default-src 'none'; script-src 'self'/);
    assert.match(page.body, /Add to my library/);
    assert.match(page.body, /src="\/jellypass\/add\.js"/);
    for (const asset of ['/jellypass/add.js', '/jellypass/add.css']) {
      assert.equal((await send(baseUrl, asset, {})).status, 200, asset);
    }
    assert.doesNotMatch((await send(baseUrl, '/jellypass/add.js', {})).body, /innerHTML/);
  });

  it('leaves the paths to Jellyfin when Seerr lookup is not configured', async (t) => {
    const { baseUrl, jellyfin } = await gateway(t, { seerr: false });
    const page = await send(baseUrl, JOIN_PATH, {});
    assert.equal(page.status, 401, 'the fake Jellyfin answers unauthenticated requests itself');
    assert.equal(jellyfin.requestedPaths.at(-1), JOIN_PATH);
  });
});

/**
 * Holds the shared write queue with an administrator change until the returned function is called; it resolves once
 * the change has finished.
 */
function holdWriteQueue({ client, service }) {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const getUsers = client.getUsers.bind(client);
  client.getUsers = async () => {
    await held;
    return getUsers();
  };
  const queued = service.setUserPasswordless('nobody-id', true).catch(() => undefined);
  return () => {
    release();
    return queued;
  };
}

/** Rejects if `promise` has not settled within `ms`, so a response that waits on held work fails instead of hanging. */
function within(ms, promise) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`no response within ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function comparableHeaders(headers) {
  const { date: _date, connection: _connection, 'keep-alive': _keepAlive, ...rest } = headers;
  return rest;
}

function send(baseUrl, pathname, options, host = HOUSEHOLD_HOST) {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: url.hostname, port: url.port, path: pathname, method: options.method ?? 'GET', headers: { ...options.headers, Host: host } }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.once('error', reject);
    request.end(options.body);
  });
}

function jellyfinAuthorization(token) {
  return `MediaBrowser Client="JellyPass Test", Device="Test", DeviceId="jellypass-join-test", Version="1.0.0"${token ? `, Token="${encodeURIComponent(token)}"` : ''}`;
}
