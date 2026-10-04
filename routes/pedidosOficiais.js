const express = require('express');
const router = express.Router();
const { pool, registrarImportacao } = require('../db');
const { avisarImportacao, formatarDataBr } = require('./lib/novidades');
const { acharClientePorNome, acharOuCriarCliente } = require('../clientMatcher');
const { codigoBase } = require('./lib/skuNormalizacao');
const { descontoPelaPolitica } = require('./lib/politicaComercial');
const { sqlFaturadoDeFato } = require('./lib/faturadoDeFato');
const { saldoMinimoDaUf } = require('./lib/saldoMinimo');

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
       WHERE cliente_codigo_oficial = $1 AND ${sqlFaturadoDeFato()}${filtroData}`,
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
      `SELECT poi.nr_pedido, poi.codigo_sku, COALESCE(pr.nome, poi.descricao) AS produto, poi.quantidade, poi.valor,
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
    // Pedidos à vista aguardando pagamento desse cliente - pelo código do
    // cliente na aba ou, se a aba não trouxer o código, pelo Nr.Pedido que
    // já está na Carteira/Faturamento dele.
    const pendentes = await pool.query(
      `SELECT nr_pedido, valor, data_implantacao
       FROM pedidos_pendentes_pagamento ppp
       WHERE ppp.cliente_codigo_oficial = $1
          OR EXISTS (SELECT 1 FROM pedidos_oficiais_itens poi
                     WHERE poi.nr_pedido = ppp.nr_pedido AND poi.cliente_codigo_oficial = $1)
       ORDER BY data_implantacao DESC NULLS LAST`,
      [codigoOficial]
    );
    // Títulos à vista em aberto (pedido faturado, boleto não pago) - pelo
    // código do cliente na aba ou pela nota fiscal de um pedido dele.
    const titulos = await pool.query(
      `SELECT titulo, parcela, vencimento, valor
       FROM titulos_avista_pendentes tap
       WHERE tap.cliente_codigo_oficial = $1
          OR EXISTS (SELECT 1 FROM pedidos_oficiais_itens poi
                     WHERE poi.nota_fiscal = tap.titulo AND poi.cliente_codigo_oficial = $1)
       ORDER BY vencimento NULLS LAST, titulo, parcela`,
      [codigoOficial]
    );
    // Mínimo do saldo em carteira antes do cancelamento - R$ 600 se a ficha de
    // CNPJ diz que o cliente é do Norte/Nordeste (ver lib/saldoMinimo.js).
    const ficha = await pool.query('SELECT uf FROM cliente_cnpj_ficha WHERE cliente_id = $1', [req.params.clienteId]);
    res.json({ vinculado: true, itens: result.rows, pendentes_pagamento: pendentes.rows, titulos_avista: titulos.rows,
               saldo_minimo: saldoMinimoDaUf(ficha.rows[0]?.uf) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar pedidos oficiais.' });
  }
});

// Terceira parte da chave da linha (coluna nota_chave, ver schema.sql): a
// nota fiscal na linha faturada, '' na de carteira (o saldo ainda não
// faturado). Produto faturado só em parte fica com as duas linhas, e o
// entregue em duas notas, com uma linha por nota.
function notaChave(item) {
  return item.status === 'faturado' && item.nota_fiscal != null ? String(item.nota_fiscal) : '';
}

// Mescla dois itens com a mesma chave (nr_pedido + codigo_sku + nota_chave),
// seguindo exatamente a mesma regra de precedência do ON CONFLICT DO UPDATE
// do INSERT logo abaixo - usada pra deduplicar o array `itens` ANTES do
// INSERT (o Postgres proíbe que o UPSERT afete a mesma linha duas vezes
// dentro do mesmo comando). Só junta carteira com faturado quando a linha
// faturada vem sem nota fiscal.
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
    descricao: novo.descricao || atual.descricao || null,
    status: (novoFaturado || atualFaturado) ? 'faturado' : novo.status,
  };
}

// Deduplica itens pela chave da linha - ver mesclarItemOficial.
function deduplicarItensOficiais(itens) {
  const porChave = new Map();
  for (const item of itens) {
    const chave = `${item.nr_pedido}::${item.codigo_sku}::${notaChave(item)}`;
    const existente = porChave.get(chave);
    porChave.set(chave, existente ? mesclarItemOficial(existente, item) : item);
  }
  return Array.from(porChave.values());
}

// O que a importação faz com as linhas de carteira (o saldo não faturado),
// olhando o relatório inteiro:
//  - pedido que o relatório dá como "Atendido Total" (todas as linhas dele no
//    Faturamento) não tem saldo: a linha dele que ainda venha na Carteira é
//    ignorada e as de carteira já gravadas são apagadas (`pedidosConcluidos`)
//    - item cancelado no ERP ficava pra sempre "em carteira" e contando na
//    Entrada de Pedidos;
//  - produto que está no Faturamento e não está mais na Carteira foi todo
//    faturado: a linha de carteira dele é apagada (`paresSemSaldo`). Antes o
//    faturado sobrescrevia a carteira; agora as duas convivem enquanto o
//    relatório trouxer o saldo.
// Relatório sem a aba Carteira cai na segunda regra - faturado apaga o saldo,
// como antes.
function planejarCarteira(itens) {
  const situacoesPorPedido = new Map();
  for (const it of itens) {
    if (it.status !== 'faturado') continue;
    const nr = String(it.nr_pedido);
    if (!situacoesPorPedido.has(nr)) situacoesPorPedido.set(nr, new Set());
    situacoesPorPedido.get(nr).add(it.situacao_pedido || '');
  }
  const pedidosConcluidos = [...situacoesPorPedido]
    .filter(([, sits]) => sits.size === 1 && sits.has('Atendido Total'))
    .map(([nr]) => nr);
  const concluido = new Set(pedidosConcluidos);
  const gravar = itens.filter(it => it.status === 'faturado' || !concluido.has(String(it.nr_pedido)));
  const comSaldo = new Set(gravar.filter(it => it.status !== 'faturado').map(it => `${it.nr_pedido}::${it.codigo_sku}`));
  const paresSemSaldo = new Map();
  for (const it of gravar) {
    const par = `${it.nr_pedido}::${it.codigo_sku}`;
    if (it.status === 'faturado' && !comSaldo.has(par) && !concluido.has(String(it.nr_pedido))) {
      paresSemSaldo.set(par, { nr_pedido: String(it.nr_pedido), codigo_sku: String(it.codigo_sku) });
    }
  }
  return { gravar, pedidosConcluidos, paresSemSaldo: [...paresSemSaldo.values()] };
}

// Aba de pedidos à vista aguardando pagamento: uma linha por pedido (a aba
// pode vir com uma linha por item - soma o valor e fica com o primeiro
// cliente/data que aparecer). Nr.Pedido é o único campo obrigatório.
function normalizarPendentesPagamento(linhas) {
  const porPedido = new Map();
  for (const l of linhas) {
    if (!l || l.nr_pedido == null) continue;
    let nr = String(l.nr_pedido).trim();
    if (/^\d+$/.test(nr)) nr = nr.replace(/^0+(?=\d)/, '');
    if (!nr) continue;
    const texto = (v) => (v != null && String(v).trim()) ? String(v).trim().slice(0, 300) : null;
    const valor = l.valor != null && Number.isFinite(Number(l.valor)) ? Number(l.valor) : null;
    const data = /^\d{4}-\d{2}-\d{2}$/.test(String(l.data_implantacao || '')) ? l.data_implantacao : null;
    const atual = porPedido.get(nr);
    if (!atual) {
      porPedido.set(nr, { nr_pedido: nr, cliente_codigo_oficial: texto(l.cliente_codigo_oficial), cliente_nome: texto(l.cliente_nome), valor, data_implantacao: data });
    } else {
      if (valor != null) atual.valor = (atual.valor ?? 0) + valor;
      atual.cliente_codigo_oficial = atual.cliente_codigo_oficial || texto(l.cliente_codigo_oficial);
      atual.cliente_nome = atual.cliente_nome || texto(l.cliente_nome);
      atual.data_implantacao = atual.data_implantacao || data;
    }
  }
  return Array.from(porPedido.values());
}

// Aba "Pendentes à Vista": um título (nota fiscal) + parcela por linha.
// Título é obrigatório; repetido (mesmo título+parcela) fica o último.
function normalizarTitulosAvista(linhas) {
  const porChave = new Map();
  for (const l of linhas) {
    if (!l || l.titulo == null) continue;
    let titulo = String(l.titulo).trim();
    if (/^\d+$/.test(titulo)) titulo = titulo.replace(/^0+(?=\d)/, '');
    if (!titulo) continue;
    const parcela = l.parcela != null ? String(l.parcela).trim().slice(0, 20) : '';
    const texto = (v) => (v != null && String(v).trim()) ? String(v).trim().slice(0, 300) : null;
    porChave.set(`${titulo}::${parcela}`, {
      titulo, parcela,
      cliente_codigo_oficial: texto(l.cliente_codigo_oficial),
      cliente_nome: texto(l.cliente_nome),
      vencimento: /^\d{4}-\d{2}-\d{2}$/.test(String(l.vencimento || '')) ? l.vencimento : null,
      valor: l.valor != null && Number.isFinite(Number(l.valor)) ? Number(l.valor) : null,
    });
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
  const { itens: itensBrutosOuNada, classificacoes, pendentes_pagamento: pendentesBrutos, titulos_avista: titulosBrutos } = req.body;
  const itensBrutos = Array.isArray(itensBrutosOuNada) ? itensBrutosOuNada : [];
  // Relatório pode vir só com as abas de pagamento pendente (sem Carteira/
  // Faturamento) - aí `itens` vem vazio, mas as listas de pendentes valem.
  const temPendentes = Array.isArray(pendentesBrutos);
  const temTitulos = Array.isArray(titulosBrutos);
  if (itensBrutos.length === 0 && !temPendentes && !temTitulos) return res.status(400).json({ erro: 'Envie { itens: [...] }' });
  const pendentes = temPendentes ? normalizarPendentesPagamento(pendentesBrutos) : null;
  const titulos = temTitulos ? normalizarTitulosAvista(titulosBrutos) : null;

  // Linha sem um desses três campos não tem como ser gravada de forma útil
  // (nr_pedido+codigo_sku é a chave primária, cliente_codigo_oficial é quem
  // liga ao cliente) - sem esse filtro, String(undefined) virava o texto
  // literal "undefined" gravado no banco, passando pelo NOT NULL.
  // "00597502" e "597502" são o mesmo pedido (os zeros à esquerda vieram na
  // aba Carteira de um relatório salvo no Excel em inglês e criaram linhas
  // duplicadas em carteira) - normaliza aqui também, além do navegador.
  const itensValidos = itensBrutos
    .filter(it => it.nr_pedido != null && it.codigo_sku != null && it.cliente_codigo_oficial != null)
    .map(it => {
      const nr = String(it.nr_pedido).trim();
      return /^\d+$/.test(nr) ? { ...it, nr_pedido: nr.replace(/^0+(?=\d)/, '') } : it;
    });
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
      // "Sem Classificatório" no relatório = cliente sem classificatório (grava
      // NULL). Antes virava um tipo com esse nome e o cliente aparecia como
      // classificado, sem faixa nem desconto.
      const semClassificatorio = /^SEMCLASSIFICATORIO$/.test(String(c.tipo).toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z]/g, ''));
      const tipo = semClassificatorio ? null : c.tipo;
      const clienteId = await acharOuCriarCliente(client, { nome: c.nome, codigo_oficial: c.codigo_oficial || null });
      const dataRef = c.data_referencia || null;
      const upd = await client.query(
        `UPDATE clientes
         SET classificatorio_tipo = $1, classificatorio_desconto = $2, classificatorio_atualizado_em = COALESCE($4::date, classificatorio_atualizado_em, now()::date)
         WHERE id = $3
           AND (classificatorio_atualizado_em IS NULL OR $4::date IS NULL OR classificatorio_atualizado_em <= $4::date)
         RETURNING id`,
        // percentual pela Política Comercial (nome do classificatório), não o
        // número que veio no relatório - ver routes/lib/politicaComercial.js
        [tipo, tipo ? descontoPelaPolitica(tipo, c.desconto ?? null) : null, clienteId, dataRef]
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

    // Saldo que deixou de existir (ver planejarCarteira) sai antes de gravar.
    const { gravar, pedidosConcluidos, paresSemSaldo } = planejarCarteira(itens);
    let carteiraRemovida = 0;
    if (pedidosConcluidos.length > 0) {
      const r = await client.query(
        `DELETE FROM pedidos_oficiais_itens WHERE status = 'carteira' AND nr_pedido = ANY($1::text[])`,
        [pedidosConcluidos]
      );
      carteiraRemovida += r.rowCount || 0;
    }
    if (paresSemSaldo.length > 0) {
      const r = await client.query(
        `DELETE FROM pedidos_oficiais_itens poi
         USING UNNEST($1::text[], $2::text[]) AS sem_saldo(nr_pedido, codigo_sku)
         WHERE poi.status = 'carteira' AND poi.nr_pedido = sem_saldo.nr_pedido AND poi.codigo_sku = sem_saldo.codigo_sku`,
        [paresSemSaldo.map(p => p.nr_pedido), paresSemSaldo.map(p => p.codigo_sku)]
      );
      carteiraRemovida += r.rowCount || 0;
    }

    const nrPedidos = gravar.map(it => String(it.nr_pedido));
    const codigosSku = gravar.map(it => String(it.codigo_sku));
    const clientesCodigos = gravar.map(it => String(it.cliente_codigo_oficial));
    const quantidades = gravar.map(it => Number(it.quantidade) || 0);
    const valores = gravar.map(it => it.valor != null ? Number(it.valor) : null);
    const dataImplant = gravar.map(it => it.data_implantacao || null);
    const dataFat = gravar.map(it => it.data_faturamento || null);
    const notasFiscais = gravar.map(it => it.nota_fiscal != null ? String(it.nota_fiscal) : null);
    const classificatorios = gravar.map(it => it.classificatorio || null);
    const transportadoras = gravar.map(it => it.transportadora || null);
    const situacoesPedido = gravar.map(it => it.situacao_pedido || null);
    const status = gravar.map(it => it.status === 'faturado' ? 'faturado' : 'carteira');
    const descricoes = gravar.map(it => (it.descricao != null && String(it.descricao).trim()) ? String(it.descricao).trim().slice(0, 300) : null);
    const notasChave = gravar.map(notaChave);

    if (gravar.length > 0) await client.query(
      `INSERT INTO pedidos_oficiais_itens
         (nr_pedido, codigo_sku, cliente_codigo_oficial, quantidade, valor, data_implantacao, data_faturamento, nota_fiscal, classificatorio, transportadora, situacao_pedido, status, descricao, nota_chave)
       SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::numeric[], $5::numeric[], $6::date[], $7::date[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::text[], $14::text[])
       ON CONFLICT (nr_pedido, codigo_sku, nota_chave) DO UPDATE SET
         quantidade = CASE WHEN EXCLUDED.status = 'faturado' OR pedidos_oficiais_itens.status != 'faturado'
                           THEN EXCLUDED.quantidade ELSE pedidos_oficiais_itens.quantidade END,
         valor = CASE WHEN EXCLUDED.status = 'faturado' OR pedidos_oficiais_itens.status != 'faturado'
                      THEN EXCLUDED.valor ELSE pedidos_oficiais_itens.valor END,
         -- a data de implantação do pedido não muda no ERP: a do relatório
         -- novo vale (antes ficava a primeira gravada, e um relatório com data
         -- errada nunca era corrigido reimportando o certo)
         data_implantacao = COALESCE(EXCLUDED.data_implantacao, pedidos_oficiais_itens.data_implantacao),
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
         descricao = COALESCE(EXCLUDED.descricao, pedidos_oficiais_itens.descricao),
         atualizado_em = now()`,
      [nrPedidos, codigosSku, clientesCodigos, quantidades, valores, dataImplant, dataFat, notasFiscais, classificatorios, transportadoras, situacoesPedido, status, descricoes, notasChave]
    );

    // Pendentes à vista: a aba é a foto atual - troca a lista inteira (o
    // pedido que saiu da aba foi pago). Sem a aba no arquivo, não mexe.
    if (pendentes) {
      await client.query('DELETE FROM pedidos_pendentes_pagamento');
      if (pendentes.length > 0) {
        await client.query(
          `INSERT INTO pedidos_pendentes_pagamento (nr_pedido, cliente_codigo_oficial, cliente_nome, valor, data_implantacao)
           SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::numeric[], $5::date[])`,
          [pendentes.map(p => p.nr_pedido), pendentes.map(p => p.cliente_codigo_oficial), pendentes.map(p => p.cliente_nome),
           pendentes.map(p => p.valor), pendentes.map(p => p.data_implantacao)]
        );
      }
    }

    if (titulos) {
      await client.query('DELETE FROM titulos_avista_pendentes');
      if (titulos.length > 0) {
        await client.query(
          `INSERT INTO titulos_avista_pendentes (titulo, parcela, cliente_codigo_oficial, cliente_nome, vencimento, valor)
           SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::date[], $6::numeric[])`,
          [titulos.map(t => t.titulo), titulos.map(t => t.parcela), titulos.map(t => t.cliente_codigo_oficial),
           titulos.map(t => t.cliente_nome), titulos.map(t => t.vencimento), titulos.map(t => t.valor)]
        );
      }
    }

    await client.query('COMMIT');
    console.log(`Pedidos oficiais: ${itens.length} linha(s) importada(s), ${clientesVinculados} cliente(s) vinculado(s) agora, ${clientesNaoEncontrados.length} não encontrado(s), ${clientesClassificados} classificado(s), ${clientesClassifIgnorados} ignorado(s) (relatório mais antigo que o já registrado), ${carteiraRemovida} linha(s) de carteira sem saldo removida(s) - por ${req.usuario?.email}.`);
    await registrarImportacao(req.usuario?.id, 'pedidos-oficiais/importar', itens.length);
    const ultimoPedido = await pool.query('/* novidades:pedidos-ate */ SELECT max(data_implantacao)::text AS ate FROM pedidos_oficiais_itens');
    const pedidosAte = formatarDataBr(ultimoPedido.rows[0] && ultimoPedido.rows[0].ate);
    await avisarImportacao('relatorio-oficial', pedidosAte ? `Pedidos até ${pedidosAte}` : null);
    res.json({ ok: true, itens: itens.length, descartados, clientesVinculados, clientesNaoEncontrados, clientesClassificados, clientesClassifIgnorados,
               pendentesPagamento: pendentes ? pendentes.length : null, titulosAvista: titulos ? titulos.length : null });
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
module.exports.planejarCarteira = planejarCarteira;
module.exports.normalizarPendentesPagamento = normalizarPendentesPagamento;
module.exports.normalizarTitulosAvista = normalizarTitulosAvista;
