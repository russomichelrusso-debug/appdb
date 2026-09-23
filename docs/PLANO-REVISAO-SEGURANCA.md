# Plano de correções — revisão de segurança e bugs

> Revisão feita em 23/09/2026 sobre o commit `490d7c9` (branch `main`).
> Escopo: backend inteiro (`server.js`, `db.js`, `auth-utils.js`, `middleware/`, `routes/`, `schema.sql`) e varredura dirigida no frontend (`index.html`, `ficha-cnpj.html`, `curva-abc.html`, `sw.js`).
> Os números de linha são desse commit — podem ter mudado desde então. Na dúvida, busque pelo trecho citado.

Marque cada item com `[x]` quando for corrigido.

## Pontos já corretos (não mexer)

- Todo o SQL usa parâmetros (`$1`, `$2`…). As interpolações `${...}` nas queries são só constantes internas, então não há SQL injection.
- A maior parte do HTML passa por `escapeHtml`.
- O service worker não guarda respostas da `/api` em cache.
- A conexão SSL com o banco verifica o certificado (`rejectUnauthorized: true`).
- A chave do Gemini vai no header, não na URL.

---

## Ordem sugerida de execução

| Fase | Itens | Por quê |
|---|---|---|
| 1 | S1, S3, S4 | Risco de invasão, roubo de sessão e queda do servidor |
| 2 | S2, S6, B1 | Permissões e pedidos perdidos sem aviso |
| 3 | B3, B4, S7 a S11 | Importações que falham ou gravam lixo, vazamento de erro, timeouts |
| 4 | Resto | Melhorias de consistência |

---

## 🔴 Segurança: alta prioridade

### [ ] S1. Atualizar a biblioteca `xlsx` (vulnerável) e parar de travar o servidor na leitura
- **Onde:** `package.json:15`, `routes/catalogoPrecos.js:53` e `:181`
- **Problema:** a versão `0.18.5` do npm tem falhas conhecidas (CVE-2023-30533, prototype pollution, e CVE-2024-22363, ReDoS) e lê no servidor arquivos enviados por usuários. A leitura é síncrona: uma planilha de até 25 MB trava o Node inteiro enquanto é processada.
- **Como corrigir:**
  - Instalar a versão 0.20.3 ou mais nova pelo CDN oficial do SheetJS (`npm i https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`), porque o npm parou na 0.18.5. Outra opção é trocar por `exceljs`.
  - Limitar o tamanho do arquivo aceito.
  - Se possível, processar a planilha em um `worker_thread`.

### [ ] S2. Exigir admin (ou um papel "importador") nas rotas que alteram dados de todos
- **Onde:**
  - `routes/catalogoPrecos.js:175`: `POST /importar` troca os preços do catálogo inteiro.
  - `routes/produtos.js:38`: `POST /sync` renomeia qualquer produto.
  - `routes/clientes.js:103`: `POST /import` renomeia clientes em lote, casando pelo CNPJ.
  - `routes/previsaoEstoque.js:21`: `POST /importar` apaga e substitui a previsão inteira.
  - `routes/pedidosOficiais.js:253`: `POST /importar` cria clientes e altera o classificatório.
  - `routes/auth.js:110`: `POST /usuarios` deixa qualquer usuário cadastrar novos usuários.
- **Problema:** basta uma conta de vendedor comprometida para corromper o catálogo e o faturamento. Os comentários dizem que parte disso foi "decisão explícita", então é preciso decidir de novo.
- **Como corrigir:** adicionar `if (!req.usuario?.is_admin) return res.status(403)…` ou criar a coluna `usuarios.pode_importar`. Registrar em log quem importou o quê.

### [ ] S3. Corrigir o XSS armazenado pelo código do produto (`p.c`)
- **Onde:** cerca de 30 ocorrências de `${p.c}` sem `escapeHtml` no `index.html`, por exemplo `:5518`, `:5620`, `:5621`, `:7002` e `:7004`, tanto em texto quanto em atributos `data-*`.
- **Problema:** o código do produto vem da planilha importada, que qualquer usuário pode enviar (ver S2). Um código como `"><img src=x onerror=...>` roda JavaScript no aparelho de todos os vendedores. O token de sessão fica no `localStorage` (`index.html:8372`) e vale por 90 dias, então um XSS consegue roubá-lo.
- **Como corrigir:**
  - Trocar todas as ocorrências por `${escapeHtml(p.c)}`. Para listar: `grep -n '\${p\.c}' index.html`.
  - No servidor, validar o formato do código na importação, por exemplo com `^[A-Za-z0-9._-]{1,30}$`.
  - Adicionar o atributo `integrity` (SRI) no `<script>` do `html2canvas` (`index.html:4882`).
  - Adicionar uma CSP via `<meta http-equiv="Content-Security-Policy">`.

### [ ] S4. Evitar que o servidor caia com erros assíncronos não tratados
- **Onde:** `const client = await pool.connect()` está **fora** do `try` em:
  - `routes/pedidos.js:68` e `:179`
  - `routes/levantamentos.js:32`
  - `routes/clientes.js:196` e `:284`
  - `routes/previsaoEstoque.js:25`
  - `routes/pedidosOficiais.js:64` e `:261`
  - `routes/clientesClassificatorio.js:527`

  Além disso, o `await client.query('ROLLBACK')` dentro dos `catch` pode lançar erro de novo.
- **Problema:** o Express 4 não captura promises rejeitadas, e no Node 15 ou mais novo uma rejeição não tratada **derruba o processo**. Pool esgotado ou banco fora do ar vira queda do servidor.
- **Como corrigir:**
  - Colocar o `pool.connect()` dentro do `try`.
  - Envolver o ROLLBACK em um `try/catch` próprio.
  - Adicionar um wrapper `asyncHandler` (ou o pacote `express-async-errors`) e um middleware de erro global no `server.js`.

### [ ] S5. Endurecer o login com Google
- **Onde:** `routes/auth.js:36-58`
- **Problemas:**
  - A busca é `WHERE email = $1 OR google_sub = $2` e usa `rows[0]` sem conferir se o `google_sub` gravado bate com o recebido. Se o e-mail for reatribuído a outra pessoa (comum em Workspace), a outra conta entra. Se o e-mail for de um usuário e o `sub` de outro, a linha escolhida é arbitrária.
  - Com o banco vazio (primeiro deploy ou banco resetado), **qualquer conta Google** vira admin. Dois logins ao mesmo tempo podem criar dois admins.
- **Como corrigir:**
  - Recusar o login quando `usuario.google_sub` existir e for diferente de `google.sub`.
  - Buscar primeiro por `google_sub` e só depois por e-mail, entre usuários com `google_sub IS NULL`.
  - Definir o admin inicial por variável de ambiente (`ADMIN_EMAIL`), ou fazer a checagem e a inserção em uma transação com `LOCK TABLE usuarios`.

### [ ] S6. Impedir que qualquer usuário sobrescreva um pedido existente
- **Onde:** `routes/pedidos.js:53-65`
- **Problema:** basta mandar o mesmo `numero_cotacao` com um `pdf_modificado_em` no futuro para substituir cliente, vendedor e itens de um pedido já gravado.
- **Como corrigir:** gravar quem criou o pedido (`pedidos.usuario_id`) e só deixar o autor ou um admin atualizar. Recusar `pdf_modificado_em` maior que `now()`.

---

## 🟠 Segurança: média e baixa prioridade

### [ ] S7. Limite de body grande aceito antes da autenticação
- **Onde:** `server.js:39`, com `express.json({ limit: '25mb' })` global.
- **Problema:** até as rotas públicas `/api/auth/*` aceitam 25 MB, o que abre espaço para DoS.
- **Como corrigir:** limite global pequeno (`1mb`) e `express.json({ limit: '25mb' })` apenas na rota `/api/catalogo-precos/importar`, depois do `requireAuth`.

### [ ] S8. Mensagens internas do banco vazando para o cliente
- **Onde:** concatenação de `' + e.message'` em:
  - `routes/produtos.js:64`
  - `routes/fichasTecnicas.js:53`
  - `routes/codigosProduto.js:54`
  - `routes/previsaoEstoque.js:47`
  - `routes/catalogoPrecos.js:219`
  - `routes/pedidosOficiais.js:353`
  - `routes/pedidos.js:120`
  - `routes/levantamentos.js:58`
  - `routes/assistente.js:93`
  - `routes/radarCnpj.js:176`
- **Problema:** expõe nomes de tabela e de constraint. Um `id` não numérico em `/:id` vira erro 500 com a mensagem do Postgres.
- **Como corrigir:** mensagem genérica para o cliente e o detalhe só no `console.error`. Validar ids com `Number.isInteger(Number(id))` e devolver 400 quando inválido. Manter apenas as mensagens de validação criadas por nós, como "Produto X não encontrado".

### [ ] S9. `fetch` para serviços externos sem timeout
- **Onde:** `auth-utils.js:21`, `routes/assistente.js:14`, `routes/radarCnpj.js:17`
- **Problema:** se o Google, o Gemini ou o radar-cnpj travarem, a requisição fica presa indefinidamente.
- **Como corrigir:** `fetch(url, { ..., signal: AbortSignal.timeout(8000) })`.

### [ ] S10. Sem limite de uso nas APIs externas ou pagas
- **Onde:** `routes/assistente.js:34`, `routes/radarCnpj.js:180` e `:194`
- **Problema:** um usuário logado consegue esgotar a cota do Gemini e sobrecarregar o radar-cnpj. O campo `texto` não tem limite de tamanho.
- **Como corrigir:** `express-rate-limit` por usuário (`keyGenerator: req => req.usuario.id`) e recusar `texto` com mais de 500 caracteres.

### [ ] S11. Tokens de sessão guardados em texto puro
- **Onde:** `schema.sql:100` (tabela `sessoes`), `routes/auth.js:62`, `middleware/auth.js:12`
- **Problema:** quem vazar o banco consegue usar as sessões ativas. Elas duram 90 dias.
- **Como corrigir:** guardar `sha256(token)` e comparar pelo hash. Considerar sessões mais curtas com renovação automática.

### [ ] S12. CORS aberto para qualquer origem
- **Onde:** `server.js:29`
- **Problema:** o risco é baixo porque a autenticação é por header Bearer, mas qualquer site pode chamar a API com um token roubado.
- **Como corrigir:** restringir `Access-Control-Allow-Origin` ao domínio do GitHub Pages, usando uma lista vinda de variável de ambiente.

### [ ] S13. Qualquer usuário exclui clientes sem histórico
- **Onde:** `routes/clientes.js:263`
- **Ação:** confirmar se é intencional. Se não for, exigir admin.

---

## 🐞 Bugs

### [ ] B1. Pedido perdido sem aviso quando há qualquer erro de duplicidade
- **Onde:** `routes/pedidos.js:115-118`
- **Problema:** qualquer erro `23505` vira `{ ja_existia: true }`, e o app descarta o pedido. Isso inclui corrida ao criar vendedor, produto ou cliente, e não só cotação duplicada.
- **Como corrigir:** só tratar como duplicado quando `e.constraint === 'idx_pedidos_numero_cotacao'`. Nos `acharOuCriar*` (`pedidos.js:6`, `levantamentos.js:5`, `clientMatcher.js:65`), usar `INSERT ... ON CONFLICT DO NOTHING RETURNING id` e, se não voltar nada, fazer `SELECT`.

### [ ] B2. Checagem de cotação duplicada fora da transação
- **Onde:** `routes/pedidos.js:53-66`
- **Problema:** duas atualizações ao mesmo tempo da mesma cotação podem apagar e reinserir itens em paralelo e deixar itens duplicados.
- **Como corrigir:** mover a busca para dentro da transação, com `SELECT ... FOR UPDATE`.

### [ ] B3. O texto `"undefined"` gravado como dado na importação oficial
- **Onde:** `routes/pedidosOficiais.js:309-311`
- **Problema:** `String(it.cliente_codigo_oficial)` com o campo ausente grava o texto `"undefined"`, e o `NOT NULL` não impede. O mesmo vale para `nr_pedido` e `codigo_sku`.
- **Como corrigir:** filtrar as linhas sem esses campos antes do `deduplicarItensOficiais` e informar quantas foram descartadas.

### [ ] B4. Importação inteira falha com item repetido no mesmo lote
- **Onde:**
  - `routes/produtos.js:51` (SKU repetido)
  - `routes/clientes.js:115` (CNPJ repetido na planilha)
  - `routes/previsaoEstoque.js:29` (violação de chave primária)
- **Problema:** `ON CONFLICT DO UPDATE` não aceita a mesma chave duas vezes no mesmo comando ("cannot affect row a second time").
- **Como corrigir:** deduplicar em memória antes, com um `Map` pela chave e mantendo a última ocorrência, como já é feito em `deduplicarItensOficiais`.

### [ ] B5. Cliente duplicado por diferença de formatação do CNPJ
- **Onde:** `routes/clientes.js:84-91`
- **Problema:** a comparação usa o documento como veio, sem normalizar, e grava sem `formatarDocumento`. Assim `12345678000199` e `12.345.678/0001-99` viram dois clientes. Uma corrida entre dois cadastros gera erro 500.
- **Como corrigir:** comparar com `regexp_replace(documento, '\D', '', 'g')`, como faz o `clientMatcher`. Gravar com `formatarDocumento` e tratar o `23505` devolvendo o cliente existente.

### [ ] B6. Mesclar clientes perde o histórico oficial e alguns campos
- **Onde:** `routes/clientes.js:190-256`
- **Problemas:**
  - Se os dois clientes têm `codigo_oficial` diferente, o do removido some (`:222`). Os `pedidos_oficiais_itens` dele ficam órfãos e somem da ficha.
  - `matriz_grupo`, `classificatorio_pic` e `classificatorio_vl_acordo` não são copiados.
  - `manter_id === remover_id` (`:194`) compara tipos diferentes (`"5"` vs `5`).
- **Como corrigir:** bloquear ou pedir confirmação quando os dois tiverem `codigo_oficial` diferente. Incluir os campos que faltam no `UPDATE`. Comparar com `Number()`.

### [ ] B7. Preço negativo e perda de dados nos produtos promocionais
- **Onde:** `routes/produtosPromocionais.js:36`, `:61` e `:80`
- **Problemas:**
  - `descontoPct` acima de 100 gera preço negativo.
  - A lista `produtos_promocionais` é lida, alterada e gravada sem lock, então duas execuções ao mesmo tempo perdem itens.
- **Como corrigir:** validar `0 <= descontoPct < 100` e fazer leitura e gravação em uma transação com `SELECT ... FOR UPDATE`.

### [ ] B8. O catálogo "substitui" mas não remove produtos, e o campo `emb` quebra a importação
- **Onde:** `routes/catalogoPrecos.js:173-221`
- **Problemas:**
  - O comentário diz que substitui o catálogo, mas a gravação é só upsert. Produtos que saíram da planilha continuam com o preço antigo.
  - `$3::int[]` faz a importação toda falhar se `emb` vier decimal ou como texto.
- **Como corrigir:** em uma transação, apagar os produtos que não vieram na planilha (`DELETE ... WHERE codigo_sku <> ALL($1)`) e gravar `emb` como `Math.round(Number(emb)) || 1`.

### [ ] B9. Importar o classificatório apaga dados já definidos
- **Onde:** `routes/clientesClassificatorio.js:547-556`
- **Problemas:**
  - `matriz_grupo = $2` com `it.matrizGrupo || null` limpa o grupo já definido quando a coluna vem vazia.
  - `vlAcordo || null` transforma `0` em `null`.
- **Como corrigir:** `matriz_grupo = COALESCE($2, matriz_grupo)`, se esse for o comportamento desejado, e `it.vlAcordo ?? null`.

### [ ] B10. Contagem de criados e atualizados errada em `/produtos/sync`
- **Onde:** `routes/produtos.js:48-61`
- **Problema:** usa a diferença de `COUNT(*)` antes e depois. Com importações simultâneas o número sai errado.
- **Como corrigir:** `RETURNING (xmax = 0) AS inserted`, como já é feito em `clientes/import`.

### [ ] B11. Corrida ao excluir o último admin
- **Onde:** `routes/auth.js:150-158`
- **Problema:** a contagem e o `DELETE` não estão na mesma transação. Duas exclusões ao mesmo tempo podem deixar o sistema sem nenhum admin. A probabilidade é baixa.
- **Como corrigir:** fazer as duas operações em uma transação com `SELECT ... FOR UPDATE` nos admins.

---

## Observações gerais

- Os testes (`node test/run_tests.js`) precisam de `npm install` antes de rodar. Vale rodá-los depois de cada fase.
- Os arquivos `mudancas.patch` e `produtos_sem_ean13.csv` na raiz parecem sobras. Avaliar se devem continuar versionados.
