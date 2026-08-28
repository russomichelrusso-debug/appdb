-- Schema do banco Cortag Revolution Tools - roda automaticamente toda vez
-- que o servidor sobe (ver db.js), então é seguro reenviar mesmo se já
-- existir - todo ALTER usa IF NOT EXISTS pra não dar erro em banco já criado.

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

CREATE TABLE IF NOT EXISTS produtos (
  id SERIAL PRIMARY KEY,
  codigo_sku TEXT UNIQUE NOT NULL,
  nome TEXT NOT NULL,
  categoria TEXT
);

CREATE TABLE IF NOT EXISTS vendedores (
  id SERIAL PRIMARY KEY,
  nome TEXT UNIQUE NOT NULL
);

CREATE TABLE IF NOT EXISTS pedidos (
  id SERIAL PRIMARY KEY,
  cliente_id INTEGER NOT NULL REFERENCES clientes(id),
  vendedor_id INTEGER REFERENCES vendedores(id),
  observacao TEXT,
  numero_cotacao TEXT,       -- identifica o pedido pra não duplicar se reprocessado
  origem TEXT NOT NULL DEFAULT 'app', -- 'app' | 'pdf' | 'faturamento'
  pdf_modificado_em TIMESTAMPTZ, -- data de modificação do arquivo PDF (metadado), usada pra saber qual versão é mais nova
  data_pedido TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS numero_cotacao TEXT;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'app';
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS pdf_modificado_em TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_numero_cotacao ON pedidos(numero_cotacao) WHERE numero_cotacao IS NOT NULL;

CREATE TABLE IF NOT EXISTS pedido_itens (
  id SERIAL PRIMARY KEY,
  pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  quantidade NUMERIC NOT NULL,
  preco_unitario NUMERIC NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS levantamentos (
  id SERIAL PRIMARY KEY,
  cliente_id INTEGER REFERENCES clientes(id),
  vendedor_id INTEGER REFERENCES vendedores(id),
  nome TEXT,
  data_visita TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS levantamento_itens (
  id SERIAL PRIMARY KEY,
  levantamento_id INTEGER NOT NULL REFERENCES levantamentos(id) ON DELETE CASCADE,
  produto_id INTEGER NOT NULL REFERENCES produtos(id),
  quantidade_contada NUMERIC NOT NULL DEFAULT 0,
  quantidade_pedido NUMERIC NOT NULL DEFAULT 0
);

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

-- Previsão de estoque (relatório tipo ESCE007) - compartilhada, todo mundo vê
-- a mesma coisa assim que o admin importa a planilha, sem precisar exportar
-- arquivo nenhum e subir no GitHub (diferente do precos.json).
CREATE TABLE IF NOT EXISTS previsao_estoque (
  codigo_sku TEXT PRIMARY KEY,
  qt_disponivel NUMERIC NOT NULL DEFAULT 0,
  qt_carteira NUMERIC NOT NULL DEFAULT 0,
  qt_compra NUMERIC NOT NULL DEFAULT 0,
  previsao DATE,
  saldo NUMERIC NOT NULL DEFAULT 0,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Configurações genéricas, guardadas como JSON por chave - usado hoje pras
-- campanhas promocionais (chave 'promocoes'), reaproveitável no futuro pra
-- qualquer outra coisa parecida (uma lista/objeto pequeno, compartilhado,
-- sem precisar de tabela própria pra cada caso.
CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Fichas técnicas (balão de informação) - tabela própria, não um bloco JSON
-- único em "configuracoes". Cada importação manda só o lote novo, o servidor
-- mescla por UPSERT - assim o tamanho do envio não cresce a cada catálogo
-- novo (o que acontecia antes e estourava o limite de tamanho do POST).
CREATE TABLE IF NOT EXISTS fichas_tecnicas (
  codigo_sku TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  descricao TEXT,
  foto TEXT NOT NULL,
  specs JSONB NOT NULL DEFAULT '{}',
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
