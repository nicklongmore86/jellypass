import assert from 'node:assert/strict';
import { connect } from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { GrantStore } from '../dist/store.js';
import { assertNoCanaries } from './support/seerr-fixtures.mjs';
import {
  ADMIN,
  ALICE,
  ANN,
  BOB,
  CAROL,
  HOST_A,
  HOST_B,
  ITEMS,
  OUTSIDER,
  OWN_MOVIE,
  REQUEST,
  REQUEST_MOVIE,
  REQUEST_TV,
  SEERR_IDS,
  SHARED_HOUSEHOLDS,
  TMDB_KEY,
  T_MOVIE,
  T_TV,
  mediaInfo,
  otherHouseholdWorlds,
  seerrRequest,
  startApp,
  world,
} from './support/household-app.mjs';
import { makeTempDir } from './support/temp-dir.mjs';

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
  it('answers /me with the caller\'s name and household only, without asking Seerr or TMDB', async (t) => {
    const app = await startApp(t);
    const answer = await app.get(`${APP}/me`);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json(), { name: 'Alice', household: 'Farmhouse' });
    assert.equal(app.seerr.calls.length, 0);
    assert.equal(app.tmdb.calls.length, 0);
  });

  it('shapes search results into allowlisted cards with the household state of each', async (t) => {
    const app = await startApp(t);
    const answer = await app.get(`${APP}/search?q=synthetic`);
    assert.equal(answer.status, 200);
    assert.equal(answer.headers['cache-control'], 'no-store');
    assert.equal(answer.headers['content-type'], 'application/json; charset=utf-8');
    // People are not titles; TMDB's totals and paging are never relayed. TMDB returned 4 results, not a full page.
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
      mediaType: 'movie', tmdbId: OWN_MOVIE, title: 'Synthetic Movie Three', year: 2024,
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

  it('pages discover lists from the results returned, never from TMDB\'s totals', async (t) => {
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

  it('never lets a TMDB or Seerr field reach an answer: every endpoint is canary-free, in every world', async (t) => {
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

  it('keeps error answers canary-free and fixed, whatever TMDB said', async (t) => {
    for (const status of [400, 401, 403, 429, 500, 503]) {
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
  /** T's state for every member of every household, on every household's host, by `user@host`. */
  async function everyone(app, households) {
    const seen = {};
    for (const household of households) {
      for (const user of household.userIds) {
        const host = `jelly-${household.id}.example.test`;
        const movie = (await app.get(`${APP}/movie/${T_MOVIE}`, { host, user })).json();
        const series = (await app.get(`${APP}/tv/${T_TV}`, { host, user })).json();
        seen[`${user}@${household.id}`] = [movie.state, series.state, ...series.seasons.map((season) => season.state)].join(',');
      }
    }
    return seen;
  }

  const allGetThis = (households) => Object.fromEntries(households.flatMap((household) =>
    household.userIds.map((user) => [`${user}@${household.id}`, 'get_this,get_this,get_this,get_this'])));

  /** Runs `steps` (each a list of households) in order, checking that nobody, anywhere, ever sees T as requested. */
  async function membershipChanges(t, requests, steps) {
    const app = await startApp(t, world({ requests }), { households: steps[0] });
    for (const [index, households] of steps.entries()) {
      for (const household of households) await app.store.upsertGroup(household);
      assert.deepEqual(await everyone(app, households), allGetThis(households), `step ${index}`);
    }
    // Seerr's requests are never read: the households a requester belongs to now say nothing about which one they asked for.
    assert.ok(!app.seerr.calls.some((call) => /\/requests$/.test(call.pathname)), JSON.stringify(app.seerr.calls.map((call) => call.path)));
    assert.deepEqual(app.seerr.violations, []);
  }

  const pending = [seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: 1 }), seerrRequest({ type: 'tv', tmdbId: T_TV, status: 2, seasons: [2] })];
  const FARMHOUSE = (...userIds) => ({ id: 'farmhouse', name: 'Farmhouse', userIds });
  const MILL = (...userIds) => ({ id: 'mill', name: 'Mill', userIds });

  it('never shows a Seerr request as requested, not even one by a member of this household alone', async (t) => {
    await membershipChanges(t, { [SEERR_IDS[ANN]]: pending, [SEERR_IDS[ALICE]]: pending }, [[FARMHOUSE(ALICE, ANN), MILL(BOB)]]);
  });

  it('keeps a shared member\'s old request hidden once they leave the other household (Codex\'s repro)', async (t) => {
    // Bob, in Farmhouse and Mill, asked for T for Mill. Leaving Mill does not make his old request Farmhouse's.
    await membershipChanges(t, { [SEERR_IDS[BOB]]: pending }, [
      [FARMHOUSE(ALICE, ANN, BOB), MILL(BOB)],
      [FARMHOUSE(ALICE, ANN, BOB), MILL()],
    ]);
  });

  it('keeps a request hidden when its requester moves to another household', async (t) => {
    // Ann asked for T while in Farmhouse alone; moving to Mill does not make it Mill's.
    await membershipChanges(t, { [SEERR_IDS[ANN]]: pending }, [
      [FARMHOUSE(ALICE, ANN), MILL(BOB)],
      [FARMHOUSE(ALICE), MILL(BOB, ANN)],
    ]);
  });

  it('keeps a request hidden when a shared member becomes exclusive to one household', async (t) => {
    await membershipChanges(t, { [SEERR_IDS[CAROL]]: pending }, [
      [FARMHOUSE(ALICE, ANN, CAROL), MILL(BOB, CAROL)],
      [FARMHOUSE(ALICE, ANN, CAROL), MILL(BOB)],
    ]);
  });

  it('keeps a request hidden when an exclusive member joins another household too', async (t) => {
    await membershipChanges(t, { [SEERR_IDS[ANN]]: pending }, [
      [FARMHOUSE(ALICE, ANN), MILL(BOB)],
      [FARMHOUSE(ALICE, ANN), MILL(BOB, ANN)],
    ]);
  });

  it('is in_library once the caller can play a title someone asked for', async (t) => {
    const app = await startApp(t, world({ requests: { [SEERR_IDS[ANN]]: [seerrRequest({ type: 'movie', tmdbId: OWN_MOVIE, status: 2 })] } }));
    const movie = (await app.get(`${APP}/movie/${OWN_MOVIE}`)).json();
    assert.equal(movie.state, 'in_library');
    assert.deepEqual(movie.play, PLAY(ITEMS.ownMovie));
  });

  it('ignores the requests of an administrator who belongs to several households', async (t) => {
    const app = await startApp(t, world({
      seerrUsers: { [SEERR_IDS[CAROL]]: { jellyfinUserId: CAROL, permissions: ADMIN } },
      requests: { [SEERR_IDS[CAROL]]: [seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: 2 })] },
    }), { households: SHARED_HOUSEHOLDS });
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).json().state, 'get_this');
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`, { host: HOST_B, user: BOB })).json().state, 'get_this');
    // The administrator's own permission still lets them request.
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`, { user: CAROL })).json().state, 'get_this');
  });

  it('ignores the requests of a user in no household, who cannot use the app either', async (t) => {
    const app = await startApp(t, world({ requests: { [SEERR_IDS[OUTSIDER]]: [seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: 1 })] } }));
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).json().state, 'get_this');
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`, { user: OUTSIDER })).status, 401);
    assert.ok(!app.seerr.calls.some((call) => call.actingUser === String(SEERR_IDS[OUTSIDER])));
  });

  it('is unavailable for what the caller cannot play when they may not request, or Seerr has no user for them', async (t) => {
    for (const changes of [{ [SEERR_IDS[ALICE]]: { jellyfinUserId: ALICE, permissions: 0 } }, { [SEERR_IDS[ALICE]]: { jellyfinUserId: 'f'.repeat(32), permissions: REQUEST } }]) {
      const app = await startApp(t, world({
        seerrUsers: changes,
        requests: { [SEERR_IDS[ANN]]: [seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: 1 })] },
      }));
      const page = (await app.get(`${APP}/search?q=synthetic`)).json();
      // Her own playable title needs no request permission.
      assert.deepEqual(states(page), { [T_MOVIE]: 'unavailable', [T_TV]: 'unavailable', [OWN_MOVIE]: 'in_library' });
      assert.deepEqual(page.results.find((card) => card.tmdbId === OWN_MOVIE).play, PLAY(ITEMS.ownMovie));
      assert.deepEqual((await app.get(`${APP}/movie/${OWN_MOVIE}`)).json().play, PLAY(ITEMS.ownMovie));
      const series = (await app.get(`${APP}/tv/${T_TV}`)).json();
      assert.deepEqual(series.seasons.map((season) => season.state), ['unavailable', 'unavailable']);
      assert.equal((await app.get(`${APP}/tv/${T_TV}/season/1`)).json().state, 'unavailable');
    }
  });

  it('shows a series and its seasons in the caller\'s library without request permission, and the rest unavailable', async (t) => {
    const app = await startApp(t, world({
      seerrUsers: { [SEERR_IDS[ALICE]]: { jellyfinUserId: ALICE, permissions: REQUEST_MOVIE } },
      items: [{ Id: ITEMS.tSeries, Name: 'Synthetic Series Two', Type: 'Series', ProviderIds: { Tmdb: String(T_TV) }, Tags: [], library: 'shared' }],
      episodes: [{ Id: '88880000888800008888000088880001', SeriesId: ITEMS.tSeries, ParentIndexNumber: 1 }],
    }));
    const series = (await app.get(`${APP}/tv/${T_TV}`)).json();
    assert.equal(series.state, 'in_library');
    assert.deepEqual(series.play, PLAY(ITEMS.tSeries));
    assert.deepEqual(series.seasons.map((season) => [season.seasonNumber, season.state]), [[1, 'in_library'], [2, 'unavailable']]);
    assert.equal((await app.get(`${APP}/tv/${T_TV}/season/2`)).json().state, 'unavailable');
  });

  it('decides request permission per media type', async (t) => {
    const app = await startApp(t, world({ seerrUsers: { [SEERR_IDS[ALICE]]: { jellyfinUserId: ALICE, permissions: REQUEST_MOVIE } } }));
    assert.deepEqual(states((await app.get(`${APP}/search?q=synthetic`)).json()), { [T_MOVIE]: 'get_this', [T_TV]: 'unavailable', [OWN_MOVIE]: 'in_library' });
    const tvOnly = await startApp(t, world({ seerrUsers: { [SEERR_IDS[ALICE]]: { jellyfinUserId: ALICE, permissions: REQUEST_TV } } }));
    assert.deepEqual(states((await tvOnly.get(`${APP}/search?q=synthetic`)).json()), { [T_MOVIE]: 'unavailable', [T_TV]: 'get_this', [OWN_MOVIE]: 'in_library' });
  });

  it('is unavailable for a blocklisted title the caller cannot play, before requested; Seerr\'s media status is never read', async (t) => {
    const app = await startApp(t, world({
      blocklist: [{ mediaType: 'movie', tmdbId: T_MOVIE }, { mediaType: 'tv', tmdbId: T_TV }, { mediaType: 'movie', tmdbId: OWN_MOVIE }],
      // Seerr's own media status says nothing: the blocklist alone decides.
      media: { [T_MOVIE]: mediaInfo(T_MOVIE, 5) },
      requests: { [SEERR_IDS[ANN]]: [seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: 1 })] },
    }));
    const page = (await app.get(`${APP}/search?q=synthetic`)).json();
    // A blocklisted title already in the caller's own library is still theirs to play.
    assert.deepEqual(states(page), { [T_MOVIE]: 'unavailable', [T_TV]: 'unavailable', [OWN_MOVIE]: 'in_library' });
    assert.deepEqual((await app.get(`${APP}/movie/${OWN_MOVIE}`)).json().play, PLAY(ITEMS.ownMovie));
    const series = (await app.get(`${APP}/tv/${T_TV}`)).json();
    assert.deepEqual(series.seasons.map((season) => season.state), ['unavailable', 'unavailable']);
    // A movie and a series with the same TMDB ID are different titles.
    const other = await startApp(t, world({ blocklist: [{ mediaType: 'tv', tmdbId: T_MOVIE }, { mediaType: 'movie', tmdbId: T_TV }] }));
    assert.deepEqual(states((await other.get(`${APP}/search?q=synthetic`)).json()), { [T_MOVIE]: 'get_this', [T_TV]: 'get_this', [OWN_MOVIE]: 'in_library' });
    assert.ok(app.seerr.calls.some((call) => call.pathname === '/api/v1/blocklist' && call.actingUser === undefined));
  });

  it('pages through Seerr\'s blocklist', async (t) => {
    const filler = Array.from({ length: 250 }, (_, index) => ({ mediaType: 'movie', tmdbId: 800000 + index }));
    const app = await startApp(t, world({ blocklist: [...filler, { mediaType: 'movie', tmdbId: T_MOVIE }] }));
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).json().state, 'unavailable');
    assert.deepEqual(app.seerr.calls.filter((call) => call.pathname === '/api/v1/blocklist').map((call) => call.path), [
      '/api/v1/blocklist?take=100&skip=0',
      '/api/v1/blocklist?take=100&skip=100',
      '/api/v1/blocklist?take=100&skip=200',
    ]);
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
      // The worlds really differ: household B holds T, or has Seerr requests for it (which no household is shown in
      // step 1: requests carry no household until "Get this" records one).
      const bob = (await changed.get(`${APP}/movie/${T_MOVIE}`, { host: HOST_B, user: BOB })).json();
      assert.equal(bob.state, /pending|large/.test(name) ? 'get_this' : 'in_library');
      assert.deepEqual(changed.seerr.violations, []);
    });
  }

  it('gives household A identical answers whether or not a member it shares with household B asked for T', async (t) => {
    // Carol is in both households: her requests could be either household's, so they must not change A's answers.
    const baseline = await startApp(t, world(), { households: SHARED_HOUSEHOLDS });
    const changed = await startApp(t, world({
      requests: { [SEERR_IDS[CAROL]]: [seerrRequest({ type: 'movie', tmdbId: T_MOVIE, status: 1 }), seerrRequest({ type: 'tv', tmdbId: T_TV, status: 2, seasons: [1] })] },
    }), { households: SHARED_HOUSEHOLDS });
    for (const pathname of ENDPOINTS) {
      for (const user of [ALICE, ANN]) {
        assert.equal(serialized(await changed.get(pathname, { user })), serialized(await baseline.get(pathname, { user })), `${user} ${pathname}`);
      }
    }
  });

  const trace = async (t, state, options) => {
    const app = await startApp(t, state, options);
    for (const pathname of ENDPOINTS) await app.get(pathname);
    for (const pathname of ENDPOINTS) await app.get(pathname, { user: ANN });
    return {
      seerr: app.seerr.calls.map((call) => `${call.actingUser ?? 'admin'} ${call.method} ${call.path}`).sort(),
      tmdb: app.tmdb.calls.map((call) => `${call.method} ${call.path}`).sort(),
      jellyfin: app.jellyfin.requests.map((request) => `${request.method} ${request.path}`).sort(),
    };
  };

  it('makes the same TMDB, Seerr and Jellyfin calls for household A in every world', async (t) => {
    const expected = await trace(t, world());
    for (const [name, state] of Object.entries(otherHouseholdWorlds())) {
      assert.deepEqual(await trace(t, state), expected, name);
    }
    const shared = await trace(t, world(), { households: SHARED_HOUSEHOLDS });
    assert.deepEqual(await trace(t, world({
      requests: { [SEERR_IDS[CAROL]]: Array.from({ length: 300 }, (_, index) => seerrRequest({ type: 'movie', tmdbId: 800000 + index, status: 1 })) },
    }), { households: SHARED_HOUSEHOLDS }), shared, 'a shared member\'s long request history');
  });

  it('reads no title from Seerr, so other households\' Seerr records cannot change A\'s status or latency', async (t) => {
    // 5 MB of other households' requests on T: when titles came from Seerr, 4.3 MB of them made A's answers fail.
    const [name, state] = Object.entries(otherHouseholdWorlds()).find(([key]) => key.startsWith('large'));
    const app = await startApp(t, state);
    for (const pathname of ENDPOINTS) assert.equal((await app.get(pathname)).status, 200, `${name} ${pathname}`);
    assert.deepEqual(app.seerr.violations, []);
    for (const call of app.seerr.calls) {
      assert.match(call.pathname, /^\/api\/v1\/(?:user\/jellyfin\/[0-9a-f]{32}|user\/[0-9]+|auth\/me|blocklist)$/, call.path);
    }
    // Bob's long history is never read for household A.
    assert.ok(!app.seerr.calls.some((call) => call.actingUser === String(SEERR_IDS[BOB])));
  });
});

describe('household app API: identity', { timeout: 20_000 }, () => {
  it('reads only the caller\'s own permissions as the caller, each call confirmed first, and titles never from Seerr', async (t) => {
    const app = await startApp(t, world({ requests: { [SEERR_IDS[ANN]]: [seerrRequest({ type: 'movie', tmdbId: T_MOVIE })] } }));
    for (const pathname of ENDPOINTS) assert.equal((await app.get(pathname)).status, 200, pathname);
    assert.deepEqual(app.seerr.violations, []);
    const acting = app.seerr.calls.filter((call) => call.actingUser !== undefined);
    assert.ok(acting.length > 0);
    for (const call of app.seerr.calls) {
      if (call.actingUser === undefined) {
        // Admin calls are only user lookups, confirmations and the blocklist.
        assert.match(call.pathname, /^\/api\/v1\/(?:user\/(?:jellyfin\/[0-9a-f]{32}|[0-9]+)|blocklist)$/);
        continue;
      }
      // Never the owner, never another member: only the caller's own Seerr user, for their own permissions.
      assert.equal(call.method, 'GET');
      assert.equal(call.actingUser, String(SEERR_IDS[ALICE]));
      assert.equal(call.pathname, '/api/v1/auth/me');
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

  it('reads titles from TMDB with JellyPass\'s key alone, the same calls whoever asks', async (t) => {
    const calls = async (host, user) => {
      const app = await startApp(t);
      for (const pathname of ENDPOINTS) assert.equal((await app.get(pathname, { host, user })).status, 200);
      return app.tmdb.calls;
    };
    const asAlice = await calls(HOST_A, ALICE);
    const asBob = await calls(HOST_B, BOB);
    assert.deepEqual(asBob.map((call) => call.path), asAlice.map((call) => call.path));
    for (const call of asAlice) {
      assert.equal(call.method, 'GET');
      assert.equal(call.query.get('api_key'), TMDB_KEY);
      assert.equal(call.query.get('language'), 'en-US');
      // Nothing about the caller, their household or their Jellyfin session reaches TMDB.
      assert.doesNotMatch(`${call.path}\n${JSON.stringify(call.headers)}`, /a11ce000|farmhouse|token-alice|x-api-user|authorization/i);
    }
    assert.deepEqual(asAlice.map((call) => call.pathname), [
      '/3/search/multi', '/3/search/multi', '/3/trending/all/day', '/3/discover/movie', '/3/discover/tv', '/3/discover/movie',
      `/3/movie/${T_MOVIE}`, `/3/movie/${OWN_MOVIE}`, `/3/tv/${T_TV}`, `/3/tv/${T_TV}/season/1`, `/3/tv/${T_TV}/season/2`,
    ]);
  });
});

describe('household app API: caches', { timeout: 20_000 }, () => {
  it('reuses a TMDB answer within a household for ten minutes, and never across households', async (t) => {
    let now = Date.parse('2026-10-24T12:00:00.000Z');
    const app = await startApp(t, world(), { now: () => now });
    const reads = () => app.tmdb.calls.filter((call) => call.pathname === `/3/movie/${T_MOVIE}`).length;
    await app.get(`${APP}/movie/${T_MOVIE}`);
    await app.get(`${APP}/movie/${T_MOVIE}`, { user: ANN });
    assert.equal(reads(), 1);
    // Household B's call is not answered from A's cache, so whether A looked at T never changes B's latency.
    await app.get(`${APP}/movie/${T_MOVIE}`, { host: HOST_B, user: BOB });
    assert.equal(reads(), 2);
    now += 10 * 60 * 1000 - 1;
    await app.get(`${APP}/movie/${T_MOVIE}`);
    assert.equal(reads(), 2);
    now += 1;
    await app.get(`${APP}/movie/${T_MOVIE}`);
    assert.equal(reads(), 3);
    // Keyed by the request's parameters: another page or query is another entry.
    await app.get(`${APP}/search?q=synthetic`);
    await app.get(`${APP}/search?q=synthetic&page=2`);
    await app.get(`${APP}/search?q=Synthetic`);
    await app.get(`${APP}/search?q=synthetic`);
    assert.equal(app.tmdb.calls.filter((call) => call.pathname === '/3/search/multi').length, 3);
  });

  it('keeps no failed TMDB answer', async (t) => {
    const state = world({ failCatalogue: 503 });
    const app = await startApp(t, state);
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).status, 502);
    state.failCatalogue = undefined;
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).status, 200);
    assert.equal((await app.get(`${APP}/movie/404404`)).status, 404);
    assert.equal((await app.get(`${APP}/movie/404404`)).status, 404);
    assert.equal(app.tmdb.calls.filter((call) => call.pathname === '/3/movie/404404').length, 2);
  });

  it('reuses Seerr\'s blocklist within a household for a minute, and never across households', async (t) => {
    let now = Date.parse('2026-10-24T12:00:00.000Z');
    const state = world();
    const app = await startApp(t, state, { now: () => now });
    const reads = () => app.seerr.calls.filter((call) => call.pathname === '/api/v1/blocklist').length;
    await app.get(`${APP}/movie/${T_MOVIE}`);
    await app.get(`${APP}/search?q=synthetic`, { user: ANN });
    assert.equal(reads(), 1);
    await app.get(`${APP}/movie/${T_MOVIE}`, { host: HOST_B, user: BOB });
    assert.equal(reads(), 2);
    state.blocklist.push({ mediaType: 'movie', tmdbId: T_MOVIE });
    now += 60 * 1000;
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).json().state, 'unavailable');
    assert.equal(reads(), 3);
  });
});

describe('household app API: one cache per household', { timeout: 120_000 }, () => {
  const hostOf = (id) => `jelly-${id}.example.test`;

  it('never evicts a household\'s cached answers for other households\' (Codex\'s repro)', async (t) => {
    let now = Date.parse('2026-10-24T12:00:00.000Z');
    const day = 24 * 60 * 60 * 1000;
    const app = await startApp(t, world(), { now: () => now, titleTtlMs: day, blocklistTtlMs: day });
    const titleReads = () => app.tmdb.calls.filter((call) => call.pathname === `/3/movie/${T_MOVIE}`).length;
    const blocklistReads = () => app.seerr.calls.filter((call) => call.pathname === '/api/v1/blocklist').length;
    await app.get(`${APP}/movie/${T_MOVIE}`);
    await app.get(`${APP}/movie/${T_MOVIE}`);
    assert.equal(titleReads(), 1);
    // 1,000 more households, each browsing through Carol, a member of all of them. At most 100 households exist.
    const refusals = [];
    for (let index = 0; index < 1000; index += 1) {
      await app.store.upsertGroup({ id: `h${index}`, name: `H${index}`, userIds: [CAROL] }).catch((error) => refusals.push(error.message));
    }
    const statuses = [];
    for (let index = 0; index < 1000; index += 1) {
      // Past Carol's 5-minute budget every 150 calls; the caches are kept for a day.
      if (index % 150 === 0) now += 5 * 60 * 1000;
      statuses.push((await app.get(`${APP}/movie/${T_MOVIE}`, { host: hostOf(`h${index}`), user: CAROL })).status);
    }
    const [titles, blocklists] = [titleReads(), blocklistReads()];
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`)).status, 200);
    assert.equal(titleReads(), titles, 'household A\'s answer still comes from its own cache');
    assert.equal(blocklistReads(), blocklists, 'and so does its blocklist');
    // Only 98 more households could be created; the rest do not exist, so their hosts serve nothing.
    assert.deepEqual(refusals, Array(902).fill('groups must be at most 100'));
    assert.deepEqual(statuses, [...Array(98).fill(200), ...Array(902).fill(404)]);
    assert.equal(titles, 99);
    // A deleted household's caches go, and only its own: a new household takes its place, A's are untouched.
    await app.store.deleteGroup('h0');
    await app.store.upsertGroup({ id: 'newcomer', name: 'Newcomer', userIds: [CAROL] });
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`, { host: hostOf('newcomer'), user: CAROL })).status, 200);
    assert.equal(titleReads(), titles + 1);
    await app.get(`${APP}/movie/${T_MOVIE}`);
    assert.equal(titleReads(), titles + 1);
    await assert.rejects(app.store.upsertGroup({ id: 'one-too-many', name: 'Too many', userIds: [] }), /groups must be at most 100/);
    const refusal = await fetch(`http://127.0.0.1:${app.port}/v1/groups/one-too-many`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Too many', userIds: [] }),
    });
    assert.equal(refusal.status, 400);
    assert.deepEqual(await refusal.json(), { error: 'groups must be at most 100' });
    // Renaming or changing an existing household is still allowed at the limit.
    await app.store.upsertGroup({ id: 'farmhouse', name: 'Farmhouse', userIds: [ALICE, ANN] });
  });

  it('caches nothing for any household when a state file holds more households than supported, and still loads it', async (t) => {
    const at = '2026-10-24T12:00:00.000Z';
    const groups = Object.fromEntries([
      { id: 'farmhouse', name: 'Farmhouse', userIds: [ALICE, ANN].sort() },
      { id: 'mill', name: 'Mill', userIds: [BOB] },
      ...Array.from({ length: 99 }, (_, index) => ({ id: `h${index}`, name: `H${index}`, userIds: [] })),
    ].map((group) => [group.id, { ...group, createdAt: at, updatedAt: at }]));
    const warn = t.mock.method(console, 'warn', () => undefined);
    const app = await startApp(t, world(), {
      stateFile: { version: 7, grants: {}, groups, catalog: { items: {} }, passwordlessUserIds: [], handledRequestIds: [] },
    });
    assert.equal(app.store.listGroups().length, 101);
    // Startup is not refused, but says why new groups are refused and nothing is cached.
    assert.deepEqual(warn.mock.calls.map((call) => JSON.parse(call.arguments[0])), [householdLimitWarning(101)]);
    for (const [host, user] of [[HOST_A, ALICE], [HOST_A, ALICE], [HOST_B, BOB], [HOST_B, BOB]]) {
      assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`, { host, user })).status, 200);
    }
    // The same for every household, whoever was served first: every call goes to TMDB and Seerr.
    assert.equal(app.tmdb.calls.filter((call) => call.pathname === `/3/movie/${T_MOVIE}`).length, 4);
    assert.equal(app.seerr.calls.filter((call) => call.pathname === '/api/v1/blocklist').length, 4);
    // An upgrade with more groups than supported: existing groups can still be changed and deleted, new ones are
    // refused until there are fewer than 100.
    await app.store.upsertGroup({ id: 'h0', name: 'Renamed', userIds: [] });
    await assert.rejects(app.store.upsertGroup({ id: 'new', name: 'New', userIds: [] }), /groups must be at most 100/);
    await app.store.deleteGroup('h0');
    await assert.rejects(app.store.upsertGroup({ id: 'new', name: 'New', userIds: [] }), /groups must be at most 100/);
    await app.store.deleteGroup('h1');
    await app.store.upsertGroup({ id: 'new', name: 'New', userIds: [] });
    assert.equal(app.store.listGroups().length, 100);
  });
});

/** The startup warning for a state file holding `groups` groups, more than the household app supports. */
const householdLimitWarning = (groups) => ({
  level: 'warn',
  message: 'the household app supports at most 100 households; no new group can be created until there are fewer, and the app caches nothing while there are more',
  groups,
});

/** A schema v7 state file holding `count` empty groups `h0`, `h1`, .... */
function stateWithGroups(count) {
  const at = '2026-10-24T12:00:00.000Z';
  const groups = Object.fromEntries(Array.from({ length: count }, (_, index) =>
    [`h${index}`, { id: `h${index}`, name: `H${index}`, userIds: [], createdAt: at, updatedAt: at }]));
  return { version: 7, grants: {}, groups, catalog: { items: {} }, passwordlessUserIds: [], handledRequestIds: [] };
}

describe('household limit: only while the household app is enabled', { timeout: 60_000 }, () => {
  const putGroup = (app, id) => fetch(`http://127.0.0.1:${app.port}/v1/groups/${id}`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: id, userIds: [] }),
  });

  it('with the app off, creates a group beyond 100 as 2.2.1 did (Codex\'s repro)', async (t) => {
    const warn = t.mock.method(console, 'warn', () => undefined);
    const app = await startApp(t, world(), { app: false, households: [], stateFile: stateWithGroups(100) });
    const created = await putGroup(app, 'new-household');
    assert.equal(created.status, 200, await created.clone().text());
    assert.equal((await created.json()).group.id, 'new-household');
    await app.store.upsertGroup({ id: 'another', name: 'Another', userIds: [] });
    assert.equal(app.store.countGroups(), 102);
    assert.equal(warn.mock.callCount(), 0, 'no household limit warning with the app off');
  });

  it('with the app on, refuses a 101st group with 400', async (t) => {
    const app = await startApp(t, world(), { households: [], stateFile: stateWithGroups(100) });
    const refused = await putGroup(app, 'new-household');
    assert.equal(refused.status, 400);
    assert.deepEqual(await refused.json(), { error: 'groups must be at most 100' });
    assert.equal(app.store.countGroups(), 100);
  });

  it('follows the setting across restarts of the same state file', async (t) => {
    const file = path.join(await makeTempDir(t, 'jfa-household-limit-'), 'grants.json');
    const warn = t.mock.method(console, 'warn', () => undefined);
    const open = async (limitHouseholds) => {
      const store = new GrantStore(file, { limitHouseholds });
      await store.load();
      return store;
    };
    // App off (the default): no limit.
    const off = await open(false);
    for (let index = 0; index < 101; index += 1) await off.upsertGroup({ id: `h${index}`, name: `H${index}`, userIds: [] });
    await off.close();
    assert.equal(warn.mock.callCount(), 0);
    // App on: the 101 groups load with a warning, stay editable and deletable, and new ones are refused until fewer than 100.
    const on = await open(true);
    assert.equal(on.countGroups(), 101);
    assert.deepEqual(warn.mock.calls.map((call) => JSON.parse(call.arguments[0])), [householdLimitWarning(101)]);
    await on.upsertGroup({ id: 'h0', name: 'Renamed', userIds: [] });
    await assert.rejects(on.upsertGroup({ id: 'new', name: 'New', userIds: [] }), /groups must be at most 100/);
    await on.deleteGroup('h0');
    await on.deleteGroup('h1');
    await on.upsertGroup({ id: 'new', name: 'New', userIds: [] });
    await assert.rejects(on.upsertGroup({ id: 'newer', name: 'Newer', userIds: [] }), /groups must be at most 100/);
    await on.close();
    // App off again: creating is unlimited once more, and nothing is logged.
    const again = await open(false);
    await again.upsertGroup({ id: 'newer', name: 'Newer', userIds: [] });
    await again.upsertGroup({ id: 'newest', name: 'Newest', userIds: [] });
    assert.equal(again.countGroups(), 102);
    await again.close();
    assert.equal(warn.mock.callCount(), 1);
    // And a store built without options is unlimited, as in 2.2.1.
    const plain = new GrantStore(file);
    await plain.load();
    await plain.upsertGroup({ id: 'plain', name: 'Plain', userIds: [] });
    assert.equal(plain.countGroups(), 103);
    await plain.close();
  });
});

describe('household app API: TMDB shared fairly', { timeout: 60_000 }, () => {
  it('keeps household A\'s TMDB share while household B bursts past TMDB\'s rate limit (Codex\'s repro)', async (t) => {
    // TMDB allows 40 calls a second; B sends 40 different searches at once, then A searches for something cold.
    const app = await startApp(t, world({ tmdbQuota: { calls: 40, windowMs: 1000 } }), { catalogueLimits: {} });
    // B is signed in and known to Seerr already, so its searches reach TMDB at once; its first call leaves TMDB's window.
    assert.equal((await app.get(`${APP}/movie/${T_MOVIE}`, { host: HOST_B, user: BOB })).status, 200);
    await delay(1100);
    let bobAnswered = 0;
    const bursts = Array.from({ length: 40 }, (_, index) =>
      app.get(`${APP}/search?q=burst-${index}`, { host: HOST_B, user: BOB }).then((answer) => {
        bobAnswered += 1;
        return answer;
      }));
    await delay(200);
    const started = performance.now();
    const alice = await app.get(`${APP}/search?q=cold`);
    const waited = performance.now() - started;
    const bobAnsweredBeforeAlice = bobAnswered;
    const bob = await Promise.all(bursts);
    assert.equal(alice.status, 200, alice.text);
    assert.deepEqual(app.tmdb.limited, [], 'TMDB never had to refuse a call');
    // A took its own turn: B still had calls waiting when A was answered.
    const bobServed = bob.filter((answer) => answer.status === 200).length;
    assert.ok(bobAnsweredBeforeAlice < bob.length, `B answered ${bobAnsweredBeforeAlice} first`);
    assert.ok(waited < 1000, `A waited ${waited} ms`);
    // B's own volume only costs B: its calls beyond its queue are refused with the fixed 429, the rest answered.
    for (const answer of bob) {
      assert.ok(answer.status === 200 || answer.text === '{"error":"too_many_requests"}', `${answer.status} ${answer.text}`);
    }
    assert.ok(bobServed >= 20 && bobServed < 40, `B served ${bobServed}`);
  });

  it('never has more TMDB calls unanswered than allowed, and gives up on a hung one, freeing its place', async (t) => {
    // TMDB never answers; tokens are plentiful, so only the 10 places in flight limit, each call abandoned after 300 ms.
    const app = await startApp(t, world({ tmdbHang: true }), { catalogueLimits: { perSecond: 1000, burst: 1000, inFlight: 10, callTimeoutMs: 300 } });
    const asks = [];
    for (const [host, user] of [[HOST_A, ALICE], [HOST_A, ANN], [HOST_B, BOB]]) {
      for (let index = 0; index < 8; index += 1) asks.push(app.get(`${APP}/search?q=${user}-${index}`, { host, user }));
    }
    // Between abandonments (at 300 ms and 600 ms) TMDB holds 10 open calls, then the last 4.
    const open = [];
    for (const at of [150, 450, 750]) {
      await delay(at - (open.length ? [150, 450, 750][open.length - 1] : 0));
      open.push(app.tmdb.hung.open);
    }
    assert.deepEqual(open, [10, 10, 4]);
    const answers = await Promise.all(asks);
    for (const answer of answers) assert.equal(answer.text, '{"error":"unavailable"}');
    // Every call reached TMDB in its turn, and JellyPass closed each one it gave up on.
    assert.equal(app.tmdb.calls.filter((call) => call.pathname === '/3/search/multi').length, 24);
    for (let waited = 0; app.tmdb.hung.open > 0 && waited < 1000; waited += 10) await delay(10);
    assert.equal(app.tmdb.hung.open, 0);
  });

  it('starts at most 30 TMDB calls in any second, whatever households ask', async (t) => {
    const app = await startApp(t, world(), { catalogueLimits: {} });
    const asks = [];
    for (const [host, user] of [[HOST_A, ALICE], [HOST_A, ANN], [HOST_B, BOB]]) {
      for (let index = 0; index < 15; index += 1) asks.push(app.get(`${APP}/search?q=${user}-${index}`, { host, user }));
    }
    const answers = await Promise.all(asks);
    assert.ok(answers.every((answer) => answer.status === 200 || answer.status === 429));
    const times = app.tmdb.calls.filter((call) => call.pathname === '/3/search/multi').map((call) => call.at);
    assert.ok(times.length >= 30, `${times.length} calls`);
    for (const first of times) {
      assert.ok(times.filter((time) => time >= first && time < first + 1000).length <= 30);
    }
  });

  it('waits as long as TMDB asks after a 429, sends nothing meanwhile, and retries the call once', async (t) => {
    const app = await startApp(t, world({ tmdbRateLimited: 1, tmdbRetryAfter: 1 }), { catalogueLimits: {} });
    const [alice, bob] = await Promise.all([
      app.get(`${APP}/movie/${T_MOVIE}`),
      delay(100).then(() => app.get(`${APP}/search?q=synthetic`, { host: HOST_B, user: BOB })),
    ]);
    // The household whose call met the limit is not charged for it, and neither is the one that called meanwhile.
    assert.equal(alice.status, 200);
    assert.equal(bob.status, 200);
    const calls = app.tmdb.calls.filter((call) => call.pathname !== '/3/authentication');
    assert.equal(app.tmdb.limited.length, 1);
    assert.equal(calls.length, 3);
    const limitedAt = app.tmdb.limited[0].at;
    for (const call of calls.slice(1)) assert.ok(call.at >= limitedAt + 900, `${call.path} ${call.at - limitedAt} ms after the 429`);
  });

  it('never retries a call more than once, and fails at once when TMDB asks to wait past the call\'s time', async (t) => {
    const app = await startApp(t, world({ tmdbRateLimited: 2, tmdbRetryAfter: 0 }), { catalogueLimits: {} });
    const answer = await app.get(`${APP}/movie/${T_MOVIE}`);
    assert.equal(answer.status, 502);
    assert.equal(answer.text, '{"error":"unavailable"}');
    assert.equal(app.tmdb.calls.filter((call) => call.pathname !== '/3/authentication').length, 2);
    // TMDB asks for 30 seconds; calls wait at most their queue time (here 300 ms), so they fail rather than pile up.
    const paused = await startApp(t, world({ tmdbRateLimited: 1, tmdbRetryAfter: 30 }), { catalogueLimits: { queueTimeoutMs: 300 } });
    const started = performance.now();
    assert.equal((await paused.get(`${APP}/movie/${T_MOVIE}`)).status, 502);
    const meanwhile = await paused.get(`${APP}/search?q=synthetic`, { host: HOST_B, user: BOB });
    assert.equal(meanwhile.status, 502);
    assert.ok(performance.now() - started < 5000);
    assert.equal(paused.tmdb.calls.filter((call) => call.pathname !== '/3/authentication').length, 1, 'nothing sent while TMDB asked to wait');
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
    // A request with no credentials never reaches Jellyfin, and a token that is not a member's is checked again on every
    // call (it is never kept, so it cannot crowd a member's out); none of these reached Seerr.
    assert.equal(app.jellyfin.requests.filter((request) => request.pathname === '/Users/Me').length, refusals.length - 1);
    assert.equal(app.seerr.calls.length, 0);
    assert.equal(app.tmdb.calls.length, 0);
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
    assert.equal(app.tmdb.calls.length, 0);
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
    let now = Date.parse('2026-10-24T12:00:00.000Z');
    const app = await startApp(t, world(), { now: () => now });
    // Spread over 4 minutes, so the household's 10-second burst limit never applies.
    const get = async (options) => {
      now += 750;
      return app.get(`${APP}/me`, options);
    };
    const answers = [];
    for (let index = 0; index < 201; index += 1) answers.push(await get());
    assert.ok(answers.slice(0, 200).every((answer) => answer.status === 200));
    const perUser = answers[200];
    assert.equal(perUser.status, 429);
    // Ann, from the same address, still has her own budget, until the address's runs out.
    for (let index = 0; index < 99; index += 1) assert.equal((await get({ user: ANN })).status, 200);
    // Still inside the address's 5-minute window.
    assert.ok(now < Date.parse('2026-10-24T12:00:00.000Z') + 5 * 60 * 1000);
    const perClient = await get({ user: ANN });
    assert.equal(perClient.status, 429);
    assert.equal(serialized(perClient), serialized(perUser));
    assert.equal(perUser.text, '{"error":"too_many_requests"}');
    // The address budget applies before any credentials are checked.
    const verifications = app.jellyfin.requests.length;
    assert.equal((await app.get(`${APP}/me`, { user: null })).status, 429);
    assert.equal(app.jellyfin.requests.length, verifications);
  });

  it('limits each household\'s calls in any 10 seconds, counting only its own members', async (t) => {
    let now = Date.parse('2026-10-24T12:00:00.000Z');
    const app = await startApp(t, world(), { now: () => now });
    // Someone else's calls on the household's host never use up its burst.
    for (let index = 0; index < 30; index += 1) assert.equal((await app.get(`${APP}/me`, { user: BOB })).status, 401);
    for (let index = 0; index < 60; index += 1) assert.equal((await app.get(`${APP}/me`, { user: index % 2 ? ANN : ALICE })).status, 200);
    const limited = await app.get(`${APP}/me`);
    assert.equal(limited.status, 429);
    assert.equal(limited.text, '{"error":"too_many_requests"}');
    assert.equal((await app.get(`${APP}/me`, { user: ANN })).status, 429);
    // Another household has its own.
    assert.equal((await app.get(`${APP}/me`, { host: HOST_B, user: BOB })).status, 200);
    now += 10 * 1000;
    assert.equal((await app.get(`${APP}/me`)).status, 200);
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
