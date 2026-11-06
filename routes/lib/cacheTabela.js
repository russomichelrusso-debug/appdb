// Cache em memória das leituras de tabela inteira que todo aparelho faz ao
// abrir o app (catálogo de preços, fichas técnicas, códigos EAN/DUN, nomes
// dos produtos). Motivo (10/2026): o Supabase avisou que o projeto passou da
// cota de egress do plano grátis (5,5 GB/mês) - tudo que sai do banco pro
// servidor do Render conta, e só o GET /api/catalogo-precos (~1,25 MB por
// leitura) somava ~1,9 GB desde agosto, relido do banco a cada abertura do app.
//
// Como sabe que a tabela mudou: pelos contadores de linhas inseridas/
// alteradas/apagadas do próprio Postgres (pg_stat_user_tables), uma consulta
// de uma linha por tabela. Vale pra qualquer escrita - importação do Painel,
// sincronização, correção feita direto por SQL no Supabase -, sem precisar
// lembrar de limpar o cache em cada rota que grava. Os contadores chegam com
// atraso (~1 s, até ~10 s numa conexão que acabou de gravar estatística); por
// isso as rotas do app que gravam nessas tabelas também chamam esquecerTabela(),
// pra quem gravou já ver o dado novo na hora.
//
// Se a consulta dos contadores falhar, lê a tabela direto (sem cache): nunca
// devolve dado velho por causa do cache.
//
// As linhas devolvidas são compartilhadas entre requisições: quem chama não
// pode alterá-las (todas as rotas daqui só leem e montam objeto novo).

const { pool } = require('../../db');

const cache = new Map(); // chave -> { tabelas, versao, rows }
let geracao = 0; // sobe a cada esquecerTabela: leitura que começou antes não grava

// Contadores de todas as tabelas numa consulta só. Na abertura do app ~20
// requisições chegam juntas e cada leitura com cache conferia a sua tabela numa
// consulta (e numa conexão do pool) própria: agora as que chegam enquanto uma
// conferência está em andamento esperam a mesma resposta.
let conferindo = null;
function contadoresDasTabelas() {
  if (!conferindo) {
    conferindo = pool.query(
      `/* CACHE-TABELA:VERSAO */ SELECT relname, (n_tup_ins + n_tup_upd + n_tup_del)::text AS versao
       FROM pg_stat_user_tables WHERE schemaname = 'public'`
    ).then(r => new Map(r.rows.map(l => [l.relname, String(l.versao)])))
      .finally(() => { conferindo = null; });
  }
  return conferindo;
}

// Versão do conjunto de tabelas (null = alguma não apareceu: lê sem cache).
async function versaoDasTabelas(tabelas) {
  const mapa = await contadoresDasTabelas();
  const partes = [];
  for (const t of tabelas) {
    if (!mapa.has(t)) return null;
    partes.push(mapa.get(t));
  }
  return partes.join(',');
}

// Linhas de `sql`, do cache enquanto nenhuma das `tabelas` (nome ou lista) que
// ele lê mudar. `chave` separa consultas diferentes; `params` (ex.: o dia de
// hoje) entram na versão: parâmetro diferente = lê de novo e troca a guardada.
async function lerComCache(chave, tabelas, sql, params) {
  const lista = Array.isArray(tabelas) ? tabelas : [tabelas];
  let versao = null;
  try {
    const v = await versaoDasTabelas(lista);
    if (v != null) versao = params && params.length ? `${v}|${JSON.stringify(params)}` : v;
  } catch (e) {
    console.error(`Cache de ${lista.join(', ')}: não consegui ler a versão, lendo direto.`, e.message);
  }
  const guardado = cache.get(chave);
  if (versao != null && guardado && guardado.versao === versao) return guardado.rows;

  const minha = geracao;
  const r = params && params.length ? await pool.query(sql, params) : await pool.query(sql);
  if (versao != null && minha === geracao) cache.set(chave, { tabelas: lista, versao, rows: r.rows });
  return r.rows;
}

// Depois de gravar na tabela: a próxima leitura vai ao banco.
function esquecerTabela(tabela) {
  geracao++;
  for (const [chave, v] of cache) if (v.tabelas.includes(tabela)) cache.delete(chave);
}

// Nomes dos produtos (SELECT codigo_sku, nome FROM produtos), usado por vários
// relatórios. Devolve { rows } como o pool.query, pra trocar sem mexer no resto.
async function nomesDosProdutos() {
  return { rows: await lerComCache('produtos:nomes', 'produtos', 'SELECT codigo_sku, nome FROM produtos') };
}

module.exports = { lerComCache, esquecerTabela, nomesDosProdutos };
