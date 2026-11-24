/* LifeOS service worker: shows push notifications and opens the app when one is tapped.
   It does not cache anything, so updates to index.html show up as before. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'LifeOS', {
    body: d.body || '',
    tag: d.tag || undefined,
    icon: '/icon-180.png',
    badge: '/icon-180.png',
    data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  let go = '';
  try { go = new URL(url, self.location.origin).searchParams.get('go') || ''; } catch (_) {}
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    // app already open: bring it forward and tell it where to go
    for (const c of list) {
      if ('focus' in c) { c.postMessage({ go }); return c.focus(); }
    }
    // app closed: open it straight on that page
    return self.clients.openWindow(url);
  }));
});
