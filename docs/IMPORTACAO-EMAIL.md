# Importação automática dos relatórios pelo Gmail

Os relatórios que a Cortag manda por e-mail pro **russo2055@gmail.com** entram no app sozinhos,
sem abrir o Painel:

| Relatório | Remetente | Anexo | Quando chega |
|---|---|---|---|
| Carteira/Faturamento | noreply@cortag.com.br | `Repres-*.xlsx` | todo dia, de madrugada |
| Classificatório | noreply@cortag.com.br | `DD.MM.AAAA_..._Classificatorio.xlsx` | ~1 vez por mês |
| Itens em falta (previsão de estoque) | noreply@cortag.com.br | `ESCE007-*.xlsx` | ~1 vez por semana |
| Lista de Preços | vendas@cortag.com | `... LISTA PADRÃO ... SUL SUDESTE ... .xlsx` | quando muda |

E dois avisos **sem planilha** (o script manda só o assunto e o texto do e-mail, pra
`POST /api/importacao-email/mensagem`):

| Aviso | Remetente | Assunto | O que acontece no app |
|---|---|---|---|
| Pedido bloqueado | noreply@cortag.com.br | `Pedido Bloqueado 00677375` | selo "⛔ Bloqueado · motivo" no pedido (histórico do cliente) e no card do cliente (Pedido/Levantamento); some quando o relatório traz o pedido faturado (ou em 30 dias) |
| Pedido à vista | noreply@cortag.com.br | `Pedido de Venda à Vista - Cortag` | selo "À vista · aguardando pagamento" no pedido no mesmo dia, sem esperar o relatório da madrugada |

Os dois geram um aviso por pedido (faixa de novidades + push no celular em dia útil, 7h–20h). E-mail
com mais de 2 dias (ex.: a 1ª rodada, que olha 7 dias pra trás) grava o selo sem push; pedido à vista
mais velho que o último relatório oficial importado é ignorado (o relatório já traz a foto certa).

Como funciona: um script do Google (`scripts/gmail-importacao/Codigo.gs`) roda **na própria conta
do Gmail**, a cada 15 minutos, e manda só esses anexos pro servidor do app
(`POST /api/importacao-email/arquivo`, com a chave secreta). O servidor reconhece o tipo pela
planilha, importa pelo mesmo caminho do Painel (⚙ › Importar arquivo) e avisa todo mundo
(faixa de novidades + push no celular). O servidor **não** recebe acesso à caixa de e-mail.

No Gmail, cada e-mail tratado ganha um marcador:

- **Cortag/Importado** — entrou no app;
- **Cortag/Falhou** — o app recusou a planilha (formato estranho, corrompida, lista de outra
  região). Importar na mão pelo Painel. Ninguém é avisado no app.
- **Cortag/Nao autenticado** — o e-mail diz vir da Cortag, mas o Gmail não confirmou. **Não vai
  pro app** (ver "Segurança" abaixo).
- E-mail com mais de um anexo em que parte entrou e parte foi recusada ganha **os dois** marcadores
  (Importado e Falhou); a execução diz quais.
- "De:" que cita um remetente da Cortag mas fora do formato `Nome <endereço>` / `endereço` (ex.:
  `noreply@cortag.com.br (Cortag)`) fica de fora e aparece como "Ignorado - o endereço não é
  exatamente o da Cortag" em Execuções; o `conferirAutenticacao` lista esses como "OUTRO ENDEREÇO".

## Segurança: só e-mail que é mesmo da Cortag

O app publica direto, inclusive preços, então um e-mail falso não pode entrar. O campo "De:" se
falsifica à vontade — `"vendas@cortag.com" <qualquer@outro.com>` aparece como "vendas@cortag.com".
Por isso o script só manda um e-mail pro app quando:

1. o **endereço** (o que fica entre `< >`) é exatamente o remetente da tabela acima; e
2. o **Gmail autenticou o domínio** desse endereço: no cabeçalho `Authentication-Results` que o
   Gmail escreve ao receber, `dmarc=pass` (header.from = o domínio) ou `dkim=pass` assinado pelo
   domínio. Conferido em 05/10/2026 com o `conferirAutenticacao` (21 de 21 e-mails reais OK):
   a vendas@cortag.com passa por `dkim=pass header.i=@cortag.com` e `dmarc=pass (p=QUARANTINE)`;
   a noreply@cortag.com.br passa **só pelo DMARC** (`dmarc=pass header.from=cortag.com.br`) — o
   DKIM dela é assinado por `cortagind.onmicrosoft.com`, que não é o domínio do remetente.
   O que vem entre aspas e entre parênteses nesse cabeçalho (o endereço de envio, escolhido por
   quem manda) é ignorado na leitura, e cada resultado só vale inteiro no formato
   `metodo=resultado chave.sub=valor …` (pedaço solto no meio ou chave repetida = não vale).

O servidor confere de novo o remetente de cada tipo (Lista de Preços só de vendas@cortag.com, o
resto só de noreply@cortag.com.br) e recusa (422) o que vier de outro endereço.

O mesmo arquivo nunca é importado duas vezes. O Painel (⚙ › status) mostra a linha
**"Importação por e-mail"** com o último arquivo de cada tipo.

## Instalar (uma vez, ~5 minutos)

1. Entre em <https://script.google.com> **logado no russo2055@gmail.com** › **Novo projeto**.
2. Apague o conteúdo do arquivo `Código.gs` e cole todo o conteúdo de
   `scripts/gmail-importacao/Codigo.gs`. Dê um nome ao projeto (ex.: "Cortag importação").
3. ⚙ **Configurações do projeto** › **Propriedades do script** › **Adicionar propriedade**:
   - Propriedade: `CHAVE`
   - Valor: a chave da importação (a mesma de `IMPORTACAO_EMAIL_CHAVE` no Render).
4. **Antes de ligar**, escolha a função **`conferirAutenticacao`** na barra de cima e toque em
   **Executar** (autorize como no passo 5). Em **Execuções** › o log mostra cada e-mail dos
   últimos 30 dias de cada remetente com **OK** ou **NÃO** e uma linha de resumo por remetente. Se
   algum e-mail verdadeiro da Cortag der **NÃO**, não siga: esses e-mails ficariam de fora da
   importação (mande o log pra quem mantém o app).
   Depois, escolha a função **`configurar`** e toque em **Executar**.
5. O Google pede autorização: escolha a conta russo2055 › "Avançado" › "Acessar Cortag
   importação (não seguro)" › **Permitir**. (O aviso aparece porque o script é seu, não
   publicado; ele só lê o Gmail, cria os marcadores e chama o servidor do app.)
6. Pronto: o `configurar` já faz a primeira verificação (e-mails dos últimos 7 dias, do mais
   antigo pro mais novo) e agenda as próximas a cada 15 minutos. O resultado de cada execução
   fica em **Execuções** (menu da esquerda).

## Problemas comuns

- **"O servidor recusou a CHAVE"** nas execuções: a propriedade `CHAVE` não bate com
  `IMPORTACAO_EMAIL_CHAVE` no Render. Copie de novo, sem espaços.
- **E-mail marcado "Cortag/Falhou"**: veja o motivo em Execuções (ou na tabela
  `importacoes_email`, coluna `erro`) e importe o anexo pelo Painel.
- **"Exceeded maximum execution time"** (versão antiga do script): o Google corta cada execução em
  6 min e cada relatório leva ~1–3 min no servidor. O script atual para de pegar arquivo novo depois
  de 3 min e salva o progresso a cada e-mail; se aparecer, cole de novo a versão atual do
  `Codigo.gs`. Nada se perde: o arquivo cortado termina no servidor e, na rodada seguinte, volta
  como "já importado".
- **E-mail verdadeiro marcado "Cortag/Nao autenticado"**: a Cortag mudou o jeito de mandar e o
  Gmail não confirma mais o domínio. Rode `conferirAutenticacao` e veja a linha
  `Authentication-Results` do e-mail no log; enquanto isso, importe o anexo pelo Painel.
- **Atualizar o script** (versão nova do `Codigo.gs`): no script.google.com, apague o conteúdo e
  cole o novo; rode `conferirAutenticacao` e depois `configurar` (cria o marcador novo, se houver).
- **Avisos de pedido bloqueado/à vista não chegam**: o script colado no Google é anterior a
  10/2026 — cole de novo a versão atual do `Codigo.gs` (não precisa rodar o `configurar` de novo).
- **Servidor dormindo** (Render gratuito): o script espera ele acordar; se não acordar, tenta
  de novo na rodada seguinte, sem marcar o e-mail.
- **Servidor responde com erro** (5xx) pro mesmo e-mail: tenta de novo nas rodadas seguintes e, na
  4ª vez seguida (~1 h), marca "Cortag/Falhou" e segue com os próximos — um arquivo que sempre dá
  erro não trava mais o relatório diário nem os avisos de pedido. Importar esse anexo pelo Painel.
  (Precisa do `Codigo.gs` de 10/2026 ou mais novo.)
- **Trocar a chave**: gerar outra (`openssl rand -hex 32`), atualizar `IMPORTACAO_EMAIL_CHAVE`
  no Render e a propriedade `CHAVE` do script.
- **Parar**: no script.google.com, menu **Acionadores** (relógio) › excluir o acionador de
  `verificarEmails`.
