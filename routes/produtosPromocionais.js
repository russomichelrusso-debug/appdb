const express = require('express');
const router = express.Router();
const { pool } = require('../db');

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

// Gera em lote códigos de "produto promocional" (preço fixo, mesmo formato
// já usado pelo modal manual do admin em index.html) a partir de um % de
// desconto sobre o preço líquido atual do produto base - usado pra
// campanhas de trade marketing que dão um código de SKU novo por faixa de
// desconto (ex: P60863 5%, P160863 10%, P260863 15%, todos variantes do
// código base 60863). Preços vêm de catalogo_precos (fonte autoritativa no
// servidor), não do que porventura está carregado no navegador de quem
// está rodando isso - evita basear o cálculo em catálogo desatualizado.
router.post('/gerar-por-desconto', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode gerar produtos promocionais.' });
  const { itens } = req.body;
  if (!Array.isArray(itens) || itens.length === 0) return res.status(400).json({ erro: 'Envie { itens: [{ baseCode, novoCodigo, descontoPct }] }' });

  try {
    const configResult = await pool.query('SELECT valor FROM configuracoes WHERE chave = $1', ['produtos_promocionais']);
    const listaAtual = configResult.rows[0]?.valor || [];
    const codigosExistentesPromo = new Set(listaAtual.map((p) => p.c));

    const catalogoResult = await pool.query('SELECT codigo_sku FROM catalogo_precos');
    const codigosCatalogo = new Set(catalogoResult.rows.map((p) => p.codigo_sku));

    const criados = [];
    const erros = [];
    const novosCodigosNesteLote = new Set();

    for (const item of itens) {
      const { baseCode, novoCodigo, descontoPct, nome } = item;
      if (!baseCode || !novoCodigo || !(descontoPct >= 0)) {
        erros.push({ baseCode, novoCodigo, motivo: 'Envie baseCode, novoCodigo e descontoPct (>= 0).' });
        continue;
      }
      if (codigosExistentesPromo.has(novoCodigo) || codigosCatalogo.has(novoCodigo) || novosCodigosNesteLote.has(novoCodigo)) {
        erros.push({ baseCode, novoCodigo, motivo: 'Já existe um produto (promocional ou do catálogo) com esse código - não sobrescrito.' });
        continue;
      }

      const baseResult = await pool.query(
        'SELECT codigo_sku, nome, emb, ipi, familia, precos_sem_imposto FROM catalogo_precos WHERE codigo_sku = $1',
        [baseCode]
      );
      if (baseResult.rows.length === 0) {
        erros.push({ baseCode, novoCodigo, motivo: 'Código base não encontrado no catálogo de preços.' });
        continue;
      }
      const base = baseResult.rows[0];
      const precos = base.precos_sem_imposto?.VAREJO;
      const lsp = precos?.SP, lss = precos?.RJ, lnc = precos?.BA;
      if (!(lsp > 0) || !(lss > 0) || !(lnc > 0)) {
        erros.push({ baseCode, novoCodigo, motivo: 'Preço líquido do canal Varejo não encontrado/inválido pro código base.' });
        continue;
      }

      const fator = 1 - descontoPct / 100;
      criados.push({
        c: novoCodigo,
        e: '',
        n: nome || `${base.nome} PROMOCIONAL`,
        familia: base.familia,
        emb: base.emb,
        ipi: Number(base.ipi) || 0,
        lsp: round4(lsp * fator),
        lss: round4(lss * fator),
        lnc: round4(lnc * fator),
        st: null,
        fx: 1,
        origemCodigo: baseCode,
        geradoPorDesconto: descontoPct,
      });
      novosCodigosNesteLote.add(novoCodigo);
    }

    if (criados.length > 0) {
      const novaLista = [...listaAtual, ...criados];
      await pool.query(
        `INSERT INTO configuracoes (chave, valor, atualizado_em) VALUES ($1, $2, now())
         ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`,
        ['produtos_promocionais', JSON.stringify(novaLista)]
      );
    }

    res.json({ ok: true, criados: criados.map((c) => c.c), erros });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao gerar produtos promocionais.' });
  }
});

module.exports = router;
