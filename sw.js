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
// libs-v2 (10/2026): bibliotecas da CDN conferidas pelo hash (SRI) ao baixar - o cache
// de bibliotecas guardado antes, sem conferência, é descartado e baixado de novo.
// v5 (10/2026): manifest.json novo (orientation "any": o app instalado no tablet ficava preso em pé);
// o manifest é servido do cache primeiro, então só a troca de versão faz o aparelho pegar o novo.
// Pula o "v3" de propósito: era o número do SW antigo removido em 30/08 (acima),
// e um cache com nome parecido de um aparelho esquecido não pode ser reaproveitado.
const CACHE_VERSION = 'cortag-sw-v5';
// Página/script do app com sinal fraco: espera a rede só até aqui e abre com a
// cópia guardada (a rede termina em segundo plano e atualiza a cópia). Antes
// esperava até o navegador desistir - o app demorava a abrir dentro da loja.
const PRAZO_REDE_PAGINA_MS = 4000;
// quando a última página saiu da cópia por causa do prazo (o script vai junto)
let paginaDaCopiaEm = 0;
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
  './tela-cliente.html',
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
// Trocar a versão de uma biblioteca no index.html = trocar aqui também, com o hash
// (o mesmo de INTEGRIDADE_CDN no index.html; node scripts/conferir-integridade.js).
//
// Cada uma com o hash do arquivo (SRI): o SW só guarda e entrega o arquivo que
// bate com ele. Se a CDN for invadida e trocar o arquivo, a cópia adulterada
// nunca entra no cache (servido do cache primeiro, ficaria pra sempre) - e o
// pdf.js (import() sem atributo integrity) e o worker dele também ficam cobertos.
const CACHE_LIBS_ANTERIOR = 'cortag-libs-v1';
const CACHE_LIBS = 'cortag-libs-v2';
// Fotos dos produtos (card de oferta da aba Produtos): quem grava é a página
// (index.html, cacheFotosProduto), com o login - o SW só não pode apagar.
const CACHE_FOTOS = 'cortag-fotos-v1';
const LIBS_PRECACHE = [
  'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js',
  'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js',
];
const LIBS = new Map([
  ['https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js', 'sha384-ZZ1pncU3bQe8y31yfZdMFdSpttDoPmOZg2wguVK9almUodir1PghgT0eY7Mrty8H'],
  ['https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js', 'sha384-JcnsjUPPylna1s1fvi1u12X5qjY5OL56iySh75FdtrwhO/SWXgMjoVqcKyIIWOLk'],
  ['https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.5.31/jspdf.plugin.autotable.min.js', 'sha384-vuyrTV5nkscLp1knFvt+FIHfKKzmROBq5reruhMRslauj54mW+l2B8b6szMN6lCL'],
  ['https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js', 'sha384-BzBxP10ZE72aitqj5UMmUsbKFliP/DZqA8Wq+BNNhlIJDGoEd1tpkMYXOg9+n6sB'],
  ['https://cdn.jsdelivr.net/npm/@e965/xlsx@0.20.3/dist/xlsx.full.min.js', 'sha384-EnyY0/GSHQGSxSgMwaIPzSESbqoOLSexfnSMN2AP+39Ckmn92stwABZynq1JyzdT'],
  ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.4.299/pdf.min.mjs', 'sha384-QCvhu/UPp22U/TNLVbQNONL82ES2yY717GAiqP9VVu37Y7+m9VPKvadGx9XlFvcp'],
  ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.4.299/pdf.worker.min.mjs', 'sha384-NfW/OTMWezITv4oaALvfH7MFLwzPxEvpySmDpoALa1mtTY8MC200l0ZNFD+SOlrM'],
  // QR Code do pareamento da tela do cliente (tela-cliente.html)
  ['https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js', 'sha384-mZT2gIty7ZDdOGkxfP6joZcYdMW1Jvj9dRlfpTmaJAKKXTqzygtB22k7FLe+KZC1'],
  // Mapa da carteira (aba Clientes, laptop)
  ['https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js', 'sha384-NElt3Op+9NBMCYaef5HxeJmU4Xeard/Lku8ek6hoPTvYkQPh3zLIrJP7KiRocsxO'],
]);
// Baixa a biblioteca conferindo o hash: arquivo diferente = erro (nunca vai pro cache).
// Em modo CORS mesmo pro <script> sem crossorigin: resposta opaca não deixa
// conferir o hash e ocupa ~7 MB da cota do aparelho no Chrome.
function baixarLib(url) {
  return fetch(url, { mode: 'cors', credentials: 'omit', integrity: LIBS.get(url) });
}
// sha384 em base64, no formato do SRI
async function hashSri(resp) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-384', await resp.arrayBuffer()));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'sha384-' + btoa(bin);
}
// Copia do cache de bibliotecas anterior (guardado sem conferência) só o que
// bate com o hash da LIBS; o activate apaga o anterior depois. Resposta opaca
// (corpo ilegível) não bate e fica de fora.
async function migrarLibsAnteriores(cache) {
  if (!(await caches.has(CACHE_LIBS_ANTERIOR))) return;
  const anterior = await caches.open(CACHE_LIBS_ANTERIOR);
  await Promise.all([...LIBS.keys()].map(async (url) => {
    try {
      if (await cache.match(url)) return;
      const velha = await anterior.match(url);
      if (velha && velha.ok && (await hashSri(velha.clone())) === LIBS.get(url)) await cache.put(url, velha);
    } catch (e) { }
  }));
}

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
    // primeiro traz do cache anterior (sem conferência) o que bate com o hash -
    // atualizar com sinal fraco não pode deixar o aparelho sem as bibliotecas
    // offline; depois baixa o que ainda falta do precache
    caches.open(CACHE_LIBS).then((cache) => migrarLibsAnteriores(cache).then(() => Promise.all(
      LIBS_PRECACHE.map((url) => cache.match(url).then((ja) => ja || baixarLib(url).then((resp) => {
        if (resp.ok) return cache.put(url, resp);
      })).catch(() => {}))
    ))),
  ]));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION && k !== CACHE_LIBS && k !== CACHE_FOTOS).map((k) => caches.delete(k))))
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
  // Sem rede ou com o arquivo adulterado (hash não bate): erro - nunca cai pra uma
  // busca sem conferência.
  const urlLib = url.origin + url.pathname;
  if (LIBS.has(urlLib)) {
    event.respondWith(
      caches.open(CACHE_LIBS).then((cache) => cache.match(urlLib).then((cached) => cached
        || baixarLib(urlLib).then((resp) => {
          if (resp.ok) cache.put(urlLib, resp.clone());
          return resp;
        })))
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
    // Páginas HTML (index.html, curva-abc.html etc.) e scripts: tenta a rede
    // primeiro, pra nunca travar numa versão velha do app. Cai pra cópia
    // guardada (sem os parâmetros) sem internet - e também quando a rede não
    // responde em PRAZO_REDE_PAGINA_MS (sinal fraco): aí a busca continua em
    // segundo plano e a cópia nova fica pra próxima abertura. Sem cópia
    // guardada, espera a rede o quanto for.
    const chave = chaveDaPagina(req.url);
    // mantém o SW vivo até a cópia nova ser gravada, mesmo depois de responder
    let fimDoCache;
    event.waitUntil(new Promise((r) => { fimDoCache = r; }));
    const daRede = fetch(req).then((resp) => {
      // só guarda respostas de sucesso - um 404/500 cacheado ficaria
      // "travado" servindo erro pra sempre no fallback offline; resposta
      // que veio de redirecionamento não pode responder uma navegação
      if (resp.ok && !resp.redirected) {
        const clone = resp.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(chave, clone)).catch(() => {}).then(fimDoCache);
      } else {
        fimDoCache();
      }
      return resp;
    });
    daRede.catch(fimDoCache);
    const daCopia = () => caches.match(chave, { cacheName: CACHE_VERSION });
    // Página e script andam juntos (versões diferentes quebram: HTML novo chamando
    // função que o importadores.js velho não tem - achado do revisor-cortag): o
    // prazo vale só pra página; o script segue o que a página fez - página da cópia
    // nos últimos segundos = script da cópia na hora; senão, espera a rede.
    const seguirCopia = isScript && !isNavegacao && Date.now() - paginaDaCopiaEm < 60000;
    event.respondWith(new Promise((responder) => {
      const prazo = isNavegacao ? setTimeout(() => {
        daCopia().then((copia) => { if (copia) { paginaDaCopiaEm = Date.now(); responder(copia); } }).catch(() => {});
      }, PRAZO_REDE_PAGINA_MS) : null;
      if (seguirCopia) daCopia().then((copia) => { if (copia) responder(copia); }).catch(() => {});
      daRede.then(
        (resp) => { clearTimeout(prazo); if (isNavegacao) paginaDaCopiaEm = 0; responder(resp); },
        // sem internet: a cópia da página (sem os parâmetros)
        () => {
          clearTimeout(prazo);
          daCopia().then((copia) => responder(copia || Response.error()), () => responder(Response.error()));
        }
      );
    }));
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
