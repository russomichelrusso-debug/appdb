// Produto do pedido/levantamento pelo código - compartilhado por
// routes/pedidos.js e routes/levantamentos.js.
//
// A tabela produtos (o que pedido_itens/levantamento_itens referenciam) era
// preenchida só pelo /api/produtos/sync, que roda quando um admin abre o
// Painel; a Lista de Preços grava em catalogo_precos. Produto novo da lista
// aparecia no app, entrava no pedido e o servidor recusava com "não
// encontrado" - e a fila offline tratava como passageiro (400) e tentava pra
// sempre. Agora a importação da lista já cria o produto (catalogoPrecos.js) e,
// se ainda faltar, ele é criado aqui a partir do catálogo.

// mesmo formato aceito no /api/produtos/sync e na Lista de Preços
const CODIGO_SKU_REGEX = /^[A-Za-z0-9._-]{1,30}$/;

// Erro que não muda tentando de novo (produto que não existe, item inválido):
// as rotas respondem 422 e a fila offline do app tira o envio como "recusado".
// 400/503 ficam pra falha passageira (banco), que a fila reenvia.
class ErroPermanente extends Error {}

// descricaoSeNovo: PDF oficial traz o nome do item - código que não está nem
// no catálogo é criado com ele (só código no formato aceito).
async function acharOuCriarProdutoPorSku(client, codigo_sku, descricaoSeNovo) {
  const achado = await client.query('SELECT id FROM produtos WHERE codigo_sku = $1', [codigo_sku]);
  if (achado.rows.length > 0) return achado.rows[0].id;
  const doCatalogo = await client.query(
    `/* produto:do-catalogo */
     INSERT INTO produtos (codigo_sku, nome, categoria)
     SELECT codigo_sku, COALESCE(NULLIF(trim(nome), ''), codigo_sku), familia FROM catalogo_precos WHERE codigo_sku = $1
     ON CONFLICT (codigo_sku) DO NOTHING RETURNING id`,
    [codigo_sku]
  );
  if (doCatalogo.rows.length > 0) return doCatalogo.rows[0].id;
  // produto promocional criado no Painel (só em configuracoes até um admin abrir
  // o Painel e sincronizar): o pedido feito com ele não pode ser recusado
  const doPromocional = await client.query(
    `/* produto:do-promocional */
     INSERT INTO produtos (codigo_sku, nome, categoria)
     SELECT p->>'c', COALESCE(NULLIF(trim(p->>'n'), ''), p->>'c'), p->>'familia'
     FROM configuracoes, jsonb_array_elements(CASE WHEN jsonb_typeof(valor) = 'array' THEN valor ELSE '[]'::jsonb END) p
     WHERE chave = 'produtos_promocionais' AND p->>'c' = $1
     LIMIT 1
     ON CONFLICT (codigo_sku) DO NOTHING RETURNING id`,
    [codigo_sku]
  );
  if (doPromocional.rows.length > 0) return doPromocional.rows[0].id;
  if (descricaoSeNovo) {
    if (!CODIGO_SKU_REGEX.test(String(codigo_sku))) {
      throw new ErroPermanente(`Código de produto em formato inválido: ${String(codigo_sku).slice(0, 40)}.`);
    }
    const criado = await client.query(
      'INSERT INTO produtos (codigo_sku, nome) VALUES ($1, $2) ON CONFLICT (codigo_sku) DO NOTHING RETURNING id',
      [codigo_sku, String(descricaoSeNovo)]
    );
    if (criado.rows.length > 0) return criado.rows[0].id;
  }
  // corrida: outro envio criou o mesmo produto entre o SELECT e o INSERT
  const depois = await client.query('SELECT id FROM produtos WHERE codigo_sku = $1', [codigo_sku]);
  if (depois.rows.length > 0) return depois.rows[0].id;
  // não é permanente: o catálogo pode chegar depois (sincronização do Painel,
  // Lista de Preços nova) - a fila offline tenta de novo (400) em vez de descartar
  throw new Error(`Produto com código ${codigo_sku} não encontrado no catálogo.`);
}

module.exports = { acharOuCriarProdutoPorSku, ErroPermanente, CODIGO_SKU_REGEX };
