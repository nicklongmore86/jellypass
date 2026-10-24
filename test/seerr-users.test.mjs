import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SeerrError, SeerrUserClient, seerrUserId } from '../dist/seerr.js';
import { SEERR_USER_CACHE_MAX, SEERR_USER_MISSING_TTL_MS, SEERR_USER_TTL_MS, SeerrUserMap } from '../dist/seerr-users.js';

const ALICE = 'aaaaaaaa-0000-0000-0000-000000000001';
const BOB = 'bbbbbbbb-0000-0000-0000-000000000002';
const jellyfinId = (index) => index.toString(16).padStart(32, '0');

/**
 * A stand-in for the admin-key SeerrClient that records lookups. `users` is Seerr's current Jellyfin-to-Seerr link and
 * can be changed between calls; while `gate` is set, lookups wait for it.
 */
function fakeSeerr(users = { [ALICE.replaceAll('-', '')]: 11 }) {
  return {
    users,
    lookups: [],
    checks: [],
    failNext: undefined,
    gate: undefined,
    async findUserByJellyfinId(id) {
      this.lookups.push(id);
      const answer = this.users[id];
      if (this.gate) await this.gate;
      if (this.failNext) {
        const error = this.failNext;
        this.failNext = undefined;
        throw error;
      }
      return answer === undefined ? undefined : { id: seerrUserId(answer), jellyfinUserId: id };
    },
    async jellyfinUserIdOf(user) {
      this.checks.push(user);
      return Object.keys(this.users).find((id) => this.users[id] === user);
    },
    asUser(user, options) {
      return new SeerrUserClient('http://seerr.test', 'key', user, options);
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function clock(start = 1_000_000) {
  const time = { now: start };
  return { time, now: () => time.now };
}

describe('Jellyfin to Seerr user map', () => {
  it('uses a one-minute TTL for found and missing users, and at most 1000 entries', () => {
    assert.equal(SEERR_USER_TTL_MS, 60_000);
    assert.equal(SEERR_USER_MISSING_TTL_MS, 60_000);
    assert.equal(SEERR_USER_CACHE_MAX, 1_000);
  });

  it('gives a mapped Jellyfin user a client acting as their Seerr user', async () => {
    const map = new SeerrUserMap(fakeSeerr());
    const client = await map.clientFor(ALICE);
    assert.ok(client instanceof SeerrUserClient);
    assert.equal(client.userId, 11);
    assert.equal(await map.seerrUserId(ALICE.toUpperCase()), 11);
  });

  it('fails closed for an unmapped user or an ID that is not a Jellyfin ID, without any admin fallback', async () => {
    const seerr = fakeSeerr();
    const map = new SeerrUserMap(seerr);
    assert.equal(await map.clientFor(BOB), undefined);
    for (const id of ['', 'alice-id', '1', '../user', undefined]) {
      assert.equal(await map.clientFor(String(id)), undefined, String(id));
    }
    assert.deepEqual(seerr.lookups, [BOB.replaceAll('-', '')]);
  });

  it('caches found and missing users for their TTLs', async () => {
    const seerr = fakeSeerr();
    const { time, now } = clock();
    const map = new SeerrUserMap(seerr, { now, ttlMs: 300, missingTtlMs: 100 });
    await map.seerrUserId(ALICE);
    await map.seerrUserId(BOB);
    time.now += 99;
    await map.seerrUserId(ALICE);
    await map.seerrUserId(BOB);
    assert.equal(seerr.lookups.length, 2);
    time.now += 1;
    await map.seerrUserId(BOB);
    assert.equal(seerr.lookups.length, 3);
    time.now += 199;
    await map.seerrUserId(ALICE);
    assert.equal(seerr.lookups.length, 3);
    time.now += 1;
    await map.seerrUserId(ALICE);
    assert.equal(seerr.lookups.length, 4);
  });

  it('never holds more than the size cap, forgetting the least recently used first', async () => {
    const users = Object.fromEntries([1, 2, 3, 4].map((index) => [jellyfinId(index), index]));
    const seerr = fakeSeerr(users);
    const map = new SeerrUserMap(seerr, { maxEntries: 3 });
    for (const index of [1, 2, 3]) await map.seerrUserId(jellyfinId(index));
    await map.seerrUserId(jellyfinId(1)); // now most recently used
    await map.seerrUserId(jellyfinId(4)); // evicts 2
    assert.equal(seerr.lookups.length, 4);
    await map.seerrUserId(jellyfinId(1));
    await map.seerrUserId(jellyfinId(3));
    await map.seerrUserId(jellyfinId(4));
    assert.equal(seerr.lookups.length, 4);
    await map.seerrUserId(jellyfinId(2));
    assert.equal(seerr.lookups.length, 5);
  });

  it('does not cache a failed lookup, and shares one lookup between concurrent callers', async () => {
    const seerr = fakeSeerr();
    const map = new SeerrUserMap(seerr);
    seerr.failNext = new SeerrError('Seerr GET /api/v1/user/jellyfin/:id returned 503', 503);
    await assert.rejects(map.clientFor(ALICE), (error) => error.status === 503);
    const results = await Promise.all([map.seerrUserId(ALICE), map.seerrUserId(ALICE), map.seerrUserId(ALICE)]);
    assert.deepEqual(results, [11, 11, 11]);
    assert.equal(seerr.lookups.length, 2);
  });

  it('forgets everything on clear', async () => {
    const seerr = fakeSeerr();
    const map = new SeerrUserMap(seerr);
    await map.seerrUserId(ALICE);
    map.clear();
    await map.seerrUserId(ALICE);
    assert.equal(seerr.lookups.length, 2);
  });

  it('treats a Jellyfin ID with or without dashes, in any case, as the same user', async () => {
    const seerr = fakeSeerr();
    const map = new SeerrUserMap(seerr);
    const dashless = ALICE.replaceAll('-', '');
    for (const id of [ALICE, ALICE.toUpperCase(), dashless, dashless.toUpperCase()]) {
      assert.equal(await map.seerrUserId(id), 11, id);
      assert.equal((await map.verifiedClientFor(id))?.userId, 11, id);
    }
    assert.deepEqual(seerr.lookups, [dashless]);
    map.invalidate(ALICE.toUpperCase());
    await map.seerrUserId(dashless);
    assert.equal(seerr.lookups.length, 2);
  });
});

describe('Jellyfin to Seerr user map after Seerr changes', () => {
  const alice = ALICE.replaceAll('-', '');
  const bob = BOB.replaceAll('-', '');

  it('confirms the link before every verified use and follows a relink at once', async () => {
    const seerr = fakeSeerr({ [alice]: 2 });
    const map = new SeerrUserMap(seerr);
    assert.equal((await map.verifiedClientFor(ALICE))?.userId, 2);
    assert.deepEqual(seerr.checks, [2]);

    // An admin relinks: Seerr user 2 now belongs to Bob, and Alice is Seerr user 3.
    seerr.users = { [alice]: 3, [bob]: 2 };
    assert.equal((await map.verifiedClientFor(ALICE))?.userId, 3);
    assert.deepEqual(seerr.checks, [2, 2, 3]);
    assert.equal(seerr.lookups.length, 2);
    // The stale mapping is gone for read-only use too.
    assert.equal((await map.clientFor(ALICE))?.userId, 3);
    assert.equal(seerr.lookups.length, 2);
  });

  it('trusts a cached mapping for read-only use for at most the TTL after a relink', async () => {
    const seerr = fakeSeerr({ [alice]: 2 });
    const { time, now } = clock();
    const map = new SeerrUserMap(seerr, { now });
    await map.clientFor(ALICE);
    seerr.users = { [alice]: 3, [bob]: 2 };
    time.now += SEERR_USER_TTL_MS;
    assert.equal((await map.clientFor(ALICE))?.userId, 3);
  });

  it('fails closed once the Seerr user is deleted', async () => {
    const seerr = fakeSeerr({ [alice]: 2 });
    const map = new SeerrUserMap(seerr);
    await map.clientFor(ALICE);
    seerr.users = {};
    assert.equal(await map.verifiedClientFor(ALICE), undefined);
    assert.equal(await map.clientFor(ALICE), undefined);
    assert.equal(seerr.lookups.length, 2);
  });

  it('fails closed if the link keeps changing while it is confirmed', async () => {
    const seerr = fakeSeerr({ [alice]: 2 });
    seerr.jellyfinUserIdOf = async (user) => {
      seerr.checks.push(user);
      return bob;
    };
    const map = new SeerrUserMap(seerr);
    assert.equal(await map.verifiedClientFor(ALICE), undefined);
    assert.deepEqual(seerr.checks, [2, 2]);
  });

  for (const status of [401, 403, 404]) {
    it(`forgets a mapping when Seerr answers a call made with it with ${status}`, async (t) => {
      const seerr = fakeSeerr({ [alice]: 2, [bob]: 5 });
      const map = new SeerrUserMap(seerr);
      const client = await map.clientFor(ALICE);
      await map.clientFor(BOB);
      t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status }));
      seerr.users = { [bob]: 5 };
      await assert.rejects(client.quota(), (error) => error.status === status);
      assert.equal(await map.clientFor(ALICE), undefined);
      assert.equal((await map.clientFor(BOB))?.userId, 5);
      assert.deepEqual(seerr.lookups, [alice, bob, alice]);
    });
  }

  it('keeps a mapping when Seerr fails a call for another reason', async (t) => {
    const seerr = fakeSeerr({ [alice]: 2 });
    const map = new SeerrUserMap(seerr);
    const client = await map.clientFor(ALICE);
    t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 503 }));
    await assert.rejects(client.quota(), (error) => error.status === 503);
    await map.clientFor(ALICE);
    assert.equal(seerr.lookups.length, 1);
  });

  for (const [name, forget] of [['clear', (map) => map.clear()], ['invalidate', (map) => map.invalidate(ALICE)]]) {
    it(`does not let a lookup pending across ${name} fill the cache or be joined`, async () => {
      const seerr = fakeSeerr({ [alice]: 2 });
      const map = new SeerrUserMap(seerr);
      const gate = deferred();
      seerr.gate = gate.promise;
      const stale = map.seerrUserId(ALICE);
      const joined = map.seerrUserId(ALICE);
      assert.equal(seerr.lookups.length, 1);

      forget(map);
      seerr.users = { [alice]: 3 };
      const fresh = map.seerrUserId(ALICE);
      assert.equal(seerr.lookups.length, 2);
      gate.resolve();
      assert.deepEqual(await Promise.all([stale, joined, fresh]), [2, 2, 3]);

      seerr.gate = undefined;
      assert.equal(await map.seerrUserId(ALICE), 3);
      assert.equal(seerr.lookups.length, 2);
    });
  }

  it('does not let a lookup pending across clear fill the cache even when nothing asks again', async () => {
    const seerr = fakeSeerr({ [alice]: 2 });
    const map = new SeerrUserMap(seerr);
    const gate = deferred();
    seerr.gate = gate.promise;
    const stale = map.seerrUserId(ALICE);
    map.clear();
    gate.resolve();
    assert.equal(await stale, 2);
    seerr.gate = undefined;
    seerr.users = { [alice]: 3 };
    assert.equal(await map.seerrUserId(ALICE), 3);
  });

  it('invalidates only the user named', async () => {
    const seerr = fakeSeerr({ [alice]: 2, [bob]: 5 });
    const map = new SeerrUserMap(seerr);
    await map.seerrUserId(ALICE);
    await map.seerrUserId(BOB);
    map.invalidate(ALICE);
    map.invalidate('not-a-jellyfin-id');
    await map.seerrUserId(ALICE);
    await map.seerrUserId(BOB);
    assert.deepEqual(seerr.lookups, [alice, bob, alice]);
  });

  it('shares one lookup between concurrent verified callers and confirms each use', async () => {
    const seerr = fakeSeerr({ [alice]: 2 });
    const map = new SeerrUserMap(seerr);
    const clients = await Promise.all([1, 2, 3].map(() => map.verifiedClientFor(ALICE)));
    assert.deepEqual(clients.map((client) => client.userId), [2, 2, 2]);
    assert.equal(seerr.lookups.length, 1);
    assert.deepEqual(seerr.checks, [2, 2, 2]);
  });
});
