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
`ficha-cnpj.html`) no GitHub Pages, backend Node/Express (`server.js` + `routes/`) no Render,
Postgres no Supabase, autenticação só via Google Sign-In (sem usuário/senha). `curva-abc.html` e
`calculadora-materiais.html` são páginas separadas de propósito — usadas esporadicamente, não
valia deixar o `index.html` mais pesado por causa delas — e se comunicam com o app principal por
parâmetro de URL (`curva-abc.html?cliente=…`, `ficha-cnpj.html?cliente=…&nome=…&doc=…`) e/ou
`localStorage` compartilhado: `cortagAuthToken_v1` (sessão), `cortagCart_v1` (carrinho, lido pela
Curva ABC) e `cortagCalcHandoff_v1` (itens que a calculadora manda pro orçamento).

## Comandos

```bash
npm install
export DATABASE_URL=postgres://usuario:senha@localhost:5432/cortag   # Supabase: usar o Session pooler
npm start                    # sobe o servidor (roda schema.sql automaticamente)
node test/run_tests.js       # suite de testes (mocka o banco em test/mock-db.js) — rodar antes de qualquer mudança em routes/
```

Não há lint nem build configurados — as páginas `.html` (`index.html`, `curva-abc.html`,
`ficha-cnpj.html`, `calculadora-materiais.html`) são validadas manualmente (checagem de sintaxe
dos blocos `<script>` inline antes de commitar) por não terem bundler.

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
  menores. **O checklist dentro do próprio arquivo ficou desatualizado (ainda mostra tudo como
  `[ ]`)** — o histórico do git (`git log --oneline | grep "Segurança PR"`) é a fonte confiável do
  que já foi corrigido, não o arquivo.
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
  rota antiga `/clientes/:id/recuperar` (só pedidos do app, cruza com levantamento, sem
  agrupar), que continua existindo.
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
  faixa/meta/risco de queda); ações 💡 sugestões · 📄 Ficha · 🛒 Comprados em botões de toque
  numa linha só. Decisões: **sem avatar de iniciais** (ocupava espaço), **código do cliente no
  ERP não aparece depois de selecionado** (continua no seletor), **"Limpar" saiu do card e foi
  pra dentro do seletor** ("Limpar seleção", só aparece com cliente escolhido; no Levantamento
  também desliga o levantamento aberto, como o antigo botão fazia). Sem cliente, o card vira um
  botão tracejado "+ Selecionar cliente" (sai o rótulo "Cliente (opcional)").

- **Política Comercial rev. 06 no pedido** (etapa 1 de 2): classificatório por canal, canal
  automático pelo cliente, desconto por prazo somado, prazos por canal e pedido mínimo por região
  (detalhes em "Motor de preço" no README). Decisões do usuário: desconto de prazo **automático e
  somado** ao classificatório (não multiplicado como o "Desc. adicional"); Marmoraria/Consumidor
  final = **+30% sobre a tabela Institucional**; Rede 18% continua no Varejo; o percentual vale
  **pela política, pelo nome** (o ERP ainda manda "Varejo Exclusive (12)"/"Premium (15)" da
  política antiga — os 131 clientes com esses valores foram corrigidos direto no banco em 09/2026).
  A tabela existe em dois lugares que precisam andar juntos: `CLASSI_POR_CANAL` (`index.html`) e
  `routes/lib/politicaComercial.js`. Etapa 2 pendente: faixas de todos os canais no card do cliente
  e classificatório pelos **últimos 12 meses** (régua móvel da política) no lugar do ano fechado.

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

- Padronização visual que ficou pra depois (levantada na análise de UI): **acessibilidade e área
  de toque** (botões de 17–32px como `.fichaInfoBtn`, `.rm`, `.pencilBtn`, `.gearBtn`; campos só
  com placeholder, sem `<label>`; steppers −/+ sem `aria-label`) e **unificar o visual das páginas
  separadas** com o `index.html` (cabeçalho, cards e botões próprios em cada uma — hoje só os
  tokens e o tema escuro foram alinhados).

- Ideia em aberto, ainda não implementada: um painel de "oportunidades do dia" na tela inicial
  (ex.: clientes sumidos há N dias, objetivo trimestral em risco, produtos parados na Lista de
  preços) — surgiu de "o que podemos implementar pra ajudar nas vendas" e faz sentido como
  próximo passo de produto, não só bug fix. A rota de sugestões de recompra e o `grupoDoProduto`
  já dão a base pro sinal de "produtos parados" por cliente.
- **Localização do cliente — próximos passos** (plano combinado com o usuário; a base é a
  posição gravada ao salvar o levantamento, que precisa de algumas semanas de uso pra cobrir a
  carteira). Em ordem de prioridade:
  1. **Cliente sugerido pela proximidade**: ao abrir Levantamento/Pedido dentro da loja, "Você
     está na LOJA X? Selecionar" — tira o passo de buscar o cliente toda visita.
  2. **"Clientes perto de mim"**: lista por distância (500 m / 2 km / 10 km) com dias sem visita,
     dias sem compra, 💡 sugestões de recompra e objetivo trimestral em risco — pra encaixar uma
     visita no tempo vago. Casa com o painel de "oportunidades do dia" acima.
  3. **Registro de visita** a partir de `levantamentos` (lat/lng + `data_visita`): "última visita
     há N dias" e cruzamento visita × compra (visitado que não compra / compra e não é visitado).
  4. **Rota da semana por cidade** usando o município da ficha de CNPJ (`cliente_cnpj_ficha`,
     sem GPS), com link pra abrir no Google Maps/Waze.
  5. **Estado do preço pela UF do cliente** (ficha de CNPJ) em vez do GPS do vendedor — o botão
     "usar GPS" pega a UF de onde o vendedor está, que erra quando ele atende cliente de outro
     estado.
  - Complemento: posição aproximada pelo CEP da ficha pra cliente nunca visitado (serviço
    gratuito de geocodificação), marcada como aproximada.
  - Descartado por agora: prospecção de lojas que ainda não são clientes — depende de base
    externa de empresas por região, normalmente paga ou limitada.
- Continuar tratando pedido de UI ("botão colado na margem", "ícone fora de centro") como sinal
  de um padrão visual quebrado, não só o pixel específico apontado — vale checar se o mesmo
  padrão (`.clientClearBtn`, `.gearBtn`, paddings de 16px) se repete em outro lugar da mesma tela
  antes de fechar o PR.
- `produtos_sem_ean13.csv` indica um backfill de EAN pendente; se o usuário pedir mais correções
  de código de barras, vale perguntar se essa lista ainda reflete o estado atual do catálogo antes
  de usá-la como referência.
