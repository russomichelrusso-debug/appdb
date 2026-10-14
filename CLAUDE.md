# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é este app e por que ele existe

**Cortag Revolution Tools** é o app de vendas em campo dos representantes comerciais da Cortag
(fabricante de ferramentas para construção civil — acabamento, corte, nivelamento etc.).
O vendedor usa no celular, muitas vezes sem internet estável, dentro da loja do cliente ou no
depósito. A proposta central é substituir tabela de preço impressa + planilha + calculadora
separada por um único app que resolve, na mesma visita:

- **Consultar preço** de qualquer produto já calculado por canal de venda (Varejo/Atacado/
  E-commerce/Moderno/Construtora/Institucional) x estado, com imposto embutido.
- **Montar um orçamento** (carrinho) e gerar PDF/imagem/texto pra mandar no WhatsApp na hora.
- **Fazer levantamento de estoque** na loja do cliente escaneando código de barras, sem perder
  o levantamento em andamento se o app fechar ou a internet cair.
- **Ver histórico e classificatório do cliente** (o que ele já comprou, curva ABC, rotatividade,
  objetivo trimestral) pra saber o que oferecer, sem depender do time interno.
- **Calcular quantidade de Espaçadores Niveladores** (linha própria de produto) e já jogar isso
  pro orçamento.
- **Lembrar o que o cliente parou de comprar** (produtos sem compra há mais de 1 ano, variações
  agrupadas) — o item que acabou na prateleira não aparece no levantamento e sairia do radar.

Cada funcionalidade nova pensada pro app costuma vir de uma dor concreta do vendedor em campo
("hoje eu tenho que abrir Curva ABC, selecionar cliente, clicar em produtos... dava pra ser um
botão só?"), não de uma lista de features abstrata. Ao propor algo novo, vale manter esse critério:
resolve um passo a menos pra quem está na rua vendendo.

Ver `README.md` para a arquitetura técnica completa (stack, hospedagem, variáveis de ambiente,
rotas da API, motor de preço por canal x estado). Este arquivo não repete aquilo — foca no
histórico de decisões e no que ainda falta.

## Arquitetura, em uma frase

Frontend estático (PWA: `index.html` + páginas soltas `curva-abc.html`/`calculadora-materiais.html`/
`ficha-cnpj.html`/`tela-cliente.html`) no GitHub Pages, backend Node/Express (`server.js` + `routes/`) no Render,
Postgres no Supabase, autenticação só via Google Sign-In (sem usuário/senha). `curva-abc.html` e
`calculadora-materiais.html` são páginas separadas de propósito — usadas esporadicamente, não
valia deixar o `index.html` mais pesado por causa delas — e se comunicam com o app principal por
parâmetro de URL (`curva-abc.html?cliente=…`, `ficha-cnpj.html?cliente=…&nome=…&doc=…`) e/ou
`localStorage` compartilhado: `cortagAuthToken_v1` (sessão), `cortagCart_v1` (carrinho, lido pela
Curva ABC) e `cortagCalcHandoff_v1` (itens que a calculadora manda pro orçamento). Entre **dois aparelhos**
(tablet + celular, PR #245) a ponte é o servidor: salas em memória em `routes/segundaTela.js`, pareadas por QR.

## Comandos

```bash
npm install
export DATABASE_URL=postgres://usuario:senha@localhost:5432/cortag   # Supabase: usar o Session pooler
npm start                    # sobe o servidor (roda schema.sql automaticamente)
node test/run_tests.js       # suite de testes (mocka o banco em test/mock-db.js) — rodar antes de qualquer mudança em routes/
node scripts/app-local.js    # app inteiro em http://localhost:8080/__entrar, já logado, banco em memória (sem Postgres/Google)
```

`scripts/app-local.js` serve as páginas e a API no mesmo endereço (o CSP do `index.html` só deixa
chamar `'self'`/https) e semeia 3 clientes com faturamento pra ver card, classificatório e busca.
Consulta que o mock não conhece responde 500 — normal; se a tela testada depender dela, ensinar o
`test/mock-db.js`. O CI (`.github/workflows/testes.yml`) roda os testes e `checar-html.js` em todo
PR contra `main`.

Não há lint nem build configurados — as páginas `.html` (`index.html`, `curva-abc.html`,
`ficha-cnpj.html`, `calculadora-materiais.html`) não têm bundler; a checagem de sintaxe dos
blocos `<script>` inline (e do CRLF do `index.html`) é `node scripts/checar-html.js [arquivo]`.

Automação do Claude Code (`.claude/`):
- `settings.json` liga dois hooks: **SessionStart** (`hooks/session-start.sh`, só na nuvem, roda
  `npm install` e instala o **`playwright-cli`** — `@playwright/cli`, versão fixa no script — com a
  skill dele em `~/.claude/skills`, apontado pro Chromium de `/opt/pw-browsers` pelas variáveis
  `PLAYWRIGHT_MCP_*` que o hook grava no `CLAUDE_ENV_FILE`) e **PostToolUse** em Edit/Write (`hooks/pos-edicao.js`: `.html` →
  `checar-html.js`; `.js` → `node --check`; `routes/`, `server.js`, `importadores.js`,
  `schema.sql`, `test/`… → `node test/run_tests.js`). Falha volta como erro pro Claude corrigir.
- Subagente **`revisor-cortag`** (`agents/revisor-cortag.md`): revisa o diff contra as regras
  deste arquivo que já deram erro em produção (data sem hora, `sqlFaturadoDeFato`, compra em
  dobro, `.hidden` × display inline, CRLF, tabelas da política). Rodar antes de abrir PR que
  mexa em `routes/`, `schema.sql`, `importadores.js` ou nas `.html`; regra nova que entrar aqui
  em "Pegadinhas"/"Fontes de dados" vale a pena copiar pra lá.
- Plugin **agent-skills** (`addyosmani/agent-skills`, registrado em `settings.json` por
  `extraKnownMarketplaces` + `enabledPlugins`, instala sozinho em toda sessão do projeto): skills
  genéricas de engenharia (revisão, testes, segurança, desempenho web…), comandos `/spec`, `/plan`,
  `/build`, `/test`, `/review`, `/ship`, `/code-simplify`, `/constraints`, `/webperf` e agentes
  code-reviewer/security-auditor/test-engineer/web-performance-auditor. São regras gerais: o que
  está neste arquivo e no `revisor-cortag` vale por cima delas (ex.: o fluxo de PR daqui).
- Plugin **taste-skill** (`Leonxlnx/taste-skill`, registrado do mesmo jeito, 10/2026): skills de
  design de interface (`taste-skill`, `redesign-skill`, `minimalist-skill`, `soft-skill`,
  `image-to-code-skill`, `brandkit`…), só texto, sem script. Pensadas pra landing page em
  React/Tailwind: aqui as páginas são HTML sem bundler e o "Padrão visual" do README (tokens de cor,
  tema escuro, botões de modal) vale por cima delas — usar como referência de gosto, não pra trocar
  o padrão do app.
- MCP **Playwright** (`.mcp.json` → `.claude/mcp-playwright.js`): navegador com tela de celular
  (Pixel 7) pra abrir o app e tirar print. Com `scripts/app-local.js` rodando, abrir
  `http://localhost:8080/__entrar`. Na nuvem usa o Chromium de `/opt/pw-browsers` (sem janela,
  sem sandbox). Mudança de tela que dá pra ver vale conferir assim antes do PR.

Pegadinhas de ambiente:
- `index.html` tem fim de linha **CRLF** — editar preservando (ex.: Python com `newline=''`).
- Pra testar SQL num Postgres local: `db.js` liga SSL sempre que `DATABASE_URL` existe, então usar
  `PGHOST`/`PGPORT`/`PGUSER`/`PGDATABASE` sem `DATABASE_URL`.
- `schema.sql` roda inteiro em toda subida: tabela nova vem **antes** da primeira referência a ela
  (até 10/2026 o `CREATE TABLE usuarios` vinha depois de um `REFERENCES usuarios` e um banco novo
  só subia na 2ª execução). O pool (`db.js`) tem `max` 10 (`PG_POOL_MAX`), espera de conexão de
  20 s e `statement_timeout` de 60 s; no SIGTERM do deploy o `server.js` termina as requisições em
  andamento (até 25 s) e fecha o pool.
- `index.html` **não tem regra `.hidden` genérica** (as páginas separadas têm, com `!important`):
  cada componente declara o seu `.X.hidden { display: none }`. Elemento que liga/desliga por
  `.hidden` não pode ter `display` no `style=""` inline — o inline ganha e ele nunca some (foi a
  causa do "Adicionar todos ao orçamento" da busca que aparecia sem resultado e não fazia nada,
  PR #128). O `scripts/checar-html.js` acusa elemento com id que liga/desliga `.hidden` sem regra
  própria (ou com `display` inline) — em 10/2026 eram 11, entre eles o botão "Entrando…" do login,
  o card de classificatório e a lista de clientes (que, escondida de verdade com os alertas
  abertos, faz a busca fechar os alertas).
- Tela que carrega dado de um cliente/aba com `await` (aba Clientes, ficha de CNPJ, busca de
  cliente) guarda o alvo e um contador antes do `await` e descarta resposta velha (`velha()`,
  `novaBuscaCliente`): com o servidor lento, a resposta de A aparecia sob B (10/2026).
- `init()` roda uma vez por carga de página (`appIniciado`); novo login com o app aberto (sessão
  expirada) recarrega a página — init de novo duplicava os listeners e "Finalizar pedido" gravava
  dois pedidos.
- `sw.js`: página do app vai à rede, mas com sinal fraco abre com a cópia guardada depois de
  `PRAZO_REDE_PAGINA_MS` (4 s) e grava a nova em segundo plano; o script (`importadores.js`) segue
  a página (página da cópia = script da cópia), pra nunca misturar versões.
- **Rotação do app instalado** (10/2026, relato do usuário: o tablet com o PWA instalado ficava preso em pé): o
  `manifest.json` tinha `"orientation": "portrait-primary"`. Agora é `"any"`, e o `index.html` trava em pé só no
  celular instalado (`screen.orientation.lock`, lado menor da tela < 600 px). O manifest é servido do cache primeiro
  pelo `sw.js`: mudar o manifest = subir o `CACHE_VERSION`, senão o aparelho continua com o velho. O conteúdo do
  `index.html` segue numa coluna de 560 px no centro, **menos a aba Levantamento**: a partir de 700 px de largura
  (`body.abaLev`, ligada em `activateMainTab`) o app vai até 1280 px e a lista de itens vira grade (tablet em pé = 2
  colunas, deitado = 3) — pedido do usuário pro levantamento no tablet com o celular de leitor.
- Proteção contra iframe: `frame-ancestors` no `<meta>` não vale (só em cabeçalho, e o GitHub Pages
  não manda). Cada página começa escondida (`#antiFrame`) e só aparece fora de frame; página nova
  separada leva o mesmo trecho no `<head>`.
- Biblioteca de CDN (cdnjs/jsdelivr) nova ou com versão trocada nas páginas entra também na lista
  `LIBS` do `sw.js` — é ela que deixa imagem/PDF do orçamento e a câmera do iPhone funcionarem sem
  internet (o teste do `run_tests.js` acusa a que faltar). O SW guarda página/script do app pelo
  endereço sem parâmetros (`chaveDaPagina`).
- Fila offline (`drenarFilaSync`, `index.html`): uma aba por vez (Web Locks — o app instalado e uma aba
  do navegador dividem o `localStorage`); **sem prazo no envio** de propósito (abortar não para o servidor,
  que terminava de gravar o levantamento e o reenvio gravava de novo); item que o servidor recusa de verdade
  (403/404/409/422 com a mensagem do app — **400 não**, o servidor também responde 400 a falha passageira do
  banco) sai da fila com aviso e fica guardado em `cortagFilaRecusados_v1`; Painel › "Ver pendências e
  recusados" mostra a fila com o último erro de cada item, baixa tudo em JSON e descarta os recusados; a
  fila é relida no fim pra não perder o que entrou durante o envio. `saveSyncQueueList` devolve se
  gravou; sem espaço, o `apiFetch` lança erro (`semEspacoNaFila`) em vez de dizer "fica salvo" (o pedido
  oferece o CSV na hora). A fila do Drive (`drenarFilaDriveCsv`) segue o mesmo padrão: Web Lock, relê
  a fila no fim, e sem espaço não diz "pendente". Erro permanente das rotas de pedido/levantamento
  (itens inválidos, origem desconhecida, código em formato inválido) responde **422** (`ErroPermanente`,
  `routes/lib/produtoPorSku.js`); produto que está na Lista de Preços ou nos promocionais do Painel e ainda
  não em `produtos` é criado na hora (e a importação da lista já cria os novos); produto que não está em
  lugar nenhum responde 400 (a fila tenta de novo — o catálogo pode chegar depois). O levantamento também leva
  `id_envio` (`idx_levantamentos_id_envio`): o reenvio devolve o já gravado. Rota nova com método novo: conferir o `Access-Control-Allow-Methods` do `server.js` (faltava
  `PUT` e o nome do arquivo do cliente nunca chegava do app publicado; teste no `run_tests.js`). Biblioteca carregada sob demanda que falhou tenta de novo na próxima vez (o pdf.js com
  `?tentativa=N`, que o `sw.js` atende pela cópia sem parâmetro).
- Nome de cliente passa por `limparNomeCliente` (`clientMatcher.js`): "\\" é o "/" escapado de exportação
  ("MATS. P\\/ CONSTR.") e criou 15 clientes duplicados em 09/2026 (apagados em 10/2026). Filiais com o
  mesmo nome (mesma razão social, CNPJs diferentes — COFEBRAL, GRACIOSA, GLASS POINT, PATRICIA TAJIMA em
  10/2026) são clientes diferentes: o código oficial novo do relatório vai pra de mesmo nome ainda sem
  código e nunca troca o de outra.
- "Hoje" no SQL é `SQL_HOJE_BR`/`SQL_HOJE_BRASIL` (dia de Brasília), nunca `CURRENT_DATE` (UTC, vira o
  dia às 21h).
- **Data sem hora nunca passa por `new Date()` pra exibir.** Coluna `DATE` (`data_faturamento`,
  `data_implantacao`) e `date_trunc(...)` chegam no JSON como meia-noite UTC
  (`2026-09-11T00:00:00.000Z`); no fuso do Brasil isso vira o dia (ou o mês/trimestre) anterior.
  Usar `formatDateBr` (`index.html`, formata `AAAA-MM-DD` direto do texto), `partesDoPeriodo`
  (`curva-abc.html`, rótulos dos gráficos) ou `String(d).slice(0, 10)`. Já causou: faturado 11/09
  aparecendo 10/09 (PR #134) e o gráfico mensal inteiro um mês atrás, setembro como "ago/26" (PR #135).

## Fluxo de trabalho

Cada mudança vira um PR próprio contra `main`, numa branch criada de `origin/main` atualizado (se a
branch de trabalho já teve um PR mergeado, recriá-la de `origin/main` antes da próxima mudança):

1. `node test/run_tests.js` e a checagem de sintaxe dos `<script>` — só segue se passar.
2. Commit, push, abrir PR **draft** contra `main` e `subscribe_pr_activity` pra acompanhar
   CI/comentários.
3. Depois do merge, trazer a branch de trabalho de volta pra `origin/main`.

Correções pontuais de **dado** (ex.: EAN trocado entre dois SKUs) são feitas direto via SQL no
Supabase, sem PR — não é mudança de código.

## O que já foi feito

- **Revisão de segurança completa** (`docs/PLANO-REVISAO-SEGURANCA.md`, 13 achados de segurança +
  11 bugs), executada em 4 PRs sequenciais por ordem de risco — todos já mergeados em `main`:
  troca da lib `xlsx` vulnerável, XSS armazenado no código do produto, queda do servidor por
  erro assíncrono não tratado, rastro de importação, pedido não pode ser sobrescrito por outro
  usuário, dados sujos na importação, vazamento de erro do banco pro cliente, timeout em chamadas
  externas, hash de token de sessão, login Google mais rígido, CORS restrito, e outras corridas
  menores. Checklist do arquivo atualizado em 09/2026 (cada item aponta o PR que corrigiu): **os
  24 itens estão feitos** — o último, B2 (cotação duplicada checada fora da transação), veio
  depois, em PR próprio: a busca da cotação em `POST /api/pedidos` roda dentro da transação com
  `SELECT ... FOR UPDATE`.
- **Segunda revisão de segurança** (10/2026, achados do `/review` do agent-skills):
  - **Vendedor que saiu é desativado, não excluído** (decisão do usuário): `usuarios.ativo`; inativo não
    passa no `requireAuth` nem no `/auth/me` (401) e o login Google recusa ("acesso desativado").
    `PATCH /api/auth/usuarios/:id {ativo}` (só admin, bolinha na lista de usuários do Painel) apaga as
    sessões e o push dele; não desativa a si mesmo nem o último admin ativo. Excluir quem tem pedido ou
    importação responde 409 (as FKs de `pedidos`/`import_log` não têm ON DELETE de propósito: o
    histórico continua com o nome dele).
  - **RLS ligado em toda tabela do `schema.sql`** (bloco no fim; tabela nova entra lá, o teste confere).
    Nunca `FORCE ROW LEVEL SECURITY`: o app conecta como dono. As tabelas de backup avulsas do banco
    também tiveram o RLS ligado direto no Supabase em 05/10/2026 (o verificador acusava 9 tabelas
    abertas pra leitura/escrita anônima).
  - **Rotas de payload grande** (`ROTAS_PAYLOAD_GRANDE`, 25 MB) conferem o login antes de ler o corpo.
  - **SheetJS do navegador é o `@e965/xlsx@0.20.3` do jsdelivr** (o 0.18.5 do cdnjs tinha
    CVE-2023-30533/CVE-2024-22363). Trocar a versão = trocar no `index.html` e na `LIBS` do `sw.js`.
  - **Link vindo de dado** (planilha, configuração, cadastro) passa por `urlHttpsOuVazio` (`index.html`),
    na importação e na exibição: `escapeHtml` não barra `href="javascript:..."`.
  - **Push só pros hosts exatos dos serviços de push** (`HOSTS_PUSH` em `routes/lib/novidades.js`).
- Atalhos de produtividade pro vendedor: botão "Produtos comprados" (pula direto pra Curva ABC já
  filtrada no cliente), botão de adicionar direto ao orçamento a partir da Curva ABC, correção da
  lista de campanhas que sumia no Painel Administrativo (race condition de render antes do dado
  assíncrono carregar), acesso rápido ao Salesforce da empresa.
- **Painel Administrativo simplificado** (área única de importação que reconhece o arquivo,
  promoções numa lista só, Produtos foco recolhido dentro de Promoções) e **padronização visual**:
  tokens de cor de status, correção do tema escuro (textos que sumiam, fundos claros fixos, telas
  de login das páginas separadas), botões de modal com um padrão só, `alert()`/`prompt()` nativos
  trocados por toast de erro/`askText`. O padrão está documentado em "Padrão visual" no README.
- **Sugestões de recompra** (PR #118): botão "💡 N sugestões" na barra do cliente (Pedido e
  Levantamento), que só aparece quando há sugestão e abre um `.minimodal` com a lista.
  Decisões do usuário: **nunca abre sozinho** (só pelo botão), é **só lembrete** (tocar no item
  não faz nada) e o histórico é **faturado oficial + pedidos do app**. Backend em
  `GET /api/clientes/:id/sugestoes-recompra` (`routes/relatorios.js`): grupo entra só se
  nenhuma variação foi comprada nos últimos 365 dias, ordena por nº de pedidos, limite de 15,
  SKUs promocionais reconciliados com `codigoBase`. O agrupamento por nome fica em
  `routes/lib/agrupamentoProduto.js` (`grupoDoProduto`: corta em " - " e na primeira palavra
  com número/"Ø"; ~1.700 produtos → ~500 grupos; tipos diferentes de broca continuam separados)
  — reaproveitar sempre que precisar tratar "o produto" em vez de cada SKU. Não confundir com a
  rota antiga `/clientes/:id/recuperar` (cruza com levantamento, por SKU, sem agrupar), que
  continua existindo — ver "Fontes de dados" abaixo.
- **Localização do cliente gravada ao salvar o Levantamento**: ao tocar em salvar, o app pega o
  GPS do celular (até ~6 s, sem aviso se negar ou falhar) e manda junto no `POST
  /api/levantamentos` — inclusive pela fila offline, com a leitura feita dentro da loja. Escolhido
  esse momento porque é quando há certeza de que o vendedor está na loja. A leitura crua fica em
  `levantamentos` (`latitude`/`longitude`/`localizacao_precisao_m`) e, se a precisão for de até
  100 m, vira a posição do cliente (`clientes.latitude`/`longitude`/`localizacao_precisao_m`/
  `localizacao_atualizada_em`), que só é trocada por leitura igual ou mais precisa, ou quando a
  atual tem mais de 180 dias (regra no `WHERE` do `UPDATE`, em `routes/levantamentos.js`). O
  toast de sucesso mostra "📍 localização da loja registrada". Por enquanto só grava — nada no
  app ainda usa essa posição (ver "Localização do cliente" em "Caminho a seguir").

- **BrasilAPI como reserva da ficha de CNPJ**: `buscarFichaNaOrigem` (`routes/radarCnpj.js`) tenta o
  radar-cnpj.com e, se ele recusar/atingir limite/cair/não achar o CNPJ, consulta a BrasilAPI
  (grátis, sem chave). A resposta dela é convertida pro formato exato do radar-cnpj
  (`routes/lib/cnpjBrasilApi.js`, conferido contra o `dados_brutos` real do banco), então cache,
  `mapearFicha` e telas não mudaram — o vendedor não percebe qual respondeu. O limite gratuito do
  radar-cnpj não está confirmado; a reserva existe justamente pra não depender dele.

- **Fichas de CNPJ completadas sozinhas + atalho direto**: o servidor completa de madrugada as
  fichas que faltam (`routes/lib/preenchimentoCnpj.js`, ligado em `server.js`) — decisão do
  usuário: **automático, sem botão**, com folga pras consultas manuais: só 01h–06h de Brasília,
  máx. 40/noite, 1 a cada 15 s, só quem não tem ficha nenhuma (ficha vencida continua sendo
  atualizada só ao abrir); 404 tenta até 3 noites e desiste; origem fora do ar/no limite pausa a
  noite. Em 24/09 eram 291 clientes com CNPJ, 122 com ficha. Progresso na linha "Fichas de CNPJ"
  do card de status do Painel Administrativo; `PREENCHIMENTO_CNPJ_DESLIGADO=1` no Render desliga.
  Pedido junto do usuário: com cliente selecionado que já tem ficha, o botão **"Ficha cadastral"**
  na barra do cliente (e o ícone de ficha do topo) abre `ficha-cnpj.html?cliente=…` direto nele,
  em aba nova, sem buscar de novo — a checagem `/ficha-cnpj/existe` só lê o banco.

- **Card do cliente selecionado redesenhado** (Pedido e Levantamento, mesmo componente
  `.clienteCard` em `index.html`) — escolhido pelo usuário a partir de mockups: nome numa linha
  (corta com "…"), selo de classificatório + CNPJ embaixo, botão ⇄ pra trocar; objetivo do
  trimestre como "faltam R$ 47,5 mil" + barrinha (sem objetivo, a mesma linha mostra a próxima
  faixa/meta/risco de queda); ações em botões de toque numa linha só (desde 10/2026, opção "B"
  escolhida pelo usuário a partir de mockups: **ícone de traço com o nome embaixo**, colunas
  iguais — Sugestões · Ficha · Pedidos · Histórico no Pedido, sem Pedidos no Levantamento; o
  número de sugestões/pedidos salvos vai numa bolinha no ícone, laranja nas sugestões; antes eram
  pílulas com emoji e os 4 nomes saíam cortados com "…". "Comprados" virou **"Histórico"** pra não
  confundir com Pedidos; continua abrindo a Curva ABC do cliente). Decisões: **sem avatar de iniciais** (ocupava espaço), **código do cliente no
  ERP não aparece depois de selecionado** (continua no seletor), **"Limpar" saiu do card e foi
  pra dentro do seletor** ("Limpar seleção", só aparece com cliente escolhido; no Levantamento
  também desliga o levantamento aberto, como o antigo botão fazia). Sem cliente, o card vira um
  botão tracejado "+ Selecionar cliente" (sai o rótulo "Cliente (opcional)").

- **Política Comercial rev. 06** (PVEN, 04/2026), em 2 PRs:
  - **No pedido** (PR #125): classificatório por canal, canal automático pelo classificatório do
    cliente, desconto por prazo, prazos por canal e pedido mínimo CIF por região (detalhes em
    "Motor de preço" no README). Decisões do usuário: desconto de prazo **automático e somado** ao
    classificatório (não multiplicado como o "Desc. adicional"); Marmoraria/Consumidor final =
    **+30% sobre a tabela Institucional** (percentual negativo = acréscimo); Rede 18% continua no
    Varejo; o percentual vale **pela política, pelo nome** — o ERP ainda manda "Varejo Exclusive
    (12)"/"Premium (15)" da política antiga, então a importação grava pelo nome
    (`descontoPelaPolitica`), e os 131 clientes antigos foram corrigidos direto no banco em 09/2026.
  - **No card/ficha do cliente** (PR #126): faixas de **todos os canais** e faixa medida pelos
    **últimos 12 meses móveis** (régua da política) no lugar do ano fechado — risco de queda = 12
    meses abaixo do mínimo da faixa; PIC continua pelo acumulado do ano. A API de status devolve
    `faturamento12m`, `faturamentoFaixa` (o valor comparado com a faixa — a barra do card usa ele)
    e `revisao` ("Apuração mensal · ajuste pra baixo em 01/01 e 01/07"); `proximaRevisao` saiu.
  - Tabelas que precisam andar juntas: `CLASSI_POR_CANAL` (`index.html`) ↔
    `routes/lib/politicaComercial.js` (percentuais) e `FAIXAS` em `routes/clientesClassificatorio.js`
    (valores das faixas; buscar sempre via `faixaDoTipo`, que ignora acento/maiúscula).
  - **Campanhas por canal** (10/2026, pedido do usuário: "as promoções são diferentes por canal"): cada
    regra de campanha do Painel (Promoções › quantidade/valor/cesta, chave `promocoes`) tem `canais`; as
    criadas antes, sem o campo, valem **só no Varejo** (`canaisDaRegra`) — antes toda regra valia em todos.
  - **Campanhas do Trade News** (10/2026): a regra ganhou campos **opcionais** ("Mais condições" no
    formulário; sem eles vale exatamente como antes, o teste confere): `classificatorios` (o do botão do
    orçamento, `classiTiposDoOrcamento`, sem acento/maiúscula — limite diferente por grupo = uma regra
    por grupo), `ufs`/`ufsExcluidas` (estado do orçamento), `validoAte` (texto `AAAA-MM-DD` × dia de
    Brasília, `hojeBrasiliaISO`), `maxPctDoPedido` (protetor de piso: alvo até X% do pedido e com outro
    produto; senão aviso "Campanha … não aplicada" no orçamento), alvo **"Pedido todo"** + `selfMetric:
    "skus"` (itens diferentes — "Mais Cortag + Desconto"), `excluirCodigos`/`excluirFamilias`/
    `excluirOutraCampanha` (contam na quantidade, não ganham o desconto) e `exigeItens` (% mínimo dos
    itens em lançamentos/família foco). **O catálogo não diz o que é lançamento 2026/família foco** (o
    "Produtos foco" do Painel é só do gráfico do Dashboard): a lista é digitada na própria regra. Motor
    puro entre `<motor-campanhas>` no `index.html` (`avaliarCampanhas`), rodado isolado pelo teste; o
    servidor grava `promocoes` sem validar campo. Preço Fixo continua sem bônus (`bonusDaCampanhaNoItem`).
    **Black Friday 10/2026, cortadores "15% de desconto no preço fixo, não acumulativo"** (decisão do usuário:
    o desconto sai **do preço fixo**, não está embutido nele): regra com `soNoPrecoFixo: true` — vale só em item
    de Preço Fixo no canal, sobre o preço fixo (sem classificatório nem desconto do item), e nunca em item não
    fixo; as demais regras seguem sem bônus em item fixo. As ventosas/máquinas MAC ("20% + classificatório, já
    no preço") são regra comum. Caixas e bolsas (preço em reais) são da Lista de Preços, não de campanha.
  - **Preço fixo é por canal**: o item "PREÇO FIXO" da Lista de Preços só é fixo em Varejo/Atacado/
    E-commerce (`canaisFx`); tudo que trava desconto (campo por item, `setItemDiscount`, campanha) usa
    `isPrecoFixoParaCanal`, nunca o `p.fx` puro (que diz "fixo em algum canal").
  - **Lápis "Editar preço base"** guarda o valor **sem imposto** e o `listPrice` põe o imposto do produto
    por cima (`fatorImposto`: preço com ÷ sem imposto da Lista de Preços, ou IPI×ST no formato antigo).
  - O orçamento guardado no aparelho leva o contexto junto (`cortagCartContexto_v1`, mesmo formato do
    `contexto` do pedido) e volta na abertura; o `cortagCart_v1` continua só a lista de itens (a Curva
    ABC lê). As parcelas disponíveis contam o total **sem** o desconto do próprio prazo.
  - Fora de propósito: Home Center Master e Trading ("a consultar"/lista específica — o vendedor
    usa o "Desc. adicional"); Institucional, Construtora e Atacarejo não têm faixa.

- **Comprados e não contados no Levantamento** (PR #129): produto que acabou na loja não tem o que escanear
  e saía do pedido (caso real: 3 rebolos na última compra, prateleira vazia). Com cliente
  selecionado, o Levantamento mostra o que ele comprou nos **últimos 12 meses** e não está na
  contagem (`GET /api/clientes/:id/comprados-recentes`, `routes/relatorios.js`: faturado + app, por
  SKU, promocional unido ao base; pedido do app já faturado conta uma vez só — ver "Fontes de dados").
  Decisões do usuário: **lista no Levantamento + aviso ao salvar** ("Incluir e salvar" / "Salvar
  assim"); incluir = **estoque 0 e pedido com a quantidade da última compra**, e o item segue o
  fluxo normal ("Adicionar todos ao orçamento"). Cópia por cliente em `localStorage`
  (`cortagCompradosRecentes_v1`) pra funcionar na loja sem internet. Complementa as 💡 sugestões,
  que cobrem o que ele não compra há mais de 1 ano. `askConfirm` ganhou `opcoes.cancelarLabel`.

- **Fontes de dados conciliadas com o sistema oficial** (PRs #132–#136, 09/2026) — o usuário
  comparou o Dashboard com o painel do Salesforce e os números não batiam; a revisão achou mais
  telas lendo a fonte errada. Regras que valem pra qualquer tela nova:
  - **Duas fontes de "compra"**: `pedidos_oficiais_itens` (relatório do ERP, Carteira +
    Faturamento — a verdade, ~3.700 pedidos) e `pedidos`/`pedido_itens` (o que o vendedor fecha
    no app, só desde 05/2026, ~260 pedidos). Tela que responde "o que o cliente comprou" usa as
    duas: `comprasDoCliente` (`routes/relatorios.js`) junta faturado + app por SKU e dia, código
    promocional (P/P1/P2) unido ao base. Usada por Histórico, Rotatividade, Recuperar e consumo
    estimado; "Já compraram" (aba Produtos), `comprados-recentes` e sugestões seguem a mesma regra.
    Antes, 118 dos 293 clientes que compraram no ERP em 12 meses apareciam sem histórico nenhum.
  - **Pedido do app não conta em dobro** (`routes/lib/comprasApp.js`, 09/2026): o vendedor fecha
    no app (ou importa o PDF) e o ERP fatura dias depois — a regra antiga ("mesmo dia") contava duas
    compras e a Rotatividade encurtava ("repõe a cada ~5 dias"). Pedido do app/PDF só conta se não
    houver faturado oficial do mesmo cliente + produto entre 7 dias antes e 45 depois; pedido com
    `origem = 'faturamento'` (cópias de uma importação antiga de faturamento, já removida — 3.067
    itens) nunca conta. Pedido do app ainda não faturado continua contando (decisão das sugestões).
    Toda tela nova que some as duas fontes usa `SQL_PEDIDO_APP_VALIDO` + `pedidoAppJaFaturado`.
  - **Dia do pedido do app = `sqlDiaDoPedido`** (`routes/lib/comprasApp.js`, 10/2026): `data_pedido` é
    TIMESTAMPTZ e o banco roda em UTC, então `data_pedido::date` punha o pedido fechado depois das 21h
    no dia seguinte. Mas o importado de PDF e as cópias de `origem = 'faturamento'` guardam **só a
    data**, à meia-noite UTC — converter pro fuso os jogaria pro dia anterior. A expressão trata hora
    exatamente 00:00:00 UTC como "só a data" e converte o resto pro fuso de Brasília (em 05/10/2026
    mudou 1 pedido de 267). O "meia-noite UTC" é lido com `AT TIME ZONE 'UTC'` (não depende do fuso da
    sessão). Nunca usar `data_pedido::date`/`DATE(data_pedido)` direto; a tela recebe o dia pronto (`dia`)
    em vez de cortar o `data_pedido` (que vem em UTC). Pedido do app fechado (ou alterado) sem internet grava
    a hora do toque, não a hora em que a fila enviou: o app manda a hora do toque (`data_pedido`/
    `alterado_em`) e o `apiFetch` carimba `enviado_em` em cada envio; o servidor desconta essa espera do
    relógio dele (`horaDoPedidoDoApp`) — relógio errado do celular não entra. O pedido novo leva um `id_envio`
    gerado no toque: com sinal fraco o servidor gravava, a resposta se perdia e o reenvio da fila criava outro
    pedido — agora o reenvio com o mesmo id devolve o já gravado (`idx_pedidos_id_envio`, único).
  - **Entrada de Pedidos ≠ Faturamento**. O painel oficial conta a entrada pela **data de
    implantação** (`Implantação`/`Dt.Implant` → `data_implantacao`), **carteira + faturado**, e
    **sem a série de pedidos de 7 dígitos** (10xxxxx–13xxxxx: itens avulsos de valor baixo, fora
    do catálogo; a série principal tem 6 dígitos, hoje na casa dos 676000). Com essa regra o
    gráfico "Qtde. Clientes Mês" bateu cliente a cliente com o oficial de jan a ago/2026. Está em
    `SQL_ENTRADA_PEDIDOS_MENSAL`/`SQL_ENTRADA_PEDIDOS_DO_MES` (`GET /api/dashboard/resumo`).
    Faturamento (classificatório, Curva ABC, top clientes, vendas semanal/trimestral) continua
    por `data_faturamento` (`Dt.Emissão`), só `status = 'faturado'`.
  - **Dashboard** (`curva-abc.html`, aba Dashboard): "Valor Entrada de Pedidos Mês", "Qtde.
    Pedidos Mês", "Qtde. Clientes Mês" e ticket médio usam a regra de entrada; tocar no cartão de
    Entrada de Pedidos abre a lista dos pedidos do mês (cliente, dia, valor; a soma bate com o
    cartão) — mesmo mecanismo `kpiExpandData`/`toggleKpiExpand` dos cartões de contas sem compra,
    que ganhou `unidade`/`vazio` por cartão.
  - Decisão do usuário: em "Já compraram" a data mostrada é a do **faturamento** (a NF ao lado é
    dela), não a do pedido.
  - **Produto que saiu da tabela de preços** aparece com o nome da coluna "Descrição" do relatório
    (`pedidos_oficiais_itens.descricao`, gravada na importação desde 09/2026), não só com o código.
    Eram 94 códigos fora de `produtos` (615 linhas, 411 pedidos, 72 sem venda há mais de 1 ano —
    descontinuados, não arquivo corrompido). Linhas importadas antes ficam sem descrição até alguém
    reimportar um relatório que tenha o item (7 foram preenchidos a partir dos relatórios de
    01/11 e 30/11/2025; os outros 87 ainda mostram o código). Nome vem de `produtos` primeiro;
    `descricao` só entra quando o código não está no catálogo.

- **Recado de ICMS-ST do Paraná no orçamento** (09/2026): pelos Protocolos ICMS 111/2026 e 95/2026,
  1.131 códigos saem da substituição tributária no PR em 01/10/2026 (lista em `ST_PR_2026`,
  `index.html`, tirada da planilha de exclusão; promocional P/P1/P2 cai no código base). Com
  estado PR e algum desses itens no carrinho, o PDF, a imagem e o texto do WhatsApp marcam o item
  com (\*) e trazem o recado (`avisoStPr2026`): antes de 01/10 avisa que a nota faturada depois
  sai sem ST e menor; depois de 01/10, se o preço ainda tiver ST (catálogo não atualizado), avisa
  que a nota sai menor. O texto muda pelo regime da ficha de CNPJ — Simples/MEI (ICMS da revenda
  no DAS) × regime normal (crédito do ICMS destacado) — que vai no `/api/clientes/sync`
  (`regime_tributario`) pra funcionar offline. O aviso some sozinho depois de 31/12/2026. Em
  09/2026 no PR: 193 clientes Simples, 96 regime normal, nenhum MEI; 156 clientes sem ficha
  (regime desconhecido, recado sem a frase do regime). **O preço em si não muda sozinho** — em
  01/10 o catálogo precisa vir sem ST nesses itens (LISTA PADRÃO nova ou correção no banco).

- **Pagamento à vista pendente** (09/2026, PRs #145 e seguinte): o relatório oficial tem **duas abas**
  (formato conferido com o relatório real de 30/09/2026), reconhecidas pelo nome em `index.html`:
  - **"Aguardando Pagamento"** (`ehAbaAguardandoPagamento`): **pedidos** não liberados, mesmo layout
    da Carteira, Sit.Financeira "Aguardando Aprovacao" — **não** aparecem na aba Carteira. Vão pra
    `pedidos_pendentes_pagamento` (um por pedido, valor somado).
  - **"Pendentes à Vista"** (`ehAbaTitulosAvista`): **títulos** em aberto de pedido já faturado —
    Vencimento, Título, Parcela, Valor, **sem Nr.Pedido**. O Título é o **número da nota fiscal**
    (liga em `pedidos_oficiais_itens.nota_fiscal`). Vão pra `titulos_avista_pendentes`.
  - Cada aba é a **foto do último relatório que a trouxe**: a importação troca a lista inteira
    (sumiu da aba = pago); relatório sem a aba não mexe. A 1ª versão (PR #145) tratava as duas como
    uma aba de pedidos e **recusava o relatório real inteiro** ("Pendentes à Vista" não tem Nr.Pedido).
  - Decisão do usuário: aparece **só no histórico do cliente** (aba Pedidos oficiais): selo "À vista ·
    aguardando pagamento" no pedido não liberado; "À vista · pagamento pendente · vence/venceu DD/MM ·
    R$ X" no pedido da NF (vermelho se vencido). Pedido/título que não está nos pedidos importados
    do cliente ganha um card só com o que a aba traz.
  - A NF do título **já aparece na aba Faturamento**, mas o pedido **não foi faturado de fato** (o
    usuário corrigiu: "aparece como faturado, mas não foi"). No card, pedido com pendência à vista
    mostra "Situação: Aguardando pagamento" + Total, sem "Faturado", selo T/P, transportadora nem
    "Rastrear entrega". Decisão do usuário: **não conta no faturamento enquanto pendente** —
    `sqlFaturadoDeFato` (`routes/lib/faturadoDeFato.js`) no lugar de `status = 'faturado'` no
    classificatório (12 meses, ano, grupo, última compra), Curva ABC, faturamento semanal/trimestral
    e top clientes do Dashboard e acumulado da ficha; volta a contar quando o título some da aba.
    Continua contando em Entrada de Pedidos (entrou de fato) e no que o cliente comprou (Histórico,
    Rotatividade, sugestões, comprados-recentes). Toda soma nova de faturamento usa `sqlFaturadoDeFato`.

- **Números oficiais da planilha Classificatório no card do cliente** (aba Clientes, 10/2026) — pedido
  do usuário pra não precisar abrir a planilha. A importação (Painel → planilha "Classificatório")
  grava uma foto por cliente em `cliente_classificatorio_erp` (relatório mais novo vence; data pelo
  nome do arquivo `DD.MM.AAAA_...`, apuração = maior Ult.Compra da planilha). O card ganhou a seção
  **"Oficial do ERP"** (12 meses da matriz × do cliente, ano anterior, acumulado, "Diferenca" lida
  como falta pra manter/subir, última compra, situação, cidade, cliente desde, gestor) acima de
  **"Ao vivo no app"** (o cálculo antigo). Conferido contra o relatório real de 02/10/2026:
  - O ERP **fecha a apuração por mês** (relatório de 02/10 = até 31/08): por isso o "ao vivo" do app
    (12 meses móveis até hoje) costuma passar do oficial. Com a janela 01/09/2025–31/08/2026 o
    "Fat.Cliente" bateu com o banco em 235 de 254 clientes não-Rede.
  - **Ano anterior, acumulado e "Faturamento" são da MATRIZ inteira no ERP**, inclusive filiais de
    outros representantes (que não estão no app); só "Fat.Cliente" é do cliente. Quando a matriz do
    ERP é maior que a soma das empresas dela no app (`fat12mOutrasEmpresas`), o veredito de faixa ao
    vivo sairia errado ("vai cair" quando falta pouco pra subir) — o card esconde barra/meta
    trimestral automática e o card compacto do Pedido/Levantamento usa a leitura oficial
    (`statusComFaixaOficialErp`); os alertas de classificatório também (`aplicarLeituraErp`, item com
    "oficial do ERP"). Em 10/2026 era 1 cliente só. Fora isso, alerta ao vivo × ERP divergiam em 6
    de 130 Premium/Master só pela janela (o app já tirou set/2025 e somou set/2026; o ERP fecha 31/08)
    — esperado, não é erro.
  - **"Por que é diferente do ERP?"** (recolhível, em "Ao vivo no app"): concilia linha a linha —
    app − vendas depois da apuração + vendas que o ERP ainda conta e o app já tirou da janela ±
    "outras diferenças" = ERP (12 meses e acumulado; `erp.conciliacao` na rota de status). Caso real
    da PEOCA (3663) em 02/10/2026: 141.058,35 − 16.955,40 (set/26) + 13.123,26 (set/25) − 351,54 =
    136.874,67. As "outras diferenças" (sempre ERP abaixo, sem nota/item que as explique) são
    provavelmente devolução/abatimento no ERP — o relatório de faturamento traz o valor bruto.
  - A importação da planilha agora **troca** a faixa gravada quando o relatório é tão ou mais novo
    (antes só preenchia quem não tinha — 22 clientes estavam com faixa de 2023–2025, corrigidos via
    SQL em 02/10/2026; backup em `backup_clientes_classif_20261002`).
  - Matriz, PIC e valor de acordo só mudam com planilha tão ou mais nova que a última foto do cliente
    (`cliente_classificatorio_erp.data_relatorio`).
  - Série de 7 dígitos: o ERP **conta** no classificatório na maioria dos casos (8 clientes), mas não
    em 2 (5569, 21650) — não aplicar o filtro `length(nr_pedido) <= 6` no classificatório.

- **Trocar de cliente limpa o que era do anterior** (10/2026, relato do usuário: trocar o cliente deixava o
  levantamento e o carrinho do anterior na tela — a contagem ia pro cliente novo e "Finalizar" gravava um pedido
  dele com os produtos do outro). Só no ⇄ de A → B (`deixarClienteAnterior`, `index.html`); os outros caminhos
  de `setLevCliente` (abrir levantamento/pedido salvo, Montar proposta, 1ª escolha com o orçamento montado)
  trazem os itens certos de propósito e não mudam. Levantamento igual à cópia salva sai sem perguntar; com
  contagem não salva, "Descartar e trocar"/"Voltar" (Voltar desiste da troca). Orçamento que é exatamente o
  pedido salvo de A (itens **e** contexto, `pedidoSalvoDoOrcamento`) sai sem perguntar; senão, decisão do
  usuário: **pergunta** "Começar vazio"/"Manter itens" (manter = mesmo orçamento pra outra loja, pedido novo);
  alteração não gravada de pedido salvo pergunta com "Descartar".

- **Pedido faturado em parte** (10/2026, PRs #154 e seguinte): o card do pedido oficial com selo "P"
  lista à parte "Não faturado · em carteira" (com valor) e "Faturado" — antes ficava tudo misturado.
  A chave de `pedidos_oficiais_itens` passou a ser `nr_pedido` + `codigo_sku` + `nota_chave` (nota
  fiscal na linha faturada, `''` no saldo em carteira; migração no `schema.sql`, roda uma vez): antes o
  saldo do produto faturado em parte era sobrescrito pelo faturado e, de um produto entregue em duas
  notas, ficava só a última (1.288 de 3.683 pedidos tinham mais de uma nota). A importação
  (`planejarCarteira`, `routes/pedidosOficiais.js`) apaga o saldo quando o produto sai da Carteira e
  aparece no Faturamento, e todo o saldo do pedido que o relatório dá como "Atendido Total" (item
  cancelado no ERP ficava "em carteira" pra sempre — 47 de 156 linhas de carteira em 02/10/2026).
  Dado antigo só se completa reimportando os relatórios. Telas de "o que o cliente comprou" somam as
  notas do mesmo pedido como uma compra (`juntarNotasDoPedido`, `routes/relatorios.js`).
- **Saldo em carteira abaixo do mínimo** (10/2026): política de cancelamento da Cortag (e-mails
  "Cancelamento saldo em carteira DD.MM.AAAA" da assistente comercial — o **aviso final antes do corte**,
  ver "Aviso de cancelamento do saldo" abaixo): o saldo
  do pedido abaixo de **R$ 300** (**R$ 600 no Norte/Nordeste**) é cancelado, além de item sem
  previsão/obsoleto, acima de 90 dias e à vista sem pagamento. Regra do usuário pra salvar o saldo:
  o cliente aumenta a quantidade — **com 1 código no saldo, só ele; com 2 ou mais, qualquer um
  deles**. O card do pedido parcial mostra "⚠ Saldo abaixo do mínimo · faltam R$ X" com quanto de
  cada item completa (`renderAvisoSaldoMinimo`, `index.html`), cruzado com a planilha de itens em
  falta (Previsão de estoque, `PREVISAO_MAP`): item sem previsão de chegada fica fora da sugestão
  (aumentar não evita o corte) e cada item do saldo leva o selo "chega DD/MM"/"sem previsão". O
  mínimo vem da API pela UF da ficha de CNPJ (`routes/lib/saldoMinimo.js`; sem ficha = R$ 300).
  **Prazo: 90 dias** (usuário) — o saldo é cancelado quando o pedido passa de 90 dias, contados da
  implantação (`prazoSaldoCarteira`): o cabeçalho "Não faturado" mostra "até DD/MM" (com os dias
  quando faltam 15 ou menos) e, passado o prazo, avisa que já deve ter sido cancelado no lugar da
  sugestão. Saldo abaixo do mínimo pode ser cortado antes: no e-mail de 29/09/2026 havia pedido de
  18/09 cancelado por "Abaixo R$300,00".

- **Aviso de cancelamento do saldo pelo e-mail** (10/2026): o "Cancelamento saldo em carteira DD.MM.AAAA"
  vem das assistentes comerciais (thamiris.sabino@, paloma.mantovani@ e, uma vez, atendimento01@cortag.com —
  lista em `REMETENTE_DO_TIPO.cancelamento`, `routes/lib/emailCortag.js`, e em `CONFIG.mensagens` do script),
  com uma **tabela HTML** no corpo (Cod. Cliente, Nr. Pedido, Item, Descrição, O.C., Motivo, Qt./Vl. Pendente;
  o texto puro do Gmail junta as células, por isso o script manda o HTML, enxuto antes do corte de 300 mil
  letras). Correção do usuário: **é o aviso final antes do corte, uma chance de vender mais** — o vendedor
  responde "alterar para N unidades" (copiando o atendimento01, que reabre o pedido). Decisões: **selo no
  pedido + faixa no card do cliente + push**. Tabela `avisos_cancelamento_saldo` (um por item; aviso mais
  velho não passa por cima); vale **15 dias** ou até o item sair faturado **depois** do dia do aviso
  (`sqlAvisoCancelamentoAtivo`, `routes/lib/cancelamentoSaldo.js`). Selo (`renderSeloCancelamento`,
  `index.html`): com motivo "Abaixo R$ X" (o mínimo vem do próprio motivo), quanto falta e a quantidade que
  completa, no múltiplo da embalagem (1 código: só ele; 2+: qualquer um; sem previsão de chegada fica fora),
  e **"✉ Pedir aumento por e-mail"** (mailto pra assistente, cc atendimento01, assunto "Re: Cancelamento…",
  a sugestão de menor acréscimo no formato que o vendedor já usava). Outros motivos ("Sem previsão", 90 dias,
  à vista): só lista, "aumentar não evita". Faixa laranja no Pedido/Levantamento pelo `/sync` (`cancelamentos`),
  tocar abre os pedidos do cliente. Um push por e-mail ("Saldo de N pedidos vai ser cancelado"); o mesmo
  aviso reenviado (já veio 3 vezes em 1 min) não avisa de novo; respostas (RES:/Re:/Fwd:) ficam de fora.
  **O script do Gmail precisa ser colado de novo** no Apps Script. O 1º aviso real (13/10/2026) chegou 30 s depois do
  merge, o servidor ainda velho respondeu "E-mail não reconhecido" (422) e o script marcou "Falhou" pra sempre (gravado
  via SQL a partir do e-mail): agora e-mail não reconhecido em `/mensagem` responde **503** e o script tenta de novo por ~1 h.
  - **Bloco "⚠ Saldo a cancelar"** no topo de "Pra cuidar" da aba Clientes (`renderCancelamentos`, `index.html`):
    todos os avisos ainda valendo, um por pedido, montados da cópia local do `/sync` (sem rota própria, funciona
    sem internet). Decisões do usuário: primeiro "Dá pra salvar aumentando" (quem falta menos primeiro), depois,
    apagados, "Aumentar não resolve" (também aparecem); botões Abrir cliente (pedidos dele), ✉ Pedir aumento
    (o mesmo e-mail do selo) e **WhatsApp** (só com WhatsApp do comprador; texto com o saldo e as opções de
    aumento). Tocar no WhatsApp **marca** o pedido; o ✉ só marca depois de o vendedor responder "Enviei" à pergunta que
    aparece ao voltar pro app (decisão do usuário: o mailto não diz se o e-mail saiu, `perguntarSeEnviouEmail`) ("✉ aumento pedido em DD/MM · 💬 cliente avisado em
    DD/MM", também no selo) e ele vai pro fim da seção, sem sair da lista; a marca fica no aparelho
    (`cortagCancelamentoMarcas_v1`, por pedido + data do aviso). Quem está no bloco sai de "Visitas × compras".

- **Reabrir pedido salvo pra alterar** (10/2026): o cliente pedia pra mudar quantidade ou incluir
  produto num pedido já fechado e o vendedor fechava outro (vários pedidos do mesmo cliente, mais um
  CSV). Agora o pedido reabre no orçamento e "Finalizar pedido" vira **"Atualizar pedido"**, que troca
  os itens do **mesmo** pedido (`PATCH /api/pedidos/:id`, `routes/pedidos.js`; mantém id, cliente e
  `data_pedido`, marca `atualizado_em`; só autor/admin, só `origem = 'app'`). Três portas: botão
  **🧾 Pedidos** no card do cliente (aba Pedido), link "Abrir pedido salvo ou arquivo CSV" no
  orçamento e **abrir o arquivo CSV** do pedido — o app acha de qual pedido ele é pelos mesmos
  produtos/quantidades, pelo nome do arquivo (`Pedido-NomeDDMMAA-HHMMSS.csv` da cópia do Drive, ±10
  min; `NomeDDMMAA.csv` do Compartilhar, único do dia) ou, se ele foi mexido fora do app, pergunta
  quando metade ou mais dos produtos bate; sem pedido correspondente, os itens entram como pedido
  novo. Pedido **recém-finalizado já fica aberto** pra edição (finalizar de novo não duplica) — **também o
  feito sem internet** (10/2026, relato do usuário: duplicava): ainda sem número, ele fica aberto pelo
  `id_envio` e "Atualizar pedido" manda o mesmo `id_envio` com os itens novos (o servidor troca os itens do
  mesmo pedido); a versão anterior ainda na fila sai dela (vale também pro PATCH); quando a fila envia, o
  pedido aberto ganha o número. O pedido ainda na fila aparece na lista 🧾 Pedidos ("ainda não enviado") e é
  reconhecido ao abrir o CSV dele (`pedidosPendentesDaFila`), mesmo depois de "Pedido novo"; a alteração
  de pedido já numerado ainda na fila aparece por cima dele ("alteração ainda não enviada",
  `todosPedidosSalvos`), e o que a fila envia entra na lista do aparelho na hora
  (`registrarEnvioNaListaDePedidos`); alteração descartada por ser mais velha avisa na fila. A versão
  anterior só sai da fila depois que a nova é aceita ou entra nela. `pedidos.versao_app` (hora do toque já
  no relógio do servidor, `horaDoPedidoDoApp` — não o relógio do aparelho) impede que uma versão mais velha
  chegando atrasada (outro aparelho, envio em andamento) apague a mais nova; o app avisa quando a alteração
  não foi aplicada por isso (`versao_antiga`). Os **itens são comparados antes da versão**
  (`compararComGravado`): a versão carrega a demora daquele envio, e o reenvio da mesma versão que chegava
  mais rápido que o 1º voltava como "versão antiga" (aviso falso, lista do aparelho com os itens de antes);
  mesmos itens e mesmo contexto = sucesso sem regravar (só o prazo/canal mudou = grava), e a versão gravada
  só sobe. Versão com hora mandada mas não confiável (relógio do aparelho mudou no meio, mais de 30 dias na
  fila) não passa por cima de uma gravada; app antigo, sem hora nenhuma, aplica como antes. O pedido gravado cuja
  resposta se perdeu (POST ainda na fila) aparece na lista junto do pedido do servidor pelo `id_envio`
  (`GET /salvos` devolve), com a versão da fila por cima, e alterar ele tira esse POST da fila. Envios com o mesmo `id_envio` passam um de cada vez
  (`pg_advisory_xact_lock`);
  limpar o orçamento, trocar/limpar o cliente ou "Pedido novo" desligam. O pedido grava o
  `contexto` do orçamento (estado, canal, classificatório, prazo, descontos e preço editado por
  item) pra reabrir com os mesmos preços — os gravados antes disso reabrem pela tabela atual. Lista
  (`GET /api/pedidos/salvos`, 120 dias, só os do vendedor) guardada no aparelho
  (`cortagPedidosSalvos_v1`) e alteração pela fila offline: funciona sem internet na loja. Estado
  da edição em `cortagPedidoEditando_v1`. A cópia CSV no Drive da alteração sai com `-alterado`
  no nome.

- **Nome do arquivo CSV escolhido por cliente** (10/2026): o CSV usava só a 1ª palavra do cliente e
  "DEPOSITO", "COMERCIAL", "CASA"… são comuns no ramo — vários clientes viravam `Deposito260926.csv`.
  A janela "Salvar orçamento em CSV" agora edita o **nome do arquivo** (texto livre vira
  `DepositoSaoJose`, só letras e números, com prévia do nome final), com sugestões tiradas do nome do
  cliente (`sugestoesNomeArquivo`: 1ª palavra, até a 2ª palavra de verdade, nome inteiro, 1ª + última,
  1ª + código do ERP) e **"Usar sempre esse nome pra este cliente"** (marcado). O nome fica **no
  servidor** (`clientes.nome_arquivo`/`nome_arquivo_em`, `PUT /api/clientes/:id/nome-arquivo`, qualquer
  usuário logado; vazio = 1ª palavra) e vem no `/api/clientes/sync`, então vale em todos os aparelhos e
  sem internet. Troca feita offline vai pela fila e fica pendente no aparelho
  (`cortagNomeArquivoCliente_v1`, `{nome, em}`) até o servidor confirmar; vale a mais nova entre ela e
  a do servidor. O nome vale também pra cópia do pedido no Drive e é reconhecido ao abrir o CSV de
  volta (`pedidoPeloNomeDoArquivo`).

- **WhatsApp do comprador** (10/2026, 1º passo das ideias de WhatsApp — cards de promoção e combos ficaram
  pra depois): linha no card do cliente (Pedido e Levantamento) "＋ WhatsApp do comprador" abre uma janela pra
  digitar/colar o número ou **escolher dos contatos do celular** (Contact Picker, `navigator.contacts.select` —
  só Chrome do Android; no iPhone o navegador não tem, a janela explica copiar/colar). Contatos do Google pela
  API People foram descartados: escopo sensível (verificação do Google, tela de "app não verificado") e no
  Android os contatos do Google já aparecem no seletor. O telefone da ficha de CNPJ entra só como sugestão
  (costuma ser fixo/contador). Grava em `clientes.whatsapp_comprador` (55+DDD+número)/`_nome`/`_em`
  (`PUT /api/clientes/:id/whatsapp`, qualquer usuário logado), vem no `/sync` junto com `telefone_ficha` e
  segue o padrão do nome do arquivo (pendência em `cortagWhatsComprador_v1`, fila offline, vale a mais nova).
  Com número, **"Texto" do compartilhar do orçamento abre direto a conversa** (`wa.me/<num>?text=`), com
  "mandar pra outro contato" na folha; sem internet (`navigator.onLine`) cai no compartilhar normal (o wa.me no
  iPhone abre uma página antes do app). **Imagem/PDF/CSV não dá pra mandar direto**: o navegador só compartilha
  arquivo pelo compartilhar do celular, que sempre pede o contato — o wa.me só leva texto.

- **CSV vai direto pro WhatsApp** (10/2026): relato de vendedor — o CSV "só salvava no aparelho" e depois
  ele tinha que procurar o arquivo pra mandar. Causas: com Google Drive conectado o CSV ia só pro Drive, sem
  oferecer o compartilhar; se o Drive falhava (loja sem internet), o compartilhar saía tarde demais (o
  navegador só deixa compartilhar logo depois de um toque) e o arquivo baixava sem aviso; fechar a janela
  de compartilhar também baixava. Agora todo CSV (orçamento, levantamento, pedidos do período) abre a
  janela `abrirEnvioCsv` (`index.html`): **"Enviar no WhatsApp / Compartilhar"** (principal, o `share` sai
  direto do toque no botão) ou **"Salvar no aparelho"** (escolhe a pasta onde o navegador deixa); a cópia
  do Drive vai em segundo plano e o resultado aparece na própria janela. Fechar o compartilhar volta pra
  janela, sem baixar. Navegador sem compartilhar de arquivo: só "Salvar", com a dica de anexar pelo
  WhatsApp (📎 › Documento). Pedido do usuário junto: **"Finalizar/Atualizar pedido" abre a mesma janela**
  ("Enviar o CSV do pedido agora?", "Agora não" fecha) no lugar do toast, com o mesmo arquivo/nome da
  cópia do Drive (`Pedido-NomeDDMMAA-HHMMSS.csv`, reconhecido ao abrir o CSV de volta).

- **Recompra da semana** (10/2026): o cliente tem um ritmo de compra e o vendedor quer oferecer na
  hora certa. Bloco recolhível no **topo da aba Clientes** com quem está **atrasado** (passou da data
  prevista; "fora do ritmo" quando o atraso passa de 1,5x o ritmo) ou com compra prevista nos
  **próximos 7 dias** (`GET /api/recompra`, `routes/recompra.js`; cálculo puro em
  `routes/lib/ritmoCompra.js`). Decisões do usuário (entrevista): ritmo do **cliente** (data) **e** de
  cada **produto** (o que entra na proposta); **12 meses**, mínimo **3 compras** (menos que isso fica fora);
  ritmo = **mediana** dos intervalos; **por CNPJ** (filiais não se somam); **"Montar proposta"** troca o
  orçamento pelos produtos que vencem até a compra prevista (+7 dias), na **mediana das 3 últimas
  compras** (arredondada pra cima no múltiplo da embalagem) — sem nenhum, os que vieram em 2 das 3
  últimas compras; sai da lista quando **compra** ou com **"Já falei"** (7 dias, no servidor em
  `recompra_adiamentos`, pela fila offline sem internet). Escolhas técnicas: compra = **entrada do
  pedido** (implantação, carteira + faturado, sem série de 7 dígitos) + app sem contar em dobro;
  pedido a menos de 7 dias do anterior entra na mesma compra, que dura no máximo 14 dias (sem o teto, quem compra toda semana virava uma compra no ano; contando só do 1º pedido, o complemento 8 dias depois partia a compra do cliente mensal — achados do `revisor-cortag`); a previsão conta do 1º pedido da última compra (mesma régua do ritmo), no mínimo 8 dias depois do último pedido (quem acabou de pedir sai da lista, mesmo com o pedido emendado na compra anterior; contar do último pedido empurrava a previsão de todo cliente com complemento), e a "última compra" mostrada é o último pedido dela; a quantidade proposta é a mediana do que veio em cada compra do cliente (a compra do produto, juntada à parte, pode atravessar duas dele). Lista guardada no aparelho (`cortagRecompra_v1`) e
  refeita pela data de hoje sem internet. Em 04/10/2026: 163 clientes com ritmo, ~54 na lista. A
  lista depende de importar o relatório em dia (pedido ainda não importado parece atraso) — por isso
  o bloco mostra "pedidos do ERP até DD/MM". É a primeira peça do painel de "oportunidades do dia".

- **Avisos de importação no celular** (10/2026): quando um relatório ou tabela é importado, todos os
  usuários ficam sabendo. Decisões do usuário (entrevista): **push no celular + aviso no app**; avisam
  **relatório oficial, catálogo de preços, previsão de estoque, Classificatório e objetivos
  trimestrais** (não a sincronização automática de produtos); mensagem **curta, só o que foi
  importado** ("Relatório oficial atualizado · Pedidos até 03/10"); **todos recebem, inclusive quem
  importou**; tocar no push abre a **lista de novidades**; reimportação do mesmo tipo em **até 30 min
  substitui** o aviso (mesma linha em `novidades`, mesma `tag` no celular, sem tocar de novo); push só
  em **dias úteis, 7h–20h** de Brasília (fora disso, sai no próximo dia útil às 7h; feriado não conta);
  no app, **faixa abaixo das abas** "🔔 N novidades · Relatório, Preços" só quando há não lidas
  (vistas por usuário, `usuarios.novidades_vistas_ate`, valem em todos os aparelhos). Equipe usa
  Android e iPhone: no iPhone o push só funciona com o app na Tela de Início (iOS 16.4+) — o app mostra
  o passo a passo no lugar do botão. "Ativar avisos no celular" fica na lista e no Painel (⚙), com
  "Enviar teste"; sair do app cancela o push do aparelho. Código: `routes/lib/novidades.js` (janela de
  horário, envio, `avisarImportacao` chamado no fim de cada importação — nunca derruba a importação),
  `routes/novidades.js`, handlers `push`/`notificationclick` no `sw.js`, tabelas `novidades` e
  `push_inscricoes`. O servidor só faz POST pra endpoints dos serviços de push dos navegadores
  (`HOSTS_PUSH`). Chave VAPID cadastrada no Render em 04/10/2026 (`VAPID_*`, assunto =
  URL do Render); trocar a chave obriga todo mundo a ativar de novo. Plano free do Render dorme: o push
  agendado pras 7h sai quando o servidor acordar.

- **Importação automática dos relatórios pelo Gmail** (10/2026): os relatórios chegam por e-mail no
  **russo2055@gmail.com** e eram baixados e importados à mão no Painel. Agora um **script do Google
  (Apps Script) na própria conta** (`scripts/gmail-importacao/Codigo.gs`, instalação em
  `docs/IMPORTACAO-EMAIL.md`) olha o e-mail **a cada 15 min** e manda só os anexos conhecidos pro
  servidor (`POST /api/importacao-email/arquivo`, chave `IMPORTACAO_EMAIL_CHAVE` no cabeçalho, conferida
  antes de ler o corpo) — o servidor nunca recebe acesso à caixa. Descartados: webhook do Gmail via
  Pub/Sub (autorização de leitura de e-mail expira em 7 dias numa conta @gmail.com sem auditoria paga
  do Google), IMAP com senha de app (caixa inteira no Render) e serviço de e-mail de entrada (relatório
  passando por terceiro). **Só e-mail autenticado** (10/2026, achado do `revisor-cortag`: o "De:"
  se falsificava pelo nome de exibição e o repositório é público): o script compara o endereço
  exato e exige `dmarc=pass`/`dkim=pass` do domínio no `Authentication-Results` do Gmail (senão
  marca "Cortag/Nao autenticado"); o servidor confere o remetente de cada tipo
  (`REMETENTE_DO_TIPO`, `routes/lib/emailCortag.js`). Anexos (conferidos no Gmail em 04/10/2026): de **noreply@cortag.com.br**,
  Carteira/Faturamento `Repres-*.xlsx` **todo dia ~3h** (inclusive fim de semana), Classificatório
  `DD.MM.AAAA_..._Classificatorio.xlsx` e itens em falta `ESCE007-*.xlsx` (= previsão de estoque); de
  **vendas@cortag.com**, `... LISTA PADRÃO ... SUL SUDESTE ... .xlsx` (outras planilhas da vendas@ —
  Black Friday, Trade News — ficam de fora). Objetivos trimestrais não chegam por e-mail (continuam no
  Painel). Decisões do usuário: **publica direto**, inclusive preços; arquivo recusado **só ganha o
  marcador "Cortag/Falhou"** no Gmail (sem aviso no app); o relatório diário gera **push todo dia útil
  às 7h** (os do fim de semana não se acumulam: novidade nova do mesmo tipo tira da fila o push
  pendente). O script importa **do mais antigo pro mais novo** (errata da Lista de Preços não é
  sobrescrita pela anterior) e guarda os IDs de mensagem já tratados; o servidor ignora arquivo
  repetido pelo hash (`importacoes_email`, que também alimenta a linha "Importação por e-mail" do
  status do Painel). Pra isso a **leitura das planilhas saiu do `index.html` pro `importadores.js`**
  (raiz, carregado por `<script src>` e por `require`) e as rotas de importação viraram funções
  reaproveitáveis (`importarRelatorioOficial`, `importarCatalogoPrecos`, `importarPrevisaoEstoque`,
  `importarClassificatorioErp`, que devolvem `{ status, json }`) — **mudança na leitura de planilha é
  feita só no `importadores.js`**, vale pros dois caminhos. Chave cadastrada no Render em 04/10/2026. Na 1ª execução
  (04/10/2026, 7 dias de atraso) cada relatório levou ~1 min e o Classificatório ~2,5 min no servidor
  (as importações fazem uma consulta por cliente, e o Render fica em Oregon e o Supabase em São Paulo)
  e o Google cortou a execução nos 6 min — por isso o script salva o progresso a cada e-mail e não
  começa arquivo novo depois de 3 min. **Importações em lote (10/2026):** o relatório oficial (863 → 16
  consultas pra 250 clientes), a planilha Classificatório (734 → 11), objetivos trimestrais e a Curva ABC
  carregam os clientes/matrizes numa consulta (nome normalizado no próprio Postgres, mesma expressão do
  `clientMatcher`), refazem as decisões em memória na ordem do arquivo e gravam com `UNNEST` — uma rodada
  por vez que o mesmo cliente aparece. Conferido contra o código antigo num Postgres local: estado
  idêntico (só o desempate entre clientes com o mesmo nome, antes ao acaso do `LIMIT 1`, agora é o de
  menor id). **Lista de Preços pelo e-mail** que tiraria mais de 5% dos códigos do catálogo é recusada
  ("Cortag/Falhou"); pelo Painel continua sem trava. **Relatório oficial mais antigo que o já importado**
  (`configuracoes.relatorio_oficial_mais_novo` = maior implantação/faturamento das linhas de pedido, até
  hoje; os pendentes à vista não contam) grava só as linhas faturadas e as descrições e apaga o saldo do
  que aparece faturado: não grava carteira nem troca as listas à vista e não gera novidade; a resposta
  traz `relatorioAntigo`/`aviso`. Planilha só com as abas de pagamento nunca é "antiga".

- **Pedido bloqueado e à vista pelo e-mail** (10/2026): dois e-mails da noreply@cortag.com.br **sem
  planilha** — o script do Gmail manda assunto + texto (`POST /api/importacao-email/mensagem`, mesma
  chave; leitura em `routes/lib/emailCortag.js`, conferida nos e-mails reais de 09/2026). Decisões do
  usuário (entrevista):
  - **Pedido Bloqueado** ("Pedido 00677375 foi bloqueado… Cliente: 22236 … Motivo: 02-Rejeitado/Limite
    Crédito"): **push no horário comercial + selo**. Selo "⛔ Bloqueado · Limite Crédito · desde DD/MM"
    no pedido do histórico do cliente (card próprio se o pedido ainda não veio no relatório) e faixa
    vermelha no card do cliente no Pedido e no Levantamento (vem no `/api/clientes/sync`, funciona
    offline). **Some quando o pedido aparece faturado** no relatório; sem isso, em 30 dias
    (`sqlBloqueioAtivo`, `routes/lib/pedidosBloqueados.js`). Tabela `pedidos_bloqueados`.
  - **Pedido de Venda à Vista** ("Boa tarde, CLIENTE, segue anexo pedido de venda No.00677304 Valor R$
    2.410,03, aguardando O pagamento…"): **selo + push**. Entra em `pedidos_pendentes_pagamento` (o
    mesmo selo "À vista · aguardando pagamento" da aba do relatório) no mesmo dia; o relatório da
    madrugada continua sendo a foto oficial (sumiu da aba = pago), e e-mail mais velho que o último
    relatório importado é ignorado. Cliente pelo pedido no relatório ou pelo nome (`acharClientePorNome`).
  - Cada pedido é um aviso próprio (`porPedido` em `routes/lib/novidades.js`: não junta nem substitui o
    anterior do mesmo tipo). E-mail com mais de 2 dias grava o selo sem push (1ª rodada do script).

- **Botão "Waze" no card do cliente** (10/2026, pedido do usuário): no Pedido e no Levantamento, entre
  Ficha e Pedidos, abre a rota até a loja (`abrirWazeCliente`, `index.html`; link `waze.com/ul`, que no
  celular abre o app). Destino: a posição gravada ao salvar o levantamento (`clientes.latitude`/
  `longitude`, exata) ou, sem ela, o endereço da ficha de CNPJ. Os dois vêm no `/api/clientes/sync`, então
  o botão funciona sem internet (o Waze é que precisa de rede pra rota). Sem ficha e sem posição, o botão
  não aparece. **A coluna `logradouro` da ficha vem sem o tipo** ("COLOMBO"); o tipo ("AVENIDA") só está
  em `dados_brutos->'endereco'->>'tipoLogradouro'` (radar-cnpj e BrasilAPI), e sem ele o Waze não acha a
  rua — o endereço montado é "AVENIDA COLOMBO, 7266, MARINGA - PR" (número "S/N"/"0" fica fora). A tela
  da Ficha cadastral ganhou "Abrir no Waze" pelo endereço. Em 10/2026: 291 clientes com ficha, 6 com GPS.

- **Clientes perto de mim + rota no Google Maps** (10/2026, itens 1 e 2 da conversa sobre "camada no
  Google Maps com os clientes"): só 6 clientes tinham GPS, então primeiro a **posição aproximada pelo
  endereço da ficha de CNPJ** — o servidor consulta sozinho o **Nominatim/OpenStreetMap** de madrugada
  (`routes/lib/geocodificacao.js`, mesmo molde do preenchimento de fichas: 01h–06h, máx. 150/noite, 1 a
  cada 2 s, User-Agent do app; `GEOCODIFICACAO_DESLIGADA=1` desliga). Escolhido no lugar do geocodificador
  do Google porque deixa guardar o resultado e usar fora de mapa do Google, sem chave nem cartão. Só
  clientes **sem GPS** com rua e município na ficha; resultado em `cliente_geocodificacao`, que guarda o
  endereço consultado (`sqlChaveEndereco`): ficha com endereço novo consulta de novo e a posição velha
  some do `/sync`. Aceita só rua ou prédio (`place_rank` ≥ 26) do mesmo município, dentro do Brasil. Cada cliente tenta até 4 buscas, parando na primeira que acha (1,1 s entre elas): como está na ficha, abreviações por extenso (`expandirAbreviacoes`: PRES, GOV., DR, PION…), sem o número e busca livre "rua, cidade, UF" — na 1ª passada (10–11/10/2026) só a 1ª existia e 64 de 296 não foram achados, quase todos por abreviação ou número. **No
  Brasil o OSM quase nunca tem o número**: a posição costuma ser um ponto da rua (`nivel = 'rua'`), que em
  avenida longa fica a quilômetros da loja — por isso aparece "aprox." e serve pra "quem está perto", não
  pra navegar. O GPS do levantamento sempre vale mais. **Posição pelo número** (10/2026, PR
  #234): quando o Nominatim só acha a rua, o servidor pede ao **Overpass** (mesma base do OSM) os outros
  endereços com número e o traçado da rua com o mesmo nome (`address.road` do Nominatim), num raio de 6 km do
  ponto da rua, e calcula onde fica o número da loja (`routes/lib/posicaoPeloNumero.js`): entre dois números
  (pelo traçado; em reta se o traçado não liga os dois) ou de um lado só (dois números a 100+ de distância dão
  a direção e os metros por número - no norte do PR quase sempre ~1 m). `nivel` **'interpolado'** (erro
  mediano ~20-30 m; o app trata como 'numero') ou **'estimado'** (mais longe dos números conhecidos, ~50-90 m;
  aproximado no app, "estimada pelo número da ficha"). Medido deixando de fora cada endereço do OSM das 103
  cidades da carteira; caso real da DEPEL (Av. Brasil, Maringá): ponto da rua a 3,6 km, calculado a 8 m. Em
  10/2026 cobria só ~27 das 234 lojas "só pela rua" (no interior a rua quase nunca tem número no OSM) - cresce
  conforme o OSM ganha endereços: 'rua'/'estimado' tentam de novo a cada 60 dias (`numero_tentado_em`);
  Overpass fora do ar não para a noite: na 1ª falha ele não é mais chamado até o dia seguinte, as lojas ficam
  com a rua e voltam; 3 noites seguidas falhando pra mesma loja = espera os 60 dias. Nova tentativa nunca troca
  a posição por nível pior (rua < estimado < interpolado < numero). Endereço com `addr:city` de outro município
  (conurbação Maringá/Sarandi/Paiçandu) fica de fora; o nome da rua vai cru (`namedetails`). Descartados antes: GeoNames (no Brasil
  só CEP por município, sem rua), BrasilAPI CEP V2 (devolveu o centro da cidade pros dois CEPs testados),
  IBGE CNAE (é tabela de atividades, sem endereço). Linha "Posição das lojas" no card de status do
  Painel (com "N pelo número"). A rota no Google Maps manda coordenada só pra loja com GPS; o resto vai pelo
  endereço por extenso. Na tela: bloco recolhível **"📍 Clientes perto de mim"** na aba Clientes, abaixo da Recompra da
  semana — distância em linha reta da posição do celular (500 m / 2 km / 10 km), cidade, "aprox.",
  última compra e selo de recompra (da lista da Recompra guardada no aparelho), Abrir cliente e Waze;
  funciona sem internet (tudo vem no `/sync`). Marcar lojas (até 10) e **"Montar rota no Google Maps"**:
  link `google.com/maps/dir/?api=1` sem `origin` (sai da posição atual), paradas na ordem do vizinho mais
  próximo + 2-opt, cada uma pelo GPS ou, sem ele, pelo **endereço por extenso** (o Google acha o número;
  a posição aproximada não). O Waze não aceita várias paradas por link. No navegador do celular sem o
  app Google Maps o link pode aceitar menos paradas.

- **"💤 Para reativar" pelo Relatório de Clientes Sem Compra** (10/2026, pedido do usuário: "tenho um arquivo de
  clientes inativos, quero buscar vendas"). O ERP manda **todo dia 2** (noreply@cortag.com.br, assunto "Relatório de
  Clientes Sem Compra"; uma vez em 07/2026 veio como "Base de Clientes x Compra", mesmo layout + 2 colunas) uma planilha
  (aba "Clientes", 3 linhas de título com "Data:"/"Periodo Analisado:", cabeçalho, linhas de total no fim — conferida
  nos arquivos reais de 02/10 e 08/07/2026) com **todo cliente do representante que comprou nos 12 meses**: código,
  CNPJ, "Meses sem Compra", "Mes Ultima Compra" (data do dia 1º, "Sep-26"), faturamento 12 meses, cidade, telefone.
  **Quem não compra há mais de 12 meses não vem**. O anexo chega com **nome cortado e sem extensão** — o script do
  Gmail reconhece pelo **assunto** (`CONFIG.porAssunto`) e manda como `ClientesSemCompra_AAAA-MM-DD.xlsx`. Leitura em
  `lerClientesSemCompra` (`importadores.js`, Painel e e-mail); gravação/lista em `routes/reativacao.js` (foto do
  último relatório em `clientes_sem_compra`; relatório mais antigo que o importado é ignorado). Em 02/10/2026: 296
  clientes, todos já no app pelo código (achado pelo CNPJ ganha o código; **não cria cliente** — sem casar por nome
  criaria duplicado, achado do `revisor-cortag`; importar pelo Painel é só admin), 88 de 3–5 meses e 53
  de 6–12 (bate com o rodapé do relatório); ~105 clientes com código fora dele = mais de 12 meses. Faixas pelas
  **cores do ERP**: 🟡 3–5, 🔴 6–12, 💤 mais de 12 (com código, fora do relatório, última compra conhecida antes do
  período — valor = o que faturou no último ano em que comprou). Meses **recontados pelo mês de hoje** (mesma conta do
  ERP: relatório de 02/10, compra em setembro = 1) e pela **compra mais nova que o app conhece** (entrada pela
  implantação sem a série de 7 dígitos + pedido do app): quem pede sai da lista na hora. Tela: bloco recolhível **"💤 Para reativar"** na aba
  Clientes, abaixo de "Perto de mim" (quem comprava mais primeiro, filtro de cidade, Abrir cliente / Ligar / **Já
  falei** 30 dias / **Não reativar** até comprar de novo — `reativacao_adiamentos`, fila offline); **faixa** "🟡 Sem
  comprar há N meses · última compra · valor" no card do cliente (Pedido/Levantamento, `clienteReativar`) e selo em
  "Perto de mim" ("💤 N sem comprar há 3+ meses" no resumo). Lista guardada no aparelho (`cortagReativar_v1`). Aviso:
  uma novidade/push por relatório ("N para reativar"), nenhum por cliente. **O script do Gmail precisa ser colado de
  novo no Apps Script** pra pegar esse e-mail.

- **"💰 Inadimplência" pelo Relatório de Inadimplência** (10/2026, pedido do usuário logo depois do "Para
  reativar"). E-mail da noreply@cortag.com.br "Previa Relatório de Inadimplência Período DD/MM/AAAA a DD/MM/AAAA",
  **sem dia fixo** (2–4 vezes por mês, às vezes repetido em minutos; o início do período varia — 01/01/2024, 2025,
  2026, até 1900), anexo **sempre `20.xlsx`** (código do representante) — o script do Gmail reconhece pelo **assunto**
  (`CONFIG.porAssunto`) e manda como `Inadimplencia_AAAA-MM-DD.xlsx`. Planilha (aba "Resumo", conferida no relatório
  real de 31/08/2026: 42 títulos, 16 clientes, R$ 58.071,79 = linha "Total:"): "Periodo:" no topo, cabeçalho na
  10ª linha (Título, Parc, Cliente = "22691 NOME", UF, Cidade, Dt Emissão, Vencimento, **Saldo Título** = o que falta
  pagar, Vl Líquido, comissão + 2 colunas sem título: uma data interna e **"COBR.TERCZ"** = em cobrança
  terceirizada). Leitura em `lerInadimplencia` (`importadores.js`); gravação/lista em `routes/inadimplencia.js`:
  **foto do último relatório** em `titulos_inadimplentes` (sumiu = pago), período mais antigo que o importado é
  ignorado, relatório sem títulos = ninguém em atraso; cliente só pelo código do ERP (não traz CNPJ; fora do app
  aparece pelo nome). Importar pelo Painel é só admin. Decisões (propostas ao usuário, sem objeção): **só alerta,
  não trava pedido** (quem bloqueia é o financeiro); faixa vermelha no card do cliente (Pedido/Levantamento,
  `clienteInadimplente`) "💰 R$ X em atraso · venceu DD/MM (N dias) · cobrança terceirizada"; bloco recolhível
  **"💰 Inadimplência"** na aba Clientes (acima de "Para reativar"), maior valor primeiro, com os títulos; um push por
  relatório ("N clientes · R$ X em atraso"). A tela **sempre mostra "posição de DD/MM"** (fim do período) e, depois
  de 15 dias, "pode já ter sido pago" — o relatório não chega em dia fixo. Lista guardada no aparelho
  (`cortagInadimplencia_v1`).

- **Aba Clientes redesenhada** (10/2026, opção "A" escolhida pelo usuário a partir de mockups): **busca no topo**;
  abaixo dela "Recentes" (últimos 8 clientes abertos neste aparelho, `cortagClientesRecentes_v1`) e "Oportunidades de
  hoje" (`#clientesPainel`, some com cliente aberto ou texto na busca — o resultado fica logo abaixo dela). Os blocos
  Recompra, Inadimplência, Para reativar, **Classificatório** (era o link vermelho "Ver alertas de classificatório";
  agora mostra o número sem abrir, cópia em `cortagClassifAlertas_v1`) e Perto de mim usam o mesmo cabeçalho
  (`cabecalhoBloco`: ícone de traço, número em destaque, seta) com a cor de gravidade na borda (`data-cor`) e
  **um aberto por vez** (`alternarBlocoCliente`). Inadimplência com relatório de mais de 15 dias fica cinza e vai pro
  fim. Perto de mim sem localização mostra "Permitir"/"Tentar de novo" e o passo a passo Android/iPhone.

- **"Abrir levantamento" em qualquer aparelho** (10/2026, pedido do usuário: o levantamento ia pro banco mas só
  abria no celular que salvou). A janela junta a cópia do aparelho com os levantamentos da **equipe inteira dos
  últimos 30 dias** (decisões do usuário; `GET /api/levantamentos/recentes`, `routes/levantamentos.js`), com busca
  por cliente ou vendedor (sem acento, palavras em qualquer ordem) e "N de M". Tocar num que só está no servidor
  baixa os itens e guarda a cópia no aparelho; a lista fica em `cortagLevantamentosEquipe_v1` pra aparecer sem
  internet (abrir um do servidor precisa de rede). Salvar de novo grava outro levantamento (o POST nunca atualiza):
  a rota devolve só o último do mesmo cliente + vendedor + dia de Brasília. Sem repetir na janela: pelo `serverId`
  da cópia ou pelo `id_envio` (salvo sem internet). O POST passou a gravar a **quantidade de pedido** do item
  (`levantamento_itens.quantidade_pedido`, que existia e ficava 0): os salvos antes disso abrem em outro aparelho
  com o pedido zerado.

- **Foto do produto e card de oferta** (10/2026, 1ª parte do pedido "cards do produto com foto e preço
  promocional pra compartilhar"; mockups escolhidos pelo usuário). Decisões: foto **pelo Painel e pelo
  vendedor**, **qualquer vendedor** cadastra, card com **de/por**, **logo e contato** do vendedor; card
  **escuro quando a campanha tem "BLACK FRIDAY" no nome**, claro nas outras; telefone que cada vendedor
  preenche uma vez (fica no aparelho, `cortagVendedorTelefone_v1`). Fotos em `produto_fotos` (JPEG reduzido
  no celular, até 600 KB; `routes/produtoFotos.js`): a imagem só sai com login, o app guarda no Cache Storage
  (`cortag-fotos-v1`, que o `sw.js` não apaga) e baixa em segundo plano as dos produtos em campanha — ficha e
  card funcionam sem internet; salvar foto precisa de internet. "Usar nas variações" (mesmo `grupoDoProduto`)
  copia só pra quem ainda não tem foto (o catálogo antigo de fotos saiu por foto trocada entre produtos).
  Na ficha do produto (aba Produtos): foto, preço de/por no contexto da aba Pedido, "Enviar card",
  "+ Orçamento". O de/por vem de `ofertaDoProduto` (mesmo motor do orçamento: `clientPrice` + `avaliarCampanhas`
  + `bonusDaCampanhaNoItem`, na menor quantidade que já ganha desconto); campanha de cesta/"pedido todo" fica de
  fora e teto do pedido/% de lançamentos viram condição escrita. Preço Fixo segue `isPrecoFixoParaCanal` (só
  regra `soNoPrecoFixo` vale nele). Imagem 1080×1080 por html2canvas, pronta antes do "Enviar" (o compartilhar
  só aceita arquivo logo depois do toque).
  - **Início da aba Produtos** (PR 2): com a busca vazia, as **campanhas ativas** no canal/estado/data do contexto
    (`campanhasDaAba`; o classificatório não filtra a lista, cada produto mostra o preço do contexto; cesta e
    "pedido todo" ficam fora) e os **produtos recentes** (`cortagProdutosRecentes_v1`). Tocar abre a campanha:
    grade com foto e de/por; marcar até 6 → **card** (1) ou **encarte** (2–6, título "BLACK FRIDAY" escuro ou
    "OFERTAS", mesmo rodapé de contato).
  - **Campanhas agrupadas** (10/2026, opção "C" escolhida pelo usuário a partir de mockups): o início da aba junta
    as campanhas em cards — **Trade do mês** (a campanha mensal; agrupa pelo mês do `validoAte`, sem ele o mês de
    hoje) e um card por **campanha especial** (esporádica: Black Friday ou outra). Decisão do usuário: o Trade é
    automático; só a especial ganha o campo opcional **"Campanha especial"** na regra do Painel (`campanhaEspecial`,
    com sugestão dos nomes já usados) — pelo nome não dá pra separar ("VIDRO 62796 - Master" × "BLACK FRIDAY -
    Cortadores"). Regra antiga com "BLACK FRIDAY" no nome entra no grupo Black Friday sem o campo
    (`campanhaEspecialDaRegra`). Tocar no card abre a grade 2 colunas das campanhas (foto, % e o nome sem o
    prefixo do grupo), um grupo aberto por vez (um grupo só já vem aberto); tocar na campanha abre a grade de
    produtos de antes. Card escuro só no grupo com "Black Friday" no nome (e o card/encarte de oferta também).
  - **"Já compraram" com WhatsApp**: comprador com WhatsApp do comprador cadastrado ganha "mandar oferta", que
    abre a conversa (`wa.me`) com o texto da oferta no **preço DELE** (`comContextoDoCliente`: canal/
    classificatório pela política, ou o padrão do canal sem classificatório, e UF da ficha de CNPJ; sem prazo,
    desconto ou preço editado do orçamento aberto). O `/api/clientes/sync` passou a mandar `classificatorio_tipo`
    pra isso funcionar sem internet. Imagem não vai direto pra um contato (limite do navegador): pra mandar o
    card, "Enviar card" e escolher o contato no compartilhar.
  - **Card da Black Friday e status do WhatsApp** (10/2026, opções "B" e "E" escolhidas pelo usuário entre 5
    mockups): produto com oferta de campanha **Black Friday** sai no modelo **"Etiqueta de preço"** (`htmlDoCardBlackFriday`:
    fundo vermelho, foto num círculo branco, etiqueta preta inclinada com % e de/por); as outras ofertas continuam no
    card claro de antes. A janela do card ganhou **"Conversa | Status"** (só com 1 produto com oferta): Status gera
    **1080×1920** no modelo **"Vermelho cheio"** (`htmlDoStatusOferta`: "-N% OFF" gigante, foto em círculo, de/por),
    sem nada importante nos ~70 px de cima nem nos ~80 de baixo (o WhatsApp cobre com o nome e a caixa de resposta).
    Limites do html2canvas: **não aplica `filter`** (o logo branco sai de um canvas, `logoBrancoUrl`) nem gradiente
    listrado (fundo liso); a fonte é a do sistema em peso 900 (a Archivo Black do mockup não está no app). Nome com
    mais de 50 letras é cortado com "…" (`nomeCurtoDoCard`). O rodapé usa o nome do usuário logado, que agora se troca
    no Painel › Gerenciar usuários (lápis; `PUT /api/auth/usuarios/:id/nome`, `routes/auth.js`: admin troca o de
    qualquer um, quem não é admin só o próprio; 2 a 60 letras). O próprio nome vale na hora (`state.currentUser`/
    `state.seller`: card, PDF do orçamento e vendedor do próximo pedido/levantamento).

- **"Você está na LOJA X?" — cliente sugerido pela proximidade** (10/2026, item 1 da localização): com o
  card do cliente vazio no Pedido/Levantamento, o app pega o GPS e sugere a loja onde o vendedor está
  (`buscarClienteProximo`, `index.html`): "Selecionar" ou "Não" (esconde aquela loja por 4 h,
  `cortagProximoDispensado_v1`), e até 2 outras lojas vizinhas como alternativa. **Só pergunta, nunca
  seleciona sozinho.** Posição da loja = `posicaoDoCliente` (a mesma de "Perto de mim"): GPS do levantamento
  (raio 100 m) ou a aproximada pelo endereço (raio 250 m, "pelo endereço da ficha" — em 10/2026 eram 10 lojas
  com GPS/número e 236 só com a rua), mais a precisão da leitura até 100 m; leitura com precisão pior que
  200 m não sugere. **Só usa o GPS se a permissão já foi dada** (Permissions API) — abrir a aba nunca faz o
  celular pedir. Busca ao abrir o app, ao entrar na aba, ao limpar o cliente e ao voltar pro app (chegou na
  loja com ele em segundo plano); leitura vale 2 min e some depois de 10. Sem internet funciona (cópia do `/sync`).
  **De onde vem a posição, na tela** (PRs #233 e #234, relato do usuário: a DEPEL aparecia "a 260 m" estando
  longe — a posição dela era um ponto da Av. Brasil, que atravessa Maringá): `posicaoDoCliente` devolve `fonte`
  — 'gps' ("pela visita anterior"), 'numero' (nível 'numero' ou 'interpolado', "pelo endereço da ficha", raio de
  GPS), 'estimado' ("~" na distância, "estimada pelo número da ficha, pode errar umas quadras") ou 'rua' ("~" e
  "só pela rua da ficha, a loja pode ficar longe daqui"; nas outras lojas, numa 2ª linha laranja junto da
  distância, que não some em nome longo). Antes, loja achada com o número saía como "pela visita anterior".
  A posição da DEPEL (as duas, mesmo endereço) foi gravada à mão como GPS em 13/10/2026, com a coordenada que o
  usuário passou — correção de dado, sem PR.

- **Registro de visita: "Sua última visita" e "Visitas × compras"** (10/2026, item 3 da localização). Decisões
  do usuário (entrevista): **visita = levantamento salvo** (pedido e botão manual ficaram de fora), **cada
  vendedor vê só as dele**, janela de **60 dias**. Uma visita por cliente por dia de Brasília. O levantamento
  passou a gravar o **usuário logado** (`levantamentos.usuario_id`; `vendedor_id` é o nome digitado no app,
  "RUSSO"/"Russo"/"Admin", sem ligação com o login): os antigos foram ligados no `schema.sql` pelo nome do
  vendedor = nome de um único usuário (em 10/2026: 63 → RUSSO/russo2055, 3 → Admin). `GET /api/visitas`
  (`routes/visitas.js`) manda, por cliente visitado por ele ou que comprou em 12 meses, a última visita, a
  última compra (entrada do pedido pela implantação, sem a série de 7 dígitos, ou pedido do app — régua da
  Recompra) e o faturado de fato em 12 meses; as listas saem no app (`cruzarVisitasCompras`, `index.html`)
  pela data de hoje: **"Visitados e não compraram"** (visita nos últimos 60 dias e nenhuma compra no dia dela
  ou depois, a mais antiga primeiro) e **"Compram e você não visita há 60+ dias"** (quem fatura mais
  primeiro). Bloco recolhível na aba Clientes (abaixo de "Perto de mim") e linha "🚶 Sua última visita: há N
  dias" no card do cliente (Pedido/Levantamento; laranja passados 60 dias). Funciona sem internet
  (`cortagVisitas_v1`); o levantamento salvo agora, até o da fila offline, já conta
  (`cortagVisitasLocais_v1`, até o servidor devolver a mesma visita). As duas cópias saem no logout.
  Pedido do usuário (PR #231): o bloco só lista quem **não** está em Recompra, Inadimplência ou Para reativar
  (`idsNosOutrosBlocosClientes`: o que cada bloco mostra — `recompraVisiveis`, `inadDados.clientes`,
  `reativarVisiveis`, já sem "Já falei"/"Não reativar"; o filtro de cidade do Para reativar não conta) e diz
  quantos ficaram de fora ("N já nos outros blocos"); é refeito quando essas listas carregam ou mudam. A Rota
  por cidade (`cruzarVisitasCompras` inteira) e a linha "Sua última visita" do card não são filtradas.

- **"🗺 Rota por cidade"** (10/2026, item 4 da localização). Decisões do usuário: **bloco próprio** na aba Clientes
  (abaixo de "Perto de mim"), lojas **prioritárias já marcadas**, **só monta e abre** (nada guardado por dia da
  semana). Escolhe a cidade (município + UF da ficha de CNPJ, que vem no `/sync` — funciona sem internet; cliente
  sem ficha fica de fora; em 10/2026 Maringá tinha 23, Umuarama 19) e vêm marcadas até 10 prioritárias (pontos:
  recompra atrasada 3 / da semana 2, comprou no ano e sem sua visita há 60+ dias 2, para reativar 1; empate por
  faturado em 12 meses). A marcação automática vale até o vendedor mexer (as listas chegam do servidor depois da 1ª
  tela); trocar de cidade volta pra automática. "Montar rota no Google Maps" reaproveita o de "Perto de mim"
  (`ordenarParadas`, `destinoDaParada`, sai da posição atual): ordem pela posição da loja (GPS ou aproximada),
  loja sem posição no fim, cada parada pelo endereço por extenso quando não há GPS (`montarRotaCidade`, `index.html`).

- **Contatos comerciais do cliente pro Salesforce** (10/2026, opção "C" escolhida pelo usuário a partir de mockups):
  telefone comercial, e-mail comercial, e-mail NF/XML, nome completo e telefone do comprador. **Edita no card do
  cliente** (Pedido/Levantamento): a linha "WhatsApp do comprador" virou **"Contatos"** ("Contatos · Marcos · (44)
  99812-4471 · 4 de 5") e abre a mesma janela, agora com a seção Empresa (`#whatsCompradorModal`, `index.html`).
  **A Ficha cadastral só mostra e copia** (card "Contatos comerciais" no topo de `ficha-cnpj.html`, botão de copiar
  por campo e "Copiar tudo pro Salesforce" = texto com rótulos + CNPJ). O comprador **reaproveita**
  `whatsapp_comprador(_nome)` (o nome passou de 60 pra 100 letras); os outros três são `clientes.telefone_comercial`
  (55+DDD+número, fixo vale), `email_comercial` (um), `email_nfe` (até 3, "; ") e `contatos_em`
  (`PUT /api/clientes/:id/contatos`, `routes/lib/contatosCliente.js`; qualquer usuário logado; vazio apaga). Vêm no
  `/sync` (com `email_ficha` da Receita) e seguem o padrão do WhatsApp: pendência em `cortagContatosCliente_v1`, fila
  offline, vale a mais nova. Telefone/e-mail da Receita só como pílula "Receita: …" (costumam ser do contador).
  O botão "Remover" saiu: apagar o campo e salvar.

- **Revisão de UX pelas 7 leis** (10/2026, opções escolhidas pelo usuário a partir de mockups feitos com
  prints do próprio app): **abas no rodapé** com ícone e nome (`.tabbar` fixa embaixo, altura em `--navH`;
  a barra do orçamento fica acima; barras presas no topo agora em `top: 58px`); **Estado/Canal/
  Classificatório recolhidos** numa linha "PR · Varejo · Premium 17% · alterar" quando há cliente escolhido
  (`atualizarResumoContexto`, chamada no `renderCart`; abrir vale até trocar de cliente; sem cliente os
  campos ficam abertos); **cabeçalho com Dashboard, Ficha, "⋯ Atalhos" e ⚙** (Calculadora, Portal do Cliente
  e Salesforce num menu com nome, `initAtalhosCabecalho`); **levantamento não salvo à vista** fora da aba
  dele (número de itens na aba e faixa "Levantamento não salvo · Abrir", `atualizarLembreteLev`, mesma
  regra do `hasUnsavedLevantamento`); **"quanto falta" na barra do orçamento** (linha verde + "Faltam R$ X
  pro mínimo FOB/pro frete CIF", mesma régua do aviso da gaveta, e a próxima faixa de campanha
  "+2 itens diferentes = 5% em …" por `proximaFaixaCampanha` no `<motor-campanhas>`: só regra de degraus,
  com item do alvo no orçamento, faltando até metade da faixa; cesta fica de fora); **alvos de toque de
  44 px** (−/+, ✕, lápis, leitor, ícones do topo; `::after` invisível quando o desenho é menor) e **botão
  flutuante de leitura** no Levantamento (aciona o `scanBtnLev`; espaço de 84 px no fim da lista pra não
  cobrir o último item); **"Compartilhar orçamento" com contorno** (Finalizar é o único botão cheio da
  gaveta); **aba Clientes em três grupos** — Pra vender hoje (Recompra, Para reativar, Classificatório),
  Pra cuidar (Inadimplência, Visitas × compras), Pra rodar (Perto de mim, Rota por cidade); grupo sem
  bloco visível some (`:has`). Padrões novos em "Padrão visual" no README.

- **Card de status do Painel agrupado** (10/2026, opção "B" escolhida pelo usuário a partir de mockups):
  grupos Este aparelho / Servidor / Relatórios por e-mail / Clientes / Conta (mesmos ids de antes), data
  curta (`quandoCurto`: "hoje 10:55", "ontem 06:05"), cor só no que pede ação (`marcarStatus`, `data-tipo`
  ok/cinza/warn/err), "Tentar enviar agora" só com algo na fila, resumo "✓ Tudo em dia" ou "⚠ N itens pedem
  atenção". Relatórios por e-mail um por linha com o dia do último recebido; **atrasado só a Carteira e
  Faturamento, mais de 2 dias** (decisão do usuário; os outros não têm dia certo), recusado em vermelho.
  **Catálogo "1.800 × 1.793"**: o Painel comparava o cadastro `produtos` (que guarda de propósito o que saiu
  da Lista de Preços e os promocionais com pedido — em 13/10/2026: 4 colheres KAEF, P60863, P61699 e uma
  linha "Retirado") com o catálogo do aparelho, achava "desatualizado" e reenviava tudo a cada abertura.
  Agora `GET /api/produtos/contagem` devolve também `catalogo` e `fora_do_cadastro`: o card compara catálogo
  com catálogo (`produtosDoCatalogo`: sem os promocionais do Painel, marcados `_promocional` no
  `mergeProdutosPromocionais`) e o cadastro só é sincronizado quando falta nele algum código do catálogo e o
  catálogo do aparelho é igual ao do servidor (o sync manda o do aparelho). Servidor sem `catalogo` (app
  publicado antes do Render) não acusa nada.

- **"Descontinuado" na frente do produto que saiu de linha** (10/2026, pedido do usuário): a LISTA PADRÃO só
  traz produto ativo (usuário: descontinuado é avisado por e-mail, ou o código é trocado). Produto cujo código
  (ou o código base, no promocional P/P1/P2) não está mais em `catalogo_precos` sai como "Descontinuado · NOME"
  e com `descontinuado: true` onde a tela é registro do que o cliente comprou: Histórico, Rotatividade, Curva
  ABC (geral e do cliente; no rótulo curto das barras vira "† ") e card dos pedidos oficiais
  (`marcarDescontinuados`, `routes/lib/descontinuado.js`, na saída da rota, depois de agrupar). Onde a tela é
  "o que oferecer" ele **sai da lista**: Recuperar (ocupava as 30 vagas: é o de compra mais antiga), Comprados e
  não contados, itens da Recompra e a sugestão "aumente o item" do saldo abaixo do mínimo. As 💡 sugestões são
  por grupo: o grupo sai só quando **nenhum** produto do mesmo `grupoDoProduto` está na Lista de Preços (código
  trocado por um novo continua). Catálogo vazio não marca nem tira nada; catálogo em cache 5 min, limpo na
  importação da Lista de Preços (`esquecerCatalogo`, com geração pra consulta em andamento não regravar o
  velho). Rota nova que mostre produto do histórico passa pelo mesmo helper.

- **Campanha no card do item** (10/2026, opção "D" escolhida pelo usuário entre 4 mockups — selo, de/por com barrinha, faixas tocáveis, fita): no Pedido (busca e Lista de preços, `renderCard`) e no Levantamento (`renderLevList`), produto que faz parte de uma campanha ganha borda e uma **fita no topo** com o nome e o maior desconto ("até -10%", "-15% no fixo", "+1" com mais de uma); preta com amarelo na Black Friday (`ehCampanhaBlackFriday`, mesma régua do card de oferta). Tocar abre `#campanhaItemModal` (`abrirCampanhaDoItem`): faixas, se conta a família/lista inteira, se soma com os outros descontos, teto do pedido, lançamentos, classificatório, validade e, com o item no orçamento, "✓ -N% aplicado" ou o motivo de não ter valido. Quais campanhas = `campanhasDoItem` (no `<motor-campanhas>`, testado): vale no contexto do orçamento (canal, estado, classificatório, data), alvo + exclusões, Preço Fixo só com `soNoPrecoFixo`; **sem olhar a quantidade** (a fita diz "faz parte", o desconto continua saindo do `cartTotals`); "pedido todo" fica de fora (marcaria todo card). O preço do card não muda.

- **Dois aparelhos** (PR #245, 10/2026): o usuário pediu ideias de integração tablet + celular / tablet + laptop
  ("uma segunda tela? um acompanhamento?"); das sugestões, escolheu as duas abaixo a partir de mockups e pediu as duas
  num PR só. Ficaram de fora, como ideias pra depois: laptop como "mesa de planejamento" que manda rota/orçamentos
  pro celular ("continuar no outro aparelho"), **aprovação de desconto pelo gerente** ao vivo (casa com a v2 de
  gerentes regionais), cliente acompanhando o orçamento no celular dele por um QR (página só de leitura, link de
  vida curta) e tablet como catálogo/vitrine das campanhas que manda item pro orçamento do celular.
- **Tablet como tela do cliente** (10/2026, 1ª das ideias de "dois aparelhos"; mockups escolhidos pelo usuário:
  **lista completa com vitrine temporária**). O tablet abre `tela-cliente.html` (⋯ Atalhos › "Tela do cliente
  (neste tablet)"), que cria uma sala (`routes/segundaTela.js`) e mostra um QR + código de 4 dígitos; o celular entra
  por ⋯ Atalhos › "Conectar tablet" (lê o QR com o leitor do app ou digita o código; o QR é o endereço
  `index.html?parear=NNNN`, então a câmera comum também conecta). **Mesma conta Google nos dois** - o código só é
  procurado entre as salas do próprio usuário. Daí o celular manda a **foto inteira** do orçamento a cada mudança
  (`estadoParaTelaCliente`, gancho em `renderCartBar` e `setLevCliente`) e o tablet espera a próxima versão por
  long-poll (até 25 s). Vai só o que o cliente pode ver: nome, quantidade, preço com imposto, campanha (de/por),
  total, economia, "faltam R$ X pro frete CIF/pedido mínimo" e a próxima faixa de campanha - **nunca classificatório,
  canal, ficha nem histórico**. A campanha vai como "Campanha -10%", **sem o nome da regra** (ele costuma trazer o
  classificatório: "VIDRO 62796 - Master" - achado do `revisor-cortag`). O tablet fica logado na conta do vendedor e na
  mão do cliente: o menu "⋯" (que leva de volta ao app) só abre **segurando** o botão, e o "Voltar ao app" some depois
  do 1º pareamento. Toda chamada da tela tem prazo (`prazoSegundaTela`/`prazo`): com sinal fraco a conexão ficava
  pendurada e o tablet congelava com o orçamento velho. Item novo aparece ~7 s em destaque (vitrine) e volta pra lista. Faixa verde no celular
  em todas as abas com **Esconder** (o tablet mostra "Seu orçamento volta já") e **Desconectar**. Salas **só na
  memória** do servidor (deploy/reinício desconecta - o tablet mostra QR novo; com várias instâncias, na v2, teria
  de ir pro banco); nada passa pela fila offline (é só tela: sem internet o tablet fica com a última versão e o
  celular reenvia quando volta). Conexão do celular em `cortagSegundaTela_v1` (sobrevive a reabrir o app); sair do
  app desconecta. Fora desta 1ª versão (decisão do usuário): escolher o que o tablet mostra (preço unitário e
  campanha sempre aparecem, código não).
- **Celular como leitor do levantamento no tablet** (10/2026, 2ª ideia, opção **"cada leitura soma 1"** escolhida nos
  mockups). No tablet/laptop, aba Levantamento › "Usar o celular como leitor" (botão só em tela de 700 px ou mais)
  cria uma sala no modo `'leitor'` e mostra o QR; o celular conecta pelo mesmo "Conectar tablet" e abre a tela de
  leitura contínua (`#modoLeitor`): câmera sempre ligada, "+1 no estoque | +1 no pedido", "Desfazer última" e
  "Digitar quantidade" (troca o total do item no tablet). O mesmo código parado na frente da câmera só conta de novo
  depois de 1,5 s. Cada leitura é um **evento com id gerado no celular** (`POST /api/segunda-tela/salas/:id/eventos`),
  guardado em `cortagLeitorFila_v1` até o servidor confirmar: **sem internet a leitura espera e entra no tablet
  quando o sinal volta**, e o servidor ignora id repetido (resposta perdida + reenvio não soma duas vezes). O
  celular resolve o código pelo catálogo dele (DUN-14 = caixa fechada, soma a embalagem; código desconhecido nem é
  enviado) e manda o SKU; o tablet soma no levantamento aberto (`aplicarEventoLeitor`) - salvar, comprados e não
  contados etc. continuam no tablet. O tablet pede os eventos depois do último `seq` aplicado e guarda a conexão
  (`cortagLeitorTablet_v1`, com o `seq`), então recarregar não perde nem repete leitura; "Desfazer" de leitura feita
  antes de recarregar o tablet é ignorado. O servidor guarda as últimas 500 leituras por sala.

## O que já tentamos e não deu certo

- **Simplificar o PDF do orçamento removendo o detalhe de IPI/ST** (colunas e linhas de imposto
  separado) pareceu uma boa limpeza visual, mas o usuário pediu pra reverter depois de ver o
  resultado real — "ficou pior sem esse detalhe" (commit `497bbca`). Hoje o PDF não só mantém
  IPI/ST detalhados como dá destaque visual ao preço final com imposto. Vale lembrar disso antes
  de propor de novo simplificar esse PDF.
- Existem arquivos avulsos na raiz do repo que já foram tentativas/preparos que não viraram fluxo
  permanente do app — `mudancas.patch` (diff antigo não aplicado) e `produtos_sem_ean13.csv`
  (lista de SKUs sem EAN cadastrado, usada manualmente em algum momento pra backfill). Não tratar
  como documentação viva; se forem retomados, vale integrar como rotina real (ex.: relatório no
  Admin) em vez de arquivo solto.

## Caminho a seguir

- **Escala para 200+ usuários com gerentes regionais (v2)** — plano completo em
  `docs/PLANO-ESCALA-V2.md` (limitações, escolha de plataforma, fases). Decisão do usuário: a v2 é
  construída num **repositório separado** (`appdbV2`, privado, cópia deste com histórico), para não
  arriscar a versão em uso. Regras que valem daqui: correção de bug de produção é feita **aqui
  primeiro** e depois levada pra v2 (merge deste `main` lá); nada da v2 volta pra cá antes da troca;
  a v2 **nunca** usa o `DATABASE_URL` da produção (o `db.js` roda o `schema.sql` na subida).

- Padronização visual que ficou pra depois (levantada na análise de UI): **acessibilidade** (a área
  de toque de 44 px foi feita em 10/2026; faltam campos só com placeholder, sem `<label>`, e steppers
  −/+ do orçamento sem `aria-label`) e **unificar o visual das páginas
  separadas** com o `index.html` (cabeçalho, cards e botões próprios em cada uma — hoje só os
  tokens e o tema escuro foram alinhados).

- **Dois aparelhos — pendências** (PR #245): o leitor contínuo do celular (`#modoLeitor`) só foi testado com câmera
  falsa (leituras simuladas) — conferir num aparelho de verdade, principalmente no iPhone (sem BarcodeDetector, usa o
  ZXing). Na v2 (várias instâncias), as salas de `routes/segundaTela.js` têm de sair da memória (banco ou Redis). O
  cartão "próxima faixa de campanha" da tela do cliente não foi visto com campanha real.
- Ideia em aberto, ainda não implementada: um painel de "oportunidades do dia" na tela inicial
  (ex.: clientes sumidos há N dias, objetivo trimestral em risco, produtos parados na Lista de
  preços) — surgiu de "o que podemos implementar pra ajudar nas vendas" e faz sentido como
  próximo passo de produto, não só bug fix. A rota de sugestões de recompra e o `grupoDoProduto`
  já dão a base pro sinal de "produtos parados" por cliente; `comprados-recentes` (PR #129) dá o
  que ele compra com frequência, pra cruzar com o último levantamento.
- **Localização do cliente — próximos passos** (plano combinado com o usuário; a base é a
  posição gravada ao salvar o levantamento, que precisa de algumas semanas de uso pra cobrir a
  carteira). Em ordem de prioridade:
  0. Feito em 10/2026: posição aproximada pelo endereço da ficha e "Clientes perto de mim" com rota no
     Google Maps (ver acima) — cobre o item 2 abaixo, menos dias sem visita e objetivo em risco.
  1. Feito em 10/2026: **cliente sugerido pela proximidade** (ver "Você está na LOJA X?" acima).
  2. **"Clientes perto de mim"**: lista por distância (500 m / 2 km / 10 km) com dias sem visita,
     dias sem compra, 💡 sugestões de recompra e objetivo trimestral em risco — pra encaixar uma
     visita no tempo vago. Casa com o painel de "oportunidades do dia" acima.
  3. Feito em 10/2026: **registro de visita** (ver "Visitas × compras" acima).
  4. Feito em 10/2026: **rota por cidade** (ver "🗺 Rota por cidade" acima).
  5. Feito em 10/2026: **estado do preço pela UF do cliente** — selecionar o cliente põe o estado da
     ficha de CNPJ (`ufDoCliente` em `setLevCliente`, `index.html`, pela cópia do `/sync`), junto com o
     canal do classificatório, num toast só. Continua editável; sem ficha não muda; pedido salvo reaberto
     volta com o estado gravado (`aplicarContextoDoPedido` roda depois). O "usar GPS" continua. Em 10/2026:
     300 fichas no PR, 1 em SP, 1 em RO.
  - Descartado por agora: prospecção de lojas que ainda não são clientes — depende de base
    externa de empresas por região, normalmente paga ou limitada.
- **Vendedor cadastrado vê só os clientes dele — etapa futura, sem data** (pedido do usuário, 10/2026).
  Hoje todo vendedor logado vê a carteira inteira; a base de clientes compartilhada é decisão assumida.
  A ideia é o app reconhecer o vendedor e mostrar só os clientes dele. As planilhas oficiais trazem o
  vendedor como "Nome (código)" — ex.: "Sergio Luiz Russo (20)", sendo 20 o código dele no ERP — e esse
  código é o elo previsto entre `usuarios` e a carteira. Hoje o importador do relatório oficial **não lê**
  esse campo (só a planilha Classificatório lê "Gestor", que aparece no card do cliente). Em aberto, a
  decidir quando a etapa for puxada: onde guardar o código (coluna em `usuarios`), como o admin/gerente vê
  tudo, cliente sem vendedor e cliente atendido por mais de um. Ligação com a revisão de segurança de
  10/2026: hoje qualquer vendedor logado importa o relatório oficial, inclusive o classificatório do
  cliente (decisão explícita em `routes/pedidosOficiais.js`); **com o escopo por vendedor essa abertura
  passa a cruzar uma fronteira real** (um vendedor alterando cliente de outro). Junto com a etapa, entram:
  `classificacoes[].data_referencia` não pode ser futura e o tipo/desconto de classificatório tem de
  seguir a tabela de `routes/lib/politicaComercial.js` — ou o import do classificatório volta a ser só
  de admin/e-mail; e as rotas de leitura sem filtro por vendedor (`routes/relatorios.js`, `levantamentos`
  que não têm dono) precisam ganhar o filtro.
- Continuar tratando pedido de UI ("botão colado na margem", "ícone fora de centro") como sinal
  de um padrão visual quebrado, não só o pixel específico apontado — vale checar se o mesmo
  padrão (`.clientClearBtn`, `.gearBtn`, paddings de 16px) se repete em outro lugar da mesma tela
  antes de fechar o PR.
- `produtos_sem_ean13.csv` indica um backfill de EAN pendente; se o usuário pedir mais correções
  de código de barras, vale perguntar se essa lista ainda reflete o estado atual do catálogo antes
  de usá-la como referência.
- **Pendências de dado** (não é código — o usuário importa pelo Painel Administrativo):
  - **Novembro/2025 — resolvido em 27/09/2026** (era R$ 1 mil faturado; ficou R$ 434 mil). Não
    faltava: o relatório de 30/11/2025 tinha sido **aberto e salvo num Excel em inglês** e importado
    assim — data com dia ≤ 12 virou data numérica com dia/mês trocados (05/11 → 11/05, espalhando
    novembro por mai/jun/jul/out/dez), dia > 12 virou texto "13/11/25" (gravado sem data), valor com
    vírgula virou texto (gravado vazio) ou número 1.000–10.000× maior, e a aba Carteira trouxe
    `Nr.Pedido` com zeros à esquerda ("00605401", 25 linhas fantasma em carteira). Corrigido via SQL
    a partir do próprio arquivo: datas de 1.380 linhas, 344 valores em texto, 25 fantasmas apagadas e
    639 valores ×10 (os que ficavam exatamente 10× abaixo do preço mediano do produto — todos caíam a
    ±20% do normal depois do ×10). Backup das 1.790 linhas antes da correção na tabela
    `backup_pedidos_oficiais_nov2025_20260927` (pode ser apagada quando ninguém mais precisar).
    A importação agora conserta data de planilha assim e **recusa** a que tem valor corrompido
    (ver `paraDataISO`/`lerAbaRelatorioOficial` em `index.html`).
  - Pedido de carteira cancelado no ERP ficava como "carteira" até a limpeza de carteira antiga
    (Painel → Avançado). Desde 10/2026 a importação apaga o saldo do pedido que vem como "Atendido
    Total", mas as 47 linhas que já estavam assim em 02/10/2026 (pedidos que não voltam mais no
    relatório) só saem por SQL ou pela limpeza. Provável causa de a Entrada de Pedidos de set/2026
    ter ficado R$ 8,2 mil / 2 clientes acima do oficial — conferir de novo depois da limpeza.
- **Outros e-mails automáticos da Cortag** (entrevista de 10/2026): **Pedido Bloqueado** e **Pedido à
  Vista** já entram (ver "Pedido bloqueado e à vista pelo e-mail" acima). **Cancelamento saldo em carteira**
  também (ver "Aviso de cancelamento do saldo" acima). **Clientes Sem Compra** já entra
  (ver "💤 Para reativar" acima). **Inadimplência** também
  (ver "💰 Inadimplência" acima). **Comissões** (PDF): fora do app, decisão
  do usuário.
- Em aberto, perguntar antes de mudar: a série de 7 dígitos ficou fora só do Dashboard; ainda soma
  no faturamento do classificatório, na Curva ABC e no top clientes (valores pequenos). Se o painel
  oficial também a exclui dali, dá pra reaproveitar o mesmo filtro (`length(nr_pedido) <= 6`).
