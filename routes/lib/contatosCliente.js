// Contatos comerciais do cliente (pro Salesforce): telefone comercial, e-mail
// comercial e e-mail NF/XML. Mesmas regras no app (index.html,
// normalizarWhatsBr/normalizarEmails) - o servidor confere de novo.

// "(44) 3025-1180", "+55 44 99812-4471" -> "554430251180" (55 + DDD + 8 ou 9
// dígitos), ou null fora do formato. Fixo também vale (telefone comercial).
function normalizarTelefoneBr(texto) {
  let d = String(texto || '').replace(/\D/g, '').replace(/^0+/, '');
  if ((d.length === 12 || d.length === 13) && !d.startsWith('55')) d = d.slice(2); // código da operadora
  if (d.length === 10 || d.length === 11) d = '55' + d;
  if (!/^55[1-9]{2}\d{8,9}$/.test(d)) return null;
  if (d.length === 13 && d[4] !== '9') return null; // celular de 9 dígitos começa com 9
  return d;
}

const RE_EMAIL = /^[^\s@;,]+@[^\s@;,]+\.[^\s@;,]+$/;
// Um ou mais e-mails (NF/XML costuma ter dois) separados por ; , ou espaço ->
// "a@x.com; b@y.com" em minúsculas, ou null se algum não for e-mail.
function normalizarEmails(texto, max = 3) {
  const lista = String(texto || '').toLowerCase().split(/[;,\s]+/).filter(Boolean);
  if (!lista.length || lista.length > max || !lista.every(e => RE_EMAIL.test(e) && e.length <= 120)) return null;
  return [...new Set(lista)].join('; ');
}

module.exports = { normalizarTelefoneBr, normalizarEmails };
