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
  pedidos.js             # pedidos e importação de faturamento
  levantamentos.js        # levantamentos de estoque em campo
  relatorios.js            # histórico, rotatividade, consumo estimado, curva ABC etc.
  previsaoEstoque.js        # previsão de estoque
  configuracoes.js           # configurações chave/valor
  fichasTecnicas.js            # fichas técnicas de produtos
  codigosProduto.js              # códigos alternativos de produto
  pedidosOficiais.js               # pedidos oficiais por cliente
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
- `/api/pedidos` — pedidos e importação de faturamento
- `/api/levantamentos` — levantamentos de estoque
- `/api/previsao-estoque` — previsão de estoque
- `/api/configuracoes` — configurações chave/valor
- `/api/fichas-tecnicas` — fichas técnicas de produtos
- `/api/codigos-produto` — códigos alternativos de produto
- `/api/pedidos-oficiais` — pedidos oficiais por cliente
- `/api/assistente` — assistente com IA (Gemini)
- `/api/clientes/:id/historico`, `/rotatividade`, `/levantamentos`, `/consumo-estimado/:produtoId`, `/api/produtos/:codigo/clientes`, `/api/pedidos/exportar`, `/api/produtos-abc-geral` — relatórios

`GET /health` retorna `{ status: 'ok' }` para checagem de disponibilidade.
