// Fotos dos produtos pro card de oferta da aba Produtos (10/2026). Qualquer
// vendedor logado cadastra, troca ou tira a foto (decisão do usuário) - pelo
// Painel ou na hora, com a câmera. O app reduz a imagem no celular e manda um
// JPEG pequeno (cabe no limite de 1 MB do JSON); aqui só confere que é JPEG
// de verdade e o tamanho.
//
// O catálogo antigo de fotos saiu por mostrar foto de um produto em outro: por
// isso a foto fica presa ao código que o vendedor viu na tela ao salvar, e a
// cópia pras variações (mesmo grupoDoProduto) só vai pra quem ainda não tem foto.
//
// A imagem só sai com login (o app baixa com o token e guarda no aparelho pra
// funcionar sem internet); a lista devolve a versão de cada foto (hora da
// última troca) pra o app saber quando baixar de novo.
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { grupoDoProduto } = require('./lib/agrupamentoProduto');

const CODIGO_SKU_REGEX = /^[A-Za-z0-9._-]{1,30}$/;
const FOTO_MIN_BYTES = 1024;
const FOTO_MAX_BYTES = 600 * 1024;
const VARIACOES_MAX = 60;

function ehJpeg(buf) {
  return buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
}
function chaveGrupo(nome) {
  return grupoDoProduto(nome).chave;
}

// { fotos: { "61366": 1760000000000, ... } } - versão = hora da troca em ms
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `/* FOTOS:LISTA */ SELECT codigo_sku, (EXTRACT(EPOCH FROM atualizado_em) * 1000)::bigint AS versao FROM produto_fotos`
    );
    const fotos = {};
    for (const row of r.rows) fotos[row.codigo_sku] = Number(row.versao);
    res.json({ fotos });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao listar as fotos dos produtos.' });
  }
});

// Variações do mesmo produto (mesmo grupoDoProduto), com e sem foto - a janela
// de foto oferece "Usar nas N variações" com as que ainda não têm.
router.get('/:sku/variacoes', async (req, res) => {
  const sku = String(req.params.sku || '');
  if (!CODIGO_SKU_REGEX.test(sku)) return res.status(400).json({ erro: 'Código de produto inválido.' });
  try {
    const r = await pool.query(
      `/* FOTOS:VARIACOES */ SELECT p.codigo_sku, p.nome, (f.codigo_sku IS NOT NULL) AS tem_foto
       FROM produtos p LEFT JOIN produto_fotos f ON f.codigo_sku = p.codigo_sku`
    );
    const doProduto = r.rows.find(x => x.codigo_sku === sku);
    if (!doProduto) return res.json({ variacoes: [] });
    const grupo = chaveGrupo(doProduto.nome);
    const variacoes = r.rows
      .filter(x => x.codigo_sku !== sku && chaveGrupo(x.nome) === grupo)
      .map(x => ({ codigo_sku: x.codigo_sku, nome: x.nome, tem_foto: !!x.tem_foto }))
      .sort((a, b) => a.codigo_sku.localeCompare(b.codigo_sku));
    res.json({ variacoes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar as variações do produto.' });
  }
});

router.get('/:sku', async (req, res) => {
  const sku = String(req.params.sku || '');
  if (!CODIGO_SKU_REGEX.test(sku)) return res.status(400).json({ erro: 'Código de produto inválido.' });
  try {
    const r = await pool.query(`/* FOTOS:IMAGEM */ SELECT imagem FROM produto_fotos WHERE codigo_sku = $1`, [sku]);
    if (!r.rows.length) return res.status(404).json({ erro: 'Produto sem foto.' });
    res.set('Content-Type', 'image/jpeg');
    // o app pede com ?v=<versão>: o mesmo endereço nunca muda de conteúdo
    res.set('Cache-Control', 'private, max-age=31536000, immutable');
    res.send(r.rows[0].imagem);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar a foto do produto.' });
  }
});

// { imagem: base64 do JPEG (com ou sem "data:image/jpeg;base64,"), variacoes: [códigos] }
router.put('/:sku', async (req, res) => {
  const sku = String(req.params.sku || '');
  if (!CODIGO_SKU_REGEX.test(sku)) return res.status(422).json({ erro: 'Código de produto inválido.' });
  const texto = typeof req.body?.imagem === 'string' ? req.body.imagem.replace(/^data:image\/jpeg;base64,/, '') : '';
  if (!texto || !/^[A-Za-z0-9+/=\s]+$/.test(texto)) return res.status(422).json({ erro: 'Imagem não enviada.' });
  const imagem = Buffer.from(texto, 'base64');
  if (!ehJpeg(imagem)) return res.status(422).json({ erro: 'A foto precisa ser JPEG.' });
  if (imagem.length < FOTO_MIN_BYTES || imagem.length > FOTO_MAX_BYTES) {
    return res.status(422).json({ erro: `Foto com tamanho fora do limite (até ${Math.round(FOTO_MAX_BYTES / 1024)} KB).` });
  }
  const pedidas = Array.isArray(req.body?.variacoes) ? req.body.variacoes.map(String) : [];
  if (pedidas.length > VARIACOES_MAX || pedidas.some(c => !CODIGO_SKU_REGEX.test(c))) {
    return res.status(422).json({ erro: 'Lista de variações inválida.' });
  }
  const variacoes = [...new Set(pedidas.filter(c => c !== sku))];
  const usuarioId = req.usuario ? req.usuario.id : null;
  try {
    const existe = await pool.query(
      `/* FOTOS:PRODUTOS */ SELECT codigo_sku FROM produtos WHERE codigo_sku = ANY($1::text[])`, [[sku, ...variacoes]]
    );
    const conhecidos = new Set(existe.rows.map(r => r.codigo_sku));
    if (!conhecidos.has(sku)) return res.status(404).json({ erro: 'Produto não encontrado no catálogo.' });
    const r = await pool.query(
      `/* FOTOS:GRAVAR */ INSERT INTO produto_fotos (codigo_sku, imagem, tamanho, atualizado_em, atualizado_por)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (codigo_sku) DO UPDATE SET imagem = EXCLUDED.imagem, tamanho = EXCLUDED.tamanho,
         atualizado_em = now(), atualizado_por = EXCLUDED.atualizado_por
       RETURNING (EXTRACT(EPOCH FROM atualizado_em) * 1000)::bigint AS versao`,
      [sku, imagem, imagem.length, usuarioId]
    );
    // variação que já tem foto (talvez de outro ângulo/tamanho) não é trocada
    const paraVariacoes = variacoes.filter(c => conhecidos.has(c));
    let aplicadas = [];
    if (paraVariacoes.length) {
      const v = await pool.query(
        `/* FOTOS:VARIACOES_GRAVAR */ INSERT INTO produto_fotos (codigo_sku, imagem, tamanho, atualizado_em, atualizado_por)
         SELECT c, $2, $3, now(), $4 FROM UNNEST($1::text[]) AS c
         ON CONFLICT (codigo_sku) DO NOTHING
         RETURNING codigo_sku`,
        [paraVariacoes, imagem, imagem.length, usuarioId]
      );
      aplicadas = v.rows.map(x => x.codigo_sku);
    }
    res.json({ codigo_sku: sku, versao: Number(r.rows[0].versao), variacoes: aplicadas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao salvar a foto do produto.' });
  }
});

router.delete('/:sku', async (req, res) => {
  const sku = String(req.params.sku || '');
  if (!CODIGO_SKU_REGEX.test(sku)) return res.status(422).json({ erro: 'Código de produto inválido.' });
  try {
    await pool.query(`/* FOTOS:APAGAR */ DELETE FROM produto_fotos WHERE codigo_sku = $1`, [sku]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao tirar a foto do produto.' });
  }
});

module.exports = router;
