
self.addEventListener('push', function(event) {
  let data = { title: 'تذكير موعد', body: 'لديك موعد قادم بعد 30 دقيقة' };
  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: '/صور/logo.png', // تأكد من المسار الصحيح للوجو أو أي أيقونة
    badge: '/صور/logo.png',
    vibrate: [200, 100, 200],
    data: {
      dateOfArrival: Date.now(),
      primaryKey: '1'
    }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.openWindow('/')
  );
});