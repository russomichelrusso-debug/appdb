// Última compra de cada cliente, lida por "Para reativar" e "Visitas × compras"
// (as duas abrem junto na aba Clientes). Varrem a tabela inteira de pedidos, mas
// só mudam com importação ou pedido novo: ficam no cache (lerComCache) até a
// tabela mudar. Na abertura do app, com ~20 requisições juntas no banco pequeno
// do Supabase, cada uma dessas levava ~450 ms em média (log de 06/11/2026).
const { lerComCache } = require('./cacheTabela');
const { SQL_PEDIDO_APP_VALIDO, sqlDiaDoPedido } = require('./comprasApp');

// Entrada do pedido no ERP (implantação, carteira + faturado), sem a série de 7 dígitos.
async function ultimaEntradaOficial() {
  return { rows: await lerComCache('ultimas:oficial', 'pedidos_oficiais_itens',
    `/* ultimas:oficial */
     SELECT cliente_codigo_oficial AS codigo, max(COALESCE(data_implantacao, data_faturamento))::text AS ultima
     FROM pedidos_oficiais_itens WHERE length(nr_pedido) <= 6 GROUP BY 1`) };
}

// Pedido do app (sem as cópias de origem 'faturamento'), no dia de Brasília.
async function ultimoPedidoApp() {
  return { rows: await lerComCache('ultimas:app', 'pedidos',
    `/* ultimas:app */
     SELECT ped.cliente_id, max(${sqlDiaDoPedido()})::text AS ultima
     FROM pedidos ped WHERE ped.cliente_id IS NOT NULL AND ${SQL_PEDIDO_APP_VALIDO} GROUP BY 1`) };
}

module.exports = { ultimaEntradaOficial, ultimoPedidoApp };
