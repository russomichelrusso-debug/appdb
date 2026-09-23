const express = require('express');
const router = express.Router();
const { pool, registrarImportacao } = require('../db');
const { acharClientePorNome, acharOuCriarCliente } = require('../clientMatcher');
const { codigoBase } = require('./lib/skuNormalizacao');

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

const CARTEIRA_ANTIGA_DIAS = 60;

// Quantos itens "em carteira" (nunca faturados) já passaram de 60 dias
// desde que o pedido foi implantado - pro admin ver antes de decidir
// excluir. Usa data_implantacao (não muda em reimportações) como âncora
// de idade, não atualizado_em (que reseta toda vez que a mesma planilha é
// reimportada mesmo sem mudança de status). Rota separada de /status, só
// pra quem tem permissão de admin (ver rota de limpeza logo abaixo).
router.get('/carteira-antiga/contagem', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode ver a carteira antiga.' });
  try {
    const result = await pool.query(
      `SELECT COUNT(*) AS total FROM pedidos_oficiais_itens
       WHERE status = 'carteira' AND data_implantacao < CURRENT_DATE - INTERVAL '${CARTEIRA_ANTIGA_DIAS} days'`
    );
    res.json({ total: Number(result.rows[0].total), dias: CARTEIRA_ANTIGA_DIAS });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao contar carteira antiga.' });
  }
});

// Exclui itens "em carteira" com mais de 60 dias - o vendedor confirmou
// que, na prática, isso significa que o pedido não foi faturado por falta
// de mercadoria (nunca chegou a ser atendido). Ação manual e irreversível,
// por isso só admin e só depois de confirmação no app (não roda sozinha).
// Um item já "faturado" NUNCA é afetado, mesmo que tenha mais de 60 dias -
// o filtro é sempre status = 'carteira'.
router.post('/carteira-antiga/limpar', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode limpar a carteira antiga.' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const excluidos = await client.query(
      `DELETE FROM pedidos_oficiais_itens
       WHERE status = 'carteira' AND data_implantacao < CURRENT_DATE - INTERVAL '${CARTEIRA_ANTIGA_DIAS} days'`
    );
    // Pedido que só ficou "Parcial" por causa do item em carteira que acabou
    // de sumir (nunca ia ser atendido mesmo) passa a valer como totalmente
    // atendido - só pega pedidos sem NENHUM item em carteira restante, então
    // um pedido que ainda tem outro item em carteira mais novo continua
    // "Parcial" corretamente.
    const atualizados = await client.query(
      `UPDATE pedidos_oficiais_itens
       SET situacao_pedido = 'Atendido Total'
       WHERE situacao_pedido = 'Atendido Parcial'
         AND nr_pedido NOT IN (SELECT nr_pedido FROM pedidos_oficiais_itens WHERE status = 'carteira')`
    );
    await client.query('COMMIT');
    console.log(`Carteira antiga limpa: ${excluidos.rowCount} item(ns) excluído(s) (>${CARTEIRA_ANTIGA_DIAS} dias em carteira), ${atualizados.rowCount} linha(s) atualizada(s) de Atendido Parcial pra Total, por ${req.usuario?.email}.`);
    res.json({ excluidos: excluidos.rowCount, atualizados: atualizados.rowCount });
  } catch (e) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { console.error('Erro no rollback:', rollbackErr); }
    }
    console.error(e);
    res.status(500).json({ erro: 'Erro ao limpar carteira antiga.' });
  } finally {
    if (client) client.release();
  }
});

// Contagem/exclusão de TODO o banco de faturamento (Carteira + Faturamento) -
// usado quando o admin vai reimportar tudo do zero pra evitar dado velho
// misturado com o novo. Ação manual, irreversível, só admin - mesmo padrão
// da "carteira antiga" acima, mas sem filtro nenhum (apaga tudo mesmo).
router.get('/tudo/contagem', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode ver essa contagem.' });
  try {
    const result = await pool.query('SELECT COUNT(*) AS total FROM pedidos_oficiais_itens');
    res.json({ total: Number(result.rows[0].total) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao contar o relatório oficial.' });
  }
});
router.post('/tudo/limpar', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode apagar o relatório oficial.' });
  try {
    const result = await pool.query('DELETE FROM pedidos_oficiais_itens');
    console.log(`Relatório oficial de faturamento apagado por completo: ${result.rowCount} linha(s) excluída(s), por ${req.usuario?.email}.`);
    res.json({ excluidos: result.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao apagar o relatório oficial.' });
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
    // Reconcilia códigos promocionais (P/P1/P2 + código base) - quando o
    // join direto não achou o produto (código literal só existe como
    // variante de campanha), busca pelo código base e mostra o nome/
    // categoria do produto original, mantendo o código literal em
    // codigo_sku_original pra quem precisar rastrear até a fatura.
    const semProduto = [...new Set(result.rows.filter(it => !it.produto).map(it => it.codigo_sku))];
    if (semProduto.length > 0) {
      const produtosResult = await pool.query('SELECT codigo_sku, nome FROM produtos');
      const codigosConhecidos = new Set(produtosResult.rows.map(p => p.codigo_sku));
      const nomesPorCodigo = {};
      for (const p of produtosResult.rows) nomesPorCodigo[p.codigo_sku] = p.nome;
      for (const item of result.rows) {
        if (item.produto) continue;
        const base = codigoBase(item.codigo_sku, codigosConhecidos);
        if (base !== item.codigo_sku) {
          item.codigo_sku_original = item.codigo_sku;
          item.codigo_sku = base;
          item.produto = nomesPorCodigo[base];
        }
      }
    }
    res.json({ vinculado: true, itens: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar pedidos oficiais.' });
  }
});

// Mescla dois itens com o mesmo nr_pedido+codigo_sku, seguindo exatamente
// a mesma regra de precedência do ON CONFLICT DO UPDATE do INSERT logo
// abaixo - usada pra deduplicar o array `itens` ANTES do INSERT (o
// Postgres proíbe que o UPSERT afete a mesma linha duas vezes dentro do
// mesmo comando, e é comum o mesmo par aparecer nas duas abas da mesma
// planilha, ex: um pedido que já foi faturado mas a linha antiga ainda
// consta na aba "Carteira").
function mesclarItemOficial(atual, novo) {
  const novoFaturado = novo.status === 'faturado';
  const atualFaturado = atual.status === 'faturado';
  return {
    ...atual,
    quantidade: (novoFaturado || !atualFaturado) ? novo.quantidade : atual.quantidade,
    valor: (novoFaturado || !atualFaturado) ? novo.valor : atual.valor,
    data_implantacao: atual.data_implantacao ?? novo.data_implantacao,
    data_faturamento: novoFaturado ? novo.data_faturamento : atual.data_faturamento,
    nota_fiscal: novoFaturado ? novo.nota_fiscal : atual.nota_fiscal,
    classificatorio: novo.classificatorio ?? atual.classificatorio,
    transportadora: novoFaturado ? novo.transportadora : atual.transportadora,
    situacao_pedido: novoFaturado ? novo.situacao_pedido : atual.situacao_pedido,
    status: (novoFaturado || atualFaturado) ? 'faturado' : novo.status,
  };
}

// Deduplica itens pelo par (nr_pedido, codigo_sku) - ver mesclarItemOficial.
function deduplicarItensOficiais(itens) {
  const porChave = new Map();
  for (const item of itens) {
    const chave = `${item.nr_pedido}::${item.codigo_sku}`;
    const existente = porChave.get(chave);
    porChave.set(chave, existente ? mesclarItemOficial(existente, item) : item);
  }
  return Array.from(porChave.values());
}

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
  const { itens: itensBrutos, classificacoes } = req.body;
  if (!Array.isArray(itensBrutos) || itensBrutos.length === 0) return res.status(400).json({ erro: 'Envie { itens: [...] }' });

  // Linha sem um desses três campos não tem como ser gravada de forma útil
  // (nr_pedido+codigo_sku é a chave primária, cliente_codigo_oficial é quem
  // liga ao cliente) - sem esse filtro, String(undefined) virava o texto
  // literal "undefined" gravado no banco, passando pelo NOT NULL.
  const itensValidos = itensBrutos.filter(it => it.nr_pedido != null && it.codigo_sku != null && it.cliente_codigo_oficial != null);
  const descartados = itensBrutos.length - itensValidos.length;
  if (descartados > 0) {
    console.warn(`Importação de pedidos oficiais: ${descartados} linha(s) descartada(s) por faltar nr_pedido/codigo_sku/cliente_codigo_oficial.`);
  }
  const itens = deduplicarItensOficiais(itensValidos);

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Classificatório do cliente (Varejo Master/Premium/Exclusive/Rede),
    // vindo de qualquer uma das abas que tiver a coluna preenchida. Só
    // sobrescreve se esse relatório for mais novo que o que definiu o
    // classificatório atual - senão, subir um relatório antigo por engano
    // faria o cliente "voltar" pra uma categoria que já mudou.
    let clientesClassificados = 0, clientesClassifIgnorados = 0;
    for (const c of (classificacoes || [])) {
      if (!c.nome || !c.tipo) continue;
      const clienteId = await acharOuCriarCliente(client, { nome: c.nome, codigo_oficial: c.codigo_oficial || null });
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
    await registrarImportacao(req.usuario?.id, 'pedidos-oficiais/importar', itens.length);
    res.json({ ok: true, itens: itens.length, descartados, clientesVinculados, clientesNaoEncontrados, clientesClassificados, clientesClassifIgnorados });
  } catch (e) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { console.error('Erro no rollback:', rollbackErr); }
    }
    console.error(e);
    res.status(500).json({ erro: 'Erro ao importar pedidos oficiais.' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
// Exportado só pra teste direto da lógica de deduplicação, sem precisar
// subir servidor/banco - não afeta o roteamento (router continua sendo o
// export default usado pelo server.js).
module.exports.deduplicarItensOficiais = deduplicarItensOficiais;
