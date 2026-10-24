// Writes the synthetic Seerr 3.5.1 fixtures in 3.5.1/: node test/seerr-fixtures/generate.mjs
// Their key structure follows responses recorded from a real ghcr.io/seerr-team/seerr:v3.5.1 container; every value is
// made up. Every user-ish value is a canary (see test/support/seerr-fixtures.mjs): it must never reach a household.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '3.5.1');
mkdirSync(out, { recursive: true });

let n = 0;
const num = () => 7_300_000 + (++n);              // numeric canary
const ts = (d) => `2001-0${1 + (d % 9)}-0${1 + (d % 9)}T0${d % 10}:0${d % 10}:0${d % 10}.00${d % 10}Z`; // timestamp canary
let t = 0;
const time = () => ts(++t);
const guid = (i) => `c0ffee00c0ffee00${String(i).padStart(16, '0')}`;

function user(label, i, permissions = 32) {
  return {
    permissions,
    warnings: [],
    id: num(),
    email: `canary-${label}@example.invalid`,
    plexUsername: `canary-${label}-plex`,
    jellyfinUsername: `canary-${label}-jellyfin`,
    username: `canary-${label}`,
    recoveryLinkExpirationDate: null,
    userType: 3,
    plexId: null,
    jellyfinUserId: guid(i),
    avatar: `/avatarproxy/canary-${label}-avatar`,
    avatarETag: `canary-${label}-etag`,
    avatarVersion: `canary-${label}-avatar-version`,
    movieQuotaLimit: null,
    movieQuotaDays: null,
    tvQuotaLimit: null,
    tvQuotaDays: null,
    createdAt: time(),
    updatedAt: time(),
    requestCount: num(),
    displayName: `Canary ${label[0].toUpperCase()}${label.slice(1)}`,
  };
}

// The caller, and two people who must never show up in a caller's response.
const self = () => user('self', 1);
const other = () => user('otherhousehold', 2);
const owner = () => user('owner', 3, 2);

function media(mediaType, tmdbId, status, extra = {}) {
  return {
    downloadStatus: [],
    downloadStatus4k: [],
    id: num(),
    mediaType,
    tmdbId,
    tvdbId: mediaType === 'tv' ? 800_002 : null,
    imdbId: null,
    status,
    status4k: 1,
    createdAt: time(),
    updatedAt: time(),
    lastSeasonChange: time(),
    mediaAddedAt: time(),
    serviceId: num(),
    serviceId4k: null,
    externalServiceId: num(),
    externalServiceId4k: null,
    externalServiceSlug: 'canary-service-slug',
    externalServiceSlug4k: null,
    ratingKey: null,
    ratingKey4k: null,
    jellyfinMediaId: guid(100 + tmdbId % 100),
    jellyfinMediaId4k: guid(200 + tmdbId % 100),
    ...extra,
  };
}

function request(type, mediaRecord, requestedBy, { status = 2, modifiedBy = null, seasons } = {}) {
  return {
    id: num(),
    status,
    createdAt: time(),
    updatedAt: time(),
    type,
    is4k: false,
    serverId: num(),
    profileId: num(),
    rootFolder: '/canary/root-folder',
    languageProfileId: null,
    tags: null,
    isAutoRequest: false,
    ignoreQuota: false,
    media: mediaRecord,
    requestedBy,
    modifiedBy,
    seasons: (seasons ?? []).map((seasonNumber) => ({ id: num(), seasonNumber, status, createdAt: time(), updatedAt: time() })),
    seasonCount: (seasons ?? []).length,
  };
}

function issue() {
  return {
    id: num(),
    issueType: 1,
    status: 1,
    problemSeason: 0,
    problemEpisode: 0,
    createdAt: time(),
    updatedAt: time(),
    createdBy: other(),
    modifiedBy: owner(),
    comments: [{ id: num(), message: 'canary issue comment: audio out of sync on 192.0.2.10', createdAt: time(), updatedAt: time(), user: other() }],
  };
}

function downloadStatus(title) {
  return [{
    externalId: num(),
    estimatedCompletionTime: time(),
    mediaType: 'movie',
    size: num(),
    sizeLeft: num(),
    status: 'downloading',
    timeLeft: '00:42:00',
    title: `canary download ${title}`,
    downloadId: 'canary-download-id',
  }];
}

const write = (name, value) => writeFileSync(path.join(out, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);

// GET /api/v1/search?query=synthetic&page=1
write('search', {
  page: 1,
  totalPages: num(),
  totalResults: num(),
  results: [
    {
      id: 900001, mediaType: 'movie', adult: false, genreIds: [28, 878], originalLanguage: 'en',
      originalTitle: 'Synthetic Movie One', overview: 'A synthetic film used only in tests.', popularity: 12.5,
      releaseDate: '2020-05-01', title: 'Synthetic Movie One', video: false, voteAverage: 7.1, voteCount: 1200,
      backdropPath: '/synthetic-backdrop-900001.jpg', posterPath: '/synthetic-poster-900001.jpg',
      // Held privately by another household: available, with their request and watchlist entry attached.
      mediaInfo: { ...media('movie', 900001, 5), watchlists: [{ id: num(), ratingKey: '', mediaType: 'movie', title: 'Synthetic Movie One', tmdbId: 900001, createdAt: time(), updatedAt: time(), requestedBy: other() }] },
    },
    {
      id: 900002, firstAirDate: '2019-09-01', genreIds: [18], mediaType: 'tv', name: 'Synthetic Series Two',
      originCountry: ['US'], originalLanguage: 'en', originalName: 'Synthetic Series Two',
      overview: 'A synthetic series used only in tests.', popularity: 8.25, voteAverage: 6.9, voteCount: 300,
      backdropPath: '/synthetic-backdrop-900002.jpg', posterPath: '/synthetic-poster-900002.jpg',
      mediaInfo: { ...media('tv', 900002, 3, { downloadStatus: downloadStatus('Synthetic Series Two S01E01') }), watchlists: [] },
    },
    {
      id: 900003, mediaType: 'movie', adult: false, genreIds: [35], originalLanguage: 'en',
      originalTitle: 'Synthetic Movie Three', overview: 'Not in Seerr yet.', popularity: 3.5,
      releaseDate: '2024-02-02', title: 'Synthetic Movie Three', video: false, voteAverage: 5.5, voteCount: 40,
      backdropPath: null, posterPath: '/synthetic-poster-900003.jpg',
    },
    {
      id: 900004, name: 'Synthetic Person', popularity: 2.5, adult: false, mediaType: 'person', profilePath: null,
      knownFor: [{ id: 900003, mediaType: 'movie', title: 'Synthetic Movie Three', posterPath: '/synthetic-poster-900003.jpg' }],
    },
  ],
});

// GET /api/v1/movie/900001: available, requested by another household, approved by the owner, with an open issue.
{
  const record = media('movie', 900001, 5, { downloadStatus: downloadStatus('Synthetic Movie One') });
  const { downloadStatus: _d, downloadStatus4k: _d4, ...nested } = record;
  write('movie', {
    id: 900001, adult: false, budget: 1000000,
    genres: [{ id: 28, name: 'Action' }, { id: 878, name: 'Science Fiction' }],
    relatedVideos: [{ site: 'YouTube', key: 'synthetic-trailer', name: 'Synthetic Trailer', size: 1080, type: 'Trailer', url: 'https://www.youtube.com/watch?v=synthetic-trailer' }],
    originalLanguage: 'en', originalTitle: 'Synthetic Movie One', popularity: 12.5,
    productionCompanies: [{ id: 900100, name: 'Synthetic Pictures', originCountry: 'US', logoPath: null }],
    productionCountries: [{ iso_3166_1: 'US', name: 'United States of America' }],
    releaseDate: '2020-05-01',
    releases: { results: [{ iso_3166_1: 'US', release_dates: [{ certification: 'PG-13', descriptors: [], iso_639_1: '', note: '', release_date: '2020-05-01T00:00:00.000Z', type: 3 }] }] },
    revenue: 2000000,
    spokenLanguages: [{ english_name: 'English', iso_639_1: 'en', name: 'English' }],
    status: 'Released', title: 'Synthetic Movie One', video: false, voteAverage: 7.1, voteCount: 1200,
    backdropPath: '/synthetic-backdrop-900001.jpg', homepage: 'https://synthetic-movie.example.invalid/',
    imdbId: 'tt9000001', overview: 'A synthetic film used only in tests.', posterPath: '/synthetic-poster-900001.jpg',
    runtime: 101, tagline: 'Entirely made up.',
    credits: {
      cast: [{ castId: 1, character: 'Lead', creditId: 'synthetic-credit-1', id: 900201, name: 'Synthetic Actor', order: 0, gender: 0, profilePath: null }],
      crew: [{ creditId: 'synthetic-credit-2', department: 'Directing', id: 900202, job: 'Director', name: 'Synthetic Director', gender: 0, profilePath: null }],
    },
    collection: null,
    externalIds: { facebookId: null, imdbId: 'tt9000001', instagramId: null, twitterId: null },
    mediaInfo: {
      ...record,
      requests: [request('movie', nested, other(), { status: 2, modifiedBy: owner() })],
      issues: [issue()],
      seasons: [],
    },
    watchProviders: [{ iso_3166_1: 'US', link: 'https://www.themoviedb.org/movie/900001/watch?locale=US', buy: [], flatrate: [] }],
    keywords: [{ id: 900301, name: 'synthetic' }],
    onUserWatchlist: false,
  });
}

// GET /api/v1/tv/900002: season 1 requested by the caller, season 2 by another household (approved by the owner).
{
  const record = media('tv', 900002, 3);
  const { downloadStatus: _d, downloadStatus4k: _d4, ...nested } = record;
  write('tv', {
    createdBy: [{ id: 900401, credit_id: 'synthetic-credit-3', name: 'Synthetic Creator', original_name: 'Synthetic Creator', gender: 0, profile_path: null }],
    episodeRunTime: [], firstAirDate: '2019-09-01',
    genres: [{ id: 18, name: 'Drama' }],
    relatedVideos: [],
    homepage: 'https://synthetic-series.example.invalid/', id: 900002, inProduction: false, languages: ['en'],
    lastAirDate: '2021-10-01', name: 'Synthetic Series Two',
    networks: [{ id: 900501, name: 'Synthetic Network', originCountry: 'US', logoPath: null }],
    numberOfEpisodes: 6, numberOfSeasons: 2, originCountry: ['US'], originalLanguage: 'en',
    originalName: 'Synthetic Series Two', tagline: '', overview: 'A synthetic series used only in tests.', popularity: 8.25,
    productionCompanies: [], productionCountries: [{ iso_3166_1: 'US', name: 'United States of America' }],
    contentRatings: { results: [{ descriptors: [], iso_3166_1: 'US', rating: 'TV-14' }] },
    spokenLanguages: [{ englishName: 'English', iso_639_1: 'en', name: 'English' }],
    seasons: [
      { airDate: '2019-09-01', episodeCount: 3, id: 900601, name: 'Season 1', overview: '', seasonNumber: 1, posterPath: null },
      { airDate: '2021-09-01', episodeCount: 3, id: 900602, name: 'Season 2', overview: '', seasonNumber: 2, posterPath: null },
    ],
    status: 'Ended', type: 'Scripted', voteAverage: 6.9, voteCount: 300,
    backdropPath: '/synthetic-backdrop-900002.jpg',
    lastEpisodeToAir: { id: 900703, airDate: '2021-10-01', episodeNumber: 3, name: 'Synthetic Finale', overview: '', productionCode: '', seasonNumber: 2, showId: 900002, voteAverage: 7, voteCount: 10, stillPath: null },
    posterPath: '/synthetic-poster-900002.jpg',
    credits: { cast: [], crew: [] },
    externalIds: { facebookId: null, freebaseId: null, freebaseMid: null, imdbId: 'tt9000002', instagramId: null, tvdbId: 800002, tvrageId: null, twitterId: null },
    keywords: [],
    mediaInfo: {
      ...record,
      requests: [
        request('tv', nested, self(), { status: 1, seasons: [1] }),
        request('tv', nested, other(), { status: 2, modifiedBy: owner(), seasons: [2] }),
      ],
      issues: [issue()],
      seasons: [
        { id: num(), seasonNumber: 1, status: 3, status4k: 1, createdAt: time(), updatedAt: time() },
        { id: num(), seasonNumber: 2, status: 5, status4k: 1, createdAt: time(), updatedAt: time() },
      ],
    },
    watchProviders: [],
    onUserWatchlist: false,
  });
}

// GET /api/v1/tv/900002/season/1: TMDB data only; Seerr attaches no media or user records.
write('season', {
  airDate: '2019-09-01',
  episodes: [1, 2, 3].map((episodeNumber) => ({
    id: 900700 + episodeNumber, airDate: `2019-09-0${episodeNumber}`, episodeNumber, name: `Synthetic Episode ${episodeNumber}`,
    overview: '', productionCode: '', seasonNumber: 1, showId: 900002, voteAverage: 7, voteCount: 10, stillPath: null,
  })),
  externalIds: { freebaseId: null, freebaseMid: null, tvdbId: 800012, tvrageId: null },
  id: 900601, name: 'Season 1', overview: '', seasonNumber: 1, posterPath: null,
});

// GET /api/v1/user/:self/requests?take=20&skip=0: the caller's own requests, one modified by the owner.
{
  write('requests', {
    pageInfo: { pages: num(), pageSize: 20, results: num(), page: 1 },
    results: [
      request('tv', media('tv', 900002, 3), self(), { status: 1, seasons: [1] }),
      request('movie', media('movie', 900003, 2), self(), { status: 3, modifiedBy: owner() }),
    ],
  });
}

// GET /api/v1/user/:self/quota
write('quota', {
  movie: { days: 7, limit: 10, used: 2, remaining: 8, restricted: false },
  tv: { days: 7, limit: 5, used: 5, remaining: 0, restricted: true },
});

// GET /api/v1/discover/watchlist?page=1 (a Jellyfin user's local Seerr watchlist)
write('watchlist', {
  page: 1,
  totalPages: num(),
  totalResults: num(),
  results: [{
    id: num(), ratingKey: '', mediaType: 'movie', title: 'Synthetic Movie Three', tmdbId: 900003,
    createdAt: time(), updatedAt: time(), requestedBy: self(), media: media('movie', 900003, 2),
  }],
});
