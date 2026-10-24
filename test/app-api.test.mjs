import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { describe, it } from 'node:test';
import { assertNoCanaries } from './support/seerr-fixtures.mjs';
import {
  ALICE,
  ANN,
  BOB,
  CATALOGUE,
  HOST_A,
  HOST_B,
  ITEMS,
  OUTSIDER,
  OWN_MOVIE,
  REQUEST,
  REQUEST_MOVIE,
  SEERR_IDS,
  T_MOVIE,
  T_TV,
  mediaInfo,
  otherHouseholdWorlds,
  seerrRequest,
  startApp,
  world,
} from './support/household-app.mjs';

const APP = '/jellypass/app/v1';
/** Every endpoint, called once with valid arguments. */
const ENDPOINTS = [
  `${APP}/me`,
  `${APP}/search?q=synthetic`,
  `${APP}/search?q=synthetic&page=2`,
  `${APP}/discover/trending`,
  `${APP}/discover/popular-movies`,
  `${APP}/discover/popular-tv`,
  `${APP}/discover/upcoming?page=3`,
  `${APP}/movie/${T_MOVIE}`,
  `${APP}/movie/${OWN_MOVIE}`,
  `${APP}/tv/${T_TV}`,
  `${APP}/tv/${T_TV}/season/1`,
  `${APP}/tv/${T_TV}/season/2`,
];
const PLAY = (itemId) => ({ itemId, url: `https://${HOST_A}/web/#/details?id=${itemId}` });
const POSTER = (tmdbId) => `https://image.tmdb.org/t/p/w342/synthetic-poster-${tmdbId}.jpg`;
const BACKDROP = (tmdbId) => `https://image.tmdb.org/t/p/w780/synthetic-backdrop-${tmdbId}.jpg`;

/** Everything a household could see of an answer: status, every header and the body, as sent. */
function serialized(answer) {
  const headers = answer.rawHeaders.filter((_, index) => index % 2 === 0)
    .map((name, index) => `${name}: ${answer.rawHeaders[index * 2 + 1]}`)
    .filter((line) => !/^(date|connection|keep-alive):/i.test(line));
  return `${answer.status}\n${headers.join('\n')}\n\n${answer.text}`;
}

/** The household state of each card on a page, by TMDB ID. */
function states(page) {
  return Object.fromEntries(page.results.map((card) => [card.tmdbId, card.state]));
}

describe('household app API: answers', { timeout: 20_000 }, () => {
  it('answers /me with the caller\'s name and household only, without asking Seerr', async (t) => {
    const app = await startApp(t);
    const answer = await app.get(`${APP}/me`);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json(), { name: 'Alice', household: 'Farmhouse' });
    assert.equal(app.seerr.calls.length, 0);
  });

  it('shapes search results into allowlisted cards with the household state of each', async (t) => {
    const app = await startApp(t);
    const answer = await app.get(`${APP}/search?q=synthetic`);
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['cache-control'], 'no-store');
    assert.equal(answer.headers['content-type'], 'application/json; charset=utf-8');
    // People are not titles; Seerr's totals and paging are never relayed. Seerr returned 4 results, not a full page.
    assert.deepEqual(answer.json(), {
      page: 1,
      nextPage: null,
      results: [
        {
          mediaType: 'movie', tmdbId: T_MOVIE, title: 'Synthetic Movie One', year: 2020,
          overview: 'A synthetic film used only in tests.', posterUrl: POSTER(T_MOVIE), backdropUrl: BACKDROP(T_MOVIE),
          rating: 7.1, state: 'get_this', play: null,
        },
        {
          mediaType: 'tv', tmdbId: T_TV, title: 'Synthetic Series Two', year: 2019,
          overview: 'A synthetic series used only in tests.', posterUrl: POSTER(T_TV), backdropUrl: BACKDROP(T_TV),
          rating: 6.9, state: 'get_this', play: null,
        },
        {
          mediaType: 'movie', tmdbId: OWN_MOVIE, title: 'Synthetic Movie Three', year: 2024, overview: 'Not in Seerr yet.',
          posterUrl: POSTER(OWN_MOVIE), backdropUrl: null, rating: 5.5, state: 'in_library', play: PLAY(ITEMS.ownMovie),
        },
      ],
    });
  });

  it('shapes movie, series and season details from allowlisted fields', async (t) => {
    const app = await startApp(t);
    assert.deepEqual((await app.get(`${APP}/movie/${OWN_MOVIE}`)).json(), {
      mediaType: 'movie', tmdbId: OWN_MOVIE, title: 'Synthetic Movie Three', year: 2020,
      overview: 'A synthetic film used only in tests.', posterUrl: POSTER(OWN_MOVIE), backdropUrl: BACKDROP(T_MOVIE),
      rating: 7.1, genres: ['Action', 'Science Fiction'], runtime: 101, state: 'in_library', play: PLAY(ITEMS.ownMovie),
    });
    assert.deepEqual((await app.get(`${APP}/tv/${T_TV}`)).json(), {
      mediaType: 'tv', tmdbId: T_TV, title: 'Synthetic Series Two', year: 2019,
      overview: 'A synthetic series used only in tests.', posterUrl: POSTER(T_TV), backdropUrl: BACKDROP(T_TV),
      rating: 6.9, genres: ['Drama'], runtime: null,
      seasons: [
        { seasonNumber: 1, name: 'Season 1', episodeCount: 3, state: 'get_this' },
        { seasonNumber: 2, name: 'Season 2', episodeCount: 3, state: 'get_this' },
      ],
      state: 'get_this', play: null,
    });
    assert.deepEqual((await app.get(`${APP}/tv/${T_TV}/season/1`)).json(), {
      tmdbId: T_TV, seasonNumber: 1, name: 'Season 1', overview: '',
      episodes: [1, 2, 3].map((episodeNumber) => ({ episodeNumber, name: `Synthetic Episode ${episodeNumber}`, overview: '' })),
      state: 'get_this',
    });
  });

  it('pages discover lists from the results returned, never from Seerr\'s totals', async (t) => {
    const app = await startApp(t);
    for (const list of ['trending', 'popular-movies', 'popular-tv', 'upcoming']) {
      const page = (await app.get(`${APP}/discover/${list}?page=2`)).json();
      assert.equal(page.page, 2);
      assert.equal(page.nextPage, null, list);
    }
    assert.deepEqual(states((await app.get(`${APP}/discover/popular-movies`)).json()), { [T_MOVIE]: 'get_this', [OWN_MOVIE]: 'in_library' });
    assert.deepEqual(states((await app.get(`${APP}/discover/popular-tv`)).json()), { [T_TV]: 'get_this' });
  });

  it('offers the next page only after a full page of results, up to page 500', async (t) => {
    const app = await startApp(t, world({ extraResults: 20 }));
    const first = (await app.get(`${APP}/search?q=synthetic`)).json();
    assert.equal(first.results.length, 23);
    assert.equal(first.nextPage, 2);
    assert.equal((await app.get(`${APP}/discover/trending?page=499`)).json().nextPage, 500);
    assert.equal((await app.get(`${APP}/search?q=synthetic&page=500`)).json().nextPage, null);
    assert.equal((await app.get(`${APP}/search?q=synthetic&page=501`)).status, 400);
  });

  it('never lets a Seerr field reach an answer: every endpoint is canary-free, in every world', async (t) => {
    const worlds = { baseline: world(), ...otherHouseholdWorlds() };
    for (const [name, state] of Object.entries(worlds)) {
      const app = await startApp(t, state);
      for (const pathname of ENDPOINTS) {
        const answer = await app.get(pathname);
        assert.equal(answer.status, 200, `${name} ${pathname}`);
        assertNoCanaries(serialized(answer), `${name} ${pathname}`);
      }
    }
  });

  it('keeps error answers canary-free and fixed, whatever Seerr said', async (t) => {
    for (const status of [400, 403, 500, 503]) {
      const app = await startApp(t, world({ failCatalogue: status }));
      for (const pathname of ENDPOINTS.slice(1)) {
        const answer = await app.get(pathname);
        assert.equal(answer.status, 502, `${status} ${pathname}`);
        assert.equal(answer.text, '{"error":"unavailable"}');
        assertNoCanaries(serialized(answer));
      }
    }
  });
});

describe('household app API: household states', { timeout: 20_000 }, () => {
  it('is requested when a member of the caller\'s household has an active HD request', async (t) => {
    const app = await startApp(t, world({
      requests: {
        [SEERR_IDS[ANN]]: [seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: 2 }), seerrRequest({ type: 'tv', tmdbId: T_TV, status: 1, seasons: [2] })],
      },
    }));
    const answer = (await app.get(`${APP}/search?q=synthetic`)).json();
    assert.deepEqual(states(answer), { [T_MOVIE]: 'requested', [T_TV]: 'requested', [OWN_MOVIE]: 'in_library' });
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).json().state, 'requested');
    const series = (await app.get(`${APP}/tv/${T_TV}`)).json();
    assert.equal(series.state, 'requested');
    assert.deepEqual(series.seasons.map((season) => season.state), ['get_this', 'get_this']);
  });

  it('is in_library, not requested, once the caller can play a title their household asked for', async (t) => {
    const app = await startApp(t, world({ requests: { [SEERR_IDS[ANN]]: [seerrRequest({ type: 'movie', tmdbId: OWN_MOVIE, status: 2 })] } }));
    const movie = (await app.get(`${APP}/movie/${OWN_MOVIE}`)).json();
    assert.equal(movie.state, 'in_library');
    assert.deepEqual(movie.play, PLAY(ITEMS.ownMovie));
  });

  it('ignores declined, failed, completed and 4K requests, and other households\' requests', async (t) => {
    const app = await startApp(t, world({
      requests: {
        [SEERR_IDS[ALICE]]: [seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: 3 }), seerrRequest({ type: 'tv', tmdbId: T_TV, status: 4 })],
        [SEERR_IDS[ANN]]: [seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: 1, is4k: true }), seerrRequest({ type: 'tv', tmdbId: T_TV, status: 5 })],
        [SEERR_IDS[BOB]]: [seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: 1 })],
      },
    }));
    assert.deepEqual(states((await app.get(`${APP}/search?q=synthetic`)).json()), { [T_MOVIE]: 'get_this', [T_TV]: 'get_this', [OWN_MOVIE]: 'in_library' });
  });

  it('pages through each member\'s own requests', async (t) => {
    const filler = Array.from({ length: 150 }, (_, index) => seerrRequest({ type: 'movie', tmdbId: 800000 + index, status: 3 }));
    const app = await startApp(t, world({ requests: { [SEERR_IDS[ANN]]: [...filler, seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: 1 })] } }));
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).json().state, 'requested');
    assert.deepEqual(app.seerr.calls.filter((call) => call.actingUser === String(SEERR_IDS[ANN])).map((call) => call.path), [
      '/api/v1/user/12/requests?take=100&skip=0',
      '/api/v1/user/12/requests?take=100&skip=100',
    ]);
  });

  it('is unavailable for everything when the caller may not request, or Seerr has no user for them', async (t) => {
    for (const changes of [{ [SEERR_IDS[ALICE]]: { jellyfinUserId: ALICE, permissions: 0 } }, { [SEERR_IDS[ALICE]]: { jellyfinUserId: 'f'.repeat(32), permissions: REQUEST } }]) {
      const app = await startApp(t, world({
        seerrUsers: changes,
        requests: { [SEERR_IDS[ANN]]: [seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: 1 })] },
      }));
      const page = (await app.get(`${APP}/search?q=synthetic`)).json();
      assert.deepEqual(states(page), { [T_MOVIE]: 'unavailable', [T_TV]: 'unavailable', [OWN_MOVIE]: 'unavailable' });
      assert.ok(page.results.every((card) => card.play === null));
      const series = (await app.get(`${APP}/tv/${T_TV}`)).json();
      assert.deepEqual(series.seasons.map((season) => season.state), ['unavailable', 'unavailable']);
      assert.equal((await app.get(`${APP}/tv/${T_TV}/season/1`)).json().state, 'unavailable');
    }
  });

  it('decides request permission per media type', async (t) => {
    const app = await startApp(t, world({ seerrUsers: { [SEERR_IDS[ALICE]]: { jellyfinUserId: ALICE, permissions: REQUEST_MOVIE } } }));
    assert.deepEqual(states((await app.get(`${APP}/search?q=synthetic`)).json()), { [T_MOVIE]: 'get_this', [T_TV]: 'unavailable', [OWN_MOVIE]: 'in_library' });
  });

  it('is unavailable for a blocklisted title, before anything else', async (t) => {
    const app = await startApp(t, world({
      media: { [OWN_MOVIE]: { status: 6 }, [T_MOVIE]: mediaInfo(T_MOVIE, 6) },
      requests: { [SEERR_IDS[ANN]]: [seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: 1 })] },
    }));
    const page = (await app.get(`${APP}/search?q=synthetic`)).json();
    assert.deepEqual(states(page), { [T_MOVIE]: 'unavailable', [T_TV]: 'get_this', [OWN_MOVIE]: 'unavailable' });
    assert.equal((await app.get(`${APP}/movie/${OWN_MOVIE}`)).json().play, null);
  });

  it('is in_library only for what the caller\'s own Jellyfin view holds: blocked tags, libraries and parental limits apply', async (t) => {
    const hidden = (id, tmdbId, extra) => ({ Id: id, Name: 'Hidden', Type: 'Movie', ProviderIds: { Tmdb: String(tmdbId) }, Tags: [], library: 'shared', ...extra });
    const app = await startApp(t, world({
      items: [
        hidden('55550000555500005555000055550000', T_MOVIE, { ParentalRating: 18 }),
        hidden('66660000666600006666000066660000', 900004, { Tags: ['JellyPass-Held-Elsewhere'] }),
        hidden('77770000777700007777000077770000', 900005, { library: 'mill-only' }),
      ],
      jellyfinUsers: { [ALICE]: { Name: 'Alice', Policy: { BlockedTags: ['jellypass-held-elsewhere'], EnabledFolders: ['shared'], MaxParentalRating: 12 } } },
    }));
    const page = (await app.get(`${APP}/search?q=synthetic`)).json();
    assert.deepEqual(states(page), { [T_MOVIE]: 'get_this', [T_TV]: 'get_this', [OWN_MOVIE]: 'in_library' });
    // Every Jellyfin read for the app used Alice's own user, and asked for her view, not an administrator's.
    const reads = app.jellyfin.requests.filter((request) => request.pathname !== '/Users/Me');
    assert.ok(reads.length > 0);
    assert.ok(reads.every((request) => new URL(request.path, 'http://x').searchParams.get('userId') === ALICE), JSON.stringify(reads));
    // Ann has no parental limit, so the same title is in her library.
    const ann = (await app.get(`${APP}/search?q=synthetic`, { user: ANN })).json();
    assert.deepEqual(ann.results.find((card) => card.tmdbId === T_MOVIE).play, PLAY('55550000555500005555000055550000'));
  });

  it('reports each season in_library only when the caller\'s view has its episodes', async (t) => {
    const app = await startApp(t, world({
      items: [{ Id: ITEMS.tSeries, Name: 'Synthetic Series Two', Type: 'Series', ProviderIds: { Tmdb: String(T_TV) }, Tags: [], library: 'shared' }],
      episodes: [
        { Id: '88880000888800008888000088880001', SeriesId: ITEMS.tSeries, ParentIndexNumber: 1 },
        { Id: '88880000888800008888000088880002', SeriesId: ITEMS.tSeries, ParentIndexNumber: 2, Tags: ['jellypass-held-elsewhere'] },
      ],
    }));
    const series = (await app.get(`${APP}/tv/${T_TV}`)).json();
    assert.equal(series.state, 'in_library');
    assert.deepEqual(series.play, PLAY(ITEMS.tSeries));
    assert.deepEqual(series.seasons.map((season) => [season.seasonNumber, season.state]), [[1, 'in_library'], [2, 'get_this']]);
    assert.equal((await app.get(`${APP}/tv/${T_TV}/season/1`)).json().state, 'in_library');
    assert.equal((await app.get(`${APP}/tv/${T_TV}/season/2`)).json().state, 'get_this');
  });
});

describe('household app API: other households are invisible', { timeout: 60_000 }, () => {
  // Household A's answers in the baseline world (nobody else holds or asked for T) and in each world where household B
  // does, compared byte for byte: status, every header and body.
  for (const [name, other] of Object.entries(otherHouseholdWorlds())) {
    it(`gives household A identical answers whether or not household B holds T through ${name}`, async (t) => {
      const baseline = await startApp(t, world());
      const changed = await startApp(t, other);
      for (const pathname of ENDPOINTS) {
        for (const user of [ALICE, ANN]) {
          const expected = await baseline.get(pathname, { user });
          const actual = await changed.get(pathname, { user });
          assert.equal(expected.status, 200, pathname);
          assert.equal(serialized(actual), serialized(expected), `${user} ${pathname}`);
        }
      }
      // The worlds really differ: household B sees T.
      const bob = (await changed.get(`${APP}/movie/${T_MOVIE}`, { host: HOST_B, user: BOB })).json();
      assert.equal(bob.state, name.includes('pending') ? 'requested' : 'in_library');
    });
  }

  it('makes the same Seerr and Jellyfin calls for household A in every world', async (t) => {
    const trace = async (state) => {
      const app = await startApp(t, state);
      for (const pathname of ENDPOINTS) await app.get(pathname);
      return {
        seerr: app.seerr.calls.map((call) => `${call.actingUser ?? 'admin'} ${call.method} ${call.path}`).sort(),
        jellyfin: app.jellyfin.requests.map((request) => `${request.method} ${request.path}`).sort(),
      };
    };
    const expected = await trace(world());
    for (const [name, state] of Object.entries(otherHouseholdWorlds())) {
      assert.deepEqual(await trace(state), expected, name);
    }
  });
});

describe('household app API: identity', { timeout: 20_000 }, () => {
  it('reads titles only as the catalogue user and each member\'s data only as that member, each confirmed first', async (t) => {
    const app = await startApp(t, world({ requests: { [SEERR_IDS[ANN]]: [seerrRequest({ type: 'movie', tmdbId: T_MOVIE })] } }));
    for (const pathname of ENDPOINTS) assert.equal((await app.get(pathname)).status, 200, pathname);
    assert.deepEqual(app.seerr.violations, []);
    const household = new Set([String(SEERR_IDS[ALICE]), String(SEERR_IDS[ANN])]);
    const acting = app.seerr.calls.filter((call) => call.actingUser !== undefined);
    assert.ok(acting.length > 0);
    for (const call of app.seerr.calls) {
      if (call.actingUser === undefined) {
        // Admin calls are only user lookups and confirmations.
        assert.match(call.pathname, /^\/api\/v1\/user\/(?:jellyfin\/[0-9a-f]{32}|[0-9]+)$/);
        continue;
      }
      assert.equal(call.method, 'GET');
      // Never the owner, never a member of another household.
      assert.ok(call.actingUser === String(CATALOGUE) || household.has(call.actingUser), call.actingUser);
      if (call.actingUser === String(CATALOGUE)) {
        assert.match(call.pathname, /^\/api\/v1\/(?:search|discover\/[a-z/]+|movie\/[0-9]+|tv\/[0-9]+(?:\/season\/[0-9]+)?)$/);
      } else {
        assert.match(call.pathname, new RegExp(`^/api/v1/(?:auth/me|user/${call.actingUser}/requests)$`));
        // Only the caller's own permissions are read; other members' requests are read as them.
        if (call.pathname === '/api/v1/auth/me') assert.equal(call.actingUser, String(SEERR_IDS[ALICE]));
      }
    }
    // Every call made as a Seerr user follows its own admin confirmation of that user: concurrent calls interleave, so
    // each is matched with a confirmation no earlier call used.
    const unused = new Map();
    for (const call of app.seerr.calls) {
      const confirmed = /^\/api\/v1\/user\/([0-9]+)$/.exec(call.pathname);
      if (call.actingUser === undefined && confirmed) unused.set(confirmed[1], (unused.get(confirmed[1]) ?? 0) + 1);
      if (call.actingUser === undefined) continue;
      assert.ok((unused.get(call.actingUser) ?? 0) > 0, `${call.actingUser} ${call.path} was not confirmed first`);
      unused.set(call.actingUser, unused.get(call.actingUser) - 1);
    }
    assert.ok(!app.seerr.calls.some((call) => call.actingUser === String(SEERR_IDS[BOB])));
  });

  it('fails when the catalogue user is no longer fit, rather than reading as anyone else', async (t) => {
    const app = await startApp(t, world({ seerrUsers: { [CATALOGUE]: { jellyfinUserId: null, permissions: REQUEST } } }));
    const answer = await app.get(`${APP}/search?q=synthetic`);
    assert.equal(answer.status, 502);
    assert.equal(answer.text, '{"error":"unavailable"}');
    assert.ok(!app.seerr.calls.some((call) => call.pathname === '/api/v1/search'));
  });
});

describe('household app API: sessions', { timeout: 20_000 }, () => {
  const UNAUTHORIZED = '{"error":"unauthorized"}';

  it('refuses a missing, invalid or disabled token and a caller from another household identically', async (t) => {
    const app = await startApp(t, world({ jellyfinUsers: { [ANN]: { Name: 'Ann', Policy: { IsDisabled: true, BlockedTags: [] } } } }));
    const refusals = [
      await app.get(`${APP}/me`, { user: null }),
      await app.get(`${APP}/me`, { user: null, headers: { Authorization: 'MediaBrowser Token="not-a-token"' } }),
      await app.get(`${APP}/me`, { user: ANN }),
      await app.get(`${APP}/me`, { user: BOB }),
      await app.get(`${APP}/me`, { user: OUTSIDER }),
      await app.get(`${APP}/search?q=synthetic`, { user: BOB }),
      await app.get(`${APP}/movie/${T_MOVIE}`, { host: HOST_B, user: ALICE }),
    ];
    for (const answer of refusals) {
      assert.equal(answer.status, 401);
      assert.equal(answer.text, UNAUTHORIZED);
      assert.equal(serialized(answer), serialized(refusals[0]));
    }
    // A request with no credentials never reaches Jellyfin, and Bob's verified token is reused for his second call; none
    // of these reached Seerr.
    assert.equal(app.jellyfin.requests.filter((request) => request.pathname === '/Users/Me').length, refusals.length - 2);
    assert.equal(app.seerr.calls.length, 0);
  });

  it('accepts the token as Jellyfin web sends it, as X-Emby-Token, or as a query parameter', async (t) => {
    const app = await startApp(t);
    for (const [pathname, headers] of [
      [`${APP}/me`, { Authorization: 'MediaBrowser Token="token-alice"' }],
      [`${APP}/me`, { 'X-Emby-Token': 'token-alice' }],
      [`${APP}/me?api_key=token-alice`, {}],
    ]) {
      const answer = await app.get(pathname, { user: null, headers });
      assert.deepEqual(answer.json(), { name: 'Alice', household: 'Farmhouse' }, JSON.stringify(headers));
    }
  });

  it('trusts a verified token for at most five minutes, and checks household membership on every call', async (t) => {
    let now = Date.parse('2026-10-24T12:00:00.000Z');
    const app = await startApp(t, world(), { now: () => now });
    const verifications = () => app.jellyfin.requests.filter((request) => request.pathname === '/Users/Me').length;
    assert.equal((await app.get(`${APP}/me`)).status, 200);
    now += 4 * 60 * 1000;
    assert.equal((await app.get(`${APP}/me`)).status, 200);
    assert.equal(verifications(), 1);
    now += 60 * 1000;
    assert.equal((await app.get(`${APP}/me`)).status, 200);
    assert.equal(verifications(), 2);
    // Removed from the household: refused at once, though the token is still cached.
    await app.store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: [ANN] });
    assert.equal((await app.get(`${APP}/me`)).text, UNAUTHORIZED);
    assert.equal(verifications(), 2);
  });

  it('fails closed when Jellyfin is down, for a new session and for a cached one', async (t) => {
    const app = await startApp(t, world(), { libraryTtlMs: 0 });
    assert.equal((await app.get(`${APP}/me`)).status, 200);
    app.jellyfin.down = true;
    for (const [user, pathname] of [[ANN, `${APP}/me`], [ALICE, `${APP}/search?q=synthetic`], [ALICE, `${APP}/movie/${OWN_MOVIE}`]]) {
      const answer = await app.get(pathname, { user });
      assert.equal(answer.status, 502, pathname);
      assert.equal(answer.text, '{"error":"unavailable"}');
    }
    await app.jellyfin.close();
    const unreachable = await app.get(`${APP}/me`, { user: ANN });
    assert.equal(unreachable.status, 502);
    assert.equal(unreachable.text, '{"error":"unavailable"}');
  });

  it('is never served on the admin host', async (t) => {
    const app = await startApp(t);
    for (const host of ['jellypass.example.test', '127.0.0.1']) {
      const asMember = await app.get(`${APP}/me`, { host });
      assert.equal(asMember.status, 401);
      assert.equal(asMember.text, UNAUTHORIZED);
      const asAdmin = await app.get(`${APP}/search?q=synthetic`, { host, user: null, headers: { Authorization: 'Bearer admin-secret' } });
      assert.equal(asAdmin.status, 404);
      assert.deepEqual(asAdmin.json(), { error: 'not_found' });
    }
    assert.equal(app.seerr.calls.length, 0);
    assert.equal(app.jellyfin.requests.length, 0);
  });

  it('answers 404 on a host for no household, and on household hosts when the app is off, never proxying', async (t) => {
    const app = await startApp(t, world(), { app: false });
    assert.equal((await app.get(`${APP}/me`, { host: 'jelly-nowhere.example.test' })).status, 404);
    for (const pathname of [`${APP}/me`, `${APP}/search?q=synthetic`, '/jellypass/app', '/jellypass/app/anything']) {
      const answer = await app.get(pathname);
      assert.equal(answer.status, 404, pathname);
      assert.deepEqual(answer.json(), { error: 'not_found' });
    }
    assert.equal(app.jellyfin.requests.length, 0);
    assert.equal(app.seerr.calls.length, 0);
  });

  it('never proxies a WebSocket upgrade on an app path to Jellyfin', async (t) => {
    const app = await startApp(t);
    const answer = await new Promise((resolve, reject) => {
      const socket = connect(app.port, '127.0.0.1', () => {
        socket.write(`GET ${APP}/me HTTP/1.1\r\nHost: ${HOST_A}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
          'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
      });
      let received = '';
      socket.on('data', (chunk) => { received += chunk; });
      socket.on('end', () => resolve(received));
      socket.on('error', reject);
    });
    assert.match(answer, /^HTTP\/1\.1 404 /);
    assert.equal(app.jellyfin.requests.length, 0);
  });
});

describe('household app API: input, budgets and metrics', { timeout: 30_000 }, () => {
  it('answers invalid input and unknown paths with fixed bodies', async (t) => {
    const app = await startApp(t);
    for (const pathname of [
      `${APP}/search`, `${APP}/search?q=`, `${APP}/search?q=%20`, `${APP}/search?q=${'x'.repeat(101)}`,
      `${APP}/search?q=x&page=0`, `${APP}/search?q=x&page=1.5`, `${APP}/search?q=x&page=501`, `${APP}/discover/trending?page=-1`,
      `${APP}/movie/0`, `${APP}/movie/abc`, `${APP}/movie/2147483648`, `${APP}/tv/1e3`, `${APP}/tv/${T_TV}/season/x`, `${APP}/tv/${T_TV}/season/1000`,
    ]) {
      const answer = await app.get(pathname);
      assert.equal(answer.status, 400, pathname);
      assert.equal(answer.text, '{"error":"invalid_request"}', pathname);
    }
    for (const pathname of [`${APP}/movie/404404`, `${APP}/tv/404404`, `${APP}/tv/${T_TV}/season/9`, `${APP}/discover/everything`, `${APP}/requests`, `${APP}/`, `${APP}`]) {
      const answer = await app.get(pathname);
      assert.equal(answer.status, 404, pathname);
      assert.equal(answer.text, '{"error":"not_found"}', pathname);
    }
  });

  it('limits calls per client address and per user, answering both the same way', async (t) => {
    const app = await startApp(t);
    const answers = [];
    for (let index = 0; index < 201; index += 1) answers.push(await app.get(`${APP}/me`));
    assert.ok(answers.slice(0, 200).every((answer) => answer.status === 200));
    const perUser = answers[200];
    assert.equal(perUser.status, 429);
    // Ann, from the same address, still has her own budget, until the address's runs out.
    for (let index = 0; index < 99; index += 1) assert.equal((await app.get(`${APP}/me`, { user: ANN })).status, 200);
    const perClient = await app.get(`${APP}/me`, { user: ANN });
    assert.equal(perClient.status, 429);
    assert.equal(serialized(perClient), serialized(perUser));
    assert.equal(perUser.text, '{"error":"too_many_requests"}');
    // The address budget applies before any credentials are checked.
    const verifications = app.jellyfin.requests.length;
    assert.equal((await app.get(`${APP}/me`, { user: null })).status, 429);
    assert.equal(app.jellyfin.requests.length, verifications);
  });

  it('counts answers by endpoint and outcome, never by title', async (t) => {
    const app = await startApp(t);
    await app.get(`${APP}/search?q=synthetic`);
    await app.get(`${APP}/movie/${T_MOVIE}`);
    await app.get(`${APP}/movie/404404`);
    await app.get(`${APP}/me`, { user: BOB });
    await app.get(`${APP}/nothing`);
    const metrics = app.service.renderMetrics();
    for (const line of [
      'jfa_app_requests_total{endpoint="search",outcome="ok"} 1',
      'jfa_app_requests_total{endpoint="movie",outcome="ok"} 1',
      'jfa_app_requests_total{endpoint="movie",outcome="not_found"} 1',
      'jfa_app_requests_total{endpoint="me",outcome="unauthorized"} 1',
      'jfa_app_requests_total{endpoint="unknown",outcome="not_found"} 1',
    ]) assert.ok(metrics.includes(line), line);
    assert.doesNotMatch(metrics, /900001|404404|synthetic/i);
  });
});
