'use strict';
// JellyPass app service worker. It caches the app's own static files and nothing else: the household API
// (/jellypass/app/v1/*, which is no-store), Jellyfin, TMDB images and every other request go straight to the network
// without this worker touching them, so no household data is ever kept for offline use. Files are fetched from the
// network first and the copy is only used when the network is unreachable.
//
// The copy is one release's complete set: the cache is named for a hash of the precached files and of this worker (filled in by
// scripts/build-app.mjs), installed all at once or not at all, and never added to afterwards, so what is used offline is
// always the files of one release. A new release installs its own cache; activation removes the older ones.
const CACHE_PREFIX = 'jellypass-app-static-';
const CACHE = `${CACHE_PREFIX}__CONTENT_HASH__`;
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
  event.waitUntil(
    // A cache of this name that is already there was not made by this install (the same release, already running):
    // it is never touched on failure, only one this attempt created is thrown away.
    caches.keys().then((keys) => {
      const created = !keys.includes(CACHE);
      return caches.open(CACHE)
        .then((cache) => cache.addAll(STATIC_PATHS.map((path) => new Request(path, { cache: 'reload' }))))
        .then(() => self.skipWaiting())
        // A set that could not be completed is thrown away, so a half-filled cache is never mistaken for a release.
        .catch((error) => (created ? caches.delete(CACHE) : Promise.resolve()).then(() => Promise.reject(error)));
    }),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

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
      .catch(() => caches.open(CACHE).then((cache) => cache.match(url.pathname)).then((hit) => hit || Response.error())),
  );
});
