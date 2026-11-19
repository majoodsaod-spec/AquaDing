const CACHE = 'aqua-ding-v3';
const ASSETS = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/')))
  );
});

function readState() {
  return new Promise((res) => {
    try {
      const r = indexedDB.open('aqua-ding', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => {
        try {
          const q = r.result.transaction('kv').objectStore('kv').get('state');
          q.onsuccess = () => res(q.result || null);
          q.onerror = () => res(null);
        } catch (e) { res(null); }
      };
      r.onerror = () => res(null);
    } catch (e) { res(null); }
  });
}
const pad = (n) => (n < 10 ? '0' + n : '' + n);

self.addEventListener('push', (e) => {
  e.waitUntil((async () => {
    const st = await readState();
    let body = 'Time for a glass of water.';
    if (st && st.goal && st.logs) {
      const d = new Date();
      const k = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
      const total = (st.logs[k] || []).reduce((a, b) => a + b.ml, 0);
      const left = st.goal - total;
      body = left > 0 ? left.toLocaleString('en-US') + ' ml to go today. Tap to log a glass.' : 'Goal reached today. One more sip never hurts.';
    }
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    wins.forEach((w) => w.postMessage({ type: 'pushed' }));
    await self.registration.showNotification('Time to drink water', {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: 'aqua-ding',
      renotify: true,
      requireInteraction: true,
      vibrate: [250, 120, 250, 120, 400],
      data: { url: '/' },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if ('focus' in w) { await w.focus(); return; } }
    await self.clients.openWindow('/');
  })());
});
