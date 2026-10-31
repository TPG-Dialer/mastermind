// Simple cache-first service worker. Bump VERSION when files change.
// Supabase requests go to another origin, so they are never cached here.
const VERSION = 'mm-v10';
const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './api-supabase.js',
  './config/supabase.js',
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

/* Web push from send-notifications: { title, body, url, tag? }.
   url is the app link for the member's group (APP_URL?group=...#/...). */
self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'Mastermind';
  const opts = {
    body: d.body || '',
    data: { url: d.url || './' },
    icon: /group=entrepreneur/.test(d.url || '') ? 'icons/entrepreneur-192.png' : 'icons/family-192.png'
  };
  if (d.tag) { opts.tag = d.tag; opts.renotify = true; }
  e.waitUntil(self.registration.showNotification(title, opts));
});

// Tapping a notification: focus an open app window on that link, or open one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './', self.location.href).href;
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const same = wins.find((w) => w.url.split('#')[0] === target.split('#')[0]) || wins.find((w) => new URL(w.url).origin === self.location.origin);
      if (same) return same.focus().then((w) => (w && w.url !== target && 'navigate' in w ? w.navigate(target) : w));
      return self.clients.openWindow(target);
    })
  );
});
