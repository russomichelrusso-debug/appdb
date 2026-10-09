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
-- Vindos da planilha "Classificatório" do ERP (agrupamento de empresas
-- irmãs/Matriz-Filial pra somar faturamento, e metas individuais
-- negociadas à parte - ver routes/clientesClassificatorio.js).
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS matriz_grupo TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS classificatorio_pic BOOLEAN DEFAULT false;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS classificatorio_vl_acordo NUMERIC;
CREATE INDEX IF NOT EXISTS idx_clientes_matriz_grupo ON clientes (matriz_grupo) WHERE matriz_grupo IS NOT NULL;

-- Foto dos números financeiros da planilha "Classificatório" do ERP, um por
-- cliente, trocada a cada importação (a do relatório mais novo vence). São os
-- números OFICIAIS da apuração mensal do ERP - fechada até `apurado_ate`
-- (maior Ult.Compra da planilha), por isso podem ficar abaixo do que o app
-- soma ao vivo. Ano anterior, acumulado e 12 meses da matriz são do grupo
-- INTEIRO no ERP (inclusive filiais de outros representantes, que não estão
-- no app); só fat_12m_cliente é do próprio cliente. `diferenca` = coluna
-- "Diferenca" (quanto falta pra manter a faixa atual ou subir pra próxima).
CREATE TABLE IF NOT EXISTS cliente_classificatorio_erp (
  cliente_id INTEGER PRIMARY KEY REFERENCES clientes(id) ON DELETE CASCADE,
  data_relatorio DATE NOT NULL,
  apurado_ate DATE,
  fat_ano_anterior NUMERIC,
  fat_acumulado NUMERIC,
  fat_12m_cliente NUMERIC,
  fat_12m_matriz NUMERIC,
  diferenca NUMERIC,
  gestor TEXT,
  situacao TEXT,
  cidade TEXT,
  uf TEXT,
  cliente_desde DATE,
  ultima_compra DATE,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

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
-- usuarios vem antes da primeira referência a ela (o ALTER TABLE pedidos logo
-- abaixo): num banco novo, criar depois fazia a 1ª execução do schema falhar.
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
-- Quem gravou o pedido - usado pra só deixar o autor (ou um admin) sobrescrever
-- uma cotação já existente reenviando o mesmo numero_cotacao. NULL em pedidos
-- antigos e nos importados do relatório oficial (não têm um usuário "dono").
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS usuario_id INTEGER REFERENCES usuarios(id);
-- Pedido do app reaberto pra editar (cliente pediu pra mudar quantidade ou
-- incluir produto): atualizado_em marca a última edição (data_pedido continua
-- a do fechamento) e contexto guarda como o orçamento estava montado (estado,
-- canal, classificatório, prazo, descontos e preços editados por item) pra
-- reabrir com os mesmos preços. NULL nos pedidos gravados antes disso.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS atualizado_em TIMESTAMPTZ;
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS contexto JSONB;
-- Identificador que o app gera no toque em "Finalizar pedido": com sinal
-- fraco o servidor gravava, a resposta se perdia, o pedido ia pra fila offline
-- e o reenvio criava um segundo pedido. O reenvio com o mesmo id_envio devolve
-- o pedido já gravado. NULL nos pedidos antigos e nos de PDF.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS id_envio TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_pedidos_id_envio ON pedidos(id_envio) WHERE id_envio IS NOT NULL;
-- Hora (relógio do aparelho) em que o vendedor tocou em Finalizar/Atualizar na
-- versão gravada. Uma versão mais velha que chegue depois (fila offline atrasada,
-- reenvio de outro aparelho) não apaga a mais nova. NULL nos pedidos antigos.
ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS versao_app TIMESTAMPTZ;

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
-- Vendedor que saiu é DESATIVADO, não excluído: pedidos e importações dele
-- (pedidos.usuario_id, import_log.usuario_id) continuam com o nome no histórico.
-- Inativo não entra (login Google recusa) e a sessão que ele tinha deixa de valer
-- (middleware/auth.js); ao desativar, as sessões e os avisos no celular dele são apagados.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ativo BOOLEAN NOT NULL DEFAULT true;

-- Registro de quem fez cada importação em massa (catálogo, produtos, clientes,
-- previsão de estoque, pedidos oficiais) - essas rotas continuam liberadas pra
-- qualquer usuário logado (não só admin), mas toda importação fica registrada
-- aqui pra dar pra rastrear quem mandou o quê depois.
CREATE TABLE IF NOT EXISTS import_log (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER REFERENCES usuarios(id),
  rota TEXT NOT NULL,
  itens_processados INTEGER NOT NULL DEFAULT 0,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_import_log_usuario ON import_log(usuario_id);
CREATE INDEX IF NOT EXISTS idx_import_log_criado ON import_log(criado_em);

-- "token" guarda sha256(token) (ver hashToken em auth-utils.js), não o token
-- em texto puro - quem vazar o banco não consegue reusar direto uma sessão
-- ativa. Essa mudança invalida sessões já gravadas com o token cru (o hash
-- delas não bate com nada) - efeito colateral aceito: todo mundo precisa
-- fazer login de novo uma vez, o resto do sistema não é afetado.
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

-- Localização da loja, gravada pelo GPS do celular no momento em que o
-- vendedor SALVA um levantamento (é quando há certeza de que ele está dentro
-- da loja - ver routes/levantamentos.js). Em levantamentos fica a leitura
-- crua de cada visita; em clientes, a posição "oficial" da loja, só
-- substituída por leitura igual ou mais precisa (ou se a atual for velha).
ALTER TABLE levantamentos ADD COLUMN IF NOT EXISTS latitude NUMERIC;
ALTER TABLE levantamentos ADD COLUMN IF NOT EXISTS longitude NUMERIC;
ALTER TABLE levantamentos ADD COLUMN IF NOT EXISTS localizacao_precisao_m NUMERIC;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS latitude NUMERIC;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS longitude NUMERIC;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS localizacao_precisao_m NUMERIC;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS localizacao_atualizada_em TIMESTAMPTZ;
-- Identificador que o app gera no toque em salvar o levantamento (mesmo padrão
-- de pedidos.id_envio): com sinal fraco o servidor gravava, a resposta se
-- perdia, o levantamento ia pra fila offline e o reenvio gravava outro. O
-- reenvio com o mesmo id_envio devolve o já gravado. NULL nos antigos.
ALTER TABLE levantamentos ADD COLUMN IF NOT EXISTS id_envio TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_levantamentos_id_envio ON levantamentos(id_envio) WHERE id_envio IS NOT NULL;

-- Nome que o vendedor escolheu pro arquivo CSV do cliente (orçamento e cópia
-- do pedido no Drive) - "DEPOSITO", "COMERCIAL"... são comuns no ramo e a 1ª
-- palavra do nome não diferenciava. Só letras e números (ex: DepositoSaoJose);
-- NULL = 1ª palavra do nome. nome_arquivo_em decide, no aparelho, entre o
-- valor do servidor e uma troca feita offline ainda na fila (o mais novo vale).
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS nome_arquivo TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS nome_arquivo_em TIMESTAMPTZ;

-- WhatsApp do comprador da loja (quem recebe o orçamento), escolhido pelo
-- vendedor no card do cliente: com ele o texto do orçamento abre direto na
-- conversa (wa.me). Só dígitos com o 55 na frente (ex: 5543999998888); NULL =
-- sem número (compartilhar normal). whatsapp_comprador_em decide, no aparelho,
-- entre o valor do servidor e uma troca feita offline ainda na fila.
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS whatsapp_comprador TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS whatsapp_comprador_nome TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS whatsapp_comprador_em TIMESTAMPTZ;

-- Situação de pedidos no sistema OFICIAL da empresa (relatório de Carteira +
-- Faturamento), guardada separada da tabela "pedidos" (que é só o que o
-- vendedor bate no próprio app). As duas fontes não têm número em comum,
-- então em vez de tentar mesclar (arriscado), mostramos as duas lado a lado
-- no histórico do cliente. "Nr.Pedido" + "codigo_sku" + nota fiscal é a chave
-- (ver `nota_chave` abaixo) - o mesmo item aparece na Carteira (ainda não
-- faturado) e depois no Faturamento (já faturado); reimportar não duplica.
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
-- Descrição do item como vem no relatório ("Descrição") - dá nome aos
-- produtos que saíram da tabela de preços (não estão em `produtos`), que
-- antes apareciam só com o código nas telas (94 códigos em 09/2026).
ALTER TABLE pedidos_oficiais_itens ADD COLUMN IF NOT EXISTS descricao TEXT;
-- Produto faturado só em parte: o saldo continua na aba Carteira e cada nota
-- fiscal do mesmo produto vem numa linha do Faturamento. Com a chave antiga
-- (nr_pedido + codigo_sku) essas linhas se sobrescreviam - sumia o saldo, e
-- do produto entregue em duas notas ficava só a última. `nota_chave` é a nota
-- fiscal na linha faturada e '' na linha de carteira (o saldo); a chave passa
-- a ser nr_pedido + codigo_sku + nota_chave. O bloco roda uma vez só (confere
-- se a chave primária já tem a coluna).
ALTER TABLE pedidos_oficiais_itens ADD COLUMN IF NOT EXISTS nota_chave TEXT NOT NULL DEFAULT '';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'pedidos_oficiais_itens'::regclass AND c.contype = 'p' AND a.attname = 'nota_chave'
  ) THEN
    UPDATE pedidos_oficiais_itens SET nota_chave = COALESCE(nota_fiscal, '') WHERE status = 'faturado';
    ALTER TABLE pedidos_oficiais_itens DROP CONSTRAINT IF EXISTS pedidos_oficiais_itens_pkey;
    ALTER TABLE pedidos_oficiais_itens ADD PRIMARY KEY (nr_pedido, codigo_sku, nota_chave);
  END IF;
END $$;
-- Apoia as agregações por mês/semana/trimestre do Dashboard principal
-- (ver routes/relatorios.js, GET /dashboard/resumo) - antes só havia
-- índice por cliente_codigo_oficial.
CREATE INDEX IF NOT EXISTS idx_pedidos_oficiais_status_data ON pedidos_oficiais_itens (status, data_faturamento);
-- Entrada de pedidos mensal do Dashboard (agrupa por data de implantação,
-- carteira + faturado - ver SQL_ENTRADA_PEDIDOS_MENSAL em routes/relatorios.js).
CREATE INDEX IF NOT EXISTS idx_pedidos_oficiais_implantacao ON pedidos_oficiais_itens (data_implantacao);

-- Pedidos à vista aguardando pagamento: aba "Aguardando Pagamento" do
-- relatório oficial (mesmo layout da Carteira, pedido ainda não liberado -
-- não aparece na aba Carteira). Uma linha por pedido. É a foto do último
-- relatório que trouxe a aba: cada importação com ela troca a lista inteira,
-- e o pedido que sumiu da aba foi pago. Relatório sem a aba não mexe.
CREATE TABLE IF NOT EXISTS pedidos_pendentes_pagamento (
  nr_pedido TEXT PRIMARY KEY,
  cliente_codigo_oficial TEXT,
  cliente_nome TEXT,
  valor NUMERIC,
  data_implantacao DATE,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pendentes_pagamento_cliente ON pedidos_pendentes_pagamento (cliente_codigo_oficial);
-- Títulos à vista em aberto: aba "Pendentes à Vista" do relatório oficial -
-- pedido já faturado cujo boleto à vista não foi pago. Não tem Nr.Pedido: o
-- "Título" é o número da nota fiscal (liga em pedidos_oficiais_itens.nota_fiscal).
-- Mesma regra de foto da tabela acima (sumiu da aba = pago).
CREATE TABLE IF NOT EXISTS titulos_avista_pendentes (
  titulo TEXT NOT NULL,
  parcela TEXT NOT NULL DEFAULT '',
  cliente_codigo_oficial TEXT,
  cliente_nome TEXT,
  vencimento DATE,
  valor NUMERIC,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (titulo, parcela)
);
CREATE INDEX IF NOT EXISTS idx_titulos_avista_cliente ON titulos_avista_pendentes (cliente_codigo_oficial);

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
-- Preço líquido por produto x canal x estado, sem IPI nem ICMS-ST embutido
-- (mesma forma de "precos", só que antes dos impostos) - usado só pro
-- orçamento mostrar o "Total S/ Impostos" pequeno acima do Total normal.
ALTER TABLE catalogo_precos ADD COLUMN IF NOT EXISTS precos_sem_imposto JSONB;

-- Rascunho de levantamento em andamento (ainda não salvo de verdade), um por
-- usuário - reforço do que já fica no localStorage do aparelho: sobrevive a
-- trocar de aparelho, reinstalar o app ou limpar dados do navegador. Sempre
-- sobrescrito por completo (upsert), nunca um histórico - é só "o que estava
-- em andamento agora", apagado assim que o levantamento é salvo de verdade.
CREATE TABLE IF NOT EXISTS levantamento_rascunhos (
  usuario_id INTEGER PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  rascunho JSONB NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- RLS ligado pra fechar o acesso público via PostgREST/API REST do Supabase
-- (o app não usa isso, conecta direto via DATABASE_URL como dono da tabela,
-- então continua acessando normalmente - RLS só bloqueia roles sem bypass,
-- tipo anon/authenticated). Sem política = nega tudo pra quem não é dono.
ALTER TABLE levantamento_rascunhos ENABLE ROW LEVEL SECURITY;

-- Cache da ficha cadastral de CNPJ (Receita Federal, via radar-cnpj.com) de
-- cada cliente. Construído aos poucos, sob demanda - só ganha uma linha
-- quando alguém abre a ficha desse cliente pela primeira vez, nunca em lote.
-- `dados_brutos` guarda a resposta inteira da origem, pra não perder nada
-- que ainda não tenha coluna própria.
CREATE TABLE IF NOT EXISTS cliente_cnpj_ficha (
  cliente_id INTEGER PRIMARY KEY REFERENCES clientes(id) ON DELETE CASCADE,
  razao_social TEXT,
  nome_fantasia TEXT,
  situacao_cadastral TEXT,
  data_situacao_cadastral TEXT,
  motivo_situacao TEXT,
  cnae_principal_codigo TEXT,
  cnae_principal_descricao TEXT,
  natureza_juridica TEXT,
  porte TEXT,
  data_abertura TEXT,
  capital_social NUMERIC,
  logradouro TEXT,
  numero TEXT,
  complemento TEXT,
  bairro TEXT,
  municipio TEXT,
  uf TEXT,
  cep TEXT,
  telefone TEXT,
  email TEXT,
  matriz_filial TEXT,
  cnae_secundario TEXT,
  socios JSONB,
  dados_brutos JSONB,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE cliente_cnpj_ficha ADD COLUMN IF NOT EXISTS socios JSONB;
ALTER TABLE cliente_cnpj_ficha ADD COLUMN IF NOT EXISTS complemento TEXT;
ALTER TABLE cliente_cnpj_ficha ADD COLUMN IF NOT EXISTS matriz_filial TEXT;
ALTER TABLE cliente_cnpj_ficha ADD COLUMN IF NOT EXISTS cnae_secundario TEXT;
-- RLS ligado (mesmo motivo de levantamento_rascunhos acima) - guarda dados
-- de CNPJ/sócios que não podem ficar públicos via PostgREST.
ALTER TABLE cliente_cnpj_ficha ENABLE ROW LEVEL SECURITY;

-- Preenchimento automático das fichas que faltam (routes/lib/preenchimentoCnpj.js):
-- guarda os clientes cujo CNPJ a Receita não achou, pra tentar no máximo 3
-- vezes (uma por noite) e depois desistir, em vez de gastar consulta toda noite.
CREATE TABLE IF NOT EXISTS cnpj_preenchimento_falhas (
  cliente_id INTEGER PRIMARY KEY REFERENCES clientes(id) ON DELETE CASCADE,
  tentativas INTEGER NOT NULL DEFAULT 1,
  ultima_tentativa TIMESTAMPTZ NOT NULL DEFAULT now(),
  erro TEXT
);
ALTER TABLE cnpj_preenchimento_falhas ENABLE ROW LEVEL SECURITY;

-- Posição APROXIMADA da loja tirada do endereço da ficha de CNPJ
-- (routes/lib/geocodificacao.js, de madrugada, pelo Nominatim/OpenStreetMap) -
-- pra "Clientes perto de mim" funcionar com quem nunca teve levantamento com
-- GPS. A posição do GPS (clientes.latitude/longitude) sempre vale mais.
-- endereco = o endereço consultado (mesma chave de SQL_CHAVE_ENDERECO): ficha
-- com endereço diferente = consulta de novo. latitude NULL = não achou
-- (tentativas conta, desiste em 3). nivel: 'numero' (achou o prédio) ou
-- 'rua' (ponto da rua - em avenida longa pode ficar a quilômetros da loja).
CREATE TABLE IF NOT EXISTS cliente_geocodificacao (
  cliente_id INTEGER PRIMARY KEY REFERENCES clientes(id) ON DELETE CASCADE,
  endereco TEXT NOT NULL,
  latitude NUMERIC,
  longitude NUMERIC,
  nivel TEXT,
  tentativas INTEGER NOT NULL DEFAULT 0,
  consultado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  erro TEXT
);
ALTER TABLE cliente_geocodificacao ENABLE ROW LEVEL SECURITY;

-- "Já falei" da Recompra da semana (routes/recompra.js): o vendedor já
-- contatou o cliente atrasado/com compra prevista e ele some da lista até
-- `ate` (7 dias). Um por cliente; vale em todos os aparelhos.
CREATE TABLE IF NOT EXISTS recompra_adiamentos (
  cliente_id INTEGER PRIMARY KEY REFERENCES clientes(id) ON DELETE CASCADE,
  ate DATE NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE recompra_adiamentos ENABLE ROW LEVEL SECURITY;

-- Avisos de importação (routes/lib/novidades.js): cada importação de relatório
-- oficial, catálogo de preços, previsão de estoque, Classificatório ou objetivos
-- trimestrais vira uma novidade - faixa "🔔 N novidades" no app e push no
-- celular. O mesmo tipo importado de novo em até 30 min atualiza a mesma linha
-- (atualizado_em) em vez de criar outra. Push só sai em dia útil, 7h-20h de
-- Brasília: push_enviar_em guarda quando; push_pendente = ainda falta enviar.
CREATE TABLE IF NOT EXISTS novidades (
  id SERIAL PRIMARY KEY,
  tipo TEXT NOT NULL,
  titulo TEXT NOT NULL,
  texto TEXT,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  push_enviar_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  push_pendente BOOLEAN NOT NULL DEFAULT true,
  push_enviado_em TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_novidades_atualizado ON novidades (atualizado_em DESC);
CREATE INDEX IF NOT EXISTS idx_novidades_push_pendente ON novidades (push_enviar_em) WHERE push_pendente;
ALTER TABLE novidades ENABLE ROW LEVEL SECURITY;
-- Até quando o usuário já viu as novidades (abriu a lista) - vale em todos os
-- aparelhos dele.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS novidades_vistas_ate TIMESTAMPTZ;

-- Aparelhos que ativaram "Avisos no celular" (Web Push). endpoint é único por
-- navegador/aparelho; o push service devolve 404/410 quando a inscrição morre
-- e aí a linha é apagada.
CREATE TABLE IF NOT EXISTS push_inscricoes (
  id SERIAL PRIMARY KEY,
  usuario_id INTEGER REFERENCES usuarios(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  ultimo_envio_em TIMESTAMPTZ
);
ALTER TABLE push_inscricoes ENABLE ROW LEVEL SECURITY;

-- Importação automática por e-mail (routes/importacaoEmail.js): um registro
-- por arquivo recebido (hash SHA-256 do conteúdo) - o mesmo arquivo nunca é
-- importado duas vezes - com o resultado ('ok'/'falhou') pro Painel.
CREATE TABLE IF NOT EXISTS importacoes_email (
  id SERIAL PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  nome_arquivo TEXT,
  tipo TEXT,
  remetente TEXT,
  assunto TEXT,
  mensagem_id TEXT,
  recebido_em TIMESTAMPTZ,
  status TEXT NOT NULL,
  erro TEXT,
  resultado JSONB,
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_importacoes_email_tipo ON importacoes_email (tipo, atualizado_em DESC);
ALTER TABLE importacoes_email ENABLE ROW LEVEL SECURITY;

-- Pedidos bloqueados pela Cortag (e-mail "Pedido Bloqueado NNNNNN" da
-- noreply@cortag.com.br, lido pela importação por e-mail). O selo "⛔
-- Bloqueado" vale enquanto o pedido não aparece faturado no relatório oficial
-- e por no máximo 30 dias (pedido que nunca fatura = cancelado) - regra em
-- routes/lib/pedidosBloqueados.js.
CREATE TABLE IF NOT EXISTS pedidos_bloqueados (
  nr_pedido TEXT PRIMARY KEY,
  cliente_codigo_oficial TEXT,
  cliente_nome TEXT,
  motivo TEXT,
  recebido_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pedidos_bloqueados_cliente ON pedidos_bloqueados (cliente_codigo_oficial);
ALTER TABLE pedidos_bloqueados ENABLE ROW LEVEL SECURITY;

-- RLS em TODAS as tabelas do schema (verificador do Supabase: rls_disabled_in_public).
-- Mesmo motivo do bloco de levantamento_rascunhos acima: fecha o acesso pela API
-- REST pública do Supabase (PostgREST, roles anon/authenticated); sem política =
-- nega tudo pra quem não é dono. O app conecta como DONO das tabelas e não é
-- afetado - por isso nunca usar FORCE ROW LEVEL SECURITY aqui (aí o dono também
-- passaria a ser barrado). Idempotente: ligar de novo não muda nada. Tabela nova
-- neste arquivo entra nesta lista (o test/run_tests.js confere).
ALTER TABLE clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE cliente_classificatorio_erp ENABLE ROW LEVEL SECURITY;
ALTER TABLE produtos ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendedores ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedido_itens ENABLE ROW LEVEL SECURITY;
ALTER TABLE levantamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE levantamento_itens ENABLE ROW LEVEL SECURITY;
ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE previsao_estoque ENABLE ROW LEVEL SECURITY;
ALTER TABLE configuracoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE fichas_tecnicas ENABLE ROW LEVEL SECURITY;
ALTER TABLE codigos_produto ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos_oficiais_itens ENABLE ROW LEVEL SECURITY;
ALTER TABLE pedidos_pendentes_pagamento ENABLE ROW LEVEL SECURITY;
ALTER TABLE titulos_avista_pendentes ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalogo_precos ENABLE ROW LEVEL SECURITY;
