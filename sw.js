// Service Worker do Cortag - só cuida de assets estáticos (ícones, manifest)
// pra permitir instalação completa como PWA e dar um fallback offline básico
// nas páginas HTML. NUNCA intercepta chamadas de API (tudo em /api/...) -
// preço, estoque e pedidos são sempre dados ao vivo, nunca devem vir de um
// cache velho.
//
// Histórico (por que a estratégia é essa): a versão anterior (v3, removida
// em 30/08) cacheava QUALQUER requisição GET com sucesso, inclusive chamadas
// de API - risco real de mostrar preço/estoque desatualizado pro vendedor.
// Ela também ficou "presa" pra sempre em aparelhos que já tinham instalado o
// app: o arquivo sw.js foi apagado do servidor, mas o index.html continuou
// chamando register('sw.js') - o navegador nunca conseguiu buscar a
// atualização (404) e o SW antigo nunca se desregistrou sozinho (PR #27
// corrigiu trocando o registro por um desregistro forçado). SE ESTE ARQUIVO
// FOR REMOVIDO DE NOVO NO FUTURO, o registro em index.html TEM que virar
// unregister() no mesmo commit - senão o mesmo problema se repete.
const CACHE_VERSION = 'cortag-sw-v1';
const STATIC_ASSETS = [
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Só same-origin - nunca mexe em chamadas pro backend (appdb-z6uh.onrender.com)
  // nem em qualquer outro domínio.
  if (url.origin !== self.location.origin) return;
  // Nunca intercepta API - preço/estoque/pedido sempre vêm da rede.
  if (url.pathname.startsWith('/api/')) return;

  const isNavegacao = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  if (isNavegacao) {
    // Páginas HTML (index.html, curva-abc.html etc.): sempre tenta a rede
    // primeiro, pra nunca travar numa versão velha do app - só cai pro
    // cache se estiver offline.
    event.respondWith(
      fetch(req)
        .then((resp) => {
          // só guarda respostas de sucesso - um 404/500 cacheado ficaria
          // "travado" servindo erro pra sempre no fallback offline.
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
          }
          return resp;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Ícones/manifest: raramente mudam - serve do cache na hora (rápido,
  // funciona offline) e atualiza o cache em segundo plano.
  event.respondWith(
    caches.match(req).then((cached) => {
      const fetchPromise = fetch(req)
        .then((resp) => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(req, clone));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
