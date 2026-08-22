const express = require('express');
const router = express.Router();
const { pool } = require('../db');

router.get('/', async (req, res) => {
  const busca = (req.query.busca || '').trim();
  try {
    const result = busca
      ? await pool.query(
          `SELECT id, codigo_sku, nome, categoria FROM produtos
           WHERE codigo_sku ILIKE $1 OR nome ILIKE $1
           ORDER BY nome LIMIT 20`,
          [`%${busca}%`]
        )
      : await pool.query('SELECT id, codigo_sku, nome, categoria FROM produtos ORDER BY nome LIMIT 50');
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar produtos.' });
  }
});

// Sincroniza em lote o catálogo de produtos vindo do precos.json do app.
// Chame isso sempre que a lista de preços for atualizada, mandando um array:
// [{ codigo_sku, nome, categoria }, ...]
// Não apaga produtos antigos (mesmo que descontinuados, o histórico de pedidos
// antigos continua precisando deles) - só cria os que ainda não existem e
// atualiza nome/categoria dos que já existem.
router.post('/sync', async (req, res) => {
  const produtos = req.body.produtos;
  if (!Array.isArray(produtos)) return res.status(400).json({ erro: 'Envie { produtos: [...] }' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let criados = 0, atualizados = 0;
    for (const p of produtos) {
      if (!p.codigo_sku || !p.nome) continue;
      const result = await client.query(
        `INSERT INTO produtos (codigo_sku, nome, categoria)
         VALUES ($1, $2, $3)
         ON CONFLICT (codigo_sku) DO UPDATE SET nome = $2, categoria = $3
         RETURNING (xmax = 0) AS inserted`,
        [p.codigo_sku, p.nome, p.categoria || null]
      );
      if (result.rows[0].inserted) criados++; else atualizados++;
    }
    await client.query('COMMIT');
    res.json({ criados, atualizados, total: produtos.length });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ erro: 'Erro ao sincronizar produtos.' });
  } finally {
    client.release();
  }
});

module.exports = router;
