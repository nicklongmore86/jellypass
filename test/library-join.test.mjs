import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AccessService } from '../dist/access-service.js';
import { JellyfinClient } from '../dist/jellyfin.js';
import { makeServer } from '../dist/server.js';
import { GrantStore } from '../dist/store.js';
import { createFakeJellyfin } from './support/fake-jellyfin.mjs';
import { makeTempDir } from './support/temp-dir.mjs';

const HOUSEHOLD_HOST = 'jelly-farmhouse.example.test';
const JOIN_PATH = '/jellypass/add';

describe('household "Add to my library"', { timeout: 10_000 }, () => {
  // TMDB movie 603 is item-1, movie 604 is item-2, movie 404 is not in the library and movie 500 fails to resolve.
  async function gateway(t, { seerr = true, trustedProxies, minResponseMs = 0 } = {}) {
    const jellyfin = await createFakeJellyfin();
    t.after(() => jellyfin.close());
    const store = new GrantStore(path.join(await makeTempDir(t, 'jfa-join-test-'), 'grants.json'));
    await store.load();
    const client = new JellyfinClient(jellyfin.url, 'test-key');
    const carol = await client.createUser('Carol', 'user-password');
    const dave = await client.createUser('Dave', 'user-password');
    await store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: ['alice-id', 'bob-id'] });
    await store.upsertGroup({ id: 'cottage', name: 'Cottage', userIds: [carol.Id] });
    const lookups = [];
    const seerrClient = seerr ? {
      async getJellyfinItemId(mediaType, tmdbId) {
        lookups.push(`${mediaType}/${tmdbId}`);
        if (tmdbId === 500) throw new Error('Seerr GET /api/v1/movie/500 returned 500');
        return { 'movie/603': 'item-1', 'movie/604': 'item-2' }[`${mediaType}/${tmdbId}`];
      },
    } : undefined;
    const service = new AccessService(client, store, undefined, seerrClient);
    const server = makeServer(service, { webhook: 'webhook-secret', admin: 'admin-secret' }, undefined, {
      ...(trustedProxies ? { trustedProxies } : {}),
      householdGateway: { jellyfinUrl: jellyfin.url, domain: 'example.test', hostPrefix: 'jelly-', libraryJoinMinResponseMs: minResponseMs },
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
    // Each join's reconciliation runs after the response; any later service call waits for it.
    const settled = () => service.planGrant('item-1').catch(() => undefined);
    return { jellyfin, store, service, server, baseUrl, login, join, grantForAlice, settled, lookups, carol, dave };
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
    assert.deepEqual(store.get('item-1').groupIds, ['farmhouse']);

    // Carol's own token decides who joins, whatever user ID the body names.
    const token = await login('Carol');
    const accepted = await join(token, { mediaType: 'movie', tmdbId: 603, userId: 'bob-id', groupIds: ['farmhouse'] });
    assert.equal(accepted.status, 202);
    await settled();
    const grant = store.get('item-1');
    assert.deepEqual(grant.groupIds, ['cottage', 'farmhouse']);
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
    await service.setManualAccess({ itemId: 'item-2', mediaType: 'movie', userIds: [], groupIds: ['farmhouse'] });
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
    await service.setManualAccess({ itemId: 'item-2', userIds: [], groupIds: ['farmhouse'] });
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
      for (const secret of ['alice', 'farmhouse', 'cottage', 'item-1', 'item-2', '17', carol.Id]) {
        assert.ok(!response.body.toLowerCase().includes(secret), `${label} must not mention ${secret}`);
      }
    }
    const metrics = service.renderMetrics();
    assert.match(metrics, /jfa_library_joins_total\{result="joined"\} 1\n/);
    assert.match(metrics, /jfa_library_joins_total\{result="unchanged"\} 6\n/);
    assert.match(metrics, /jfa_library_joins_total\{result="error"\} 1\n/);
    assert.doesNotMatch(metrics.split('\n').filter((line) => line.startsWith('jfa_library_joins_total')).join('\n'), /item|tmdb|farmhouse|cottage/);
  });

  it('takes at least the minimum response time whichever case applies', async (t) => {
    const { login, join, grantForAlice } = await gateway(t, { minResponseMs: 150 });
    await grantForAlice();
    const token = await login('Carol');
    for (const tmdbId of [404, 604, 603]) {
      const startedAt = performance.now();
      assert.equal((await join(token, { mediaType: 'movie', tmdbId })).status, 202);
      assert.ok(performance.now() - startedAt >= 145, String(tmdbId));
    }
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
