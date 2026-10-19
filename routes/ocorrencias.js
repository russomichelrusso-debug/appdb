const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { horaDoPedidoDoApp } = require('./pedidos');

// Ocorrência no Pós-Vendas da Cortag (botão "Abrir ocorrência" no card do
// pedido oficial com NF). O e-mail com as fotos sai do celular do vendedor
// (compartilhar › Gmail); o servidor só guarda o registro, gravado quando ele
// confirma "Enviei" ao voltar pro app, pro selo "Ocorrência aberta" aparecer
// pra todos os vendedores (decisão do usuário, 10/2026) até alguém marcar
// resolvida. A lista do cliente vai junto com os pedidos oficiais
// (GET /api/pedidos-oficiais/:clienteId, `ocorrencias`).

// Mesmos tipos do e-mail "ABERTURA DE OCORRÊNCIAS - PADRÃO ENVIO DE E-MAILS"
// do Pós-Vendas (10/2026) - os rótulos ficam no app (TIPOS_OCORRENCIA).
// Nr.Pedido e NF como o importador grava (normalmente só dígitos, mas texto que
// não é número passa como veio, ex.: "245118-1")
const NUMERO_DOC = /^[0-9A-Za-z./-]{1,20}$/;
const TIPOS = ['faltando_item', 'faltando_volume', 'avariado', 'trocado', 'desacordo', 'atraso', 'outros'];

function texto(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

// Hora do toque em "Enviei": a fila offline pode mandar dias depois. O app manda
// a hora do toque (`hora_toque`) e o apiFetch carimba `enviado_em` em cada envio;
// a espera entre as duas, descontada do relógio do servidor, dá a hora certa sem
// depender do relógio do celular (mesma conta do pedido do app, horaDoPedidoDoApp).
// Sem elas: agora.
router.post('/', async (req, res) => {
  try {
    const b = req.body || {};
    const clienteId = Number(b.cliente_id);
    const nrPedido = texto(b.nr_pedido, 20);
    const notaFiscal = texto(b.nota_fiscal, 20);
    const tipo = texto(b.tipo, 30);
    const idEnvio = texto(b.id_envio, 64);
    if (!Number.isInteger(clienteId) || clienteId <= 0 || !NUMERO_DOC.test(nrPedido) || !NUMERO_DOC.test(notaFiscal)
        || !TIPOS.includes(tipo) || !/^[A-Za-z0-9_-]{8,64}$/.test(idEnvio)) {
      return res.status(422).json({ erro: 'Ocorrência com dados inválidos.' });
    }
    const cliente = await pool.query('SELECT id FROM clientes WHERE id = $1', [clienteId]);
    if (cliente.rows.length === 0) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    // reenvio do mesmo id_envio (resposta perdida, fila offline) devolve o já gravado
    await pool.query(
      `/* ocorrencias:gravar */
       INSERT INTO ocorrencias_pos_venda (cliente_id, nr_pedido, nota_fiscal, tipo, resumo, enviado_em, usuario_id, id_envio)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (id_envio) DO NOTHING`,
      [clienteId, nrPedido, notaFiscal, tipo, texto(b.resumo, 300) || null, horaDoPedidoDoApp(b.hora_toque, b.enviado_em) || new Date().toISOString(), req.usuario ? req.usuario.id : null, idEnvio]);
    const r = await pool.query(
      `/* ocorrencias:por-envio */
       SELECT id, cliente_id, nr_pedido, nota_fiscal, tipo, resumo, enviado_em, resolvida_em, id_envio
       FROM ocorrencias_pos_venda WHERE id_envio = $1`, [idEnvio]);
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao gravar a ocorrência.' });
  }
});

// Marca (ou desmarca) resolvida - qualquer vendedor, como o selo é de todos.
router.patch('/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0 || typeof (req.body || {}).resolvida !== 'boolean') {
      return res.status(422).json({ erro: 'Ocorrência com dados inválidos.' });
    }
    const r = await pool.query(
      `/* ocorrencias:resolver */
       UPDATE ocorrencias_pos_venda
       SET resolvida_em = CASE WHEN $2 THEN COALESCE(resolvida_em, now()) ELSE NULL END
       WHERE id = $1
       RETURNING id, cliente_id, nr_pedido, nota_fiscal, tipo, resumo, enviado_em, resolvida_em, id_envio`,
      [id, req.body.resolvida]);
    if (r.rows.length === 0) return res.status(404).json({ erro: 'Ocorrência não encontrada.' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao atualizar a ocorrência.' });
  }
});

module.exports = router;
module.exports.TIPOS_OCORRENCIA = TIPOS;
