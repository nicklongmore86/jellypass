import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AccessService, accessTag } from '../dist/access-service.js';
import { JellyfinClient } from '../dist/jellyfin.js';
import { makeServer } from '../dist/server.js';
import { GrantStore } from '../dist/store.js';
import { makeTempDir } from './support/temp-dir.mjs';

const baseUrl = process.env.JELLYFIN_REAL_URL;
const webhookToken = 'real-webhook-secret';

describe('real Jellyfin integration', { timeout: 90_000, skip: !baseUrl }, () => {
  let fixture;
  let client;
  let store;
  let server;
  let seerrStore;
  let seerrService;
  let seerrServer;
  // Seerr's GET /api/v1/request/:id answers, by request ID. A request made in 2000 predates the availability journal
  // (judged new, as 2.2.1 did); one made after a catalog sync saw the movie is late.
  const requests = new Map();
  const seerr = { getRequest: async (requestId) => structuredClone(requests.get(String(requestId))) };
  const seerrRequest = (requestId, createdAt, tmdbId) => {
    requests.set(requestId, {
      id: requestId,
      status: 5,
      type: 'movie',
      is4k: false,
      createdAt,
      requestedBy: { jellyfinUserId: fixture.aliceId },
      media: { mediaType: 'movie', status: 5, jellyfinMediaId: fixture.itemId, ...(tmdbId ? { tmdbId } : {}) },
    });
  };

  before(async () => {
    fixture = await setupJellyfin(baseUrl);
    store = new GrantStore(path.join(await makeTempDir(null, 'jfa-real-'), 'grants.json'));
    await store.load();
    client = new JellyfinClient(baseUrl, fixture.token);
    // No Seerr client: webhooks must carry an HD event to be trusted, and can only join request grants.
    server = makeServer(new AccessService(client, store), { webhook: webhookToken, admin: 'real-admin-secret' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    seerrStore = new GrantStore(path.join(await makeTempDir(null, 'jfa-real-seerr-'), 'grants.json'));
    await seerrStore.load();
    seerrService = new AccessService(client, seerrStore, undefined, seerr);
    seerrServer = makeServer(seerrService, { webhook: webhookToken, admin: 'real-admin-secret' });
    await new Promise((resolve) => seerrServer.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (seerrServer) await new Promise((resolve) => seerrServer.close(resolve));
  });

  const available = (requestId, event) => ({
    notificationType: 'MEDIA_AVAILABLE',
    ...(event === undefined ? {} : { event }),
    media: { jellyfinMediaId: fixture.itemId, mediaType: 'movie' },
    request: { id: requestId, requestedBy: { jellyfinUserId: fixture.aliceId } },
  });

  it('rejects a Seerr-less webhook without a recognised HD event and grants nothing', async () => {
    for (const [requestId, event] of [['real-16', undefined], ['real-16b', 'Something Else']]) {
      assert.deepEqual(await sendWebhook(server, available(requestId, event)), {
        status: 502,
        body: { error: 'webhook event does not name an HD request and Seerr lookup is not configured' },
      }, String(event));
    }

    assert.equal(store.get(fixture.itemId), undefined);
    const item = await client.getItem(fixture.itemId);
    const users = await client.getUsers();
    assert.ok(!item.Tags.includes(accessTag(fixture.itemId)));
    assert.ok(!user(users, fixture.bobId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));
  });

  it('grants nothing for a Seerr-less HD webhook, which cannot be told apart from a late request', async () => {
    assert.deepEqual(await sendWebhook(server, available('real-16c', 'Movie Request Now Available')), {
      status: 202,
      body: { status: 'ignored' },
    });
    assert.equal(store.get(fixture.itemId), undefined);
    assert.ok(!(await client.getItem(fixture.itemId)).Tags.includes(accessTag(fixture.itemId)));
    assert.ok(!user(await client.getUsers(), fixture.bobId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));
  });

  it('records what a catalog sync and a poll see, and judges a request made after that late', async () => {
    const { titles, episodes } = await client.fetchAvailability();
    const movie = titles.find((title) => title.itemId === fixture.itemId);
    assert.ok(movie, JSON.stringify(titles));
    assert.equal(movie.mediaType, 'movie');
    assert.deepEqual(movie.qualities, ['hd']);
    assert.deepEqual(episodes, []);
    // Jellyfin's last-saved filter finds the movie when asked from before it was added, and nothing from later on.
    assert.ok((await client.fetchSavedSince(new Date('2000-01-01T00:00:00.000Z'))).titles.some((title) => title.itemId === fixture.itemId));
    assert.deepEqual(await client.fetchSavedSince(new Date(Date.now() + 3_600_000)), { titles: [], episodes: [] });

    await seerrService.syncLibraryCatalog();
    assert.equal(seerrService.hasAvailabilityJournal(), true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Seerr knows the movie by the TMDB ID Jellyfin matched, if it matched one.
    seerrRequest('real-late', new Date().toISOString(), movie.tmdbId);
    for (const event of ['Movie Now Available', 'Movie Request Now Available']) {
      assert.deepEqual(await sendWebhook(seerrServer, available('real-late', event)), { status: 202, body: { status: 'ignored' } }, event);
    }
    assert.equal(seerrStore.get(fixture.itemId), undefined);
    assert.ok(!(await client.getItem(fixture.itemId)).Tags.includes(accessTag(fixture.itemId)));
    assert.ok(!user(await client.getUsers(), fixture.bobId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));
    // The poll overlaps the sync by two minutes, so it may see the just-scanned movie again; it changes nothing.
    const polled = await seerrService.pollAvailability();
    assert.ok(polled.titles <= 1 && polled.episodes === 0, JSON.stringify(polled));
    assert.equal(seerrStore.get(fixture.itemId), undefined);
  });

  it('answers an unknown item ID with a 404, the only status JellyPass treats as a deleted item', async () => {
    const unknownId = randomUUID().replaceAll('-', '');
    await assert.rejects(client.getItem(unknownId), (error) => error.status === 404);
  });

  it('grants and revokes access on Jellyfin for a new request\'s HD Now Available webhook', async () => {
    seerrRequest('real-17', '2000-01-01T00:00:00.000Z');
    const granted = await sendWebhook(seerrServer, available('real-17', 'Movie Request Now Available'));
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.equal(granted.body.status, 'granted');
    assert.ok(seerrStore.get(fixture.itemId));

    const taggedItem = await client.getItem(fixture.itemId);
    const grantedUsers = await client.getUsers();
    assert.ok(taggedItem.Tags.includes(accessTag(fixture.itemId)));
    assert.ok(user(grantedUsers, fixture.bobId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));
    assert.ok(!user(grantedUsers, fixture.aliceId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));

    const revoked = await fetch(`${serverUrl(seerrServer)}/v1/grants/${fixture.itemId}/requests/real-17`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer real-admin-secret' },
    });
    assert.ok(revoked.ok, await revoked.text());
    const cleanedItem = await client.getItem(fixture.itemId);
    const cleanedUsers = await client.getUsers();
    assert.ok(!cleanedItem.Tags.includes(accessTag(fixture.itemId)));
    assert.ok(!user(cleanedUsers, fixture.bobId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));
  });

  it('lets a signed-in user add a household title to their library, checking their token with Jellyfin', async (t) => {
    // Alice's household requested the movie; Bob belongs to no household and signs in on Jellyfin itself.
    const joinStore = new GrantStore(path.join(await makeTempDir(t, 'jfa-real-join-'), 'grants.json'));
    await joinStore.load();
    await joinStore.upsertGroup({ id: 'realhouse', name: 'Real House', userIds: [fixture.aliceId] });
    const joinSeerr = {
      ...seerr,
      getJellyfinItemId: async (mediaType, tmdbId) => (mediaType === 'movie' && tmdbId === 603 ? fixture.itemId : undefined),
    };
    const service = new AccessService(client, joinStore, undefined, joinSeerr);
    const gateway = makeServer(service, { webhook: webhookToken, admin: 'real-admin-secret' }, undefined, {
      householdGateway: { jellyfinUrl: baseUrl, domain: 'example.test', hostPrefix: 'jelly-' },
    });
    await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => gateway.close(resolve)));
    seerrRequest('real-18', '2000-01-01T00:00:00.000Z');
    const granted = await sendWebhook(gateway, available('real-18', 'Movie Request Now Available'));
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.ok(user(await client.getUsers(), fixture.bobId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));

    const join = (authorization) => postWithHost(gateway, '/jellypass/add', 'jelly-realhouse.example.test', authorization, { mediaType: 'movie', tmdbId: 603 });
    assert.equal((await join(undefined)).status, 401);
    assert.equal((await join('MediaBrowser Client="jfa-test", Device="ci", DeviceId="jfa-real-join", Version="1.0", Token="not-a-token"')).status, 401);
    assert.equal(joinStore.get(fixture.itemId).joins, undefined);

    const bob = await request(baseUrl, '/Users/AuthenticateByName', {
      method: 'POST',
      authorization: 'MediaBrowser Client="jfa-test", Device="ci", DeviceId="jfa-real-bob", Version="1.0"',
      body: { Username: 'Bob', Pw: '' },
    });
    // The page sends only the token, as Jellyfin web stored it, so Jellyfin does not rename the user's web session.
    const accepted = await join(`MediaBrowser Token="${bob.AccessToken}"`);
    assert.deepEqual(accepted, { status: 202, body: { status: 'accepted' } });
    // The join runs after the answer.
    await waitFor(async () => joinStore.get(fixture.itemId).manualUserIds.includes(fixture.bobId.toLowerCase()));
    assert.deepEqual(joinStore.get(fixture.itemId).manualUserIds, [fixture.bobId.toLowerCase()]);
    await waitFor(async () => !user(await client.getUsers(), fixture.bobId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));
    const item = await request(baseUrl, `/Users/${fixture.bobId}/Items/${fixture.itemId}`, { token: bob.AccessToken });
    assert.equal(item.Id, fixture.itemId);
  });
});

function postWithHost(server, pathname, host, authorization, body) {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: pathname,
      method: 'POST',
      headers: { Host: host, 'Content-Type': 'application/json', ...(authorization ? { Authorization: authorization } : {}) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    outgoing.once('error', reject);
    outgoing.end(JSON.stringify(body));
  });
}

function serverUrl(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

async function sendWebhook(server, body) {
  const response = await fetch(`${serverUrl(server)}/webhooks/seerr`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${webhookToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, body: await response.json() };
}

async function setupJellyfin(url) {
  await waitFor(async () => (await request(url, '/System/Info/Public')).Version === '10.11.3');
  await request(url, '/Startup/User');
  await request(url, '/Startup/Configuration', {
    method: 'POST',
    body: { UICulture: 'en-US', MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en' },
  });
  await request(url, '/Startup/User', { method: 'POST', body: { Name: 'admin', Password: 'test-password' } });
  await request(url, '/Startup/Complete', { method: 'POST' });
  const authentication = await request(url, '/Users/AuthenticateByName', {
    method: 'POST',
    authorization: 'MediaBrowser Client="jfa-test", Device="ci", DeviceId="jfa-real-ci", Version="1.0"',
    body: { Username: 'admin', Pw: 'test-password' },
  });
  const token = authentication.AccessToken;
  const alice = await request(url, '/Users/New', { method: 'POST', token, body: { Name: 'Alice', Password: '' } });
  const bob = await request(url, '/Users/New', { method: 'POST', token, body: { Name: 'Bob', Password: '' } });
  await request(url, '/Library/VirtualFolders?name=Movies&collectionType=movies&paths=%2Fmedia&refreshLibrary=true', {
    method: 'POST',
    token,
  });
  let item;
  await waitFor(async () => {
    const result = await request(url, '/Items?Recursive=true&SearchTerm=Test%20Movie&IncludeItemTypes=Movie', { token });
    item = result.Items?.[0];
    return !!item;
  });
  await waitFor(async () => {
    const libraries = await request(url, '/Library/VirtualFolders', { token });
    const movies = libraries.find((library) => library.Name === 'Movies');
    return movies?.RefreshStatus === 'Idle';
  });
  return { token, aliceId: alice.Id, bobId: bob.Id, itemId: item.Id };
}

async function request(url, pathname, options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.token) {
    headers.Authorization = `MediaBrowser Client="jfa-test", Device="ci", DeviceId="jfa-real-ci", Version="1.0", Token="${encodeURIComponent(options.token)}"`;
  }
  if (options.authorization) headers.Authorization = options.authorization;
  const response = await fetch(`${url}${pathname}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${pathname} returned ${response.status}: ${await response.text()}`);
  if (response.status === 204) return undefined;
  return response.json();
}

async function waitFor(predicate) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw lastError ?? new Error('timed out waiting for Jellyfin');
}

function user(users, id) {
  const found = users.find((entry) => entry.Id === id);
  assert.ok(found, `user ${id} should exist`);
  return found;
}
