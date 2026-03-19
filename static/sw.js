const CACHE_NAME = 'codereader-static-v4';

// Install: 立即激活，不预缓存（避免安装卡住）
self.addEventListener('install', () => self.skipWaiting());

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
      fetch(event.request).then((response) => {
        // 缓存首页用于离线回退
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put('/', clone));
        return response;
      }).catch(() => caches.match('/'))
    );
    return;
  }

  // Static resources: cache-first, miss then fetch and cache
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        return cached;
      }
      return fetch(event.request).then((response) => {
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
