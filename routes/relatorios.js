const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { SQL_FATURAMENTO_CLASSIFICATORIO_INDIVIDUAL_POR_CLIENTE, diaDoBanco } = require('./clientesClassificatorio');
const { mesclarPorCodigoBase, codigoBase } = require('./lib/skuNormalizacao');
const { nomesDosProdutos } = require('./lib/cacheTabela');
const { grupoDoProduto } = require('./lib/agrupamentoProduto');
const { SQL_PEDIDO_APP_VALIDO, sqlDiaDoPedido, SQL_HOJE_BR, FUSO, indexarDatasOficiais, pedidoAppJaFaturado } = require('./lib/comprasApp');
const { validarIdInteiro } = require('../middleware/validarId');
const { sqlFaturadoDeFato } = require('./lib/faturadoDeFato');
const { clientesDeOutroVendedor, REPRESENTACAO } = require('./lib/contasSalesforce');
const { rankingMixInicial, canalDaLoja } = require('./lib/mixInicial');
const { comSubfamilia } = require('./lib/subfamilias');
const { marcarDescontinuados, estaDescontinuado, grupoDescontinuado, catalogoOuNada } = require('./lib/descontinuado');

router.param('id', validarIdInteiro);
router.param('produtoId', validarIdInteiro);

// Reconcilia códigos promocionais (P/P1/P2 + código base, ver
// routes/lib/skuNormalizacao.js) num array já agregado por codigo_sku
// literal, e corrige num_pedidos pros grupos que mescharam 2+ códigos
// (soma ingênua de COUNT DISTINCT pode contar duas vezes um nr_pedido
// que por acaso tem o código base E a variante na mesma linha de
// pedido - raro; uma consulta só pra todos os grupos que de fato mesclaram).
async function reconciliarProdutosPorCodigoBase(linhas, { inicio, fim, clienteCodigo } = {}) {
  const produtosResult = await pool.query('SELECT codigo_sku, nome, categoria FROM produtos');
  const produtosPorCodigo = {};
  for (const p of produtosResult.rows) produtosPorCodigo[p.codigo_sku] = p;
  const mescladas = mesclarPorCodigoBase(linhas, produtosPorCodigo);
  // pedidos distintos de todos os grupos mesclados numa consulta só (antes uma
  // por grupo)
  const grupos = mescladas.filter(g => g._codigosOriginais.length >= 2);
  if (grupos.length > 0) {
    const params = [grupos.flatMap((g, i) => g._codigosOriginais.map(() => i)), grupos.flatMap(g => g._codigosOriginais)];
    let filtro = '';
    if (clienteCodigo) { params.push(clienteCodigo); filtro += ` AND poi.cliente_codigo_oficial = $${params.length}`; }
    if (inicio) { params.push(inicio); filtro += ` AND poi.data_faturamento >= $${params.length}::date`; }
    if (fim) { params.push(fim); filtro += ` AND poi.data_faturamento <= $${params.length}::date`; }
    const r = await pool.query(
      `/* curva-abc:pedidos-por-grupo */
       SELECT g.grupo, COUNT(DISTINCT poi.nr_pedido) AS total
       FROM UNNEST($1::int[], $2::text[]) AS g(grupo, codigo_sku)
       JOIN pedidos_oficiais_itens poi ON poi.codigo_sku = g.codigo_sku
       WHERE ${sqlFaturadoDeFato('poi')}${filtro}
       GROUP BY g.grupo`,
      params
    );
    const totalDoGrupo = new Map(r.rows.map(x => [Number(x.grupo), Number(x.total)]));
    grupos.forEach((g, i) => { g.num_pedidos = totalDoGrupo.get(i) || 0; });
  }
  for (const grupo of mescladas) delete grupo._codigosOriginais;
  return mescladas;
}

// Canal do cliente pro Dashboard (não existe campo de canal de venda no
// cadastro - deriva do prefixo do classificatorio_tipo, mesma convenção já
// usada nas faixas de faturamento: "Varejo Master"/"Varejo Premium"/etc →
// "Varejo", "Atacado Premium" → "Atacado", "Rede" → "Rede". Sem
// classificatório (grande maioria da base, clientes "Varejo" comuns) cai em
// "Varejo" por padrão.
function canalDoCliente(classificatorioTipo) {
  const t = String(classificatorioTipo || '').trim();
  if (/^Atacado/i.test(t)) return 'Atacado';
  if (/^Rede/i.test(t)) return 'Rede';
  return 'Varejo';
}

// Faixas dos cartões "Contas - X a Y Meses Sem Compra" do Dashboard, na régua
// do painel do Salesforce (conferida em 22/10/2026 contra o relatório "Todas
// Contas"): meses de calendário contados de hoje pra trás - "3 a 5" = último
// pedido entre hoje - 5 meses e hoje - 3 meses, "6 a 8" = entre - 8 e - 6
// (os dois limites entram). Quem está entre 5 e 6 meses (ou 8 e 9) não entra
// em nenhum: é assim no Salesforce - com faixas emendadas o 3-5 dava 79 e o
// 6-8, 32 (painel: 61 e 24; com este corte, 62 e 24). Antes eram blocos de 30
// dias (90-179/180-269). Limiar diferente do
// DIAS_SEM_COMPRAR_ALERTA=60 do alerta de classificatório.
const FAIXA_3_A_5_MESES = [3, 5];
const FAIXA_6_A_8_MESES = [6, 8];

// "AAAA-MM-DD" de N meses antes do dia dado, como o "- interval 'N months'" do
// Postgres: dia que não existe no mês de destino vira o último dele (31/07 - 5
// meses = 28/02).
function mesesAntes(diaISO, n) {
  const [a, m, d] = diaISO.split('-').map(Number);
  const alvo = new Date(Date.UTC(a, m - 1 - n, 1));
  const ultimo = new Date(Date.UTC(alvo.getUTCFullYear(), alvo.getUTCMonth() + 1, 0)).getUTCDate();
  alvo.setUTCDate(Math.min(d, ultimo));
  return alvo.toISOString().slice(0, 10);
}

// Produto entregue em mais de uma nota fiscal do mesmo pedido (faturado em
// parte, o saldo saiu depois) vira uma linha por nota em
// pedidos_oficiais_itens. Pra "o que o cliente comprou" continua sendo uma
// compra só: soma as notas do mesmo pedido + código, na data da primeira -
// senão a entrega dividida parecia recompra e encurtava a Rotatividade.
function juntarNotasDoPedido(rows) {
  const dia = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
  const porChave = new Map();
  for (const l of rows) {
    const chave = `${l.pedido}::${l.codigo_sku}`;
    const atual = porChave.get(chave);
    if (!atual) { porChave.set(chave, { ...l, quantidade: Number(l.quantidade) || 0 }); continue; }
    atual.quantidade += Number(l.quantidade) || 0;
    if (l.data && (!atual.data || dia(l.data) < dia(atual.data))) atual.data = l.data;
    if (!atual.descricao && l.descricao) atual.descricao = l.descricao;
  }
  return [...porChave.values()];
}

// Tudo que o cliente comprou, por SKU e por dia: faturado oficial (relatório
// do ERP) + pedidos feitos pelo app. Antes Histórico/Rotatividade/Recuperar só
// olhavam o app (desde 05/2026, uma fração das compras) - quem comprava pelo
// ERP aparecia sem histórico. Mesmas regras de comprados-recentes:
//  - código promocional (P/P1/P2 + código) conta como o produto base;
//  - pedido do app que já virou faturado oficial não conta de novo, e as
//    cópias da importação antiga de faturamento nunca contam (regra e janela
//    em routes/lib/comprasApp.js);
//  - se ainda sobrar app e faturado do mesmo SKU no mesmo dia, vale o faturado.
// Devolve Map codigo_sku -> { codigo_sku, nome, noCatalogo, dias: Map
// 'AAAA-MM-DD' -> { quantidade, pedidos: Set } }. `null` se o cliente não existe.
async function comprasDoCliente(clienteId) {
  const cliente = await pool.query('SELECT codigo_oficial FROM clientes WHERE id = $1', [clienteId]);
  if (cliente.rows.length === 0) return null;
  const codigoOficial = cliente.rows[0].codigo_oficial;
  const [oficial, app, produtos] = await Promise.all([
    codigoOficial
      ? pool.query(
        `/* compras-cliente:oficial */
         SELECT codigo_sku, data_faturamento AS data, quantidade, nr_pedido AS pedido, descricao
         FROM pedidos_oficiais_itens
         WHERE status = 'faturado' AND data_faturamento IS NOT NULL AND cliente_codigo_oficial = $1`,
        [codigoOficial])
      : Promise.resolve({ rows: [] }),
    pool.query(
      `/* compras-cliente:app */
       SELECT p.codigo_sku, ${sqlDiaDoPedido()} AS data, pi.quantidade, 'app' || ped.id AS pedido
       FROM pedidos ped
       JOIN pedido_itens pi ON pi.pedido_id = ped.id
       JOIN produtos p ON p.id = pi.produto_id
       WHERE ped.cliente_id = $1 AND ${SQL_PEDIDO_APP_VALIDO}`,
      [clienteId]),
    nomesDosProdutos(),
  ]);
  const nomePorCodigo = new Map(produtos.rows.map(p => [String(p.codigo_sku), p.nome]));
  const codigosConhecidos = new Set(nomePorCodigo.keys());
  const dia = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
  const skuDe = (l) => codigoBase(String(l.codigo_sku), codigosConhecidos);
  oficial.rows = juntarNotasDoPedido(oficial.rows);
  // produto que saiu da tabela de preços (fora de `produtos`): nome pela
  // "Descrição" do relatório oficial, em vez de mostrar só o código
  const descricaoPorSku = new Map();
  for (const l of oficial.rows) if (l.descricao && !descricaoPorSku.has(skuDe(l))) descricaoPorSku.set(skuDe(l), l.descricao);
  const datasOficiais = indexarDatasOficiais(oficial.rows, skuDe);
  const appNaoFaturado = app.rows.filter(l => !pedidoAppJaFaturado(skuDe(l), l.data, datasOficiais));
  // primeiro separa por origem, depois escolhe a origem de cada dia
  const brutos = new Map(); // sku -> dia -> { oficial: {q, pedidos}, app: {q, pedidos} }
  for (const [origem, rows] of [['oficial', oficial.rows], ['app', appNaoFaturado]]) {
    for (const l of rows) {
      if (!l.data) continue;
      const sku = codigoBase(String(l.codigo_sku), codigosConhecidos);
      const d = dia(l.data);
      const porDia = brutos.get(sku) || new Map();
      const noDia = porDia.get(d) || { oficial: { q: 0, pedidos: new Set() }, app: { q: 0, pedidos: new Set() } };
      noDia[origem].q += Number(l.quantidade) || 0;
      noDia[origem].pedidos.add(String(l.pedido));
      porDia.set(d, noDia);
      brutos.set(sku, porDia);
    }
  }
  const compras = new Map();
  for (const [sku, porDia] of brutos) {
    const dias = new Map();
    for (const [d, noDia] of porDia) {
      const vale = noDia.oficial.pedidos.size > 0 ? noDia.oficial : noDia.app;
      dias.set(d, { quantidade: vale.q, pedidos: vale.pedidos });
    }
    compras.set(sku, { codigo_sku: sku, nome: nomePorCodigo.get(sku) || descricaoPorSku.get(sku) || sku, noCatalogo: nomePorCodigo.has(sku), dias });
  }
  return compras;
}

// Resumo de um SKU a partir de comprasDoCliente: 1ª/última compra, nº de
// pedidos, total e intervalo médio entre as compras (dias distintos).
function resumoCompras(c) {
  const dias = [...c.dias.keys()].sort();
  const pedidos = new Set();
  let total = 0;
  for (const q of c.dias.values()) { total += q.quantidade; q.pedidos.forEach(p => pedidos.add(p)); }
  const primeira = dias[0];
  const ultima = dias[dias.length - 1];
  const media = dias.length > 1
    ? Math.round((new Date(ultima) - new Date(primeira)) / 86400000 / (dias.length - 1))
    : null;
  return {
    codigo_sku: c.codigo_sku, produto: c.nome,
    primeira_compra: primeira, ultima_compra: ultima,
    num_pedidos: pedidos.size, total_acumulado: total, total_comprado: total,
    media_dias_entre_pedidos: media,
  };
}

// Todos os produtos que esse cliente já comprou alguma vez, com primeira/última
// compra e total acumulado - a pergunta original do projeto.
router.get('/clientes/:id/historico', async (req, res) => {
  try {
    const compras = await comprasDoCliente(req.params.id);
    if (!compras) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    const lista = [...compras.values()].map(resumoCompras)
      .sort((a, b) => b.ultima_compra.localeCompare(a.ultima_compra));
    res.json(await marcarDescontinuados(pool, lista, 'produto'));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao gerar histórico.' });
  }
});

// Rotatividade: além do histórico, calcula o intervalo médio entre as compras -
// isso responde "de quanto em quanto tempo esse cliente costuma repor esse item".
router.get('/clientes/:id/rotatividade', async (req, res) => {
  try {
    const compras = await comprasDoCliente(req.params.id);
    if (!compras) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    const lista = [...compras.values()].map(resumoCompras)
      .sort((a, b) => (a.media_dias_entre_pedidos ?? Infinity) - (b.media_dias_entre_pedidos ?? Infinity)
        || b.ultima_compra.localeCompare(a.ultima_compra));
    res.json(await marcarDescontinuados(pool, lista, 'produto'));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao calcular rotatividade.' });
  }
});

// Histórico de visitas/levantamentos feitos nesse cliente
router.get('/clientes/:id/levantamentos', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.id, l.nome, l.data_visita, v.nome AS vendedor,
              COUNT(li.id) AS num_produtos, SUM(li.quantidade_contada) AS total_unidades
       FROM levantamentos l
       LEFT JOIN vendedores v ON l.vendedor_id = v.id
       LEFT JOIN levantamento_itens li ON li.levantamento_id = l.id
       WHERE l.cliente_id = $1
       GROUP BY l.id, l.nome, l.data_visita, v.nome
       ORDER BY l.data_visita DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar levantamentos.' });
  }
});

// Consumo real estimado: compara leituras sucessivas de estoque contado no
// levantamento, somando o que foi pedido no intervalo, pra estimar o que foi
// de fato consumido entre uma visita e outra:
//   consumo = estoque_inicial + pedido_no_periodo - estoque_final
// Isso é mais preciso que só olhar frequência de pedido, porque conta o que
// o cliente realmente gastou, não só quando ele repôs.
router.get('/clientes/:id/consumo-estimado/:produtoId', async (req, res) => {
  const { id, produtoId } = req.params;
  try {
    const leiturasResult = await pool.query(
      `SELECT l.data_visita, li.quantidade_contada, (l.data_visita AT TIME ZONE '${FUSO}')::date::text AS dia_visita
       FROM levantamento_itens li
       JOIN levantamentos l ON li.levantamento_id = l.id
       WHERE l.cliente_id = $1 AND li.produto_id = $2
       ORDER BY l.data_visita ASC`,
      [id, produtoId]
    );
    const leituras = leiturasResult.rows;
    // O que entrou entre uma visita e outra vem do faturado oficial + app
    // (comprasDoCliente) - só o app deixava de fora a compra feita pelo ERP
    // e o consumo saía menor que o real (ou zerado).
    const [compras, produto] = await Promise.all([
      leituras.length > 1 ? comprasDoCliente(id) : null,
      pool.query('SELECT codigo_sku FROM produtos WHERE id = $1', [produtoId]),
    ]);
    const doProduto = compras && produto.rows[0] ? compras.get(String(produto.rows[0].codigo_sku)) : null;
    // dia da visita no fuso de Brasília (data_visita é TIMESTAMPTZ): pelo dia
    // UTC, a visita feita depois das 21h caía no dia seguinte e a compra desse
    // dia saía do período
    const diaDe = (l) => l.dia_visita || (l.data_visita instanceof Date ? l.data_visita.toISOString() : String(l.data_visita)).slice(0, 10);
    const consumos = [];
    for (let i = 1; i < leituras.length; i++) {
      const inicio = leituras[i-1].data_visita;
      const fim = leituras[i].data_visita;
      let pedidoNoPeriodo = 0;
      if (doProduto) {
        for (const [d, q] of doProduto.dias) {
          if (d > diaDe(leituras[i-1]) && d <= diaDe(leituras[i])) pedidoNoPeriodo += q.quantidade;
        }
      }
      const dias = (new Date(fim) - new Date(inicio)) / 86400000;
      const consumoEstimado = Number(leituras[i-1].quantidade_contada) + pedidoNoPeriodo - Number(leituras[i].quantidade_contada);
      consumos.push({
        de: inicio,
        ate: fim,
        dias: Math.round(dias),
        estoque_inicial: leituras[i-1].quantidade_contada,
        pedido_no_periodo: pedidoNoPeriodo,
        estoque_final: leituras[i].quantidade_contada,
        consumo_estimado: consumoEstimado > 0 ? consumoEstimado : 0,
      });
    }
    res.json({ leituras, consumos });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao calcular consumo estimado.' });
  }
});

// Busca reversa: dado um código de produto, quem já comprou ele e/ou quem
// tem ele no levantamento mais recente. Útil pra "preciso saber quem tem
// esse produto" sem precisar abrir cliente por cliente.
router.get('/produtos/:codigo/clientes', async (req, res) => {
  const { codigo } = req.params;
  try {
    const produtoResult = await pool.query('SELECT id, codigo_sku, nome FROM produtos WHERE codigo_sku = $1', [codigo]);
    if (produtoResult.rows.length === 0) return res.status(404).json({ erro: 'Produto não encontrado — confira o código ou sincronize o catálogo.' });
    const produtoId = produtoResult.rows[0].id;

    // Quem comprou = faturado oficial (relatório do ERP) + pedidos feitos
    // pelo app - antes só contava o app, e o cliente que comprou direto pelo
    // ERP (a maioria) não aparecia. Códigos promocionais (P/P1/P2 + código)
    // contam como o próprio produto, como na Curva ABC.
    const variantes = [codigo, `P${codigo}`, `P1${codigo}`, `P2${codigo}`];
    const [oficial, app] = await Promise.all([
      pool.query(
        `/* produto-compradores:oficial */
         SELECT c.id, c.nome, c.documento, poi.quantidade, poi.data_faturamento AS data, poi.nota_fiscal
         FROM pedidos_oficiais_itens poi
         JOIN clientes c ON c.codigo_oficial = poi.cliente_codigo_oficial
         WHERE poi.status = 'faturado' AND poi.data_faturamento IS NOT NULL AND poi.codigo_sku = ANY($1)`,
        [variantes]),
      pool.query(
        `/* produto-compradores:app */
         SELECT c.id, c.nome, c.documento, pi.quantidade, ${sqlDiaDoPedido()} AS data
         FROM pedido_itens pi
         JOIN produtos p ON p.id = pi.produto_id
         JOIN pedidos ped ON ped.id = pi.pedido_id
         JOIN clientes c ON c.id = ped.cliente_id
         WHERE p.codigo_sku = ANY($1) AND ${SQL_PEDIDO_APP_VALIDO}`,
        [variantes]),
    ]);
    const dia = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
    // pedido do app que já virou faturado oficial desse cliente não conta de
    // novo (routes/lib/comprasApp.js) - todas as variantes são "o produto"
    const datasOficiais = indexarDatasOficiais(oficial.rows, r => String(r.id));
    const appNaoFaturado = app.rows.filter(r => !pedidoAppJaFaturado(String(r.id), r.data, datasOficiais));
    const porCliente = new Map();
    for (const [origem, rows] of [['oficial', oficial.rows], ['app', appNaoFaturado]]) {
      for (const r of rows) {
        const g = porCliente.get(r.id) || { id: r.id, nome: r.nome, documento: r.documento, dias: new Map(), ultima_compra: null, nota_fiscal: null };
        const d = dia(r.data);
        const q = g.dias.get(d) || { oficial: 0, app: 0 };
        q[origem] += Number(r.quantidade) || 0;
        g.dias.set(d, q);
        if (!g.ultima_compra || d > g.ultima_compra) g.ultima_compra = d;
        if (origem === 'oficial' && r.nota_fiscal && (!g._dataNf || d >= g._dataNf)) { g.nota_fiscal = r.nota_fiscal; g._dataNf = d; }
        porCliente.set(r.id, g);
      }
    }
    // Se ainda sobrar app e faturado no mesmo dia, vale só o faturado.
    const compradores = [...porCliente.values()]
      .map(g => ({
        id: g.id, nome: g.nome, documento: g.documento,
        total_comprado: [...g.dias.values()].reduce((t, q) => t + (q.oficial || q.app), 0),
        ultima_compra: g.ultima_compra,
        nota_fiscal: g.nota_fiscal,
      }))
      .sort((a, b) => b.ultima_compra.localeCompare(a.ultima_compra));

    // só a leitura mais recente de levantamento por cliente (não o histórico
    // inteiro) - o que importa aqui é "quanto ele tem agora", não a série toda
    const levantados = await pool.query(
      `SELECT DISTINCT ON (c.id) c.id, c.nome, c.documento, li.quantidade_contada, l.data_visita
       FROM levantamento_itens li
       JOIN levantamentos l ON l.id = li.levantamento_id
       JOIN clientes c ON c.id = l.cliente_id
       WHERE li.produto_id = $1
       ORDER BY c.id, l.data_visita DESC`,
      [produtoId]
    );

    res.json({
      produto: produtoResult.rows[0],
      compradores,
      levantamentos: levantados.rows,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar clientes desse produto.' });
  }
});

// Exporta todos os pedidos (com itens) num período - usado pra baixar um CSV
// direto do servidor, de qualquer aparelho, sem depender de arquivo salvo
// localmente em algum celular específico. Só admin, já que é o histórico da
// empresa toda, não só do vendedor logado.
router.get('/pedidos/exportar', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode exportar o histórico completo de pedidos.' });
  const { inicio, fim } = req.query;
  if (!inicio || !fim) return res.status(400).json({ erro: 'Informe as datas de início e fim (?inicio=AAAA-MM-DD&fim=AAAA-MM-DD).' });
  try {
    const result = await pool.query(
      `/* pedidos:exportar */
       SELECT
         ped.data_pedido, ${sqlDiaDoPedido()}::text AS dia, c.nome AS cliente_nome, c.documento AS cliente_documento,
         v.nome AS vendedor_nome, p.codigo_sku, p.nome AS produto_nome,
         pi.quantidade, pi.preco_unitario, ped.origem, ped.numero_cotacao
       FROM pedidos ped
       JOIN pedido_itens pi ON pi.pedido_id = ped.id
       JOIN clientes c ON c.id = ped.cliente_id
       JOIN produtos p ON p.id = pi.produto_id
       LEFT JOIN vendedores v ON v.id = ped.vendedor_id
       WHERE ${sqlDiaDoPedido()} BETWEEN $1::date AND $2::date
       ORDER BY ${sqlDiaDoPedido()} DESC, ped.data_pedido DESC`,
      [inicio, fim]
    );
    console.log(`Exportação de pedidos (${inicio} a ${fim}): ${result.rows.length} linha(s), por ${req.usuario?.email}.`);
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao exportar pedidos.' });
  }
});

// Produtos que esse cliente já comprou antes, mas faz tempo que não repõe, E
// que o levantamento mais recente mostra em zero (ou nem foi contado) - é a
// lista de "oportunidade de recuperar venda": já foi cliente desse produto,
// não tem mais em estoque, provavelmente precisa repor.
// Sugestões de recompra: TIPOS de produto (variações agrupadas pelo nome, ver
// routes/lib/agrupamentoProduto.js) que o cliente já comprou mas não compra
// há mais de 1 ano - lembrete pro vendedor oferecer de novo, pensado pro
// produto que acabou na loja e por isso nem aparece mais no levantamento.
// Histórico = faturado oficial (pelo codigo_oficial) + pedidos feitos pelo
// app. Se QUALQUER variação do grupo foi comprada no último ano, o grupo não
// entra. Ordem: o que ele mais comprava primeiro.
const SUGESTOES_DIAS_SEM_COMPRAR = 365;
const SUGESTOES_LIMITE = 15;
router.get('/clientes/:id/sugestoes-recompra', async (req, res) => {
  try {
    const cliente = await pool.query('SELECT codigo_oficial FROM clientes WHERE id = $1', [req.params.id]);
    if (cliente.rows.length === 0) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    const codigoOficial = cliente.rows[0].codigo_oficial;

    const [oficial, app, produtos] = await Promise.all([
      codigoOficial
        ? pool.query(
          `/* sugestoes-recompra:oficial */
           SELECT DISTINCT codigo_sku, data_faturamento AS data, nr_pedido AS pedido
           FROM pedidos_oficiais_itens
           WHERE status = 'faturado' AND cliente_codigo_oficial = $1 AND data_faturamento IS NOT NULL`,
          [codigoOficial])
        : Promise.resolve({ rows: [] }),
      pool.query(
        `/* sugestoes-recompra:app */
         SELECT DISTINCT p.codigo_sku, ${sqlDiaDoPedido()} AS data, 'app' || ped.id AS pedido
         FROM pedidos ped
         JOIN pedido_itens pi ON pi.pedido_id = ped.id
         JOIN produtos p ON p.id = pi.produto_id
         WHERE ped.cliente_id = $1 AND ${SQL_PEDIDO_APP_VALIDO}`,
        [req.params.id]),
      nomesDosProdutos(),
    ]);

    const nomePorCodigo = new Map(produtos.rows.map(p => [String(p.codigo_sku), p.nome]));
    const codigosConhecidos = new Set(nomePorCodigo.keys());
    // uma linha por (SKU, pedido); pedido do app que já virou faturado oficial
    // não conta de novo (routes/lib/comprasApp.js)
    const skuDe = (l) => codigoBase(String(l.codigo_sku), codigosConhecidos);
    const datasOficiais = indexarDatasOficiais(oficial.rows, skuDe);
    const porSku = new Map();
    for (const l of [...oficial.rows, ...app.rows.filter(l => !pedidoAppJaFaturado(skuDe(l), l.data, datasOficiais))]) {
      if (!l.data) continue;
      const sku = skuDe(l);
      const g = porSku.get(sku) || { codigo_sku: sku, ultima_compra: null, pedidos: new Set() };
      const data = new Date(l.data);
      if (!g.ultima_compra || data > g.ultima_compra) g.ultima_compra = data;
      g.pedidos.add(String(l.pedido));
      porSku.set(sku, g);
    }
    const cat = await catalogoOuNada(pool);
    const grupos = new Map();
    for (const linha of [...porSku.values()].map(g => ({ codigo_sku: g.codigo_sku, ultima_compra: g.ultima_compra, num_pedidos: g.pedidos.size }))) {
      const sku = linha.codigo_sku;
      const nome = nomePorCodigo.get(sku);
      if (!nome || !linha.ultima_compra) continue; // produto fora do catálogo: sem nome pra agrupar
      const { chave, rotulo } = grupoDoProduto(nome);
      const g = grupos.get(chave) || { chave, grupo: rotulo, ultima_compra: null, num_pedidos: 0, variacoes: new Set(), ultimo: null };
      // prefere o rótulo com acento quando o catálogo grafa o mesmo nome dos dois jeitos
      if (rotulo !== g.grupo && /[^\x00-\x7F]/.test(rotulo) && !/[^\x00-\x7F]/.test(g.grupo)) g.grupo = rotulo;
      const data = new Date(linha.ultima_compra);
      if (!g.ultima_compra || data > g.ultima_compra) g.ultima_compra = data;
      g.num_pedidos += Number(linha.num_pedidos) || 0;
      g.variacoes.add(sku);
      // a medida comprada por último que ainda está na Lista de Preços - o "+"
      // da gaveta do cliente (Dashboard) põe ela na proposta
      if (!(cat && estaDescontinuado(sku, cat.codigos)) && (!g.ultimo || data > g.ultimo.data)) g.ultimo = { sku, data };
      grupos.set(chave, g);
    }

    const limite = Date.now() - SUGESTOES_DIAS_SEM_COMPRAR * 86400000;
    const sugestoes = [...grupos.values()]
      // grupo sem nenhum produto na Lista de Preços saiu de linha: não tem o que
      // oferecer. Código trocado por um novo continua no mesmo grupo (fica).
      .filter(g => !(cat && grupoDescontinuado(g.chave, cat)))
      .filter(g => g.ultima_compra.getTime() < limite)
      .sort((a, b) => b.num_pedidos - a.num_pedidos || b.ultima_compra - a.ultima_compra)
      .slice(0, SUGESTOES_LIMITE)
      .map(g => ({
        grupo: g.grupo,
        ultima_compra: g.ultima_compra.toISOString().slice(0, 10),
        meses_sem_comprar: Math.floor((Date.now() - g.ultima_compra.getTime()) / (30.44 * 86400000)),
        num_pedidos: g.num_pedidos,
        variacoes: g.variacoes.size,
        codigo_sku: g.ultimo ? g.ultimo.sku : null,
      }));
    res.json(sugestoes);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar sugestões de recompra.' });
  }
});

// Faturado do cliente mês a mês, este mês + os 11 anteriores - gráfico da gaveta
// do cliente no Dashboard (curva-abc.html). Por CNPJ (sem somar a matriz),
// faturado de fato pela data da nota (mesma régua da faixa). Mês sem nota = 0;
// meses pelo dia de Brasília, como a série mensal do Dashboard.
router.get('/clientes/:id/mensal', async (req, res) => {
  try {
    const cliente = await pool.query('SELECT codigo_oficial FROM clientes WHERE id = $1', [req.params.id]);
    if (cliente.rows.length === 0) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    const r = await pool.query(
      `/* cliente-mensal */
       SELECT to_char(m.periodo, 'YYYY-MM-DD') AS periodo, COALESCE(f.valor, 0) AS valor
       FROM generate_series(date_trunc('month', ${SQL_HOJE_BR}) - INTERVAL '11 months',
                            date_trunc('month', ${SQL_HOJE_BR}), INTERVAL '1 month') AS m(periodo)
       LEFT JOIN (
         SELECT date_trunc('month', data_faturamento) AS periodo, SUM(valor) AS valor
         FROM pedidos_oficiais_itens
         WHERE ${sqlFaturadoDeFato()} AND cliente_codigo_oficial = $1
           AND data_faturamento >= date_trunc('month', ${SQL_HOJE_BR}) - INTERVAL '11 months'
         GROUP BY 1
       ) f ON f.periodo = m.periodo
       ORDER BY m.periodo`,
      [cliente.rows[0].codigo_oficial]);
    res.json({ meses: r.rows.map(x => ({ periodo: x.periodo, valor: Math.round((Number(x.valor) || 0) * 100) / 100 })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar o faturamento mensal do cliente.' });
  }
});

// Comprados no último ano (por SKU) - o Levantamento mostra os que não foram
// contados na prateleira: produto que acabou na loja não tem o que escanear e
// sairia do pedido (ex.: 3 rebolos na última compra, nenhum na prateleira).
// Complementa as sugestões de recompra acima, que cobrem o que ele NÃO compra
// há mais de 1 ano. Histórico = faturado oficial + pedidos do app; código
// promocional conta como o base. qtd_ultima_compra = soma do SKU no dia da
// compra mais recente - vira a quantidade sugerida pro pedido.
const COMPRADOS_RECENTES_DIAS = 365;
const COMPRADOS_RECENTES_LIMITE = 60;
router.get('/clientes/:id/comprados-recentes', async (req, res) => {
  try {
    const cliente = await pool.query('SELECT codigo_oficial FROM clientes WHERE id = $1', [req.params.id]);
    if (cliente.rows.length === 0) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    const codigoOficial = cliente.rows[0].codigo_oficial;

    const [oficial, app, produtos] = await Promise.all([
      codigoOficial
        ? pool.query(
          `/* comprados-recentes:oficial */
           SELECT codigo_sku, data_faturamento AS data, quantidade, nr_pedido AS pedido
           FROM pedidos_oficiais_itens
           WHERE status = 'faturado' AND cliente_codigo_oficial = $1
             AND data_faturamento > ${SQL_HOJE_BR} - $2::int`,
          [codigoOficial, COMPRADOS_RECENTES_DIAS])
        : Promise.resolve({ rows: [] }),
      pool.query(
        `/* comprados-recentes:app */
         SELECT p.codigo_sku, ${sqlDiaDoPedido()} AS data, pi.quantidade, 'app' || ped.id AS pedido
         FROM pedidos ped
         JOIN pedido_itens pi ON pi.pedido_id = ped.id
         JOIN produtos p ON p.id = pi.produto_id
         WHERE ped.cliente_id = $1 AND ${sqlDiaDoPedido()} > ${SQL_HOJE_BR} - $2::int AND ${SQL_PEDIDO_APP_VALIDO}`,
        [req.params.id, COMPRADOS_RECENTES_DIAS]),
      nomesDosProdutos(),
    ]);

    const nomePorCodigo = new Map(produtos.rows.map(p => [String(p.codigo_sku), p.nome]));
    const codigosConhecidos = new Set(nomePorCodigo.keys());
    const dia = (d) => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
    const porSku = new Map();
    // Pedido do app que já virou faturado oficial não conta de novo
    // (routes/lib/comprasApp.js); se ainda sobrar app e faturado do mesmo SKU
    // no mesmo dia, vale só a quantidade do faturado.
    const skuDe = (l) => codigoBase(String(l.codigo_sku), codigosConhecidos);
    oficial.rows = juntarNotasDoPedido(oficial.rows);
    const datasOficiais = indexarDatasOficiais(oficial.rows, skuDe);
    const linhas = [
      ...oficial.rows.map(l => ({ ...l, origem: 'oficial' })),
      ...app.rows.filter(l => !pedidoAppJaFaturado(skuDe(l), l.data, datasOficiais)).map(l => ({ ...l, origem: 'app' })),
    ];
    const cat = await catalogoOuNada(pool);
    for (const linha of linhas) {
      if (!linha.data) continue;
      const sku = codigoBase(String(linha.codigo_sku), codigosConhecidos);
      if (!nomePorCodigo.has(sku)) continue; // fora do catálogo: o app não tem como incluir
      if (cat && estaDescontinuado(sku, cat.codigos)) continue; // saiu da Lista de Preços: não ocupa vaga
      const d = dia(linha.data);
      const g = porSku.get(sku) || { codigo_sku: sku, nome: nomePorCodigo.get(sku), ultima_compra: d, qtd: { oficial: 0, app: 0 }, pedidos: new Set() };
      if (d > g.ultima_compra) { g.ultima_compra = d; g.qtd = { oficial: 0, app: 0 }; }
      if (d === g.ultima_compra) g.qtd[linha.origem] += Number(linha.quantidade) || 0;
      g.pedidos.add(String(linha.pedido));
      porSku.set(sku, g);
    }
    const lista = [...porSku.values()]
      .sort((a, b) => b.ultima_compra.localeCompare(a.ultima_compra) || b.pedidos.size - a.pedidos.size)
      .slice(0, COMPRADOS_RECENTES_LIMITE)
      .map(g => ({
        codigo_sku: g.codigo_sku,
        nome: g.nome,
        ultima_compra: g.ultima_compra,
        qtd_ultima_compra: g.qtd.oficial || g.qtd.app,
        num_pedidos: g.pedidos.size,
      }));
    res.json(lista);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar produtos comprados.' });
  }
});

router.get('/clientes/:id/recuperar', async (req, res) => {
  try {
    // Já comprou (faturado oficial + app - ver comprasDoCliente), e no
    // levantamento mais recente em que o produto apareceu estava zerado, ou
    // nunca foi contado. Só pra quem já tem levantamento: sem nenhum, não há
    // com o que comparar (e a lista viraria só "o que ele comprou há mais tempo").
    const [compras, leituras] = await Promise.all([
      comprasDoCliente(req.params.id),
      pool.query(
        `SELECT DISTINCT ON (li.produto_id) p.codigo_sku, li.quantidade_contada, l.data_visita
         FROM levantamento_itens li
         JOIN levantamentos l ON l.id = li.levantamento_id
         JOIN produtos p ON p.id = li.produto_id
         WHERE l.cliente_id = $1
         ORDER BY li.produto_id, l.data_visita DESC`,
        [req.params.id]),
    ]);
    if (!compras) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    const temLevantamento = await pool.query('SELECT 1 FROM levantamentos WHERE cliente_id = $1 LIMIT 1', [req.params.id]);
    if (temLevantamento.rows.length === 0) return res.json([]);
    const ultimaLeitura = new Map(leituras.rows.map(r => [String(r.codigo_sku), r]));
    const cat = await catalogoOuNada(pool);
    const lista = [];
    for (const c of compras.values()) {
      if (!c.noCatalogo) continue; // fora do catálogo: não tem como ir pro orçamento
      // saiu da Lista de Preços: não tem o que oferecer, e era o que ocupava as 30 vagas
      // (é o de compra mais antiga)
      if (cat && estaDescontinuado(c.codigo_sku, cat.codigos)) continue;
      const leitura = ultimaLeitura.get(c.codigo_sku);
      if (leitura && Number(leitura.quantidade_contada) > 0) continue;
      const r = resumoCompras(c);
      lista.push({
        codigo_sku: r.codigo_sku, produto: r.produto, ultima_compra: r.ultima_compra, total_comprado: r.total_comprado,
        estoque_atual: 0, ultimo_levantamento: leitura ? leitura.data_visita : null,
      });
    }
    lista.sort((a, b) => a.ultima_compra.localeCompare(b.ultima_compra));
    res.json(lista.slice(0, 30));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar produtos pra recuperar.' });
  }
});

// Curva ABC de produtos somando TODOS os clientes - mostra o negócio inteiro:
// quais produtos concentram a maior parte do faturamento (e do volume). Usa
// pedidos_oficiais_itens (relatório oficial de Faturamento, status='faturado'),
// não pedido_itens: é a única fonte com valor (R$) confiável — pedido_itens vem
// de cotações do app/PDF, cujo preço pode não refletir o valor realmente
// faturado. Aceita ?inicio=AAAA-MM-DD e/ou ?fim=AAAA-MM-DD (por data de
// faturamento) pra restringir a um período; sem nenhum dos dois, soma tudo.
// Devolve os dois campos (quantidade_total e faturamento_total) juntos pra o
// dashboard poder alternar entre eles sem precisar buscar de novo.
router.get('/produtos-abc-geral', async (req, res) => {
  const { inicio, fim } = req.query;
  const params = [];
  let filtroData = '';
  if (inicio) { params.push(inicio); filtroData += ` AND poi.data_faturamento >= $${params.length}::date`; }
  if (fim) { params.push(fim); filtroData += ` AND poi.data_faturamento <= $${params.length}::date`; }
  try {
    const result = await pool.query(
      `SELECT poi.codigo_sku,
              COALESCE(p.nome, MAX(poi.descricao), poi.codigo_sku) AS produto,
              p.categoria,
              COUNT(DISTINCT poi.nr_pedido) AS num_pedidos,
              SUM(poi.quantidade) AS quantidade_total,
              SUM(poi.valor) AS faturamento_total
       FROM pedidos_oficiais_itens poi
       LEFT JOIN produtos p ON p.codigo_sku = poi.codigo_sku
       WHERE ${sqlFaturadoDeFato('poi')}${filtroData}
       GROUP BY poi.codigo_sku, p.nome, p.categoria
       ORDER BY faturamento_total DESC NULLS LAST`,
      params
    );
    const reconciliado = await reconciliarProdutosPorCodigoBase(result.rows, { inicio, fim });
    reconciliado.sort((a, b) => b.faturamento_total - a.faturamento_total);
    res.json(comSubfamilia(await marcarDescontinuados(pool, reconciliado, 'produto')));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao calcular curva ABC geral.' });
  }
});

// Mix inicial (routes/lib/mixInicial.js): os produtos comprados pelo maior
// número de lojas nos últimos 12 meses, por canal. O app guarda a resposta no
// aparelho (vale sem internet) e monta o orçamento com ela. Mesmo resultado pra
// todo mundo: guardado 30 min no servidor (importação nova aparece em até 30 min).
const MIX_DIAS = 365;
const MIX_CACHE_MS = 30 * 60 * 1000;
let mixCache = null; // { em, json }
router.get('/mix-inicial', async (req, res) => {
  try {
    if (mixCache && Date.now() - mixCache.em < MIX_CACHE_MS) return res.json(mixCache.json);
    const [oficial, app, clientes, catalogo, deOutro] = await Promise.all([
      pool.query(
        `/* mix-inicial:oficial */
         SELECT DISTINCT codigo_sku, cliente_codigo_oficial AS codigo
         FROM pedidos_oficiais_itens
         WHERE status = 'faturado' AND cliente_codigo_oficial IS NOT NULL
           AND data_faturamento > ${SQL_HOJE_BR} - $1::int`,
        [MIX_DIAS]),
      pool.query(
        `/* mix-inicial:app */
         SELECT DISTINCT p.codigo_sku, ped.cliente_id
         FROM pedidos ped
         JOIN pedido_itens pi ON pi.pedido_id = ped.id
         JOIN produtos p ON p.id = pi.produto_id
         WHERE ped.cliente_id IS NOT NULL AND ${sqlDiaDoPedido()} > ${SQL_HOJE_BR} - $1::int AND ${SQL_PEDIDO_APP_VALIDO}`,
        [MIX_DIAS]),
      pool.query('/* mix-inicial:clientes */ SELECT id, codigo_oficial, classificatorio_tipo FROM clientes'),
      pool.query('SELECT codigo_sku, nome FROM catalogo_precos'),
      clientesDeOutroVendedor(),
    ]);
    // conta da própria representação (amostras) não é loja
    const representacao = new Set([...deOutro].filter(([, base]) => base === REPRESENTACAO).map(([id]) => id));
    const porCodigo = new Map();
    const porId = new Map();
    for (const c of clientes.rows) {
      if (representacao.has(String(c.id))) continue;
      const loja = { loja: c.codigo_oficial ? `erp:${c.codigo_oficial}` : `app:${c.id}`, canal: canalDaLoja(c.classificatorio_tipo) };
      porId.set(String(c.id), loja);
      if (c.codigo_oficial && !porCodigo.has(String(c.codigo_oficial))) porCodigo.set(String(c.codigo_oficial), loja);
    }
    const compras = [];
    for (const l of oficial.rows) {
      const loja = porCodigo.get(String(l.codigo));
      if (loja) compras.push({ ...loja, codigo_sku: l.codigo_sku });
    }
    for (const l of app.rows) {
      const loja = porId.get(String(l.cliente_id));
      if (loja) compras.push({ ...loja, codigo_sku: l.codigo_sku });
    }
    // Lista de Preços ainda não importada (banco novo): vale o cadastro de produtos,
    // como em descontinuado.js (catálogo vazio não tira nada)
    const produtos = catalogo.rows.length ? catalogo.rows : (await nomesDosProdutos()).rows;
    const json = { geradoEm: new Date().toISOString(), dias: MIX_DIAS, ...rankingMixInicial(compras, produtos) };
    mixCache = { em: Date.now(), json };
    res.json(json);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao montar o mix inicial.' });
  }
});
// Teste: cada cenário semeia o banco de novo
router.esquecerMixInicial = () => { mixCache = null; };

// Curva ABC "por cliente" - mesma classificação de Pareto da geral, mas
// escopada a UM cliente: responde "o que esse cliente mais compra e o que
// ele quase não compra", pra saber o que oferecer numa visita ou negociação.
// Mesma fonte (pedidos_oficiais_itens faturado) e mesmos filtros de período
// da curva geral; liga em pedidos_oficiais_itens pelo codigo_oficial do
// cliente (aprendido na primeira importação do relatório oficial - ver
// comentário na coluna, em schema.sql). Cliente que nunca apareceu no
// relatório oficial (sem codigo_oficial ainda) simplesmente não tem
// nenhuma linha pra somar - devolve lista vazia, não erro.
router.get('/clientes/:id/produtos-abc', async (req, res) => {
  const { inicio, fim } = req.query;
  const clienteResult = await pool.query('SELECT codigo_oficial FROM clientes WHERE id = $1', [req.params.id]).catch((e) => { console.error(e); return null; });
  if (!clienteResult) return res.status(500).json({ erro: 'Erro ao calcular curva ABC do cliente.' });
  if (clienteResult.rows.length === 0) return res.status(404).json({ erro: 'Cliente não encontrado.' });
  const codigoOficial = clienteResult.rows[0].codigo_oficial;
  if (!codigoOficial) return res.json([]); // ainda não apareceu em nenhum relatório oficial de faturamento

  const params = [codigoOficial];
  let filtroData = '';
  if (inicio) { params.push(inicio); filtroData += ` AND poi.data_faturamento >= $${params.length}::date`; }
  if (fim) { params.push(fim); filtroData += ` AND poi.data_faturamento <= $${params.length}::date`; }
  try {
    const result = await pool.query(
      `SELECT poi.codigo_sku,
              COALESCE(p.nome, MAX(poi.descricao), poi.codigo_sku) AS produto,
              p.categoria,
              COUNT(DISTINCT poi.nr_pedido) AS num_pedidos,
              SUM(poi.quantidade) AS quantidade_total,
              SUM(poi.valor) AS faturamento_total
       FROM pedidos_oficiais_itens poi
       LEFT JOIN produtos p ON p.codigo_sku = poi.codigo_sku
       WHERE ${sqlFaturadoDeFato('poi')} AND poi.cliente_codigo_oficial = $1${filtroData}
       GROUP BY poi.codigo_sku, p.nome, p.categoria
       ORDER BY faturamento_total DESC NULLS LAST`,
      params
    );
    const reconciliado = await reconciliarProdutosPorCodigoBase(result.rows, { inicio, fim, clienteCodigo: codigoOficial });
    reconciliado.sort((a, b) => b.faturamento_total - a.faturamento_total);
    res.json(comSubfamilia(await marcarDescontinuados(pool, reconciliado, 'produto')));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao calcular curva ABC do cliente.' });
  }
});

// "Entrada de pedidos" do mês, com a mesma regra do painel do sistema oficial
// (Salesforce) - conciliado em 09/2026 contra o gráfico "Qtde. Clientes Mês"
// de lá, que bateu cliente a cliente de jan a ago:
//  - mês pela data de IMPLANTAÇÃO do pedido (quando ele entrou), não pela de
//    faturamento;
//  - carteira + faturado: pedido que entrou e ainda não foi faturado conta;
//  - só a série principal de pedidos (6 dígitos, hoje na casa dos 676000). A
//    série de 7 dígitos (10xxxxx-13xxxxx: itens avulsos de valor baixo, fora
//    do catálogo) não entra no painel oficial.
//
// Sempre devolve os 12 meses, terminando no mês atual - mês sem pedido vem
// com zero. Antes só vinham os meses com pedido, e a tela tomava a última
// linha como "o mês": no dia 1º, sem pedido importado ainda, os cartões do
// Dashboard continuavam mostrando o mês anterior inteiro (out/2026 abria com
// os R$ 480 mil / 98 pedidos de setembro).
//
// "Hoje" pelo relógio de Brasília: o banco roda em UTC, e CURRENT_DATE já
// virava o mês às 21h do último dia (e ainda estava no mês anterior até as
// 3h do dia 1º). Vale também pro faturamento semanal/trimestral e o top
// clientes do Dashboard (janelas de 10 semanas, 24 e 12 meses).
const SQL_HOJE_BRASIL = `(now() AT TIME ZONE 'America/Sao_Paulo')::date`;
const SQL_ENTRADA_PEDIDOS_MENSAL = `
  SELECT m.periodo, COALESCE(e.valor, 0) AS valor, COALESCE(e.pedidos, 0) AS pedidos, COALESCE(e.clientes, 0) AS clientes
  FROM generate_series(date_trunc('month', ${SQL_HOJE_BRASIL}) - INTERVAL '11 months',
                       date_trunc('month', ${SQL_HOJE_BRASIL}), INTERVAL '1 month') AS m(periodo)
  LEFT JOIN (
    SELECT date_trunc('month', data_implantacao) AS periodo, SUM(valor) AS valor,
           COUNT(DISTINCT nr_pedido) AS pedidos, COUNT(DISTINCT cliente_codigo_oficial) AS clientes
    FROM pedidos_oficiais_itens
    WHERE data_implantacao >= date_trunc('month', ${SQL_HOJE_BRASIL}) - INTERVAL '11 months'
      AND length(nr_pedido) <= 6
    GROUP BY 1
  ) e ON e.periodo = m.periodo
  ORDER BY m.periodo`;

// Entrada do mês anterior só até o mesmo dia de hoje (1º a DD do mês passado),
// pra comparar o mês em andamento com um período do mesmo tamanho - comparar
// com o mês anterior inteiro dava "↓ 100%" todo começo de mês. Mês anterior
// mais curto (hoje 31/03) para no último dia dele (28/02): o "- 1 month" do
// Postgres já faz isso.
const SQL_ENTRADA_MES_ANTERIOR_ATE_HOJE = `
  SELECT (h - INTERVAL '1 month')::date AS ate, COALESCE(SUM(poi.valor), 0) AS valor
  FROM (SELECT ${SQL_HOJE_BRASIL} AS h) hoje
  LEFT JOIN pedidos_oficiais_itens poi
    ON poi.data_implantacao >= date_trunc('month', h) - INTERVAL '1 month'
   AND poi.data_implantacao <= (h - INTERVAL '1 month')::date
   AND length(poi.nr_pedido) <= 6
  GROUP BY h`;

// Os pedidos por trás do cartão "Valor Entrada de Pedidos Mês" (mesma regra
// acima, só o mês atual): um por linha, com o nome do cliente, pra lista que
// abre ao tocar no cartão. Cliente ainda não vinculado ao código oficial
// (sem linha em clientes) vem com nome null - a tela mostra o código.
const SQL_ENTRADA_PEDIDOS_DO_MES = `
  SELECT poi.nr_pedido, poi.cliente_codigo_oficial, MAX(c.id) AS cliente_id, MAX(c.nome) AS cliente_nome,
         MIN(poi.data_implantacao) AS data_implantacao, SUM(poi.valor) AS valor
  FROM pedidos_oficiais_itens poi
  LEFT JOIN clientes c ON c.codigo_oficial = poi.cliente_codigo_oficial
  WHERE poi.data_implantacao >= date_trunc('month', ${SQL_HOJE_BRASIL})
    AND length(poi.nr_pedido) <= 6
  GROUP BY poi.nr_pedido, poi.cliente_codigo_oficial
  ORDER BY data_implantacao DESC, valor DESC NULLS LAST`;

// Resumo do Dashboard principal (curva-abc.html, aba "Dashboard"): entrada de
// pedidos mensal (12 meses, regra acima), faturamento semanal (10 semanas) e
// trimestral (8 trimestres), + top 5 clientes por faturamento (12 meses) -
// tudo a partir de pedidos_oficiais_itens (mesma fonte oficial usada na Curva
// ABC), num só round-trip. Sem filtro de
// vendedor: o relatório oficial do ERP não tem essa granularidade (só
// `pedidos`, a tabela antiga de cotação do app, tem vendedor_id). Aberto a
// qualquer usuário logado - é informação de uso diário do vendedor, mesmo
// padrão de acesso de /produtos-abc-geral e dos alertas de classificatório.
router.get('/dashboard/resumo', async (req, res) => {
  try {
    const outrosVendedores = await clientesDeOutroVendedor();
    const [mensal, pedidosDoMes, mesAnteriorAteHoje, semanal, trimestral, topClientes, porCliente, contasSf, entradaAte] = await Promise.all([
      pool.query(SQL_ENTRADA_PEDIDOS_MENSAL),
      pool.query(SQL_ENTRADA_PEDIDOS_DO_MES),
      pool.query(SQL_ENTRADA_MES_ANTERIOR_ATE_HOJE),
      pool.query(
        `SELECT date_trunc('week', data_faturamento) AS periodo, SUM(valor) AS faturamento
         FROM pedidos_oficiais_itens WHERE ${sqlFaturadoDeFato()} AND data_faturamento >= ${SQL_HOJE_BRASIL} - INTERVAL '10 weeks'
         GROUP BY 1 ORDER BY 1`
      ),
      pool.query(
        `SELECT date_trunc('quarter', data_faturamento) AS periodo, SUM(valor) AS faturamento
         FROM pedidos_oficiais_itens WHERE ${sqlFaturadoDeFato()} AND data_faturamento >= ${SQL_HOJE_BRASIL} - INTERVAL '24 months'
         GROUP BY 1 ORDER BY 1`
      ),
      pool.query(
        `SELECT c.id, c.nome, SUM(poi.valor) AS faturamento
         FROM pedidos_oficiais_itens poi JOIN clientes c ON c.codigo_oficial = poi.cliente_codigo_oficial
         WHERE ${sqlFaturadoDeFato('poi')} AND poi.data_faturamento >= ${SQL_HOJE_BRASIL} - INTERVAL '12 months'
         GROUP BY c.id, c.nome ORDER BY faturamento DESC LIMIT 5`
      ),
      // Canal + último pedido de TODOS os clientes (não só os classificados;
      // sem classificatorio_tipo = canal "Varejo"), cada um POR CONTA (sem
      // somar a matriz_grupo): o painel do Salesforce conta conta por conta.
      pool.query(
        `SELECT c.id, c.nome, c.codigo_oficial, c.classificatorio_tipo, base.ultima_compra, base.ultimo_pedido
         FROM clientes c
         JOIN (${SQL_FATURAMENTO_CLASSIFICATORIO_INDIVIDUAL_POR_CLIENTE} GROUP BY c.id) base ON base.cliente_id = c.id`
      ),
      // Foto do relatório "Todas Contas" do Salesforce (routes/contasSalesforce.js).
      pool.query(
        `/* contas-sf:dashboard */ SELECT codigo_oficial, cliente_id, nome, situacao, classificatorio,
           ultima_compra::text AS ultima_compra, data_relatorio::text AS data_relatorio, de_outro_vendedor
         FROM contas_salesforce`
      ),
      pool.query(`/* dashboard:entrada-ate */ SELECT MAX(data_implantacao)::text AS dia FROM pedidos_oficiais_itens WHERE length(nr_pedido) <= 6`),
    ]);

    // Régua do painel do Salesforce (conferida em 22/10/2026: app 300 × SF 290
    // ativos, 57 × 61 e 20 × 24 nas contas sem compra):
    //  - "Clientes Ativos por Canal" = contas com situação "Ativo" no relatório
    //    Todas Contas (comprou em ~6 meses, com exceções que o próprio
    //    Salesforce mantém), inclusive as de outra base - o painel conta todas
    //    as contas que o representante enxerga. Quem pediu depois da foto
    //    também é ativo. Conta fora do relatório (ou sem relatório importado):
    //    pedido nos últimos 6 meses. Antes era 12 meses.
    //  - "Meses sem compra" pelo último pedido da conta (implantação no ERP,
    //    nota ou app - o "Última compra" do Salesforce é a implantação) ou o do
    //    Salesforce, o mais novo (comprou com outro vendedor). Ativas de outra
    //    base e a conta da representação ficam fora das listas: não são de
    //    quem vende (decisão de 10/2026) - por isso pode faltar 1 ou 2 em
    //    relação ao painel.
    const hojeBr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
    const ativoAte = mesesAntes(hojeBr, 6);
    const faixas = [
      { lista: [], de: mesesAntes(hojeBr, FAIXA_3_A_5_MESES[1]), ate: mesesAntes(hojeBr, FAIXA_3_A_5_MESES[0]) },
      { lista: [], de: mesesAntes(hojeBr, FAIXA_6_A_8_MESES[1]), ate: mesesAntes(hojeBr, FAIXA_6_A_8_MESES[0]) },
    ];
    const contas = new Map(); // chave: id do cliente, ou "sf:<código>" pra conta que não está no app
    const idPorCodigo = new Map();
    for (const row of porCliente.rows) {
      if (row.codigo_oficial) idPorCodigo.set(String(row.codigo_oficial), String(row.id));
      contas.set(String(row.id), {
        id: row.id, nome: row.nome, classificatorio: row.classificatorio_tipo,
        ultimo: diaDoBanco(row.ultimo_pedido) || diaDoBanco(row.ultima_compra), sf: null,
      });
    }
    for (const sf of contasSf.rows) {
      // sem cliente_id (ativa de outra base gravada antes de o cliente existir no
      // app): liga pelo código, senão a conta contava duas vezes
      const chave = sf.cliente_id != null ? String(sf.cliente_id) : (idPorCodigo.get(String(sf.codigo_oficial)) || `sf:${sf.codigo_oficial}`);
      const conta = contas.get(chave) || { id: null, nome: sf.nome, classificatorio: sf.classificatorio, ultimo: null };
      conta.sf = sf;
      contas.set(chave, conta);
    }
    const ativosPorCanal = { Varejo: 0, Atacado: 0, Rede: 0 };
    let ativosDeOutrasBases = 0;
    for (const [chave, conta] of contas) {
      const sf = conta.sf;
      const doApp = conta.ultimo;
      const ultimo = [doApp, sf && diaDoBanco(sf.ultima_compra)].filter(Boolean).sort().pop() || null;
      const ativo = sf
        ? (sf.situacao === 'Ativo' || (!!doApp && doApp > sf.data_relatorio))
        : (!!ultimo && ultimo >= ativoAte);
      const base = outrosVendedores.get(chave);
      const deOutraBase = !!base || !!(sf && sf.de_outro_vendedor);
      if (ativo) {
        const canal = canalDoCliente(conta.classificatorio);
        ativosPorCanal[canal] = (ativosPorCanal[canal] || 0) + 1;
        if (deOutraBase && base !== REPRESENTACAO) ativosDeOutrasBases++;
      }
      // ativa com outro vendedor / representação, ou conta fora do app: não entra nas listas
      if (deOutraBase || conta.id == null || !ultimo) continue;
      const faixa = faixas.find(f => ultimo >= f.de && ultimo <= f.ate);
      if (!faixa) continue;
      const diasSemComprar = Math.round((Date.parse(`${hojeBr}T00:00:00Z`) - Date.parse(`${ultimo}T00:00:00Z`)) / 86400000);
      faixa.lista.push({ id: conta.id, nome: conta.nome, diasSemComprar });
    }
    const [clientesDe3a5Meses, clientesDe6a8Meses] = faixas.map(f => f.lista);
    // Mais tempo sem comprar primeiro - é quem mais precisa de atenção.
    clientesDe3a5Meses.sort((a, b) => b.diasSemComprar - a.diasSemComprar);
    clientesDe6a8Meses.sort((a, b) => b.diasSemComprar - a.diasSemComprar);
    const totalAtivos = ativosPorCanal.Varejo + ativosPorCanal.Atacado + ativosPorCanal.Rede;

    res.json({
      mensal: mensal.rows,
      entradaPedidosMes: pedidosDoMes.rows,
      entradaMesAnteriorAteHoje: mesAnteriorAteHoje.rows[0] || null,
      semanal: semanal.rows,
      trimestral: trimestral.rows,
      topClientes: topClientes.rows,
      clientesAtivosPorCanal: { total: totalAtivos, porCanal: ativosPorCanal, deOutrasBases: ativosDeOutrasBases },
      // último dia de implantação importado: o painel do Salesforce é ao vivo, o
      // relatório do ERP chega de madrugada sem os pedidos da véspera
      entradaAte: (entradaAte.rows[0] && entradaAte.rows[0].dia) || null,
      contasSemComprar: {
        de3a5Meses: clientesDe3a5Meses.length,
        de6a8Meses: clientesDe6a8Meses.length,
        clientesDe3a5Meses,
        clientesDe6a8Meses,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao montar o resumo do dashboard.' });
  }
});

module.exports = router;
