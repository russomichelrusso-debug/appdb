// Registro de visita (10/2026, item 3 da "Localização do cliente"). Decisões
// do usuário: visita = levantamento salvo; cada vendedor vê SÓ AS DELE (pelo
// usuário logado, levantamentos.usuario_id); cruzamento com janela de 60 dias.
// Uma visita por cliente por dia de Brasília.
//
// Devolve, por cliente, a última visita do usuário e a última compra (entrada
// do pedido no ERP pela implantação, carteira + faturado, sem a série de 7
// dígitos - mesma régua da Recompra e do "Para reativar" - ou pedido do app),
// mais o faturado de fato em 12 meses (quem compra mais vem primeiro). Entra
// quem ele já visitou ou quem comprou em 12 meses. As duas listas ("visitado
// e não comprou", "compra e não é visitado") o app monta com a data de hoje
// (cruzarVisitasCompras, index.html): também sem internet e logo depois de
// salvar um levantamento na fila offline.
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { SQL_PEDIDO_APP_VALIDO, sqlDiaDoPedido, SQL_HOJE_BR, FUSO } = require('./lib/comprasApp');
const { diaISO, somarDias } = require('./lib/ritmoCompra');
const { sqlFaturadoDeFato } = require('./lib/faturadoDeFato');
const { clientesDeOutroVendedor } = require('./lib/contasSalesforce');

const JANELA_DIAS = 60;
const COMPRA_DIAS = 365;

function hojeBrasil() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

router.get('/', async (req, res) => {
  try {
    const hoje = hojeBrasil();
    const [clientes, visitas, oficial, app, fat] = await Promise.all([
      pool.query(
        `/* visitas:clientes */
         SELECT c.id, c.nome, c.codigo_oficial, f.municipio
         FROM clientes c LEFT JOIN cliente_cnpj_ficha f ON f.cliente_id = c.id`),
      pool.query(
        `/* visitas:ultimas */
         SELECT cliente_id, max((data_visita AT TIME ZONE '${FUSO}')::date)::text AS ultima,
                count(DISTINCT (data_visita AT TIME ZONE '${FUSO}')::date)::int AS total
         FROM levantamentos WHERE usuario_id = $1 AND cliente_id IS NOT NULL GROUP BY 1`,
        [req.usuario.id]),
      pool.query(
        `/* visitas:ultima-oficial */
         SELECT cliente_codigo_oficial AS codigo, max(COALESCE(data_implantacao, data_faturamento))::text AS ultima
         FROM pedidos_oficiais_itens WHERE length(nr_pedido) <= 6 GROUP BY 1`),
      pool.query(
        `/* visitas:ultima-app */
         SELECT ped.cliente_id, max(${sqlDiaDoPedido()})::text AS ultima
         FROM pedidos ped WHERE ped.cliente_id IS NOT NULL AND ${SQL_PEDIDO_APP_VALIDO} GROUP BY 1`),
      pool.query(
        `/* visitas:fat-12m */
         SELECT poi.cliente_codigo_oficial AS codigo, sum(poi.valor) AS total
         FROM pedidos_oficiais_itens poi
         WHERE ${sqlFaturadoDeFato('poi')} AND poi.data_faturamento > ${SQL_HOJE_BR} - ${COMPRA_DIAS}
         GROUP BY 1`),
    ]);

    const visitaPorCliente = new Map(visitas.rows.map(v => [String(v.cliente_id), v]));
    const ultimaOficial = new Map(oficial.rows.map(l => [String(l.codigo), l.ultima && diaISO(l.ultima)]));
    const ultimaApp = new Map(app.rows.map(l => [String(l.cliente_id), l.ultima && diaISO(l.ultima)]));
    const fat12m = new Map(fat.rows.map(l => [String(l.codigo), Number(l.total)]));
    const desdeCompra = somarDias(hoje, -COMPRA_DIAS);

    const lista = [];
    const outros = await clientesDeOutroVendedor();
    for (const c of clientes.rows) {
      // ativo com outro vendedor (Salesforce): não é visita a cobrar
      if (outros.has(String(c.id))) continue;
      const id = String(c.id);
      const visita = visitaPorCliente.get(id);
      const ultimaCompra = [c.codigo_oficial ? ultimaOficial.get(String(c.codigo_oficial)) : null, ultimaApp.get(id)]
        .filter(Boolean).sort().pop() || null;
      // compra "no futuro" (implantação digitada errada) não esconde nada
      const compra = ultimaCompra && ultimaCompra <= hoje ? ultimaCompra : null;
      if (!visita && !(compra && compra > desdeCompra)) continue;
      lista.push({
        cliente_id: c.id,
        nome: c.nome,
        cidade: c.municipio || null,
        ultima_visita: visita ? diaISO(visita.ultima) : null,
        visitas: visita ? visita.total : 0,
        ultima_compra: compra,
        fat_12m: (c.codigo_oficial && fat12m.get(String(c.codigo_oficial))) || 0,
      });
    }
    res.json({ hoje, janelaDias: JANELA_DIAS, clientes: lista });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao montar o registro de visitas.' });
  }
});

module.exports = router;
