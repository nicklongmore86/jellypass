// A household app under test: a fake TMDB, a fake Seerr and a fake Jellyfin (all real HTTP servers), and a JellyPass
// server whose household gateway serves the app API from them. TMDB answers are the canary-laden TMDB fixtures; Seerr
// answers are built from the canary-laden Seerr 3.5.1 fixtures.
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { request as httpRequest, createServer } from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { AccessService } from '../../dist/access-service.js';
import { JellyfinClient } from '../../dist/jellyfin.js';
import { SeerrClient } from '../../dist/seerr.js';
import { HouseholdRequests } from '../../dist/household-requests.js';
import { SeerrUserMap } from '../../dist/seerr-users.js';
import { makeServer } from '../../dist/server.js';
import { BackgroundTasks } from '../../dist/shutdown.js';
import { GrantStore } from '../../dist/store.js';
import { TmdbClient } from '../../dist/tmdb.js';
import { seerrFixture } from './seerr-fixtures.mjs';
import { tmdbFixture } from './tmdb-fixtures.mjs';
import { makeTempDir } from './temp-dir.mjs';

// Jellyfin users (32 hex digits, none a canary). Alice and Ann are household A ("farmhouse"); Bob is household B
// ("mill"); Carol is in no household unless a test puts her in some (see SHARED_HOUSEHOLDS); the outsider is in none.
export const ALICE = 'a11ce000a11ce000a11ce000a11ce000';
export const ANN = 'a2200000a2200000a2200000a2200000';
export const BOB = 'b0b00000b0b00000b0b00000b0b00000';
export const CAROL = 'ca201000ca201000ca201000ca201000';
export const OUTSIDER = 'e0e00000e0e00000e0e00000e0e00000';
/** A Jellyfin administrator, who signs in to nothing here: reconciliation needs one to read items. */
export const JELLYFIN_ADMIN = 'ad000000ad000000ad000000ad000000';
export const TOKENS = { [ALICE]: 'token-alice', [ANN]: 'token-ann', [BOB]: 'token-bob', [CAROL]: 'token-carol', [OUTSIDER]: 'token-outsider' };
export const HOST_A = 'jelly-farmhouse.example.test';
export const HOST_B = 'jelly-mill.example.test';
/** The default households, and the same with Carol in both. */
export const HOUSEHOLDS = [
  { id: 'farmhouse', name: 'Farmhouse', userIds: [ALICE, ANN] },
  { id: 'mill', name: 'Mill', userIds: [BOB] },
];
export const SHARED_HOUSEHOLDS = [
  { id: 'farmhouse', name: 'Farmhouse', userIds: [ALICE, ANN, CAROL] },
  { id: 'mill', name: 'Mill', userIds: [BOB, CAROL] },
];
// Seerr users, one per Jellyfin user.
export const SEERR_IDS = { [ALICE]: 11, [ANN]: 12, [BOB]: 21, [CAROL]: 41, [OUTSIDER]: 31 };
export const ADMIN = 2;
export const REQUEST = 32;
export const REQUEST_MOVIE = 262_144;
export const REQUEST_TV = 524_288;
// Titles. 900001 (a movie) and 900002 (a series) are T, the titles another household may hold; 900003 is in household
// A's own library.
export const T_MOVIE = 900001;
export const T_TV = 900002;
export const OWN_MOVIE = 900003;
// Jellyfin items (non-canary IDs).
export const ITEMS = {
  tMovie: '11110000111100001111000011110000',
  tSeries: '22220000222200002222000022220000',
  ownMovie: '33330000333300003333000033330000',
};

/** JellyPass's TMDB v3 API key in these tests (not a canary). */
export const TMDB_KEY = 'f00dfeedf00dfeedf00dfeedf00dfeed';

/** A household's member, by Jellyfin ID, as `Authorization` for the app. */
export function authorization(userId) {
  return `MediaBrowser Client="JellyPass app test", Device="Test", DeviceId="app-test", Version="1.0.0", Token="${TOKENS[userId]}"`;
}

/**
 * The baseline world, in which nobody but household A holds or asks for anything. `options` change it:
 * - `media`: tmdbId → Seerr's `mediaInfo` for that title (undefined: Seerr has no record). The app never reads it:
 *   the fake Seerr counts any title read as a violation;
 * - `requests`: Seerr user → that user's own requests (Seerr request objects);
 * - `blocklist`: the titles on Seerr's blocklist, as `{ mediaType, tmdbId }`;
 * - `items`, `episodes`: extra Jellyfin items and episodes;
 * - `seerrUsers`: Seerr user → changes to its record (permissions, jellyfinUserId);
 * - `failCatalogue`: a status TMDB answers every title call with (a `429` says `Retry-After: 0`);
 * - `tmdbQuota`: `{ calls, windowMs }`, TMDB's own rate limit: a title call beyond `calls` in the last `windowMs` is
 *   answered `429` with `Retry-After: 1`;
 * - `tmdbRateLimited`: how many title calls TMDB answers `429` first, with `Retry-After: <tmdbRetryAfter>`;
 * - `tmdbMovies`: more movies TMDB knows, by TMDB ID, as `{ title, release_date }`; search lists them too;
 * - `tmdbHang`: TMDB never answers a title call; it only notices when JellyPass gives up on it.
 */
export function world(options = {}) {
  return {
    media: { ...options.media },
    requests: { ...options.requests },
    blocklist: [...(options.blocklist ?? [])],
    items: [
      { Id: ITEMS.ownMovie, Name: 'Synthetic Movie Three', Type: 'Movie', ProviderIds: { Tmdb: String(OWN_MOVIE) }, Tags: [], library: 'shared' },
      ...(options.items ?? []),
    ],
    episodes: [...(options.episodes ?? [])],
    jellyfinUsers: {
      [ALICE]: { Name: 'Alice', Policy: { BlockedTags: ['jellypass-held-elsewhere'], EnabledFolders: ['shared'] } },
      [ANN]: { Name: 'Ann', Policy: { BlockedTags: ['jellypass-held-elsewhere'], EnabledFolders: ['shared'] } },
      [BOB]: { Name: 'Bob', Policy: { BlockedTags: [], EnableAllFolders: true } },
      [CAROL]: { Name: 'Carol', Policy: { BlockedTags: [], EnableAllFolders: true } },
      [OUTSIDER]: { Name: 'Outsider', Policy: { BlockedTags: [], EnableAllFolders: true } },
      [JELLYFIN_ADMIN]: { Name: 'Administrator', Policy: { IsAdministrator: true, BlockedTags: [], EnableAllFolders: true } },
      ...options.jellyfinUsers,
    },
    seerrUsers: {
      [SEERR_IDS[ALICE]]: { jellyfinUserId: ALICE, permissions: REQUEST },
      [SEERR_IDS[ANN]]: { jellyfinUserId: ANN, permissions: REQUEST },
      [SEERR_IDS[BOB]]: { jellyfinUserId: BOB, permissions: REQUEST },
      [SEERR_IDS[CAROL]]: { jellyfinUserId: CAROL, permissions: REQUEST },
      [SEERR_IDS[OUTSIDER]]: { jellyfinUserId: OUTSIDER, permissions: REQUEST },
      ...options.seerrUsers,
    },
    tokens: { ...TOKENS, ...options.tokens },
    passwords: { ...options.passwords },
    signInDown: options.signInDown ?? false,
    grants: [...(options.grants ?? [])],
    failCatalogue: options.failCatalogue,
    tmdbQuota: options.tmdbQuota,
    tmdbRateLimited: options.tmdbRateLimited ?? 0,
    tmdbRetryAfter: options.tmdbRetryAfter,
    tmdbMovies: { ...options.tmdbMovies },
    tmdbHang: options.tmdbHang ?? false,
    extraResults: options.extraResults ?? 0,
    // TMDB's discover lists page by page, if set: `(type, page)` gives that page's results ('movie' or 'tv'), or
    // undefined for the usual fixture (the same results on every page).
    tmdbDiscover: options.tmdbDiscover,
    // Seerr's quotas, by Seerr user: `{ movie: { limit, days }, tv: { limit, days } }` (none: no limit).
    quotas: { ...options.quotas },
    // New requests are approved at once (Seerr's auto-approve), or left pending.
    autoApprove: options.autoApprove ?? false,
    // A promise each POST /api/v1/request waits for before Seerr answers, if set.
    holdRequests: undefined,
    // A promise each POST /api/v1/request waits for after making the request and before answering, if set.
    holdCreated: undefined,
    // A promise each member quota read (GET /api/v1/user/:id/quota) waits for before Seerr answers, if set.
    holdQuota: undefined,
    // A promise each admin title read (GET /api/v1/movie|tv/:id) waits for before Seerr answers, if set.
    holdTitles: undefined,
  };
}

/** A Seerr request object for `user` (Seerr ID), shaped like the fixtures' and full of their canaries. */
export function seerrRequest({ type, tmdbId, status = 1, is4k = false, seasons }) {
  const template = structuredClone(seerrFixture('requests').results[type === 'tv' ? 0 : 1]);
  template.type = type;
  template.status = status;
  template.is4k = is4k;
  template.media.tmdbId = tmdbId;
  template.media.mediaType = type;
  if (seasons) template.seasons = seasons.map((seasonNumber) => ({ ...template.seasons[0], seasonNumber }));
  return template;
}

/** Seerr's `mediaInfo` for a title, as the fixtures record it for one held by another household, with `status`. */
export function mediaInfo(tmdbId, status, { requests } = {}) {
  const source = tmdbId === T_TV ? seerrFixture('tv').mediaInfo : seerrFixture('movie').mediaInfo;
  return { ...source, tmdbId, status, requests: requests ?? source.requests };
}

/**
 * Seerr's `mediaInfo` for T as a busy server would hold it: thousands of other households' requests, about `megabytes`
 * of JSON in all, each full of canaries.
 */
export function largeMediaInfo(tmdbId, megabytes) {
  const request = seerrFixture('movie').mediaInfo.requests[0];
  const size = Buffer.byteLength(JSON.stringify(request));
  const requests = Array.from({ length: Math.ceil((megabytes * 1024 * 1024) / size) }, () => request);
  return mediaInfo(tmdbId, 5, { requests });
}

/** The worlds that differ from the baseline only in whether household B holds or asked for T. */
export function otherHouseholdWorlds() {
  const blockedForA = (id, name, type, tmdbId, extra = {}) =>
    ({ Id: id, Name: name, Type: type, ProviderIds: { Tmdb: String(tmdbId) }, Tags: ['jellypass-held-elsewhere'], library: 'shared', ...extra });
  const tItems = (extra) => [
    blockedForA(ITEMS.tMovie, 'Synthetic Movie One', 'Movie', T_MOVIE, extra),
    blockedForA(ITEMS.tSeries, 'Synthetic Series Two', 'Series', T_TV, extra),
  ];
  const tEpisodes = [1, 2].map((season) => ({ Id: `4444000044440000444400004444000${season}`, SeriesId: ITEMS.tSeries, ParentIndexNumber: season }));
  return {
    'a private grant': world({
      media: { [T_MOVIE]: mediaInfo(T_MOVIE, 5), [T_TV]: mediaInfo(T_TV, 5) },
      requests: { [SEERR_IDS[BOB]]: [seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: 5 }), seerrRequest({ type: 'tv', tmdbId: T_TV, status: 5, seasons: [1, 2] })] },
      items: tItems(),
      episodes: tEpisodes,
      grants: [
        { request: { itemId: ITEMS.tMovie, mediaType: 'movie', requestId: '7300501', userId: BOB, groupIds: ['mill'] } },
        { request: { itemId: ITEMS.tSeries, mediaType: 'tv', requestId: '7300502', userId: BOB, groupIds: ['mill'] } },
      ],
    }),
    'a pending request': world({
      media: { [T_MOVIE]: mediaInfo(T_MOVIE, 2), [T_TV]: mediaInfo(T_TV, 3) },
      requests: { [SEERR_IDS[BOB]]: [seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: 1 }), seerrRequest({ type: 'tv', tmdbId: T_TV, status: 2, seasons: [2] })] },
    }),
    'a manual grant': world({
      media: { [T_MOVIE]: mediaInfo(T_MOVIE, 5, { requests: [] }), [T_TV]: mediaInfo(T_TV, 4, { requests: [] }) },
      items: tItems(),
      episodes: tEpisodes,
      grants: [
        { manual: { itemId: ITEMS.tMovie, mediaType: 'movie', userIds: [], groupIds: ['mill'] } },
        { manual: { itemId: ITEMS.tSeries, mediaType: 'tv', userIds: [BOB], groupIds: [] } },
      ],
    }),
    'a public title outside household A\'s libraries': world({
      media: { [T_MOVIE]: mediaInfo(T_MOVIE, 5, { requests: [] }), [T_TV]: mediaInfo(T_TV, 5, { requests: [] }) },
      items: tItems({ Tags: [], library: 'mill-only' }),
      episodes: tEpisodes,
    }),
    // Codex's measurement: +1 MB of Seerr records slowed A's answers, +4.3 MB made them fail. Seerr is not on the
    // catalogue path, so neither can matter now; Bob's own request history is long too.
    'large Seerr records of other households\' requests': world({
      media: { [T_MOVIE]: largeMediaInfo(T_MOVIE, 5), [T_TV]: largeMediaInfo(T_TV, 5) },
      requests: {
        [SEERR_IDS[BOB]]: [
          seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: 1 }),
          ...Array.from({ length: 2000 }, (_, index) => seerrRequest({ type: 'movie', tmdbId: 800000 + index, status: 2 })),
        ],
      },
    }),
  };
}

/**
 * Starts a fake Seerr serving `state` (see {@link world}); `calls` records every call, `violations` misuse. Set
 * `onRequest` to check each POST /api/v1/request as it arrives: what it returns, if anything, is a violation.
 */
export async function createFakeSeerr(state) {
  const calls = [];
  const violations = [];
  // Every POST /api/v1/request that reached Seerr, with its acting user and body.
  const posts = [];
  let onRequest;
  let nextRequestId = 7350001;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const actingUser = request.headers['x-api-user'];
    calls.push({ method: request.method, path: `${url.pathname}${url.search}`, pathname: url.pathname, actingUser });
    if (request.headers['x-api-key'] !== 'seerr-key') return send(response, 401, { message: 'canary unauthorized' });
    if (actingUser === undefined) return admin(url, response);
    const acting = Number(actingUser);
    const user = state.seerrUsers[acting];
    if (!/^[1-9][0-9]*$/.test(actingUser) || !user) return send(response, 403, { message: 'canary forbidden' });
    if (request.method === 'POST' && url.pathname === '/api/v1/request') return createRequest(request, response, acting, user);
    if (request.method !== 'GET') {
      violations.push(`${request.method} ${url.pathname}`);
      return send(response, 405, { message: 'canary' });
    }
    const quota = /^\/api\/v1\/user\/([0-9]+)\/quota$/.exec(url.pathname);
    if (quota) {
      if (Number(quota[1]) !== acting) {
        violations.push(`${acting} read ${url.pathname}`);
        return send(response, 403, { message: 'canary' });
      }
      if (state.quotaFails) return send(response, 500, { message: 'canary failure' });
      if (state.holdQuota) return state.holdQuota.then(() => send(response, 200, { movie: quotaOf(acting, 'movie'), tv: quotaOf(acting, 'tv') }));
      return send(response, 200, { movie: quotaOf(acting, 'movie'), tv: quotaOf(acting, 'tv') });
    }
    if (url.pathname === '/api/v1/auth/me') {
      return send(response, 200, { ...seerrFixture('requests').results[0].requestedBy, id: acting, permissions: user.permissions, jellyfinUserId: user.jellyfinUserId });
    }
    const own = /^\/api\/v1\/user\/([0-9]+)\/requests$/.exec(url.pathname);
    if (own) {
      if (Number(own[1]) !== acting) {
        violations.push(`${acting} read ${url.pathname}`);
        return send(response, 403, { message: 'canary' });
      }
      const take = Number(url.searchParams.get('take'));
      const skip = Number(url.searchParams.get('skip'));
      const mine = state.requests[acting] ?? [];
      return send(response, 200, { pageInfo: { pages: 7300901, pageSize: take, results: 7300902, page: 7300903 }, results: mine.slice(skip, skip + take) });
    }
    // Titles never come from Seerr: its title answers carry every household's media records and requests.
    violations.push(`${acting} read ${url.pathname}`);
    return send(response, 403, { message: 'canary' });
  });

  /** Every request Seerr holds, with its requester's Jellyfin ID. */
  function allRequests() {
    return Object.entries(state.requests).flatMap(([seerrId, requests]) => requests.map((entry) => ({
      ...entry,
      requestedBy: { ...entry.requestedBy, id: Number(seerrId), jellyfinUserId: state.seerrUsers[seerrId]?.jellyfinUserId ?? entry.requestedBy?.jellyfinUserId },
    })));
  }

  /** Seerr's media record for a title: the world's `media` entry, with every request Seerr holds for it. */
  function mediaRecord(mediaType, tmdbId) {
    const info = state.media[tmdbId] && (state.media[tmdbId].mediaType ?? mediaType) === mediaType ? state.media[tmdbId] : undefined;
    const requests = allRequests().filter((entry) => entry.type === mediaType && entry.media?.tmdbId === tmdbId);
    if (!info && requests.length === 0) return undefined;
    return { ...(info ?? { id: 7360000 + (tmdbId % 10000), mediaType, tmdbId, status: 2 }), requests: [...(info?.requests ?? []), ...requests] };
  }

  /**
   * Seerr 3.5.1's quota for a user: requests not declined, made within the window (every request ever made when `days`
   * is 0 or unset); one unit per movie or season.
   */
  function quotaOf(acting, mediaType) {
    const limits = state.quotas[acting]?.[mediaType];
    if (!limits?.limit) return { days: limits?.days ?? 0, limit: 0, used: 0, restricted: false };
    const since = limits.days ? Date.now() - limits.days * 24 * 60 * 60 * 1000 : -Infinity;
    const used = (state.requests[acting] ?? []).filter((entry) => entry.type === mediaType && entry.status !== 3 && Date.parse(entry.createdAt) > since)
      .reduce((sum, entry) => sum + (mediaType === 'movie' ? 1 : entry.seasons.length), 0);
    return { days: limits.days, limit: limits.limit, used, remaining: Math.max(0, limits.limit - used), restricted: limits.limit - used <= 0 };
  }

  /** POST /api/v1/request as `acting`, refused and charged as Seerr 3.5.1 does. */
  async function createRequest(request, response, acting, user) {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    posts.push({ actingUser: acting, body });
    const violation = onRequest?.(body);
    if (violation) violations.push(violation);
    if (Object.keys(body).some((key) => !['mediaType', 'mediaId', 'seasons', 'is4k'].includes(key)) || body.is4k !== false) {
      violations.push(`request with ${JSON.stringify(body)}`);
    }
    if (state.holdRequests) await state.holdRequests;
    const { mediaType, mediaId: tmdbId } = body;
    const permitted = (user.permissions & (ADMIN | REQUEST)) || (user.permissions & (mediaType === 'movie' ? REQUEST_MOVIE : REQUEST_TV));
    if (!permitted) return send(response, 403, { message: 'canary permission' });
    if (state.blocklist.some((entry) => entry.mediaType === mediaType && entry.tmdbId === tmdbId)) return send(response, 403, { message: 'canary blocklisted' });
    const existing = (mediaRecord(mediaType, tmdbId)?.requests ?? []).filter((entry) => !entry.is4k && entry.status !== 3);
    let seasons = [];
    if (mediaType === 'movie') {
      if (existing.length > 0) return send(response, 409, { message: 'canary duplicate' });
    } else {
      const taken = new Set(existing.flatMap((entry) => entry.seasons.map((season) => season.seasonNumber)));
      seasons = body.seasons.filter((season) => !taken.has(season));
      if (seasons.length === 0) return send(response, 202, { message: 'canary no seasons' });
    }
    const quota = quotaOf(acting, mediaType);
    if (quota.limit && quota.used + (mediaType === 'movie' ? 1 : seasons.length) > quota.limit) return send(response, 403, { message: 'canary quota' });
    const media = mediaRecord(mediaType, tmdbId);
    const created = {
      id: nextRequestId++,
      status: state.autoApprove ? 2 : 1,
      type: mediaType,
      is4k: false,
      createdAt: new Date().toISOString(),
      media: { id: media?.id ?? 7360000 + (tmdbId % 10000), mediaType, tmdbId, status: 2 },
      seasons: seasons.map((seasonNumber) => ({ id: 7370000 + seasonNumber, seasonNumber, status: 1 })),
      requestedBy: { id: acting, jellyfinUserId: user.jellyfinUserId, email: 'canary-new@example.invalid' },
    };
    state.requests[acting] = [...(state.requests[acting] ?? []), created];
    // Made, and counted by the quota from now on, before the answer leaves.
    if (state.holdCreated) await state.holdCreated;
    // Seerr made it, but its answer fails.
    if (state.failCreated) return send(response, 500, { message: 'canary failure' });
    return send(response, 201, created);
  }

  function admin(url, response) {
    const title = /^\/api\/v1\/(movie|tv)\/([0-9]+)$/.exec(url.pathname);
    if (title) {
      if (state.titlesFail) return send(response, 500, { message: 'canary failure' });
      const answer = () => send(response, 200, { ...seerrFixture(title[1]), id: Number(title[2]), mediaInfo: mediaRecord(title[1], Number(title[2])) });
      return state.holdTitles ? state.holdTitles.then(answer) : answer();
    }
    // The request backfill's list: every request, newest first.
    if (url.pathname === '/api/v1/request') {
      const results = allRequests().sort((left, right) => right.id - left.id);
      return send(response, 200, { pageInfo: { results: results.length }, results });
    }
    const byRequest = /^\/api\/v1\/request\/([0-9]+)$/.exec(url.pathname);
    if (byRequest) {
      const found = [...allRequests(), ...Object.values(state.media).flatMap((info) => info?.requests ?? [])].find((entry) => entry.id === Number(byRequest[1]));
      return found ? send(response, 200, found) : send(response, 404, { message: 'canary' });
    }
    const byJellyfin = /^\/api\/v1\/user\/jellyfin\/([0-9a-f]{32})$/.exec(url.pathname);
    if (byJellyfin) {
      const found = Object.entries(state.seerrUsers).find(([, user]) => user.jellyfinUserId === byJellyfin[1]);
      return found ? send(response, 200, { id: Number(found[0]), jellyfinUserId: found[1].jellyfinUserId, email: 'canary@example.invalid' })
        : send(response, 404, { message: 'canary' });
    }
    const byId = /^\/api\/v1\/user\/([0-9]+)$/.exec(url.pathname);
    if (byId) {
      const user = state.seerrUsers[Number(byId[1])];
      return user ? send(response, 200, { id: Number(byId[1]), permissions: user.permissions, jellyfinUserId: user.jellyfinUserId, email: 'canary@example.invalid' })
        : send(response, 404, { message: 'canary' });
    }
    if (url.pathname === '/api/v1/blocklist') {
      const take = Number(url.searchParams.get('take'));
      const skip = Number(url.searchParams.get('skip'));
      const entries = state.blocklist.map(({ mediaType, tmdbId }, index) => ({
        id: 7300800 + index,
        mediaType,
        title: 'canary blocklisted title',
        tmdbId,
        blocklistedTags: null,
        createdAt: '2001-01-01T00:00:00.000Z',
        user: seerrFixture('requests').results.find((request) => request.modifiedBy).modifiedBy,
      }));
      return send(response, 200, { pageInfo: { pages: 7300901, pageSize: take, results: 7300902, page: 7300903 }, results: entries.slice(skip, skip + take) });
    }
    violations.push(`admin GET ${url.pathname}`);
    return send(response, 404, { message: 'canary' });
  }

  await listen(server);
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    calls,
    violations,
    posts,
    state,
    set onRequest(check) { onRequest = check; },
    close: () => close(server),
  };
}

/** The violation the fake Seerr records for a request sent before an intent for its title was in the state file. */
export const UNSAVED_INTENT = 'request sent before its intent was in the state file';

/**
 * The invariant every app test runs under (see startApp): when a request reaches Seerr, the state file on disk already
 * holds a "Get this" intent for its title, so the decision that protects its grant survives a crash.
 */
function intentOnDisk(stateFile) {
  return (body) => {
    let intents;
    try {
      intents = Object.values(JSON.parse(readFileSync(stateFile, 'utf8')).appRequestIntents ?? {});
    } catch {
      intents = [];
    }
    return intents.some((intent) => intent.mediaType === body.mediaType && intent.tmdbId === body.mediaId) ? undefined : UNSAVED_INTENT;
  };
}

/**
 * Starts a fake TMDB serving the TMDB fixtures. It refuses any call without JellyPass's key (as `api_key`) and records
 * every call in `calls` (with the time it arrived, `at`, from `performance.now()`), and every `429` it answers in
 * `limited`. `state.failCatalogue`, `state.tmdbQuota` and `state.tmdbRateLimited` make title calls fail; with
 * `state.tmdbHang`, title calls are held open and `hung` counts those open now, the most open at once, and those
 * JellyPass closed.
 */
export async function createFakeTmdb(state) {
  const calls = [];
  const limited = [];
  const hung = { open: 0, maxOpen: 0, closed: 0 };
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const at = performance.now();
    calls.push({ method: request.method, path: `${url.pathname}${url.search}`, pathname: url.pathname, query: url.searchParams, headers: request.headers, at });
    if (url.searchParams.get('api_key') !== TMDB_KEY) return send(response, 401, { status_code: 7, status_message: 'canary invalid key' });
    if (url.pathname === '/3/authentication') return send(response, 200, { success: true, status_code: 1, status_message: 'Success.' });
    const tooMany = (retryAfter) => {
      limited.push({ path: `${url.pathname}${url.search}`, at });
      return send(response, 429, { status_code: 25, status_message: 'canary rate limited' }, { 'Retry-After': String(retryAfter) });
    };
    if (state.tmdbRateLimited > 0) {
      state.tmdbRateLimited -= 1;
      return tooMany(state.tmdbRetryAfter ?? 1);
    }
    if (state.tmdbQuota) {
      const recent = calls.filter((call) => call.pathname !== '/3/authentication' && call.at > at - state.tmdbQuota.windowMs);
      if (recent.length > state.tmdbQuota.calls) return tooMany(1);
    }
    if (state.tmdbHang) {
      hung.open += 1;
      hung.maxOpen = Math.max(hung.maxOpen, hung.open);
      response.on('close', () => {
        hung.open -= 1;
        hung.closed += 1;
      });
      return undefined;
    }
    if (state.failCatalogue === 429) return tooMany(0);
    if (state.failCatalogue) return send(response, state.failCatalogue, { status_code: 7300999, status_message: 'canary upstream failure' });
    const page = Number(url.searchParams.get('page'));
    const list = (results) => send(response, 200, { page, results, total_pages: 7300911, total_results: 7300912 });
    if (url.pathname === '/3/search/multi' || url.pathname === '/3/trending/all/day') return list(searchResults());
    if (url.pathname === '/3/discover/movie' || url.pathname === '/3/discover/tv') {
      const type = url.pathname.endsWith('movie') ? 'movie' : 'tv';
      const paged = state.tmdbDiscover?.(type, page);
      if (paged) return list(paged);
      // TMDB's discover results carry no media_type.
      return list(searchResults().filter((entry) => entry.media_type === type).map(({ media_type: _, ...entry }) => entry));
    }
    const trendingOne = /^\/3\/trending\/(movie|tv)\/day$/.exec(url.pathname);
    // TMDB's per-kind trending lists carry media_type, as the mixed one does.
    if (trendingOne) return list(searchResults().filter((entry) => entry.media_type === trendingOne[1]));
    const topRated = /^\/3\/(movie|tv)\/top_rated$/.exec(url.pathname);
    if (topRated) return list(searchResults().filter((entry) => entry.media_type === topRated[1]).map(({ media_type: _, ...entry }) => entry));
    const movie = /^\/3\/movie\/([0-9]+)$/.exec(url.pathname);
    if (movie) {
      const tmdbId = Number(movie[1]);
      const listed = searchResults().find((entry) => entry.id === tmdbId && entry.media_type === 'movie');
      if (!listed) return send(response, 404, { status_code: 34, status_message: 'canary not found' });
      return send(response, 200, { ...tmdbFixture('movie'), id: tmdbId, title: listed.title, release_date: listed.release_date, poster_path: listed.poster_path });
    }
    const tv = /^\/3\/tv\/([0-9]+)$/.exec(url.pathname);
    if (tv) {
      if (Number(tv[1]) !== T_TV) return send(response, 404, { status_code: 34, status_message: 'canary not found' });
      return send(response, 200, tmdbFixture('tv'));
    }
    const season = /^\/3\/tv\/([0-9]+)\/season\/([0-9]+)$/.exec(url.pathname);
    if (season) {
      const seasonNumber = Number(season[2]);
      if (Number(season[1]) !== T_TV || ![1, 2].includes(seasonNumber)) return send(response, 404, { status_code: 34, status_message: 'canary not found' });
      return send(response, 200, { ...tmdbFixture('season'), season_number: seasonNumber, name: `Season ${seasonNumber}` });
    }
    return send(response, 404, { status_code: 34, status_message: 'canary unknown route' });
  });

  function searchResults() {
    const fixture = tmdbFixture('search').results;
    const extra = Array.from({ length: state.extraResults ?? 0 }, (_, index) =>
      ({ ...fixture[2], id: 910000 + index, title: `Synthetic Extra ${index}`, poster_path: `/synthetic-poster-${910000 + index}.jpg` }));
    const movies = Object.entries(state.tmdbMovies ?? {}).map(([id, movie]) =>
      ({ ...fixture[2], id: Number(id), poster_path: `/synthetic-poster-${id}.jpg`, ...movie }));
    return [...fixture, ...extra, ...movies];
  }

  await listen(server);
  return { url: `http://127.0.0.1:${server.address().port}`, calls, limited, hung, state, close: () => close(server) };
}

/**
 * Starts a fake Jellyfin serving `state`'s users and items. It answers GET /Users/Me for a user token, and item queries
 * only with what that user may see: an item is hidden by a blocked tag, a library the user is not given, or a parental
 * rating above the user's limit, as Jellyfin does. `requests` records every call.
 */
export async function createFakeJellyfinForApp(state) {
  const requests = [];
  const minted_ = [];
  const attempts_ = [];
  const logouts = [];
  let down = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push({ method: request.method, path: `${url.pathname}${url.search}`, pathname: url.pathname });
    if (down) return send(response, 503, { message: 'down' });
    if (url.pathname === '/Users/Public' && request.method === 'GET') {
      // Like Jellyfin, every user but hidden and disabled ones: the household gateway is what narrows this to a household.
      return send(response, 200, Object.entries(state.jellyfinUsers).filter(([, user]) => !user.Policy.IsHidden && !user.Policy.IsDisabled).map(([Id, user]) => ({
        // Jellyfin says so even for an empty password: JellyPass's passwordless marking is what turns it off.
        Id, Name: user.Name, HasPassword: true, HasConfiguredPassword: true,
      })));
    }
    if (url.pathname === '/Users/AuthenticateByName' && request.method === 'POST') {
      return readJson(request).then((body) => {
        const header = request.headers.authorization ?? '';
        // Jellyfin 10.11 refuses a sign-in whose Authorization names no client, device, device ID and version.
        if (!/^MediaBrowser /.test(header) || !['Client', 'Device', 'DeviceId', 'Version'].every((name) => new RegExp(`${name}="[^"]+"`).test(header))) {
          return send(response, 400, { error: 'request.App is required' });
        }
        attempts_.push({ username: body.Username, password: body.Pw, header });
        const entry = Object.entries(state.jellyfinUsers).find(([, user]) => user.Name.toLowerCase() === String(body.Username).toLowerCase());
        if (state.signInDown) return send(response, 503, { message: 'upstream detail that must never be shown' });
        // Any other answer Jellyfin might give a member's sign-in, or none at all.
        if (state.signInStatus) return send(response, state.signInStatus, { message: 'upstream detail that must never be shown' });
        if (state.signInHangs) return undefined;
        if (!entry || entry[1].Policy.IsDisabled || (state.passwords?.[entry[0]] ?? '') !== body.Pw) return send(response, 401, { message: 'upstream detail that must never be shown' });
        const minted = `signin-token-${entry[0].slice(0, 4)}-${minted_.length + 1}`;
        minted_.push({ token: minted, userId: entry[0], header });
        return send(response, 200, { User: { Id: entry[0], Name: entry[1].Name }, AccessToken: minted, ServerId: 'server' });
      });
    }
    // As ASP.NET Core routes it: percent-decoded, in any case, with any trailing slashes.
    if (routePath(url.pathname) === '/sessions/logout' && request.method === 'POST') {
      // Jellyfin signs out the first of the request's tokens it knows. `state.holdLogout`, when set, holds it (before
      // it is revoked) until the promise it returns settles, and is passed the request so a test can break it.
      // `state.revokeLate`, when set, answers first and revokes only once the promise it returns settles.
      const signOut = async () => {
        const session = tokensOf(request, url).map((token) => minted_.find((entry) => entry.token === token && !entry.revoked)).find(Boolean);
        if (!session) return send(response, 401, {});
        const revoke = () => {
          session.revoked = true;
          logouts.push(session.token);
        };
        if (!state.revokeLate) {
          revoke();
          return send(response, 204, undefined);
        }
        const late = state.revokeLate();
        send(response, 204, undefined);
        await late;
        revoke();
      };
      return state.holdLogout ? state.holdLogout(request, response).then(signOut) : signOut();
    }
    const token = authorizationToken(request.headers.authorization ?? '') ?? request.headers['x-emby-token'] ?? url.searchParams.get('api_key');
    // JellyPass's own API key: users and every item, as an administrator sees them, and the updates reconciliation makes.
    if (token === 'jellyfin-key') return administer(request, response, url);
    const userId = minted_.find((entry) => entry.token === token && !entry.revoked)?.userId
      ?? Object.entries(state.tokens ?? TOKENS).find(([, value]) => value === token)?.[0];
    const user = userId && state.jellyfinUsers[userId];
    if (!user) return send(response, 401, {});
    if (url.pathname === '/Users/Me') {
      const me = { Id: userId, Name: user.Name, Policy: user.Policy, ServerId: 'server' };
      // `state.holdMe`, when set, holds the answer (decided now) until the promise it returns settles.
      return state.holdMe ? state.holdMe().then(() => send(response, 200, me)) : send(response, 200, me);
    }
    const parameter = (name) => [...url.searchParams].find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    if (parameter('userId') !== userId) return send(response, 403, {});
    if (url.pathname === '/Items') {
      const types = (parameter('includeItemTypes') ?? '').split(',');
      const visible = state.items.filter((item) => types.includes(item.Type) && sees(user, item) && (parameter('hasTmdbId') !== 'true' || item.ProviderIds?.Tmdb));
      const start = Number(parameter('startIndex') ?? 0);
      const limit = Number(parameter('limit') ?? 100);
      return send(response, 200, {
        Items: visible.slice(start, start + limit).map((item) => ({ Id: item.Id, Name: item.Name, Type: item.Type, ProviderIds: item.ProviderIds })),
        TotalRecordCount: visible.length,
      });
    }
    const episodes = /^\/Shows\/([0-9a-f]{32})\/Episodes$/.exec(url.pathname);
    if (episodes) {
      const series = state.items.find((item) => item.Id === episodes[1]);
      if (!series || !sees(user, series)) return send(response, 404, {});
      return send(response, 200, {
        Items: state.episodes.filter((episode) => episode.SeriesId === series.Id && sees(user, episode))
          .map((episode) => ({ Id: episode.Id, Type: 'Episode', ParentIndexNumber: episode.ParentIndexNumber })),
      });
    }
    return send(response, 404, {});
  });
  async function administer(request, response, url) {
    const parameter = (name) => [...url.searchParams].find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
    const itemOf = (item) => ({ Id: item.Id, Name: item.Name, Type: item.Type, ProviderIds: item.ProviderIds, ProductionYear: item.ProductionYear, Tags: item.Tags ?? [] });
    if (request.method === 'GET' && url.pathname === '/Users') {
      return send(response, 200, Object.entries(state.jellyfinUsers).map(([Id, user]) => ({ Id, Name: user.Name, Policy: user.Policy })));
    }
    if (request.method === 'GET' && url.pathname === '/Items' && !parameter('userId')) {
      const types = (parameter('includeItemTypes') ?? '').split(',');
      const ids = parameter('ids')?.split(',');
      const term = parameter('searchTerm')?.toLowerCase();
      const all = state.items.filter((item) => types.includes(item.Type) && (!ids || ids.includes(item.Id))
        && (parameter('hasTmdbId') !== 'true' || item.ProviderIds?.Tmdb) && (!term || item.Name.toLowerCase().includes(term)));
      state.onAdminRead?.(url.pathname, url);
      const start = Number(parameter('startIndex') ?? 0);
      return send(response, 200, { Items: all.slice(start, start + Number(parameter('limit') ?? 100)).map(itemOf) });
    }
    const episodes = /^\/Shows\/([0-9a-f]{32})\/Episodes$/.exec(url.pathname);
    if (request.method === 'GET' && episodes) {
      const answer = state.episodes.filter((episode) => episode.SeriesId === episodes[1]);
      state.onAdminRead?.(url.pathname);
      return send(response, 200, { Items: answer.map((episode) => ({ Id: episode.Id, Type: 'Episode', ParentIndexNumber: episode.ParentIndexNumber })) });
    }
    const item = /^\/Users\/[0-9a-f]{32}\/Items\/([0-9a-f]{32})$/.exec(url.pathname);
    if (request.method === 'GET' && item) {
      const found = state.items.find((entry) => entry.Id === item[1]);
      return found ? send(response, 200, itemOf(found)) : send(response, 404, {});
    }
    if (request.method === 'GET' && /^\/Items\/[0-9a-f]{32}\/LocalTrailers$/.test(url.pathname)) return send(response, 200, []);
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    const update = /^\/Items\/([0-9a-f]{32})$/.exec(url.pathname);
    if (request.method === 'POST' && update) {
      const found = state.items.find((entry) => entry.Id === update[1]);
      if (!found) return send(response, 404, {});
      found.Tags = body.Tags;
      return send(response, 204);
    }
    const policy = /^\/Users\/([0-9a-f]{32})\/Policy$/.exec(url.pathname);
    if (request.method === 'POST' && policy && state.jellyfinUsers[policy[1]]) {
      state.jellyfinUsers[policy[1]].Policy = body;
      return send(response, 204);
    }
    return send(response, 404, {});
  }

  await listen(server);
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    /** Every sign-in this Jellyfin granted: token, user and the Authorization header it came with. */
    signIns: minted_,
    /** Every sign-in Jellyfin was asked for, granted or not: the name and password it was sent, and the Authorization header. */
    signInAttempts: attempts_,
    /** The tokens signed out at Jellyfin. */
    logouts,
    state,
    set down(value) { down = value; },
    close: () => close(server),
  };
}

/**
 * The `Token` of a `MediaBrowser ...` header as Jellyfin 10.11 reads it (AuthorizationContext.GetParts): commas inside
 * quotes are part of a value, the last `Token` given wins, and its value is URL-decoded with `+` as a space.
 */
function authorizationToken(header) {
  const match = /^(?:mediabrowser|emby) (.*)$/is.exec(header);
  if (!match) return undefined;
  const fields = [...match[1].matchAll(/\s*([^=,"]*?)\s*=\s*("[^"]*"|[^,]*)\s*(?:,|$)/g)];
  const value = fields.filter(([, key]) => key === 'Token').at(-1)?.[2].replace(/^"|"$/g, '');
  return value ? decodeURIComponent(value.replace(/\+/g, ' ')) : undefined;
}

function routePath(pathname) {
  return decodeURIComponent(pathname).toLowerCase().replace(/\/+$/, '');
}

/** Every token a request carries, as Jellyfin reads them: `Token` in either authorization header, `X-Emby-Token`, `X-MediaBrowser-Token`, and the token query parameters in any case. */
function tokensOf(request, url) {
  const tokens = [];
  for (const name of ['authorization', 'x-emby-authorization']) {
    const token = authorizationToken(request.headers[name] ?? '');
    if (token) tokens.push(token);
  }
  for (const name of ['x-emby-token', 'x-mediabrowser-token']) if (request.headers[name]) tokens.push(request.headers[name]);
  for (const [key, value] of url.searchParams) if (['api_key', 'apikey', 'access_token'].includes(key.toLowerCase())) tokens.push(value);
  return tokens;
}

function sees(user, item) {
  const blocked = (item.Tags ?? []).some((tag) => user.Policy.BlockedTags?.some((blockedTag) => blockedTag.toLowerCase() === tag.toLowerCase()));
  const library = !item.library || user.Policy.EnableAllFolders || user.Policy.EnabledFolders?.includes(item.library);
  const rating = user.Policy.MaxParentalRating === undefined || (item.ParentalRating ?? 0) <= user.Policy.MaxParentalRating;
  return !blocked && library && rating;
}

/**
 * Starts the whole app for `state`: fake TMDB, Seerr and Jellyfin and a JellyPass server with households A (Alice, Ann)
 * and B (Bob). Pass `app: false` to start JellyPass without the app API (and so without the household limit),
 * `seerr: { url, apiKey }` to use a real Seerr instead of the fake, `households` to replace the two households,
 * `stateFile` to start the store from that state, `trustedProxies` to trust `X-Forwarded-For` from them, `now`,
 * `libraryTtlMs`, `titleTtlMs` or `blocklistTtlMs` to set the app's clock and cache lifetimes, `catalogueLimits` to
 * set its share of TMDB calls (by default high enough that tests not about it never wait for one), `reconcile` to apply
 * the world's grants to Jellyfin first, `recordDelayMs` to delay "Get this" records (none by default),
 * `requests: false` to serve no "Get this", `loginFailureDelayMs` for the least time a refused household sign-in
 * takes (default 0, so tests not about it never wait), and `loginTimeoutMs` for how long a sign-in waits for Jellyfin.
 */
export async function startApp(t, state = world(), options = {}) {
  const seerr = options.seerr ? { ...options.seerr, close: async () => undefined } : await createFakeSeerr(state);
  const tmdb = await createFakeTmdb(state);
  const jellyfin = await createFakeJellyfinForApp(state);
  const stateFile = path.join(await makeTempDir(t, 'jfa-app-'), 'grants.json');
  if (options.stateFile) await writeFile(stateFile, JSON.stringify(options.stateFile));
  if (!options.seerr) seerr.onRequest = intentOnDisk(stateFile);
  const store = new GrantStore(stateFile, { limitHouseholds: options.app !== false });
  await store.load();
  for (const household of options.households ?? HOUSEHOLDS) await store.upsertGroup(household);
  for (const grant of state.grants ?? []) {
    if (grant.request) await store.grant(grant.request);
    if (grant.manual) await store.setManualAccess(grant.manual);
  }
  const admin = new SeerrClient(seerr.url, seerr.apiKey ?? 'seerr-key');
  const jellyfinClient = new JellyfinClient(jellyfin.url, 'jellyfin-key');
  const service = new AccessService(jellyfinClient, store, undefined, admin);
  // Grants applied to Jellyfin (tags and blocked tags), as a running JellyPass would have them.
  if (options.reconcile) await service.reconcileAll();
  // Background work, tracked so a test can wait for it to settle.
  const tasks = new BackgroundTasks();
  const running = new Set();
  const background = {
    run(task) {
      const started = tasks.run(task);
      if (started) {
        running.add(started);
        started.finally(() => running.delete(started));
      }
      return started;
    },
    stop: () => tasks.stop(),
    async settled() {
      while (running.size > 0) await Promise.all([...running]);
    },
  };
  const members = new SeerrUserMap(admin);
  const requests = new HouseholdRequests({
    store,
    jellyfin: jellyfinClient,
    seerr: admin,
    members,
    joins: service,
    background,
    record: (result) => service.recordGetThis(result),
    recordBranch: (branch) => service.recordGetThisBranch(branch),
    ...(options.now ? { now: options.now } : {}),
    recordDelayMs: options.recordDelayMs ?? 0,
  });
  const server = makeServer(service, { webhook: 'webhook-secret', admin: 'admin-secret' }, undefined, {
    background,
    ...(options.trustedProxies ? { trustedProxies: options.trustedProxies } : {}),
    householdGateway: { jellyfinUrl: jellyfin.url, domain: 'example.test', hostPrefix: 'jelly-', loginFailureDelayMs: options.loginFailureDelayMs ?? 0, ...(options.loginTimeoutMs ? { loginTimeoutMs: options.loginTimeoutMs } : {}), ...(options.signOutTimeoutMs ? { signOutTimeoutMs: options.signOutTimeoutMs } : {}) },
    ...(options.app === false ? {} : {
      householdApp: {
        catalogue: new TmdbClient(TMDB_KEY, { baseUrl: tmdb.url, ...(options.now ? { now: options.now } : {}) }),
        blocklist: admin,
        members,
        ...(options.requests === false ? {} : { requests }),
        ...(options.now ? { now: options.now } : {}),
        ...(options.libraryTtlMs !== undefined ? { libraryTtlMs: options.libraryTtlMs } : {}),
        ...(options.titleTtlMs !== undefined ? { titleTtlMs: options.titleTtlMs } : {}),
        ...(options.blocklistTtlMs !== undefined ? { blocklistTtlMs: options.blocklistTtlMs } : {}),
        catalogueLimits: options.catalogueLimits ?? { perSecond: 1000, burst: 1000 },
        ...(options.signOutLimits ? { signOutLimits: options.signOutLimits } : {}),
      },
    }),
  });
  await listen(server);
  t.after(async () => {
    server.closeAllConnections();
    await Promise.all([close(server), seerr.close(), tmdb.close(), jellyfin.close()]);
    // Checked for every test: a request sent before its intent was on disk fails it (see intentOnDisk).
    if (seerr.violations?.includes(UNSAVED_INTENT)) throw new Error(UNSAVED_INTENT);
  });
  const port = server.address().port;
  return {
    port,
    seerr,
    tmdb,
    jellyfin,
    store,
    /** The state file the store writes, to start another app from. */
    stateFile,
    members,
    service,
    requests,
    background,
    /** GET `pathname` on `host` as `user` (a Jellyfin ID, or null for no credentials, or a header object). */
    get: (pathname, { host = HOST_A, user = ALICE, headers } = {}) => get(port, pathname, {
      Host: host,
      ...(user ? { Authorization: authorization(user) } : {}),
      ...headers,
    }),
    /** POST `body` (a string or an object sent as JSON; undefined for none) to `pathname`, like {@link get}. */
    post: (pathname, body, { host = HOST_A, user = ALICE, headers } = {}) => get(port, pathname, {
      Host: host,
      ...(user ? { Authorization: authorization(user) } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    }, { method: 'POST', body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }),
    /** A Seerr MEDIA_AVAILABLE webhook for an HD request whose item Jellyfin now has. */
    webhook: (payload) => get(port, '/webhooks/seerr', {
      Host: 'jellypass.example.test',
      Authorization: 'Bearer webhook-secret',
      'Content-Type': 'application/json',
    }, { method: 'POST', body: JSON.stringify(payload) }),
  };
}

/** The raw answer: status, headers and body bytes. */
export function get(port, pathname, headers, { method = 'GET', body } = {}) {
  return call(port, pathname, { method, headers, body });
}

/** POST a JSON body. */
export function post(port, pathname, headers, body) {
  return call(port, pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function call(port, pathname, { method = 'GET', headers, body }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: pathname, method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          status: response.statusCode,
          headers: response.headers,
          rawHeaders: response.rawHeaders,
          body,
          text: body.toString('utf8'),
          json: () => JSON.parse(body.toString('utf8')),
        });
      });
    });
    request.once('error', reject);
    request.end(body);
  });
}

function readJson(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
  });
}

function send(response, status, value, headers = {}) {
  if (status === 204) return response.writeHead(204, headers).end();
  const encoded = value === undefined ? '' : JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded), ...headers });
  response.end(encoded);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}
