// Aviso de cancelamento do saldo em carteira (tabela avisos_cancelamento_saldo,
// vinda do e-mail "Cancelamento saldo em carteira DD.MM.AAAA" das assistentes
// comerciais da Cortag). Decisão do usuário (10/2026): o e-mail é o AVISO FINAL
// antes do corte - a chance de o cliente aumentar a quantidade e chegar ao
// mínimo (o vendedor responde "alterar para N unidades" e o atendimento reabre).
// Vale enquanto o item não aparece faturado depois do aviso, por no máximo 15
// dias (depois disso o saldo já foi cortado ou reaberto). Faturado no próprio dia
// do aviso não conta: pode ser a nota da manhã, e o e-mail da tarde fala do que
// sobrou.
const DIAS_AVISO_CANCELAMENTO = 15;

// Também sai quando um relatório oficial importado DEPOIS do aviso não traz
// mais o item em carteira: o saldo já foi cortado (ou o pedido fechado) e o
// "Pedir aumento" não serve mais. Em 14/10/2026, 6 dos 7 avisos do e-mail da
// véspera já não estavam na carteira do relatório da madrugada e seguiam na
// lista "Saldo a cancelar" por 15 dias.
function sqlAvisoCancelamentoAtivo(alias = 'acs') {
  return `(${alias}.recebido_em > now() - make_interval(days => ${DIAS_AVISO_CANCELAMENTO})
    AND NOT EXISTS (SELECT 1 FROM pedidos_oficiais_itens poi_fat
                    WHERE poi_fat.nr_pedido = ${alias}.nr_pedido AND poi_fat.codigo_sku = ${alias}.codigo_sku
                      AND poi_fat.status = 'faturado' AND poi_fat.data_faturamento > ${alias}.data_aviso)
    AND (EXISTS (SELECT 1 FROM pedidos_oficiais_itens poi_cart
                 WHERE poi_cart.nr_pedido = ${alias}.nr_pedido AND poi_cart.codigo_sku = ${alias}.codigo_sku
                   AND poi_cart.status = 'carteira')
         OR NOT EXISTS (SELECT 1 FROM import_log il
                        WHERE il.rota = 'pedidos-oficiais/importar' AND il.criado_em > ${alias}.recebido_em)))`;
}

// Campos que vão pro app (histórico do pedido e cópia local do /sync). A data
// sai como texto AAAA-MM-DD - coluna DATE vira meia-noite UTC no JSON.
function sqlCamposAviso(alias = 'acs') {
  return `'nr_pedido', ${alias}.nr_pedido, 'codigo_sku', ${alias}.codigo_sku, 'descricao', ${alias}.descricao,
    'motivo', ${alias}.motivo, 'minimo', ${alias}.minimo, 'quantidade', ${alias}.quantidade, 'valor', ${alias}.valor,
    'data_aviso', to_char(${alias}.data_aviso, 'YYYY-MM-DD'), 'remetente', ${alias}.remetente`;
}

module.exports = { DIAS_AVISO_CANCELAMENTO, sqlAvisoCancelamentoAtivo, sqlCamposAviso };
