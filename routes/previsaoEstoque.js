const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Devolve a previsão de todos os produtos - qualquer usuário logado pode
// ver (todo mundo precisa do aviso de estoque na busca, não só o admin).
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM previsao_estoque');
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar previsão de estoque.' });
  }
});

// Substitui a previsão inteira pela planilha nova, em uma operação em lote
// (evita o mesmo problema de timeout que já vimos antes com laço item a
// item). Qualquer usuário logado pode importar (não só admin) - decisão
// explícita, mesmo essa operação substituindo a previsão antiga inteira.
router.post('/importar', async (req, res) => {
  const { itens } = req.body;
  if (!Array.isArray(itens) || itens.length === 0) return res.status(400).json({ erro: 'Envie { itens: [...] }' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM previsao_estoque');
    await client.query(
      `INSERT INTO previsao_estoque (codigo_sku, qt_disponivel, qt_carteira, qt_compra, previsao, saldo)
       SELECT * FROM UNNEST($1::text[], $2::numeric[], $3::numeric[], $4::numeric[], $5::date[], $6::numeric[])`,
      [
        itens.map(i => String(i.codigo_sku)),
        itens.map(i => Number(i.qt_disponivel) || 0),
        itens.map(i => Number(i.qt_carteira) || 0),
        itens.map(i => Number(i.qt_compra) || 0),
        itens.map(i => i.previsao || null),
        itens.map(i => Number(i.saldo) || 0),
      ]
    );
    await client.query('COMMIT');
    console.log(`Previsão de estoque importada: ${itens.length} produto(s), por ${req.usuario?.email}.`);
    res.json({ ok: true, total: itens.length });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ erro: 'Erro ao importar previsão de estoque: ' + e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
