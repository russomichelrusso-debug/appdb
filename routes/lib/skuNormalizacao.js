// Reconciliação de códigos promocionais (P/P1/P2 + código base) pros
// relatórios que agrupam por codigo_sku (Curva ABC, produtos-abc-geral,
// histórico de pedidos oficiais). Uma campanha de trade marketing cria
// códigos como "P60863"/"P160863"/"P260863" pra representar faixas de
// desconto do MESMO produto físico do código "60863" - sem essa
// reconciliação, o mesmo produto aparece fragmentado em várias linhas
// nos relatórios (um código por faixa vendida).
//
// Um código só é tratado como variante quando o restante (depois de
// tirar o prefixo P/P1/P2) bate com um codigo_sku conhecido em
// `produtos` - sem essa checagem, um código como "P123" que não é
// variante de promoção nenhuma seria cortado indevidamente.
function codigoBase(codigoSku, codigosConhecidos) {
  const m = /^P[12]?(.+)$/.exec(String(codigoSku || ''));
  if (m && codigosConhecidos.has(m[1])) return m[1];
  return codigoSku;
}

// Mescla linhas já agregadas por codigo_sku literal (uma por SKU, com
// num_pedidos/quantidade_total/faturamento_total já somados) pelo código
// normalizado - soma os totais e usa nome/categoria do produto BASE.
function mesclarPorCodigoBase(linhas, produtosPorCodigo) {
  const codigosConhecidos = new Set(Object.keys(produtosPorCodigo || {}));
  const porGrupo = new Map();
  for (const linha of linhas) {
    const base = codigoBase(linha.codigo_sku, codigosConhecidos);
    const atual = porGrupo.get(base) || {
      codigo_sku: base, num_pedidos: 0, quantidade_total: 0, faturamento_total: 0,
      _codigosOriginais: [],
    };
    atual.num_pedidos += Number(linha.num_pedidos) || 0;
    atual.quantidade_total += Number(linha.quantidade_total) || 0;
    atual.faturamento_total += Number(linha.faturamento_total) || 0;
    atual._codigosOriginais.push(linha.codigo_sku);
    porGrupo.set(base, atual);
  }
  for (const grupo of porGrupo.values()) {
    const p = produtosPorCodigo[grupo.codigo_sku];
    grupo.produto = p ? p.nome : grupo.codigo_sku;
    grupo.categoria = p ? p.categoria : null;
  }
  return [...porGrupo.values()];
}

module.exports = { codigoBase, mesclarPorCodigoBase };
