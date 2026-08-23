const { pool } = require('../db');

// Confere se o token enviado (cabeçalho "Authorization: Bearer <token>")
// corresponde a uma sessão válida e não expirada. Se sim, guarda quem é o
// usuário em req.usuario pras rotas seguintes usarem (ex: registrar quem
// fez o pedido).
async function requireAuth(req, res, next) {
  const token = (req.header('Authorization') || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ erro: 'Não autenticado — faça login novamente.' });
  try {
    const result = await pool.query(
      `SELECT u.id, u.nome, u.usuario FROM sessoes s
       JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.token = $1 AND s.expira_em > now()`,
      [token]
    );
    if (result.rows.length === 0) return res.status(401).json({ erro: 'Sessão expirada — faça login novamente.' });
    req.usuario = result.rows[0];
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao verificar autenticação.' });
  }
}

module.exports = { requireAuth };
