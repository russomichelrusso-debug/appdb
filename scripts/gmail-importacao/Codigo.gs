// Cortag Revolution Tools - importação automática dos relatórios pelo Gmail.
//
// Roda no Google Apps Script da conta que recebe os relatórios (russo2055),
// a cada 15 minutos: procura os e-mails da Cortag com planilha anexa e manda
// cada anexo pro servidor do app (POST /api/importacao-email/arquivo), que lê
// a planilha e publica sozinho - mesmo efeito de importar pelo Painel (⚙).
// O servidor NÃO recebe acesso à caixa de e-mail: só os anexos que este
// script escolhe mandar.
//
// Instalação (uma vez): ver docs/IMPORTACAO-EMAIL.md
//  1. script.google.com (logado no russo2055) › Novo projeto › colar este arquivo;
//  2. Configurações do projeto › Propriedades do script › CHAVE = a chave da
//     importação (a mesma de IMPORTACAO_EMAIL_CHAVE no Render);
//  3. escolher a função "configurar" e tocar em Executar › autorizar.
//
// Resultado de cada e-mail fica num marcador do Gmail:
//  - "Cortag/Importado": entrou no app;
//  - "Cortag/Falhou": o app recusou a planilha (formato estranho, corrompida) -
//    importar na mão pelo Painel. Ninguém é avisado no app (decisão do usuário).
// Servidor dormindo/fora do ar: não marca nada e tenta de novo na próxima rodada.

const CONFIG = {
  urlServidor: 'https://appdb-z6uh.onrender.com',
  minutos: 15,
  diasParaTras: 7,
  marcadorImportado: 'Cortag/Importado',
  marcadorFalhou: 'Cortag/Falhou',
  // remetente + nome do anexo de cada relatório (o servidor confere de novo
  // o tipo pelas abas/colunas da planilha)
  regras: [
    { remetente: 'noreply@cortag.com.br', anexo: /^Repres-.*\.xlsx$/i }, // Carteira/Faturamento (todo dia)
    { remetente: 'noreply@cortag.com.br', anexo: /Classificatorio\.xlsx$/i }, // Classificatório
    { remetente: 'noreply@cortag.com.br', anexo: /^ESCE007-.*\.xlsx$/i }, // itens em falta = previsão de estoque
    { remetente: 'vendas@cortag.com', anexo: /LISTA PADR\S{1,2}O.*SUL SUDESTE.*\.xlsx$/i }, // Lista de Preços
  ],
  maxProcessadosGuardados: 400,
};

// Rodar uma vez: confere a chave, cria os marcadores e o agendamento de 15 min.
function configurar() {
  chave_();
  marcador_(CONFIG.marcadorImportado);
  marcador_(CONFIG.marcadorFalhou);
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'verificarEmails')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('verificarEmails').timeBased().everyMinutes(CONFIG.minutos).create();
  verificarEmails();
  Logger.log('Pronto: verificando o e-mail a cada %s minutos.', CONFIG.minutos);
}

function verificarEmails() {
  const props = PropertiesService.getScriptProperties();
  const chave = chave_();
  const processados = JSON.parse(props.getProperty('PROCESSADOS') || '[]');
  const jaFeito = new Set(processados);
  const remetentes = Array.from(new Set(CONFIG.regras.map(r => r.remetente)));
  const consulta = `from:(${remetentes.join(' OR ')}) has:attachment filename:xlsx newer_than:${CONFIG.diasParaTras}d`;
  const limite = new Date(Date.now() - CONFIG.diasParaTras * 86400000);

  // junta os e-mails novos e importa do MAIS ANTIGO pro mais novo - senão uma
  // Lista de Preços antiga podia sobrescrever a errata que chegou depois
  const fila = [];
  GmailApp.search(consulta, 0, 50).forEach(thread => {
    thread.getMessages().forEach(msg => {
      if (jaFeito.has(msg.getId()) || msg.getDate() < limite) return;
      const de = msg.getFrom().toLowerCase();
      const anexos = msg.getAttachments({ includeInlineImages: false })
        .filter(a => CONFIG.regras.some(r => de.indexOf(r.remetente) !== -1 && r.anexo.test(a.getName())));
      if (anexos.length === 0) { processados.push(msg.getId()); return; }
      fila.push({ thread, msg, anexos });
    });
  });
  fila.sort((a, b) => a.msg.getDate() - b.msg.getDate());

  let servidorAcordado = false;
  for (const item of fila) {
    if (!servidorAcordado) {
      if (!acordarServidor_()) break; // fora do ar: tenta tudo de novo na próxima rodada
      servidorAcordado = true;
    }
    let falhou = false;
    let tentarDeNovo = false;
    for (const anexo of item.anexos) {
      const r = enviar_(chave, anexo, item.msg);
      if (r === 'tentar-de-novo') tentarDeNovo = true;
      else if (r === 'falhou') falhou = true;
    }
    if (tentarDeNovo) break; // mantém a ordem: o resto fica pra próxima rodada
    item.thread.addLabel(marcador_(falhou ? CONFIG.marcadorFalhou : CONFIG.marcadorImportado));
    processados.push(item.msg.getId());
  }
  props.setProperty('PROCESSADOS', JSON.stringify(processados.slice(-CONFIG.maxProcessadosGuardados)));
}

// 'ok' | 'falhou' (planilha recusada - não adianta repetir) | 'tentar-de-novo'
function enviar_(chave, anexo, msg) {
  let resp;
  try {
    resp = UrlFetchApp.fetch(CONFIG.urlServidor + '/api/importacao-email/arquivo', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Chave-Importacao': chave },
      payload: JSON.stringify({
        nome: anexo.getName(),
        arquivoBase64: Utilities.base64Encode(anexo.getBytes()),
        remetente: msg.getFrom(),
        assunto: msg.getSubject(),
        recebidoEm: msg.getDate().toISOString(),
        mensagemId: msg.getId(),
      }),
      muteHttpExceptions: true,
    });
  } catch (e) {
    Logger.log('Sem resposta do servidor (%s) - tento de novo na próxima rodada.', e);
    return 'tentar-de-novo';
  }
  const codigo = resp.getResponseCode();
  Logger.log('%s: %s %s', anexo.getName(), codigo, resp.getContentText().slice(0, 300));
  if (codigo === 401) throw new Error('O servidor recusou a CHAVE - confira a propriedade CHAVE do script e IMPORTACAO_EMAIL_CHAVE no Render.');
  if (codigo >= 200 && codigo < 300) return 'ok';
  if (codigo === 422) return 'falhou';
  return 'tentar-de-novo'; // 5xx, 429 (limite), 408...
}

// O Render gratuito dorme sem uso: chama /health e espera acordar (até ~1,5 min).
function acordarServidor_() {
  for (let i = 0; i < 4; i++) {
    try {
      const r = UrlFetchApp.fetch(CONFIG.urlServidor + '/health', { muteHttpExceptions: true });
      if (r.getResponseCode() === 200) return true;
    } catch (e) { /* ainda acordando */ }
    Utilities.sleep(20000);
  }
  Logger.log('Servidor não respondeu - tento de novo na próxima rodada.');
  return false;
}

function chave_() {
  const chave = PropertiesService.getScriptProperties().getProperty('CHAVE');
  if (!chave) throw new Error('Falta a CHAVE: Configurações do projeto › Propriedades do script › adicionar "CHAVE".');
  return chave.trim();
}

function marcador_(nome) {
  return GmailApp.getUserLabelByName(nome) || GmailApp.createLabel(nome);
}
