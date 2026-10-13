// Produto que saiu de linha: o código (ou o código base, no promocional
// P/P1/P2 + código) não está mais na Lista de Preços (catalogo_precos). O
// cadastro `produtos` e o relatório oficial continuam com ele (pedidos e
// histórico antigos), então as telas de "o que o cliente comprou" mostravam
// o nome como se ainda fosse vendido. Pedido do usuário (10/2026): pôr
// "Descontinuado" na frente do nome.
//
// Marca na SAÍDA da rota (depois de agrupar/reconciliar - o nome entra em
// agrupamentos como grupoDoProduto) e devolve também `descontinuado: true`.
// Catálogo vazio (banco novo, importação ainda não feita) não marca nada.

const PREFIXO = 'Descontinuado · ';
const VALIDADE_MS = 5 * 60 * 1000;

let cache = null; // { codigos: Set, em: ms }

async function codigosDoCatalogo(pool) {
  if (cache && Date.now() - cache.em < VALIDADE_MS) return cache.codigos;
  const r = await pool.query('SELECT codigo_sku FROM catalogo_precos');
  cache = { codigos: new Set(r.rows.map(x => String(x.codigo_sku))), em: Date.now() };
  return cache.codigos;
}

// Importação da Lista de Preços: a próxima consulta já vê o catálogo novo.
function esquecerCatalogo() {
  cache = null;
}

function estaDescontinuado(codigo, catalogo) {
  if (!catalogo || catalogo.size === 0 || codigo == null) return false;
  const c = String(codigo);
  if (catalogo.has(c)) return false;
  const promo = /^P[12]?(.+)$/.exec(c);
  return !(promo && catalogo.has(promo[1]));
}

function nomeComDescontinuado(nome) {
  const n = nome == null ? '' : String(nome);
  return n.startsWith(PREFIXO) ? n : PREFIXO + n;
}

// rows: lista de objetos; campoNome: onde fica o nome ('produto', 'nome').
// Nome vazio não ganha prefixo (a tela mostra o código), só o selo.
async function marcarDescontinuados(pool, rows, campoNome, campoCodigo = 'codigo_sku') {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  let catalogo;
  try {
    catalogo = await codigosDoCatalogo(pool);
  } catch (e) {
    console.error('Não foi possível ler o catálogo pra marcar descontinuados:', e);
    return rows; // nunca derruba a tela por causa do selo
  }
  for (const row of rows) {
    if (!row || !estaDescontinuado(row[campoCodigo], catalogo)) continue;
    row.descontinuado = true;
    if (row[campoNome]) row[campoNome] = nomeComDescontinuado(row[campoNome]);
  }
  return rows;
}

module.exports = { marcarDescontinuados, estaDescontinuado, esquecerCatalogo, PREFIXO };
