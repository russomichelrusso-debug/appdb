// Ritmo de compra do cliente e de cada produto dele - base da "Recompra da
// semana" (routes/recompra.js). Funções puras, sem banco.
//
// Decisões do usuário (10/2026):
//  - histórico dos últimos 12 meses; com menos de 3 compras não há ritmo e o
//    cliente fica fora da lista;
//  - ritmo = MEDIANA dos intervalos entre as compras (uma compra fora da curva
//    pesa menos que na média); próxima compra = última + ritmo;
//  - aparece 7 dias antes da data prevista; "fora do ritmo" quando o atraso
//    passa de 1,5x o ritmo;
//  - quantidade sugerida = mediana das 3 últimas compras do produto.
// Compras a até 7 dias uma da outra contam como uma só (entrega dividida,
// pedido complementar na mesma semana) - senão o ritmo encurtava.

const JANELA_DIAS = 365;
const MIN_COMPRAS = 3;
const JUNTAR_DIAS = 7;
const ANTECEDENCIA_DIAS = 7;
const FORA_DO_RITMO = 1.5;
const QTD_ULTIMAS_COMPRAS = 3;
// sem produto com ritmo próprio vencendo: entram os que vieram em pelo menos
// 2 das 3 últimas compras do cliente
const FREQUENTE_MIN = 2;
const FREQUENTE_ULTIMAS = 3;

function diaISO(d) {
  return (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
}
function somarDias(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
// b - a, em dias
function diasEntre(a, b) {
  return Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);
}
function mediana(nums) {
  if (!nums.length) return null;
  const v = [...nums].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// eventos [{ data, quantidade? }] -> compras [{ data, fim, quantidade }], em
// ordem. Evento a até JUNTAR_DIAS do anterior entra na mesma compra; `data` é
// o 1º dia da compra e `fim` o último.
function juntarCompras(eventos) {
  const ordenados = eventos
    .filter(e => e && e.data)
    .map(e => ({ data: diaISO(e.data), quantidade: Number(e.quantidade) || 0 }))
    .sort((a, b) => a.data.localeCompare(b.data));
  const compras = [];
  for (const e of ordenados) {
    const atual = compras[compras.length - 1];
    if (atual && diasEntre(atual.fim, e.data) <= JUNTAR_DIAS) {
      atual.fim = e.data;
      atual.quantidade += e.quantidade;
    } else {
      compras.push({ data: e.data, fim: e.data, quantidade: e.quantidade });
    }
  }
  return compras;
}

// compras (de juntarCompras) -> ritmo, ou null com menos de MIN_COMPRAS.
// atraso_dias > 0 = passou da data prevista; negativo = faltam N dias.
function ritmoDasCompras(compras, hoje) {
  if (!compras || compras.length < MIN_COMPRAS) return null;
  const intervalos = [];
  for (let i = 1; i < compras.length; i++) intervalos.push(diasEntre(compras[i - 1].data, compras[i].data));
  const ritmo = Math.round(mediana(intervalos));
  const ultima = compras[compras.length - 1].data;
  const previsao = somarDias(ultima, ritmo);
  return {
    num_compras: compras.length,
    ritmo_dias: ritmo,
    ultima_compra: ultima,
    previsao,
    atraso_dias: diasEntre(previsao, hoje),
  };
}

// 'atrasado' | 'fora' | 'semana' | null (no ritmo, longe da data)
function situacaoDoRitmo(r) {
  if (!r) return null;
  if (r.atraso_dias > FORA_DO_RITMO * r.ritmo_dias) return 'fora';
  if (r.atraso_dias > 0) return 'atrasado';
  if (r.atraso_dias >= -ANTECEDENCIA_DIAS) return 'semana';
  return null;
}

function quantidadeTipica(compras) {
  const q = mediana(compras.slice(-QTD_ULTIMAS_COMPRAS).map(c => c.quantidade).filter(n => n > 0));
  return q ? Math.max(1, Math.round(q)) : 1;
}

// Produtos pro "Montar proposta" de um cliente com ritmo `ritmoCliente`.
// comprasCliente = compras do cliente (juntarCompras de todos os eventos);
// comprasPorSku = Map codigo_sku -> compras daquele produto.
// 1º: produtos com ritmo próprio que vencem até a compra prevista do cliente
//     (+ a antecedência). Produto "fora do ritmo" fica de fora: o cliente
//     continuou comprando e esse item não veio, então parou de levar.
// Se nenhum: os que vieram em pelo menos 2 das 3 últimas compras do cliente.
function itensDaProposta(ritmoCliente, comprasCliente, comprasPorSku, hoje) {
  const base = ritmoCliente.previsao > hoje ? ritmoCliente.previsao : hoje;
  const limite = somarDias(base, ANTECEDENCIA_DIAS);
  const porRitmo = [];
  for (const [sku, compras] of comprasPorSku) {
    const r = ritmoDasCompras(compras, hoje);
    if (!r || r.previsao > limite || situacaoDoRitmo(r) === 'fora') continue;
    porRitmo.push({
      codigo_sku: sku, quantidade: quantidadeTipica(compras), origem: 'ritmo',
      ritmo_dias: r.ritmo_dias, ultima_compra: r.ultima_compra, previsao: r.previsao,
    });
  }
  if (porRitmo.length) return porRitmo.sort((a, b) => a.previsao.localeCompare(b.previsao) || a.codigo_sku.localeCompare(b.codigo_sku));

  const ultimas = comprasCliente.slice(-FREQUENTE_ULTIMAS);
  const frequentes = [];
  for (const [sku, compras] of comprasPorSku) {
    const nas = compras.filter(c => ultimas.some(u => c.data <= u.fim && c.fim >= u.data));
    if (nas.length < FREQUENTE_MIN) continue;
    frequentes.push({
      codigo_sku: sku, quantidade: quantidadeTipica(nas), origem: 'frequente',
      ritmo_dias: null, ultima_compra: compras[compras.length - 1].data, previsao: null,
    });
  }
  return frequentes.sort((a, b) => b.ultima_compra.localeCompare(a.ultima_compra) || a.codigo_sku.localeCompare(b.codigo_sku));
}

module.exports = {
  JANELA_DIAS, MIN_COMPRAS, JUNTAR_DIAS, ANTECEDENCIA_DIAS, FORA_DO_RITMO,
  diaISO, somarDias, diasEntre, mediana,
  juntarCompras, ritmoDasCompras, situacaoDoRitmo, quantidadeTipica, itensDaProposta,
};
