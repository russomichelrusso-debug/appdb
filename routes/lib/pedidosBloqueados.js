// Pedido bloqueado (tabela pedidos_bloqueados, vinda do e-mail "Pedido
// Bloqueado" da Cortag): o selo "⛔ Bloqueado" vale enquanto o pedido não
// aparece faturado no relatório oficial, por no máximo 30 dias - decisão do
// usuário (10/2026). O e-mail de liberação vem de uma pessoa, não do sistema,
// então o app só sabe que liberou quando o pedido fatura.
const DIAS_BLOQUEIO = 30;

function sqlBloqueioAtivo(alias = 'pb') {
  return `(${alias}.recebido_em > now() - make_interval(days => ${DIAS_BLOQUEIO})
    AND NOT EXISTS (SELECT 1 FROM pedidos_oficiais_itens poi_fat
                    WHERE poi_fat.nr_pedido = ${alias}.nr_pedido AND poi_fat.status = 'faturado'))`;
}

module.exports = { DIAS_BLOQUEIO, sqlBloqueioAtivo };
