import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AccessService, accessTag } from '../dist/access-service.js';
import { GrantStore } from '../dist/store.js';
import { parseWebhook } from '../dist/webhook.js';
import { makeTempDir } from './support/temp-dir.mjs';

// Seerr accepts POST /api/v1/request for a movie that is already available and, for a user who may auto-approve,
// reports it available at once: MEDIA_AVAILABLE as `Movie Now Available` and `Movie Request Now Available`, in either
// order, for the same request. Such a "late" request must be treated like a household library join, never as a grant.

const ADDED_AT = '2026-06-01T00:00:00.0000000Z';
/** Before Jellyfin added the items: a new request. */
const NEW = '2026-05-01T00:00:00.000Z';
/** After Jellyfin added the items: a late request. */
const LATE = '2026-07-15T00:00:00.000Z';
const SINCE = new Date('2026-01-01T00:00:00.000Z');
const EVENT_ORDERS = [
  ['Movie Now Available', 'Movie Request Now Available'],
  ['Movie Request Now Available', 'Movie Now Available'],
];

/**
 * Jellyfin has movie-1 (HD) and movie-4k (its 4K version), and series-1, which it added in 2025 with season 1; season
 * 2 was added after NEW and before LATE. Alice and Bob are House A, Carol is House B, Dave belongs to no household.
 */
async function world(t, { seerr = true } = {}) {
  const users = [
    { Id: 'admin-id', Name: 'Admin', Policy: { IsAdministrator: true, BlockedTags: [] } },
    { Id: 'alice-id', Name: 'Alice', Policy: { BlockedTags: [] } },
    { Id: 'bob-id', Name: 'Bob', Policy: { BlockedTags: [] } },
    { Id: 'carol-id', Name: 'Carol', Policy: { BlockedTags: [] } },
    { Id: 'dave-id', Name: 'Dave', Policy: { BlockedTags: [] } },
  ];
  const items = new Map([
    ['movie-1', { Id: 'movie-1', Name: 'Movie', Type: 'Movie', DateCreated: ADDED_AT, Tags: [] }],
    ['movie-4k', { Id: 'movie-4k', Name: 'Movie 4K', Type: 'Movie', DateCreated: ADDED_AT, Tags: [] }],
    ['series-1', { Id: 'series-1', Name: 'Series', Type: 'Series', DateCreated: '2025-01-01T00:00:00.0000000Z', Tags: [] }],
  ]);
  const seasons = [
    { Id: 'season-1', IndexNumber: 1, Type: 'Season', DateCreated: '2025-01-01T00:00:00.0000000Z' },
    { Id: 'season-2', IndexNumber: 2, Type: 'Season', DateCreated: ADDED_AT },
  ];
  const jellyfin = {
    async getUsers() { return structuredClone(users); },
    async getItem(itemId) {
      const item = items.get(itemId);
      if (!item) throw Object.assign(new Error(`Jellyfin GET /Items/${itemId} returned 404`), { status: 404 });
      return structuredClone(item);
    },
    async getItems(itemIds) { return Promise.all(itemIds.map((itemId) => jellyfin.getItem(itemId))); },
    async getSeasons(seriesId) { return seriesId === 'series-1' ? structuredClone(seasons) : []; },
    async getLocalTrailers() { return []; },
    async updateItem(item) { items.set(item.Id, structuredClone(item)); },
    async updatePolicy(userId, policy) { users.find((user) => user.Id === userId).Policy = structuredClone(policy); },
  };
  const requests = new Map();
  const seerrClient = {
    async getRequest(requestId) {
      const request = requests.get(String(requestId));
      if (!request) throw Object.assign(new Error(`Seerr GET /api/v1/request/${requestId} returned 404`), { status: 404 });
      return structuredClone(request);
    },
    async listRequestsSince() { return [...requests.values()].reverse().map((request) => structuredClone(request)); },
  };
  const store = new GrantStore(path.join(await makeTempDir(t, 'jfa-late-'), 'grants.json'));
  await store.load();
  const service = new AccessService(jellyfin, store, undefined, seerr ? seerrClient : undefined);
  await service.upsertGroup({ id: 'house-a', name: 'House A', userIds: ['alice-id', 'bob-id'] });
  await service.upsertGroup({ id: 'house-b', name: 'House B', userIds: ['carol-id'] });

  /** Seerr saves a request; `createdAt` is set by its database. */
  const request = (id, { userId = 'alice-id', createdAt = NEW, is4k = false, mediaType = 'movie', seasons: requested, ...extra } = {}) => {
    const media = mediaType === 'tv'
      ? { mediaType, status: 4, jellyfinMediaId: 'series-1' }
      : { mediaType, status: 5, status4k: 5, jellyfinMediaId: 'movie-1', jellyfinMediaId4k: 'movie-4k' };
    requests.set(String(id), {
      id,
      status: 5,
      type: mediaType,
      is4k,
      createdAt,
      requestedBy: { jellyfinUserId: userId },
      media,
      ...(requested ? { seasons: requested.map((seasonNumber) => ({ seasonNumber })) } : {}),
      ...extra,
    });
  };
  /** Seerr's MEDIA_AVAILABLE webhook for a request, as the documented template fills it. */
  const deliver = (id, event = 'Movie Request Now Available') => {
    const saved = requests.get(String(id));
    return service.processWebhook(parseWebhook({
      notificationType: 'MEDIA_AVAILABLE',
      event,
      media: { jellyfinMediaId: saved?.media.jellyfinMediaId ?? 'movie-1', mediaType: saved?.type ?? 'movie' },
      request: { id: String(id), requestedBy: { jellyfinUserId: saved?.requestedBy.jellyfinUserId ?? 'alice-id' } },
    }));
  };
  const blocked = (userId) => users.find((user) => user.Id === userId).Policy.BlockedTags;
  const tags = (itemId) => items.get(itemId).Tags;
  return { store, service, request, deliver, blocked, tags, requests, items };
}

/** Webhook and backfill, each run on a fresh world; `apply` hands a request ID to one of them. */
const PATHS = [
  ['webhook', (w, id) => w.deliver(id)],
  ['backfill', (w) => w.service.backfillRequests(SINCE)],
];

describe('late requests (made after the title was already available)', () => {
  for (const [name, apply] of PATHS) {
    it(`leave a public movie public (${name})`, async (t) => {
      const w = await world(t);
      w.request(30, { userId: 'carol-id', createdAt: LATE });
      await apply(w, 30);
      assert.deepEqual(w.store.list(), []);
      assert.deepEqual(w.tags('movie-1'), []);
      for (const userId of ['alice-id', 'bob-id', 'dave-id']) assert.deepEqual(w.blocked(userId), [], userId);
      assert.equal(w.store.hasHandledRequest('30'), true, 'a late request is decided once');

      // Neither a replay nor a later backfill run decides it again.
      assert.equal(await w.deliver(30), null);
      const again = await w.service.backfillRequests(SINCE);
      assert.deepEqual(again.granted, []);
      assert.deepEqual(again.joined, []);
      assert.deepEqual(w.store.list(), []);
    });

    it(`cannot re-add a household or user an administrator removed (${name})`, async (t) => {
      const w = await world(t);
      // Alice's new request makes the movie House A's; Carol and Dave got access and an administrator took it away.
      w.request(1);
      await w.deliver(1);
      await w.service.setManualAccess({ itemId: 'movie-1', userIds: ['dave-id'], groupIds: ['house-a', 'house-b'] });
      await w.service.setManualAccess({ itemId: 'movie-1', userIds: [], groupIds: ['house-a'] });
      assert.deepEqual(w.store.getRemovals('movie-1'), { userIds: ['carol-id', 'dave-id'], groupIds: ['house-b'] });
      const before = w.store.get('movie-1');

      w.request(31, { userId: 'carol-id', createdAt: LATE });
      w.request(32, { userId: 'dave-id', createdAt: LATE });
      if (name === 'webhook') {
        assert.equal(await w.deliver(31), null);
        assert.equal(await w.deliver(32), null);
      } else {
        const result = await w.service.backfillRequests(SINCE);
        assert.deepEqual(result.granted, []);
        assert.deepEqual(result.joined, []);
      }
      assert.deepEqual(w.store.get('movie-1'), before);
      assert.deepEqual(w.blocked('carol-id'), [accessTag('movie-1')]);
      assert.deepEqual(w.blocked('dave-id'), [accessTag('movie-1')]);
      assert.equal(w.store.hasHandledRequest('31'), true);
      assert.equal(w.store.hasHandledRequest('32'), true);
    });

    it(`do not touch a manual-only grant (${name})`, async (t) => {
      const w = await world(t);
      await w.service.setManualAccess({ itemId: 'movie-1', userIds: [], groupIds: ['house-a'] });
      const before = w.store.get('movie-1');
      w.request(33, { userId: 'carol-id', createdAt: LATE });
      await apply(w, 33);
      assert.deepEqual(w.store.get('movie-1'), before);
      assert.deepEqual(w.blocked('carol-id'), [accessTag('movie-1')]);
    });

    it(`join a request grant with the requester's households, honouring removal marks (${name})`, async (t) => {
      const w = await world(t);
      w.request(1);
      await w.deliver(1);
      // An administrator removed House B while it was empty, so only the household is marked; Carol, who joined it
      // later, also belongs to House C.
      await w.service.upsertGroup({ id: 'house-b', name: 'House B', userIds: [] });
      await w.service.setGrantGroups('movie-1', ['house-a', 'house-b']);
      await w.service.setGrantGroups('movie-1', ['house-a']);
      await w.service.upsertGroup({ id: 'house-b', name: 'House B', userIds: ['carol-id'] });
      await w.service.upsertGroup({ id: 'house-c', name: 'House C', userIds: ['carol-id'] });
      assert.deepEqual(w.store.getRemovals('movie-1'), { groupIds: ['house-b'] });

      w.request(34, { userId: 'carol-id', createdAt: LATE });
      w.request(35, { userId: 'dave-id', createdAt: LATE });
      if (name === 'webhook') {
        assert.equal(await w.deliver(34), null, 'a late request is not reported as granted');
        assert.equal(await w.deliver(35), null);
      } else {
        const result = await w.service.backfillRequests(SINCE);
        assert.deepEqual(result.granted, []);
        assert.deepEqual(result.joined, ['movie-1', 'movie-1']);
      }
      const grant = w.store.get('movie-1');
      assert.deepEqual(grant.requests, { 1: 'alice-id' }, 'a late request is never recorded as a request grant');
      assert.deepEqual(grant.groupIds, ['house-a', 'house-c']);
      assert.deepEqual(grant.manualUserIds, ['dave-id'], 'a requester in no household joins as a user');
      assert.deepEqual(grant.joins.map((join) => [join.userId, join.groupIds, join.userAdded]), [
        ['carol-id', ['house-c'], false],
        ['dave-id', [], true],
      ]);
      assert.equal(grant.sync.state, 'synced');
      assert.deepEqual(w.blocked('carol-id'), []);
      assert.deepEqual(w.blocked('dave-id'), []);
    });

    it(`never create a grant for a late 4K request, and never join one, since joins are HD only (${name})`, async (t) => {
      const w = await world(t);
      w.request(36, { userId: 'carol-id', createdAt: LATE, is4k: true });
      await apply(w, 36);
      assert.deepEqual(w.store.list(), []);
      assert.deepEqual(w.tags('movie-4k'), []);

      // A 4K request grant on movie-4k is not joined by a late 4K request either, and the HD item stays public.
      const w2 = await world(t);
      w2.request(2, { is4k: true });
      w2.request(37, { userId: 'carol-id', createdAt: LATE, is4k: true });
      if (name === 'webhook') {
        await w2.service.processWebhook(parseWebhook({ notificationType: 'MEDIA_AVAILABLE', request: { id: '2' } }));
        assert.equal(await w2.service.processWebhook(parseWebhook({ notificationType: 'MEDIA_AVAILABLE', event: '4K Movie Now Available', request: { id: '37' } })), null);
      } else {
        const result = await w2.service.backfillRequests(SINCE);
        assert.deepEqual(result.granted, ['movie-4k']);
        assert.deepEqual(result.joined, []);
      }
      assert.deepEqual(w2.store.get('movie-4k').groupIds, ['house-a']);
      assert.equal(w2.store.get('movie-4k').joins, undefined);
      assert.equal(w2.store.get('movie-1'), undefined);
      assert.deepEqual(w2.blocked('carol-id'), [accessTag('movie-4k')]);
    });

    it(`never create a grant for a TV request whose seasons were all available already (${name})`, async (t) => {
      const w = await world(t);
      // Season 1 was in Jellyfin long before; season 2 was added before the request too.
      w.request(38, { userId: 'carol-id', createdAt: LATE, mediaType: 'tv', seasons: [1, 2] });
      // A TV request that names no season proves nothing new was added.
      w.request(39, { userId: 'carol-id', createdAt: NEW, mediaType: 'tv' });
      if (name === 'webhook') {
        assert.equal(await w.deliver(38, 'Series Now Available'), null);
        assert.equal(await w.deliver(39, 'Series Request Now Available'), null);
      } else {
        await w.service.backfillRequests(SINCE);
      }
      assert.deepEqual(w.store.list(), []);
      assert.deepEqual(w.tags('series-1'), []);
    });
  }

  it('behave the same whichever of Seerr\'s two availability events arrives first', async (t) => {
    const outcomes = [];
    for (const order of EVENT_ORDERS) {
      const w = await world(t);
      w.request(1);
      await w.deliver(1);
      w.request(40, { userId: 'carol-id', createdAt: LATE });
      w.request(41, { userId: 'dave-id', createdAt: LATE });
      // Movie 1 has a request grant (joined); Seerr reports each late request available twice.
      for (const event of order) {
        assert.equal(await w.deliver(40, event), null, event);
        assert.equal(await w.deliver(41, event), null, event);
      }
      const grant = w.store.get('movie-1');
      outcomes.push({
        groupIds: grant.groupIds,
        manualUserIds: grant.manualUserIds,
        requests: grant.requests,
        joins: grant.joins.map((join) => ({ ...join, joinedAt: undefined })),
        carol: w.blocked('carol-id'),
        dave: w.blocked('dave-id'),
        metrics: w.service.renderMetrics().split('\n').filter((line) => line.startsWith('jfa_webhooks_total')).sort(),
      });
    }
    assert.deepEqual(outcomes[0], outcomes[1]);
    assert.deepEqual(outcomes[0].groupIds, ['house-a', 'house-b']);
    assert.deepEqual(outcomes[0].joins.length, 2, 'each late request joins once');
    assert.deepEqual(outcomes[0].metrics, [
      'jfa_webhooks_total{result="granted"} 1',
      'jfa_webhooks_total{result="ignored"} 2',
      'jfa_webhooks_total{result="late"} 2',
    ]);

    // On a public movie, both orders leave it public.
    for (const order of EVENT_ORDERS) {
      const w = await world(t);
      w.request(42, { userId: 'carol-id', createdAt: LATE });
      for (const event of order) assert.equal(await w.deliver(42, event), null, event);
      assert.deepEqual(w.store.list(), []);
      assert.deepEqual(w.tags('movie-1'), []);
    }
  });

  it('count as late when Seerr gives no creation time or Jellyfin no date, failing safe', async (t) => {
    const w = await world(t);
    w.request(43, { userId: 'carol-id' });
    delete w.requests.get('43').createdAt;
    w.request(44, { userId: 'carol-id', createdAt: 'not a date' });
    assert.equal(await w.deliver(43), null);
    assert.equal(await w.deliver(44), null);
    // A new request, but Jellyfin reports no date for the item.
    delete w.items.get('movie-1').DateCreated;
    w.request(45, { userId: 'carol-id' });
    assert.equal(await w.deliver(45), null);
    assert.deepEqual(w.store.list(), []);
    assert.deepEqual(w.tags('movie-1'), []);
  });
});

describe('new requests (the title became available after the request) are unchanged', () => {
  for (const [name, apply] of PATHS) {
    it(`create a household grant on a public movie (${name})`, async (t) => {
      const w = await world(t);
      w.request(50, { userId: 'carol-id' });
      await apply(w, 50);
      const grant = w.store.get('movie-1');
      assert.deepEqual(grant.requests, { 50: 'carol-id' });
      assert.deepEqual(grant.groupIds, ['house-b']);
      assert.deepEqual(w.tags('movie-1'), [accessTag('movie-1')]);
      assert.deepEqual(w.blocked('alice-id'), [accessTag('movie-1')]);
      assert.deepEqual(w.blocked('carol-id'), []);
    });

    it(`re-add the requester's household an administrator removed, the documented exception (${name})`, async (t) => {
      const w = await world(t);
      w.request(1);
      await w.deliver(1);
      await w.service.setGrantGroups('movie-1', ['house-a', 'house-b']);
      await w.service.setGrantGroups('movie-1', ['house-a']);
      assert.deepEqual(w.store.getRemovals('movie-1').groupIds, ['house-b']);

      w.request(51, { userId: 'carol-id' });
      await apply(w, 51);
      const grant = w.store.get('movie-1');
      assert.deepEqual(grant.requests, { 1: 'alice-id', 51: 'carol-id' });
      assert.deepEqual(grant.groupIds, ['house-a', 'house-b']);
      assert.deepEqual(w.blocked('carol-id'), []);
    });

    it(`grant a TV request for seasons Jellyfin added after it, on a show that was partly available (${name})`, async (t) => {
      const w = await world(t);
      w.request(52, { userId: 'carol-id', mediaType: 'tv', seasons: [2] });
      await apply(w, 52);
      const grant = w.store.get('series-1');
      assert.deepEqual(grant.requests, { 52: 'carol-id' });
      assert.deepEqual(grant.groupIds, ['house-b']);
      assert.deepEqual(w.tags('series-1'), [accessTag('series-1')]);
    });

    it(`grant a 4K request on the 4K item only (${name})`, async (t) => {
      const w = await world(t);
      w.request(53, { userId: 'carol-id', is4k: true });
      if (name === 'webhook') {
        await w.service.processWebhook(parseWebhook({ notificationType: 'MEDIA_AVAILABLE', event: '4K Movie Request Now Available', request: { id: '53' } }));
      } else {
        await apply(w, 53);
      }
      assert.deepEqual(w.store.get('movie-4k').requests, { 53: 'carol-id' });
      assert.equal(w.store.get('movie-1'), undefined);
      assert.deepEqual(w.tags('movie-1'), []);
    });
  }

  it('grant the same whichever of Seerr\'s two availability events arrives first', async (t) => {
    const outcomes = [];
    for (const order of EVENT_ORDERS) {
      const w = await world(t);
      w.request(54, { userId: 'carol-id' });
      for (const event of order) await w.deliver(54, event);
      const { updatedAt, sync, ...grant } = w.store.get('movie-1');
      outcomes.push({ grant, syncState: sync.state, tags: w.tags('movie-1'), alice: w.blocked('alice-id') });
    }
    assert.deepEqual(outcomes[0], outcomes[1]);
    assert.deepEqual(outcomes[0].grant.groupIds, ['house-b']);
  });
});
