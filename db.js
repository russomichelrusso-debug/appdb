const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

// Bancos gerenciados na nuvem (Render, Supabase, etc.) exigem conexão criptografada (SSL).
// Só desliga isso se DATABASE_URL não estiver definida (ex: rodando localmente sem banco real).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
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
