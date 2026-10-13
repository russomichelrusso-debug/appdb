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
//
// "Cancelamento saldo em carteira 13.10.2026" (assistente comercial, não a
// noreply - formato conferido nos e-mails reais de 10/2025 a 10/2026): tabela
// HTML no corpo, uma linha por item do saldo, com as colunas Gestor,
// Representante, Cod. Cliente, Nome Cliente, Nr. Pedido, Venda/Bonific, Item,
// Descrição, O.C., Motivo ("Abaixo R$ 300,00", "Sem previsão"...), Qt. Pendente
// e Vl. Pendente ("120,76"). O texto puro do Gmail junta as células com espaço
// (não dá pra separar a descrição do O.C.), então o script manda o HTML.

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

function ehCancelamentoSaldo(assunto) {
  // ancorado no começo: a resposta ("RES:", "Re:", "Fwd:") não é aviso novo
  return /^\s*cancelamento\s+saldo\s+em\s+carteira\b/i.test(String(assunto || ''));
}

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function textoDaCelula(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
      }
      return ENTIDADES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ').trim();
}
// "Cod. Cliente" -> "codcliente", "Descrição" -> "descricao", "O.C." -> "oc"
function nomeDaColuna(texto) {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
const COLUNAS_CANCELAMENTO = {
  codcliente: 'cliente_codigo_oficial', nomecliente: 'cliente_nome', nrpedido: 'nr_pedido', item: 'codigo_sku',
  descricao: 'descricao', oc: 'ordem_compra', motivo: 'motivo', qtpendente: 'quantidade', vlpendente: 'valor',
};

// { data_aviso: 'AAAA-MM-DD' | null, itens: [{ cliente_codigo_oficial,
// cliente_nome, nr_pedido, codigo_sku, descricao, ordem_compra, motivo, minimo,
// quantidade, valor }] } ou null (sem a tabela). `minimo` = o valor do motivo
// "Abaixo R$ 300,00" (300; 600 no Norte/Nordeste) - nos outros motivos
// aumentar a quantidade não salva o saldo e fica null.
function lerCancelamentoSaldo(assunto, html) {
  const data = /(\d{2})\.(\d{2})\.(\d{4})/.exec(String(assunto || ''));
  const linhas = [];
  for (const tr of String(html || '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    linhas.push([...tr[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map(c => textoDaCelula(c[1])));
  }
  const iCab = linhas.findIndex(l => l.some(c => nomeDaColuna(c) === 'nrpedido') && l.some(c => nomeDaColuna(c) === 'item'));
  if (iCab === -1) return null;
  const campos = linhas[iCab].map(c => COLUNAS_CANCELAMENTO[nomeDaColuna(c)] || null);
  const itens = [];
  for (const l of linhas.slice(iCab + 1)) {
    const it = {};
    campos.forEach((campo, i) => { if (campo) it[campo] = l[i] ?? ''; });
    const nr = String(it.nr_pedido || '').replace(/\D/g, '');
    const sku = String(it.codigo_sku || '').trim();
    if (!nr || !sku) continue; // linha de total/vazia
    const motivo = it.motivo || null;
    const minimo = motivo && /^\s*abaixo/i.test(motivo) ? valorBr((/R\$\s*([\d.]+(?:,\d+)?)/i.exec(motivo) || [])[1] || '') : null;
    itens.push({
      cliente_codigo_oficial: String(it.cliente_codigo_oficial || '').replace(/\D/g, '') || null,
      cliente_nome: it.cliente_nome || null,
      nr_pedido: semZeros(nr),
      codigo_sku: sku,
      descricao: it.descricao || null,
      ordem_compra: it.ordem_compra || null,
      motivo,
      minimo: minimo > 0 ? minimo : null,
      quantidade: it.quantidade ? valorBr(it.quantidade) : null,
      valor: it.valor ? valorBr(it.valor) : null,
    });
  }
  // HTML cortado no limite do envio (sem o fim da tabela): os itens do fim se
  // perderam - a importação grava os que vieram e registra `parcial`
  const parcial = !/<\/table>/i.test(String(html).slice(String(html).search(/<tr\b/i)));
  return { data_aviso: data ? `${data[3]}-${data[2]}-${data[1]}` : null, itens, parcial };
}

// Quem manda cada tipo. O script do Gmail só manda e-mail desses endereços que
// o Gmail autenticou (DKIM/DMARC); aqui é a 2ª barreira: com a chave certa mas
// outro remetente (script desatualizado, chave vazada), recusa.
const NOREPLY = 'noreply@cortag.com.br';
const REMETENTE_DO_TIPO = {
  relatorio: NOREPLY, classificatorio: NOREPLY, previsao: NOREPLY, bloqueado: NOREPLY, avista: NOREPLY, semcompra: NOREPLY, inadimplencia: NOREPLY,
  precos: 'vendas@cortag.com',
  // assistentes comerciais (e o atendimento, que mandou o de 16/10/2025)
  cancelamento: ['thamiris.sabino@cortag.com', 'paloma.mantovani@cortag.com', 'atendimento01@cortag.com'],
};

// "Vendas <vendas@cortag.com>" -> "vendas@cortag.com" (o nome de exibição é
// texto livre de quem mandou e não conta)
function enderecoDoRemetente(from) {
  const s = String(from || '');
  const m = s.match(/<([^<>]*)>\s*$/);
  return (m ? m[1] : s).trim().toLowerCase();
}

function remetenteValido(tipo, from) {
  const validos = [].concat(REMETENTE_DO_TIPO[tipo] || []);
  return validos.includes(enderecoDoRemetente(from));
}

module.exports = {
  ehPedidoBloqueado, ehPedidoAvista, lerPedidoBloqueado, lerPedidoAvista, ehCancelamentoSaldo, lerCancelamentoSaldo,
  REMETENTE_DO_TIPO, enderecoDoRemetente, remetenteValido,
};
