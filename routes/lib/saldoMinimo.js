// Saldo mínimo em carteira (política de cancelamento da Cortag, e-mails
// "Cancelamento saldo em carteira"): o que sobra de um pedido sem faturar é
// cancelado quando fica abaixo de R$ 300,00 - R$ 600,00 no Norte e Nordeste.
// Antes do corte o vendedor pode pedir ao cliente pra aumentar a quantidade e
// passar do mínimo: com 1 código no saldo, só ele pode aumentar; com 2 ou
// mais, qualquer um deles (regra aplicada no card do pedido, index.html).
const SALDO_MINIMO_PADRAO = 300;
const SALDO_MINIMO_NORTE_NORDESTE = 600;
const UFS_NORTE_NORDESTE = new Set([
  'AC', 'AP', 'AM', 'PA', 'RO', 'RR', 'TO',
  'AL', 'BA', 'CE', 'MA', 'PB', 'PE', 'PI', 'RN', 'SE',
]);

// UF da ficha de CNPJ do cliente; sem ficha (UF desconhecida) vale o padrão.
function saldoMinimoDaUf(uf) {
  const sigla = uf ? String(uf).trim().toUpperCase() : null;
  const norteNordeste = !!sigla && UFS_NORTE_NORDESTE.has(sigla);
  return {
    valor: norteNordeste ? SALDO_MINIMO_NORTE_NORDESTE : SALDO_MINIMO_PADRAO,
    uf: sigla,
    regiao: norteNordeste ? 'Norte/Nordeste' : null,
  };
}

module.exports = { saldoMinimoDaUf, SALDO_MINIMO_PADRAO, SALDO_MINIMO_NORTE_NORDESTE };
