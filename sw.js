// InvestBook Service Worker — verze se meni s kazdym deployem
const SW_VERSION = "v4.59";
const CACHE_NAME = "investbook-" + SW_VERSION;

// ─── Soubory ke stažení dopředu při instalaci ────────────────────────────────
// Jde o soubory, které se NIKDY nemění (verzovaná CDN URL nebo lokální ikonky).
// Uloží se při prvním spuštění a pak se servírují z cache — bez stahování.
const PRECACHE_URLS = [
  // CDN knihovny — verzovaná URL, obsah se nikdy nezmění
  "https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/prop-types/15.8.1/prop-types.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/recharts/2.12.7/Recharts.js",
  "https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.5/babel.min.js",
  // Fonty — CSS soubor s popisem fontů (woff2 soubory se stáhnou automaticky)
  "https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700;800&family=DM+Mono:wght@400;500;600&display=swap",
  // Lokální soubory projektu
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/investbook-core.js",
];

// ─── Domény, které se NIKDY necachují ────────────────────────────────────────
// Auth tokeny, živá data z burzy a Sheets — musí jít vždy přes síť.
const SKIP_CACHE_HOSTNAMES = [
  "accounts.google.com",
  "apis.google.com",
  "sheets.googleapis.com",
  "oauth2.googleapis.com",
  "stooq.com",
  "query1.finance.yahoo.com",
  "query2.finance.yahoo.com",
];

// ─── Instal: předstáhni všechny knihovny do cache ────────────────────────────
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .catch(err => {
        // Pokud se nepodaří stáhnout některý soubor (např. offline), SW se
        // nainstaluje i tak — jen bez předem stažených souborů.
        console.warn("[SW] Precache selhal, pokračuji bez předstahování:", err);
      })
      .then(() => self.skipWaiting())
  );
});

// ─── Activate: vymaž staré cache z předchozích verzí ─────────────────────────
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Fetch: rozhoduj, co se cachuje a co ne ───────────────────────────────────
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);

  // 1. Domény, které se nikdy necachují (auth, živá data) → projde na síť
  if (SKIP_CACHE_HOSTNAMES.some(h => url.hostname.endsWith(h))) {
    return; // bez respondWith = propadne na síť normálně
  }

  // 2. Cloudflare Workers (proxy pro Gemini AI) → nikdy necachuj
  if (url.hostname.endsWith(".workers.dev")) {
    return;
  }

  // 3. Navigace (HTML stránka) → network-first: vždy zkus nejnovější verzi,
  //    cache jako záloha pro offline
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // 4. CDN knihovny (cdnjs.cloudflare.com) → cache-first:
  //    verzované URL se nemění, stahuj jen jednou
  if (url.hostname === "cdnjs.cloudflare.com") {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // 5. Google Fonts CSS + woff2 soubory → cache-first:
  //    fonty se nemění, šetříme data
  if (
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com"
  ) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // 6. Lokální statické soubory (manifest, ikony, investbook-core) →
  //    stale-while-revalidate: vrať z cache okamžitě, aktualizuj na pozadí
  if (
    url.pathname === "/manifest.json" ||
    url.pathname === "/icon-192.png" ||
    url.pathname === "/icon-512.png" ||
    url.pathname === "/investbook-core.js"
  ) {
    event.respondWith(staleWhileRevalidate(event.request));
    return;
  }

  // 7. Vše ostatní → propadne na síť bez cachování
});

// ─── Pomocné funkce ───────────────────────────────────────────────────────────

// Cache-first: vrať z cache, pokud není → stáhni a ulož
function cacheFirst(request) {
  return caches.match(request).then(cached => {
    if (cached) return cached;
    return fetch(request).then(response => {
      const clone = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
      return response;
    });
  });
}

// Stale-while-revalidate: vrať z cache okamžitě, ale aktualizuj na pozadí
function staleWhileRevalidate(request) {
  return caches.open(CACHE_NAME).then(cache => {
    return cache.match(request).then(cached => {
      const fetchPromise = fetch(request).then(response => {
        cache.put(request, response.clone());
        return response;
      });
      return cached || fetchPromise;
    });
  });
}
