# Plano de escala — v2 (200+ usuários, gerentes regionais)

Levantado em 09/2026. Hoje o app atende um grupo pequeno, com todo mundo vendo tudo. Este
documento junta o que impede de levar o app a **200+ representantes com gerentes regionais**, o
plano em fases e como a v2 é construída **sem arriscar a versão que está em uso**.

Resumo: 200 usuários é pouca carga para servidor e banco — isso se resolve com plano pago. O
trabalho de verdade é **de quem é cada cliente** (escopo de carteira), **papéis de acesso**,
**importação** e **metas**, e, no frontend, **organizar o código e controlar versão** entre o app
no celular e a API.

---

## 1. Limitações atuais

### Bloqueiam a escala

| # | Limitação | Onde está hoje |
|---|---|---|
| 1 | **O app não sabe de quem é o cliente.** O relatório do ERP traz "Representante" e "Gestor", mas a importação descarta as duas. Todo vendedor vê a carteira inteira; o Dashboard é o total da empresa. | `clientes`, `pedidos_oficiais_itens` (sem representante/gestor/região); `lerAbaRelatorioOficial` em `index.html` |
| 2 | **Um único papel de acesso** (`is_admin`). Não existem vendedor × gerente × admin. | `usuarios.is_admin`, `middleware/` |
| 3 | **Sync de clientes manda todos os clientes** para cada celular. | `GET /api/clientes/sync` |
| 4 | **Importação manual, aberta a qualquer usuário, lida no navegador, com corpo de até 1 MB.** O relatório da empresa inteira passa disso, e vários importando relatórios sobrepostos vira bagunça. | `express.json({ limit: '1mb' })` em `server.js`; decisão atual de manter a importação liberada (09/2026) |
| 5 | **Login Google**: se a tela de consentimento estiver em modo "Teste", o limite é 100 usuários de teste — publicar (escopos básicos não pedem verificação) ou usar "Interno" se a Cortag tiver Google Workspace. Cadastro de usuário é um e-mail por vez. | Google Cloud Console; tabela `usuarios` |

### Aguentam no começo, depois incomodam

| # | Limitação | Detalhe |
|---|---|---|
| 6 | **Plano gratuito** | Render dorme (daí o `keep-alive.yml`) e roda 1 instância; o preenchimento noturno de fichas de CNPJ roda dentro do processo web (com 2 instâncias rodaria 2 vezes). Supabase gratuito tem 500 MB — hoje ~3.700 pedidos; a empresa inteira pode ser 20–50×. |
| 7 | **Relatórios recalculados a cada acesso** | Dashboard, Curva ABC, classificatório e alertas varrem as tabelas inteiras. 200 pessoas abrindo às 8h fica lento. |
| 8 | **Meta mensal única** | Uma configuração global; não há meta por vendedor/região/trimestre. |
| 9 | **Sem CI, sem homologação, sem monitoramento de erros** | O único workflow é o `keep-alive.yml`; os testes (`test/run_tests.js`) só rodam na mão; erros só nos logs do Render. |
| 10 | **Custos por uso** | Gemini (assistente) e limite do radar-cnpj crescem com o número de usuários (BrasilAPI já é reserva). |
| 11 | **LGPD e desligamento** | GPS das lojas, histórico de compra e acesso de um representante à carteira de outro precisam de regra; não há processo para revogar sessão e transferir carteira. |

### Frontend (o "limite do HTML")

O problema não é ser web — web/PWA continua sendo a melhor plataforma para atualizar 200 celulares
de uma vez. O limite é a organização do código e a entrega das versões:

- **`index.html` com ~14 mil linhas / 890 KB / ~480 funções**, sem módulos nem build. Qualquer
  correção de uma linha faz todo mundo baixar os 890 KB de novo; com mais de uma pessoa
  programando, conflito o tempo todo; não há teste automático de tela.
- **Atualização no celular**: o `sw.js` busca o HTML na rede primeiro, então a versão nova chega
  **na próxima abertura com internet** (bom). Mas:
  - app aberto há dias em segundo plano continua na versão antiga — não existe aviso "nova versão,
    toque para atualizar";
  - **não há controle de versão entre app e API**: celular antigo conversa com servidor novo sem
    ninguém perceber — o caso perigoso é o levantamento salvo **offline** numa versão e enviado
    depois do deploy, num formato que o servidor talvez não aceite mais;
  - **`@zxing/library@latest`** (leitor de código de barras) sem versão fixa: uma versão nova da
    biblioteca pode quebrar o scanner de todo mundo sem nenhum deploy nosso.
- **Fila offline e carrinho em `localStorage`**: espaço pequeno (~5 MB) e, no iPhone usado pelo
  Safari (sem instalar o ícone), os dados podem ser apagados depois de dias sem uso.
- **GitHub Pages**: sem versão de teste por PR, sem liberar por grupo, sem voltar versão num clique.

---

## 2. Escolha de plataforma

| Opção | Escala / manutenção | Rapidez para a versão nova chegar | Custo da mudança |
|---|---|---|---|
| **A. PWA com build (Vite)**, mesmo app dividido em módulos | Alta | **Imediata** (próxima abertura) | Baixo, aos poucos |
| B. PWA com framework (React/Vue/Svelte) | A mais alta com equipe | Imediata | Alto: reescrever 14 mil linhas |
| C. Capacitor (código web dentro de app de loja) | Alta | Pior: revisão da loja (ou atualização remota paga) | Médio |
| D. Nativo (Flutter/React Native) | Alta | Pior: duas lojas, usuário que não atualiza | Muito alto |

**Decisão proposta: A.** C só se o scanner (câmera nativa lê bem melhor em loja escura / etiqueta
amassada) ou o GPS em segundo plano virarem dor real. B só se entrar uma equipe de desenvolvimento.

---

## 3. Como a v2 é construída sem risco

A v2 fica num **repositório separado** (`appdb-v2`, privado), criado a partir de uma cópia deste
(com o histórico — dá para trazer correções daqui com `git merge`). Repositório separado sozinho
**não isola nada**: o que protege a produção são as regras abaixo.

### Regras que não podem ser quebradas

1. **Nunca usar o `DATABASE_URL` da produção na v2.** O `db.js` roda o `schema.sql` inteiro a cada
   subida do servidor — um servidor v2 apontado para o banco de produção aplicaria as mudanças de
   schema da v2 direto nos dados reais. A v2 usa um **projeto Supabase próprio**, com uma cópia
   dos dados (dump/restore), e uma cópia nova sempre que precisar de dado atualizado.
2. **Servidor próprio no Render** (serviço novo), com as mesmas variáveis, exceto
   `DATABASE_URL`, `ALLOWED_ORIGINS` (só o endereço da v2) e, se possível, chaves de API
   separadas (Gemini, radar-cnpj) para o consumo da v2 não esgotar o limite da produção.
3. **Frontend da v2 nunca aponta para a API de produção.** `API_BASE_URL_DEFAULT` (em
   `index.html`, `curva-abc.html`, `ficha-cnpj.html`) vem para a API da v2 no primeiro commit do
   repositório novo. O `keep-alive.yml` copiado passa a pingar a v2 (ou fica desligado).
4. **Login Google**: acrescentar o endereço da v2 nas "Origens JavaScript autorizadas" do mesmo
   Client ID (não mexe em nada da produção) — ou criar um Client ID de teste.
5. **Correção de bug de produção é feita aqui (`appdb`) primeiro** e depois levada para a v2
   (`git fetch producao && git merge producao/main` no repositório novo). Nunca o contrário: nada
   da v2 volta para cá antes da troca.
6. **A troca é um corte planejado**, não um merge: piloto numa região → migração do banco de
   produção com o `schema.sql` da v2 (testado antes na cópia) → apontar o domínio/Pages para a v2
   → manter a v1 no ar por algumas semanas como volta.

### Passos manuais (só o dono das contas consegue fazer)

- [ ] Criar o repositório **privado** `appdb-v2` vazio no GitHub (sem README) — a integração do
      Claude não tem permissão de criar repositório; depois disso a cópia é enviada daqui.
- [ ] Criar o projeto Supabase da v2 e copiar os dados (a string do "Session pooler" vai no Render).
- [ ] Criar o serviço no Render apontando para `appdb-v2`, com as variáveis da regra 2.
- [ ] Publicar o frontend da v2 (Cloudflare Pages ou Vercel — versão de teste por PR e rollback
      num clique; GitHub Pages também serve no começo).
- [ ] Autorizar o endereço da v2 no Google Cloud Console (regra 4).
- [ ] Conferir se `ALLOWED_ORIGINS` está definido no Render de **produção** — sem ele a API aceita
      qualquer origem (inclusive a v2).

---

## 4. Plano em fases (na v2)

### Fase 0 — decisões antes de código
- [ ] Dono do cliente vem do ERP (coluna Representante)? E quando o ERP troca o representante?
- [ ] Hierarquia: gestor → representantes; região por UF ou por lista?
- [ ] O que o gerente vê: só a equipe ou outras regiões também? Existe diretoria acima?
- [ ] A Cortag tem Google Workspace? (login "Interno")
- [ ] O ERP exporta sozinho (arquivo agendado, pasta, e-mail, API)?
- [ ] Orçamento mensal de infraestrutura.

### Fase 1 — frontend seguro (pequeno, fecha os riscos de perder dado)
- [ ] Versão fixa de todas as bibliotecas externas, começando pelo zxing; de preferência
      empacotadas junto do app.
- [ ] Controle de versão app ↔ API: o app manda a versão em cada chamada; o servidor responde
      "versão mínima X"; aviso "Nova versão disponível — toque para atualizar" (nunca no meio de
      um levantamento); itens da fila offline gravam a versão.
- [ ] Fila offline em IndexedDB, com armazenamento persistente pedido ao navegador.
- [ ] CI rodando `test/run_tests.js` em todo PR.

### Fase 2 — escopo de acesso (a base de tudo)
- [ ] Papéis: vendedor, gerente, admin. Usuário ligado a um código de representante e a um gestor.
- [ ] Importação grava Representante e Gestor (clientes e pedidos oficiais).
- [ ] Filtro central de escopo aplicado em **todas** as rotas, com testes "vendedor A não enxerga
      cliente do B".
- [ ] Sync só da carteira do vendedor.
- [ ] Importação restrita a admin (revisar a decisão atual de deixar aberta).
- [ ] Cadastro de usuários em lote; desligamento (revoga sessão, transfere carteira).

### Fase 3 — infraestrutura
- [ ] Render pago (sem hibernação) e Supabase Pro (backup diário).
- [ ] Monitoramento de erros (Sentry, plano gratuito) no servidor e no app.
- [ ] Ambiente de homologação e versão de teste por PR.
- [ ] Job noturno de fichas de CNPJ com trava no Postgres (advisory lock) para rodar uma vez só.

### Fase 4 — build e dados
- [ ] Vite: dividir o `index.html` em módulos por tela (Pedido, Levantamento, Orçamento, Clientes,
      Admin), arquivos com nome versionado, Admin carregado só por quem abre o Admin. Tela por
      tela, sem parar o app.
- [ ] Testes de tela com Playwright nos fluxos críticos (login, pedido, levantamento offline, PDF).
- [ ] Importação processada no servidor, com o arquivo inteiro e as mesmas regras de hoje
      (`paraDataISO`, recusa de valor corrompido etc.); ideal: o ERP deposita o relatório sozinho.
- [ ] Metas por vendedor, região e trimestre.
- [ ] Totais pré-calculados (faturamento por cliente × mês), atualizados após cada importação.

### Fase 5 — o que o gerente regional ganha
- [ ] Dashboard com filtro por equipe e por representante; ranking de entrada de pedidos.
- [ ] Clientes em risco de cair de faixa, por equipe.
- [ ] Cobertura de visitas (levantamentos + GPS — ver "Localização do cliente" no `CLAUDE.md`).
- [ ] Conversão de orçamento em pedido.

### Fase 6 — governança e implantação
- [ ] Registro de quem importou / alterou o quê.
- [ ] Política de retenção do GPS e dos dados de cliente (LGPD).
- [ ] Liberação por grupo (feature flag por região) e tela "Novidades".
- [ ] **Piloto**: uma região (~20 vendedores + 1 gerente) por 4–6 semanas antes dos 200 — é no
      piloto que aparecem cliente sem representante, representante trocado no ERP e clientes com
      o mesmo nome em regiões diferentes.

---

## 5. Custo e esforço (ordem de grandeza)

- Infraestrutura: **~US$ 50–100/mês** (Render US$ 7–25, Supabase Pro US$ 25, Gemini conforme uso;
  Cloudflare Pages/Vercel e Sentry no plano gratuito cabem nesse porte).
- Fases 1–2 são as críticas (algumas semanas). Fases 4–5 dependem de como o ERP exporta.
- Maior risco: a qualidade da coluna Representante/Gestor no ERP — se vier inconsistente, o
  escopo de acesso sai errado.
