import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AccessService, accessTag, sameStringSet } from '../dist/access-service.js';
import { SeerrClient } from '../dist/seerr.js';
import { GrantStore } from '../dist/store.js';
import { parseWebhook } from '../dist/webhook.js';
import { makeTempDir } from './support/temp-dir.mjs';

describe('access tags and webhook validation', () => {
  it('uses stable tags and compares them without case or order sensitivity', () => {
    assert.equal(accessTag('ABC-123'), 'jfa:private:abc-123');
    assert.equal(sameStringSet(['Family', 'Private'], ['private', 'family']), true);
    assert.equal(sameStringSet(['Family'], ['Family', 'Private']), false);
  });

  it('parses valid events and rejects unresolved template variables', () => {
    const event = parseWebhook(webhook());
    assert.equal(event.request.requestedBy.jellyfinUserId, 'alice-id');
    assert.equal(event.request.is4k, false);
    for (const mediaType of ['Movie', 'Series']) {
      for (const request of [' Request', '']) {
        const text = `${mediaType}${request} Now Available`;
        assert.equal(parseWebhook(webhook({ event: text })).request.is4k, false, text);
        assert.equal(parseWebhook(webhook({ event: `4K ${text}` })).request.is4k, true, `4K ${text}`);
      }
    }
    assert.equal(parseWebhook(webhook({ event: '  4K Movie Now Available\n' })).request.is4k, true);
    assert.equal(parseWebhook(webhook({ event: ' Series Request Now Available ' })).request.is4k, false);
    for (const unknown of [null, 4, true, { text: 'Movie Now Available' }, '{{event}}', '', 'Something else', '4k Movie Now Available', 'Movie Request Now Available!']) {
      assert.equal('is4k' in parseWebhook(webhook({ event: unknown })).request, false, String(unknown));
    }
    // Payloads built from older templates may still send a TMDB ID; it is ignored, even if malformed.
    const withTmdb = webhook();
    withTmdb.media.tmdbId = 'not-a-number';
    assert.deepEqual(parseWebhook(withTmdb).media, { jellyfinMediaId: 'item-1', mediaType: 'movie' });
    assert.throws(() => parseWebhook(webhook({ mediaId: '{{media_jellyfinMediaId}}' })), /invalid/);
    assert.deepEqual(parseWebhook({ notificationType: 'MEDIA_AVAILABLE', request: { id: '136' } }), {
      notificationType: 'MEDIA_AVAILABLE',
      request: { id: '136' },
    });
  });

  it('ignores non-availability events without validating their IDs', async (t) => {
    assert.deepEqual(parseWebhook({ notificationType: 'TEST_NOTIFICATION', request: { id: '' } }), { notificationType: 'TEST_NOTIFICATION' });
    assert.deepEqual(parseWebhook({ notificationType: 'MEDIA_PENDING' }), { notificationType: 'MEDIA_PENDING' });
    assert.throws(() => parseWebhook({ notificationType: 'MEDIA_AVAILABLE', request: { id: '' } }), /id must be a non-empty string/);
    assert.throws(() => parseWebhook({ notificationType: 'MEDIA_AVAILABLE' }), /request must be an object/);
    assert.throws(() => parseWebhook({ notificationType: 'MEDIA_AVAILABLE', request: { id: '{{request_id}}' } }), /invalid/);
    assert.throws(() => parseWebhook({ request: { id: '1' } }), /notificationType/);
    assert.throws(() => parseWebhook({ notificationType: '{{notification_type}}', request: { id: '' } }), /notificationType is invalid/);
    assert.throws(() => parseWebhook({ notificationType: 'media_available' }), /notificationType is invalid/);
    assert.throws(() => parseWebhook({ notificationType: 'TEST NOTIFICATION' }), /notificationType is invalid/);

    const store = new GrantStore(await stateFile(t));
    await store.load();
    const service = new AccessService(fakeJellyfin(), store);
    assert.equal(await service.processWebhook(parseWebhook({ notificationType: 'TEST_NOTIFICATION', request: { id: '' } })), null);
    assert.equal(store.list().length, 0);
    assert.match(service.renderMetrics(), /jfa_webhooks_total\{result="ignored"\} 1/);
  });
});

describe('state file persistence', () => {
  it('applies concurrent passwordless updates without losing a write', async (t) => {
    const file = await stateFile(t);
    const store = new GrantStore(file);
    await store.load();
    const extraUsers = Array.from({ length: 20 }, (_, index) => ({ Id: `member-${index}`, Name: `Member ${index}` }));
    const service = new AccessService(fakeJellyfin({ extraUsers }), store);
    const results = await Promise.allSettled(extraUsers.map((user) => service.setUserPasswordless(user.Id, true)));
    assert.deepEqual(results.filter((result) => result.status === 'rejected').map((result) => result.reason.message), []);
    const expected = extraUsers.map((user) => user.Id).sort();
    assert.deepEqual(store.listPasswordlessUserIds(), expected);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(saved.passwordlessUserIds, expected);
    assert.deepEqual((await readdir(path.dirname(file))).sort(), ['grants.json']);
  });

  it('queues a passwordless update behind other service mutations', async (t) => {
    const store = new GrantStore(await stateFile(t));
    await store.load();
    const fake = fakeJellyfin();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const getItem = fake.getItem;
    fake.getItem = async function gatedGetItem(itemId) {
      await gate;
      return getItem.call(this, itemId);
    };
    const service = new AccessService(fake, store);
    const order = [];
    const webhookDone = service.processWebhook(parseWebhook(webhook())).then(() => order.push('webhook'));
    const passwordlessDone = service.setUserPasswordless('bob-id', true).then(() => order.push('passwordless'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, [], 'the passwordless update waits for the running webhook');
    release();
    await Promise.all([webhookDone, passwordlessDone]);
    assert.deepEqual(order, ['webhook', 'passwordless']);
  });

  it('delivers a failed write to every coalesced caller and keeps writing afterwards', async (t) => {
    const file = await stateFile(t);
    const store = new GrantStore(file);
    await store.load();
    // A non-empty directory at the state path makes the rename fail.
    await rm(file);
    await mkdir(path.join(file, 'blocker'), { recursive: true });
    const results = await Promise.allSettled(['a', 'b', 'c'].map((id) => store.setUserPasswordless(`member-${id}`, true)));
    assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected', 'rejected']);
    assert.equal(new Set(results.map((result) => result.reason)).size, 1, 'the callers share one write');

    await rm(file, { recursive: true });
    await store.setUserPasswordless('member-d', true);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.deepEqual(saved.passwordlessUserIds, ['member-a', 'member-b', 'member-c', 'member-d']);
    assert.deepEqual((await readdir(path.dirname(file))).sort(), ['grants.json']);
  });

  it('serializes overlapping store writes and leaves the newest state on disk', async (t) => {
    const file = await stateFile(t);
    const store = new GrantStore(file);
    await store.load();
    await store.upsertGroup({ id: 'house-a', name: 'House A', userIds: ['alice-id'] });
    const writes = [];
    for (let index = 0; index < 20; index += 1) {
      writes.push(store.setUserPasswordless(`member-${index}`, true));
      writes.push(store.grant({ itemId: `item-${index}`, requestId: String(100 + index), userId: 'alice-id', groupIds: ['house-a'] }));
    }
    const results = await Promise.allSettled(writes);
    assert.deepEqual(results.filter((result) => result.status === 'rejected').map((result) => result.reason.message), []);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.passwordlessUserIds.length, 20);
    assert.equal(Object.keys(saved.grants).length, 20);
    assert.equal(saved.handledRequestIds.length, 20);
    const reloaded = new GrantStore(file);
    await reloaded.load();
    assert.deepEqual(reloaded.list().map((grant) => grant.itemId).sort(), Object.keys(saved.grants).sort());
    assert.deepEqual((await readdir(path.dirname(file))).sort(), ['grants.json']);
  });
});

describe('state migration', () => {
  it('migrates v1 grants to active, pending v6 records', async (t) => {
    const file = await stateFile(t);
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
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 7);
  });

  it('adds manual audiences and catalog while migrating v2 state to v7', async (t) => {
    const file = await stateFile(t);
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
    assert.equal(migrated.version, 7);
    assert.deepEqual(migrated.catalog.items, {});
    assert.equal('claims' in migrated, false);
  });

  it('preserves v3 grants while adding the v7 catalog and passwordless list', async (t) => {
    const file = await stateFile(t);
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
    assert.equal(migrated.version, 7);
    assert.deepEqual(migrated.catalog, { items: {} });
    assert.equal('claims' in migrated, false);
    assert.deepEqual(migrated.passwordlessUserIds, []);
  });

  it('preserves v4 state while adding an empty passwordless user list', async (t) => {
    const file = await stateFile(t);
    await writeFile(file, JSON.stringify({ version: 4, grants: {}, groups: {}, catalog: { items: {} } }));
    const store = new GrantStore(file);
    await store.load();
    const migrated = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(migrated.version, 7);
    assert.equal('claims' in migrated, false);
    assert.deepEqual(migrated.passwordlessUserIds, []);
  });

  it('migrates v5 state to v7, dropping claims and adding an empty passwordless user list', async (t) => {
    const file = await stateFile(t);
    const claims = { 'movie:1': { mediaType: 'movie', tmdbId: 1, userIds: ['alice-id'], updatedAt: '2026-01-01T00:00:00.000Z' } };
    await writeFile(file, JSON.stringify({ version: 5, grants: {}, groups: {}, catalog: { items: {} }, claims }));
    const store = new GrantStore(file);
    await store.load();
    const migrated = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(migrated.version, 7);
    assert.equal('claims' in migrated, false);
    assert.deepEqual(migrated.passwordlessUserIds, []);
    await store.setUserPasswordless('Alice-ID', true);
    await store.setUserPasswordless('bob-id', true);
    await store.setUserPasswordless('bob-id', false);
    assert.deepEqual(store.listPasswordlessUserIds(), ['alice-id']);
    const reloaded = new GrantStore(file);
    await reloaded.load();
    assert.deepEqual(reloaded.listPasswordlessUserIds(), ['alice-id']);
  });

  it('loads v5 and v6 state that has no claim registry', async (t) => {
    for (const version of [5, 6]) {
      const file = await stateFile(t);
      await writeFile(file, JSON.stringify({
        version,
        grants: {
          'item-1': {
            itemId: 'item-1', active: true, owners: ['alice-id'], requests: { '17': 'alice-id' }, manualUserIds: [],
            groupIds: [], sync: { state: 'synced', attempts: 0 }, updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        groups: {},
        catalog: { items: {} },
        ...(version === 6 ? { passwordlessUserIds: [] } : {}),
      }));
      const store = new GrantStore(file);
      await store.load();
      assert.deepEqual(store.get('item-1').owners, ['alice-id'], `v${version}`);
      assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 7);
    }
  });

  it('rejects a newer state schema and leaves the file untouched', async (t) => {
    const file = await stateFile(t);
    const contents = JSON.stringify({ version: 8, grants: {}, groups: {}, catalog: { items: {} }, passwordlessUserIds: [], future: true });
    await writeFile(file, contents);
    await assert.rejects(new GrantStore(file).load(), /unsupported state schema version/);
    assert.equal(await readFile(file, 'utf8'), contents);
  });

  it('migrates v6 state to v7 by dropping claims and keeping grants that came from claims', async (t) => {
    const file = await stateFile(t);
    // Bob claimed item-1 before it became available, so 1.1.0 added him as a manual user.
    const grants = {
      'item-1': {
        itemId: 'item-1', active: true, mediaType: 'movie', owners: ['alice-id', 'bob-id'], requests: { '17': 'alice-id' },
        manualUserIds: ['bob-id'], groupIds: [], sync: { state: 'synced', attempts: 0 }, updatedAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const claims = {
      'movie:101': {
        mediaType: 'movie', tmdbId: 101, userIds: ['bob-id'], claimedAt: { 'bob-id': '2026-01-01T00:00:00.000Z' },
        jellyfinItemId: 'item-1', updatedAt: '2026-01-01T00:00:00.000Z',
      },
      'tv:1399': { mediaType: 'tv', tmdbId: 1399, userIds: ['carol-id'], updatedAt: '2026-01-02T00:00:00.000Z' },
    };
    await writeFile(file, JSON.stringify({
      version: 6, grants, groups: {}, catalog: { items: {} }, claims, passwordlessUserIds: ['carol-id'], handledRequestIds: ['17'],
    }));
    const store = new GrantStore(file);
    await store.load();

    const migrated = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(migrated.version, 7);
    assert.equal('claims' in migrated, false);
    assert.deepEqual(migrated.grants, grants);
    assert.deepEqual(migrated.passwordlessUserIds, ['carol-id']);
    assert.deepEqual(migrated.handledRequestIds, ['17']);
    assert.doesNotMatch(JSON.stringify(migrated), /tmdbId|claimedAt|1399/);

    // The claimant stays an ordinary manual user when another request lands on the title.
    const service = new AccessService(fakeJellyfin(), store);
    const grant = await service.processWebhook(parseWebhook(webhook({ requestId: '18' })));
    assert.deepEqual(grant.manualUserIds, ['bob-id']);
    assert.deepEqual(grant.owners, ['alice-id', 'bob-id']);

    const reloaded = new GrantStore(file);
    await reloaded.load();
    assert.deepEqual(reloaded.get('item-1').owners, ['alice-id', 'bob-id']);
  });
});

describe('grant lifecycle', () => {
  it('syncs the catalog and consolidates bulk access into one policy write per user', async (t) => {
    const store = new GrantStore(await stateFile(t));
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

  it('searches and retroactively protects library media for selected users', async (t) => {
    const store = new GrantStore(await stateFile(t));
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

  it('protects local trailers and discovers trailers added after the original grant', async (t) => {
    const store = new GrantStore(await stateFile(t));
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

  it('supports household sharing, dry runs, revocation, and last-owner cleanup', async (t) => {
    const store = new GrantStore(await stateFile(t));
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

  it('persists failed synchronization status for a later retry', async (t) => {
    const store = new GrantStore(await stateFile(t));
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

  it('resolves webhooks without Jellyfin IDs through the Seerr request API', async (t) => {
    const store = new GrantStore(await stateFile(t));
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

    const grant = await service.processWebhook(parseWebhook({ notificationType: 'MEDIA_AVAILABLE', request: { id: '136' } }));
    assert.equal(grant.requests['136'], 'alice-id');
    assert.deepEqual(grant.owners, ['alice-id']);
    assert.deepEqual(fake.item.Tags, ['keep-me', 'jfa:private:item-1']);
  });
});

describe('webhooks without Seerr lookup', () => {
  async function serviceWithoutSeerr() {
    const store = new GrantStore(await stateFile());
    await store.load();
    const fake = fakeJellyfin();
    return { store, fake, service: new AccessService(fake, store) };
  }

  it('rejects a 4K event instead of granting the payload item, and counts it as an error', async () => {
    const { store, fake, service } = await serviceWithoutSeerr();
    for (const event of ['4K Movie Request Now Available', '4K Movie Now Available']) {
      await assert.rejects(
        () => service.processWebhook(parseWebhook(webhook({ event }))),
        /4K request and Seerr lookup is not configured/,
      );
    }
    assert.equal(store.list().length, 0);
    assert.deepEqual(fake.item.Tags, ['keep-me']);
    assert.match(service.renderMetrics(), /jfa_webhooks_total\{result="error"\} 2/);
  });

  it('counts a webhook missing Jellyfin IDs as an error', async () => {
    const { store, service } = await serviceWithoutSeerr();
    await assert.rejects(
      () => service.processWebhook(parseWebhook({ notificationType: 'MEDIA_AVAILABLE', request: { id: '136' } })),
      /missing Jellyfin IDs and Seerr lookup is not configured/,
    );
    assert.equal(store.list().length, 0);
    assert.match(service.renderMetrics(), /jfa_webhooks_total\{result="error"\} 1/);
  });

  it('grants the payload item only for a recognized HD event', async () => {
    const { store, service } = await serviceWithoutSeerr();
    await service.processWebhook(parseWebhook(webhook({ event: 'Movie Now Available' })));
    await service.processWebhook(parseWebhook(webhook({ event: 'Series Request Now Available', requestId: '18' })));
    assert.deepEqual(store.get('item-1').requests, { '17': 'alice-id', '18': 'alice-id' });
    assert.match(service.renderMetrics(), /jfa_webhooks_total\{result="granted"\} 2/);
  });

  it('rejects a missing, empty, unfilled or unrecognized event, which may be a 4K request', async () => {
    // Seerr fills {{media_jellyfinMediaId}} with the HD item even for a 4K request, so trusting
    // these payloads could privatize the HD item and leave the 4K item public.
    const events = [null, '', '   ', '{{event}}', 'Movie Request Approved', 'Now Available'];
    const { store, fake, service } = await serviceWithoutSeerr();
    for (const event of events) {
      await assert.rejects(
        () => service.processWebhook(parseWebhook(webhook({ event }))),
        /^Error: webhook event does not name an HD request and Seerr lookup is not configured$/,
        String(event),
      );
    }
    assert.equal(store.list().length, 0);
    assert.equal(store.hasHandledRequest('17'), false);
    assert.deepEqual(fake.item.Tags, ['keep-me']);
    const metrics = service.renderMetrics();
    assert.match(metrics, new RegExp(`jfa_webhooks_total\\{result="error"\\} ${events.length}\n`));
    assert.doesNotMatch(metrics, /result="granted"/);
  });
});

describe('webhook outcome accounting', () => {
  it('counts a grant that cannot be persisted once as an error', async (t) => {
    const store = new GrantStore(await stateFile(t));
    await store.load();
    const fake = fakeJellyfin();
    const service = new AccessService(fake, store);
    store.grant = async () => {
      throw new Error('EACCES: permission denied, open state.json.tmp');
    };
    await assert.rejects(() => service.processWebhook(parseWebhook(webhook())), /EACCES/);
    const metrics = service.renderMetrics();
    assert.match(metrics, /jfa_webhooks_total\{result="error"\} 1\n/);
    assert.doesNotMatch(metrics, /result="granted"|result="invalid"/);
    assert.deepEqual(fake.item.Tags, ['keep-me']);
  });

  it('counts a grant that is stored but cannot be reconciled once as an error', async (t) => {
    const store = new GrantStore(await stateFile(t));
    await store.load();
    const fake = fakeJellyfin();
    fake.updateItem = async () => {
      throw new Error('Jellyfin unavailable');
    };
    const service = new AccessService(fake, store);
    await assert.rejects(() => service.processWebhook(parseWebhook(webhook())), /Jellyfin unavailable/);
    const metrics = service.renderMetrics();
    assert.match(metrics, /jfa_webhooks_total\{result="error"\} 1\n/);
    assert.doesNotMatch(metrics, /result="granted"/);
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

describe('replayed webhooks', () => {
  async function twoHouseholds() {
    const store = new GrantStore(await stateFile());
    await store.load();
    const fake = fakeJellyfin({ extraUsers: [{ Id: 'carol-id', Name: 'Carol' }] });
    const service = new AccessService(fake, store);
    await service.upsertGroup({ id: 'house-a', name: 'House A', userIds: ['alice-id', 'bob-id'] });
    await service.upsertGroup({ id: 'house-b', name: 'House B', userIds: ['carol-id'] });
    return { store, fake, service };
  }

  it('does not recreate a grant whose last audience an administrator removed', async () => {
    const { store, fake, service } = await twoHouseholds();
    await service.processWebhook(parseWebhook(webhook()));
    await service.revokeRequest('item-1', '17');
    await service.setGrantGroups('item-1', []);
    assert.equal(store.get('item-1'), undefined);
    assert.equal(store.hasHandledRequest('17'), true);

    assert.equal(await service.processWebhook(parseWebhook(webhook())), null);
    assert.equal(await service.processWebhook(parseWebhook(webhook())), null);
    assert.equal(store.get('item-1'), undefined);
    assert.deepEqual(fake.item.Tags, ['keep-me']);
    assert.deepEqual(fake.user('carol-id').Policy.BlockedTags, []);
    const metrics = service.renderMetrics();
    assert.match(metrics, /jfa_webhooks_total\{result="granted"\} 1\n/);
    assert.match(metrics, /jfa_webhooks_total\{result="ignored"\} 2\n/);
    assert.doesNotMatch(metrics, /result="error"/);
  });

  it('does not re-add a revoked request to a grant that other audiences keep', async () => {
    const { store, service } = await twoHouseholds();
    await service.processWebhook(parseWebhook(webhook()));
    await service.setManualAccess({ itemId: 'item-1', userIds: ['carol-id'], groupIds: [] });
    await service.revokeRequest('item-1', '17');

    assert.equal(await service.processWebhook(parseWebhook(webhook())), null);
    const grant = store.get('item-1');
    assert.deepEqual(grant.requests, {});
    assert.deepEqual(grant.manualUserIds, ['carol-id']);
  });

  it('does not reattach household groups an administrator cleared from the grant', async () => {
    const { store, fake, service } = await twoHouseholds();
    await service.processWebhook(parseWebhook(webhook()));
    await service.setGrantGroups('item-1', []);
    assert.deepEqual(fake.user('bob-id').Policy.BlockedTags, ['other', 'jfa:private:item-1']);

    const grant = await service.processWebhook(parseWebhook(webhook()));
    assert.deepEqual(grant.groupIds, []);
    assert.deepEqual(grant.requests, { '17': 'alice-id' });
    assert.deepEqual(store.get('item-1').groupIds, []);
    assert.deepEqual(fake.user('bob-id').Policy.BlockedTags, ['other', 'jfa:private:item-1']);
    assert.match(service.renderMetrics(), /jfa_webhooks_total\{result="granted"\} 2\n/);
  });

  it('retries a delivery whose grant was stored but not applied by reconciling it', async () => {
    const { store, fake, service } = await twoHouseholds();
    const updateItem = fake.updateItem;
    fake.updateItem = async () => {
      throw new Error('Jellyfin unavailable');
    };
    await assert.rejects(() => service.processWebhook(parseWebhook(webhook())), /Jellyfin unavailable/);
    assert.equal(store.hasHandledRequest('17'), true);
    assert.equal(store.get('item-1').sync.state, 'error');

    fake.updateItem = updateItem;
    const grant = await service.processWebhook(parseWebhook(webhook()));
    assert.deepEqual(grant.groupIds, ['house-a']);
    assert.equal(grant.sync.state, 'synced');
    assert.deepEqual(fake.item.Tags, ['keep-me', 'jfa:private:item-1']);
    const metrics = service.renderMetrics();
    assert.match(metrics, /jfa_webhooks_total\{result="error"\} 1\n/);
    assert.match(metrics, /jfa_webhooks_total\{result="granted"\} 1\n/);
  });

  it('adds a request from another household to the same title', async () => {
    const { store, fake, service } = await twoHouseholds();
    await service.processWebhook(parseWebhook(webhook()));
    const grant = await service.processWebhook(parseWebhook(webhook({ requestId: '18', userId: 'carol-id' })));
    assert.deepEqual(grant.requests, { '17': 'alice-id', '18': 'carol-id' });
    assert.deepEqual(grant.groupIds, ['house-a', 'house-b']);
    assert.deepEqual(store.get('item-1').owners, ['alice-id', 'bob-id', 'carol-id']);
    assert.deepEqual(fake.user('carol-id').Policy.BlockedTags, []);
  });

  it('grants a new request for a title after an administrator revoked an earlier one', async () => {
    const { store, fake, service } = await twoHouseholds();
    await service.processWebhook(parseWebhook(webhook()));
    await service.revokeRequest('item-1', '17');
    await service.setGrantGroups('item-1', []);
    assert.equal(store.get('item-1'), undefined);

    const grant = await service.processWebhook(parseWebhook(webhook({ requestId: '19' })));
    assert.deepEqual(grant.requests, { '19': 'alice-id' });
    assert.deepEqual(grant.groupIds, ['house-a']);
    assert.deepEqual(fake.item.Tags, ['keep-me', 'jfa:private:item-1']);
  });

  it('does not let a replay with other IDs or a 4K event change the recorded grant', async () => {
    const { store, fake, service } = await twoHouseholds();
    await service.processWebhook(parseWebhook(webhook()));
    const recorded = store.get('item-1');
    const altered = webhook({ userId: 'carol-id', mediaId: 'item-2', event: '4K Movie Request Now Available' });

    const grant = await service.processWebhook(parseWebhook(altered));
    assert.equal(grant.itemId, 'item-1');
    assert.deepEqual(grant.requests, recorded.requests);
    assert.deepEqual(grant.groupIds, recorded.groupIds);
    assert.deepEqual(grant.owners, recorded.owners);
    assert.equal(store.get('item-2'), undefined);
    assert.deepEqual(fake.item2.Tags, []);
    assert.deepEqual(fake.user('carol-id').Policy.BlockedTags, ['jfa:private:item-1']);

    await service.revokeRequest('item-1', '17');
    await service.setGrantGroups('item-1', []);
    assert.equal(await service.processWebhook(parseWebhook(altered)), null);
    assert.deepEqual(store.list(), []);
    assert.deepEqual(fake.item2.Tags, []);
    assert.doesNotMatch(service.renderMetrics(), /result="error"/);
  });

  it('retries a delivery that failed before its grant was stored as a first delivery', async () => {
    const { store, fake, service } = await twoHouseholds();
    const grant = store.grant;
    store.grant = async () => {
      throw new Error('ENOSPC: no space left on device');
    };
    await assert.rejects(() => service.processWebhook(parseWebhook(webhook())), /ENOSPC/);
    assert.equal(store.hasHandledRequest('17'), false);

    store.grant = grant;
    const created = await service.processWebhook(parseWebhook(webhook()));
    assert.deepEqual(created.requests, { '17': 'alice-id' });
    assert.deepEqual(created.groupIds, ['house-a']);
    assert.deepEqual(fake.item.Tags, ['keep-me', 'jfa:private:item-1']);
  });
});

describe('household library joins', () => {
  // TMDB movie 603 is item-1, TV 1396 is item-2, movie 404 is not in the library and movie 500 fails to resolve.
  function fakeSeerr() {
    const lookups = [];
    return {
      lookups,
      async getJellyfinItemId(mediaType, tmdbId) {
        lookups.push(`${mediaType}/${tmdbId}`);
        if (tmdbId === 500) throw new Error('Seerr GET /api/v1/movie/500 returned 500');
        return { 'movie/603': 'item-1', 'tv/1396': 'item-2' }[`${mediaType}/${tmdbId}`];
      },
    };
  }

  async function households(t) {
    const store = new GrantStore(await stateFile(t));
    await store.load();
    const fake = fakeJellyfin({ extraUsers: [{ Id: 'carol-id', Name: 'Carol' }, { Id: 'dave-id', Name: 'Dave' }] });
    const seerr = fakeSeerr();
    const service = new AccessService(fake, store, undefined, seerr);
    await service.upsertGroup({ id: 'house-a', name: 'House A', userIds: ['alice-id', 'bob-id'] });
    await service.upsertGroup({ id: 'house-b', name: 'House B', userIds: ['carol-id'] });
    const join = (userId, tmdbId = 603, mediaType = 'movie', isAdministrator = false) =>
      service.joinLibrary({ userId, isAdministrator, mediaType, tmdbId });
    return { store, fake, seerr, service, join };
  }

  it('adds the caller\'s households to a request grant and records the join', async (t) => {
    const { store, fake, service, join } = await households(t);
    await service.processWebhook(parseWebhook(webhook()));
    assert.deepEqual(fake.user('carol-id').Policy.BlockedTags, ['jfa:private:item-1']);

    assert.equal(await join('carol-id'), 'joined');
    const grant = store.get('item-1');
    assert.deepEqual(grant.requests, { '17': 'alice-id' });
    assert.deepEqual(grant.groupIds, ['house-a', 'house-b']);
    assert.deepEqual(grant.manualUserIds, []);
    assert.deepEqual(grant.owners, ['alice-id', 'bob-id', 'carol-id']);
    assert.equal(grant.joins.length, 1);
    assert.deepEqual({ ...grant.joins[0], joinedAt: undefined }, { userId: 'carol-id', groupIds: ['house-b'], userAdded: false, joinedAt: undefined });
    assert.ok(Date.parse(grant.joins[0].joinedAt) > 0);
    assert.equal(grant.sync.state, 'synced');
    assert.deepEqual(fake.user('carol-id').Policy.BlockedTags, []);
    assert.deepEqual(fake.user('dave-id').Policy.BlockedTags, ['jfa:private:item-1']);
    assert.match(service.renderMetrics(), /jfa_library_joins_total\{result="joined"\} 1\n/);
  });

  it('adds a caller who belongs to no household as a user', async (t) => {
    const { store, fake, service, join } = await households(t);
    await service.processWebhook(parseWebhook(webhook({ mediaId: 'item-2', mediaType: 'tv' })));

    assert.equal(await join('dave-id', 1396, 'tv'), 'joined');
    const grant = store.get('item-2');
    assert.deepEqual(grant.groupIds, ['house-a']);
    assert.deepEqual(grant.manualUserIds, ['dave-id']);
    assert.equal(grant.joins[0].userAdded, true);
    assert.deepEqual(grant.joins[0].groupIds, []);
    assert.deepEqual(fake.user('dave-id').Policy.BlockedTags, []);
    assert.deepEqual(fake.user('carol-id').Policy.BlockedTags, ['jfa:private:item-2']);
  });

  it('is idempotent: repeating a join changes and writes nothing', async (t) => {
    const { store, service, join } = await households(t);
    await service.processWebhook(parseWebhook(webhook()));
    assert.equal(await join('carol-id'), 'joined');
    const joined = store.get('item-1');

    for (const userId of ['carol-id', 'alice-id', 'bob-id']) assert.equal(await join(userId), 'unchanged', userId);
    assert.deepEqual(store.get('item-1'), joined);
    const metrics = service.renderMetrics();
    assert.match(metrics, /jfa_library_joins_total\{result="joined"\} 1\n/);
    assert.match(metrics, /jfa_library_joins_total\{result="unchanged"\} 3\n/);
  });

  it('leaves manual-only grants, public titles and titles outside the library untouched', async (t) => {
    const { store, fake, seerr, service, join } = await households(t);
    await service.setManualAccess({ itemId: 'item-1', mediaType: 'movie', userIds: [], groupIds: ['house-a'] });
    const manual = store.get('item-1');

    assert.equal(await join('carol-id'), 'unchanged');
    assert.equal(await join('dave-id'), 'unchanged');
    assert.equal(await join('carol-id', 1396, 'tv'), 'unchanged', 'item-2 has no grant, so it is public');
    assert.equal(await join('carol-id', 404), 'unchanged', 'not in the library');
    assert.deepEqual(store.get('item-1'), manual);
    assert.equal(store.get('item-2'), undefined);
    assert.deepEqual(fake.user('carol-id').Policy.BlockedTags, ['jfa:private:item-1']);
    assert.deepEqual(seerr.lookups, ['movie/603', 'movie/603', 'tv/1396', 'movie/404']);
  });

  it('ignores administrators, who already see every title', async (t) => {
    const { store, service, join } = await households(t);
    await service.processWebhook(parseWebhook(webhook()));
    const before = store.get('item-1');
    assert.equal(await join('admin-id', 603, 'movie', true), 'unchanged');
    assert.deepEqual(store.get('item-1'), before);
  });

  it('does not add back a household or user an administrator removed', async (t) => {
    const { store, fake, service, join } = await households(t);
    await service.processWebhook(parseWebhook(webhook()));
    await service.processWebhook(parseWebhook(webhook({ requestId: '18', userId: 'dave-id' })));
    await join('carol-id');
    await service.setGrantGroups('item-1', ['house-a']);
    await service.revokeRequest('item-1', '18');
    let grant = store.get('item-1');
    assert.deepEqual(store.getRemovals('item-1').groupIds, ['house-b']);
    assert.deepEqual(store.getRemovals('item-1').userIds, ['carol-id', 'dave-id'], 'Carol lost access with her household');
    assert.deepEqual(fake.user('carol-id').Policy.BlockedTags, ['jfa:private:item-1']);

    assert.equal(await join('carol-id'), 'unchanged');
    assert.equal(await join('dave-id'), 'unchanged');
    grant = store.get('item-1');
    assert.deepEqual(grant.groupIds, ['house-a']);
    assert.deepEqual(grant.manualUserIds, []);
    assert.deepEqual(fake.user('carol-id').Policy.BlockedTags, ['jfa:private:item-1']);
    assert.deepEqual(fake.user('dave-id').Policy.BlockedTags, ['jfa:private:item-1']);

    // Assigning them again is the administrator's call, and clears the marks.
    await service.setManualAccess({ itemId: 'item-1', userIds: ['dave-id'], groupIds: ['house-a', 'house-b'] });
    grant = store.get('item-1');
    assert.equal(store.getRemovals('item-1').groupIds, undefined);
    assert.equal(store.getRemovals('item-1').userIds, undefined);
    assert.equal(grant.joins.length, 1, 'the audit trail survives administrator edits');
  });

  it('forgets a removal mark when its group is deleted, but not the marks of the members who lost access', async (t) => {
    const { store, service, join } = await households(t);
    await service.processWebhook(parseWebhook(webhook()));
    await join('carol-id');
    await service.setGrantGroups('item-1', ['house-a']);
    await service.deleteGroup('house-b');
    assert.equal(store.getRemovals('item-1').groupIds, undefined);
    await service.upsertGroup({ id: 'house-b', name: 'New House B', userIds: ['carol-id', 'dave-id'] });
    assert.equal(await join('carol-id'), 'unchanged', 'Carol herself is still marked');
    assert.equal(await join('dave-id'), 'joined');
    assert.deepEqual(store.get('item-1').groupIds, ['house-a', 'house-b']);
  });

  it('does not let a user an administrator removed regain access by joining through a household', async (t) => {
    const { store, fake, service, join } = await households(t);
    await service.processWebhook(parseWebhook(webhook()));
    // Dave, in no household, joins as a user, and an administrator takes him off.
    assert.equal(await join('dave-id'), 'joined');
    await service.setManualAccess({ itemId: 'item-1', userIds: [], groupIds: ['house-a'] });
    assert.deepEqual(store.getRemovals('item-1').userIds, ['dave-id']);
    assert.deepEqual(fake.user('dave-id').Policy.BlockedTags, ['jfa:private:item-1']);

    // He moves into House B, which nobody removed, and joins again: nothing happens.
    await service.upsertGroup({ id: 'house-b', name: 'House B', userIds: ['carol-id', 'dave-id'] });
    assert.equal(await join('dave-id'), 'unchanged');
    assert.deepEqual(store.get('item-1').groupIds, ['house-a']);
    assert.equal(store.get('item-1').joins.length, 1);
    assert.deepEqual(fake.user('dave-id').Policy.BlockedTags, ['jfa:private:item-1']);

    // The mark is Dave's own: another member can still join House B, which then includes him.
    assert.equal(await join('carol-id'), 'joined');
    assert.deepEqual(store.get('item-1').groupIds, ['house-a', 'house-b']);
    assert.deepEqual(store.getRemovals('item-1').userIds, ['dave-id']);
    assert.deepEqual(fake.user('dave-id').Policy.BlockedTags, []);
  });

  it('does not let a member of a removed household regain access by joining after leaving it', async (t) => {
    const { store, fake, service, join } = await households(t);
    await service.processWebhook(parseWebhook(webhook()));
    assert.equal(await join('carol-id'), 'joined');
    await service.setGrantGroups('item-1', ['house-a']);
    assert.deepEqual(store.getRemovals('item-1').userIds, ['carol-id']);

    // Carol leaves House B, so she belongs to no household and would be added directly.
    await service.upsertGroup({ id: 'house-b', name: 'House B', userIds: [] });
    assert.equal(await join('carol-id'), 'unchanged');
    // Nor through a new household.
    await service.upsertGroup({ id: 'house-c', name: 'House C', userIds: ['carol-id'] });
    assert.equal(await join('carol-id'), 'unchanged');
    const grant = store.get('item-1');
    assert.deepEqual(grant.groupIds, ['house-a']);
    assert.deepEqual(grant.manualUserIds, []);
    assert.deepEqual(fake.user('carol-id').Policy.BlockedTags, ['jfa:private:item-1']);
  });

  it('skips a caller\'s removed household but adds their others', async (t) => {
    const { store, service, join } = await households(t);
    await service.processWebhook(parseWebhook(webhook()));
    await join('carol-id');
    await service.setGrantGroups('item-1', ['house-a']);
    // Dave never had access, so he is not marked; he belongs to the removed House B and to House C.
    await service.upsertGroup({ id: 'house-b', name: 'House B', userIds: ['carol-id', 'dave-id'] });
    await service.upsertGroup({ id: 'house-c', name: 'House C', userIds: ['dave-id'] });
    assert.equal(await join('dave-id'), 'joined');
    const grant = store.get('item-1');
    assert.deepEqual(grant.groupIds, ['house-a', 'house-c']);
    assert.deepEqual(grant.joins.at(-1).groupIds, ['house-c']);
  });

  it('keeps a member\'s mark when their household stays on the grant, and clears it when an administrator adds the household', async (t) => {
    const { store, service, join } = await households(t);
    await service.processWebhook(parseWebhook(webhook()));
    await join('carol-id');
    await service.setGrantGroups('item-1', ['house-a']);
    await service.setGrantGroups('item-1', ['house-a']);
    assert.deepEqual(store.getRemovals('item-1').userIds, ['carol-id']);
    await service.setGrantGroups('item-1', ['house-a', 'house-b']);
    assert.equal(store.getRemovals('item-1').userIds, undefined);
    assert.equal(store.getRemovals('item-1').groupIds, undefined);
  });

  it('reports a failed lookup or write as an error without throwing or changing anything', async (t) => {
    const { store, service, join } = await households(t);
    await service.processWebhook(parseWebhook(webhook()));
    const before = store.get('item-1');
    const errors = [];
    const originalError = console.error;
    console.error = (line) => errors.push(JSON.parse(line));
    try {
      assert.equal(await join('carol-id', 500), 'error');
      await store.close();
      assert.equal(await join('carol-id'), 'error');
    } finally {
      console.error = originalError;
    }
    assert.deepEqual(store.get('item-1'), before, 'a closed store refuses the join and memory stays unchanged');
    assert.deepEqual(errors.map((entry) => entry.message), ['library join failed', 'library join failed']);
    assert.match(errors[1].detail, /state store is closed/);
    assert.match(service.renderMetrics(), /jfa_library_joins_total\{result="error"\} 2\n/);
  });
});

describe('Seerr request backfill', () => {
  const since = new Date('2026-10-01T00:00:00.000Z');

  // Seerr v3.5.0 MediaRequestStatus: 1 pending, 2 approved, 3 declined, 4 failed, 5 completed.
  function seerrRequest(id, overrides = {}) {
    return {
      id,
      status: 2,
      type: 'movie',
      is4k: false,
      createdAt: '2026-10-10T00:00:00.000Z',
      requestedBy: { displayName: 'Alice', jellyfinUserId: 'alice-id' },
      media: { mediaType: 'movie', tmdbId: 1000 + id, status: 5, jellyfinMediaId: 'item-1' },
      ...overrides,
    };
  }

  async function withSeerr(listed, details, run, existingStore, serviceOptions) {
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
      const store = existingStore ?? new GrantStore(await stateFile());
      if (!existingStore) await store.load();
      const fake = fakeJellyfin({ extraUsers: [{ Id: 'carol-id', Name: 'Carol' }] });
      const service = new AccessService(fake, store, undefined, new SeerrClient('http://seerr.test', 'key'), serviceOptions);
      if (!existingStore) {
        await service.upsertGroup({ id: 'house-a', name: 'House A', userIds: ['alice-id', 'bob-id'] });
        await service.upsertGroup({ id: 'house-b', name: 'House B', userIds: ['carol-id'] });
      }
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
      // 202 is a second request for item-1, so it is added to the grant 201 created.
      assert.deepEqual(result.granted, ['item-1', 'item-1']);
      assert.equal(result.failed, 1);
      assert.equal(result.skipped, 3);

      const grant = store.get('item-1');
      assert.deepEqual(grant.requests, { '201': 'alice-id', '202': 'bob-id' });
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
      assert.match(metrics, /jfa_request_backfill_total\{result="granted"\} 2/);
      assert.match(metrics, /jfa_request_backfill_total\{result="error"\} 1/);
      assert.match(metrics, /jfa_request_backfill_last_run_timestamp_seconds \d{10}/);

      const again = await service.backfillRequests(since);
      assert.deepEqual(again.granted, []);
      assert.deepEqual(store.get('item-1').requests, { '201': 'alice-id', '202': 'bob-id' });
    });
  });

  it('grants only approved or completed requests, even for available media', async () => {
    const available = (id, status, overrides = {}) => seerrRequest(id, { status, ...overrides });
    const listed = [
      available(1306, undefined, { media: { mediaType: 'movie', tmdbId: 2306, status: 5, jellyfinMediaId: 'item-2' } }),
      available(1305, 4, { media: { mediaType: 'movie', tmdbId: 2305, status: 5, jellyfinMediaId: 'item-2' } }),
      available(1304, 3, { requestedBy: { jellyfinUserId: 'carol-id' }, media: { mediaType: 'movie', tmdbId: 2304, status: 5, jellyfinMediaId: 'item-2' } }),
      available(1303, 1, { requestedBy: { jellyfinUserId: 'carol-id' }, media: { mediaType: 'movie', tmdbId: 2303, status: 5, jellyfinMediaId: 'item-1' } }),
      available(1302, 5, { media: { mediaType: 'movie', tmdbId: 2302, status: 5, jellyfinMediaId: 'item-1' } }),
      available(1301, 2, { requestedBy: { jellyfinUserId: 'bob-id' }, media: { mediaType: 'movie', tmdbId: 2301, status: 4, jellyfinMediaId: 'item-1' } }),
    ];
    await withSeerr(listed, {}, async ({ store, fake, service }) => {
      const result = await service.backfillRequests(since);
      assert.deepEqual(result.granted, ['item-1', 'item-1']);
      assert.equal(result.skipped, 4);
      const grant = store.get('item-1');
      assert.deepEqual(grant.requests, { '1301': 'bob-id', '1302': 'alice-id' });
      assert.deepEqual(grant.groupIds, ['house-a'], 'a pending request from another household joins nothing');
      assert.deepEqual(fake.user('carol-id').Policy.BlockedTags, ['jfa:private:item-1']);
      assert.equal(store.get('item-2'), undefined, 'declined, failed and status-less requests privatize nothing');
      assert.deepEqual(fake.item2.Tags, []);
      for (const id of ['1303', '1304', '1305', '1306']) assert.equal(store.hasHandledRequest(id), false, id);

      // Once Seerr approves the pending request, a later run adds it.
      listed[3].status = 2;
      assert.deepEqual((await service.backfillRequests(since)).granted, ['item-1']);
      assert.deepEqual(store.get('item-1').groupIds, ['house-a', 'house-b']);
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

  it('adds a later request from another household to a request-originated grant', async () => {
    const listed = [
      seerrRequest(702, { requestedBy: { jellyfinUserId: 'carol-id' }, media: { mediaType: 'tv', tmdbId: 1700, status: 5, jellyfinMediaId: 'item-2' } }),
      seerrRequest(701, { media: { mediaType: 'tv', tmdbId: 1700, status: 4, jellyfinMediaId: 'item-2' } }),
    ];
    await withSeerr(listed, {}, async ({ store, fake, service }) => {
      const result = await service.backfillRequests(since);
      assert.deepEqual(result.granted, ['item-2', 'item-2']);
      const grant = store.get('item-2');
      assert.deepEqual(grant.requests, { '701': 'alice-id', '702': 'carol-id' });
      assert.deepEqual(grant.groupIds, ['house-a', 'house-b']);
      assert.deepEqual(fake.user('carol-id').Policy.BlockedTags, []);
      assert.deepEqual(fake.user('bob-id').Policy.BlockedTags, ['other']);
      assert.deepEqual(fake.item2.Tags, ['jfa:private:item-2']);
    });
  });

  it('adds a backfilled request to an existing webhook grant without removing anything', async () => {
    const listed = [seerrRequest(801, { requestedBy: { jellyfinUserId: 'carol-id' } })];
    await withSeerr(listed, {}, async ({ store, service }) => {
      await service.processWebhook(parseWebhook(webhook({ userId: 'bob-id' })));
      const result = await service.backfillRequests(since);
      assert.deepEqual(result.granted, ['item-1']);
      const grant = store.get('item-1');
      assert.deepEqual(grant.requests, { '17': 'bob-id', '801': 'carol-id' });
      assert.deepEqual(grant.groupIds, ['house-a', 'house-b']);
    });
  });

  describe('webhook Seerr lookup', () => {
    const detail4k = seerrRequest(17, {
      is4k: true,
      requestedBy: { jellyfinUserId: 'carol-id' },
      media: { mediaType: 'movie', status: 5, status4k: 5, jellyfinMediaId: 'item-1', jellyfinMediaId4k: 'item-2' },
    });

    it('trusts the payload IDs of an HD request without asking Seerr', async () => {
      await withSeerr([], { 17: detail4k }, async ({ store, fake, service, calls }) => {
        const grant = await service.processWebhook(parseWebhook(webhook()));
        assert.deepEqual(calls, []);
        assert.equal(grant.itemId, 'item-1');
        assert.deepEqual(grant.requests, { '17': 'alice-id' });
        assert.equal(store.get('item-2'), undefined);
        assert.deepEqual(fake.item.Tags, ['keep-me', 'jfa:private:item-1']);
      });
    });

    it('asks Seerr when the payload lacks the item or user ID', async () => {
      const detail = seerrRequest(17, { requestedBy: { jellyfinUserId: 'carol-id' }, media: { mediaType: 'tv', status: 5, jellyfinMediaId: 'item-2' } });
      const noUser = webhook();
      delete noUser.request.requestedBy;
      const noItem = webhook({ requestId: '18' });
      delete noItem.media.jellyfinMediaId;
      await withSeerr([], { 17: detail, 18: { ...detail, id: 18 } }, async ({ store, service, calls }) => {
        assert.equal((await service.processWebhook(parseWebhook(noUser))).itemId, 'item-2');
        assert.equal((await service.processWebhook(parseWebhook(noItem))).itemId, 'item-2');
        assert.deepEqual(calls, ['/api/v1/request/17', '/api/v1/request/18']);
        assert.deepEqual(store.get('item-2').requests, { '17': 'carol-id', '18': 'carol-id' });
      });
    });

    it('asks Seerr for the 4K item when the payload cannot rule out a 4K request', async () => {
      // Seerr fills {{media_jellyfinMediaId}} with the HD item even for a 4K request.
      for (const event of ['4K Movie Request Now Available', null, '', '{{event}}', 'Movie Request Approved']) {
        await withSeerr([], { 17: detail4k }, async ({ store, fake, service, calls }) => {
          const grant = await service.processWebhook(parseWebhook(webhook({ event })));
          assert.deepEqual(calls, ['/api/v1/request/17'], String(event));
          assert.equal(grant.itemId, 'item-2');
          assert.deepEqual(grant.requests, { '17': 'carol-id' });
          assert.equal(store.get('item-1'), undefined, 'the HD item stays public');
          assert.deepEqual(fake.item.Tags, ['keep-me']);
        });
      }
    });

    it('grants separate HD and 4K requests for a title on their own items', async () => {
      await withSeerr([], { 20: { ...detail4k, id: 20 } }, async ({ store, fake, service, calls }) => {
        const hd = await service.processWebhook(parseWebhook(webhook()));
        const uhd = await service.processWebhook(parseWebhook(webhook({ requestId: '20', event: '4K Movie Request Now Available' })));
        assert.deepEqual(calls, ['/api/v1/request/20']);
        assert.equal(hd.itemId, 'item-1');
        assert.equal(uhd.itemId, 'item-2');
        assert.deepEqual(store.get('item-1').requests, { '17': 'alice-id' });
        assert.deepEqual(store.get('item-2').requests, { '20': 'carol-id' });
        assert.deepEqual(fake.item.Tags, ['keep-me', 'jfa:private:item-1']);
        assert.deepEqual(fake.item2.Tags, ['jfa:private:item-2']);
      });
    });

    it('does not grant a 4K request on the HD item when Seerr has no 4K item yet', async () => {
      const noUhdItem = seerrRequest(17, { is4k: true, media: { mediaType: 'movie', status: 5, status4k: 5, jellyfinMediaId: 'item-1' } });
      await withSeerr([noUhdItem], { 17: noUhdItem }, async ({ store, fake, service, calls }) => {
        await assert.rejects(
          () => service.processWebhook(parseWebhook(webhook({ event: '4K Movie Request Now Available' }))),
          /Seerr request 17 is missing a 4K Jellyfin media ID/,
        );
        assert.deepEqual(calls, ['/api/v1/request/17']);
        assert.equal(store.list().length, 0);
        assert.equal(store.hasHandledRequest('17'), false);
        assert.deepEqual(fake.item.Tags, ['keep-me']);
        assert.match(service.renderMetrics(), /jfa_webhooks_total\{result="error"\} 1/);
        assert.doesNotMatch(service.renderMetrics(), /result="granted"/);

        // Once Seerr knows the 4K item, the backfill grants it.
        noUhdItem.media.jellyfinMediaId4k = 'item-2';
        assert.deepEqual((await service.backfillRequests(since)).granted, ['item-2']);
        assert.deepEqual(fake.item.Tags, ['keep-me']);
      });
    });

    it('fails a needed lookup when Seerr is unreachable and leaves the request to the backfill', async () => {
      const noUser = webhook();
      delete noUser.request.requestedBy;
      await withSeerr([seerrRequest(17)], {}, async ({ store, service, calls }) => {
        await assert.rejects(() => service.processWebhook(parseWebhook(noUser)), /500/);
        assert.deepEqual(calls, ['/api/v1/request/17']);
        assert.match(service.renderMetrics(), /jfa_webhooks_total\{result="error"\} 1/);
        assert.equal(store.list().length, 0);
        assert.equal(store.hasHandledRequest('17'), false);

        const result = await service.backfillRequests(since);
        assert.deepEqual(result.granted, ['item-1']);
        assert.deepEqual(store.get('item-1').requests, { '17': 'alice-id' });
      });
    });
  });

  it('grants a 4K request on the 4K item only', async () => {
    const listed = [
      seerrRequest(903, { is4k: true, media: { mediaType: 'movie', tmdbId: 1903, status: 5, status4k: 5, jellyfinMediaId: 'item-1' } }),
      seerrRequest(902, { is4k: true, media: { mediaType: 'movie', tmdbId: 1902, status: 5, status4k: 3, jellyfinMediaId: 'item-1', jellyfinMediaId4k: 'item-2' } }),
      seerrRequest(901, { is4k: true, media: { mediaType: 'movie', tmdbId: 1901, status: 3, status4k: 5, jellyfinMediaId: 'item-1', jellyfinMediaId4k: 'item-2' } }),
    ];
    // 903 has no 4K item even after the detail lookup, so it must not fall back to the HD item.
    const details = { 903: listed[0] };
    await withSeerr(listed, details, async ({ store, fake, service, calls }) => {
      const result = await service.backfillRequests(since);
      assert.deepEqual(result.granted, ['item-2']);
      assert.equal(result.skipped, 2);
      assert.equal(result.failed, 0);
      assert.deepEqual(store.get('item-2').requests, { '901': 'alice-id' });
      assert.equal(store.get('item-1'), undefined, 'the HD item stays public');
      assert.deepEqual(fake.item.Tags, ['keep-me']);
      assert.ok(calls.includes('/api/v1/request/903'));
    });
  });

  it('counts a stored grant that cannot be reconciled as a failure only', async () => {
    const listed = [seerrRequest(1001)];
    await withSeerr(listed, {}, async ({ store, fake, service }) => {
      fake.updateItem = async () => { throw new Error('Jellyfin unavailable'); };
      const result = await service.backfillRequests(since);
      assert.deepEqual(result.granted, []);
      assert.equal(result.failed, 1);
      assert.equal(result.skipped, 0);
      assert.equal(store.get('item-1').sync.state, 'error', 'the grant is kept for reconcileAll to retry');
      const metrics = service.renderMetrics();
      assert.doesNotMatch(metrics, /jfa_request_backfill_total\{result="granted"\}/);
      assert.match(metrics, /jfa_request_backfill_total\{result="error"\} 1/);

      const again = await service.backfillRequests(since);
      assert.deepEqual(again, { scanned: 1, granted: [], skipped: 1, failed: 0 });
    });
  });

  async function backfillMissingItemLogs(serviceOptions) {
    const listed = [seerrRequest(1101, { media: { mediaType: 'movie', tmdbId: 2101, status: 5, jellyfinMediaId: 'item-gone' } })];
    const logged = [];
    await withSeerr(listed, {}, async ({ store, fake, service }) => {
      const getItem = fake.getItem.bind(fake);
      fake.getItem = async (itemId) => {
        if (itemId === 'item-gone') throw Object.assign(new Error('Jellyfin GET /Items/item-gone returned 404'), { status: 404 });
        return getItem(itemId);
      };
      const originalLog = console.log;
      const originalDebug = console.debug;
      console.log = (line) => logged.push(line);
      console.debug = (line) => logged.push(line);
      try {
        for (let run = 0; run < 2; run += 1) {
          assert.deepEqual(await service.backfillRequests(since), { scanned: 1, granted: [], skipped: 1, failed: 0 });
        }
      } finally {
        console.log = originalLog;
        console.debug = originalDebug;
      }
      assert.equal(store.get('item-gone'), undefined);
      assert.doesNotMatch(service.renderMetrics(), /jfa_request_backfill_total\{result="error"\}/);
    }, undefined, serviceOptions);
    return logged.filter((line) => line.includes('missing Jellyfin item'));
  }

  it('skips a request whose Jellyfin item was deleted without logging at the default level', async () => {
    assert.deepEqual(await backfillMissingItemLogs(), []);
    assert.deepEqual(await backfillMissingItemLogs({ logLevel: 'info' }), []);
  });

  it('logs a deleted Jellyfin item once at LOG_LEVEL=debug', async () => {
    const lines = await backfillMissingItemLogs({ logLevel: 'debug' });
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), {
      level: 'debug',
      message: 'request backfill skipped missing Jellyfin item',
      requestId: '1101',
      itemId: 'item-gone',
    });
  });

  it('never re-imports a request recorded on a grant before handledRequestIds existed', async (t) => {
    const file = await stateFile(t);
    await writeFile(file, JSON.stringify({
      version: 7,
      grants: {
        'item-1': {
          itemId: 'item-1', active: true, owners: ['alice-id'], requests: { '1201': 'alice-id' }, manualUserIds: [],
          groupIds: [], sync: { state: 'synced', attempts: 0 }, updatedAt: '2026-10-02T00:00:00.000Z',
        },
      },
      groups: {},
      catalog: { items: {} },
      passwordlessUserIds: [],
    }));
    const store = new GrantStore(file);
    await store.load();
    assert.equal(store.hasHandledRequest('1201'), true);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).handledRequestIds, ['1201']);

    await withSeerr([seerrRequest(1201)], {}, async ({ service }) => {
      await service.backfillRequests(since);
    }, store);
    await new AccessService(fakeJellyfin(), store).revokeRequest('item-1', '1201');
    assert.equal(store.get('item-1'), undefined);
    await withSeerr([seerrRequest(1201)], {}, async ({ service }) => {
      assert.deepEqual((await service.backfillRequests(since)).granted, []);
    }, store);
    assert.equal(store.get('item-1'), undefined);
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
  const event = overrides.event === undefined ? 'Movie Request Now Available' : overrides.event;
  return {
    notificationType: 'MEDIA_AVAILABLE',
    ...(event === null ? {} : { event }),
    media: {
      jellyfinMediaId: overrides.mediaId ?? 'item-1',
      mediaType: overrides.mediaType ?? 'movie',
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

/** Without a test context `t`, the directory is removed when this file's tests finish. */
async function stateFile(t = null) {
  return path.join(await makeTempDir(t, 'jfa-test-'), 'grants.json');
}

describe('Seerr recent requests cache', () => {
  function recentRequest(n) {
    return {
      id: n,
      type: 'movie',
      status: 2,
      createdAt: `2026-10-${String(1 + (n % 28)).padStart(2, '0')}T00:00:00.000Z`,
      requestedBy: { displayName: 'Alice' },
      media: { mediaType: 'movie', tmdbId: 5000 + n, status: 5, jellyfinMediaId: `item-${n}` },
    };
  }

  async function withRecentSeerr(count, run) {
    const listed = Array.from({ length: count }, (_, index) => recentRequest(index + 1));
    const originalFetch = globalThis.fetch;
    const calls = { list: 0, details: 0 };
    globalThis.fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/v1/request') {
        calls.list += 1;
        const skip = Number(url.searchParams.get('skip'));
        const take = Number(url.searchParams.get('take'));
        return Response.json({ pageInfo: { results: listed.length }, results: listed.slice(skip, skip + take) });
      }
      const match = url.pathname.match(/^\/api\/v1\/movie\/(\d+)$/);
      if (match) {
        calls.details += 1;
        return Response.json({ title: `Movie ${Number(match[1]) - 5000}`, releaseDate: '2026-01-01' });
      }
      return new Response('boom', { status: 500 });
    };
    try {
      await run(new SeerrClient('http://seerr.test', 'key'), calls);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  const ids = (items) => items.map((item) => item.id);
  const catalog = (from, to) => new Set(Array.from({ length: to - from + 1 }, (_, index) => `item-${from + index}`));

  it('serves a larger request from the cache after a smaller one within the TTL', async () => {
    await withRecentSeerr(30, async (seerr, calls) => {
      assert.deepEqual(ids(await seerr.getRecentRequests(8)), [1, 2, 3, 4, 5, 6, 7, 8]);
      assert.deepEqual(ids(await seerr.getRecentRequests(12)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      assert.equal((await seerr.getRecentRequests(50)).length, 20);
      assert.equal(calls.list, 1);
      assert.equal(calls.details, 20);
    });
  });

  it('defaults to twelve recent requests', async () => {
    await withRecentSeerr(30, async (seerr) => {
      assert.equal((await seerr.getRecentRequests()).length, 12);
    });
  });

  it('does not serve results computed for a different catalog set', async () => {
    await withRecentSeerr(30, async (seerr, calls) => {
      assert.deepEqual(ids(await seerr.getRecentRequests(12, catalog(1, 5))), [1, 2, 3, 4, 5]);
      assert.deepEqual(ids(await seerr.getRecentRequests(12, catalog(6, 15))), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      assert.equal(calls.list, 2);
      // An equal catalog in a new Set instance is still a cache hit.
      assert.deepEqual(ids(await seerr.getRecentRequests(12, catalog(6, 15))), [6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
      assert.equal(calls.list, 2);
    });
  });
});
