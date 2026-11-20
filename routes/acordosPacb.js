const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Acordo PACB (Plano de Ambientação Cortag Brasil 2026, expositores perfurados).
// O formulário oficial é preenchido e assinado (cliente + representante) no
// celular e o PDF sai pelo compartilhar pro gerente, que assina por fora - o
// servidor só guarda o acordo pra mostrar o acompanhamento no card do cliente
// (valor, prazo de 6 meses e quanto já faturou, no /api/clientes/sync).
// `id_envio` (gerado no aparelho) = reenvio da fila offline devolve o já gravado.

// R$ 7.500 por expositor, até 2 por CNPJ/código (somando os dois modelos)
const VALOR_POR_EXPOSITOR = 7500;
const EXPOSITORES_MAX = 2;

function texto(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

// dia AAAA-MM-DD que existe no calendário
function diaValido(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const clienteId = Number(b.cliente_id);
    const q62522 = Number(b.qtd_62522 || 0);
    const q62521 = Number(b.qtd_62521 || 0);
    const total = q62522 + q62521;
    const dataAcordo = texto(b.data_acordo, 10);
    const idEnvio = texto(b.id_envio, 64);
    const responsavel = texto(b.responsavel, 100);
    // um dia de folga no futuro: o celular pode estar no fuso de outro estado
    const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    if (!Number.isInteger(clienteId) || clienteId <= 0 || !Number.isInteger(q62522) || !Number.isInteger(q62521)
        || q62522 < 0 || q62521 < 0 || total < 1 || total > EXPOSITORES_MAX
        || !diaValido(dataAcordo) || dataAcordo > amanha || !responsavel
        || !/^[A-Za-z0-9_-]{8,64}$/.test(idEnvio)) {
      return res.status(422).json({ erro: 'Acordo PACB com dados inválidos.' });
    }
    const cliente = await pool.query('SELECT id FROM clientes WHERE id = $1', [clienteId]);
    if (cliente.rows.length === 0) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    await pool.query(
      `/* acordos-pacb:gravar */
       INSERT INTO acordos_pacb (cliente_id, data_acordo, qtd_62522, qtd_62521, valor, responsavel, usuario_id, id_envio)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id_envio) DO NOTHING`,
      [clienteId, dataAcordo, q62522, q62521, total * VALOR_POR_EXPOSITOR, responsavel, req.usuario ? req.usuario.id : null, idEnvio]);
    const r = await pool.query(
      `/* acordos-pacb:por-envio */
       SELECT id, cliente_id, data_acordo::text AS data_acordo, qtd_62522, qtd_62521, valor, responsavel, id_envio
       FROM acordos_pacb WHERE id_envio = $1`, [idEnvio]);
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao gravar o acordo PACB.' });
  }
});

module.exports = router;
module.exports.VALOR_POR_EXPOSITOR = VALOR_POR_EXPOSITOR;
