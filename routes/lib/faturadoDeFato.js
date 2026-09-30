// Item do relatório oficial que conta como FATURADO nos números de faturamento
// (classificatório, Curva ABC, faturamento/top clientes do Dashboard, acumulado
// da ficha do cliente).
//
// Pedido à vista: o ERP emite a nota e ela já aparece na aba Faturamento, mas
// o pedido só é faturado de fato depois do pagamento. Enquanto o título
// (nº da nota fiscal) estiver na aba "Pendentes à Vista" (tabela
// titulos_avista_pendentes), o item não soma - decisão do usuário, 09/2026.
// Quando o título some da aba (pago), volta a contar sozinho.
//
// Não vale pra "o que o cliente comprou" (Histórico, Rotatividade, sugestões,
// comprados-recentes): o pedido existe, só o pagamento está pendente. Nem pra
// Entrada de Pedidos, que conta carteira + faturado pela data de implantação.
function sqlFaturadoDeFato(alias) {
  const p = alias ? `${alias}.` : '';
  return `(${p}status = 'faturado' AND NOT EXISTS (SELECT 1 FROM titulos_avista_pendentes tav WHERE tav.titulo = ${p}nota_fiscal))`;
}

module.exports = { sqlFaturadoDeFato };
