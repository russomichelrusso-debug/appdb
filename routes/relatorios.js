const express = require('express');
const router = express.Router();
const { pool } = require('../db');

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

module.exports = router;
