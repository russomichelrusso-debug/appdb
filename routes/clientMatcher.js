// Lógica de "achar ou criar cliente" compartilhada entre pedidos.js,
// levantamentos.js e a importação de faturamento - centralizada aqui pra não
// triplicar a mesma regra em três arquivos.
//
// Dois níveis de comparação por nome (quando não tem CNPJ pra comparar):
//   1) normalizada: maiúsculas, sem acento, espaço duplo colapsado
//   2) tolerante: igual à normalizada, mas também tira pontuação (ponto,
//      vírgula) - resolve casos tipo "EDD AL LTDA." vs "EDD AL LTDA" sem
//      pedir confirmação, já que a diferença é só um caractere de pontuação.

function sqlNormalizado(coluna, valor){
  return { sql: `regexp_replace(upper(trim(${coluna})), '\\s+', ' ', 'g') = regexp_replace(upper(trim($N)), '\\s+', ' ', 'g')`, valor };
}

async function acharClientePorNome(client, nome){
  // nível 1: normalizado (maiúscula/espaço)
  const exato = await client.query(
    `SELECT id FROM clientes
     WHERE regexp_replace(upper(trim(nome)), '\\s+', ' ', 'g') = regexp_replace(upper(trim($1)), '\\s+', ' ', 'g')
     LIMIT 1`,
    [nome]
  );
  if(exato.rows.length > 0) return exato.rows[0].id;

  // nível 2: tolerante a pontuação (tira . e , antes de comparar)
  const tolerante = await client.query(
    `SELECT id FROM clientes
     WHERE regexp_replace(upper(trim(nome)), '[.,\\s]+', ' ', 'g') = regexp_replace(upper(trim($1)), '[.,\\s]+', ' ', 'g')
     LIMIT 1`,
    [nome]
  );
  if(tolerante.rows.length > 0) return tolerante.rows[0].id;

  return null;
}

async function acharOuCriarCliente(client, { cliente_id, nome, documento, contato }) {
  if (cliente_id) return cliente_id;
  if (documento) {
    const existing = await client.query(
      `SELECT id FROM clientes WHERE regexp_replace(documento, '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g') LIMIT 1`,
      [documento]
    );
    if (existing.rows.length > 0) return existing.rows[0].id;
  }
  if (nome) {
    const porNome = await acharClientePorNome(client, nome);
    if (porNome) return porNome;
  }
  const result = await client.query(
    'INSERT INTO clientes (nome, documento, contato) VALUES ($1, $2, $3) RETURNING id',
    [nome, documento || null, contato || null]
  );
  return result.rows[0].id;
}

module.exports = { acharOuCriarCliente, acharClientePorNome };
