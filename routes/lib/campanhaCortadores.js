'use strict';

const { SQL_HOJE_BR, SQL_PEDIDO_APP_VALIDO, sqlDiaDoPedido } = require('./comprasApp');
const { sqlFaturadoDeFato } = require('./faturadoDeFato');

// Campanha "Cortadores manuais - desconto extra pro cliente" (Canal Varejo),
// e-mail da Adm. de Vendas (Paloma Mantovani, 10/2026) com a planilha
// "Campanha_Cortadores_Manuais...xlsx", aba "Clientes - Desconto Extra 5%":
// de 01/09 a 30/11/2026, cliente do Varejo que ainda não comprou cortador
// manual em 2026 ganha 5% sobre o PREÇO FIXO nas compras do PRIMEIRO MÊS de
// compra ("válido apenas no mês da primeira compra"; no ERP o vendedor lança no
// campo Desconto Adicional). A lista de clientes elegíveis é a da planilha
// ("Atualizado em Setembro 2026 - sem compras de cortadores manuais até agosto"),
// mantida aqui à mão como a de subfamílias. Lista nova = trocar CODIGOS.
//
// O app recebe no /api/clientes/sync, por cliente da lista, até quando o
// desconto vale: sem compra de cortador manual desde 01/09 = até 30/11; com
// compra = até o fim do mês da 1ª compra. A 1ª compra é o dia mais antigo entre
// o pedido no ERP (implantação; carteira inclusive) e o pedido do app - o pedido
// fechado hoje abre o mês da campanha e o desconto continua valendo até o fim
// dele. Pedido implantado antes de 01/09 conta pelo faturamento (a planilha é
// por faturamento: pedido de 28/08 faturado em setembro ainda está na lista).

const CAMPANHA = {
  inicio: '2026-09-01',
  fim: '2026-11-30',
  pct: 5,
  familia: 'CORTADORES MANUAIS', // "01 - CORTADORES MANUAIS" na Lista de Preços
  canal: 'VAREJO',
};

const CODIGOS = new Set(`
13556 222171 288056 211657 213107 214169 10922 23824 274558 20405 221664 225624 23713 285500 284579 288498
15438 25196 8147 287870 5501 10268 283465 212834 284571 278173 26185 21947 276320 285275 214163 14661 278172
27284 6590 6968 10714 276669 14542 31255 222907 282781 285559 289360 212630 11730 12336 20346 23480 32322
221867 224312 14594 286542 32189 32795 221214 285404 212822 17922 284574 19339 26118 216212 27993 7934 227075
275221 290486 3358 217347 220777 275211 8884 10225 22947 212770 219223 226703 218942 21416 12634 14535 216106
217156 212840 13794 18330 28843 217625 10222 31427 288672 289629 21946 3191 7198 13983 16523 20817 15593 33240
222405 33528 285329 282841 11239 27474 13745 15809 282840 10248 13196 17014 29033 6963 24960 15839 212665
283337 215342 285343 212294 280762 11769 274164 218062 273252 13887 289428 25937 24390 6207 11509 28347 277270
1397 213729 221948 224642 278853 12200 15962 25499 27834 9186 216388 226784 212771 275289 29972 215262 1018 5739
13652 2808 6522 8384 278527 25081 8162 32945 287737 26084 29875 1708 9477 22281 21226 31934 286494 23746 226468
3474 29537 8851 1438 224553 217198 6240 23464 223008 287363 12564 275124 22114 27994 23199 278895 3173 18331
19526 12975 9753 221425 32271 2563 215141 17625 225891 20079 21998 2106 10506 8359 20204 9472 9094 276341 21358
26170 21921 282312 213328 16721 22426 1444 1663 217518 2839 33120 22691 22328 27001 23388 6116 1853 222259 27592
27285 26174 211604 28321 10427 3447 218589 11797 22236 6673 26679 25432 15932 215724
`.trim().split(/\s+/));

// último dia do mês de 'AAAA-MM-DD' (texto, sem fuso)
function fimDoMes(iso) {
  const [a, m] = iso.slice(0, 7).split('-').map(Number);
  const ultimo = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return `${iso.slice(0, 7)}-${String(ultimo).padStart(2, '0')}`;
}

// Até quando o desconto vale pro cliente (texto AAAA-MM-DD), ou null se não
// vale mais hoje. primeira = dia da 1ª compra de cortador manual desde o
// início da campanha (null = ainda não comprou).
function validoAteDoCliente(primeira, hoje) {
  if (hoje < CAMPANHA.inicio || hoje > CAMPANHA.fim) return null;
  let ate = CAMPANHA.fim;
  if (primeira) {
    const fim = fimDoMes(primeira);
    if (fim < ate) ate = fim;
  }
  return hoje <= ate ? ate : null;
}

// Map codigo_oficial -> { ate, primeira, valor12m } dos clientes da lista que
// ainda têm o desconto hoje (dia de Brasília). valor12m (faturado de fato em
// 12 meses) ordena a lista da aba Clientes: quem comprava mais primeiro.
async function clientesComDescontoCortadores(pool) {
  const { rows: [h] } = await pool.query(`SELECT ${SQL_HOJE_BR}::text AS hoje`);
  const hoje = h && h.hoje;
  if (!hoje || hoje < CAMPANHA.inicio || hoje > CAMPANHA.fim) return new Map();
  const codigos = [...CODIGOS];
  const familia = `%${CAMPANHA.familia}%`;
  const [compras, valores] = await Promise.all([
    pool.query(
      `WITH cm AS (SELECT codigo_sku FROM catalogo_precos WHERE familia ILIKE $3),
       dias AS (
         SELECT p.cliente_codigo_oficial AS cod,
                CASE WHEN coalesce(p.data_implantacao, p.data_faturamento) >= $1::date
                     THEN coalesce(p.data_implantacao, p.data_faturamento) ELSE p.data_faturamento END AS dia
         FROM pedidos_oficiais_itens p
         WHERE p.cliente_codigo_oficial = ANY($2::text[]) AND p.quantidade > 0
           AND regexp_replace(p.codigo_sku, '^P[12]?', '') IN (SELECT codigo_sku FROM cm)
         UNION ALL
         SELECT c.codigo_oficial, ${sqlDiaDoPedido('ped')}
         FROM pedidos ped
         JOIN clientes c ON c.id = ped.cliente_id
         JOIN pedido_itens pi ON pi.pedido_id = ped.id
         JOIN produtos pr ON pr.id = pi.produto_id
         WHERE ${SQL_PEDIDO_APP_VALIDO} AND c.codigo_oficial = ANY($2::text[]) AND pi.quantidade > 0
           AND regexp_replace(pr.codigo_sku, '^P[12]?', '') IN (SELECT codigo_sku FROM cm)
       )
       SELECT cod, min(dia)::text AS primeira FROM dias WHERE dia >= $1::date GROUP BY cod`,
      [CAMPANHA.inicio, codigos, familia]
    ),
    pool.query(
      `SELECT p.cliente_codigo_oficial AS cod, sum(p.valor) AS valor
       FROM pedidos_oficiais_itens p
       WHERE p.cliente_codigo_oficial = ANY($1::text[]) AND ${sqlFaturadoDeFato('p')}
         AND p.data_faturamento > ${SQL_HOJE_BR} - 365
       GROUP BY 1`,
      [codigos]
    ),
  ]);
  const primeiraPorCod = new Map(compras.rows.map(r => [String(r.cod), String(r.primeira).slice(0, 10)]));
  const valorPorCod = new Map(valores.rows.map(r => [String(r.cod), Number(r.valor) || 0]));
  const res = new Map();
  for (const cod of codigos) {
    const primeira = primeiraPorCod.get(cod) || null;
    const ate = validoAteDoCliente(primeira, hoje);
    if (ate) res.set(cod, { ate, primeira, valor12m: Math.round((valorPorCod.get(cod) || 0) * 100) / 100 });
  }
  return res;
}

module.exports = { CAMPANHA, CODIGOS, fimDoMes, validoAteDoCliente, clientesComDescontoCortadores };
