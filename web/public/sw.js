/* BlaulichtCMS Service Worker: hält nur die App-Oberfläche offline bereit.
   API-Aufrufe, Uploads und Medien werden nie zwischengespeichert – Freigaben und
   Veröffentlichungen bestätigt ausschließlich der Server. */
const CACHE = 'blaulichtcms-shell-v2';
const MAX_ASSETS = 150;
// Nur vollständige, eigene Antworten speichern – keine 502/404-Seiten als Offline-Oberfläche (#88)
const cacheable = (res) => res && res.ok && res.type === 'basic';
const SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/favicon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;
  if (e.request.mode === 'navigate') {
    // Netz zuerst, bei fehlender Verbindung die zuletzt geladene Oberfläche. Antwortet statt BlaulichtCMS nur der Proxy
    // (502/503/504, z. B. während eines Updates), ebenfalls die Oberfläche: Sie zeigt „Server nicht erreichbar“ und
    // versucht es selbst erneut (#194) – statt einer Fehlerseite des Proxys ohne Erklärung.
    e.respondWith(
      fetch(e.request)
        .then(async (res) => {
          if (cacheable(res)) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          if ([502, 503, 504].includes(res.status)) return (await caches.match('/')) || res;
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (cacheable(res)) {
              const copy = res.clone();
              caches.open(CACHE).then(async (c) => {
                await c.put(e.request, copy);
                // Alte Asset-Fassungen (Hash im Namen) nicht unbegrenzt ansammeln
                const keys = (await c.keys()).filter((k) => new URL(k.url).pathname.startsWith('/assets/'));
                for (const k of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await c.delete(k);
              });
            }
            return res;
          }),
      ),
    );
  }
});
