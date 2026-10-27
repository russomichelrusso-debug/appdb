const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { lerComCache, esquecerTabela } = require('./lib/cacheTabela');
const { limparArquivoDoSite } = require('./lib/fichasSite');

// Devolve todas as fichas de uma vez, no mesmo formato {codigo: {...}} que o
// app já usa - qualquer usuário logado pode ler (o balão (i) é pra todo mundo).
router.get('/', async (req, res) => {
  try {
    // do cache enquanto a tabela não mudar (routes/lib/cacheTabela.js: egress do Supabase)
    const rows = await lerComCache('fichas_tecnicas', 'fichas_tecnicas', 'SELECT codigo_sku, nome, descricao, foto, specs FROM fichas_tecnicas');
    const mapa = {};
    for (const row of rows) {
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
    esquecerTabela('fichas_tecnicas');
    const totalResult = await pool.query('SELECT COUNT(*) FROM fichas_tecnicas');
    console.log(`Fichas técnicas: ${codigos.length} importada(s) por ${req.usuario?.email}. Total agora: ${totalResult.rows[0].count}.`);
    res.json({ ok: true, importadas: codigos.length, total: Number(totalResult.rows[0].count) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao importar fichas técnicas.' });
  }
});

// Conteúdo do site oficial (tabela fichas_site, routes/lib/fichasSite.js): uma
// entrada por página; o app monta o "por SKU" do lado dele. Todo usuário lê.
router.get('/site', async (req, res) => {
  try {
    const rows = await lerComCache('fichas_site', 'fichas_site',
      `/* FICHAS_SITE:LISTA */ SELECT url, titulo, categoria, texto, beneficios, indicado, acompanha, foto, skus, lido_em::text AS lido_em FROM fichas_site`);
    res.json({ paginas: rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar o conteúdo do site.' });
  }
});

// Arquivo do scripts/raspar-site-cortag.js: troca a foto inteira (página que saiu
// do site sai daqui). Não mexe em fichas_tecnicas.
router.post('/site', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode importar o conteúdo do site.' });
  const { paginas, recusadas, erro } = limparArquivoDoSite(req.body);
  if (erro) return res.status(422).json({ erro });
  if (!paginas.length) return res.status(422).json({ erro: 'Nenhuma página válida no arquivo (endereço do cortag.com e SKU na página).' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('/* FICHAS_SITE:APAGAR */ DELETE FROM fichas_site');
    await client.query(
      `/* FICHAS_SITE:GRAVAR */ INSERT INTO fichas_site (url, titulo, categoria, texto, beneficios, indicado, acompanha, foto, skus, lido_em)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::jsonb[], $6::text[], $7::text[], $8::text[], $9::jsonb[], $10::date[])`,
      [
        paginas.map(p => p.url), paginas.map(p => p.titulo), paginas.map(p => p.categoria), paginas.map(p => p.texto),
        paginas.map(p => JSON.stringify(p.beneficios)), paginas.map(p => p.indicado), paginas.map(p => p.acompanha),
        paginas.map(p => p.foto), paginas.map(p => JSON.stringify(p.skus)), paginas.map(p => p.lidoEm),
      ]
    );
    await client.query('COMMIT');
    esquecerTabela('fichas_site');
    const skus = paginas.reduce((n, p) => n + Object.keys(p.skus).length, 0);
    console.log(`Conteúdo do site: ${paginas.length} página(s), ${skus} SKU(s), importado por ${req.usuario?.email}.`);
    res.json({ ok: true, paginas: paginas.length, skus, recusadas });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(e);
    res.status(500).json({ erro: 'Erro ao importar o conteúdo do site.' });
  } finally {
    client.release();
  }
});

module.exports = router;
