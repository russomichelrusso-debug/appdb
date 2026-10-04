// Novidades (avisos de importação - routes/lib/novidades.js): lista dos
// últimos 30 dias pra faixa "🔔 N novidades" do app, marcar como vistas e
// ativar/desativar o push no aparelho.
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const {
  chavePublicaPush, pushConfigurado, endpointPushValido, enviarPush, dadosDaNovidade,
} = require('./lib/novidades');

const DIAS_LISTA = 30;
const LIMITE_LISTA = 50;

router.get('/', async (req, res) => {
  try {
    const [lista, usuario] = await Promise.all([
      pool.query(
        `/* novidades:lista */
         SELECT id, tipo, titulo, texto, criado_em, atualizado_em FROM novidades
         WHERE atualizado_em > now() - make_interval(days => $1)
         ORDER BY atualizado_em DESC LIMIT $2`,
        [DIAS_LISTA, LIMITE_LISTA]),
      pool.query('/* novidades:vistas */ SELECT novidades_vistas_ate FROM usuarios WHERE id = $1', [req.usuario.id]),
    ]);
    res.json({
      novidades: lista.rows.map(dadosDaNovidade),
      vistas_ate: usuario.rows[0] ? usuario.rows[0].novidades_vistas_ate : null,
      chave_push: pushConfigurado() ? chavePublicaPush() : null,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar novidades.' });
  }
});

// Abriu a lista: tudo até `ate` (a novidade mais nova que o app mostrou) fica
// visto, em todos os aparelhos. Nunca volta pra trás nem passa de agora.
router.post('/vistas', async (req, res) => {
  try {
    const ate = new Date(req.body && req.body.ate);
    const valido = !isNaN(ate.getTime()) && ate.getTime() <= Date.now() + 60000;
    const r = await pool.query(
      `/* novidades:marcar-vistas */
       UPDATE usuarios SET novidades_vistas_ate = GREATEST(COALESCE(novidades_vistas_ate, $2::timestamptz), $2::timestamptz)
       WHERE id = $1 RETURNING novidades_vistas_ate`,
      [req.usuario.id, valido ? ate.toISOString() : new Date().toISOString()]);
    res.json({ vistas_ate: r.rows[0] ? r.rows[0].novidades_vistas_ate : null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao marcar novidades como vistas.' });
  }
});

function inscricaoDoCorpo(body) {
  const endpoint = body && body.endpoint;
  const keys = (body && body.keys) || {};
  const chaveOk = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200 && /^[A-Za-z0-9_\-=]+$/.test(v);
  if (!endpointPushValido(endpoint) || !chaveOk(keys.p256dh) || !chaveOk(keys.auth)) return null;
  return { endpoint, p256dh: keys.p256dh, auth: keys.auth };
}

// "Ativar avisos no celular": guarda a inscrição Web Push deste aparelho.
router.post('/push/inscrever', async (req, res) => {
  try {
    if (!pushConfigurado()) return res.status(503).json({ erro: 'Avisos no celular ainda não estão configurados no servidor.' });
    const insc = inscricaoDoCorpo(req.body);
    if (!insc) return res.status(400).json({ erro: 'Inscrição de aviso inválida.' });
    await pool.query(
      `/* push:inscrever */
       INSERT INTO push_inscricoes (usuario_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET usuario_id = EXCLUDED.usuario_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [req.usuario.id, insc.endpoint, insc.p256dh, insc.auth]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao ativar avisos no celular.' });
  }
});

router.post('/push/cancelar', async (req, res) => {
  try {
    const endpoint = req.body && req.body.endpoint;
    if (typeof endpoint !== 'string' || !endpoint) return res.status(400).json({ erro: 'Informe o endpoint.' });
    await pool.query('/* push:cancelar */ DELETE FROM push_inscricoes WHERE endpoint = $1 AND usuario_id = $2', [endpoint, req.usuario.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao desativar avisos no celular.' });
  }
});

// "Enviar aviso de teste": só pros aparelhos de quem pediu, na hora (fora da
// regra de horário) - confirma que a ativação funcionou.
router.post('/push/teste', async (req, res) => {
  try {
    if (!pushConfigurado()) return res.status(503).json({ erro: 'Avisos no celular ainda não estão configurados no servidor.' });
    const inscricoes = await pool.query(
      '/* push:inscricoes-usuario */ SELECT id, endpoint, p256dh, auth FROM push_inscricoes WHERE usuario_id = $1',
      [req.usuario.id]);
    const payload = JSON.stringify({
      titulo: '🔔 Avisos do Cortag ativados',
      texto: 'Você vai receber aqui quando um relatório ou tabela nova for importada.',
      tag: 'teste',
      url: './index.html#novidades',
    });
    let enviados = 0;
    for (const i of inscricoes.rows) if (await enviarPush(i, payload, 'teste')) enviados++;
    res.json({ enviados, aparelhos: inscricoes.rows.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao enviar aviso de teste.' });
  }
});

module.exports = router;
