const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { acharOuCriarCliente } = require('../clientMatcher');
const { validarIdInteiro } = require('../middleware/validarId');
const { sqlDiaDoPedido } = require('./lib/comprasApp');

router.param('id', validarIdInteiro);

// Hora em que o vendedor fechou o pedido do app. Sem internet, o pedido fica na
// fila do aparelho e só chega aqui quando a rede volta - às vezes no dia
// seguinte; gravar now() punha a compra no dia do envio (Histórico, Recompra,
// Rotatividade). O app manda a hora do toque em "Finalizar pedido"; vale só
// hora completa (data sem hora é coisa do PDF), dos últimos 30 dias até 10 min
// à frente (relógio do celular adiantado). Fora disso: null = now().
const FILA_MAX_DIAS = 30;
function horaDoPedidoDoApp(valor, agora = new Date()) {
  if (typeof valor !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(valor)) return null;
  const t = new Date(valor).getTime();
  if (!Number.isFinite(t)) return null;
  if (t < agora.getTime() - FILA_MAX_DIAS * 86400000 || t > agora.getTime() + 10 * 60000) return null;
  // meia-noite UTC exata é lida como "só a data" (sqlDiaDoPedido); 1 ms a mais
  // mantém a hora de verdade no dia de Brasília
  return new Date(t % 86400000 === 0 ? t + 1 : t).toISOString();
}

async function acharOuCriarVendedor(client, nomeVendedor) {
  if (!nomeVendedor) return null;
  const existing = await client.query('SELECT id FROM vendedores WHERE nome = $1', [nomeVendedor]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const result = await client.query(
    'INSERT INTO vendedores (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING RETURNING id',
    [nomeVendedor]
  );
  if (result.rows.length > 0) return result.rows[0].id;
  // corrida: outro pedido criou o mesmo vendedor entre o SELECT e o INSERT.
  const depois = await client.query('SELECT id FROM vendedores WHERE nome = $1', [nomeVendedor]);
  return depois.rows[0].id;
}
// Acha o produto pelo código. Se não existir e vier uma descrição (caso do
// PDF oficial, que já traz o nome do item), cria na hora em vez de recusar -
// diferente do "Finalizar pedido" manual, que exige sincronizar o catálogo
// antes (lá o código vem só de digitação/scanner, sem descrição junto).
async function acharOuCriarProdutoPorSku(client, codigo_sku, descricaoSeNovo) {
  const result = await client.query('SELECT id FROM produtos WHERE codigo_sku = $1', [codigo_sku]);
  if (result.rows.length > 0) return result.rows[0].id;
  if (!descricaoSeNovo) {
    throw new Error(`Produto com código ${codigo_sku} não encontrado - rode /api/produtos/sync primeiro.`);
  }
  const criado = await client.query(
    'INSERT INTO produtos (codigo_sku, nome) VALUES ($1, $2) ON CONFLICT (codigo_sku) DO NOTHING RETURNING id',
    [codigo_sku, descricaoSeNovo]
  );
  if (criado.rows.length > 0) return criado.rows[0].id;
  // corrida: outro pedido criou o mesmo produto entre o SELECT e o INSERT.
  const depois = await client.query('SELECT id FROM produtos WHERE codigo_sku = $1', [codigo_sku]);
  return depois.rows[0].id;
}

// "Como o orçamento estava montado" (estado, canal, descontos, preços
// editados - ver contextoDoOrcamento no index.html), guardado junto do pedido
// do app pra ele reabrir com os mesmos preços. Só objeto simples e pequeno;
// qualquer outra coisa vira NULL em vez de recusar o pedido.
const CONTEXTO_MAX_BYTES = 20000;
function contextoParaGravar(contexto) {
  if (!contexto || typeof contexto !== 'object' || Array.isArray(contexto)) return null;
  const json = JSON.stringify(contexto);
  return json.length <= CONTEXTO_MAX_BYTES ? json : null;
}

// Finaliza/grava um pedido. Corpo esperado:
// {
//   cliente: { cliente_id? , nome, documento?, contato? },
//   vendedor_nome?: "...",
//   observacao?: "...",
//   numero_cotacao?: "...",       // se vier e já existir, compara data (ver pdf_modificado_em) antes de decidir
//   data_pedido?: "2026-08-01",   // data original do documento, se souber (senão usa agora)
//   pdf_modificado_em?: "...",    // data de modificação do ARQUIVO PDF (metadado), pra saber qual versão é mais nova
//   origem?: "app" | "pdf",       // de onde veio esse registro
//   contexto?: { uf, canal, ... }, // como o orçamento estava montado (só pedido do app, pra reabrir e editar)
//   itens: [{ codigo_sku, quantidade, preco_unitario, descricao? }, ...]
// }
router.post('/', async (req, res) => {
  const { cliente, vendedor_nome, observacao, itens, numero_cotacao, data_pedido, pdf_modificado_em, origem, contexto } = req.body;
  if (!cliente || !cliente.nome) return res.status(400).json({ erro: 'Informe os dados do cliente (nome).' });
  if (!Array.isArray(itens) || itens.length === 0) return res.status(400).json({ erro: 'Informe ao menos um item.' });
  if (pdf_modificado_em && new Date(pdf_modificado_em) > new Date()) {
    return res.status(400).json({ erro: 'pdf_modificado_em não pode ser uma data futura.' });
  }

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // Duplicidade da cotação, checada DENTRO da transação com FOR UPDATE
    // (antes era antes do BEGIN: duas atualizações simultâneas da mesma
    // cotação liam o mesmo estado, as duas apagavam e regravavam os itens e
    // o pedido podia ficar com itens duplicados - item B2 do plano de
    // segurança). Com o lock, a segunda espera a primeira terminar e já
    // compara contra a versão que ela gravou. Duas cotações NOVAS iguais ao
    // mesmo tempo não têm linha pra travar - quem pega esse caso é o índice
    // único (idx_pedidos_numero_cotacao, tratado no catch).
    // Se a mesma cotação já foi consolidada antes, só substitui os itens se o
    // PDF novo for mais recente que o gravado (data de modificação do
    // arquivo, não a de emissão do documento - a emissão pode não mudar numa
    // reimpressão/correção, o metadado do arquivo sim). Sem essa informação
    // dos dois lados, mantém o comportamento antigo: recusa como duplicado.
    let pedidoParaAtualizar = null;
    if (numero_cotacao) {
      const existente = await client.query(
        'SELECT id, cliente_id, data_pedido, pdf_modificado_em, usuario_id FROM pedidos WHERE numero_cotacao = $1 FOR UPDATE',
        [numero_cotacao]
      );
      if (existente.rows.length > 0) {
        const atual = existente.rows[0];
        const novoEhMaisRecente = pdf_modificado_em && (!atual.pdf_modificado_em || new Date(pdf_modificado_em) > new Date(atual.pdf_modificado_em));
        if (!novoEhMaisRecente) {
          await client.query('ROLLBACK');
          return res.status(200).json({ ja_existia: true, pedido_id: atual.id, cliente_id: atual.cliente_id, data_pedido: atual.data_pedido });
        }
        // só o autor original (ou um admin) pode sobrescrever um pedido já
        // gravado - pedidos sem dono (importados antes dessa coluna existir,
        // ou vindos do relatório oficial) continuam sobrescrevíveis por
        // qualquer um, como sempre foi.
        if (atual.usuario_id && atual.usuario_id !== req.usuario.id && !req.usuario.is_admin) {
          await client.query('ROLLBACK');
          return res.status(403).json({ erro: 'Esse pedido já foi gravado por outro usuário — só ele ou um administrador pode atualizá-lo.' });
        }
        pedidoParaAtualizar = atual.id;
      }
    }

    const clienteId = await acharOuCriarCliente(client, cliente);
    const vendedorId = await acharOuCriarVendedor(client, vendedor_nome);
    const criarProdutosDesconhecidos = origem === 'pdf';
    const origemFinal = origem || 'app';
    const dataPedidoGravar = origemFinal === 'app' ? horaDoPedidoDoApp(data_pedido) : (data_pedido || null);

    let pedidoId, dataPedidoFinal, atualizado = false;
    if (pedidoParaAtualizar) {
      // PDF mais novo pra uma cotação já existente: atualiza o cabeçalho e
      // substitui os itens (apaga os antigos, grava os novos) em vez de criar
      // um pedido paralelo - fica um registro só por cotação, sempre a versão mais recente.
      const upd = await client.query(
        `UPDATE pedidos SET cliente_id = $1, vendedor_id = $2, observacao = $3,
                            data_pedido = COALESCE($4::timestamptz, data_pedido),
                            pdf_modificado_em = $5
         WHERE id = $6 RETURNING id, data_pedido`,
        [clienteId, vendedorId, observacao || null, dataPedidoGravar, pdf_modificado_em || null, pedidoParaAtualizar]
      );
      pedidoId = upd.rows[0].id;
      dataPedidoFinal = upd.rows[0].data_pedido;
      await client.query('DELETE FROM pedido_itens WHERE pedido_id = $1', [pedidoId]);
      atualizado = true;
    } else {
      const pedidoResult = await client.query(
        `INSERT INTO pedidos (cliente_id, vendedor_id, observacao, numero_cotacao, origem, data_pedido, pdf_modificado_em, usuario_id, contexto)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7, $8, $9::jsonb)
         RETURNING id, data_pedido`,
        [clienteId, vendedorId, observacao || null, numero_cotacao || null, origemFinal, dataPedidoGravar, pdf_modificado_em || null, req.usuario.id, contextoParaGravar(contexto)]
      );
      pedidoId = pedidoResult.rows[0].id;
      dataPedidoFinal = pedidoResult.rows[0].data_pedido;
    }

    for (const item of itens) {
      const produtoId = await acharOuCriarProdutoPorSku(client, item.codigo_sku, criarProdutosDesconhecidos ? item.descricao : null);
      await client.query(
        'INSERT INTO pedido_itens (pedido_id, produto_id, quantidade, preco_unitario) VALUES ($1, $2, $3, $4)',
        [pedidoId, produtoId, item.quantidade, item.preco_unitario]
      );
    }

    await client.query('COMMIT');
    console.log(`Pedido #${pedidoId} ${atualizado ? 'ATUALIZADO (versão mais nova do PDF)' : 'gravado'} (cliente ${clienteId}, ${itens.length} item(ns))${numero_cotacao ? ` [cotação ${numero_cotacao}]` : ''}.`);
    res.status(201).json({ pedido_id: pedidoId, cliente_id: clienteId, data_pedido: dataPedidoFinal, atualizado });
  } catch (e) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { console.error('Erro no rollback:', rollbackErr); }
    }
    if (e.code === '23505' && e.constraint === 'idx_pedidos_numero_cotacao') {
      // corrida rara: dois envios da mesma cotação quase ao mesmo tempo
      return res.status(200).json({ ja_existia: true, erro_corrida: true });
    }
    console.error(e);
    // e.code só existe em erro vindo direto do driver do Postgres (ex: violação
    // de constraint) - esse detalhe não vai pro cliente. Erro lançado por nós
    // mesmos (ex: "Produto com código X não encontrado") não tem .code e é uma
    // mensagem pensada pra quem está usando o app ler.
    res.status(400).json({ erro: !e.code && e.message ? e.message : 'Erro ao gravar pedido.' });
  } finally {
    if (client) client.release();
  }
});

// Pedidos que o próprio vendedor fechou no app nos últimos DIAS_PEDIDOS_SALVOS
// dias, com os itens - lista do "🧾 Pedidos" (reabrir pra editar quando o
// cliente quer mudar alguma coisa, em vez de fechar outro pedido) e base pra
// reconhecer um CSV de pedido aberto de volta no app (mesmos códigos e
// quantidades = mesmo pedido). Só origem 'app': cotação em PDF tem a versão
// dela no próprio PDF. Os dados do cliente vêm junto pro app selecionar o
// cliente com canal/classificatório ao reabrir.
const DIAS_PEDIDOS_SALVOS = 120;
const LIMITE_PEDIDOS_SALVOS = 150;
router.get('/salvos', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ped.id, ped.data_pedido, ped.atualizado_em, ped.contexto,
              c.id AS cliente_id, c.nome AS cliente_nome, c.documento AS cliente_documento,
              c.classificatorio_tipo, c.classificatorio_desconto, c.codigo_oficial,
              json_agg(json_build_object('codigo_sku', pr.codigo_sku, 'quantidade', pi.quantidade,
                                         'preco_unitario', pi.preco_unitario) ORDER BY pi.id) AS itens
       FROM pedidos ped
       JOIN clientes c ON c.id = ped.cliente_id
       JOIN pedido_itens pi ON pi.pedido_id = ped.id
       JOIN produtos pr ON pr.id = pi.produto_id
       WHERE ped.origem = 'app' AND ped.usuario_id = $1
         AND COALESCE(ped.atualizado_em, ped.data_pedido) >= now() - make_interval(days => $2)
       GROUP BY ped.id, c.id
       ORDER BY COALESCE(ped.atualizado_em, ped.data_pedido) DESC
       LIMIT $3`,
      [req.usuario.id, DIAS_PEDIDOS_SALVOS, LIMITE_PEDIDOS_SALVOS]
    );
    res.json({ dias: DIAS_PEDIDOS_SALVOS, pedidos: result.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar os pedidos salvos.' });
  }
});

// Itens de um pedido vindos do app: código, quantidade > 0 e preço >= 0.
function itensValidos(itens) {
  return Array.isArray(itens) && itens.length > 0 && itens.every(it => it
    && typeof it.codigo_sku === 'string' && it.codigo_sku.trim() !== ''
    && Number.isFinite(Number(it.quantidade)) && Number(it.quantidade) > 0
    && Number.isFinite(Number(it.preco_unitario)) && Number(it.preco_unitario) >= 0);
}

// Atualiza um pedido do app já gravado (reaberto pra editar): troca os itens
// e o contexto, marca atualizado_em e mantém o mesmo id, cliente e data do
// pedido - um registro só por pedido, em vez de um novo a cada mudança do
// cliente. Só o autor (ou um admin) e só pedido com origem 'app'. Corpo:
// { itens: [{ codigo_sku, quantidade, preco_unitario }], contexto?, vendedor_nome?, observacao? }
router.patch('/:id', async (req, res) => {
  const { itens, contexto, vendedor_nome, observacao } = req.body || {};
  if (!itensValidos(itens)) return res.status(400).json({ erro: 'Informe ao menos um item, com código, quantidade e preço.' });

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // FOR UPDATE: duas atualizações do mesmo pedido ao mesmo tempo (ex.: a
    // fila offline reenviando) não regravam os itens em paralelo.
    const atualResult = await client.query(
      'SELECT id, cliente_id, origem, usuario_id FROM pedidos WHERE id = $1 FOR UPDATE',
      [req.params.id]
    );
    const atual = atualResult.rows[0];
    if (!atual) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Pedido não encontrado — pode ter sido excluído.' });
    }
    if (atual.origem !== 'app') {
      await client.query('ROLLBACK');
      return res.status(400).json({ erro: 'Só pedido fechado no app pode ser editado por aqui.' });
    }
    if (atual.usuario_id !== req.usuario.id && !req.usuario.is_admin) {
      await client.query('ROLLBACK');
      return res.status(403).json({ erro: 'Esse pedido foi gravado por outro usuário — só ele ou um administrador pode alterá-lo.' });
    }

    // acha todos os produtos antes de apagar os itens antigos: código que não
    // existe recusa a edição já aqui, com o pedido intacto
    const produtoIds = [];
    for (const item of itens) produtoIds.push(await acharOuCriarProdutoPorSku(client, item.codigo_sku.trim(), null));
    const vendedorId = await acharOuCriarVendedor(client, vendedor_nome);
    const upd = await client.query(
      `UPDATE pedidos SET contexto = $1::jsonb, atualizado_em = now(),
                          vendedor_id = COALESCE($2, vendedor_id), observacao = COALESCE($3, observacao)
       WHERE id = $4 RETURNING id, cliente_id, data_pedido, atualizado_em`,
      [contextoParaGravar(contexto), vendedorId, observacao || null, atual.id]
    );
    await client.query('DELETE FROM pedido_itens WHERE pedido_id = $1', [atual.id]);
    for (let i = 0; i < itens.length; i++) {
      await client.query(
        'INSERT INTO pedido_itens (pedido_id, produto_id, quantidade, preco_unitario) VALUES ($1, $2, $3, $4)',
        [atual.id, produtoIds[i], Number(itens[i].quantidade), Number(itens[i].preco_unitario)]
      );
    }

    await client.query('COMMIT');
    const pedido = upd.rows[0];
    console.log(`Pedido #${pedido.id} EDITADO no app (cliente ${pedido.cliente_id}, ${itens.length} item(ns)).`);
    res.json({ pedido_id: pedido.id, cliente_id: pedido.cliente_id, data_pedido: pedido.data_pedido, atualizado_em: pedido.atualizado_em, atualizado: true });
  } catch (e) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { console.error('Erro no rollback:', rollbackErr); }
    }
    console.error(e);
    res.status(400).json({ erro: !e.code && e.message ? e.message : 'Erro ao atualizar pedido.' });
  } finally {
    if (client) client.release();
  }
});

// A antiga importação de "relatório de faturamento" (.xlsx só com a aba
// Faturamento, sem NF/transportadora/valor, gravando em pedidos/pedido_itens
// com origem='faturamento') foi retirada daqui - substituída pela importação
// unificada da planilha oficial (Carteira + Faturamento, com todos os dados)
// em POST /api/pedidos-oficiais/importar. Pedidos antigos com
// origem='faturamento' continuam no histórico normalmente, só não é mais
// possível criar novos por essa rota.

// Encontra pedidos "prováveis duplicados": mesmo cliente, mesmo dia, com pelo
// menos um produto em comum com outro pedido do mesmo cliente naquele dia.
// Acontece quando a mesma venda entra por dois caminhos diferentes (ex: o
// vendedor finaliza no app na hora, e depois o mesmo pedido aparece de novo
// ao importar o relatório de faturamento oficial - cada caminho tem sua
// própria identificação, então o bloqueio automático de duplicata não pega
// esse caso entre origens diferentes).
router.get('/duplicados', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode ver pedidos duplicados.' });
  try {
    const result = await pool.query(`
      /* pedidos:duplicados */
      SELECT ped.id AS pedido_id, ped.cliente_id, c.nome AS cliente_nome,
             ped.data_pedido, ${sqlDiaDoPedido()}::text AS dia, ped.origem, ped.numero_cotacao,
             json_agg(json_build_object('codigo_sku', pr.codigo_sku, 'produto', pr.nome, 'quantidade', pi.quantidade) ORDER BY pr.nome) AS itens
      FROM pedidos ped
      JOIN clientes c ON c.id = ped.cliente_id
      JOIN pedido_itens pi ON pi.pedido_id = ped.id
      JOIN produtos pr ON pr.id = pi.produto_id
      WHERE ped.id IN (
        SELECT DISTINCT p2.id
        FROM pedidos p2
        JOIN pedido_itens pi2 ON pi2.pedido_id = p2.id
        WHERE EXISTS (
          SELECT 1 FROM pedidos p3
          JOIN pedido_itens pi3 ON pi3.pedido_id = p3.id
          WHERE p3.id <> p2.id
            AND p3.cliente_id = p2.cliente_id
            AND ${sqlDiaDoPedido('p3')} = ${sqlDiaDoPedido('p2')}
            AND pi3.produto_id = pi2.produto_id
        )
      )
      GROUP BY ped.id, ped.cliente_id, c.nome, ped.data_pedido, ped.origem, ped.numero_cotacao
      ORDER BY ped.cliente_id, dia DESC, ped.data_pedido DESC
    `);
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar pedidos duplicados.' });
  }
});

// Exclui um pedido específico (e seus itens) - usado pra limpar duplicata
// depois de revisar manualmente. Só admin - é destrutivo de histórico real.
router.delete('/:id', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode excluir pedido.' });
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('DELETE FROM pedido_itens WHERE pedido_id = $1', [req.params.id]);
    const result = await client.query('DELETE FROM pedidos WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Pedido não encontrado.' });
    }
    await client.query('COMMIT');
    console.log(`Pedido #${req.params.id} excluído por ${req.usuario?.email}.`);
    res.json({ ok: true });
  } catch (e) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { console.error('Erro no rollback:', rollbackErr); }
    }
    console.error(e);
    res.status(500).json({ erro: 'Erro ao excluir pedido.' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
module.exports.horaDoPedidoDoApp = horaDoPedidoDoApp;
