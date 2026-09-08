const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { acharClientePorNome, acharOuCriarCliente } = require('../clientMatcher');

// Status geral da importação oficial - pro painel admin mostrar de cara
// quando foi o último relatório importado, sem precisar abrir cliente por
// cliente. Existe porque já aconteceu de passar dias sem ninguém notar que
// o relatório oficial tinha parado de ser importado (rota separada só de
// consulta, precisa vir ANTES de "/:clienteId" pra não ser confundida com
// um id de cliente).
router.get('/status', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT MAX(atualizado_em) AS ultima_atualizacao, COUNT(*) AS total_linhas,
              COUNT(*) FILTER (WHERE status = 'carteira') AS total_carteira,
              COUNT(*) FILTER (WHERE status = 'faturado') AS total_faturado
       FROM pedidos_oficiais_itens`
    );
    const row = result.rows[0];
    res.json({
      ultima_atualizacao: row.ultima_atualizacao,
      total_linhas: Number(row.total_linhas),
      total_carteira: Number(row.total_carteira),
      total_faturado: Number(row.total_faturado),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar status da importação oficial.' });
  }
});

// Resumo do cliente pro topo da ficha: classificatório mais recente e valor
// acumulado faturado (dado oficial, mais confiável que o preço estimado do
// app) num intervalo de datas escolhido no calendário. ?inicio=AAAA-MM-DD e
// /ou ?fim=AAAA-MM-DD - sem nenhum dos dois, soma tudo.
router.get('/:clienteId/resumo', async (req, res) => {
  try {
    const cliente = await pool.query('SELECT codigo_oficial FROM clientes WHERE id = $1', [req.params.clienteId]);
    if (cliente.rows.length === 0) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    const codigoOficial = cliente.rows[0].codigo_oficial;
    if (!codigoOficial) return res.json({ vinculado: false });

    const classResult = await pool.query(
      `SELECT classificatorio FROM pedidos_oficiais_itens
       WHERE cliente_codigo_oficial = $1 AND classificatorio IS NOT NULL
       ORDER BY data_faturamento DESC NULLS LAST LIMIT 1`,
      [codigoOficial]
    );
    const { inicio, fim } = req.query;
    const params = [codigoOficial];
    let filtroData = '';
    if (inicio) { params.push(inicio); filtroData += ` AND data_faturamento >= $${params.length}::date`; }
    if (fim) { params.push(fim); filtroData += ` AND data_faturamento <= $${params.length}::date`; }
    const soma = await pool.query(
      `SELECT COALESCE(SUM(valor),0) AS acumulado, COUNT(*) AS qtd_itens
       FROM pedidos_oficiais_itens
       WHERE cliente_codigo_oficial = $1 AND status = 'faturado'${filtroData}`,
      params
    );
    res.json({
      vinculado: true,
      classificatorio: classResult.rows[0]?.classificatorio || null,
      acumulado: Number(soma.rows[0].acumulado),
      qtd_itens: Number(soma.rows[0].qtd_itens),
      inicio: inicio || null,
      fim: fim || null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar resumo do cliente.' });
  }
});

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
              poi.data_implantacao, poi.data_faturamento, poi.nota_fiscal, poi.classificatorio,
              poi.transportadora, poi.situacao_pedido, poi.status
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

// Importa em lote as abas "Carteira" e "Faturamento" do relatório oficial -
// ÚNICA porta de entrada de pedidos oficiais desde a unificação (antes havia
// também um upload de JSON pré-preparado à mão pelo usuário, e uma planilha
// separada só com a aba Faturamento incompleta - os dois foram removidos:
// o app lê a planilha .xlsx oficial diretamente, sem etapa manual no meio).
// Pode rodar quantas vezes quiser: o mesmo Nr.Pedido+código não duplica, só
// atualiza - e uma vez "faturado", nunca volta pra "carteira" mesmo que uma
// planilha antiga de carteira seja reimportada por engano depois.
router.post('/importar', async (req, res) => {
  // Qualquer usuário logado pode importar (não só admin) - decisão explícita
  // (já valia antes da unificação; mantida aqui inclusive pra classificação
  // de cliente, que antes exigia admin no fluxo separado que foi removido).
  const { itens, classificacoes } = req.body;
  if (!Array.isArray(itens) || itens.length === 0) return res.status(400).json({ erro: 'Envie { itens: [...] }' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Classificatório do cliente (Varejo Master/Premium/Exclusive/Rede),
    // vindo de qualquer uma das abas que tiver a coluna preenchida. Só
    // sobrescreve se esse relatório for mais novo que o que definiu o
    // classificatório atual - senão, subir um relatório antigo por engano
    // faria o cliente "voltar" pra uma categoria que já mudou.
    let clientesClassificados = 0, clientesClassifIgnorados = 0;
    for (const c of (classificacoes || [])) {
      if (!c.nome || !c.tipo) continue;
      const clienteId = await acharOuCriarCliente(client, { nome: c.nome });
      const dataRef = c.data_referencia || null;
      const upd = await client.query(
        `UPDATE clientes
         SET classificatorio_tipo = $1, classificatorio_desconto = $2, classificatorio_atualizado_em = COALESCE($4::date, classificatorio_atualizado_em, now()::date)
         WHERE id = $3
           AND (classificatorio_atualizado_em IS NULL OR $4::date IS NULL OR classificatorio_atualizado_em <= $4::date)
         RETURNING id`,
        [c.tipo, c.desconto ?? null, clienteId, dataRef]
      );
      if (upd.rows.length > 0) clientesClassificados++;
      else clientesClassifIgnorados++;
    }

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
    const notasFiscais = itens.map(it => it.nota_fiscal != null ? String(it.nota_fiscal) : null);
    const classificatorios = itens.map(it => it.classificatorio || null);
    const transportadoras = itens.map(it => it.transportadora || null);
    const situacoesPedido = itens.map(it => it.situacao_pedido || null);
    const status = itens.map(it => it.status === 'faturado' ? 'faturado' : 'carteira');

    await client.query(
      `INSERT INTO pedidos_oficiais_itens
         (nr_pedido, codigo_sku, cliente_codigo_oficial, quantidade, valor, data_implantacao, data_faturamento, nota_fiscal, classificatorio, transportadora, situacao_pedido, status)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::numeric[], $5::numeric[], $6::date[], $7::date[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[])
       ON CONFLICT (nr_pedido, codigo_sku) DO UPDATE SET
         quantidade = CASE WHEN EXCLUDED.status = 'faturado' OR pedidos_oficiais_itens.status != 'faturado'
                           THEN EXCLUDED.quantidade ELSE pedidos_oficiais_itens.quantidade END,
         valor = CASE WHEN EXCLUDED.status = 'faturado' OR pedidos_oficiais_itens.status != 'faturado'
                      THEN EXCLUDED.valor ELSE pedidos_oficiais_itens.valor END,
         data_implantacao = COALESCE(pedidos_oficiais_itens.data_implantacao, EXCLUDED.data_implantacao),
         data_faturamento = CASE WHEN EXCLUDED.status = 'faturado' THEN EXCLUDED.data_faturamento
                                  ELSE pedidos_oficiais_itens.data_faturamento END,
         nota_fiscal = CASE WHEN EXCLUDED.status = 'faturado' THEN EXCLUDED.nota_fiscal
                             ELSE pedidos_oficiais_itens.nota_fiscal END,
         classificatorio = COALESCE(EXCLUDED.classificatorio, pedidos_oficiais_itens.classificatorio),
         transportadora = CASE WHEN EXCLUDED.status = 'faturado' THEN EXCLUDED.transportadora
                                ELSE pedidos_oficiais_itens.transportadora END,
         situacao_pedido = CASE WHEN EXCLUDED.status = 'faturado' THEN EXCLUDED.situacao_pedido
                                 ELSE pedidos_oficiais_itens.situacao_pedido END,
         status = CASE WHEN EXCLUDED.status = 'faturado' OR pedidos_oficiais_itens.status = 'faturado'
                       THEN 'faturado' ELSE EXCLUDED.status END,
         atualizado_em = now()`,
      [nrPedidos, codigosSku, clientesCodigos, quantidades, valores, dataImplant, dataFat, notasFiscais, classificatorios, transportadoras, situacoesPedido, status]
    );

    await client.query('COMMIT');
    console.log(`Pedidos oficiais: ${itens.length} linha(s) importada(s), ${clientesVinculados} cliente(s) vinculado(s) agora, ${clientesNaoEncontrados.length} não encontrado(s), ${clientesClassificados} classificado(s), ${clientesClassifIgnorados} ignorado(s) (relatório mais antigo que o já registrado) - por ${req.usuario?.email}.`);
    res.json({ ok: true, itens: itens.length, clientesVinculados, clientesNaoEncontrados, clientesClassificados, clientesClassifIgnorados });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ erro: 'Erro ao importar pedidos oficiais: ' + e.message });
  } finally {
    client.release();
  }
});

module.exports = router;
