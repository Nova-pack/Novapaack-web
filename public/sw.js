const CACHE_NAME = 'novapack-repartidor-v14';
const urlsToCache = [
    '/reparto.html',
    '/reparto.css',
    '/reparto.js',
    '/copiloto.js',
    '/manifest-repartidor.json',
    '/firebase-config.js',
    '/libs/html5-qrcode.min.js',
    '/icon_new.png',
    '/phantom-engine.js'
];

self.addEventListener('install', event => {
    // Do NOT call skipWaiting() here — let the page control activation
    // via postMessage('skipWaiting') to avoid reload loops on iOS
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(urlsToCache))
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(function(cacheNames) {
            return Promise.all(
                cacheNames.filter(function(name) { return name !== CACHE_NAME; })
                           .map(function(name) { return caches.delete(name); })
            );
        }).then(function() { return self.clients.claim(); })
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;

    // Network-first for API/Firestore, cache-first for static assets
    const url = new URL(event.request.url);
    if (url.hostname.includes('firestore') || url.hostname.includes('googleapis') || url.hostname.includes('firebase')) {
        return; // Let Firestore requests go through normally
    }

    event.respondWith(
        fetch(event.request).then(response => {
            if (response && response.status === 200) {
                const responseClone = response.clone();
                caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
            }
            return response;
        }).catch(() => {
            return caches.match(event.request);
        })
    );
});

// Handle push notifications in background
self.addEventListener('push', event => {
    var data = { title: 'Novapack Reparto', body: 'Nuevo aviso' };
    try {
        if (event.data) data = event.data.json();
    } catch(e) {}

    event.waitUntil(
        self.registration.showNotification(data.title || 'Novapack Reparto', {
            body: data.body || '',
            icon: '/icon_new.png',
            badge: '/icon_new.png',
            tag: 'novapack-' + Date.now(),
            requireInteraction: true,
            vibrate: [200, 100, 200, 100, 300]
        })
    );
});

// When user taps notification, focus or open the app
self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            // If app is already open, focus it
            for (var i = 0; i < windowClients.length; i++) {
                var client = windowClients[i];
                if (client.url.includes('reparto') && 'focus' in client) {
                    return client.focus();
                }
            }
            // Otherwise open it
            if (clients.openWindow) {
                return clients.openWindow('/reparto.html');
            }
        })
    );
});

// Allow app to trigger skipWaiting for immediate activation
self.addEventListener('message', event => {
    if (event.data === 'skipWaiting') {
        self.skipWaiting();
    }
});

// Periodic background sync (keeps SW alive)
self.addEventListener('periodicsync', event => {
    if (event.tag === 'keep-alive') {
        event.waitUntil(Promise.resolve());
    }
});
