/* Simple SW for offline caching of dashboard + apps.json */
const CACHE = 'app-dashboard-cache-v3';
const CORE = [
  './',
  './index.html',
  './dashboard.css',
  './dashboard.js',
  './manifest.webmanifest',
  './apps.json'
];

async function cacheManifestApps(cache){
  try{
    const res = await fetch('./apps.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();

    const list = Array.isArray(json?.apps) ? json.apps : [];
    const files = list
      .map(x => (typeof x === 'string' ? x : x?.file))
      .filter(Boolean)
      .map(s => String(s).trim())
      .filter(s => /\.html?$/i.test(s))
      .filter(s => !/^index\.html$/i.test(s))
      .filter(s => !/^dashboard\.html$/i.test(s))
      .filter(s => !/^dashboard\./i.test(s))
      .map(f => './' + f.replace(/^\.\//,''));

    // cache HTML dari manifest
    await cache.addAll([...new Set(files)]);
  }catch(e){
    // kalau offline / apps.json error, jangan gagalkan install
    console.warn('SW: gagal cache apps dari apps.json', e);
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await cache.addAll(CORE);
    await cacheManifestApps(cache);
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
      return cached || new Response('Offline', {
        status: 503,
        headers: { 'Content-Type':'text/plain' }
      });
    }
  })());
});
