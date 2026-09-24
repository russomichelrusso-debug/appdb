// Agrupa variações do mesmo produto pelo nome - "ESPAÇADOR NIVELADOR 0,5 mm",
// "ESPAÇADOR NIVELADOR 2,0 mm" e "ESPACADOR NIVELADOR 1,0 mm SMART - PACOTE C/
// 50 UN" viram um item só, "Espaçador Nivelador". Usado nas sugestões de
// recompra (routes/relatorios.js), onde o vendedor quer um lembrete do TIPO de
// produto que o cliente parou de comprar, não a lista de cada tamanho.
//
// Regra: corta no primeiro " - " (tira "- PACOTE C/ 50 UN", "- COM CABO"),
// depois pega as palavras até a primeira que tem número (ou "Ø") - medida,
// tamanho ou quantidade - e tira conectivo solto no fim ("BROCA C/" -> "BROCA").
// Testado no catálogo real: ~1.700 produtos viram ~500 grupos, e tipos
// diferentes do mesmo produto continuam separados ("BROCA DE AÇO RÁPIDO" x
// "BROCA C/ PONTA DE METAL DURO P/ CONCRETO").

const CONECTIVOS_FINAIS = new Set(['C/', 'P/', 'DE', 'DA', 'DO', 'PARA', 'E', 'COM', 'EM']);

function semAcento(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function tituloPalavra(p) {
  const semAc = semAcento(p).toUpperCase();
  // abreviações ficam como estão: "C/", "P/", siglas sem vogal ("SDS", "PVC")
  // e palavras de 2 letras que não são conectivo ("HD")
  if (/\//.test(p) || (p === p.toUpperCase() && (!/[AEIOU]/.test(semAc) || (p.length <= 2 && !CONECTIVOS_FINAIS.has(semAc))))) return p;
  const minuscula = p.toLocaleLowerCase('pt-BR');
  if (CONECTIVOS_FINAIS.has(semAc)) return minuscula;
  return minuscula.charAt(0).toLocaleUpperCase('pt-BR') + minuscula.slice(1);
}

function grupoDoProduto(nome) {
  const original = String(nome || '').trim();
  const semSufixo = original.split(/\s+-\s+/)[0];
  const palavras = semSufixo.split(/\s+/).filter(Boolean);
  const escolhidas = [];
  for (const p of palavras) {
    if (/\d/.test(p) || p === 'Ø') break;
    escolhidas.push(p);
  }
  while (escolhidas.length > 1 && CONECTIVOS_FINAIS.has(semAcento(escolhidas[escolhidas.length - 1]).toUpperCase())) {
    escolhidas.pop();
  }
  const base = escolhidas.length ? escolhidas : palavras.slice(0, 1);
  const chave = semAcento(base.join(' ')).toUpperCase();
  const rotulo = base.map(tituloPalavra).join(' ');
  return { chave: chave || semAcento(original).toUpperCase(), rotulo: rotulo || original };
}

module.exports = { grupoDoProduto };
