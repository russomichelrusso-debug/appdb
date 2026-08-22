-- Esquema do banco de dados Cortag - histórico de clientes, pedidos e levantamentos
-- Roda automaticamente quando o backend inicia (ver server.js), mas também pode
-- ser executado manualmente no console SQL do Render se preferir.

CREATE TABLE IF NOT EXISTS clientes (
  id SERIAL PRIMARY KEY,
  nome TEXT NOT NULL,
  documento TEXT UNIQUE,           -- CNPJ/CPF, evita duplicar o mesmo cliente
  contato TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
  observacao TEXT
);

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
