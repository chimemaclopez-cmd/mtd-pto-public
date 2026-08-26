const CACHE_NAME = 'lofty-support-portal-v10';
const APP_SHELL = [
  '/',
  '/shared/kpi.css',
  '/shared/loading-status.css',
  '/shared/ui-utils.js',
  '/shared/date-utils.js',
  '/shared/loading-status.js',
  '/shared/auth-service.js',
  '/shared/my-data-service.js',
  '/shared/pto-service.js',
  '/shared/img/lofty-logo.png',
  '/shared/img/icon-192.png',
  '/shared/img/icon-512.png',
  '/manifest.json'
];

self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).catch(() => {}));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// Network-first: always prefer live data (KPI/PTO/schedule numbers must never go silently stale).
// Falls back to the last cached copy only when the network request fails outright (offline).
// {cache:'no-store'} bypasses the browser's own HTTP cache for this fetch - without it, a
// "network-first" request can still resolve from the browser's disk cache if the server sent a
// cacheable response, silently serving a stale build (found live: users saw the old nav layout
// flash before the new one appeared - the SW's Cache API entry was fine, but the fetch() call
// feeding it was itself reading a stale HTTP-cached response).
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request, { cache: 'no-store' }).then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
