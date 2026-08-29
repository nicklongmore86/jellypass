import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AccessService, accessTag, sameStringSet } from '../dist/access-service.js';
import { GrantStore } from '../dist/store.js';
import { parseWebhook } from '../dist/webhook.js';

describe('access tags and webhook validation', () => {
  it('uses stable tags and compares them without case or order sensitivity', () => {
    assert.equal(accessTag('ABC-123'), 'jfa:private:abc-123');
    assert.equal(sameStringSet(['Family', 'Private'], ['private', 'family']), true);
    assert.equal(sameStringSet(['Family'], ['Family', 'Private']), false);
  });

  it('parses valid events and rejects unresolved template variables', () => {
    const event = parseWebhook(webhook());
    assert.equal(event.request.requestedBy.jellyfinUserId, 'alice-id');
    assert.throws(() => parseWebhook(webhook({ mediaId: '{{media_jellyfinMediaId}}' })), /invalid/);
  });
});

describe('state migration', () => {
  it('migrates v1 grants to active, pending v2 records', async () => {
    const file = await stateFile();
    await writeFile(file, JSON.stringify({
      version: 1,
      grants: {
        'item-1': {
          itemId: 'item-1',
          owners: ['alice-id'],
          requests: { '17': 'alice-id' },
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    }));
    const store = new GrantStore(file);
    await store.load();
    const grant = store.get('item-1');
    assert.equal(grant.active, true);
    assert.deepEqual(grant.groupIds, []);
    assert.equal(grant.sync.state, 'pending');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 2);
  });
});

describe('grant lifecycle', () => {
  it('supports household sharing, dry runs, revocation, and last-owner cleanup', async () => {
    const store = new GrantStore(await stateFile());
    await store.load();
    const fake = fakeJellyfin();
    const service = new AccessService(fake, store);

    await service.processWebhook(parseWebhook(webhook()));
    assert.deepEqual(fake.item.Tags, ['keep-me', 'jfa:private:item-1']);
    assert.deepEqual(fake.user('bob-id').Policy.BlockedTags, ['other', 'jfa:private:item-1']);
    assert.equal(store.get('item-1').sync.state, 'synced');

    await service.upsertGroup({ id: 'household', name: 'Household', userIds: ['bob-id'] });
    await service.setGrantGroups('item-1', ['household']);
    assert.deepEqual(fake.user('bob-id').Policy.BlockedTags, ['other']);

    const dryRun = await service.revokeRequest('item-1', '17', true);
    assert.deepEqual(dryRun.plan.owners, ['bob-id']);
    assert.equal(store.get('item-1').requests['17'], 'alice-id');

    await service.revokeRequest('item-1', '17');
    assert.deepEqual(store.get('item-1').owners, ['bob-id']);
    assert.deepEqual(fake.user('alice-id').Policy.BlockedTags, ['other', 'jfa:private:item-1']);

    await service.setGrantGroups('item-1', []);
    assert.equal(store.get('item-1'), undefined);
    assert.deepEqual(fake.item.Tags, ['keep-me']);
    assert.deepEqual(fake.user('alice-id').Policy.BlockedTags, ['other']);
    assert.deepEqual(fake.user('bob-id').Policy.BlockedTags, ['other']);
  });

  it('persists failed synchronization status for a later retry', async () => {
    const store = new GrantStore(await stateFile());
    await store.load();
    const fake = fakeJellyfin();
    fake.updateItem = async () => { throw new Error('Jellyfin unavailable'); };
    const service = new AccessService(fake, store);

    await assert.rejects(() => service.processWebhook(parseWebhook(webhook())), /unavailable/);
    const grant = store.get('item-1');
    assert.equal(grant.sync.state, 'error');
    assert.equal(grant.sync.attempts, 1);
    assert.match(grant.sync.lastError, /unavailable/);
    assert.ok(grant.sync.nextRetryAt);
  });
});

function webhook(overrides = {}) {
  return {
    notificationType: 'MEDIA_AVAILABLE',
    media: { jellyfinMediaId: overrides.mediaId ?? 'item-1', mediaType: 'movie' },
    request: {
      id: overrides.requestId ?? '17',
      requestedBy: { jellyfinUserId: overrides.userId ?? 'alice-id', username: 'Alice' },
    },
  };
}

function fakeJellyfin() {
  const users = [
    { Id: 'alice-id', Name: 'Alice', Policy: { BlockedTags: ['other'] } },
    { Id: 'bob-id', Name: 'Bob', Policy: { BlockedTags: ['other'] } },
    { Id: 'admin-id', Name: 'Admin', Policy: { IsAdministrator: true, BlockedTags: [] } },
  ];
  return {
    item: { Id: 'item-1', Name: 'Movie', Tags: ['keep-me'] },
    user(id) {
      return users.find((user) => user.Id === id);
    },
    async getItem() {
      return structuredClone(this.item);
    },
    async getUsers() {
      return structuredClone(users);
    },
    async updateItem(item) {
      this.item = structuredClone(item);
    },
    async updatePolicy(userId, policy) {
      const user = users.find((entry) => entry.Id === userId);
      user.Policy = structuredClone(policy);
    },
  };
}

async function stateFile() {
  return path.join(await mkdtemp(path.join(tmpdir(), 'jfa-test-')), 'grants.json');
}
