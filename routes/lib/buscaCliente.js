// Busca de cliente por texto - a mesma no servidor (GET /api/clientes?busca=)
// e no app sem internet (buscarClientesLocais, index.html). O trecho entre os
// marcadores é copiado igual no index.html (o teste confere que os dois são
// iguais): mudou aqui, muda lá.
//
// Antes (10/2026) era nome ILIKE '%texto%': "joao" não achava "JOÃO", "maringa
// deposito" não achava "DEPOSITO ... MARINGA", CNPJ só batia digitado com a
// mesma pontuação do cadastro e o código do ERP não era procurado. E a busca
// sem internet devolvia qualquer cliente com CNPJ quando o texto não tinha
// número (o "contém" com texto vazio é sempre verdadeiro).

// <motor-busca-cliente>
// Cliente: { nome, documento, codigo_oficial, nome_fantasia, municipio }.
// Sem acento, minúsculo, pontuação vira espaço ("MATS. P/ CONSTR." = "mats p constr").
function textoBuscaCliente(s) {
  return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}
// "de", "e", "p/"... não contam se o nome não tiver ("deposito sao jose" acha "DEPOSITO S. JOSE" pelo resto).
const LIGACAO_BUSCA_CLIENTE = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'p', 'para', 'com', 'a', 'o']);
// Levenshtein com teto: devolve teto + 1 se passar dele.
function distanciaAte(a, b, teto) {
  if (Math.abs(a.length - b.length) > teto) return teto + 1;
  let ant = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let menor = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(ant[j] + 1, cur[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < menor) menor = cur[j];
    }
    if (menor > teto) return teto + 1;
    ant = cur;
  }
  return ant[b.length];
}
// Quão bem a palavra bate com as palavras de um campo (menor é melhor):
// 0 igual, 1 começo ("dep" → "deposito"), 2 no meio (3+ letras), 3 erro de
// digitação (1 letra em palavra de 4+, 2 letras em palavra de 8+). Infinity = não achou.
function penalidadePalavraCliente(w, tokens) {
  let melhor = Infinity;
  for (const t of tokens) {
    if (t === w) return 0;
    if (t.startsWith(w)) melhor = Math.min(melhor, 1);
    else if (w.length >= 3 && t.includes(w)) melhor = Math.min(melhor, 2);
  }
  if (melhor < Infinity || w.length < 4 || /^\d+$/.test(w)) return melhor;
  const teto = w.length >= 8 ? 2 : 1;
  for (const t of tokens) {
    if (/^\d+$/.test(t)) continue;
    if (distanciaAte(w, t, teto) <= teto) return 3;
  }
  return Infinity;
}
// Palavras vizinhas juntas ("W A MATERIAIS" → "wa", "VITOR MULTI COISAS" →
// "multicoisas"): o vendedor digita a sigla ou o nome da loja sem o espaço do
// cadastro. Só valem inteiras (+1) ou, com 3 letras ou mais, pelo começo (+2),
// sem erro de digitação.
function juntasCliente(tokens) {
  const juntas = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    juntas.push(tokens[i] + tokens[i + 1]);
    if (i + 2 < tokens.length) juntas.push(tokens[i] + tokens[i + 1] + tokens[i + 2]);
  }
  return juntas;
}
function penalidadeJuntaCliente(w, juntas) {
  if (w.length < 2) return Infinity;
  let melhor = Infinity;
  for (const t of juntas) {
    if (t === w) return 1;
    if (w.length >= 3 && t.startsWith(w)) melhor = 2;
  }
  return melhor;
}
// Pontos do cliente pra busca (menor é melhor) ou null se não bate.
// Código do ERP/CNPJ exato 0, começo do código/CNPJ 1, CNPJ contém 2, nome
// (razão social) ou nome fantasia igual 3, nome ou fantasia começando com a
// busca 4; depois 10 + o quanto cada palavra errou - palavra no nome ou no
// nome fantasia conta como está (o vendedor conhece a loja pelo fantasia:
// "LOJA BOM JESUS" é a IRACEMA PERISSATO E CIA), na cidade +2, e a frase
// seguida no nome ou no fantasia tira 1. Todas as palavras têm de bater em
// algum campo (só as de ligação podem faltar).
function pontuarClienteBusca(c, busca) {
  const q = textoBuscaCliente(busca);
  if (!q) return null;
  const digitos = String(busca).replace(/\D/g, '');
  const cod = textoBuscaCliente(c.codigo_oficial);
  const doc = String(c.documento || '').replace(/\D/g, '');
  if (/^[\d\s.\-/]+$/.test(String(busca).trim()) && digitos.length >= 2) {
    if (cod === digitos || doc === digitos) return 0;
    if (cod.startsWith(digitos) || (digitos.length >= 3 && doc.startsWith(digitos))) return 1;
    if (digitos.length >= 4 && doc.includes(digitos)) return 2;
  }
  const nome = textoBuscaCliente(c.nome);
  const fantasia = textoBuscaCliente(c.nome_fantasia);
  if (nome === q || fantasia === q) return 3;
  if (nome.startsWith(q) || (fantasia && fantasia.startsWith(q))) return 4;
  const tokensNome = nome.split(' ').filter(Boolean);
  const tokensFantasia = fantasia.split(' ').filter(Boolean);
  const campos = [
    [tokensNome, 0],
    [tokensFantasia, 0],
    [textoBuscaCliente(c.municipio).split(' ').filter(Boolean), 2],
  ];
  const juntas = juntasCliente(tokensNome).concat(juntasCliente(tokensFantasia));
  const todas = q.split(' ');
  const palavras = todas.filter(w => !LIGACAO_BUSCA_CLIENTE.has(w));
  let total = 0, achou = 0;
  for (const w of todas) {
    let melhor = (w === cod || (w.length >= 4 && /^\d+$/.test(w) && doc.includes(w))) ? 0 : Infinity;
    for (const [tokens, extra] of campos) {
      const p = penalidadePalavraCliente(w, tokens);
      if (p + extra < melhor) melhor = p + extra;
    }
    if (melhor > 1) melhor = Math.min(melhor, penalidadeJuntaCliente(w, juntas));
    if (melhor === Infinity) {
      if (LIGACAO_BUSCA_CLIENTE.has(w) && palavras.length) continue;
      return null;
    }
    total += melhor;
    achou++;
  }
  if (!achou) return null;
  const frase = todas.length > 1 && ((' ' + nome + ' ').includes(' ' + q + ' ')
    || (' ' + fantasia + ' ').includes(' ' + q + ' ')) ? -1 : 0;
  return 10 + total + frase;
}
// Os clientes que batem com a busca, melhor primeiro (empate: nome mais curto, alfabético).
function ordenarClientesPorBusca(clientes, busca, limite) {
  const achados = [];
  for (const c of clientes) {
    const p = pontuarClienteBusca(c, busca);
    if (p !== null) achados.push([p, c]);
  }
  achados.sort((a, b) => a[0] - b[0]
    || String(a[1].nome || '').length - String(b[1].nome || '').length
    || String(a[1].nome || '').localeCompare(String(b[1].nome || '')));
  return achados.slice(0, limite || 20).map(r => r[1]);
}
// </motor-busca-cliente>

module.exports = { textoBuscaCliente, pontuarClienteBusca, ordenarClientesPorBusca };
