const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Devolve uma configuração pelo nome da chave - qualquer usuário logado pode
// ler (ex: campanhas promocionais valem pra todo mundo, não só pro admin).
router.get('/:chave', async (req, res) => {
  try {
    const result = await pool.query('SELECT valor, atualizado_em FROM configuracoes WHERE chave = $1', [req.params.chave]);
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Configuração não encontrada.' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar configuração.' });
  }
});

// Substitui o valor inteiro de uma configuração - só admin, já que isso
// afeta o que todo mundo vê (ex: desconto promocional aplicado sozinho).
router.post('/:chave', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode alterar configurações.' });
  const { valor } = req.body;
  if (valor === undefined) return res.status(400).json({ erro: 'Envie { valor: ... }' });
  try {
    await pool.query(
      `INSERT INTO configuracoes (chave, valor, atualizado_em) VALUES ($1, $2, now())
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`,
      [req.params.chave, JSON.stringify(valor)]
    );
    console.log(`Configuração "${req.params.chave}" atualizada por ${req.usuario?.email}.`);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao salvar configuração.' });
  }
});

module.exports = router;
