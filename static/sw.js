const CACHE_NAME = 'codereader-static-v1';

const PRECACHE_URLS = [
  '/',
  '/css/main.css',
  '/css/code.css',
  '/css/graph.css',
  '/css/responsive.css',
  '/css/chat.css',
  '/css/offline.css',
  '/js/api.js',
  '/js/app.js',
  '/js/browse.js',
  '/js/notes.js',
  '/js/ai.js',
  '/js/chat.js',
  '/js/paths.js',
  '/js/graph.js',
  '/js/list.js',
  '/js/export.js',
  '/js/cache-db.js',
  '/js/offline.js',
  '/js/cache-manager.js',
  '/lib/highlight.min.js',
  '/lib/highlight-python.min.js',
  '/lib/d3.min.js',
  '/lib/atom-one-dark.min.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

// Install: pre-cache all critical static resources
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// Activate: clean up old version caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith('codereader-') && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: API pass-through, static cache-first, offline navigation fallback
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API requests: never intercept, pass through directly
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Navigation requests: try network first, fallback to cached SPA entry
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .catch(() => caches.match('/'))
    );
    return;
  }

  // Static resources: cache-first strategy
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(event.request).then((response) => {
        // Only cache successful same-origin responses
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseToCache);
        });
        return response;
      });
    })
  );
});
