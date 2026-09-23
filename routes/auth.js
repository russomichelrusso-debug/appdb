const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { generateToken, hashToken, verificarGoogleIdToken } = require('../auth-utils');
const { requireAuth } = require('../middleware/auth');
const { validarIdInteiro } = require('../middleware/validarId');

router.param('id', validarIdInteiro);

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

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // LOCK previne a corrida de dois primeiros logins simultâneos os dois
    // lendo "tabela vazia" e virando admin ao mesmo tempo - com o lock, o
    // segundo espera o primeiro terminar a transação e já encontra a tabela
    // não mais vazia.
    await client.query('LOCK TABLE usuarios IN EXCLUSIVE MODE');
    const totalUsuarios = await client.query('SELECT COUNT(*) FROM usuarios');
    let usuario;
    if (Number(totalUsuarios.rows[0].count) === 0) {
      const adminEmail = process.env.ADMIN_EMAIL;
      if (adminEmail && adminEmail.toLowerCase().trim() !== google.email) {
        await client.query('ROLLBACK');
        return res.status(403).json({ erro: 'Esse e-mail do Google não está cadastrado — peça pra um administrador te cadastrar antes.' });
      }
      const criado = await client.query(
        'INSERT INTO usuarios (nome, email, google_sub, is_admin) VALUES ($1, $2, $3, true) RETURNING id, nome, email, is_admin',
        [google.nome, google.email, google.sub]
      );
      usuario = criado.rows[0];
      console.log(`Primeiro usuário criado via Google (admin): ${usuario.email}`);
    } else {
      // google_sub primeiro (é o identificador estável da conta Google) -
      // só cai pra e-mail, e só entre quem ainda não tem google_sub gravado
      // (cadastro feito por um admin, ainda nunca logou de fato). Um e-mail
      // que já tem google_sub de outra conta Google associado não entra por
      // aqui - evita que reatribuir o e-mail (comum em Workspace) dê acesso
      // à conta de quem usava esse e-mail antes.
      const porSub = await client.query('SELECT id, nome, email, is_admin, google_sub FROM usuarios WHERE google_sub = $1', [google.sub]);
      const existente = porSub.rows.length > 0
        ? porSub
        : await client.query('SELECT id, nome, email, is_admin, google_sub FROM usuarios WHERE email = $1 AND google_sub IS NULL', [google.email]);
      if (existente.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(403).json({ erro: 'Esse e-mail do Google não está cadastrado — peça pra um administrador te cadastrar antes.' });
      }
      usuario = existente.rows[0];
      if (!usuario.google_sub) {
        // primeira vez que esse cadastro (feito por e-mail pelo admin) loga de
        // fato - grava o "sub" do Google pra próxima vez conferir por ele também.
        await client.query('UPDATE usuarios SET google_sub = $1 WHERE id = $2', [google.sub, usuario.id]);
      }
    }

    const token = generateToken();
    await client.query(
      `INSERT INTO sessoes (token, usuario_id, expira_em) VALUES ($1, $2, now() + ($3 || ' days')::interval)`,
      [hashToken(token), usuario.id, DURACAO_SESSAO_DIAS]
    );
    await client.query('COMMIT');
    console.log(`Login via Google: ${usuario.email}`);
    res.json({ token, nome: usuario.nome, email: usuario.email, is_admin: usuario.is_admin });
  } catch (e) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { console.error('Erro no rollback:', rollbackErr); }
    }
    console.error(e);
    if (e.code === '23505') return res.status(409).json({ erro: 'Corrida rara no primeiro login — tente de novo.' });
    res.status(500).json({ erro: 'Erro ao entrar.' });
  } finally {
    if (client) client.release();
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
      [hashToken(token)]
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
    if (token) await pool.query('DELETE FROM sessoes WHERE token = $1', [hashToken(token)]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao sair.' });
  }
});

// Cadastra um novo usuário pelo e-mail da conta Google dele - só admin (é
// isso que decide quem pode entrar no sistema, diferente das importações em
// massa de dados). A pessoa só consegue de fato entrar depois, fazendo
// "Entrar com Google" com esse mesmo e-mail.
router.post('/usuarios', requireAuth, async (req, res) => {
  if (!req.usuario.is_admin) return res.status(403).json({ erro: 'Só administrador pode cadastrar usuário.' });
  const { nome, email, is_admin } = req.body;
  if (!nome || !email) return res.status(400).json({ erro: 'Informe nome e e-mail.' });
  const tornarAdmin = !!is_admin;
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
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    const alvo = await client.query('SELECT is_admin FROM usuarios WHERE id = $1', [id]);
    if (alvo.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Usuário não encontrado.' });
    }
    if (alvo.rows[0].is_admin) {
      // FOR UPDATE trava as linhas de admin até o fim da transação - sem
      // isso, duas exclusões concorrentes podiam cada uma contar ">1 admin"
      // antes da outra terminar, e as duas passarem, zerando os admins.
      // (Postgres não aceita FOR UPDATE junto de COUNT(*)/agregação, por
      // isso traz as linhas e conta em JS.)
      const totalAdmins = await client.query('SELECT id FROM usuarios WHERE is_admin = true FOR UPDATE');
      if (totalAdmins.rows.length <= 1) {
        await client.query('ROLLBACK');
        return res.status(400).json({ erro: 'Esse é o último administrador do sistema — não é possível excluí-lo. Promova outro usuário a admin antes.' });
      }
    }
    const result = await client.query('DELETE FROM usuarios WHERE id = $1 RETURNING nome, email', [id]);
    await client.query('COMMIT');
    console.log(`Usuário excluído: ${result.rows[0].email} por ${req.usuario.email}`);
    res.json({ ok: true });
  } catch (e) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { console.error('Erro no rollback:', rollbackErr); }
    }
    console.error(e);
    res.status(500).json({ erro: 'Erro ao excluir usuário.' });
  } finally {
    if (client) client.release();
  }
});

module.exports = router;
