# Cortag Backend

API backend em Node.js/Express + PostgreSQL para o app Cortag: consulta de preços, levantamento de estoque, produtos, clientes, pedidos e relatórios para vendedores. O frontend (PWA) é hospedado separadamente (GitHub Pages) e consome esta API via CORS liberado.

## Stack

- Node.js (>=18) + Express
- PostgreSQL (via `pg`), com SSL exigido quando `DATABASE_URL` é definido
- Autenticação por sessão em tabela própria (token opaco), sem JWT/OAuth externos
- Migração de schema automática na subida do servidor (`schema.sql`, todo `IF NOT EXISTS`)

## Estrutura do projeto

```
server.js          # bootstrap do Express, CORS, montagem das rotas, roda migrações e sobe o servidor
db.js               # pool de conexão pg + runMigrations() (executa schema.sql)
schema.sql           # schema completo do banco (idempotente)
auth-utils.js         # hash/verificação de senha (scrypt) e geração de token
middleware/auth.js     # requireAuth: valida "Authorization: Bearer <token>" contra a tabela sessoes
routes/
  auth.js             # setup, login, logout, /me, gestão de usuários
  clientes.js          # CRUD de clientes, import, merge
  produtos.js           # produtos e sincronização
  pedidos.js             # pedidos manuais/do app (finalizar pedido, PDF) e export por período
  levantamentos.js        # levantamentos de estoque em campo
  relatorios.js            # histórico, rotatividade, consumo estimado, curva ABC etc.
  previsaoEstoque.js        # previsão de estoque
  configuracoes.js           # configurações chave/valor
  fichasTecnicas.js            # fichas técnicas de produtos
  codigosProduto.js              # códigos alternativos de produto
  pedidosOficiais.js               # ÚNICA importação de pedidos oficiais (planilha .xlsx Carteira/Faturamento) e consulta por cliente
  assistente.js                     # assistente com IA (Gemini)
index.html, manifest.json, icon-*.png  # PWA estático servido pelo frontend
```

## Configuração

Variáveis de ambiente:

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | Sim (produção) | String de conexão do PostgreSQL. Sem ela, a conexão roda sem SSL (uso local). |
| `DB_SSL_INSECURE` | Não | `true` desativa a validação do certificado SSL do banco (`rejectUnauthorized: false`). Use só como contorno temporário. |
| `PORT` | Não | Porta HTTP do servidor. Padrão `10000`. |
| `GEMINI_API_KEY` | Sim (para `/api/assistente`) | Chave da API Gemini usada pelo assistente com IA. |
| `GEMINI_MODEL` | Não | Modelo Gemini usado. Padrão `gemini-2.0-flash`. |

## Rodando localmente

```bash
npm install
export DATABASE_URL=postgres://usuario:senha@localhost:5432/cortag
npm start
```

O schema é aplicado automaticamente na subida (`runMigrations`), incluindo limpeza de sessões expiradas.

## Autenticação

- `POST /api/auth/setup` cria o primeiro usuário (admin), só funciona se ainda não existir nenhum usuário.
- `POST /api/auth/login` retorna um token de sessão (`Authorization: Bearer <token>`), com duração de 1 dia ou 90 dias (`lembrar`).
- Todas as rotas em `/api/*` (exceto `/api/auth/*` de login/setup/logout) exigem esse token via middleware `requireAuth`.
- Criação de novos usuários (`POST /api/auth/usuarios`) exige estar autenticado; promover a admin exige que quem cria já seja admin.

## Principais rotas da API

- `/api/auth` — login, logout, sessão atual, gestão de usuários
- `/api/clientes` — cadastro, importação e mesclagem de clientes
- `/api/produtos` — catálogo de produtos e sincronização
- `/api/pedidos` — pedidos manuais/do app (POST `/`) e export por período (GET `/exportar`)
- `/api/levantamentos` — levantamentos de estoque
- `/api/previsao-estoque` — previsão de estoque
- `/api/configuracoes` — configurações chave/valor
- `/api/fichas-tecnicas` — fichas técnicas de produtos
- `/api/codigos-produto` — códigos alternativos de produto
- `/api/pedidos-oficiais` — pedidos oficiais por cliente e importação da planilha oficial
- `/api/assistente` — assistente com IA (Gemini)
- `/api/clientes/:id/historico`, `/rotatividade`, `/levantamentos`, `/consumo-estimado/:produtoId`, `/api/produtos/:codigo/clientes`, `/api/pedidos/exportar`, `/api/produtos-abc-geral` — relatórios

`GET /health` retorna `{ status: 'ok' }` para checagem de disponibilidade.

## Importação de pedidos oficiais (Carteira / Faturamento)

Única porta de entrada de dados de pedidos oficiais desde a unificação (a
importação por JSON preparado à mão, e a planilha .xlsx separada e
incompleta que só cobria a aba Faturamento, foram retiradas):

- `POST /api/pedidos-oficiais/importar` — recebe `{ itens: [...], classificacoes: [...] }`.
  O frontend (`index.html`, `parseRelatorioOficialXlsx`) lê as abas "Carteira"
  e "Faturamento" da planilha .xlsx oficial direto no navegador e monta esse
  payload - não existe mais preparo manual de arquivo. Grava em
  `pedidos_oficiais_itens` (chave `nr_pedido` + `codigo_sku`, nunca duplica,
  nunca "recua" de faturado pra carteira) e atualiza o classificatório do
  cliente (`clientes.classificatorio_tipo/desconto`), respeitando qual
  relatório é mais recente.
  - Qualquer usuário autenticado pode importar (decisão explícita, não só admin).
  - Os nomes de coluna esperados na planilha (`Cliente`, `Cod.Cliente`,
    `Nr.Pedido`, `Item`, `Nota Fiscal`, `Transportadora`, `Situação`,
    `Classificatório` etc., com variações aceitas) estão centralizados em
    `COLUNAS_RELATORIO_OFICIAL` no `index.html` — se o relatório real usar
    nomes diferentes, o import falha com um erro dizendo qual coluna faltou
    e quais existem no arquivo (em vez de gravar dado errado). Ajuste a lista
    de apelidos ali se necessário.
- `GET /api/pedidos-oficiais/status` — última data de atualização e totais
  (carteira/faturado), usado pelo painel admin pra mostrar de cara se o
  relatório está desatualizado.
- `GET /api/pedidos-oficiais/:clienteId` e `/:clienteId/resumo` — consulta por cliente (inalteradas).
