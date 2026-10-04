// Avisos de importação: cada importação de relatório oficial, catálogo de
// preços, previsão de estoque, Classificatório ou objetivos trimestrais vira
// uma "novidade" - faixa "🔔 N novidades" no app (routes/novidades.js) e push
// no celular de quem ativou "Avisos no celular".
//
// Decisões do usuário (10/2026):
//  - todos recebem, inclusive quem importou; mensagem curta (só o que foi
//    importado);
//  - push só em dia útil, das 7h às 20h de Brasília - importou fora disso, sai
//    no próximo dia útil às 7h (a faixa no app aparece na hora). Feriado não
//    é considerado;
//  - o mesmo tipo importado de novo em até 30 min (correção) atualiza a mesma
//    novidade e o push substitui o anterior no celular, sem tocar de novo
//    (mesma `tag` na notificação - ver sw.js);
//  - tocar no push abre a lista de novidades (index.html#novidades).
//
// Push = Web Push com chave VAPID (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY /
// VAPID_SUBJECT no Render). Sem a chave, as novidades continuam aparecendo no
// app, só o push fica desligado.
const webpush = require('web-push');
const { pool } = require('../../db');

const TIPOS = {
  'relatorio-oficial': { emoji: '📋', titulo: 'Relatório oficial atualizado' },
  'catalogo-precos': { emoji: '💲', titulo: 'Catálogo de preços atualizado' },
  'previsao-estoque': { emoji: '📦', titulo: 'Previsão de estoque atualizada' },
  'classificatorio': { emoji: '🏅', titulo: 'Classificatório atualizado' },
  'objetivos-trimestrais': { emoji: '🎯', titulo: 'Objetivos trimestrais atualizados' },
  // e-mails da Cortag por pedido (routes/importacaoEmail.js): cada pedido é
  // um aviso próprio - não junta nem substitui o anterior do mesmo tipo
  'pedido-bloqueado': { emoji: '⛔', titulo: 'Pedido bloqueado', porPedido: true },
  'pedido-avista': { emoji: '💳', titulo: 'Pedido à vista aguardando pagamento', porPedido: true },
};

const JUNTAR_MINUTOS = 30;
const HORA_INICIO = 7;
const HORA_FIM = 20; // até 19:59
// Brasília sem horário de verão desde 2019
const FUSO_BRASILIA_MS = -3 * 3600000;
const INTERVALO_ENVIO_MS = 60000;
// Só serviços de push dos navegadores (Chrome/Android, Firefox, Safari/iPhone,
// Edge) - o servidor faz POST no endpoint da inscrição, então não pode
// aceitar um endereço qualquer.
const HOSTS_PUSH = ['.googleapis.com', '.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'];

// Quando o push pode sair: agora, se for dia útil entre 7h e 20h de Brasília;
// senão o próximo dia útil às 7h (hoje mesmo, se for dia útil antes das 7h).
function proximaJanelaPush(agora = new Date()) {
  const local = new Date(agora.getTime() + FUSO_BRASILIA_MS); // getUTC* = hora de Brasília
  const util = (d) => d >= 1 && d <= 5;
  const dia = local.getUTCDay();
  const hora = local.getUTCHours();
  if (util(dia) && hora >= HORA_INICIO && hora < HORA_FIM) return agora;
  const alvo = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), HORA_INICIO));
  if (!(util(dia) && hora < HORA_INICIO)) {
    do { alvo.setUTCDate(alvo.getUTCDate() + 1); } while (!util(alvo.getUTCDay()));
  }
  return new Date(alvo.getTime() - FUSO_BRASILIA_MS);
}

function chavePublicaPush() {
  return process.env.VAPID_PUBLIC_KEY || null;
}
let vapidConfigurado = null;
function pushConfigurado() {
  if (vapidConfigurado !== null) return vapidConfigurado;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  vapidConfigurado = false;
  if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY && VAPID_SUBJECT) {
    try {
      webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
      vapidConfigurado = true;
    } catch (e) {
      console.error('Chave VAPID inválida - avisos no celular desligados:', e.message);
    }
  }
  return vapidConfigurado;
}

function endpointPushValido(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return false;
  let url;
  try { url = new URL(endpoint); } catch (e) { return false; }
  return url.protocol === 'https:' && HOSTS_PUSH.some(h => url.hostname.endsWith(h));
}

function dadosDaNovidade(n) {
  const def = TIPOS[n.tipo] || { emoji: '🔔' };
  return { ...n, emoji: def.emoji };
}

function payloadPush(n) {
  const def = TIPOS[n.tipo] || { emoji: '🔔' };
  return JSON.stringify({
    titulo: `${def.emoji} ${n.titulo}`,
    texto: n.texto || '',
    tag: `novidade-${n.id}`,
    url: './index.html#novidades',
  });
}

// Manda um push pra uma inscrição. Inscrição morta (404/410) sai do banco.
async function enviarPush(inscricao, payload, topico) {
  try {
    await webpush.sendNotification(
      { endpoint: inscricao.endpoint, keys: { p256dh: inscricao.p256dh, auth: inscricao.auth } },
      payload,
      { TTL: 24 * 3600, urgency: 'normal', topic: topico, timeout: 10000 });
    await pool.query('/* push:enviado */ UPDATE push_inscricoes SET ultimo_envio_em = now() WHERE id = $1', [inscricao.id]);
    return true;
  } catch (e) {
    if (e && (e.statusCode === 404 || e.statusCode === 410)) {
      await pool.query('/* push:apagar */ DELETE FROM push_inscricoes WHERE id = $1', [inscricao.id]);
    } else {
      console.error('Falha ao enviar aviso no celular:', e && (e.statusCode || e.message));
    }
    return false;
  }
}

// Envia os pushes que já podem sair. A linha é "reservada" no próprio UPDATE
// (push_pendente = false) - duas chamadas ao mesmo tempo não mandam em dobro.
let processando = false;
async function processarPushPendentes() {
  if (processando) return 0;
  processando = true;
  try {
    const pendentes = await pool.query(
      `/* novidades:reservar-push */
       UPDATE novidades SET push_pendente = false, push_enviado_em = now()
       WHERE push_pendente AND push_enviar_em <= now()
       RETURNING id, tipo, titulo, texto`);
    if (pendentes.rows.length === 0 || !pushConfigurado()) return 0;
    const inscricoes = await pool.query('/* push:inscricoes */ SELECT id, endpoint, p256dh, auth FROM push_inscricoes');
    let enviados = 0;
    for (const n of pendentes.rows) {
      for (const i of inscricoes.rows) {
        if (await enviarPush(i, payloadPush(n), `novidade${n.id}`)) enviados++;
      }
    }
    return enviados;
  } finally {
    processando = false;
  }
}

// Grava a novidade (ou atualiza a do mesmo tipo dos últimos 30 min) e tenta
// mandar o push. Nunca derruba a importação: erro só vai pro log. Tipo
// `porPedido` sempre grava uma novidade nova, com o título de `opcoes.titulo`.
async function avisarImportacao(tipo, texto, opcoes = {}) {
  const def = TIPOS[tipo];
  if (!def) return null;
  try {
    const enviarEm = proximaJanelaPush(new Date());
    if (def.porPedido) {
      const r = await pool.query(
        `/* novidades:inserir */
         INSERT INTO novidades (tipo, titulo, texto, push_enviar_em) VALUES ($1, $2, $3, $4) RETURNING id`,
        [tipo, String(opcoes.titulo || def.titulo).slice(0, 200), texto || null, enviarEm]);
      processarPushPendentes().catch(e => console.error('Erro ao enviar avisos no celular:', e));
      return r.rows[0].id;
    }
    const recente = await pool.query(
      `/* novidades:recente */
       SELECT id FROM novidades
       WHERE tipo = $1 AND atualizado_em > now() - make_interval(mins => $2)
       ORDER BY atualizado_em DESC LIMIT 1`,
      [tipo, JUNTAR_MINUTOS]);
    let id;
    if (recente.rows.length) {
      id = recente.rows[0].id;
      await pool.query(
        `/* novidades:atualizar */
         UPDATE novidades SET texto = $2, atualizado_em = now(), push_pendente = true, push_enviar_em = $3
         WHERE id = $1`,
        [id, texto || null, enviarEm]);
    } else {
      const r = await pool.query(
        `/* novidades:inserir */
         INSERT INTO novidades (tipo, titulo, texto, push_enviar_em) VALUES ($1, $2, $3, $4) RETURNING id`,
        [tipo, def.titulo, texto || null, enviarEm]);
      id = r.rows[0].id;
    }
    // aviso do mesmo tipo que ainda esperava a janela de horário (ex.: o
    // relatório diário de sábado e domingo) fica pra trás: na segunda sai
    // um push só, o do mais novo
    await pool.query(
      `/* novidades:substituir-pendentes */
       UPDATE novidades SET push_pendente = false WHERE tipo = $1 AND push_pendente AND id <> $2`,
      [tipo, id]);
    processarPushPendentes().catch(e => console.error('Erro ao enviar avisos no celular:', e));
    return id;
  } catch (e) {
    console.error(`Não foi possível registrar o aviso de importação (${tipo}):`, e);
    return null;
  }
}

function formatarDataBr(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}` : null;
}
function quantos(n, singular, plural) {
  return `${Number(n).toLocaleString('pt-BR')} ${Number(n) === 1 ? singular : plural}`;
}

// Push agendado (importação fora do horário): confere a cada minuto.
let timer = null;
function iniciarEnvioAgendado() {
  if (process.env.NODE_ENV === 'test' || timer) return;
  timer = setInterval(() => {
    processarPushPendentes().catch(e => console.error('Erro ao enviar avisos no celular:', e));
  }, INTERVALO_ENVIO_MS);
  if (timer.unref) timer.unref();
  console.log(pushConfigurado()
    ? 'Avisos no celular ligados (chave VAPID configurada).'
    : 'Avisos no celular desligados (sem VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT) - novidades só no app.');
}

module.exports = {
  TIPOS, proximaJanelaPush, pushConfigurado, chavePublicaPush, endpointPushValido,
  avisarImportacao, processarPushPendentes, enviarPush, payloadPush, dadosDaNovidade,
  iniciarEnvioAgendado, formatarDataBr, quantos,
};
