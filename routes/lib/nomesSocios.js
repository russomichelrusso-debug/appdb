// Nome completo dos sócios na ficha de CNPJ (ficha-cnpj.html, Quadro societário).
// Desde 25/09/2026 o radar-cnpj devolve a ficha "mascarada" (`mascarado: true`):
// sócio como "FRANCISCO A. M." em vez de "FRANCISCO DE ASSIS MARTINHAGO". A
// BrasilAPI (reserva da ficha, routes/lib/cnpjBrasilApi.js) traz o nome inteiro, e
// a ficha gravada antes de 25/09 também. Aqui o nome abreviado é trocado pelo
// completo que bate com ele: mesmo 1º nome e as iniciais dos outros, sem as
// partículas (DE, DA, DOS...), que o radar tira ("A. M." = "DE ASSIS MARTINHAGO").

const PARTICULAS = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'D']);

function palavras(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/\s+/)
    .filter(Boolean);
}

// "FRANCISCO A. M." - alguma palavra depois da 1ª é uma letra com ponto
function nomeAbreviado(nome) {
  return palavras(nome).slice(1).some((p) => /^[A-Z]\.$/.test(p));
}

function iniciais(lista) {
  return lista.map((p) => p.charAt(0)).join('');
}

function casaComAbreviado(abreviado, completo) {
  const a = palavras(abreviado);
  const c = palavras(completo);
  if (a.length < 2 || c.length < 2 || a[0] !== c[0] || nomeAbreviado(completo)) return false;
  const letras = a.slice(1).map((p) => p.replace(/\.$/, ''));
  if (letras.some((p) => p.length !== 1)) return false;
  const resto = c.slice(1);
  const alvo = letras.join('');
  return iniciais(resto.filter((p) => !PARTICULAS.has(p))) === alvo || iniciais(resto) === alvo;
}

// socios: [{nome, ...}] da ficha nova; candidatos: [{nome, ...}] de outras fontes.
// Só troca quando exatamente um candidato bate (dois sócios "JOSE A. S." e "JOSE
// ANTONIO SILVA"/"JOSE AUGUSTO SOUZA" ficam abreviados). Do candidato vêm também a
// data de entrada e a faixa etária que faltarem.
function completarNomesSocios(socios, candidatos) {
  if (!Array.isArray(socios)) return socios;
  const lista = (Array.isArray(candidatos) ? candidatos : []).filter((c) => c && c.nome && !nomeAbreviado(c.nome));
  return socios.map((s) => {
    if (!s || !nomeAbreviado(s.nome)) return s;
    const achados = lista.filter((c) => casaComAbreviado(s.nome, c.nome));
    const nomesDiferentes = new Set(achados.map((c) => palavras(c.nome).join(' ')));
    if (nomesDiferentes.size !== 1) return s;
    const c = achados[0];
    return {
      ...s,
      nome: c.nome,
      dataEntrada: s.dataEntrada || c.dataEntrada || null,
      faixaEtaria: s.faixaEtaria || c.faixaEtaria || null,
    };
  });
}

function temSocioAbreviado(socios) {
  return Array.isArray(socios) && socios.some((s) => s && nomeAbreviado(s.nome));
}

module.exports = { nomeAbreviado, casaComAbreviado, completarNomesSocios, temSocioAbreviado };
