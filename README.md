# Cortag Backend — histórico de clientes, pedidos e levantamentos

API que guarda o que hoje só existe no celular de cada vendedor: cliente,
pedidos feitos, levantamentos de estoque, e os relatórios de histórico e
rotatividade. Roda em cima de um banco Postgres.

## O que tem aqui
- `schema.sql` — as tabelas (roda sozinho ao iniciar o servidor)
- `server.js` — ponto de entrada
- `db.js` — conexão com o Postgres + migração automática
- `middleware/auth.js` — autenticação simples por chave (`X-API-Key`)
- `routes/` — clientes, produtos, pedidos, levantamentos, relatórios
- `test/` — testes automatizados simulando o banco (não precisa de Postgres pra rodar)

## Rotas principais
| Rota | O que faz |
|---|---|
| `GET /api/clientes?busca=` | Busca cliente por nome/documento |
| `POST /api/clientes` | Cria cliente (não duplica se o documento já existir) |
| `POST /api/produtos/sync` | Sincroniza o catálogo (rodar sempre que o `precos.json` mudar) |
| `POST /api/pedidos` | Grava um pedido fechado, com itens |
| `POST /api/levantamentos` | Grava um levantamento de estoque, com itens |
| `GET /api/clientes/:id/historico` | Tudo que o cliente já comprou, com 1ª/última compra e total |
| `GET /api/clientes/:id/rotatividade` | Igual acima + intervalo médio entre pedidos |
| `GET /api/clientes/:id/levantamentos` | Histórico de visitas/levantamentos do cliente |
| `GET /api/clientes/:id/consumo-estimado/:produtoId` | Consumo real estimado comparando estoque contado entre visitas |

Todas as rotas de dados exigem o cabeçalho `X-API-Key: <sua-chave>`.

## Como colocar no ar (Render)

1. **Suba esta pasta pra um repositório no GitHub** (novo repositório, ex: `cortag-backend`).
   - Se nunca fez isso: crie o repositório vazio em github.com/new, depois no
     GitHub mesmo use "Add file → Upload files" e arraste todos os arquivos
     desta pasta (menos `node_modules` e `test/`, que são só pra teste local).
2. No [dashboard do Render](https://dashboard.render.com): **New → Web Service**,
   conecte esse repositório.
3. Configuração do serviço:
   - **Build command**: `npm install`
   - **Start command**: `npm start`
4. Crie o banco: **New → PostgreSQL** (plano free serve pra começar).
5. No serviço web, aba **Environment**, adicione:
   - `DATABASE_URL` → cole a "Internal Connection String" do banco criado
   - `API_KEY` → invente uma senha longa qualquer (é o que o app vai mandar
     no cabeçalho pra poder gravar/ler dados)
6. Deploy. Na primeira subida, o servidor cria as tabelas sozinho (não precisa
   rodar `schema.sql` manualmente).
7. Teste: acesse a URL que o Render deu, em `/health` deve responder `{"status":"ok"}`.

## Testando localmente sem Postgres

```
npm install
node test/run_tests.js
```

Isso sobe o servidor de verdade com um banco simulado em memória e testa as
rotas via HTTP real — não grava nada de verdade, só confere se a lógica está
certa antes de mexer no banco real.
