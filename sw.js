/* Caches the app itself so it opens with no signal.
   Map tiles are handled separately in IndexedDB by app.js. */

const CACHE = 'trailmark-shell-v1';
const SHELL = ['./', './index.html', './app.js', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Never intercept tile requests — app.js owns that cache.
  if (url.hostname.includes('tile.')) return;
  if (e.request.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request).then(hit => {
      if (hit) {
        // Serve instantly, refresh quietly in the background.
        fetch(e.request)
          .then(res => { if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res)); })
          .catch(() => {});
        return hit;
      }
      return fetch(e.request).catch(() => caches.match('./index.html'));
    })
  );
});
