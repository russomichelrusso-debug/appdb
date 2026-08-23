const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Busca clientes por nome ou documento - usado pelo app pra autocompletar
// "qual cliente é esse" ao salvar um levantamento ou pedido.
router.get('/', async (req, res) => {
  const busca = (req.query.busca || '').trim();
  try {
    const result = busca
      ? await pool.query(
          `SELECT id, nome, documento, contato FROM clientes
           WHERE nome ILIKE $1 OR documento ILIKE $1
           ORDER BY nome LIMIT 20`,
          [`%${busca}%`]
        )
      : await pool.query('SELECT id, nome, documento, contato FROM clientes ORDER BY nome LIMIT 50');
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar clientes.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar cliente.' });
  }
});

// Cria um cliente novo, ou devolve o já existente se o documento (CNPJ/CPF)
// já estiver cadastrado - evita duplicar o mesmo cliente em visitas diferentes.
router.post('/', async (req, res) => {
  const { nome, documento, contato } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome é obrigatório.' });
  try {
    if (documento) {
      const existing = await pool.query('SELECT * FROM clientes WHERE documento = $1', [documento]);
      if (existing.rows.length > 0) return res.json(existing.rows[0]);
    }
    const result = await pool.query(
      'INSERT INTO clientes (nome, documento, contato) VALUES ($1, $2, $3) RETURNING *',
      [nome, documento || null, contato || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao criar cliente.' });
  }
});

// Importa clientes em lote (ex: planilha de Razão Social + CNPJ). Mesma
// lógica de "uma operação só" usada no sync de produtos - evita o mesmo
// problema de tempo limite que já vimos lá. Não apaga ninguém, só cria ou
// atualiza o nome de quem já existe (por CNPJ).
router.post('/import', async (req, res) => {
  const clientes = req.body.clientes;
  if (!Array.isArray(clientes)) return res.status(400).json({ erro: 'Envie { clientes: [...] }' });

  const validos = clientes.filter(c => c.nome && c.cnpj);
  if (validos.length === 0) return res.json({ criados: 0, atualizados: 0, total: clientes.length });

  const nomes = validos.map(c => c.nome);
  const documentos = validos.map(c => String(c.cnpj));

  try {
    const result = await pool.query(
      `WITH entrada AS (
         SELECT * FROM UNNEST($1::text[], $2::text[]) AS t(nome, documento)
       ),
       upsert AS (
         INSERT INTO clientes (nome, documento)
         SELECT nome, documento FROM entrada
         ON CONFLICT (documento) DO UPDATE SET nome = EXCLUDED.nome
         RETURNING (xmax = 0) AS inserted
       )
       SELECT
         COUNT(*) FILTER (WHERE inserted) AS criados,
         COUNT(*) FILTER (WHERE NOT inserted) AS atualizados
       FROM upsert`,
      [nomes, documentos]
    );
    const { criados, atualizados } = result.rows[0];
    console.log(`Import de clientes: ${criados} criado(s), ${atualizados} atualizado(s) de ${clientes.length}.`);
    res.json({ criados: Number(criados), atualizados: Number(atualizados), total: clientes.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao importar clientes.' });
  }
});

module.exports = router;
