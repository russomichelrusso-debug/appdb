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
const { gerarMiniaturaSemTravar } = require('./lib/miniaturaFoto');
const { fotoDoSkuNaPagina, URL_FOTO } = require('./lib/fichasSite');

const CODIGO_SKU_REGEX = /^[A-Za-z0-9._-]{1,30}$/;
const FOTO_MIN_BYTES = 1024;
const FOTO_MAX_BYTES = 600 * 1024;
const VARIACOES_MAX = 60;
const MINIATURAS_POR_PEDIDO = 100; // códigos por pedido do app
const MINIATURAS_GERAR_POR_PEDIDO = 15; // geradas na hora por pedido (~0,2-0,5 s cada no Render)

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

// ---- Miniaturas pro catálogo sem internet (10/2026) ----
// A miniatura é gerada na primeira vez que alguém pede e fica no banco; só
// grava se a foto não foi trocada no meio (mesma versão). Foto que não dá pra
// ler grava miniatura vazia (0 bytes): não é decodificada de novo a cada
// pedido (o app fica com a foto cheia); trocar a foto zera. Dois vendedores
// pedindo a mesma ao mesmo tempo esperam a mesma geração.
const geracoesEmAndamento = new Map(); // "sku@versão" -> Promise
function miniaturaGerada(sku, versao) {
  const chave = `${sku}@${versao}`;
  if (!geracoesEmAndamento.has(chave)) {
    const p = gerarEGravarMiniatura(sku, versao).finally(() => geracoesEmAndamento.delete(chave));
    geracoesEmAndamento.set(chave, p);
  }
  return geracoesEmAndamento.get(chave);
}
async function gerarEGravarMiniatura(sku, versao) {
  const r = await pool.query(
    `/* FOTOS:IMAGEM_PRA_MINI */ SELECT imagem FROM produto_fotos
     WHERE codigo_sku = $1 AND (EXTRACT(EPOCH FROM atualizado_em) * 1000)::bigint = $2`, [sku, versao]
  );
  if (!r.rows.length) return null;
  const mini = await gerarMiniaturaSemTravar(r.rows[0].imagem);
  if (mini === undefined) return null; // thread caiu/passou do prazo: tenta no próximo pedido
  await pool.query(
    `/* FOTOS:MINIATURA_GRAVAR */ UPDATE produto_fotos SET miniatura = $2
     WHERE codigo_sku = $1 AND (EXTRACT(EPOCH FROM atualizado_em) * 1000)::bigint = $3`, [sku, mini || Buffer.alloc(0), versao]
  );
  return mini;
}

// { codigos: [...] } -> { miniaturas: { "61366": { v: versão, img: base64 } }, faltam: N }
// "faltam" = do pedido que ainda não tinham miniatura e ficaram pra próxima
// (gera no máximo MINIATURAS_GERAR_POR_PEDIDO por vez). Foto que não dá pra
// ler fica de fora (o app usa a foto cheia).
router.post('/miniaturas', async (req, res) => {
  const pedidos = Array.isArray(req.body?.codigos) ? [...new Set(req.body.codigos.map(String))] : [];
  if (!pedidos.length || pedidos.length > MINIATURAS_POR_PEDIDO || pedidos.some(c => !CODIGO_SKU_REGEX.test(c))) {
    return res.status(422).json({ erro: `Mande de 1 a ${MINIATURAS_POR_PEDIDO} códigos.` });
  }
  try {
    const r = await pool.query(
      `/* FOTOS:MINIATURAS */ SELECT codigo_sku, (EXTRACT(EPOCH FROM atualizado_em) * 1000)::bigint AS versao, miniatura
       FROM produto_fotos WHERE codigo_sku = ANY($1::text[])`, [pedidos]
    );
    const miniaturas = {};
    let gerar = MINIATURAS_GERAR_POR_PEDIDO, faltam = 0;
    for (const row of r.rows) {
      const versao = Number(row.versao);
      let mini = row.miniatura;
      if (mini && mini.length === 0) continue; // ilegível: o app usa a foto cheia
      if (!mini) {
        if (gerar <= 0) { faltam++; continue; }
        gerar--;
        mini = await miniaturaGerada(row.codigo_sku, versao);
        if (!mini) continue;
      }
      miniaturas[row.codigo_sku] = { v: versao, img: Buffer.from(mini).toString('base64') };
    }
    res.json({ miniaturas, faltam });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar as miniaturas das fotos.' });
  }
});

// Uma miniatura (foto que apareceu na tela antes do lote chegar).
router.get('/:sku/mini', async (req, res) => {
  const sku = String(req.params.sku || '');
  if (!CODIGO_SKU_REGEX.test(sku)) return res.status(400).json({ erro: 'Código de produto inválido.' });
  try {
    const r = await pool.query(
      `/* FOTOS:MINIATURAS */ SELECT codigo_sku, (EXTRACT(EPOCH FROM atualizado_em) * 1000)::bigint AS versao, miniatura
       FROM produto_fotos WHERE codigo_sku = ANY($1::text[])`, [[sku]]
    );
    if (!r.rows.length) return res.status(404).json({ erro: 'Produto sem foto.' });
    const versao = Number(r.rows[0].versao);
    const guardada = r.rows[0].miniatura;
    const mini = guardada && guardada.length ? guardada : (guardada ? null : await miniaturaGerada(sku, versao));
    if (!mini) return res.status(404).json({ erro: 'Não deu pra gerar a miniatura dessa foto.' });
    res.set('Content-Type', 'image/jpeg');
    // pedido com a versão de antes (foto trocada no meio): não guarda a nova no endereço velho
    res.set('Cache-Control', String(req.query.v || '') === String(versao) ? 'private, max-age=31536000, immutable' : 'no-store');
    res.send(Buffer.from(mini));
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar a miniatura da foto.' });
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
      `/* FOTOS:PRODUTOS */ SELECT codigo_sku, nome FROM produtos WHERE codigo_sku = ANY($1::text[])`, [[sku, ...variacoes]]
    );
    const doProduto = existe.rows.find(r => r.codigo_sku === sku);
    if (!doProduto) return res.status(404).json({ erro: 'Produto não encontrado no catálogo.' });
    // a cópia só vai pra variação do MESMO produto (mesmo grupoDoProduto) - conferido
    // aqui, não só no app: lista velha no aparelho não espalha a foto por outra linha
    const grupo = chaveGrupo(doProduto.nome);
    const doMesmoGrupo = new Set(existe.rows.filter(r => r.codigo_sku !== sku && chaveGrupo(r.nome) === grupo).map(r => r.codigo_sku));
    const r = await pool.query(
      `/* FOTOS:GRAVAR */ INSERT INTO produto_fotos (codigo_sku, imagem, tamanho, atualizado_em, atualizado_por)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (codigo_sku) DO UPDATE SET imagem = EXCLUDED.imagem, tamanho = EXCLUDED.tamanho,
         atualizado_em = now(), atualizado_por = EXCLUDED.atualizado_por, miniatura = NULL
       RETURNING (EXTRACT(EPOCH FROM atualizado_em) * 1000)::bigint AS versao`,
      [sku, imagem, imagem.length, usuarioId]
    );
    // variação que já tem foto (talvez de outro ângulo/tamanho) não é trocada; a
    // cópia leva a mesma hora da principal (o app usa uma versão só pras duas)
    const versao = Number(r.rows[0].versao);
    const paraVariacoes = variacoes.filter(c => doMesmoGrupo.has(c));
    let aplicadas = [];
    if (paraVariacoes.length) {
      const v = await pool.query(
        `/* FOTOS:VARIACOES_GRAVAR */ INSERT INTO produto_fotos (codigo_sku, imagem, tamanho, atualizado_em, atualizado_por)
         SELECT c, $2, $3, to_timestamp($5::double precision / 1000), $4 FROM UNNEST($1::text[]) AS c
         ON CONFLICT (codigo_sku) DO NOTHING
         RETURNING codigo_sku`,
        [paraVariacoes, imagem, imagem.length, usuarioId, versao]
      );
      aplicadas = v.rows.map(x => x.codigo_sku);
    }
    res.json({ codigo_sku: sku, versao, variacoes: aplicadas });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao salvar a foto do produto.' });
  }
});

// "Usar a foto do site" (produto sem foto, 10/2026): a foto vem da página do
// cortag.com onde o SKU está impresso (tabela fichas_site), nunca de um endereço
// mandado pelo app - o servidor só baixa de cortag.com/wp-content/uploads. É só
// sugestão: produto que já tem foto não é trocado (409).
const PRAZO_FOTO_SITE_MS = 15000;
router.post('/:sku/do-site', async (req, res) => {
  const sku = String(req.params.sku || '');
  if (!CODIGO_SKU_REGEX.test(sku)) return res.status(422).json({ erro: 'Código de produto inválido.' });
  try {
    const p = await pool.query(`/* FOTOS:PRODUTOS */ SELECT codigo_sku, nome FROM produtos WHERE codigo_sku = ANY($1::text[])`, [[sku]]);
    if (!p.rows.length) return res.status(404).json({ erro: 'Produto não encontrado no catálogo.' });
    const pg = await pool.query(`/* FOTOS:PAGINA_SITE */ SELECT foto, skus FROM fichas_site WHERE skus ? $1 LIMIT 1`, [sku.toUpperCase()]);
    const url = pg.rows.length ? fotoDoSkuNaPagina(pg.rows[0], sku.toUpperCase()) : '';
    if (!url || !URL_FOTO.test(url)) return res.status(404).json({ erro: 'Este produto não tem foto no site da Cortag.' });
    let imagem;
    try {
      const r = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(PRAZO_FOTO_SITE_MS) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (Number(r.headers && r.headers.get && r.headers.get('content-length')) > FOTO_MAX_BYTES) {
        return res.status(422).json({ erro: 'A foto do site é grande demais: tire uma foto ou escolha da galeria.' });
      }
      imagem = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      console.error(`Foto do site (${sku}): ${e.message}`);
      return res.status(502).json({ erro: 'Não consegui baixar a foto do site da Cortag. Tente de novo mais tarde.' });
    }
    if (!ehJpeg(imagem)) return res.status(422).json({ erro: 'A foto do site não é JPEG: tire uma foto ou escolha da galeria.' });
    if (imagem.length > FOTO_MAX_BYTES) return res.status(422).json({ erro: 'A foto do site é grande demais: tire uma foto ou escolha da galeria.' });
    if (imagem.length < FOTO_MIN_BYTES) return res.status(422).json({ erro: 'A foto do site veio vazia: tire uma foto ou escolha da galeria.' });
    const r = await pool.query(
      `/* FOTOS:GRAVAR_SE_NAO_TEM */ INSERT INTO produto_fotos (codigo_sku, imagem, tamanho, atualizado_em, atualizado_por)
       VALUES ($1, $2, $3, now(), $4)
       ON CONFLICT (codigo_sku) DO NOTHING
       RETURNING (EXTRACT(EPOCH FROM atualizado_em) * 1000)::bigint AS versao`,
      [sku, imagem, imagem.length, req.usuario ? req.usuario.id : null]
    );
    if (!r.rows.length) return res.status(409).json({ erro: 'Este produto já tem foto.' });
    res.json({ codigo_sku: sku, versao: Number(r.rows[0].versao) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao salvar a foto do site.' });
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
