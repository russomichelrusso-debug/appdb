const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { acharClientePorNome } = require('../clientMatcher');

// Devolve as linhas de pedido oficiais de um cliente específico (pelo id
// interno do app) - só funciona se esse cliente já tiver codigo_oficial
// aprendido (de uma importação anterior que casou o nome corretamente).
router.get('/:clienteId', async (req, res) => {
  try {
    const cliente = await pool.query('SELECT codigo_oficial FROM clientes WHERE id = $1', [req.params.clienteId]);
    if (cliente.rows.length === 0) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    const codigoOficial = cliente.rows[0].codigo_oficial;
    if (!codigoOficial) return res.json({ vinculado: false, itens: [] });

    const result = await pool.query(
      `SELECT poi.nr_pedido, poi.codigo_sku, pr.nome AS produto, poi.quantidade, poi.valor,
              poi.data_implantacao, poi.data_faturamento, poi.status
       FROM pedidos_oficiais_itens poi
       LEFT JOIN produtos pr ON pr.codigo_sku = poi.codigo_sku
       WHERE poi.cliente_codigo_oficial = $1
       ORDER BY poi.data_implantacao DESC NULLS LAST`,
      [codigoOficial]
    );
    res.json({ vinculado: true, itens: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar pedidos oficiais.' });
  }
});

// Importa em lote as abas "Carteira" e/ou "Faturamento" do relatório oficial.
// Pode rodar quantas vezes quiser: o mesmo Nr.Pedido+código não duplica, só
// atualiza - e uma vez "faturado", nunca volta pra "carteira" mesmo que uma
// planilha antiga de carteira seja reimportada por engano depois.
router.post('/importar', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode importar pedidos oficiais.' });
  const { itens } = req.body;
  if (!Array.isArray(itens) || itens.length === 0) return res.status(400).json({ erro: 'Envie { itens: [...] }' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Aprende o codigo_oficial de clientes que ainda não têm, casando por
    // nome - só na primeira vez que aquele código aparece. Depois disso, o
    // vínculo já fica salvo e não precisa casar nome de novo.
    const paresUnicos = new Map();
    for (const it of itens) {
      if (it.cliente_codigo_oficial && it.cliente_nome && !paresUnicos.has(it.cliente_codigo_oficial)) {
        paresUnicos.set(it.cliente_codigo_oficial, it.cliente_nome);
      }
    }
    let clientesVinculados = 0, clientesNaoEncontrados = [];
    for (const [codigo, nome] of paresUnicos) {
      const jaVinculado = await client.query('SELECT id FROM clientes WHERE codigo_oficial = $1', [codigo]);
      if (jaVinculado.rows.length > 0) continue;
      const clienteId = await acharClientePorNome(client, nome);
      if (clienteId) {
        await client.query('UPDATE clientes SET codigo_oficial = $1 WHERE id = $2', [codigo, clienteId]);
        clientesVinculados++;
      } else {
        clientesNaoEncontrados.push({ codigo, nome });
      }
    }

    const nrPedidos = itens.map(it => String(it.nr_pedido));
    const codigosSku = itens.map(it => String(it.codigo_sku));
    const clientesCodigos = itens.map(it => String(it.cliente_codigo_oficial));
    const quantidades = itens.map(it => Number(it.quantidade) || 0);
    const valores = itens.map(it => it.valor != null ? Number(it.valor) : null);
    const dataImplant = itens.map(it => it.data_implantacao || null);
    const dataFat = itens.map(it => it.data_faturamento || null);
    const status = itens.map(it => it.status === 'faturado' ? 'faturado' : 'carteira');

    await client.query(
      `INSERT INTO pedidos_oficiais_itens
         (nr_pedido, codigo_sku, cliente_codigo_oficial, quantidade, valor, data_implantacao, data_faturamento, status)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::numeric[], $5::numeric[], $6::date[], $7::date[], $8::text[])
       ON CONFLICT (nr_pedido, codigo_sku) DO UPDATE SET
         quantidade = CASE WHEN EXCLUDED.status = 'faturado' OR pedidos_oficiais_itens.status != 'faturado'
                           THEN EXCLUDED.quantidade ELSE pedidos_oficiais_itens.quantidade END,
         valor = CASE WHEN EXCLUDED.status = 'faturado' OR pedidos_oficiais_itens.status != 'faturado'
                      THEN EXCLUDED.valor ELSE pedidos_oficiais_itens.valor END,
         data_implantacao = COALESCE(pedidos_oficiais_itens.data_implantacao, EXCLUDED.data_implantacao),
         data_faturamento = CASE WHEN EXCLUDED.status = 'faturado' THEN EXCLUDED.data_faturamento
                                  ELSE pedidos_oficiais_itens.data_faturamento END,
         status = CASE WHEN EXCLUDED.status = 'faturado' OR pedidos_oficiais_itens.status = 'faturado'
                       THEN 'faturado' ELSE EXCLUDED.status END,
         atualizado_em = now()`,
      [nrPedidos, codigosSku, clientesCodigos, quantidades, valores, dataImplant, dataFat, status]
    );

    await client.query('COMMIT');
    console.log(`Pedidos oficiais: ${itens.length} linha(s) importada(s), ${clientesVinculados} cliente(s) vinculado(s) agora, ${clientesNaoEncontrados.length} não encontrado(s) - por ${req.usuario.usuario}.`);
    res.json({ ok: true, itens: itens.length, clientesVinculados, clientesNaoEncontrados });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ erro: 'Erro ao importar pedidos oficiais: ' + e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
