import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import { AccessService, OperationCancelledError } from '../dist/access-service.js';
import { BackgroundTasks, createShutdown } from '../dist/shutdown.js';
import { GrantStore } from '../dist/store.js';
import { makeTempDir } from './support/temp-dir.mjs';

describe('stopping background work on shutdown', { timeout: 10_000 }, () => {
  async function newStore(t) {
    const store = new GrantStore(path.join(await makeTempDir(t, 'jellypass-background-test-'), 'grants.json'));
    await store.load();
    return store;
  }

  it('reconcileAll starts no further grant once its signal is aborted', async (t) => {
    const store = await newStore(t);
    await store.setManualAccess({ itemId: 'item-1', userIds: ['alice-id'], groupIds: [] });
    await store.setManualAccess({ itemId: 'item-2', userIds: ['alice-id'], groupIds: [] });
    const controller = new AbortController();
    const fetched = [];
    const jellyfin = {
      async getItem(itemId) {
        fetched.push(itemId);
        // Shutdown begins while the first grant is being reconciled.
        controller.abort(new Error('shutting down'));
        throw new Error('Jellyfin unavailable');
      },
      async getUsers() { return []; },
    };
    const service = new AccessService(jellyfin, store);
    await assert.rejects(service.reconcileAll({ dueOnly: true, signal: controller.signal }), /shutting down/);
    assert.equal(fetched.length, 1, `reconciled ${fetched.join(', ')} after shutdown began`);
  });

  it('reconcileAll does nothing when shutdown began before it ran', async (t) => {
    const store = await newStore(t);
    await store.setManualAccess({ itemId: 'item-1', userIds: ['alice-id'], groupIds: [] });
    const fetched = [];
    const jellyfin = {
      async getItem(itemId) { fetched.push(itemId); throw new Error('Jellyfin unavailable'); },
      async getUsers() { return []; },
    };
    const service = new AccessService(jellyfin, store);
    await assert.rejects(service.reconcileAll({ dueOnly: true, signal: AbortSignal.abort(new Error('shutting down')) }), /shutting down/);
    assert.deepEqual(fetched, []);
  });

  it('backfillRequests starts no further request once its signal is aborted', async (t) => {
    const store = await newStore(t);
    const controller = new AbortController();
    const looked = [];
    const seerr = {
      async listRequestsSince() {
        controller.abort(new Error('shutting down'));
        return [{ id: 1, media: { status: 5 } }, { id: 2, media: { status: 5 } }];
      },
      async getRequest(requestId) {
        looked.push(requestId);
        return { id: Number(requestId), media: { status: 5, jellyfinMediaId: `item-${requestId}` }, requestedBy: { jellyfinUserId: 'alice-id' } };
      },
    };
    const jellyfin = { async getUsers() { return [{ Id: 'alice-id' }]; }, async getItem() { return {}; } };
    const service = new AccessService(jellyfin, store, undefined, seerr);
    await assert.rejects(service.backfillRequests(new Date(0), { signal: controller.signal }), /shutting down/);
    assert.deepEqual(looked, []);
    assert.equal(store.hasHandledRequest('1'), false);
  });

  it('syncLibraryCatalog does not replace the catalog when shutdown began during the fetch', async (t) => {
    const store = await newStore(t);
    const controller = new AbortController();
    const jellyfin = {
      async fetchLibraryCatalog() {
        controller.abort(new Error('shutting down'));
        return [{ id: 'item-1', name: 'Movie', type: 'Movie' }];
      },
    };
    const service = new AccessService(jellyfin, store);
    await assert.rejects(service.syncLibraryCatalog({ signal: controller.signal }), /shutting down/);
    assert.deepEqual(store.getCatalog().items, []);
  });

  it('BackgroundTasks.stop() aborts running tasks, waits for them, and refuses new ones', async () => {
    const background = new BackgroundTasks();
    const events = [];
    background.run((signal) => new Promise((resolve) => {
      signal.addEventListener('abort', () => setTimeout(() => {
        events.push('task finished');
        resolve();
      }, 20));
    }));
    await background.stop();
    events.push('stopped');
    let started = false;
    background.run(async () => { started = true; });
    assert.deepEqual(events, ['task finished', 'stopped']);
    assert.equal(started, false);
  });

  it('shutdown waits for background work before closing the store', async () => {
    const events = [];
    const exits = [];
    await createShutdown({
      servers: [],
      timers: () => [],
      background: { stop: () => new Promise((resolve) => setTimeout(() => { events.push('background stopped'); resolve(); }, 50)) },
      closeStore: async () => { events.push('store closed'); },
      exit: (code) => exits.push(code),
      log: () => {},
    })('SIGTERM');
    assert.deepEqual(events, ['background stopped', 'store closed']);
    assert.deepEqual(exits, [0]);
  });

  it('shutdown stops waiting for background work after the grace period', async () => {
    const exits = [];
    const logs = [];
    const startedAt = performance.now();
    await createShutdown({
      servers: [],
      timers: () => [],
      background: { stop: () => new Promise(() => {}) },
      closeStore: async () => {},
      graceMs: 100,
      exit: (code) => exits.push(code),
      log: (level, message) => logs.push(message),
    })('SIGTERM');
    const elapsed = performance.now() - startedAt;
    assert.deepEqual(exits, [0]);
    assert.ok(elapsed >= 95 && elapsed < 1_000, `shutdown took ${elapsed.toFixed(0)} ms`);
    assert.ok(logs.includes('background work still running; shutting down without waiting for it'));
  });
});

/**
 * A recorded backfill/reconcile world: every Jellyfin and Seerr call is logged, and `abortAt` aborts the run inside the
 * named call (the call itself still completes, like a fetch already in flight).
 */
function recordingWorld(abortAt) {
  const controller = new AbortController();
  const calls = [];
  const increments = [];
  const record = (name, value) => {
    calls.push(name);
    if (name === abortAt) controller.abort(new Error('shutting down'));
    return value;
  };
  const users = [
    { Id: 'admin-id', Name: 'Admin', Policy: { IsAdministrator: true, BlockedTags: [] } },
    { Id: 'alice-id', Name: 'Alice', Policy: { BlockedTags: [] } },
    { Id: 'bob-id', Name: 'Bob', Policy: { BlockedTags: [] } },
  ];
  const jellyfin = {
    getUsers: async () => record('getUsers', structuredClone(users)),
    getItem: async (itemId) => record('getItem', { Id: itemId, Name: 'Movie', Type: 'Movie', Tags: [] }),
    getLocalTrailers: async () => record('getLocalTrailers', []),
    updateItem: async () => record('updateItem'),
    updatePolicy: async () => record('updatePolicy'),
    fetchLibraryCatalog: async () => record('fetchLibraryCatalog', [{ id: 'item-1', name: 'Movie', type: 'Movie' }]),
  };
  const seerr = {
    listRequestsSince: async () => record('listRequestsSince', [{ id: 7, media: { status: 5 } }]),
    getRequest: async (requestId) => record('getRequest', {
      id: Number(requestId), media: { status: 5, jellyfinMediaId: 'item-1', mediaType: 'movie' }, requestedBy: { jellyfinUserId: 'alice-id' },
    }),
  };
  const metrics = {
    increment: (name, labels) => increments.push({ name, ...labels }),
    gauge: () => {},
    render: () => '',
  };
  return { controller, calls, increments, jellyfin, seerr, metrics };
}

describe('cancellation inside an active background run', { timeout: 10_000 }, () => {
  async function newStore(t) {
    const store = new GrantStore(path.join(await makeTempDir(t, 'jellypass-cancel-test-'), 'grants.json'));
    await store.load();
    return store;
  }

  async function quietly(run) {
    const errors = mock.method(console, 'error', () => {});
    const infos = mock.method(console, 'log', () => {});
    try {
      const error = await run().then(() => undefined, (caught) => caught);
      return { error, errorLogs: errors.mock.calls.map((call) => call.arguments.join(' ')), infoLogs: infos.mock.calls.map((call) => call.arguments.join(' ')) };
    } finally {
      errors.mock.restore();
      infos.mock.restore();
    }
  }

  const BACKFILL_ABORT_POINTS = [
    ['getRequest', ['listRequestsSince', 'getRequest']],
    ['getUsers', ['listRequestsSince', 'getRequest', 'getUsers']],
    ['getItem', ['listRequestsSince', 'getRequest', 'getUsers', 'getItem']],
  ];
  for (const [abortAt, expectedCalls] of BACKFILL_ABORT_POINTS) {
    it(`backfill aborted inside ${abortAt}() makes no further call, stores no grant, and logs and counts nothing`, async (t) => {
      const world = recordingWorld(abortAt);
      const store = await newStore(t);
      const service = new AccessService(world.jellyfin, store, world.metrics, world.seerr);
      const { error, errorLogs, infoLogs } = await quietly(() => service.backfillRequests(new Date(0), { signal: world.controller.signal }));
      assert.ok(error instanceof OperationCancelledError, String(error));
      assert.deepEqual(world.calls, expectedCalls);
      assert.equal(store.get('item-1'), undefined);
      assert.equal(store.hasHandledRequest('7'), false);
      assert.deepEqual(world.increments, []);
      assert.deepEqual(errorLogs, []);
      assert.deepEqual(infoLogs, []);
    });
  }

  for (const abortAt of ['getLocalTrailers', 'updateItem']) {
    it(`backfill aborted while reconciling its new grant (inside ${abortAt}()) applies nothing further and logs and counts nothing`, async (t) => {
      const world = recordingWorld(abortAt);
      const store = await newStore(t);
      const service = new AccessService(world.jellyfin, store, world.metrics, world.seerr);
      const { error, errorLogs, infoLogs } = await quietly(() => service.backfillRequests(new Date(0), { signal: world.controller.signal }));
      assert.ok(error instanceof OperationCancelledError, String(error));
      assert.equal(world.calls.at(-1), abortAt, `calls after the abort: ${world.calls.join(', ')}`);
      assert.ok(!world.calls.includes('updatePolicy'));
      assert.deepEqual(world.increments.filter((entry) => entry.name !== 'jfa_item_updates_total'), []);
      assert.deepEqual(errorLogs, []);
      assert.deepEqual(infoLogs, []);
      // The grant was stored before the abort; it stays pending (not failed) and is reconciled after restart.
      assert.equal(store.get('item-1')?.sync.state, 'pending');
    });
  }

  for (const [abortAt, expectedCalls] of [
    ['getUsers', ['getItem', 'getUsers']],
    ['getLocalTrailers', ['getItem', 'getUsers', 'getLocalTrailers']],
    ['updateItem', ['getItem', 'getUsers', 'getLocalTrailers', 'updateItem']],
  ]) {
    it(`reconcileAll aborted inside ${abortAt}() makes no further call, leaves the grant pending, and counts nothing`, async (t) => {
      const world = recordingWorld(abortAt);
      const store = await newStore(t);
      await store.setManualAccess({ itemId: 'item-1', userIds: ['alice-id'], groupIds: [] });
      await store.setManualAccess({ itemId: 'item-2', userIds: ['alice-id'], groupIds: [] });
      const service = new AccessService(world.jellyfin, store, world.metrics);
      const { error, errorLogs } = await quietly(() => service.reconcileAll({ dueOnly: true, signal: world.controller.signal }));
      assert.ok(error instanceof OperationCancelledError, String(error));
      assert.deepEqual(world.calls, expectedCalls);
      assert.deepEqual(world.increments.filter((entry) => entry.name !== 'jfa_item_updates_total'), []);
      assert.deepEqual(errorLogs, []);
      assert.equal(store.get('item-1').sync.state, 'pending');
      assert.equal(store.get('item-1').sync.attempts, 0);
    });
  }

  it('catalog sync aborted inside fetchLibraryCatalog() stores nothing and rejects as cancelled', async (t) => {
    const world = recordingWorld('fetchLibraryCatalog');
    const store = await newStore(t);
    const service = new AccessService(world.jellyfin, store, world.metrics);
    const { error, errorLogs } = await quietly(() => service.syncLibraryCatalog({ signal: world.controller.signal }));
    assert.ok(error instanceof OperationCancelledError, String(error));
    assert.deepEqual(world.calls, ['fetchLibraryCatalog']);
    assert.deepEqual(store.getCatalog().items, []);
    assert.deepEqual(errorLogs, []);
  });

  it('reconciliation without a signal (webhook and admin paths) runs to completion as before', async (t) => {
    const world = recordingWorld(undefined);
    const store = await newStore(t);
    await store.setManualAccess({ itemId: 'item-1', userIds: ['alice-id'], groupIds: [] });
    const service = new AccessService(world.jellyfin, store, world.metrics);
    await service.reconcileAll();
    assert.deepEqual(world.calls, ['getItem', 'getUsers', 'getLocalTrailers', 'updateItem', 'updatePolicy']);
    assert.equal(store.get('item-1').sync.state, 'synced');
    assert.ok(world.increments.some((entry) => entry.name === 'jfa_reconciliations_total' && entry.result === 'success'));
  });
});

describe('cancellation while a reconciliation save is finishing', { timeout: 10_000 }, () => {
  async function newStore(t) {
    const store = new GrantStore(path.join(await makeTempDir(t, 'jellypass-boundary-test-'), 'grants.json'));
    await store.load();
    return store;
  }

  /** Lets `method` finish its save, then aborts: shutdown arriving exactly as the write completes. */
  function abortAfter(store, method, controller, calls) {
    const original = store[method].bind(store);
    store[method] = async (...args) => {
      calls.push(method);
      await original(...args);
      controller.abort(new Error('shutting down'));
    };
  }

  function track(store, method, calls) {
    const original = store[method].bind(store);
    store[method] = async (...args) => {
      calls.push(method);
      return original(...args);
    };
  }

  async function quietly(run) {
    const errors = mock.method(console, 'error', () => {});
    const infos = mock.method(console, 'log', () => {});
    try {
      const error = await run().then(() => undefined, (caught) => caught);
      return { error, logs: [...errors.mock.calls, ...infos.mock.calls].map((call) => call.arguments.join(' ')) };
    } finally {
      errors.mock.restore();
      infos.mock.restore();
    }
  }

  it('does not purge an inactive grant or record success when shutdown aborts during the success save', async (t) => {
    const world = recordingWorld(undefined);
    const store = await newStore(t);
    await store.grant({ itemId: 'item-1', requestId: 'r', userId: 'alice-id' });
    await store.revokeRequest('item-1', 'r');
    const storeCalls = [];
    abortAfter(store, 'markSyncSuccess', world.controller, storeCalls);
    track(store, 'purgeInactive', storeCalls);
    const service = new AccessService(world.jellyfin, store, world.metrics);
    const { error, logs } = await quietly(() => service.reconcileAll({ dueOnly: true, signal: world.controller.signal }));
    assert.ok(error instanceof OperationCancelledError, String(error));
    assert.deepEqual(storeCalls, ['markSyncSuccess']);
    assert.ok(store.get('item-1'), 'the grant was purged after shutdown began');
    assert.deepEqual(world.increments, []);
    assert.deepEqual(logs, []);
  });

  it('records no success when shutdown aborts while an inactive grant is being purged', async (t) => {
    const world = recordingWorld(undefined);
    const store = await newStore(t);
    await store.grant({ itemId: 'item-1', requestId: 'r', userId: 'alice-id' });
    await store.revokeRequest('item-1', 'r');
    abortAfter(store, 'purgeInactive', world.controller, []);
    const service = new AccessService(world.jellyfin, store, world.metrics);
    const { error, logs } = await quietly(() => service.reconcileAll({ dueOnly: true, signal: world.controller.signal }));
    assert.ok(error instanceof OperationCancelledError, String(error));
    assert.deepEqual(world.increments, []);
    assert.deepEqual(logs, []);
  });

  it('records no granted backfill when shutdown aborts during the new grant\'s success save', async (t) => {
    const world = recordingWorld(undefined);
    const store = await newStore(t);
    abortAfter(store, 'markSyncSuccess', world.controller, []);
    const service = new AccessService(world.jellyfin, store, world.metrics, world.seerr);
    const { error, logs } = await quietly(() => service.backfillRequests(new Date(0), { signal: world.controller.signal }));
    assert.ok(error instanceof OperationCancelledError, String(error));
    assert.deepEqual(world.increments.filter((entry) => !['jfa_item_updates_total', 'jfa_policy_updates_total'].includes(entry.name)), []);
    assert.deepEqual(logs, []);
    assert.equal(store.get('item-1')?.sync.state, 'synced');
  });

  it('records no error when shutdown aborts while a failed reconciliation is being saved', async (t) => {
    const world = recordingWorld(undefined);
    world.jellyfin.getLocalTrailers = async () => { throw new Error('Jellyfin unavailable'); };
    const store = await newStore(t);
    await store.setManualAccess({ itemId: 'item-1', userIds: ['alice-id'], groupIds: [] });
    abortAfter(store, 'markSyncError', world.controller, []);
    const service = new AccessService(world.jellyfin, store, world.metrics);
    const { error, logs } = await quietly(() => service.reconcileAll({ dueOnly: true, signal: world.controller.signal }));
    assert.ok(error instanceof OperationCancelledError, String(error));
    assert.deepEqual(world.increments, []);
    assert.deepEqual(logs, []);
  });
});
