// Quando um pedido feito no app conta como compra do cliente.
//
// Várias telas (Histórico, Rotatividade, Recuperar, Já compraram, Comprados
// e não contados, Sugestões de recompra) somam o faturado oficial do ERP com
// os pedidos gravados no app (`pedidos`/`pedido_itens`). Os dois descrevem a
// MESMA compra na maioria das vezes, então sem cuidado ela entra duas vezes:
//  - origem 'faturamento': cópias do relatório de faturamento, de uma
//    importação antiga que já foi removida do app - o relatório oficial cobre
//    tudo, então nunca contam (3.067 itens em 09/2026, 2.986 idênticos ao
//    oficial no mesmo dia);
//  - origem 'app'/'pdf': o vendedor fecha o pedido (ou importa a cotação em
//    PDF) e ele é faturado DIAS DEPOIS - a regra antiga ("mesmo dia") contava
//    duas compras e a Rotatividade saía "repõe a cada ~5 dias". Conta só se
//    não houver faturado oficial do mesmo cliente + produto entre
//    JANELA_DIAS_ANTES antes e JANELA_DIAS_DEPOIS depois da data do pedido.
// Pedido do app sem faturamento correspondente continua contando (pedido
// recente ainda não faturado, ou cliente sem código no ERP) - decisão de
// produto das sugestões de recompra: histórico = faturado + pedidos do app.

const JANELA_DIAS_ANTES = 7;
const JANELA_DIAS_DEPOIS = 45;

// Filtro SQL (alias `ped` = pedidos) que tira as cópias da importação antiga.
const SQL_PEDIDO_APP_VALIDO = "ped.origem IS DISTINCT FROM 'faturamento'";

// Dia do pedido do app no fuso de Brasília. data_pedido é TIMESTAMPTZ e o banco
// (Supabase) roda em UTC: data_pedido::date punha o pedido fechado depois das
// 21h no dia seguinte (Histórico, Rotatividade, Recompra; achado do
// revisor-cortag, 10/2026). Mas o pedido importado de PDF (e as cópias antigas
// de origem 'faturamento') guardam SÓ A DATA, gravada como meia-noite UTC -
// convertidos pro fuso, iam pro dia anterior. Por isso: hora exatamente 00:00:00
// UTC = "só a data", fica o dia gravado; o resto (hora real, com microssegundos)
// vai pro dia de Brasília. Conferido no banco em 05/10/2026: 13 de 13 do PDF e
// 234 de 234 de 'faturamento' à meia-noite UTC; 1 de 20 do app muda de dia.
const FUSO = 'America/Sao_Paulo';
function sqlDiaDoPedido(alias = 'ped') {
  const d = `${alias}.data_pedido`;
  return `(CASE WHEN ${d}::time = '00:00:00' THEN ${d}::date ELSE (${d} AT TIME ZONE '${FUSO}')::date END)`;
}
const SQL_HOJE_BR = `(now() AT TIME ZONE '${FUSO}')::date`;

function diaISO(d) {
  return (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);
}
function somarDias(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// linhas oficiais -> Map chave -> ['AAAA-MM-DD', ...] (chaveFn define o que é
// "o mesmo cliente + produto" em cada tela)
function indexarDatasOficiais(linhas, chaveFn) {
  const porChave = new Map();
  for (const l of linhas) {
    if (!l.data) continue;
    const chave = chaveFn(l);
    if (!porChave.has(chave)) porChave.set(chave, []);
    porChave.get(chave).push(diaISO(l.data));
  }
  return porChave;
}

// true = esse pedido do app já aparece como faturado oficial (não contar de novo)
function pedidoAppJaFaturado(chave, dataApp, datasOficiais) {
  const datas = datasOficiais.get(chave);
  if (!datas || !dataApp) return false;
  const dia = diaISO(dataApp);
  const inicio = somarDias(dia, -JANELA_DIAS_ANTES);
  const fim = somarDias(dia, JANELA_DIAS_DEPOIS);
  return datas.some(d => d >= inicio && d <= fim);
}

module.exports = { SQL_PEDIDO_APP_VALIDO, FUSO, sqlDiaDoPedido, SQL_HOJE_BR, JANELA_DIAS_ANTES, JANELA_DIAS_DEPOIS, diaISO, indexarDatasOficiais, pedidoAppJaFaturado };
