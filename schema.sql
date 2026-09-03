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
  usuario TEXT UNIQUE,             -- sistema antigo (usuário/senha) - mantido só pra não perder histórico, não é mais usado pra login
  senha_hash TEXT,                 -- idem - login hoje é só via Google (id_token), não por senha
  email TEXT UNIQUE,               -- e-mail da conta Google - é isso que identifica o login agora
  google_sub TEXT UNIQUE,          -- "sub" (id único da conta) devolvido pelo Google, gravado no primeiro login de fato
  is_admin BOOLEAN NOT NULL DEFAULT false,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Garante as colunas também em bancos que já tinham a tabela criada antes
-- delas existirem (sem isso, "CREATE TABLE IF NOT EXISTS" não adicionaria
-- coluna nova em quem já tinha rodado uma versão anterior do schema).
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS google_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_usuarios_google_sub ON usuarios(google_sub) WHERE google_sub IS NOT NULL;
-- Bancos criados antes da troca pro login por Google tinham usuario/senha_hash
-- como obrigatórios - relaxa isso pra permitir cadastrar gente só com e-mail.
ALTER TABLE usuarios ALTER COLUMN usuario DROP NOT NULL;
ALTER TABLE usuarios ALTER COLUMN senha_hash DROP NOT NULL;

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

-- Códigos oficiais (EAN-13 da unidade e DUN-14 da caixa fechada) por SKU -
-- corrige/completa o EAN que já vem no catálogo de preços, e adiciona o
-- código da caixa fechada, usado no Levantamento pra somar a quantidade da
-- embalagem padrão de uma vez, sem precisar abrir a caixa e escanear
-- unidade por unidade.
CREATE TABLE IF NOT EXISTS codigos_produto (
  codigo_sku TEXT PRIMARY KEY,
  ean13 TEXT,
  dun14 TEXT,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_codigos_produto_dun14 ON codigos_produto(dun14) WHERE dun14 IS NOT NULL AND dun14 != '';

-- Código do cliente no sistema oficial da empresa (ex: "Cod. Cliente" do
-- relatório de Carteira/Faturamento) - aprendido automaticamente na primeira
-- importação (casando por nome), usado depois pra ligar com confiança as
-- linhas de pedidos_oficiais_itens a esse cliente, sem depender de casar
-- nome de novo toda vez.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS codigo_oficial TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_clientes_codigo_oficial ON clientes(codigo_oficial) WHERE codigo_oficial IS NOT NULL;

-- Situação de pedidos no sistema OFICIAL da empresa (relatório de Carteira +
-- Faturamento), guardada separada da tabela "pedidos" (que é só o que o
-- vendedor bate no próprio app). As duas fontes não têm número em comum,
-- então em vez de tentar mesclar (arriscado), mostramos as duas lado a lado
-- no histórico do cliente. "Nr.Pedido" + "codigo_sku" é a chave - o mesmo
-- Nr.Pedido aparece na Carteira (ainda não faturado) e depois no Faturamento
-- (já faturado); reimportar não duplica, só atualiza o status pra faturado.
CREATE TABLE IF NOT EXISTS pedidos_oficiais_itens (
  nr_pedido TEXT NOT NULL,
  codigo_sku TEXT NOT NULL,
  cliente_codigo_oficial TEXT NOT NULL,
  quantidade NUMERIC NOT NULL DEFAULT 0,
  valor NUMERIC,
  data_implantacao DATE,
  data_faturamento DATE,
  status TEXT NOT NULL DEFAULT 'carteira',
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (nr_pedido, codigo_sku)
);
CREATE INDEX IF NOT EXISTS idx_pedidos_oficiais_cliente ON pedidos_oficiais_itens(cliente_codigo_oficial);
-- Colunas adicionadas depois da criação original da tabela - "ADD COLUMN IF
-- NOT EXISTS" garante que existam tanto em banco novo quanto no que já
-- tinha a tabela criada sem elas.
ALTER TABLE pedidos_oficiais_itens ADD COLUMN IF NOT EXISTS nota_fiscal TEXT;
ALTER TABLE pedidos_oficiais_itens ADD COLUMN IF NOT EXISTS classificatorio TEXT;
-- Transportadora e situação do pedido (Total/Parcial) - só vêm preenchidas
-- na aba Faturamento do relatório oficial (a Carteira não tem transportadora
-- ainda, faz sentido: só se sabe depois que foi despachado).
ALTER TABLE pedidos_oficiais_itens ADD COLUMN IF NOT EXISTS transportadora TEXT;
ALTER TABLE pedidos_oficiais_itens ADD COLUMN IF NOT EXISTS situacao_pedido TEXT;

-- Catálogo completo de preços: um valor por produto x canal x estado (27 UFs
-- x 6 canais). Guardado em JSONB por produto (não um blob único gigante) pra
-- não repetir o problema de tamanho que já tivemos com fichas técnicas.
CREATE TABLE IF NOT EXISTS catalogo_precos (
  codigo_sku TEXT PRIMARY KEY,
  nome TEXT,
  emb INTEGER,
  ncm TEXT,
  ipi NUMERIC,
  familia TEXT,
  preco_fixo BOOLEAN NOT NULL DEFAULT false,
  canais_fx JSONB NOT NULL DEFAULT '[]',
  precos JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Converte quem já tinha essa coluna como TEXT[] (versão anterior deste
-- schema) pra JSONB - sem isso, "CREATE TABLE IF NOT EXISTS" não mudaria o
-- tipo de coluna que já existe. Se a coluna já for JSONB, o "USING" abaixo
-- não dá erro (o driver do Postgres ignora conversão pro mesmo tipo).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'catalogo_precos' AND column_name = 'canais_fx' AND data_type = 'ARRAY'
  ) THEN
    ALTER TABLE catalogo_precos ALTER COLUMN canais_fx DROP DEFAULT;
    ALTER TABLE catalogo_precos ALTER COLUMN canais_fx TYPE JSONB USING to_jsonb(canais_fx);
    ALTER TABLE catalogo_precos ALTER COLUMN canais_fx SET DEFAULT '[]'::jsonb;
  END IF;
END $$;
