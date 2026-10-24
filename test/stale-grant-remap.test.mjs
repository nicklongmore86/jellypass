import assert from 'node:assert/strict';
import path from 'node:path';
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
  const seerr = {
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
    calls,
    writes,
    addItem(id, tags = []) { items.set(id, { Id: id, Name: `Movie ${id}`, Type: 'Movie', Tags: tags }); },
    tags(id) { return items.get(id)?.Tags ?? []; },
    /** The non-administrators blocked from the item tagged `tag`. */
    blockedFrom(tag) { return users.filter((user) => !user.Policy.IsAdministrator && user.Policy.BlockedTags.includes(tag)).map((user) => user.Id); },
    blocked(userId) { return users.find((user) => user.Id === userId).Policy.BlockedTags; },
    request(id, media, extra = {}) {
      requests.set(String(id), { id, type: 'movie', requestedBy: { jellyfinUserId: 'alice-id' }, media: { mediaType: 'movie', status: 5, ...media }, ...extra });
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
