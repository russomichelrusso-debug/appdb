// Classificatórios da Política Comercial Cortag (PVEN rev. 06, 04/2026,
// item 4): percentual de desconto sobre a tabela de preços de cada canal.
// Percentual NEGATIVO é acréscimo (Marmoraria / Consumidor Final: +30%).
//
// O relatório oficial do ERP manda o classificatório como "Varejo Exclusive
// (12)" - o número entre parênteses às vezes ainda é o da política antiga
// (Exclusive 12 / Premium 15). Por decisão do usuário, vale sempre o
// percentual da política pelo NOME do classificatório; o número do ERP só é
// usado quando o nome não está nesta tabela.
//
// Mesma tabela, do lado do navegador: CLASSI_POR_CANAL em index.html -
// manter as duas iguais.

const CLASSIFICATORIOS = [
  { tipo: 'Varejo Exclusive', canal: 'VAREJO', pct: 15 },
  { tipo: 'Varejo Premium', canal: 'VAREJO', pct: 17 },
  { tipo: 'Varejo Master', canal: 'VAREJO', pct: 20 },
  { tipo: 'Rede', canal: 'VAREJO', pct: 18 },
  { tipo: 'Atacado Exclusive', canal: 'ATACADO', pct: 20 },
  { tipo: 'Atacado Premium', canal: 'ATACADO', pct: 22 },
  { tipo: 'Atacado Master', canal: 'ATACADO', pct: 25 },
  { tipo: 'E-commerce Exclusive', canal: 'E-COMMERCE', pct: 10 },
  { tipo: 'E-commerce Premium', canal: 'E-COMMERCE', pct: 15 },
  { tipo: 'E-commerce Master', canal: 'E-COMMERCE', pct: 20 },
  { tipo: 'Home Center Premium', canal: 'MODERNO', pct: 22 },
  { tipo: 'Atacarejo', canal: 'MODERNO', pct: 25 },
  { tipo: 'Locação', canal: 'INSTITUCIONAL', pct: 12 },
  { tipo: 'Assistência Técnica', canal: 'INSTITUCIONAL', pct: 12 },
  { tipo: 'Marmoraria', canal: 'INSTITUCIONAL', pct: -30 },
  { tipo: 'Consumidor Final', canal: 'INSTITUCIONAL', pct: -30 },
  { tipo: 'Construtora', canal: 'CONSTRUTORA', pct: 0 },
];

// "E-Commerce Máster", "e-commerce master" e "E-commerce Master" são o mesmo
// classificatório - compara sem acento, sem diferença de maiúscula e sem
// espaço/hífen.
function chaveTipo(tipo) {
  return String(tipo || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[\s-]+/g, '');
}
const POR_CHAVE = new Map(CLASSIFICATORIOS.map(c => [chaveTipo(c.tipo), c]));

function classificatorioDaPolitica(tipo) {
  return POR_CHAVE.get(chaveTipo(tipo)) || null;
}

// Percentual a gravar pro cliente: o da política quando o nome é conhecido,
// senão o que veio do ERP (ou null).
function descontoPelaPolitica(tipo, descontoOriginal) {
  const c = classificatorioDaPolitica(tipo);
  if (c) return c.pct;
  return descontoOriginal == null ? null : descontoOriginal;
}

module.exports = { CLASSIFICATORIOS, chaveTipo, classificatorioDaPolitica, descontoPelaPolitica };
