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

module.exports = router;
