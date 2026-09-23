// Lógica de "achar ou criar cliente" compartilhada entre pedidos.js,
// levantamentos.js e a importação de faturamento - centralizada aqui pra não
// triplicar a mesma regra em três arquivos.
//
// Dois níveis de comparação por nome (quando não tem CNPJ pra comparar):
//   1) normalizada: maiúsculas, sem acento, espaço duplo colapsado
//   2) tolerante: igual à normalizada, mas também tira pontuação (ponto,
//      vírgula) - resolve casos tipo "EDD AL LTDA." vs "EDD AL LTDA" sem
//      pedir confirmação, já que a diferença é só um caractere de pontuação.

async function acharClientePorNome(client, nome){
  const exato = await client.query(
    `SELECT id FROM clientes
     WHERE regexp_replace(upper(trim(nome)), '\\s+', ' ', 'g') = regexp_replace(upper(trim($1)), '\\s+', ' ', 'g')
     LIMIT 1`,
    [nome]
  );
  if(exato.rows.length > 0) return exato.rows[0].id;

  const tolerante = await client.query(
    `SELECT id FROM clientes
     WHERE regexp_replace(upper(trim(nome)), '[.,\\s]+', ' ', 'g') = regexp_replace(upper(trim($1)), '[.,\\s]+', ' ', 'g')
     LIMIT 1`,
    [nome]
  );
  if(tolerante.rows.length > 0) return tolerante.rows[0].id;

  return null;
}

async function acharOuCriarCliente(client, { cliente_id, nome, documento, codigo_oficial, contato }) {
  if (cliente_id) return cliente_id;
  // Cod.Cliente do ERP é a chave mais confiável quando existe - vem antes de
  // CNPJ e nome porque diferencia clientes com o mesmo nome mas CNPJs
  // diferentes (o nome sozinho, e às vezes até o CNPJ digitado errado na
  // planilha, pode confundir os dois).
  if (codigo_oficial) {
    const porCodigo = await client.query('SELECT id FROM clientes WHERE codigo_oficial = $1 LIMIT 1', [codigo_oficial]);
    if (porCodigo.rows.length > 0) return porCodigo.rows[0].id;
  }
  if (documento) {
    const existing = await client.query(
      `SELECT id FROM clientes WHERE regexp_replace(documento, '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g') LIMIT 1`,
      [documento]
    );
    if (existing.rows.length > 0) return existing.rows[0].id;
  }
  if (nome) {
    const porNome = await acharClientePorNome(client, nome);
    if (porNome) {
      // Se veio um codigo_oficial e o cliente achado por nome já tem um
      // código diferente, não é o mesmo cliente - são duas empresas com
      // nome igual e Cod.Cliente diferente (o bug real que motivou dar
      // prioridade ao código: não pode "herdar" o cadastro de outra
      // empresa só porque o nome bate). Cai pra criar um cliente novo.
      if (codigo_oficial) {
        const candidato = await client.query('SELECT codigo_oficial FROM clientes WHERE id = $1', [porNome]);
        const codigoAtual = candidato.rows[0]?.codigo_oficial;
        if (!codigoAtual || codigoAtual === codigo_oficial) return porNome;
      } else {
        return porNome;
      }
    }
  }
  // ON CONFLICT DO NOTHING sem alvo específico cobre tanto o índice único de
  // documento quanto o de codigo_oficial - evita que uma corrida (duas
  // requisições checando "não existe" ao mesmo tempo e tentando criar o
  // mesmo cliente) suba como erro 23505 genérico pra quem chamou.
  const result = await client.query(
    'INSERT INTO clientes (nome, documento, codigo_oficial, contato) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING RETURNING id',
    [nome, documento || null, codigo_oficial || null, contato || null]
  );
  if (result.rows.length > 0) return result.rows[0].id;

  // o insert não voltou nada: outra requisição criou o cliente entre a
  // checagem lá em cima e este insert - busca de novo pra achar o id dela.
  if (codigo_oficial) {
    const porCodigo = await client.query('SELECT id FROM clientes WHERE codigo_oficial = $1 LIMIT 1', [codigo_oficial]);
    if (porCodigo.rows.length > 0) return porCodigo.rows[0].id;
  }
  if (documento) {
    const porDoc = await client.query(
      `SELECT id FROM clientes WHERE regexp_replace(documento, '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g') LIMIT 1`,
      [documento]
    );
    if (porDoc.rows.length > 0) return porDoc.rows[0].id;
  }
  throw new Error(`Corrida ao criar cliente "${nome}" - não encontrei o registro depois do conflito.`);
}

module.exports = { acharOuCriarCliente, acharClientePorNome };
