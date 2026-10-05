// Substitui o módulo ../db pelo mock ANTES de qualquer rota carregar,
// interceptando o require - assim testo o server.js de verdade, só trocando
// o banco por dentro.
const Module = require('module');
const path = require('path');
const mockDb = require('./mock-db');
const { generateToken, hashToken } = require('../auth-utils');
const dbPath = path.resolve(__dirname, '../db.js');
// /health/banco guarda a resposta por 15 s (server.js); no teste, 300 ms
process.env.HEALTH_BANCO_CACHE_MS = '300';
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  const resolved = originalResolve.call(this, request, ...args);
  return resolved;
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

// web-push falso (routes/lib/novidades.js): registra o que seria enviado, sem
// sair pra internet. Endpoint com "morta" responde 410 (inscrição expirada).
const webPushEnviados = [];
const webPushPath = require.resolve('web-push');
require.cache[webPushPath] = { id: webPushPath, filename: webPushPath, loaded: true, exports: {
  setVapidDetails: () => {},
  sendNotification: async (sub, payload, opts) => {
    if (sub.endpoint.includes('morta')) { const e = new Error('gone'); e.statusCode = 410; throw e; }
    webPushEnviados.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), opts });
    return {};
  },
} };
process.env.VAPID_PUBLIC_KEY = 'BChaveDeTeste_123';
process.env.VAPID_PRIVATE_KEY = 'privada-de-teste';
process.env.VAPID_SUBJECT = 'https://exemplo.test';
process.env.IMPORTACAO_EMAIL_CHAVE = 'chave-de-teste-da-importacao-por-email-123456';

process.env.PORT = '4123';
// não liga o preenchimento automático de fichas de CNPJ (timer) durante o teste
process.env.NODE_ENV = 'test';

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
        resolve({ status: res.statusCode, body: json, headers: res.headers });
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

  // 1b) /health/banco: servidor no ar E banco respondendo (o script do Gmail usa antes de
  // mandar arquivo); banco com erro = 503 genérico, sem a mensagem do banco
  // A resposta fica guardada (300 ms no teste, 15 s de verdade) e chamadas ao mesmo
  // tempo esperam a mesma consulta: rota pública em loop não ocupa o banco.
  {
    const queryOriginal = mockDb.pool.query;
    let consultas = 0;
    mockDb.pool.query = async (sql, params) => {
      if (sql.includes('health:banco')) { consultas++; await new Promise(r => setTimeout(r, 50)); }
      return queryOriginal(sql, params);
    };
    let juntas;
    try {
      juntas = await Promise.all([1, 2, 3, 4, 5].map(() => req('GET', '/health/banco')));
      res = await req('GET', '/health/banco');
    } finally { mockDb.pool.query = queryOriginal; }
    assert(juntas.every(r => r.status === 200 && r.body.banco === 'ok') && res.status === 200 && consultas === 1,
      `health do banco responde OK; 6 chamadas = 1 consulta ao banco: ${JSON.stringify([res.body, consultas])}`);
  }
  await new Promise(r => setTimeout(r, 350)); // passa a validade da resposta guardada
  {
    const queryOriginal = mockDb.pool.query;
    mockDb.pool.query = async (sql, params) => {
      if (sql.includes('health:banco')) throw new Error('connection terminated SEGREDO');
      return queryOriginal(sql, params);
    };
    try { res = await req('GET', '/health/banco'); } finally { mockDb.pool.query = queryOriginal; }
    // erro lançado na hora (sem promise) também não trava: passada a validade, consulta de novo
    await new Promise(r => setTimeout(r, 350));
    mockDb.pool.query = (sql, params) => { if (sql.includes('health:banco')) throw new Error('síncrono'); return queryOriginal(sql, params); };
    let rSinc;
    try { rSinc = await req('GET', '/health/banco'); } finally { mockDb.pool.query = queryOriginal; }
    await new Promise(r => setTimeout(r, 350));
    const rVolta = await req('GET', '/health/banco');
    assert(rSinc.status === 503 && rVolta.status === 200, `health do banco: erro síncrono não deixa a consulta presa: ${JSON.stringify([rSinc.status, rVolta.status])}`);
    const r2 = await req('GET', '/health');
    assert(res.status === 503 && !JSON.stringify(res.body).includes('SEGREDO') && r2.status === 200,
      `health do banco: banco fora = 503 sem detalhe, e o /health continua 200: ${JSON.stringify(res.body)}`);
  }

  // 1c) CORS: todo método que as rotas usam está liberado na checagem prévia do navegador
  // (o app publicado roda em outro domínio). Faltava PUT e o nome do arquivo do cliente
  // nunca chegava ao servidor (achado da 4ª rodada do revisor-cortag).
  {
    const fs = require('fs');
    const metodos = new Set();
    for (const f of fs.readdirSync(path.join(__dirname, '../routes')).filter(f => f.endsWith('.js'))) {
      for (const m of fs.readFileSync(path.join(__dirname, '../routes', f), 'utf8').matchAll(/router\.(get|post|put|patch|delete)\(/g)) metodos.add(m[1].toUpperCase());
    }
    const pre = await req('OPTIONS', '/api/clientes/1/nome-arquivo', null, { Origin: 'https://example.com', 'Access-Control-Request-Method': 'PUT' });
    const liberados = String(pre.headers['access-control-allow-methods'] || '').split(/\s*,\s*/);
    const faltando = [...metodos].filter(m => !liberados.includes(m));
    assert(pre.status === 204 && metodos.has('PUT') && faltando.length === 0,
      `CORS libera todos os métodos usados pelas rotas: ${JSON.stringify({ liberados, faltando })}`);
  }

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
  // sessoes.token guarda o hash do token (ver auth-utils.js hashToken) - o
  // que fica no header Authorization das requisições é sempre o token cru.
  await mockDb.pool.query(
    'INSERT INTO sessoes (token, usuario_id, expira_em) VALUES ($1, $2, $3)',
    [hashToken(authToken), criado.rows[0].id, '90']
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

  // 5b) busca (e a lista offline /sync) devolvem codigo_oficial - pedido do
  // usuário pra mostrar o código do cliente entre parênteses ao selecionar
  // (seletor de cliente e barra "cliente selecionado" no front).
  mockDb.__seed({
    clientes: [{
      id: 9010, nome: 'CLIENTE COM CODIGO OFICIAL', documento: '99988877000922', codigo_oficial: 'COD9010',
      classificatorio_tipo: null, classificatorio_desconto: null, matriz_grupo: null,
    }],
  });
  res = await req('GET', '/api/clientes?busca=CLIENTE%20COM%20CODIGO');
  assert(
    res.status === 200 && res.body.length === 1 && res.body[0].codigo_oficial === 'COD9010',
    `busca de cliente devolve codigo_oficial pro seletor mostrar entre parênteses: ${JSON.stringify(res.body[0])}`
  );
  res = await req('GET', '/api/clientes/sync');
  const sincronizado = res.body.clientes.find(c => c.id === 9010);
  assert(
    res.status === 200 && sincronizado && sincronizado.codigo_oficial === 'COD9010',
    'lista offline (/sync) também traz codigo_oficial, pra funcionar sem internet'
  );
  assert(sincronizado.regime_tributario === null, 'cliente sem ficha de CNPJ vai pro /sync com regime desconhecido (null)');

  // 5b2) nome do arquivo CSV escolhido pro cliente - grava no servidor pra
  // valer em todos os aparelhos e volta no /sync (usado offline)
  res = await req('PUT', '/api/clientes/9010/nome-arquivo', { nome_arquivo: 'ClienteCodigo9010' });
  assert(res.status === 200 && res.body.nome_arquivo === 'ClienteCodigo9010' && res.body.nome_arquivo_em,
    `grava o nome do arquivo do cliente: ${JSON.stringify(res.body)}`);
  res = await req('GET', '/api/clientes/sync');
  const comNomeArquivo = res.body.clientes.find(c => c.id === 9010);
  assert(comNomeArquivo.nome_arquivo === 'ClienteCodigo9010' && comNomeArquivo.nome_arquivo_em,
    '/sync traz o nome do arquivo escolhido e quando foi trocado');
  res = await req('PUT', '/api/clientes/9010/nome-arquivo', { nome_arquivo: 'Deposito São José' });
  assert(res.status === 400, 'nome do arquivo com espaço/acento é recusado (só letras e números)');
  res = await req('PUT', '/api/clientes/9010/nome-arquivo', { nome_arquivo: '' });
  assert(res.status === 200 && res.body.nome_arquivo === null, 'nome vazio volta pra 1ª palavra do cliente (NULL)');
  res = await req('PUT', '/api/clientes/99999/nome-arquivo', { nome_arquivo: 'Xyz' });
  assert(res.status === 404, 'cliente inexistente: 404');

  // 5c) regime tributário da ficha de CNPJ no /sync - o recado de ICMS-ST do
  // orçamento (gerado offline) muda o texto pra Simples/MEI x regime normal
  mockDb.__seed({
    clientes: [
      { id: 9011, nome: 'REGIME SIMPLES', documento: '11122233000144', codigo_oficial: null },
      { id: 9012, nome: 'REGIME NORMAL', documento: '11122233000225', codigo_oficial: null },
      { id: 9013, nome: 'REGIME MEI', documento: '11122233000306', codigo_oficial: null },
    ],
    fichasCnpj: {
      9011: { dados_brutos: { simples: { optante: true, dataOpcao: '2007-07-01', dataExclusao: null }, mei: { optante: false } } },
      9012: { dados_brutos: { simples: { optante: false, dataOpcao: '2008-09-01', dataExclusao: '2010-12-31' }, mei: { optante: false } } },
      9013: { dados_brutos: { simples: { optante: true }, mei: { optante: true } } },
    },
  });
  res = await req('GET', '/api/clientes/sync');
  const regimeDe = (id) => (res.body.clientes.find(c => c.id === id) || {}).regime_tributario;
  assert(
    regimeDe(9011) === 'simples' && regimeDe(9012) === 'normal' && regimeDe(9013) === 'mei',
    `/sync traz o regime da ficha (simples/normal/mei): ${regimeDe(9011)}/${regimeDe(9012)}/${regimeDe(9013)}`
  );

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

  // 12b) itens de um levantamento (fallback pro caso da cópia local no
  // aparelho ficar vazia - ver doOpenSavedSurvey em index.html)
  const levantamentoIdSalvo = res.body[0].id;
  res = await req('GET', `/api/levantamentos/${levantamentoIdSalvo}/itens`);
  assert(res.status === 200 && res.body.length === 1 && res.body[0].codigo_sku === '60863' && Number(res.body[0].quantidade_contada) === 12, 'itens de um levantamento salvo podem ser recuperados do servidor');
  assert(typeof res.body[0].quantidade_contada === 'string', 'quantidade_contada vem como string (NUMERIC do Postgres) - front precisa converter com Number(), nunca somar direto');

  // 13) classificatório: calcula sobre os ÚLTIMOS 12 MESES (régua móvel da
  // Política Comercial rev. 06 - ver routes/clientesClassificatorio.js) -
  // venda de 400 dias atrás não conta, de 200 dias atrás conta. Datas
  // relativas a hoje, pra o teste não depender do mês em que roda.
  const anoFechado = mockDb.__anoClassificatorioFechado();
  const diasAtras = (n) => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const dataPC1 = diasAtras(400);
  const dataPC2 = diasAtras(200);
  mockDb.__seed({
    clientes: [{
      id: 9001, nome: 'CLIENTE CLASSIFICATORIO TESTE', documento: '99988877000166', codigo_oficial: 'COD9001',
      classificatorio_tipo: 'Varejo Premium', classificatorio_desconto: 17, classificatorio_pic: false, classificatorio_vl_acordo: null, matriz_grupo: null,
    }],
    pedidosOficiaisItens: [
      { nr_pedido: 'PC1', codigo_sku: '60863', cliente_codigo_oficial: 'COD9001', quantidade: 1, valor: 43000, data_faturamento: dataPC1, data_implantacao: dataPC1, status: 'faturado' },
      { nr_pedido: 'PC2', codigo_sku: '60863', cliente_codigo_oficial: 'COD9001', quantidade: 1, valor: 500000, data_faturamento: dataPC2, data_implantacao: dataPC2, status: 'faturado' },
    ],
  });
  res = await req('GET', '/api/clientes/9001/classificatorio/status');
  assert(
    res.status === 200 && res.body.faturamento12m === 500000 && res.body.faturamentoFaixa === 500000
      && res.body.periodoReferencia?.janela === 'ultimos_12_meses' && !res.body.proximaRevisao,
    'classificatório soma os últimos 12 meses (conta a venda de 200 dias, ignora a de 400 dias)'
  );
  const esperadoAnoCorrente = dataPC2 >= `${anoFechado + 1}-01-01` ? 500000 : 0;
  assert(
    res.body.anoCorrente === anoFechado + 1 && res.body.faturamentoAnoCorrente === esperadoAnoCorrente,
    'classificatório também traz o acumulado do ano em andamento (comparativo da ficha do cliente)'
  );

  // 13b) faturamentoMesmoPeriodoAnoAnterior: comparar o acumulado do ano
  // corrente contra o MESMO PERÍODO do ano fechado (não o ano fechado
  // inteiro) - pedido do usuário, pra não parecer sempre "atrás" só porque
  // o ano corrente ainda não terminou. Semeia uma venda garantidamente
  // DENTRO da janela (1º de janeiro do ano fechado) e uma garantidamente
  // FORA (no dia seguinte ao limite "mesmo período", calculado com a mesma
  // aritmética de dias decorridos que o backend usa).
  const agoraTeste = new Date();
  const diasDecorridosTeste = Math.floor((Date.UTC(agoraTeste.getUTCFullYear(), agoraTeste.getUTCMonth(), agoraTeste.getUTCDate()) - Date.UTC(agoraTeste.getUTCFullYear(), 0, 1)) / 86400000);
  const limiteMesmoPeriodoTeste = new Date(Date.UTC(anoFechado, 0, 1) + diasDecorridosTeste * 86400000);
  const dataForaJanelaTeste = new Date(limiteMesmoPeriodoTeste.getTime() + 86400000).toISOString().slice(0, 10);
  mockDb.__seed({
    clientes: [{
      id: 9004, nome: 'CLIENTE YOY TESTE', documento: '99988877000433', codigo_oficial: 'COD9004',
      classificatorio_tipo: 'Varejo Premium', classificatorio_desconto: 17, classificatorio_pic: false, classificatorio_vl_acordo: null, matriz_grupo: null,
    }],
    pedidosOficiaisItens: [
      { nr_pedido: 'PC5', codigo_sku: '60863', cliente_codigo_oficial: 'COD9004', quantidade: 1, valor: 20000, data_faturamento: `${anoFechado}-01-01`, status: 'faturado' },
      { nr_pedido: 'PC6', codigo_sku: '60863', cliente_codigo_oficial: 'COD9004', quantidade: 1, valor: 99999, data_faturamento: dataForaJanelaTeste, status: 'faturado' },
    ],
  });
  const resYoy = await req('GET', '/api/clientes/9004/classificatorio/status');
  assert(
    resYoy.status === 200 && resYoy.body.faturamentoMesmoPeriodoAnoAnterior === 20000,
    `faturamentoMesmoPeriodoAnoAnterior soma só o mesmo período do ano fechado (20.000), ignora venda fora da janela: ${resYoy.body.faturamentoMesmoPeriodoAnoAnterior}`
  );

  // 14) o mini gráfico trimestral deve trazer os trimestres RECENTES (janela
  // móvel terminando no trimestre em andamento agora), não presos ao ano
  // civil fechado - senão o vendedor nunca consegue "acompanhar os
  // trimestres recentes" (ex: em setembro/2026, precisa ver T4/2025 em
  // diante, não T2/2025 pra trás). PC1 (junho do ano fechado) fica de fora
  // dessa janela; PC2 (janeiro do ano em andamento) entra.
  const somaTrimestres = (res.body.trimestral?.historico || []).reduce((acc, t) => acc + Number(t.faturado), 0);
  assert(
    somaTrimestres === 500000,
    `gráfico trimestral mostra a janela móvel recente (tem a venda de 200 dias, não a de 400 dias): ${somaTrimestres}`
  );

  // 14b) Política Comercial rev. 06: a faixa é decidida pelos últimos 12
  // meses - sobe assim que bater o teto (apuração mensal) e ficar abaixo do
  // mínimo da própria faixa é risco de queda, sem depender do ritmo
  // trimestral. Faixas de todos os canais. Teste direto na função pura.
  const { calcularStatusClassificatorio } = require('../routes/clientesClassificatorio');
  let s = calcularStatusClassificatorio({ tipo: 'Varejo Premium', faturamento12m: 55000, faturamentoAnoCorrente: 1000, atrasadoNoRitmo: false });
  assert(
    s.jaQualificaProximaFaixa === true && s.faltaPraProximaFaixa == null && s.faturamentoFaixa === 55000,
    'sobe de faixa quando os últimos 12 meses batem o teto (independe do acumulado do ano)'
  );
  s = calcularStatusClassificatorio({ tipo: 'Varejo Master', faturamento12m: 60000, faturamentoAnoCorrente: 10000, atrasadoNoRitmo: true });
  assert(s.emRiscoDeQueda === false, 'últimos 12 meses acima do mínimo da faixa não é risco de queda');
  s = calcularStatusClassificatorio({ tipo: 'Varejo Master', faturamento12m: 40000, faturamentoAnoCorrente: 90000, atrasadoNoRitmo: false });
  assert(
    s.emRiscoDeQueda === true && s.faltaPraManter === 10000 && s.faixaAnterior === 'Varejo Premium',
    'últimos 12 meses abaixo do mínimo (40 mil < 50 mil) é risco de queda: faltam R$10.000'
  );
  s = calcularStatusClassificatorio({ tipo: 'Atacado Premium', faturamento12m: 800000 });
  assert(s.faltaPraProximaFaixa === 200000 && s.proximaFaixa === 'Atacado Master', 'Atacado Premium com 800 mil: faltam 200 mil pra Master (1 milhão)');
  s = calcularStatusClassificatorio({ tipo: 'E-Commerce Exclusive', faturamento12m: 150000 });
  assert(s.faltaPraProximaFaixa === 50000 && s.proximaFaixa === 'E-commerce Premium', 'E-commerce Exclusive com 150 mil: faltam 50 mil pra Premium (nome do ERP com outra grafia resolve a faixa)');
  s = calcularStatusClassificatorio({ tipo: 'Home Center Premium', faturamento12m: 100000 });
  assert(s.emRiscoDeQueda === true && s.faltaPraManter === 20000, 'Home Center Premium abaixo de 120 mil é risco de queda');
  s = calcularStatusClassificatorio({ tipo: 'Locação', faturamento12m: 5000 });
  assert(s.classificado === true && s.semFaixaDefinida === true, 'Locação (Institucional) é fixo, sem faixa');
  s = calcularStatusClassificatorio({ tipo: 'Varejo Master', pic: true, vlAcordo: 80000, faturamento12m: 90000, faturamentoAnoCorrente: 30000, atrasadoNoRitmo: true });
  assert(s.faltaPraMeta === 50000 && s.emRiscoDeQueda === true && s.faturamentoFaixa === 30000, 'meta individual (PIC) continua contra o acumulado do ano, com risco pelo ritmo');

  // 14a) faltaTrimestreAtual: quanto falta pra bater a meta DESTE trimestre
  // especificamente (não o ritmo ajustado pros trimestres seguintes) -
  // destacado na UI a pedido do usuário. Master: meta anual = mínimo da
  // faixa (50.000, sem teto), meta por trimestre = 12.500.
  const { calcularRitmoTrimestral } = require('../routes/clientesClassificatorio');
  let ritmoTeste = calcularRitmoTrimestral({
    tipo: 'Varejo Master',
    trimestres: [{ trimestre: '2026-01-01', faturado: 5000 }],
    anoReferencia: 2026, trimestreReferenciaIdx: 0,
  });
  assert(
    ritmoTeste.faltaTrimestreAtual === 7500,
    `faltaTrimestreAtual calcula quanto falta pra bater a meta do trimestre atual (12.500 - 5.000 = 7.500): ${ritmoTeste.faltaTrimestreAtual}`
  );
  ritmoTeste = calcularRitmoTrimestral({
    tipo: 'Varejo Master',
    trimestres: [{ trimestre: '2026-01-01', faturado: 15000 }],
    anoReferencia: 2026, trimestreReferenciaIdx: 0,
  });
  assert(
    ritmoTeste.faltaTrimestreAtual === 0,
    'faltaTrimestreAtual não fica negativo quando a meta do trimestre já foi batida'
  );

  // 14c) rota em lote (/classificatorio/alertas) usa a mesma regra acima,
  // mas calculada em lote (uma janela de trimestres pra todos os clientes
  // classificados de uma vez, não N+1 consultas) - só confere que a rota
  // não quebra com a consulta nova e devolve os 3 grupos esperados.
  res = await req('GET', '/api/clientes/classificatorio/alertas');
  assert(
    res.status === 200 && Array.isArray(res.body.pertoDeSubir) && Array.isArray(res.body.riscoDeQueda) && Array.isArray(res.body.semComprarRecente),
    'rota de alertas em lote responde com os 3 grupos, usando a consulta trimestral em lote nova'
  );

  // 14c-bis) o histórico trimestral soma por DATA_IMPLANTACAO (entrada do
  // pedido no ERP), não por data de faturamento, e conta tanto 'carteira'
  // quanto 'faturado' - bate com a metodologia do relatório oficial de
  // "Entrada Realizada" (ver plano "Meta trimestral oficial"). PC9 é
  // 'carteira' (ainda não faturado) mas implantado dentro da janela: deve
  // contar. PC10 é 'faturado' dentro da janela de faturamento mas
  // implantado FORA da janela (trimestre antigo): não deve contar.
  mockDb.__seed({
    clientes: [{
      id: 9007, nome: 'CLIENTE IMPLANTACAO TESTE', documento: '99988877000700', codigo_oficial: 'COD9007',
      classificatorio_tipo: 'Varejo Premium', classificatorio_desconto: 17, classificatorio_pic: false, classificatorio_vl_acordo: null, matriz_grupo: null,
    }],
    pedidosOficiaisItens: [
      { nr_pedido: 'PC9', codigo_sku: '60863', cliente_codigo_oficial: 'COD9007', quantidade: 1, valor: 7000, data_faturamento: null, data_implantacao: `${anoFechado + 1}-01-10`, status: 'carteira' },
      { nr_pedido: 'PC10', codigo_sku: '60863', cliente_codigo_oficial: 'COD9007', quantidade: 1, valor: 88888, data_faturamento: `${anoFechado + 1}-01-10`, data_implantacao: `${anoFechado}-06-15`, status: 'faturado' },
    ],
  });
  const resImplantacao = await req('GET', '/api/clientes/9007/classificatorio/status');
  const trimestresImplantacao = (resImplantacao.body.trimestral?.historico || []).reduce((s, t) => s + Number(t.faturado), 0);
  assert(
    resImplantacao.status === 200 && trimestresImplantacao === 7000,
    `histórico trimestral soma pedido em carteira dentro da janela de implantação (7.000) e ignora pedido faturado cuja implantação está fora da janela (88.888 não conta): ${trimestresImplantacao}`
  );

  // 14d) Rede: métrica e gráfico devem ser SÓ do próprio cliente, mesmo
  // compartilhando matriz_grupo com outra loja da mesma rede/cooperativa
  // (matriz_grupo pra Rede é o nome da rede, não empresas irmãs - somar
  // misturaria lojas sem relação societária). Semeia um cliente Rede e
  // outro cliente (não-Rede) no MESMO matriz_grupo com faturamento bem
  // maior, pra confirmar que o cliente Rede não "herda" esse valor.
  mockDb.__seed({
    clientes: [
      {
        id: 9005, nome: 'CLIENTE REDE TESTE', documento: '99988877000522', codigo_oficial: 'COD9005',
        classificatorio_tipo: 'Rede', classificatorio_desconto: 18, classificatorio_pic: false, classificatorio_vl_acordo: null, matriz_grupo: 'REDE TESTE',
      },
      {
        id: 9006, nome: 'OUTRA LOJA DA MESMA REDE', documento: '99988877000611', codigo_oficial: 'COD9006',
        classificatorio_tipo: 'Varejo Master', classificatorio_desconto: 20, classificatorio_pic: false, classificatorio_vl_acordo: null, matriz_grupo: 'REDE TESTE',
      },
    ],
    pedidosOficiaisItens: [
      // Tudo dentro dos últimos 12 meses e da janela trimestral móvel.
      { nr_pedido: 'PC7', codigo_sku: '60863', cliente_codigo_oficial: 'COD9005', quantidade: 1, valor: 8000, data_faturamento: diasAtras(200), data_implantacao: diasAtras(200), status: 'faturado' },
      { nr_pedido: 'PC7B', codigo_sku: '60863', cliente_codigo_oficial: 'COD9005', quantidade: 1, valor: 3000, data_faturamento: diasAtras(100), data_implantacao: diasAtras(100), status: 'faturado' },
      { nr_pedido: 'PC8', codigo_sku: '60863', cliente_codigo_oficial: 'COD9006', quantidade: 1, valor: 900000, data_faturamento: diasAtras(200), data_implantacao: diasAtras(200), status: 'faturado' },
      { nr_pedido: 'PC8B', codigo_sku: '60863', cliente_codigo_oficial: 'COD9006', quantidade: 1, valor: 500000, data_faturamento: diasAtras(100), data_implantacao: diasAtras(100), status: 'faturado' },
    ],
  });
  const resRede = await req('GET', '/api/clientes/9005/classificatorio/status');
  assert(
    resRede.status === 200 && resRede.body.ehRede === true && resRede.body.faturamento12m === 11000,
    `cliente Rede mostra só o próprio faturamento (11.000), não somado com a outra loja da rede (1,4 milhão): ${resRede.body.faturamento12m}`
  );
  const trimestresRede = (resRede.body.trimestral?.historico || []).reduce((s, t) => s + Number(t.faturado), 0);
  assert(
    trimestresRede === 11000,
    `histórico trimestral do cliente Rede também é só individual (11.000), não soma a outra loja: ${trimestresRede}`
  );

  // 15) grupo (matriz_grupo) do classificatório: um cliente sem grupo não
  // traz nenhum membro; só admin pode incluir um cliente num grupo; depois
  // de incluído, a lista de membros traz cada empresa com seu PRÓPRIO
  // faturamento (não a soma do grupo), ordenada do que compra menos pro que
  // compra mais - é o ponto do pedido (achar quem no grupo está comprando
  // pouco).
  res = await req('GET', '/api/clientes/9001/classificatorio/grupo');
  assert(res.status === 200 && res.body.matrizGrupo === null && res.body.membros.length === 0, 'cliente sem grupo não traz nenhum membro');

  mockDb.__seed({
    clientes: [{
      id: 9002, nome: 'CLIENTE CLASSIFICATORIO TESTE 2 (GRUPO)', documento: '99988877000255', codigo_oficial: 'COD9002',
      classificatorio_tipo: 'Varejo Exclusive', classificatorio_desconto: 15, classificatorio_pic: false, classificatorio_vl_acordo: null, matriz_grupo: null,
    }],
    pedidosOficiaisItens: [
      { nr_pedido: 'PC3', codigo_sku: '60863', cliente_codigo_oficial: 'COD9002', quantidade: 1, valor: 10000, data_faturamento: diasAtras(150), status: 'faturado' },
    ],
  });

  const criadoNaoAdmin = await mockDb.pool.query(
    'INSERT INTO usuarios (nome, email, google_sub, is_admin) VALUES ($1, $2, $3, false) RETURNING id, nome, email, is_admin',
    ['Vendedor Comum', 'vendedor@example.com', 'sub-teste-vendedor']
  );
  const tokenNaoAdmin = generateToken();
  await mockDb.pool.query('INSERT INTO sessoes (token, usuario_id, expira_em) VALUES ($1, $2, $3)', [hashToken(tokenNaoAdmin), criadoNaoAdmin.rows[0].id, '90']);
  const tokenOriginal = authToken;
  authToken = tokenNaoAdmin;
  res = await req('PATCH', '/api/clientes/9001/matriz-grupo', { matriz_grupo: 'GRUPO TESTE' });
  assert(res.status === 403, 'só admin pode incluir/alterar o grupo (matriz) de um cliente');
  authToken = tokenOriginal;

  res = await req('PATCH', '/api/clientes/9001/matriz-grupo', { matriz_grupo: 'GRUPO TESTE' });
  assert(res.status === 200, 'admin cria o grupo a partir do cliente atual');
  res = await req('PATCH', '/api/clientes/9002/matriz-grupo', { matriz_grupo: 'GRUPO TESTE' });
  assert(res.status === 200, 'admin inclui outro cliente no mesmo grupo');

  res = await req('GET', '/api/clientes/9001/classificatorio/grupo');
  const nomes = (res.body.membros || []).map(m => m.nome);
  assert(
    res.status === 200 && res.body.matrizGrupo === 'GRUPO TESTE' && res.body.membros.length === 2
      && nomes[0] === 'CLIENTE CLASSIFICATORIO TESTE 2 (GRUPO)' && res.body.membros[0].faturamento12m === 10000
      && res.body.membros[1].faturamento12m === 500000,
    `lista os dois membros do grupo, o que compra menos primeiro: ${JSON.stringify(res.body.membros)}`
  );

  // 15b) Objetivo trimestral (ERP) - "Falta p/ Objetivo": importa uma
  // planilha com um cliente normal (objetivo importado e calculado), um
  // cliente Rede (pulado - RDA/Rede fora de escopo por enquanto) e uma
  // linha com nome não reconhecido (aparece no resumo de erro).
  const periodoObjInicio = `${anoFechado + 1}-01-01`;
  const periodoObjFim = `${anoFechado + 1}-03-31`;
  mockDb.__seed({
    clientes: [{
      id: 9008, nome: 'CLIENTE OBJETIVO TESTE', documento: '99988877000788', codigo_oficial: 'COD9008',
      classificatorio_tipo: 'Varejo Premium', classificatorio_desconto: 17, classificatorio_pic: false, classificatorio_vl_acordo: null, matriz_grupo: null,
    }],
    pedidosOficiaisItens: [
      { nr_pedido: 'PC11', codigo_sku: '60863', cliente_codigo_oficial: 'COD9008', quantidade: 1, valor: 5000, data_faturamento: null, data_implantacao: `${anoFechado + 1}-02-15`, status: 'carteira' },
    ],
  });
  res = await req('POST', '/api/clientes/classificatorio/objetivos-trimestrais/importar', {
    periodoInicio: periodoObjInicio,
    periodoFim: periodoObjFim,
    itens: [
      { matriz: 'CLIENTE OBJETIVO TESTE', objetivo: 8000 },
      { matriz: 'REDE TESTE', objetivo: 999999 }, // matriz_grupo do cliente Rede (9005) - deve ser pulado
      { matriz: 'CLIENTE FANTASMA SA', objetivo: 1234 }, // nome que não bate com nenhum cliente
    ],
  });
  assert(
    res.status === 200 && res.body.importados === 1 && res.body.pulosRede === 1 && res.body.naoReconhecidos?.length === 1 && res.body.naoReconhecidos[0] === 'CLIENTE FANTASMA SA',
    `import de objetivos trimestrais: 1 importado, 1 Rede pulado, 1 não reconhecido: ${JSON.stringify(res.body)}`
  );

  res = await req('GET', '/api/clientes/9008/classificatorio/status');
  assert(
    res.status === 200 && res.body.objetivoTrimestral === 8000 && res.body.entradaTrimestral === 5000 && res.body.faltaPObjetivo === 3000,
    `faltaPObjetivo calcula objetivo (8.000) menos entrada no período (5.000) = 3.000: ${JSON.stringify({ objetivoTrimestral: res.body.objetivoTrimestral, entradaTrimestral: res.body.entradaTrimestral, faltaPObjetivo: res.body.faltaPObjetivo })}`
  );

  // cliente Rede (9005) não recebeu objetivo (foi pulado no import) -
  // faltaPObjetivo deve ficar ausente/null, convivendo sem quebrar a rota.
  res = await req('GET', '/api/clientes/9005/classificatorio/status');
  assert(
    res.status === 200 && res.body.faltaPObjetivo == null,
    'cliente Rede pulado no import não recebe objetivo trimestral (faltaPObjetivo ausente)'
  );

  // 15c) Planilha Classificatório do ERP com data (nome do arquivo): troca a
  // faixa parada do cliente (antes só preenchia quem não tinha nenhuma - 22
  // clientes ficaram com a faixa errada por isso) e grava a foto financeira
  // oficial, que a rota de status devolve em `erp` pro card da aba Clientes.
  mockDb.__seed({
    clientes: [{
      id: 9060, nome: 'CLIENTE PLANILHA ERP', documento: '11222333000181', codigo_oficial: 'COD9060',
      classificatorio_tipo: 'Varejo Exclusive', classificatorio_desconto: 15, classificatorio_atualizado_em: '2024-07-24',
      classificatorio_pic: false, classificatorio_vl_acordo: null, matriz_grupo: null,
    }],
  });
  const linhaPlanilhaErp = {
    codigoOficial: 'COD9060', cnpj: '11.222.333/0001-81', matrizGrupo: 'ROTTA MATERIAIS DE CONSTRUCAO LTDA',
    classificatorioTipo: 'Varejo Premium', classificatorioDesconto: 17, pic: false, vlAcordo: null,
    fatAnoAnterior: 35832.56, fatAcumulado: 26856.48, fat12mCliente: 15677.37, fat12mMatriz: 39122.52, diferenca: 10877.47,
    gestor: 'VILMAR HEDLER JUNIOR', situacao: 'Ativo', cidade: 'Mambore', uf: 'PR', clienteDesde: '2009-07-01', ultimaCompra: '2026-07-27',
  };
  res = await req('POST', '/api/clientes/classificatorio/importar', { dataRelatorio: '2026-10-02', apuradoAte: '2026-08-31', itens: [linhaPlanilhaErp] });
  assert(res.status === 200 && res.body.atualizados === 1, `import da planilha Classificatório com data: ${JSON.stringify(res.body)}`);
  res = await req('GET', '/api/clientes/9060/classificatorio/status');
  const erp = res.body.erp || {};
  assert(
    res.status === 200 && res.body.tipo === 'Varejo Premium' && res.body.matrizGrupo === 'ROTTA MATERIAIS DE CONSTRUCAO LTDA',
    `planilha mais nova troca a faixa parada (Exclusive de 2024 -> Premium): ${res.body.tipo}`
  );
  assert(
    erp.dataRelatorio === '2026-10-02' && erp.apuradoAte === '2026-08-31' && erp.fat12mCliente === 15677.37
      && erp.fat12mMatriz === 39122.52 && erp.fatAnoAnterior === 35832.56 && erp.fatAcumulado === 26856.48
      && erp.ultimaCompra === '2026-07-27' && erp.clienteDesde === '2009-07-01' && erp.cidade === 'Mambore' && erp.gestor === 'VILMAR HEDLER JUNIOR'
      && erp.leituraDiferenca?.situacao === 'subir' && erp.leituraDiferenca.falta === 10877.47 && erp.leituraDiferenca.proximaFaixa === 'Varejo Master'
      && erp.fat12mOutrasEmpresas === 23445.15,
    `status devolve a foto oficial da planilha (números iguais aos dela): ${JSON.stringify(erp)}`
  );
  // relatório mais antigo não desfaz nem a faixa nem a foto
  res = await req('POST', '/api/clientes/classificatorio/importar', {
    dataRelatorio: '2026-09-01', apuradoAte: '2026-07-31',
    itens: [{ ...linhaPlanilhaErp, classificatorioTipo: 'Varejo Exclusive', classificatorioDesconto: 15, fat12mCliente: 1 }],
  });
  res = await req('GET', '/api/clientes/9060/classificatorio/status');
  assert(
    res.body.tipo === 'Varejo Premium' && res.body.erp?.fat12mCliente === 15677.37 && res.body.erp?.dataRelatorio === '2026-10-02',
    'planilha Classificatório mais antiga não volta a faixa nem a foto financeira'
  );
  // sem data (formato antigo do import): não troca faixa existente nem grava foto
  mockDb.__seed({
    clientes: [{ id: 9061, nome: 'CLIENTE SEM DATA', documento: '11222333000262', codigo_oficial: 'COD9061', classificatorio_tipo: 'Varejo Master', classificatorio_desconto: 20, classificatorio_pic: false }],
  });
  res = await req('POST', '/api/clientes/classificatorio/importar', { itens: [{ ...linhaPlanilhaErp, codigoOficial: 'COD9061', cnpj: null, classificatorioTipo: 'Varejo Exclusive' }] });
  res = await req('GET', '/api/clientes/9061/classificatorio/status');
  assert(res.body.tipo === 'Varejo Master' && res.body.erp == null, 'import sem data do relatório mantém a faixa e não grava foto');

  // Alertas: o 9060 não tem venda no app (ao vivo = R$0, abaixo do mínimo
  // do Premium), mas a matriz dele no ERP tem R$ 23.445 de outras empresas
  // fora do app - o ERP diz que faltam R$ 10.877 pra SUBIR, não que vai cair.
  // O 9061 (sem foto do ERP) continua pela conta ao vivo.
  res = await req('GET', '/api/clientes/classificatorio/alertas');
  const emRisco = (res.body.riscoDeQueda || []).map(c => c.id);
  assert(
    res.status === 200 && !emRisco.includes(9060) && emRisco.includes(9061),
    `alertas: matriz com empresas fora do app usa o veredito do ERP (9060 fora do risco), sem foto continua ao vivo (9061 em risco): ${JSON.stringify(emRisco)}`
  );
  const { aplicarLeituraErp } = require('../routes/clientesClassificatorio');
  let sErp = aplicarLeituraErp({ tipo: 'Varejo Premium', emRiscoDeQueda: true, faltaPraManter: 30000, faixaMin: 0, faixaMax: 30000 },
    { situacao: 'subir', falta: 10877.47, proximaFaixa: 'Varejo Master' });
  assert(
    sErp.emRiscoDeQueda === false && sErp.faltaPraManter == null && sErp.faltaPraProximaFaixa === 10877.47
      && sErp.proximaFaixa === 'Varejo Master' && sErp.faixaMax == null && sErp.fonteFaixa === 'erp',
    'aplicarLeituraErp troca "vai cair" ao vivo por "falta pra subir" oficial e tira a barra'
  );
  sErp = aplicarLeituraErp({ tipo: 'Varejo Master', emRiscoDeQueda: false, faltaPraProximaFaixa: null },
    { situacao: 'manter', falta: 4000, faixaAnterior: 'Varejo Premium' });
  assert(sErp.emRiscoDeQueda === true && sErp.faltaPraManter === 4000 && sErp.faixaAnterior === 'Varejo Premium', 'aplicarLeituraErp: ERP abaixo do mínimo vira risco de queda');

  // Conciliação ERP × app no status: apuração do ERP fechada há 30 dias.
  // A = venda depois da apuração (app conta, ERP ainda não); B = venda que o
  // ERP ainda conta e o app já tirou da janela de 12 meses; C = nos dois.
  // ERP = B + C - 50 (devolução lançada só no ERP) -> "outras" = -50.
  {
    const iso = d => d.toISOString().slice(0, 10);
    const diasAtras = n => { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return iso(d); };
    const apurado = diasAtras(30);
    const ap = new Date(apurado + 'T00:00:00Z');
    const dataB = iso(new Date(Date.UTC(ap.getUTCFullYear() - 1, ap.getUTCMonth(), ap.getUTCDate() + 6)));
    mockDb.__seed({
      clientes: [{ id: 9062, nome: 'CLIENTE CONCILIACAO', documento: '11222333000343', codigo_oficial: 'COD9062',
        classificatorio_tipo: 'Varejo Master', classificatorio_desconto: 20, classificatorio_pic: false, matriz_grupo: null }],
      pedidosOficiaisItens: [
        { nr_pedido: 'CA1', codigo_sku: '60863', cliente_codigo_oficial: 'COD9062', quantidade: 1, valor: 1000, data_faturamento: diasAtras(10), status: 'faturado' },
        { nr_pedido: 'CB1', codigo_sku: '60863', cliente_codigo_oficial: 'COD9062', quantidade: 1, valor: 700, data_faturamento: dataB, status: 'faturado' },
        { nr_pedido: 'CC1', codigo_sku: '60863', cliente_codigo_oficial: 'COD9062', quantidade: 1, valor: 5000, data_faturamento: diasAtras(100), status: 'faturado' },
      ],
    });
    res = await req('POST', '/api/clientes/classificatorio/importar', {
      dataRelatorio: diasAtras(0), apuradoAte: apurado,
      itens: [{ codigoOficial: 'COD9062', classificatorioTipo: 'Varejo Master', classificatorioDesconto: 20, fat12mCliente: 5650, fat12mMatriz: 5650, fatAcumulado: null }],
    });
    res = await req('GET', '/api/clientes/9062/classificatorio/status');
    const doze = res.body.erp?.conciliacao?.doze;
    assert(
      doze && doze.app === 6000 && doze.depoisApuracao === 1000 && doze.foraDaJanelaApp === 700 && doze.erp === 5650 && doze.outras === -50
        && res.body.erp.conciliacao.periodoErp.fim === apurado,
      `conciliação ERP × app: app 6.000 - 1.000 (depois da apuração) + 700 (ERP ainda conta) - 50 (outras) = ERP 5.650: ${JSON.stringify(res.body.erp?.conciliacao)}`
    );
  }

  // Leitura da coluna "Diferenca" (conferida contra a planilha real de 02/10/2026)
  const { interpretarDiferencaErp } = require('../routes/clientesClassificatorio');
  let ld = interpretarDiferencaErp({ tipo: 'Varejo Premium', fat12mMatriz: 21438.53, diferenca: 8561.47 });
  assert(ld.situacao === 'manter' && ld.falta === 8561.47 && ld.faixaAnterior === 'Varejo Exclusive', 'Premium abaixo de 30 mil: Diferenca = falta pra manter Premium');
  ld = interpretarDiferencaErp({ tipo: 'Varejo Master', fat12mMatriz: 7339.93, diferenca: 42660.07 });
  assert(ld.situacao === 'manter' && ld.falta === 42660.07, 'Master abaixo de 50 mil: Diferenca = falta pra manter Master');
  ld = interpretarDiferencaErp({ tipo: 'Varejo Exclusive', fat12mMatriz: 5636.36, diferenca: 24363.63 });
  assert(ld.situacao === 'subir' && ld.proximaFaixa === 'Varejo Premium', 'Exclusive: Diferenca = falta pra subir pra Premium');
  ld = interpretarDiferencaErp({ tipo: 'Varejo Exclusive', fat12mMatriz: 30197.44, diferenca: null });
  assert(ld.situacao === 'qualifica' && ld.proximaFaixa === 'Varejo Premium', 'Exclusive acima de 30 mil sem Diferenca: já qualifica pra Premium');
  ld = interpretarDiferencaErp({ tipo: 'Varejo Master', fat12mMatriz: 80000, diferenca: null });
  assert(ld.situacao === 'topo', 'Master acima de 50 mil: faixa máxima');
  ld = interpretarDiferencaErp({ tipo: 'Varejo Premium', pic: true, vlAcordo: 30000, fat12mMatriz: 23774.73, diferenca: 6225.27 });
  assert(ld.situacao === 'meta' && ld.falta === 6225.27 && ld.meta === 30000, 'PIC: Diferenca = falta pra meta do acordo');
  assert(interpretarDiferencaErp({ tipo: 'Varejo Master', pic: true, vlAcordo: 90000, fat12mMatriz: 80237, diferenca: null }) === null, 'PIC sem Diferenca: não afirma nada');
  assert(interpretarDiferencaErp({ tipo: 'Rede', fat12mMatriz: 6170157.91, diferenca: null }) === null, 'Rede não tem faixa');

  // 16) GET /api/dashboard/resumo: os cartões "Contas - 3 a 5/6 a 8 Meses Sem
  // Compra" precisam trazer a LISTA de clientes (não só a contagem), pra dar
  // pra expandir e ver quem são - senão o card só mostra um número sem
  // nenhum jeito de agir sobre ele.
  function diasAtrasISO(n) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  }
  mockDb.__seed({
    clientes: [{
      id: 9003, nome: 'CLIENTE SUMIDO 150 DIAS', documento: '99988877000344', codigo_oficial: 'COD9003',
      classificatorio_tipo: null, classificatorio_desconto: null, classificatorio_pic: false, classificatorio_vl_acordo: null, matriz_grupo: null,
    }],
    pedidosOficiaisItens: [
      { nr_pedido: 'PC4', codigo_sku: '60863', cliente_codigo_oficial: 'COD9003', quantidade: 1, valor: 1000, data_faturamento: diasAtrasISO(150), status: 'faturado' },
    ],
  });
  res = await req('GET', '/api/dashboard/resumo');
  const listaDe3a5 = res.body.contasSemComprar?.clientesDe3a5Meses || [];
  const achado = listaDe3a5.find(c => c.id === 9003);
  assert(
    res.status === 200 && res.body.contasSemComprar?.de3a5Meses === listaDe3a5.length
      && achado && achado.nome === 'CLIENTE SUMIDO 150 DIAS' && achado.diasSemComprar === 150,
    `dashboard/resumo traz a lista de clientes de 3-5 meses sem comprar, com nome e dias: ${JSON.stringify(listaDe3a5)}`
  );

  // 16b) GET /api/dashboard/resumo: "Valor Entrada de Pedidos" segue a regra
  // do painel oficial - mês pela data de implantação, carteira + faturado, e
  // sem a série de pedidos de 7 dígitos. Pedido implantado no mês passado e
  // faturado neste NÃO conta neste mês.
  const hojeUtc = new Date();
  const mesAtualISO = new Date(Date.UTC(hojeUtc.getUTCFullYear(), hojeUtc.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const mesAnteriorISO = new Date(Date.UTC(hojeUtc.getUTCFullYear(), hojeUtc.getUTCMonth() - 1, 1)).toISOString().slice(0, 10);
  mockDb.__seed({
    pedidosOficiaisItens: [
      { nr_pedido: '700001', codigo_sku: '1', cliente_codigo_oficial: 'E1', quantidade: 1, valor: 1000, data_implantacao: mesAtualISO, data_faturamento: mesAtualISO, status: 'faturado' },
      { nr_pedido: '700002', codigo_sku: '1', cliente_codigo_oficial: 'E2', quantidade: 1, valor: 500, data_implantacao: mesAtualISO, data_faturamento: null, status: 'carteira' },
      { nr_pedido: '1330001', codigo_sku: '1', cliente_codigo_oficial: 'E3', quantidade: 1, valor: 100, data_implantacao: mesAtualISO, data_faturamento: mesAtualISO, status: 'faturado' },
      { nr_pedido: '690001', codigo_sku: '1', cliente_codigo_oficial: 'E4', quantidade: 1, valor: 9000, data_implantacao: mesAnteriorISO, data_faturamento: mesAtualISO, status: 'faturado' },
    ],
  });
  res = await req('GET', '/api/dashboard/resumo');
  const entradaMes = (res.body.mensal || []).find(m => String(m.periodo).slice(0, 10) === mesAtualISO);
  assert(
    res.status === 200 && entradaMes && entradaMes.valor === 1500 && entradaMes.pedidos === 2 && entradaMes.clientes === 2,
    `entrada de pedidos do mês = implantados no mês (carteira + faturado), sem série de 7 dígitos: ${JSON.stringify(res.body.mensal)}`
  );

  // 16b2) A série mensal vem com os 12 meses, terminando no mês atual, e mês
  // sem pedido vem zerado. Antes só vinham os meses com pedido e a tela pegava
  // a última linha como "o mês": no dia 1º, sem pedido importado ainda, o
  // Dashboard mostrava os números do mês passado como se fossem do atual.
  const serieMensal = res.body.mensal || [];
  const mesesEsperados = Array.from({ length: 12 }, (_, i) =>
    new Date(Date.UTC(hojeUtc.getUTCFullYear(), hojeUtc.getUTCMonth() - 11 + i, 1)).toISOString().slice(0, 10));
  assert(
    JSON.stringify(serieMensal.map(m => String(m.periodo).slice(0, 10))) === JSON.stringify(mesesEsperados)
      && serieMensal.some(m => Number(m.valor) === 0 && Number(m.pedidos) === 0),
    `série mensal = 12 meses seguidos terminando no atual, mês sem pedido zerado: ${JSON.stringify(serieMensal)}`
  );

  // 16b3) A comparação do cartão é com o mês anterior só até o mesmo dia de
  // hoje: pedido do dia 1º do mês passado entra; do último dia (depois de
  // hoje, exceto no dia 28+) não.
  const diaHoje = hojeUtc.getUTCDate();
  const ultimoDiaMesAnterior = new Date(Date.UTC(hojeUtc.getUTCFullYear(), hojeUtc.getUTCMonth(), 0)).getUTCDate();
  const ateEsperado = new Date(Date.UTC(hojeUtc.getUTCFullYear(), hojeUtc.getUTCMonth() - 1, Math.min(diaHoje, ultimoDiaMesAnterior))).toISOString().slice(0, 10);
  const fimMesAnteriorISO = new Date(Date.UTC(hojeUtc.getUTCFullYear(), hojeUtc.getUTCMonth(), 0)).toISOString().slice(0, 10);
  mockDb.__seed({
    pedidosOficiaisItens: [
      { nr_pedido: '690003', codigo_sku: '1', cliente_codigo_oficial: 'E5', quantidade: 1, valor: 300, data_implantacao: fimMesAnteriorISO, data_faturamento: null, status: 'carteira' },
    ],
  });
  res = await req('GET', '/api/dashboard/resumo');
  const mesmoPeriodo = res.body.entradaMesAnteriorAteHoje;
  // 9000 = pedido 690001 do dia 1º do mês passado (16b); 300 = último dia do
  // mês passado, que só entra quando hoje já é esse dia ou depois.
  const esperadoMesmoPeriodo = 9000 + (fimMesAnteriorISO <= ateEsperado ? 300 : 0);
  assert(
    res.status === 200 && mesmoPeriodo && String(mesmoPeriodo.ate).slice(0, 10) === ateEsperado && Number(mesmoPeriodo.valor) === esperadoMesmoPeriodo,
    `entrada do mês anterior até o mesmo dia de hoje (${ateEsperado}) = ${esperadoMesmoPeriodo}: ${JSON.stringify(mesmoPeriodo)}`
  );

  // 16c) ...e a lista que abre ao tocar no cartão traz esses mesmos pedidos,
  // um por linha (itens somados), com o nome do cliente quando ele existe no
  // app e o código quando ainda não foi vinculado.
  mockDb.__seed({
    clientes: [{
      id: 9004, nome: 'CLIENTE ENTRADA E1', documento: '11122233000144', codigo_oficial: 'E1',
      classificatorio_tipo: null, classificatorio_desconto: null, classificatorio_pic: false, classificatorio_vl_acordo: null, matriz_grupo: null,
    }],
    pedidosOficiaisItens: [
      { nr_pedido: '700001', codigo_sku: '2', cliente_codigo_oficial: 'E1', quantidade: 1, valor: 250, data_implantacao: mesAtualISO, data_faturamento: mesAtualISO, status: 'faturado' },
    ],
  });
  res = await req('GET', '/api/dashboard/resumo');
  const listaEntrada = res.body.entradaPedidosMes || [];
  const pedE1 = listaEntrada.find(p => p.nr_pedido === '700001');
  const pedE2 = listaEntrada.find(p => p.nr_pedido === '700002');
  assert(
    res.status === 200 && listaEntrada.length === 2
      && pedE1 && pedE1.cliente_nome === 'CLIENTE ENTRADA E1' && pedE1.valor === 1250
      && pedE2 && pedE2.cliente_nome == null && pedE2.cliente_codigo_oficial === 'E2' && pedE2.valor === 500,
    `lista da entrada de pedidos do mês: um por pedido, com nome do cliente, sem a série de 7 dígitos: ${JSON.stringify(listaEntrada)}`
  );

  // 17) Sugestões de recompra: agrupamento de variações pelo nome
  // (routes/lib/agrupamentoProduto.js) - tamanhos diferentes viram um item só,
  // tipos diferentes do mesmo produto continuam separados.
  const { grupoDoProduto } = require('../routes/lib/agrupamentoProduto');
  const gEsp = ['ESPAÇADOR NIVELADOR 0,5 mm', 'ESPAÇADOR NIVELADOR 2,0 mm', 'ESPACADOR NIVELADOR 1,0 mm SMART - PACOTE C/ 50 UN']
    .map(n => grupoDoProduto(n).chave);
  assert(new Set(gEsp).size === 1 && grupoDoProduto('ESPAÇADOR NIVELADOR 0,5 mm').rotulo === 'Espaçador Nivelador',
    `variações de Espaçador Nivelador viram um grupo só: ${JSON.stringify(gEsp)}`);
  const gBrocas = ['BROCA DE AÇO RAPIDO 3,0 mm', 'BROCA C/ PONTA DE METAL DURO P/ CONCRETO 6 mm', 'BROCA C/ ENCAIXE SDS PLUS P/ CONCRETO 6 x 110 mm']
    .map(n => grupoDoProduto(n).chave);
  assert(new Set(gBrocas).size === 3, `tipos diferentes de broca ficam em grupos separados: ${JSON.stringify(gBrocas)}`);

  // 18) GET /api/clientes/:id/sugestoes-recompra: grupo sem compra há mais de
  // 1 ano aparece; grupo com QUALQUER variação comprada no último ano não;
  // código promocional (P + base) conta como o produto base.
  mockDb.__seed({
    produtos: [
      { id: 801, codigo_sku: '62648', nome: 'ESPAÇADOR NIVELADOR 0,5 mm', categoria: '05' },
      { id: 802, codigo_sku: '61296', nome: 'ESPAÇADOR NIVELADOR 2,0 mm', categoria: '05' },
      { id: 803, codigo_sku: '62429', nome: 'BROCA DE AÇO RAPIDO 1,0 mm', categoria: '13' },
      { id: 804, codigo_sku: '62430', nome: 'BROCA DE AÇO RAPIDO 1,5 mm', categoria: '13' },
      { id: 805, codigo_sku: '62932', nome: 'DESEMPENADEIRA INOX CABO REMOVÍVEL DENTE 10 mm - COM CABO', categoria: '16' },
    ],
    clientes: [{ id: 9101, nome: 'LOJA SUGESTOES', documento: '11122233000144', codigo_oficial: 'COD9101' }],
    pedidosOficiaisItens: [
      // Espaçador: duas variações, última compra há ~2 anos -> sugere
      { nr_pedido: 'S1', codigo_sku: '62648', cliente_codigo_oficial: 'COD9101', quantidade: 5, valor: 100, data_faturamento: diasAtrasISO(800), status: 'faturado' },
      { nr_pedido: 'S2', codigo_sku: 'P61296', cliente_codigo_oficial: 'COD9101', quantidade: 5, valor: 100, data_faturamento: diasAtrasISO(700), status: 'faturado' },
      // Broca: uma variação antiga, outra comprada há 60 dias -> NÃO sugere
      { nr_pedido: 'S3', codigo_sku: '62429', cliente_codigo_oficial: 'COD9101', quantidade: 1, valor: 10, data_faturamento: diasAtrasISO(900), status: 'faturado' },
      { nr_pedido: 'S4', codigo_sku: '62430', cliente_codigo_oficial: 'COD9101', quantidade: 1, valor: 10, data_faturamento: diasAtrasISO(60), status: 'faturado' },
    ],
    // Desempenadeira só em pedido do app, há ~400 dias -> sugere
    pedidos: [{ id: 9901, cliente_id: 9101, data_pedido: new Date(Date.now() - 400 * 86400000).toISOString() }],
    pedidoItens: [{ id: 9902, pedido_id: 9901, produto_id: 805, quantidade: 1, preco_unitario: 50 }],
  });
  res = await req('GET', '/api/clientes/9101/sugestoes-recompra');
  const grupos = (res.body || []).map(g => g.grupo);
  const esp = (res.body || []).find(g => g.grupo === 'Espaçador Nivelador');
  assert(
    res.status === 200 && esp && esp.variacoes === 2 && esp.num_pedidos === 2 && esp.meses_sem_comprar >= 22
      && grupos.includes('Desempenadeira Inox Cabo Removível Dente')
      && !grupos.some(g => g.startsWith('Broca')),
    `sugestoes-recompra agrupa variações, junta faturado + app e ignora grupo comprado no último ano: ${JSON.stringify(res.body)}`
  );
  res = await req('GET', '/api/clientes/999999/sugestoes-recompra');
  assert(res.status === 404, 'sugestoes-recompra de cliente inexistente responde 404');

  // 18b) GET /api/clientes/:id/comprados-recentes: SKUs comprados no último
  // ano (faturado + app), com a quantidade somada no dia da compra mais
  // recente; código promocional vira o base; compra de mais de 1 ano fica fora.
  mockDb.__seed({
    produtos: [
      { id: 811, codigo_sku: '70001', nome: 'REBOLO RETO 6"', categoria: '20' },
      { id: 812, codigo_sku: '70002', nome: 'DISCO DE CORTE 4.1/2"', categoria: '20' },
      { id: 813, codigo_sku: '70003', nome: 'LIXA FERRO GRÃO 80', categoria: '20' },
      { id: 814, codigo_sku: '70004', nome: 'TRENA 5 m', categoria: '21' },
    ],
    clientes: [{ id: 9111, nome: 'LOJA REBOLO', documento: '11122233000225', codigo_oficial: 'COD9111' }],
    pedidosOficiaisItens: [
      // rebolo: 2 un. há 200 dias; na última compra (30 dias) veio em 2 linhas (P + base) = 3 un.
      { nr_pedido: 'R1', codigo_sku: '70001', cliente_codigo_oficial: 'COD9111', quantidade: 2, valor: 10, data_faturamento: diasAtrasISO(200), status: 'faturado' },
      { nr_pedido: 'R2', codigo_sku: '70001', cliente_codigo_oficial: 'COD9111', quantidade: 1, valor: 10, data_faturamento: diasAtrasISO(30), status: 'faturado' },
      { nr_pedido: 'R2', codigo_sku: 'P70001', cliente_codigo_oficial: 'COD9111', quantidade: 2, valor: 10, data_faturamento: diasAtrasISO(30), status: 'faturado' },
      // disco: há 400 dias -> fora; lixa: em carteira -> fora
      { nr_pedido: 'R0', codigo_sku: '70002', cliente_codigo_oficial: 'COD9111', quantidade: 9, valor: 10, data_faturamento: diasAtrasISO(400), status: 'faturado' },
      { nr_pedido: 'R3', codigo_sku: '70003', cliente_codigo_oficial: 'COD9111', quantidade: 9, valor: 10, data_faturamento: null, status: 'carteira' },
    ],
    // trena só em pedido do app, há 10 dias
    // + o mesmo rebolo pedido pelo app no dia do faturamento (mesma compra - não soma)
    pedidos: [
      { id: 9911, cliente_id: 9111, data_pedido: new Date(Date.now() - 10 * 86400000).toISOString() },
      { id: 9913, cliente_id: 9111, data_pedido: diasAtrasISO(30) + 'T12:00:00Z' },
    ],
    pedidoItens: [
      { id: 9912, pedido_id: 9911, produto_id: 814, quantidade: 4, preco_unitario: 50 },
      { id: 9914, pedido_id: 9913, produto_id: 811, quantidade: 3, preco_unitario: 10 },
    ],
  });
  res = await req('GET', '/api/clientes/9111/comprados-recentes');
  const rebolo = (res.body || []).find(r => r.codigo_sku === '70001');
  assert(
    res.status === 200 && res.body.length === 2 && res.body[0].codigo_sku === '70004' && res.body[0].qtd_ultima_compra === 4
      // 2 pedidos (R1 e R2): o pedido do app 9913 é a mesma compra que R2 (routes/lib/comprasApp.js)
      && rebolo && rebolo.qtd_ultima_compra === 3 && rebolo.num_pedidos === 2 && rebolo.nome === 'REBOLO RETO 6"',
    `comprados-recentes: último ano, faturado + app, P+base somados no dia mais recente: ${JSON.stringify(res.body)}`
  );
  res = await req('GET', '/api/clientes/999999/comprados-recentes');
  assert(res.status === 404, 'comprados-recentes de cliente inexistente responde 404');

  // 18b1) Dia do pedido do app no fuso de Brasília (routes/lib/comprasApp.js
  // sqlDiaDoPedido): pedido com hora real vai pro dia de Brasília; o de PDF/faturamento,
  // gravado só com a data (meia-noite UTC), fica no dia gravado. Nenhuma rota corta
  // data_pedido direto no fuso do banco (UTC).
  {
    const { sqlDiaDoPedido } = require('../routes/lib/comprasApp');
    const expr = sqlDiaDoPedido('p3');
    const fs = require('fs');
    const cortesDiretos = ['relatorios.js', 'recompra.js', 'pedidos.js']
      .filter(f => /data_pedido\)?::date(?!\s+(?:ELSE|END))|DATE\(\w+\.data_pedido\)/.test(fs.readFileSync(require('path').join(__dirname, '../routes', f), 'utf8')));
    // "meia-noite"/"dia gravado" lidos em UTC explícito, não no fuso da sessão do banco
    assert(/\(p3\.data_pedido AT TIME ZONE 'UTC'\)::time = '00:00:00' THEN \(p3\.data_pedido AT TIME ZONE 'UTC'\)::date ELSE \(p3\.data_pedido AT TIME ZONE 'America\/Sao_Paulo'\)::date/.test(expr)
      && cortesDiretos.length === 0,
      `dia do pedido do app no fuso de Brasília (só-data à meia-noite UTC fica como está); nenhuma rota corta data_pedido em UTC: ${JSON.stringify([expr, cortesDiretos])}`);

    // Pelas rotas: pedido fechado às 22h30 de Brasília (01:30 UTC do dia D) é do
    // dia D-1; o de PDF gravado só com a data D (meia-noite UTC) fica em D.
    const D = diasAtrasISO(20), D1 = diasAtrasISO(21);
    mockDb.__seed({
      produtos: [{ id: 851, codigo_sku: '70011', nome: 'DESEMPENADEIRA FUSO', categoria: '20' }],
      clientes: [{ id: 9121, nome: 'LOJA FUSO', documento: '11122233000306', codigo_oficial: null }],
      pedidos: [
        { id: 9781, cliente_id: 9121, origem: 'app', data_pedido: `${D}T01:30:00.123Z` },
        { id: 9782, cliente_id: 9121, origem: 'pdf', data_pedido: `${D}T00:00:00.000Z` },
        { id: 9784, cliente_id: 9121, origem: 'app', data_pedido: `${D1}T15:00:00.000Z` },
      ],
      pedidoItens: [
        { id: 9791, pedido_id: 9781, produto_id: 851, quantidade: 2, preco_unitario: 10 },
        { id: 9792, pedido_id: 9782, produto_id: 851, quantidade: 3, preco_unitario: 10 },
        { id: 9794, pedido_id: 9784, produto_id: 851, quantidade: 4, preco_unitario: 10 },
      ],
    });
    // duplicados: 9781 e 9784 são do mesmo dia em Brasília (D-1); o PDF de D,
    // que no dia UTC cairia junto com 9781, fica de fora
    res = await req('GET', '/api/pedidos/duplicados');
    const dupFuso = (res.body || []).filter(p => p.cliente_id === 9121).map(p => `${p.pedido_id}@${p.dia}`).sort();
    assert(res.status === 200 && JSON.stringify(dupFuso) === JSON.stringify([`9781@${D1}`, `9784@${D1}`]),
      `duplicados agrupa pelo dia de Brasília (campo dia vem do servidor): ${JSON.stringify(dupFuso)}`);
    // exportar: período pelo dia de Brasília, mais novo primeiro pelo dia (o PDF
    // de D vem antes do pedido das 22h30 de D-1, mesmo gravado "antes" em UTC)
    res = await req('GET', `/api/pedidos/exportar?inicio=${D1}&fim=${D}`);
    const expFuso = (res.body || []).filter(r => r.codigo_sku === '70011').map(r => `${r.quantidade}@${r.dia}`);
    const expSoD1 = await req('GET', `/api/pedidos/exportar?inicio=${D1}&fim=${D1}`);
    assert(res.status === 200 && JSON.stringify(expFuso) === JSON.stringify([`3@${D}`, `2@${D1}`, `4@${D1}`])
      && JSON.stringify((expSoD1.body || []).filter(r => r.codigo_sku === '70011').map(r => r.quantidade)) === '[2,4]',
      `exportar filtra e ordena pelo dia de Brasília: ${JSON.stringify([expFuso, expSoD1.body])}`);
    // comprados-recentes: última compra é a do PDF (D, 3 un.), 2 compras em dias diferentes
    // (no dia UTC, 9781 cairia em D junto com o PDF e a última compra seria 5)
    res = await req('GET', '/api/clientes/9121/comprados-recentes');
    const cr = (res.body || [])[0];
    assert(res.status === 200 && cr && cr.qtd_ultima_compra === 3 && cr.num_pedidos === 3,
      `comprados-recentes usa o dia de Brasília do pedido do app: ${JSON.stringify(res.body)}`);
  }

  // 18b1b) Pedido fechado/alterado sem internet: o app manda a hora do toque e a
  // hora do envio (carimbada em cada envio, inclusive o da fila); o servidor
  // desconta essa espera do relógio dele - o relógio errado do celular não entra.
  {
    const { horaDoPedidoDoApp } = require('../routes/pedidos');
    const agora = new Date('2026-10-05T15:00:00Z');
    const casos = [
      horaDoPedidoDoApp('2026-10-04T23:40:00.000Z', '2026-10-05T13:40:00.000Z', agora), // esperou 14h na fila
      horaDoPedidoDoApp('2026-10-03T10:00:00.000Z', '2026-10-03T10:00:00.200Z', agora), // celular 2 dias atrasado, enviado na hora: agora
      horaDoPedidoDoApp('2026-10-05T12:00:00-03:00', '2026-10-05T13:00:00-03:00', agora), // com offset
      horaDoPedidoDoApp('2026-10-05T12:00', '2026-10-05T13:00', agora),                 // sem fuso: não
      horaDoPedidoDoApp('2026-10-04T23:40:00.000Z', undefined, agora),                  // sem hora do envio: não
      horaDoPedidoDoApp('2026-08-01T12:00:00.000Z', '2026-10-05T12:00:00.000Z', agora), // esperou mais de 30 dias: não
      horaDoPedidoDoApp('2026-10-05T12:00:00.000Z', '2026-10-05T11:00:00.000Z', agora), // enviado "antes" do toque: não
      horaDoPedidoDoApp('2026-10-04', '2026-10-05', agora), horaDoPedidoDoApp(12345, 'x', agora),
      // cairia na meia-noite UTC exata ("só a data"): 1 ms antes
      horaDoPedidoDoApp('2026-10-05T10:00:00.000Z', '2026-10-05T19:00:00.000Z', new Date('2026-10-06T09:00:00.000Z')),
    ];
    assert(JSON.stringify(casos) === JSON.stringify(['2026-10-05T01:00:00.000Z', '2026-10-05T14:59:59.800Z', '2026-10-05T14:00:00.000Z',
      null, null, null, null, null, null, '2026-10-05T23:59:59.999Z']),
      `horaDoPedidoDoApp desconta a espera do relógio do servidor: ${JSON.stringify(casos)}`);

    const h = (ms) => new Date(Date.now() + ms).toISOString();
    const item = [{ codigo_sku: '70011', quantidade: 1, preco_unitario: 10 }];
    const postar = (extra) => req('POST', '/api/pedidos', { cliente: { cliente_id: 9121, nome: 'LOJA FUSO' }, itens: item, ...extra });
    const r1 = await postar({ data_pedido: h(-26 * 3600000), enviado_em: h(0) });              // 26h na fila
    const r2 = await postar({ data_pedido: h(-2 * 86400000), enviado_em: h(-2 * 86400000 + 100) }); // relógio 2 dias atrás, na hora
    const r3 = await postar({ data_pedido: h(-3600000) });                                     // sem hora do envio
    const r4 = await postar({ data_pedido: '2026-08-01', origem: 'pdf' });                      // PDF: a data dele
    const gravado = (r) => mockDb.__getPedidos().find(p => p.id === r.body.pedido_id);
    const perto = (iso, ms) => Math.abs(new Date(iso).getTime() - (Date.now() + ms)) < 5000;
    const alt = await req('PATCH', `/api/pedidos/${r1.body.pedido_id}`, { itens: [{ ...item[0], quantidade: 2 }], alterado_em: h(-5 * 3600000), enviado_em: h(0) });
    assert(r1.status === 201 && perto(gravado(r1).data_pedido, -26 * 3600000) && perto(gravado(r2).data_pedido, 0)
      && perto(gravado(r3).data_pedido, 0) && gravado(r4).data_pedido === '2026-08-01T00:00:00.000Z'
      && alt.status === 200 && perto(gravado(r1).atualizado_em, -5 * 3600000),
      `pedido/alteração do app grava a hora do toque no relógio do servidor (fila offline): ${JSON.stringify([r1, r2, r3, r4].map(r => gravado(r)?.data_pedido).concat(alt.status, gravado(r1)?.atualizado_em))}`);
  }

  // 18b1c) Pedido reenviado pela fila offline com o mesmo id_envio (a resposta se
  // perdeu com sinal fraco): devolve o pedido já gravado, não cria outro
  {
    const toque0 = new Date(Date.now() - 3 * 3600000).toISOString();
    const corpo = { cliente: { cliente_id: 9121, nome: 'LOJA FUSO' }, itens: [{ codigo_sku: '70011', quantidade: 3, preco_unitario: 10 }],
      id_envio: '7f3c2a10-1b2c-4d5e-8f90-a1b2c3d4e5f6', data_pedido: toque0 };
    const antes = mockDb.__getPedidos().length;
    const e1 = await req('POST', '/api/pedidos', corpo);
    const e2 = await req('POST', '/api/pedidos', corpo);
    // troca a consulta do banco simulado também dentro da transação (pool.connect)
    const comConsulta = async (troca, fn) => {
      const q0 = mockDb.pool.query, c0 = mockDb.pool.connect;
      const q = (sql, params) => troca(sql, params, q0);
      mockDb.pool.query = q;
      mockDb.pool.connect = async () => ({ query: q, release: () => {} });
      try { return await fn(); } finally { mockDb.pool.query = q0; mockDb.pool.connect = c0; }
    };
    // corrida (duas abas): a consulta não acha e o INSERT bate no índice único
    let buscas3 = 0;
    const e3 = await comConsulta(async (sql, params, q0) => {
      if (sql.includes('WHERE id_envio = $1') && buscas3++ === 0) return { rows: [] };
      return q0(sql, params);
    }, () => req('POST', '/api/pedidos', corpo));
    // corrida e a busca do já gravado falha (banco instável): 503 (fica na fila e o próximo
    // envio acha o pedido), não 409 - o 409 tirava da fila como "recusado"
    let buscas4 = 0;
    const e4 = await comConsulta(async (sql, params, q0) => {
      if (sql.includes('WHERE id_envio = $1') && buscas4++ === 0) return { rows: [] };
      if (sql.includes('WHERE id_envio = $1')) throw new Error('Connection terminated');
      return q0(sql, params);
    }, () => req('POST', '/api/pedidos', corpo));
    assert(e4.status === 503 && buscas3 === 2 && buscas4 === 2,
      `pedido do app: corrida sem conseguir confirmar o já gravado = 503 (tenta de novo): ${JSON.stringify([e4.status, e4.body, buscas3, buscas4])}`);
    const semId = await req('POST', '/api/pedidos', { ...corpo, id_envio: 'curto' }); // inválido: vira pedido normal
    assert(e1.status === 201 && e2.status === 200 && e2.body.mesmo_envio === true && e2.body.pedido_id === e1.body.pedido_id
      && e3.status === 200 && e3.body.pedido_id === e1.body.pedido_id && semId.status === 201
      && mockDb.__getPedidos().length === antes + 2,
      `pedido do app: reenvio com o mesmo id_envio devolve o gravado (também na corrida): ${JSON.stringify([e1.body, e2.body, e3.body, semId.status])}`);

    // (o app carimba enviado_em em cada envio - a versão é a hora do toque no relógio do servidor)
    const agoraIso = () => new Date().toISOString();
    // Pedido feito sem internet e ALTERADO antes de o 1º envio sair: o app manda o mesmo
    // id_envio com os itens novos (e a hora do toque da alteração) - troca os itens do
    // mesmo pedido. A versão velha que chegar depois (fila de outro aparelho) não volta.
    const itensDe = (id) => mockDb.__getPedidoItens().filter(i => i.pedido_id === id).map(i => i.quantidade);
    const toque1 = new Date(Date.now() - 2 * 3600000).toISOString();
    const nPedidos = mockDb.__getPedidos().length;
    const alt = await req('POST', '/api/pedidos', { ...corpo, itens: [{ codigo_sku: '70011', quantidade: 5, preco_unitario: 10 }], alterado_em: toque1, enviado_em: agoraIso() });
    const depoisAlt = itensDe(e1.body.pedido_id);
    const velho = await req('POST', '/api/pedidos', { ...corpo, enviado_em: agoraIso() }); // a versão de antes chegando atrasada
    const depoisVelho = itensDe(e1.body.pedido_id);
    // PATCH (pedido já com número): alteração mais velha que a gravada também não volta
    const patchVelho = await req('PATCH', `/api/pedidos/${e1.body.pedido_id}`, { itens: [{ codigo_sku: '70011', quantidade: 1, preco_unitario: 10 }], alterado_em: toque0, enviado_em: agoraIso() });
    // outro aparelho com o relógio 2 h ATRASADO alterando agora: vale (a versão é a hora do
    // servidor; pelo relógio do aparelho, "hora 2 h atrás" perderia pra versão gravada)
    const atrasado = new Date(Date.now() - 2 * 3600000 - 60000).toISOString();
    const patchNovo = await req('PATCH', `/api/pedidos/${e1.body.pedido_id}`, { itens: [{ codigo_sku: '70011', quantidade: 7, preco_unitario: 10 }], alterado_em: atrasado, enviado_em: atrasado });
    assert(alt.status === 200 && alt.body.atualizado === true && alt.body.pedido_id === e1.body.pedido_id && JSON.stringify(depoisAlt) === '[5]'
      && velho.status === 200 && velho.body.versao_antiga === true && JSON.stringify(depoisVelho) === '[5]'
      && patchVelho.body.versao_antiga === true && patchNovo.body.atualizado === true && JSON.stringify(itensDe(e1.body.pedido_id)) === '[7]'
      && mockDb.__getPedidos().length === nPedidos,
      `pedido do app: alteração pelo mesmo envio troca os itens; versão mais velha não sobrescreve (POST e PATCH): ${JSON.stringify([alt.body, depoisAlt, depoisVelho, patchVelho.body, itensDe(e1.body.pedido_id)])}`);

    // Reenvio da MESMA versão (resposta perdida) como o app manda de verdade: com
    // enviado_em novo. Se o reenvio chega mais rápido que o 1º, a versão calculada
    // sai menor - antes voltava "versão antiga" (aviso falso e lista do aparelho com
    // os itens de antes). Mesmos itens = sucesso, POST e PATCH.
    const toqueR = new Date(Date.now() - 60000).toISOString();
    const corpoR = { ...corpo, id_envio: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', data_pedido: toqueR };
    const r1 = await req('POST', '/api/pedidos', { ...corpoR, enviado_em: agoraIso() });
    const maisDemorado = new Date(Date.now() + 2000).toISOString(); // espera maior = versão "mais velha"
    const r2 = await req('POST', '/api/pedidos', { ...corpoR, enviado_em: maisDemorado });
    const pid = r1.body.pedido_id;
    const p7 = [{ codigo_sku: '70011', quantidade: 7, preco_unitario: 10 }];
    const pa = await req('PATCH', `/api/pedidos/${pid}`, { itens: p7, alterado_em: agoraIso(), enviado_em: agoraIso() });
    const ta = new Date().toISOString();
    const pb = await req('PATCH', `/api/pedidos/${pid}`, { itens: p7, alterado_em: ta, enviado_em: new Date(Date.parse(ta) + 2000).toISOString() });
    // sem hora confiável (relógio do aparelho voltou, sem enviado_em) com versão gravada: não passa por cima
    const semHora = await req('PATCH', `/api/pedidos/${pid}`, { itens: [{ codigo_sku: '70011', quantidade: 9, preco_unitario: 10 }], alterado_em: agoraIso() });
    assert(r1.status === 201 && r2.status === 200 && r2.body.pedido_id === pid && !r2.body.versao_antiga
      && pa.body.atualizado === true && pb.status === 200 && pb.body.atualizado === true && !pb.body.versao_antiga
      && semHora.body.versao_antiga === true && JSON.stringify(itensDe(pid)) === '[7]',
      `pedido do app: reenvio da mesma versão (enviado_em novo, chegando mais rápido) não vira "versão antiga"; sem hora não sobrescreve: ${JSON.stringify([r2.body, pb.body, semHora.body, itensDe(pid)])}`);

    // A -> B -> A: o vendedor volta ao que já estava gravado (A de novo, mesmos itens)
    // enquanto B ainda espera na fila de outro aparelho. A versão gravada sobe com o
    // reenvio igual, e o B atrasado não volta.
    const corpoV = { ...corpo, id_envio: '1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d', data_pedido: new Date(Date.now() - 3 * 3600000).toISOString() };
    const vA = await req('POST', '/api/pedidos', { ...corpoV, enviado_em: agoraIso() });
    await req('POST', '/api/pedidos', { ...corpoV, alterado_em: new Date(Date.now() - 3600000).toISOString(), enviado_em: agoraIso() });
    const vB = await req('POST', '/api/pedidos', { ...corpoV, itens: [{ codigo_sku: '70011', quantidade: 4, preco_unitario: 10 }],
      alterado_em: new Date(Date.now() - 2 * 3600000).toISOString(), enviado_em: agoraIso() });
    // corrida no INSERT (sem a trava) com itens diferentes dos gravados: 503 pra fila
    // mandar de novo e cair na troca de itens (200 aqui perdia a alteração)
    let buscas5 = 0;
    const corrida = await comConsulta(async (sql, params, q0) => {
      if (sql.includes('WHERE id_envio = $1') && buscas5++ === 0) return { rows: [] };
      return q0(sql, params);
    }, () => req('POST', '/api/pedidos', { ...corpoV, itens: [{ codigo_sku: '70011', quantidade: 6, preco_unitario: 10 }], alterado_em: agoraIso(), enviado_em: agoraIso() }));
    const salvosV = await req('GET', '/api/pedidos/salvos');
    assert(vB.body.versao_antiga === true && JSON.stringify(itensDe(vA.body.pedido_id)) === '[3]'
      && corrida.status === 503 && buscas5 === 2
      && (salvosV.body.pedidos.find(p => p.id === vA.body.pedido_id) || {}).id_envio === corpoV.id_envio,
      `pedido do app: A -> B -> A não deixa o B atrasado voltar; corrida com itens novos = 503; lista traz o id_envio: ${JSON.stringify([vB.body, itensDe(vA.body.pedido_id), corrida.status, buscas5])}`);
  }

  // 18b2) Recompra da semana (routes/recompra.js + routes/lib/ritmoCompra.js):
  // ritmo = mediana dos intervalos entre compras dos últimos 12 meses (mín. 3),
  // pedido a menos de 7 dias do anterior entra na mesma compra (até 14 dias de
  // compra), previsão = último pedido da última compra + ritmo.
  const ritmoLib = require('../routes/lib/ritmoCompra');
  const hojeBr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const antesBr = (n) => ritmoLib.somarDias(hojeBr, -n);
  {
    const compras = ritmoLib.juntarCompras([
      { data: antesBr(90), quantidade: 2 }, { data: antesBr(60), quantidade: 1 },
      { data: antesBr(57), quantidade: 3 }, { data: antesBr(30), quantidade: 6 },
    ]);
    assert(compras.length === 3 && compras[1].quantidade === 4 && compras[1].fim === antesBr(57),
      `juntarCompras junta os pedidos da mesma semana: ${JSON.stringify(compras)}`);
    const r = ritmoLib.ritmoDasCompras(compras, hojeBr);
    assert(r && r.ritmo_dias === 30 && r.previsao === hojeBr && r.atraso_dias === 0 && ritmoLib.situacaoDoRitmo(r) === 'semana',
      `ritmoDasCompras: mediana dos intervalos, previsão = última + ritmo: ${JSON.stringify(r)}`);
    assert(ritmoLib.ritmoDasCompras(compras.slice(0, 2), hojeBr) === null, 'menos de 3 compras = sem ritmo');
    // quem compra toda semana: cada semana é uma compra (emendando, o ano inteiro virava uma só)
    const semanal = ritmoLib.juntarCompras(Array.from({ length: 52 }, (_, i) => ({ data: antesBr(i * 7), quantidade: 1 })));
    const rs = ritmoLib.ritmoDasCompras(semanal, hojeBr);
    // comprou hoje: fora da lista hoje (piso de 8 dias depois do último pedido); amanhã já é "semana"
    const rsAmanha = ritmoLib.ritmoDasCompras(semanal, ritmoLib.somarDias(hojeBr, 1));
    assert(semanal.length === 52 && rs && rs.ritmo_dias === 7 && rs.ultima_compra === hojeBr && ritmoLib.situacaoDoRitmo(rs) === null
      && ritmoLib.situacaoDoRitmo(rsAmanha) === 'semana',
      `juntarCompras: quem compra toda semana tem ritmo de 7 dias: ${JSON.stringify([semanal.length, rs])}`);
    // pedidos seguidos (35, 29, 22, 15 dias): a semana conta do 1º pedido, e a última
    // compra é o pedido de 15 dias atrás, não o início da sequência
    const seguidas = ritmoLib.juntarCompras([95, 65, 35, 29, 22, 15].map(n => ({ data: antesBr(n), quantidade: 1 })));
    const rq = ritmoLib.ritmoDasCompras(seguidas, hojeBr);
    assert(seguidas.length === 5 && seguidas[2].data === antesBr(35) && seguidas[2].fim === antesBr(29)
      && rq.ultima_compra === antesBr(15) && rq.atraso_dias < 0 && ritmoLib.situacaoDoRitmo(rq) !== 'atrasado',
      `juntarCompras: quem acabou de comprar não aparece atrasado: ${JSON.stringify([seguidas, rq])}`);
    // cliente mensal com complementos 5 e 8 dias depois do pedido principal: cada mês é
    // uma compra (contando a semana só do 1º pedido, partia em duas e o ritmo dava ~8)
    const rajadas = ritmoLib.juntarCompras([152, 147, 144, 122, 117, 114, 92, 87, 84, 62, 57, 54, 32, 27, 24]
      .map(n => ({ data: antesBr(n), quantidade: 1 })));
    const rr = ritmoLib.ritmoDasCompras(rajadas, hojeBr);
    // compra que se arrasta (pedido a cada 6 dias) para em 14 dias
    const arrastada = ritmoLib.juntarCompras([0, 6, 12, 18].map(n => ({ data: antesBr(60 - n), quantidade: 1 })));
    // previsão conta do 1º pedido da última compra (há 32 dias) + 30 = há 2 dias: atrasado 2
    // (contando do último pedido, dava "faltam 6 dias" e ele só entrava na lista depois do dia)
    assert(rajadas.length === 5 && rr.ritmo_dias === 30 && rr.ultima_compra === antesBr(24) && rr.previsao === antesBr(2)
      && rr.atraso_dias === 2 && ritmoLib.situacaoDoRitmo(rr) === 'atrasado'
      && arrastada.length === 2 && arrastada[0].fim === antesBr(48) && arrastada[1].data === antesBr(42),
      `juntarCompras: complemento até 14 dias fica na mesma compra (mensal = ritmo 30): ${JSON.stringify([rajadas.length, rr, arrastada])}`);
    // o cliente mensal com complementos entra na lista 7 dias antes do dia em que costuma
    // comprar, como o sem complemento (achado da 3ª rodada do revisor-cortag)
    const mensalCompl = ritmoLib.juntarCompras([143, 138, 135, 113, 108, 105, 83, 78, 75, 53, 48, 45, 23, 18, 15]
      .map(n => ({ data: antesBr(n), quantidade: 1 })));
    const rm = ritmoLib.ritmoDasCompras(mensalCompl, hojeBr);
    // ritmo menor que a duração da compra: a régua (há 20 + 10) cairia antes do último pedido;
    // o piso põe a previsão 8 dias depois dele (há 7 + 8 = amanhã)
    const curto = ritmoLib.ritmoDasCompras([
      { data: antesBr(40), fim: antesBr(40), quantidade: 1 }, { data: antesBr(30), fim: antesBr(30), quantidade: 1 },
      { data: antesBr(20), fim: antesBr(7), quantidade: 1 }], hojeBr);
    assert(rm.ritmo_dias === 30 && rm.previsao === ritmoLib.somarDias(hojeBr, 7) && ritmoLib.situacaoDoRitmo(rm) === 'semana'
      && curto.ritmo_dias === 10 && curto.previsao === ritmoLib.somarDias(hojeBr, 1) && curto.ultima_compra === antesBr(7),
      `ritmoDasCompras: previsão pelo 1º pedido da última compra (mensal com complemento entra 7 dias antes), no mínimo 8 dias depois do último pedido: ${JSON.stringify([rm, curto])}`);
    // cliente de 10 em 10 dias atrasado que compra: sai da lista (achado da 4ª rodada do
    // revisor-cortag - o pedido entrava na compra anterior e ele voltava "atrasado" 2 dias depois)
    const dezEmDez = (ns) => ritmoLib.ritmoDasCompras(ritmoLib.juntarCompras(ns.map(n => ({ data: antesBr(n), quantidade: 1 }))), hojeBr);
    const antesDeComprar = dezEmDez([42, 32, 22, 11, 5]);   // última compra há 11 dias + complemento há 5
    const depoisDeComprar = dezEmDez([42, 32, 22, 11, 5, 0]); // fechou o pedido hoje (entra na mesma compra)
    assert(ritmoLib.situacaoDoRitmo(antesDeComprar) === 'semana' && depoisDeComprar.previsao === ritmoLib.somarDias(hojeBr, 8)
      && ritmoLib.situacaoDoRitmo(depoisDeComprar) === null,
      `ritmoDasCompras: quem compra sai da lista, mesmo com o pedido emendado na compra anterior: ${JSON.stringify([antesDeComprar, depoisDeComprar])}`);
    // ...mas o complemento normal não empurra a previsão (2ª rodada do revisor na correção):
    // ritmo 13 com complemento 6 dias depois: previsão = piso (complemento + 8 = há 5), 1 dia depois
    // da régua; contando do último pedido dava hoje (6 dias de atraso pra entrar na lista)
    const r13 = dezEmDez([71, 65, 58, 52, 45, 39, 32, 26, 19, 13]);
    assert(r13.ritmo_dias === 13 && r13.previsao === antesBr(5) && ritmoLib.situacaoDoRitmo(r13) === 'atrasado',
      `ritmoDasCompras: complemento da compra não empurra a previsão: ${JSON.stringify(r13)}`);
    // proposta "frequente": produto que veio em 2 das 3 últimas compras do cliente conta 2,
    // mesmo que as compras do produto (juntadas à parte) atravessem a quebra do cliente
    const cliProp = [{ data: antesBr(80), fim: antesBr(80) }, { data: antesBr(40), fim: antesBr(28) }, { data: antesBr(24), fim: antesBr(24) }];
    const propFreq = ritmoLib.itensDaProposta({ previsao: hojeBr }, cliProp,
      new Map([['71009', [{ data: antesBr(28), fim: antesBr(24), quantidade: 4 }]]]), hojeBr);
    assert(propFreq.length === 1 && propFreq[0].codigo_sku === '71009' && propFreq[0].origem === 'frequente',
      `itensDaProposta: produto em 2 compras do cliente conta 2 mesmo com a compra do produto atravessando as duas: ${JSON.stringify(propFreq)}`);
    // ...e a quantidade é a de cada compra do cliente (2 e 2 = 2), não a da compra do produto
    // que soma as duas (4) - achado da 4ª rodada do revisor-cortag
    const propQtd = ritmoLib.itensDaProposta({ previsao: hojeBr }, cliProp,
      new Map([['71009', [{ data: antesBr(28), fim: antesBr(24), quantidade: 4 }]]]), hojeBr,
      new Map([['71009', [{ data: antesBr(28), quantidade: 2 }, { data: antesBr(24), quantidade: 2 }]]]));
    assert(propQtd.length === 1 && propQtd[0].quantidade === 2 && propFreq[0].quantidade === 4,
      `itensDaProposta: quantidade "frequente" por compra do cliente: ${JSON.stringify([propQtd, propFreq])}`);
    // o mesmo no item "por ritmo": os pedidos de há 14 e 11 dias são compras diferentes do
    // cliente (a de há 26 dura até 14 dias), mas a compra do produto junta os dois (20)
    const evCli = [60, 40, 26, 20, 14, 11].map(n => ({ data: antesBr(n), quantidade: 1 }));
    const evX = [[60, 20], [40, 20], [14, 10], [11, 10]].map(([n, q]) => ({ data: antesBr(n), quantidade: q }));
    const propRitmo = ritmoLib.itensDaProposta({ previsao: ritmoLib.somarDias(hojeBr, 5) }, ritmoLib.juntarCompras(evCli),
      new Map([['71010', ritmoLib.juntarCompras(evX)]]), hojeBr, new Map([['71010', evX]]));
    assert(propRitmo.length === 1 && propRitmo[0].origem === 'ritmo' && propRitmo[0].quantidade === 10,
      `itensDaProposta: quantidade "por ritmo" por compra do cliente (20, 10, 10 = 10; não 20): ${JSON.stringify(propRitmo)}`);
    assert(ritmoLib.mediana([10, 30, 200]) === 30 && ritmoLib.quantidadeTipica([{ quantidade: 2 }, { quantidade: 10 }, { quantidade: 4 }, { quantidade: 3 }]) === 4,
      'mediana ignora a compra fora da curva; quantidade típica = mediana das 3 últimas');
    const sit = (atraso, ritmo) => ritmoLib.situacaoDoRitmo({ atraso_dias: atraso, ritmo_dias: ritmo });
    assert(sit(-8, 30) === null && sit(-7, 30) === 'semana' && sit(1, 30) === 'atrasado' && sit(45, 30) === 'atrasado' && sit(46, 30) === 'fora',
      'situação: 7 dias antes = semana, passou = atrasado, atraso > 1,5x o ritmo = fora');
  }
  mockDb.__seed({
    produtos: [
      { id: 821, codigo_sku: '71001', nome: 'DESEMPENADEIRA RITMO', categoria: '16' },
      { id: 822, codigo_sku: '71002', nome: 'ESPATULA RITMO', categoria: '16' },
      { id: 823, codigo_sku: '71003', nome: 'NIVEL RITMO', categoria: '16' },
      { id: 824, codigo_sku: '71004', nome: 'TRENA RITMO', categoria: '16' },
    ],
    clientes: [
      { id: 9201, nome: 'RITMO ATRASADO', documento: '22200000000101', codigo_oficial: 'COD9201' },
      { id: 9202, nome: 'RITMO SEMANA SO APP', documento: '22200000000102' },
      { id: 9203, nome: 'RITMO EM DIA', documento: '22200000000103', codigo_oficial: 'COD9203' },
      { id: 9204, nome: 'RITMO DUAS COMPRAS', documento: '22200000000104', codigo_oficial: 'COD9204' },
      { id: 9205, nome: 'RITMO ENTREGA JUNTA', documento: '22200000000105', codigo_oficial: 'COD9205' },
      { id: 9206, nome: 'RITMO FORA', documento: '22200000000106', codigo_oficial: 'COD9206' },
    ],
    pedidosOficiaisItens: [
      // 9201: a cada 30 dias (100, 70, 40) -> previsto há 10 dias = atrasado.
      // Desempenadeira nas 3 (2, P+base 4, 3 -> mediana 3); espátula só em 1.
      { nr_pedido: '920101', codigo_sku: '71001', cliente_codigo_oficial: 'COD9201', quantidade: 2, valor: 10, data_implantacao: antesBr(100), data_faturamento: antesBr(98), status: 'faturado' },
      { nr_pedido: '920102', codigo_sku: '71001', cliente_codigo_oficial: 'COD9201', quantidade: 1, valor: 10, data_implantacao: antesBr(70), data_faturamento: antesBr(66), status: 'faturado' },
      { nr_pedido: '920102', codigo_sku: 'P71001', cliente_codigo_oficial: 'COD9201', quantidade: 3, valor: 10, data_implantacao: antesBr(70), data_faturamento: antesBr(66), status: 'faturado' },
      { nr_pedido: '920102', codigo_sku: '71002', cliente_codigo_oficial: 'COD9201', quantidade: 5, valor: 10, data_implantacao: antesBr(70), data_faturamento: antesBr(66), status: 'faturado' },
      { nr_pedido: '920103', codigo_sku: '71001', cliente_codigo_oficial: 'COD9201', quantidade: 3, valor: 10, data_implantacao: antesBr(40), data_faturamento: null, status: 'carteira' },
      // série de 7 dígitos (avulso) há 5 dias: não conta como compra
      { nr_pedido: '1092010', codigo_sku: '71004', cliente_codigo_oficial: 'COD9201', quantidade: 1, valor: 5, data_implantacao: antesBr(5), data_faturamento: antesBr(3), status: 'faturado' },
      // 9203: comprou há 2 dias, ritmo ~29 -> longe da data, fora da lista
      { nr_pedido: '920301', codigo_sku: '71001', cliente_codigo_oficial: 'COD9203', quantidade: 1, valor: 10, data_implantacao: antesBr(60), data_faturamento: antesBr(58), status: 'faturado' },
      { nr_pedido: '920302', codigo_sku: '71001', cliente_codigo_oficial: 'COD9203', quantidade: 1, valor: 10, data_implantacao: antesBr(30), data_faturamento: antesBr(28), status: 'faturado' },
      { nr_pedido: '920303', codigo_sku: '71001', cliente_codigo_oficial: 'COD9203', quantidade: 1, valor: 10, data_implantacao: antesBr(2), data_faturamento: null, status: 'carteira' },
      // 9204: só 2 compras -> sem ritmo
      { nr_pedido: '920401', codigo_sku: '71001', cliente_codigo_oficial: 'COD9204', quantidade: 1, valor: 10, data_implantacao: antesBr(90), data_faturamento: antesBr(88), status: 'faturado' },
      { nr_pedido: '920402', codigo_sku: '71001', cliente_codigo_oficial: 'COD9204', quantidade: 1, valor: 10, data_implantacao: antesBr(60), data_faturamento: antesBr(58), status: 'faturado' },
      // 9205: 90, 60 + 57 (mesma compra), 30 -> ritmo 30, prevista hoje = semana
      // (sem juntar seria mediana 27, prevista há 3 dias = atrasado)
      { nr_pedido: '920501', codigo_sku: '71003', cliente_codigo_oficial: 'COD9205', quantidade: 1, valor: 10, data_implantacao: antesBr(90), data_faturamento: antesBr(88), status: 'faturado' },
      { nr_pedido: '920502', codigo_sku: '71003', cliente_codigo_oficial: 'COD9205', quantidade: 1, valor: 10, data_implantacao: antesBr(60), data_faturamento: antesBr(58), status: 'faturado' },
      { nr_pedido: '920503', codigo_sku: '71004', cliente_codigo_oficial: 'COD9205', quantidade: 1, valor: 10, data_implantacao: antesBr(57), data_faturamento: antesBr(55), status: 'faturado' },
      { nr_pedido: '920504', codigo_sku: '71003', cliente_codigo_oficial: 'COD9205', quantidade: 1, valor: 10, data_implantacao: antesBr(30), data_faturamento: antesBr(28), status: 'faturado' },
      // 9206: 200, 170, 140 -> ritmo 30, atraso 110 > 45 = fora do ritmo
      { nr_pedido: '920601', codigo_sku: '71001', cliente_codigo_oficial: 'COD9206', quantidade: 1, valor: 10, data_implantacao: antesBr(200), data_faturamento: antesBr(198), status: 'faturado' },
      { nr_pedido: '920602', codigo_sku: '71001', cliente_codigo_oficial: 'COD9206', quantidade: 1, valor: 10, data_implantacao: antesBr(170), data_faturamento: antesBr(168), status: 'faturado' },
      { nr_pedido: '920603', codigo_sku: '71001', cliente_codigo_oficial: 'COD9206', quantidade: 1, valor: 10, data_implantacao: antesBr(140), data_faturamento: antesBr(138), status: 'faturado' },
    ],
    pedidos: [
      // 9201: pedido do app que virou o 920103 (mesma compra, não conta de novo)
      { id: 9921, cliente_id: 9201, data_pedido: antesBr(41) + 'T12:00:00Z' },
      // 9202 (sem código no ERP): só app, 55, 35 e 15 dias -> ritmo 20, prevista em 5 dias.
      // Nenhum produto em 3 compras -> proposta com os que vieram em 2 das 3 últimas.
      { id: 9922, cliente_id: 9202, data_pedido: antesBr(55) + 'T12:00:00Z' },
      { id: 9923, cliente_id: 9202, data_pedido: antesBr(35) + 'T12:00:00Z' },
      { id: 9924, cliente_id: 9202, data_pedido: antesBr(15) + 'T12:00:00Z' },
    ],
    pedidoItens: [
      { id: 9931, pedido_id: 9921, produto_id: 821, quantidade: 3, preco_unitario: 10 },
      { id: 9932, pedido_id: 9922, produto_id: 823, quantidade: 2, preco_unitario: 10 },
      { id: 9933, pedido_id: 9923, produto_id: 823, quantidade: 4, preco_unitario: 10 },
      { id: 9934, pedido_id: 9923, produto_id: 824, quantidade: 1, preco_unitario: 10 },
      { id: 9935, pedido_id: 9924, produto_id: 824, quantidade: 1, preco_unitario: 10 },
      { id: 9936, pedido_id: 9924, produto_id: 822, quantidade: 9, preco_unitario: 10 },
    ],
  });
  res = await req('GET', '/api/recompra');
  {
    const doTeste = (res.body && res.body.clientes || []).filter(c => c.cliente_id >= 9201 && c.cliente_id <= 9206);
    const porId = new Map(doTeste.map(c => [c.cliente_id, c]));
    const a = porId.get(9201), b = porId.get(9202), e = porId.get(9205), f = porId.get(9206);
    assert(res.status === 200 && res.body.hoje === hojeBr && doTeste.length === 4 && !porId.has(9203) && !porId.has(9204),
      `recompra: lista só quem está atrasado/na semana/fora, com 3+ compras: ${JSON.stringify(doTeste.map(c => [c.cliente_id, c.situacao]))}`);
    assert(a && a.situacao === 'atrasado' && a.ritmo_dias === 30 && a.num_compras === 3 && a.ultima_compra === antesBr(40) && a.atraso_dias === 10
      && a.itens.length === 1 && a.itens[0].codigo_sku === '71001' && a.itens[0].quantidade === 3 && a.itens[0].origem === 'ritmo' && a.itens[0].nome === 'DESEMPENADEIRA RITMO',
      `recompra: entrada pela implantação (carteira conta), sem série de 7 dígitos, app já no oficial não repete, P+base: ${JSON.stringify(a)}`);
    assert(b && b.situacao === 'semana' && b.ritmo_dias === 20 && b.previsao === ritmoLib.somarDias(hojeBr, 5)
      && b.itens.map(i => i.codigo_sku).sort().join() === '71003,71004' && b.itens.every(i => i.origem === 'frequente')
      && b.itens.find(i => i.codigo_sku === '71003').quantidade === 3,
      `recompra: cliente só do app; sem produto com ritmo, proposta com os de 2 das 3 últimas compras: ${JSON.stringify(b)}`);
    assert(e && e.situacao === 'semana' && e.ritmo_dias === 30 && e.num_compras === 3,
      `recompra: pedidos da mesma semana contam como uma compra só: ${JSON.stringify(e)}`);
    assert(f && f.situacao === 'fora' && f.atraso_dias === 110 && f.itens.length === 1 && f.itens[0].origem === 'frequente',
      `recompra: fora do ritmo (atraso > 1,5x), proposta pelos itens frequentes: ${JSON.stringify(f)}`);
    const ordem = doTeste.map(c => c.cliente_id);
    assert(ordem.indexOf(9201) < ordem.indexOf(9206) && ordem.indexOf(9206) < ordem.indexOf(9205) && ordem.indexOf(9205) < ordem.indexOf(9202),
      `recompra: atrasados primeiro, depois fora do ritmo, depois a semana pela data: ${JSON.stringify(ordem)}`);
  }
  res = await req('POST', '/api/recompra/9201/adiar', {});
  assert(res.status === 200 && res.body.adiado_ate === ritmoLib.somarDias(hojeBr, 7), `"Já falei" adia 7 dias: ${JSON.stringify(res.body)}`);
  res = await req('POST', '/api/recompra/9202/adiar', { em: antesBr(3) });
  assert(res.status === 200 && res.body.adiado_ate === ritmoLib.somarDias(hojeBr, 4), `"Já falei" pela fila offline conta do dia em que foi tocado: ${JSON.stringify(res.body)}`);
  res = await req('POST', '/api/recompra/9202/adiar', { em: ritmoLib.somarDias(hojeBr, 30) });
  assert(res.status === 200 && res.body.adiado_ate === ritmoLib.somarDias(hojeBr, 7), `"Já falei" com data no futuro vale de hoje: ${JSON.stringify(res.body)}`);
  res = await req('GET', '/api/recompra');
  {
    const a = (res.body.clientes || []).find(c => c.cliente_id === 9201);
    assert(a && a.adiado_ate === ritmoLib.somarDias(hojeBr, 7), `recompra devolve até quando o cliente foi adiado: ${JSON.stringify(a && a.adiado_ate)}`);
  }
  res = await req('POST', '/api/recompra/999999/adiar', {});
  assert(res.status === 404, '"Já falei" de cliente inexistente responde 404');
  res = await req('POST', '/api/recompra/abc/adiar', {});
  assert(res.status === 400, '"Já falei" com id inválido responde 400');

  // 18c) GET /api/produtos/:codigo/clientes ("Já compraram" da aba Produtos):
  // conta o faturado oficial, não só pedido do app - caso real: lixadeira
  // faturada pelo ERP aparecia "Já compraram (0)". Código promocional conta
  // como o produto, e pedido do app faturado no mesmo dia não soma em dobro.
  mockDb.__seed({
    clientes: [
      { id: 9121, nome: 'LOJA SÓ ERP', documento: '11122233000306', codigo_oficial: 'COD9121' },
      { id: 9122, nome: 'LOJA APP E ERP', documento: '11122233000387', codigo_oficial: 'COD9122' },
    ],
    pedidosOficiaisItens: [
      { nr_pedido: 'L1', codigo_sku: '70004', cliente_codigo_oficial: 'COD9121', quantidade: 1, valor: 10, data_faturamento: diasAtrasISO(16), nota_fiscal: '915137', status: 'faturado' },
      { nr_pedido: 'L1', codigo_sku: 'P70004', cliente_codigo_oficial: 'COD9121', quantidade: 2, valor: 10, data_faturamento: diasAtrasISO(16), nota_fiscal: '915137', status: 'faturado' },
      { nr_pedido: 'L2', codigo_sku: '70004', cliente_codigo_oficial: 'COD9122', quantidade: 5, valor: 10, data_faturamento: diasAtrasISO(40), nota_fiscal: '900001', status: 'faturado' },
      { nr_pedido: 'L3', codigo_sku: '70004', cliente_codigo_oficial: 'COD9122', quantidade: 7, valor: 10, data_faturamento: null, status: 'carteira' },
    ],
    pedidos: [{ id: 9921, cliente_id: 9122, data_pedido: diasAtrasISO(40) + 'T12:00:00Z' }],
    pedidoItens: [{ id: 9922, pedido_id: 9921, produto_id: 814, quantidade: 5, preco_unitario: 50 }],
  });
  res = await req('GET', '/api/produtos/70004/clientes');
  const soErp = (res.body.compradores || []).find(c => c.id === 9121);
  const appErp = (res.body.compradores || []).find(c => c.id === 9122);
  assert(
    res.status === 200 && soErp && soErp.total_comprado === 3 && soErp.ultima_compra === diasAtrasISO(16) && soErp.nota_fiscal === '915137'
      && appErp && appErp.total_comprado === 5
      && res.body.compradores.findIndex(c => c.id === 9121) < res.body.compradores.findIndex(c => c.id === 9122),
    `produto/clientes: "Já compraram" inclui o faturado oficial (P+base), sem somar app+faturado do mesmo dia: ${JSON.stringify(res.body.compradores)}`
  );

  // 18d) Histórico / Rotatividade / Recuperar / consumo estimado contam o
  // faturado oficial, não só pedido do app (antes o cliente que comprava pelo
  // ERP aparecia sem histórico). P+base viram um produto; app e faturado do
  // mesmo SKU no mesmo dia são uma compra só.
  mockDb.__seed({
    produtos: [
      { id: 831, codigo_sku: '71001', nome: 'DESEMP. AÇO 38 cm', categoria: '20' },
      { id: 832, codigo_sku: '71002', nome: 'FITA DUPLA FACE 12 mm', categoria: '20' },
      { id: 833, codigo_sku: '71003', nome: 'SERRA COPO 35mm', categoria: '20' },
    ],
    clientes: [
      { id: 9131, nome: 'LOJA ERP', documento: '11122233000468', codigo_oficial: 'COD9131' },
      { id: 9132, nome: 'LOJA SEM LEVANTAMENTO', documento: '11122233000549', codigo_oficial: 'COD9132' },
    ],
    pedidosOficiaisItens: [
      { nr_pedido: 'H1', codigo_sku: '71001', cliente_codigo_oficial: 'COD9131', quantidade: 12, valor: 10, data_faturamento: diasAtrasISO(90), status: 'faturado' },
      { nr_pedido: 'H2', codigo_sku: '71001', cliente_codigo_oficial: 'COD9131', quantidade: 6, valor: 10, data_faturamento: diasAtrasISO(30), status: 'faturado' },
      { nr_pedido: 'H2', codigo_sku: 'P71001', cliente_codigo_oficial: 'COD9131', quantidade: 6, valor: 10, data_faturamento: diasAtrasISO(30), status: 'faturado' },
      { nr_pedido: 'H3', codigo_sku: '71002', cliente_codigo_oficial: 'COD9131', quantidade: 24, valor: 10, data_faturamento: diasAtrasISO(200), status: 'faturado' },
      { nr_pedido: 'H4', codigo_sku: '71003', cliente_codigo_oficial: 'COD9131', quantidade: 3, valor: 10, data_faturamento: diasAtrasISO(150), status: 'faturado' },
      { nr_pedido: 'H5', codigo_sku: '71001', cliente_codigo_oficial: 'COD9131', quantidade: 99, valor: 10, data_faturamento: null, status: 'carteira' },
      { nr_pedido: 'H6', codigo_sku: '71001', cliente_codigo_oficial: 'COD9132', quantidade: 5, valor: 10, data_faturamento: diasAtrasISO(10), status: 'faturado' },
    ],
    // o mesmo desempenador pedido pelo app no dia do faturamento H2 (mesma compra)
    pedidos: [{ id: 9931, cliente_id: 9131, data_pedido: diasAtrasISO(30) + 'T12:00:00Z' }],
    pedidoItens: [{ id: 9932, pedido_id: 9931, produto_id: 831, quantidade: 12, preco_unitario: 10 }],
    // levantamentos: desempenador contado 10 (há 100 dias) e 4 (há 20 dias);
    // fita contada 0; serra copo nunca contada.
    levantamentos: [
      { id: 9941, cliente_id: 9131, nome: 'visita 1', data_visita: diasAtrasISO(100) + 'T15:00:00Z' },
      { id: 9942, cliente_id: 9131, nome: 'visita 2', data_visita: diasAtrasISO(20) + 'T15:00:00Z' },
    ],
    levantamentoItens: [
      { id: 9951, levantamento_id: 9941, produto_id: 831, quantidade_contada: 10 },
      { id: 9952, levantamento_id: 9942, produto_id: 831, quantidade_contada: 4 },
      { id: 9953, levantamento_id: 9942, produto_id: 832, quantidade_contada: 0 },
    ],
  });
  res = await req('GET', '/api/clientes/9131/historico');
  const hDesemp = (res.body || []).find(r => r.codigo_sku === '71001');
  assert(
    res.status === 200 && res.body.length === 3 && !res.body.some(r => r.codigo_sku === 'P71001')
      && hDesemp && hDesemp.total_acumulado === 24 && hDesemp.num_pedidos === 2
      && hDesemp.primeira_compra === diasAtrasISO(90) && hDesemp.ultima_compra === diasAtrasISO(30),
    `historico: faturado oficial + app, P+base juntos, app do mesmo dia não soma: ${JSON.stringify(res.body)}`
  );
  res = await req('GET', '/api/clientes/9131/rotatividade');
  assert(
    res.status === 200 && res.body[0].codigo_sku === '71001' && res.body[0].media_dias_entre_pedidos === 60,
    `rotatividade: intervalo médio entre as compras oficiais (90 e 30 dias atrás = 60): ${JSON.stringify(res.body)}`
  );
  res = await req('GET', '/api/clientes/9131/recuperar');
  const recCodigos = (res.body || []).map(r => r.codigo_sku);
  assert(
    res.status === 200 && recCodigos.length === 2 && recCodigos[0] === '71002' && recCodigos[1] === '71003'
      && res.body[1].ultimo_levantamento === null,
    `recuperar: zerado ou nunca contado, com o que tem estoque fora, mais antigo primeiro: ${JSON.stringify(res.body)}`
  );
  res = await req('GET', '/api/clientes/9132/recuperar');
  assert(res.status === 200 && Array.isArray(res.body) && res.body.length === 0,
    `recuperar: cliente sem nenhum levantamento não tem com o que comparar: ${JSON.stringify(res.body)}`);
  res = await req('GET', '/api/clientes/9131/consumo-estimado/831');
  const consumo = (res.body.consumos || [])[0];
  assert(
    res.status === 200 && consumo && consumo.pedido_no_periodo === 24 && consumo.consumo_estimado === 30,
    `consumo estimado conta o faturado entre as visitas (10 + 24 - 4 = 30): ${JSON.stringify(res.body.consumos)}`
  );
  res = await req('GET', '/api/clientes/999999/historico');
  assert(res.status === 404, 'historico de cliente inexistente responde 404');

  // 18e) POST /api/pedidos com numero_cotacao (item B2 do plano de
  // segurança): a busca da cotação já gravada roda DENTRO da transação, com
  // FOR UPDATE, pra duas atualizações simultâneas não regravarem os itens em
  // paralelo. Mesmo PDF de novo = ja_existia; PDF mais novo = substitui os
  // itens (sem duplicar); outro usuário não sobrescreve; corrida de duas
  // cotações novas iguais cai no índice único e vira ja_existia.
  const cotacaoBase = {
    cliente: { cliente_id: clienteId, nome: 'João Silva Materiais' },
    numero_cotacao: 'COT-B2-1', origem: 'pdf',
  };
  mockDb.__queryLog.length = 0;
  res = await req('POST', '/api/pedidos', { ...cotacaoBase, pdf_modificado_em: '2026-09-01T10:00:00Z',
    itens: [{ codigo_sku: '60863', quantidade: 10, preco_unitario: 28.59 }] });
  const pedidoCotacaoId = res.body.pedido_id;
  const logCotacao = mockDb.__queryLog.map(q => q.sql.toUpperCase());
  const idxBegin = logCotacao.findIndex(q => q === 'BEGIN');
  const idxBusca = logCotacao.findIndex(q => q.includes('FROM PEDIDOS WHERE NUMERO_COTACAO = $1'));
  assert(
    res.status === 201 && idxBegin >= 0 && idxBusca > idxBegin && logCotacao[idxBusca].endsWith('FOR UPDATE'),
    `cotação: a busca da cotação existente roda depois do BEGIN, com FOR UPDATE (B2): ${JSON.stringify(logCotacao.slice(0, 4))}`
  );
  res = await req('POST', '/api/pedidos', { ...cotacaoBase, pdf_modificado_em: '2026-09-01T10:00:00Z',
    itens: [{ codigo_sku: '60863', quantidade: 99, preco_unitario: 28.59 }] });
  assert(res.status === 200 && res.body.ja_existia === true && res.body.pedido_id === pedidoCotacaoId,
    'cotação: mesmo PDF reenviado não grava de novo (ja_existia)');
  res = await req('POST', '/api/pedidos', { ...cotacaoBase, pdf_modificado_em: '2026-09-02T10:00:00Z',
    itens: [{ codigo_sku: '60863', quantidade: 12, preco_unitario: 28.59 }, { codigo_sku: '61362', quantidade: 2, preco_unitario: 217.42 }] });
  const itensCotacao = mockDb.__getPedidoItens().filter(i => i.pedido_id === pedidoCotacaoId);
  assert(res.status === 201 && res.body.atualizado === true && res.body.pedido_id === pedidoCotacaoId
      && itensCotacao.length === 2 && itensCotacao.some(i => i.quantidade === 12),
    `cotação: PDF mais novo atualiza o mesmo pedido e substitui os itens, sem duplicar: ${JSON.stringify(itensCotacao)}`);
  const pedidoPersistido = await mockDb.pool.query('SELECT id FROM pedidos WHERE numero_cotacao = $1 FOR UPDATE', ['COT-B2-1']);
  assert(pedidoPersistido.rows.length === 1, 'cotação: continua um pedido só por cotação');

  const outroUsuario = await mockDb.pool.query(
    'INSERT INTO usuarios (nome, email, google_sub, is_admin) VALUES ($1, $2, $3, false) RETURNING id, nome, email, is_admin',
    ['Outro Vendedor', 'outro@example.com', 'sub-teste-outro']
  );
  const tokenOutro = generateToken();
  await mockDb.pool.query('INSERT INTO sessoes (token, usuario_id, expira_em) VALUES ($1, $2, $3)', [hashToken(tokenOutro), outroUsuario.rows[0].id, '90']);
  const tokenAntesCotacao = authToken;
  authToken = tokenOutro;
  res = await req('POST', '/api/pedidos', { ...cotacaoBase, pdf_modificado_em: '2026-09-03T10:00:00Z',
    itens: [{ codigo_sku: '60863', quantidade: 1, preco_unitario: 28.59 }] });
  authToken = tokenAntesCotacao;
  assert(res.status === 403, 'cotação: outro usuário (não admin) não sobrescreve a cotação de quem gravou');

  // 18e2) Reabrir pedido do app pra editar (cliente quer mudar quantidade ou
  // incluir produto): GET /api/pedidos/salvos lista os pedidos do próprio
  // vendedor com itens, cliente e contexto; PATCH /api/pedidos/:id troca os
  // itens do MESMO pedido (sem criar outro). Só o autor/admin, só origem 'app'.
  const contextoPedido = { uf: 'SC', canal: 'ATACADO', channelDiscount: 22, paymentTerm: 'A Vista', qtyDiscounts: { '61362': 5 } };
  res = await req('POST', '/api/pedidos', {
    cliente: { cliente_id: clienteId, nome: 'João Silva Materiais' }, vendedor_nome: 'Michel Russo', contexto: contextoPedido,
    itens: [{ codigo_sku: '60863', quantidade: 20, preco_unitario: 28.59 }],
  });
  const pedidoEditavelId = res.body.pedido_id;
  const dataPedidoEditavel = res.body.data_pedido;
  let salvos = await req('GET', '/api/pedidos/salvos');
  let salvo = salvos.body && salvos.body.pedidos.find(p => p.id === pedidoEditavelId);
  assert(
    salvos.status === 200 && salvo && salvo.cliente_nome === 'João Silva Materiais' && salvo.contexto && salvo.contexto.canal === 'ATACADO'
      && salvo.itens.length === 1 && salvo.itens[0].codigo_sku === '60863' && salvo.itens[0].quantidade === 20
      && !salvos.body.pedidos.some(p => p.id === pedidoCotacaoId),
    `pedidos salvos: lista o pedido do app com itens, cliente e contexto (e não a cotação em PDF): ${JSON.stringify(salvos.body && salvos.body.pedidos.map(p => p.id))}`
  );
  const novoContexto = { ...contextoPedido, paymentTerm: '28 dias' };
  res = await req('PATCH', `/api/pedidos/${pedidoEditavelId}`, { contexto: novoContexto, itens: [
    { codigo_sku: '60863', quantidade: 30, preco_unitario: 28.59 }, { codigo_sku: '61362', quantidade: 2, preco_unitario: 206.55 },
  ] });
  const itensEditados = mockDb.__getPedidoItens().filter(i => i.pedido_id === pedidoEditavelId);
  assert(
    res.status === 200 && res.body.atualizado === true && res.body.pedido_id === pedidoEditavelId && res.body.data_pedido === dataPedidoEditavel
      && res.body.atualizado_em && itensEditados.length === 2 && itensEditados.some(i => i.quantidade === 30) && itensEditados.some(i => i.quantidade === 2),
    `editar pedido: troca os itens do mesmo pedido, mantém a data do pedido e marca atualizado_em: ${JSON.stringify(itensEditados)}`
  );
  salvos = await req('GET', '/api/pedidos/salvos');
  salvo = salvos.body.pedidos.filter(p => p.id === pedidoEditavelId);
  assert(salvo.length === 1 && salvo[0].itens.length === 2 && salvo[0].contexto.paymentTerm === '28 dias' && salvos.body.pedidos[0].id === pedidoEditavelId,
    'editar pedido: continua um pedido só, com os itens e o contexto novos, no topo da lista (editado por último)');
  res = await req('PATCH', `/api/pedidos/${pedidoEditavelId}`, { itens: [{ codigo_sku: '60863', quantidade: 0, preco_unitario: 28.59 }] });
  assert(res.status === 400, 'editar pedido: recusa item com quantidade zero');
  res = await req('PATCH', `/api/pedidos/${pedidoEditavelId}`, { itens: [] });
  assert(res.status === 400, 'editar pedido: recusa pedido sem itens');
  res = await req('PATCH', `/api/pedidos/${pedidoEditavelId}`, { itens: [{ codigo_sku: 'CODIGO-INEXISTENTE', quantidade: 1, preco_unitario: 1 }] });
  assert(res.status === 400 && res.body.erro.includes('não encontrado') && mockDb.__getPedidoItens().filter(i => i.pedido_id === pedidoEditavelId).length === 2,
    'editar pedido: produto inexistente recusa sem perder os itens que já estavam gravados (rollback)');
  res = await req('PATCH', `/api/pedidos/${pedidoCotacaoId}`, { itens: [{ codigo_sku: '60863', quantidade: 1, preco_unitario: 28.59 }] });
  assert(res.status === 400, 'editar pedido: cotação importada do PDF não é editada por aqui');
  res = await req('PATCH', '/api/pedidos/999999', { itens: [{ codigo_sku: '60863', quantidade: 1, preco_unitario: 28.59 }] });
  assert(res.status === 404, 'editar pedido: pedido inexistente responde 404');
  authToken = tokenOutro;
  res = await req('PATCH', `/api/pedidos/${pedidoEditavelId}`, { itens: [{ codigo_sku: '60863', quantidade: 1, preco_unitario: 28.59 }] });
  const salvosOutro = await req('GET', '/api/pedidos/salvos');
  authToken = tokenAntesCotacao;
  assert(res.status === 403, 'editar pedido: outro usuário (não admin) não altera o pedido de quem gravou');
  assert(salvosOutro.status === 200 && !salvosOutro.body.pedidos.some(p => p.id === pedidoEditavelId),
    'pedidos salvos: cada vendedor vê só os pedidos que ele fechou');
  res = await req('POST', '/api/pedidos', {
    cliente: { cliente_id: clienteId, nome: 'João Silva Materiais' }, contexto: { lixo: 'x'.repeat(30000) },
    itens: [{ codigo_sku: '60863', quantidade: 1, preco_unitario: 28.59 }],
  });
  salvos = await req('GET', '/api/pedidos/salvos');
  salvo = salvos.body.pedidos.find(p => p.id === res.body.pedido_id);
  assert(res.status === 201 && salvo && salvo.contexto === null, 'pedido: contexto grande demais é ignorado (grava o pedido sem ele)');

  // 18f) Pedido do app não conta em dobro com o faturado oficial
  // (routes/lib/comprasApp.js): o vendedor fecha no app e o ERP fatura dias
  // depois - antes eram duas compras e a Rotatividade saía "a cada ~5 dias".
  // Cópias da importação antiga de faturamento (origem 'faturamento') nunca
  // contam; pedido do app ainda sem faturamento continua contando.
  mockDb.__seed({
    produtos: [
      { id: 841, codigo_sku: '72001', nome: 'ESPAÇADOR TESTE 2 mm', categoria: '20' },
      { id: 842, codigo_sku: '72002', nome: 'CUNHA TESTE', categoria: '20' },
    ],
    clientes: [{ id: 9141, nome: 'LOJA DUPLA CONTAGEM', documento: '11122233000620', codigo_oficial: 'COD9141' }],
    pedidosOficiaisItens: [
      { nr_pedido: 'D1', codigo_sku: '72001', cliente_codigo_oficial: 'COD9141', quantidade: 10, valor: 10, data_faturamento: diasAtrasISO(95), status: 'faturado' },
    ],
    pedidos: [
      { id: 9951, cliente_id: 9141, origem: 'app', data_pedido: diasAtrasISO(100) + 'T12:00:00Z' },         // faturado 5 dias depois (D1)
      { id: 9952, cliente_id: 9141, origem: 'faturamento', data_pedido: diasAtrasISO(95) + 'T12:00:00Z' }, // cópia antiga de D1
      { id: 9953, cliente_id: 9141, origem: 'app', data_pedido: diasAtrasISO(3) + 'T12:00:00Z' },           // ainda não faturado
    ],
    pedidoItens: [
      { id: 9961, pedido_id: 9951, produto_id: 841, quantidade: 10, preco_unitario: 1 },
      { id: 9962, pedido_id: 9952, produto_id: 841, quantidade: 10, preco_unitario: 1 },
      { id: 9963, pedido_id: 9953, produto_id: 842, quantidade: 4, preco_unitario: 1 },
    ],
  });
  res = await req('GET', '/api/clientes/9141/historico');
  const hEsp = (res.body || []).find(r => r.codigo_sku === '72001');
  const hCunha = (res.body || []).find(r => r.codigo_sku === '72002');
  assert(
    res.status === 200 && hEsp && hEsp.num_pedidos === 1 && hEsp.total_acumulado === 10 && hEsp.media_dias_entre_pedidos === null
      && hCunha && hCunha.total_acumulado === 4,
    `historico: pedido do app faturado dias depois e cópia antiga de faturamento não contam em dobro; app não faturado conta: ${JSON.stringify(res.body)}`
  );
  res = await req('GET', '/api/produtos/72001/clientes');
  const compradorDup = (res.body.compradores || []).find(c => c.id === 9141);
  assert(res.status === 200 && compradorDup && compradorDup.total_comprado === 10,
    `já compraram: sem contar o pedido do app que virou faturado: ${JSON.stringify(res.body.compradores)}`);

  // "Sem Classificatório" no relatório oficial = cliente sem classificatório
  mockDb.__seed({ clientes: [{ id: 9403, nome: 'LOJA SEM CLASSI', codigo_oficial: 'COD9403', classificatorio_tipo: 'Varejo Master', classificatorio_desconto: 20, classificatorio_atualizado_em: '2026-01-01' }] });
  res = await req('POST', '/api/pedidos-oficiais/importar', {
    itens: [{ nr_pedido: 'SC9403', codigo_sku: '60863', cliente_codigo_oficial: 'COD9403', cliente_nome: 'LOJA SEM CLASSI', status: 'faturado', valor: 10 }],
    classificacoes: [{ nome: 'LOJA SEM CLASSI', codigo_oficial: 'COD9403', tipo: 'Sem Classificatório', desconto: null, data_referencia: '2026-09-20' }],
  });
  const clienteSemClassi = mockDb.__getClientes().find(c => c.id === 9403);
  assert(res.status < 300 && clienteSemClassi && clienteSemClassi.classificatorio_tipo === null && clienteSemClassi.classificatorio_desconto === null,
    `importação: "Sem Classificatório" grava cliente sem classificatório: ${JSON.stringify(clienteSemClassi)}`);

  // 19) localização da loja gravada ao salvar o levantamento
  // (routes/levantamentos.js) - só leitura precisa (<= 100 m) vira a posição
  // do cliente, e uma pior não substitui uma melhor.
  res = await req('POST', '/api/clientes', { nome: 'Loja do GPS', documento: '98765432000110' });
  const clienteGpsId = res.body.id;
  const salvarLevComGps = (localizacao) => req('POST', '/api/levantamentos', {
    cliente: { cliente_id: clienteGpsId, nome: 'Loja do GPS' },
    itens: [{ codigo_sku: '60863', quantidade_contada: 1 }],
    localizacao,
  });
  const clienteGps = () => mockDb.__getClientes().find(c => c.id === clienteGpsId);
  const levGps = (id) => mockDb.__getLevantamentos().find(l => l.id === id);

  res = await salvarLevComGps({ latitude: -22.4321, longitude: -46.9571, precisao_m: 30 });
  assert(
    res.status === 201 && res.body.localizacao_registrada === true
      && clienteGps().latitude === -22.4321 && clienteGps().localizacao_precisao_m === 30
      && levGps(res.body.levantamento_id).latitude === -22.4321,
    'levantamento com GPS preciso grava a posição na visita e no cliente'
  );
  res = await salvarLevComGps({ latitude: -22.5, longitude: -46.9, precisao_m: 80 });
  assert(
    res.status === 201 && res.body.localizacao_registrada === false
      && clienteGps().latitude === -22.4321 && levGps(res.body.levantamento_id).localizacao_precisao_m === 80,
    'leitura menos precisa fica só na visita, não substitui a posição do cliente'
  );
  res = await salvarLevComGps({ latitude: -23, longitude: -47, precisao_m: 500 });
  assert(
    res.status === 201 && res.body.localizacao_registrada === false && clienteGps().latitude === -22.4321,
    'leitura imprecisa (500 m) não vira posição do cliente'
  );
  res = await salvarLevComGps({ latitude: 999, longitude: -46.9, precisao_m: 10 });
  assert(
    res.status === 201 && res.body.localizacao_registrada === false && levGps(res.body.levantamento_id).latitude === null,
    'localização inválida é ignorada e o levantamento é salvo mesmo assim'
  );
  res = await salvarLevComGps({ latitude: null, longitude: null, precisao_m: 5 });
  assert(
    res.status === 201 && res.body.localizacao_registrada === false && clienteGps().latitude === -22.4321,
    'latitude/longitude nulas não viram coordenada 0,0'
  );
  res = await salvarLevComGps({ latitude: -22.4322, longitude: -46.9572, precisao_m: 12 });
  assert(
    res.status === 201 && res.body.localizacao_registrada === true && clienteGps().localizacao_precisao_m === 12,
    'leitura mais precisa substitui a posição do cliente'
  );

  // 20) BrasilAPI como reserva do radar-cnpj (routes/radarCnpj.js) - fetch
  // simulado; o servidor de teste roda no mesmo processo.
  const { brasilApiParaFormatoRadar } = require('../routes/lib/cnpjBrasilApi');
  const respostaBrasilApi = {
    cnpj: '19131243000197', razao_social: 'MATERIAIS SILVA LTDA', nome_fantasia: 'SILVA MATERIAIS',
    situacao_cadastral: 2, descricao_situacao_cadastral: 'ATIVA', data_situacao_cadastral: '2013-10-03',
    descricao_motivo_situacao_cadastral: 'SEM MOTIVO', codigo_natureza_juridica: 2062, natureza_juridica: 'Sociedade Empresária Limitada',
    cnae_fiscal: 4744099, cnae_fiscal_descricao: 'Comércio varejista de materiais de construção em geral',
    porte: 'MICRO EMPRESA', codigo_porte: 1, data_inicio_atividade: '2013-10-03', capital_social: 50000,
    descricao_tipo_de_logradouro: 'RUA', logradouro: 'DAS FLORES', numero: '100', complemento: '', bairro: 'CENTRO',
    municipio: 'MOGI MIRIM', uf: 'SP', cep: '13800000', ddd_telefone_1: '1938621234', ddd_telefone_2: '', email: null,
    identificador_matriz_filial: 1, descricao_identificador_matriz_filial: 'MATRIZ',
    cnaes_secundarios: [{ codigo: 4742300, descricao: 'x' }, { codigo: 4741500, descricao: 'y' }],
    qsa: [{ nome_socio: 'FULANO DE TAL', qualificacao_socio: 'Sócio-Administrador', codigo_qualificacao_socio: 49 }],
    opcao_pelo_simples: true, data_opcao_pelo_simples: '2013-10-03', data_exclusao_do_simples: null,
    opcao_pelo_mei: false, data_opcao_pelo_mei: null, data_exclusao_do_mei: null,
  };
  const conv = brasilApiParaFormatoRadar(respostaBrasilApi);
  assert(
    conv.simples.optante === true && conv.simples.dataOpcao === '2013-10-03' && conv.mei.optante === false
      && brasilApiParaFormatoRadar({ cnpj: '1', opcao_pelo_simples: null }).simples === null,
    'BrasilAPI: opção pelo Simples/MEI vira {optante, dataOpcao, dataExclusao} como no radar-cnpj; null = desconhecido'
  );
  assert(
    conv.razaoSocial === 'MATERIAIS SILVA LTDA' && conv.situacao.label === 'Ativa' && conv.porte.label === 'Microempresa'
      && conv.endereco.logradouro === 'DAS FLORES' && conv.endereco.municipio === 'MOGI MIRIM' && conv.endereco.complemento === null
      && conv.contato.telefone1 === '(19) 38621234' && conv.contato.telefone2 === null && conv.matrizFilial.label === 'Matriz'
      && conv.cnaeSecundario === '4742300,4741500' && conv.naturezaJuridica.descricao === 'Sociedade Empresária Limitada'
      && conv.socios[0].nome === 'FULANO DE TAL' && conv.socios[0].qualificacao.descricao === 'Sócio-Administrador',
    'BrasilAPI é convertida pro formato do radar-cnpj (situação/porte/matriz, endereço, telefone, CNAEs, sócios)'
  );

  const fetchOriginal = global.fetch;
  const chamadas = [];
  const simularFetch = (radar, brasil) => {
    chamadas.length = 0;
    global.fetch = async (url) => {
      chamadas.push(String(url).includes('brasilapi') ? 'brasilapi' : 'radar');
      const r = String(url).includes('brasilapi') ? brasil : radar;
      if (r instanceof Error) throw r;
      return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => r.body };
    };
  };
  const bodyRadar = { ok: true, data: { razaoSocial: 'VIA RADAR LTDA', nomeFantasia: 'RADAR', situacao: { label: 'Ativa' } } };
  const erroSilencioso = console.warn;
  console.warn = () => {};
  try {
    simularFetch({ status: 200, body: bodyRadar }, { status: 200, body: respostaBrasilApi });
    res = await req('GET', '/api/radar-cnpj/19131243000197');
    assert(res.status === 200 && res.body.razao_social === 'VIA RADAR LTDA' && chamadas.join() === 'radar',
      'com o radar-cnpj respondendo, a BrasilAPI nem é chamada');

    simularFetch({ status: 429, body: { ok: false, error: 'limite' } }, { status: 200, body: respostaBrasilApi });
    res = await req('GET', '/api/radar-cnpj/19131243000197');
    assert(res.status === 200 && res.body.razao_social === 'MATERIAIS SILVA LTDA' && res.body.situacao_cadastral === 'Ativa'
      && chamadas.join() === 'radar,brasilapi',
      'radar-cnpj no limite (429) -> ficha vem da BrasilAPI, mesmo formato de resposta');

    simularFetch(new Error('fetch failed'), { status: 200, body: respostaBrasilApi });
    res = await req('GET', '/api/radar-cnpj/19131243000197');
    assert(res.status === 200 && res.body.nome_fantasia === 'SILVA MATERIAIS', 'radar-cnpj fora do ar -> BrasilAPI responde');

    simularFetch({ status: 404, body: {} }, { status: 200, body: respostaBrasilApi });
    res = await req('GET', '/api/radar-cnpj/19131243000197');
    assert(res.status === 200 && res.body.razao_social === 'MATERIAIS SILVA LTDA', 'CNPJ que o radar-cnpj não conhece ainda é achado na BrasilAPI');

    simularFetch({ status: 404, body: {} }, { status: 404, body: {} });
    res = await req('GET', '/api/radar-cnpj/19131243000197');
    assert(res.status === 404, 'CNPJ que nenhuma das duas acha responde 404');

    simularFetch({ status: 500, body: {} }, { status: 503, body: {} });
    res = await req('GET', '/api/radar-cnpj/19131243000197');
    assert(res.status === 502, 'as duas fora do ar responde 502 (o cadastro manual segue normal)');
  } finally {
    global.fetch = fetchOriginal;
    console.warn = erroSilencioso;
  }

  // 21) preenchimento automático de fichas de CNPJ (routes/lib/preenchimentoCnpj.js)
  const preench = require('../routes/lib/preenchimentoCnpj');
  // 03:30 UTC = 00:30 em Brasília (fora da janela 01h-06h); 05:00 UTC = 02:00 (dentro)
  assert(
    preench.agoraBrasilia(new Date('2026-09-25T03:30:00Z')).dia === '2026-09-25' && preench.agoraBrasilia(new Date('2026-09-25T03:30:00Z')).hora === 0
      && !preench.dentroDaJanela(new Date('2026-09-25T03:30:00Z')) && preench.dentroDaJanela(new Date('2026-09-25T05:00:00Z'))
      && !preench.dentroDaJanela(new Date('2026-09-25T09:00:00Z')),
    'janela do preenchimento é 01h-06h no horário de Brasília (servidor em UTC)'
  );
  const fakeDeps = ({ estado = null, pendentes = [], erros = {}, agora = '2026-09-25T05:00:00Z' } = {}) => {
    const d = {
      estadoSalvo: estado, consultados: [], falhas: [], esperas: 0,
      agora: () => new Date(agora),
      esperar: async () => { d.esperas++; },
      lerEstado: async () => d.estadoSalvo,
      salvarEstado: async (e) => { d.estadoSalvo = { ...e }; },
      listarPendentes: async (limite) => pendentes.slice(0, limite),
      obterFicha: async (id) => {
        d.consultados.push(id);
        if (erros[id]) { const e = new Error(erros[id].msg); e.status = erros[id].status; throw e; }
      },
      registrarFalha: async (id) => { d.falhas.push(id); },
    };
    return d;
  };
  const muitos = Array.from({ length: 60 }, (_, i) => i + 1);

  let fd = fakeDeps({ pendentes: muitos });
  let r = await preench.rodarRodada(fd);
  assert(r.consultas === 40 && fd.consultados.length === 40 && fd.estadoSalvo.consultas === 40 && fd.estadoSalvo.dia === '2026-09-25'
    && fd.esperas === 39, 'preenchimento para em 40 consultas no dia, com espera entre uma e outra');

  fd = fakeDeps({ pendentes: muitos, estado: { dia: '2026-09-25', consultas: 35 } });
  r = await preench.rodarRodada(fd);
  assert(r.consultas === 5 && fd.estadoSalvo.consultas === 40, 'conta o que já foi gasto no mesmo dia (35 + 5 = 40)');

  fd = fakeDeps({ pendentes: muitos, estado: { dia: '2026-09-24', consultas: 40, pausado_no_dia: '2026-09-24' } });
  r = await preench.rodarRodada(fd);
  assert(r.consultas === 40 && fd.estadoSalvo.dia === '2026-09-25', 'dia novo zera o contador e a pausa do dia anterior');

  fd = fakeDeps({ pendentes: [1, 2, 3], erros: { 2: { status: 404, msg: 'CNPJ não encontrado' } } });
  r = await preench.rodarRodada(fd);
  assert(fd.consultados.join() === '1,2,3' && fd.falhas.join() === '2' && r.motivo !== 'origem_indisponivel',
    'CNPJ não encontrado registra falha do cliente e segue pro próximo');

  fd = fakeDeps({ pendentes: [1, 2, 3], erros: { 2: { status: 502, msg: 'radar-cnpj respondeu 429; reserva: BrasilAPI respondeu 503' } } });
  r = await preench.rodarRodada(fd);
  assert(fd.consultados.join() === '1,2' && r.motivo === 'origem_indisponivel' && fd.estadoSalvo.pausado_no_dia === '2026-09-25'
    && fd.falhas.length === 0, 'origens fora do ar/no limite encerram a noite sem culpar o cliente');
  r = await preench.rodarRodada(fd);
  assert(r.consultas === 0 && r.motivo === 'pausado_hoje', 'depois de pausar, não tenta de novo na mesma noite');

  fd = fakeDeps({ pendentes: muitos, agora: '2026-09-25T15:00:00Z' });
  r = await preench.rodarRodada(fd);
  assert(r.consultas === 0 && r.motivo === 'fora_da_janela' && fd.consultados.length === 0, 'fora da madrugada não consulta nada');

  // rota de status + atalho "existe" (não consulta a Receita)
  mockDb.__seed({
    clientes: [
      { id: 9301, nome: 'COM FICHA', documento: '11.222.333/0001-81' },
      { id: 9302, nome: 'SEM FICHA', documento: '11222333000262' },
    ],
    fichasCnpj: { 9301: { cliente_id: 9301, razao_social: 'COM FICHA LTDA', atualizado_em: new Date().toISOString() } },
  });
  const fetchAntes = global.fetch;
  let chamouOrigem = false;
  global.fetch = async () => { chamouOrigem = true; throw new Error('não devia consultar'); };
  try {
    res = await req('GET', '/api/clientes/9301/ficha-cnpj/existe');
    const comFicha = res.status === 200 && res.body.existe === true && !!res.body.atualizado_em;
    res = await req('GET', '/api/clientes/9302/ficha-cnpj/existe');
    assert(comFicha && res.status === 200 && res.body.existe === false && !chamouOrigem,
      'ficha-cnpj/existe responde pelo banco, sem consultar a Receita');
  } finally {
    global.fetch = fetchAntes;
  }
  res = await req('GET', '/api/cnpj-preenchimento/status');
  assert(res.status === 200 && res.body.com_cnpj >= 2 && res.body.faltam === res.body.com_cnpj - res.body.com_ficha
    && res.body.hoje.limite === 40 && res.body.janela === '01h–06h',
    'status do preenchimento devolve progresso, limite e janela');

  // 22) Política Comercial: o percentual do classificatório vem do NOME
  // (routes/lib/politicaComercial.js), não do número do relatório do ERP -
  // "Varejo Exclusive (12)" da política antiga grava 15.
  const politica = require('../routes/lib/politicaComercial');
  assert(
    politica.descontoPelaPolitica('Varejo Exclusive', 12) === 15 && politica.descontoPelaPolitica('Varejo Premium', 15) === 17
      && politica.descontoPelaPolitica('E-Commerce Máster', null) === 20 && politica.descontoPelaPolitica('Atacado Premium', 22) === 22
      && politica.descontoPelaPolitica('Consumidor Final', null) === -30 && politica.descontoPelaPolitica('Locação', null) === 12
      && politica.descontoPelaPolitica('Tipo Desconhecido', 9) === 9 && politica.descontoPelaPolitica('Tipo Desconhecido', null) === null,
    'percentual do classificatório pela política (nome sem acento/maiúscula; desconhecido mantém o do ERP)'
  );
  mockDb.__seed({ clientes: [{ id: 9401, nome: 'LOJA POLITICA', codigo_oficial: 'COD9401' }] });
  res = await req('POST', '/api/pedidos-oficiais/importar', {
    itens: [{ nr_pedido: 'PP9401', codigo_sku: '60863', cliente_codigo_oficial: 'COD9401', cliente_nome: 'LOJA POLITICA', status: 'faturado', valor: 10 }],
    classificacoes: [{ nome: 'LOJA POLITICA', codigo_oficial: 'COD9401', tipo: 'Varejo Exclusive', desconto: 12, data_referencia: '2026-09-20' }],
  });
  const clientePolitica = mockDb.__getClientes().find(c => c.id === 9401);
  assert(
    res.status < 300 && clientePolitica && clientePolitica.classificatorio_tipo === 'Varejo Exclusive' && clientePolitica.classificatorio_desconto === 15,
    'importação grava o % da política (Exclusive 15), não o 12 do relatório'
  );

  // 23) Importação oficial: nr_pedido com zeros à esquerda ("00597502") é o
  // mesmo pedido que "597502" (não cria linha duplicada), e reimportar um
  // relatório com a data de implantação certa corrige a que estava errada
  // (caso real: relatório de 30/11/2025 salvo em Excel americano).
  mockDb.__seed({
    clientes: [{ id: 9402, nome: 'LOJA REIMPORT', codigo_oficial: 'COD9402' }],
    pedidosOficiaisItens: [
      { nr_pedido: '597502', codigo_sku: '60863', cliente_codigo_oficial: 'COD9402', quantidade: 6, valor: 100, data_implantacao: '2025-05-11', data_faturamento: '2025-06-11', status: 'faturado' },
    ],
  });
  res = await req('POST', '/api/pedidos-oficiais/importar', {
    itens: [
      { nr_pedido: '00597502', codigo_sku: '60863', cliente_codigo_oficial: 'COD9402', cliente_nome: 'LOJA REIMPORT', status: 'faturado', valor: 100, quantidade: 6, data_implantacao: '2025-11-05', data_faturamento: '2025-11-06' },
      { nr_pedido: '00490144BRO', codigo_sku: '60067', cliente_codigo_oficial: 'COD9402', cliente_nome: 'LOJA REIMPORT', status: 'faturado', valor: 5, quantidade: 1, data_implantacao: '2024-07-12', data_faturamento: '2024-07-15' },
    ],
  });
  const linhasReimport = mockDb.__getPedidosOficiaisItens().filter(it => it.cliente_codigo_oficial === 'COD9402');
  const pedidoCorrigido = linhasReimport.find(it => it.nr_pedido === '597502');
  assert(
    res.status < 300 && !linhasReimport.some(it => it.nr_pedido === '00597502') && linhasReimport.some(it => it.nr_pedido === '00490144BRO')
      && pedidoCorrigido && pedidoCorrigido.data_implantacao === '2025-11-05' && pedidoCorrigido.data_faturamento === '2025-11-06',
    `importação: zeros à esquerda não duplicam o pedido (só em número puro) e reimportar corrige a data de implantação: ${JSON.stringify(linhasReimport)}`
  );

  // 24) Produto que saiu da tabela de preços (fora de `produtos`): a
  // importação grava a "Descrição" do relatório e as telas mostram ela no
  // lugar do código (antes: cartão "60110 · Cód. 60110").
  mockDb.__seed({ clientes: [{ id: 9404, nome: 'LOJA DESCONTINUADO', codigo_oficial: 'COD9404' }] });
  res = await req('POST', '/api/pedidos-oficiais/importar', {
    itens: [{ nr_pedido: 'DS9404', codigo_sku: '99110', cliente_codigo_oficial: 'COD9404', cliente_nome: 'LOJA DESCONTINUADO', status: 'faturado',
      valor: 500, quantidade: 2, data_implantacao: '2025-10-01', data_faturamento: '2025-10-03', descricao: 'CORTADOR HD-900' }],
  });
  const linhaDesc = mockDb.__getPedidosOficiaisItens().find(it => it.nr_pedido === 'DS9404');
  const histDesc = await req('GET', '/api/clientes/' + mockDb.__getClientes().find(c => c.codigo_oficial === 'COD9404').id + '/historico');
  const abcDesc = await req('GET', '/api/produtos-abc-geral');
  assert(
    res.status < 300 && linhaDesc && linhaDesc.descricao === 'CORTADOR HD-900'
      && (histDesc.body || []).some(r => r.codigo_sku === '99110' && r.produto === 'CORTADOR HD-900')
      && (abcDesc.body || []).some(r => r.codigo_sku === '99110' && r.produto === 'CORTADOR HD-900'),
    `produto fora da tabela de preços aparece com a Descrição do relatório (histórico e curva ABC): ${JSON.stringify((histDesc.body || []).filter(r => r.codigo_sku === '99110'))}`
  );

  // 25) Aba de pedidos à vista aguardando pagamento: a importação troca a
  // lista inteira (o pedido que saiu da aba foi pago), relatório sem a aba
  // não mexe, e o histórico do cliente devolve os pendentes dele - também
  // quando a aba não traz o código do cliente (casa pelo Nr.Pedido).
  mockDb.__seed({ clientes: [{ id: 9405, nome: 'LOJA A VISTA', codigo_oficial: 'COD9405' }] });
  res = await req('POST', '/api/pedidos-oficiais/importar', {
    itens: [{ nr_pedido: 'AV1', codigo_sku: '1001', cliente_codigo_oficial: 'COD9405', cliente_nome: 'LOJA A VISTA', status: 'carteira',
      valor: 300, quantidade: 1, data_implantacao: '2026-09-20' }],
    pendentes_pagamento: [
      { nr_pedido: 'AV1', valor: 100, data_implantacao: '2026-09-20' },
      { nr_pedido: 'AV1', valor: 200 },
      { nr_pedido: '0000777', cliente_codigo_oficial: 'COD9405', valor: 50, data_implantacao: '2026-09-22' },
      { nr_pedido: '888', cliente_codigo_oficial: 'OUTRO', valor: 10 },
      { valor: 99 },
    ],
  });
  const clienteAV = mockDb.__getClientes().find(c => c.codigo_oficial === 'COD9405').id;
  let histAV = await req('GET', '/api/pedidos-oficiais/' + clienteAV);
  const pendAV = (histAV.body && histAV.body.pendentes_pagamento) || [];
  assert(
    res.status < 300 && res.body.pendentesPagamento === 3 && pendAV.length === 2
      && pendAV.some(p => p.nr_pedido === 'AV1' && Number(p.valor) === 300) && pendAV.some(p => p.nr_pedido === '777'),
    `à vista pendente: importa a aba (soma por pedido, zeros à esquerda) e o histórico do cliente mostra os dele: ${JSON.stringify(pendAV)}`
  );
  res = await req('POST', '/api/pedidos-oficiais/importar', {
    itens: [{ nr_pedido: 'AV2', codigo_sku: '1001', cliente_codigo_oficial: 'COD9405', cliente_nome: 'LOJA A VISTA', status: 'carteira', valor: 1, quantidade: 1 }],
  });
  const aindaTres = mockDb.__getPedidosPendentesPagamento().length === 3;
  res = await req('POST', '/api/pedidos-oficiais/importar', { pendentes_pagamento: [{ nr_pedido: '777', cliente_codigo_oficial: 'COD9405' }] });
  histAV = await req('GET', '/api/pedidos-oficiais/' + clienteAV);
  assert(
    aindaTres && res.status < 300 && histAV.body.pendentes_pagamento.length === 1 && histAV.body.pendentes_pagamento[0].nr_pedido === '777',
    `à vista pendente: relatório sem a aba não mexe; com a aba, o pedido que saiu dela (pago) some: ${JSON.stringify(histAV.body.pendentes_pagamento)}`
  );

  // 26) Aba "Pendentes à Vista": títulos (nota fiscal + parcela) de pedido já
  // faturado com boleto à vista em aberto - ligados ao cliente pelo código ou
  // pela nota fiscal; mesma regra de foto (sumiu da aba = pago).
  mockDb.__seed({ clientes: [{ id: 9406, nome: 'LOJA TITULO', codigo_oficial: 'COD9406' }] });
  res = await req('POST', '/api/pedidos-oficiais/importar', {
    itens: [{ nr_pedido: 'TT1', codigo_sku: '1001', cliente_codigo_oficial: 'COD9406', cliente_nome: 'LOJA TITULO', status: 'faturado',
      valor: 9917.82, quantidade: 1, data_implantacao: '2026-09-20', data_faturamento: '2026-09-22', nota_fiscal: '919895' }],
    titulos_avista: [
      { titulo: 919895, parcela: 1, vencimento: '2026-09-25', valor: 9917.82 },
      { titulo: '000555', parcela: 1, cliente_codigo_oficial: 'COD9406', vencimento: '2026-10-05', valor: 100 },
      { titulo: '777', parcela: 1, cliente_codigo_oficial: 'OUTRO', valor: 1 },
      { valor: 3 },
    ],
  });
  const clienteTT = mockDb.__getClientes().find(c => c.codigo_oficial === 'COD9406').id;
  let histTT = await req('GET', '/api/pedidos-oficiais/' + clienteTT);
  const titTT = (histTT.body && histTT.body.titulos_avista) || [];
  const pendentesAntes = mockDb.__getPedidosPendentesPagamento().length;
  assert(
    res.status < 300 && res.body.titulosAvista === 3 && res.body.pendentesPagamento === null && pendentesAntes > 0
      && titTT.length === 2 && titTT.some(t => t.titulo === '919895' && t.parcela === '1') && titTT.some(t => t.titulo === '555'),
    `títulos à vista: importa a aba (sem mexer nos pedidos aguardando pagamento) e o histórico mostra os do cliente, pela NF ou pelo código: ${JSON.stringify(titTT)}`
  );
  res = await req('POST', '/api/pedidos-oficiais/importar', { titulos_avista: [] });
  histTT = await req('GET', '/api/pedidos-oficiais/' + clienteTT);
  assert(res.status < 300 && histTT.body.titulos_avista.length === 0, 'títulos à vista: aba vazia no relatório novo = todos pagos');

  // 27) Faturamento não conta pedido à vista com título pendente (a NF já está
  // na aba Faturamento, mas o pedido só é faturado depois do pagamento):
  // Curva ABC sem o item enquanto o título está na aba; pago (sumiu), volta.
  const hojeISO = new Date().toISOString().slice(0, 10);
  res = await req('POST', '/api/pedidos-oficiais/importar', {
    itens: [
      { nr_pedido: 'FV1', codigo_sku: '99771', cliente_codigo_oficial: 'COD9406', cliente_nome: 'LOJA TITULO', status: 'faturado',
        valor: 700, quantidade: 7, data_implantacao: hojeISO, data_faturamento: hojeISO, nota_fiscal: '990001' },
      { nr_pedido: 'FV2', codigo_sku: '99772', cliente_codigo_oficial: 'COD9406', cliente_nome: 'LOJA TITULO', status: 'faturado',
        valor: 50, quantidade: 1, data_implantacao: hojeISO, data_faturamento: hojeISO, nota_fiscal: '990002' },
    ],
    titulos_avista: [{ titulo: '990001', parcela: 1, valor: 700 }],
  });
  let abcFV = await req('GET', '/api/produtos-abc-geral');
  const pendenteFora = !(abcFV.body || []).some(r => r.codigo_sku === '99771') && (abcFV.body || []).some(r => r.codigo_sku === '99772');
  await req('POST', '/api/pedidos-oficiais/importar', { titulos_avista: [] });
  abcFV = await req('GET', '/api/produtos-abc-geral');
  assert(
    res.status < 300 && pendenteFora && (abcFV.body || []).some(r => r.codigo_sku === '99771'),
    'faturamento: item de pedido à vista com título pendente fica fora da Curva ABC e volta quando o título é pago'
  );

  // 28) Produto faturado só em parte: o saldo da Carteira e cada nota fiscal
  // do mesmo código ficam em linhas próprias (antes a chave era só
  // nr_pedido + codigo_sku e uma linha sobrescrevia a outra - sumia o saldo, e
  // da entrega em duas notas ficava só a última).
  const { planejarCarteira } = require('../routes/pedidosOficiais');
  const plano = planejarCarteira([
    { nr_pedido: 'X1', codigo_sku: 'A', status: 'faturado', nota_fiscal: '1', situacao_pedido: 'Atendido Parcial' },
    { nr_pedido: 'X1', codigo_sku: 'A', status: 'carteira', situacao_pedido: 'Atendido Parcial' },
    { nr_pedido: 'X1', codigo_sku: 'B', status: 'faturado', nota_fiscal: '1', situacao_pedido: 'Atendido Parcial' },
    { nr_pedido: 'X2', codigo_sku: 'C', status: 'faturado', nota_fiscal: '2', situacao_pedido: 'Atendido Total' },
    { nr_pedido: 'X2', codigo_sku: 'D', status: 'carteira', situacao_pedido: 'Atendido Total' },
  ]);
  assert(
    plano.gravar.length === 4 && !plano.gravar.some(it => it.codigo_sku === 'D')
      && JSON.stringify(plano.pedidosConcluidos) === '["X2"]'
      && JSON.stringify(plano.paresSemSaldo) === '[{"nr_pedido":"X1","codigo_sku":"B"}]',
    `planejarCarteira: saldo do faturado em parte fica, pedido Atendido Total não fica com carteira: ${JSON.stringify(plano)}`
  );

  mockDb.__seed({
    clientes: [{ id: 9407, nome: 'LOJA PARCIAL', codigo_oficial: 'COD9407' }],
    pedidosOficiaisItens: [
      // item cancelado no ERP: pedido depois sai como Atendido Total sem ele
      { nr_pedido: 'PZ29407', codigo_sku: '62001', cliente_codigo_oficial: 'COD9407', quantidade: 3, valor: 30, data_implantacao: '2026-09-01', status: 'carteira', situacao_pedido: 'Aberto' },
      // relatório só com o Faturamento: o faturado ainda apaga o saldo (como antes)
      { nr_pedido: 'PZ39407', codigo_sku: '62002', cliente_codigo_oficial: 'COD9407', quantidade: 2, valor: 20, data_implantacao: '2026-09-01', status: 'carteira', situacao_pedido: 'Aberto' },
      { nr_pedido: 'PZ39407', codigo_sku: '62003', cliente_codigo_oficial: 'COD9407', quantidade: 5, valor: 50, data_implantacao: '2026-09-01', status: 'carteira', situacao_pedido: 'Aberto' },
    ],
  });
  const base9407 = { cliente_codigo_oficial: 'COD9407', cliente_nome: 'LOJA PARCIAL', data_implantacao: '2026-09-01' };
  const linhasPC = (nr) => mockDb.__getPedidosOficiaisItens().filter(it => it.nr_pedido === nr);
  // relatório 1: 6 de 10 faturados na NF 5001, 4 ainda na Carteira
  res = await req('POST', '/api/pedidos-oficiais/importar', {
    itens: [
      { ...base9407, nr_pedido: 'PZ19407', codigo_sku: '60863', status: 'carteira', quantidade: 4, valor: 40, situacao_pedido: 'Atendido Parcial' },
      { ...base9407, nr_pedido: 'PZ19407', codigo_sku: '60863', status: 'faturado', quantidade: 6, valor: 60, data_faturamento: '2026-09-05', nota_fiscal: '5001', situacao_pedido: 'Atendido Parcial' },
      { ...base9407, nr_pedido: 'PZ29407', codigo_sku: '62004', status: 'faturado', quantidade: 1, valor: 10, data_faturamento: '2026-09-05', nota_fiscal: '5002', situacao_pedido: 'Atendido Total' },
      { ...base9407, nr_pedido: 'PZ39407', codigo_sku: '62002', status: 'faturado', quantidade: 2, valor: 20, data_faturamento: '2026-09-05', nota_fiscal: '5003', situacao_pedido: 'Atendido Parcial' },
    ],
  });
  const pc1Rel1 = linhasPC('PZ19407');
  assert(
    res.status < 300 && pc1Rel1.length === 2
      && pc1Rel1.some(it => it.status === 'carteira' && Number(it.quantidade) === 4)
      && pc1Rel1.some(it => it.status === 'faturado' && it.nota_fiscal === '5001' && Number(it.quantidade) === 6),
    `importação: produto faturado em parte guarda o faturado e o saldo em carteira: ${JSON.stringify(pc1Rel1)}`
  );
  assert(
    linhasPC('PZ29407').length === 1 && linhasPC('PZ29407')[0].status === 'faturado'
      && linhasPC('PZ39407').length === 2 && !linhasPC('PZ39407').some(it => it.codigo_sku === '62002' && it.status === 'carteira')
      && linhasPC('PZ39407').some(it => it.codigo_sku === '62003' && it.status === 'carteira'),
    `importação: pedido Atendido Total perde o que sobrou em carteira; produto faturado sem saldo sai da carteira: ${JSON.stringify([...linhasPC('PZ29407'), ...linhasPC('PZ39407')])}`
  );
  // relatório 2: o saldo saiu na NF 5009 - duas notas do mesmo código, sem carteira
  res = await req('POST', '/api/pedidos-oficiais/importar', {
    itens: [
      { ...base9407, nr_pedido: 'PZ19407', codigo_sku: '60863', status: 'faturado', quantidade: 6, valor: 60, data_faturamento: '2026-09-05', nota_fiscal: '5001', situacao_pedido: 'Atendido Total' },
      { ...base9407, nr_pedido: 'PZ19407', codigo_sku: '60863', status: 'faturado', quantidade: 4, valor: 40, data_faturamento: '2026-09-12', nota_fiscal: '5009', situacao_pedido: 'Atendido Total' },
    ],
  });
  const pc1Rel2 = linhasPC('PZ19407');
  assert(
    res.status < 300 && pc1Rel2.length === 2 && pc1Rel2.every(it => it.status === 'faturado')
      && pc1Rel2.reduce((s, it) => s + Number(it.quantidade), 0) === 10,
    `importação: entrega em duas notas do mesmo código guarda as duas, e o saldo sai da carteira: ${JSON.stringify(pc1Rel2)}`
  );
  // as duas notas do mesmo pedido são uma compra só no histórico/rotatividade
  const hist9407 = await req('GET', '/api/clientes/9407/historico');
  const disco9407 = (hist9407.body || []).find(r => r.codigo_sku === '60863');
  assert(
    hist9407.status === 200 && disco9407 && disco9407.total_acumulado === 10 && disco9407.num_pedidos === 1
      && disco9407.media_dias_entre_pedidos === null && disco9407.primeira_compra === disco9407.ultima_compra,
    `histórico: entrega dividida em duas notas conta como uma compra: ${JSON.stringify(disco9407)}`
  );

  // 29) Saldo mínimo em carteira (política de cancelamento): R$ 300, R$ 600 no
  // Norte/Nordeste pela UF da ficha de CNPJ; sem ficha vale o padrão.
  const { saldoMinimoDaUf } = require('../routes/lib/saldoMinimo');
  assert(
    saldoMinimoDaUf('PR').valor === 300 && saldoMinimoDaUf(' ba ').valor === 600 && saldoMinimoDaUf('BA').regiao === 'Norte/Nordeste'
      && saldoMinimoDaUf('AM').valor === 600 && saldoMinimoDaUf(null).valor === 300,
    'saldo mínimo em carteira: R$ 300, R$ 600 no Norte/Nordeste, padrão sem UF'
  );
  let oficiais9407 = await req('GET', '/api/pedidos-oficiais/9407');
  const minimoSemFicha = oficiais9407.body && oficiais9407.body.saldo_minimo;
  mockDb.__seed({ fichasCnpj: { 9407: { cliente_id: 9407, uf: 'CE' } } });
  oficiais9407 = await req('GET', '/api/pedidos-oficiais/9407');
  assert(
    minimoSemFicha && minimoSemFicha.valor === 300
      && oficiais9407.body.saldo_minimo && oficiais9407.body.saldo_minimo.valor === 600 && oficiais9407.body.saldo_minimo.uf === 'CE',
    `pedidos oficiais do cliente trazem o saldo mínimo pela UF da ficha: ${JSON.stringify([minimoSemFicha, oficiais9407.body.saldo_minimo])}`
  );

  // 30) Avisos de importação (routes/lib/novidades.js + routes/novidades.js)
  const nov = require('../routes/lib/novidades');
  {
    // push só em dia útil, 7h-20h de Brasília (UTC-3)
    const j = (iso) => nov.proximaJanelaPush(new Date(iso)).toISOString();
    assert(j('2026-10-07T13:00:00Z') === '2026-10-07T13:00:00.000Z', 'push: quarta 10h sai na hora');
    assert(j('2026-10-07T23:30:00Z') === '2026-10-08T10:00:00.000Z', 'push: quarta 20h30 fica pra quinta 7h');
    assert(j('2026-10-07T08:00:00Z') === '2026-10-07T10:00:00.000Z', 'push: quarta 5h fica pras 7h do mesmo dia');
    assert(j('2026-10-09T23:10:00Z') === '2026-10-12T10:00:00.000Z', 'push: sexta 20h10 fica pra segunda 7h');
    assert(j('2026-10-10T15:00:00Z') === '2026-10-12T10:00:00.000Z', 'push: sábado fica pra segunda 7h');
    assert(j('2026-10-12T02:00:00Z') === '2026-10-12T10:00:00.000Z', 'push: domingo 23h fica pra segunda 7h');
    assert(nov.endpointPushValido('https://fcm.googleapis.com/fcm/send/abc') && nov.endpointPushValido('https://web.push.apple.com/xyz')
      && !nov.endpointPushValido('http://fcm.googleapis.com/x') && !nov.endpointPushValido('https://exemplo.com/fcm.googleapis.com')
      && !nov.endpointPushValido('https://googleapis.com.evil.test/x'),
      'push: só aceita endpoint https dos serviços de push dos navegadores');
  }
  // as importações feitas acima (classificatório, objetivos, relatório oficial
  // várias vezes) viraram novidades - reimportação em até 30 min = a mesma
  res = await req('GET', '/api/novidades');
  {
    const tipos = (res.body.novidades || []).map(n => n.tipo);
    const rel = (res.body.novidades || []).find(n => n.tipo === 'relatorio-oficial');
    assert(res.status === 200 && tipos.filter(t => t === 'relatorio-oficial').length === 1 && tipos.includes('classificatorio') && tipos.includes('objetivos-trimestrais')
      && rel && rel.emoji === '📋' && /^Pedidos até \d{2}\/\d{2}$/.test(rel.texto) && res.body.chave_push === 'BChaveDeTeste_123' && res.body.vistas_ate === null,
      `novidades: uma por tipo (reimportação junta), com emoji e texto curto: ${JSON.stringify(res.body)}`);
    const maisNova = res.body.novidades[0].atualizado_em;
    res = await req('POST', '/api/novidades/vistas', { ate: maisNova });
    const r2 = await req('GET', '/api/novidades');
    assert(res.status === 200 && new Date(r2.body.vistas_ate).getTime() === new Date(maisNova).getTime(),
      `novidades: abrir a lista marca como vistas até a mais nova: ${JSON.stringify(r2.body.vistas_ate)}`);
    res = await req('POST', '/api/novidades/vistas', { ate: '2020-01-01T00:00:00Z' });
    assert(new Date(res.body.vistas_ate).getTime() === new Date(maisNova).getTime(), 'novidades: "vistas" nunca volta pra trás');
  }
  res = await req('POST', '/api/novidades/push/inscrever', { endpoint: 'http://169.254.169.254/latest', keys: { p256dh: 'abc', auth: 'def' } });
  assert(res.status === 400, 'push: inscrição com endpoint fora dos serviços de push é recusada');
  res = await req('POST', '/api/novidades/push/inscrever', { endpoint: 'https://fcm.googleapis.com/fcm/send/aparelho1', keys: { p256dh: 'BPchave-1_x', auth: 'auth1' } });
  const res2 = await req('POST', '/api/novidades/push/inscrever', { endpoint: 'https://fcm.googleapis.com/fcm/send/morta', keys: { p256dh: 'BPchave2', auth: 'auth2' } });
  assert(res.status === 200 && res2.status === 200 && mockDb.__getPushInscricoes().length === 2, 'push: aparelho ativa os avisos');
  await new Promise(r => setTimeout(r, 50));
  webPushEnviados.length = 0;
  {
    const id1 = await nov.avisarImportacao('catalogo-precos', '10 produtos');
    const id2 = await nov.avisarImportacao('catalogo-precos', '12 produtos');
    const n = mockDb.__getNovidades().find(x => x.id === id1);
    assert(id1 && id1 === id2 && n && n.texto === '12 produtos' && mockDb.__getNovidades().filter(x => x.tipo === 'catalogo-precos').length === 1,
      `aviso: o mesmo tipo em até 30 min atualiza a mesma novidade: ${JSON.stringify([id1, id2, n])}`);
    // força a janela (o teste pode rodar à noite/fim de semana) e envia
    await new Promise(r => setTimeout(r, 50));
    mockDb.__getNovidades().forEach(x => { if (x.id === id1) { x.push_pendente = true; x.push_enviar_em = new Date(Date.now() - 1000); } });
    webPushEnviados.length = 0;
    await nov.processarPushPendentes();
    const p = webPushEnviados.find(e => e.payload.tag === `novidade-${id1}`);
    assert(p && p.endpoint.endsWith('aparelho1') && p.payload.titulo === '💲 Catálogo de preços atualizado' && p.payload.texto === '12 produtos'
      && p.payload.url === './index.html#novidades' && p.opts.topic === `novidade${id1}`,
      `push: sai com o título do tipo, texto curto, tag da novidade e abre a lista: ${JSON.stringify(webPushEnviados)}`);
    assert(mockDb.__getPushInscricoes().length === 1 && !mockDb.__getPushInscricoes().some(i => i.endpoint.includes('morta')),
      'push: inscrição expirada (410) é apagada');
    webPushEnviados.length = 0;
    assert(await nov.processarPushPendentes() === 0 && webPushEnviados.length === 0, 'push: o que já foi enviado não sai de novo');
    mockDb.__getNovidades().forEach(x => { if (x.id === id1) { x.push_pendente = true; x.push_enviar_em = new Date(Date.now() + 3600000); } });
    assert(await nov.processarPushPendentes() === 0 && webPushEnviados.length === 0, 'push: fora do horário fica esperando a janela');
  }
  webPushEnviados.length = 0;
  res = await req('POST', '/api/novidades/push/teste', {});
  assert(res.status === 200 && res.body.enviados === 1 && webPushEnviados.length === 1 && webPushEnviados[0].payload.tag === 'teste',
    `push: aviso de teste vai só pros aparelhos de quem pediu: ${JSON.stringify(res.body)}`);
  res = await req('POST', '/api/novidades/push/cancelar', { endpoint: 'https://fcm.googleapis.com/fcm/send/aparelho1' });
  assert(res.status === 200 && mockDb.__getPushInscricoes().length === 0, 'push: desativar apaga a inscrição do aparelho');

  // 31) Importação automática por e-mail (routes/importacaoEmail.js) e leitura
  // compartilhada das planilhas (importadores.js - a mesma do Painel)
  const XLSXt = require('@e965/xlsx');
  const Importadores = require('../importadores');
  const planilha = (abas) => {
    const wb = XLSXt.utils.book_new();
    for (const [nome, linhas] of Object.entries(abas)) XLSXt.utils.book_append_sheet(wb, XLSXt.utils.aoa_to_sheet(linhas, { cellDates: true }), nome);
    return XLSXt.write(wb, { type: 'buffer', bookType: 'xlsx' });
  };
  const dia = (a, m, d) => new Date(a, m - 1, d);
  const xlsRelatorio = planilha({
    Carteira: [['Relatório de Carteira'], [],
      ['Cliente', 'Cod.Cliente', 'Nr.Pedido', 'Item', 'Descrição', 'Qte.Pedida', 'Vlr.Pedido', 'Implantação', 'Classificatório'],
      ['LOJA EMAIL', 'COD9501', '00676001', '60863', 'DISCO', 4, 400, dia(2026, 10, 1), 'Varejo Premium (17)'],
      ['Total', null, null, null, null, null, null, null, null]],
    Faturamento: [['Relatório de Faturamento'], [],
      ['Cliente', 'Cod.Cliente', 'Nr.Pedido', 'Item', 'Descrição', 'Qte.Faturada', 'Vlr.Faturado', 'Dt.Implant', 'Dt.Emissão', 'Nota Fiscal', 'Classificatório', 'Situação'],
      ['LOJA EMAIL', 'COD9501', '675990', '61362', 'CORTADOR', 2, 300, dia(2026, 9, 25), dia(2026, 9, 30), 889001, 'Varejo Premium (17)', 'Atendido Total']],
  });
  const xlsClassif = planilha({ Cliente: [['Relatório Classificatório'],
    ['Cod.Cliente', 'CNPJ', 'Matriz', 'Classificatorio', 'Fat.Cliente', 'Ult.Compra'],
    ['COD9501', '55.555.555/0001-55', 'LOJA EMAIL', 'Varejo Master (20)', 1234.5, dia(2026, 8, 31)],
    ['COD9502', '66.666.666/0001-66', 'OUTRA', null, 10, dia(2026, 8, 1)]] });
  const xlsPrevisao = planilha({ Plan1: [['Item', 'Descrição', 'Qt. Disp.', 'Qt. Carteira', 'Qt. Compra', 'Previsão', 'Saldo'],
    ['60863', 'DISCO', 0, 5, 10, dia(2026, 10, 20), -5],
    ['61362', 'CORTADOR', 3, 0, 0, 'Sem Previsão', 3]] });
  const ufsExatas = ['MG', 'RJ', 'PR', 'SC', 'RS'];
  const xlsPrecos = planilha({
    'Referência Estados': [[], [], [], ...ufsExatas.map((uf, i) => [uf, null, null, null, null, null, null, 11 + i])],
    'TRIBUTAÇÃO': [[], [], [], ['60863', 'DISCO DE CORTE', 10, null, '68042211', 0.05, null, null, null, null, 0.1, 0.1, 0.2, 0.1, 0.1]],
    'PRECIFICAÇÃO': [[], [], [], ['60863', null, ...Array.from({ length: 18 }, (_, i) => 10 + i)]],
  });
  const xlsQualquer = planilha({ Plan1: [['Nome', 'Telefone'], ['Fulano', '123']] });
  {
    assert(Importadores.detectarTipoPlanilha(XLSXt, xlsRelatorio) === 'relatorio' && Importadores.detectarTipoPlanilha(XLSXt, xlsClassif) === 'classificatorio'
      && Importadores.detectarTipoPlanilha(XLSXt, xlsPrevisao) === 'previsao' && Importadores.detectarTipoPlanilha(XLSXt, xlsPrecos) === 'precos'
      && Importadores.detectarTipoPlanilha(XLSXt, xlsQualquer) === null,
      'importadores: reconhece relatório, Classificatório, previsão e lista de preços pelas abas/colunas');
    const rel = Importadores.lerRelatorioOficial(XLSXt, xlsRelatorio);
    const cart = rel.itens.find(i => i.status === 'carteira');
    const fat = rel.itens.find(i => i.status === 'faturado');
    assert(rel.itens.length === 2 && cart.nr_pedido === '676001' && cart.data_implantacao === '2026-10-01' && cart.data_faturamento === null && cart.valor === 400
      && fat.data_implantacao === '2026-09-25' && fat.data_faturamento === '2026-09-30' && fat.nota_fiscal === '889001' && fat.descricao === 'CORTADOR'
      && rel.classificacoes.length === 1 && rel.classificacoes[0].tipo === 'Varejo Premium' && rel.pendentesPagamento === null,
      `importadores: lê Carteira e Faturamento (datas, zeros do pedido, classificação): ${JSON.stringify(rel)}`);
    const cl = Importadores.lerClassificatorio(XLSXt, xlsClassif);
    assert(cl.length === 1 && cl[0].codigoOficial === 'COD9501' && cl[0].classificatorioTipo === 'Varejo Master' && cl[0].ultimaCompra === '2026-08-31' && cl[0].fat12mCliente === 1234.5
      && Importadores.dataRelatorioClassificatorio("02.10.2026_RUSSO'S REPRESENTACO_Classificatorio.xlsx") === '2026-10-02',
      `importadores: lê o Classificatório e a data do relatório pelo nome do arquivo: ${JSON.stringify(cl)}`);
    const pv = Importadores.lerPrevisao(XLSXt, xlsPrevisao);
    assert(pv['60863'].previsao === '2026-10-20' && pv['60863'].qtCarteira === 5 && pv['61362'].previsao === null,
      `importadores: lê os itens em falta (previsão de estoque): ${JSON.stringify(pv)}`);
  }
  const CHAVE_EMAIL = process.env.IMPORTACAO_EMAIL_CHAVE;
  const enviarArquivo = (nome, buf, chave = CHAVE_EMAIL, extra = {}) => req('POST', '/api/importacao-email/arquivo',
    { nome, arquivoBase64: buf.toString('base64'), remetente: 'noreply@cortag.com.br', assunto: 'teste', recebidoEm: '2026-10-04T06:10:25Z', mensagemId: 'm1', ...extra },
    { 'X-Chave-Importacao': chave, Authorization: '' });
  res = await enviarArquivo('ESCE007-28092026060311.xlsx', xlsPrevisao, 'chave-errada');
  assert(res.status === 401 && mockDb.__getImportacoesEmail().length === 0, 'importação por e-mail: chave errada é recusada antes de ler o arquivo');
  mockDb.__seed({ clientes: [{ id: 9501, nome: 'LOJA EMAIL', documento: '55555555000155', codigo_oficial: 'COD9501' }] });
  res = await enviarArquivo('ESCE007-28092026060311.xlsx', xlsPrevisao);
  assert(res.status === 200 && res.body.tipo === 'previsao' && mockDb.__getPrevisaoEstoque().length === 2
    && mockDb.__getNovidades().some(n => n.tipo === 'previsao-estoque' && n.texto === '2 itens')
    && mockDb.__getImportacoesEmail().some(i => i.status === 'ok' && i.tipo === 'previsao' && i.mensagem_id === 'm1'),
    `importação por e-mail: itens em falta entram, registram e geram a novidade: ${JSON.stringify(res.body)}`);
  res = await enviarArquivo('ESCE007-28092026060311.xlsx', xlsPrevisao);
  assert(res.status === 200 && res.body.duplicado === true, 'importação por e-mail: o mesmo arquivo de novo não é importado outra vez');
  res = await enviarArquivo('Repres-20.xlsx', xlsRelatorio);
  assert(res.status === 200 && res.body.tipo === 'relatorio' && res.body.resultado.itens === 2
    && mockDb.__getPedidosOficiaisItens().some(i => i.nr_pedido === '676001' && i.status === 'carteira'),
    `importação por e-mail: relatório Carteira/Faturamento entra pelo mesmo caminho do Painel: ${JSON.stringify(res.body)}`);
  res = await enviarArquivo("02.10.2026_RUSSO'S REPRESENTACO_Classificatorio.xlsx", xlsClassif);
  assert(res.status === 200 && res.body.tipo === 'classificatorio' && res.body.resultado.atualizados === 1,
    `importação por e-mail: Classificatório entra (sem precisar de admin): ${JSON.stringify(res.body)}`);
  res = await enviarArquivo('02.09.2026 - LISTA PADRÃO 2026 - NORTE NORDESTE Por Canal_REV 4.xlsx', xlsPrecos, CHAVE_EMAIL, { remetente: 'vendas@cortag.com' });
  assert(res.status === 422 && /SUL SUDESTE/.test(res.body.erro), `importação por e-mail: lista de preços de outra região é recusada: ${JSON.stringify(res.body)}`);
  {
    // remetente falso: o nome de exibição diz "vendas@cortag.com", o endereço é outro
    const catalogoAntes = JSON.stringify(mockDb.__getCatalogoPrecos());
    res = await enviarArquivo('02.09.2026 - LISTA PADRÃO 2026 - SUL SUDESTE Por Canal_REV 4.xlsx', xlsPrecos, CHAVE_EMAIL,
      { remetente: '"vendas@cortag.com" <golpe@outro-dominio.com>' });
    const xlsRelatorio2 = planilha({ Carteira: [['Relatório de Carteira'], [],
      ['Cliente', 'Cod.Cliente', 'Nr.Pedido', 'Item', 'Descrição', 'Qte.Pedida', 'Vlr.Pedido', 'Implantação', 'Classificatório'],
      ['LOJA EMAIL', 'COD9501', '00676777', '60863', 'DISCO', 1, 99, dia(2026, 10, 2), 'Varejo Premium (17)']] });
    const r2 = await enviarArquivo('Repres-22.xlsx', xlsRelatorio2, CHAVE_EMAIL, { remetente: 'vendas@cortag.com' });
    assert(res.status === 422 && /vendas@cortag\.com/.test(res.body.erro) && JSON.stringify(mockDb.__getCatalogoPrecos()) === catalogoAntes
      && r2.status === 422 && /noreply@cortag\.com\.br/.test(r2.body.erro) && !mockDb.__getPedidosOficiaisItens().some(i => i.nr_pedido === '676777'),
      `importação por e-mail: cada tipo só vale do remetente dele (endereço exato, não o nome de exibição): ${JSON.stringify([res.body, r2.body])}`);
  }
  res = await enviarArquivo('02.09.2026 - LISTA PADRÃO 2026 - SUL SUDESTE Por Canal_REV 4.xlsx', Buffer.concat([xlsPrecos]), CHAVE_EMAIL, { remetente: 'Vendas <vendas@cortag.com>' });
  {
    const p = mockDb.__getCatalogoPrecos().find(x => x.codigo_sku === '60863');
    assert(res.status === 200 && res.body.tipo === 'precos' && p && p.precos.VAREJO.SP === 10.5 && p.precos_sem_imposto.VAREJO.SP === 10,
      `importação por e-mail: Lista de Preços SUL SUDESTE substitui o catálogo: ${JSON.stringify([res.body, p && p.precos.VAREJO])}`);
  }
  res = await enviarArquivo('Repres-21.xlsx', xlsQualquer);
  assert(res.status === 422 && mockDb.__getImportacoesEmail().some(i => i.status === 'falhou' && i.nome_arquivo === 'Repres-21.xlsx'),
    `importação por e-mail: planilha não reconhecida é recusada (422) e fica registrada: ${JSON.stringify(res.body)}`);
  res = await enviarArquivo('relatorio.pdf', xlsPrevisao);
  assert(res.status === 422, 'importação por e-mail: só aceita .xlsx');
  {
    // planilha que parece relatório mas sem as colunas: erro do leitor = recusada (422, não tenta de novo)
    const xlsSemColunas = planilha({ Carteira: [['Relatório de Carteira'], [], ['Cliente', 'Coisa'], ['LOJA', 'x']] });
    res = await enviarArquivo('Repres-23.xlsx', xlsSemColunas);
    assert(res.status === 422 && res.body.tipo === 'relatorio',
      `importação por e-mail: erro do leitor da planilha é recusa (422): ${JSON.stringify(res.body)}`);
    // importou, mas o registro em importacoes_email falhou: continua 200 (antes: 422 "Cortag/Falhou"
    // com o arquivo já dentro do app, e a mensagem crua do banco na resposta)
    const queryOriginal = mockDb.pool.query;
    mockDb.pool.query = async (sql, params) => {
      if (sql.includes('importacao-email:registrar') && params && params[7] === 'ok') throw new Error('conexão perdida SEGREDO-DO-BANCO');
      return queryOriginal(sql, params);
    };
    const xlsPrevisao2 = planilha({ Plan1: [['Item', 'Descrição', 'Qt. Disp.', 'Qt. Carteira', 'Qt. Compra', 'Previsão', 'Saldo'],
      ['60863', 'DISCO', 1, 5, 10, dia(2026, 10, 25), -4]] });
    try {
      res = await enviarArquivo('ESCE007-05102026060311.xlsx', xlsPrevisao2);
    } finally {
      mockDb.pool.query = queryOriginal;
    }
    assert(res.status === 200 && res.body.tipo === 'previsao' && !JSON.stringify(res.body).includes('SEGREDO')
      && mockDb.__getPrevisaoEstoque().some(p => p.codigo_sku === '60863' && Number(p.qt_disponivel) === 1),
      `importação por e-mail: falha só no registro depois de importar não vira "Falhou": ${JSON.stringify(res.body)}`);
  }
  res = await req('GET', '/api/importacao-email/status', null, { Authorization: '' });
  assert(res.status === 401, 'importação por e-mail: o status do Painel exige login');
  res = await req('GET', '/api/importacao-email/status');
  {
    const porTipo = Object.fromEntries((res.body.tipos || []).map(t => [t.tipo, t]));
    assert(res.status === 200 && porTipo.previsao.status === 'ok' && porTipo.precos.status === 'ok' && porTipo.relatorio && porTipo.classificatorio,
      `importação por e-mail: status do Painel traz o último de cada tipo: ${JSON.stringify(res.body)}`);
  }
  {
    // e-mails sem planilha: Pedido Bloqueado e Pedido de Venda à Vista (texto real de 09/2026)
    const EmailCortag = require('../routes/lib/emailCortag');
    const textoBloqueado = 'Prezado(a),\r\n\r\nInformamos que o pedido *00677375* foi bloqueado conforme abaixo:\r\n\r\n'
      + 'Cliente: 22236 DEPOSITO DE MATS. P/ CONSTR. LOANDA LTDA\r\nMotivo: 02-Rejeitado/Limite Crédito\r\n\r\nAtenciosamente';
    const textoAvista = 'COMUNICADO\n\nBoa tarde, CIA ACABAMENTOS LTDA, segue anexo pedido de venda No.00677304 Valor R$ 2.410,03,\n'
      + 'aguardando O pagamento para liberação, caso já tenha efetuado o pagamento favor desconsiderar.';
    const b = EmailCortag.lerPedidoBloqueado('Pedido Bloqueado 00677375', textoBloqueado);
    assert(EmailCortag.ehPedidoBloqueado('Pedido Bloqueado 00677375') && b && b.nr_pedido === '677375' && b.cliente_codigo_oficial === '22236'
      && b.cliente_nome === 'DEPOSITO DE MATS. P/ CONSTR. LOANDA LTDA' && b.motivo === 'Rejeitado/Limite Crédito' && b.motivo_curto === 'Limite Crédito',
      `e-mail Cortag: lê o pedido bloqueado (número sem zeros, cliente, motivo): ${JSON.stringify(b)}`);
    const a = EmailCortag.lerPedidoAvista('Pedido de Venda à Vista - Cortag', textoAvista);
    assert(EmailCortag.ehPedidoAvista('Pedido de Venda à Vista - Cortag') && !EmailCortag.ehPedidoAvista('Pedido Bloqueado 1')
      && a && a.nr_pedido === '677304' && a.cliente_nome === 'CIA ACABAMENTOS LTDA' && a.valor === 2410.03,
      `e-mail Cortag: lê o pedido à vista (número, cliente, valor): ${JSON.stringify(a)}`);

    const enviarMensagem = (assunto, texto, extra = {}, chave = CHAVE_EMAIL) => req('POST', '/api/importacao-email/mensagem',
      { assunto, texto, remetente: 'noreply@cortag.com.br', recebidoEm: new Date().toISOString(), mensagemId: 'msg-' + assunto, ...extra },
      { 'X-Chave-Importacao': chave, Authorization: '' });
    mockDb.__seed({ clientes: [
      { id: 9502, nome: 'DEPOSITO LOANDA', documento: '55555555000256', codigo_oficial: '22236' },
      { id: 9503, nome: 'CIA ACABAMENTOS LTDA', documento: '55555555000337', codigo_oficial: '30001' },
    ] });
    res = await enviarMensagem('Pedido Bloqueado 00677375', textoBloqueado, {}, 'chave-errada');
    assert(res.status === 401 && mockDb.__getPedidosBloqueados().length === 0, 'e-mail Cortag: mensagem com chave errada é recusada');

    const novidadesAntes = mockDb.__getNovidades().length;
    res = await enviarMensagem('Pedido Bloqueado 00677375', textoBloqueado);
    const nb = mockDb.__getNovidades().find(n => n.tipo === 'pedido-bloqueado');
    assert(res.status === 200 && res.body.tipo === 'bloqueado' && res.body.resultado.avisado === true
      && mockDb.__getPedidosBloqueados().some(x => x.nr_pedido === '677375' && x.cliente_codigo_oficial === '22236')
      && nb && nb.titulo === 'Pedido 677375 bloqueado' && nb.texto === 'DEPOSITO LOANDA · Limite Crédito',
      `e-mail Cortag: pedido bloqueado grava o selo e gera o aviso com o nome do cliente no app: ${JSON.stringify([res.body, nb])}`);
    res = await enviarMensagem('Pedido Bloqueado 00677375', textoBloqueado);
    assert(res.status === 200 && res.body.duplicado === true && mockDb.__getNovidades().length === novidadesAntes + 1,
      'e-mail Cortag: a mesma mensagem de novo não gera outro aviso');

    res = await req('GET', '/api/pedidos-oficiais/9502');
    const bloqueadosDoCliente = res.body.bloqueados || [];
    res = await req('GET', '/api/clientes/sync');
    const sync9502 = (res.body.clientes || []).find(c => c.id === 9502);
    const sync9503 = (res.body.clientes || []).find(c => c.id === 9503);
    assert(bloqueadosDoCliente.length === 1 && bloqueadosDoCliente[0].motivo === 'Rejeitado/Limite Crédito'
      && sync9502 && sync9502.bloqueados && sync9502.bloqueados[0].nr_pedido === '677375' && sync9503 && !sync9503.bloqueados,
      `e-mail Cortag: o bloqueio aparece no histórico do cliente e na cópia local (sync): ${JSON.stringify([bloqueadosDoCliente, sync9502])}`);

    mockDb.__seed({ pedidosOficiaisItens: [{ nr_pedido: '677375', codigo_sku: '60863', cliente_codigo_oficial: '22236', cliente_nome: 'DEPOSITO LOANDA',
      status: 'faturado', quantidade: 1, valor: 10, data_implantacao: '2026-10-01', data_faturamento: '2026-10-03', nota_fiscal: '900001' }] });
    res = await req('GET', '/api/pedidos-oficiais/9502');
    assert((res.body.bloqueados || []).length === 0, `e-mail Cortag: o selo de bloqueado some quando o pedido aparece faturado: ${JSON.stringify(res.body.bloqueados)}`);

    const velho = new Date(Date.now() - 5 * 86400000).toISOString();
    res = await enviarMensagem('Pedido Bloqueado 00677400', textoBloqueado.replace('00677375', '00677400'), { recebidoEm: velho });
    assert(res.status === 200 && res.body.resultado.ativo === true && res.body.resultado.avisado === false
      && !mockDb.__getNovidades().some(n => n.titulo === 'Pedido 677400 bloqueado'),
      'e-mail Cortag: e-mail antigo (1ª rodada do script) grava o selo sem mandar push');

    res = await enviarMensagem('Pedido de Venda à Vista - Cortag', textoAvista);
    const na = mockDb.__getNovidades().find(n => n.tipo === 'pedido-avista');
    const pend = mockDb.__getPedidosPendentesPagamento().find(p => p.nr_pedido === '677304');
    assert(res.status === 200 && res.body.tipo === 'avista' && pend && pend.cliente_codigo_oficial === '30001' && pend.valor === 2410.03
      && na && na.titulo === 'Pedido 677304 aguardando pagamento' && na.texto === 'CIA ACABAMENTOS LTDA · R$ 2.410,03',
      `e-mail Cortag: pedido à vista entra nos pendentes (cliente pelo nome) e gera o aviso: ${JSON.stringify([res.body, pend, na])}`);

    // relatório oficial importado depois do e-mail já traz a foto certa: e-mail velho não ressuscita o pedido
    res = await enviarMensagem('Pedido de Venda à Vista - Cortag', textoAvista.replace('00677304', '00677299'), { recebidoEm: '2026-10-01T15:00:00Z' });
    assert(res.status === 200 && res.body.resultado.ignorado && !mockDb.__getPedidosPendentesPagamento().some(p => p.nr_pedido === '677299'),
      `e-mail Cortag: à vista mais velho que o último relatório oficial é ignorado: ${JSON.stringify(res.body)}`);

    res = await enviarMensagem('Pedido Bloqueado 00677998', textoBloqueado.replace('00677375', '00677998'), { remetente: 'Cortag <noreply@cortag.com.br.golpe.com>' });
    assert(res.status === 422 && !mockDb.__getPedidosBloqueados().some(x => x.nr_pedido === '677998'),
      `e-mail Cortag: pedido bloqueado de outro remetente é recusado (sem selo nem push): ${JSON.stringify(res.body)}`);

    {
      // gravou o selo e mandou o aviso, mas o registro final falhou: 200 (com 503 o script
      // reenviava e cada reenvio mandava outro push)
      const queryOriginal = mockDb.pool.query;
      mockDb.pool.query = async (sql, params) => {
        if (sql.includes('importacao-email:registrar') && params && params[7] === 'ok') throw new Error('conexão perdida');
        return queryOriginal(sql, params);
      };
      const avisosAntes = mockDb.__getNovidades().filter(n => n.titulo === 'Pedido 677997 bloqueado').length;
      try {
        res = await enviarMensagem('Pedido Bloqueado 00677997', textoBloqueado.replace('00677375', '00677997'));
      } finally {
        mockDb.pool.query = queryOriginal;
      }
      assert(res.status === 200 && res.body.tipo === 'bloqueado'
        && mockDb.__getNovidades().filter(n => n.titulo === 'Pedido 677997 bloqueado').length === avisosAntes + 1,
        `e-mail Cortag: falha só no registro depois de gravar o bloqueio responde 200 (sem reenvio = sem push repetido): ${JSON.stringify(res.body)}`);
    }

    res = await enviarMensagem('Pedido Bloqueado 00677999', 'texto sem o formato esperado');
    const res2 = await enviarMensagem('Relatório de Comissões', 'qualquer coisa');
    assert(res.status === 200 && res.body.resultado.nr_pedido === '677999' && res2.status === 422
      && mockDb.__getImportacoesEmail().some(i => i.status === 'falhou' && i.nome_arquivo === 'Relatório de Comissões'),
      `e-mail Cortag: número só no assunto ainda vale; e-mail não reconhecido é recusado (422): ${JSON.stringify([res.body, res2.body])}`);
  }
  {
    // script do Gmail (scripts/gmail-importacao/Codigo.gs, roda no Google): só manda
    // e-mail do endereço exato que o Gmail autenticou (DKIM/DMARC). Cabeçalhos no
    // formato do e-mail real da vendas@cortag.com de 16/09/2026.
    const codigoGs = require('fs').readFileSync(require('path').join(__dirname, '../scripts/gmail-importacao/Codigo.gs'), 'utf8');
    const gs = require('vm').runInNewContext(codigoGs + '\n;({ enderecoDe_, cabecalhos_, autenticadoPeloGmail_ })', {});
    const bruto = (autenticacao, resto = '') => ['Delivered-To: russo2055@gmail.com',
      'Received: by 2002:a05:6000:118e with SMTP id g14;\r\n        Wed, 16 Sep 2026 07:11:09 -0700 (PDT)',
      'ARC-Authentication-Results: i=2; mx.google.com;\r\n       dkim=pass header.i=@cortag.com',
      ...(autenticacao ? ['Authentication-Results: mx.google.com;\r\n       ' + autenticacao.join(';\r\n       ')] : []),
      'From: Vendas <vendas@cortag.com>', 'Subject: LISTA', resto].filter(Boolean).join('\r\n') + '\r\n\r\ncorpo\r\nAuthentication-Results: mx.google.com; dmarc=pass header.from=cortag.com';
    const cab = (autenticacao, resto) => gs.cabecalhos_({ getRawContent: () => bruto(autenticacao, resto) });
    const real = ['dkim=pass header.i=@cortag.com header.s=selector1 header.b=C49PC7Nx',
      'arc=pass (i=1 spf=pass spfdomain=cortag.com dkim=pass dkdomain=cortag.com dmarc=pass fromdomain=cortag.com)',
      'spf=pass (google.com: domain of vendas@cortag.com designates 2a01:111:f403:c111::5 as permitted sender) smtp.mailfrom=vendas@cortag.com',
      'dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=cortag.com'];
    const internoDaCortag = 'authentication-results: dkim=none (message not signed)\r\n header.d=none;dmarc=none action=none header.from=cortag.com;';
    const falsoAbaixo = 'Authentication-Results: mx.google.com; dkim=pass header.i=@cortag.com; dmarc=pass header.from=cortag.com';
    const reprovado = ['dkim=none', 'spf=pass smtp.mailfrom=golpe@outro-dominio.com', 'dmarc=fail (p=QUARANTINE) header.from=cortag.com'];
    assert(gs.enderecoDe_('Vendas <VENDAS@cortag.com>') === 'vendas@cortag.com' && gs.enderecoDe_('noreply@cortag.com.br') === 'noreply@cortag.com.br'
      && gs.enderecoDe_('"vendas@cortag.com" <golpe@outro-dominio.com>') === 'golpe@outro-dominio.com',
      'script do Gmail: o remetente é o endereço dentro de <...>, não o nome de exibição');
    assert(gs.autenticadoPeloGmail_(cab(real, internoDaCortag), 'vendas@cortag.com') === true
      && gs.autenticadoPeloGmail_(cab(['dkim=pass header.i=@cortag.com.br header.s=s1', 'spf=pass smtp.mailfrom=noreply@cortag.com.br']), 'noreply@cortag.com.br') === true
      && gs.autenticadoPeloGmail_(cab(['dkim=pass header.d=cortag.com.br']), 'noreply@cortag.com.br') === true,
      'script do Gmail: e-mail com DMARC ou DKIM "pass" do domínio do remetente vale');
    assert(gs.autenticadoPeloGmail_(cab(reprovado, falsoAbaixo), 'vendas@cortag.com') === false
      && gs.autenticadoPeloGmail_(cab(real), 'noreply@cortag.com.br') === false
      && gs.autenticadoPeloGmail_(cab(['dkim=pass header.d=cortag.com.golpe.com', 'dmarc=fail header.from=cortag.com']), 'vendas@cortag.com') === false
      && gs.autenticadoPeloGmail_(cab(['dkim=pass header.i=@cortag.com']), 'noreply@cortag.com.br') === false
      && gs.autenticadoPeloGmail_(cab(['spf=pass smtp.mailfrom=vendas@cortag.com', 'dmarc=none header.from=cortag.com']), 'vendas@cortag.com') === false
      && gs.autenticadoPeloGmail_('From: vendas@cortag.com', 'vendas@cortag.com') === false,
      'script do Gmail: não vale "pass" escrito por quem mandou (abaixo do do Gmail), de outro domínio/subdomínio, só SPF ou sem Authentication-Results');
    // formatos reais do log do conferirAutenticacao (05/10/2026): a noreply passa SÓ pelo
    // DMARC (DKIM de cortagind.onmicrosoft.com, não alinhado); a vendas@ às vezes traz
    // header.b entre aspas
    const realNoreply = ['dkim=pass header.i=@cortagind.onmicrosoft.com header.s=selector2-cortagind-onmicrosoft-com header.b=e3BvrIva',
      'arc=pass (i=1 spf=pass spfdomain=cortag.com.br dkim=pass dkdomain=cortag.com.br dmarc=pass fromdomain=cortag.com.br)',
      'spf=pass (google.com: domain of noreply@cortag.com.br designates 2a01:111:f403:c10d::1 as permitted sender) smtp.mailfrom=noreply@cortag.com.br',
      'dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=cortag.com.br'];
    const realVendasAspas = ['dkim=pass header.i=@cortag.com header.s=selector1 header.b="ALsKnD/O"',
      'spf=pass (google.com: domain of vendas@cortag.com designates 2a01:111:f403:c10d::3 as permitted sender) smtp.mailfrom=vendas@cortag.com',
      'dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=cortag.com'];
    assert(gs.autenticadoPeloGmail_(cab(realNoreply), 'noreply@cortag.com.br') === true
      && gs.autenticadoPeloGmail_(cab(realVendasAspas), 'vendas@cortag.com') === true
      && gs.autenticadoPeloGmail_(cab(realNoreply.filter(r => !r.startsWith('dmarc='))), 'noreply@cortag.com.br') === false,
      'script do Gmail: formato real da noreply (só DMARC) e da vendas@ (header.b entre aspas) passam; noreply sem o DMARC não');
    // endereço de envio escolhido por quem manda, repetido pelo Gmail no comentário do spf e
    // no smtp.mailfrom: um ";dmarc=pass header.from=..." dentro dele não vira resultado
    const envelope = (texto) => ['dkim=none', `spf=pass (google.com: domain of ${texto}@golpe.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=${texto}@golpe.com`,
      'dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=cortag.com.br'];
    assert(gs.autenticadoPeloGmail_(cab(envelope('"x;dmarc=pass header.from=cortag.com.br y"')), 'noreply@cortag.com.br') === false
      && gs.autenticadoPeloGmail_(cab(envelope('"x;dkim=pass header.i=@cortag.com y"')), 'vendas@cortag.com') === false
      && gs.autenticadoPeloGmail_(cab(envelope('"x(;dmarc=pass header.from=cortag.com.br"')), 'noreply@cortag.com.br') === false,
      'script do Gmail: "pass" escondido no endereço de envio (entre aspas/parênteses) não vale');
    // cada resultado tem que estar inteiro no formato "metodo=resultado chave.sub=valor":
    // pedaço solto no meio ou chave repetida descarta o resultado
    assert(gs.autenticadoPeloGmail_(cab(['dmarc=pass golpe header.from=cortag.com.br']), 'noreply@cortag.com.br') === false
      && gs.autenticadoPeloGmail_(cab(['dmarc=pass header.from=golpe.com header.from=cortag.com.br']), 'noreply@cortag.com.br') === false
      && gs.autenticadoPeloGmail_(cab(['dmarc=pass header.from=cortag.com.br=x']), 'noreply@cortag.com.br') === false
      && gs.autenticadoPeloGmail_(cab(['dkim=pass x=y header.i=@cortag.com']), 'vendas@cortag.com') === false
      && gs.autenticadoPeloGmail_(cab(['dmarc=pass header.from=cortag.com.br.golpe.com']), 'noreply@cortag.com.br') === false
      && gs.autenticadoPeloGmail_(cab(['dkim=pass header.i=@cortag.com header.d=cortag.com header.b=""']), 'vendas@cortag.com') === true
      && gs.autenticadoPeloGmail_(cab(['DMARC=Pass header.from=Cortag.com.br']), 'noreply@cortag.com.br') === true,
      'script do Gmail: resultado de autenticação só vale inteiro no formato (sem pedaço solto nem chave repetida)');
    // verificarEmails de ponta a ponta, com Gmail/servidor falsos: e-mail com erro do
    // servidor (503) não trava a fila pra sempre - na 4ª rodada vira "Falhou" e o
    // seguinte entra; remetente falso nunca é mandado (endereço de fora: nem é
    // considerado; endereço da Cortag sem autenticação: "Cortag/Nao autenticado").
    // "autenticado" guardado pela checagem antiga (chave sem versão) não vale mais:
    // o golpe-endereco é conferido de novo e marcado
    const props = { CHAVE: 'chave-teste', AUTENTICADOS: JSON.stringify({ 'golpe-endereco': 'noreply@cortag.com.br' }) };
    const marcadores = {};
    const leiturasCompletas = {};
    const logs = [];
    const enviados = [];
    const autenticado = 'Authentication-Results: mx.google.com;\r\n dkim=pass header.i=@cortag.com.br;\r\n dmarc=pass header.from=cortag.com.br';
    const emailFalso = (id, de, nomeAnexo, data, cab) => {
      const thread = { addLabel: (l) => { marcadores[id] = marcadores[id] ? marcadores[id] + '+' + l.nome : l.nome; }, getMessages: () => [msg] };
      const msg = {
        getId: () => id, getDate: () => data, getFrom: () => de, getSubject: () => 'Relatório ' + id,
        getAttachments: () => [].concat(nomeAnexo).map(n => ({ getName: () => n, getBytes: () => [1, 2, 3] })),
        getRawContent: () => { leiturasCompletas[id] = (leiturasCompletas[id] || 0) + 1; return cab + '\r\nFrom: ' + de + '\r\n\r\ncorpo'; },
      };
      return thread;
    };
    const agora = Date.now();
    let bancoFora = false;
    const threads = [
      emailFalso('velho-503', 'noreply@cortag.com.br', 'Repres-1.xlsx', new Date(agora - 3 * 3600000), autenticado),
      emailFalso('novo-ok', 'noreply@cortag.com.br', 'Repres-2.xlsx', new Date(agora - 3600000), autenticado),
      emailFalso('golpe-nome', '"noreply@cortag.com.br" <golpe@outro.com>', 'Repres-3.xlsx', new Date(agora - 7200000),
        'Authentication-Results: mx.google.com; dmarc=fail header.from=outro.com'),
      emailFalso('golpe-endereco', 'noreply@cortag.com.br', 'Repres-4.xlsx', new Date(agora - 5400000),
        'Authentication-Results: mx.google.com; spf=softfail; dmarc=fail header.from=cortag.com.br'),
      // dois anexos: um entra, outro é recusado (422) -> os dois marcadores
      emailFalso('dois-anexos', 'noreply@cortag.com.br', ['Repres-5.xlsx', 'Repres-6-ruim.xlsx'], new Date(agora - 1800000), autenticado),
      // "De:" com comentário em vez de <...>: fica de fora, mas avisa no log
      emailFalso('outro-formato', 'noreply@cortag.com.br (Cortag)', 'Repres-7.xlsx', new Date(agora - 1700000), autenticado),
    ];
    const ctx = {
      Logger: { log: (...a) => { logs.push(a.join(' ')); } },
      Utilities: { base64Encode: () => 'AQID', sleep: () => {} },
      PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; }, deleteProperty: k => { delete props[k]; } }) },
      GmailApp: { search: () => threads, getUserLabelByName: n => ({ nome: n }), createLabel: n => ({ nome: n }) },
      UrlFetchApp: { fetch: (url, opts) => {
        if (url.endsWith('/health')) return { getResponseCode: () => 200 };
        if (url.endsWith('/health/banco')) return { getResponseCode: () => (bancoFora ? 503 : 200) };
        const corpo = JSON.parse(opts.payload);
        enviados.push(corpo.nome);
        const codigo = corpo.nome === 'Repres-1.xlsx' ? 503 : corpo.nome === 'Repres-6-ruim.xlsx' ? 422 : 200;
        return { getResponseCode: () => codigo, getContentText: () => '{}' };
      } },
    };
    require('vm').runInNewContext(codigoGs, ctx);
    // banco do app fora do ar por 5 rodadas (/health no ar, /health/banco 503): nada é
    // mandado nem conta tentativa - senão uma queda longa do banco fazia desistir de e-mail bom
    bancoFora = true;
    for (let i = 0; i < 5; i++) ctx.verificarEmails();
    const comBancoFora = { enviados: enviados.splice(0).length, marcadores: Object.keys(marcadores).filter(k => k !== 'golpe-endereco').length,
      tentativas: props.TENTATIVAS || '{}' };
    bancoFora = false;
    const rodadas = [];
    for (let i = 0; i < 4; i++) {
      ctx.verificarEmails();
      rodadas.push({ velho: marcadores['velho-503'] || null, novo: marcadores['novo-ok'] || null, enviados: enviados.splice(0).join(',') });
    }
    assert(rodadas.slice(0, 3).every(r => !r.velho && !r.novo && r.enviados === 'Repres-1.xlsx')
      && rodadas[3].velho === 'Cortag/Falhou' && rodadas[3].novo === 'Cortag/Importado'
      && rodadas[3].enviados === 'Repres-1.xlsx,Repres-2.xlsx,Repres-5.xlsx,Repres-6-ruim.xlsx'
      && !marcadores['golpe-nome'] && marcadores['golpe-endereco'] === 'Cortag/Nao autenticado'
      && !('velho-503' in JSON.parse(props.TENTATIVAS || '{}'))
      && comBancoFora.enviados === 0 && comBancoFora.marcadores === 0 && comBancoFora.tentativas === '{}'
      // o e-mail que esperou na fila 9 rodadas (5 de banco fora + 4 de erro) foi lido inteiro 1 vez só
      && leiturasCompletas['velho-503'] === 1 && leiturasCompletas['novo-ok'] === 1
      && JSON.parse(props.AUTENTICADOS_v2 || '{}')['velho-503'] === undefined && !('AUTENTICADOS' in props)
      && marcadores['dois-anexos'] === 'Cortag/Importado+Cortag/Falhou'
      && !marcadores['outro-formato'] && !leiturasCompletas['outro-formato']
      && logs.some(l => l.includes('não é exatamente o da Cortag') && l.includes('(Cortag)')),
      `script do Gmail: erro do servidor tenta 4 rodadas e desiste sem travar a fila; banco fora não conta tentativa; remetente falso não é mandado; e-mail na fila lido 1 vez; 2 anexos = 2 marcadores; "De:" fora do padrão avisa: ${JSON.stringify([comBancoFora, rodadas, marcadores, leiturasCompletas])}`);
  }
  {
    // relatório diário do fim de semana: na segunda sai um push só, o do mais novo
    const idSab = await nov.avisarImportacao('objetivos-trimestrais', 'sábado');
    mockDb.__getNovidades().forEach(x => { if (x.id === idSab) { x.atualizado_em = new Date(Date.now() - 3600000); x.push_pendente = true; x.push_enviar_em = new Date(Date.now() + 86400000); } });
    const idDom = await nov.avisarImportacao('objetivos-trimestrais', 'domingo');
    const sab = mockDb.__getNovidades().find(x => x.id === idSab);
    assert(idSab !== idDom && sab.push_pendente === false, 'aviso: novidade nova do mesmo tipo tira da fila o push que ainda esperava o horário');
  }

  {
    // Service Worker: toda biblioteca de CDN que as páginas carregam está na lista
    // do sw.js (senão quebra sem internet - imagem/PDF do orçamento, câmera no
    // iPhone); e página/script do app guardados sem os parâmetros (?cliente=…).
    const fs = require('fs');
    const raiz = path.join(__dirname, '..');
    const sw = fs.readFileSync(path.join(raiz, 'sw.js'), 'utf8');
    const usadas = new Set();
    for (const f of ['index.html', 'curva-abc.html', 'calculadora-materiais.html', 'ficha-cnpj.html', 'importadores.js']) {
      for (const m of fs.readFileSync(path.join(raiz, f), 'utf8').matchAll(/https:\/\/(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net)\/[^'"`\s)]+/g)) usadas.add(m[0]);
    }
    const faltando = [...usadas].filter(u => !sw.includes(`'${u}'`));
    // versão fixa no endereço: o SW guarda pelo endereço e não busca de novo (@latest ficaria preso)
    assert(usadas.size >= 5 && faltando.length === 0 && ![...usadas].some(u => u.includes('@latest')) && /cache\.put\(chave,/.test(sw) && !/ignoreSearch:\s*true/.test(sw),
      `service worker guarda offline todas as bibliotecas de CDN das páginas e as páginas sem parâmetro: ${JSON.stringify(faltando)}`);
  }

  console.log();
  console.log(process.exitCode === 1 ? 'ALGUNS TESTES FALHARAM' : 'TODOS OS TESTES PASSARAM');
  process.exit(process.exitCode || 0);
}

main().catch(e => { console.error('ERRO NO TESTE:', e); process.exit(1); });
