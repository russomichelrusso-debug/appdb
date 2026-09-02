const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Bancos gerenciados na nuvem (Render, Supabase, etc.) exigem conexão criptografada (SSL).
// Por padrão agora EXIGE certificado válido (rejectUnauthorized: true) - a maioria dos
// provedores usa certificado de autoridade reconhecida, então isso deve funcionar sem
// mudança nenhuma. Se der erro de certificado depois de subir isso, defina
// DB_SSL_INSECURE=true temporariamente enquanto investiga (não é o ideal, mas evita
// ficar fora do ar) - e me avisa, porque não deveria ser necessário no caso comum.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: process.env.DB_SSL_INSECURE === 'true' ? false : true }
    : false,
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

module.exports = { pool, runMigrations };
