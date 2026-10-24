import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, it, mock } from 'node:test';
import { AccessService, ConflictError, OperationCancelledError, accessTag } from '../dist/access-service.js';
import { makeServer } from '../dist/server.js';
import { GrantStore } from '../dist/store.js';
import { parseWebhook } from '../dist/webhook.js';
import { makeTempDir } from './support/temp-dir.mjs';

const OLD_TAG = accessTag('item-old');
const NEW_TAG = accessTag('item-new');

function httpError(message, status) {
  return Object.assign(new Error(message), { status });
}

/**
 * An in-memory Jellyfin and Seerr. `items` are the Jellyfin items that exist; `requests` are Seerr requests by ID.
 * `failures` maps a Jellyfin item ID or `seerr:<requestId>` to an HTTP status to fail with. Every call is recorded.
 */
function world() {
  const users = [
    { Id: 'admin-id', Name: 'Admin', Policy: { IsAdministrator: true, BlockedTags: [] } },
    { Id: 'alice-id', Name: 'Alice', Policy: { BlockedTags: [] } },
    { Id: 'bob-id', Name: 'Bob', Policy: { BlockedTags: [] } },
    { Id: 'carol-id', Name: 'Carol', Policy: { BlockedTags: [] } },
    { Id: 'dave-id', Name: 'Dave', Policy: { BlockedTags: [] } },
  ];
  const items = new Map();
  const requests = new Map();
  const failures = new Map();
  const calls = [];
  const writes = [];
  const jellyfin = {
    async getUsers() { calls.push('getUsers'); return structuredClone(users); },
    async getItem(itemId) {
      calls.push(`getItem:${itemId}`);
      if (failures.has(itemId)) throw httpError(`Jellyfin GET /Items/${itemId} returned ${failures.get(itemId)}`, failures.get(itemId));
      const item = items.get(itemId);
      if (!item) throw httpError(`Jellyfin GET /Users/admin-id/Items/${itemId} returned 404`, 404);
      return structuredClone(item);
    },
    async getItems(itemIds) { return Promise.all(itemIds.map((itemId) => jellyfin.getItem(itemId))); },
    async getLocalTrailers(itemId) {
      calls.push(`getLocalTrailers:${itemId}`);
      if (!items.has(itemId)) throw httpError(`Jellyfin GET /Items/${itemId}/LocalTrailers returned 404`, 404);
      return [];
    },
    async updateItem(item) {
      writes.push(`updateItem:${item.Id}`);
      if (!items.has(item.Id)) throw httpError(`Jellyfin POST /Items/${item.Id} returned 404`, 404);
      items.set(item.Id, structuredClone(item));
    },
    async updatePolicy(userId, policy) {
      writes.push(`updatePolicy:${userId}`);
      users.find((user) => user.Id === userId).Policy = structuredClone(policy);
    },
  };
  // Household "Add to my library" lookups: `${mediaType}/${tmdbId}` to the HD Jellyfin item Seerr links to the title.
  const titles = new Map();
  const seerr = {
    async getJellyfinItemId(mediaType, tmdbId) {
      calls.push(`getJellyfinItemId:${mediaType}/${tmdbId}`);
      return titles.get(`${mediaType}/${tmdbId}`);
    },
    async getRequest(requestId) {
      calls.push(`getRequest:${requestId}`);
      const failure = failures.get(`seerr:${requestId}`);
      if (failure) throw httpError(`Seerr GET /api/v1/request/${requestId} returned ${failure}`, failure);
      const request = requests.get(String(requestId));
      if (!request) throw httpError(`Seerr GET /api/v1/request/${requestId} returned 404`, 404);
      return structuredClone(request);
    },
  };
  return {
    jellyfin,
    seerr,
    items,
    requests,
    failures,
    titles,
    calls,
    writes,
    // Items are added to Jellyfin after the requests were made, so the requests are new, not late.
    addItem(id, tags = []) { items.set(id, { Id: id, Name: `Movie ${id}`, Type: 'Movie', DateCreated: '2026-06-01T00:00:00.000Z', Tags: tags }); },
    tags(id) { return items.get(id)?.Tags ?? []; },
    /** The non-administrators blocked from the item tagged `tag`. */
    blockedFrom(tag) { return users.filter((user) => !user.Policy.IsAdministrator && user.Policy.BlockedTags.includes(tag)).map((user) => user.Id); },
    blocked(userId) { return users.find((user) => user.Id === userId).Policy.BlockedTags; },
    request(id, media, extra = {}) {
      requests.set(String(id), {
        id,
        type: 'movie',
        createdAt: '2026-05-01T00:00:00.000Z',
        requestedBy: { jellyfinUserId: 'alice-id' },
        media: { mediaType: 'movie', status: 5, ...media },
        ...extra,
      });
    },
  };
}

async function newStore(t, file) {
  const store = new GrantStore(file ?? path.join(await makeTempDir(t, 'jellypass-remap-test-'), 'grants.json'));
  await store.load();
  await store.upsertGroup({ id: 'house-a', name: 'House A', userIds: ['alice-id'] });
  await store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: ['carol-id'] });
  return store;
}

/**
 * The live failure: alice requested a movie, which was granted and applied to item-old; Jellyfin then deleted it and
 * re-imported it as item-new, and Seerr's request now names item-new.
 */
async function reimported(t, { seerr = true } = {}) {
  const w = world();
  const store = await newStore(t);
  const service = new AccessService(w.jellyfin, store, undefined, seerr ? w.seerr : undefined);
  w.addItem('item-old');
  await store.grant({ itemId: 'item-old', requestId: '7', userId: 'alice-id', groupIds: ['house-a'] });
  await service.reconcileAll();
  assert.ok(w.blocked('bob-id').includes(OLD_TAG), 'precondition: bob is blocked from the old item');
  w.items.delete('item-old');
  w.addItem('item-new');
  w.request(7, { jellyfinMediaId: 'item-new' });
  w.calls.length = 0;
  w.writes.length = 0;
  return { w, store, service };
}

/**
 * A dry run's grant is exactly what the write stores, apart from when it was written and its reconciliation, which a
 * dry run never does: it stays pending with `previous`'s attempt count and last success, as the write stores it.
 */
function assertPreviewStored(preview, stored, previous, message) {
  const { updatedAt: _plannedAt, sync, ...planned } = preview;
  const { updatedAt: _storedAt, sync: _reconciled, ...actual } = stored;
  assert.deepEqual(planned, actual, message);
  const lastSuccessAt = previous?.sync.lastSuccessAt;
  assert.deepEqual(sync, { state: 'pending', attempts: previous?.sync.attempts ?? 0, ...(lastSuccessAt ? { lastSuccessAt } : {}) }, `${message}: sync`);
}

async function quietly(run) {
  const errors = mock.method(console, 'error', () => {});
  const infos = mock.method(console, 'log', () => {});
  try {
    const result = await run().then((value) => ({ value }), (error) => ({ error }));
    return {
      ...result,
      errorLogs: errors.mock.calls.map((call) => call.arguments.join(' ')),
      infoLogs: infos.mock.calls.map((call) => call.arguments.join(' ')),
    };
  } finally {
    errors.mock.restore();
    infos.mock.restore();
  }
}

describe('grants whose Jellyfin item was deleted and re-imported', { timeout: 10_000 }, () => {
  it('moves the grant to the item its Seerr request now resolves to and applies it', async (t) => {
    const { w, store, service } = await reimported(t);
    const { value: plans, error, infoLogs } = await quietly(() => service.reconcileAll({ dueOnly: true }));
    assert.equal(error, undefined, String(error));
    assert.deepEqual(plans.map((plan) => plan.itemId), ['item-new']);
    assert.equal(store.get('item-old'), undefined, 'the stale grant is removed');
    const moved = store.get('item-new');
    assert.deepEqual(moved.requests, { 7: 'alice-id' });
    assert.deepEqual(moved.groupIds, ['house-a']);
    assert.equal(moved.sync.state, 'synced');
    assert.equal(store.hasHandledRequest('7'), true, 'the request stays handled');
    assert.ok(w.tags('item-new').includes(NEW_TAG));
    for (const userId of ['bob-id', 'carol-id', 'dave-id']) {
      assert.ok(w.blocked(userId).includes(NEW_TAG), `${userId} is blocked from the new item`);
      assert.ok(!w.blocked(userId).includes(OLD_TAG), `${userId} no longer carries the deleted item's tag`);
    }
    assert.ok(!w.blocked('alice-id').includes(NEW_TAG));
    assert.ok(infoLogs.some((line) => line.includes('grant remapped') && line.includes('item-new')));
    const metrics = service.renderMetrics();
    assert.match(metrics, /jfa_grant_remaps_total\{result="remapped",trigger="auto"\} 1/);
    assert.match(metrics, /jfa_sync_errors 0/);
    assert.match(metrics, /jfa_orphaned_grants 0/);
  });

  it('merges into a manual grant already on the new item without dropping anyone', async (t) => {
    const { w, store, service } = await reimported(t);
    // The old grant also had a manual user; an administrator has since shared the new item with Farmhouse.
    await store.setManualAccess({ itemId: 'item-old', userIds: ['dave-id'], groupIds: ['house-a'] });
    await store.setManualAccess({ itemId: 'item-new', userIds: [], groupIds: ['farmhouse'] });
    await quietly(() => service.reconcileAll({ dueOnly: true }));
    assert.equal(store.get('item-old'), undefined);
    const merged = store.get('item-new');
    assert.deepEqual(merged.requests, { 7: 'alice-id' });
    assert.deepEqual(merged.manualUserIds, ['dave-id']);
    assert.deepEqual(merged.groupIds, ['farmhouse', 'house-a']);
    assert.deepEqual(merged.owners, ['alice-id', 'carol-id', 'dave-id']);
    assert.equal(merged.sync.state, 'synced');
    assert.deepEqual(['alice-id', 'bob-id', 'carol-id', 'dave-id'].filter((id) => w.blocked(id).includes(NEW_TAG)), ['bob-id']);
  });

  it('recovers when Seerr re-sends MEDIA_AVAILABLE for the already-handled request', async (t) => {
    const { store, service } = await reimported(t);
    const event = parseWebhook({ notificationType: 'MEDIA_AVAILABLE', event: 'Movie Request Now Available', media: { jellyfinMediaId: 'item-new', mediaType: 'movie' }, request: { id: '7', requestedBy: { jellyfinUserId: 'alice-id' } } });
    const { value, error } = await quietly(() => service.processWebhook(event));
    assert.equal(error, undefined, String(error));
    assert.equal(value.itemId, 'item-new');
    assert.equal(store.get('item-old'), undefined);
  });

  it('marks an unresolvable grant orphaned, keeps it, logs once and stops retrying it on schedule', async (t) => {
    const { w, store, service } = await reimported(t);
    w.requests.delete('7'); // Seerr no longer knows the request (404).
    const first = await quietly(() => service.reconcileAll({ dueOnly: true }));
    assert.equal(first.error, undefined, 'an orphan is not a reconciliation failure');
    const orphan = store.get('item-old');
    assert.ok(orphan, 'a grant is never deleted just because it cannot be remapped');
    assert.equal(orphan.sync.state, 'orphaned');
    assert.match(orphan.sync.lastError, /none of its Seerr requests resolves/);
    assert.deepEqual(orphan.requests, { 7: 'alice-id' });
    assert.equal(first.errorLogs.filter((line) => line.includes('grant orphaned')).length, 1);

    w.calls.length = 0;
    const second = await quietly(() => service.reconcileAll({ dueOnly: true }));
    assert.equal(second.error, undefined);
    assert.deepEqual(w.calls, [], 'a scheduled run does not retry an orphaned grant');
    assert.deepEqual(second.errorLogs, []);

    // A full reconcile tries again; while still unresolvable it neither fails nor logs again.
    const third = await quietly(() => service.reconcileAll());
    assert.equal(third.error, undefined);
    assert.ok(w.calls.includes('getRequest:7'));
    assert.deepEqual(third.errorLogs, []);
    assert.deepEqual(await service.reconcileAll({ dryRun: true }), [], 'a dry run skips orphaned grants');

    const metrics = service.renderMetrics();
    assert.match(metrics, /jfa_orphaned_grants 1/);
    assert.match(metrics, /jfa_sync_errors 0/);
    assert.match(metrics, /jfa_grant_remaps_total\{result="orphaned",trigger="auto"\} 1/);
  });

  it('orphans the grant when Seerr still names the deleted item or lookup is not configured', async (t) => {
    const still = await reimported(t);
    still.w.request(7, { jellyfinMediaId: 'item-old' });
    await quietly(() => still.service.reconcileAll({ dueOnly: true }));
    assert.equal(still.store.get('item-old').sync.state, 'orphaned');

    const noSeerr = await reimported(t, { seerr: false });
    await quietly(() => noSeerr.service.reconcileAll({ dueOnly: true }));
    assert.equal(noSeerr.store.get('item-old').sync.state, 'orphaned');
    assert.match(noSeerr.store.get('item-old').sync.lastError, /Seerr lookup is not configured/);
  });

  it('does not treat a Jellyfin 5xx or network failure as deletion', async (t) => {
    const { w, store, service } = await reimported(t);
    w.addItem('item-old', [OLD_TAG]);
    for (const failure of [503, undefined]) {
      w.jellyfin.getItem = async (itemId) => {
        w.calls.push(`getItem:${itemId}`);
        throw failure ? httpError(`Jellyfin GET returned ${failure}`, failure) : new TypeError('fetch failed');
      };
      const { error } = await quietly(() => service.reconcileAll());
      assert.ok(error instanceof AggregateError, String(error));
      const grant = store.get('item-old');
      assert.equal(grant.sync.state, 'error', 'the grant keeps the usual retry backoff');
      assert.ok(grant.sync.nextRetryAt);
      assert.equal(store.get('item-new'), undefined);
      assert.ok(!w.calls.some((call) => call.startsWith('getRequest')), 'Seerr is not consulted');
    }
    assert.match(service.renderMetrics(), /jfa_sync_errors 1/);
  });

  it('keeps the usual retry when Seerr fails with a 5xx while re-resolving', async (t) => {
    const { w, store, service } = await reimported(t);
    w.failures.set('seerr:7', 502);
    const { error } = await quietly(() => service.reconcileAll());
    assert.ok(error instanceof AggregateError, String(error));
    assert.equal(store.get('item-old').sync.state, 'error');
    assert.equal(store.get('item-new'), undefined);
    assert.deepEqual(w.writes, []);

    w.failures.delete('seerr:7');
    await quietly(() => service.reconcileAll());
    assert.equal(store.get('item-old'), undefined, 'the next attempt remaps it');
    assert.equal(store.get('item-new').sync.state, 'synced');
  });

  it('keeps 4K and HD apart: a 4K request moves only to the new 4K item, never to the HD item', async (t) => {
    const w = world();
    const store = await newStore(t);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    w.addItem('item-hd');
    w.addItem('item-new-4k');
    await store.grant({ itemId: 'item-old-4k', requestId: '9', userId: 'alice-id' });
    await store.grant({ itemId: 'item-gone-4k', requestId: '10', userId: 'alice-id' });
    w.request(9, { jellyfinMediaId: 'item-hd', jellyfinMediaId4k: 'item-new-4k' }, { is4k: true });
    w.request(10, { jellyfinMediaId: 'item-hd' }, { is4k: true });
    await quietly(() => service.reconcileAll());
    assert.deepEqual(store.get('item-new-4k').requests, { 9: 'alice-id' });
    assert.equal(store.get('item-hd'), undefined, 'the HD item gets no grant');
    assert.deepEqual(w.tags('item-hd'), []);
    assert.equal(store.get('item-gone-4k').sync.state, 'orphaned', 'a 4K request without a 4K item does not fall back to HD');
  });

  it('keeps a request that resolves to no existing item on the stale grant instead of guessing a destination', async (t) => {
    const w = world();
    const store = await newStore(t);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    w.addItem('item-hd');
    await store.grant({ itemId: 'item-old', requestId: '9', userId: 'alice-id', groupIds: ['house-a'] });
    await store.grant({ itemId: 'item-old', requestId: '10', userId: 'bob-id' });
    w.request(9, { jellyfinMediaId: 'item-hd' });
    // A 4K request whose 4K copy has not been re-imported yet: Seerr names only the HD item.
    w.request(10, { jellyfinMediaId: 'item-hd' }, { is4k: true, requestedBy: { jellyfinUserId: 'bob-id' } });
    const { error, errorLogs } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    assert.deepEqual(store.get('item-hd').requests, { 9: 'alice-id' }, 'the 4K request is not attached to the HD item');
    assert.deepEqual(store.get('item-hd').groupIds, ['house-a']);
    assert.equal(store.get('item-hd').sync.state, 'synced');
    assert.deepEqual(w.blockedFrom(accessTag('item-hd')), ['bob-id', 'carol-id', 'dave-id']);
    const stale = store.get('item-old');
    assert.deepEqual(stale.requests, { 10: 'bob-id' }, 'the unresolved request stays for an administrator');
    assert.equal(stale.sync.state, 'orphaned');
    assert.match(stale.sync.lastError, /resolve to no existing Jellyfin item were kept here/);
    assert.equal(errorLogs.filter((line) => line.includes('grant orphaned')).length, 1);
    assert.match(service.renderMetrics(), /jfa_orphaned_grants 1/);
  });

  it('splits requests across new items with only their requesters\' households and keeps the rest on the stale grant', async (t) => {
    const w = world();
    const store = await newStore(t);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    await store.upsertGroup({ id: 'neighbours', name: 'Neighbours', userIds: ['dave-id'] });
    w.addItem('item-a');
    w.addItem('item-b');
    await store.grant({ itemId: 'item-old', requestId: '1', userId: 'alice-id' });
    await store.grant({ itemId: 'item-old', requestId: '2', userId: 'bob-id' });
    await store.grant({ itemId: 'item-old', requestId: '3', userId: 'carol-id' });
    await store.setManualAccess({ itemId: 'item-old', userIds: ['dave-id'], groupIds: ['farmhouse', 'house-a', 'neighbours'] });
    w.request(1, { jellyfinMediaId: 'item-a' });
    w.request(2, { jellyfinMediaId: 'item-a' }, { requestedBy: { jellyfinUserId: 'bob-id' } });
    w.request(3, { jellyfinMediaId: 'item-b' }, { requestedBy: { jellyfinUserId: 'carol-id' } });
    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    const a = store.get('item-a');
    assert.deepEqual([a.requests, a.manualUserIds, a.groupIds], [{ 1: 'alice-id', 2: 'bob-id' }, [], ['house-a']]);
    const b = store.get('item-b');
    assert.deepEqual([b.requests, b.manualUserIds, b.groupIds], [{ 3: 'carol-id' }, [], ['farmhouse']]);
    assert.deepEqual(w.blockedFrom(accessTag('item-a')), ['carol-id', 'dave-id']);
    assert.deepEqual(w.blockedFrom(accessTag('item-b')), ['alice-id', 'bob-id', 'dave-id']);
    const stale = store.get('item-old');
    assert.deepEqual([stale.requests, stale.manualUserIds, stale.groupIds], [{}, ['dave-id'], ['neighbours']]);
    assert.equal(stale.sync.state, 'orphaned', 'the unattributable audience waits for an administrator');
    assert.match(stale.sync.lastError, /moved to other items/);
  });

  it('never carries the manual audience of a grant left over from a split when its last request resolves later', async (t) => {
    const w = world();
    const store = await newStore(t);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    w.addItem('item-a');
    await store.grant({ itemId: 'item-old', requestId: '1', userId: 'alice-id' });
    await store.grant({ itemId: 'item-old', requestId: '2', userId: 'bob-id' });
    await store.setManualAccess({ itemId: 'item-old', userIds: ['dave-id'], groupIds: [] });
    w.request(1, { jellyfinMediaId: 'item-a' });
    // Bob's request is not re-imported yet: Seerr still names the deleted item.
    w.request(2, { jellyfinMediaId: 'item-old' }, { requestedBy: { jellyfinUserId: 'bob-id' } });
    await quietly(() => service.reconcileAll());
    assert.deepEqual(store.get('item-a').requests, { 1: 'alice-id' });
    const leftover = store.get('item-old');
    assert.deepEqual([leftover.requests, leftover.manualUserIds, leftover.sync.state], [{ 2: 'bob-id' }, ['dave-id'], 'orphaned']);
    assert.deepEqual(leftover.remap.splitTo, ['item-a']);

    w.addItem('item-b');
    w.request(2, { jellyfinMediaId: 'item-b' }, { requestedBy: { jellyfinUserId: 'bob-id' } });
    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    const b = store.get('item-b');
    assert.deepEqual([b.requests, b.manualUserIds, b.groupIds], [{ 2: 'bob-id' }, [], []], 'only the newly resolved request moves');
    assert.deepEqual(w.blockedFrom(accessTag('item-b')), ['alice-id', 'carol-id', 'dave-id'], 'Dave gains nothing');
    const still = store.get('item-old');
    assert.deepEqual([still.requests, still.manualUserIds, still.sync.state], [{}, ['dave-id'], 'orphaned'], 'Dave waits for an administrator');
    assert.deepEqual(still.remap.splitTo, ['item-a', 'item-b']);
  });

  it('keeps the source grant and its restrictions when the deleted item reappears before the move finishes', async (t) => {
    const { w, store, service } = await reimported(t);
    const getLocalTrailers = w.jellyfin.getLocalTrailers;
    w.jellyfin.getLocalTrailers = async (itemId, userId) => {
      // While the target is applied, Jellyfin finds the old item again (still tagged).
      if (itemId === 'item-new') w.addItem('item-old', [OLD_TAG]);
      return getLocalTrailers(itemId, userId);
    };
    const { error, errorLogs } = await quietly(() => service.reconcileAll({ dueOnly: true }));
    assert.equal(error, undefined, String(error));
    assert.deepEqual(w.tags('item-old'), [OLD_TAG], 'the source keeps its tag');
    assert.deepEqual(w.blockedFrom(OLD_TAG), ['bob-id', 'carol-id', 'dave-id'], 'nobody gains access to the source');
    assert.deepEqual(w.blockedFrom(NEW_TAG), ['bob-id', 'carol-id', 'dave-id'], 'the target stays applied');
    const source = store.get('item-old');
    assert.deepEqual(source.requests, { 7: 'alice-id' }, 'the source grant is kept intact');
    assert.deepEqual(source.groupIds, ['house-a']);
    assert.deepEqual(source.remap.sourceReappeared.movedTo, ['item-new']);
    assert.ok(errorLogs.some((line) => line.includes('grant source reappeared')));
    assert.match(service.renderMetrics(), /jfa_grant_remaps_total\{result="source_reappeared",trigger="auto"\} 1/);

    w.jellyfin.getLocalTrailers = getLocalTrailers;
    await quietly(() => service.reconcileAll({ dueOnly: true }));
    assert.equal(store.get('item-old').sync.state, 'synced', 'the next run applies it to the reappeared item');
    assert.deepEqual(w.blockedFrom(OLD_TAG), ['bob-id', 'carol-id', 'dave-id']);
  });

  it('carries the whole audience when every request resolves to one item that already has a manual grant', async (t) => {
    // The Grudge 3: request 172 (Nick, Farmhouse) on the deleted item; the new item already shared with Farmhouse.
    const w = world();
    const store = await newStore(t);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    w.addItem('item-old');
    await store.grant({ itemId: 'item-old', requestId: '172', userId: 'carol-id', groupIds: ['farmhouse'] });
    await store.setManualAccess({ itemId: 'item-old', userIds: ['dave-id'], groupIds: ['farmhouse', 'house-a'] });
    await service.reconcileAll();
    w.items.delete('item-old');
    w.addItem('item-new');
    await service.setManualAccess({ itemId: 'item-new', userIds: [], groupIds: ['farmhouse'] });
    w.request(172, { jellyfinMediaId: 'item-new' }, { requestedBy: { jellyfinUserId: 'carol-id' } });
    const { error } = await quietly(() => service.reconcileAll({ dueOnly: true }));
    assert.equal(error, undefined, String(error));
    assert.equal(store.get('item-old'), undefined);
    const merged = store.get('item-new');
    assert.deepEqual([merged.requests, merged.manualUserIds, merged.groupIds], [{ 172: 'carol-id' }, ['dave-id'], ['farmhouse', 'house-a']]);
    assert.deepEqual(w.blockedFrom(NEW_TAG), ['bob-id']);
  });

  it('converges with no access lost or gained when restarted between storing the new grant and applying it', async (t) => {
    const file = path.join(await makeTempDir(t, 'jellypass-remap-crash-'), 'grants.json');
    const w = world();
    const store = await newStore(t, file);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    w.addItem('item-old');
    await store.grant({ itemId: 'item-old', requestId: '7', userId: 'alice-id', groupIds: ['house-a'] });
    await store.setManualAccess({ itemId: 'item-old', userIds: ['dave-id'], groupIds: ['house-a'] });
    await service.reconcileAll();
    w.items.delete('item-old');
    w.addItem('item-new');
    await service.setManualAccess({ itemId: 'item-new', userIds: [], groupIds: ['farmhouse'] });
    w.request(7, { jellyfinMediaId: 'item-new' });
    const before = w.blockedFrom(NEW_TAG);
    assert.deepEqual(before, ['alice-id', 'bob-id', 'dave-id']);

    // The process dies while applying the merged grant: the call never returns, and nothing after it runs.
    const getLocalTrailers = w.jellyfin.getLocalTrailers;
    w.jellyfin.getLocalTrailers = async (itemId) => {
      w.calls.push(`getLocalTrailers:${itemId}`);
      return new Promise(() => {});
    };
    w.calls.length = 0;
    const crashed = quietly(() => service.reconcileAll({ dueOnly: true }));
    while (!w.calls.includes('getLocalTrailers:item-new')) await new Promise((resolve) => setImmediate(resolve));
    void crashed;

    const restarted = await newStore(t, file);
    const onDisk = restarted.get('item-old');
    assert.deepEqual([onDisk.requests, onDisk.manualUserIds], [{ 7: 'alice-id' }, ['dave-id']], 'the stale grant still records everyone');
    assert.deepEqual(restarted.get('item-new').owners, ['alice-id', 'carol-id', 'dave-id']);
    assert.deepEqual(w.blockedFrom(NEW_TAG), before, 'nothing was applied before the crash');

    w.jellyfin.getLocalTrailers = getLocalTrailers;
    const rerun = new AccessService(w.jellyfin, restarted, undefined, w.seerr);
    const { error } = await quietly(() => rerun.reconcileAll({ dueOnly: true }));
    assert.equal(error, undefined, String(error));
    assert.equal(restarted.get('item-old'), undefined);
    const merged = restarted.get('item-new');
    assert.deepEqual([merged.requests, merged.manualUserIds, merged.groupIds], [{ 7: 'alice-id' }, ['dave-id'], ['farmhouse', 'house-a']]);
    assert.equal(merged.sync.state, 'synced');
    assert.deepEqual(w.blockedFrom(NEW_TAG), ['bob-id']);
    assert.deepEqual(w.blockedFrom(OLD_TAG), [], 'the deleted item\'s tag is cleared once the move finished');
  });

  /**
   * Alice's request 7 on the deleted item-old (no households) resolves to item-new, but applying item-new fails after
   * the merge was stored, so the request is on both grants until the next run.
   */
  async function failedApply(t) {
    const w = world();
    const store = await newStore(t);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    w.addItem('item-old');
    await store.grant({ itemId: 'item-old', requestId: '7', userId: 'alice-id' });
    await service.reconcileAll();
    w.items.delete('item-old');
    w.addItem('item-new');
    w.request(7, { jellyfinMediaId: 'item-new' });
    const updateItem = w.jellyfin.updateItem;
    w.jellyfin.updateItem = async (item) => { throw httpError(`Jellyfin POST /Items/${item.Id} returned 500`, 500); };
    const { error } = await quietly(() => service.reconcileAll());
    assert.ok(error instanceof AggregateError, String(error));
    w.jellyfin.updateItem = updateItem;
    assert.deepEqual(store.get('item-old').requests, { 7: 'alice-id' });
    assert.deepEqual(store.get('item-new').requests, { 7: 'alice-id' });
    return { w, store, service };
  }

  it('never restores a request an administrator revoked from the target from the stale copy on the source', async (t) => {
    const { w, store, service } = await failedApply(t);
    const revoked = await quietly(() => service.revokeRequest('item-new', '7'));
    assert.equal(revoked.error, undefined, String(revoked.error));
    assert.equal(store.get('item-new'), undefined, 'the emptied target grant is purged');

    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    assert.equal(store.get('item-new'), undefined, 'recovery does not recreate the revoked request');
    assert.equal(store.findGrantForRequest('7'), undefined);
    assert.equal(store.get('item-old'), undefined, 'the stale copy is dropped');
    assert.deepEqual(w.tags('item-new'), []);
    assert.deepEqual(w.blockedFrom(OLD_TAG), []);

    // An administrator's explicit move does not restore it either.
    await store.grant({ itemId: 'item-gone', requestId: '7', userId: 'alice-id' });
    const preview = await service.remapGrant('item-gone', 'item-new', true);
    assert.deepEqual(preview.current.requests, {});
  });

  it('keeps the target\'s copy when the request is revoked from the stale source only', async (t) => {
    const { w, store, service } = await failedApply(t);
    const revoked = await quietly(() => service.revokeRequest('item-old', '7'));
    assert.equal(revoked.error, undefined, String(revoked.error));
    assert.equal(store.get('item-old'), undefined);

    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    assert.deepEqual(store.get('item-new').requests, { 7: 'alice-id' }, 'a revoke is scoped to the item it was made on');
    assert.equal(store.get('item-new').sync.state, 'synced');
    assert.deepEqual(w.blockedFrom(NEW_TAG), ['bob-id', 'carol-id', 'dave-id']);
  });

  it('still grants a genuine new Seerr request for the title after the old one was revoked', async (t) => {
    const { w, store, service } = await failedApply(t);
    await quietly(() => service.revokeRequest('item-new', '7'));
    await quietly(() => service.reconcileAll());
    assert.equal(store.get('item-new'), undefined);

    w.request(8, { jellyfinMediaId: 'item-new' });
    const event = parseWebhook({ notificationType: 'MEDIA_AVAILABLE', event: 'Movie Request Now Available', media: { jellyfinMediaId: 'item-new', mediaType: 'movie' }, request: { id: '8', is4k: false, requestedBy: { jellyfinUserId: 'alice-id' } } });
    const { value, error } = await quietly(() => service.processWebhook(event));
    assert.equal(error, undefined, String(error));
    assert.deepEqual(value.requests, { 8: 'alice-id' });
    assert.equal(store.get('item-new').sync.state, 'synced');
    assert.deepEqual(w.blockedFrom(NEW_TAG), ['bob-id', 'carol-id', 'dave-id']);
  });

  /**
   * Like failedApply, but item-old also has dave as a manual user and the farmhouse group (carol), so after the failed
   * apply that whole audience is on both grants. The state is kept in `file`.
   */
  async function failedManualApply(t) {
    const file = path.join(await makeTempDir(t, 'jellypass-remap-manual-'), 'grants.json');
    const w = world();
    const store = await newStore(t, file);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    w.addItem('item-old');
    await store.grant({ itemId: 'item-old', requestId: '7', userId: 'alice-id' });
    await store.setManualAccess({ itemId: 'item-old', userIds: ['dave-id'], groupIds: ['farmhouse'] });
    await service.reconcileAll();
    w.items.delete('item-old');
    w.addItem('item-new');
    w.request(7, { jellyfinMediaId: 'item-new' });
    const updateItem = w.jellyfin.updateItem;
    w.jellyfin.updateItem = async (item) => { throw httpError(`Jellyfin POST /Items/${item.Id} returned 500`, 500); };
    const { error } = await quietly(() => service.reconcileAll());
    assert.ok(error instanceof AggregateError, String(error));
    w.jellyfin.updateItem = updateItem;
    for (const itemId of ['item-old', 'item-new']) {
      const grant = store.get(itemId);
      assert.deepEqual([grant.requests, grant.manualUserIds, grant.groupIds], [{ 7: 'alice-id' }, ['dave-id'], ['farmhouse']]);
    }
    return { w, store, service, file };
  }

  it('never restores a manual user an administrator removed from the target from the stale copy on the source', async (t) => {
    const { w, store, service, file } = await failedManualApply(t);
    const removed = await quietly(() => service.setManualAccess({ itemId: 'item-new', userIds: [], groupIds: ['farmhouse'] }));
    assert.equal(removed.error, undefined, String(removed.error));
    const restarted = new GrantStore(file);
    await restarted.load();
    assert.ok(restarted.isAccessRemoved('item-new', 'userIds', 'dave-id'), 'the removal is stored');
    assert.ok(!restarted.isAccessRemoved('item-old', 'userIds', 'dave-id'), 'for that item only');

    // An administrator's explicit move, previewed or not, does not restore the user either.
    const preview = await service.remapGrant('item-old', 'item-new', true);
    assert.deepEqual(preview.current.manualUserIds, []);

    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    assert.equal(store.get('item-old'), undefined);
    const merged = store.get('item-new');
    assert.deepEqual([merged.requests, merged.manualUserIds, merged.groupIds], [{ 7: 'alice-id' }, [], ['farmhouse']]);
    assert.equal(merged.sync.state, 'synced');
    assert.deepEqual(w.blockedFrom(NEW_TAG), ['bob-id', 'dave-id']);
  });

  it('never restores a group an administrator removed from the target from the stale copy on the source', async (t) => {
    const { w, store, service } = await failedManualApply(t);
    const removed = await quietly(() => service.setGrantGroups('item-new', []));
    assert.equal(removed.error, undefined, String(removed.error));
    assert.ok(store.isAccessRemoved('item-new', 'groupIds', 'farmhouse'));

    const preview = await service.remapGrant('item-old', 'item-new', true);
    assert.deepEqual(preview.current.groupIds, []);

    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    assert.equal(store.get('item-old'), undefined);
    const merged = store.get('item-new');
    assert.deepEqual([merged.requests, merged.manualUserIds, merged.groupIds], [{ 7: 'alice-id' }, ['dave-id'], []]);
    assert.deepEqual(w.blockedFrom(NEW_TAG), ['bob-id', 'carol-id']);
  });

  it('keeps the target\'s manual users and groups when they are removed from the stale source only', async (t) => {
    const { w, store, service } = await failedManualApply(t);
    // Applying item-old then fails on its 404, but the administrator's change is stored.
    await quietly(() => service.setGrantGroups('item-old', []));
    await store.setManualAccess({ itemId: 'item-old', userIds: [], groupIds: [] });
    assert.deepEqual([store.get('item-old').manualUserIds, store.get('item-old').groupIds], [[], []]);
    assert.ok(store.isAccessRemoved('item-old', 'userIds', 'dave-id'));
    assert.ok(!store.isAccessRemoved('item-new', 'userIds', 'dave-id'));
    assert.ok(!store.isAccessRemoved('item-new', 'groupIds', 'farmhouse'));

    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    assert.equal(store.get('item-old'), undefined);
    const merged = store.get('item-new');
    assert.deepEqual([merged.manualUserIds, merged.groupIds], [['dave-id'], ['farmhouse']], 'a removal is scoped to the item it was made on');
    assert.equal(merged.sync.state, 'synced');
    assert.deepEqual(w.blockedFrom(NEW_TAG), ['bob-id']);
  });

  it('clears a removal when an administrator assigns the manual user or group to the item again', async (t) => {
    const { store, service, file } = await failedManualApply(t);
    await quietly(() => service.setManualAccess({ itemId: 'item-new', userIds: ['bob-id'], groupIds: [] }));
    assert.ok(store.isAccessRemoved('item-new', 'userIds', 'dave-id'));
    assert.ok(store.isAccessRemoved('item-new', 'groupIds', 'farmhouse'));
    assert.deepEqual((await service.remapGrant('item-old', 'item-new', true)).current.manualUserIds, ['bob-id']);

    const readded = await quietly(() => service.setManualAccess({ itemId: 'item-new', userIds: ['dave-id'], groupIds: [] }));
    assert.equal(readded.error, undefined, String(readded.error));
    assert.ok(!store.isAccessRemoved('item-new', 'userIds', 'dave-id'), 'assigning the user again clears its removal');
    assert.ok(store.isAccessRemoved('item-new', 'userIds', 'bob-id'), 'the user taken off now is marked');
    const regrouped = await quietly(() => service.setGrantGroups('item-new', ['farmhouse']));
    assert.equal(regrouped.error, undefined, String(regrouped.error));
    assert.ok(!store.isAccessRemoved('item-new', 'groupIds', 'farmhouse'), 'assigning the group again clears its removal');
    const restarted = new GrantStore(file);
    await restarted.load();
    assert.ok(!restarted.isAccessRemoved('item-new', 'userIds', 'dave-id'));
    assert.ok(!restarted.isAccessRemoved('item-new', 'groupIds', 'farmhouse'));
  });

  it('forgets a deleted group\'s removals, so a new group with the same ID starts unmarked', async (t) => {
    const { store, service } = await failedManualApply(t);
    await quietly(() => service.setGrantGroups('item-new', []));
    assert.ok(store.isAccessRemoved('item-new', 'groupIds', 'farmhouse'));
    await quietly(() => service.deleteGroup('farmhouse'));
    assert.ok(!store.isAccessRemoved('item-new', 'groupIds', 'farmhouse'));
  });

  it('deletes an inactive grant whose item is gone instead of failing forever', async (t) => {
    const { w, store, service } = await reimported(t);
    // Clearing its groups leaves it active (the request still holds it), so applying still fails on the 404.
    const cleared = await quietly(() => service.setGrantGroups('item-old', []));
    assert.match(String(cleared.error), /returned 404/);
    const { error } = await quietly(() => service.revokeRequest('item-old', '7'));
    assert.equal(error, undefined, String(error));
    assert.equal(store.get('item-old'), undefined);
    assert.ok(!w.blocked('bob-id').includes(OLD_TAG));
  });

  it('starts no further call or write once shutdown aborts a recovery', async (t) => {
    const { w, store, service } = await reimported(t);
    const controller = new AbortController();
    const getRequest = w.seerr.getRequest;
    w.seerr.getRequest = async (requestId) => {
      const request = await getRequest(requestId);
      controller.abort(new Error('shutting down'));
      return request;
    };
    const { error, errorLogs, infoLogs } = await quietly(() => service.reconcileAll({ dueOnly: true, signal: controller.signal }));
    assert.ok(error instanceof OperationCancelledError, String(error));
    assert.equal(w.calls.at(-1), 'getRequest:7');
    assert.deepEqual(w.writes, []);
    assert.equal(store.get('item-old').sync.state, 'synced', 'left as it was, neither failed nor orphaned');
    assert.equal(store.get('item-new'), undefined);
    assert.deepEqual([...errorLogs, ...infoLogs], []);
  });
});

describe('admin grant remap', { timeout: 10_000 }, () => {
  it('previews a move without changing anything', async (t) => {
    const { w, store, service } = await reimported(t);
    await store.setManualAccess({ itemId: 'item-new', userIds: [], groupIds: ['farmhouse'] });
    const before = store.list();
    const result = await service.remapGrant('item-old', 'item-new', true);
    assert.deepEqual(store.list(), before);
    assert.deepEqual(w.writes, []);
    assert.deepEqual(result.current.groupIds, ['farmhouse', 'house-a']);
    assert.deepEqual(result.current.requests, { 7: 'alice-id' });
    assert.equal(result.target.itemId, 'item-new');
    assert.equal(result.plan.itemId, 'item-new');
    assert.equal(result.plan.item.action, 'add_tag');
    assert.equal(result.sourcePlan.itemId, 'item-old');
    assert.ok(result.sourcePlan.users.some((change) => change.userId === 'bob-id' && change.action === 'unblock'));
  });

  it('moves a grant whose source item is already gone, merging with the target grant', async (t) => {
    const { w, store, service } = await reimported(t);
    await store.setManualAccess({ itemId: 'item-new', userIds: [], groupIds: ['farmhouse'] });
    const { value: result, error } = await quietly(() => service.remapGrant('item-old', 'item-new'));
    assert.equal(error, undefined, String(error));
    assert.equal(store.get('item-old'), undefined);
    assert.deepEqual(result.current.groupIds, ['farmhouse', 'house-a']);
    assert.equal(store.get('item-new').sync.state, 'synced');
    assert.ok(w.tags('item-new').includes(NEW_TAG));
    assert.ok(w.blocked('bob-id').includes(NEW_TAG) && !w.blocked('bob-id').includes(OLD_TAG));
    assert.match(service.renderMetrics(), /jfa_grant_remaps_total\{result="remapped",trigger="admin"\} 1/);
  });

  it('clears an orphaned grant by moving it', async (t) => {
    const { w, store, service } = await reimported(t);
    w.requests.delete('7');
    await quietly(() => service.reconcileAll());
    assert.equal(store.get('item-old').sync.state, 'orphaned');
    await quietly(() => service.remapGrant('item-old', 'item-new'));
    assert.equal(store.get('item-old'), undefined);
    assert.match(service.renderMetrics(), /jfa_orphaned_grants 0/);
  });

  it('refuses to move a grant whose source item still exists, changing nothing', async (t) => {
    const w = world();
    const store = await newStore(t);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    w.addItem('item-old');
    w.addItem('item-new');
    await store.grant({ itemId: 'item-old', requestId: '7', userId: 'alice-id' });
    await service.reconcileAll();
    const before = store.list();
    w.writes.length = 0;
    for (const dryRun of [true, false]) {
      await assert.rejects(service.remapGrant('item-old', 'item-new', dryRun), (error) =>
        error instanceof ConflictError && error.code === 'source_item_exists' && /source item still exists.*revoke its access explicitly first/.test(error.message));
    }
    assert.deepEqual(w.writes, []);
    assert.deepEqual(store.list(), before);
    assert.ok(w.tags('item-old').includes(OLD_TAG), 'the source item stays private');
    assert.deepEqual(w.blockedFrom(OLD_TAG), ['bob-id', 'carol-id', 'dave-id']);
  });

  it('keeps the source grant when applying the target fails, and finishes on a retry', async (t) => {
    const { w, store, service } = await reimported(t);
    const updateItem = w.jellyfin.updateItem;
    w.jellyfin.updateItem = async (item) => {
      w.writes.push(`updateItem:${item.Id}`);
      throw httpError(`Jellyfin POST /Items/${item.Id} returned 500`, 500);
    };
    const failed = await quietly(() => service.remapGrant('item-old', 'item-new'));
    assert.match(String(failed.error), /returned 500/);
    assert.deepEqual(store.get('item-old').requests, { 7: 'alice-id' }, 'the source grant is not removed');
    assert.ok(w.blocked('bob-id').includes(OLD_TAG), 'its tag is not cleared yet');
    assert.equal(store.get('item-new').sync.state, 'error');

    w.jellyfin.updateItem = updateItem;
    const retried = await quietly(() => service.remapGrant('item-old', 'item-new'));
    assert.equal(retried.error, undefined, String(retried.error));
    assert.equal(store.get('item-old'), undefined);
    assert.deepEqual(store.get('item-new').requests, { 7: 'alice-id' });
    assert.deepEqual(w.blockedFrom(NEW_TAG), ['bob-id', 'carol-id', 'dave-id']);
    assert.deepEqual(w.blockedFrom(OLD_TAG), []);
  });

  it('keeps the source grant when its item reappears while an administrator moves it', async (t) => {
    const { w, store, service } = await reimported(t);
    const getLocalTrailers = w.jellyfin.getLocalTrailers;
    w.jellyfin.getLocalTrailers = async (itemId, userId) => {
      if (itemId === 'item-new') w.addItem('item-old', [OLD_TAG]);
      return getLocalTrailers(itemId, userId);
    };
    const { error, errorLogs } = await quietly(() => service.remapGrant('item-old', 'item-new'));
    assert.ok(error instanceof ConflictError && error.code === 'source_reappeared', String(error));
    assert.match(error.message, /source grant was kept with its restrictions/);
    assert.deepEqual(w.tags('item-old'), [OLD_TAG]);
    assert.deepEqual(w.blockedFrom(OLD_TAG), ['bob-id', 'carol-id', 'dave-id']);
    assert.deepEqual(store.get('item-old').requests, { 7: 'alice-id' });
    assert.deepEqual(store.get('item-old').remap.sourceReappeared.movedTo, ['item-new']);
    assert.equal(store.get('item-new').sync.state, 'synced');
    assert.ok(errorLogs.some((line) => line.includes('grant source reappeared')));
    assert.match(service.renderMetrics(), /jfa_grant_remaps_total\{result="source_reappeared",trigger="admin"\} 1/);
  });

  it('refuses to move a 4K request onto the HD item or an HD request onto the 4K item', async (t) => {
    const w = world();
    const store = await newStore(t);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    w.addItem('item-hd');
    w.addItem('item-4k');
    await store.grant({ itemId: 'item-old-4k', requestId: '9', userId: 'alice-id' });
    await store.grant({ itemId: 'item-old-hd', requestId: '10', userId: 'alice-id' });
    w.request(9, { jellyfinMediaId: 'item-hd' }, { is4k: true });
    w.request(10, { jellyfinMediaId: 'item-hd', jellyfinMediaId4k: 'item-4k' });
    await assert.rejects(service.remapGrant('item-old-4k', 'item-hd'), (error) => error instanceof ConflictError && error.code === 'quality_mismatch');
    await assert.rejects(service.remapGrant('item-old-hd', 'item-4k', true), (error) => error instanceof ConflictError && error.code === 'quality_mismatch');
    assert.deepEqual(w.writes, []);
    assert.equal(store.get('item-hd'), undefined);
    assert.equal(store.get('item-4k'), undefined);
  });

  it('rejects a missing source grant, a missing target item and a move onto itself', async (t) => {
    const { w, store, service } = await reimported(t);
    await assert.rejects(service.remapGrant('item-none', 'item-new'), /grant not found: item-none/);
    await assert.rejects(service.remapGrant('item-old', 'item-missing', true), /Jellyfin item not found: item-missing/);
    await assert.rejects(service.remapGrant('item-old', 'ITEM-OLD'), /different item/);
    w.failures.set('item-new', 500);
    await assert.rejects(service.remapGrant('item-old', 'item-new'), /returned 500/);
    assert.deepEqual(w.writes, []);
    assert.ok(store.get('item-old'));
  });

  it('refuses during shutdown before touching Jellyfin', async (t) => {
    const w = world();
    const store = await newStore(t);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    w.addItem('item-old', [OLD_TAG]);
    w.addItem('item-new');
    await store.grant({ itemId: 'item-old', requestId: '7', userId: 'alice-id' });
    await store.close();
    await assert.rejects(service.remapGrant('item-old', 'item-new'), /state store is closed/);
    assert.deepEqual(w.writes, []);
    assert.deepEqual(w.tags('item-old'), [OLD_TAG]);
    assert.ok(store.get('item-old'));
    assert.equal(store.get('item-new'), undefined);
  });

  it('is served at POST /v1/grants/:itemId/remap', async (t) => {
    const { w, store, service } = await reimported(t);
    const server = makeServer(service, { webhook: 'webhook-token', admin: 'admin-token' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (itemId, body, query = '') => fetch(`${base}/v1/grants/${itemId}/remap${query}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    w.addItem('item-live');
    await store.grant({ itemId: 'item-live', requestId: '8', userId: 'alice-id' });
    const { value: responses } = await quietly(async () => [
      await post('item-live', { toItemId: 'item-new' }, '?dryRun=true'),
      await post('item-old', { toItemId: 'item-new' }, '?dryRun=true'),
      await post('item-none', { toItemId: 'item-new' }),
      await post('item-old', { toItemId: '../etc' }),
      await post('item-old', { toItemId: 'item-new' }),
    ]);
    const [conflict, planned, missing, invalid, remapped] = responses;
    assert.equal(conflict.status, 409);
    const conflictBody = await conflict.json();
    assert.equal(conflictBody.code, 'source_item_exists');
    assert.match(conflictBody.error, /source item still exists/);
    assert.equal(planned.status, 200);
    assert.equal((await planned.json()).status, 'planned');
    assert.equal(missing.status, 404);
    assert.equal(invalid.status, 400);
    assert.equal(remapped.status, 200);
    const body = await remapped.json();
    assert.equal(body.status, 'remapped');
    assert.equal(body.result.current.itemId, 'item-new');
    assert.equal(store.get('item-old'), undefined);
  });
});

/**
 * Household library joins (removedAccess marks, from PR #25) and grant moves (revokedRequests and removal marks, from
 * PR #24) share one per-item removal record; each path must honour every removal the other records.
 */
describe('removals across household library joins and grant moves', { timeout: 10_000 }, () => {
  /** TMDB movie 603 is linked in Seerr to `itemId`. */
  function join(service, w, userId, itemId = 'item-new') {
    w.titles.set('movie/603', itemId);
    return quietly(() => service.joinLibrary({ userId, isAdministrator: false, mediaType: 'movie', tmdbId: 603 }))
      .then(({ value, error }) => {
        assert.equal(error, undefined, String(error));
        return value;
      });
  }

  /**
   * item-old has alice's request 7 (with House A), dave as a manual user and Farmhouse (carol); applying the move to
   * item-new failed after it was merged, so that whole audience is on both grants. The state is kept in `file`.
   */
  async function staleCopy(t) {
    const file = path.join(await makeTempDir(t, 'jellypass-removals-'), 'grants.json');
    const w = world();
    const store = await newStore(t, file);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    w.addItem('item-old');
    await store.grant({ itemId: 'item-old', requestId: '7', userId: 'alice-id', groupIds: ['house-a'] });
    await store.setManualAccess({ itemId: 'item-old', userIds: ['dave-id'], groupIds: ['farmhouse', 'house-a'] });
    await service.reconcileAll();
    w.items.delete('item-old');
    w.addItem('item-new');
    w.request(7, { jellyfinMediaId: 'item-new' });
    const updateItem = w.jellyfin.updateItem;
    w.jellyfin.updateItem = async (item) => { throw httpError(`Jellyfin POST /Items/${item.Id} returned 500`, 500); };
    const { error } = await quietly(() => service.reconcileAll());
    assert.ok(error instanceof AggregateError, String(error));
    w.jellyfin.updateItem = updateItem;
    for (const itemId of ['item-old', 'item-new']) {
      const grant = store.get(itemId);
      assert.deepEqual([grant.requests, grant.manualUserIds, grant.groupIds], [{ 7: 'alice-id' }, ['dave-id'], ['farmhouse', 'house-a']]);
    }
    return { w, store, service, file };
  }

  it('(a) never re-adds a household removed by hand on an item, by library join or by a move onto it', async (t) => {
    const { w, store, service } = await staleCopy(t);
    const removed = await quietly(() => service.setGrantGroups('item-new', ['house-a']));
    assert.equal(removed.error, undefined, String(removed.error));
    assert.ok(store.isAccessRemoved('item-new', 'groupIds', 'farmhouse'));
    // Bob joins Farmhouse afterwards, so he has no mark of his own: only the household's mark stops his join.
    await store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: ['bob-id', 'carol-id'] });

    assert.equal(await join(service, w, 'bob-id'), 'unchanged');
    assert.deepEqual(store.get('item-new').groupIds, ['house-a']);
    // Nor does an administrator's move, previewed or not, nor recovery, from the stale copy that still lists Farmhouse.
    assert.deepEqual((await service.remapGrant('item-old', 'item-new', true)).current.groupIds, ['house-a']);
    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    assert.equal(store.get('item-old'), undefined);
    assert.deepEqual(store.get('item-new').groupIds, ['house-a']);
    assert.equal(await join(service, w, 'bob-id'), 'unchanged', 'nor after the move');
    assert.deepEqual(store.get('item-new').groupIds, ['house-a']);
    assert.deepEqual(w.blockedFrom(NEW_TAG), ['bob-id', 'carol-id']);
  });

  it('(b) keeps users and households removed before an automatic move from joining the new item', async (t) => {
    const { w, store, service } = await reimported(t);
    // Before item-old was deleted, an administrator gave it Farmhouse (carol) and dave, then took both off again.
    w.addItem('item-old');
    await quietly(() => service.setManualAccess({ itemId: 'item-old', userIds: ['dave-id'], groupIds: ['farmhouse', 'house-a'] }));
    await quietly(() => service.setManualAccess({ itemId: 'item-old', userIds: [], groupIds: ['house-a'] }));
    w.items.delete('item-old');
    assert.deepEqual(store.getRemovals('item-old'), { userIds: ['carol-id', 'dave-id'], groupIds: ['farmhouse'] });

    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    assert.equal(store.get('item-old'), undefined);
    assert.deepEqual(store.getRemovals('item-new'), { userIds: ['carol-id', 'dave-id'], groupIds: ['farmhouse'] }, 'the marks moved with the grant');

    // Carol, Dave (in no household) and Bob, who joins Farmhouse only now, all try to add themselves.
    await store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: ['bob-id', 'carol-id'] });
    assert.equal(await join(service, w, 'carol-id'), 'unchanged');
    assert.equal(await join(service, w, 'dave-id'), 'unchanged');
    assert.equal(await join(service, w, 'bob-id'), 'unchanged');
    // Carol, now in a new household of her own too, still joins nothing.
    await store.upsertGroup({ id: 'cottage', name: 'Cottage', userIds: ['carol-id'] });
    assert.equal(await join(service, w, 'carol-id'), 'unchanged');
    const grant = store.get('item-new');
    assert.deepEqual([grant.manualUserIds, grant.groupIds, grant.joins], [[], ['house-a'], undefined]);
    assert.deepEqual(w.blockedFrom(NEW_TAG), ['bob-id', 'carol-id', 'dave-id']);
  });

  it('(c) joins only the caller\'s household to a moved grant and never touches the orphaned leftover', async (t) => {
    const w = world();
    const store = await newStore(t);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    await store.upsertGroup({ id: 'neighbours', name: 'Neighbours', userIds: ['dave-id'] });
    w.addItem('item-new');
    await store.grant({ itemId: 'item-old', requestId: '7', userId: 'alice-id', groupIds: ['house-a'] });
    await store.grant({ itemId: 'item-old', requestId: '8', userId: 'bob-id' });
    await store.setManualAccess({ itemId: 'item-old', userIds: ['dave-id'], groupIds: ['house-a', 'neighbours'] });
    // Request 7 resolves to item-new; request 8 still names the deleted item, so the grant is split.
    w.request(7, { jellyfinMediaId: 'item-new' });
    w.request(8, { jellyfinMediaId: 'item-old' }, { requestedBy: { jellyfinUserId: 'bob-id' } });
    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    const leftover = store.get('item-old');
    assert.equal(leftover.sync.state, 'orphaned');
    assert.deepEqual([leftover.requests, leftover.manualUserIds, leftover.groupIds], [{ 8: 'bob-id' }, ['dave-id'], ['neighbours']]);

    assert.equal(await join(service, w, 'carol-id'), 'joined');
    const moved = store.get('item-new');
    assert.deepEqual([moved.requests, moved.manualUserIds, moved.groupIds], [{ 7: 'alice-id' }, [], ['farmhouse', 'house-a']]);
    assert.deepEqual(moved.joins.map((entry) => [entry.userId, entry.groupIds]), [['carol-id', ['farmhouse']]]);
    assert.deepEqual(w.blockedFrom(NEW_TAG), ['bob-id', 'dave-id'], 'only the caller\'s household gained access');

    // A title Seerr still links to the deleted item joins nobody to the leftover, whose audience waits for an administrator.
    assert.equal(await join(service, w, 'alice-id', 'item-old'), 'unchanged');
    assert.equal(await join(service, w, 'carol-id', 'item-old'), 'unchanged');
    assert.deepEqual(store.get('item-old'), leftover);
  });

  it('(d) lets joins and moves reach a user again once an administrator re-adds them by hand', async (t) => {
    const { w, store, service } = await staleCopy(t);
    await quietly(() => service.setManualAccess({ itemId: 'item-new', userIds: [], groupIds: ['farmhouse', 'house-a'] }));
    assert.ok(store.isAccessRemoved('item-new', 'userIds', 'dave-id'));
    assert.equal(await join(service, w, 'dave-id'), 'unchanged', 'dave is marked');
    assert.deepEqual((await service.remapGrant('item-old', 'item-new', true)).current.manualUserIds, []);

    // An administrator adds Neighbours, dave's household, by hand: that clears dave's mark.
    await store.upsertGroup({ id: 'neighbours', name: 'Neighbours', userIds: ['dave-id'] });
    const readded = await quietly(() => service.setGrantGroups('item-new', ['farmhouse', 'house-a', 'neighbours']));
    assert.equal(readded.error, undefined, String(readded.error));
    assert.ok(!store.isAccessRemoved('item-new', 'userIds', 'dave-id'));
    // The stale copy's manual user moves again, and dave's own join adds his other household.
    assert.deepEqual((await service.remapGrant('item-old', 'item-new', true)).current.manualUserIds, ['dave-id']);
    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    assert.deepEqual(store.get('item-new').manualUserIds, ['dave-id']);
    await store.upsertGroup({ id: 'cottage', name: 'Cottage', userIds: ['bob-id', 'dave-id'] });
    assert.equal(await join(service, w, 'dave-id'), 'joined');
    assert.deepEqual(store.get('item-new').groupIds, ['cottage', 'farmhouse', 'house-a', 'neighbours']);
    assert.deepEqual(w.blockedFrom(NEW_TAG), []);
  });

  it('(e) keeps a revoked request revoked when the grant moves, even when its requester tries a library join', async (t) => {
    const { w, store, service } = await reimported(t);
    w.addItem('item-old');
    // Carol, in no household, had her own request 8 for the title; an administrator revoked it from item-old.
    await store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: [] });
    await store.grant({ itemId: 'item-old', requestId: '8', userId: 'carol-id' });
    await quietly(() => service.revokeRequest('item-old', '8'));
    w.items.delete('item-old');
    w.request(8, { jellyfinMediaId: 'item-new' }, { requestedBy: { jellyfinUserId: 'carol-id' } });

    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    assert.equal(store.get('item-old'), undefined);
    assert.ok(store.isRequestRevoked('8', 'item-new'), 'the revocation moved with the grant');
    assert.ok(store.isAccessRemoved('item-new', 'userIds', 'carol-id'));
    assert.equal(await join(service, w, 'carol-id'), 'unchanged');
    // Nor does Seerr re-sending the request's MEDIA_AVAILABLE restore it.
    const event = parseWebhook({ notificationType: 'MEDIA_AVAILABLE', event: 'Movie Request Now Available', media: { jellyfinMediaId: 'item-new', mediaType: 'movie' }, request: { id: '8', requestedBy: { jellyfinUserId: 'carol-id' } } });
    assert.equal((await quietly(() => service.processWebhook(event))).value, null);
    const grant = store.get('item-new');
    assert.deepEqual([grant.requests, grant.manualUserIds, grant.groupIds], [{ 7: 'alice-id' }, [], ['house-a']]);
    assert.ok(w.blocked('carol-id').includes(NEW_TAG));
  });

  it('(e) keeps a request revoked from the new item off it when the stale copy moves, despite a library join', async (t) => {
    const { w, store, service } = await staleCopy(t);
    // Carol, in no household, also requested the title (request 8); both copies record it.
    await store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: [] });
    await store.grant({ itemId: 'item-old', requestId: '8', userId: 'carol-id' });
    await store.grant({ itemId: 'item-new', requestId: '8', userId: 'carol-id' });
    w.request(8, { jellyfinMediaId: 'item-new' }, { requestedBy: { jellyfinUserId: 'carol-id' } });
    const revoked = await quietly(() => service.revokeRequest('item-new', '8'));
    assert.equal(revoked.error, undefined, String(revoked.error));
    assert.equal(await join(service, w, 'carol-id'), 'unchanged');

    assert.deepEqual((await service.remapGrant('item-old', 'item-new', true)).current.requests, { 7: 'alice-id' });
    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    // The revoked request goes nowhere, so the rest of the stale copy stays behind, orphaned, without it.
    const leftover = store.get('item-old');
    assert.deepEqual([leftover.requests, leftover.sync.state], [{}, 'orphaned']);
    assert.equal(await join(service, w, 'carol-id'), 'unchanged', 'nor after the move');
    assert.equal(await join(service, w, 'carol-id', 'item-old'), 'unchanged');
    const grant = store.get('item-new');
    assert.deepEqual([grant.requests, grant.manualUserIds], [{ 7: 'alice-id' }, ['dave-id']]);
    assert.ok(store.isRequestRevoked('8', 'item-new'));
    assert.ok(w.blocked('carol-id').includes(NEW_TAG));
  });

  it('(f) loads state files written by 2.1.1 and by each earlier development shape without losing a record', async (t) => {
    const dir = await makeTempDir(t, 'jellypass-removal-shapes-');
    const now = '2026-10-20T00:00:00.000Z';
    const groups = { farmhouse: { id: 'farmhouse', name: 'Farmhouse', userIds: ['carol-id'], createdAt: now, updatedAt: now } };
    const grant = (itemId, extra = {}) => ({
      itemId, active: true, owners: ['alice-id'], requests: { 7: 'alice-id' }, manualUserIds: [], groupIds: [],
      sync: { state: 'synced', attempts: 0 }, updatedAt: now, ...extra,
    });
    const base = { version: 7, groups, catalog: { items: {} }, passwordlessUserIds: [], handledRequestIds: ['7', '8'] };
    const join = { userId: 'carol-id', groupIds: ['farmhouse'], userAdded: false, joinedAt: now };
    const shapes = {
      // 2.1.1: no removal records at all.
      'v2.1.1': { ...base, grants: { 'item-a': grant('item-a') } },
      // Grant moves only: removals in the state, revoked requests, a split leftover.
      moves: {
        ...base,
        grants: { 'item-a': grant('item-a', { remap: { splitTo: ['item-b'] }, sync: { state: 'orphaned', attempts: 0, lastError: 'split' } }) },
        revokedRequests: { 8: ['item-a'] },
        removedManualAccess: { 'item-a': { userIds: ['dave-id'], groupIds: ['farmhouse'] } },
      },
      // Library joins only: marks and joins on the grant.
      joins: { ...base, grants: { 'item-a': grant('item-a', { joins: [join], removedUserIds: ['carol-id'], removedGroupIds: ['farmhouse'] }) } },
      // Both, overlapping on the same item.
      both: {
        ...base,
        grants: { 'item-a': grant('item-a', { joins: [join], removedUserIds: ['carol-id'], removedGroupIds: ['farmhouse'] }) },
        revokedRequests: { 8: ['item-a'] },
        removedManualAccess: { 'item-a': { userIds: ['dave-id'] }, 'item-gone': { groupIds: ['farmhouse'] } },
      },
    };
    const expected = {
      'v2.1.1': {},
      moves: { 'item-a': { userIds: ['dave-id'], groupIds: ['farmhouse'] } },
      joins: { 'item-a': { userIds: ['carol-id'], groupIds: ['farmhouse'] } },
      both: { 'item-a': { userIds: ['carol-id', 'dave-id'], groupIds: ['farmhouse'] }, 'item-gone': { groupIds: ['farmhouse'] } },
    };
    for (const [name, state] of Object.entries(shapes)) {
      const file = path.join(dir, `${name}.json`);
      await writeFile(file, JSON.stringify(state));
      for (const pass of ['first load', 'reload']) {
        const store = new GrantStore(file);
        await store.load();
        const loaded = JSON.parse(await readFile(file, 'utf8'));
        assert.equal(loaded.version, 7, `${name} ${pass}`);
        assert.deepEqual(loaded.removedAccess ?? {}, expected[name], `${name} ${pass}: every removal mark is kept`);
        for (const [itemId, removals] of Object.entries(expected[name])) assert.deepEqual(store.getRemovals(itemId), removals);
        assert.equal(loaded.removedManualAccess, undefined, `${name} ${pass}`);
        assert.equal('removedUserIds' in loaded.grants['item-a'] || 'removedGroupIds' in loaded.grants['item-a'], false);
        assert.deepEqual(loaded.revokedRequests, state.revokedRequests, `${name} ${pass}`);
        assert.equal(store.isRequestRevoked('8', 'item-a'), Boolean(state.revokedRequests));
        const loadedGrant = store.get('item-a');
        assert.deepEqual(loadedGrant.joins, state.grants['item-a'].joins, `${name} ${pass}: joins are kept`);
        assert.deepEqual(loadedGrant.remap, state.grants['item-a'].remap);
        assert.equal(loadedGrant.sync.state, state.grants['item-a'].sync.state);
        assert.deepEqual(loadedGrant.requests, { 7: 'alice-id' });
        assert.deepEqual(store.listGroups().map((group) => group.id), ['farmhouse']);
      }
    }
  });
});

/**
 * Household library joins (GrantRecord.joins, an admin-only audit trail) follow the households they added when a grant
 * moves: all of them when the whole audience moves to one item, only the matching ones on a split; an orphaned
 * leftover keeps its own list, and merging the same move again records each join once. They never give access.
 */
describe('library join history across grant moves', { timeout: 10_000 }, () => {
  /** TMDB movie 603 is linked in Seerr to `itemId`; `userId` joins it to their library. */
  async function join(service, w, userId, itemId) {
    w.titles.set('movie/603', itemId);
    const { value, error } = await quietly(() => service.joinLibrary({ userId, isAdministrator: false, mediaType: 'movie', tmdbId: 603 }));
    assert.equal(error, undefined, String(error));
    assert.equal(value, 'joined', `${userId} joins ${itemId}`);
  }

  /** A grant's join history as comparable entries; a join recorded twice shows up twice. */
  function history(grant) {
    return (grant?.joins ?? []).map((entry) => `${entry.userId} ${entry.groupIds.join(',')} ${entry.userAdded} ${entry.joinedAt}`).sort();
  }

  /**
   * item-old has alice's request 7 (House A); carol then joined Farmhouse to it and dave, in no household, joined
   * himself. item-old was then deleted and re-imported as item-new, which Seerr's request 7 now names.
   */
  async function joinedThenReimported(t, file) {
    const w = world();
    const store = await newStore(t, file);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    w.addItem('item-old');
    await store.grant({ itemId: 'item-old', requestId: '7', userId: 'alice-id', groupIds: ['house-a'] });
    await service.reconcileAll();
    await join(service, w, 'carol-id', 'item-old');
    await join(service, w, 'dave-id', 'item-old');
    const joins = store.get('item-old').joins;
    assert.deepEqual(joins.map((entry) => [entry.userId, entry.groupIds, entry.userAdded]), [
      ['carol-id', ['farmhouse'], false],
      ['dave-id', [], true],
    ]);
    assert.deepEqual(w.blockedFrom(OLD_TAG), ['bob-id']);
    w.items.delete('item-old');
    w.addItem('item-new');
    w.request(7, { jellyfinMediaId: 'item-new' });
    return { w, store, service, joins };
  }

  it('moves the whole history with the whole audience, once, and the history alone gives no access', async (t) => {
    const { w, store, service, joins } = await joinedThenReimported(t);
    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    assert.equal(store.get('item-old'), undefined, 'the stale record is gone');
    const moved = store.get('item-new');
    assert.deepEqual(moved.joins, joins, 'every join made before the move, each once');
    assert.deepEqual([moved.manualUserIds, moved.groupIds], [['dave-id'], ['farmhouse', 'house-a']]);
    assert.deepEqual(w.blockedFrom(NEW_TAG), ['bob-id'], 'exactly the moved audience, as before the move');

    // An administrator takes Farmhouse and dave off: their joins stay on record but give carol and dave nothing.
    const { error: changed } = await quietly(() => service.setManualAccess({ itemId: 'item-new', userIds: [], groupIds: ['house-a'] }));
    assert.equal(changed, undefined, String(changed));
    assert.deepEqual(store.get('item-new').joins, joins);
    assert.deepEqual(store.get('item-new').owners, ['alice-id']);
    assert.deepEqual(w.blockedFrom(NEW_TAG), ['bob-id', 'carol-id', 'dave-id']);
  });

  it('moves the whole history when an administrator took members off before the move, and it restores nobody', async (t) => {
    const { w, store, service, joins } = await joinedThenReimported(t);
    // Before the item was found deleted, an administrator took Farmhouse and dave off, so carol and dave are marked.
    await store.setManualAccess({ itemId: 'item-old', userIds: [], groupIds: ['house-a'] });
    assert.deepEqual(store.getRemovals('item-old'), { userIds: ['carol-id', 'dave-id'], groupIds: ['farmhouse'] });
    assert.deepEqual(store.get('item-old').joins, joins);

    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    assert.equal(store.get('item-old'), undefined);
    const moved = store.get('item-new');
    assert.deepEqual(moved.joins, joins, 'the whole remaining audience moved, so its whole history goes with it');
    assert.deepEqual([moved.requests, moved.manualUserIds, moved.groupIds, moved.owners], [{ 7: 'alice-id' }, [], ['house-a'], ['alice-id']]);
    assert.deepEqual(store.getRemovals('item-new'), { userIds: ['carol-id', 'dave-id'], groupIds: ['farmhouse'] });
    assert.deepEqual(w.blockedFrom(NEW_TAG), ['bob-id', 'carol-id', 'dave-id'], 'the history gives carol and dave nothing');
  });

  it('splits the history with the households that follow each requester and keeps the rest on the leftover', async (t) => {
    const w = world();
    const store = await newStore(t);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    await store.upsertGroup({ id: 'cottage', name: 'Cottage', userIds: ['bob-id'] });
    w.addItem('item-old');
    await store.grant({ itemId: 'item-old', requestId: '1', userId: 'alice-id' });
    await store.grant({ itemId: 'item-old', requestId: '2', userId: 'bob-id' });
    await store.grant({ itemId: 'item-old', requestId: '3', userId: 'carol-id' });
    await service.reconcileAll();
    // Each requester's household joins, then dave, in no household, joins himself.
    for (const userId of ['alice-id', 'bob-id', 'carol-id', 'dave-id']) await join(service, w, userId, 'item-old');
    const joins = store.get('item-old').joins;
    const byUser = Object.fromEntries(joins.map((entry) => [entry.userId, entry]));
    assert.deepEqual(joins.map((entry) => [entry.userId, entry.groupIds]), [
      ['alice-id', ['house-a']], ['bob-id', ['cottage']], ['carol-id', ['farmhouse']], ['dave-id', []],
    ]);
    // Request 1 resolves to item-a and 2 to item-b; carol's request 3 still names the deleted item.
    w.items.delete('item-old');
    w.addItem('item-a');
    w.addItem('item-b');
    w.request(1, { jellyfinMediaId: 'item-a' });
    w.request(2, { jellyfinMediaId: 'item-b' }, { requestedBy: { jellyfinUserId: 'bob-id' } });
    w.request(3, { jellyfinMediaId: 'item-old' }, { requestedBy: { jellyfinUserId: 'carol-id' } });
    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));

    const a = store.get('item-a');
    assert.deepEqual([a.requests, a.manualUserIds, a.groupIds], [{ 1: 'alice-id' }, [], ['house-a']]);
    assert.deepEqual(a.joins, [byUser['alice-id']], 'only House A\'s join goes to item-a');
    const b = store.get('item-b');
    assert.deepEqual([b.requests, b.manualUserIds, b.groupIds], [{ 2: 'bob-id' }, [], ['cottage']]);
    assert.deepEqual(b.joins, [byUser['bob-id']], 'only Cottage\'s join goes to item-b');
    const leftover = store.get('item-old');
    assert.equal(leftover.sync.state, 'orphaned');
    assert.deepEqual([leftover.requests, leftover.manualUserIds, leftover.groupIds], [{ 3: 'carol-id' }, ['dave-id'], ['farmhouse']]);
    assert.deepEqual(leftover.joins, joins, 'the leftover keeps its own list, the unassignable joins included');
    // Access is exactly what each grant's audience gives, whatever its history mentions.
    assert.deepEqual(w.blockedFrom(accessTag('item-a')), ['bob-id', 'carol-id', 'dave-id']);
    assert.deepEqual(w.blockedFrom(accessTag('item-b')), ['alice-id', 'carol-id', 'dave-id']);
  });

  it('merges into a target with its own history, keeping both sets once', async (t) => {
    const { w, store, service, joins } = await joinedThenReimported(t);
    // item-new already has bob's own request 9, which Cottage (bob) joined.
    await store.upsertGroup({ id: 'cottage', name: 'Cottage', userIds: ['bob-id'] });
    await store.grant({ itemId: 'item-new', requestId: '9', userId: 'bob-id' });
    w.request(9, { jellyfinMediaId: 'item-new' }, { requestedBy: { jellyfinUserId: 'bob-id' } });
    await join(service, w, 'bob-id', 'item-new');
    const own = store.get('item-new').joins;
    assert.equal(own.length, 1);

    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    assert.equal(store.get('item-old'), undefined);
    const merged = store.get('item-new');
    assert.deepEqual(history(merged), history({ joins: [...own, ...joins] }));
    assert.deepEqual([merged.requests, merged.manualUserIds, merged.groupIds], [{ 7: 'alice-id', 9: 'bob-id' }, ['dave-id'], ['cottage', 'farmhouse', 'house-a']]);
    assert.deepEqual(w.blockedFrom(NEW_TAG), []);
  });

  it('records each join once when a move is interrupted, repeated and finished after a restart', async (t) => {
    const file = path.join(await makeTempDir(t, 'jellypass-join-history-'), 'grants.json');
    const { w, store, service, joins } = await joinedThenReimported(t, file);
    // Applying item-new fails twice after the merge was stored, so the same move is merged twice.
    const updateItem = w.jellyfin.updateItem;
    w.jellyfin.updateItem = async (item) => { throw httpError(`Jellyfin POST /Items/${item.Id} returned 500`, 500); };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const { error } = await quietly(() => service.reconcileAll());
      assert.ok(error instanceof AggregateError, String(error));
      assert.deepEqual(store.get('item-new').joins, joins, `attempt ${attempt}: one copy on the target`);
      assert.deepEqual(store.get('item-old').joins, joins, `attempt ${attempt}: the source keeps its list`);
    }
    w.jellyfin.updateItem = updateItem;

    const restarted = await newStore(t, file);
    const { error } = await quietly(() => new AccessService(w.jellyfin, restarted, undefined, w.seerr).reconcileAll());
    assert.equal(error, undefined, String(error));
    assert.equal(restarted.get('item-old'), undefined);
    assert.deepEqual(restarted.get('item-new').joins, joins);
    assert.deepEqual(w.blockedFrom(NEW_TAG), ['bob-id']);
  });

  it('records each join once when an interrupted split is run again', async (t) => {
    const w = world();
    const store = await newStore(t);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    w.addItem('item-old');
    await store.grant({ itemId: 'item-old', requestId: '1', userId: 'alice-id' });
    await store.grant({ itemId: 'item-old', requestId: '3', userId: 'carol-id' });
    await service.reconcileAll();
    await join(service, w, 'alice-id', 'item-old');
    await join(service, w, 'carol-id', 'item-old');
    const joins = store.get('item-old').joins;
    w.items.delete('item-old');
    w.addItem('item-a');
    w.request(1, { jellyfinMediaId: 'item-a' });
    w.request(3, { jellyfinMediaId: 'item-old' }, { requestedBy: { jellyfinUserId: 'carol-id' } });
    const updateItem = w.jellyfin.updateItem;
    w.jellyfin.updateItem = async (item) => { throw httpError(`Jellyfin POST /Items/${item.Id} returned 500`, 500); };
    const failed = await quietly(() => service.reconcileAll());
    assert.ok(failed.error instanceof AggregateError, String(failed.error));
    w.jellyfin.updateItem = updateItem;
    for (let run = 1; run <= 2; run += 1) {
      const { error } = await quietly(() => service.reconcileAll());
      assert.equal(error, undefined, String(error));
      assert.deepEqual(store.get('item-a').joins, [joins[0]], `run ${run}: House A's join once on item-a`);
      assert.deepEqual(store.get('item-old').joins, joins, `run ${run}: the leftover keeps its own list once`);
    }
  });

  it('carries the history on an administrator\'s move, and its dry run changes nothing', async (t) => {
    const { w, store, service, joins } = await joinedThenReimported(t);
    // Seerr no longer links request 7 to any item, so only an administrator can move the grant.
    w.request(7, { jellyfinMediaId: 'item-old' });
    await store.upsertGroup({ id: 'cottage', name: 'Cottage', userIds: ['bob-id'] });
    await store.grant({ itemId: 'item-new', requestId: '9', userId: 'bob-id' });
    await join(service, w, 'bob-id', 'item-new');
    const own = store.get('item-new').joins;
    const before = store.list();
    const target = store.get('item-new');
    w.writes.length = 0;

    const planned = await service.remapGrant('item-old', 'item-new', true);
    assert.deepEqual(history(planned.current), history({ joins: [...own, ...joins] }));
    assert.deepEqual(store.list(), before, 'the dry run stores nothing');
    assert.deepEqual(w.writes, []);

    const { value: result, error } = await quietly(() => service.remapGrant('item-old', 'item-new'));
    assert.equal(error, undefined, String(error));
    assert.equal(store.get('item-old'), undefined);
    assertPreviewStored(planned.current, store.get('item-new'), target, 'the dry run plans the grant the move stores');
    assert.deepEqual(result.current, store.get('item-new'));
    assert.deepEqual(w.blockedFrom(NEW_TAG), []);
  });

  it('moves an orphaned split leftover\'s whole history onto one of its split targets without duplicates', async (t) => {
    const w = world();
    const store = await newStore(t);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    w.addItem('item-old');
    await store.grant({ itemId: 'item-old', requestId: '1', userId: 'alice-id' });
    await store.grant({ itemId: 'item-old', requestId: '3', userId: 'carol-id' });
    await service.reconcileAll();
    await join(service, w, 'alice-id', 'item-old');
    await join(service, w, 'carol-id', 'item-old');
    const joins = store.get('item-old').joins;
    w.items.delete('item-old');
    w.addItem('item-a');
    w.request(1, { jellyfinMediaId: 'item-a' });
    w.request(3, { jellyfinMediaId: 'item-old' }, { requestedBy: { jellyfinUserId: 'carol-id' } });
    await quietly(() => service.reconcileAll());
    assert.equal(store.get('item-old').sync.state, 'orphaned');
    assert.deepEqual(store.get('item-a').joins, [joins[0]]);
    const before = store.list();
    const target = store.get('item-a');

    const planned = await service.remapGrant('item-old', 'item-a', true);
    assert.deepEqual(planned.current.joins, joins);
    assert.deepEqual(store.list(), before, 'the dry run stores nothing');
    const { error } = await quietly(() => service.remapGrant('item-old', 'item-a'));
    assert.equal(error, undefined, String(error));
    assert.equal(store.get('item-old'), undefined);
    const a = store.get('item-a');
    assertPreviewStored(planned.current, a, target, 'the dry run plans the grant the move stores');
    assert.deepEqual(a.joins, joins, 'House A\'s join once, Farmhouse\'s join added');
    assert.deepEqual([a.requests, a.groupIds], [{ 1: 'alice-id', 3: 'carol-id' }, ['farmhouse', 'house-a']]);
    assert.deepEqual(w.blockedFrom(accessTag('item-a')), ['bob-id', 'dave-id']);
  });
});

/**
 * Every administrator dry run (manual access, bulk access, revoking a request, setting a grant's groups, moving a grant)
 * returns the grant its write stores: library join history, remap notes and sync status included.
 */
describe('administrator dry runs plan exactly what the write stores', { timeout: 10_000 }, () => {
  /**
   * item-1 has alice's request 7 (House A) and bob's request 8; carol joined Farmhouse to it. Its last move off it
   * found the item there again (a `remap` note). It was applied since, so it is synced with a last success.
   */
  async function joinedAndNoted(t) {
    const w = world();
    const store = await newStore(t);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    await store.upsertGroup({ id: 'cottage', name: 'Cottage', userIds: ['dave-id'] });
    w.addItem('item-1');
    w.addItem('item-2');
    await store.replaceCatalog(['item-1', 'item-2'].map((id) => ({ id, name: `Movie ${id}`, type: 'Movie', mediaType: 'movie', libraryId: 'movies', libraryName: 'Movies' })));
    await store.grant({ itemId: 'item-1', requestId: '7', userId: 'alice-id', groupIds: ['house-a'] });
    await store.grant({ itemId: 'item-1', requestId: '8', userId: 'bob-id' });
    await service.reconcileAll();
    w.titles.set('movie/603', 'item-1');
    const { value, error } = await quietly(() => service.joinLibrary({ userId: 'carol-id', isAdministrator: false, mediaType: 'movie', tmdbId: 603 }));
    assert.equal(error, undefined, String(error));
    assert.equal(value, 'joined');
    await store.markSourceReappeared('item-1', ['item-x']);
    await service.reconcileAll();
    const grant = store.get('item-1');
    assert.equal(grant.joins.length, 1);
    assert.ok(grant.remap?.sourceReappeared);
    assert.equal(grant.sync.state, 'synced');
    assert.ok(grant.sync.lastSuccessAt);
    w.writes.length = 0;
    return { w, store, service, grant };
  }

  /** Runs `write` as a dry run and for real; the dry run stores and changes nothing. */
  async function previewThenWrite(w, store, write) {
    const before = store.list();
    const planned = await write(true);
    assert.deepEqual(store.list(), before, 'the dry run stores nothing');
    assert.deepEqual(w.writes, [], 'the dry run changes nothing in Jellyfin');
    const { value, error } = await quietly(() => write(false));
    assert.equal(error, undefined, String(error));
    return { planned, written: value };
  }

  it('previews manual access with the grant\'s join history and remap note', async (t) => {
    const { w, store, service, grant } = await joinedAndNoted(t);
    const input = { itemId: 'item-1', userIds: ['dave-id'], groupIds: ['house-a', 'farmhouse'] };
    const { planned, written } = await previewThenWrite(w, store, (dryRun) => service.setManualAccess(input, dryRun));
    assert.deepEqual(planned.current.joins, grant.joins, 'carol\'s join is in the preview');
    assert.deepEqual(planned.previous, grant);
    assertPreviewStored(planned.current, store.get('item-1'), grant, 'manual access');
    assertPreviewStored(planned.current, written.current, grant, 'manual access result');
    assert.deepEqual(planned.plan, written.plan);
  });

  it('previews bulk manual access with each grant\'s join history and remap note', async (t) => {
    const { w, store, service, grant } = await joinedAndNoted(t);
    const input = { itemIds: ['item-1', 'item-2'], userIds: ['dave-id'], groupIds: ['farmhouse'] };
    const { planned, written } = await previewThenWrite(w, store, (dryRun) => service.setBulkManualAccess(input, dryRun));
    assert.deepEqual(planned.currents.map((current) => current.itemId), ['item-1', 'item-2']);
    assert.deepEqual(planned.currents[0].joins, grant.joins, 'carol\'s join is in the preview');
    assertPreviewStored(planned.currents[0], store.get('item-1'), grant, 'bulk access, existing grant');
    assertPreviewStored(planned.currents[1], store.get('item-2'), undefined, 'bulk access, new grant');
    planned.currents.forEach((current, index) => assertPreviewStored(current, written.currents[index], index === 0 ? grant : undefined, `bulk access result ${index}`));
    assert.deepEqual(planned.plans, written.plans);
  });

  it('previews revoking a request as the revocation stores it', async (t) => {
    const { w, store, service, grant } = await joinedAndNoted(t);
    const { planned, written } = await previewThenWrite(w, store, (dryRun) => service.revokeRequest('item-1', '8', dryRun));
    assert.deepEqual(planned.previous, grant);
    assertPreviewStored(planned.current, store.get('item-1'), grant, 'revocation');
    assertPreviewStored(planned.current, written.current, grant, 'revocation result');
    assert.deepEqual(planned.plan, written.plan);
  });

  it('previews setting a grant\'s groups as the change stores it', async (t) => {
    const { w, store, service, grant } = await joinedAndNoted(t);
    const { planned, written } = await previewThenWrite(w, store, (dryRun) => service.setGrantGroups('item-1', ['house-a', 'cottage'], dryRun));
    assert.deepEqual(planned.previous, grant);
    assert.deepEqual(planned.current.groupIds, ['cottage', 'house-a']);
    assertPreviewStored(planned.current, store.get('item-1'), grant, 'groups');
    assertPreviewStored(planned.current, written.current, grant, 'groups result');
    assert.deepEqual(planned.plan, written.plan);
  });
});

/**
 * item-1 has alice's request 7 (House A) and bob's request 8 and is shared with Farmhouse by carol's library join; dave's
 * request 9 was revoked from it (a revoked request and a removal mark). item-old was granted to House A through alice's
 * request 11, then deleted from Jellyfin; Seerr's request now names item-new. Everything was applied, then the state
 * file was written once more, so `snapshot` can tell any change apart.
 */
async function administered(t) {
  const w = world();
  const file = path.join(await makeTempDir(t, 'jellypass-write-order-test-'), 'grants.json');
  const store = await newStore(t, file);
  const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
  await store.upsertGroup({ id: 'cottage', name: 'Cottage', userIds: ['dave-id'] });
  for (const id of ['item-1', 'item-2', 'item-old', 'item-new']) w.addItem(id);
  await store.replaceCatalog(['item-1', 'item-2'].map((id) => ({ id, name: `Movie ${id}`, type: 'Movie', mediaType: 'movie', libraryId: 'movies', libraryName: 'Movies' })));
  await store.grant({ itemId: 'item-1', requestId: '7', userId: 'alice-id', groupIds: ['house-a'] });
  await store.grant({ itemId: 'item-1', requestId: '8', userId: 'bob-id' });
  await store.grant({ itemId: 'item-1', requestId: '9', userId: 'dave-id' });
  await store.grant({ itemId: 'item-old', requestId: '11', userId: 'alice-id', groupIds: ['house-a'] });
  await service.reconcileAll();
  w.titles.set('movie/603', 'item-1');
  const joined = await quietly(() => service.joinLibrary({ userId: 'carol-id', isAdministrator: false, mediaType: 'movie', tmdbId: 603 }));
  assert.equal(joined.error, undefined, String(joined.error));
  assert.equal(joined.value, 'joined', 'precondition: carol joined');
  const revoked = await quietly(() => service.revokeRequest('item-1', '9'));
  assert.equal(revoked.error, undefined, String(revoked.error));
  w.items.delete('item-old');
  w.request(11, { jellyfinMediaId: 'item-new' });
  const grant = store.get('item-1');
  assert.deepEqual(grant.groupIds, ['farmhouse', 'house-a'], 'precondition: shared with Farmhouse');
  assert.ok(store.isRequestRevoked('9', 'item-1'), 'precondition: request 9 was revoked');
  assert.equal(grant.sync.state, 'synced', 'precondition: item-1 is synced');
  await store.setUserPasswordless('bob-id', false);
  w.calls.length = 0;
  w.writes.length = 0;
  return { w, store, service, file };
}

/**
 * Everything stored about the grants, as the state file holds it and as the store holds it in memory (written out by an
 * idempotent save), plus the readable parts for a clearer failure message.
 */
async function snapshot(store, file) {
  const disk = await readFile(file, 'utf8');
  await store.setUserPasswordless('bob-id', false);
  const memory = await readFile(file, 'utf8');
  const itemIds = ['item-1', 'item-2', 'item-old', 'item-new'];
  return {
    grants: store.list(),
    removals: itemIds.map((id) => store.getRemovals(id)),
    revoked: ['7', '8', '9', '11'].flatMap((requestId) => itemIds.filter((id) => store.isRequestRevoked(requestId, id)).map((id) => `${requestId}:${id}`)),
    disk,
    memory,
  };
}

/** `write` rejects with `expected` and leaves the stored state and Jellyfin exactly as they were. */
async function assertFailsUntouched(w, store, file, write, expected, message) {
  const before = await snapshot(store, file);
  assert.equal(before.disk, before.memory, 'precondition: the file holds the state');
  const { error } = await quietly(write);
  assert.ok(error, `${message}: rejects`);
  assert.match(error.message, expected, message);
  assert.deepEqual(await snapshot(store, file), before, `${message}: nothing is stored`);
  assert.deepEqual(w.writes, [], `${message}: nothing changes in Jellyfin`);
}

/**
 * A write whose planning, validation or Jellyfin and Seerr lookups fail stores nothing: no grant, removal mark, revoked
 * request, join or sync status changes, and Jellyfin is not written to.
 */
describe('administrator writes that fail before storing leave everything as it was', { timeout: 10_000 }, () => {
  it('manual access whose Jellyfin item lookup fails', async (t) => {
    const { w, store, service, file } = await administered(t);
    w.failures.set('item-1', 503);
    const input = { itemId: 'item-1', userIds: ['dave-id'], groupIds: ['house-a'] };
    await assertFailsUntouched(w, store, file, () => service.setManualAccess(input), /returned 503/, 'manual access');
    // Nothing of the failed edit is waiting to take effect at the next reconcile either.
    w.failures.delete('item-1');
    const { error } = await quietly(() => service.reconcileAll());
    assert.equal(error, undefined, String(error));
    assert.deepEqual(w.blockedFrom(accessTag('item-1')), ['dave-id']);
  });

  it('manual access on an item Jellyfin no longer has', async (t) => {
    const { w, store, service, file } = await administered(t);
    w.items.delete('item-1');
    const input = { itemId: 'item-1', userIds: ['dave-id'], groupIds: ['house-a'] };
    await assertFailsUntouched(w, store, file, () => service.setManualAccess(input), /item-1/, 'manual access on a deleted item');
  });

  it('manual access with an unknown group or user', async (t) => {
    const { w, store, service, file } = await administered(t);
    await assertFailsUntouched(w, store, file, () => service.setManualAccess({ itemId: 'item-1', userIds: [], groupIds: ['nowhere'] }), /group not found/, 'unknown group');
    await assertFailsUntouched(w, store, file, () => service.setManualAccess({ itemId: 'item-1', userIds: ['erin-id'], groupIds: [] }), /user not found/, 'unknown user');
  });

  it('bulk access whose Jellyfin item lookup fails', async (t) => {
    const { w, store, service, file } = await administered(t);
    w.failures.set('item-2', 503);
    const input = { itemIds: ['item-1', 'item-2'], userIds: ['dave-id'], groupIds: ['house-a'] };
    await assertFailsUntouched(w, store, file, () => service.setBulkManualAccess(input), /returned 503/, 'bulk access');
  });

  it('bulk access on an item Jellyfin no longer has', async (t) => {
    const { w, store, service, file } = await administered(t);
    w.items.delete('item-2');
    const input = { itemIds: ['item-1', 'item-2'], userIds: ['dave-id'], groupIds: ['house-a'] };
    await assertFailsUntouched(w, store, file, () => service.setBulkManualAccess(input), /returned 404/, 'bulk access on a deleted item');
  });

  it('revoking a request the grant does not have', async (t) => {
    const { w, store, service, file } = await administered(t);
    await assertFailsUntouched(w, store, file, () => service.revokeRequest('item-1', '9'), /request grant not found/, 'an already revoked request');
    await assertFailsUntouched(w, store, file, () => service.revokeRequest('item-2', '7'), /request grant not found/, 'another item\'s request');
  });

  it('setting groups that do not exist, or on a grant that does not', async (t) => {
    const { w, store, service, file } = await administered(t);
    await assertFailsUntouched(w, store, file, () => service.setGrantGroups('item-1', ['house-a', 'nowhere']), /group not found/, 'unknown group');
    await assertFailsUntouched(w, store, file, () => service.setGrantGroups('item-2', ['house-a']), /grant not found/, 'no grant');
  });

  it('moving a grant whose Jellyfin or Seerr lookups fail', async (t) => {
    const { w, store, service, file } = await administered(t);
    w.failures.set('item-new', 503);
    await assertFailsUntouched(w, store, file, () => service.remapGrant('item-old', 'item-new'), /returned 503/, 'target lookup');
    w.failures.delete('item-new');
    w.failures.set('item-old', 503);
    await assertFailsUntouched(w, store, file, () => service.remapGrant('item-old', 'item-new'), /returned 503/, 'source lookup');
    w.failures.delete('item-old');
    w.failures.set('seerr:11', 503);
    await assertFailsUntouched(w, store, file, () => service.remapGrant('item-old', 'item-new'), /returned 503/, 'Seerr lookup');
    w.failures.delete('seerr:11');
    w.request(11, { jellyfinMediaId: 'item-other', jellyfinMediaId4k: 'item-new' });
    await assertFailsUntouched(w, store, file, () => service.remapGrant('item-old', 'item-new'), /never moves between them/, 'other quality');
    await assertFailsUntouched(w, store, file, () => service.remapGrant('item-old', 'item-gone'), /Jellyfin item not found/, 'missing target');
    w.addItem('item-old');
    await assertFailsUntouched(w, store, file, () => service.remapGrant('item-old', 'item-new'), /still exists|exists/, 'source still exists');
  });
});

/** A dry run works on its own copy of the state: whatever happens to it, or around it, the real state is untouched. */
describe('dry runs are isolated from the stored state', { timeout: 10_000 }, () => {
  const move = { itemId: 'item-new', requests: { 11: 'alice-id' }, manualUserIds: ['bob-id'], groupIds: ['cottage'], mediaType: 'movie' };

  /** Runs every store preview once, with changes that differ from anything stored. */
  function previewAll(store) {
    return {
      manual: store.previewManualAccessBatch([
        { itemId: 'item-1', userIds: ['bob-id'], groupIds: ['cottage'] },
        { itemId: 'item-2', userIds: ['dave-id'], groupIds: [] },
      ]),
      groups: store.previewGrantGroups('item-1', ['cottage']),
      revoke: store.previewRevokeRequest('item-1', '7'),
      merge: store.previewMerge('item-old', move),
    };
  }

  it('a preview while a real write is paused or queued changes neither the real nor the stored state', async (t) => {
    const { w, store, service, file } = await administered(t);
    const updatePolicy = w.jellyfin.updatePolicy;
    let reached;
    const paused = new Promise((resolve) => { reached = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    w.jellyfin.updatePolicy = async (...args) => {
      reached();
      await gate;
      return updatePolicy(...args);
    };
    const write = quietly(() => service.setManualAccess({ itemId: 'item-1', userIds: ['dave-id'], groupIds: ['house-a'] }));
    await paused;
    // The write is stored and paused applying it; a service dry run queues behind it.
    const during = await snapshot(store, file);
    assert.deepEqual(store.get('item-1').manualUserIds, ['dave-id']);
    const queued = service.setGrantGroups('item-1', ['cottage'], true);
    const previews = previewAll(store);
    assert.deepEqual(previews.manual[0].current.groupIds, ['cottage']);
    assert.deepEqual(await snapshot(store, file), during, 'previews while the write is paused change nothing');
    release();
    const { error } = await write;
    assert.equal(error, undefined, String(error));
    const dryRun = await queued;
    const stored = store.get('item-1');
    assert.deepEqual(dryRun.previous, stored, 'the queued dry run plans from the written and applied grant');
    const after = await snapshot(store, file);
    assert.equal(after.disk, after.memory);
    assert.deepEqual([stored.manualUserIds, stored.groupIds, stored.sync.state], [['dave-id'], ['house-a'], 'synced']);
    assert.deepEqual(store.get('item-2'), undefined);
    assert.deepEqual(store.get('item-old'), during.grants.find((grant) => grant.itemId === 'item-old'));
    assert.deepEqual(JSON.parse(after.disk).grants['item-1'], stored);
  });

  it('changing what a preview returns does not change the real state', async (t) => {
    const { store, service, file } = await administered(t);
    const before = await snapshot(store, file);
    const previews = previewAll(store);
    const dryRun = await service.setManualAccess({ itemId: 'item-1', userIds: ['dave-id'], groupIds: ['house-a'] }, true);
    const grants = [
      ...previews.manual.flatMap((result) => [result.previous, result.current]),
      previews.groups.previous, previews.groups.current,
      previews.revoke.previous, previews.revoke.current,
      previews.merge,
      dryRun.previous, dryRun.current,
    ].filter(Boolean);
    for (const grant of grants) {
      grant.manualUserIds.push('erin-id');
      grant.groupIds.push('nowhere');
      grant.owners.push('erin-id');
      grant.requests['99'] = 'erin-id';
      delete grant.requests['7'];
      grant.joins?.push({ userId: 'erin-id', groupIds: [], joinedAt: new Date(0).toISOString() });
      if (grant.joins?.[0]) grant.joins[0].userId = 'erin-id';
      grant.sync.state = 'error';
      grant.active = false;
    }
    assert.deepEqual(await snapshot(store, file), before);
  });

  it('a preview that throws leaves the state as it was', async (t) => {
    const { store, file } = await administered(t);
    const before = await snapshot(store, file);
    // The first item is changed on the copy before the second one throws.
    assert.throws(() => store.previewManualAccessBatch([
      { itemId: 'item-1', userIds: ['dave-id'], groupIds: [] },
      { itemId: 'item-2', userIds: [], groupIds: ['nowhere'] },
    ]), /group not found/);
    assert.throws(() => store.previewGrantGroups('item-1', ['nowhere']), /group not found/);
    assert.throws(() => store.previewMerge('item-gone', { ...move, itemId: 'item-1' }), /grant not found/);
    assert.deepEqual(await snapshot(store, file), before);
  });
});

/**
 * The store's multi-step writes are all-or-nothing on their own, without the service's validation and dry run in front
 * of them: one that throws after changing part of the state keeps none of it, in memory or in a later save.
 */
describe('store writes that throw partway leave everything as it was', { timeout: 10_000 }, () => {
  it('a manual access batch whose second item names a missing group', async (t) => {
    const { w, store, file } = await administered(t);
    // The first item is valid and would change item-1 and its removal marks before the second one throws.
    await assertFailsUntouched(w, store, file, () => store.setManualAccessBatch([
      { itemId: 'item-1', userIds: ['dave-id'], groupIds: [] },
      { itemId: 'item-2', userIds: ['bob-id'], groupIds: ['nowhere'] },
    ]), /group not found: nowhere/, 'manual access batch');
  });

  it('a grant merge whose second move is malformed', async (t) => {
    const { w, store, file } = await administered(t);
    assert.ok(store.isAccessRemoved('item-1', 'userIds', 'dave-id'), 'precondition: item-1 has removal marks to carry');
    // The first move carries item-1's removal marks and revoked requests to item-2 before the second one throws.
    await assertFailsUntouched(w, store, file, () => store.mergeGrants('item-1', [
      { itemId: 'item-2', requests: { 7: 'alice-id' }, manualUserIds: [], groupIds: ['house-a'], mediaType: 'movie' },
      { itemId: 'item-new', requests: null, manualUserIds: [], groupIds: [], mediaType: 'movie' },
    ]), /null/, 'grant merge');
  });

  it('a sync success batch whose second ID is not a string', async (t) => {
    const { w, store, file } = await administered(t);
    await assertFailsUntouched(w, store, file, () => store.markSyncSuccessBatch(['item-old', null]), /null/, 'sync success batch');
  });

  it('a sync error batch whose second ID is not a string', async (t) => {
    const { w, store, file } = await administered(t);
    await assertFailsUntouched(w, store, file, () => store.markSyncErrorBatch(['item-1', null], 'boom'), /null/, 'sync error batch');
  });
});
