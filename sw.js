// Simple cache-first service worker. Bump VERSION when files change.
const VERSION = 'mm-v9';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './manifest-entrepreneur.webmanifest',
  './config/family.json',
  './config/entrepreneur.json',
  './data/family.json',
  './data/entrepreneur.json',
  './icons/family-192.png',
  './icons/family-512.png',
  './icons/entrepreneur-192.png',
  './icons/entrepreneur-512.png',
  './brand/flight-club-logo-mask-720.png',
  './brand/shoreline-logo.svg',
  './brand/frond-tr-green.png',
  './brand/frond-bl-green.png',
  './brand/tpg-mark-mask.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // Navigations ignore the ?group= query so one cached index.html serves both groups.
  const ignoreSearch = req.mode === 'navigate';
  e.respondWith(
    caches.match(req, { ignoreSearch }).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
