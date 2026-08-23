# Cortag Backend — histórico de clientes, pedidos e levantamentos

API que guarda o que antes só existia no celular de cada vendedor: cliente,
pedidos feitos, levantamentos de estoque, login de usuário, e os relatórios
de histórico, rotatividade e "quem tem esse produto". Roda em cima de um
banco Postgres (hoje hospedado no **Supabase**; o serviço da API em si roda
no **Render**).

## O que tem aqui
- `schema.sql` — todas as tabelas (roda sozinho ao iniciar o servidor, não precisa rodar na mão)
- `server.js` — ponto de entrada, monta todas as rotas
- `db.js` — conexão com o Postgres + migração automática do esquema
- `auth-utils.js` — hash de senha e geração de token, só com o módulo `crypto` nativo do Node (sem depender de pacotes externos tipo bcrypt)
- `middleware/auth.js` — confere se o token da sessão (`Authorization: Bearer <token>`) é válido
- `routes/` — auth (login), clientes, produtos, pedidos, levantamentos, relatórios
- `test/` — testes automatizados simulando o banco (não precisa de Postgres pra rodar)

## Login e sessões

Não existe mais uma chave de API fixa — cada vendedor tem seu próprio usuário
e senha. Por baixo dos panos:

1. **Primeiro acesso**: `POST /api/auth/setup` cria o primeiro usuário do
   sistema — só funciona se a tabela `usuarios` estiver vazia (depois disso,
   fica bloqueado; novos usuários passam a exigir login).
2. **Login**: `POST /api/auth/login` com `{usuario, senha, lembrar}` devolve
   um token. A sessão dura **90 dias** se `lembrar` for `true`, ou **1 dia**
   se for `false`.
3. Toda rota de dados (`/api/clientes`, `/api/pedidos`, etc.) exige o
   cabeçalho `Authorization: Bearer <token>`. Sem isso, ou com token
   expirado, devolve `401`.
4. **Cadastrar mais gente**: `POST /api/auth/usuarios` — exige já estar
   logado (é assim que se evita deixar a porta aberta pra qualquer um se
   auto-cadastrar).

Senha é guardada com hash `scrypt` (nativo do Node, com salt aleatório por
usuário) — nunca em texto puro.

## Rotas principais

| Rota | O que faz |
|---|---|
| `POST /api/auth/setup` | Cria o primeiro usuário (só funciona uma vez) |
| `POST /api/auth/login` | Login — devolve token |
| `GET /api/auth/me` | Confere se o token guardado no aparelho ainda vale |
| `POST /api/auth/logout` | Invalida o token atual |
| `POST /api/auth/usuarios` | Cadastra mais um usuário (exige estar logado) |
| `GET /api/clientes?busca=` | Busca cliente por nome/documento |
| `POST /api/clientes` | Cria cliente (não duplica se o documento já existir) |
| `POST /api/clientes/import` | Importa clientes em lote (planilha de nome+CNPJ) |
| `DELETE /api/clientes/:id` | Exclui cliente (recusa se ele já tiver pedido/levantamento registrado) |
| `POST /api/produtos/sync` | Sincroniza o catálogo (rodar sempre que o `precos.json` mudar) |
| `POST /api/pedidos` | Grava um pedido fechado, com itens |
| `POST /api/levantamentos` | Grava um levantamento de estoque, com itens |
| `GET /api/clientes/:id/historico` | Tudo que o cliente já comprou, com 1ª/última compra e total |
| `GET /api/clientes/:id/rotatividade` | Igual acima + intervalo médio entre pedidos |
| `GET /api/clientes/:id/levantamentos` | Histórico de visitas/levantamentos do cliente |
| `GET /api/clientes/:id/consumo-estimado/:produtoId` | Consumo real estimado comparando estoque contado entre visitas |
| `GET /api/produtos/:codigo/clientes` | Busca reversa: quem já comprou ou tem esse produto no levantamento mais recente |

Todas as rotas acima (menos as de `/api/auth`, que cuidam disso sozinhas)
exigem o cabeçalho `Authorization: Bearer <token>`.

## Como colocar no ar

1. **Suba esta pasta pra um repositório no GitHub** (substitua todo o
   conteúdo do repositório já existente pelos arquivos desta pasta).
2. **Banco de dados**: crie um projeto grátis em [database.new](https://database.new)
   (Supabase). Em "Connect", copie a connection string do **Session pooler**
   (não a "Transaction pooler" nem "Direct connection" — o serviço fica
   sempre ligado, então precisa da que é feita pra isso).
3. No [dashboard do Render](https://dashboard.render.com): **New → Web Service**,
   conecte o repositório.
   - **Build command**: `npm install`
   - **Start command**: `npm start`
4. Nas variáveis de ambiente do serviço (aba **Environment**):
   - `DATABASE_URL` → a connection string do Supabase (Session pooler)
5. Deploy. Na primeira subida, o servidor cria as tabelas sozinho.
6. Acesse a URL que o Render deu + `/health` — deve responder `{"status":"ok"}`.
7. Abra o app, vá na tela de login, toque em "Primeiro acesso" e crie seu usuário.
8. No Painel Administrativo do app, sincronize o catálogo de produtos antes
   de tentar gravar qualquer pedido ou levantamento (senão dá erro de
   "produto não encontrado", já que o banco começa vazio).

## Testando localmente sem Postgres

```
npm install
node test/run_tests.js
```

Isso sobe o servidor de verdade com um banco simulado em memória e testa as
rotas via HTTP real — não grava nada de verdade, só confere se a lógica está
certa antes de mexer no banco real.

## Histórico de mudanças relevantes

- **Migrado de Render Postgres pra Supabase** — o Render Postgres grátis
  expira em 30 dias; o Supabase não tem esse limite fixo.
- **Login por usuário substituiu a chave de API fixa** — cada vendedor tem
  seu próprio usuário/senha agora, em vez de uma chave compartilhada.
- **Sincronização de produtos e importação de clientes viraram operações em
  lote** (uma única consulta com `UNNEST`, não mais um laço item a item) —
  a versão em laço estourava o tempo limite de execução do Supabase com
  catálogos grandes (~1.700 produtos).
