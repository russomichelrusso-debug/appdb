const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Devolve todas as fichas de uma vez, no mesmo formato {codigo: {...}} que o
// app já usa - qualquer usuário logado pode ler (o balão (i) é pra todo mundo).
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT codigo_sku, nome, descricao, foto, specs FROM fichas_tecnicas');
    const mapa = {};
    for (const row of result.rows) {
      mapa[row.codigo_sku] = { nome: row.nome, desc: row.descricao, foto: row.foto, specs: row.specs };
    }
    res.json({ valor: mapa });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar fichas técnicas.' });
  }
});

// Importa só o lote enviado (não o acumulado inteiro) - upsert em lote com
// UNNEST, mesma técnica já usada em produtos/previsão pra evitar timeout e
// evitar reenviar tudo que já foi importado antes.
router.post('/importar', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode importar fichas técnicas.' });
  const { fichas } = req.body;
  if (!fichas || typeof fichas !== 'object' || Array.isArray(fichas)) {
    return res.status(400).json({ erro: 'Envie { fichas: {codigo: {...}} }' });
  }
  const codigos = Object.keys(fichas);
  if (codigos.length === 0) return res.status(400).json({ erro: 'Nenhuma ficha no arquivo.' });

  try {
    await pool.query(
      `INSERT INTO fichas_tecnicas (codigo_sku, nome, descricao, foto, specs)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::jsonb[])
       ON CONFLICT (codigo_sku) DO UPDATE SET
         nome = EXCLUDED.nome, descricao = EXCLUDED.descricao, foto = EXCLUDED.foto,
         specs = EXCLUDED.specs, atualizado_em = now()`,
      [
        codigos,
        codigos.map(c => fichas[c].nome || ''),
        codigos.map(c => fichas[c].desc || ''),
        codigos.map(c => fichas[c].foto || ''),
        codigos.map(c => JSON.stringify(fichas[c].specs || {})),
      ]
    );
    const totalResult = await pool.query('SELECT COUNT(*) FROM fichas_tecnicas');
    console.log(`Fichas técnicas: ${codigos.length} importada(s) por ${req.usuario?.email}. Total agora: ${totalResult.rows[0].count}.`);
    res.json({ ok: true, importadas: codigos.length, total: Number(totalResult.rows[0].count) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao importar fichas técnicas: ' + e.message });
  }
});

module.exports = router;
