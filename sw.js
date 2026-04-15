// InvestBook Service Worker – offline cache
const CACHE = 'investbook-v41';
const ASSETS = [
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Přeskočit non-GET požadavky (POST na Worker apod. – Cache API neumí cachovat POST)
  if (e.request.method !== 'GET') return;

  // Vždy ze sítě: Google APIs, Fonts, Gemini, CDN, Cloudflare Workers, CORS proxy
  const url = e.request.url;
  if (
    url.includes('googleapis.com') ||
    url.includes('fonts.') ||
    url.includes('gstatic') ||
    url.includes('yahoo.com') ||
    url.includes('allorigins.win') ||
    url.includes('corsproxy.io') ||
    url.includes('codetabs.com') ||
    url.includes('generativelanguage') ||
    url.includes('cdnjs.cloudflare.com') ||
    url.includes('accounts.google.com') ||
    url.includes('workers.dev')
  ) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // Vlastní soubory: cache-first, fallback na síť
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).then(resp => {
        if (resp && resp.status === 200 && resp.type !== 'opaque') {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      })
    )
  );
});
