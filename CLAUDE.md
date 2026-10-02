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

Pegadinhas de ambiente:
- `index.html` tem fim de linha **CRLF** — editar preservando (ex.: Python com `newline=''`).
- Pra testar SQL num Postgres local: `db.js` liga SSL sempre que `DATABASE_URL` existe, então usar
  `PGHOST`/`PGPORT`/`PGUSER`/`PGDATABASE` sem `DATABASE_URL`.
- Num banco **novo**, a 1ª execução do `schema.sql` falha (um `ALTER TABLE pedidos … REFERENCES
  usuarios` vem antes do `CREATE TABLE usuarios`); rodar de novo resolve. O Supabase não é
  afetado (as tabelas já existem).
- `index.html` **não tem regra `.hidden` genérica** (as páginas separadas têm, com `!important`):
  cada componente declara o seu `.X.hidden { display: none }`. Elemento que liga/desliga por
  `.hidden` não pode ter `display` no `style=""` inline — o inline ganha e ele nunca some (foi a
  causa do "Adicionar todos ao orçamento" da busca que aparecia sem resultado e não fazia nada,
  PR #128).
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
  - Série de 7 dígitos: o ERP **conta** no classificatório na maioria dos casos (8 clientes), mas não
    em 2 (5569, 21650) — não aplicar o filtro `length(nr_pedido) <= 6` no classificatório.

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
  "Cancelamento saldo em carteira DD.MM.AAAA" da assistente comercial, chegam depois do corte): o saldo
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
  novo. Pedido **recém-finalizado já fica aberto** pra edição (finalizar de novo não duplica);
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
  1ª + código do ERP) e **"Usar sempre esse nome pra este cliente"** (marcado), que guarda no aparelho
  (`cortagNomeArquivoCliente_v1`, por id). O nome guardado vale também pra cópia do pedido no Drive e
  é reconhecido ao abrir o CSV de volta (`pedidoPeloNomeDoArquivo`). Por aparelho, não vai pro servidor.

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

- Padronização visual que ficou pra depois (levantada na análise de UI): **acessibilidade e área
  de toque** (botões de 17–32px como `.fichaInfoBtn`, `.rm`, `.pencilBtn`, `.gearBtn`; campos só
  com placeholder, sem `<label>`; steppers −/+ sem `aria-label`) e **unificar o visual das páginas
  separadas** com o `index.html` (cabeçalho, cards e botões próprios em cada uma — hoje só os
  tokens e o tema escuro foram alinhados).

- Ideia em aberto, ainda não implementada: um painel de "oportunidades do dia" na tela inicial
  (ex.: clientes sumidos há N dias, objetivo trimestral em risco, produtos parados na Lista de
  preços) — surgiu de "o que podemos implementar pra ajudar nas vendas" e faz sentido como
  próximo passo de produto, não só bug fix. A rota de sugestões de recompra e o `grupoDoProduto`
  já dão a base pro sinal de "produtos parados" por cliente; `comprados-recentes` (PR #129) dá o
  que ele compra com frequência, pra cruzar com o último levantamento.
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
- Correção pequena pendente: mover o `CREATE TABLE usuarios` do `schema.sql` pra antes da
  primeira referência a ele, pra um banco novo subir na primeira execução.
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
- Em aberto, perguntar antes de mudar: a série de 7 dígitos ficou fora só do Dashboard; ainda soma
  no faturamento do classificatório, na Curva ABC e no top clientes (valores pequenos). Se o painel
  oficial também a exclui dali, dá pra reaproveitar o mesmo filtro (`length(nr_pedido) <= 6`).
