# Hyperframes Composition Brief: Cortag Revolution Tools

## Objective
Create a short launch-style brag video for Cortag Revolution Tools (app de vendas em campo da Cortag).

## Output
- Composition directory: `brag-output-2026-10-05-015034/composition/`
- Rendered video: `brag-output-2026-10-05-015034/brag.mp4`
- Format: landscape — 1920x1080, 30fps
- Duration: 23.5 seconds

## Source Material
- Project root: repo `appdb`
- Primary files read: `index.html` (tokens `:root`, `.topbar`, `.tabbar`, `.clienteCard` e ações), `manifest.json`, `catalogo-embutido.js`, `README.md`, `CLAUDE.md`
- Product name: Cortag Revolution Tools
- Tagline / strongest claim: substituir tabela de preço impressa + planilha + calculadora por um único app; "resolve um passo a menos pra quem está na rua vendendo"
- Key UI to recreate: topbar escura com logo (PNG extraído do `index.html`), abas Pedido/Levantamento/Produtos/Clientes, card do cliente com Sugestões · Ficha · Pedidos · Histórico, folhas "Comprados e não contados" e "Enviar no WhatsApp"
- Copy that must appear verbatim: "Comprados e não contados", "Incluir e salvar", "Salvar assim", "Enviar no WhatsApp", "Salvar no aparelho", "Sugestões", "Ficha", "Pedidos", "Histórico", nomes de produto do catálogo (CORTADOR HD-500/750/900/1000 G2, REBOLO TIPO COPO CÔNICO 75 mm G 60 ROSCA M14, KIT MOSAICO, RODEL INFINITY Ø 22 mm)

## Creative Direction
- Tone preset: default
- Creative direction: lançamento limpo e prático, feito pro vendedor de rua
- Angle / hook / outro: ver `brag-plan.md`
- Avoid: generic SaaS language, abstract filler, redesign do app; dado real de cliente (usar "DEPÓSITO SÃO JOSÉ", fictício)

## Visual Identity
- Background: #121214 → #1D1D1F com brilho vermelho (#CC0935) atrás do celular
- Text: #FFFFFF no palco; #1D1D1F dentro do app sobre #F5F5F7
- Accent: #CC0935; estados: success #1E8E3E, warning #B36B00 / #FFF4E5
- Fonts: Liberation Sans (local, substituto métrico do Arial/Helvetica do app); DejaVu Sans Mono para o nome do CSV

## Storyboard
Contrato em `brag-plan.md`. Resumo:
1. Gancho — 3.0s — três ferramentas riscadas → "Um app só."
2. Reveal — 2.2s — logo + "O app de vendas em campo."
3. Preço — 4.0s — busca, cards, "+ Adicionar"
4. Levantamento — 4.5s — 3 leituras sem internet, "Comprados e não contados"
5. Cliente — 3.5s — meta do trimestre, sugestões de recompra
6. WhatsApp — 2.5s — "Enviar no WhatsApp" → "Enviado"
7. Outro — 3.5s — logo + punchline

## Audio
- Role: warm bed + UI accents
- Music: `assets/music/happy-beats-business-moves-vol-1-by-ende-dot-app.mp3`, fade-out nos últimos 1.5s
- Music cue guidance: `/brag` preset `assets/music/cues/happy-beats-business-moves-vol-1-by-ende-dot-app.music-cues.json` (120.19 BPM). Locks: 3.02 (logo do reveal), 18.52 (toque Enviar), 20.02 (logo do outro). Beat-grid: leituras 10.52/11.52/12.52.
- Audio-reactive: subtle — graves → brilho atrás do celular e do logo (`assets/audio-data.js`, extraído com `hyperframes-creative/scripts/extract-audio-data.py`)
- SFX: Kenney CC0 low-HF-risk (impactSoft_medium, click_003, select_008, card-slide-1, bong_001, impactBell_heavy_000, keypress) — copiados em `composition/assets/sfx/`

## Hyperframes Instructions
Monolithic `index.html`, one paused GSAP timeline (local `assets/vendor/gsap.min.js`; the CDN is blocked in this environment), `hyperframes check` before render, local render only.
