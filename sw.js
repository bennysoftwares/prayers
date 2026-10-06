// Service worker: offline support + showing notifications.
// Bump VERSION whenever you upload new files so phones pick up changes.
const VERSION = 'prayers-v45';
const ASSETS = ['./', './index.html', './manifest.json', './splash.jpg', './header.jpg', './header-morning.jpg', './header-midday.jpg', './header-night.jpg', './library.js',
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
  // Only handle the app's own files; anything else (like the place-name lookup) goes straight to the network.
  if (new URL(e.request.url).origin !== self.location.origin) return;
  const net = fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' });
  e.respondWith(
    net.then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('./')))
  );
});

// Tapping a notification opens the app on that prayer
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const id = e.notification.data && e.notification.data.prayer;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) if ('focus' in c) { if (id) c.postMessage({ type: 'open-prayer', id }); return c.focus(); }
    return self.clients.openWindow(id ? './?prayer=' + encodeURIComponent(id) : './');
  }));
});

// Reminders sent by the account (the "reminders" server function): {title, body, tag, prayer, silent}
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) { data = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Time to pray', {
    body: data.body || '', tag: data.tag || 'prayer', silent: !!data.silent,
    data: { prayer: data.prayer || null },          // tapping opens the app on this prayer
    icon: 'icons/icon-192.png', badge: 'icons/icon-192.png'
  }));
});
