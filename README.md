# Cortag Revolution Tools — App de Vendas

App de vendas em campo para representantes da Cortag (ferramentas de construção civil): consulta de preço por canal/estado, levantamento de estoque via scanner de código de barras, orçamento, histórico/pedidos oficiais por cliente e fichas técnicas/catálogo de produtos.

Este repositório contém **frontend (PWA) e backend (API) juntos**, publicados em dois lugares diferentes:

| Parte | Tecnologia | Hospedagem |
|---|---|---|
| Frontend (PWA) — `index.html`, `curva-abc.html`, `calculadora-materiais.html` etc. | HTML/CSS/JS estático | GitHub Pages (serve os arquivos direto da branch `main`) |
| Backend (API) — `server.js` e demais | Node.js (>=18) + Express | Render (free tier) |
| Banco de dados | PostgreSQL | Supabase (usar a connection string **Session pooler**, não a direta) |

O catálogo técnico ilustrado (fotos em alta resolução dos produtos) mora em outro repositório, `cortag-catalogo-tecnico`, publicado à parte no GitHub Pages.

Planos em andamento: `docs/PLANO-ESCALA-V2.md` (escala para 200+ usuários, repositório `appdbV2`)
e `docs/PLANO-REVISAO-SEGURANCA.md` (concluído).

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
  clientesClassificatorio.js    # classificatório do cliente: faixas, status, alertas, objetivo trimestral
  produtos.js                   # catálogo de referência (código+nome+categoria) e sincronização
  catalogoPrecos.js              # catálogo completo de preços por canal x estado (importação da planilha)
  pedidos.js                      # pedidos feitos pelo próprio app (finalizar pedido) e export por período
  pedidosOficiais.js               # importação e consulta da planilha oficial Carteira/Faturamento
  levantamentos.js                  # levantamentos de estoque em campo
  relatorios.js                      # histórico/rotatividade/recuperar (comprasDoCliente), Já compraram, sugestões, curva ABC, Dashboard
  novidades.js                        # avisos de importação: lista, "vistas", push no celular (lógica em lib/novidades.js)
  recompra.js                         # Recompra da semana: ritmo de compra do cliente, "Já falei" (cálculo em lib/ritmoCompra.js)
  produtosPromocionais.js             # SKUs promocionais (P/P1/P2 + código base)
  radarCnpj.js                        # ficha de CNPJ (radar-cnpj.com + BrasilAPI de reserva)
  previsaoEstoque.js                  # previsão de estoque (relatório ESCE007)
  configuracoes.js                     # configurações chave/valor (campanhas promocionais etc.)
  fichasTecnicas.js                     # balão de ficha técnica (specs resumidas)
  codigosProduto.js                      # EAN-13/DUN-14 por SKU (scanner de código de barras)
  assistente.js                           # assistente de IA (Gemini) — interpreta pergunta falada, nunca inventa dado
  lib/                                     # regras compartilhadas: skuNormalizacao (código promocional → base),
                                           # agrupamentoProduto (variações → "o produto"), politicaComercial,
                                           # cnpjBrasilApi, preenchimentoCnpj
test/                    # suite de testes (node test/run_tests.js), banco simulado em test/mock-db.js
index.html, curva-abc.html, calculadora-materiais.html, ficha-cnpj.html, catalogo-embutido.js, manifest.json, icon-*.png  # PWA estático servido pelo GitHub Pages
.github/workflows/keep-alive.yml  # ping em /health a cada 10 min pra evitar o Render dormir (free tier)
```

## Configuração

Variáveis de ambiente:

| Variável | Obrigatória | Descrição |
|---|---|---|
| `DATABASE_URL` | Sim (produção) | String de conexão do PostgreSQL (Supabase, connection pooler). Sem ela, a conexão roda sem SSL (uso local). |
| `DB_SSL_INSECURE` | Não | `true` desativa a validação do certificado SSL do banco (`rejectUnauthorized: false`). Use só como contorno temporário. |
| `PORT` | Não | Porta HTTP do servidor. Padrão `10000`. |
| `PREENCHIMENTO_CNPJ_DESLIGADO` | Não | `1` desliga o preenchimento automático das fichas de CNPJ que faltam (ver rota `/api/cnpj-preenchimento/status`). |
| `GOOGLE_CLIENT_ID` | Não | Client ID do Google usado no login (há um valor fixo no código como padrão). |
| `ADMIN_EMAIL` | Não | Se definida, só esse e-mail pode virar o **primeiro** usuário (admin) num banco sem usuários. Sem ela, quem logar primeiro vira admin. |
| `ALLOWED_ORIGINS` | Não | Origens liberadas no CORS, separadas por vírgula (ex.: `https://usuario.github.io`). Sem ela, a API aceita qualquer origem. |
| `GEMINI_API_KEY` | Sim (para `/api/assistente`) | Chave da API Gemini usada pelo assistente com IA. |
| `GEMINI_MODEL` | Não | Modelo Gemini usado. Padrão `gemini-2.0-flash`. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Não (para avisos no celular) | Chave Web Push dos avisos de importação (gerar com `npx web-push generate-vapid-keys`; `VAPID_SUBJECT` = `mailto:` ou URL https). Sem elas, as novidades aparecem só no app. Trocar a chave invalida as inscrições: cada vendedor ativa de novo. |

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
- `/api/pedidos` — pedidos manuais/do app (POST `/`) e export por período (GET `/exportar`). `GET /salvos` lista os pedidos que o próprio vendedor fechou no app nos últimos 120 dias (itens, cliente e `contexto` — estado, canal, classificatório, prazo, descontos e preços editados de quando foi montado); `PATCH /:id` altera um pedido do app já gravado (troca os itens e o contexto, marca `atualizado_em`, mantém id/cliente/data; só o autor ou admin, só `origem = 'app'`). É o que o app usa pra reabrir um pedido no orçamento ("🧾 Pedidos" no card do cliente, link no orçamento ou abrindo o CSV do pedido) e "Atualizar pedido" em vez de fechar outro
- `/api/pedidos-oficiais` — pedidos oficiais por cliente e importação da planilha oficial Carteira/Faturamento
- `/api/levantamentos` — levantamentos de estoque em campo, incluindo rascunho automático (`POST`/`GET`/`DELETE /api/levantamentos/rascunho`, um por usuário) pra não perder levantamento não salvo em caso de queda de conexão ou fechamento acidental do app. O `POST` aceita `localizacao: { latitude, longitude, precisao_m }` (GPS do celular no momento de salvar): fica gravada no levantamento e, se a precisão for de até 100 m, vira a localização do cliente (só substitui uma leitura igual ou mais precisa, ou com mais de 180 dias)
- `/api/clientes/sync` — lista enxuta (`id`, `nome`, `documento`) de todos os clientes, usada pra manter uma cópia local no aparelho (`localStorage`) e o app continuar funcionando na aba de Levantamento mesmo se a busca de cliente no servidor falhar
- `/api/previsao-estoque` — previsão de estoque (relatório ESCE007)
- `/api/configuracoes` — configurações chave/valor
- `/api/fichas-tecnicas` — fichas técnicas de produtos
- `/api/codigos-produto` — EAN-13/DUN-14 por SKU (leitura livre, importar restrito a admin)
- `/api/assistente` — assistente de IA (Gemini)
- `/api/clientes/:id/ficha-cnpj` (+ `POST .../atualizar`) e `/api/radar-cnpj/:cnpj` — ficha cadastral da Receita Federal. Consulta o radar-cnpj.com e, se ele recusar, atingir limite, cair ou não achar o CNPJ, usa a BrasilAPI de reserva, convertida pro mesmo formato (`routes/lib/cnpjBrasilApi.js`); a ficha fica em cache por 30 dias em `cliente_cnpj_ficha`
- `/api/clientes/:id/ficha-cnpj/existe` — só diz se o cliente já tem ficha guardada (lê o banco, nunca consulta a Receita); usado pelo botão "Ficha cadastral" da barra do cliente, que abre `ficha-cnpj.html?cliente=ID&nome=…&doc=…` direto na ficha
- `/api/cnpj-preenchimento/status` — progresso do preenchimento automático das fichas que faltam (`routes/lib/preenchimentoCnpj.js`): o servidor completa sozinho, das 01h às 06h de Brasília, no máximo 40 consultas por noite, uma a cada 15 s, só clientes com CNPJ e sem ficha nenhuma; CNPJ não encontrado é tentado até 3 vezes (tabela `cnpj_preenchimento_falhas`); se as duas origens estiverem fora do ar ou no limite, para a noite e retoma na seguinte. Estado do dia em `configuracoes` (`cnpj_preenchimento_auto`)
- `/api/clientes/:id/comprados-recentes` — SKUs que o cliente comprou nos últimos 12 meses (faturado oficial + pedidos do app, código promocional unido ao base), com a quantidade da compra mais recente; o Levantamento mostra os que não foram contados ("Comprados e não contados") e avisa ao salvar
- `/api/clientes/:id/historico`, `/rotatividade`, `/recuperar`, `/consumo-estimado/:produtoId` — o que o cliente comprou, via `comprasDoCliente` (faturado oficial + pedidos do app; ver "Fontes de dados"). `recuperar` só responde pra cliente com levantamento (produto comprado e zerado/nunca contado na leitura mais recente)
- `/api/clientes/:id/sugestoes-recompra` — produtos (variações agrupadas) que o cliente não compra há mais de 1 ano
- `/api/novidades` (+ `POST /vistas`, `/push/inscrever`, `/push/cancelar`, `/push/teste`) — avisos de importação: relatório oficial, catálogo de preços, previsão de estoque, Classificatório e objetivos trimestrais viram uma novidade (`routes/lib/novidades.js`). Faixa "🔔 N novidades" abaixo das abas e push no celular (Web Push, `sw.js`) só em dia útil, 7h–20h de Brasília (fora disso, sai no próximo dia útil às 7h); o mesmo tipo reimportado em até 30 min atualiza a mesma novidade e troca o aviso no celular sem tocar de novo
- `/api/recompra` (+ `POST /api/recompra/:id/adiar`) — Recompra da semana (topo da aba Clientes): clientes com a próxima compra atrasada ou prevista pros próximos 7 dias, pelo ritmo dos últimos 12 meses (mediana dos intervalos, mín. 3 compras; compras a até 7 dias uma da outra = uma só), com os produtos pro "Montar proposta" (`routes/lib/ritmoCompra.js`). `adiar` = "Já falei": sai da lista por 7 dias (tabela `recompra_adiamentos`)
- `/api/produtos/:codigo/clientes` — "Já compraram" (faturado oficial + app, por cliente, com a última data de faturamento e NF) e "Levantamento" (última contagem por cliente) da aba Produtos
- `/api/dashboard/resumo` — dados do Dashboard (`curva-abc.html`): entrada de pedidos mensal + lista dos pedidos do mês (`entradaPedidosMes`), vendas semanal/trimestral, top clientes, clientes ativos por canal, contas sem compra
- `/api/produtos-abc-geral`, `/api/clientes/:id/produtos-abc` — Curva ABC geral e por cliente (faturado oficial)
- `/api/clientes/:id/classificatorio/status`, `/grupo`, `/api/clientes/classificatorio/alertas` — classificatório (faixas pelos 12 meses móveis de faturado)
- `/api/clientes/:id/levantamentos`, `/api/pedidos/exportar` — levantamentos do cliente e export de pedidos

`GET /health` retorna `{ status: 'ok' }` para checagem de disponibilidade (usado pelo keep-alive).

## Fontes de dados — o que cada tela soma

| Fonte | O que é | Datas |
|---|---|---|
| `pedidos_oficiais_itens` | Relatório oficial do ERP (abas Carteira + Faturamento), importado pelo Painel. É a fonte oficial. | `data_implantacao` (entrada do pedido: `Implantação`/`Dt.Implant`) e `data_faturamento` (emissão da NF: `Dt.Emissão`) |
| `pedidos` / `pedido_itens` | Pedidos fechados pelo vendedor no app (só desde 05/2026, uma fração do total) | `data_pedido` |

- **O que o cliente comprou** (Histórico, Rotatividade, Recuperar, consumo estimado, "Já compraram", comprados-recentes, sugestões): **faturado oficial + app**. Código promocional (P/P1/P2) conta como o produto base; pedido do app ou de PDF só conta se não houver faturado oficial do mesmo cliente + produto entre 7 dias antes e 45 depois (senão é a mesma compra, faturada dias depois), e pedido com `origem = 'faturamento'` (cópias de uma importação antiga) nunca conta — `routes/lib/comprasApp.js`. Função `comprasDoCliente` em `routes/relatorios.js`. Nunca usar só `pedidos`/`pedido_itens` — a maior parte das compras vem do ERP.
- **Recompra da semana**: compra = **entrada do pedido** (carteira + faturado pela data de implantação, sem a série de 7 dígitos) + pedidos do app (mesma regra de não contar em dobro) — o cliente sai da lista assim que pede, sem esperar faturar.
- **Entrada de Pedidos** (Dashboard: valor, qtde. de pedidos e de clientes, ticket médio): mesma regra do painel oficial — mês pela **data de implantação**, **carteira + faturado**, **sem a série de pedidos de 7 dígitos** (10xxxxx–13xxxxx, itens avulsos fora do catálogo). Conciliado com o Salesforce em 09/2026.
- **Faturamento** (classificatório, Curva ABC, top clientes, vendas semanal/trimestral): só `status = 'faturado'`, pela `data_faturamento`.
- **Datas sem hora** (`DATE` e `date_trunc`) chegam no JSON como meia-noite UTC — no navegador, `new Date()` joga pro dia/mês anterior. Exibir sempre com `formatDateBr` (`index.html`) ou `partesDoPeriodo` (`curva-abc.html`).

## Motor de preço — canal × estado

Cada produto carrega preço por 6 canais (Varejo/Atacado/E-commerce/Moderno/Construtora/Institucional) x 27 estados, já com imposto calculado:

- **5 estados (MG, RJ, PR, SC, RS)**: cálculo fiscal exato (ICMS-ST específico do estado).
- **Outros 22 estados (inclusive SP)**: preço líquido + IPI, sem ICMS-ST adicional.
- Regra de "Preço Fixo" (sem desconto, só imposto) só vale para Varejo/Atacado/E-commerce.
- **Classificatório por canal** (Política Comercial rev. 06): os botões do Pedido mudam conforme o Canal (`CLASSI_POR_CANAL` em `index.html`) — Varejo 15/17/20 + Rede 18, Atacado 20/22/25, E-commerce 10/15/20, Moderno Home Center Premium 22 / Atacarejo 25, Institucional Locação/Assistência 12 e Marmoraria/Consumidor final **+30%** (percentual negativo = acréscimo sobre a tabela), Construtora 0. Selecionar um cliente troca o Canal e marca o classificatório dele. O percentual gravado vem do **nome** do classificatório pela política (`routes/lib/politicaComercial.js`, mesma tabela do navegador), não do número que o relatório do ERP traz entre parênteses.
- **Faixas do classificatório** (card e ficha do cliente, `FAIXAS` em `routes/clientesClassificatorio.js`): medidas pelo faturado dos **últimos 12 meses móveis** — Varejo 30 mil / 50 mil, Atacado 300 mil / 1 mi, E-commerce 200 mil / 1 mi, Home Center Premium a partir de 120 mil; Institucional, Construtora, Atacarejo e Home Center Master sem faixa. Risco de queda = 12 meses abaixo do mínimo da faixa atual.
- **Desconto por prazo**: À vista +2% e 14 dias +1,5%, **somados** ao classificatório (Master 20% + à vista = 22%), aplicados ao escolher o prazo, com "remover" embaixo do seletor. O PDF/texto mostra "A Vista (+2% desc. financeiro)".
- **Prazos por canal** (itens 11.1/11.2) em `PRAZOS_POR_CANAL`; **pedido mínimo por região** (item 14) em `pedidoMinimoCif()`: CIF SP Capital R$ 800 (pelo município da ficha de CNPJ), resto de SP/Sul/Sudeste R$ 1.200, Centro-Oeste R$ 1.800, Norte/Nordeste R$ 2.000; FOB/Redespacho R$ 1.000 — só aviso, sobre o total sem impostos.
- A conversão da planilha "LISTA PADRÃO" para o banco acontece no servidor (`routes/catalogoPrecos.js`, via lib `xlsx`), não no navegador.
- O orçamento mostra uma linha "Total S/ Impostos" acima do Total, calculada a partir do preço sem imposto de cada produto (`precos_sem_imposto`, calculado e armazenado já na importação da planilha).
- No Admin, todas as promoções (campanhas por quantidade/valor, desconto por classificatório e produtos com preço promocional) ficam numa lista única no card "Promoções", cada item com etiqueta do tipo; "+ Nova promoção" pergunta qual dos três criar.

## Painel Administrativo

- **Importar arquivo**: uma área única recebe qualquer arquivo (vários de uma vez) e reconhece o tipo pelo conteúdo — `detectarTipoArquivo()` em `index.html` (abas `PRECIFICAÇÃO`/`TRIBUTAÇÃO` → planilha de preços; `Carteira`/`Faturamento` → relatório oficial; colunas `Matriz` + `OBJETIVO MÊS` → objetivo trimestral; `Classificatorio` → classificatório do ERP; `Item` + `Qt. Disp.` → previsão de estoque; `Código` + `YouTube`/`Instagram` → vídeos; `Código` + `Link` → link do site; JSON de fichas técnicas, EAN/DUN-14 ou clientes; `.pdf` → cotação). Mostra "Detectado: X" e só envia depois de confirmar. Para aceitar um formato novo, adicione o tipo em `TIPOS_IMPORTACAO` e a regra de reconhecimento em `detectarTipoArquivo()`.
- **Status**: uma linha de resumo que abre os detalhes; "Sincronizar agora" confere o servidor, reenvia o catálogo de produtos e recarrega a fonte automática.
- **Avançado** (fechado por padrão): exportar pedidos, produtos sem EAN, integridade de clientes, pedidos duplicados, carteira antiga, apagar relatório oficial e endereço do servidor.
- **Produtos foco** fica dentro do card Promoções, recolhido; a lista só é montada ao abrir.
- **Transportadoras (rastreio de entrega)**, em Avançado: nome, texto(s) pra reconhecer no nome da transportadora do relatório oficial (vários separados por `;`, sem diferença de acento/pontuação, por palavra inteira — ex: `SAO MIGUEL; EXPRESSO S M`) e link de rastreio (aceita `{cnpj}` e `{nf}`); cada item pode ser editado. Salvo na configuração `transportadoras_rastreio`; enquanto ninguém salvar, valem Expresso São Miguel e TRD Transportes (Senior).

## Rastreio de entrega

Cada pedido faturado (aba Pedidos do cliente) com nota fiscal tem o botão **Rastrear entrega**: mostra o CNPJ do cliente e a NF com botão de copiar e abre o site da transportadora, escolhida pelo nome que veio no relatório oficial (`acharTransportadora()` em `index.html`). Os portais das transportadoras em geral não aceitam os dados pelo link, por isso o fluxo é copiar e colar; quando aceitam, o link cadastrado com `{cnpj}`/`{nf}` já abre preenchido.

## Padrão visual (frontend)

- **Cores de status**: use os tokens do `:root`, nunca o hex solto — `--success`, `--warning`, `--danger` (texto/borda, mudam no tema escuro), `--success-bg`/`--warning-bg`/`--danger-bg`/`--accent-bg`/`--info-bg` (tintas de fundo) e `--success-strong`/`--warning-strong`/`--danger-strong` (fundo sólido com texto branco, iguais nos dois temas).
- **Texto sobre fundo de destaque** (vermelho, verde, vidro escuro): `var(--on-accent)`. `--white` é cor de *superfície* — no tema escuro vira cinza-escuro.
- **Botões**: `.fileBtn`/`.restoreBtn` = secundário; `.btnPrimary` = ação principal; `.btnDanger` = modificador destrutivo; `.restoreBtn.compacto` = versão estreita. Em modais, `.minimodal-btnrow`: o primeiro botão é o Cancelar e o último (se houver dois) vira a ação principal sozinho.
- **Mensagens**: `<div class="ap-msg success">` / `<div class="ap-msg error">`; toast com `showToast(msg)` ou `showToast(msg, 'erro')` (vermelho, fica 5s). Nada de `alert()`/`prompt()`/`confirm()` nativos — use `askConfirm(msg, rotulo, { perigo })` e `askText(msg, valorInicial, rotulo)`.
- **Ícones de lista**: `ICON_TRASH`, `ICON_EDIT`, `ICON_ATIVO`/`ICON_INATIVO` (SVG em `currentColor`), não emoji.
- **Fonte**: tamanhos inteiros (11, 12, 13, 14, 15…); títulos `h2` 18px, `h3` de modal 17px.
- As páginas separadas (`curva-abc.html`, `ficha-cnpj.html`, `calculadora-materiais.html`) repetem os mesmos tokens de status no próprio `:root`.

## Frontend — carregamento do catálogo de preços

O catálogo de produtos não fica embutido no `index.html` (carregamento inicial mais leve). A função `loadActiveDB()` tenta, nessa ordem: override manual salvo no aparelho (`localStorage`) → `/api/catalogo-precos` no servidor → `precos.json` hospedado junto do app → `catalogo-embutido.js` (base offline, último recurso).

O carregamento de EAN/DUN-14 (`loadCodigosProduto()`) roda **depois** que o catálogo termina de carregar (encadeado via `.then()`), para o scanner de código de barras não ficar sem índice.

## Importação de pedidos oficiais (Carteira / Faturamento)

- `POST /api/pedidos-oficiais/importar` — recebe `{ itens: [...], classificacoes: [...] }`.
  O frontend (`index.html`, `parseRelatorioOficialXlsx`) lê as abas "Carteira" e "Faturamento" da planilha .xlsx oficial direto no navegador e monta esse payload — não existe preparo manual de arquivo. Grava em `pedidos_oficiais_itens` (chave `nr_pedido` + `codigo_sku` + `nota_chave` — a nota fiscal na linha faturada, `''` no saldo em carteira —, nunca duplica, nunca "recua" de faturado pra carteira) e atualiza o classificatório do cliente (`clientes.classificatorio_tipo/desconto`), respeitando qual relatório é mais recente.
  - Qualquer usuário autenticado pode importar.
  - Os nomes de coluna esperados na planilha (`Cliente`, `Cod.Cliente`, `Nr.Pedido`, `Item`, `Nota Fiscal`, `Transportadora`, `Situação`, `Classificatório` etc., com variações aceitas) estão centralizados em `COLUNAS_RELATORIO_OFICIAL` no `index.html` — se uma coluna essencial não for encontrada, o import falha com erro explícito em vez de gravar dado errado.
  - Datas: `Implantação` (Carteira) / `Dt.Implant` (Faturamento) → `data_implantacao`; `Dt.Emissão` → `data_faturamento` (só nas linhas faturadas). Valor: `Vlr.Faturado` no faturado, `Vl.Pendente` na carteira. `Descrição` → `descricao`: dá nome, nas telas, ao produto que já saiu da tabela de preços (o nome do catálogo tem prioridade).
  - **Produto faturado só em parte**: o faturado (uma linha por nota fiscal) e o saldo que continua na aba Carteira ficam em linhas separadas. A linha de carteira só sai quando o relatório traz o produto no Faturamento e não mais na Carteira, ou quando dá o pedido como "Atendido Total" (aí sai todo o saldo dele em carteira — item cancelado no ERP). Histórico/Rotatividade/Comprados recentes somam as notas do mesmo pedido como uma compra só.
  - **Saldo abaixo do mínimo** (R$ 300; R$ 600 no Norte/Nordeste, pela UF da ficha de CNPJ — `GET /api/pedidos-oficiais/:clienteId` devolve `saldo_minimo`): o card do pedido parcial avisa que o saldo pode ser cancelado, quanto falta e qual item o cliente pode aumentar (com 1 código no saldo, só ele; com 2 ou mais, qualquer um), deixando de fora o que a planilha de Previsão de estoque dá como sem previsão de chegada. O saldo também tem o prazo de 90 dias da implantação ("até DD/MM"); passado ele, o card avisa que já deve ter sido cancelado.
  - Fora isso, a importação **só acrescenta e atualiza**: um pedido de carteira cancelado no ERP que nunca volta num relatório continua gravado como carteira até a limpeza de "carteira antiga" (Painel → Avançado). Um mês cujo relatório nunca foi importado fica vazio em todos os relatórios. Reimportar corrige datas e valores (a data de implantação do relatório novo substitui a gravada).
  - **Planilha salva num Excel em inglês**: o ERP gera data "05/11/25" e valor "1207,296"; aberta e salva num Excel configurado em inglês, a data com dia ≤ 12 vira data com dia/mês trocados, a de dia > 12 fica como texto, e o valor vira número sem vírgula (até 10.000× maior) ou texto. A importação lê data em texto dd/mm/aa, **destroca** as datas numéricas de uma coluna que tem esse texto, e **recusa o arquivo** quando a coluna de valor mistura número e texto com vírgula (não tem como saber o valor certo) — a mensagem pede para exportar de novo sem passar pelo Excel. `Nr.Pedido` só numérico perde os zeros à esquerda ("00597502" = "597502").
- `GET /api/pedidos-oficiais/status` — última data de atualização e totais (carteira/faturado).
- `GET /api/pedidos-oficiais/:clienteId` e `/:clienteId/resumo` — consulta por cliente.

## Levantamento — cliente e rascunho não se perdem

- **Cliente local com sincronização em segundo plano**: além de buscar cliente no servidor, o app mantém uma cópia local (`localStorage`) de todos os clientes (`GET /api/clientes/sync`), sincronizada no boot com tentativas escalonadas (`0s, 4s, 8s, 15s`) pra já estar disponível o quanto antes. Se a busca no servidor falhar (rede instável, banco indisponível), o app tenta de novo automaticamente (retry) e só cai pra essa base local como último recurso, evitando a mensagem de "Não foi possível conectar ao servidor de histórico" travar a seleção de cliente.
- **Limpar o cliente**: fica dentro do seletor de cliente ("Limpar seleção", só aparece com cliente escolhido); no Levantamento também fecha o levantamento aberto.
- **Comprados e não contados**: com cliente selecionado, o Levantamento lista o que ele comprou nos últimos 12 meses e não está na contagem, e avisa ao salvar ("Incluir e salvar" põe estoque 0 e a quantidade da última compra no pedido).
- **Rascunho de levantamento não salvo**: o levantamento em andamento (itens + cliente) é salvo automaticamente no aparelho e, com um debounce de ~2,5s, também no servidor (`levantamento_rascunhos`), pra sobreviver a fechamento acidental do app, falta de conexão ou troca de aparelho. Ao carregar, os itens do rascunho só são revalidados contra o catálogo depois que ele termina de carregar — evitando que o rascunho seja apagado por engano por uma corrida com o carregamento assíncrono do catálogo.

## Condição de Pagamento

O orçamento tem um campo de seleção de Condição de Pagamento (lista fixa de opções usadas pela Cortag). O valor escolhido aparece no PDF do orçamento, na imagem gerada e no texto de compartilhamento (WhatsApp etc.), e é limpo junto com o carrinho/sessão.

## Calculadora de Materiais (Espaçadores Niveladores)

Página própria (`calculadora-materiais.html`), separada do `index.html` pelo mesmo motivo da Curva ABC (uso esporádico, mantém o app principal leve). Calcula a quantidade recomendada de peças e de Espaçadores Niveladores a partir das medidas da peça e do ambiente, da junta desejada e da perda estimada — fórmula calibrada e validada contra a calculadora oficial da Cortag.

- Modelos disponíveis: **Standard**, **ECO** e **Slim** (as 3 linhas mais vendidas), cada um com seu próprio conjunto de juntas válidas.
- Botão "Limpar" reseta os campos de peça/ambiente e volta modelo/perda pro padrão.
- Botão "Adicionar ao orçamento" resolve o produto do catálogo certo pra cada modelo/junta (usando o tamanho de embalagem pra distinguir SKU vendável de caixa fechada, e o nome do produto pra diferenciar Standard das demais linhas) e faz o handoff pro carrinho do `index.html` via `localStorage` + redirecionamento (`index.html?importarCalculo=1`), sem precisar duplicar a lógica de carrinho na página separada.
- Acessível por um ícone (calculadora) no topo do app principal, ao lado do ícone da Curva ABC.

## Dashboard e Curva ABC

Página própria (`curva-abc.html`), separada do `index.html`: uso esporádico, peso de biblioteca de gráfico, e não depende de estado "ao vivo" (só lê histórico já fechado). Acessível a qualquer pessoa logada por um ícone no topo do app principal. Duas abas:

- **Dashboard** (inicial): objetivo do mês, **Valor Entrada de Pedidos Mês** (regra do painel oficial — ver "Fontes de dados"; tocar no cartão abre a lista dos pedidos do mês com cliente, dia e valor), ticket médio, clientes ativos por canal, contas de 3–5 e 6–8 meses sem compra, risco de queda / perto de subir (cartões expansíveis), gráficos de entrada de pedidos, pedidos e clientes por mês (12 meses), vendas semanal e trimestral, top 5 clientes e produtos mais vendidos, e valor do mês por família de produtos e por produtos foco.
- **Curva ABC**: geral ou por cliente (`curva-abc.html?cliente=ID`), pelo faturado oficial, com códigos promocionais unidos ao produto base.

## Assistente de voz (Gemini)

Reconhecimento de voz do navegador → texto enviado pro backend → Gemini só classifica a intenção (preço/ficha técnica/cliente) e extrai o termo de busca, **nunca responde o dado em si** → o app busca o dado real no próprio catálogo/banco → resposta falada via síntese do navegador (grátis) ou, opcionalmente, voz nativa do Gemini.

## Infraestrutura / operação

- **Render free tier**: o serviço dorme após ~15 min sem uso. Mitigado por `.github/workflows/keep-alive.yml`, que faz ping em `/health` a cada 10 minutos.
- Ao mexer em configuração do Render, sempre confirmar que a URL do serviço bate com a que o frontend usa.
- **DATABASE_URL** deve sempre apontar para a connection string "Session pooler" do Supabase — a conexão direta causa timeout para a maioria dos estados.
- Rodar a suite de testes em `test/` antes de mudanças grandes no backend.
