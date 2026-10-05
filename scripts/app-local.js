#!/usr/bin/env node
// Sobe o app inteiro na máquina, sem Postgres e sem login do Google — pra abrir
// no navegador (ou no Playwright) e ver uma mudança de tela funcionando.
//  - backend: o server.js de verdade, com o banco trocado pelo mock dos testes
//    (test/mock-db.js, em memória, some ao parar);
//  - páginas e API no MESMO endereço (o CSP do index.html só deixa chamar
//    'self' ou https, então o app não fala com um backend em outra porta);
//  - /__entrar grava no navegador o endereço do servidor e uma sessão de admin
//    já criada, e abre o index.html logado.
// Uso: node scripts/app-local.js   (porta: APP_LOCAL_PORTA, padrão 8080)
const http = require('http');
const fs = require('fs');
const path = require('path');

const raiz = path.resolve(__dirname, '..');
const PORTA = Number(process.env.APP_LOCAL_PORTA || 8080);
const PORTA_API = PORTA + 1;
const TOKEN = 'token-local-de-desenvolvimento';

// mesmo truque do test/run_tests.js: o mock entra no lugar do db.js antes de
// qualquer rota carregar
const mockDb = require('../test/mock-db');
const { hashToken } = require('../auth-utils');
const dbPath = path.join(raiz, 'db.js');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };
process.env.PORT = String(PORTA_API);
process.env.NODE_ENV = 'test'; // não liga os timers (fichas de CNPJ de madrugada, push agendado)

async function semear() {
  const { rows: [admin] } = await mockDb.pool.query(
    'INSERT INTO usuarios (nome, email, google_sub, is_admin) VALUES ($1, $2, $3, true) RETURNING id, nome, email, is_admin',
    ['Vendedor Local', 'local@example.com', 'sub-local']
  );
  await mockDb.pool.query(
    'INSERT INTO sessoes (token, usuario_id, expira_em) VALUES ($1, $2, $3)',
    [hashToken(TOKEN), admin.id, '90']
  );
  const hoje = new Date();
  const dia = n => new Date(hoje.getTime() - n * 86400000).toISOString().slice(0, 10);
  mockDb.__seed({
    clientes: [
      { id: 101, nome: 'DEPOSITO SAO JOSE MATERIAIS DE CONSTRUCAO', documento: '11222333000181', codigo_oficial: '3663',
        classificatorio_tipo: 'Varejo Premium', classificatorio_desconto: 15, matriz_grupo: null },
      { id: 102, nome: 'CASA DAS FERRAMENTAS LTDA', documento: '44555666000192', codigo_oficial: '5569',
        classificatorio_tipo: 'Varejo Master', classificatorio_desconto: 18, matriz_grupo: null },
      { id: 103, nome: 'COMERCIAL PISO E ACABAMENTO', documento: '77888999000103', codigo_oficial: null,
        classificatorio_tipo: null, classificatorio_desconto: null, matriz_grupo: null },
    ],
    pedidosOficiaisItens: [
      { nr_pedido: '676001', codigo_sku: '60863', cliente_codigo_oficial: '3663', quantidade: 10, valor: 1850,
        data_faturamento: dia(40), data_implantacao: dia(45), status: 'faturado', nota_fiscal: '900001' },
      { nr_pedido: '676002', codigo_sku: '61362', cliente_codigo_oficial: '3663', quantidade: 4, valor: 2200,
        data_faturamento: dia(12), data_implantacao: dia(15), status: 'faturado', nota_fiscal: '900002' },
      { nr_pedido: '676003', codigo_sku: '60863', cliente_codigo_oficial: '5569', quantidade: 6, valor: 1110,
        data_faturamento: null, data_implantacao: dia(5), status: 'carteira' },
    ],
  });
}

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json',
  '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const PAGINA_ENTRAR = `<!doctype html><meta charset="utf-8"><title>Entrando…</title><script>
  localStorage.setItem('cortagApiConfig_v1', JSON.stringify({ baseUrl: location.origin }));
  localStorage.setItem('cortagAuthToken_v1', ${JSON.stringify(TOKEN)});
  location.replace('/index.html');
</script>`;

function repassarPraApi(req, res) {
  const r = http.request({ host: '127.0.0.1', port: PORTA_API, path: req.url, method: req.method, headers: req.headers }, resp => {
    res.writeHead(resp.statusCode, resp.headers);
    resp.pipe(res);
  });
  r.on('error', () => { res.writeHead(502); res.end('API local fora do ar'); });
  req.pipe(r);
}

function servirArquivo(req, res) {
  const caminho = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (caminho === '/__entrar') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGINA_ENTRAR);
  }
  const arquivo = path.join(raiz, caminho === '/' ? 'index.html' : caminho);
  const tipo = TIPOS[path.extname(arquivo)];
  // só arquivos da raiz do repo com extensão conhecida (nada de node_modules, .git, ..)
  if (!tipo || path.dirname(arquivo) !== raiz || !fs.existsSync(arquivo)) {
    res.writeHead(404); return res.end('não encontrado');
  }
  res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'no-store' });
  fs.createReadStream(arquivo).pipe(res);
}

async function main() {
  require('../server.js');
  await new Promise(r => setTimeout(r, 400));
  await semear();
  http.createServer((req, res) => {
    if (req.url.startsWith('/api/') || req.url === '/health') return repassarPraApi(req, res);
    servirArquivo(req, res);
  }).listen(PORTA, '127.0.0.1', () => {
    console.log(`\nApp local: http://localhost:${PORTA}/__entrar  (abre o index.html já logado como admin)`);
    console.log(`Outras páginas: /curva-abc.html, /calculadora-materiais.html, /ficha-cnpj.html`);
    console.log('Banco em memória (mock dos testes) — tudo some ao parar (Ctrl+C).');
  });
}

main().catch(e => { console.error(e); process.exit(1); });
