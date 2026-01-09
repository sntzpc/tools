/* Simple SW for offline caching of dashboard + bundled apps */
const CACHE = 'app-dashboard-cache-v1';
const CORE = [
  './',
  './index.html',
  './dashboard.css',
  './dashboard.js',
  './manifest.webmanifest',
  ["cuaca.html", "kalbmi.html", "keuangan.html", "paint.html", "todolist.html"]
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k === CACHE ? null : caches.delete(k))));
    self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  e.respondWith((async () => {
    const cached = await caches.match(req);
    if (cached) return cached;
    try{
      const fresh = await fetch(req);
      const cache = await caches.open(CACHE);
      cache.put(req, fresh.clone());
      return fresh;
    }catch(err){
      return cached || new Response('Offline', { status: 503, headers: { 'Content-Type':'text/plain' }});
    }
  })());
});
