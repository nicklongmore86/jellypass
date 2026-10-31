import assert from 'node:assert/strict';
import { connect } from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { describe, it } from 'node:test';
import { readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseHTML } from 'linkedom';
import { setTimeout as delay } from 'node:timers/promises';
import { APP_API_VERSION } from '../dist/app-api.js';
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
  authorization,
  get,
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
  `${APP}/discover/trending-movies`,
  `${APP}/discover/trending-tv`,
  `${APP}/discover/popular-movies`,
  `${APP}/discover/popular-tv`,
  `${APP}/discover/upcoming?page=3`,
  `${APP}/discover/upcoming-tv`,
  `${APP}/discover/new-movies?page=2`,
  `${APP}/discover/top-movies`,
  `${APP}/discover/top-tv?page=4`,
  `${APP}/discover/sources`,
  `${APP}/discover/network/213`,
  // Netflix's films, then its series and films mixed (both answered from the household's cache by now).
  `${APP}/discover/network/213/films`,
  `${APP}/discover/network/213/all`,
  `${APP}/discover/studio/41077?page=2`,
  `${APP}/movie/${T_MOVIE}`,
  `${APP}/movie/${OWN_MOVIE}`,
  `${APP}/tv/${T_TV}`,
  `${APP}/tv/${T_TV}/season/1`,
  `${APP}/tv/${T_TV}/season/2`,
];
/** The endpoints answered without TMDB: who the caller is, and the allowlisted networks and studios. */
const TMDB_FREE = new Set([`${APP}/me`, `${APP}/discover/sources`]);
/** Network and studio logos: TMDB's own files at w300, and nothing else. */
const LOGO = /^https:\/\/image\.tmdb\.org\/t\/p\/w300\/[A-Za-z0-9_-]{1,100}\.(?:jpg|jpeg|png|webp)$/;
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
  it('answers /me with the caller\'s name and household and the API version only, without asking Seerr or TMDB', async (t) => {
    const app = await startApp(t);
    const answer = await app.get(`${APP}/me`);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json(), { name: 'Alice', household: 'Grove', apiVersion: 4 });
    assert.equal(app.seerr.calls.length, 0);
    assert.equal(app.tmdb.calls.length, 0);
    // The version is the server's, the same for every household and every member.
    assert.equal(APP_API_VERSION, 4);
    assert.deepEqual((await app.get(`${APP}/me`, { host: HOST_B, user: BOB })).json(), { name: 'Bob', household: 'Mill', apiVersion: APP_API_VERSION });
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
          rating: 7.1, state: 'get_this', play: null, hidden: false,
        },
        {
          mediaType: 'tv', tmdbId: T_TV, title: 'Synthetic Series Two', year: 2019,
          overview: 'A synthetic series used only in tests.', posterUrl: POSTER(T_TV), backdropUrl: BACKDROP(T_TV),
          rating: 6.9, state: 'get_this', play: null, hidden: false,
        },
        {
          mediaType: 'movie', tmdbId: OWN_MOVIE, title: 'Synthetic Movie Three', year: 2024, overview: 'Not in Seerr yet.',
          posterUrl: POSTER(OWN_MOVIE), backdropUrl: null, rating: 5.5, state: 'in_library', play: PLAY(ITEMS.ownMovie), hidden: false,
        },
      ],
    });
  });

  it('shapes movie, series and season details from allowlisted fields', async (t) => {
    const app = await startApp(t);
    assert.deepEqual((await app.get(`${APP}/movie/${OWN_MOVIE}`)).json(), {
      mediaType: 'movie', tmdbId: OWN_MOVIE, title: 'Synthetic Movie Three', year: 2024,
      overview: 'A synthetic film used only in tests.', posterUrl: POSTER(OWN_MOVIE), backdropUrl: BACKDROP(T_MOVIE),
      rating: 7.1, genres: ['Action', 'Science Fiction'], runtime: 101, state: 'in_library', play: PLAY(ITEMS.ownMovie), hidden: false,
    });
    assert.deepEqual((await app.get(`${APP}/tv/${T_TV}`)).json(), {
      mediaType: 'tv', tmdbId: T_TV, title: 'Synthetic Series Two', year: 2019,
      overview: 'A synthetic series used only in tests.', posterUrl: POSTER(T_TV), backdropUrl: BACKDROP(T_TV),
      rating: 6.9, genres: ['Drama'], runtime: null,
      seasons: [
        { seasonNumber: 1, name: 'Season 1', episodeCount: 3, state: 'get_this' },
        { seasonNumber: 2, name: 'Season 2', episodeCount: 3, state: 'get_this' },
      ],
      state: 'get_this', play: null, hidden: false,
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
      for (const pathname of ENDPOINTS.filter((endpoint) => !TMDB_FREE.has(endpoint))) {
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
  const GROVE = (...userIds) => ({ id: 'grove', name: 'Grove', userIds });
  const MILL = (...userIds) => ({ id: 'mill', name: 'Mill', userIds });

  it('never shows a Seerr request as requested, not even one by a member of this household alone', async (t) => {
    await membershipChanges(t, { [SEERR_IDS[ANN]]: pending, [SEERR_IDS[ALICE]]: pending }, [[GROVE(ALICE, ANN), MILL(BOB)]]);
  });

  it('keeps a shared member\'s old request hidden once they leave the other household (Codex\'s repro)', async (t) => {
    // Bob, in Grove and Mill, asked for T for Mill. Leaving Mill does not make his old request Grove's.
    await membershipChanges(t, { [SEERR_IDS[BOB]]: pending }, [
      [GROVE(ALICE, ANN, BOB), MILL(BOB)],
      [GROVE(ALICE, ANN, BOB), MILL()],
    ]);
  });

  it('keeps a request hidden when its requester moves to another household', async (t) => {
    // Ann asked for T while in Grove alone; moving to Mill does not make it Mill's.
    await membershipChanges(t, { [SEERR_IDS[ANN]]: pending }, [
      [GROVE(ALICE, ANN), MILL(BOB)],
      [GROVE(ALICE), MILL(BOB, ANN)],
    ]);
  });

  it('keeps a request hidden when a shared member becomes exclusive to one household', async (t) => {
    await membershipChanges(t, { [SEERR_IDS[CAROL]]: pending }, [
      [GROVE(ALICE, ANN, CAROL), MILL(BOB, CAROL)],
      [GROVE(ALICE, ANN, CAROL), MILL(BOB)],
    ]);
  });

  it('keeps a request hidden when an exclusive member joins another household too', async (t) => {
    await membershipChanges(t, { [SEERR_IDS[ANN]]: pending }, [
      [GROVE(ALICE, ANN), MILL(BOB)],
      [GROVE(ALICE, ANN), MILL(BOB, ANN)],
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

  it('draws Home\'s hero byte for byte the same in every other-household world', async (t) => {
    const dir = path.join(import.meta.dirname, '..', 'dist', 'app', 'js');
    const file = readdirSync(dir).filter((name) => /^render\.[0-9a-f]{12}\.js$/.test(name));
    assert.equal(file.length, 1, `render.js is built once: ${file}`);
    const { heroCarousel } = await import(pathToFileURL(path.join(dir, file[0])).href);
    const hero = async (state) => {
      const app = await startApp(t, state);
      const page = (await app.get(`${APP}/discover/trending`)).json();
      const { document } = parseHTML('<!doctype html><html><body></body></html>');
      const node = heroCarousel(document, page.results);
      assert.ok(node, 'the hero is drawn');
      const parts = (selector, read) => [...node.querySelectorAll(selector)].map(read).join('|');
      // Everything the hero says or links to, as strings (never DOM nodes).
      return JSON.stringify({
        html: node.outerHTML,
        pills: parts('.badge, .pill', (n) => n.textContent),
        text: node.textContent,
        links: parts('a', (n) => n.getAttribute('href')),
        buttons: parts('button', (n) => `${n.getAttribute('aria-label')}`),
      });
    };
    const expected = await hero(world());
    assert.match(expected, /hero-slide/);
    for (const [name, state] of Object.entries(otherHouseholdWorlds())) {
      assert.equal(await hero(state), expected, name);
    }
  });

  it('draws the network rows and pages, upcoming series and the studios strip byte for byte the same in every other-household world', async (t) => {
    const dir = path.join(import.meta.dirname, '..', 'dist', 'app', 'js');
    const file = readdirSync(dir).filter((name) => /^render\.[0-9a-f]{12}\.js$/.test(name));
    const { sourceRow, sourceHeading, sourceTabs, justWatchNote, studioStrip, titleRow, cardList } = await import(pathToFileURL(path.join(dir, file[0])).href);
    const drawn = async (state) => {
      const app = await startApp(t, state);
      const { networks, studios } = (await app.get(`${APP}/discover/sources`)).json();
      const { document } = parseHTML('<!doctype html><html><body></body></html>');
      const parts = [studioStrip(document, 'row-studios', studios)];
      parts.push(titleRow(document, 'row-upcoming-tv', 'Upcoming series', (await app.get(`${APP}/discover/upcoming-tv`)).json()));
      // The first three rows, and HBO Max's, drawn from two TMDB networks.
      for (const network of networks.filter((source, index) => index < 3 || source.id === 3186)) {
        // Home's rows: each service's series and films mixed.
        parts.push(sourceRow(document, `row-network-${network.id}`, 'network', network, (await app.get(`${APP}/discover/network/${network.id}/all`)).json()));
      }
      parts.push(justWatchNote(document));
      // A service's page, on each of its tabs.
      for (const list of ['all', 'series', 'films']) {
        const answer = (await app.get(`${APP}/discover/network/${networks[0].id}${list === 'series' ? '' : `/${list}`}?page=2`)).json();
        parts.push(sourceHeading(document, 'network', networks[0], list), sourceTabs(document, 'source-tab', 'source-panel', list), cardList(document, answer.results, 'grid'));
      }
      parts.push(sourceHeading(document, 'studio', studios[0]), cardList(document, (await app.get(`${APP}/discover/studio/${studios[0].id}`)).json().results, 'grid'));
      // Everything drawn, as strings (never DOM nodes).
      return parts.map((node) => node.outerHTML).join('\n');
    };
    const expected = await drawn(world());
    assert.match(expected, /Popular on/);
    assert.match(expected, /Synthetic Series Two/);
    assert.match(expected, /href="#\/network\/3186"[^]*alt="HBO Max"/);
    assert.match(expected, /Films on Netflix/);
    assert.match(expected, /JustWatch/);
    assert.match(expected, /Synthetic Movie One[^]*Synthetic Series Two[^]*Synthetic Movie Three/, 'a mixed row: film, series, film');
    for (const [name, state] of Object.entries(otherHouseholdWorlds())) assert.equal(await drawn(state), expected, name);
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
      assert.match(call.pathname, /^\/api\/v1\/(?:user\/jellyfin\/[0-9a-f]{32}|user\/[0-9]+(?:\/quota)?|auth\/me|blocklist)$/, call.path);
    }
    // Bob's long history is never read for household A.
    assert.ok(!app.seerr.calls.some((call) => call.actingUser === String(SEERR_IDS[BOB])));
  });
});

describe('household app API: identity', { timeout: 20_000 }, () => {
  it('reads only the caller\'s own permissions and quota as the caller, each call confirmed first, and titles never from Seerr', async (t) => {
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
      // Never the owner, never another member: only the caller's own Seerr user, for their own permissions and quota.
      assert.equal(call.method, 'GET');
      assert.equal(call.actingUser, String(SEERR_IDS[ALICE]));
      assert.ok(['/api/v1/auth/me', `/api/v1/user/${SEERR_IDS[ALICE]}/quota`].includes(call.pathname), call.pathname);
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
      assert.doesNotMatch(`${call.path}\n${JSON.stringify(call.headers)}`, /a11ce000|grove|token-alice|x-api-user|authorization/i);
    }
    assert.deepEqual(asAlice.map((call) => call.pathname), [
      '/3/search/multi', '/3/search/multi', '/3/trending/all/day', '/3/trending/movie/day', '/3/trending/tv/day', '/3/discover/movie',
      '/3/discover/tv', '/3/discover/movie', '/3/discover/tv', '/3/discover/movie', '/3/movie/top_rated', '/3/tv/top_rated',
      '/3/discover/tv', '/3/discover/movie', '/3/discover/movie',
      `/3/movie/${T_MOVIE}`, `/3/movie/${OWN_MOVIE}`, `/3/tv/${T_TV}`, `/3/tv/${T_TV}/season/1`, `/3/tv/${T_TV}/season/2`,
    ]);
  });
});

describe('household app API: networks, studios and upcoming series', { timeout: 60_000 }, () => {
  const tmdbCalls = (app) => app.tmdb.calls.filter((call) => call.pathname !== '/3/authentication');

  it('lists only the allowlisted networks and studios, with TMDB logos, without asking TMDB', async (t) => {
    const app = await startApp(t);
    const answer = await app.get(`${APP}/discover/sources`);
    assert.equal(answer.status, 200);
    const { networks, studios } = answer.json();
    assert.deepEqual(Object.keys(answer.json()), ['networks', 'studios']);
    assert.deepEqual(networks.map((network) => `${network.id} ${network.name}`), [
      '213 Netflix', '2739 Disney+', '2552 Apple TV', '1024 Prime Video', '3186 HBO Max', '453 Hulu', '4330 Paramount+', '3353 Peacock',
    ]);
    assert.deepEqual(studios.map((studio) => `${studio.id} ${studio.name}`), [
      '2 Disney', '127928 20th Century Studios', '34 Sony Pictures', '174 Warner Bros. Pictures', '33 Universal', '4 Paramount', '3 Pixar',
      '521 DreamWorks', '420 Marvel Studios', '9993 DC', '41077 A24',
    ]);
    for (const source of [...networks, ...studios]) {
      assert.deepEqual(Object.keys(source), networks.includes(source) ? ['id', 'name', 'logoUrl', 'hasFilms'] : ['id', 'name', 'logoUrl']);
      assert.match(source.logoUrl, LOGO, source.name);
    }
    // Every network's films can be listed (US where-to-watch data); the provider IDs themselves are never sent.
    assert.ok(networks.every((network) => network.hasFilms === true));
    assert.doesNotMatch(answer.text, /1796|2303|watch/);
    assert.equal(networks[0].logoUrl, 'https://image.tmdb.org/t/p/w300/wwemzKWzjKYJFfCeiB57q3r4Bcm.png');
    assert.equal(tmdbCalls(app).length, 0);
    // The same bytes for every household.
    assert.equal(serialized(await app.get(`${APP}/discover/sources`, { host: HOST_B, user: BOB })), serialized(answer));
  });

  it('refuses any network or studio not on the allowlist with the fixed 400, before TMDB is asked', async (t) => {
    const app = await startApp(t);
    for (const pathname of [
      `${APP}/discover/network/1`, `${APP}/discover/network/49`, `${APP}/discover/network/41077`, `${APP}/discover/network/0213`,
      `${APP}/discover/network/213.0`, `${APP}/discover/network/-213`, `${APP}/discover/network/abc`, `${APP}/discover/network/99999999999`,
      `${APP}/discover/studio/213`, `${APP}/discover/studio/1`, `${APP}/discover/studio/%32`, `${APP}/discover/network/213?page=0`,
      `${APP}/discover/network/213?page=501`, `${APP}/discover/studio/2?page=x`, `${APP}/discover/network/1?page=2`,
      `${APP}/discover/network/213/films?page=0`, `${APP}/discover/network/213/all?page=501`,
    ]) {
      const answer = await app.get(pathname);
      assert.equal(answer.status, 400, pathname);
      assert.equal(answer.text, '{"error":"invalid_request"}', pathname);
    }
    // A network's lists are `films` and `all` alone; a studio has none; an unlisted or malformed ID has none either.
    // Any other second segment is an unknown path, as in 2.6.0.
    for (const pathname of [`${APP}/discover/network`, `${APP}/discover/network/213/films/2`, `${APP}/discover/networks/213`, `${APP}/discover/company/2`,
      `${APP}/discover/network/213/films/`,
      `${APP}/discover/network/213/2`, `${APP}/discover/network/213/series`, `${APP}/discover/network/213/Films`,
      `${APP}/discover/network/213/movies`, `${APP}/discover/network/213/%66ilms`, `${APP}/discover/network/213/all%20`,
      `${APP}/discover/network/49/films`, `${APP}/discover/network/1/all`, `${APP}/discover/network/8/films`,
      `${APP}/discover/studio/2/films`, `${APP}/discover/studio/41077/all`, `${APP}/discover/studio/2/2`,
      `${APP}/discover/network/abc/films`, `${APP}/discover/network/0213/films`, `${APP}/discover/network/1/2?page=0`,
      `${APP}/discover/studio/1/films?page=x`]) {
      const answer = await app.get(pathname);
      assert.equal(answer.status, 404, pathname);
      assert.equal(answer.text, '{"error":"not_found"}', pathname);
    }
    assert.equal(tmdbCalls(app).length, 0, 'no TMDB call for a refused network or studio');
  });

  it('pages a network\'s popular series and a studio\'s popular movies, each card with the caller\'s state', async (t) => {
    const app = await startApp(t, world({ extraResults: 20 }));
    const network = (await app.get(`${APP}/discover/network/213`)).json();
    assert.deepEqual(Object.keys(network), ['page', 'nextPage', 'results']);
    assert.deepEqual(network.results.map((card) => `${card.mediaType} ${card.tmdbId} ${card.state}`), [`tv ${T_TV} get_this`]);
    assert.equal(network.nextPage, null, 'one series is not a full page');
    const studio = (await app.get(`${APP}/discover/studio/41077?page=2`)).json();
    assert.equal(studio.page, 2);
    assert.equal(studio.nextPage, 3, 'a full page of movies offers the next');
    assert.deepEqual(states({ results: studio.results.filter((card) => card.tmdbId < 910000) }), { [T_MOVIE]: 'get_this', [OWN_MOVIE]: 'in_library' });
    assert.ok(studio.results.every((card) => card.mediaType === 'movie'));
    const upcoming = (await app.get(`${APP}/discover/upcoming-tv`)).json();
    assert.deepEqual(upcoming.results.map((card) => `${card.mediaType} ${card.tmdbId}`), [`tv ${T_TV}`]);
    const [networkCall, studioCall, upcomingCall] = tmdbCalls(app);
    assert.equal(networkCall.pathname, '/3/discover/tv');
    assert.equal(networkCall.query.get('with_networks'), '213');
    assert.equal(networkCall.query.get('sort_by'), 'popularity.desc');
    assert.equal(studioCall.pathname, '/3/discover/movie');
    assert.equal(studioCall.query.get('with_companies'), '41077');
    assert.equal(studioCall.query.get('page'), '2');
    assert.equal(upcomingCall.pathname, '/3/discover/tv');
    assert.match(upcomingCall.query.get('first_air_date.gte'), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(upcomingCall.query.has('with_networks'), false);
  });

  it('lists HBO Max\'s row with HBO\'s own series under HBO Max\'s ID, and HBO\'s ID on its own not at all', async (t) => {
    const app = await startApp(t);
    const answer = await app.get(`${APP}/discover/network/3186`);
    assert.equal(answer.status, 200);
    assert.deepEqual(answer.json().results.map((card) => `${card.mediaType} ${card.tmdbId}`), [`tv ${T_TV}`]);
    for (const pathname of [`${APP}/discover/network/49`, `${APP}/discover/network/3186%7C49`, `${APP}/discover/network/3186|49`, `${APP}/discover/network/49?page=2`]) {
      const refused = await app.get(pathname);
      assert.equal(refused.status, 400, pathname);
      assert.equal(refused.text, '{"error":"invalid_request"}', pathname);
    }
    // A caller's own with_networks is ignored: the same answer, from the cache.
    assert.equal(serialized(await app.get(`${APP}/discover/network/3186?with_networks=1`, { user: ANN })), serialized(answer));
    const sent = tmdbCalls(app).map((call) => call.query.get('with_networks'));
    assert.deepEqual(sent, ['3186|49'], 'one TMDB call, cached under 3186, for both HBO Max answers');
  });

  it('caches network and studio pages per household, by network and page, and never across households', async (t) => {
    const app = await startApp(t);
    const reads = () => tmdbCalls(app).length;
    await app.get(`${APP}/discover/network/213`);
    await app.get(`${APP}/discover/network/213`, { user: ANN });
    assert.equal(reads(), 1);
    await app.get(`${APP}/discover/network/213?page=2`);
    await app.get(`${APP}/discover/network/2739`);
    await app.get(`${APP}/discover/studio/2`);
    assert.equal(reads(), 4);
    await app.get(`${APP}/discover/network/213`, { host: HOST_B, user: BOB });
    assert.equal(reads(), 5, 'household B is not answered from A\'s cache');
  });

  it('keeps network and studio pages within the household\'s 500 cached answers', async (t) => {
    let now = Date.parse('2026-10-24T12:00:00.000Z');
    const day = 24 * 60 * 60 * 1000;
    const app = await startApp(t, world(), { now: () => now, titleTtlMs: day, catalogueLimits: { perSecond: 10_000, burst: 10_000 } });
    const reads = (pathname) => tmdbCalls(app).filter((call) => call.path.includes(pathname)).length;
    let calls = 0;
    const ask = async (pathname) => {
      // Past the household's 10-second burst, and each 5-minute budget every 250 calls; cached answers are kept for a day.
      if (++calls % 50 === 0) now += 61_000;
      const answer = await app.get(pathname, { user: calls % 2 ? ALICE : ANN });
      assert.equal(answer.status, 200, pathname);
    };
    await ask(`${APP}/discover/network/213`);
    // 500 more answers: every page of Netflix's after the first, then one of Disney+'s.
    for (let page = 2; page <= 500; page += 1) await ask(`${APP}/discover/network/213?page=${page}`);
    await ask(`${APP}/discover/network/2739`);
    assert.equal(tmdbCalls(app).length, 501);
    // The oldest is forgotten: asking for it again goes to TMDB; the newest is still kept.
    await ask(`${APP}/discover/network/2739`);
    assert.equal(tmdbCalls(app).length, 501);
    await ask(`${APP}/discover/network/213`);
    assert.equal(reads('with_networks=213'), 501, 'the first page was evicted and read again');
  });

  it('keeps household A\'s TMDB turn while household B asks for every network and studio page at once', async (t) => {
    const app = await startApp(t, world(), { catalogueLimits: {} });
    assert.equal((await app.get(`${APP}/discover/sources`, { host: HOST_B, user: BOB })).status, 200);
    const { networks, studios } = (await app.get(`${APP}/discover/sources`)).json();
    const paths = [...networks.map((network) => `network/${network.id}`), ...studios.map((studio) => `studio/${studio.id}`)]
      .flatMap((source) => [1, 2].map((page) => `${APP}/discover/${source}?page=${page}`));
    assert.equal(paths.length, 38);
    const bursts = paths.map((pathname) => app.get(pathname, { host: HOST_B, user: BOB }));
    await delay(100);
    const started = performance.now();
    const alice = await app.get(`${APP}/discover/network/213?page=9`);
    const waited = performance.now() - started;
    const bob = await Promise.all(bursts);
    assert.equal(alice.status, 200, alice.text);
    assert.ok(waited < 1000, `A waited ${waited} ms`);
    // B's burst only costs B: past its 20 waiting TMDB calls, the fixed 429; the rest answered.
    for (const answer of bob) assert.ok(answer.status === 200 || answer.text === '{"error":"too_many_requests"}', `${answer.status} ${answer.text}`);
    const times = app.tmdb.calls.map((call) => call.at);
    for (const first of times) assert.ok(times.filter((time) => time >= first && time < first + 1000).length <= 30);
  });
});

describe('household app API: films on a service (US where to watch)', { timeout: 60_000 }, () => {
  const tmdbCalls = (app) => app.tmdb.calls.filter((call) => call.pathname !== '/3/authentication');
  const PROVIDERS = {
    213: '8|1796', 2739: '337', 2552: '350', 1024: '9|2100', 3186: '1899', 453: '15', 4330: '2303|2616', 3353: '386|387',
  };
  const sent = (call) => [...call.query].filter(([name]) => name !== 'api_key').map(([name, value]) => `${name}=${value}`).join('&');

  it('asks TMDB for each service\'s films by its US watch providers, flatrate, by popularity, and nothing else', async (t) => {
    const app = await startApp(t);
    for (const id of Object.keys(PROVIDERS)) assert.equal((await app.get(`${APP}/discover/network/${id}/films?page=2`)).status, 200, id);
    assert.deepEqual(tmdbCalls(app).map((call) => `${call.pathname}?${sent(call)}`), Object.values(PROVIDERS).map((providers) =>
      `/3/discover/movie?page=2&sort_by=popularity.desc&include_adult=false&watch_region=US&with_watch_providers=${providers}`
      + '&with_watch_monetization_types=flatrate&language=en-US'));
  });

  it('ignores the caller\'s own query parameters: the same TMDB call, and the same answer from the cache', async (t) => {
    const app = await startApp(t);
    const answer = await app.get(`${APP}/discover/network/213/films`);
    assert.equal(answer.status, 200);
    for (const query of [
      'watch_region=GB', 'with_watch_providers=1', 'with_watch_monetization_types=rent', 'kind=series', 'with_networks=49',
      'sort_by=vote_average.desc&include_adult=true', 'language=fr-FR&region=GB', 'api_key=x',
    ]) {
      assert.equal(serialized(await app.get(`${APP}/discover/network/213/films?${query}`, { user: ANN })), serialized(answer), query);
    }
    assert.deepEqual(tmdbCalls(app).map(sent), [
      'page=1&sort_by=popularity.desc&include_adult=false&watch_region=US&with_watch_providers=8|1796&with_watch_monetization_types=flatrate&language=en-US',
    ]);
  });

  it('mixes a service\'s films and series, film first, alternating, with each card\'s type and the caller\'s state', async (t) => {
    const app = await startApp(t, world({ extraResults: 20 }));
    const all = (await app.get(`${APP}/discover/network/213/all`)).json();
    assert.deepEqual(Object.keys(all), ['page', 'nextPage', 'results']);
    assert.deepEqual(all.results.slice(0, 4).map((card) => `${card.mediaType} ${card.tmdbId} ${card.state}`),
      [`movie ${T_MOVIE} get_this`, `tv ${T_TV} get_this`, `movie ${OWN_MOVIE} in_library`, 'movie 910000 get_this']);
    assert.equal(all.results.filter((card) => card.mediaType === 'tv').length, 1, 'nothing is dropped or repeated');
    assert.equal(all.results.length, 23);
    assert.equal(all.nextPage, 2, 'a full page of films offers the next');
    // Two TMDB calls, one per kind, each under its own cache key: the Series and Films lists are answered from them.
    assert.deepEqual(tmdbCalls(app).map((call) => `${call.pathname} ${call.query.get('with_networks') ?? call.query.get('with_watch_providers')}`).sort(),
      ['/3/discover/movie 8|1796', '/3/discover/tv 213']);
    const series = (await app.get(`${APP}/discover/network/213`)).json();
    const films = (await app.get(`${APP}/discover/network/213/films`)).json();
    assert.equal(tmdbCalls(app).length, 2);
    assert.deepEqual(series.results.map((card) => card.mediaType), ['tv']);
    assert.ok(films.results.every((card) => card.mediaType === 'movie'));
    assert.equal(films.results.length, 22);
  });

  /**
   * TMDB's discover lists with a different set of titles on every page: `pages` full pages (20) and then a last page of
   * `last`, nothing after. Films are 5PPII, series 6PPII (P the page, II the index), so no two pages share a title.
   */
  const pagedDiscover = (counts) => (type, page) => {
    const { pages, last } = counts[type];
    const length = page <= pages ? 20 : page === pages + 1 ? last : 0;
    return Array.from({ length }, (_, index) => {
      const id = (type === 'movie' ? 500000 : 600000) + page * 100 + index;
      return type === 'movie'
        ? { id, title: `Film ${id}`, release_date: '2020-01-01', poster_path: `/synthetic-poster-${id}.jpg` }
        : { id, name: `Series ${id}`, first_air_date: '2020-01-01', poster_path: `/synthetic-poster-${id}.jpg` };
    });
  };
  const ids = (type, counts, page) => pagedDiscover(counts)(type, page).map((entry) => `${type} ${entry.id}`);
  /** The page the API should answer: that page's films and series alternating, film first, the longer one's rest after. */
  const expectedPage = (counts, page) => {
    const [films, series] = [ids('movie', counts, page), ids('tv', counts, page)];
    return Array.from({ length: Math.max(films.length, series.length) }, (_, index) => [films[index], series[index]])
      .flat().filter((card) => card !== undefined);
  };
  /** Loads a service's mixed list with Load more (each answer's nextPage) until it ends: every page's cards and nextPage. */
  const loadAll = async (app) => {
    const pages = [];
    for (let page = 1; page !== null; page = pages.at(-1).nextPage) {
      assert.ok(page <= 20, 'Load more ends');
      const answer = (await app.get(`${APP}/discover/network/213/all?page=${page}`)).json();
      assert.equal(answer.page, page);
      pages.push({ page, nextPage: answer.nextPage, cards: answer.results.map((card) => `${card.mediaType} ${card.tmdbId}`) });
    }
    return pages;
  };
  const allIds = (counts) => {
    const last = Math.max(counts.movie.pages, counts.tv.pages) + 1;
    return Array.from({ length: last }, (_, page) => [...ids('movie', counts, page + 1), ...ids('tv', counts, page + 1)]).flat();
  };

  it('pages a service\'s mix on after its films run out: the series alone, then the end', async (t) => {
    // Films: pages 1-2 full, 5 on page 3. Series: pages 1-4 full, 7 on page 5.
    const counts = { movie: { pages: 2, last: 5 }, tv: { pages: 4, last: 7 } };
    const app = await startApp(t, world({ tmdbDiscover: pagedDiscover(counts) }));
    const pages = await loadAll(app);
    assert.deepEqual(pages.map((page) => `${page.page}>${page.nextPage}`), ['1>2', '2>3', '3>4', '4>5', '5>null'],
      'as many pages as the longer list (the series, 5)');
    for (const page of pages) assert.deepEqual(page.cards, expectedPage(counts, page.page), `page ${page.page}`);
    // Page 3: the films' last 5, alternating with the first 5 series, then the other 15 series.
    assert.deepEqual(pages[2].cards.slice(0, 10).map((card) => card.split(' ')[0]), Array(5).fill(['movie', 'tv']).flat());
    assert.deepEqual(pages[2].cards.slice(10).map((card) => card.split(' ')[0]), Array(15).fill('tv'));
    assert.equal(pages[2].cards.length, 25);
    // Pages 4 and 5: the series alone.
    assert.deepEqual(pages.slice(3).map((page) => page.cards.filter((card) => card.startsWith('movie ')).length), [0, 0]);
    assert.deepEqual(pages.slice(3).map((page) => page.cards.length), [20, 7]);
    const cards = pages.flatMap((page) => page.cards);
    assert.equal(new Set(cards).size, cards.length, 'no card twice');
    assert.deepEqual([...cards].sort(), allIds(counts).sort(), 'every film and series, none missing');
    assert.equal(cards.length, 2 * 20 + 5 + 4 * 20 + 7);
  });

  it('pages a service\'s mix on after its series run out: the films alone, then the end', async (t) => {
    // Series: page 1 full, 3 on page 2. Films: pages 1-3 full, 11 on page 4.
    const counts = { movie: { pages: 3, last: 11 }, tv: { pages: 1, last: 3 } };
    const app = await startApp(t, world({ tmdbDiscover: pagedDiscover(counts) }));
    const pages = await loadAll(app);
    assert.deepEqual(pages.map((page) => `${page.page}>${page.nextPage}`), ['1>2', '2>3', '3>4', '4>null'],
      'as many pages as the longer list (the films, 4)');
    for (const page of pages) assert.deepEqual(page.cards, expectedPage(counts, page.page), `page ${page.page}`);
    // Page 2: 3 series alternating with the first 3 films, then the other 17 films.
    assert.deepEqual(pages[1].cards.slice(0, 6).map((card) => card.split(' ')[0]), Array(3).fill(['movie', 'tv']).flat());
    assert.deepEqual(pages[1].cards.slice(6).map((card) => card.split(' ')[0]), Array(17).fill('movie'));
    // Pages 3 and 4: the films alone.
    assert.deepEqual(pages.slice(2).map((page) => page.cards.filter((card) => card.startsWith('tv ')).length), [0, 0]);
    assert.deepEqual(pages.slice(2).map((page) => page.cards.length), [20, 11]);
    const cards = pages.flatMap((page) => page.cards);
    assert.equal(new Set(cards).size, cards.length, 'no card twice');
    assert.deepEqual([...cards].sort(), allIds(counts).sort(), 'every film and series, none missing');
    assert.equal(cards.length, 3 * 20 + 11 + 20 + 3);
    // Past the end: nothing, and no next page.
    const past = (await app.get(`${APP}/discover/network/213/all?page=5`)).json();
    assert.deepEqual([past.page, past.nextPage, past.results.length], [5, null, 0]);
  });

  it('caches films apart from series, per service and page, and never across households', async (t) => {
    const app = await startApp(t);
    const reads = () => tmdbCalls(app).length;
    await app.get(`${APP}/discover/network/213`);
    await app.get(`${APP}/discover/network/213/films`);
    assert.equal(reads(), 2, 'a service\'s films are not its series');
    await app.get(`${APP}/discover/network/213/films`, { user: ANN });
    await app.get(`${APP}/discover/network/213/all`, { user: ANN });
    assert.equal(reads(), 2);
    await app.get(`${APP}/discover/network/213/films?page=2`);
    await app.get(`${APP}/discover/network/2739/films`);
    await app.get(`${APP}/discover/studio/2`);
    assert.equal(reads(), 5);
    await app.get(`${APP}/discover/network/213/films`, { host: HOST_B, user: BOB });
    assert.equal(reads(), 6, 'household B is not answered from A\'s cache');
    await app.get(`${APP}/discover/network/213/all`, { host: HOST_B, user: BOB });
    assert.equal(reads(), 7, 'B\'s mixed row reads B\'s own series');
  });

  it('keeps household A\'s TMDB turn while household B scrolls every service\'s mixed, series and films lists', async (t) => {
    const app = await startApp(t, world(), { catalogueLimits: {} });
    const ids = Object.keys(PROVIDERS);
    const paths = ids.flatMap((id) => [1, 2].flatMap((page) => ['/all', '', '/films'].map((list) => `${APP}/discover/network/${id}${list}?page=${page}`)));
    assert.equal(paths.length, 48);
    const bursts = paths.map((pathname) => app.get(pathname, { host: HOST_B, user: BOB }));
    await delay(100);
    const started = performance.now();
    const alice = await app.get(`${APP}/discover/network/213/all?page=9`);
    const waited = performance.now() - started;
    const bob = await Promise.all(bursts);
    assert.equal(alice.status, 200, alice.text);
    assert.ok(waited < 1000, `A waited ${waited} ms`);
    for (const answer of bob) assert.ok(answer.status === 200 || answer.text === '{"error":"too_many_requests"}', `${answer.status} ${answer.text}`);
    const times = app.tmdb.calls.map((call) => call.at);
    for (const first of times) assert.ok(times.filter((time) => time >= first && time < first + 1000).length <= 30);
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
    const refusal = await fetch(`http://127.0.0.1:${app.adminPort}/v1/groups/one-too-many`, {
      method: 'PUT',
      headers: { Authorization: 'Bearer admin-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Too many', userIds: [] }),
    });
    assert.equal(refusal.status, 400);
    assert.deepEqual(await refusal.json(), { error: 'groups must be at most 100' });
    // Renaming or changing an existing household is still allowed at the limit.
    await app.store.upsertGroup({ id: 'grove', name: 'Grove', userIds: [ALICE, ANN] });
  });

  it('caches nothing for any household when a state file holds more households than supported, and still loads it', async (t) => {
    const at = '2026-10-24T12:00:00.000Z';
    const groups = Object.fromEntries([
      { id: 'grove', name: 'Grove', userIds: [ALICE, ANN].sort() },
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
  const putGroup = (app, id) => fetch(`http://127.0.0.1:${app.adminPort}/v1/groups/${id}`, {
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
      assert.deepEqual(answer.json(), { name: 'Alice', household: 'Grove', apiVersion: 4 }, JSON.stringify(headers));
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
    await app.store.upsertGroup({ id: 'grove', name: 'Grove', userIds: [ANN] });
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
    // The admin listener, whatever the host; on the member listener a host that is no household's is a fixed 421.
    for (const host of ['jellypass.example.test', '127.0.0.1']) {
      const asMember = await get(app.adminPort, `${APP}/me`, { Host: host, Authorization: authorization(ALICE) });
      assert.equal(asMember.status, 401);
      assert.equal(asMember.text, UNAUTHORIZED);
      const asAdmin = await get(app.adminPort, `${APP}/search?q=synthetic`, { Host: host, Authorization: 'Bearer admin-secret' });
      assert.equal(asAdmin.status, 404);
      assert.deepEqual(asAdmin.json(), { error: 'not_found' });
      assert.equal((await get(app.port, `${APP}/me`, { Host: host, Authorization: authorization(ALICE) })).status, 421);
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
    for (const pathname of [`${APP}/movie/404404`, `${APP}/tv/404404`, `${APP}/tv/${T_TV}/season/9`, `${APP}/discover/everything`, `${APP}/requests/x`, `${APP}/movie/${T_MOVIE}/get`, `${APP}/`, `${APP}`]) {
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

describe('household app API: Home\'s per-kind trending, new releases and all-time great lists', { timeout: 60_000 }, () => {
  const tmdbCalls = (app) => app.tmdb.calls.filter((call) => call.pathname !== '/3/authentication');
  const NOW = Date.parse('2026-10-24T12:00:00.000Z');
  const LISTS = ['trending-movies', 'trending-tv', 'new-movies', 'top-movies', 'top-tv'];

  it('asks TMDB for each list the way it is documented, and for nothing else', async (t) => {
    const app = await startApp(t, world(), { now: () => NOW });
    for (const list of LISTS) assert.equal((await app.get(`${APP}/discover/${list}?page=2`)).status, 200, list);
    const calls = tmdbCalls(app).map((call) => `${call.pathname} ${[...call.query].filter(([name]) => name !== 'api_key').map(([name, value]) => `${name}=${value}`).join('&')}`);
    assert.deepEqual(calls, [
      '/3/trending/movie/day page=2&language=en-US',
      '/3/trending/tv/day page=2&language=en-US',
      // Opened in US theatres (release types 2 and 3) in the 60 days up to today.
      '/3/discover/movie page=2&sort_by=popularity.desc&include_adult=false&region=US&with_release_type=2|3&release_date.gte=2026-08-25&release_date.lte=2026-10-24&language=en-US',
      '/3/movie/top_rated page=2&language=en-US',
      '/3/tv/top_rated page=2&language=en-US',
    ]);
  });

  it('answers cards of one kind for a per-kind list: movies from the movie lists, series from the series lists', async (t) => {
    const app = await startApp(t);
    const kinds = {};
    for (const list of LISTS) {
      const page = (await app.get(`${APP}/discover/${list}`)).json();
      assert.deepEqual(Object.keys(page), ['page', 'nextPage', 'results']);
      assert.ok(page.results.length > 0, list);
      kinds[list] = [...new Set(page.results.map((card) => card.mediaType))].join();
    }
    assert.deepEqual(kinds, { 'trending-movies': 'movie', 'trending-tv': 'tv', 'new-movies': 'movie', 'top-movies': 'movie', 'top-tv': 'tv' });
    assert.deepEqual(states((await app.get(`${APP}/discover/top-movies`)).json()), { [T_MOVIE]: 'get_this', [OWN_MOVIE]: 'in_library' });
    assert.deepEqual(states((await app.get(`${APP}/discover/top-tv`)).json()), { [T_TV]: 'get_this' });
  });

  it('refuses a bad page with the fixed 400 and any other spelling of a list with the fixed 404, before TMDB', async (t) => {
    const app = await startApp(t);
    for (const list of LISTS) {
      for (const query of ['page=0', 'page=501', 'page=x', 'page=1.5']) {
        const answer = await app.get(`${APP}/discover/${list}?${query}`);
        assert.equal(answer.status, 400, `${list} ${query}`);
        assert.equal(answer.text, '{"error":"invalid_request"}');
      }
    }
    for (const pathname of [`${APP}/discover/Top-Movies`, `${APP}/discover/top_movies`, `${APP}/discover/top-movies/`, `${APP}/discover/top-movies/2`,
      `${APP}/discover/trending/movie`, `${APP}/discover/trending-all`, `${APP}/discover/new`, `${APP}/discover/top-rated`, `${APP}/discover/now-playing`]) {
      const answer = await app.get(pathname);
      assert.equal(answer.status, 404, pathname);
      assert.equal(answer.text, '{"error":"not_found"}', pathname);
    }
    assert.equal(tmdbCalls(app).length, 0);
  });

  it('ignores the caller\'s own query parameters: the same TMDB call, and the same answer from the cache', async (t) => {
    const app = await startApp(t, world(), { now: () => NOW });
    const plain = await app.get(`${APP}/discover/new-movies`);
    for (const list of LISTS) await app.get(`${APP}/discover/${list}?with_genres=27&sort_by=revenue.desc&region=DE&include_adult=true&language=de`, { user: ANN });
    assert.equal(serialized(await app.get(`${APP}/discover/new-movies?region=DE&release_date.gte=1900-01-01`, { user: ANN })), serialized(plain));
    const sent = tmdbCalls(app).map((call) => call.path);
    assert.equal(sent.length, 5, 'one TMDB call per list, new-movies answered once');
    assert.ok(sent.every((path) => !/with_genres|revenue|DE|true|1900|language=de/.test(path)), sent.join('\n'));
  });

  it('caches each list per household and page, and never across households', async (t) => {
    const app = await startApp(t);
    for (const list of LISTS) {
      await app.get(`${APP}/discover/${list}`);
      await app.get(`${APP}/discover/${list}`, { user: ANN });
    }
    assert.equal(tmdbCalls(app).length, 5);
    for (const list of LISTS) await app.get(`${APP}/discover/${list}?page=2`);
    assert.equal(tmdbCalls(app).length, 10, 'another page is another entry');
    for (const list of LISTS) await app.get(`${APP}/discover/${list}`, { host: HOST_B, user: BOB });
    assert.equal(tmdbCalls(app).length, 15, 'household B is not answered from A\'s cache');
  });

  it('answers byte for byte the same whatever other households hold, ask for or wait on', async (t) => {
    const seen = {};
    for (const [name, state] of Object.entries({ baseline: world(), ...otherHouseholdWorlds() })) {
      const app = await startApp(t, state);
      seen[name] = (await Promise.all(LISTS.map(async (list) => serialized(await app.get(`${APP}/discover/${list}`))))).join('\n---\n');
    }
    assert.ok(Object.keys(seen).length >= 5);
    for (const [name, text] of Object.entries(seen)) assert.equal(text, seen.baseline, name);
  });

  it('keeps household A\'s TMDB turn while household B asks for every new list and page at once', async (t) => {
    const app = await startApp(t, world(), { catalogueLimits: {} });
    const paths = LISTS.flatMap((list) => Array.from({ length: 8 }, (_, index) => `${APP}/discover/${list}?page=${index + 1}`));
    const bursts = paths.map((pathname) => app.get(pathname, { host: HOST_B, user: BOB }));
    await delay(100);
    const started = performance.now();
    const alice = await app.get(`${APP}/discover/top-tv?page=9`);
    const waited = performance.now() - started;
    const bob = await Promise.all(bursts);
    assert.equal(alice.status, 200, alice.text);
    assert.ok(waited < 1000, `A waited ${waited} ms`);
    for (const answer of bob) assert.ok(answer.status === 200 || answer.text === '{"error":"too_many_requests"}', `${answer.status} ${answer.text}`);
    const times = app.tmdb.calls.map((call) => call.at);
    for (const first of times) assert.ok(times.filter((time) => time >= first && time < first + 1000).length <= 30);
  });
});
