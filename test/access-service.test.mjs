import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AccessService, accessTag, sameStringSet } from '../dist/access-service.js';
import { SeerrClient } from '../dist/seerr.js';
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

  it('ignores non-availability events without validating their IDs', async () => {
    assert.deepEqual(parseWebhook({ notificationType: 'TEST_NOTIFICATION', request: { id: '' } }), { notificationType: 'TEST_NOTIFICATION' });
    assert.deepEqual(parseWebhook({ notificationType: 'MEDIA_PENDING' }), { notificationType: 'MEDIA_PENDING' });
    assert.throws(() => parseWebhook({ notificationType: 'MEDIA_AVAILABLE', request: { id: '' } }), /id must be a non-empty string/);
    assert.throws(() => parseWebhook({ notificationType: 'MEDIA_AVAILABLE' }), /request must be an object/);
    assert.throws(() => parseWebhook({ notificationType: 'MEDIA_AVAILABLE', request: { id: '{{request_id}}' } }), /invalid/);
    assert.throws(() => parseWebhook({ request: { id: '1' } }), /notificationType/);

    const store = new GrantStore(await stateFile());
    await store.load();
    const service = new AccessService(fakeJellyfin(), store);
    assert.equal(await service.processWebhook(parseWebhook({ notificationType: 'TEST_NOTIFICATION', request: { id: '' } })), null);
    assert.equal(store.list().length, 0);
    assert.match(service.renderMetrics(), /jfa_webhooks_total\{result="ignored"\} 1/);
  });
});

describe('state migration', () => {
  it('migrates v1 grants to active, pending v6 records', async () => {
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
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 6);
  });

  it('adds manual audiences, catalog, and claims while migrating v2 state to v6', async () => {
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
    assert.equal(migrated.version, 6);
    assert.deepEqual(migrated.catalog.items, {});
    assert.deepEqual(migrated.claims, {});
  });

  it('preserves v3 grants while adding the v6 catalog, claims, and passwordless list', async () => {
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
    assert.equal(migrated.version, 6);
    assert.deepEqual(migrated.catalog, { items: {} });
    assert.deepEqual(migrated.claims, {});
    assert.deepEqual(migrated.passwordlessUserIds, []);
  });

  it('preserves v4 state while adding an empty claim registry', async () => {
    const file = await stateFile();
    await writeFile(file, JSON.stringify({ version: 4, grants: {}, groups: {}, catalog: { items: {} } }));
    const store = new GrantStore(file);
    await store.load();
    const migrated = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(migrated.version, 6);
    assert.deepEqual(migrated.claims, {});
    assert.deepEqual(migrated.passwordlessUserIds, []);
  });

  it('preserves v5 state while adding an empty passwordless user list', async () => {
    const file = await stateFile();
    const claims = { 'movie:1': { mediaType: 'movie', tmdbId: 1, userIds: ['alice-id'], updatedAt: '2026-01-01T00:00:00.000Z' } };
    await writeFile(file, JSON.stringify({ version: 5, grants: {}, groups: {}, catalog: { items: {} }, claims }));
    const store = new GrantStore(file);
    await store.load();
    const migrated = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(migrated.version, 6);
    assert.deepEqual(migrated.claims, claims);
    assert.deepEqual(migrated.passwordlessUserIds, []);
    await store.setUserPasswordless('Alice-ID', true);
    await store.setUserPasswordless('bob-id', true);
    await store.setUserPasswordless('bob-id', false);
    assert.deepEqual(store.listPasswordlessUserIds(), ['alice-id']);
    const reloaded = new GrantStore(file);
    await reloaded.load();
    assert.deepEqual(reloaded.listPasswordlessUserIds(), ['alice-id']);
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

describe('household-scoped request grants', () => {
  async function twoHouseholds() {
    const store = new GrantStore(await stateFile());
    await store.load();
    const fake = fakeJellyfin({ extraUsers: [{ Id: 'carol-id', Name: 'Carol' }, { Id: 'dave-id', Name: 'Dave' }] });
    const service = new AccessService(fake, store);
    await service.upsertGroup({ id: 'house-a', name: 'House A', userIds: ['alice-id', 'bob-id'] });
    await service.upsertGroup({ id: 'house-b', name: 'House B', userIds: ['carol-id'] });
    return { store, fake, service };
  }

  it('shares a webhook grant with the requester household and blocks other households', async () => {
    const { store, fake, service } = await twoHouseholds();

    const grant = await service.processWebhook(parseWebhook(webhook()));
    assert.deepEqual(grant.groupIds, ['house-a']);
    assert.deepEqual(grant.requests, { '17': 'alice-id' });
    assert.deepEqual(grant.owners, ['alice-id', 'bob-id']);
    assert.deepEqual(fake.user('bob-id').Policy.BlockedTags, ['other']);
    assert.deepEqual(fake.user('carol-id').Policy.BlockedTags, ['jfa:private:item-1']);
    assert.deepEqual(fake.user('dave-id').Policy.BlockedTags, ['jfa:private:item-1']);
    assert.equal(store.get('item-1').sync.state, 'synced');
  });

  it('keeps a user-only grant when the requester belongs to no household', async () => {
    const { fake, service } = await twoHouseholds();

    const grant = await service.processWebhook(parseWebhook(webhook({ userId: 'dave-id' })));
    assert.deepEqual(grant.groupIds, []);
    assert.deepEqual(grant.owners, ['dave-id']);
    assert.deepEqual(fake.user('bob-id').Policy.BlockedTags, ['other', 'jfa:private:item-1']);
    assert.deepEqual(fake.user('dave-id').Policy.BlockedTags, []);
  });

  it('attaches every household of a requester who belongs to several', async () => {
    const { service } = await twoHouseholds();
    await service.upsertGroup({ id: 'house-b', name: 'House B', userIds: ['carol-id', 'alice-id'] });

    const grant = await service.processWebhook(parseWebhook(webhook()));
    assert.deepEqual(grant.groupIds, ['house-a', 'house-b']);
    assert.deepEqual(grant.owners, ['alice-id', 'bob-id', 'carol-id']);
  });

  it('preserves manually assigned groups and users when a request is granted', async () => {
    const { store, fake, service } = await twoHouseholds();
    await service.setManualAccess({ itemId: 'item-1', mediaType: 'movie', userIds: ['dave-id'], groupIds: ['house-b'] });

    const grant = await service.processWebhook(parseWebhook(webhook()));
    assert.deepEqual(grant.groupIds, ['house-a', 'house-b']);
    assert.deepEqual(grant.manualUserIds, ['dave-id']);
    assert.deepEqual(store.get('item-1').owners, ['alice-id', 'bob-id', 'carol-id', 'dave-id']);
    assert.deepEqual(fake.user('carol-id').Policy.BlockedTags, []);
  });
});

describe('Seerr request backfill', () => {
  const since = new Date('2026-10-01T00:00:00.000Z');

  function seerrRequest(id, overrides = {}) {
    return {
      id,
      type: 'movie',
      is4k: false,
      createdAt: '2026-10-10T00:00:00.000Z',
      requestedBy: { displayName: 'Alice', jellyfinUserId: 'alice-id' },
      media: { mediaType: 'movie', tmdbId: 1000 + id, status: 5, jellyfinMediaId: 'item-1' },
      ...overrides,
    };
  }

  async function withSeerr(listed, details, run) {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/api/v1/request') {
        const skip = Number(url.searchParams.get('skip'));
        const take = Number(url.searchParams.get('take'));
        return Response.json({ pageInfo: { results: listed.length }, results: listed.slice(skip, skip + take) });
      }
      const match = url.pathname.match(/^\/api\/v1\/request\/(\d+)$/);
      if (match && details[match[1]]) return Response.json(details[match[1]]);
      return new Response('boom', { status: 500 });
    };
    try {
      const store = new GrantStore(await stateFile());
      await store.load();
      const fake = fakeJellyfin({ extraUsers: [{ Id: 'carol-id', Name: 'Carol' }] });
      const service = new AccessService(fake, store, undefined, new SeerrClient('http://seerr.test', 'key'));
      await service.upsertGroup({ id: 'house-a', name: 'House A', userIds: ['alice-id', 'bob-id'] });
      await service.upsertGroup({ id: 'house-b', name: 'House B', userIds: ['carol-id'] });
      await run({ store, fake, service, calls });
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  it('grants available requests since the cutoff to the requester household and skips the rest', async () => {
    const listed = [
      seerrRequest(206, { media: { mediaType: 'movie', tmdbId: 1206, status: 5 }, requestedBy: {} }),
      seerrRequest(205, { media: { mediaType: 'movie', tmdbId: 1205, status: 5 }, requestedBy: {} }),
      seerrRequest(204, { requestedBy: { jellyfinUserId: 'ghost-id' }, media: { mediaType: 'tv', tmdbId: 1204, status: 5, jellyfinMediaId: 'item-2' } }),
      seerrRequest(203, { media: { mediaType: 'tv', tmdbId: 1203, status: 3, jellyfinMediaId: 'item-2' } }),
      seerrRequest(202, { requestedBy: { jellyfinUserId: 'bob-id' }, media: { mediaType: 'movie', tmdbId: 1201, status: 4, jellyfinMediaId: 'item-1' } }),
      seerrRequest(201, { media: { mediaType: 'movie', tmdbId: 1201, status: 4, jellyfinMediaId: 'item-1' } }),
      seerrRequest(200, { createdAt: '2026-09-30T23:59:59.000Z', media: { mediaType: 'tv', tmdbId: 1200, status: 5, jellyfinMediaId: 'item-2' } }),
    ];
    // 206 resolves to nothing; 205's lookup fails outright.
    const details = { 206: { id: 206, media: { mediaType: 'movie' } } };
    await withSeerr(listed, details, async ({ store, fake, service, calls }) => {
      const result = await service.backfillRequests(since);
      assert.equal(result.scanned, 6);
      assert.deepEqual(result.granted, ['item-1']);
      assert.equal(result.failed, 1);
      assert.equal(result.skipped, 4);

      const grant = store.get('item-1');
      assert.deepEqual(grant.requests, { '201': 'alice-id' });
      assert.deepEqual(grant.groupIds, ['house-a']);
      assert.equal(grant.sync.state, 'synced');
      assert.deepEqual(fake.item.Tags, ['keep-me', 'jfa:private:item-1']);
      assert.deepEqual(fake.user('bob-id').Policy.BlockedTags, ['other']);
      assert.deepEqual(fake.user('carol-id').Policy.BlockedTags, ['jfa:private:item-1']);
      assert.equal(store.get('item-2'), undefined, 'pre-cutoff, unavailable and unknown-requester items stay public');
      assert.deepEqual(fake.item2.Tags, []);
      assert.ok(calls.includes('/api/v1/request/206'));
      assert.ok(calls.includes('/api/v1/request/205'));

      const metrics = service.renderMetrics();
      assert.match(metrics, /jfa_request_backfill_total\{result="granted"\} 1/);
      assert.match(metrics, /jfa_request_backfill_total\{result="error"\} 1/);
      assert.match(metrics, /jfa_request_backfill_last_run_timestamp_seconds \d{10}/);

      const again = await service.backfillRequests(since);
      assert.deepEqual(again.granted, []);
      assert.deepEqual(store.get('item-1').requests, { '201': 'alice-id' });
    });
  });

  it('leaves existing grants and their manual audience untouched', async () => {
    const listed = [seerrRequest(301, { requestedBy: { jellyfinUserId: 'carol-id' } })];
    await withSeerr(listed, {}, async ({ store, service }) => {
      await service.setManualAccess({ itemId: 'item-1', mediaType: 'movie', userIds: ['bob-id'], groupIds: ['house-a'] });
      const before = store.get('item-1');

      const result = await service.backfillRequests(since);
      assert.deepEqual(result.granted, []);
      assert.equal(result.skipped, 1);
      const after = store.get('item-1');
      assert.deepEqual(after.requests, {});
      assert.deepEqual(after.groupIds, before.groupIds);
      assert.deepEqual(after.manualUserIds, ['bob-id']);
    });
  });

  it('does not re-create a grant an administrator removed after a webhook or backfill', async () => {
    const listed = [seerrRequest(401)];
    await withSeerr(listed, {}, async ({ store, service }) => {
      assert.deepEqual((await service.backfillRequests(since)).granted, ['item-1']);
      await service.revokeRequest('item-1', '401');
      await service.setGrantGroups('item-1', []);
      assert.equal(store.get('item-1'), undefined);

      const result = await service.backfillRequests(since);
      assert.deepEqual(result.granted, []);
      assert.equal(store.get('item-1'), undefined);
    });
  });

  it('stops paging once a whole page predates the cutoff', async () => {
    const recent = Array.from({ length: 50 }, (_, index) => seerrRequest(600 - index, { media: { status: 3 } }));
    const old = Array.from({ length: 60 }, (_, index) => seerrRequest(500 - index, { createdAt: '2026-01-01T00:00:00.000Z' }));
    await withSeerr([...recent, ...old], {}, async ({ service, calls }) => {
      const result = await service.backfillRequests(since);
      assert.equal(result.scanned, 50);
      assert.deepEqual(calls.filter((call) => call.startsWith('/api/v1/request?')), [
        '/api/v1/request?take=50&skip=0&sort=added',
        '/api/v1/request?take=50&skip=50&sort=added',
      ]);
    });
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

function fakeJellyfin({ extraUsers = [] } = {}) {
  const users = [
    { Id: 'alice-id', Name: 'Alice', Policy: { BlockedTags: ['other'] } },
    { Id: 'bob-id', Name: 'Bob', Policy: { BlockedTags: ['other'] } },
    { Id: 'admin-id', Name: 'Admin', Policy: { IsAdministrator: true, BlockedTags: [] } },
    ...extraUsers.map((user) => ({ Policy: { BlockedTags: [] }, ...user })),
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
