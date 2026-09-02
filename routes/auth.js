const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { generateToken, verificarGoogleIdToken } = require('../auth-utils');
const { requireAuth } = require('../middleware/auth');

// Mesmo Client ID usado no botão "Entrar com Google" do frontend (index.html)
// - dá pra sobrescrever por variável de ambiente se o client ID for trocado
// no futuro, sem precisar reeditar os dois lados (front e back) juntos.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '587215783588-g9nrt4mq8onu12qkj4r8h4ao307478i4.apps.googleusercontent.com';

// Sessão de login já fica "lembrada" por padrão - não depende mais de senha
// pra ser considerada segura, então não faz sentido pedir login de novo com
// frequência (a conta Google é quem garante a identidade).
const DURACAO_SESSAO_DIAS = 90;

// Login único, via "Entrar com Google" (ID token do Google Identity Services).
// Se ainda não existe NENHUM usuário cadastrado, essa conta vira o primeiro
// admin automaticamente (substitui o antigo /setup de usuário/senha). Depois
// que já existe alguém, só entra quem tiver esse e-mail cadastrado antes por
// um admin (POST /usuarios) - continua não sendo auto-cadastro livre.
router.post('/google', async (req, res) => {
  const { id_token } = req.body;
  if (!id_token) return res.status(400).json({ erro: 'Envie { id_token }.' });

  let google;
  try {
    google = await verificarGoogleIdToken(id_token, GOOGLE_CLIENT_ID);
  } catch (e) {
    console.error('Erro ao verificar token do Google:', e);
    return res.status(502).json({ erro: 'Não foi possível confirmar sua conta Google agora — tente de novo.' });
  }
  if (!google) return res.status(401).json({ erro: 'Login do Google inválido ou expirado — tente de novo.' });

  try {
    const totalUsuarios = await pool.query('SELECT COUNT(*) FROM usuarios');
    let usuario;
    if (Number(totalUsuarios.rows[0].count) === 0) {
      const criado = await pool.query(
        'INSERT INTO usuarios (nome, email, google_sub, is_admin) VALUES ($1, $2, $3, true) RETURNING id, nome, email, is_admin',
        [google.nome, google.email, google.sub]
      );
      usuario = criado.rows[0];
      console.log(`Primeiro usuário criado via Google (admin): ${usuario.email}`);
    } else {
      const existente = await pool.query(
        'SELECT id, nome, email, is_admin, google_sub FROM usuarios WHERE email = $1 OR google_sub = $2',
        [google.email, google.sub]
      );
      if (existente.rows.length === 0) {
        return res.status(403).json({ erro: 'Esse e-mail do Google não está cadastrado — peça pra um administrador te cadastrar antes.' });
      }
      usuario = existente.rows[0];
      if (!usuario.google_sub) {
        // primeira vez que esse cadastro (feito por e-mail pelo admin) loga de
        // fato - grava o "sub" do Google pra próxima vez conferir por ele também.
        await pool.query('UPDATE usuarios SET google_sub = $1 WHERE id = $2', [google.sub, usuario.id]);
      }
    }

    const token = generateToken();
    await pool.query(
      `INSERT INTO sessoes (token, usuario_id, expira_em) VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
      [token, usuario.id, DURACAO_SESSAO_DIAS]
    );
    console.log(`Login via Google: ${usuario.email}`);
    res.json({ token, nome: usuario.nome, email: usuario.email, is_admin: usuario.is_admin });
  } catch (e) {
    console.error(e);
    if (e.code === '23505') return res.status(409).json({ erro: 'Corrida rara no primeiro login — tente de novo.' });
    res.status(500).json({ erro: 'Erro ao entrar.' });
  }
});

// Confirma se o token guardado no aparelho ainda é válido, e devolve quem é
// o usuário - usado quando o app abre, pra pular a tela de login se já
// tiver uma sessão válida guardada.
router.get('/me', async (req, res) => {
  const token = (req.header('Authorization') || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ erro: 'Sem sessão.' });
  try {
    const result = await pool.query(
      `SELECT u.nome, u.email, u.is_admin FROM sessoes s
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

// Cadastra um novo usuário pelo e-mail da conta Google dele - exige já estar
// logado. A pessoa só consegue de fato entrar depois, fazendo "Entrar com
// Google" com esse mesmo e-mail. Só um admin consegue criar outro admin.
router.post('/usuarios', requireAuth, async (req, res) => {
  const { nome, email, is_admin } = req.body;
  if (!nome || !email) return res.status(400).json({ erro: 'Informe nome e e-mail.' });
  const tornarAdmin = !!is_admin && !!req.usuario.is_admin;
  try {
    const result = await pool.query(
      'INSERT INTO usuarios (nome, email, is_admin) VALUES ($1, $2, $3) RETURNING id, nome, email, is_admin',
      [nome, String(email).toLowerCase().trim(), tornarAdmin]
    );
    console.log(`Usuário cadastrado por ${req.usuario?.email || '?'}: ${result.rows[0].email}${tornarAdmin ? ' (admin)' : ''}`);
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error(e);
    if (e.code === '23505') return res.status(400).json({ erro: 'Esse e-mail já está cadastrado.' });
    res.status(500).json({ erro: 'Erro ao criar usuário.' });
  }
});

// Lista todos os usuários - só admin vê essa lista (painel de gerenciamento).
router.get('/usuarios', requireAuth, async (req, res) => {
  if (!req.usuario.is_admin) return res.status(403).json({ erro: 'Só administrador pode ver a lista de usuários.' });
  try {
    const result = await pool.query('SELECT id, nome, email, is_admin, criado_em FROM usuarios ORDER BY nome');
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao listar usuários.' });
  }
});

// Exclui um usuário - só admin. Duas proteções pra não travar o sistema:
// não pode se auto-excluir (evita ficar sem acesso sem querer), e não pode
// excluir o último admin restante.
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
    const result = await pool.query('DELETE FROM usuarios WHERE id = $1 RETURNING nome, email', [id]);
    console.log(`Usuário excluído: ${result.rows[0].email} por ${req.usuario.email}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao excluir usuário.' });
  }
});

module.exports = router;
