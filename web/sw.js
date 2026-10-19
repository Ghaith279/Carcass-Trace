// The Meatrix: lets the phone install the site as an app.
// Everything still comes live from the internet; nothing is kept offline, so the app never shows old data.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
