const CACHE_NAME = 'lofty-support-portal-v6';
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
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(event.request).then(response => {
      if (response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      }
      return response;
    }).catch(() => caches.match(event.request))
  );
});
