// Recompra da semana: clientes cuja próxima compra, pelo ritmo dos últimos 12
// meses, está atrasada ou cai nos próximos 7 dias - com os produtos pra
// "Montar proposta" (cálculo em routes/lib/ritmoCompra.js).
//
// O que conta como compra é a ENTRADA do pedido: relatório oficial (carteira +
// faturado) pela data de implantação + pedidos do app - assim o cliente sai da
// lista assim que pede, sem esperar faturar. Sem a série de pedidos de 7
// dígitos (itens avulsos de valor baixo, fora do catálogo - mesma regra da
// Entrada de Pedidos do Dashboard). Pedido do app que já está no relatório
// oficial não conta de novo (routes/lib/comprasApp.js). Código promocional
// (P/P1/P2) conta como o produto base.
// Datas saem do banco como texto (AAAA-MM-DD): DATE vira Date na meia-noite
// do fuso do servidor e poderia andar um dia.
//
// "Já falei" (POST /:id/adiar) tira o cliente da lista por 7 dias; vale em
// todos os aparelhos (tabela recompra_adiamentos).
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { codigoBase } = require('./lib/skuNormalizacao');
const { SQL_PEDIDO_APP_VALIDO, sqlDiaDoPedido, indexarDatasOficiais, pedidoAppJaFaturado } = require('./lib/comprasApp');
const { validarIdInteiro } = require('../middleware/validarId');
const {
  JANELA_DIAS, diaISO, somarDias, diasEntre,
  juntarCompras, ritmoDasCompras, situacaoDoRitmo, itensDaProposta,
} = require('./lib/ritmoCompra');

router.param('id', validarIdInteiro);

const ADIAR_DIAS = 7;
const ORDEM_SITUACAO = { atrasado: 0, fora: 1, semana: 2 };

function hojeBrasil() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

router.get('/', async (req, res) => {
  try {
    const hoje = hojeBrasil();
    const [clientes, oficial, app, produtos, adiamentos, dadosAte] = await Promise.all([
      pool.query('/* recompra:clientes */ SELECT id, nome, documento, codigo_oficial, classificatorio_tipo FROM clientes'),
      pool.query(
        `/* recompra:oficial */
         SELECT cliente_codigo_oficial, codigo_sku, quantidade,
                COALESCE(data_implantacao, data_faturamento)::text AS data, data_faturamento::text AS data_faturamento
         FROM pedidos_oficiais_itens
         WHERE COALESCE(data_implantacao, data_faturamento) > $1::date - $2::int
           AND length(nr_pedido) <= 6`,
        [hoje, JANELA_DIAS]),
      pool.query(
        `/* recompra:app */
         SELECT ped.cliente_id, p.codigo_sku, pi.quantidade, ${sqlDiaDoPedido()}::text AS data
         FROM pedidos ped
         JOIN pedido_itens pi ON pi.pedido_id = ped.id
         JOIN produtos p ON p.id = pi.produto_id
         WHERE ped.cliente_id IS NOT NULL AND ${sqlDiaDoPedido()} > $1::date - $2::int
           AND ${SQL_PEDIDO_APP_VALIDO}`,
        [hoje, JANELA_DIAS]),
      pool.query('SELECT codigo_sku, nome FROM produtos'),
      pool.query('/* recompra:adiamentos */ SELECT cliente_id, ate::text AS ate FROM recompra_adiamentos WHERE ate >= $1::date', [hoje]),
      pool.query('/* recompra:dados-ate */ SELECT max(data_implantacao)::text AS ate FROM pedidos_oficiais_itens'),
    ]);

    const nomePorCodigo = new Map(produtos.rows.map(p => [String(p.codigo_sku), p.nome]));
    const codigosConhecidos = new Set(nomePorCodigo.keys());
    const skuDe = (l) => codigoBase(String(l.codigo_sku), codigosConhecidos);
    const clientePorCodigo = new Map();
    for (const c of clientes.rows) if (c.codigo_oficial) clientePorCodigo.set(String(c.codigo_oficial), c);
    const clientePorId = new Map(clientes.rows.map(c => [String(c.id), c]));
    const adiadoAte = new Map(adiamentos.rows.map(a => [String(a.cliente_id), diaISO(a.ate)]));

    // pedido do app já no relatório oficial (implantado ou faturado na janela
    // de comprasApp.js) = a mesma compra
    const datasOficiais = indexarDatasOficiais(
      oficial.rows.flatMap(l => [l, l.data_faturamento ? { ...l, data: l.data_faturamento } : null]).filter(Boolean),
      l => `${l.cliente_codigo_oficial}::${skuDe(l)}`);

    const eventosPorCliente = new Map(); // id -> [{ data, sku, quantidade }]
    const anotar = (cliente, l) => {
      const id = String(cliente.id);
      if (!eventosPorCliente.has(id)) eventosPorCliente.set(id, []);
      eventosPorCliente.get(id).push({ data: diaISO(l.data), sku: skuDe(l), quantidade: Number(l.quantidade) || 0 });
    };
    for (const l of oficial.rows) {
      const c = l.data && clientePorCodigo.get(String(l.cliente_codigo_oficial));
      if (c) anotar(c, l);
    }
    for (const l of app.rows) {
      const c = l.data && clientePorId.get(String(l.cliente_id));
      if (!c) continue;
      if (c.codigo_oficial && pedidoAppJaFaturado(`${c.codigo_oficial}::${skuDe(l)}`, l.data, datasOficiais)) continue;
      anotar(c, l);
    }

    const lista = [];
    for (const [id, eventos] of eventosPorCliente) {
      const comprasCliente = juntarCompras(eventos);
      const ritmo = ritmoDasCompras(comprasCliente, hoje);
      const situacao = situacaoDoRitmo(ritmo);
      if (!situacao) continue;
      const porSku = new Map();
      for (const e of eventos) {
        if (!nomePorCodigo.has(e.sku)) continue; // fora do catálogo: não vai pro orçamento
        if (!porSku.has(e.sku)) porSku.set(e.sku, []);
        porSku.get(e.sku).push(e);
      }
      const comprasPorSku = new Map([...porSku].map(([sku, evs]) => [sku, juntarCompras(evs)]));
      const cliente = clientePorId.get(id);
      lista.push({
        cliente_id: cliente.id,
        nome: cliente.nome,
        documento: cliente.documento || null,
        classificatorio_tipo: cliente.classificatorio_tipo || null,
        situacao,
        ...ritmo,
        adiado_ate: adiadoAte.get(id) || null,
        itens: itensDaProposta(ritmo, comprasCliente, comprasPorSku, hoje, porSku)
          .map(it => ({ ...it, nome: nomePorCodigo.get(it.codigo_sku) })),
      });
    }
    lista.sort((a, b) => ORDEM_SITUACAO[a.situacao] - ORDEM_SITUACAO[b.situacao]
      || (a.situacao === 'semana' ? a.previsao.localeCompare(b.previsao) : a.atraso_dias - b.atraso_dias)
      || String(a.nome).localeCompare(String(b.nome)));

    res.json({
      hoje,
      dados_ate: dadosAte.rows[0] && dadosAte.rows[0].ate ? diaISO(dadosAte.rows[0].ate) : null,
      clientes: lista,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao montar a recompra da semana.' });
  }
});

// "Já falei": some da lista por 7 dias. `em` (AAAA-MM-DD) = dia em que o
// vendedor tocou - a fila offline pode mandar dias depois; vale no máximo 30
// dias pra trás e nunca no futuro.
router.post('/:id/adiar', async (req, res) => {
  try {
    const hoje = hojeBrasil();
    const em = String((req.body && req.body.em) || '');
    const desde = /^\d{4}-\d{2}-\d{2}$/.test(em) && em <= hoje && diasEntre(em, hoje) <= 30 ? em : hoje;
    const ate = somarDias(desde, ADIAR_DIAS);
    const cliente = await pool.query('SELECT id FROM clientes WHERE id = $1', [req.params.id]);
    if (cliente.rows.length === 0) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    const r = await pool.query(
      `/* recompra:adiar */
       INSERT INTO recompra_adiamentos (cliente_id, ate, usuario_id) VALUES ($1, $2::date, $3)
       ON CONFLICT (cliente_id) DO UPDATE SET ate = GREATEST(recompra_adiamentos.ate, EXCLUDED.ate),
         usuario_id = EXCLUDED.usuario_id, criado_em = now()
       RETURNING ate::text AS ate`,
      [req.params.id, ate, req.usuario ? req.usuario.id : null]);
    const gravado = r.rows[0] && r.rows[0].ate ? diaISO(r.rows[0].ate) : ate;
    res.json({ cliente_id: Number(req.params.id), adiado_ate: gravado });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao adiar o cliente na recompra.' });
  }
});

module.exports = router;
