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
//    importar na mão pelo Painel. Ninguém é avisado no app (decisão do usuário);
//  - "Cortag/Nao autenticado": o e-mail diz vir da Cortag mas o Gmail não
//    confirmou (DKIM/DMARC) - NÃO é mandado pro app. Ver "Segurança" abaixo.
// Servidor dormindo/fora do ar: não marca nada e tenta de novo na próxima rodada.
// Servidor que RESPONDE com erro (5xx) pro mesmo e-mail: tenta de novo nas
// próximas rodadas e, na 4ª vez (~1 h), desiste dele ("Cortag/Falhou") pra não
// travar a fila - senão o relatório diário e os pedidos bloqueados que
// chegassem depois ficavam parados atrás dele pra sempre.
//
// Segurança: o app publica direto (inclusive preços), então só vale e-mail que
// é mesmo da Cortag. O "De:" se falsifica à vontade ("vendas@cortag.com"
// <qualquer@outro.com>), então: (1) o endereço tem que ser EXATAMENTE o da
// regra e (2) o Gmail tem que ter autenticado o domínio dele - DMARC ou DKIM
// "pass" do próprio domínio no cabeçalho Authentication-Results que o Gmail
// põe por cima de tudo ao receber. Pra conferir os e-mails reais antes de
// valer: rodar a função "conferirAutenticacao" (ver docs/IMPORTACAO-EMAIL.md).

const CONFIG = {
  urlServidor: 'https://appdb-z6uh.onrender.com',
  minutos: 15,
  diasParaTras: 7,
  marcadorImportado: 'Cortag/Importado',
  marcadorFalhou: 'Cortag/Falhou',
  marcadorNaoAutenticado: 'Cortag/Nao autenticado',
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
  // e-mail com erro do servidor (5xx) nesta quantidade de rodadas seguidas:
  // desiste dele e segue a fila
  maxTentativasErroServidor: 4,
  // o Google corta cada execução em 6 min, e cada relatório leva ~1-3 min no
  // servidor: depois de 3 min não começa outro arquivo (fica pra próxima rodada)
  tempoMaximoMs: 3 * 60 * 1000,
};

// Rodar uma vez: confere a chave, cria os marcadores e o agendamento de 15 min.
function configurar() {
  chave_();
  marcador_(CONFIG.marcadorImportado);
  marcador_(CONFIG.marcadorFalhou);
  marcador_(CONFIG.marcadorNaoAutenticado);
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
      const de = enderecoDe_(msg.getFrom());
      const anexos = msg.getAttachments({ includeInlineImages: false })
        .filter(a => CONFIG.regras.some(r => de === r.remetente && r.anexo.test(a.getName())));
      const ehMensagem = CONFIG.mensagens.some(m => de === m.remetente && m.assunto.test(msg.getSubject()));
      if (anexos.length === 0 && !ehMensagem) { processados.push(id); jaFeito.add(id); return; }
      if (!autenticadoPeloGmail_(cabecalhos_(msg), de)) {
        Logger.log('NÃO autenticado (não vai pro app): "%s" de %s', msg.getSubject(), msg.getFrom());
        thread.addLabel(marcador_(CONFIG.marcadorNaoAutenticado));
        processados.push(id); jaFeito.add(id);
        return;
      }
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
    let erroServidor = false;
    const resultados = item.anexos.length
      ? item.anexos.map(anexo => enviar_(chave, anexo, item.msg))
      : [enviarMensagem_(chave, item.msg)];
    for (const r of resultados) {
      if (r === 'tentar-de-novo') tentarDeNovo = true;
      else if (r === 'erro-servidor') erroServidor = true;
      else if (r === 'falhou') falhou = true;
    }
    if (tentarDeNovo) break; // mantém a ordem: o resto fica pra próxima rodada
    if (erroServidor) {
      const tentativas = contarTentativa_(props, item.msg.getId());
      if (tentativas < CONFIG.maxTentativasErroServidor) {
        Logger.log('Erro do servidor em "%s" (%s de %s) - tento de novo na próxima rodada.', item.msg.getSubject(), tentativas, CONFIG.maxTentativasErroServidor);
        break; // mantém a ordem
      }
      Logger.log('Erro do servidor em "%s" %s vezes seguidas - desisto dele e sigo a fila.', item.msg.getSubject(), tentativas);
      falhou = true;
    }
    item.thread.addLabel(marcador_(falhou ? CONFIG.marcadorFalhou : CONFIG.marcadorImportado));
    processados.push(item.msg.getId());
    esquecerTentativas_(props, item.msg.getId());
    salvar(); // a cada e-mail: se a execução for cortada, o que já foi não volta
  }
}

// 'ok' | 'falhou' (planilha recusada - não adianta repetir) | 'erro-servidor'
// (o servidor respondeu com erro - tenta de novo, até um limite) |
// 'tentar-de-novo' (sem resposta, limite de uso - tenta de novo, sem limite)
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
  if (codigo >= 500) return 'erro-servidor';
  return 'tentar-de-novo'; // 429 (limite), 408...
}

// Rodadas seguidas com erro do servidor por e-mail (id -> n), guardadas entre
// as execuções. Devolve a contagem com esta.
function contarTentativa_(props, id) {
  const tentativas = JSON.parse(props.getProperty('TENTATIVAS') || '{}');
  tentativas[id] = (tentativas[id] || 0) + 1;
  const ids = Object.keys(tentativas);
  if (ids.length > 50) ids.slice(0, ids.length - 50).forEach(k => { delete tentativas[k]; });
  props.setProperty('TENTATIVAS', JSON.stringify(tentativas));
  return tentativas[id];
}

function esquecerTentativas_(props, id) {
  const tentativas = JSON.parse(props.getProperty('TENTATIVAS') || '{}');
  if (!(id in tentativas)) return;
  delete tentativas[id];
  props.setProperty('TENTATIVAS', JSON.stringify(tentativas));
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

// "Vendas <vendas@cortag.com>" -> "vendas@cortag.com". Só o que está dentro
// de <...>: o nome de exibição é texto livre de quem mandou.
function enderecoDe_(from) {
  const s = String(from || '');
  const m = s.match(/<([^<>]*)>\s*$/);
  return (m ? m[1] : s).trim().toLowerCase();
}

// Só os cabeçalhos do e-mail (até a 1ª linha em branco), com as linhas
// continuadas juntadas.
function cabecalhos_(msg) {
  const bruto = msg.getRawContent();
  const fim = bruto.search(/\r?\n\r?\n/);
  return (fim === -1 ? bruto : bruto.slice(0, fim)).replace(/\r?\n[ \t]+/g, ' ');
}

// O Gmail autenticou o domínio do remetente? Lê o PRIMEIRO cabeçalho
// "Authentication-Results" - o Gmail escreve o dele em todo e-mail que chega
// de fora, acima dos cabeçalhos de quem mandou; um que venha mais abaixo foi
// escrito pelo remetente e não vale.
// Aceita DMARC "pass" do domínio ou DKIM "pass" assinado pelo domínio (não um
// subdomínio nem um domínio que só começa igual). A noreply@cortag.com.br passa
// pelo DMARC: o DKIM dela é assinado por cortagind.onmicrosoft.com (conferido
// em 05/10/2026 com o conferirAutenticacao).
// Texto entre aspas e entre parênteses sai antes de separar os resultados por
// ";": o Gmail repete ali o endereço de envio (smtp.mailfrom, o comentário do
// spf), que é escolhido por quem manda - um "x;dmarc=pass header.from=..."@golpe
// virava um resultado falso (achado do revisor-cortag, 10/2026).
function autenticadoPeloGmail_(cabecalhos, endereco) {
  const dominio = String(endereco || '').split('@')[1];
  if (!dominio) return false;
  const linha = String(cabecalhos || '').split(/\r?\n/).find(l => /^Authentication-Results:/i.test(l));
  if (!linha || !/^Authentication-Results:\s*mx\.google\.com\s*;/i.test(linha)) return false;
  let limpa = linha.replace(/^Authentication-Results:\s*mx\.google\.com\s*;/i, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  for (let antes = ''; antes !== limpa;) { antes = limpa; limpa = limpa.replace(/\([^()]*\)/g, ' '); }
  if (/["()]/.test(limpa.replace(/""/g, ''))) return false; // aspas ou parênteses soltos: não dá pra confiar
  const d = dominio.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fimDominio = '(?=[\\s;]|$)';
  return limpa.split(';').some(r =>
    new RegExp('^\\s*dmarc=pass(?:\\s.*)?\\sheader\\.from=' + d + fimDominio, 'i').test(r)
    || new RegExp('^\\s*dkim=pass(?:\\s.*)?\\sheader\\.(?:i=[^\\s;@]*@|d=)' + d + fimDominio, 'i').test(r));
}

// Rodar à mão antes de deixar esta versão valer (e sempre que a Cortag trocar o
// jeito de mandar e-mail): lista os e-mails dos últimos 30 dias de cada
// remetente e diz se passariam na checagem. Não manda nada pro app.
function conferirAutenticacao() {
  const remetentes = Array.from(new Set(CONFIG.regras.map(r => r.remetente).concat(CONFIG.mensagens.map(m => m.remetente))));
  remetentes.forEach(remetente => {
    const threads = GmailApp.search(`from:${remetente} newer_than:30d`, 0, 10);
    let ok = 0;
    let total = 0;
    threads.forEach(t => t.getMessages().forEach(msg => {
      if (enderecoDe_(msg.getFrom()) !== remetente) return;
      const cab = cabecalhos_(msg);
      const passou = autenticadoPeloGmail_(cab, remetente);
      total++;
      if (passou) ok++;
      const linha = cab.split(/\r?\n/).find(l => /^Authentication-Results:/i.test(l)) || '(sem Authentication-Results)';
      Logger.log('%s  %s | %s | %s', passou ? 'OK ' : 'NÃO', remetente, msg.getSubject(), linha.slice(0, 400));
    }));
    Logger.log('== %s: %s de %s e-mail(s) autenticado(s)%s', remetente, ok, total,
      total && ok < total ? ' - os que deram NÃO não seriam importados; avise antes de usar esta versão' : '');
  });
}

function chave_() {
  const chave = PropertiesService.getScriptProperties().getProperty('CHAVE');
  if (!chave) throw new Error('Falta a CHAVE: Configurações do projeto › Propriedades do script › adicionar "CHAVE".');
  return chave.trim();
}

function marcador_(nome) {
  return GmailApp.getUserLabelByName(nome) || GmailApp.createLabel(nome);
}
