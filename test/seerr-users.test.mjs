import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SeerrError, SeerrUserClient, seerrUserId } from '../dist/seerr.js';
import { SEERR_USER_CACHE_MAX, SEERR_USER_MISSING_TTL_MS, SEERR_USER_TTL_MS, SeerrUserMap } from '../dist/seerr-users.js';

const ALICE = 'aaaaaaaa-0000-0000-0000-000000000001';
const BOB = 'bbbbbbbb-0000-0000-0000-000000000002';
const jellyfinId = (index) => index.toString(16).padStart(32, '0');

/** A stand-in for the admin-key SeerrClient that records lookups. */
function fakeSeerr(users = { [ALICE.replaceAll('-', '')]: 11 }) {
  const lookups = [];
  return {
    lookups,
    failNext: undefined,
    async findUserByJellyfinId(id) {
      lookups.push(id);
      if (this.failNext) {
        const error = this.failNext;
        this.failNext = undefined;
        throw error;
      }
      const user = users[id];
      return user === undefined ? undefined : { id: seerrUserId(user), jellyfinUserId: id };
    },
    asUser(user) {
      return new SeerrUserClient('http://seerr.test', 'key', user);
    },
  };
}

function clock(start = 1_000_000) {
  const time = { now: start };
  return { time, now: () => time.now };
}

describe('Jellyfin to Seerr user map', () => {
  it('uses a five-minute TTL for found users, one minute for missing ones, and at most 1000 entries', () => {
    assert.equal(SEERR_USER_TTL_MS, 300_000);
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

  it('caches found users for the TTL and missing users for the shorter TTL', async () => {
    const seerr = fakeSeerr();
    const { time, now } = clock();
    const map = new SeerrUserMap(seerr, { now });
    await map.seerrUserId(ALICE);
    await map.seerrUserId(BOB);
    time.now += SEERR_USER_MISSING_TTL_MS - 1;
    await map.seerrUserId(ALICE);
    await map.seerrUserId(BOB);
    assert.equal(seerr.lookups.length, 2);
    time.now += 1;
    await map.seerrUserId(BOB);
    assert.equal(seerr.lookups.length, 3);
    time.now += SEERR_USER_TTL_MS - SEERR_USER_MISSING_TTL_MS - 1;
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
});
