import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import { AccessService, OperationCancelledError, accessTag } from '../dist/access-service.js';
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
    blocked(userId) { return users.find((user) => user.Id === userId).Policy.BlockedTags; },
    request(id, media, extra = {}) {
      requests.set(String(id), { id, type: 'movie', requestedBy: { jellyfinUserId: 'alice-id' }, media: { mediaType: 'movie', status: 5, ...media }, ...extra });
    },
  };
}

async function newStore(t) {
  const store = new GrantStore(path.join(await makeTempDir(t, 'jellypass-remap-test-'), 'grants.json'));
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

  it('splits requests that now resolve to different items and keeps the manual audience on each', async (t) => {
    const w = world();
    const store = await newStore(t);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    w.addItem('item-a');
    w.addItem('item-b');
    await store.grant({ itemId: 'item-old', requestId: '1', userId: 'alice-id' });
    await store.grant({ itemId: 'item-old', requestId: '2', userId: 'bob-id' });
    await store.grant({ itemId: 'item-old', requestId: '3', userId: 'carol-id' });
    await store.grant({ itemId: 'item-old', requestId: '4', userId: 'dave-id' });
    await store.setManualAccess({ itemId: 'item-old', userIds: ['dave-id'], groupIds: ['farmhouse'] });
    w.request(1, { jellyfinMediaId: 'item-a' });
    w.request(2, { jellyfinMediaId: 'item-a' });
    w.request(3, { jellyfinMediaId: 'item-b' });
    // Request 4 no longer exists in Seerr: it moves with the item most requests went to.
    await quietly(() => service.reconcileAll());
    assert.equal(store.get('item-old'), undefined);
    assert.deepEqual(store.get('item-a').requests, { 1: 'alice-id', 2: 'bob-id', 4: 'dave-id' });
    assert.deepEqual(store.get('item-b').requests, { 3: 'carol-id' });
    for (const id of ['item-a', 'item-b']) {
      assert.deepEqual(store.get(id).manualUserIds, ['dave-id']);
      assert.deepEqual(store.get(id).groupIds, ['farmhouse']);
    }
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

  it('makes a source item that still exists public again', async (t) => {
    const w = world();
    const store = await newStore(t);
    const service = new AccessService(w.jellyfin, store, undefined, w.seerr);
    w.addItem('item-old');
    w.addItem('item-new');
    await store.grant({ itemId: 'item-old', requestId: '7', userId: 'alice-id' });
    await service.reconcileAll();
    await quietly(() => service.remapGrant('item-old', 'item-new'));
    assert.ok(!w.tags('item-old').includes(OLD_TAG));
    assert.ok(!w.blocked('bob-id').includes(OLD_TAG));
    assert.ok(w.blocked('bob-id').includes(NEW_TAG));
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
    const { store, service } = await reimported(t);
    const server = makeServer(service, { webhook: 'webhook-token', admin: 'admin-token' });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (itemId, body, query = '') => fetch(`${base}/v1/grants/${itemId}/remap${query}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const { value: responses } = await quietly(async () => [
      await post('item-old', { toItemId: 'item-new' }, '?dryRun=true'),
      await post('item-none', { toItemId: 'item-new' }),
      await post('item-old', { toItemId: '../etc' }),
      await post('item-old', { toItemId: 'item-new' }),
    ]);
    const [planned, missing, invalid, remapped] = responses;
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
