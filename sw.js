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
// v2 (10/2026): apaga o importadores.js guardado pela regra antiga (ver abaixo).
// v4 (10/2026): apaga as cópias por endereço com parâmetro (ver chaveDaPagina).
// Pula o "v3" de propósito: era o número do SW antigo removido em 30/08 (acima),
// e um cache com nome parecido de um aparelho esquecido não pode ser reaproveitado.
const CACHE_VERSION = 'cortag-sw-v4';
const STATIC_ASSETS = [
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
];

// O app e as páginas separadas, guardados já na instalação: o SW é registrado
// depois que a página carrega, então a 1ª abertura não passa por ele - e a
// troca de CACHE_VERSION apaga o cache anterior. Sem isto, depois de um deploy
// que sobe a versão, quem abrisse o app sem internet antes de uma 2ª abertura
// online via a página de erro do navegador (achado do revisor-cortag, 10/2026).
const PAGINAS_OFFLINE = [
  './',
  './index.html',
  './importadores.js',
  './curva-abc.html',
  './calculadora-materiais.html',
  './ficha-cnpj.html',
];

// Bibliotecas de fora (cdnjs/jsdelivr) que o app usa no campo: imagem e PDF do
// orçamento (html2canvas, jsPDF), leitor de código de barras no iPhone (ZXing -
// o Safari não tem BarcodeDetector), CSV/planilha (SheetJS) e PDF de cotação
// (pdf.js). Sem isto, abrir o app sem internet deixava a imagem/PDF do orçamento
// e a câmera do levantamento quebrados (achado do revisor-cortag, 10/2026).
// Só estes endereços - a lista fechada é o limite do cache. Ficam num cache à
// parte, que não é apagado quando CACHE_VERSION sobe (não mudam: o endereço
// tem a versão). As de PRECACHE já vão na instalação (a de PDF só carrega
// quando alguém gera o 1º PDF); as outras, na 1ª vez que forem usadas online.
// Trocar a versão de uma biblioteca no index.html = trocar aqui também.
const CACHE_LIBS = 'cortag-libs-v1';
const LIBS_PRECACHE = [
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js',
  'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js',
];
const LIBS = new Set(LIBS_PRECACHE.concat([
  'https://cdn.jsdelivr.net/npm/@e965/xlsx@0.20.3/dist/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.1.200/pdf.min.mjs',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.1.200/pdf.worker.min.mjs',
]));

// Páginas e scripts do app são guardados pelo endereço SEM parâmetros: antes
// cada curva-abc.html?cliente=… virava uma cópia nova (o cache crescia sem
// limite) e, sem internet, o "mesmo endereço sem parâmetros" (ignoreSearch)
// podia achar uma cópia velha com parâmetro antes da atual (achado do
// revisor-cortag, 10/2026). As páginas são estáticas: o parâmetro não muda o HTML.
function chaveDaPagina(url) {
  const u = new URL(url);
  return u.origin + u.pathname;
}

self.addEventListener('install', (event) => {
  event.waitUntil(Promise.all([
    caches.open(CACHE_VERSION).then((cache) => Promise.all(
      // um por um: um arquivo que falhe não impede de guardar os outros
      // (cache.addAll é tudo-ou-nada); 'reload' pula o cache HTTP do navegador
      STATIC_ASSETS.concat(PAGINAS_OFFLINE).map((url) =>
        cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
      )
    )),
    caches.open(CACHE_LIBS).then((cache) => Promise.all(
      LIBS_PRECACHE.map((url) => cache.match(url).then((ja) => ja || cache.add(url)).catch(() => {}))
    )),
  ]));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION && k !== CACHE_LIBS).map((k) => caches.delete(k))))
      // biblioteca que saiu da lista (versão trocada) sai do cache
      .then(() => caches.open(CACHE_LIBS))
      .then((cache) => cache.keys().then((reqs) => Promise.all(reqs.filter((r) => !LIBS.has(r.url)).map((r) => cache.delete(r)))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Biblioteca da lista: do cache primeiro (o endereço tem a versão, o conteúdo
  // não muda); sem cópia, da rede, guardando pra próxima. Pelo endereço sem
  // parâmetros: a nova tentativa do pdf.js depois de uma falha vem com
  // "?tentativa=N" (o navegador pode guardar a falha do import() do endereço puro).
  const urlLib = url.origin + url.pathname;
  if (LIBS.has(urlLib)) {
    event.respondWith(
      caches.open(CACHE_LIBS).then((cache) => cache.match(urlLib).then((cached) => cached
        // busca em modo CORS mesmo pro <script> sem crossorigin: resposta opaca
        // ocupa ~7 MB da cota do aparelho no Chrome, e não dá pra saber se é erro
        || fetch(urlLib, { mode: 'cors', credentials: 'omit' }).then((resp) => {
          if (resp.ok) cache.put(urlLib, resp.clone());
          return resp;
        }, () => fetch(req))))
    );
    return;
  }
  // Só same-origin - nunca mexe em chamadas pro backend (appdb-z6uh.onrender.com)
  // nem em qualquer outro domínio.
  if (url.origin !== self.location.origin) return;
  // Nunca intercepta API - preço/estoque/pedido sempre vêm da rede.
  if (url.pathname.startsWith('/api/')) return;

  const isNavegacao = req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
  // Script do próprio app (importadores.js, carregado pelo index.html): é
  // código, muda junto com o HTML. Antes caía na regra dos ícones (cache
  // primeiro) e o Painel importava planilha com o leitor da versão anterior
  // enquanto a importação por e-mail já usava o novo (achado do
  // revisor-cortag, 10/2026).
  const isScript = req.destination === 'script' || url.pathname.endsWith('.js');
  if (isNavegacao || isScript) {
    // Páginas HTML (index.html, curva-abc.html etc.) e scripts: sempre tenta
    // a rede primeiro, pra nunca travar numa versão velha do app - só cai
    // pro cache se estiver offline.
    const chave = chaveDaPagina(req.url);
    event.respondWith(
      fetch(req)
        .then((resp) => {
          // só guarda respostas de sucesso - um 404/500 cacheado ficaria
          // "travado" servindo erro pra sempre no fallback offline; resposta
          // que veio de redirecionamento não pode responder uma navegação
          if (resp.ok && !resp.redirected) {
            const clone = resp.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(chave, clone));
          }
          return resp;
        })
        // sem internet: a cópia da página (sem os parâmetros)
        .catch(() => caches.match(chave, { cacheName: CACHE_VERSION }).then((r) => r || Response.error()))
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

// Avisos no celular (Web Push - routes/lib/novidades.js): relatório/tabela
// nova importada. `tag` igual substitui o aviso que já está na tela sem tocar
// de novo (renotify: false) - é assim que a reimportação de correção em até
// 30 min troca o aviso anterior.
self.addEventListener('push', (event) => {
  let dados = {};
  try { dados = event.data ? event.data.json() : {}; } catch (e) { dados = { texto: event.data ? event.data.text() : '' }; }
  const titulo = dados.titulo || 'Cortag';
  event.waitUntil(self.registration.showNotification(titulo, {
    body: dados.texto || '',
    tag: dados.tag || 'cortag',
    renotify: false,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: { url: dados.url || './index.html#novidades' },
  }));
});

// Tocar no aviso: abre a lista de novidades - no app que já estiver aberto
// (manda uma mensagem pra ele) ou abrindo o app de novo.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || './index.html#novidades', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((janelas) => {
      const app = janelas.find((j) => new URL(j.url).pathname.endsWith('/index.html') || new URL(j.url).pathname.endsWith('/'));
      if (app) {
        app.postMessage({ tipo: 'abrir-novidades' });
        return app.focus();
      }
      return self.clients.openWindow(url);
    })
  );
});
