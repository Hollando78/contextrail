/*
 * ContextRail desklet service worker.
 *
 * Deliberately NETWORK-FIRST for everything: the desklet is always driven by a
 * live host, and we already hit a stale-bundle bug once, so the SW must never
 * serve an out-of-date desklet.js while the host is reachable. It only falls
 * back to cache when the network is unavailable (offline app shell), and it
 * stays out of the way of pairing / admin / health / WebSocket traffic.
 */
const CACHE = 'contextrail-shell-v1';

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/desklet', '/icon.svg', '/manifest.webmanifest']).catch(() => {})));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never intercept dynamic / control routes.
  if (/^\/(pair|admin|health)\b/.test(url.pathname)) return;

  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const c = await caches.open(CACHE);
        c.put(req, res.clone());
      }
      return res;
    } catch {
      const cached = await caches.match(req);
      return cached || (await caches.match('/desklet')) || (await caches.match('/')) || Response.error();
    }
  })());
});
