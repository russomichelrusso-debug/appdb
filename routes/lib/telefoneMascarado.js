// Telefone da ficha de CNPJ que o radar-cnpj passou a mandar escondido (ficha
// "mascarada", desde 25/09/2026): "(44) 3•••••03". A BrasilAPI traz o número
// inteiro ("(44) 35681403"). Só troca quando o número bate com o que aparece:
// mesmo DDD, mesmos dígitos visíveis e a mesma quantidade de dígitos escondidos
// (conferido em 18/10/2026 contra a BrasilAPI: todo número que ela tinha bateu).

function telefoneMascarado(v) {
  return /•/.test(String(v || ''));
}

// "(44) 3•••••03" -> /^44 3\d{5}03$/ sobre "44 35681403" (DDD e número só com dígitos)
function padraoDoMascarado(v) {
  const m = String(v || '').match(/^\s*\((\d{2,4})\)\s*([\d•]+)\s*$/);
  if (!m) return null;
  const corpo = m[2].replace(/•/g, '\\d');
  return new RegExp(`^${m[1]} ${corpo}$`);
}

function dddENumero(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length < 10 || /^0+$/.test(d)) return null;
  return `${d.slice(0, 2)} ${d.slice(2)}`;
}

// candidatos: telefones de outras fontes ("(44) 35681403", "4435681403"...).
// Devolve o primeiro que bate, no formato do candidato; senão o mascarado.
function completarTelefone(mascarado, candidatos) {
  if (!telefoneMascarado(mascarado)) return mascarado;
  const padrao = padraoDoMascarado(mascarado);
  if (!padrao) return mascarado;
  const achado = (Array.isArray(candidatos) ? candidatos : [])
    .find((c) => c && !telefoneMascarado(c) && padrao.test(dddENumero(c) || ''));
  return achado || mascarado;
}

module.exports = { telefoneMascarado, completarTelefone };
