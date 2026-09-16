const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { SQL_FATURAMENTO_12M_POR_CLIENTE } = require('./clientesClassificatorio');

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

// Faixas de dias sem comprar usadas nos cartões "Contas - X a Y Meses Sem
// Compra" do Dashboard - meses tratados como blocos de 30 dias, com o limite
// superior de cada faixa excluindo o dia em que o próximo bloco começa (ex:
// "até 5 meses" para antes do dia 180, quando começam os 6 meses). Limiar
// diferente do DIAS_SEM_COMPRAR_ALERTA=60 já usado no alerta de
// classificatório (routes/clientesClassificatorio.js) - documentado aqui
// pra não os dois divergirem em silêncio se um dia precisar mudar.
const FAIXA_3_A_5_MESES = [90, 179];
const FAIXA_6_A_8_MESES = [180, 269];

// Todos os produtos que esse cliente já comprou alguma vez, com primeira/última
// compra e total acumulado - a pergunta original do projeto.
router.get('/clientes/:id/historico', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         p.codigo_sku,
         p.nome AS produto,
         MIN(ped.data_pedido) AS primeira_compra,
         MAX(ped.data_pedido) AS ultima_compra,
         COUNT(DISTINCT ped.id) AS num_pedidos,
         SUM(pi.quantidade) AS total_acumulado
       FROM pedidos ped
       JOIN pedido_itens pi ON ped.id = pi.pedido_id
       JOIN produtos p ON pi.produto_id = p.id
       WHERE ped.cliente_id = $1
       GROUP BY p.id, p.codigo_sku, p.nome
       ORDER BY ultima_compra DESC`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao gerar histórico.' });
  }
});

// Rotatividade: além do histórico, calcula o intervalo médio entre pedidos -
// isso responde "de quanto em quanto tempo esse cliente costuma repor esse item".
router.get('/clientes/:id/rotatividade', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT
         p.codigo_sku,
         p.nome AS produto,
         COUNT(DISTINCT ped.id) AS num_pedidos,
         SUM(pi.quantidade) AS total_comprado,
         MIN(ped.data_pedido) AS primeira_compra,
         MAX(ped.data_pedido) AS ultima_compra,
         CASE WHEN COUNT(DISTINCT ped.id) > 1
           THEN ROUND(EXTRACT(EPOCH FROM (MAX(ped.data_pedido) - MIN(ped.data_pedido))) / 86400.0 / (COUNT(DISTINCT ped.id) - 1))
           ELSE NULL
         END AS media_dias_entre_pedidos
       FROM pedidos ped
       JOIN pedido_itens pi ON ped.id = pi.pedido_id
       JOIN produtos p ON pi.produto_id = p.id
       WHERE ped.cliente_id = $1
       GROUP BY p.id, p.codigo_sku, p.nome
       ORDER BY media_dias_entre_pedidos ASC NULLS LAST`,
      [req.params.id]
    );
    res.json(result.rows);
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
      `SELECT l.data_visita, li.quantidade_contada
       FROM levantamento_itens li
       JOIN levantamentos l ON li.levantamento_id = l.id
       WHERE l.cliente_id = $1 AND li.produto_id = $2
       ORDER BY l.data_visita ASC`,
      [id, produtoId]
    );
    const leituras = leiturasResult.rows;
    const consumos = [];
    for (let i = 1; i < leituras.length; i++) {
      const inicio = leituras[i-1].data_visita;
      const fim = leituras[i].data_visita;
      const pedidoResult = await pool.query(
        `SELECT COALESCE(SUM(pi.quantidade), 0) AS pedido_no_periodo
         FROM pedidos ped
         JOIN pedido_itens pi ON ped.id = pi.pedido_id
         WHERE ped.cliente_id = $1 AND pi.produto_id = $2
           AND ped.data_pedido > $3 AND ped.data_pedido <= $4`,
        [id, produtoId, inicio, fim]
      );
      const pedidoNoPeriodo = Number(pedidoResult.rows[0].pedido_no_periodo);
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

    const compradores = await pool.query(
      `SELECT c.id, c.nome, c.documento, SUM(pi.quantidade) AS total_comprado,
              po.data_faturamento AS ultima_compra, po.nota_fiscal
       FROM pedido_itens pi
       JOIN pedidos ped ON ped.id = pi.pedido_id
       JOIN clientes c ON c.id = ped.cliente_id
       LEFT JOIN (
         SELECT DISTINCT ON (cliente_codigo_oficial) cliente_codigo_oficial, data_faturamento, nota_fiscal
         FROM pedidos_oficiais_itens
         WHERE codigo_sku = $2 AND status = 'faturado'
         ORDER BY cliente_codigo_oficial, data_faturamento DESC NULLS LAST
       ) po ON po.cliente_codigo_oficial = c.codigo_oficial
       WHERE pi.produto_id = $1
       GROUP BY c.id, c.nome, c.documento, po.data_faturamento, po.nota_fiscal
       ORDER BY po.data_faturamento DESC NULLS LAST`,
      [produtoId, codigo]
    );

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
      compradores: compradores.rows,
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
      `SELECT
         ped.data_pedido, c.nome AS cliente_nome, c.documento AS cliente_documento,
         v.nome AS vendedor_nome, p.codigo_sku, p.nome AS produto_nome,
         pi.quantidade, pi.preco_unitario, ped.origem, ped.numero_cotacao
       FROM pedidos ped
       JOIN pedido_itens pi ON pi.pedido_id = ped.id
       JOIN clientes c ON c.id = ped.cliente_id
       JOIN produtos p ON p.id = pi.produto_id
       LEFT JOIN vendedores v ON v.id = ped.vendedor_id
       WHERE ped.data_pedido >= $1 AND ped.data_pedido < ($2::date + interval '1 day')
       ORDER BY ped.data_pedido DESC`,
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
router.get('/clientes/:id/recuperar', async (req, res) => {
  try {
    const result = await pool.query(
      `WITH historico AS (
         SELECT p.id AS produto_id, p.codigo_sku, p.nome,
                MAX(ped.data_pedido) AS ultima_compra,
                SUM(pi.quantidade) AS total_comprado
         FROM pedidos ped
         JOIN pedido_itens pi ON pi.pedido_id = ped.id
         JOIN produtos p ON p.id = pi.produto_id
         WHERE ped.cliente_id = $1
         GROUP BY p.id, p.codigo_sku, p.nome
       ),
       ultimo_levantamento AS (
         SELECT DISTINCT ON (li.produto_id) li.produto_id, li.quantidade_contada, l.data_visita
         FROM levantamento_itens li
         JOIN levantamentos l ON l.id = li.levantamento_id
         WHERE l.cliente_id = $1
         ORDER BY li.produto_id, l.data_visita DESC
       )
       SELECT h.codigo_sku, h.nome AS produto, h.ultima_compra, h.total_comprado,
              COALESCE(ul.quantidade_contada, 0) AS estoque_atual, ul.data_visita AS ultimo_levantamento
       FROM historico h
       LEFT JOIN ultimo_levantamento ul ON ul.produto_id = h.produto_id
       WHERE COALESCE(ul.quantidade_contada, 0) = 0
       ORDER BY h.ultima_compra ASC
       LIMIT 30`,
      [req.params.id]
    );
    res.json(result.rows);
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
              COALESCE(p.nome, poi.codigo_sku) AS produto,
              p.categoria,
              COUNT(DISTINCT poi.nr_pedido) AS num_pedidos,
              SUM(poi.quantidade) AS quantidade_total,
              SUM(poi.valor) AS faturamento_total
       FROM pedidos_oficiais_itens poi
       LEFT JOIN produtos p ON p.codigo_sku = poi.codigo_sku
       WHERE poi.status = 'faturado'${filtroData}
       GROUP BY poi.codigo_sku, p.nome, p.categoria
       ORDER BY faturamento_total DESC NULLS LAST`,
      params
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao calcular curva ABC geral.' });
  }
});

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
              COALESCE(p.nome, poi.codigo_sku) AS produto,
              p.categoria,
              COUNT(DISTINCT poi.nr_pedido) AS num_pedidos,
              SUM(poi.quantidade) AS quantidade_total,
              SUM(poi.valor) AS faturamento_total
       FROM pedidos_oficiais_itens poi
       LEFT JOIN produtos p ON p.codigo_sku = poi.codigo_sku
       WHERE poi.status = 'faturado' AND poi.cliente_codigo_oficial = $1${filtroData}
       GROUP BY poi.codigo_sku, p.nome, p.categoria
       ORDER BY faturamento_total DESC NULLS LAST`,
      params
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao calcular curva ABC do cliente.' });
  }
});

// Resumo do Dashboard principal (curva-abc.html, aba "Dashboard"): faturamento
// mensal (12 meses), semanal (10 semanas) e trimestral (8 trimestres), + top 5
// clientes por faturamento (12 meses) - tudo a partir de pedidos_oficiais_itens
// (mesma fonte oficial usada na Curva ABC), num só round-trip. Sem filtro de
// vendedor: o relatório oficial do ERP não tem essa granularidade (só
// `pedidos`, a tabela antiga de cotação do app, tem vendedor_id). Aberto a
// qualquer usuário logado - é informação de uso diário do vendedor, mesmo
// padrão de acesso de /produtos-abc-geral e dos alertas de classificatório.
router.get('/dashboard/resumo', async (req, res) => {
  try {
    const [mensal, semanal, trimestral, topClientes, porCliente] = await Promise.all([
      pool.query(
        `SELECT date_trunc('month', data_faturamento) AS periodo, SUM(valor) AS faturamento, COUNT(DISTINCT nr_pedido) AS pedidos, COUNT(DISTINCT cliente_codigo_oficial) AS clientes
         FROM pedidos_oficiais_itens WHERE status = 'faturado' AND data_faturamento >= CURRENT_DATE - INTERVAL '12 months'
         GROUP BY 1 ORDER BY 1`
      ),
      pool.query(
        `SELECT date_trunc('week', data_faturamento) AS periodo, SUM(valor) AS faturamento
         FROM pedidos_oficiais_itens WHERE status = 'faturado' AND data_faturamento >= CURRENT_DATE - INTERVAL '10 weeks'
         GROUP BY 1 ORDER BY 1`
      ),
      pool.query(
        `SELECT date_trunc('quarter', data_faturamento) AS periodo, SUM(valor) AS faturamento
         FROM pedidos_oficiais_itens WHERE status = 'faturado' AND data_faturamento >= CURRENT_DATE - INTERVAL '24 months'
         GROUP BY 1 ORDER BY 1`
      ),
      pool.query(
        `SELECT c.id, c.nome, SUM(poi.valor) AS faturamento
         FROM pedidos_oficiais_itens poi JOIN clientes c ON c.codigo_oficial = poi.cliente_codigo_oficial
         WHERE poi.status = 'faturado' AND poi.data_faturamento >= CURRENT_DATE - INTERVAL '12 months'
         GROUP BY c.id, c.nome ORDER BY faturamento DESC LIMIT 5`
      ),
      // Canal + inatividade (cartões "Clientes Ativos por Canal" e "Contas
      // sem comprar") - precisa de TODOS os clientes, não só os já
      // classificados (sem classificatorio_tipo = canal "Varejo" por
      // padrão), por isso não reaproveita /clientes/classificatorio/alertas
      // (que filtra por classificatorio_tipo IS NOT NULL) e usa a mesma
      // subconsulta de faturamento 12m sem filtro nenhum de cliente.
      pool.query(
        `SELECT c.id, c.classificatorio_tipo, base.ultima_compra
         FROM clientes c
         JOIN (${SQL_FATURAMENTO_12M_POR_CLIENTE} GROUP BY c.id) base ON base.cliente_id = c.id`
      ),
    ]);

    const hoje = new Date();
    let ativosPorCanal = { Varejo: 0, Atacado: 0, Rede: 0 };
    let de3a5Meses = 0, de6a8Meses = 0;
    for (const row of porCliente.rows) {
      const canal = canalDoCliente(row.classificatorio_tipo);
      if (!row.ultima_compra) continue;
      const diasSemComprar = Math.floor((hoje - new Date(row.ultima_compra)) / (1000 * 60 * 60 * 24));
      if (diasSemComprar <= 365) ativosPorCanal[canal] = (ativosPorCanal[canal] || 0) + 1;
      if (diasSemComprar >= FAIXA_3_A_5_MESES[0] && diasSemComprar <= FAIXA_3_A_5_MESES[1]) de3a5Meses++;
      else if (diasSemComprar >= FAIXA_6_A_8_MESES[0] && diasSemComprar <= FAIXA_6_A_8_MESES[1]) de6a8Meses++;
    }
    const totalAtivos = ativosPorCanal.Varejo + ativosPorCanal.Atacado + ativosPorCanal.Rede;

    res.json({
      mensal: mensal.rows,
      semanal: semanal.rows,
      trimestral: trimestral.rows,
      topClientes: topClientes.rows,
      clientesAtivosPorCanal: { total: totalAtivos, porCanal: ativosPorCanal },
      contasSemComprar: { de3a5Meses, de6a8Meses },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao montar o resumo do dashboard.' });
  }
});

module.exports = router;
