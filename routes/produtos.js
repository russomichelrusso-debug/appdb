const express = require('express');
const router = express.Router();
const { pool, registrarImportacao } = require('../db');

const CODIGO_SKU_REGEX = /^[A-Za-z0-9._-]{1,30}$/;

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
  const codigosInvalidos = produtos.filter(p => !CODIGO_SKU_REGEX.test(String(p.codigo_sku))).map(p => p.codigo_sku);
  if (codigosInvalidos.length > 0) {
    return res.status(400).json({
      erro: 'Códigos de produto em formato inválido: ' + codigosInvalidos.slice(0, 10).join(', '),
    });
  }
  try {
    // Dedup em memória por codigo_sku (mantendo a última ocorrência) - o
    // UNNEST + ON CONFLICT DO UPDATE abaixo falha com "cannot affect row a
    // second time" se a mesma chave aparecer duas vezes no mesmo lote.
    const porCodigo = new Map();
    for (const p of produtos) porCodigo.set(String(p.codigo_sku), p);
    const unicos = Array.from(porCodigo.values());

    const codigos = unicos.map(p => String(p.codigo_sku));
    const nomes = unicos.map(p => p.nome || '');
    const categorias = unicos.map(p => p.categoria || null);

    // RETURNING (xmax = 0) diz se a linha foi INSERIDA (xmax = 0) ou
    // ATUALIZADA (xmax setado pelo UPDATE do conflito) - diferente de
    // comparar COUNT(*) antes/depois, isso não é afetado por uma
    // importação simultânea mexendo na tabela ao mesmo tempo.
    const upsert = await pool.query(
      `WITH entrada AS (
         SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[]) AS t(codigo_sku, nome, categoria)
       ),
       resultado AS (
         INSERT INTO produtos (codigo_sku, nome, categoria)
         SELECT codigo_sku, nome, categoria FROM entrada
         ON CONFLICT (codigo_sku) DO UPDATE SET nome = EXCLUDED.nome, categoria = EXCLUDED.categoria
         RETURNING (xmax = 0) AS inserted
       )
       SELECT
         COUNT(*) FILTER (WHERE inserted) AS criados,
         COUNT(*) FILTER (WHERE NOT inserted) AS atualizados
       FROM resultado`,
      [codigos, nomes, categorias]
    );
    const { criados, atualizados } = upsert.rows[0];
    const totalResult = await pool.query('SELECT COUNT(*) FROM produtos');

    await registrarImportacao(req.usuario?.id, 'produtos/sync', unicos.length);
    res.json({ criados: Number(criados), atualizados: Number(atualizados), total: Number(totalResult.rows[0].count) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao sincronizar catálogo.' });
  }
});

module.exports = router;
