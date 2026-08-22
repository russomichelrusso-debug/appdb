const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// O Render preenche DATABASE_URL sozinho quando o banco é conectado ao serviço.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
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
}

module.exports = { pool, runMigrations };
