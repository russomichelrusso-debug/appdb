// Substitui o módulo ../db pelo mock ANTES de qualquer rota carregar,
// interceptando o require - assim testo o server.js de verdade, só trocando
// o banco por dentro.
const Module = require('module');
const path = require('path');
const mockDb = require('./mock-db');
const { generateToken } = require('../auth-utils');
const dbPath = path.resolve(__dirname, '../db.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  const resolved = originalResolve.call(this, request, ...args);
  return resolved;
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

process.env.PORT = '4123';

const http = require('http');

let authToken = '';

function req(method, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: 'localhost', port: 4123, path: urlPath, method,
      headers: { 'Content-Type': 'application/json', ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}), ...headers, ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => chunks += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(chunks); } catch (e) {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function assert(cond, msg) {
  if (!cond) { console.error('FALHOU:', msg); process.exitCode = 1; }
  else console.log('OK:', msg);
}

async function main() {
  // dá um tempinho pro server.js (rodado via require abaixo) subir
  require('../server.js');
  await new Promise(r => setTimeout(r, 400));

  // 1) health check sem chave de API - deve funcionar (rota pública)
  let res = await req('GET', '/health');
  assert(res.status === 200 && res.body.status === 'ok', 'health check responde OK');

  // 2) endpoint protegido sem token -> 401
  res = await req('GET', '/api/clientes');
  assert(res.status === 401, 'endpoint protegido rejeita sem token de sessão');

  // 2b) login real é via "Entrar com Google" (POST /api/auth/google, que exige
  // um id_token de verdade validado contra o servidor do Google - não dá pra
  // simular aqui). Em vez disso, semeia a sessão direto no banco (mesmo
  // atalho usado pelos scripts de verificação manual desta sessão), pulando
  // só a etapa de confirmar a identidade - o resto do fluxo (token de sessão,
  // requireAuth, is_admin) é o código real.
  const criado = await mockDb.pool.query(
    'INSERT INTO usuarios (nome, email, google_sub, is_admin) VALUES ($1, $2, $3, true) RETURNING id, nome, email, is_admin',
    ['Michel Russo', 'michel@example.com', 'sub-teste-michel']
  );
  assert(criado.rows[0].is_admin === true, 'primeiro usuário criado vira admin');
  authToken = generateToken();
  await mockDb.pool.query(
    'INSERT INTO sessoes (token, usuario_id, expira_em) VALUES ($1, $2, $3)',
    [authToken, criado.rows[0].id, '90']
  );

  // 3) criar cliente
  res = await req('POST', '/api/clientes', { nome: 'João Silva Materiais', documento: '12345678000199', contato: '11999998888' });
  assert(res.status === 201 && res.body.id, 'cria cliente novo');
  const clienteId = res.body.id;

  // 4) criar o MESMO cliente de novo (mesmo documento) -> deve devolver o mesmo id, nao duplicar
  res = await req('POST', '/api/clientes', { nome: 'João Silva Materiais LTDA', documento: '12345678000199' });
  assert(res.status === 200 && res.body.id === clienteId, 'nao duplica cliente com mesmo documento');

  // 5) buscar cliente por nome
  res = await req('GET', '/api/clientes?busca=Jo%C3%A3o');
  assert(res.status === 200 && res.body.length === 1, 'busca de cliente por nome funciona');

  // 6) sincronizar produtos (simulando o precos.json)
  res = await req('POST', '/api/produtos/sync', { produtos: [
    { codigo_sku: '60863', nome: 'DISCO DE CORTE DIAMANTADO TURBO PORCELANATO 110 mm', categoria: '09 - CORTE DIAMANTADO' },
    { codigo_sku: '99999', nome: 'PRODUTO NOVO TESTE', categoria: 'TESTE' },
  ]});
  assert(res.status === 200 && res.body.criados === 1 && res.body.atualizados === 1, 'sync de produtos cria novo e atualiza existente corretamente');

  // 7) gravar um pedido
  res = await req('POST', '/api/pedidos', {
    cliente: { cliente_id: clienteId, nome: 'João Silva Materiais' },
    vendedor_nome: 'Michel Russo',
    itens: [
      { codigo_sku: '60863', quantidade: 40, preco_unitario: 28.59 },
      { codigo_sku: '61362', quantidade: 5, preco_unitario: 217.42 },
    ],
  });
  assert(res.status === 201 && res.body.pedido_id, 'grava pedido com itens');

  // 8) gravar um SEGUNDO pedido no mesmo cliente (pra testar historico com 2 pedidos do mesmo produto)
  res = await req('POST', '/api/pedidos', {
    cliente: { cliente_id: clienteId, nome: 'João Silva Materiais' },
    vendedor_nome: 'Michel Russo',
    itens: [ { codigo_sku: '60863', quantidade: 60, preco_unitario: 28.59 } ],
  });
  assert(res.status === 201, 'grava segundo pedido');

  // 9) pedido com produto que não existe -> deve falhar com erro claro
  res = await req('POST', '/api/pedidos', {
    cliente: { cliente_id: clienteId, nome: 'João Silva Materiais' },
    itens: [ { codigo_sku: 'CODIGO-INEXISTENTE', quantidade: 1, preco_unitario: 10 } ],
  });
  assert(res.status === 400 && res.body.erro.includes('não encontrado'), 'rejeita pedido com produto inexistente, com mensagem clara');

  // 10) historico do cliente - deve mostrar 60863 com total 100 (40+60) e 2 pedidos
  res = await req('GET', `/api/clientes/${clienteId}/historico`);
  const item60863 = res.body.find(r => r.codigo_sku === '60863');
  assert(item60863 && item60863.total_acumulado === 100 && item60863.num_pedidos === 2, 'historico agrega corretamente as duas compras do mesmo produto (total 100 un, 2 pedidos)');

  // 11) gravar um levantamento
  res = await req('POST', '/api/levantamentos', {
    cliente: { cliente_id: clienteId, nome: 'João Silva Materiais' },
    vendedor_nome: 'Michel Russo',
    nome_levantamento: 'Visita trimestral',
    itens: [ { codigo_sku: '60863', quantidade_contada: 12 } ],
  });
  assert(res.status === 201 && res.body.levantamento_id, 'grava levantamento com itens');

  // 12) historico de levantamentos do cliente
  res = await req('GET', `/api/clientes/${clienteId}/levantamentos`);
  assert(res.status === 200 && res.body.length === 1 && res.body[0].num_produtos === 1, 'lista levantamentos do cliente corretamente');

  // 13) classificatório: calcula sobre o ANO CIVIL FECHADO anterior, não uma
  // janela móvel de 12 meses (ver routes/clientesClassificatorio.js) - semeia
  // um cliente com faturamento no ano fechado (conta) e um pedido no ano
  // corrente ainda não fechado (não deve contar, mesmo sendo mais recente).
  const anoFechado = new Date().getUTCFullYear() - 1;
  mockDb.__seed({
    clientes: [{
      id: 9001, nome: 'CLIENTE CLASSIFICATORIO TESTE', documento: '99988877000166', codigo_oficial: 'COD9001',
      classificatorio_tipo: 'Varejo Premium', classificatorio_desconto: 17, classificatorio_pic: false, classificatorio_vl_acordo: null, matriz_grupo: null,
    }],
    pedidosOficiaisItens: [
      { nr_pedido: 'PC1', codigo_sku: '60863', cliente_codigo_oficial: 'COD9001', quantidade: 1, valor: 43000, data_faturamento: `${anoFechado}-06-15`, status: 'faturado' },
      { nr_pedido: 'PC2', codigo_sku: '60863', cliente_codigo_oficial: 'COD9001', quantidade: 1, valor: 500000, data_faturamento: `${anoFechado + 1}-01-05`, status: 'faturado' },
    ],
  });
  res = await req('GET', '/api/clientes/9001/classificatorio/status');
  assert(
    res.status === 200 && res.body.faturamento12m === 43000 && res.body.periodoReferencia?.anoInicio === anoFechado,
    `classificatório soma só o ano civil fechado (${anoFechado}), ignora pedido do ano corrente ainda não fechado`
  );

  console.log();
  console.log(process.exitCode === 1 ? 'ALGUNS TESTES FALHARAM' : 'TODOS OS TESTES PASSARAM');
  process.exit(process.exitCode || 0);
}

main().catch(e => { console.error('ERRO NO TESTE:', e); process.exit(1); });
