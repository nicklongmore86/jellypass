'use strict';
// JellyPass app service worker. It caches the app's own static files and nothing else: the household API
// (/jellypass/app/v1/*, which is no-store), Jellyfin, TMDB images and every other request go straight to the network
// without this worker touching them, so no household data is ever kept for offline use. Files are fetched from the
// network first and the copy is only used when the network is unreachable.
//
// The copy is one release's complete set: each install fills a cache of its own (named for a hash of the precached files
// and of this worker, filled in by scripts/build-app.mjs, plus a random id for that install), all at once or not at all,
// and never adds to it afterwards, so what is used offline is always the files of one release. Installs never share a
// cache, so a failing install can only delete the one it made itself, never one another worker is serving from. Offline,
// any complete cache of this release will do (they hold the same files). Activation removes the other releases' caches.
const CACHE_PREFIX = 'jellypass-app-static-';
const RELEASE = `${CACHE_PREFIX}__CONTENT_HASH__-`;
const API_PREFIX = '/jellypass/app/v1/';
const STATIC_PATHS = [
  '/jellypass/app/',
  '/jellypass/app/app.css',
  '/jellypass/app/manifest.webmanifest',
  '/jellypass/app/tmdb-logo.svg',
  '/jellypass/app/icons/icon-192.png',
  '/jellypass/app/icons/icon-512.png',
  '/jellypass/app/icons/apple-touch-icon.png',
  '/jellypass/app/js/api.js',
  '/jellypass/app/js/main.js',
  '/jellypass/app/js/render.js',
  '/jellypass/app/js/session.js',
];
const STATIC = new Set(STATIC_PATHS);

self.addEventListener('install', (event) => {
  const own = `${RELEASE}${crypto.randomUUID()}`;
  event.waitUntil(
    caches.open(own)
      .then((cache) => cache.addAll(STATIC_PATHS.map((path) => new Request(path, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
      // A set that could not be completed is thrown away, so a half-filled cache is never mistaken for a release.
      .catch((error) => caches.delete(own).then(() => Promise.reject(error))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && !key.startsWith(RELEASE)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/** The stored copy of a path from any cache of this release (a cache still being filled simply has no hit). */
function stored(pathname) {
  return caches.keys().then(async (keys) => {
    for (const key of keys.filter((name) => name.startsWith(RELEASE))) {
      const hit = await caches.open(key).then((cache) => cache.match(pathname));
      if (hit) return hit;
    }
    return undefined;
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Do not widen this to "everything on the origin": it is an allowlist on purpose. The API (household data) and every
  // other request must reach the network without this worker answering for them or keeping a copy.
  if (url.pathname.startsWith(API_PREFIX) || !STATIC.has(url.pathname)) return;
  event.respondWith(
    fetch(request)
      .catch(() => stored(url.pathname).then((hit) => hit || Response.error())),
  );
});
