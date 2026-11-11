// Middleware que exige login em toda rota protegida - lê o token do cabeçalho
// "Authorization: Bearer <token>", confere se existe sessão válida (não
// expirada) pra ele, e disponibiliza o usuário logado em req.usuario pro
// resto da rota usar (ex: req.usuario.is_admin, req.usuario.id). Usuário
// desativado pelo admin (usuarios.ativo = false) é tratado como sessão inválida.

const { pool } = require('../db');
const { hashToken } = require('../auth-utils');

// Sessão conferida fica na memória por até 60 s (11/2026, log [lenta]: toda requisição fazia 1 consulta só pra
// conferir o login, ~180 ms Render <-> Supabase, inclusive as que respondem 304; na abertura do app ~20 requisições
// juntas disputavam as conexões do pool). Logout, desativar, excluir e trocar o nome limpam na hora
// (esquecerSessao/esquecerSessoesDoUsuario); o resto (sessão vencida, mudança feita direto por SQL) vale em até 60 s.
// Uma instância só do servidor: com várias (v2), a limpeza não chega nas outras - só o prazo de 60 s vale.
const SESSAO_CACHE_MS = (() => {
  const v = process.env.SESSAO_CACHE_MS;
  if (v === undefined || v === '') return 60000;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0; // 0 ou negativo desliga
})();
const SESSAO_CACHE_MAX = 2000;
const sessoesEmMemoria = new Map(); // hash do token -> { usuario, ate }
// Sobe a cada revogação: o SELECT que começou antes de um logout/desativação e volta depois dele
// não grava no cache a foto velha (senão a sessão revogada valia mais 60 s) - achado do revisor-cortag.
let geracaoRevogacao = 0;

// (a consulta em andamento também é esquecida: quem chega depois da revogação faz a sua, não herda a resposta de antes)
function esquecerSessao(tokenHash) { geracaoRevogacao++; sessoesEmMemoria.delete(tokenHash); consultasDeSessao.delete(tokenHash); }
function esquecerSessoesDoUsuario(usuarioId) {
  geracaoRevogacao++;
  consultasDeSessao.clear();
  for (const [chave, v] of sessoesEmMemoria) if (Number(v.usuario.id) === Number(usuarioId)) sessoesEmMemoria.delete(chave);
}

// Conferir uma sessão que não está na memória custa 1 consulta. Sem limite, quem não tem conta ocupava as conexões
// do pool mandando token qualquer em laço, e a abertura do app (~20 requisições juntas com a sessão fora da memória)
// fazia ~20 consultas iguais (auditoria 11/2026). Agora: (1) requisições com o mesmo token esperam a mesma consulta;
// (2) no máximo SESSAO_CONSULTAS_MAX consultas de sessão rodam ao mesmo tempo (padrão 4), as outras esperam na fila
// (até 200) e, com a fila cheia, a resposta é 503 sem ir ao banco. Não depende do IP de quem chama (atrás do proxy
// do Render ele pode ser o mesmo pra todo mundo). Sessão já na memória não passa por aqui.
const SESSAO_CONSULTAS_MAX = (() => {
  const n = Number(process.env.SESSAO_CONSULTAS_MAX);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 4;
})();
const SESSAO_FILA_MAX = 200;
const SQL_SESSAO = `SELECT u.id, u.nome, u.email, u.is_admin, u.telefone, s.expira_em FROM sessoes s
       JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.token = $1 AND s.expira_em > now() AND u.ativo`;
const consultasDeSessao = new Map(); // hash do token -> Promise da linha (ou null)
let consultasAtivas = 0;
const filaDeConsultas = [];
function comVagaDeConsulta(fn) {
  return new Promise((resolve, reject) => {
    const rodar = () => {
      consultasAtivas++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { // erro síncrono do fn também devolve a vaga
        consultasAtivas--;
        const proxima = filaDeConsultas.shift();
        if (proxima) proxima();
      });
    };
    if (consultasAtivas < SESSAO_CONSULTAS_MAX) return rodar();
    if (filaDeConsultas.length >= SESSAO_FILA_MAX) {
      const e = new Error('Fila de conferência de sessão cheia.');
      e.ocupado = true;
      return reject(e);
    }
    filaDeConsultas.push(rodar);
  });
}
// Linha da sessão válida (com o usuário) ou null. Erro com .ocupado = fila cheia (responder 503).
function consultarSessao(hash) {
  let p = consultasDeSessao.get(hash);
  if (!p) {
    p = comVagaDeConsulta(() => pool.query(SQL_SESSAO, [hash]).then(r => r.rows[0] || null));
    consultasDeSessao.set(hash, p);
    const limpar = () => { if (consultasDeSessao.get(hash) === p) consultasDeSessao.delete(hash); };
    p.then(limpar, limpar);
  }
  return p;
}
function responderOcupado(res) {
  res.set('Retry-After', '5');
  return res.status(503).json({ erro: 'Servidor ocupado — tenta de novo em instantes.' });
}

async function requireAuth(req, res, next) {
  // já conferido nesta requisição (server.js confere antes de ler o corpo das
  // rotas de payload grande) - não consulta o banco de novo
  if (req.usuario) return next();
  const token = (req.header('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ erro: 'Não autenticado — faça login novamente.' });
  const hash = hashToken(token);
  const agora = Date.now();
  const guardada = sessoesEmMemoria.get(hash);
  if (guardada && guardada.ate > agora) {
    req.usuario = { ...guardada.usuario };
    return next();
  }
  if (guardada) sessoesEmMemoria.delete(hash);
  const geracao = geracaoRevogacao;
  try {
    const linha = await consultarSessao(hash);
    if (!linha) return res.status(401).json({ erro: 'Sessão expirada ou inválida — faça login novamente.' });
    const { expira_em, telefone, ...usuario } = linha; // o telefone é só do /auth/me (não fica na memória)
    if (SESSAO_CACHE_MS > 0) {
      const expira = new Date(expira_em).getTime();
      const ate = Math.min(agora + SESSAO_CACHE_MS, Number.isFinite(expira) ? expira : agora);
      if (sessoesEmMemoria.size >= SESSAO_CACHE_MAX) sessoesEmMemoria.clear();
      if (ate > agora && geracao === geracaoRevogacao) sessoesEmMemoria.set(hash, { usuario, ate });
    }
    req.usuario = { ...usuario };
    next();
  } catch (e) {
    if (e && e.ocupado) return responderOcupado(res);
    console.error(e);
    res.status(500).json({ erro: 'Erro ao verificar sessão.' });
  }
}

module.exports = { requireAuth, esquecerSessao, esquecerSessoesDoUsuario, consultarSessao, responderOcupado, SESSAO_CONSULTAS_MAX, SESSAO_FILA_MAX };
