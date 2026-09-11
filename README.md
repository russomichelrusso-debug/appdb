# Cortag Revolution Tools — App de Vendas

App de vendas em campo para representantes da Cortag (ferramentas de construção civil): consulta de preço por canal/estado, levantamento de estoque via scanner de código de barras, orçamento, histórico/pedidos oficiais por cliente e fichas técnicas/catálogo de produtos.

Este repositório contém **frontend (PWA) e backend (API) juntos**, publicados em dois lugares diferentes:

| Parte | Tecnologia | Hospedagem |
|---|---|---|
| Frontend (PWA) — `index.html`, `curva-abc.html`, `calculadora-materiais.html` etc. | HTML/CSS/JS estático | GitHub Pages (serve os arquivos direto da branch `main`) |
| Backend (API) — `server.js` e demais | Node.js (>=18) + Express | Render (free tier) |
| Banco de dados | PostgreSQL | Supabase (usar a connection string **Session pooler**, não a direta) |

O catálogo técnico ilustrado (fotos em alta resolução dos produtos) mora em outro repositório, `cortag-catalogo-tecnico`, publicado à parte no GitHub Pages.

## Stack

- Node.js (>=18) + Express
- PostgreSQL (via `pg`), com SSL exigido quando `DATABASE_URL` é definido
- Autenticação via **Google Sign-In** (Google Identity Services), sessão em tabela própria com token opaco — não é usuário/senha
- Migração de schema automática na subida do servidor (`schema.sql`, todo `IF NOT EXISTS`)

## Estrutura do projeto

```
server.js              # bootstrap do Express, CORS, montagem das rotas, roda migrações e sobe o servidor
db.js                   # pool de conexão pg + runMigrations() (executa schema.sql)
schema.sql               # schema completo do banco (idempotente)
auth-utils.js             # verificação de ID token do Google + geração de token de sessão opaco
clientMatcher.js           # casa nome de cliente da planilha oficial com cliente já cadastrado
middleware/auth.js          # requireAuth: valida "Authorization: Bearer <token>" contra a tabela sessoes
routes/
  auth.js                     # login via Google, /me, logout, CRUD de usuários
  clientes.js                  # CRUD de clientes, import, merge
  produtos.js                   # catálogo de referência (código+nome+categoria) e sincronização
  catalogoPrecos.js              # catálogo completo de preços por canal x estado (importação da planilha)
  pedidos.js                      # pedidos feitos pelo próprio app (finalizar pedido) e export por período
  pedidosOficiais.js               # importação e consulta da planilha oficial Carteira/Faturamento
  levantamentos.js                  # levantamentos de estoque em campo
  relatorios.js                      # histórico, rotatividade, consumo estimado, curva ABC geral
  previsaoEstoque.js                  # previsão de estoque (relatório ESCE007)
  configuracoes.js                     # configurações chave/valor (campanhas promocionais etc.)
  fichasTecnicas.js                     # balão de ficha técnica (specs resumidas)
  codigosProduto.js                      # EAN-13/DUN-14 por SKU (scanner de código de barras)
  assistente.js                           # assistente de IA (Gemini) — interpreta pergunta falada, nunca inventa dado
test/                    # suite de testes automatizados (Node) cobrindo login/token
index.html, curva-abc.html, calculadora-materiais.html, catalogo-embutido.js, manifest.json, icon-*.png  # PWA estático servido pelo GitHub Pages
.github/workflows/keep-alive.yml  # ping em /health a cada 10 min pra evitar o Render dormir (free tier)
```

## Configuração

Variáveis de ambiente:

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | Sim (produção) | String de conexão do PostgreSQL (Supabase, connection pooler). Sem ela, a conexão roda sem SSL (uso local). |
| `DB_SSL_INSECURE` | Não | `true` desativa a validação do certificado SSL do banco (`rejectUnauthorized: false`). Use só como contorno temporário. |
| `PORT` | Não | Porta HTTP do servidor. Padrão `10000`. |
| `GOOGLE_CLIENT_ID` | Não | Client ID do Google usado no login (há um valor fixo no código como padrão). |
| `GEMINI_API_KEY` | Sim (para `/api/assistente`) | Chave da API Gemini usada pelo assistente com IA. |
| `GEMINI_MODEL` | Não | Modelo Gemini usado. Padrão `gemini-2.0-flash`. |

## Rodando localmente

```bash
npm install
export DATABASE_URL=postgres://usuario:senha@localhost:5432/cortag
npm start
```

O schema é aplicado automaticamente na subida (`runMigrations`), incluindo limpeza de sessões expiradas.

## Autenticação — Google Sign-In

Não é usuário/senha. O fluxo:

- O botão "Entrar com Google" no frontend usa Google Identity Services (`google.accounts.id`) e devolve um **ID token**.
- O frontend manda esse ID token para `POST /api/auth/google`.
- O backend verifica o token com o Google:
  - Se é o **primeiro usuário** do sistema, vira admin automaticamente.
  - Caso contrário, só entra se o e-mail já foi cadastrado antes por um admin (`POST /api/auth/usuarios`, que pede só nome + e-mail).
- A sessão dura 90 dias, com token opaco guardado na tabela `sessoes`.
- Todas as rotas em `/api/*` (exceto login) exigem esse token via middleware `requireAuth`.
- Cada vendedor precisa estar na lista de "usuários de teste" do OAuth consent screen no Google Cloud Console (o app não passou por verificação pública do Google — uso interno).

**Só "Gerenciar usuários" e "Gerenciar clientes" (exclusão) ficam restritos a admin.** Todo o resto (importações, relatórios, catálogo) é liberado pra qualquer vendedor logado.

## Principais rotas da API

- `/api/auth` — login via Google, `/me`, logout, gestão de usuários
- `/api/clientes` — cadastro, importação e mesclagem de clientes
- `/api/produtos` — catálogo de referência de produtos e sincronização
- `/api/catalogo-precos` — catálogo completo de preços por canal x estado (fonte automática, alimentada pelo upload de planilha no Admin)
- `/api/pedidos` — pedidos manuais/do app (POST `/`) e export por período (GET `/exportar`)
- `/api/pedidos-oficiais` — pedidos oficiais por cliente e importação da planilha oficial Carteira/Faturamento
- `/api/levantamentos` — levantamentos de estoque em campo, incluindo rascunho automático (`POST`/`GET`/`DELETE /api/levantamentos/rascunho`, um por usuário) pra não perder levantamento não salvo em caso de queda de conexão ou fechamento acidental do app
- `/api/clientes/sync` — lista enxuta (`id`, `nome`, `documento`) de todos os clientes, usada pra manter uma cópia local no aparelho (`localStorage`) e o app continuar funcionando na aba de Levantamento mesmo se a busca de cliente no servidor falhar
- `/api/previsao-estoque` — previsão de estoque (relatório ESCE007)
- `/api/configuracoes` — configurações chave/valor
- `/api/fichas-tecnicas` — fichas técnicas de produtos
- `/api/codigos-produto` — EAN-13/DUN-14 por SKU (leitura livre, importar restrito a admin)
- `/api/assistente` — assistente de IA (Gemini)
- `/api/clientes/:id/historico`, `/rotatividade`, `/levantamentos`, `/consumo-estimado/:produtoId`, `/api/produtos/:codigo/clientes`, `/api/pedidos/exportar`, `/api/produtos-abc-geral` — relatórios

`GET /health` retorna `{ status: 'ok' }` para checagem de disponibilidade (usado pelo keep-alive).

## Motor de preço — canal × estado

Cada produto carrega preço por 6 canais (Varejo/Atacado/E-commerce/Moderno/Construtora/Institucional) x 27 estados, já com imposto calculado:

- **5 estados (MG, RJ, PR, SC, RS)**: cálculo fiscal exato (ICMS-ST específico do estado).
- **Outros 22 estados (inclusive SP)**: preço líquido + IPI, sem ICMS-ST adicional.
- Regra de "Preço Fixo" (sem desconto, só imposto) só vale para Varejo/Atacado/E-commerce.
- A conversão da planilha "LISTA PADRÃO" para o banco acontece no servidor (`routes/catalogoPrecos.js`, via lib `xlsx`), não no navegador.
- O orçamento mostra uma linha "Total S/ Impostos" acima do Total, calculada a partir do preço sem imposto de cada produto (`precos_sem_imposto`, calculado e armazenado já na importação da planilha).
- No Admin, "Produtos promocionais" fica aninhado dentro do card de "Campanhas promocionais" (a lista de produtos com desconto pertence a uma campanha).

## Frontend — carregamento do catálogo de preços

O catálogo de produtos não fica embutido no `index.html` (carregamento inicial mais leve). A função `loadActiveDB()` tenta, nessa ordem: override manual salvo no aparelho (`localStorage`) → `/api/catalogo-precos` no servidor → `precos.json` hospedado junto do app → `catalogo-embutido.js` (base offline, último recurso).

O carregamento de EAN/DUN-14 (`loadCodigosProduto()`) roda **depois** que o catálogo termina de carregar (encadeado via `.then()`), para o scanner de código de barras não ficar sem índice.

## Importação de pedidos oficiais (Carteira / Faturamento)

- `POST /api/pedidos-oficiais/importar` — recebe `{ itens: [...], classificacoes: [...] }`.
  O frontend (`index.html`, `parseRelatorioOficialXlsx`) lê as abas "Carteira" e "Faturamento" da planilha .xlsx oficial direto no navegador e monta esse payload — não existe preparo manual de arquivo. Grava em `pedidos_oficiais_itens` (chave `nr_pedido` + `codigo_sku`, nunca duplica, nunca "recua" de faturado pra carteira) e atualiza o classificatório do cliente (`clientes.classificatorio_tipo/desconto`), respeitando qual relatório é mais recente.
  - Qualquer usuário autenticado pode importar.
  - Os nomes de coluna esperados na planilha (`Cliente`, `Cod.Cliente`, `Nr.Pedido`, `Item`, `Nota Fiscal`, `Transportadora`, `Situação`, `Classificatório` etc., com variações aceitas) estão centralizados em `COLUNAS_RELATORIO_OFICIAL` no `index.html` — se uma coluna essencial não for encontrada, o import falha com erro explícito em vez de gravar dado errado.
- `GET /api/pedidos-oficiais/status` — última data de atualização e totais (carteira/faturado).
- `GET /api/pedidos-oficiais/:clienteId` e `/:clienteId/resumo` — consulta por cliente.

## Levantamento — cliente e rascunho não se perdem

- **Cliente local com sincronização em segundo plano**: além de buscar cliente no servidor, o app mantém uma cópia local (`localStorage`) de todos os clientes (`GET /api/clientes/sync`), sincronizada no boot com tentativas escalonadas (`0s, 4s, 8s, 15s`) pra já estar disponível o quanto antes. Se a busca no servidor falhar (rede instável, banco indisponível), o app tenta de novo automaticamente (retry) e só cai pra essa base local como último recurso, evitando a mensagem de "Não foi possível conectar ao servidor de histórico" travar a seleção de cliente.
- **Botão "Limpar" do cliente**: na aba Levantamento, ao lado do botão "Selecionar" (empilhados verticalmente — "Selecionar" em destaque acima, "Limpar" em cinza neutro abaixo, sem quebrar o nome do cliente), permite remover o cliente selecionado sem precisar escolher outro.
- **Rascunho de levantamento não salvo**: o levantamento em andamento (itens + cliente) é salvo automaticamente no aparelho e, com um debounce de ~2,5s, também no servidor (`levantamento_rascunhos`), pra sobreviver a fechamento acidental do app, falta de conexão ou troca de aparelho. Ao carregar, os itens do rascunho só são revalidados contra o catálogo depois que ele termina de carregar — evitando que o rascunho seja apagado por engano por uma corrida com o carregamento assíncrono do catálogo.

## Condição de Pagamento

O orçamento tem um campo de seleção de Condição de Pagamento (lista fixa de opções usadas pela Cortag). O valor escolhido aparece no PDF do orçamento, na imagem gerada e no texto de compartilhamento (WhatsApp etc.), e é limpo junto com o carrinho/sessão.

## Calculadora de Materiais (Espaçadores Niveladores)

Página própria (`calculadora-materiais.html`), separada do `index.html` pelo mesmo motivo da Curva ABC (uso esporádico, mantém o app principal leve). Calcula a quantidade recomendada de peças e de Espaçadores Niveladores a partir das medidas da peça e do ambiente, da junta desejada e da perda estimada — fórmula calibrada e validada contra a calculadora oficial da Cortag.

- Modelos disponíveis: **Standard**, **ECO** e **Slim** (as 3 linhas mais vendidas), cada um com seu próprio conjunto de juntas válidas.
- Botão "Limpar" reseta os campos de peça/ambiente e volta modelo/perda pro padrão.
- Botão "Adicionar ao orçamento" resolve o produto do catálogo certo pra cada modelo/junta (usando o tamanho de embalagem pra distinguir SKU vendável de caixa fechada, e o nome do produto pra diferenciar Standard das demais linhas) e faz o handoff pro carrinho do `index.html` via `localStorage` + redirecionamento (`index.html?importarCalculo=1`), sem precisar duplicar a lógica de carrinho na página separada.
- Acessível por um ícone (calculadora) no topo do app principal, ao lado do ícone da Curva ABC.

## Curva ABC

Página própria (`curva-abc.html`), separada do `index.html`: uso esporádico, peso de biblioteca de gráfico, e não depende de estado "ao vivo" (só lê histórico já fechado). Acessível a qualquer pessoa logada por um ícone no topo do app principal.

## Assistente de voz (Gemini)

Reconhecimento de voz do navegador → texto enviado pro backend → Gemini só classifica a intenção (preço/ficha técnica/cliente) e extrai o termo de busca, **nunca responde o dado em si** → o app busca o dado real no próprio catálogo/banco → resposta falada via síntese do navegador (grátis) ou, opcionalmente, voz nativa do Gemini.

## Infraestrutura / operação

- **Render free tier**: o serviço dorme após ~15 min sem uso. Mitigado por `.github/workflows/keep-alive.yml`, que faz ping em `/health` a cada 10 minutos.
- Ao mexer em configuração do Render, sempre confirmar que a URL do serviço bate com a que o frontend usa.
- **DATABASE_URL** deve sempre apontar para a connection string "Session pooler" do Supabase — a conexão direta causa timeout para a maioria dos estados.
- Rodar a suite de testes em `test/` antes de mudanças grandes no backend.
