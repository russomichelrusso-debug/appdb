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
//
// Importante: isso roda numa ÚNICA operação (UNNEST + INSERT ... ON CONFLICT),
// não um loop item a item - com ~1.700 produtos, fazer uma ida-e-volta ao banco
// por produto é lento o bastante pra estourar o tempo limite de execução do
// Supabase (erro 57014/query_canceled). Em lote, é uma soma só, quase instantâneo.
router.post('/sync', async (req, res) => {
  const produtos = req.body.produtos;
  if (!Array.isArray(produtos)) return res.status(400).json({ erro: 'Envie { produtos: [...] }' });

  const validos = produtos.filter(p => p.codigo_sku && p.nome);
  if (validos.length === 0) return res.json({ criados: 0, atualizados: 0, total: produtos.length });

  const codigos = validos.map(p => String(p.codigo_sku));
  const nomes = validos.map(p => p.nome);
  const categorias = validos.map(p => p.categoria || null);

  try {
    const result = await pool.query(
      `WITH entrada AS (
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[]) AS t(codigo_sku, nome, categoria)
       ),
       upsert AS (
         INSERT INTO produtos (codigo_sku, nome, categoria)
         SELECT codigo_sku, nome, categoria FROM entrada
         ON CONFLICT (codigo_sku) DO UPDATE SET nome = EXCLUDED.nome, categoria = EXCLUDED.categoria
         RETURNING (xmax = 0) AS inserted
       )
       SELECT
         COUNT(*) FILTER (WHERE inserted) AS criados,
         COUNT(*) FILTER (WHERE NOT inserted) AS atualizados
       FROM upsert`,
      [codigos, nomes, categorias]
    );
    const { criados, atualizados } = result.rows[0];
    res.json({ criados: Number(criados), atualizados: Number(atualizados), total: produtos.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao sincronizar produtos.' });
  }
});

module.exports = router;
