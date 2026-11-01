// Índice de fotos pro reconhecimento por foto ("📷 Pela etiqueta", 11/2026).
// O celular calcula o vetor da foto da embalagem (DINOv2-small, no aparelho) e
// compara com este índice pra mandar ao Gemini só os ~30 produtos mais parecidos
// (ele escolhe dentro da lista) e, sem internet, sugerir os 5 primeiros.
// - GET /versao: barato, pro aparelho saber se precisa baixar de novo
// - GET /: o índice inteiro do modelo atual (~1 MB pra ~1.800 fotos); ?desde=<ms> só o que mudou
//   depois disso (cada foto de etiqueta confirmada mudaria a versão e faria todo aparelho baixar
//   o índice inteiro de novo: egress do Supabase)
// - POST /catalogo (admin): vetores das fotos do catálogo, gerados no Painel
// - POST /loja: foto de etiqueta que o vendedor confirmou (até 8 por código)
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { pool } = require('../db');
const { lerComCache, esquecerTabela } = require('./lib/cacheTabela');
const { MODELO_VETOR, CODIGO_SKU_REGEX, vetorValido } = require('./lib/vetoresFoto');

const CATALOGO_POR_PEDIDO = 200;
const LOJA_POR_CODIGO = 8;

const lojaLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.usuario?.id || req.ip),
  message: { erro: 'Muitas fotos de etiqueta guardadas em pouco tempo.' },
});

router.get('/versao', async (req, res) => {
  try {
    const r = await pool.query(
      `/* VETORES:VERSAO */ SELECT count(*)::int AS n, (EXTRACT(EPOCH FROM max(atualizado_em)) * 1000)::bigint AS ultimo
       FROM produto_vetores WHERE modelo = $1`, [MODELO_VETOR]);
    const { n, ultimo } = r.rows[0] || {};
    res.json({ modelo: MODELO_VETOR, versao: `${n || 0}-${ultimo || 0}`, total: n || 0, ultimo: Number(ultimo) || 0 });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao ler a versão do índice de fotos.' });
  }
});

const COLUNAS_LISTA = `id, codigo_sku, origem, foto_versao, encode(vetor, 'base64') AS v`;
router.get('/', async (req, res) => {
  const desde = req.query.desde == null ? null : Number(req.query.desde);
  if (desde != null && !(Number.isSafeInteger(desde) && desde >= 0)) return res.status(422).json({ erro: 'Parâmetro desde inválido.' });
  try {
    // modelo vem da constante (não do usuário): pode ir no texto da consulta, que é a chave do cache
    const rows = desde == null
      ? await lerComCache(`vetores:${MODELO_VETOR}`, 'produto_vetores',
        `/* VETORES:LISTA */ SELECT ${COLUNAS_LISTA} FROM produto_vetores WHERE modelo = '${MODELO_VETOR}' ORDER BY id`)
      : (await pool.query(`/* VETORES:DESDE */ SELECT ${COLUNAS_LISTA} FROM produto_vetores
          WHERE modelo = $1 AND atualizado_em > to_timestamp($2 / 1000.0) ORDER BY id`, [MODELO_VETOR, desde])).rows;
    // com ?desde=, os ids que existem hoje (~10 KB): o aparelho tira os que o servidor apagou (foto
    // retirada, foto de loja além das 8) sem baixar o índice inteiro de novo
    const ids = desde == null ? undefined
      : (await pool.query(`/* VETORES:IDS */ SELECT id FROM produto_vetores WHERE modelo = $1`, [MODELO_VETOR])).rows.map(r => Number(r.id));
    res.json({
      modelo: MODELO_VETOR,
      vetores: rows.map(r => ({ id: Number(r.id), c: r.codigo_sku, o: r.origem, f: r.foto_versao == null ? null : Number(r.foto_versao), v: r.v })),
      ...(ids ? { ids } : {}),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao ler o índice de fotos.' });
  }
});

router.post('/catalogo', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador gera o índice de fotos.' });
  const { modelo, vetores } = req.body || {};
  if (modelo !== MODELO_VETOR) return res.status(422).json({ erro: 'Modelo de reconhecimento diferente do servidor — atualize o app.' });
  if (!Array.isArray(vetores) || !vetores.length || vetores.length > CATALOGO_POR_PEDIDO) {
    return res.status(422).json({ erro: `Envie de 1 a ${CATALOGO_POR_PEDIDO} vetores.` });
  }
  const cods = [], bufs = [], versoes = [];
  for (const x of vetores) {
    const buf = x && vetorValido(x.v);
    const f = Number(x && x.f);
    if (!buf || !CODIGO_SKU_REGEX.test(String(x.c || '')) || !Number.isSafeInteger(f) || f < 0) {
      return res.status(422).json({ erro: 'Vetor inválido no índice.' });
    }
    cods.push(String(x.c)); bufs.push(buf.toString('base64')); versoes.push(f);
  }
  try {
    const r = await pool.query(
      `/* VETORES:CATALOGO */ INSERT INTO produto_vetores (codigo_sku, origem, modelo, vetor, foto_versao, criado_por)
       SELECT t.c, 'catalogo', $1, decode(t.v, 'base64'), t.f, $5
       FROM UNNEST($2::text[], $3::text[], $4::bigint[]) AS t(c, v, f)
       WHERE EXISTS (SELECT 1 FROM produto_fotos pf WHERE pf.codigo_sku = t.c)
       ON CONFLICT (codigo_sku, modelo) WHERE origem = 'catalogo'
       DO UPDATE SET vetor = EXCLUDED.vetor, foto_versao = EXCLUDED.foto_versao, criado_por = EXCLUDED.criado_por, atualizado_em = now()`,
      [MODELO_VETOR, cods, bufs, versoes, req.usuario.id]);
    // foto que saiu do produto: o vetor dela sai do índice
    await pool.query(
      `/* VETORES:SEM_FOTO */ DELETE FROM produto_vetores v WHERE v.origem = 'catalogo'
       AND NOT EXISTS (SELECT 1 FROM produto_fotos pf WHERE pf.codigo_sku = v.codigo_sku)`);
    esquecerTabela('produto_vetores');
    res.json({ gravados: r.rowCount });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao gravar o índice de fotos.' });
  }
});

router.post('/loja', lojaLimiter, async (req, res) => {
  const { modelo, c, v } = req.body || {};
  if (modelo !== MODELO_VETOR) return res.status(422).json({ erro: 'Modelo de reconhecimento diferente do servidor — atualize o app.' });
  const buf = vetorValido(v);
  const sku = String(c || '');
  if (!buf || !CODIGO_SKU_REGEX.test(sku)) return res.status(422).json({ erro: 'Foto de etiqueta inválida.' });
  try {
    // só grava código que está no catálogo (uma ida ao banco: Render em Oregon, Supabase em São Paulo)
    const ins = await pool.query(
      `/* VETORES:LOJA */ INSERT INTO produto_vetores (codigo_sku, origem, modelo, vetor, criado_por)
       SELECT $1, 'loja', $2, $3, $4
       WHERE EXISTS (SELECT 1 FROM catalogo_precos WHERE codigo_sku = $1) OR EXISTS (SELECT 1 FROM produtos WHERE codigo_sku = $1)`,
      [sku, MODELO_VETOR, buf, req.usuario ? req.usuario.id : null]);
    if (!ins.rowCount) return res.status(422).json({ erro: 'Produto não está no catálogo.' });
    // só as mais recentes de cada código (o índice que todo aparelho baixa não cresce sem fim)
    await pool.query(
      `/* VETORES:LOJA_LIMITE */ DELETE FROM produto_vetores WHERE origem = 'loja' AND codigo_sku = $1 AND modelo = $2
       AND id NOT IN (SELECT id FROM produto_vetores WHERE origem = 'loja' AND codigo_sku = $1 AND modelo = $2 ORDER BY id DESC LIMIT $3)`,
      [sku, MODELO_VETOR, LOJA_POR_CODIGO]);
    esquecerTabela('produto_vetores');
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao guardar a foto da etiqueta.' });
  }
});

module.exports = router;
