import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AccessService } from '../dist/access-service.js';
import { BackgroundTasks, createShutdown } from '../dist/shutdown.js';
import { GrantStore } from '../dist/store.js';

describe('stopping background work on shutdown', { timeout: 10_000 }, () => {
  async function newStore() {
    const store = new GrantStore(path.join(await mkdtemp(path.join(tmpdir(), 'jellypass-background-test-')), 'grants.json'));
    await store.load();
    return store;
  }

  it('reconcileAll starts no further grant once its signal is aborted', async () => {
    const store = await newStore();
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

  it('reconcileAll does nothing when shutdown began before it ran', async () => {
    const store = await newStore();
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

  it('backfillRequests starts no further request once its signal is aborted', async () => {
    const store = await newStore();
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

  it('syncLibraryCatalog does not replace the catalog when shutdown began during the fetch', async () => {
    const store = await newStore();
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
