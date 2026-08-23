const express = require('express');
const router = express.Router();
const { pool } = require('../db');

async function acharOuCriarCliente(client, { cliente_id, nome, documento, contato }) {
  if (cliente_id) return cliente_id;
  if (documento) {
    const existing = await client.query('SELECT id FROM clientes WHERE documento = $1', [documento]);
    if (existing.rows.length > 0) return existing.rows[0].id;
  }
  const result = await client.query(
    'INSERT INTO clientes (nome, documento, contato) VALUES ($1, $2, $3) RETURNING id',
    [nome, documento || null, contato || null]
  );
  return result.rows[0].id;
}
async function acharOuCriarVendedor(client, nomeVendedor) {
  if (!nomeVendedor) return null;
  const existing = await client.query('SELECT id FROM vendedores WHERE nome = $1', [nomeVendedor]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const result = await client.query('INSERT INTO vendedores (nome) VALUES ($1) RETURNING id', [nomeVendedor]);
  return result.rows[0].id;
}
async function acharProdutoPorSku(client, codigo_sku) {
  const result = await client.query('SELECT id FROM produtos WHERE codigo_sku = $1', [codigo_sku]);
  if (result.rows.length === 0) {
    throw new Error(`Produto com código ${codigo_sku} não encontrado - rode /api/produtos/sync primeiro.`);
  }
  return result.rows[0].id;
}

// Grava um levantamento de estoque feito na visita ao cliente. Corpo esperado:
// {
//   cliente: { cliente_id?, nome, documento?, contato? },
//   vendedor_nome?: "...",
//   nome_levantamento?: "...",
//   itens: [{ codigo_sku, quantidade_contada }, ...]
// }
router.post('/', async (req, res) => {
  const { cliente, vendedor_nome, nome_levantamento, itens } = req.body;
  if (!cliente || !cliente.nome) return res.status(400).json({ erro: 'Informe os dados do cliente (nome).' });
  if (!Array.isArray(itens) || itens.length === 0) return res.status(400).json({ erro: 'Informe ao menos um item.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const clienteId = await acharOuCriarCliente(client, cliente);
    const vendedorId = await acharOuCriarVendedor(client, vendedor_nome);

    const levResult = await client.query(
      'INSERT INTO levantamentos (cliente_id, vendedor_id, nome) VALUES ($1, $2, $3) RETURNING id, data_visita',
      [clienteId, vendedorId, nome_levantamento || null]
    );
    const levantamentoId = levResult.rows[0].id;

    for (const item of itens) {
      const produtoId = await acharProdutoPorSku(client, item.codigo_sku);
      await client.query(
        'INSERT INTO levantamento_itens (levantamento_id, produto_id, quantidade_contada) VALUES ($1, $2, $3)',
        [levantamentoId, produtoId, item.quantidade_contada]
      );
    }

    await client.query('COMMIT');
    console.log(`Levantamento #${levantamentoId} gravado (cliente ${clienteId}, ${itens.length} item(ns)).`);
    res.status(201).json({ levantamento_id: levantamentoId, cliente_id: clienteId, data_visita: levResult.rows[0].data_visita });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(400).json({ erro: e.message || 'Erro ao gravar levantamento.' });
  } finally {
    client.release();
  }
});

module.exports = router;
