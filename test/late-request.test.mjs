import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AccessService, accessTag } from '../dist/access-service.js';
import { availabilityEpisode, availabilityTitle } from '../dist/availability.js';
import { GrantStore } from '../dist/store.js';
import { parseWebhook } from '../dist/webhook.js';
import { makeTempDir } from './support/temp-dir.mjs';

// Seerr accepts POST /api/v1/request for a movie that is already available and, for a user who may auto-approve,
// reports it available at once: MEDIA_AVAILABLE as `Movie Now Available` and `Movie Request Now Available`, in either
// order, for the same request. Such a "late" request must be treated like a household library join, never as a grant.
// Whether a request is late is decided by what JellyPass saw in Jellyfin (its availability journal) when the request
// was made. Jellyfin's DateCreated is the file's time: a download keeps the release's old one, and a rewrite or
// upgrade sets a new one, so the fixtures below give files dates that would mislead a DateCreated comparison.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** The journal's first full sync. */
const T0 = Date.parse('2026-06-01T00:00:00.000Z');
const iso = (time) => new Date(time).toISOString();
/** A release's file time, kept by the downloader: long before any request. */
const OLD_FILE = '2022-03-01T00:00:00.0000000Z';
const SINCE = new Date('2026-01-01T00:00:00.000Z');
const EVENT_ORDERS = [
  ['Movie Now Available', 'Movie Request Now Available'],
  ['Movie Request Now Available', 'Movie Now Available'],
];

/**
 * At T0 Jellyfin has the movie TMDB 603 as movie-1 (HD) and movie-4k (4K), and the series TMDB 1399 as series-1 with
 * all 10 episodes of season 1 and 4 of season 2's 10; the journal's first full sync runs then (unless `synced` is
 * false). Alice and Bob are House A, Carol is House B, Dave belongs to no household. The clock then stands at
 * T0 + 1 day. `file` reuses a state file, as after a restart.
 */
async function world(t, { seerr = true, synced = true, file } = {}) {
  const clock = { now: T0 };
  const users = [
    { Id: 'admin-id', Name: 'Admin', Policy: { IsAdministrator: true, BlockedTags: [] } },
    { Id: 'alice-id', Name: 'Alice', Policy: { BlockedTags: [] } },
    { Id: 'bob-id', Name: 'Bob', Policy: { BlockedTags: [] } },
    { Id: 'carol-id', Name: 'Carol', Policy: { BlockedTags: [] } },
    { Id: 'dave-id', Name: 'Dave', Policy: { BlockedTags: [] } },
  ];
  /** Jellyfin's items by ID; `savedAt` is when Jellyfin last saved one (its DateLastSaved). */
  const items = new Map();
  const episodes = [];
  const calls = [];
  /** Called with each Jellyfin or Seerr call before it answers, so a test can abort during it. */
  let onCall;
  const called = async (name) => {
    calls.push(name);
    await onCall?.(name);
  };
  const dto = (item) => {
    const { savedAt, tmdbId, width, ...rest } = item;
    return structuredClone({ ...rest, ProviderIds: tmdbId ? { Tmdb: String(tmdbId) } : {}, ...(width ? { Width: width } : {}) });
  };
  const qualities = (width) => ((width ?? 0) > 2000 ? ['hd', '4k'] : ['hd']);
  const title = (item) => ({
    mediaType: item.Type === 'Movie' ? 'movie' : 'tv',
    itemId: item.Id,
    ...(item.tmdbId ? { tmdbId: item.tmdbId } : {}),
    qualities: qualities(item.width),
  });
  const episode = (entry) => ({ seriesId: entry.SeriesId, seasonNumber: entry.ParentIndexNumber, qualities: qualities(entry.width) });
  const jellyfin = {
    async getUsers() {
      await called('getUsers');
      return structuredClone(users);
    },
    async getItem(itemId) {
      await called('getItem');
      const item = items.get(itemId);
      if (!item) throw Object.assign(new Error(`Jellyfin GET /Items/${itemId} returned 404`), { status: 404 });
      return dto(item);
    },
    async getItems(itemIds) { return Promise.all(itemIds.map((itemId) => jellyfin.getItem(itemId))); },
    async getLocalTrailers() { return []; },
    async updateItem(item) {
      items.set(item.Id, { ...items.get(item.Id), Tags: structuredClone(item.Tags), savedAt: clock.now });
    },
    async updatePolicy(userId, policy) { users.find((user) => user.Id === userId).Policy = structuredClone(policy); },
    async fetchLibraryCatalog() {
      await called('fetchLibraryCatalog');
      return [...items.values()].map((item) => ({
        id: item.Id, name: item.Name, mediaType: item.Type.toLowerCase(), libraryId: 'library', libraryName: 'Library',
      }));
    },
    async fetchAvailability() {
      await called('fetchAvailability');
      return { titles: [...items.values()].map(title), episodes: episodes.map(episode) };
    },
    async fetchSavedSince(since) {
      await called('fetchSavedSince');
      const saved = [...items.values()].filter((item) => item.savedAt >= since.getTime());
      const seriesIds = [...new Set(episodes.filter((entry) => entry.savedAt >= since.getTime()).map((entry) => entry.SeriesId))];
      const series = seriesIds.map((id) => items.get(id)).filter((item) => item && !saved.includes(item));
      return { titles: [...saved, ...series].map(title), episodes: episodes.filter((entry) => seriesIds.includes(entry.SeriesId)).map(episode) };
    },
    async getEpisodes(seriesId) {
      await called('getEpisodes');
      return episodes.filter((entry) => entry.SeriesId === seriesId).map(episode);
    },
    /** JellyPass before the journal compared season folders' DateCreated; kept so this file can run against it. */
    async getSeasons(seriesId) {
      await called('getSeasons');
      const numbers = [...new Set(episodes.filter((entry) => entry.SeriesId === seriesId).map((entry) => entry.ParentIndexNumber))];
      return numbers.map((number) => ({
        Id: `${seriesId}-s${number}`,
        Type: 'Season',
        IndexNumber: number,
        DateCreated: episodes.find((entry) => entry.SeriesId === seriesId && entry.ParentIndexNumber === number).DateCreated,
      }));
    },
  };

  /** Jellyfin adds an item now; its DateCreated is the file's time. */
  const addItem = (id, { name = id, type = 'Movie', tmdbId, width = 1920, dateCreated = OLD_FILE } = {}) => {
    items.set(id, { Id: id, Name: name, Type: type, DateCreated: dateCreated, Tags: [], tmdbId, width, savedAt: clock.now });
  };
  const addEpisodes = (seriesId, season, count, { width = 1920, dateCreated = OLD_FILE } = {}) => {
    const existing = episodes.filter((entry) => entry.SeriesId === seriesId && entry.ParentIndexNumber === season).length;
    for (let index = 1; index <= count; index += 1) {
      episodes.push({
        Id: `${seriesId}-s${season}e${existing + index}`, SeriesId: seriesId, ParentIndexNumber: season, width, DateCreated: dateCreated, savedAt: clock.now,
      });
    }
  };
  /** Jellyfin deletes an item (and a series' episodes). */
  const removeItem = (id) => {
    items.delete(id);
    for (let index = episodes.length - 1; index >= 0; index -= 1) if (episodes[index].SeriesId === id) episodes.splice(index, 1);
  };
  /** A re-import or upgrade: the item is replaced by a new one, with a new ID and the new file's time. */
  const reimport = (fromId, toId, dateCreated) => {
    const item = items.get(fromId);
    removeItem(fromId);
    addItem(toId, { name: item.Name, type: item.Type, tmdbId: item.tmdbId, width: item.width, dateCreated });
  };

  /** Seerr's media rows by TMDB ID: the items it links each quality to. */
  const media = new Map();
  const link = (tmdbId, links) => media.set(tmdbId, { ...media.get(tmdbId), ...links });
  const requests = new Map();
  /** A request as Seerr answers it, with its media row as it is now. */
  const seerrView = (request) => {
    const row = media.get(request.tmdbId) ?? {};
    return structuredClone({
      id: request.id,
      status: request.status,
      type: row.mediaType ?? 'movie',
      is4k: request.is4k,
      ...(request.createdAt === undefined ? {} : { createdAt: request.createdAt }),
      requestedBy: { jellyfinUserId: request.userId },
      ...(request.seasons ? { seasons: request.seasons.map((seasonNumber) => ({ seasonNumber })) } : {}),
      media: {
        mediaType: row.mediaType ?? 'movie',
        tmdbId: request.tmdbId,
        status: row.hd ? 5 : 3,
        status4k: row['4k'] ? 5 : 3,
        ...(row.hd ? { jellyfinMediaId: row.hd } : {}),
        ...(row['4k'] ? { jellyfinMediaId4k: row['4k'] } : {}),
      },
    });
  };
  const seerrClient = {
    async getRequest(requestId) {
      await called('seerr.getRequest');
      const request = requests.get(String(requestId));
      if (!request) throw Object.assign(new Error(`Seerr GET /api/v1/request/${requestId} returned 404`), { status: 404 });
      return seerrView(request);
    },
    async listRequestsSince() {
      await called('seerr.listRequestsSince');
      return [...requests.values()].reverse().map(seerrView);
    },
  };
  /** Seerr saves a request now (or at `createdAt`); its database sets the time. */
  const request = (id, { userId = 'alice-id', tmdbId = 603, is4k = false, seasons, status = 5, createdAt = iso(clock.now) } = {}) => {
    requests.set(String(id), { id, userId, tmdbId, is4k, seasons, status, createdAt });
  };

  const stateFile = file ?? path.join(await makeTempDir(t, 'jfa-late-'), 'grants.json');
  const store = new GrantStore(stateFile);
  await store.load();
  const service = new AccessService(jellyfin, store, undefined, seerr ? seerrClient : undefined, { now: () => new Date(clock.now) });
  if (!file) {
    await service.upsertGroup({ id: 'house-a', name: 'House A', userIds: ['alice-id', 'bob-id'] });
    await service.upsertGroup({ id: 'house-b', name: 'House B', userIds: ['carol-id'] });
  }
  addItem('movie-1', { tmdbId: 603 });
  addItem('movie-4k', { tmdbId: 603, width: 3840 });
  link(603, { mediaType: 'movie', hd: 'movie-1', '4k': 'movie-4k' });
  addItem('series-1', { type: 'Series', tmdbId: 1399 });
  addEpisodes('series-1', 1, 10);
  addEpisodes('series-1', 2, 4);
  link(1399, { mediaType: 'tv', hd: 'series-1' });
  if (synced) await service.syncLibraryCatalog();
  clock.now = T0 + DAY;

  /** Seerr's MEDIA_AVAILABLE webhook for a request, as the documented template fills it. */
  const deliver = (id, event = 'Movie Request Now Available') => {
    const saved = requests.get(String(id));
    const row = media.get(saved?.tmdbId) ?? {};
    return service.processWebhook(parseWebhook({
      notificationType: 'MEDIA_AVAILABLE',
      event: saved?.is4k ? `4K ${event}` : event,
      media: { jellyfinMediaId: row.hd ?? 'movie-1', mediaType: row.mediaType ?? 'movie' },
      request: { id: String(id), requestedBy: { jellyfinUserId: saved?.userId ?? 'alice-id' } },
    }));
  };
  const blocked = (userId) => users.find((user) => user.Id === userId).Policy.BlockedTags;
  const tags = (itemId) => items.get(itemId).Tags;
  const isPrivate = (itemId) => tags(itemId).includes(accessTag(itemId));
  return {
    clock, store, service, stateFile, calls, items, episodes, requests,
    setOnCall: (hook) => { onCall = hook; },
    addItem, addEpisodes, removeItem, reimport, link, request, deliver, blocked, tags, isPrivate,
    sync: () => service.syncLibraryCatalog(),
    poll: () => service.pollAvailability(),
  };
}

/** Adds TMDB 604 as movie-2 now, linked by Seerr. */
function addMovie2(w, options = {}) {
  w.addItem('movie-2', { tmdbId: 604, ...options });
  w.link(604, { mediaType: 'movie', hd: 'movie-2' });
}

/** Webhook and backfill, each run on a fresh world; `apply` hands a request ID to one of them. */
const PATHS = [
  ['webhook', (w, id, event) => w.deliver(id, event)],
  ['backfill', (w) => w.service.backfillRequests(SINCE)],
];

describe('late requests (made when JellyPass had already seen the title in Jellyfin)', () => {
  for (const [name, apply] of PATHS) {
    it(`leave a public movie public (${name})`, async (t) => {
      const w = await world(t);
      w.request(30, { userId: 'carol-id' });
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

    it(`stay late when the title was re-imported (new item ID, newer file date) before the request was handled (${name})`, async (t) => {
      const w = await world(t);
      w.request(31, { userId: 'carol-id' });
      // Radarr upgrades the file: Jellyfin replaces movie-1 with movie-1b, dated after the request, and Seerr relinks.
      w.clock.now += HOUR;
      w.reimport('movie-1', 'movie-1b', iso(w.clock.now));
      w.link(603, { hd: 'movie-1b' });
      w.clock.now += HOUR;
      await w.sync();
      await apply(w, 31);
      assert.deepEqual(w.store.list(), []);
      assert.deepEqual(w.tags('movie-1b'), []);
      assert.equal(w.store.hasHandledRequest('31'), true);
    });

    it(`stay late when a full sync saw the title missing for a while after the request (${name})`, async (t) => {
      const w = await world(t);
      w.request(32, { userId: 'carol-id' });
      w.clock.now += HOUR;
      // Both versions go (a 4K file counts as HD too).
      w.removeItem('movie-1');
      w.removeItem('movie-4k');
      await w.sync();
      w.clock.now += HOUR;
      w.addItem('movie-1c', { tmdbId: 603, dateCreated: iso(w.clock.now) });
      w.link(603, { hd: 'movie-1c' });
      await w.sync();
      await apply(w, 32);
      assert.deepEqual(w.store.list(), []);
    });

    it(`cannot re-add a household or user an administrator removed (${name})`, async (t) => {
      const w = await world(t);
      // Alice's new request made a new title House A's; Carol and Dave got access and an administrator took it away.
      w.request(1, { tmdbId: 604 });
      w.clock.now += HOUR;
      addMovie2(w);
      await w.deliver(1);
      await w.service.setManualAccess({ itemId: 'movie-2', userIds: ['dave-id'], groupIds: ['house-a', 'house-b'] });
      await w.service.setManualAccess({ itemId: 'movie-2', userIds: [], groupIds: ['house-a'] });
      assert.deepEqual(w.store.getRemovals('movie-2'), { userIds: ['carol-id', 'dave-id'], groupIds: ['house-b'] });
      const before = w.store.get('movie-2');

      // JellyPass saw movie-2 when it applied request 1, so these later requests are late, before any full sync.
      w.clock.now += HOUR;
      w.request(33, { userId: 'carol-id', tmdbId: 604 });
      w.request(34, { userId: 'dave-id', tmdbId: 604 });
      if (name === 'webhook') {
        assert.equal(await w.deliver(33), null);
        assert.equal(await w.deliver(34), null);
      } else {
        const result = await w.service.backfillRequests(SINCE);
        assert.deepEqual(result.granted, []);
        assert.deepEqual(result.joined, []);
      }
      assert.deepEqual(w.store.get('movie-2'), before);
      assert.deepEqual(w.blocked('carol-id'), [accessTag('movie-2')]);
      assert.deepEqual(w.blocked('dave-id'), [accessTag('movie-2')]);
      assert.equal(w.store.hasHandledRequest('33'), true);
      assert.equal(w.store.hasHandledRequest('34'), true);
    });

    it(`do not touch a manual-only grant (${name})`, async (t) => {
      const w = await world(t);
      await w.service.setManualAccess({ itemId: 'movie-1', userIds: [], groupIds: ['house-a'] });
      const before = w.store.get('movie-1');
      w.request(35, { userId: 'carol-id' });
      await apply(w, 35);
      assert.deepEqual(w.store.get('movie-1'), before);
      assert.deepEqual(w.blocked('carol-id'), [accessTag('movie-1')]);
    });

    it(`join a request grant with the requester's households, honouring removal marks (${name})`, async (t) => {
      const w = await world(t);
      w.request(1, { tmdbId: 604 });
      w.clock.now += HOUR;
      addMovie2(w);
      await w.deliver(1);
      // An administrator removed House B while it was empty, so only the household is marked; Carol, who joined it
      // later, also belongs to House C.
      await w.service.upsertGroup({ id: 'house-b', name: 'House B', userIds: [] });
      await w.service.setGrantGroups('movie-2', ['house-a', 'house-b']);
      await w.service.setGrantGroups('movie-2', ['house-a']);
      await w.service.upsertGroup({ id: 'house-b', name: 'House B', userIds: ['carol-id'] });
      await w.service.upsertGroup({ id: 'house-c', name: 'House C', userIds: ['carol-id'] });
      assert.deepEqual(w.store.getRemovals('movie-2'), { groupIds: ['house-b'] });

      w.clock.now += HOUR;
      w.request(36, { userId: 'carol-id', tmdbId: 604 });
      w.request(37, { userId: 'dave-id', tmdbId: 604 });
      if (name === 'webhook') {
        assert.equal(await w.deliver(36), null, 'a late request is not reported as granted');
        assert.equal(await w.deliver(37), null);
      } else {
        const result = await w.service.backfillRequests(SINCE);
        assert.deepEqual(result.granted, []);
        assert.deepEqual(result.joined, ['movie-2', 'movie-2']);
      }
      const grant = w.store.get('movie-2');
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
      w.request(38, { userId: 'carol-id', is4k: true });
      await apply(w, 38);
      assert.deepEqual(w.store.list(), []);
      assert.deepEqual(w.tags('movie-4k'), []);

      // A 4K request grant is not joined by a late 4K request either, and the HD item stays public.
      const w2 = await world(t);
      w2.request(2, { is4k: true, tmdbId: 604 });
      w2.clock.now += HOUR;
      addMovie2(w2);
      w2.addItem('movie-2-4k', { tmdbId: 604, width: 3840 });
      w2.link(604, { '4k': 'movie-2-4k' });
      await w2.sync();
      w2.clock.now += HOUR;
      w2.request(39, { userId: 'carol-id', is4k: true, tmdbId: 604 });
      if (name === 'webhook') {
        await w2.deliver(2);
        assert.equal(await w2.deliver(39), null);
      } else {
        const result = await w2.service.backfillRequests(SINCE);
        assert.deepEqual(result.granted, ['movie-2-4k']);
        assert.deepEqual(result.joined, []);
      }
      assert.deepEqual(w2.store.get('movie-2-4k').groupIds, ['house-a']);
      assert.equal(w2.store.get('movie-2-4k').joins, undefined);
      assert.equal(w2.store.get('movie-2'), undefined);
      assert.deepEqual(w2.blocked('carol-id'), [accessTag('movie-2-4k')]);
    });

    it(`never create a grant for a TV request whose seasons were all there already, even after a rewrite (${name})`, async (t) => {
      const w = await world(t);
      // Season 1 was complete; a rewriter then replaced its files, so every episode has a new date.
      w.request(40, { userId: 'carol-id', tmdbId: 1399, seasons: [1] });
      w.clock.now += HOUR;
      for (let index = w.episodes.length - 1; index >= 0; index -= 1) {
        if (w.episodes[index].ParentIndexNumber === 1) w.episodes.splice(index, 1);
      }
      w.addEpisodes('series-1', 1, 10, { dateCreated: iso(w.clock.now) });
      await apply(w, 40, 'Series Now Available');
      assert.deepEqual(w.store.list(), []);
      assert.deepEqual(w.tags('series-1'), []);
    });

    it(`never create a grant for a TV request that names no season (${name})`, async (t) => {
      const w = await world(t);
      // A new series, added after the request: only its seasons could show that the request asked for something.
      w.request(41, { userId: 'carol-id', tmdbId: 1400 });
      w.clock.now += HOUR;
      w.addItem('series-2', { type: 'Series', tmdbId: 1400, dateCreated: iso(w.clock.now) });
      w.addEpisodes('series-2', 1, 8, { dateCreated: iso(w.clock.now) });
      w.link(1400, { mediaType: 'tv', hd: 'series-2' });
      await apply(w, 41, 'Series Request Now Available');
      assert.deepEqual(w.store.list(), []);
      assert.deepEqual(w.tags('series-2'), []);
      assert.equal(w.store.hasHandledRequest('41'), true);
    });
  }

  it('behave the same whichever of Seerr\'s two availability events arrives first', async (t) => {
    const outcomes = [];
    for (const order of EVENT_ORDERS) {
      const w = await world(t);
      w.request(1, { tmdbId: 604 });
      w.clock.now += HOUR;
      addMovie2(w);
      await w.deliver(1);
      w.clock.now += HOUR;
      w.request(42, { userId: 'carol-id', tmdbId: 604 });
      w.request(43, { userId: 'dave-id', tmdbId: 604 });
      // Movie 2 has a request grant (joined); Seerr reports each late request available twice.
      for (const event of order) {
        assert.equal(await w.deliver(42, event), null, event);
        assert.equal(await w.deliver(43, event), null, event);
      }
      const grant = w.store.get('movie-2');
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
      w.request(44, { userId: 'carol-id' });
      for (const event of order) assert.equal(await w.deliver(44, event), null, event);
      assert.deepEqual(w.store.list(), []);
      assert.deepEqual(w.tags('movie-1'), []);
    }
  });

  it('count as late when Seerr gives no valid creation time, failing safe', async (t) => {
    const w = await world(t);
    w.request(45, { userId: 'carol-id', tmdbId: 604, createdAt: undefined });
    w.requests.get('45').createdAt = undefined;
    w.request(46, { userId: 'carol-id', tmdbId: 604, createdAt: 'not a date' });
    addMovie2(w);
    assert.equal(await w.deliver(45), null);
    assert.equal(await w.deliver(46), null);
    assert.deepEqual(w.store.list(), []);
    assert.deepEqual(w.tags('movie-2'), []);
  });

  it('judge a 4K request by the 4K version alone, and an HD request by the HD one', async (t) => {
    const w = await world(t);
    // Jellyfin has only the HD version of TMDB 604; Carol asks for 4K, which arrives with an old file date.
    addMovie2(w);
    await w.sync();
    w.clock.now += HOUR;
    w.request(47, { userId: 'carol-id', tmdbId: 604, is4k: true });
    w.request(48, { userId: 'dave-id', tmdbId: 604 });
    w.clock.now += HOUR;
    w.addItem('movie-2-4k', { tmdbId: 604, width: 3840 });
    w.link(604, { '4k': 'movie-2-4k' });
    await w.deliver(47);
    assert.deepEqual(w.store.get('movie-2-4k').requests, { 47: 'carol-id' });
    assert.ok(w.isPrivate('movie-2-4k'));
    // Dave's HD request came after the HD version was there: late, so the HD item stays public.
    assert.equal(await w.deliver(48), null);
    assert.equal(w.store.get('movie-2'), undefined);
    assert.deepEqual(w.tags('movie-2'), []);
  });
});

describe('new requests (the title was not in Jellyfin when requested) are granted', () => {
  for (const [name, apply] of PATHS) {
    it(`even when the file keeps an old release date, like live requests #171 and #172 (${name})`, async (t) => {
      const w = await world(t);
      w.request(50, { userId: 'carol-id', tmdbId: 604 });
      // The download finishes an hour later; SABnzbd kept the release group's 2022 file time.
      w.clock.now += HOUR;
      addMovie2(w, { dateCreated: OLD_FILE });
      await w.sync();
      await apply(w, 50);
      const grant = w.store.get('movie-2');
      assert.deepEqual(grant.requests, { 50: 'carol-id' });
      assert.deepEqual(grant.groupIds, ['house-b']);
      assert.ok(w.isPrivate('movie-2'));
      assert.deepEqual(w.blocked('alice-id'), [accessTag('movie-2')]);
      assert.deepEqual(w.blocked('carol-id'), []);
    });

    it(`even when the file was rewritten after it arrived, keeping an old date (${name})`, async (t) => {
      const w = await world(t);
      w.request(51, { userId: 'carol-id', tmdbId: 604 });
      w.clock.now += HOUR;
      addMovie2(w, { dateCreated: iso(w.clock.now) });
      await w.sync();
      // An .mp4 to .mkv rewriter replaces the file (new item ID) and copies the release's old time onto it.
      w.clock.now += HOUR;
      w.reimport('movie-2', 'movie-2b', OLD_FILE);
      w.link(604, { hd: 'movie-2b' });
      await w.sync();
      await apply(w, 51);
      assert.deepEqual(w.store.get('movie-2b').requests, { 51: 'carol-id' });
      assert.ok(w.isPrivate('movie-2b'));
    });

    it(`when the title arrived after the last full sync but before the request: the documented gap a poll narrows (${name})`, async (t) => {
      // Without a poll, a title added after the last full sync is unknown to JellyPass, so a request for it is new.
      const w = await world(t);
      addMovie2(w);
      w.clock.now += 30 * 60_000;
      w.request(52, { userId: 'carol-id', tmdbId: 604 });
      await apply(w, 52);
      assert.deepEqual(w.store.get('movie-2').requests, { 52: 'carol-id' });

      // A poll that ran between the title's arrival and the request makes the same request late.
      const polled = await world(t);
      addMovie2(polled);
      polled.clock.now += 5 * 60_000;
      // The poll overlaps the last sync, so it also sees again what that sync saw: movie-1, movie-4k and series-1's 14
      // episodes.
      assert.deepEqual(await polled.poll(), { titles: 4, episodes: 14 });
      polled.clock.now += 25 * 60_000;
      polled.request(52, { userId: 'carol-id', tmdbId: 604 });
      await apply(polled, 52);
      assert.deepEqual(polled.store.list(), []);
      assert.deepEqual(polled.tags('movie-2'), []);
    });

    it(`after the title was deleted, once a full sync saw it gone (${name})`, async (t) => {
      const w = await world(t);
      w.removeItem('movie-1');
      w.removeItem('movie-4k');
      w.clock.now += HOUR;
      await w.sync();
      w.clock.now += HOUR;
      w.request(53, { userId: 'carol-id' });
      w.clock.now += HOUR;
      w.addItem('movie-1d', { tmdbId: 603, dateCreated: OLD_FILE });
      w.link(603, { hd: 'movie-1d' });
      await apply(w, 53);
      assert.deepEqual(w.store.get('movie-1d').requests, { 53: 'carol-id' });

      // Re-requested before any full sync saw the title gone: it still counts as there, so it is late (fails safe).
      const early = await world(t);
      early.removeItem('movie-1');
      early.removeItem('movie-4k');
      early.request(53, { userId: 'carol-id' });
      early.clock.now += HOUR;
      early.addItem('movie-1d', { tmdbId: 603 });
      early.link(603, { hd: 'movie-1d' });
      await early.sync();
      await apply(early, 53);
      assert.deepEqual(early.store.list(), []);
    });

    it(`for a TV request that completes a partly available season (${name})`, async (t) => {
      const w = await world(t);
      // Season 2 had 4 of its 10 episodes; the other 6 arrive after the request, with old file dates.
      w.request(54, { userId: 'carol-id', tmdbId: 1399, seasons: [2] });
      w.clock.now += HOUR;
      w.addEpisodes('series-1', 2, 6);
      await apply(w, 54, 'Series Request Now Available');
      const grant = w.store.get('series-1');
      assert.deepEqual(grant.requests, { 54: 'carol-id' });
      assert.deepEqual(grant.groupIds, ['house-b']);
      assert.ok(w.isPrivate('series-1'));
    });

    it(`for a TV request for a new season of a series Jellyfin had (${name})`, async (t) => {
      const w = await world(t);
      w.request(55, { userId: 'carol-id', tmdbId: 1399, seasons: [3] });
      w.clock.now += HOUR;
      w.addEpisodes('series-1', 3, 8);
      await apply(w, 55, 'Series Request Now Available');
      assert.deepEqual(w.store.get('series-1').requests, { 55: 'carol-id' });
    });

    it(`re-add the requester's household an administrator removed, the documented exception (${name})`, async (t) => {
      const w = await world(t);
      w.request(1, { tmdbId: 604 });
      w.request(56, { userId: 'carol-id', tmdbId: 604 });
      w.clock.now += HOUR;
      addMovie2(w);
      await w.deliver(1);
      await w.service.setGrantGroups('movie-2', ['house-a', 'house-b']);
      await w.service.setGrantGroups('movie-2', ['house-a']);
      assert.deepEqual(w.store.getRemovals('movie-2').groupIds, ['house-b']);

      // Carol asked before the title arrived, so hers is a new request too.
      await apply(w, 56);
      const grant = w.store.get('movie-2');
      assert.deepEqual(grant.requests, { 1: 'alice-id', 56: 'carol-id' });
      assert.deepEqual(grant.groupIds, ['house-a', 'house-b']);
      assert.deepEqual(w.blocked('carol-id'), []);
    });

    it(`when made before the journal's first full sync, as JellyPass 2.2.1 did (${name})`, async (t) => {
      const w = await world(t, { synced: false });
      w.request(57, { userId: 'carol-id', createdAt: iso(T0 - DAY) });
      await apply(w, 57);
      assert.deepEqual(w.store.get('movie-1').requests, { 57: 'carol-id' });

      // Once the journal has synced, a request made before that sync is still judged that way; a later one is not.
      const later = await world(t, { synced: false });
      await later.sync();
      later.request(58, { userId: 'carol-id', createdAt: iso(T0 - HOUR) });
      later.clock.now += 60_000;
      later.request(59, { userId: 'dave-id' });
      if (name === 'webhook') {
        await later.deliver(58);
        assert.equal(await later.deliver(59), null);
      } else {
        await later.service.backfillRequests(SINCE);
      }
      assert.deepEqual(later.store.get('movie-1').requests, { 58: 'carol-id' });
      assert.deepEqual(later.store.get('movie-1').manualUserIds, ['dave-id'], 'the late request joined');
    });
  }

  it('grant the same whichever of Seerr\'s two availability events arrives first', async (t) => {
    const outcomes = [];
    for (const order of EVENT_ORDERS) {
      const w = await world(t);
      w.request(60, { userId: 'carol-id', tmdbId: 604 });
      w.clock.now += HOUR;
      addMovie2(w);
      for (const event of order) await w.deliver(60, event);
      const { updatedAt, sync, ...grant } = w.store.get('movie-2');
      outcomes.push({ grant, syncState: sync.state, tags: w.tags('movie-2'), alice: w.blocked('alice-id') });
    }
    assert.deepEqual(outcomes[0], outcomes[1]);
    assert.deepEqual(outcomes[0].grant.groupIds, ['house-b']);
  });

  it('replay live requests #166-#188: every request that became available is new, whatever its file dates', async (t) => {
    // Shaped like the 23 live requests (synthetic IDs and titles): 19 became available and were granted, 4 did not
    // (declined). Most files' DateCreated is the import time; #168, #171 and #172 kept a 2025 or 2022 release time
    // from before the request, and four were rewritten or upgraded after import. Catalog syncs run hourly; each title
    // arrives 20 minutes to 7 hours 20 minutes after its request.
    const w = await world(t);
    const releaseTimes = { 168: '2025-02-11T09:30:00.0000000Z', 171: '2022-08-03T21:10:00.0000000Z', 172: '2022-11-19T04:45:00.0000000Z' };
    const rewritten = new Set([169, 176, 181, 185]);
    const unavailable = new Set([170, 179, 183, 187]);
    const timeline = [];
    for (let id = 166; id <= 188; id += 1) {
      const requestedAt = T0 + DAY + (id - 166) * 3 * HOUR;
      timeline.push({ at: requestedAt, run: () => w.request(id, { userId: id % 2 ? 'carol-id' : 'alice-id', tmdbId: 5000 + id, status: unavailable.has(id) ? 3 : 5 }) });
      if (unavailable.has(id)) continue;
      const arrivesAt = requestedAt + 20 * 60_000 + ((id * 37) % 8) * HOUR;
      timeline.push({ at: arrivesAt, run: async () => {
        w.addItem(`live-${id}`, { tmdbId: 5000 + id, dateCreated: releaseTimes[id] ?? iso(arrivesAt) });
        w.link(5000 + id, { mediaType: 'movie', hd: `live-${id}` });
        if (rewritten.has(id)) {
          w.clock.now = arrivesAt + 10 * 60_000;
          w.reimport(`live-${id}`, `live-${id}-v2`, iso(w.clock.now));
          w.link(5000 + id, { hd: `live-${id}-v2` });
        }
        await w.deliver(id);
      } });
    }
    for (let hour = 1; hour <= 80; hour += 1) timeline.push({ at: T0 + DAY + hour * HOUR - 1, run: () => w.sync() });
    timeline.sort((left, right) => left.at - right.at);
    for (const step of timeline) {
      w.clock.now = Math.max(w.clock.now, step.at);
      await step.run();
    }
    const granted = w.store.list().filter((grant) => Object.keys(grant.requests).length > 0);
    assert.equal(granted.length, 19);
    for (const grant of granted) assert.ok(w.isPrivate(grant.itemId), grant.itemId);
    for (const id of [168, 171, 172]) assert.ok(w.store.get(`live-${id}`), `request ${id}`);
    assert.doesNotMatch(w.service.renderMetrics(), /result="late"/);
    const backfill = await w.service.backfillRequests(SINCE);
    assert.deepEqual([backfill.granted, backfill.joined, backfill.skipped], [[], [], 23]);
  });
});

describe('the availability journal', () => {
  it('survives a restart, and keeps knowing a title under a new Jellyfin item ID', async (t) => {
    const w = await world(t);
    // JellyPass restarts on the same state file; Jellyfin meanwhile re-imported movie-1 as movie-1e.
    const restarted = await world(t, { file: w.stateFile, synced: false });
    restarted.removeItem('movie-1');
    restarted.addItem('movie-1e', { tmdbId: 603, dateCreated: iso(restarted.clock.now) });
    restarted.link(603, { hd: 'movie-1e' });
    restarted.request(70, { userId: 'carol-id' });
    assert.equal(await restarted.deliver(70), null);
    assert.deepEqual(restarted.store.list(), []);
    assert.deepEqual(restarted.tags('movie-1e'), []);
  });

  it('keeps a deleted title for its retention period, then forgets it', async (t) => {
    const w = await world(t);
    w.removeItem('movie-1');
    w.removeItem('movie-4k');
    await w.sync();
    const reload = async () => {
      const reloaded = new GrantStore(w.stateFile);
      await reloaded.load();
      return reloaded;
    };
    const kept = await reload();
    assert.equal(kept.availableAt(['movie:tmdb-603:hd'], T0 + HOUR), 2, 'there before the deletion');
    assert.equal(kept.availableAt(['movie:tmdb-603:hd'], w.clock.now + 1), 0, 'gone after it');
    w.clock.now = T0 + 401 * DAY;
    await w.sync();
    const pruned = await reload();
    assert.equal(pruned.availableAt(['movie:tmdb-603:hd', 'movie:tmdb-603:4k'], T0 + HOUR), 0, 'forgotten');
    assert.equal(pruned.availableAt(['tv:tmdb-1399:hd:s1'], T0 + 2 * DAY), 10, 'what is still there is kept');
    assert.equal(pruned.availabilitySince(), T0 + DAY, 'requests from before the retention period are judged as 2.2.1 did');
    const state = JSON.parse(await readFile(w.stateFile, 'utf8'));
    assert.deepEqual(Object.keys(state.availability.titles).sort(), ['tv:tmdb-1399:hd:s1', 'tv:tmdb-1399:hd:s2']);
  });

  it('reads a title and its qualities from Jellyfin items as Seerr would link them', () => {
    const movie = (fields) => availabilityTitle({ Id: 'A1', Name: 'Movie', Type: 'Movie', ...fields });
    assert.deepEqual(movie({ ProviderIds: { Tmdb: '603' } }), { mediaType: 'movie', itemId: 'A1', tmdbId: 603, qualities: ['hd'] });
    assert.deepEqual(movie({ ProviderIds: { tmdb: ' 603 ' }, Width: 1920 }).tmdbId, 603);
    assert.equal(movie({ ProviderIds: { Tmdb: 'tt0133093' } }).tmdbId, undefined, 'not a TMDB ID: the item ID is the title');
    assert.deepEqual(movie({ Width: 3840 }).qualities, ['hd', '4k']);
    assert.deepEqual(movie({ MediaSourceCount: 2 }).qualities, ['hd', '4k'], 'two versions: either may be 4K');
    assert.deepEqual(movie({ MediaSources: [{ MediaStreams: [{ Type: 'Audio', Width: 4000 }, { Type: 'Video', Width: 1280 }] }] }).qualities, ['hd']);
    assert.deepEqual(movie({ MediaSources: [{ MediaStreams: [{ Type: 'Video', Width: 3840 }] }] }).qualities, ['hd', '4k']);
    assert.equal(availabilityTitle({ Id: 'B1', Name: 'Trailer', Type: 'Trailer' }), undefined);
    assert.deepEqual(availabilityEpisode({ Id: 'E1', Name: 'E1', Type: 'Episode', SeriesId: 'S1', ParentIndexNumber: 2 }), { seriesId: 'S1', seasonNumber: 2, qualities: ['hd'] });
    assert.equal(availabilityEpisode({ Id: 'E2', Name: 'E2', Type: 'Episode', SeriesId: 'S1', ParentIndexNumber: 2, LocationType: 'Virtual' }), undefined, 'a missing episode');
    assert.equal(availabilityEpisode({ Id: 'E3', Name: 'E3', Type: 'Episode', SeriesId: 'S1' }), undefined, 'no season');
  });

  it('is stored additively in schema 7', async (t) => {
    const w = await world(t);
    const state = JSON.parse(await readFile(w.stateFile, 'utf8'));
    assert.equal(state.version, 7);
    assert.equal(state.availability.since, iso(T0));
    assert.deepEqual(state.availability.titles['movie:tmdb-603:hd'], [[iso(T0), 2]], 'the 4K file also counts as HD');
    assert.deepEqual(state.availability.titles['movie:tmdb-603:4k'], [[iso(T0), 1]]);
    assert.deepEqual(state.availability.titles['tv:tmdb-1399:hd:s2'], [[iso(T0), 4]]);
  });

  it('polls nothing before its first full sync, and records what Jellyfin saved since the last one', async (t) => {
    const w = await world(t, { synced: false });
    assert.deepEqual(await w.poll(), { titles: 0, episodes: 0 });
    assert.deepEqual(w.calls.filter((call) => call === 'fetchSavedSince'), []);
    await w.sync();
    w.clock.now += 10 * 60_000;
    w.addEpisodes('series-1', 2, 1);
    assert.deepEqual(await w.poll(), { titles: 1, episodes: 15 });
    assert.equal(w.store.availableAt(['tv:tmdb-1399:hd:s2'], w.clock.now + 1), 5);
    assert.equal(w.store.availableAt(['tv:tmdb-1399:hd:s2'], w.clock.now), 4, 'a request made as the poll finished is not judged by it');
  });
});

describe('shutdown during a TV request\'s classification', () => {
  it('starts no Jellyfin or Seerr call after the abort, whichever call it came during', async (t) => {
    const setup = async () => {
      const w = await world(t);
      w.request(80, { userId: 'carol-id', tmdbId: 1399, seasons: [2] });
      w.clock.now += HOUR;
      w.addEpisodes('series-1', 2, 6);
      w.calls.length = 0;
      return w;
    };
    // The backfill's calls for one TV request, up to and including its classification's.
    const probe = await setup();
    await probe.service.backfillRequests(SINCE);
    const classified = probe.calls.findIndex((call) => call === 'getEpisodes' || call === 'getSeasons');
    assert.ok(classified > 0, probe.calls.join());
    const sequence = probe.calls.slice(0, classified + 1);

    for (let index = 0; index < sequence.length; index += 1) {
      const w = await setup();
      const controller = new AbortController();
      let seen = 0;
      w.setOnCall(() => {
        if (seen++ === index) controller.abort(new Error('shutting down'));
      });
      await assert.rejects(w.service.backfillRequests(SINCE, { signal: controller.signal }), { name: 'OperationCancelledError' });
      assert.deepEqual(w.calls, sequence.slice(0, index + 1), `aborted during ${sequence[index]}`);
      assert.equal(w.store.hasHandledRequest('80'), false);
      assert.deepEqual(w.store.list(), []);
    }
  });
});
