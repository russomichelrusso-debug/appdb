const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Só a contagem, sem trazer produto nenhum - usado na checagem automática ao
// abrir o app, pra decidir rapidinho se vale a pena sincronizar de novo.
router.get('/contagem', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM produtos');
    res.json({ total: Number(result.rows[0].count) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao contar produtos.' });
  }
});

router.get('/', async (req, res) => {
  const busca = (req.query.busca || '').trim();
  try {
    const result = busca
      ? await pool.query(
          `SELECT id, codigo_sku, nome, categoria FROM produtos
           WHERE nome ILIKE $1 OR codigo_sku ILIKE $1
           ORDER BY nome LIMIT 30`,
          [`%${busca}%`]
        )
      : await pool.query('SELECT id, codigo_sku, nome, categoria FROM produtos ORDER BY nome');
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar produtos.' });
  }
});

// Sincroniza o catálogo inteiro em uma operação em lote (UNNEST) - fazer
// isso item a item com 1700+ produtos já deu timeout antes, por isso o
// cuidado de sempre inserir/atualizar tudo de uma vez só.
router.post('/sync', async (req, res) => {
  const { produtos } = req.body;
  if (!Array.isArray(produtos) || produtos.length === 0) {
    return res.status(400).json({ erro: 'Envie { produtos: [...] }' });
  }
  try {
    const codigos = produtos.map(p => String(p.codigo_sku));
    const nomes = produtos.map(p => p.nome || '');
    const categorias = produtos.map(p => p.categoria || null);

    const antes = await pool.query('SELECT COUNT(*) FROM produtos');
    const totalAntes = Number(antes.rows[0].count);

    await pool.query(
      `INSERT INTO produtos (codigo_sku, nome, categoria)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[])
       ON CONFLICT (codigo_sku) DO UPDATE SET nome = EXCLUDED.nome, categoria = EXCLUDED.categoria`,
      [codigos, nomes, categorias]
    );

    const depois = await pool.query('SELECT COUNT(*) FROM produtos');
    const totalDepois = Number(depois.rows[0].count);

    res.json({ criados: totalDepois - totalAntes, atualizados: produtos.length - (totalDepois - totalAntes), total: totalDepois });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao sincronizar catálogo: ' + e.message });
  }
});

module.exports = router;
