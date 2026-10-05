# Brag Plan: Cortag Revolution Tools

## What is this app?
O app de vendas em campo dos representantes da Cortag: preço por canal × estado com imposto embutido, levantamento de estoque por código de barras que funciona sem internet, histórico e meta do cliente, e orçamento que sai direto pro WhatsApp.

## The angle
O próprio CLAUDE.md do projeto diz a missão: substituir "tabela de preço impressa + planilha + calculadora" por um app só, e cada recurso nasce de "um passo a menos pra quem está na rua vendendo". O vídeo risca as três ferramentas antigas e mostra o celular fazendo a visita inteira.

## Hook (first 2-3 seconds)
"Tabela impressa" / "Planilha" / "Calculadora" entram uma por uma e são riscadas em vermelho Cortag → "Um app só." bate no fim do intro da música.

## Key moments (the middle)
- Busca "cortador hd" sendo digitada → aparecem os CORTADOR HD-500/750/900/1000 G2 do catálogo real com preço → toque em "+ Adicionar" → barra "Orçamento · 1 item".
- Leitor de código de barras com a faixa "Sem internet · salvo no aparelho": três EANs reais escaneados, um por vez, entrando na contagem → folha "Comprados e não contados" com o REBOLO de 3 un (caso real do CLAUDE.md) → "Incluir e salvar".
- Card do cliente: selo Premium, "faltam R$ 47,5 mil" com a barra enchendo, ações Sugestões · Ficha · Pedidos · Histórico → toque em Sugestões → lista de recompra.
- Folha "Enviar o CSV do pedido" → "Enviar no WhatsApp" → "Enviado".

## Outro / punchline
Logo Cortag Revolution Tools + "Um passo a menos pra quem está na rua vendendo."

## User flow worth showing
Buscar produto e adicionar ao orçamento → levantamento escaneado sem sinal → orçamento enviado no WhatsApp.

## Tone
- Preset: default
- Creative direction: lançamento de produto limpo e prático, feito pro vendedor de rua
- Interpretation: 4 cenas de celular com toques simulados, transições curtas (mergulho pelo fundo), nada de piada forçada; o humor seco fica no gancho das três ferramentas riscadas.

## Format: landscape — 1920x1080
## Duration: 23.5s

## Visual identity (from the project)
- Background: #1D1D1F (topbar/abas do app) em fundo escuro com brilho vermelho
- Accent: #CC0935 (`--red`)
- Text: #FFFFFF no fundo escuro; #1D1D1F (`--ink`) dentro do app, fundo #F5F5F7 (`--fill`)
- Display font: system stack do app (-apple-system / Helvetica Neue / Arial) → Liberation Sans local
- Body font: idem
- Strongest visual element: topbar escura com o logo + abas Pedido/Levantamento/Produtos/Clientes com sublinhado vermelho; card do cliente (`.clienteCard`)

Dados de tela: produtos, códigos, EANs e preços (`lsp`) vêm do `catalogo-embutido.js`; "faltam R$ 47,5 mil" e "3 rebolos" vêm do CLAUDE.md. O cliente "DEPÓSITO SÃO JOSÉ" é fictício (substitui dado real de cliente).

## Share copy (draft)
Tabela impressa, planilha e calculadora viraram um app só: preço por canal e estado, levantamento sem internet e orçamento direto no WhatsApp.

## Audio direction
- Role: warm bed + UI accents casados com os toques
- Music: happy-beats-business-moves-vol-1 (120 BPM)
- Music treatment: começa em 0 (intro sob o gancho), entra o groove em ~3.0s no reveal, fade-out nos últimos 1.5s
- Music cue guidance: preset `cues/happy-beats-business-moves-vol-1-by-ende-dot-app.music-cues.json`, 120.19 BPM. Strong cues: 18.52 (toque em Enviar no WhatsApp), 20.02 (logo do outro). Beat 3.02 para o logo do reveal. Beat-grid: leituras de código em 10.52/11.52/12.52 (um a cada dois beats, porque cada leitura adiciona uma linha de texto); itens de sugestão 15.52/15.77/16.02 com o conjunto inteiro parado até 17.2.
- Audio-reactive treatment: subtle; graves fazem o brilho vermelho atrás do celular e do logo respirar. Sem barras/visualizador.
- SFX posture: moderate, motion-matched
- Audio-coupled moments: riscos do gancho, digitação, toques, bipes de leitura, folhas subindo, envio, logo
- Restraint rule: nada agudo repetido alto; teclas só em parte dos caracteres.

## Storyboard

### Scene 1 — Gancho — 3.0s
"Tabela impressa", "Planilha", "Calculadora" entram uma a uma e são riscadas; "Um app só." entra em 2.0s.
Sequential/interaction: sim — três linhas, risco em cada uma (0.5/1.1/1.7s).
Audio intent: batidas secas e quentes em cada risco; acento no "Um app só."
Music: intro suave
Transition mood: soft (mergulho pelo fundo) → Scene 2

### Scene 2 — Reveal — 2.2s (3.0–5.2)
Logo Cortag Revolution Tools, "O app de vendas em campo." e "Pra quem está dentro da loja do cliente."
Sequential/interaction: logo, depois título, depois subtítulo.
Audio intent: payoff quando o groove entra.
Transition mood: soft → Scene 3

### Scene 3 — Preço — 4.0s (5.5–9.5)
Celular sobe. Legenda: "PREÇO / Preço na hora, imposto embutido. / 6 canais × estado." Busca digitada, quatro cards de cortador, toque em "+ Adicionar".
Sequential/interaction: digitação + cards um a um + toque.
Audio intent: teclas leves, clique no toque.
Transition mood: clean → Scene 4

### Scene 4 — Levantamento — 4.5s (9.5–14.0)
Legenda: "LEVANTAMENTO / Contou. Salvou. Sem sinal. / Escaneia o código de barras." Faixa sem internet, três leituras, folha "Comprados e não contados", toque em "Incluir e salvar".
Sequential/interaction: leituras uma a uma + folha + toque.
Audio intent: bipes suaves por leitura, deslize da folha.
Transition mood: clean → Scene 5

### Scene 5 — Cliente — 3.5s (14.0–17.5)
Legenda: "CLIENTE / Sabe o que oferecer. / Meta do trimestre e recompra." Card do cliente, barra enchendo, toque em Sugestões, lista de 3 grupos.
Sequential/interaction: toque + itens um a um (hold do conjunto ≥1.2s).
Transition mood: clean → Scene 6

### Scene 6 — WhatsApp — 2.5s (17.5–20.0)
Legenda: "ORÇAMENTO / Direto pro WhatsApp." Folha de envio com DepositoSaoJose.csv, toque em "Enviar no WhatsApp" (strong cue 18.52), "Enviado".
Audio intent: confirmação.
Transition mood: soft → Scene 7

### Scene 7 — Outro — 3.5s (20.0–23.5)
Logo (strong cue 20.02) + "Um passo a menos pra quem está na rua vendendo." + "Cortag Revolution Tools". Hold ~2.5s.
Audio intent: bell no logo, música termina em fade.

**Music mood for this video:** upbeat
**Audio summary:** intro quieto sob o gancho, groove entra no reveal, toques e leituras pontuam a demo, bell no logo e fade-out.
