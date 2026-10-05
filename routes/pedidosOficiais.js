const express = require('express');
const router = express.Router();
const { pool, registrarImportacao } = require('../db');
const { avisarImportacao, formatarDataBr } = require('./lib/novidades');
const { sqlBloqueioAtivo } = require('./lib/pedidosBloqueados');
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
    // sem relatório nenhum, o próximo importado não pode sair "antigo"
    await pool.query('/* relatorio-oficial:zerar-data */ DELETE FROM configuracoes WHERE chave = $1', [CHAVE_RELATORIO_MAIS_NOVO]);
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
    // Pedidos bloqueados pela Cortag (e-mail "Pedido Bloqueado") ainda valendo
    const bloqueados = await pool.query(
      `/* pedidos-oficiais:bloqueados */
       SELECT pb.nr_pedido, pb.motivo, pb.recebido_em FROM pedidos_bloqueados pb
       WHERE pb.cliente_codigo_oficial = $1 AND ${sqlBloqueioAtivo('pb')}
       ORDER BY pb.recebido_em DESC`,
      [codigoOficial]
    );
    // Mínimo do saldo em carteira antes do cancelamento - R$ 600 se a ficha de
    // CNPJ diz que o cliente é do Norte/Nordeste (ver lib/saldoMinimo.js).
    const ficha = await pool.query('SELECT uf FROM cliente_cnpj_ficha WHERE cliente_id = $1', [req.params.clienteId]);
    res.json({ vinculado: true, itens: result.rows, pendentes_pagamento: pendentes.rows, titulos_avista: titulos.rows,
               bloqueados: bloqueados.rows, saldo_minimo: saldoMinimoDaUf(ficha.rows[0]?.uf) });
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

// Data do relatório = a mais nova (implantação/faturamento) das linhas de
// pedido. Os pendentes à vista NÃO contam: o pedido aguardando pagamento foi
// implantado dias antes e a planilha só com essas abas saía sempre "antiga"
// (a lista à vista não era trocada - achado do revisor-cortag). Data depois de
// hoje (Brasília) é erro de planilha e não conta (senão travava o relatório do
// dia seguinte como "antigo").
function dataDoRelatorio(itens, _pendentes, agora = new Date()) {
  const limite = agora.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  let max = null;
  const ver = (d) => {
    const dia = String(d || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(dia) && dia <= limite && (!max || dia > max)) max = dia;
  };
  for (const it of itens) { ver(it.data_implantacao); ver(it.data_faturamento); }
  return max;
}
// Normalização de nome do clientMatcher.js (acharClientePorNome): exata
// (maiúsculas, espaços colapsados) e tolerante (também sem ponto/vírgula).
const sqlNomeExato = (col) => `regexp_replace(upper(trim(${col})), '\\s+', ' ', 'g')`;
const sqlNomeTolerante = (col) => `regexp_replace(upper(trim(${col})), '[.,\\s]+', ' ', 'g')`;
const ehSemClassificatorio = (tipo) => /^SEMCLASSIFICATORIO$/.test(String(tipo).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z]/g, ''));

// Classificatório e código oficial dos clientes do relatório. Mesmas regras
// do laço antigo (um acharOuCriarCliente + UPDATE por classificação, e um
// SELECT + acharClientePorNome + UPDATE por código novo - ~750 consultas por
// relatório, cada uma uma ida de Oregon a São Paulo): os clientes que podem
// casar (pelo código ou pelo nome normalizado no próprio Postgres) vêm numa
// consulta só, a ordem das decisões é refeita em memória e a gravação sai em
// lote.
//  - Classificação (Varejo Master/Premium/Exclusive/Rede), de qualquer aba
//    que tiver a coluna: só sobrescreve se o relatório for mais novo que o
//    que definiu o classificatório atual - subir um relatório antigo por
//    engano faria o cliente "voltar" pra uma categoria que já mudou.
//    "Sem Classificatório" grava NULL (antes virava um tipo com esse nome).
//    Percentual pela Política Comercial, não o do relatório.
//  - Código oficial: cliente ainda sem o código casado pelo nome, só na
//    primeira vez que o código aparece.
async function classificarEVincularClientes(client, classificacoes, itens) {
  const classifs = classificacoes.filter(c => c.nome && c.tipo);
  const paresUnicos = new Map();
  for (const it of itens) {
    if (it.cliente_codigo_oficial && it.cliente_nome && !paresUnicos.has(it.cliente_codigo_oficial)) {
      paresUnicos.set(it.cliente_codigo_oficial, it.cliente_nome);
    }
  }
  const resultado = { clientesClassificados: 0, clientesClassifIgnorados: 0, clientesVinculados: 0, clientesNaoEncontrados: [] };
  if (classifs.length === 0 && paresUnicos.size === 0) return resultado;

  const codigos = [...new Set([...classifs.map(c => c.codigo_oficial), ...paresUnicos.keys()].filter(Boolean).map(String))];
  const nomes = [...new Set([...classifs.map(c => c.nome), ...paresUnicos.values()].map(String))];
  const carga = await client.query(
    `/* relatorio-oficial:clientes */
     WITH entrada AS (
       SELECT nome, ${sqlNomeExato('nome')} AS exato, ${sqlNomeTolerante('nome')} AS tolerante FROM UNNEST($2::text[]) AS e(nome)
     ), cli AS (
       SELECT id, codigo_oficial, ${sqlNomeExato('nome')} AS exato, ${sqlNomeTolerante('nome')} AS tolerante FROM clientes
     )
     SELECT 'cliente' AS fonte, cli.id, NULL::text AS nome, cli.codigo_oficial, cli.exato, cli.tolerante FROM cli
     WHERE cli.codigo_oficial = ANY($1::text[]) OR cli.exato IN (SELECT exato FROM entrada) OR cli.tolerante IN (SELECT tolerante FROM entrada)
     UNION ALL
     SELECT 'entrada', NULL, nome, NULL, exato, tolerante FROM entrada`,
    [codigos, nomes]
  );

  // Clientes em memória, na ordem em que a consulta por nome os acharia (os já
  // gravados por id, os criados agora depois deles)
  const chaveDoNome = new Map();
  const porCodigo = new Map();
  const porExato = new Map();
  const porTolerante = new Map();
  const indexar = (reg) => {
    if (!porExato.has(reg.exato)) porExato.set(reg.exato, reg);
    if (!porTolerante.has(reg.tolerante)) porTolerante.set(reg.tolerante, reg);
  };
  const existentes = [];
  for (const r of carga.rows) {
    if (r.fonte === 'entrada') chaveDoNome.set(r.nome, { exato: r.exato, tolerante: r.tolerante });
    else existentes.push({ id: r.id, codigo: r.codigo_oficial || null, exato: r.exato, tolerante: r.tolerante });
  }
  existentes.sort((a, b) => a.id - b.id);
  for (const reg of existentes) {
    indexar(reg);
    if (reg.codigo) porCodigo.set(reg.codigo, reg);
  }
  const acharPorNome = (nome) => {
    const k = chaveDoNome.get(String(nome));
    return k ? (porExato.get(k.exato) || porTolerante.get(k.tolerante) || null) : null;
  };
  // acharOuCriarCliente (clientMatcher.js) com nome + código, sem CNPJ
  const novos = [];
  const acharOuCriar = (nome, codigo) => {
    if (codigo && porCodigo.has(codigo)) return porCodigo.get(codigo);
    const porNome = acharPorNome(nome);
    // mesmo nome com OUTRO código é outra empresa: cria
    if (porNome && (!codigo || !porNome.codigo || porNome.codigo === codigo)) return porNome;
    const k = chaveDoNome.get(String(nome));
    const reg = { id: null, nome: String(nome), codigo: codigo || null, codigoNaCriacao: codigo || null, exato: k.exato, tolerante: k.tolerante };
    indexar(reg);
    if (reg.codigo) porCodigo.set(reg.codigo, reg);
    novos.push(reg);
    return reg;
  };

  const tentativas = classifs.map(c => {
    const tipo = ehSemClassificatorio(c.tipo) ? null : c.tipo;
    const codigo = c.codigo_oficial ? String(c.codigo_oficial) : null;
    return {
      reg: acharOuCriar(c.nome, codigo), tipo,
      // percentual pela Política Comercial (nome do classificatório), não o
      // número que veio no relatório - ver routes/lib/politicaComercial.js
      desconto: tipo ? descontoPelaPolitica(tipo, c.desconto ?? null) : null,
      dataRef: c.data_referencia || null,
    };
  });
  // código de quem estava sem, casando pelo nome (depois das classificações,
  // como antes: inclui os clientes que elas criaram)
  const codigoAntes = new Map([...porCodigo].map(([cod, reg]) => [cod, reg]));
  const vinculos = [];
  for (const [codigo, nome] of paresUnicos) {
    if (porCodigo.has(String(codigo))) continue;
    const reg = acharPorNome(nome);
    if (!reg) { resultado.clientesNaoEncontrados.push({ codigo, nome }); continue; }
    if (reg.codigo && porCodigo.get(reg.codigo) === reg) porCodigo.delete(reg.codigo);
    reg.codigo = String(codigo);
    porCodigo.set(reg.codigo, reg);
    vinculos.push({ reg, codigo: String(codigo) });
    resultado.clientesVinculados++;
  }

  // 1) clientes novos: com código, em lote (ON CONFLICT DO NOTHING como no
  // clientMatcher; o código liga a linha devolvida ao cliente); sem código, um
  // a um (não há como ligar a linha devolvida)
  const comCodigo = novos.filter(r => r.codigoNaCriacao);
  if (comCodigo.length > 0) {
    const criados = await client.query(
      `/* relatorio-oficial:criar-clientes */
       INSERT INTO clientes (nome, codigo_oficial)
       SELECT nome, codigo FROM UNNEST($1::text[], $2::text[]) WITH ORDINALITY AS n(nome, codigo, ordem) ORDER BY ordem
       ON CONFLICT DO NOTHING RETURNING id, codigo_oficial`,
      [comCodigo.map(r => r.nome), comCodigo.map(r => r.codigoNaCriacao)]
    );
    const idPorCodigo = new Map(criados.rows.map(r => [r.codigo_oficial, r.id]));
    const faltando = comCodigo.filter(r => !idPorCodigo.has(r.codigoNaCriacao)).map(r => r.codigoNaCriacao);
    if (faltando.length > 0) {
      // corrida: outra requisição criou o mesmo código entre a leitura e o INSERT
      const depois = await client.query('/* relatorio-oficial:clientes-por-codigo */ SELECT id, codigo_oficial FROM clientes WHERE codigo_oficial = ANY($1::text[])', [faltando]);
      for (const r of depois.rows) idPorCodigo.set(r.codigo_oficial, r.id);
    }
    for (const reg of comCodigo) {
      reg.id = idPorCodigo.get(reg.codigoNaCriacao);
      if (reg.id == null) throw new Error(`Corrida ao criar cliente "${reg.nome}" - não encontrei o registro depois do conflito.`);
    }
  }
  for (const reg of novos.filter(r => !r.codigoNaCriacao)) {
    const r = await client.query('INSERT INTO clientes (nome, documento, codigo_oficial, contato) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id', [reg.nome, null, null, null]);
    if (!r.rows.length) throw new Error(`Corrida ao criar cliente "${reg.nome}" - não encontrei o registro depois do conflito.`);
    reg.id = r.rows[0].id;
  }

  // 2) classificações: uma rodada por vez que o mesmo cliente aparece (a 2ª
  // compara com o que a 1ª gravou, como no laço antigo); a condição de data
  // fica no WHERE, igual à de antes
  const rodadas = [];
  const vezes = new Map();
  for (const t of tentativas) {
    const n = vezes.get(t.reg) || 0;
    vezes.set(t.reg, n + 1);
    (rodadas[n] = rodadas[n] || []).push(t);
  }
  for (const rodada of rodadas) {
    const r = await client.query(
      `/* relatorio-oficial:classificar */
       UPDATE clientes c
       SET classificatorio_tipo = u.tipo, classificatorio_desconto = u.desconto,
           classificatorio_atualizado_em = COALESCE(u.data_ref, c.classificatorio_atualizado_em, now()::date)
       FROM UNNEST($1::int[], $2::text[], $3::numeric[], $4::date[]) AS u(id, tipo, desconto, data_ref)
       WHERE c.id = u.id
         AND (c.classificatorio_atualizado_em IS NULL OR u.data_ref IS NULL OR c.classificatorio_atualizado_em <= u.data_ref)
       RETURNING c.id`,
      [rodada.map(t => t.reg.id), rodada.map(t => t.tipo), rodada.map(t => t.desconto), rodada.map(t => t.dataRef)]
    );
    const gravados = r.rowCount != null ? r.rowCount : r.rows.length;
    resultado.clientesClassificados += gravados;
    resultado.clientesClassifIgnorados += rodada.length - gravados;
  }

  // 3) códigos aprendidos. Em lote só com o código final de cada cliente; se
  // algum código passa de um cliente pra outro (o índice único reclamaria no
  // meio do lote), um a um na ordem de antes.
  if (vinculos.length > 0) {
    const finalPorReg = new Map();
    for (const v of vinculos) finalPorReg.set(v.reg, v.codigo);
    const trocaDeDono = [...finalPorReg].some(([reg, codigo]) => codigoAntes.has(codigo) && codigoAntes.get(codigo) !== reg);
    if (trocaDeDono) {
      for (const v of vinculos) await client.query('UPDATE clientes SET codigo_oficial = $1 WHERE id = $2', [v.codigo, v.reg.id]);
    } else {
      await client.query(
        `/* relatorio-oficial:vincular-codigos */
         UPDATE clientes c SET codigo_oficial = u.codigo FROM UNNEST($1::int[], $2::text[]) AS u(id, codigo) WHERE c.id = u.id`,
        [[...finalPorReg.keys()].map(r => r.id), [...finalPorReg.values()]]
      );
    }
  }
  return resultado;
}

const CHAVE_RELATORIO_MAIS_NOVO = 'relatorio_oficial_mais_novo';
const dataComAno = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// Importa em lote as abas "Carteira" e "Faturamento" do relatório oficial -
// ÚNICA porta de entrada de pedidos oficiais desde a unificação (antes havia
// também um upload de JSON pré-preparado à mão pelo usuário, e uma planilha
// separada só com a aba Faturamento incompleta - os dois foram removidos:
// o app lê a planilha .xlsx oficial diretamente, sem etapa manual no meio).
// Pode rodar quantas vezes quiser: o mesmo Nr.Pedido+código não duplica, só
// atualiza - e uma vez "faturado", nunca volta pra "carteira" mesmo que uma
// planilha antiga de carteira seja reimportada por engano depois.
// Também chamada pela importação automática por e-mail (routes/importacaoEmail.js)
// - devolve { status, json } em vez de responder direto.
async function importarRelatorioOficial(body, usuario) {
  const { itens: itensBrutosOuNada, classificacoes, pendentes_pagamento: pendentesBrutos, titulos_avista: titulosBrutos } = body || {};
  const itensBrutos = Array.isArray(itensBrutosOuNada) ? itensBrutosOuNada : [];
  // Relatório pode vir só com as abas de pagamento pendente (sem Carteira/
  // Faturamento) - aí `itens` vem vazio, mas as listas de pendentes valem.
  const temPendentes = Array.isArray(pendentesBrutos);
  const temTitulos = Array.isArray(titulosBrutos);
  if (itensBrutos.length === 0 && !temPendentes && !temTitulos) return { status: 400, json: { erro: 'Envie { itens: [...] }' } };
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

    // Relatório mais antigo que o mais novo já importado (reimportado por
    // engano, ou e-mail atrasado): a carteira e as listas à vista dele são uma
    // foto velha - recriavam saldo já faturado (a linha de carteira e a
    // faturada têm chaves diferentes desde a nota_chave) e voltavam os
    // pendentes à vista. Ele grava só as linhas faturadas e as descrições.
    // A linha da configuração fica travada até o COMMIT: duas importações ao
    // mesmo tempo comparam uma depois da outra.
    const dataArquivo = dataDoRelatorio(itens, pendentes);
    const gravadaResult = await client.query(
      `/* relatorio-oficial:data-mais-nova */
       INSERT INTO configuracoes (chave, valor) VALUES ($1, 'null'::jsonb)
       ON CONFLICT (chave) DO UPDATE SET chave = EXCLUDED.chave
       RETURNING valor #>> '{}' AS data`,
      [CHAVE_RELATORIO_MAIS_NOVO]
    );
    const dataMaisNova = gravadaResult.rows[0] ? gravadaResult.rows[0].data : null;
    const relatorioAntigo = !!(dataArquivo && dataMaisNova && dataArquivo < dataMaisNova);

    // Classificação e vínculo do código oficial dos clientes do relatório -
    // em lote (ver classificarEVincularClientes).
    const { clientesClassificados, clientesClassifIgnorados, clientesVinculados, clientesNaoEncontrados } =
      await classificarEVincularClientes(client, classificacoes || [], itens);

    // Saldo que deixou de existir (ver planejarCarteira) sai antes de gravar.
    // Relatório antigo: só as faturadas, sem apagar nem gravar carteira.
    // O saldo de produto que aparece faturado sai em qualquer caso (apagar saldo já
    // faturado é seguro com relatório de qualquer data).
    const plano = relatorioAntigo
      ? { gravar: itens.filter(it => it.status === 'faturado'), pedidosConcluidos: [], paresSemSaldo: planejarCarteira(itens).paresSemSaldo }
      : planejarCarteira(itens);
    const { gravar, pedidosConcluidos, paresSemSaldo } = plano;
    const carteiraIgnorada = relatorioAntigo ? itens.length - gravar.length : 0;
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

    // Relatório antigo: a descrição da linha de carteira dele ainda completa o
    // nome do produto que saiu da tabela de preços, sem criar a linha
    if (relatorioAntigo) {
      const comDescricao = itens.filter(it => it.status !== 'faturado' && it.descricao != null && String(it.descricao).trim());
      if (comDescricao.length > 0) {
        await client.query(
          `/* relatorio-oficial:descricoes */
           UPDATE pedidos_oficiais_itens poi SET descricao = d.descricao
           FROM UNNEST($1::text[], $2::text[], $3::text[]) AS d(nr_pedido, codigo_sku, descricao)
           WHERE poi.nr_pedido = d.nr_pedido AND poi.codigo_sku = d.codigo_sku AND poi.descricao IS NULL`,
          [comDescricao.map(it => String(it.nr_pedido)), comDescricao.map(it => String(it.codigo_sku)),
           comDescricao.map(it => String(it.descricao).trim().slice(0, 300))]
        );
      }
    }

    // Pendentes à vista: a aba é a foto atual - troca a lista inteira (o
    // pedido que saiu da aba foi pago). Sem a aba no arquivo, não mexe.
    // Relatório antigo também não: a foto dele é velha.
    if (pendentes && !relatorioAntigo) {
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

    if (titulos && !relatorioAntigo) {
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

    if (!relatorioAntigo && dataArquivo && (!dataMaisNova || dataArquivo > dataMaisNova)) {
      await client.query(
        `/* relatorio-oficial:gravar-data */ UPDATE configuracoes SET valor = to_jsonb($2::text), atualizado_em = now() WHERE chave = $1`,
        [CHAVE_RELATORIO_MAIS_NOVO, dataArquivo]
      );
    }

    await client.query('COMMIT');
    if (relatorioAntigo) console.log(`Pedidos oficiais: relatório de ${dataArquivo} mais antigo que o já importado (${dataMaisNova}) - só as linhas faturadas; ${carteiraIgnorada} linha(s) de carteira e as listas à vista ignoradas.`);
    console.log(`Pedidos oficiais: ${itens.length} linha(s) importada(s), ${clientesVinculados} cliente(s) vinculado(s) agora, ${clientesNaoEncontrados.length} não encontrado(s), ${clientesClassificados} classificado(s), ${clientesClassifIgnorados} ignorado(s) (relatório mais antigo que o já registrado), ${carteiraRemovida} linha(s) de carteira sem saldo removida(s) - por ${usuario?.email}.`);
    await registrarImportacao(usuario?.id, 'pedidos-oficiais/importar', itens.length);
    if (!relatorioAntigo) {
      // relatório antigo não traz nada novo pra avisar ("Pedidos até" não muda)
      const ultimoPedido = await pool.query('/* novidades:pedidos-ate */ SELECT max(data_implantacao)::text AS ate FROM pedidos_oficiais_itens');
      const pedidosAte = formatarDataBr(ultimoPedido.rows[0] && ultimoPedido.rows[0].ate);
      await avisarImportacao('relatorio-oficial', pedidosAte ? `Pedidos até ${pedidosAte}` : null);
    }
    return { status: 200, json: { ok: true, itens: itens.length, descartados, clientesVinculados, clientesNaoEncontrados, clientesClassificados, clientesClassifIgnorados,
               pendentesPagamento: pendentes && !relatorioAntigo ? pendentes.length : null, titulosAvista: titulos && !relatorioAntigo ? titulos.length : null,
               dataRelatorio: dataArquivo,
               ...(relatorioAntigo ? {
                 relatorioAntigo: true, relatorioMaisNovo: dataMaisNova, carteiraIgnorada,
                 aviso: `Relatório de ${dataComAno(dataArquivo)} é mais antigo que o já importado (${dataComAno(dataMaisNova)}): `
                   + 'entraram só as linhas faturadas; carteira e pagamentos à vista não foram alterados',
               } : {}) } };
  } catch (e) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { console.error('Erro no rollback:', rollbackErr); }
    }
    console.error(e);
    return { status: 500, json: { erro: 'Erro ao importar pedidos oficiais.' } };
  } finally {
    if (client) client.release();
  }
}
// Qualquer usuário logado pode importar (não só admin) - decisão explícita
// (já valia antes da unificação; mantida aqui inclusive pra classificação
// de cliente, que antes exigia admin no fluxo separado que foi removido).
router.post('/importar', async (req, res) => {
  const r = await importarRelatorioOficial(req.body, req.usuario);
  res.status(r.status).json(r.json);
});

module.exports = router;
// Exportado só pra teste direto da lógica de deduplicação, sem precisar
// subir servidor/banco - não afeta o roteamento (router continua sendo o
// export default usado pelo server.js).
module.exports.deduplicarItensOficiais = deduplicarItensOficiais;
module.exports.planejarCarteira = planejarCarteira;
module.exports.dataDoRelatorio = dataDoRelatorio;
module.exports.normalizarPendentesPagamento = normalizarPendentesPagamento;
module.exports.normalizarTitulosAvista = normalizarTitulosAvista;
module.exports.importarRelatorioOficial = importarRelatorioOficial;
