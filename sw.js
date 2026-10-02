// Service worker: offline support + showing notifications.
// Bump VERSION whenever you upload new files so phones pick up changes.
const VERSION = 'prayers-v10';
const ASSETS = ['./', './index.html', './manifest.json', './splash.jpg', './header.jpg',
  './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png', './icons/icon-maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) =>
    // add one by one so a missing file (e.g. splash.jpg) doesn't break install
    Promise.all(ASSETS.map((a) => c.add(a).catch(() => {})))
  ));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

// Network first (so updates show up), cache as offline fallback.
// Our own files are fetched with cache:'no-cache', so the phone always asks GitHub for the newest
// version instead of reusing its 10-minute browser copy.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const own = new URL(e.request.url).origin === self.location.origin;
  const net = own ? fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(e.request);
  e.respondWith(
    net.then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./')))
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  }));
});

// Phase 2 hook: a push server will send {title, body, silent} here.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil(self.registration.showNotification(data.title || 'Prayer', {
    body: data.body || '', tag: data.tag, silent: !!data.silent,
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png'
  }));
});
