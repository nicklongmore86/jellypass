import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AccessService, accessTag } from '../dist/access-service.js';
import { JellyfinClient } from '../dist/jellyfin.js';
import { makeServer } from '../dist/server.js';
import { GrantStore } from '../dist/store.js';

const baseUrl = process.env.JELLYFIN_REAL_URL;
const webhookToken = 'real-webhook-secret';

describe('real Jellyfin integration', { timeout: 90_000, skip: !baseUrl }, () => {
  let fixture;
  let client;
  let store;
  let server;

  before(async () => {
    fixture = await setupJellyfin(baseUrl);
    store = new GrantStore(path.join(await mkdtemp(path.join(tmpdir(), 'jfa-real-')), 'grants.json'));
    await store.load();
    client = new JellyfinClient(baseUrl, fixture.token);
    // No Seerr client: webhooks must carry an HD event to be trusted.
    server = makeServer(new AccessService(client, store), { webhook: webhookToken, admin: 'real-admin-secret' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
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

  it('grants and revokes access on Jellyfin for an HD Now Available webhook', async () => {
    const granted = await sendWebhook(server, available('real-17', 'Movie Request Now Available'));
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.equal(granted.body.status, 'granted');
    assert.ok(store.get(fixture.itemId));

    const taggedItem = await client.getItem(fixture.itemId);
    const grantedUsers = await client.getUsers();
    assert.ok(taggedItem.Tags.includes(accessTag(fixture.itemId)));
    assert.ok(user(grantedUsers, fixture.bobId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));
    assert.ok(!user(grantedUsers, fixture.aliceId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));

    const revoked = await fetch(`${serverUrl(server)}/v1/grants/${fixture.itemId}/requests/real-17`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer real-admin-secret' },
    });
    assert.ok(revoked.ok, await revoked.text());
    const cleanedItem = await client.getItem(fixture.itemId);
    const cleanedUsers = await client.getUsers();
    assert.ok(!cleanedItem.Tags.includes(accessTag(fixture.itemId)));
    assert.ok(!user(cleanedUsers, fixture.bobId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));
  });
});

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
