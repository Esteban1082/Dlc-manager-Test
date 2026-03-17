// StoreLine Service Worker v1.0
const CACHE_NAME = 'storeline-v1';

// Fichiers à mettre en cache pour le mode offline
const STATIC_ASSETS = [
  '/login.html',
  '/index.html',
  '/admin.html',
  '/dlc.html',
  '/pertes.html',
  '/produits.html',
  '/allergenes.html',
  '/temperatures.html',
  '/documents.html',
  '/transferts.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// Installation — mise en cache des assets statiques
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS.map(url => new Request(url, { cache: 'reload' })))
        .catch(err => console.warn('Cache partiel:', err));
    })
  );
  self.skipWaiting();
});

// Activation — nettoyer les anciens caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — stratégie Network First avec fallback cache
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Ignorer les requêtes non-GET et les API externes
  if (event.request.method !== 'GET') return;
  if (url.hostname.includes('supabase.co')) return;
  if (url.hostname.includes('script.google.com')) return;
  if (url.hostname.includes('fonts.googleapis.com')) return;
  if (url.hostname.includes('unpkg.com')) return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Mettre en cache les pages HTML
        if (response.ok && (url.pathname.endsWith('.html') || url.pathname === '/')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Pas de réseau → chercher dans le cache
        return caches.match(event.request).then(cached => {
          if (cached) return cached;
          // Page offline de fallback
          return new Response(`
            <!DOCTYPE html>
            <html lang="fr">
            <head>
              <meta charset="UTF-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <title>StoreLine — Hors ligne</title>
              <style>
                body { background:#0f0f0d; color:#f0ede4; font-family:'DM Mono',monospace;
                       display:flex; align-items:center; justify-content:center;
                       min-height:100vh; text-align:center; padding:20px; }
                .icon { font-size:48px; margin-bottom:16px; }
                h1 { font-family:serif; font-size:24px; color:#e8a045; margin-bottom:8px; }
                p { color:#7a7a6e; font-size:13px; margin-bottom:24px; }
                button { padding:12px 24px; background:#e8a045; border:none; border-radius:10px;
                         font-size:15px; font-weight:700; color:#000; cursor:pointer; }
              </style>
            </head>
            <body>
              <div>
                <div class="icon">📡</div>
                <h1>Pas de connexion</h1>
                <p>StoreLine nécessite une connexion internet.<br>Vérifie ton réseau et réessaie.</p>
                <button onclick="location.reload()">↻ Réessayer</button>
              </div>
            </body>
            </html>
          `, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        });
      })
  );
});
