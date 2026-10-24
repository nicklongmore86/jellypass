// A household app under test: a fake Seerr and a fake Jellyfin (both real HTTP servers), and a JellyPass server whose
// household gateway serves the app API from them. Seerr answers are built from the canary-laden 3.5.1 fixtures.
import { request as httpRequest, createServer } from 'node:http';
import path from 'node:path';
import { AccessService } from '../../dist/access-service.js';
import { JellyfinClient } from '../../dist/jellyfin.js';
import { SeerrCatalogueClient, SeerrClient, seerrUserId } from '../../dist/seerr.js';
import { SeerrUserMap } from '../../dist/seerr-users.js';
import { makeServer } from '../../dist/server.js';
import { GrantStore } from '../../dist/store.js';
import { seerrFixture } from './seerr-fixtures.mjs';
import { makeTempDir } from './temp-dir.mjs';

// Jellyfin users (32 hex digits, none a canary). Alice and Ann are household A ("farmhouse"); Bob is household B.
export const ALICE = 'a11ce000a11ce000a11ce000a11ce000';
export const ANN = 'a2200000a2200000a2200000a2200000';
export const BOB = 'b0b00000b0b00000b0b00000b0b00000';
export const OUTSIDER = 'e0e00000e0e00000e0e00000e0e00000';
export const TOKENS = { [ALICE]: 'token-alice', [ANN]: 'token-ann', [BOB]: 'token-bob', [OUTSIDER]: 'token-outsider' };
export const HOST_A = 'jelly-farmhouse.example.test';
export const HOST_B = 'jelly-mill.example.test';
// Seerr users: each member's, and the catalogue user.
export const SEERR_IDS = { [ALICE]: 11, [ANN]: 12, [BOB]: 21, [OUTSIDER]: 31 };
export const CATALOGUE = 50;
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

/** A household's member, by Jellyfin ID, as `Authorization` for the app. */
export function authorization(userId) {
  return `MediaBrowser Client="JellyPass app test", Device="Test", DeviceId="app-test", Version="1.0.0", Token="${TOKENS[userId]}"`;
}

/**
 * The baseline world, in which nobody but household A holds or asks for anything. `options` change it:
 * - `media`: tmdbId → Seerr's `mediaInfo` for that title (undefined: Seerr has no record);
 * - `requests`: Seerr user → that user's own requests (Seerr request objects);
 * - `items`, `episodes`: extra Jellyfin items and episodes;
 * - `seerrUsers`: Seerr user → changes to its record (permissions, jellyfinUserId).
 */
export function world(options = {}) {
  return {
    media: { ...options.media },
    requests: { ...options.requests },
    items: [
      { Id: ITEMS.ownMovie, Name: 'Synthetic Movie Three', Type: 'Movie', ProviderIds: { Tmdb: String(OWN_MOVIE) }, Tags: [], library: 'shared' },
      ...(options.items ?? []),
    ],
    episodes: [...(options.episodes ?? [])],
    jellyfinUsers: {
      [ALICE]: { Name: 'Alice', Policy: { BlockedTags: ['jellypass-held-elsewhere'], EnabledFolders: ['shared'] } },
      [ANN]: { Name: 'Ann', Policy: { BlockedTags: ['jellypass-held-elsewhere'], EnabledFolders: ['shared'] } },
      [BOB]: { Name: 'Bob', Policy: { BlockedTags: [], EnableAllFolders: true } },
      [OUTSIDER]: { Name: 'Outsider', Policy: { BlockedTags: [], EnableAllFolders: true } },
      ...options.jellyfinUsers,
    },
    seerrUsers: {
      [SEERR_IDS[ALICE]]: { jellyfinUserId: ALICE, permissions: REQUEST },
      [SEERR_IDS[ANN]]: { jellyfinUserId: ANN, permissions: REQUEST },
      [SEERR_IDS[BOB]]: { jellyfinUserId: BOB, permissions: REQUEST },
      [SEERR_IDS[OUTSIDER]]: { jellyfinUserId: OUTSIDER, permissions: REQUEST },
      [CATALOGUE]: { jellyfinUserId: null, permissions: 0 },
      ...options.seerrUsers,
    },
    tokens: { ...TOKENS, ...options.tokens },
    grants: [...(options.grants ?? [])],
    failCatalogue: options.failCatalogue,
    extraResults: options.extraResults ?? 0,
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
  };
}

/** Starts a fake Seerr serving `state` (see {@link world}); `calls` records every call, `violations` misuse. */
export async function createFakeSeerr(state) {
  const calls = [];
  const violations = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    const actingUser = request.headers['x-api-user'];
    calls.push({ method: request.method, path: `${url.pathname}${url.search}`, pathname: url.pathname, actingUser });
    if (request.headers['x-api-key'] !== 'seerr-key') return send(response, 401, { message: 'canary unauthorized' });
    if (actingUser === undefined) return admin(url, response);
    const acting = Number(actingUser);
    const user = state.seerrUsers[acting];
    if (!/^[1-9][0-9]*$/.test(actingUser) || !user) return send(response, 403, { message: 'canary forbidden' });
    if (request.method !== 'GET') {
      violations.push(`${request.method} ${url.pathname}`);
      return send(response, 405, { message: 'canary' });
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
    if (acting !== CATALOGUE) {
      violations.push(`${acting} read ${url.pathname}`);
      return send(response, 403, { message: 'canary' });
    }
    if (state.failCatalogue) return send(response, state.failCatalogue, { message: 'canary upstream failure', stack: 'canary stack' });
    return catalogue(url, response);
  });

  function admin(url, response) {
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
    violations.push(`admin GET ${url.pathname}`);
    return send(response, 404, { message: 'canary' });
  }

  /** A title with the world's own `mediaInfo` for it (none when Seerr has no record of it). */
  function withMedia(title) {
    const result = { ...title };
    delete result.mediaInfo;
    if (Object.hasOwn(state.media, title.id)) result.mediaInfo = state.media[title.id];
    return result;
  }

  function searchResults() {
    const fixture = seerrFixture('search').results;
    const extra = Array.from({ length: state.extraResults }, (_, index) =>
      ({ ...fixture[2], id: 910000 + index, title: `Synthetic Extra ${index}`, posterPath: `/synthetic-poster-${910000 + index}.jpg` }));
    return [...fixture, ...extra].map((entry) => entry.mediaType === 'person' ? entry : withMedia(entry));
  }

  function catalogue(url, response) {
    const page = (results) => send(response, 200, { page: Number(url.searchParams.get('page')), totalPages: 7300911, totalResults: 7300912, results });
    if (url.pathname === '/api/v1/search') return page(searchResults());
    if (url.pathname === '/api/v1/discover/trending') return page(searchResults());
    if (url.pathname === '/api/v1/discover/movies' || url.pathname === '/api/v1/discover/movies/upcoming') {
      return page(searchResults().filter((entry) => entry.mediaType === 'movie'));
    }
    if (url.pathname === '/api/v1/discover/tv' || url.pathname === '/api/v1/discover/tv/upcoming') {
      return page(searchResults().filter((entry) => entry.mediaType === 'tv'));
    }
    const movie = /^\/api\/v1\/movie\/([0-9]+)$/.exec(url.pathname);
    if (movie) {
      const tmdbId = Number(movie[1]);
      const listed = seerrFixture('search').results.find((entry) => entry.id === tmdbId && entry.mediaType === 'movie');
      if (!listed) return send(response, 404, { message: 'canary not found' });
      return send(response, 200, withMedia({ ...seerrFixture('movie'), id: tmdbId, title: listed.title, posterPath: listed.posterPath }));
    }
    const tv = /^\/api\/v1\/tv\/([0-9]+)$/.exec(url.pathname);
    if (tv) {
      if (Number(tv[1]) !== T_TV) return send(response, 404, { message: 'canary not found' });
      return send(response, 200, withMedia(seerrFixture('tv')));
    }
    const season = /^\/api\/v1\/tv\/([0-9]+)\/season\/([0-9]+)$/.exec(url.pathname);
    if (season) {
      const seasonNumber = Number(season[2]);
      if (Number(season[1]) !== T_TV || ![1, 2].includes(seasonNumber)) return send(response, 404, { message: 'canary not found' });
      return send(response, 200, { ...seerrFixture('season'), seasonNumber, name: `Season ${seasonNumber}` });
    }
    violations.push(`catalogue GET ${url.pathname}`);
    return send(response, 404, { message: 'canary' });
  }

  await listen(server);
  return { url: `http://127.0.0.1:${server.address().port}`, calls, violations, state, close: () => close(server) };
}

/**
 * Starts a fake Jellyfin serving `state`'s users and items. It answers GET /Users/Me for a user token, and item queries
 * only with what that user may see: an item is hidden by a blocked tag, a library the user is not given, or a parental
 * rating above the user's limit, as Jellyfin does. `requests` records every call.
 */
export async function createFakeJellyfinForApp(state) {
  const requests = [];
  let down = false;
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    requests.push({ method: request.method, path: `${url.pathname}${url.search}`, pathname: url.pathname });
    if (down) return send(response, 503, { message: 'down' });
    const token = /Token="([^"]+)"/.exec(request.headers.authorization ?? '')?.[1] ?? request.headers['x-emby-token'] ?? url.searchParams.get('api_key');
    const userId = Object.entries(state.tokens ?? TOKENS).find(([, value]) => value === token)?.[0];
    const user = userId && state.jellyfinUsers[userId];
    if (!user) return send(response, 401, {});
    if (url.pathname === '/Users/Me') return send(response, 200, { Id: userId, Name: user.Name, Policy: user.Policy, ServerId: 'server' });
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
  await listen(server);
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    state,
    set down(value) { down = value; },
    close: () => close(server),
  };
}

function sees(user, item) {
  const blocked = (item.Tags ?? []).some((tag) => user.Policy.BlockedTags?.some((blockedTag) => blockedTag.toLowerCase() === tag.toLowerCase()));
  const library = !item.library || user.Policy.EnableAllFolders || user.Policy.EnabledFolders?.includes(item.library);
  const rating = user.Policy.MaxParentalRating === undefined || (item.ParentalRating ?? 0) <= user.Policy.MaxParentalRating;
  return !blocked && library && rating;
}

/**
 * Starts the whole app for `state`: fake Seerr and Jellyfin and a JellyPass server with households A (Alice, Ann) and B
 * (Bob). Pass `app: false` to start JellyPass without the app API, `seerr: { url, apiKey }` to use a real Seerr instead
 * of the fake (with its `catalogueUserId`), and `households` to replace the two households.
 */
export async function startApp(t, state = world(), options = {}) {
  const seerr = options.seerr ? { ...options.seerr, close: async () => undefined } : await createFakeSeerr(state);
  const jellyfin = await createFakeJellyfinForApp(state);
  const store = new GrantStore(path.join(await makeTempDir(t, 'jfa-app-'), 'grants.json'));
  await store.load();
  for (const household of options.households ?? [
    { id: 'farmhouse', name: 'Farmhouse', userIds: [ALICE, ANN] },
    { id: 'mill', name: 'Mill', userIds: [BOB] },
  ]) await store.upsertGroup(household);
  for (const grant of state.grants ?? []) {
    if (grant.request) await store.grant(grant.request);
    if (grant.manual) await store.setManualAccess(grant.manual);
  }
  const admin = new SeerrClient(seerr.url, seerr.apiKey ?? 'seerr-key');
  const service = new AccessService(new JellyfinClient(jellyfin.url, 'jellyfin-key'), store, undefined, admin);
  const server = makeServer(service, { webhook: 'webhook-secret', admin: 'admin-secret' }, undefined, {
    householdGateway: { jellyfinUrl: jellyfin.url, domain: 'example.test', hostPrefix: 'jelly-' },
    ...(options.app === false ? {} : {
      householdApp: {
        catalogue: new SeerrCatalogueClient(admin, seerrUserId(options.catalogueUserId ?? CATALOGUE)),
        members: new SeerrUserMap(admin),
        ...(options.now ? { now: options.now } : {}),
        ...(options.libraryTtlMs !== undefined ? { libraryTtlMs: options.libraryTtlMs } : {}),
      },
    }),
  });
  await listen(server);
  t.after(async () => {
    server.closeAllConnections();
    await Promise.all([close(server), seerr.close(), jellyfin.close()]);
  });
  const port = server.address().port;
  return {
    port,
    seerr,
    jellyfin,
    store,
    service,
    /** GET `pathname` on `host` as `user` (a Jellyfin ID, or null for no credentials, or a header object). */
    get: (pathname, { host = HOST_A, user = ALICE, headers } = {}) => get(port, pathname, {
      Host: host,
      ...(user ? { Authorization: authorization(user) } : {}),
      ...headers,
    }),
  };
}

/** The raw answer: status, headers and body bytes. */
export function get(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, path: pathname, headers }, (response) => {
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
    request.end();
  });
}

function send(response, status, value) {
  const encoded = JSON.stringify(value);
  response.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) });
  response.end(encoded);
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  server.closeAllConnections?.();
  return new Promise((resolve) => server.close(() => resolve()));
}
