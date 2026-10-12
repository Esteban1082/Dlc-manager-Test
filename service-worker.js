// StoreLine Service Worker v2.0
const CACHE_NAME = 'storeline-v30';

// Fichiers à mettre en cache pour le mode offline
const STATIC_ASSETS = [
  '/login.html',
  '/set-password.html',
  '/index.html',
  '/hub.html',
  '/admin.html',
  '/dlc.html',
  '/pertes.html',
  '/produits.html',
  '/import-produits.html',
  '/import-pertes.html',
  '/import-temperatures.html',
  '/import-allergenes.html',
  '/import-transferts.html',
  '/import-dlc.html',
  '/allergenes.html',
  '/temperatures.html',
  '/documents.html',
  '/transferts.html',
  '/commandes.html',
  '/donnees.html',
  '/planning.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// Installation — mise en cache des assets statiques
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(new Request(url, { cache: 'reload' })).then(
            () => ({ url, ok:true }),
            err => ({ url, ok:false, err })
          )
        )
      ).then(results => {
        const failed = results
          .map(r => r.value)
          .filter(r => r && !r.ok)
          .map(r => r.url);
        if (failed.length) console.warn('Cache partiel:', failed);
      });
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
                body { margin:0; background:#f4efe7; color:#23201c; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
                       display:flex; align-items:center; justify-content:center; min-height:100vh; text-align:center; padding:24px; }
                h1 { font-family:Georgia,serif; font-size:28px; margin:0 0 8px; }
                p { color:#6e6256; font-size:15px; line-height:1.45; margin:0 0 28px; }
                button { padding:14px 28px; background:#e8a045; border:none; border-radius:999px; font-size:16px; font-weight:700; color:#23201c; cursor:pointer; }
              </style>
            </head>
            <body>
              <div>
                <h1>Pas de connexion</h1>
                <p>StoreLine a besoin d’internet.<br>Vérifie le réseau et réessaie.</p>
                <button onclick="location.reload()">Réessayer</button>
              </div>
            </body>
            </html>
          `, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
        });
      })
  );
});
