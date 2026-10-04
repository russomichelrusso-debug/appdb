// Cortag Revolution Tools - importação automática dos relatórios pelo Gmail.
//
// Roda no Google Apps Script da conta que recebe os relatórios (russo2055),
// a cada 15 minutos: procura os e-mails da Cortag com planilha anexa e manda
// cada anexo pro servidor do app (POST /api/importacao-email/arquivo), que lê
// a planilha e publica sozinho - mesmo efeito de importar pelo Painel (⚙).
// Os avisos sem planilha (Pedido Bloqueado, Pedido de Venda à Vista) vão só
// com assunto + texto (POST /api/importacao-email/mensagem).
// O servidor NÃO recebe acesso à caixa de e-mail: só os anexos e textos que
// este script escolhe mandar.
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
  // e-mails sem planilha: vai o texto (o servidor lê pedido, cliente, motivo/valor)
  mensagens: [
    { remetente: 'noreply@cortag.com.br', assunto: /^\s*Pedido Bloqueado\b/i, busca: 'subject:"Pedido Bloqueado"' },
    { remetente: 'noreply@cortag.com.br', assunto: /Pedido de Venda [àa] Vista/i, busca: 'subject:"Pedido de Venda"' },
  ],
  maxProcessadosGuardados: 400,
  // o Google corta cada execução em 6 min, e cada relatório leva ~1-3 min no
  // servidor: depois de 3 min não começa outro arquivo (fica pra próxima rodada)
  tempoMaximoMs: 3 * 60 * 1000,
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
  const inicio = Date.now();
  const props = PropertiesService.getScriptProperties();
  const chave = chave_();
  const processados = JSON.parse(props.getProperty('PROCESSADOS') || '[]');
  const jaFeito = new Set(processados);
  const remetentes = Array.from(new Set(CONFIG.regras.map(r => r.remetente)));
  const periodo = `newer_than:${CONFIG.diasParaTras}d`;
  const consultas = [`from:(${remetentes.join(' OR ')}) has:attachment filename:xlsx ${periodo}`]
    .concat(CONFIG.mensagens.map(m => `from:${m.remetente} ${m.busca} ${periodo}`));
  const limite = new Date(Date.now() - CONFIG.diasParaTras * 86400000);

  // junta os e-mails novos e importa do MAIS ANTIGO pro mais novo - senão uma
  // Lista de Preços antiga podia sobrescrever a errata que chegou depois
  const fila = [];
  const naFila = new Set();
  consultas.forEach(consulta => GmailApp.search(consulta, 0, 50).forEach(thread => {
    thread.getMessages().forEach(msg => {
      const id = msg.getId();
      if (jaFeito.has(id) || naFila.has(id) || msg.getDate() < limite) return;
      const de = msg.getFrom().toLowerCase();
      const anexos = msg.getAttachments({ includeInlineImages: false })
        .filter(a => CONFIG.regras.some(r => de.indexOf(r.remetente) !== -1 && r.anexo.test(a.getName())));
      const ehMensagem = CONFIG.mensagens.some(m => de.indexOf(m.remetente) !== -1 && m.assunto.test(msg.getSubject()));
      if (anexos.length === 0 && !ehMensagem) { processados.push(id); jaFeito.add(id); return; }
      naFila.add(id);
      fila.push({ thread, msg, anexos, ehMensagem });
    });
  }));
  fila.sort((a, b) => a.msg.getDate() - b.msg.getDate());

  const salvar = () => props.setProperty('PROCESSADOS', JSON.stringify(processados.slice(-CONFIG.maxProcessadosGuardados)));
  salvar();
  let servidorAcordado = false;
  for (const item of fila) {
    if (Date.now() - inicio > CONFIG.tempoMaximoMs) {
      Logger.log('Tempo da rodada esgotado - o resto fica pra próxima (%s e-mail(s)).', fila.length - fila.indexOf(item));
      break;
    }
    if (!servidorAcordado) {
      if (!acordarServidor_()) break; // fora do ar: tenta tudo de novo na próxima rodada
      servidorAcordado = true;
    }
    let falhou = false;
    let tentarDeNovo = false;
    const resultados = item.anexos.length
      ? item.anexos.map(anexo => enviar_(chave, anexo, item.msg))
      : [enviarMensagem_(chave, item.msg)];
    for (const r of resultados) {
      if (r === 'tentar-de-novo') tentarDeNovo = true;
      else if (r === 'falhou') falhou = true;
    }
    if (tentarDeNovo) break; // mantém a ordem: o resto fica pra próxima rodada
    item.thread.addLabel(marcador_(falhou ? CONFIG.marcadorFalhou : CONFIG.marcadorImportado));
    processados.push(item.msg.getId());
    salvar(); // a cada e-mail: se a execução for cortada, o que já foi não volta
  }
}

// 'ok' | 'falhou' (planilha recusada - não adianta repetir) | 'tentar-de-novo'
function enviar_(chave, anexo, msg) {
  return postar_(chave, '/api/importacao-email/arquivo', anexo.getName(), {
    nome: anexo.getName(),
    arquivoBase64: Utilities.base64Encode(anexo.getBytes()),
    remetente: msg.getFrom(),
    assunto: msg.getSubject(),
    recebidoEm: msg.getDate().toISOString(),
    mensagemId: msg.getId(),
  });
}

// E-mail sem planilha (Pedido Bloqueado, Pedido de Venda à Vista): só o texto.
function enviarMensagem_(chave, msg) {
  return postar_(chave, '/api/importacao-email/mensagem', msg.getSubject(), {
    assunto: msg.getSubject(),
    texto: msg.getPlainBody().slice(0, 20000),
    remetente: msg.getFrom(),
    recebidoEm: msg.getDate().toISOString(),
    mensagemId: msg.getId(),
  });
}

function postar_(chave, caminho, rotulo, corpo) {
  let resp;
  try {
    resp = UrlFetchApp.fetch(CONFIG.urlServidor + caminho, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Chave-Importacao': chave },
      payload: JSON.stringify(corpo),
      muteHttpExceptions: true,
    });
  } catch (e) {
    Logger.log('Sem resposta do servidor (%s) - tento de novo na próxima rodada.', e);
    return 'tentar-de-novo';
  }
  const codigo = resp.getResponseCode();
  Logger.log('%s: %s %s', rotulo, codigo, resp.getContentText().slice(0, 300));
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
