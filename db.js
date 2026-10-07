const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Bancos gerenciados na nuvem (Render, Supabase, etc.) exigem conexão criptografada (SSL).
// Por padrão agora EXIGE certificado válido (rejectUnauthorized: true) - a maioria dos
// provedores usa certificado de autoridade reconhecida, então isso deve funcionar sem
// mudança nenhuma. Se der erro de certificado depois de subir isso, defina
// DB_SSL_INSECURE=true temporariamente enquanto investiga (não é o ideal, mas evita
// ficar fora do ar) - e me avisa, porque não deveria ser necessário no caso comum.
//
// Limites do pool: no máximo POOL_MAX conexões (o padrão do pg, agora explícito);
// quem espera conexão livre desiste em ESPERA_CONEXAO_MS em vez de ficar parado
// pra sempre; conexão ociosa fecha em 30 s. Cada consulta tem no máximo
// LIMITE_CONSULTA_MS (statement_timeout, ver o onConnect abaixo) - uma consulta
// que trava não segura uma conexão do pool indefinidamente.
const POOL_MAX = Number(process.env.PG_POOL_MAX) || 10;
const ESPERA_CONEXAO_MS = 20000;
const LIMITE_CONSULTA_MS = 60000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: process.env.DB_SSL_INSECURE === 'true' ? false : true }
    : false,
  max: POOL_MAX,
  connectionTimeoutMillis: ESPERA_CONEXAO_MS,
  idleTimeoutMillis: 30000,
  // statement_timeout por SET na conexão nova (e não como parâmetro de partida):
  // funciona igual no Postgres local e no Session pooler do Supabase, que mantém
  // a sessão. O pool espera esse hook terminar antes de entregar a conexão.
  onConnect: (client) => client.query(`SET statement_timeout = ${LIMITE_CONSULTA_MS}`),
});

// Sem esse listener, um cliente ocioso do pool que perde a conexão (comum
// com poolers gerenciados, tipo o "Session pooler" do Supabase, que fecham
// conexões ociosas de vez em quando) derruba o processo inteiro - o `pg`
// emite um evento 'error' no Pool, e sem ninguém ouvindo esse evento o
// Node trata como exceção não tratada e mata o servidor.
pool.on('error', (err) => {
  console.error('Erro inesperado numa conexão ociosa do pool:', err);
});

// Roda o schema.sql inteiro na subida do servidor. Como todas as tabelas usam
// "CREATE TABLE IF NOT EXISTS", isso é seguro de rodar toda vez (não apaga nada
// que já existe) - funciona como uma migração automática simples.
async function runMigrations() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(schemaSql);
  console.log('Esquema do banco verificado/criado com sucesso.');

  // Aproveita a subida pra limpar sessões que já venceram. Elas não dão mais
  // acesso a nada (toda consulta filtra por expira_em), mas sem isso ficariam
  // acumulando pra sempre e ocupando espaço à toa.
  try {
    const limpeza = await pool.query('DELETE FROM sessoes WHERE expira_em < now()');
    if (limpeza.rowCount > 0) console.log(`Sessões expiradas removidas: ${limpeza.rowCount}`);
  } catch (e) {
    console.warn('Não foi possível limpar sessões expiradas:', e.message);
  }
}

// Registra quem fez uma importação em massa (catálogo, produtos, clientes,
// previsão de estoque, pedidos oficiais) - essas rotas continuam abertas pra
// qualquer usuário logado, isso aqui só deixa rastreável quem mandou o quê.
// Falha de log nunca deve derrubar a importação em si, por isso engole erro.
async function registrarImportacao(usuarioId, rota, itensProcessados) {
  try {
    await pool.query(
      'INSERT INTO import_log (usuario_id, rota, itens_processados) VALUES ($1, $2, $3)',
      [usuarioId || null, rota, itensProcessados || 0]
    );
  } catch (e) {
    console.error('Erro ao registrar importação em import_log:', e);
  }
}

module.exports = { pool, runMigrations, registrarImportacao };
