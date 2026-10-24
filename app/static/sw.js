'use strict';
// JellyPass app service worker. It caches the app's own static files and nothing else: the household API
// (/jellypass/app/v1/*, which is no-store), Jellyfin, TMDB images and every other request go straight to the network
// without this worker touching them, so no household data is ever kept for offline use. Files are fetched from the
// network first and the copy is only used when the network is unreachable.
const CACHE = 'jellypass-app-static-v1';
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
    caches.open(CACHE)
      .then((cache) => cache.addAll(STATIC_PATHS.map((path) => new Request(path, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('jellypass-app-static-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(API_PREFIX) || !STATIC.has(url.pathname)) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE).then((cache) => cache.put(url.pathname, copy)));
        }
        return response;
      })
      .catch(() => caches.open(CACHE).then((cache) => cache.match(url.pathname)).then((hit) => hit || Response.error())),
  );
});
