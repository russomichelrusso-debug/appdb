-- Esquema do banco de dados Cortag - histórico de clientes, pedidos e levantamentos
-- Roda automaticamente quando o backend inicia (ver server.js), mas também pode
-- ser executado manualmente no console SQL do Render se preferir.

CREATE TABLE IF NOT EXISTS clientes (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  documento TEXT UNIQUE,           -- CNPJ/CPF, evita duplicar o mesmo cliente
  contato TEXT,
  classificatorio_tipo TEXT,       -- Varejo Master/Premium/Exclusive/Rede - vem do relatório de faturamento
  classificatorio_desconto NUMERIC, -- percentual correspondente (20/17/15/18)
  classificatorio_atualizado_em DATE, -- data do relatório que definiu esse classificatório (evita voltar pra um valor velho)
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS classificatorio_tipo TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS classificatorio_desconto NUMERIC;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS classificatorio_atualizado_em DATE;

CREATE TABLE IF NOT EXISTS vendedores (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS produtos (
  id SERIAL PRIMARY KEY,
  codigo_sku TEXT UNIQUE NOT NULL,
  nome TEXT NOT NULL,
  categoria TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pedidos (
  id SERIAL PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  vendedor_id INTEGER REFERENCES vendedores(id),
  data_pedido TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'confirmado',
  observacao TEXT,
  numero_cotacao TEXT,
  origem TEXT NOT NULL DEFAULT 'app'
);
-- Número da cotação (vindo do PDF oficial) evita duplicar o mesmo pedido se
-- o arquivo for consolidado mais de uma vez por engano. Fica opcional (NULL)
-- pra não quebrar pedidos gravados manualmente pelo "Finalizar pedido", que
-- não têm essa numeração.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS numero_cotacao TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'app';
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pdf_modificado_em TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_numero_cotacao ON pedidos(numero_cotacao) WHERE numero_cotacao IS NOT NULL;

CREATE TABLE IF NOT EXISTS pedido_itens (
  id SERIAL PRIMARY KEY,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  quantidade NUMERIC NOT NULL,
  preco_unitario NUMERIC NOT NULL   -- preço de fato cobrado, histórico - não muda se o preço vigente mudar depois
);

CREATE TABLE IF NOT EXISTS levantamentos (
  id SERIAL PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  vendedor_id INTEGER REFERENCES vendedores(id),
  data_visita TIMESTAMPTZ NOT NULL DEFAULT now(),
  nome TEXT                          -- rótulo livre opcional, ex: "Levantamento trimestral"
);

CREATE TABLE IF NOT EXISTS levantamento_itens (
  id SERIAL PRIMARY KEY,
  levantamento_id INTEGER NOT NULL REFERENCES levantamentos(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  quantidade_contada NUMERIC NOT NULL
);

-- Índices que aceleram os relatórios de histórico/rotatividade
CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON pedidos(cliente_id, data_pedido DESC);
CREATE INDEX IF NOT EXISTS idx_pedido_itens_produto ON pedido_itens(produto_id);
CREATE INDEX IF NOT EXISTS idx_levantamentos_cliente ON levantamentos(cliente_id, data_visita DESC);
CREATE INDEX IF NOT EXISTS idx_levantamento_itens_produto ON levantamento_itens(produto_id);

-- Login de usuário (vendedores acessando o app) e sessões ("lembrar-me")
CREATE TABLE IF NOT EXISTS usuarios (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  usuario TEXT UNIQUE NOT NULL,
  senha_hash TEXT NOT NULL,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Garante a coluna também em bancos que já tinham a tabela criada antes
-- dela existir (sem isso, "CREATE TABLE IF NOT EXISTS" não adicionaria a
-- coluna nova em quem já tinha rodado o schema antigo).
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS sessoes (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  expira_em TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessoes_expira ON sessoes(expira_em);
