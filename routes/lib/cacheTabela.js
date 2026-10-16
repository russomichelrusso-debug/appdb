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
// até ~1 s de atraso; por isso as importações também chamam esquecerTabela(),
// pra quem importou já ver o dado novo na hora.
//
// Se a consulta dos contadores falhar, lê a tabela direto (sem cache): nunca
// devolve dado velho por causa do cache.
//
// As linhas devolvidas são compartilhadas entre requisições: quem chama não
// pode alterá-las (todas as rotas daqui só leem e montam objeto novo).

const { pool } = require('../../db');

const cache = new Map(); // chave -> { tabela, versao, rows }
let geracao = 0; // sobe a cada esquecerTabela: leitura que começou antes não grava

async function versaoDaTabela(tabela) {
  const r = await pool.query(
    `/* CACHE-TABELA:VERSAO */ SELECT (n_tup_ins + n_tup_upd + n_tup_del)::text AS versao
     FROM pg_stat_user_tables WHERE schemaname = 'public' AND relname = $1`,
    [tabela]
  );
  return r.rows[0] ? String(r.rows[0].versao) : null;
}

// Linhas de `sql` (leitura da tabela `tabela` inteira), do cache enquanto a
// tabela não mudar. `chave` separa consultas diferentes da mesma tabela.
async function lerComCache(chave, tabela, sql) {
  let versao = null;
  try {
    versao = await versaoDaTabela(tabela);
  } catch (e) {
    console.error(`Cache de ${tabela}: não consegui ler a versão, lendo direto.`, e.message);
  }
  const guardado = cache.get(chave);
  if (versao != null && guardado && guardado.versao === versao) return guardado.rows;

  const minha = geracao;
  const r = await pool.query(sql);
  if (versao != null && minha === geracao) cache.set(chave, { tabela, versao, rows: r.rows });
  return r.rows;
}

// Depois de gravar na tabela: a próxima leitura vai ao banco.
function esquecerTabela(tabela) {
  geracao++;
  for (const [chave, v] of cache) if (v.tabela === tabela) cache.delete(chave);
}

// Nomes dos produtos (SELECT codigo_sku, nome FROM produtos), usado por vários
// relatórios. Devolve { rows } como o pool.query, pra trocar sem mexer no resto.
async function nomesDosProdutos() {
  return { rows: await lerComCache('produtos:nomes', 'produtos', 'SELECT codigo_sku, nome FROM produtos') };
}

module.exports = { lerComCache, esquecerTabela, nomesDosProdutos };
