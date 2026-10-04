// Leitura do TEXTO de e-mails automáticos da Cortag (noreply@cortag.com.br)
// que não trazem planilha - o script do Gmail manda assunto + corpo e a
// importação por e-mail (routes/importacaoEmail.js) usa isto. Formatos
// conferidos nos e-mails reais de 09/2026:
//
// "Pedido Bloqueado 00677375":
//   Informamos que o pedido *00677375* foi bloqueado conforme abaixo:
//   Cliente: 22236 DEPOSITO DE MATS. P/ CONSTR. LOANDA LTDA
//   Motivo: 02-Rejeitado/Limite Crédito
//
// "Pedido de Venda à Vista - Cortag":
//   COMUNICADO Boa tarde, CIA ACABAMENTOS LTDA, segue anexo pedido de venda
//   No.00677304 Valor R$ 2.410,03, aguardando O pagamento para liberação, ...

function limpar(texto) {
  return String(texto || '').replace(/[*_]/g, '').replace(/\r/g, '');
}
function semZeros(nr) {
  return String(nr).replace(/^0+(?=\d)/, '');
}

function ehPedidoBloqueado(assunto) {
  return /^\s*pedido\s+bloqueado\b/i.test(String(assunto || ''));
}
function ehPedidoAvista(assunto) {
  return /pedido\s+de\s+venda\s+[àa]\s+vista/i.test(String(assunto || ''));
}

// { nr_pedido, cliente_codigo_oficial, cliente_nome, motivo, motivo_curto } ou null
function lerPedidoBloqueado(assunto, corpo) {
  const t = limpar(corpo);
  const nr = (/pedido\s+0*(\d+)\s+foi\s+bloqueado/i.exec(t) || /pedido\s+bloqueado\s+0*(\d+)/i.exec(String(assunto || '')) || [])[1];
  if (!nr) return null;
  const cliente = /Cliente:\s*(\d+)\s+([^\n]+)/i.exec(t);
  const motivoBruto = ((/Motivo:\s*([^\n]+)/i.exec(t) || [])[1] || '').trim();
  const motivo = motivoBruto.replace(/^\d+\s*-\s*/, '').trim() || null; // "02-Rejeitado/Limite Crédito" -> "Rejeitado/Limite Crédito"
  const motivoCurto = motivo ? motivo.replace(/^rejeitado\s*\/\s*/i, '').trim() : null; // -> "Limite Crédito"
  return {
    nr_pedido: semZeros(nr),
    cliente_codigo_oficial: cliente ? cliente[1] : null,
    cliente_nome: cliente ? cliente[2].trim() : null,
    motivo,
    motivo_curto: motivoCurto,
  };
}

function valorBr(texto) {
  const n = Number(String(texto).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// { nr_pedido, cliente_nome, valor } ou null
function lerPedidoAvista(assunto, corpo) {
  const t = limpar(corpo).replace(/\s+/g, ' ');
  const m = /(?:bom dia|boa tarde|boa noite|ol[áa])\s*,\s*(.+?)\s*,\s*segue\s+anexo\s+(?:o\s+)?pedido\s+de\s+venda\s+N[oº°]?\.?\s*0*(\d+)\s+Valor\s+R\$\s*([\d.]+,\d{2})/i.exec(t);
  if (!m) return null;
  return { nr_pedido: semZeros(m[2]), cliente_nome: m[1].trim(), valor: valorBr(m[3]) };
}

module.exports = { ehPedidoBloqueado, ehPedidoAvista, lerPedidoBloqueado, lerPedidoAvista };
