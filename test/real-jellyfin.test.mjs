import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AccessService, accessTag } from '../dist/access-service.js';
import { JellyfinClient } from '../dist/jellyfin.js';
import { GrantStore } from '../dist/store.js';
import { parseWebhook } from '../dist/webhook.js';

const baseUrl = process.env.JELLYFIN_REAL_URL;

describe('real Jellyfin integration', { timeout: 90_000 }, () => {
  it('grants and revokes access on Jellyfin 10.11', { skip: !baseUrl }, async () => {
    const fixture = await setupJellyfin(baseUrl);
    const stateFile = path.join(await mkdtemp(path.join(tmpdir(), 'jfa-real-')), 'grants.json');
    const store = new GrantStore(stateFile);
    await store.load();
    const client = new JellyfinClient(baseUrl, fixture.token);
    const service = new AccessService(client, store);

    await service.processWebhook(parseWebhook({
      notificationType: 'MEDIA_AVAILABLE',
      media: { jellyfinMediaId: fixture.itemId, mediaType: 'movie' },
      request: { id: 'real-17', requestedBy: { jellyfinUserId: fixture.aliceId } },
    }));

    const taggedItem = await client.getItem(fixture.itemId);
    const grantedUsers = await client.getUsers();
    assert.ok(taggedItem.Tags.includes(accessTag(fixture.itemId)));
    assert.ok(user(grantedUsers, fixture.bobId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));
    assert.ok(!user(grantedUsers, fixture.aliceId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));

    await service.revokeRequest(fixture.itemId, 'real-17');
    const cleanedItem = await client.getItem(fixture.itemId);
    const cleanedUsers = await client.getUsers();
    assert.ok(!cleanedItem.Tags.includes(accessTag(fixture.itemId)));
    assert.ok(!user(cleanedUsers, fixture.bobId).Policy.BlockedTags.includes(accessTag(fixture.itemId)));
  });
});

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
  return { token, aliceId: alice.Id, bobId: bob.Id, itemId: item.Id };
}

async function request(url, pathname, options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.body) headers['Content-Type'] = 'application/json';
  if (options.token) headers['X-Emby-Token'] = options.token;
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
