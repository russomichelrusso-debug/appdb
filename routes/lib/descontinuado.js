// Produto que saiu de linha: o código (ou o código base, no promocional
// P/P1/P2 + código) não está mais na Lista de Preços (catalogo_precos) - a
// LISTA PADRÃO só traz produto ativo (usuário, 10/2026). O cadastro
// `produtos` e o relatório oficial continuam com ele (pedidos e histórico
// antigos), então as telas de "o que o cliente comprou" mostravam o nome
// como se ainda fosse vendido. Pedido do usuário (10/2026): pôr
// "Descontinuado" na frente do nome.
//
// Marca na SAÍDA da rota (depois de agrupar/reconciliar - o nome entra em
// agrupamentos como grupoDoProduto) e devolve também `descontinuado: true`.
// Telas de "o que oferecer" (Recuperar, sugestões, Recompra, comprados
// recentes) tiram o descontinuado em vez de marcar (estaDescontinuado).
// Catálogo vazio (banco novo, importação ainda não feita) não marca nada.

const { grupoDoProduto } = require('./agrupamentoProduto');

const PREFIXO = 'Descontinuado · ';
const VALIDADE_MS = 5 * 60 * 1000;

let cache = null; // { codigos: Set, grupos: Set, em: ms }
let geracao = 0;  // sobe a cada importação: consulta que começou antes não grava o catálogo velho

async function catalogo(pool) {
  if (cache && Date.now() - cache.em < VALIDADE_MS) return cache;
  const minha = geracao;
  const r = await pool.query('SELECT codigo_sku, nome FROM catalogo_precos');
  const lido = {
    codigos: new Set(r.rows.map(x => String(x.codigo_sku))),
    // grupos (grupoDoProduto) que ainda têm produto ativo: código trocado
    // por um novo continua no mesmo grupo
    grupos: new Set(r.rows.filter(x => x.nome).map(x => grupoDoProduto(String(x.nome)).chave)),
    em: Date.now(),
  };
  if (minha === geracao) cache = lido;
  return lido;
}

async function codigosDoCatalogo(pool) {
  return (await catalogo(pool)).codigos;
}

// Importação da Lista de Preços: a próxima consulta já vê o catálogo novo.
function esquecerCatalogo() {
  geracao++;
  cache = null;
}

function estaDescontinuado(codigo, codigos) {
  if (!codigos || codigos.size === 0 || codigo == null) return false;
  const c = String(codigo);
  if (codigos.has(c)) return false;
  const promo = /^P[12]?(.+)$/.exec(c);
  return !(promo && codigos.has(promo[1]));
}

// Grupo (chave de grupoDoProduto) sem nenhum produto na Lista de Preços.
function grupoDescontinuado(chave, cat) {
  if (!cat || cat.codigos.size === 0) return false;
  return !cat.grupos.has(chave);
}

function nomeComDescontinuado(nome) {
  const n = nome == null ? '' : String(nome);
  return n.startsWith(PREFIXO) ? n : PREFIXO + n;
}

// rows: lista de objetos; campoNome: onde fica o nome ('produto', 'nome').
// Nome vazio não ganha prefixo (a tela mostra o código), só o selo.
async function marcarDescontinuados(pool, rows, campoNome, campoCodigo = 'codigo_sku') {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  let codigos;
  try {
    codigos = await codigosDoCatalogo(pool);
  } catch (e) {
    console.error('Não foi possível ler o catálogo pra marcar descontinuados:', e);
    return rows; // nunca derruba a tela por causa do selo
  }
  for (const row of rows) {
    if (!row || !estaDescontinuado(row[campoCodigo], codigos)) continue;
    row.descontinuado = true;
    if (row[campoNome]) row[campoNome] = nomeComDescontinuado(row[campoNome]);
  }
  return rows;
}

// Pra quem só quer filtrar: devolve o catálogo, ou null se não deu pra ler
// (aí nada é tirado - melhor sugerir um descontinuado que esconder um ativo).
async function catalogoOuNada(pool) {
  try {
    return await catalogo(pool);
  } catch (e) {
    console.error('Não foi possível ler o catálogo pra tirar descontinuados:', e);
    return null;
  }
}

module.exports = {
  marcarDescontinuados, estaDescontinuado, grupoDescontinuado, catalogoOuNada, codigosDoCatalogo, esquecerCatalogo, PREFIXO,
};
