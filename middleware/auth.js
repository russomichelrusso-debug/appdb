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

function esquecerSessao(tokenHash) { geracaoRevogacao++; sessoesEmMemoria.delete(tokenHash); }
function esquecerSessoesDoUsuario(usuarioId) {
  geracaoRevogacao++;
  for (const [chave, v] of sessoesEmMemoria) if (Number(v.usuario.id) === Number(usuarioId)) sessoesEmMemoria.delete(chave);
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
    const result = await pool.query(
      `SELECT u.id, u.nome, u.email, u.is_admin, s.expira_em FROM sessoes s
       JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.token = $1 AND s.expira_em > now() AND u.ativo`,
      [hash]
    );
    if (result.rows.length === 0) return res.status(401).json({ erro: 'Sessão expirada ou inválida — faça login novamente.' });
    const { expira_em, ...usuario } = result.rows[0];
    if (SESSAO_CACHE_MS > 0) {
      const expira = new Date(expira_em).getTime();
      const ate = Math.min(agora + SESSAO_CACHE_MS, Number.isFinite(expira) ? expira : agora);
      if (sessoesEmMemoria.size >= SESSAO_CACHE_MAX) sessoesEmMemoria.clear();
      if (ate > agora && geracao === geracaoRevogacao) sessoesEmMemoria.set(hash, { usuario, ate });
    }
    req.usuario = { ...usuario };
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao verificar sessão.' });
  }
}

module.exports = { requireAuth, esquecerSessao, esquecerSessoesDoUsuario };
