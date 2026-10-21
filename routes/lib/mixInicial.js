// Mix inicial (10/2026, pedido do usuário): cliente novo pede um orçamento
// "dos produtos que mais vendem" pra avaliar. Decisões do usuário (entrevista):
//  - "mais vende" = comprado pelo maior NÚMERO DE LOJAS nos últimos 12 meses
//    (não faturamento: um item caro de 2 clientes grandes não encabeça);
//  - só lojas do mesmo canal do orçamento (Varejo, Atacado…; canal pelo
//    classificatório da política, sem classificatório = Varejo);
//  - cada produto (grupoDoProduto) entra só na medida mais vendida - o app
//    recebe as medidas na ordem e pula a que não pode entrar (Preço Fixo, sem
//    previsão de chegada, fora do catálogo do aparelho);
//  - promocional P/P1/P2 conta como o código base; produto fora da Lista de
//    Preços (descontinuado) não entra.
// Conta pela loja: o faturado oficial pelo código do ERP e o pedido do app pelo
// cliente (com código, a mesma loja). Uma loja que comprou nas duas fontes conta
// uma vez - por isso não precisa da regra de "pedido do app já faturado".

const { grupoDoProduto } = require('./agrupamentoProduto');
const { codigoBase } = require('./skuNormalizacao');
const { classificatorioDaPolitica } = require('./politicaComercial');

const MIX_GRUPOS_POR_CANAL = 150;
const MIX_MEDIDAS_POR_GRUPO = 5;
const TODOS = 'TODOS';

function canalDaLoja(classificatorioTipo) {
  const c = classificatorioDaPolitica(classificatorioTipo);
  return c ? c.canal : 'VAREJO';
}

// compras: [{ loja, canal, codigo_sku }] (uma linha por loja + código basta);
// catalogo: [{ codigo_sku, nome }] da Lista de Preços.
// Devolve { lojas: {canal: n}, grupos: {chave: [códigos do catálogo]}, canais:
// {canal: [{ g: chave, nome, lojas, skus: [códigos, mais lojas primeiro] }]} }.
// TODOS = a carteira inteira (o app usa quando o canal tem poucas lojas).
function rankingMixInicial(compras, catalogo) {
  const nomePorCodigo = new Map(catalogo.map(p => [String(p.codigo_sku), String(p.nome || '')]));
  const conhecidos = new Set(nomePorCodigo.keys());
  const grupoDe = new Map(); // código -> { chave, rotulo }
  const grupos = {};
  for (const [cod, nome] of nomePorCodigo) {
    if (!nome) continue;
    const g = grupoDoProduto(nome);
    grupoDe.set(cod, g);
    (grupos[g.chave] = grupos[g.chave] || []).push(cod);
  }
  // canal -> chave -> { lojas: Set, porSku: Map sku -> Set }
  const porCanal = new Map();
  const lojasDoCanal = new Map();
  for (const c of compras) {
    const sku = codigoBase(String(c.codigo_sku), conhecidos);
    const g = grupoDe.get(sku);
    if (!g) continue; // fora da Lista de Preços: descontinuado ou sem nome
    for (const canal of [c.canal || 'VAREJO', TODOS]) {
      (lojasDoCanal.get(canal) || lojasDoCanal.set(canal, new Set()).get(canal)).add(c.loja);
      const doCanal = porCanal.get(canal) || porCanal.set(canal, new Map()).get(canal);
      const doGrupo = doCanal.get(g.chave) || doCanal.set(g.chave, { rotulo: g.rotulo, lojas: new Set(), porSku: new Map() }).get(g.chave);
      doGrupo.lojas.add(c.loja);
      (doGrupo.porSku.get(sku) || doGrupo.porSku.set(sku, new Set()).get(sku)).add(c.loja);
    }
  }
  const canais = {};
  const usados = new Set();
  for (const [canal, doCanal] of porCanal) {
    canais[canal] = [...doCanal.entries()]
      .map(([chave, x]) => ({
        g: chave,
        nome: x.rotulo,
        lojas: x.lojas.size,
        skus: [...x.porSku.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
          .slice(0, MIX_MEDIDAS_POR_GRUPO).map(([sku]) => sku),
      }))
      .sort((a, b) => b.lojas - a.lojas || a.nome.localeCompare(b.nome))
      .slice(0, MIX_GRUPOS_POR_CANAL);
    for (const item of canais[canal]) usados.add(item.g);
  }
  const gruposUsados = {};
  for (const chave of usados) gruposUsados[chave] = grupos[chave];
  const lojas = {};
  for (const [canal, s] of lojasDoCanal) lojas[canal] = s.size;
  return { lojas, grupos: gruposUsados, canais };
}

module.exports = { rankingMixInicial, canalDaLoja, TODOS, MIX_GRUPOS_POR_CANAL };
