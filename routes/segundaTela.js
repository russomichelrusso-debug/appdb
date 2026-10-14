// Segunda tela (10/2026, mockups escolhidos pelo usuário): o tablet vira a "tela
// do cliente" - mostra ao vivo o orçamento que o vendedor monta no celular.
//
// O tablet abre tela-cliente.html, que cria uma SALA e mostra um QR com o código
// dela; o celular lê o QR (ou digita o código) e entra na sala. Daí em diante o
// celular manda a foto do orçamento (PUT /estado, sempre a foto inteira, nunca o
// pedaço que mudou) e o tablet espera a próxima com uma requisição que fica
// aberta até algo mudar ou passar ESPERA_MS (long-poll - funciona atrás de
// qualquer proxy e sem biblioteca nova).
//
// Modo 'leitor' (2ª ideia, opção "cada leitura soma 1"): o levantamento fica na
// tela do tablet e o celular vira o leitor de código de barras. Aí o celular não
// manda foto: manda EVENTOS (cada leitura, desfazer, quantidade digitada), cada
// um com um id gerado no celular - o reenvio depois de uma resposta perdida não
// conta duas vezes. O tablet pede os eventos depois do último número (seq) que
// já aplicou.
//
// As salas ficam SÓ NA MEMÓRIA do servidor, de propósito: é um elo de minutos a
// horas, nada que precise sobreviver. Deploy ou reinício do Render apaga todas -
// os dois aparelhos recebem 404 e o tablet mostra um QR novo. (Com mais de uma
// instância - a v2 - isto teria de ir pro banco.)
//
// Segurança: tablet e celular têm de estar logados na MESMA conta. O código de 4
// dígitos só é procurado entre as salas do próprio usuário, então não há o que
// adivinhar de fora; e o id da sala (aleatório, 32 letras) só vale pro dono.
const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const MODOS = new Set(['cliente', 'leitor']);
const VALIDADE_CODIGO_MS = 5 * 60 * 1000;
const SALA_PARADA_MS = 12 * 60 * 60 * 1000;
const ESPERA_MS = Number(process.env.SEGUNDA_TELA_ESPERA_MS) || 25000;
// o tablet é dado como conectado se está esperando agora ou esperou há pouco
// (uma espera dura até ESPERA_MS; depois ele volta em seguida)
const CONECTADO_MS = ESPERA_MS + 15000;
const MAX_SALAS_POR_USUARIO = 4;
const MAX_ESTADO_BYTES = 200 * 1024;
const ID_SALA_REGEX = /^[a-f0-9]{32}$/;
const TIPOS_EVENTO = new Set(['leitura', 'desfazer', 'definir']);
const ID_EVENTO_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_EVENTOS_POR_ENVIO = 100;
const MAX_EVENTO_BYTES = 2048;
const MAX_EVENTOS_GUARDADOS = 500; // o tablet pega em segundos; o resto é folga pra reconexão
const MAX_IDS_LEMBRADOS = 5000;

const salas = new Map(); // id -> sala
let desligando = false;

function salaDoUsuario(req) {
  const id = String(req.params.id || '');
  if (!ID_SALA_REGEX.test(id)) return null;
  const sala = salas.get(id);
  return sala && sala.usuarioId === req.usuario.id ? sala : null;
}

function acordar(sala) {
  for (const fim of [...sala.esperando]) fim();
}

function encerrar(sala) {
  salas.delete(sala.id);
  sala.encerrada = true;
  acordar(sala);
}

function tabletConectado(sala, agora) {
  return sala.tabletEsperando > 0 || (sala.tabletVistoEm > 0 && agora - sala.tabletVistoEm < CONECTADO_MS);
}

function resumo(sala, agora) {
  return {
    id: sala.id,
    modo: sala.modo,
    pareada: sala.pareada,
    versao: sala.versao,
    seq: sala.seq,
    tablet_conectado: tabletConectado(sala, agora),
  };
}

// Código de 4 dígitos que nenhuma outra sala do mesmo usuário com código ainda
// valendo está usando.
function novoCodigo(usuarioId, agora) {
  const emUso = new Set();
  for (const s of salas.values()) {
    if (s.usuarioId === usuarioId && s.codigo && s.codigoExpiraEm > agora) emUso.add(s.codigo);
  }
  for (;;) {
    const c = String(crypto.randomInt(0, 10000)).padStart(4, '0');
    if (!emUso.has(c)) return c;
  }
}

// Tira as salas paradas há muito tempo e as que ninguém pareou.
function limparSalas(agora = Date.now()) {
  for (const sala of [...salas.values()]) {
    const parada = agora - sala.atividadeEm > SALA_PARADA_MS;
    const codigoVencidoSemPar = !sala.pareada && sala.codigoExpiraEm + 60000 < agora;
    if ((parada || codigoVencidoSemPar) && sala.tabletEsperando === 0) encerrar(sala);
  }
}
setInterval(() => limparSalas(), 10 * 60 * 1000).unref();

// Tablet: cria a sala e recebe o código pro QR. O usuário fica com no máximo
// MAX_SALAS_POR_USUARIO (abrir de novo a tela do tablet cria outra; a mais
// antiga sai).
router.post('/salas', (req, res) => {
  const modo = String((req.body && req.body.modo) || 'cliente');
  if (!MODOS.has(modo)) return res.status(400).json({ erro: 'Modo de tela desconhecido.' });
  const agora = Date.now();
  const doUsuario = [...salas.values()].filter(s => s.usuarioId === req.usuario.id).sort((a, b) => a.atividadeEm - b.atividadeEm);
  while (doUsuario.length >= MAX_SALAS_POR_USUARIO) encerrar(doUsuario.shift());
  const sala = {
    id: crypto.randomBytes(16).toString('hex'),
    usuarioId: req.usuario.id,
    modo,
    codigo: novoCodigo(req.usuario.id, agora),
    codigoExpiraEm: agora + VALIDADE_CODIGO_MS,
    pareada: false,
    estado: null,
    versao: 0,
    seq: 0,
    eventos: [],
    idsEventos: new Set(),
    atividadeEm: agora,
    tabletVistoEm: agora,
    tabletEsperando: 0,
    encerrada: false,
    esperando: new Set(),
  };
  salas.set(sala.id, sala);
  // valido_por_ms: o tablet conta o prazo pelo próprio relógio (o dele pode estar errado)
  res.json({ id: sala.id, codigo: sala.codigo, modo, valido_por_ms: VALIDADE_CODIGO_MS });
});

// Celular: entra na sala pelo código (lido do QR ou digitado). O código vale uma
// vez só - outro celular que quiser entrar precisa de um QR novo no tablet.
router.post('/entrar', (req, res) => {
  const codigo = String((req.body && req.body.codigo) || '').replace(/\D/g, '');
  if (!/^\d{4}$/.test(codigo)) return res.status(400).json({ erro: 'O código do tablet tem 4 números.' });
  const agora = Date.now();
  const sala = [...salas.values()].find(s => s.usuarioId === req.usuario.id && s.codigo === codigo && s.codigoExpiraEm > agora);
  if (!sala) {
    return res.status(404).json({ erro: 'Código não encontrado ou vencido. Confira o código no tablet (e se ele entrou com a mesma conta Google).' });
  }
  sala.codigo = null;
  sala.pareada = true;
  sala.atividadeEm = agora;
  acordar(sala);
  res.json(resumo(sala, agora));
});

// Celular: manda a foto inteira do orçamento. Volta se o tablet está ouvindo.
router.put('/salas/:id/estado', (req, res) => {
  const sala = salaDoUsuario(req);
  if (!sala) return res.status(404).json({ erro: 'Conexão com o tablet encerrada.' });
  if (!sala.pareada) return res.status(409).json({ erro: 'O tablet ainda não foi conectado.' });
  const estado = req.body && req.body.estado;
  if (!estado || typeof estado !== 'object' || Array.isArray(estado)) return res.status(400).json({ erro: 'Estado inválido.' });
  if (Buffer.byteLength(JSON.stringify(estado)) > MAX_ESTADO_BYTES) return res.status(413).json({ erro: 'Orçamento grande demais pra tela do cliente.' });
  const agora = Date.now();
  sala.estado = estado;
  sala.versao += 1;
  sala.atividadeEm = agora;
  acordar(sala);
  res.json(resumo(sala, agora));
});

// Celular no modo leitor: manda as leituras (e desfazer/quantidade digitada).
// Evento com id já recebido é ignorado - o celular reenvia o que não teve
// confirmação, e isso não pode somar de novo.
router.post('/salas/:id/eventos', (req, res) => {
  const sala = salaDoUsuario(req);
  if (!sala) return res.status(404).json({ erro: 'Conexão com o tablet encerrada.' });
  if (sala.modo !== 'leitor') return res.status(409).json({ erro: 'Este tablet não está no modo leitor.' });
  if (!sala.pareada) return res.status(409).json({ erro: 'O tablet ainda não foi conectado.' });
  const eventos = req.body && req.body.eventos;
  if (!Array.isArray(eventos) || eventos.length === 0 || eventos.length > MAX_EVENTOS_POR_ENVIO) {
    return res.status(400).json({ erro: `Mande de 1 a ${MAX_EVENTOS_POR_ENVIO} leituras por vez.` });
  }
  for (const ev of eventos) {
    if (!ev || typeof ev !== 'object' || Array.isArray(ev) || !ID_EVENTO_REGEX.test(String(ev.id || ''))
      || !TIPOS_EVENTO.has(ev.tipo) || Buffer.byteLength(JSON.stringify(ev)) > MAX_EVENTO_BYTES) {
      return res.status(400).json({ erro: 'Leitura em formato inválido.' });
    }
  }
  let aceitos = 0;
  for (const ev of eventos) {
    if (sala.idsEventos.has(ev.id)) continue;
    sala.idsEventos.add(ev.id);
    sala.seq += 1;
    sala.eventos.push({ ...ev, seq: sala.seq });
    aceitos += 1;
  }
  if (sala.eventos.length > MAX_EVENTOS_GUARDADOS) sala.eventos.splice(0, sala.eventos.length - MAX_EVENTOS_GUARDADOS);
  if (sala.idsEventos.size > MAX_IDS_LEMBRADOS) {
    // os ids mais antigos saem (Set guarda na ordem de entrada)
    const sobra = sala.idsEventos.size - MAX_IDS_LEMBRADOS;
    let i = 0;
    for (const id of sala.idsEventos) { if (i++ >= sobra) break; sala.idsEventos.delete(id); }
  }
  const agora = Date.now();
  sala.atividadeEm = agora;
  if (aceitos) acordar(sala);
  res.json({ ...resumo(sala, agora), aceitos });
});

// Tablet (e o celular, pra saber se o tablet ainda está lá). Com esperar=1, só
// responde quando a versão ou o pareamento mudar - ou passados ESPERA_MS.
router.get('/salas/:id', async (req, res) => {
  // servidor desligando (deploy): o tablet espera uns segundos e tenta de novo,
  // em vez de repetir a pergunta sem parar
  if (desligando) return res.status(503).json({ erro: 'Servidor reiniciando.' });
  const sala = salaDoUsuario(req);
  if (!sala) return res.status(404).json({ erro: 'Conexão encerrada.' });
  const ehTablet = req.query.papel === 'tablet';
  const versaoCliente = Number(req.query.versao);
  const pareadaCliente = req.query.pareada === '1';
  const seqCliente = Number(req.query.seq) || 0;
  const mudou = () => sala.encerrada || sala.versao !== versaoCliente || sala.pareada !== pareadaCliente
    || (ehTablet && sala.seq !== seqCliente);
  if (ehTablet) sala.tabletVistoEm = Date.now();
  if (req.query.esperar === '1' && !mudou()) {
    if (ehTablet) sala.tabletEsperando += 1;
    await new Promise((resolve) => {
      let feito = false;
      const fim = () => {
        if (feito) return;
        feito = true;
        clearTimeout(timer);
        sala.esperando.delete(fim);
        resolve();
      };
      const timer = setTimeout(fim, ESPERA_MS);
      sala.esperando.add(fim);
      res.on('close', fim); // tablet fechou a página / perdeu a conexão
    });
    if (ehTablet) {
      sala.tabletEsperando -= 1;
      sala.tabletVistoEm = Date.now();
    }
  }
  if (res.writableEnded || res.destroyed) return;
  if (desligando) return res.status(503).json({ erro: 'Servidor reiniciando.' });
  if (sala.encerrada) return res.status(404).json({ erro: 'Conexão encerrada.' });
  const agora = Date.now();
  if (ehTablet) sala.atividadeEm = agora;
  const corpo = resumo(sala, agora);
  if (ehTablet && sala.versao !== versaoCliente) corpo.estado = sala.estado;
  if (ehTablet && sala.modo === 'leitor') {
    corpo.eventos = sala.eventos.filter(ev => ev.seq > seqCliente);
    // o tablet ficou tanto tempo fora que leituras já saíram da memória
    corpo.perdeu_eventos = sala.eventos.length > 0 && sala.eventos[0].seq > seqCliente + 1;
  }
  res.json(corpo);
});

// Qualquer um dos dois desconecta.
router.delete('/salas/:id', (req, res) => {
  const sala = salaDoUsuario(req);
  if (sala) encerrar(sala);
  res.json({ ok: true });
});

// Desligamento do servidor (server.js): as esperas abertas respondem na hora, em
// vez de segurar o deploy até ESPERA_MS.
function acordarTodas() {
  desligando = true;
  for (const sala of salas.values()) acordar(sala);
}

module.exports = router;
module.exports.acordarTodas = acordarTodas;
module.exports.limparSalas = limparSalas;
module.exports._salas = salas;
