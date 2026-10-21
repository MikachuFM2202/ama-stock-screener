// Service worker: push notifications only. No fetch handler, so it never serves stale pages or data.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data?.json() || {}; } catch { d = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Halal Terminal', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag, icon: 'icon-192.png', badge: 'icon-192.png',
    data: { hash: /^#[\w/.^=%-]*$/.test(d.url || '') ? d.url : '#brief' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const hash = e.notification.data?.hash || '#brief';
  e.waitUntil((async () => {
    const [c] = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (c) { await c.focus(); c.postMessage({ type: 'open', hash }); }
    else await self.clients.openWindow(new URL(hash, self.registration.scope).href);
  })());
});
