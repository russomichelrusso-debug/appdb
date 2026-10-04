# Importação automática dos relatórios pelo Gmail

Os relatórios que a Cortag manda por e-mail pro **russo2055@gmail.com** entram no app sozinhos,
sem abrir o Painel:

| Relatório | Remetente | Anexo | Quando chega |
|---|---|---|---|
| Carteira/Faturamento | noreply@cortag.com.br | `Repres-*.xlsx` | todo dia, de madrugada |
| Classificatório | noreply@cortag.com.br | `DD.MM.AAAA_..._Classificatorio.xlsx` | ~1 vez por mês |
| Itens em falta (previsão de estoque) | noreply@cortag.com.br | `ESCE007-*.xlsx` | ~1 vez por semana |
| Lista de Preços | vendas@cortag.com | `... LISTA PADRÃO ... SUL SUDESTE ... .xlsx` | quando muda |

Como funciona: um script do Google (`scripts/gmail-importacao/Codigo.gs`) roda **na própria conta
do Gmail**, a cada 15 minutos, e manda só esses anexos pro servidor do app
(`POST /api/importacao-email/arquivo`, com a chave secreta). O servidor reconhece o tipo pela
planilha, importa pelo mesmo caminho do Painel (⚙ › Importar arquivo) e avisa todo mundo
(faixa de novidades + push no celular). O servidor **não** recebe acesso à caixa de e-mail.

No Gmail, cada e-mail tratado ganha um marcador:

- **Cortag/Importado** — entrou no app;
- **Cortag/Falhou** — o app recusou a planilha (formato estranho, corrompida, lista de outra
  região). Importar na mão pelo Painel. Ninguém é avisado no app.

O mesmo arquivo nunca é importado duas vezes. O Painel (⚙ › status) mostra a linha
**"Importação por e-mail"** com o último arquivo de cada tipo.

## Instalar (uma vez, ~5 minutos)

1. Entre em <https://script.google.com> **logado no russo2055@gmail.com** › **Novo projeto**.
2. Apague o conteúdo do arquivo `Código.gs` e cole todo o conteúdo de
   `scripts/gmail-importacao/Codigo.gs`. Dê um nome ao projeto (ex.: "Cortag importação").
3. ⚙ **Configurações do projeto** › **Propriedades do script** › **Adicionar propriedade**:
   - Propriedade: `CHAVE`
   - Valor: a chave da importação (a mesma de `IMPORTACAO_EMAIL_CHAVE` no Render).
4. Volte ao editor, escolha a função **`configurar`** na barra de cima e toque em **Executar**.
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
- **Servidor dormindo** (Render gratuito): o script espera ele acordar; se não acordar, tenta
  de novo na rodada seguinte, sem marcar o e-mail.
- **Trocar a chave**: gerar outra (`openssl rand -hex 32`), atualizar `IMPORTACAO_EMAIL_CHAVE`
  no Render e a propriedade `CHAVE` do script.
- **Parar**: no script.google.com, menu **Acionadores** (relógio) › excluir o acionador de
  `verificarEmails`.
