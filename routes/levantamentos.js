const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { acharOuCriarCliente } = require('../clientMatcher');
const { validarIdInteiro } = require('../middleware/validarId');

router.param('id', validarIdInteiro);
async function acharOuCriarVendedor(client, nomeVendedor) {
  if (!nomeVendedor) return null;
  const existing = await client.query('SELECT id FROM vendedores WHERE nome = $1', [nomeVendedor]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const result = await client.query(
    'INSERT INTO vendedores (nome) VALUES ($1) ON CONFLICT (nome) DO NOTHING RETURNING id',
    [nomeVendedor]
  );
  if (result.rows.length > 0) return result.rows[0].id;
  // corrida: outro levantamento criou o mesmo vendedor entre o SELECT e o INSERT.
  const depois = await client.query('SELECT id FROM vendedores WHERE nome = $1', [nomeVendedor]);
  return depois.rows[0].id;
}
async function acharProdutoPorSku(client, codigo_sku) {
  const result = await client.query('SELECT id FROM produtos WHERE codigo_sku = $1', [codigo_sku]);
  if (result.rows.length === 0) {
    throw new Error(`Produto com código ${codigo_sku} não encontrado - rode /api/produtos/sync primeiro.`);
  }
  return result.rows[0].id;
}

// Localização da loja - só leitura de GPS boa o bastante (até 100 m) vira a
// posição do cliente; a atual só é trocada por uma igual ou mais precisa, ou
// se tiver mais de 180 dias (loja pode ter mudado de endereço).
const LOCALIZACAO_PRECISAO_MAX_M = 100;
const LOCALIZACAO_VALIDADE_DIAS = 180;

// Aceita { latitude, longitude, precisao_m } vindo do celular. Qualquer coisa
// fora disso vira null - localização é bônus, nunca motivo pra recusar o
// levantamento.
function lerLocalizacao(loc) {
  if (!loc || typeof loc !== 'object') return null;
  const { latitude, longitude, precisao_m: precisao } = loc;
  // typeof em vez de Number(): Number(null) e Number('') viram 0, que é uma
  // coordenada válida (no meio do Atlântico) e passaria pela checagem.
  if (typeof latitude !== 'number' || typeof longitude !== 'number' || typeof precisao !== 'number') return null;
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  if (!Number.isFinite(precisao) || precisao < 0) return null;
  return { latitude, longitude, precisao_m: precisao };
}

// Grava um levantamento de estoque feito na visita ao cliente. Corpo esperado:
// {
//   cliente: { cliente_id?, nome, documento?, contato? },
//   vendedor_nome?: "...",
//   nome_levantamento?: "...",
//   itens: [{ codigo_sku, quantidade_contada }, ...],
//   localizacao?: { latitude, longitude, precisao_m }  // GPS no momento de salvar
// }
router.post('/', async (req, res) => {
  const { cliente, vendedor_nome, nome_levantamento, itens } = req.body;
  const localizacao = lerLocalizacao(req.body.localizacao);
  if (!cliente || !cliente.nome) return res.status(400).json({ erro: 'Informe os dados do cliente (nome).' });
  if (!Array.isArray(itens) || itens.length === 0) return res.status(400).json({ erro: 'Informe ao menos um item.' });

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const clienteId = await acharOuCriarCliente(client, cliente);
    const vendedorId = await acharOuCriarVendedor(client, vendedor_nome);

    const levResult = await client.query(
      `INSERT INTO levantamentos (cliente_id, vendedor_id, nome, latitude, longitude, localizacao_precisao_m)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, data_visita`,
      [clienteId, vendedorId, nome_levantamento || null,
        localizacao ? localizacao.latitude : null, localizacao ? localizacao.longitude : null, localizacao ? localizacao.precisao_m : null]
    );
    const levantamentoId = levResult.rows[0].id;

    for (const item of itens) {
      const produtoId = await acharProdutoPorSku(client, item.codigo_sku);
      await client.query(
        'INSERT INTO levantamento_itens (levantamento_id, produto_id, quantidade_contada) VALUES ($1, $2, $3)',
        [levantamentoId, produtoId, item.quantidade_contada]
      );
    }

    let localizacaoRegistrada = false;
    if (localizacao && localizacao.precisao_m <= LOCALIZACAO_PRECISAO_MAX_M) {
      // a regra de substituição fica no WHERE - sem SELECT antes, sem corrida
      // entre dois levantamentos do mesmo cliente salvos ao mesmo tempo.
      const upd = await client.query(
        `UPDATE clientes SET latitude = $2, longitude = $3, localizacao_precisao_m = $4, localizacao_atualizada_em = now()
         WHERE id = $1
           AND (latitude IS NULL
             OR localizacao_precisao_m IS NULL
             OR $4 <= localizacao_precisao_m
             OR localizacao_atualizada_em < now() - make_interval(days => $5))`,
        [clienteId, localizacao.latitude, localizacao.longitude, localizacao.precisao_m, LOCALIZACAO_VALIDADE_DIAS]
      );
      localizacaoRegistrada = upd.rowCount > 0;
    }

    await client.query('COMMIT');
    console.log(`Levantamento #${levantamentoId} gravado (cliente ${clienteId}, ${itens.length} item(ns)).`);
    res.status(201).json({
      levantamento_id: levantamentoId,
      cliente_id: clienteId,
      data_visita: levResult.rows[0].data_visita,
      localizacao_registrada: localizacaoRegistrada,
    });
  } catch (e) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { console.error('Erro no rollback:', rollbackErr); }
    }
    console.error(e);
    res.status(400).json({ erro: !e.code && e.message ? e.message : 'Erro ao gravar levantamento.' });
  } finally {
    if (client) client.release();
  }
});

// Rascunho de levantamento em andamento, por usuário - reforço do autosave
// que já existe no localStorage do aparelho (sobrevive a trocar de aparelho,
// reinstalar o app, ou limpar dados do navegador). Sobrescrito por completo
// a cada chamada (upsert), sem histórico - é só "o que está em andamento".
router.post('/rascunho', async (req, res) => {
  const { valor } = req.body;
  if (valor === undefined) return res.status(400).json({ erro: 'Envie { valor: ... }' });
  try {
    await pool.query(
      `INSERT INTO levantamento_rascunhos (usuario_id, rascunho, atualizado_em) VALUES ($1, $2, now())
       ON CONFLICT (usuario_id) DO UPDATE SET rascunho = EXCLUDED.rascunho, atualizado_em = now()`,
      [req.usuario.id, JSON.stringify(valor)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao salvar rascunho.' });
  }
});

router.get('/rascunho', async (req, res) => {
  try {
    const result = await pool.query('SELECT rascunho, atualizado_em FROM levantamento_rascunhos WHERE usuario_id = $1', [req.usuario.id]);
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Nenhum rascunho salvo.' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar rascunho.' });
  }
});

router.delete('/rascunho', async (req, res) => {
  try {
    await pool.query('DELETE FROM levantamento_rascunhos WHERE usuario_id = $1', [req.usuario.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao apagar rascunho.' });
  }
});

// Itens de um levantamento já gravado - usado como fallback quando a cópia
// local (localStorage, só no aparelho que salvou) não tem os itens na hora
// de reabrir (ex.: a gravação local falhou silenciosamente por limite de
// espaço do navegador, mesmo o levantamento tendo sido gravado com sucesso
// aqui no servidor).
router.get('/:id/itens', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.codigo_sku, li.quantidade_contada
       FROM levantamento_itens li
       JOIN produtos p ON p.id = li.produto_id
       WHERE li.levantamento_id = $1
       ORDER BY li.id`,
      [req.params.id]
    );
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar itens do levantamento.' });
  }
});

module.exports = router;
