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
    assert.deepEqual(parseWebhook({ notificationType: 'MEDIA_AVAILABLE', request: { id: '136' } }), {
      notificationType: 'MEDIA_AVAILABLE',
      request: { id: '136' },
    });
  });
});

describe('state migration', () => {
  it('migrates v1 grants to active, pending v5 records', async () => {
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
    assert.deepEqual(grant.manualUserIds, []);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 5);
  });

  it('adds manual audiences, catalog, and claims while migrating v2 state to v5', async () => {
    const file = await stateFile();
    await writeFile(file, JSON.stringify({
      version: 2,
      grants: {
        'item-1': {
          itemId: 'item-1', active: true, owners: ['alice-id'], requests: { '17': 'alice-id' },
          groupIds: [], sync: { state: 'synced', attempts: 0 }, updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      groups: {},
    }));
    const store = new GrantStore(file);
    await store.load();
    assert.deepEqual(store.get('item-1').manualUserIds, []);
    const migrated = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(migrated.version, 5);
    assert.deepEqual(migrated.catalog.items, {});
    assert.deepEqual(migrated.claims, {});
  });

  it('preserves v3 grants while adding the v5 catalog and claims', async () => {
    const file = await stateFile();
    await writeFile(file, JSON.stringify({
      version: 3,
      grants: {
        'item-1': {
          itemId: 'item-1', active: true, owners: ['bob-id'], requests: {}, manualUserIds: ['bob-id'],
          groupIds: [], sync: { state: 'synced', attempts: 0 }, updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
      groups: {},
    }));
    const store = new GrantStore(file);
    await store.load();
    assert.deepEqual(store.get('item-1').manualUserIds, ['bob-id']);
    const migrated = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(migrated.version, 5);
    assert.deepEqual(migrated.catalog, { items: {} });
    assert.deepEqual(migrated.claims, {});
  });

  it('preserves v4 state while adding an empty claim registry', async () => {
    const file = await stateFile();
    await writeFile(file, JSON.stringify({ version: 4, grants: {}, groups: {}, catalog: { items: {} } }));
    const store = new GrantStore(file);
    await store.load();
    const migrated = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(migrated.version, 5);
    assert.deepEqual(migrated.claims, {});
  });
});

describe('grant lifecycle', () => {
  it('joins pending requests and grants the whole title to every claimant when available', async () => {
    const store = new GrantStore(await stateFile());
    await store.load();
    const fake = fakeJellyfin();
    const service = new AccessService(fake, store);

    const pending = await service.claimMediaAccess('bob-id', 'tv', 1399);
    assert.equal(pending.claimed, true);
    assert.equal(pending.jellyfinItemId, undefined);
    assert.deepEqual(service.listMediaClaims('bob-id').map((claim) => claim.tmdbId), [1399]);

    const grant = await service.processWebhook(parseWebhook(webhook({ mediaType: 'tv', tmdbId: 1399 })));
    assert.deepEqual(grant.owners, ['alice-id', 'bob-id']);
    assert.equal(service.getMediaAccess('bob-id', 'tv', 1399).owned, true);
    assert.equal(service.listMediaClaims('bob-id')[0].jellyfinItemId, 'item-1');
  });

  it('adds a user to an existing private title without creating another request', async () => {
    const store = new GrantStore(await stateFile());
    await store.load();
    const fake = fakeJellyfin();
    const service = new AccessService(fake, store);

    await service.processWebhook(parseWebhook(webhook({ tmdbId: 101 })));
    const access = await service.claimMediaAccess('bob-id', 'movie', 101, 'item-1');
    assert.equal(access.owned, true);
    assert.deepEqual(store.get('item-1').manualUserIds, ['bob-id']);
    assert.equal(Object.keys(store.get('item-1').requests).length, 1);
    assert.deepEqual(fake.user('bob-id').Policy.BlockedTags, ['other']);
  });

  it('syncs the catalog and consolidates bulk access into one policy write per user', async () => {
    const store = new GrantStore(await stateFile());
    await store.load();
    const fake = fakeJellyfin();
    const service = new AccessService(fake, store);

    const catalog = await service.syncLibraryCatalog();
    assert.equal(catalog.items.length, 2);
    assert.equal(service.getLibraryCatalog().items.every((item) => !item.managed), true);
    const preview = await service.setBulkManualAccess({ itemIds: ['item-1', 'item-2'], userIds: ['bob-id'], groupIds: [] }, true);
    assert.equal(preview.plans.length, 2);
    assert.equal(store.list().length, 0);

    await service.setBulkManualAccess({ itemIds: ['item-1', 'item-2'], userIds: ['bob-id'], groupIds: [] });
    assert.equal(fake.policyUpdates, 1);
    assert.deepEqual(fake.user('alice-id').Policy.BlockedTags, ['other', 'jfa:private:item-1', 'jfa:private:item-2']);
    assert.deepEqual(fake.item.Tags, ['keep-me', 'jfa:private:item-1']);
    assert.deepEqual(fake.item2.Tags, ['jfa:private:item-2']);
    assert.equal(service.getLibraryCatalog().items.every((item) => item.managed), true);
  });

  it('searches and retroactively protects library media for selected users', async () => {
    const store = new GrantStore(await stateFile());
    await store.load();
    const fake = fakeJellyfin();
    const service = new AccessService(fake, store);

    assert.deepEqual(await service.searchLibrary('mov'), [{ id: 'item-1', name: 'Movie', mediaType: 'movie', productionYear: 2026 }]);
    const preview = await service.setManualAccess({ itemId: 'item-1', mediaType: 'movie', userIds: ['bob-id'], groupIds: [] }, true);
    assert.equal(store.get('item-1'), undefined);
    assert.deepEqual(preview.plan.owners, ['bob-id']);
    assert.equal(preview.plan.item.action, 'add_tag');
    assert.equal(preview.plan.users.find((change) => change.userId === 'alice-id').action, 'block');

    await service.setManualAccess({ itemId: 'item-1', mediaType: 'movie', userIds: ['bob-id'], groupIds: [] });
    assert.deepEqual(store.get('item-1').manualUserIds, ['bob-id']);
    assert.deepEqual(fake.item.Tags, ['keep-me', 'jfa:private:item-1']);
    assert.deepEqual(fake.user('alice-id').Policy.BlockedTags, ['other', 'jfa:private:item-1']);
    assert.deepEqual(fake.user('bob-id').Policy.BlockedTags, ['other']);
  });

  it('protects local trailers and discovers trailers added after the original grant', async () => {
    const store = new GrantStore(await stateFile());
    await store.load();
    const fake = fakeJellyfin();
    fake.addLocalTrailer('item-1', { Id: 'trailer-1', Name: 'Movie Trailer', Type: 'Trailer', Tags: ['keep-trailer'] });
    const service = new AccessService(fake, store);

    const grant = await service.processWebhook(parseWebhook(webhook()));
    assert.equal(grant.sync.state, 'synced');
    assert.deepEqual(fake.trailer('trailer-1').Tags, ['keep-trailer', 'jfa:private:item-1']);

    fake.addLocalTrailer('item-1', { Id: 'trailer-2', Name: 'New Trailer', Type: 'Trailer', Tags: [] });
    const plans = await service.reconcileAll();
    assert.equal(plans[0].relatedItems.find((item) => item.itemId === 'trailer-2').action, 'add_tag');
    assert.deepEqual(fake.trailer('trailer-2').Tags, ['jfa:private:item-1']);

    await service.revokeRequest('item-1', '17');
    assert.deepEqual(fake.trailer('trailer-1').Tags, ['keep-trailer']);
    assert.deepEqual(fake.trailer('trailer-2').Tags, []);
  });

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

  it('resolves legacy Jellyseerr webhooks through the request API', async () => {
    const store = new GrantStore(await stateFile());
    await store.load();
    const fake = fakeJellyfin();
    const seerr = {
      async getRequest(requestId) {
        assert.equal(requestId, '136');
        return {
          id: 136,
          is4k: false,
          requestedBy: { jellyfinUserId: 'alice-id' },
          media: { jellyfinMediaId: 'item-1', mediaType: 'movie', tmdbId: 101 },
        };
      },
    };
    const service = new AccessService(fake, store, undefined, seerr);

    await service.claimMediaAccess('bob-id', 'movie', 101);
    const grant = await service.processWebhook(parseWebhook({ notificationType: 'MEDIA_AVAILABLE', request: { id: '136' } }));
    assert.equal(grant.requests['136'], 'alice-id');
    assert.deepEqual(grant.owners, ['alice-id', 'bob-id']);
    assert.deepEqual(fake.item.Tags, ['keep-me', 'jfa:private:item-1']);
  });
});

function webhook(overrides = {}) {
  return {
    notificationType: 'MEDIA_AVAILABLE',
    media: {
      jellyfinMediaId: overrides.mediaId ?? 'item-1',
      mediaType: overrides.mediaType ?? 'movie',
      ...(overrides.tmdbId ? { tmdbId: overrides.tmdbId } : {}),
    },
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
  const localTrailers = new Map();
  let policyUpdates = 0;
  return {
    item: { Id: 'item-1', Name: 'Movie', Tags: ['keep-me'] },
    item2: { Id: 'item-2', Name: 'Series', Tags: [] },
    get policyUpdates() { return policyUpdates; },
    user(id) {
      return users.find((user) => user.Id === id);
    },
    trailer(id) {
      return [...localTrailers.values()].flat().find((trailer) => trailer.Id === id);
    },
    addLocalTrailer(itemId, trailer) {
      localTrailers.set(itemId, [...(localTrailers.get(itemId) ?? []), structuredClone(trailer)]);
    },
    async searchLibrary() {
      return [{ id: 'item-1', name: 'Movie', mediaType: 'movie', productionYear: 2026 }];
    },
    async fetchLibraryCatalog() {
      return [
        { id: 'item-1', name: 'Movie', mediaType: 'movie', productionYear: 2026, libraryId: 'movies', libraryName: 'Movies' },
        { id: 'item-2', name: 'Series', mediaType: 'series', productionYear: 2025, libraryId: 'shows', libraryName: 'TV Shows' },
      ];
    },
    async getItem(itemId = 'item-1') {
      return structuredClone(itemId === 'item-2' ? this.item2 : this.item);
    },
    async getItems(itemIds) {
      return Promise.all(itemIds.map((itemId) => this.getItem(itemId)));
    },
    async getUsers() {
      return structuredClone(users);
    },
    async getLocalTrailers(itemId) {
      return structuredClone(localTrailers.get(itemId) ?? []);
    },
    async updateItem(item) {
      if (item.Id === 'item-1') this.item = structuredClone(item);
      else if (item.Id === 'item-2') this.item2 = structuredClone(item);
      else {
        for (const [parentId, trailers] of localTrailers) {
          const index = trailers.findIndex((trailer) => trailer.Id === item.Id);
          if (index === -1) continue;
          trailers[index] = structuredClone(item);
          localTrailers.set(parentId, trailers);
          return;
        }
        throw new Error(`item not found: ${item.Id}`);
      }
    },
    async updatePolicy(userId, policy) {
      policyUpdates += 1;
      const user = users.find((entry) => entry.Id === userId);
      user.Policy = structuredClone(policy);
    },
  };
}

async function stateFile() {
  return path.join(await mkdtemp(path.join(tmpdir(), 'jfa-test-')), 'grants.json');
}
