import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { SeerrClient, SeerrMemberClient, SeerrUnmappedUserError, seerrUserId } from '../dist/seerr.js';
import { SEERR_USER_CACHE_MAX, SEERR_USER_MISSING_TTL_MS, SEERR_USER_TTL_MS, SeerrUserMap } from '../dist/seerr-users.js';

const BASE_URL = 'http://seerr.test';
const ALICE = 'aaaaaaaa-0000-0000-0000-000000000001';
const BOB = 'bbbbbbbb-0000-0000-0000-000000000002';
const alice = ALICE.replaceAll('-', '');
const bob = BOB.replaceAll('-', '');
const jellyfinId = (index) => index.toString(16).padStart(32, '0');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function clock(start = 1_000_000) {
  const time = { now: start };
  return { time, now: () => time.now };
}

/**
 * A fake Seerr behind fetch. `users` is Seerr's current Jellyfin-to-Seerr link and can be changed at any time; while
 * `lookupGate` or `checkGate` is set, the user lookup or link check waits for it after reading `users` (so a relink
 * can land in between). `onLookup` and `onCheck` run as each lookup or link check is answered, after it read `users`. Calls acting as a user are kept in `acted`.
 */
let seerr;
let originalFetch;

beforeEach(() => {
  seerr = {
    users: { [alice]: 11 },
    lookups: [],
    checks: [],
    acted: [],
    failNext: undefined,
    lookupGate: undefined,
    checkGate: undefined,
    onCheck: undefined,
    onLookup: undefined,
    actingStatus: 200,
  };
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const actingAs = headers.get('x-api-user');
    if (actingAs !== null) {
      seerr.acted.push(`${actingAs} ${init.method ?? 'GET'} ${url.pathname}`);
      return Response.json({}, { status: seerr.actingStatus });
    }
    const lookup = url.pathname.match(/^\/api\/v1\/user\/jellyfin\/([0-9a-f]{32})$/);
    if (lookup) {
      seerr.lookups.push(lookup[1]);
      const id = seerr.users[lookup[1]];
      seerr.onLookup?.(id);
      if (seerr.lookupGate) await seerr.lookupGate;
      if (seerr.failNext) {
        const status = seerr.failNext;
        seerr.failNext = undefined;
        return new Response('down', { status });
      }
      return id === undefined ? Response.json({}, { status: 404 }) : Response.json({ id, jellyfinUserId: lookup[1] });
    }
    const check = url.pathname.match(/^\/api\/v1\/user\/(\d+)$/);
    if (check) {
      const id = Number(check[1]);
      seerr.checks.push(id);
      const linked = Object.keys(seerr.users).find((key) => seerr.users[key] === id);
      if (seerr.checkGate) await seerr.checkGate;
      seerr.onCheck?.(id);
      return linked === undefined ? Response.json({}, { status: 404 }) : Response.json({ id, permissions: 0, jellyfinUserId: linked });
    }
    return Response.json({}, { status: 500 });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const admin = () => new SeerrClient(BASE_URL, 'key');

describe('Jellyfin to Seerr user map', () => {
  it('uses a one-minute TTL for found and missing users, and at most 1000 entries', () => {
    assert.equal(SEERR_USER_TTL_MS, 60_000);
    assert.equal(SEERR_USER_MISSING_TTL_MS, 60_000);
    assert.equal(SEERR_USER_CACHE_MAX, 1_000);
  });

  it('gives a Jellyfin user a member client that acts as their confirmed Seerr user', async () => {
    const map = new SeerrUserMap(admin());
    const member = map.member(ALICE);
    assert.ok(member instanceof SeerrMemberClient);
    assert.equal(member.jellyfinUserId, alice);
    await member.quota();
    assert.deepEqual(seerr.acted, ['11 GET /api/v1/user/11/quota']);
    assert.equal(await map.candidate(ALICE.toUpperCase()), 11);
  });

  it('fails closed for an unmapped user or an ID that is not a Jellyfin ID, without any admin fallback', async () => {
    const map = new SeerrUserMap(admin());
    await assert.rejects(map.member(BOB).quota(), SeerrUnmappedUserError);
    for (const id of ['', 'alice-id', '1', '../user', undefined]) {
      assert.equal(map.member(String(id)), undefined, String(id));
      assert.equal(await map.candidate(String(id)), undefined, String(id));
    }
    assert.deepEqual(seerr.lookups, [bob]);
    assert.deepEqual(seerr.acted, []);
  });

  it('caches found and missing users for their TTLs', async () => {
    const { time, now } = clock();
    const map = new SeerrUserMap(admin(), { now, ttlMs: 300, missingTtlMs: 100 });
    await map.candidate(ALICE);
    await map.candidate(BOB);
    time.now += 99;
    await map.candidate(ALICE);
    await map.candidate(BOB);
    assert.equal(seerr.lookups.length, 2);
    time.now += 1;
    await map.candidate(BOB);
    assert.equal(seerr.lookups.length, 3);
    time.now += 199;
    await map.candidate(ALICE);
    assert.equal(seerr.lookups.length, 3);
    time.now += 1;
    await map.candidate(ALICE);
    assert.equal(seerr.lookups.length, 4);
  });

  it('never holds more than the size cap, forgetting the least recently used first', async () => {
    seerr.users = Object.fromEntries([1, 2, 3, 4].map((index) => [jellyfinId(index), index]));
    const map = new SeerrUserMap(admin(), { maxEntries: 3 });
    for (const index of [1, 2, 3]) await map.candidate(jellyfinId(index));
    await map.candidate(jellyfinId(1)); // now most recently used
    await map.candidate(jellyfinId(4)); // evicts 2
    assert.equal(seerr.lookups.length, 4);
    await map.candidate(jellyfinId(1));
    await map.candidate(jellyfinId(3));
    await map.candidate(jellyfinId(4));
    assert.equal(seerr.lookups.length, 4);
    await map.candidate(jellyfinId(2));
    assert.equal(seerr.lookups.length, 5);
  });

  it('does not cache a failed lookup, and shares one lookup between concurrent callers', async () => {
    const map = new SeerrUserMap(admin());
    seerr.failNext = 503;
    await assert.rejects(map.member(ALICE).quota(), (error) => error.status === 503);
    assert.deepEqual(seerr.acted, []);
    const results = await Promise.all([map.candidate(ALICE), map.candidate(ALICE), map.candidate(ALICE)]);
    assert.deepEqual(results, [11, 11, 11]);
    assert.equal(seerr.lookups.length, 2);
  });

  it('forgets everything on clear', async () => {
    const map = new SeerrUserMap(admin());
    await map.candidate(ALICE);
    map.clear();
    await map.candidate(ALICE);
    assert.equal(seerr.lookups.length, 2);
  });

  it('treats a Jellyfin ID with or without dashes, in any case, as the same user', async () => {
    const map = new SeerrUserMap(admin());
    for (const id of [ALICE, ALICE.toUpperCase(), alice, alice.toUpperCase()]) {
      assert.equal(await map.candidate(id), 11, id);
      await map.member(id).quota();
    }
    assert.deepEqual(seerr.lookups, [alice]);
    assert.equal(seerr.acted.length, 4);
    map.invalidate(ALICE.toUpperCase());
    await map.candidate(alice);
    assert.equal(seerr.lookups.length, 2);
  });
});

describe('Jellyfin to Seerr user map after Seerr changes', () => {
  it('confirms the link immediately before every call and follows a relink at once', async () => {
    seerr.users = { [alice]: 2 };
    const map = new SeerrUserMap(admin());
    await map.member(ALICE).quota();
    assert.deepEqual(seerr.checks, [2]);

    // An admin relinks: Seerr user 2 now belongs to Bob, and Alice is Seerr user 3.
    seerr.users = { [alice]: 3, [bob]: 2 };
    await map.member(ALICE).quota();
    assert.deepEqual(seerr.checks, [2, 2, 3]);
    assert.equal(seerr.lookups.length, 2);
    assert.deepEqual(seerr.acted, ['2 GET /api/v1/user/2/quota', '3 GET /api/v1/user/3/quota']);
  });

  it('acts as the member\'s current Seerr user on every call through a client kept across a relink', async () => {
    // Codex's repro: a client obtained while Alice was Seerr user 2 must not keep acting as 2 once 2 is Bob's.
    seerr.users = { [alice]: 2 };
    const map = new SeerrUserMap(admin());
    const saved = map.member(ALICE);
    await saved.quota();
    seerr.users = { [alice]: 3, [bob]: 2 };
    const fresh = map.member(ALICE);
    await fresh.quota();
    await saved.quota();
    await saved.quota();
    await saved.ownRequests();
    await saved.createRequest({ mediaType: 'movie', tmdbId: 1 });
    await saved.watchlist();
    assert.deepEqual(seerr.acted, [
      '2 GET /api/v1/user/2/quota',
      '3 GET /api/v1/user/3/quota',
      '3 GET /api/v1/user/3/quota',
      '3 GET /api/v1/user/3/quota',
      '3 GET /api/v1/user/3/requests',
      '3 POST /api/v1/request',
      '3 GET /api/v1/discover/watchlist',
    ]);
    // Each call was confirmed: no call left without a check of the user it acted as just before it.
    assert.equal(seerr.checks.filter((id) => id === 3).length, 6);
  });

  it('acts as nobody through a kept client once the member is unlinked, and as them again once relinked', async () => {
    seerr.users = { [alice]: 2 };
    const map = new SeerrUserMap(admin());
    const saved = map.member(ALICE);
    await saved.quota();
    seerr.users = { [bob]: 2 };
    for (const call of [() => saved.quota(), () => saved.ownRequests(), () => saved.watchlist(), () => saved.createRequest({ mediaType: 'movie', tmdbId: 1 })]) {
      await assert.rejects(call(), SeerrUnmappedUserError);
    }
    assert.deepEqual(seerr.acted, ['2 GET /api/v1/user/2/quota']);
    seerr.users = { [alice]: 5, [bob]: 2 };
    map.invalidate(ALICE);
    await saved.quota();
    assert.deepEqual(seerr.acted.slice(1), ['5 GET /api/v1/user/5/quota']);
  });

  it('sends every concurrent call as whoever Seerr linked when that call was confirmed, during a relink', async () => {
    seerr.users = { [alice]: 2 };
    const map = new SeerrUserMap(admin());
    const member = map.member(ALICE);
    await member.quota();
    seerr.acted = [];

    // Five calls are confirmed together; the relink lands while their checks are in flight, after Seerr read the link.
    const gate = deferred();
    seerr.checkGate = gate.promise;
    const inFlight = [1, 2, 3, 4, 5].map(() => member.quota());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(seerr.checks.length, 6);
    seerr.users = { [alice]: 3, [bob]: 2 };
    seerr.checkGate = undefined;
    gate.resolve();
    await Promise.all(inFlight);
    // Seerr confirmed user 2 for all five before the relink, so each went as 2; none went as anyone unconfirmed.
    assert.deepEqual(seerr.acted, Array(5).fill('2 GET /api/v1/user/2/quota'));

    // Five more, after the relink: every one is confirmed again and goes as 3.
    seerr.acted = [];
    await Promise.all([1, 2, 3, 4, 5].map(() => member.quota()));
    assert.deepEqual(seerr.acted, Array(5).fill('3 GET /api/v1/user/3/quota'));
  });

  it('confirms again a call whose user is invalidated while it is being confirmed', async () => {
    seerr.users = { [alice]: 2 };
    const map = new SeerrUserMap(admin());
    const member = map.member(ALICE);
    await map.candidate(ALICE);
    // While the first check is answered, an admin relinks Alice to 3 and JellyPass is told (invalidate).
    seerr.onCheck = () => {
      seerr.onCheck = undefined;
      seerr.users = { [alice]: 3, [bob]: 2 };
      map.invalidate(ALICE);
    };
    // The answer still says 2 is Alice's (it was read before the relink), but the call must not go as 2.
    const gate = deferred();
    seerr.checkGate = gate.promise;
    const call = member.quota();
    await new Promise((resolve) => setImmediate(resolve));
    seerr.checkGate = undefined;
    gate.resolve();
    await call;
    assert.deepEqual(seerr.checks, [2, 3]);
    assert.deepEqual(seerr.acted, ['3 GET /api/v1/user/3/quota']);
  });

  it('fails closed if every confirmation is invalidated', async () => {
    seerr.users = { [alice]: 2 };
    const map = new SeerrUserMap(admin());
    seerr.onCheck = () => map.invalidate(ALICE);
    await assert.rejects(map.member(ALICE).quota(), SeerrUnmappedUserError);
    assert.deepEqual(seerr.acted, []);
    assert.equal(seerr.checks.length, 2);
  });

  it('confirms again after clear() lands during a confirmation', async () => {
    seerr.users = { [alice]: 2 };
    const map = new SeerrUserMap(admin());
    seerr.onCheck = () => {
      seerr.onCheck = undefined;
      map.clear();
    };
    await map.member(ALICE).quota();
    assert.deepEqual(seerr.checks, [2, 2]);
    assert.deepEqual(seerr.lookups, [alice, alice]);
    assert.deepEqual(seerr.acted, ['2 GET /api/v1/user/2/quota']);
  });

  it('is not fooled by the invalidation of another user', async () => {
    seerr.users = { [alice]: 2, [bob]: 5 };
    const map = new SeerrUserMap(admin());
    seerr.onCheck = () => map.invalidate(BOB);
    await map.member(ALICE).quota();
    assert.deepEqual(seerr.checks, [2]);
  });

  it('keeps a user\'s version when only their stamp is evicted', async () => {
    seerr.users = { [alice]: 2 };
    const map = new SeerrUserMap(admin(), { maxEntries: 1 });
    map.invalidate(ALICE);
    seerr.onCheck = () => {
      seerr.onCheck = undefined;
      map.invalidate(BOB); // evicts Alice's stamp
    };
    await map.member(ALICE).quota();
    // Alice was not invalidated: her evicted stamp becomes the floor, so her version reads the same and she still
    // goes as the user Seerr confirmed.
    assert.deepEqual(seerr.checks, [2]);
    assert.deepEqual(seerr.acted, ['2 GET /api/v1/user/2/quota']);
  });

  it('is not fooled by an invalidation whose stamp was evicted during the confirmation', async () => {
    // Codex's repro: Alice's confirmation starts with no stamp for her; Alice is relinked to 3 and Bob to 2, and both
    // invalidations land, the second evicting the first. Alice must not read as unchanged and go as 2.
    seerr.users = { [alice]: 2 };
    const map = new SeerrUserMap(admin(), { maxEntries: 1 });
    seerr.onCheck = () => {
      seerr.onCheck = undefined;
      seerr.users = { [alice]: 3, [bob]: 2 };
      map.invalidate(ALICE);
      map.invalidate(BOB);
    };
    await map.member(ALICE).quota();
    assert.deepEqual(seerr.checks, [2, 3]);
    assert.deepEqual(seerr.acted, ['3 GET /api/v1/user/3/quota']);
  });

  it('never sends as the old user however many invalidations and evictions land during a confirmation', async () => {
    for (const maxEntries of [1, 2, 3, 10]) {
      for (const others of [0, 1, 2, 5, 50]) {
        for (const clearAt of [-1, 0, Math.floor(others / 2)]) {
          seerr.users = { [alice]: 2 };
          seerr.checks = [];
          seerr.acted = [];
          const map = new SeerrUserMap(admin(), { maxEntries });
          if (maxEntries > 1) map.invalidate(ALICE); // also start from a stamp Alice has
          seerr.onCheck = () => {
            seerr.onCheck = undefined;
            seerr.users = { [alice]: 3, [bob]: 2 };
            map.invalidate(ALICE);
            for (let index = 0; index < others; index += 1) {
              if (index === clearAt) map.clear();
              map.invalidate(index % 2 ? BOB : jellyfinId(1000 + index));
            }
          };
          await map.member(ALICE).quota();
          const label = `maxEntries ${maxEntries}, ${others} others, clear at ${clearAt}`;
          assert.deepEqual(seerr.acted, ['3 GET /api/v1/user/3/quota'], label);
        }
      }
    }
  });

  it('gives every user a version that never goes down and grows on each of their invalidations', () => {
    const map = new SeerrUserMap(admin(), { maxEntries: 3 });
    const users = [1, 2, 3, 4, 5, 6].map(jellyfinId);
    const last = new Map(users.map((user) => [user, map.version(user)]));
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let step = 0; step < 5_000; step += 1) {
      const target = users[Math.floor(random() * users.length)];
      const clearing = random() < 0.02;
      if (clearing) map.clear();
      else map.invalidate(target);
      for (const user of users) {
        const version = map.version(user);
        assert.ok(version >= last.get(user), `step ${step}: ${user} went down`);
        if (clearing || user === target) assert.ok(version > last.get(user), `step ${step}: ${user} did not grow`);
        last.set(user, version);
      }
    }
  });

  it('trusts no cached mapping for any call after a relink, however recent', async () => {
    seerr.users = { [alice]: 2 };
    const { now } = clock();
    const map = new SeerrUserMap(admin(), { now });
    await map.candidate(ALICE);
    seerr.users = { [alice]: 3, [bob]: 2 };
    // Within the TTL the cache still proposes 2, but the confirmation catches it.
    assert.equal(await map.candidate(ALICE), 2);
    await map.member(ALICE).ownRequests();
    assert.deepEqual(seerr.acted, ['3 GET /api/v1/user/3/requests']);
    assert.equal(await map.candidate(ALICE), 3);
  });

  it('fails closed once the Seerr user is deleted', async () => {
    seerr.users = { [alice]: 2 };
    const map = new SeerrUserMap(admin());
    await map.candidate(ALICE);
    seerr.users = {};
    await assert.rejects(map.member(ALICE).quota(), SeerrUnmappedUserError);
    assert.equal(await map.candidate(ALICE), undefined);
    assert.equal(seerr.lookups.length, 2);
    assert.deepEqual(seerr.acted, []);
  });

  it('fails closed if the link keeps changing while it is confirmed', async () => {
    seerr.users = { [alice]: 2 };
    const map = new SeerrUserMap(admin());
    // Each time Alice is looked up, an admin moves her on and gives her old Seerr user to Bob.
    seerr.onLookup = (id) => {
      seerr.users = { [alice]: id + 1, [bob]: id };
    };
    await assert.rejects(map.member(ALICE).quota(), SeerrUnmappedUserError);
    assert.deepEqual(seerr.acted, []);
  });

  for (const status of [401, 403, 404]) {
    it(`forgets a mapping when Seerr answers a call made with it with ${status}`, async () => {
      seerr.users = { [alice]: 2, [bob]: 5 };
      const map = new SeerrUserMap(admin());
      await map.candidate(ALICE);
      await map.candidate(BOB);
      seerr.actingStatus = status;
      await assert.rejects(map.member(ALICE).quota(), (error) => error.status === status);
      seerr.actingStatus = 200;
      assert.equal(await map.candidate(ALICE), 2);
      assert.equal(await map.candidate(BOB), 5);
      assert.deepEqual(seerr.lookups, [alice, bob, alice]);
    });
  }

  it('keeps a mapping when Seerr fails a call for another reason', async () => {
    seerr.users = { [alice]: 2 };
    const map = new SeerrUserMap(admin());
    seerr.actingStatus = 503;
    await assert.rejects(map.member(ALICE).quota(), (error) => error.status === 503);
    await map.candidate(ALICE);
    assert.equal(seerr.lookups.length, 1);
  });

  for (const [name, forget] of [['clear', (map) => map.clear()], ['invalidate', (map) => map.invalidate(ALICE)]]) {
    it(`does not let a lookup pending across ${name} fill the cache or be joined`, async () => {
      seerr.users = { [alice]: 2 };
      const map = new SeerrUserMap(admin());
      const gate = deferred();
      seerr.lookupGate = gate.promise;
      const stale = map.candidate(ALICE);
      const joined = map.candidate(ALICE);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(seerr.lookups.length, 1);

      forget(map);
      seerr.users = { [alice]: 3 };
      const fresh = map.candidate(ALICE);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(seerr.lookups.length, 2);
      gate.resolve();
      assert.deepEqual(await Promise.all([stale, joined, fresh]), [2, 2, 3]);

      seerr.lookupGate = undefined;
      assert.equal(await map.candidate(ALICE), 3);
      assert.equal(seerr.lookups.length, 2);
    });
  }

  it('does not let a lookup pending across clear fill the cache even when nothing asks again', async () => {
    seerr.users = { [alice]: 2 };
    const map = new SeerrUserMap(admin());
    const gate = deferred();
    seerr.lookupGate = gate.promise;
    const stale = map.candidate(ALICE);
    await new Promise((resolve) => setImmediate(resolve));
    map.clear();
    gate.resolve();
    assert.equal(await stale, 2);
    seerr.lookupGate = undefined;
    seerr.users = { [alice]: 3 };
    assert.equal(await map.candidate(ALICE), 3);
  });

  it('invalidates only the user named', async () => {
    seerr.users = { [alice]: 2, [bob]: 5 };
    const map = new SeerrUserMap(admin());
    await map.candidate(ALICE);
    await map.candidate(BOB);
    map.invalidate(ALICE);
    map.invalidate('not-a-jellyfin-id');
    await map.candidate(ALICE);
    await map.candidate(BOB);
    assert.deepEqual(seerr.lookups, [alice, bob, alice]);
  });

  it('shares one lookup between concurrent member calls and confirms each one', async () => {
    seerr.users = { [alice]: 2 };
    const map = new SeerrUserMap(admin());
    await Promise.all([1, 2, 3].map(() => map.member(ALICE).quota()));
    assert.equal(seerr.lookups.length, 1);
    assert.deepEqual(seerr.checks, [2, 2, 2]);
    assert.equal(seerr.acted.length, 3);
  });

  it('never lets a forged candidate act as anyone', async () => {
    seerr.users = { [alice]: 2, [bob]: 5 };
    const forged = { candidate: async () => seerrUserId(5), forget() {}, version: () => 0 };
    await assert.rejects(new SeerrMemberClient(admin(), ALICE, forged).quota(), SeerrUnmappedUserError);
    assert.deepEqual(seerr.acted, []);
  });
});
