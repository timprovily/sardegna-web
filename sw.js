// Caches everything that ships with the app — HTML, CSS, JS, route data,
// icons — so the app opens and narrates with zero connection. Only live
// map tiles, OSRM routing, and Wikipedia extras need a signal; all three
// degrade gracefully in the app itself when they're not available.
//
// Bump CACHE_NAME whenever you change a bundled file, so returning users
// get the update instead of a stale cached copy.
const CACHE_NAME = 'sardegna-v19';

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/style.css',
  './js/app.js',
  './js/data.js',
  './js/speech.js',
  './js/geo.js',
  './js/navEngine.js',
  './js/maneuverIcons.js',
  './js/reverse.js',
  './js/tourEngine.js',
  './js/enrichment.js',
  './js/map.js',
  './js/overviewMap.js',
  './js/storage.js',
  './js/i18n.js',
  './js/wakeLock.js',
  './js/theme.js',
  './js/gpxImport.js',
  './js/weather.js',
  './js/spotify.js',
  './js/radio.js',
  './js/storyteller.js',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './data/routes-manifest.json',
  './data/facts.json',
  './data/route-alghero-bosa.json',
  './data/route-ss125-ogliastra.json',
  './data/route-costa-verde.json',
  './data/route-iglesiente.json',
  './data/route-gallura.json',
  './data/route-barbagia.json',
  './data/route-sud-est.json',
  './data/route-sinis-barumini.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Only handle our own shell files this way. Map tiles, OSRM, and
  // Wikipedia go straight to the network — caching those would either be
  // huge (tiles) or go stale in unhelpful ways (routing, summaries).
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
