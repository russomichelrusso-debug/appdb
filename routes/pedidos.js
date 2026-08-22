const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Acha ou cria o cliente (por documento, se enviado) e o vendedor (por nome).
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

// Finaliza/grava um pedido. Corpo esperado:
// {
//   cliente: { cliente_id? , nome, documento?, contato? },
//   vendedor_nome?: "...",
//   observacao?: "...",
//   itens: [{ codigo_sku, quantidade, preco_unitario }, ...]
// }
router.post('/', async (req, res) => {
  const { cliente, vendedor_nome, observacao, itens } = req.body;
  if (!cliente || !cliente.nome) return res.status(400).json({ erro: 'Informe os dados do cliente (nome).' });
  if (!Array.isArray(itens) || itens.length === 0) return res.status(400).json({ erro: 'Informe ao menos um item.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const clienteId = await acharOuCriarCliente(client, cliente);
    const vendedorId = await acharOuCriarVendedor(client, vendedor_nome);

    const pedidoResult = await client.query(
      'INSERT INTO pedidos (cliente_id, vendedor_id, observacao) VALUES ($1, $2, $3) RETURNING id, data_pedido',
      [clienteId, vendedorId, observacao || null]
    );
    const pedidoId = pedidoResult.rows[0].id;

    for (const item of itens) {
      const produtoId = await acharProdutoPorSku(client, item.codigo_sku);
      await client.query(
        'INSERT INTO pedido_itens (pedido_id, produto_id, quantidade, preco_unitario) VALUES ($1, $2, $3, $4)',
        [pedidoId, produtoId, item.quantidade, item.preco_unitario]
      );
    }

    await client.query('COMMIT');
    res.status(201).json({ pedido_id: pedidoId, cliente_id: clienteId, data_pedido: pedidoResult.rows[0].data_pedido });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(400).json({ erro: e.message || 'Erro ao gravar pedido.' });
  } finally {
    client.release();
  }
});

module.exports = router;
