/* BlaulichtCMS Service Worker: hält nur die App-Oberfläche offline bereit.
   API-Aufrufe, Uploads und Medien werden nie zwischengespeichert – Freigaben und
   Veröffentlichungen bestätigt ausschließlich der Server. */
const CACHE = 'blaulichtcms-shell-v4';
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

/* Push-Benachrichtigungen (#191): Inhalt ist mit den Schlüsseln dieses Browsers verschlüsselt (RFC 8291) und wird vom
   Browser entschlüsselt. Ein Klick öffnet bzw. fokussiert BlaulichtCMS auf der verlinkten Seite (nur eigene Pfade). */
self.addEventListener('push', (e) => {
  let d = {};
  try {
    d = e.data ? e.data.json() : {};
  } catch {
    d = { title: 'BlaulichtCMS', body: e.data ? e.data.text() : '' };
  }
  const link = typeof d.link === 'string' && d.link.startsWith('/') && !d.link.startsWith('//') ? d.link : '/benachrichtigungen';
  // Punkt am App-Symbol (Taskleiste/Dock), bis die geöffnete App die genaue Zahl setzt – nur wo unterstützt (#197)
  try {
    self.navigator.setAppBadge?.().catch(() => {});
  } catch {
    /* nicht unterstützt */
  }
  e.waitUntil(
    self.registration.showNotification(String(d.title || d.app || 'BlaulichtCMS').slice(0, 200), {
      body: String(d.body || '').slice(0, 500),
      tag: d.tag || undefined,
      renotify: !!d.tag,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      lang: 'de',
      data: { link },
    }),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.link) || '/', self.location.origin).href;
  // Vorhandenes Fenster bevorzugen (installierte App am Desktop: kein zweites Fenster), das aktive bzw. sichtbare zuerst.
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      const own = list.filter((c) => new URL(c.url).origin === self.location.origin);
      own.sort((a, b) => Number(b.focused) - Number(a.focused) || Number(b.visibilityState === 'visible') - Number(a.visibilityState === 'visible'));
      const c = own[0];
      if (!c) return self.clients.openWindow(target);
      const w = (await c.focus().catch(() => null)) || c;
      if (w.url === target) return;
      // navigate() geht nur bei gesteuerten Fenstern; sonst wechselt die Seite selbst (Nachricht an main.tsx)
      await w.navigate(target).catch(() => w.postMessage({ type: 'bc-open', link: new URL(target).pathname + new URL(target).search + new URL(target).hash }));
    }),
  );
});

/* Abo vom Browser erneuert (z. B. abgelaufen): neues Abo mit demselben Schlüssel beim Server hinterlegen. Gelingt das
   nicht (abgemeldet), schaltet die Person Push unter „Mein Konto“ erneut ein. */
self.addEventListener('pushsubscriptionchange', (e) => {
  const key = e.oldSubscription && e.oldSubscription.options && e.oldSubscription.options.applicationServerKey;
  if (!key) return;
  e.waitUntil(
    self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).then((sub) =>
      fetch('/api/v1/notify/push/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-blaulichtcms-request': '1' },
        body: JSON.stringify({ subscription: sub.toJSON(), label: 'Gerät (erneuert)' }),
      }),
    ).catch(() => {}),
  );
});
