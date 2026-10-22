// Service Worker لتطبيق الهاتف MetaPulse - التحديث المباشر
const CACHE_NAME = 'metapulse-v2.2.0';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('🧹 حذف ذاكرة التخزين المؤقت القديمة:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// استقبال أمر التحديث الفوري
self.addEventListener('message', (event) => {
  if (event.data && event.data.action === 'skipWaiting') {
    self.skipWaiting();
  }
});

// التعامل مع الطلبات الشبكية (Network First للبيانات، Cache First للواجهة)
self.addEventListener('fetch', (event) => {
  // لا نخزن أي طلبات API أو Webhook حتى لا تتأثر حداثة البيانات نهائياً
  if (event.request.url.includes('/api/') || event.request.url.includes('/webhook')) {
    return;
  }

  event.respondWith(
    fetch(event.request).then((networkResponse) => {
      if (networkResponse && networkResponse.status === 200) {
        const responseClone = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
      }
      return networkResponse;
    }).catch(() => {
      return caches.match(event.request);
    })
  );
});
