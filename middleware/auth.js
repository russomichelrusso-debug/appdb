// Middleware que exige login em toda rota protegida - lê o token do cabeçalho
// "Authorization: Bearer <token>", confere se existe sessão válida (não
// expirada) pra ele, e disponibiliza o usuário logado em req.usuario pro
// resto da rota usar (ex: req.usuario.is_admin, req.usuario.id).

const { pool } = require('../db');

async function requireAuth(req, res, next) {
  const token = (req.header('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ erro: 'Não autenticado — faça login novamente.' });
  try {
    const result = await pool.query(
      `SELECT u.id, u.nome, u.email, u.is_admin FROM sessoes s
       JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.token = $1 AND s.expira_em > now()`,
      [token]
    );
    if (result.rows.length === 0) return res.status(401).json({ erro: 'Sessão expirada ou inválida — faça login novamente.' });
    req.usuario = result.rows[0];
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao verificar sessão.' });
  }
}

module.exports = { requireAuth };
