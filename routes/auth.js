const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { hashPassword, verifyPassword, generateToken } = require('../auth-utils');
const { requireAuth } = require('../middleware/auth');

// Duração da sessão: "lembrar-me" marcado = 90 dias; desmarcado = 1 dia.
const DURACAO_LEMBRAR_DIAS = 90;
const DURACAO_PADRAO_DIAS = 1;

// Cria o primeiro usuário do sistema - só funciona se ainda não existir
// nenhum usuário cadastrado (evita virar uma porta aberta pra sempre).
// Depois que o primeiro existe, novos usuários precisam ser criados por quem
// já está logado (ver rota /api/auth/usuarios abaixo).
router.post('/setup', async (req, res) => {
  const { nome, usuario, senha } = req.body;
  if (!nome || !usuario || !senha) return res.status(400).json({ erro: 'Informe nome, usuário e senha.' });
  try {
    const existing = await pool.query('SELECT COUNT(*) FROM usuarios');
    if (Number(existing.rows[0].count) > 0) {
      return res.status(403).json({ erro: 'Já existe usuário cadastrado. Peça pra alguém já logado te cadastrar.' });
    }
    const senha_hash = hashPassword(senha);
    // o primeiro usuário do sistema vira admin automaticamente - é quem fez
    // a configuração inicial, faz sentido ele ter controle total desde já.
    const result = await pool.query(
      'INSERT INTO usuarios (nome, usuario, senha_hash, is_admin) VALUES ($1, $2, $3, true) RETURNING id, nome, usuario, is_admin',
      [nome, usuario, senha_hash]
    );
    console.log(`Primeiro usuário criado (admin): ${usuario}`);
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error(e);
    if (e.code === '23505') return res.status(400).json({ erro: 'Esse nome de usuário já existe.' });
    res.status(500).json({ erro: 'Erro ao criar usuário.' });
  }
});

router.post('/login', async (req, res) => {
  const { usuario, senha, lembrar } = req.body;
  if (!usuario || !senha) return res.status(400).json({ erro: 'Informe usuário e senha.' });
  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE usuario = $1', [usuario]);
    const user = result.rows[0];
    if (!user || !verifyPassword(senha, user.senha_hash)) {
      return res.status(401).json({ erro: 'Usuário ou senha incorretos.' });
    }
    const token = generateToken();
    const dias = lembrar ? DURACAO_LEMBRAR_DIAS : DURACAO_PADRAO_DIAS;
    await pool.query(
      `INSERT INTO sessoes (token, usuario_id, expira_em) VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
      [token, user.id, dias]
    );
    console.log(`Login: ${usuario} (sessão de ${dias} dia(s))`);
    res.json({ token, nome: user.nome, usuario: user.usuario, is_admin: user.is_admin });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao entrar.' });
  }
});

// Confirma se o token guardado no aparelho ainda é válido, e devolve quem é
// o usuário - usado quando o app abre, pra pular a tela de login se já
// tiver uma sessão válida guardada ("lembrar-me").
router.get('/me', async (req, res) => {
  const token = (req.header('Authorization') || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Sem sessão.' });
  try {
    const result = await pool.query(
      `SELECT u.nome, u.usuario, u.is_admin FROM sessoes s
       JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.token = $1 AND s.expira_em > now()`,
      [token]
    );
    if (result.rows.length === 0) return res.status(401).json({ erro: 'Sessão expirada ou inválida.' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao verificar sessão.' });
  }
});

router.post('/logout', async (req, res) => {
  const token = (req.header('Authorization') || '').replace('Bearer ', '');
  try {
    if (token) await pool.query('DELETE FROM sessoes WHERE token = $1', [token]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao sair.' });
  }
});

// Cadastra um novo usuário - exige já estar logado (usa o middleware requireAuth
// no server.js), pra não deixar aberto pra qualquer um se auto-cadastrar.
// Só um admin consegue criar outro admin - um usuário comum criando alguém
// não consegue promover ninguém além do próprio nível dele.
router.post('/usuarios', requireAuth, async (req, res) => {
  const { nome, usuario, senha, is_admin } = req.body;
  if (!nome || !usuario || !senha) return res.status(400).json({ erro: 'Informe nome, usuário e senha.' });
  const tornarAdmin = !!is_admin && !!req.usuario.is_admin;
  try {
    const senha_hash = hashPassword(senha);
    const result = await pool.query(
      'INSERT INTO usuarios (nome, usuario, senha_hash, is_admin) VALUES ($1, $2, $3, $4) RETURNING id, nome, usuario, is_admin',
      [nome, usuario, senha_hash, tornarAdmin]
    );
    console.log(`Usuário cadastrado por ${req.usuario?.usuario || '?'}: ${usuario}${tornarAdmin ? ' (admin)' : ''}`);
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error(e);
    if (e.code === '23505') return res.status(400).json({ erro: 'Esse nome de usuário já existe.' });
    res.status(500).json({ erro: 'Erro ao criar usuário.' });
  }
});

// Lista todos os usuários - só admin vê essa lista (painel de gerenciamento).
router.get('/usuarios', requireAuth, async (req, res) => {
  if (!req.usuario.is_admin) return res.status(403).json({ erro: 'Só administrador pode ver a lista de usuários.' });
  try {
    const result = await pool.query('SELECT id, nome, usuario, is_admin, criado_em FROM usuarios ORDER BY nome');
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao listar usuários.' });
  }
});

// Exclui um usuário - só admin. Duas proteções pra não travar o sistema:
// não pode se auto-excluir (evita ficar sem acesso sem querer), e não pode
// excluir o último admin restante (sem isso, ninguém mais conseguiria
// cadastrar gente nova ou fazer exclusão forçada de cliente).
router.delete('/usuarios/:id', requireAuth, async (req, res) => {
  if (!req.usuario.is_admin) return res.status(403).json({ erro: 'Só administrador pode excluir usuário.' });
  const { id } = req.params;
  if (Number(id) === req.usuario.id) {
    return res.status(400).json({ erro: 'Você não pode excluir a própria conta enquanto estiver logado nela.' });
  }
  try {
    const alvo = await pool.query('SELECT is_admin FROM usuarios WHERE id = $1', [id]);
    if (alvo.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado.' });
    if (alvo.rows[0].is_admin) {
      const totalAdmins = await pool.query('SELECT COUNT(*) FROM usuarios WHERE is_admin = true');
      if (Number(totalAdmins.rows[0].count) <= 1) {
        return res.status(400).json({ erro: 'Esse é o último administrador do sistema — não é possível excluí-lo. Promova outro usuário a admin antes.' });
      }
    }
    const result = await pool.query('DELETE FROM usuarios WHERE id = $1 RETURNING nome, usuario', [id]);
    console.log(`Usuário excluído: ${result.rows[0].usuario} por ${req.usuario.usuario}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao excluir usuário.' });
  }
});

module.exports = router;
