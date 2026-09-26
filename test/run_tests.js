// Substitui o módulo ../db pelo mock ANTES de qualquer rota carregar,
// interceptando o require - assim testo o server.js de verdade, só trocando
// o banco por dentro.
const Module = require('module');
const path = require('path');
const mockDb = require('./mock-db');
const { generateToken, hashToken } = require('../auth-utils');
const dbPath = path.resolve(__dirname, '../db.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  const resolved = originalResolve.call(this, request, ...args);
  return resolved;
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: mockDb };

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

  // 13) classificatório: calcula sobre o ANO CIVIL FECHADO anterior, não uma
  // janela móvel de 12 meses (ver routes/clientesClassificatorio.js) - semeia
  // um cliente com faturamento no ano fechado (conta) e um pedido no ano
  // corrente ainda não fechado (não deve contar, mesmo sendo mais recente).
  const anoFechado = mockDb.__anoClassificatorioFechado();
  mockDb.__seed({
    clientes: [{
      id: 9001, nome: 'CLIENTE CLASSIFICATORIO TESTE', documento: '99988877000166', codigo_oficial: 'COD9001',
      classificatorio_tipo: 'Varejo Premium', classificatorio_desconto: 17, classificatorio_pic: false, classificatorio_vl_acordo: null, matriz_grupo: null,
    }],
    pedidosOficiaisItens: [
      { nr_pedido: 'PC1', codigo_sku: '60863', cliente_codigo_oficial: 'COD9001', quantidade: 1, valor: 43000, data_faturamento: `${anoFechado}-06-15`, data_implantacao: `${anoFechado}-06-15`, status: 'faturado' },
      { nr_pedido: 'PC2', codigo_sku: '60863', cliente_codigo_oficial: 'COD9001', quantidade: 1, valor: 500000, data_faturamento: `${anoFechado + 1}-01-05`, data_implantacao: `${anoFechado + 1}-01-05`, status: 'faturado' },
    ],
  });
  res = await req('GET', '/api/clientes/9001/classificatorio/status');
  assert(
    res.status === 200 && res.body.faturamento12m === 43000 && res.body.periodoReferencia?.anoInicio === anoFechado,
    `classificatório soma só o ano civil fechado (${anoFechado}), ignora pedido do ano corrente ainda não fechado`
  );
  assert(
    res.body.anoCorrente === anoFechado + 1 && res.body.faturamentoAnoCorrente === 500000,
    'classificatório também traz o acumulado do ano em andamento (pra acompanhar ao lado do ano fechado)'
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
  const trimestres = (res.body.trimestral?.historico || []).map(t => t.trimestre.slice(0, 7));
  assert(
    !trimestres.some(t => t === `${anoFechado}-06`) && trimestres.some(t => t === `${anoFechado + 1}-01`),
    `gráfico trimestral mostra a janela móvel recente (tem ${anoFechado + 1}-01, não tem ${anoFechado}-06): ${JSON.stringify(trimestres)}`
  );

  // 14b) regra confirmada com o usuário: subir de faixa usa o ANO CORRENTE
  // (não o fechado) e pode acontecer a qualquer momento do ano assim que
  // bater o teto (não precisa esperar dezembro); cair só é sinalizado
  // quando o ritmo trimestral está "atrasado" - senão mostraria risco
  // falso o ano inteiro (ex: em fevereiro, todo mundo está "abaixo" de uma
  // meta pensada pra dezembro). Teste unitário direto na função pura,
  // sem precisar montar cenário de trimestres reais.
  const { calcularStatusClassificatorio } = require('../routes/clientesClassificatorio');
  let s = calcularStatusClassificatorio({ tipo: 'Varejo Premium', faturamento12m: 25000, faturamentoAnoCorrente: 55000, atrasadoNoRitmo: false });
  assert(
    s.jaQualificaProximaFaixa === true && s.faltaPraProximaFaixa == null,
    'sobe de faixa assim que o ano corrente bate o teto, mesmo com o ano fechado abaixo (promoção não espera dezembro)'
  );
  s = calcularStatusClassificatorio({ tipo: 'Varejo Master', faturamento12m: 60000, faturamentoAnoCorrente: 10000, atrasadoNoRitmo: false });
  assert(s.emRiscoDeQueda === false, 'acumulado baixo no início do ano não é risco de queda se o ritmo trimestral não está atrasado (evita alarme falso)');
  s = calcularStatusClassificatorio({ tipo: 'Varejo Master', faturamento12m: 60000, faturamentoAnoCorrente: 10000, atrasadoNoRitmo: true });
  assert(
    s.emRiscoDeQueda === true && s.faltaPraManter === 40000,
    'sinaliza risco de queda quando o ritmo trimestral está atrasado (faltam R$40.000 pra chegar no mínimo de R$50.000)'
  );

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
      // Ano fechado (pra conferir faturamento12m) - dentro da janela trimestral
      // móvel também entra o par de janeiro do ano corrente (mesmo mês já
      // confirmado "dentro da janela" no teste 14 acima, com PC2).
      { nr_pedido: 'PC7', codigo_sku: '60863', cliente_codigo_oficial: 'COD9005', quantidade: 1, valor: 8000, data_faturamento: `${anoFechado}-06-15`, data_implantacao: `${anoFechado}-06-15`, status: 'faturado' },
      { nr_pedido: 'PC7B', codigo_sku: '60863', cliente_codigo_oficial: 'COD9005', quantidade: 1, valor: 3000, data_faturamento: `${anoFechado + 1}-01-05`, data_implantacao: `${anoFechado + 1}-01-05`, status: 'faturado' },
      { nr_pedido: 'PC8', codigo_sku: '60863', cliente_codigo_oficial: 'COD9006', quantidade: 1, valor: 900000, data_faturamento: `${anoFechado}-06-15`, data_implantacao: `${anoFechado}-06-15`, status: 'faturado' },
      { nr_pedido: 'PC8B', codigo_sku: '60863', cliente_codigo_oficial: 'COD9006', quantidade: 1, valor: 500000, data_faturamento: `${anoFechado + 1}-01-05`, data_implantacao: `${anoFechado + 1}-01-05`, status: 'faturado' },
    ],
  });
  const resRede = await req('GET', '/api/clientes/9005/classificatorio/status');
  assert(
    resRede.status === 200 && resRede.body.ehRede === true && resRede.body.faturamento12m === 8000,
    `cliente Rede mostra só o próprio faturamento (8.000), não somado com a outra loja da rede (900.000): ${resRede.body.faturamento12m}`
  );
  const trimestresRede = (resRede.body.trimestral?.historico || []).reduce((s, t) => s + Number(t.faturado), 0);
  assert(
    trimestresRede === 3000,
    `histórico trimestral do cliente Rede também é só individual (3.000), não soma a outra loja (500.000): ${trimestresRede}`
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
      { nr_pedido: 'PC3', codigo_sku: '60863', cliente_codigo_oficial: 'COD9002', quantidade: 1, valor: 10000, data_faturamento: `${anoFechado}-06-15`, status: 'faturado' },
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
      && nomes[0] === 'CLIENTE CLASSIFICATORIO TESTE 2 (GRUPO)' && res.body.membros[0].faturamentoAnoFechado === 10000
      && res.body.membros[1].faturamentoAnoFechado === 43000,
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
  };
  const conv = brasilApiParaFormatoRadar(respostaBrasilApi);
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

  console.log();
  console.log(process.exitCode === 1 ? 'ALGUNS TESTES FALHARAM' : 'TODOS OS TESTES PASSARAM');
  process.exit(process.exitCode || 0);
}

main().catch(e => { console.error('ERRO NO TESTE:', e); process.exit(1); });
