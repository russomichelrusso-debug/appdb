// Contas que hoje são de OUTRO vendedor, pelo último relatório "Todas Contas"
// do Salesforce (routes/contasSalesforce.js): situação Ativo e proprietário
// diferente do principal do relatório. Saem das listas de oportunidade (Para
// reativar, Visitas, Perto de mim, Rota, alertas de classificatório e contas sem
// comprar do Dashboard) - o cliente compra, só que com outro vendedor. As
// vendas antigas continuam contando no faturamento (foram do representante).
const { pool } = require('../../db');

// id do cliente (texto) -> nome do proprietário
async function clientesDeOutroVendedor(db = pool) {
  const r = await db.query(
    `/* contas-sf:outros */ SELECT cliente_id, proprietario FROM contas_salesforce
     WHERE de_outro_vendedor AND cliente_id IS NOT NULL`);
  return new Map(r.rows.map(l => [String(l.cliente_id), l.proprietario || 'outro vendedor']));
}

// ids (texto) das contas INATIVAS no Salesforce. As que viraram cliente pela
// importação vêm com classificatório e sem compra no app: quem chama tira dos
// alertas de classificatório só as que ainda não compraram (estão no Para reativar)
async function clientesInativosNoSalesforce(db = pool) {
  const r = await db.query(
    `/* contas-sf:inativos */ SELECT cliente_id FROM contas_salesforce WHERE cliente_id IS NOT NULL AND situacao = 'Inativo'`);
  return new Set(r.rows.map(l => String(l.cliente_id)));
}

// Proprietário principal = o que tem mais contas ativas no relatório (o dono da
// carteira que exportou); empate pelo total de contas.
function proprietarioPrincipal(contas) {
  const porDono = new Map();
  for (const c of contas) {
    const dono = c.proprietario;
    if (!dono) continue;
    const p = porDono.get(dono) || { ativos: 0, total: 0 };
    p.total++;
    if (ehAtivo(c.situacao)) p.ativos++;
    porDono.set(dono, p);
  }
  let melhor = null;
  for (const [dono, p] of porDono) {
    const m = melhor && porDono.get(melhor);
    if (!m || p.ativos > m.ativos || (p.ativos === m.ativos && p.total > m.total)) melhor = dono;
  }
  return melhor;
}

function ehAtivo(situacao) {
  return String(situacao || '').trim().toUpperCase() === 'ATIVO';
}

// "44 3664 1112 44 9 91268052", "(43) 98433-0757", "43 999534188 Angelica":
// o primeiro número com DDD (10 ou 11 dígitos) - o resto é texto livre
function primeiroTelefone(texto) {
  const partes = String(texto || '').replace(/[()./-]/g, ' ').replace(/[,;]/g, ' ; ').split(/\s+/).filter(Boolean);
  let d = '';
  for (const p of partes) {
    if (!/^\d+$/.test(p)) { d = ''; continue; }
    d += d ? p : p.replace(/^0+/, ''); // "044 3367-8707"
    if (d.length < 10) continue;
    if (d.length <= 11 && /^[1-9]{2}/.test(d)) return d;
    d = '';
  }
  return null;
}

module.exports = { clientesDeOutroVendedor, clientesInativosNoSalesforce, proprietarioPrincipal, ehAtivo, primeiroTelefone };
