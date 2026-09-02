const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Devolve todos os códigos de uma vez, {codigo: {ean, dun14}} - qualquer
// usuário logado pode ler (usado pra buscar/escanear produto).
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT codigo_sku, ean13, dun14 FROM codigos_produto');
    const mapa = {};
    for (const row of result.rows) {
      mapa[row.codigo_sku] = { ean: row.ean13 || '', dun14: row.dun14 || '' };
    }
    res.json({ valor: mapa });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar códigos.' });
  }
});

// Importa só o lote enviado - upsert em lote com UNNEST, mesmo padrão das
// fichas técnicas (evita reenviar tudo que já foi importado antes).
router.post('/importar', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode importar códigos.' });
  const { codigos } = req.body;
  if (!codigos || typeof codigos !== 'object' || Array.isArray(codigos)) {
    return res.status(400).json({ erro: 'Envie { codigos: {codigo: {ean, dun14}} }' });
  }
  const skus = Object.keys(codigos);
  if (skus.length === 0) return res.status(400).json({ erro: 'Nenhum código no arquivo.' });

  try {
    await pool.query(
      `INSERT INTO codigos_produto (codigo_sku, ean13, dun14)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[])
       ON CONFLICT (codigo_sku) DO UPDATE SET
         ean13 = EXCLUDED.ean13, dun14 = EXCLUDED.dun14, atualizado_em = now()`,
      [
        skus,
        skus.map(c => codigos[c].ean || ''),
        skus.map(c => codigos[c].dun14 || ''),
      ]
    );
    const totalResult = await pool.query('SELECT COUNT(*) FROM codigos_produto');
    console.log(`Códigos produto: ${skus.length} importado(s) por ${req.usuario?.email}. Total agora: ${totalResult.rows[0].count}.`);
    res.json({ ok: true, importados: skus.length, total: Number(totalResult.rows[0].count) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao importar códigos: ' + e.message });
  }
});

module.exports = router;
