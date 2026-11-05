'use strict';

// Produtos que continuam na Lista de Preços (a importação traz de volta) mas não
// aparecem no app: saem do GET /api/catalogo-precos, então somem da busca, do
// Catálogo, das campanhas e do orçamento. O histórico do cliente continua igual
// (lê o banco, não esta rota). Pedido do usuário, 11/2026: linha VONDER
// (espaçadores 62202-62207, cortadores VDEC 61397-61399, rodel 61400).
// Ocultar outro produto = pôr o código aqui; mostrar de novo = tirar.
const CODIGOS_OCULTOS = new Set(
  '62202 62203 62204 62205 62206 62207 61397 61398 61399 61400'.split(/\s+/)
);

// o promocional P/P1/P2 segue o código base (codigoBase de skuNormalizacao.js)
function produtoOculto(codigo) {
  const c = String(codigo == null ? '' : codigo).trim().toUpperCase();
  if (CODIGOS_OCULTOS.has(c)) return true;
  const m = /^P[12]?(.+)$/.exec(c);
  return !!(m && CODIGOS_OCULTOS.has(m[1]));
}

function semOcultos(linhas) {
  return linhas.filter(l => !produtoOculto(l.codigo_sku));
}

module.exports = { CODIGOS_OCULTOS, produtoOculto, semOcultos };
