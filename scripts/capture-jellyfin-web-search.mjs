#!/usr/bin/env node
// Writes test/fixtures/jellyfin-web-search-requests.json: the requests Jellyfin web's Search page makes for "the", as
// the `XMLHttpRequest.open` calls they reach, captured from a built Jellyfin web checkout's own `@jellyfin/sdk` and
// axios (the TV add-on's search cap, tv/src/search-cap.ts, rewrites exactly these). Not run by the tests.
//
//   node scripts/capture-jellyfin-web-search.mjs <jellyfin-web checkout with node_modules>
//
// The calls are the ones `src/apps/legacy/features/search/api/*.ts` make, with their arguments copied from there (the
// SDK builds the address). axios is left to pick its own adapter: a global XMLHttpRequest is put in place first, as a
// browser has, so if axios chose fetch or http instead nothing would be captured and the script fails. Nothing is
// sent anywhere: the fake XMLHttpRequest answers every request itself.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const checkout = process.argv[2];
if (!checkout) throw new Error('usage: capture-jellyfin-web-search.mjs <jellyfin-web checkout>');
const modules = join(checkout, 'node_modules');
const version = (name) => JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8')).version;
const load = (file) => import(pathToFileURL(join(modules, file)).href);

const opened = [];
globalThis.XMLHttpRequest = class {
  constructor() {
    this.readyState = 0;
    this.status = 0;
    this.responseText = '{}';
    this.response = '{}';
  }
  open(...args) {
    opened.push(args);
    this.readyState = 1;
  }
  setRequestHeader() {}
  getAllResponseHeaders() { return 'content-type: application/json'; }
  addEventListener() {}
  abort() {}
  send() {
    this.readyState = 4;
    this.status = 200;
    setTimeout(() => (this.onloadend ? this.onloadend() : this.onreadystatechange && this.onreadystatechange()), 0);
  }
};

const axios = (await load('axios/index.js')).default;
const { Api } = await load('@jellyfin/sdk/lib/api.js');
const { getLibraryApi } = await load('@jellyfin/sdk/lib/utils/api/library-api.js');
const { getPersonApi } = await load('@jellyfin/sdk/lib/utils/api/person-api.js');
const { getStudioApi } = await load('@jellyfin/sdk/lib/utils/api/studio-api.js');
const { getArtistApi } = await load('@jellyfin/sdk/lib/utils/api/artist-api.js');

// The SDK's default: the global axios instance, as Jellyfin web's useApi has it.
const api = new Api('https://jelly-grove.example.test', { name: 'Jellyfin Web', version: '12.3.0' }, { name: 'TV', id: 'device' }, 'token', axios);
const QUERY_OPTIONS = { limit: 100, fields: ['PrimaryImageAspectRatio', 'CanDelete', 'MediaSourceCount'], enableTotalRecordCount: false, imageTypeLimit: 1 };
const userId = 'u1';
const searchTerm = 'the';
const ALL_TYPES = ['Movie', 'Series', 'Episode', 'Playlist', 'MusicAlbum', 'Audio', 'TvChannel', 'PhotoAlbum', 'Photo', 'AudioBook', 'Book', 'BoxSet'];
const calls = {
  // useSearchItems.ts → fetchItemsByType.ts, no library chosen.
  items: () => getLibraryApi(api).getItems({ ...QUERY_OPTIONS, userId, recursive: true, includeItemTypes: ALL_TYPES, parentId: undefined, searchTerm, isMissing: false, limit: 800 }),
  people: () => getPersonApi(api).getPersons({ ...QUERY_OPTIONS, userId, searchTerm, excludePersonTypes: ['Artist', 'AlbumArtist'] }),
  studios: () => getStudioApi(api).getStudios({ ...QUERY_OPTIONS, userId, parentId: undefined, searchTerm }),
  artists: () => getArtistApi(api).getArtists({ ...QUERY_OPTIONS, userId, parentId: undefined, searchTerm }),
  videos: () => getLibraryApi(api).getItems({ ...QUERY_OPTIONS, userId, recursive: true, mediaTypes: ['Video'], excludeItemTypes: ['Movie', 'Episode', 'TvChannel'], parentId: undefined, searchTerm }),
};
const requests = {};
for (const [name, call] of Object.entries(calls)) {
  const before = opened.length;
  await call();
  if (opened.length !== before + 1) throw new Error(`${name}: expected one XMLHttpRequest.open, got ${opened.length - before}`);
  requests[name] = opened[before];
}
const out = join(import.meta.dirname, '..', 'test', 'fixtures', 'jellyfin-web-search-requests.json');
writeFileSync(out, `${JSON.stringify({
  jellyfinWeb: JSON.parse(readFileSync(join(checkout, 'package.json'), 'utf8')).version,
  sdk: version('@jellyfin/sdk'),
  axios: version('axios'),
  axiosAdapters: (await load('axios/lib/defaults/index.js')).default.adapter,
  source: 'src/apps/legacy/features/search/api/*.ts',
  xhrOpen: requests,
}, null, 2)}\n`);
console.log(`wrote ${out}`);
