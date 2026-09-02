const express = require('express');
const router = express.Router();
const XLSX = require('xlsx');
const { pool } = require('../db');

// ---------------------------------------------------------------------
// Conversor da planilha "LISTA PADRÃO" (6 canais x 3 regiões, com
// tributação detalhada só pra MG/RJ/PR/SC/RS) pro catálogo completo:
// produto x canal x estado (27 UFs).
//
// Regra de preço final por estado (confirmada testando contra o cálculo
// real do Excel/LibreOffice na aba "TABELA DE PREÇOS" da planilha):
// - MG, RJ, PR, SC, RS: preço líquido (por canal+região) + IPI + ICMS-ST
//   específico do estado.
// - Todos os outros 22 estados (inclusive SP): preço líquido + IPI, sem
//   ICMS-ST adicional - é o máximo que a própria planilha original
//   calcula pra eles (ela também deixa em branco pra esses estados).
//
// Regra de "Preço Fixo" (sem desconto, só imposto): só vale pra Varejo,
// Atacado e E-commerce (confirmado na fórmula da aba TABELA DE PREÇOS -
// Moderno/Construtora/Institucional não têm essa trava).
// ---------------------------------------------------------------------

const CANAIS = ['VAREJO', 'ATACADO', 'E-COMMERCE', 'MODERNO', 'CONSTRUTORA', 'INSTITUCIONAL'];
const TODOS_ESTADOS = ['AC','AL','AM','AP','BA','CE','DF','ES','GO','MA','MG','MS','MT','PA','PB',
                       'PE','PI','PR','RJ','RN','RO','RR','RS','SC','SE','SP','TO'];
const ESTADOS_EXATOS = new Set(['MG', 'RJ', 'PR', 'SC', 'RS']);

function regiaoIndice(uf) {
  if (uf === 'SP') return 0;
  if (ESTADOS_EXATOS.has(uf)) return 1;
  return 2;
}
function colPrecificacao(canalIdx, regiaoIdx) {
  // PRECIFICAÇÃO: colunas 3,4,5 (1-based) = Varejo(SP,SULSUD,NNOCO); 6,7,8=Atacado...
  // devolve indice 0-based do array de linha
  return 2 + canalIdx * 3 + regiaoIdx;
}

function planilhaParaLinhas(sheet) {
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null, raw: true });
}

function converterPlanilha(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });

  const wsRef = wb.Sheets['Referência Estados'];
  const wsTrib = wb.Sheets['TRIBUTAÇÃO'];
  const wsPrec = wb.Sheets['PRECIFICAÇÃO'];
  if (!wsRef || !wsTrib || !wsPrec) {
    throw new Error('Planilha não tem as abas esperadas (Referência Estados, TRIBUTAÇÃO, PRECIFICAÇÃO). Confira se é o arquivo certo.');
  }

  // estado -> coluna de %ST dentro de TRIBUTAÇÃO (1-based, coluna H da tabela de referência)
  const linhasRef = planilhaParaLinhas(wsRef);
  const estadosColunas = {};
  for (let i = 3; i < 30 && i < linhasRef.length; i++) {
    const row = linhasRef[i];
    if (!row) continue;
    const uf = row[0];
    if (!ESTADOS_EXATOS.has(uf)) continue;
    estadosColunas[uf] = { colSt: row[7] };
  }
  if (Object.keys(estadosColunas).length < 5) {
    throw new Error('Não encontrei os 5 estados esperados (MG,RJ,PR,SC,RS) na aba "Referência Estados". A planilha pode ter mudado de formato.');
  }

  // TRIBUTAÇÃO: linha 3 (indice 2) = cabecalho, dados a partir da linha 4 (indice 3)
  const linhasTrib = planilhaParaLinhas(wsTrib);
  const tribPorCodigo = {};
  for (let i = 3; i < linhasTrib.length; i++) {
    const row = linhasTrib[i];
    if (!row || row[0] == null) continue;
    tribPorCodigo[String(row[0]).trim()] = row;
  }

  // PRECIFICAÇÃO: mesma estrutura de linhas
  const linhasPrec = planilhaParaLinhas(wsPrec);
  const precPorCodigo = {};
  for (let i = 3; i < linhasPrec.length; i++) {
    const row = linhasPrec[i];
    if (!row || row[0] == null) continue;
    precPorCodigo[String(row[0]).trim()] = row;
  }

  const produtos = [];
  for (const codigo of Object.keys(tribPorCodigo)) {
    const trib = tribPorCodigo[codigo];
    const prec = precPorCodigo[codigo];
    if (!prec) continue; // produto sem precificação, ignora

    const nome = trib[1];
    const emb = trib[2] || 1;
    const ncm = trib[4];
    const ipi = Number(trib[5]) || 0;
    const familia = trib.length > 173 ? trib[173] : null;
    const ehPrecoFixo = prec.length > 21 && prec[21] === 'PF';

    const precosPorCanal = {};
    for (let ci = 0; ci < CANAIS.length; ci++) {
      const canal = CANAIS[ci];
      const precosEstado = {};
      for (const uf of TODOS_ESTADOS) {
        const regiaoIdx = regiaoIndice(uf);
        const idxPreco = colPrecificacao(ci, regiaoIdx);
        const precoLiquido = prec[idxPreco];
        if (typeof precoLiquido !== 'number') continue;
        const precoComIpi = precoLiquido * (1 + ipi);

        let precoFinal = precoComIpi;
        if (ESTADOS_EXATOS.has(uf)) {
          const idxSt = estadosColunas[uf].colSt - 1; // 1-based -> 0-based
          const pctSt = trib[idxSt];
          if (typeof pctSt === 'number') precoFinal = precoComIpi * (1 + pctSt);
        }
        precosEstado[uf] = Math.round(precoFinal * 10000) / 10000;
      }
      precosPorCanal[canal] = precosEstado;
    }

    produtos.push({
      codigo_sku: codigo,
      nome,
      emb,
      ncm: ncm != null ? String(ncm) : null,
      ipi,
      familia: familia != null ? String(familia) : null,
      preco_fixo: ehPrecoFixo,
      canais_fx: ehPrecoFixo ? ['VAREJO', 'ATACADO', 'E-COMMERCE'] : [],
      precos: precosPorCanal,
    });
  }

  return produtos;
}

// Importa a planilha inteira (base64) e substitui o catálogo completo no
// banco. Liberado pra qualquer usuário logado (não só admin).
router.post('/importar', async (req, res) => {
  const { arquivoBase64 } = req.body;
  if (!arquivoBase64) return res.status(400).json({ erro: 'Envie { arquivoBase64: "..." } com o arquivo .xlsx em base64.' });

  let produtos;
  try {
    const buffer = Buffer.from(arquivoBase64, 'base64');
    produtos = converterPlanilha(buffer);
  } catch (e) {
    console.error('Erro ao converter planilha:', e);
    return res.status(400).json({ erro: 'Erro ao ler a planilha: ' + e.message });
  }

  if (produtos.length === 0) {
    return res.status(400).json({ erro: 'Nenhum produto encontrado na planilha - confira se é o arquivo certo.' });
  }

  try {
    await pool.query(
      `INSERT INTO catalogo_precos (codigo_sku, nome, emb, ncm, ipi, familia, preco_fixo, canais_fx, precos, atualizado_em)
       SELECT * FROM UNNEST(
         $1::text[], $2::text[], $3::int[], $4::text[], $5::numeric[], $6::text[], $7::boolean[], $8::text[][], $9::jsonb[], $10::timestamptz[]
       )
       ON CONFLICT (codigo_sku) DO UPDATE SET
         nome = EXCLUDED.nome, emb = EXCLUDED.emb, ncm = EXCLUDED.ncm, ipi = EXCLUDED.ipi,
         familia = EXCLUDED.familia, preco_fixo = EXCLUDED.preco_fixo, canais_fx = EXCLUDED.canais_fx,
         precos = EXCLUDED.precos, atualizado_em = EXCLUDED.atualizado_em`,
      [
        produtos.map(p => p.codigo_sku),
        produtos.map(p => p.nome),
        produtos.map(p => p.emb),
        produtos.map(p => p.ncm),
        produtos.map(p => p.ipi),
        produtos.map(p => p.familia),
        produtos.map(p => p.preco_fixo),
        produtos.map(p => p.canais_fx),
        produtos.map(p => JSON.stringify(p.precos)),
        produtos.map(() => new Date()),
      ]
    );
    res.json({ ok: true, produtosImportados: produtos.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao salvar catálogo no banco: ' + e.message });
  }
});

// Devolve o catálogo completo, no formato que o app usa como "fonte
// automática" (substitui o precos.json estático do GitHub Pages - agora
// todo aparelho busca direto do servidor).
router.get('/', async (req, res) => {
  try {
    const r = await pool.query('SELECT codigo_sku, nome, emb, ncm, ipi, familia, preco_fixo, canais_fx, precos FROM catalogo_precos ORDER BY codigo_sku');
    res.json({
      version: 'Catálogo do servidor',
      generatedAt: new Date().toISOString(),
      canais: CANAIS,
      produtos: r.rows,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar catálogo.' });
  }
});

module.exports = router;
