self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || 'New order received', {
      body: data.body || 'A new order has arrived.',
      tag: `order-${data.orderId || Date.now()}`,
      renotify: true,
      vibrate: [300, 150, 300, 150, 600],
      icon: '/owner-push-icon.svg',
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const existing = list.find(client => 'focus' in client);
    if (existing) return existing.focus();
    return clients.openWindow('/owner-dashboard.html');
  }));
});
