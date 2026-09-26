const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { validarIdInteiro } = require('../middleware/validarId');
const { descontoPelaPolitica, chaveTipo } = require('./lib/politicaComercial');

router.param('id', validarIdInteiro);

// Faixas de faturamento líquido dos ÚLTIMOS 12 MESES (régua móvel), somado
// por Matriz/grupo de "empresas irmãs" - Política Comercial rev. 06, item
// 4. Institucional, Construtora, Atacarejo e Home Center Master não têm
// faixa (fixos ou por lista da Cortag). Se a política mudar, ajustar aqui.
const FAIXAS = {
  'Varejo Exclusive': { min: 0, max: 30000, proximaFaixa: 'Varejo Premium' },
  'Varejo Premium': { min: 30000, max: 50000, proximaFaixa: 'Varejo Master', faixaAnterior: 'Varejo Exclusive' },
  'Varejo Master': { min: 50000, max: null, faixaAnterior: 'Varejo Premium' },
  'Atacado Exclusive': { min: 0, max: 300000, proximaFaixa: 'Atacado Premium' },
  'Atacado Premium': { min: 300000, max: 1000000, proximaFaixa: 'Atacado Master', faixaAnterior: 'Atacado Exclusive' },
  'Atacado Master': { min: 1000000, max: null, faixaAnterior: 'Atacado Premium' },
  'E-commerce Exclusive': { min: 0, max: 200000, proximaFaixa: 'E-commerce Premium' },
  'E-commerce Premium': { min: 200000, max: 1000000, proximaFaixa: 'E-commerce Master', faixaAnterior: 'E-commerce Exclusive' },
  'E-commerce Master': { min: 1000000, max: null, faixaAnterior: 'E-commerce Premium' },
  // abaixo de 120 mil a política manda o cliente pras faixas do Varejo (nota 4)
  'Home Center Premium': { min: 120000, max: null, faixaAnterior: 'Varejo Master' },
};
// "E-Commerce Máster" e "E-commerce Master" são a mesma faixa.
const FAIXAS_POR_CHAVE = new Map(Object.entries(FAIXAS).map(([tipo, f]) => [chaveTipo(tipo), f]));
function faixaDoTipo(tipo) {
  return FAIXAS_POR_CHAVE.get(chaveTipo(tipo)) || null;
}

const LIMIAR_PERTO_DE_SUBIR = 0.15; // falta <= 15% do tamanho da faixa conta como "perto"
const DIAS_SEM_COMPRAR_ALERTA = 60; // mesmo limiar já usado na "carteira antiga"

function normalizarDoc(v) {
  return String(v || '').replace(/\D/g, '');
}

// Soma pedidos_oficiais_itens.valor por data_implantacao dentro de
// [periodoInicio, periodoFim] (mesma fórmula corrigida do histórico
// trimestral - sem filtro de status, carteira+faturado juntos) pro grupo
// (matriz_grupo) do cliente - usada pra comparar contra o "Objetivo
// Trimestral" customizado importado do ERP (ver
// router.post('/classificatorio/objetivos-trimestrais/importar') abaixo).
async function calcularEntradaTrimestralPeriodo(pool, cliente, periodoInicio, periodoFim) {
  const ehRede = cliente.classificatorio_tipo === 'Rede';
  const result = await pool.query(
    ehRede
      ? `SELECT COALESCE(SUM(poi.valor), 0) AS entrada
         FROM pedidos_oficiais_itens poi
         WHERE poi.cliente_codigo_oficial = $1
           AND poi.data_implantacao >= $2 AND poi.data_implantacao <= $3`
      : `SELECT COALESCE(SUM(poi.valor), 0) AS entrada
         FROM pedidos_oficiais_itens poi
         JOIN clientes c2 ON poi.cliente_codigo_oficial = c2.codigo_oficial
         WHERE (c2.id = $1 OR (c2.matriz_grupo IS NOT NULL AND c2.matriz_grupo = $4))
           AND poi.data_implantacao >= $2 AND poi.data_implantacao <= $3`,
    ehRede ? [cliente.codigo_oficial, periodoInicio, periodoFim] : [cliente.id, periodoInicio, periodoFim, cliente.matriz_grupo]
  );
  return Number(result.rows[0]?.entrada || 0);
}

// Calcula o status de classificatório (quanto falta pra subir/cair) de um
// cliente. Política Comercial rev. 06 (item 4): a faixa é decidida pelo
// faturamento líquido dos ÚLTIMOS 12 MESES (régua móvel) - apuração mensal,
// pode subir em qualquer mês que bater o teto; ficar abaixo do mínimo da
// própria faixa é risco real de queda (a Cortag ajusta pra baixo em 01/01 e
// 01/07). Meta individual (PIC/Vl.Acordo) continua contra o acumulado do
// ano corrente, com o risco decidido pelo ritmo trimestral.
// `faturamentoFaixa` na resposta = o valor que foi comparado com a faixa
// (a barra de progresso do app usa esse).
// Função pura - sem acesso a banco - pra ser testável direto.
function calcularStatusClassificatorio({ tipo, pic, vlAcordo, faturamento12m, faturamentoAnoCorrente, atrasadoNoRitmo }) {
  const fat12m = Number(faturamento12m) || 0;
  const fatAnoCorrente = Number(faturamentoAnoCorrente) || 0;
  if (!tipo) return { classificado: false };

  const base = { classificado: true, tipo, faturamento12m: fat12m };

  if (tipo === 'Rede') {
    // Acordo bilateral com a rede/cooperativa de compras - não depende de
    // faturamento, nunca tem "falta pra subir/cair".
    return { ...base, ehRede: true, semMeta: true };
  }

  if (pic && vlAcordo) {
    // Meta individual negociada à parte (PIC), substitui a faixa padrão.
    const falta = Math.max(0, Number(vlAcordo) - fatAnoCorrente);
    return { ...base, faturamentoFaixa: fatAnoCorrente, metaIndividual: Number(vlAcordo), faltaPraMeta: falta, emRiscoDeQueda: !!atrasadoNoRitmo, faixaMin: 0, faixaMax: Number(vlAcordo) };
  }

  const faixa = faixaDoTipo(tipo);
  if (!faixa) return { ...base, semFaixaDefinida: true };

  const fat = fat12m;
  base.faturamentoFaixa = fat;
  if (fat < faixa.min) {
    // Abaixo do mínimo da própria faixa nos últimos 12 meses - risco real
    // de cair no próximo ajuste (01/01 ou 01/07).
    return {
      ...base,
      emRiscoDeQueda: true,
      faixaAnterior: faixa.faixaAnterior || null,
      faltaPraManter: faixa.min - fat,
      faixaMin: 0,
      faixaMax: faixa.min,
    };
  }
  if (faixa.max != null && fat < faixa.max) {
    // Dentro da faixa, mas ainda não bateu o teto pra promover.
    return {
      ...base,
      emRiscoDeQueda: false,
      proximaFaixa: faixa.proximaFaixa || null,
      faltaPraProximaFaixa: faixa.max - fat,
      faixaMin: faixa.min,
      faixaMax: faixa.max,
    };
  }
  // Já bateu o teto da faixa este ano (ou a faixa não tem teto definido) -
  // qualifica pra subir agora mesmo, não precisa esperar o fim do ano.
  return { ...base, emRiscoDeQueda: false, jaQualificaProximaFaixa: !!faixa.proximaFaixa, proximaFaixa: faixa.proximaFaixa || null };
}

// Quebra o faturamento em até 4 trimestres civis (mais recentes primeiro
// na entrada, devolvido em ordem cronológica) e calcula o ritmo necessário
// pros trimestres restantes do ano de referência baterem a meta anual/da
// faixa. `trimestres` = [{ trimestre: 'YYYY-MM-DD' (início do trimestre), faturado }].
// `anoReferencia`/`trimestreReferenciaIdx` (0-3) dizem qual ano e qual é o
// "trimestre atual" pra fins de déficit acumulado/trimestres restantes -
// por padrão usam a data de hoje. A rota de status passa o ANO EM
// ANDAMENTO (o mesmo que vai ser revisado na próxima janeiro) e o
// trimestre atual de verdade - é o que o vendedor quer acompanhar "ao
// vivo"; o ano já fechado não tem mais nada a fazer, então não faz
// sentido medir ritmo contra ele. `trimestres` pode incluir um trimestre
// à direita (trilha, pro gráfico) de fora do ano de referência - a função
// ignora esses pra fins de déficit/ritmo, só desenha no histórico.
function calcularRitmoTrimestral({ tipo, pic, vlAcordo, trimestres, anoReferencia, trimestreReferenciaIdx }) {
  const historico = (trimestres || []).map(t => ({ trimestre: t.trimestre, faturado: Number(t.faturado) || 0 }));
  if (tipo === 'Rede') return { historico, semMeta: true };

  let metaAnual = null;
  if (pic && vlAcordo) metaAnual = Number(vlAcordo);
  else if (faixaDoTipo(tipo)) metaAnual = faixaDoTipo(tipo).max != null ? faixaDoTipo(tipo).max : faixaDoTipo(tipo).min;
  if (metaAnual == null) return { historico, semMeta: true };

  // Piso por trimestre = quanto precisa faturar por trimestre pra não cair
  // da faixa atual (mínimo da própria faixa, dividido em 4). Não se aplica
  // quando não há risco de queda possível (Exclusive, min=0) nem quando a
  // meta é individual (PIC/Vl.Acordo não tem "piso" separado, só a meta).
  const faixaAtual = !pic || !vlAcordo ? faixaDoTipo(tipo) : null;
  const pisoPorTrimestre = faixaAtual && faixaAtual.min > 0 ? faixaAtual.min / 4 : null;

  const metaPorTrimestre = metaAnual / 4;
  const hoje = new Date();
  const trimestreAtualIdx = trimestreReferenciaIdx != null ? trimestreReferenciaIdx : Math.floor(hoje.getMonth() / 3);
  // Trimestres do ano de referência já decorridos (inclusive o atual), na ordem em que aparecem em `historico`.
  const anoCorrente = anoReferencia != null ? anoReferencia : hoje.getFullYear();
  // Mapa idx-do-trimestre -> faturado, só do ano de referência. Precisa
  // disso (em vez de só percorrer `historico`) porque um trimestre SEM
  // nenhuma venda não gera linha nenhuma na consulta SQL (GROUP BY) - se o
  // déficit só somasse os trimestres presentes em `historico`, um
  // trimestre inteiro zerado seria silenciosamente ignorado em vez de
  // contar como falta total da cota.
  const faturadoPorTrimestre = new Map();
  for (const t of historico) {
    const d = new Date(t.trimestre);
    if (d.getFullYear() !== anoCorrente) continue;
    faturadoPorTrimestre.set(Math.floor(d.getMonth() / 3), t.faturado);
  }
  let deficitAcumulado = 0;
  for (let idx = 0; idx < trimestreAtualIdx; idx++) {
    // Trimestre já fechado - soma o déficit (ou crédito) em relação à cota,
    // tratando ausência de dados como faturado = 0.
    deficitAcumulado += metaPorTrimestre - (faturadoPorTrimestre.get(idx) || 0);
  }
  const trimestresRestantes = 4 - trimestreAtualIdx; // inclui o trimestre atual
  const ritmoNecessarioProximoTrimestre = trimestresRestantes > 0
    ? Math.max(0, (metaPorTrimestre * trimestresRestantes + deficitAcumulado) / trimestresRestantes)
    : null;

  let situacao = 'no_ritmo';
  if (deficitAcumulado > metaPorTrimestre * 0.05) situacao = 'atrasado';
  else if (deficitAcumulado < -metaPorTrimestre * 0.05) situacao = 'adiantado';

  // Quanto falta pra bater a meta DESTE trimestre especificamente (não o
  // ritmo pros trimestres seguintes, que já considera o déficit acumulado
  // de trimestres passados) - usado pra destacar na UI "faltam R$X pra
  // atingir a meta trimestral", pedido do usuário pra ficar visível tanto
  // na ficha completa do cliente quanto na barra compacta de cliente.
  const faturadoTrimestreAtual = faturadoPorTrimestre.get(trimestreAtualIdx) || 0;
  const faltaTrimestreAtual = Math.max(0, metaPorTrimestre - faturadoTrimestreAtual);

  return { historico, metaAnual, metaPorTrimestre, pisoPorTrimestre, situacao, ritmoNecessarioProximoTrimestre, faltaTrimestreAtual };
}

// O classificatório usa os ÚLTIMOS 12 MESES (régua móvel) - Política
// Comercial rev. 06, item 4 (decisão do usuário, trocando o ano civil
// fechado que valia antes). Os limites do ano civil abaixo continuam só pro
// comparativo "acumulado do ano corrente x mesmo período do ano anterior"
// da ficha do cliente.
const JANELA_12M_SQL = `CURRENT_DATE - INTERVAL '12 months'`;
const PERIODO_CLASSIFICATORIO_INICIO_SQL = `date_trunc('year', CURRENT_DATE) - INTERVAL '1 year'`;
const PERIODO_CLASSIFICATORIO_FIM_SQL = `date_trunc('year', CURRENT_DATE)`; // exclusivo

// Monta a subconsulta que soma faturamento (do ano civil fechado mais
// recente, ver comentário acima), com `agruparPorMatrizGrupo` decidindo se
// soma junto com as "empresas irmãs" do mesmo matriz_grupo (uso normal -
// classificatório Master/Premium/Exclusive por grupo econômico) ou só o
// próprio cliente (usado pra Rede - ali matriz_grupo guarda o nome da
// REDE/COOPERATIVA de compras, não empresas irmãs do mesmo dono; somar
// tudo misturaria o faturamento de lojas sem nenhuma relação societária
// entre si, então o cliente Rede sempre vê métrica/gráfico só dele mesmo,
// pedido explícito do usuário). Também traz o acumulado do ano EM
// ANDAMENTO (ainda não fechado, não usado pra decidir faixa - só pra o
// vendedor acompanhar o progresso do ano corrente lado a lado com o
// último ano fechado).
function sqlFaturamentoClassificatorioPorCliente(agruparPorMatrizGrupo) {
  const joinC2 = agruparPorMatrizGrupo
    ? `LEFT JOIN clientes c2 ON c2.id = c.id
    OR (c.matriz_grupo IS NOT NULL AND c2.matriz_grupo = c.matriz_grupo)`
    : `LEFT JOIN clientes c2 ON c2.id = c.id`;
  return `
  SELECT c.id AS cliente_id,
         COALESCE(SUM(poi.valor) FILTER (
           WHERE poi.status = 'faturado'
             AND poi.data_faturamento > ${JANELA_12M_SQL}
         ), 0) AS faturamento_12m,
         COALESCE(SUM(poi.valor) FILTER (
           WHERE poi.status = 'faturado'
             AND poi.data_faturamento >= ${PERIODO_CLASSIFICATORIO_FIM_SQL}
         ), 0) AS faturamento_ano_corrente,
         -- Mesmo período do ano fechado (mesma contagem de dias decorridos
         -- no ano corrente, mas no ano anterior) - pra comparar "evolução
         -- justa" (Jan-Set/ano corrente vs Jan-Set/ano anterior), em vez do
         -- ano fechado INTEIRO, que sempre parece maior só porque o ano
         -- corrente ainda não terminou. Pedido do usuário na aba Clientes.
         COALESCE(SUM(poi.valor) FILTER (
           WHERE poi.status = 'faturado'
             AND poi.data_faturamento >= ${PERIODO_CLASSIFICATORIO_INICIO_SQL}
             AND poi.data_faturamento < ${PERIODO_CLASSIFICATORIO_INICIO_SQL} + (CURRENT_DATE - ${PERIODO_CLASSIFICATORIO_FIM_SQL})
         ), 0) AS faturamento_mesmo_periodo_ano_anterior,
         MAX(poi.data_faturamento) FILTER (WHERE poi.status = 'faturado') AS ultima_compra
  FROM clientes c
  ${joinC2}
  LEFT JOIN pedidos_oficiais_itens poi ON poi.cliente_codigo_oficial = c2.codigo_oficial
`;
}
// Reaproveitada pelo status individual (clientes não-Rede) e pelos alertas
// em lote - continua exportada com o mesmo nome pra não quebrar quem já
// importa (routes/relatorios.js).
const SQL_FATURAMENTO_CLASSIFICATORIO_POR_CLIENTE = sqlFaturamentoClassificatorioPorCliente(true);
// Variante individual (sem somar matriz_grupo) - só pra clientes Rede.
const SQL_FATURAMENTO_CLASSIFICATORIO_INDIVIDUAL_POR_CLIENTE = sqlFaturamentoClassificatorioPorCliente(false);

// Status de classificatório de UM cliente - aberto pra qualquer usuário
// logado (não é ação de admin, é consulta do dia a dia na ficha do cliente).
router.get('/:id/classificatorio/status', async (req, res) => {
  try {
    const clienteResult = await pool.query('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
    const cliente = clienteResult.rows[0];
    if (!cliente) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    if (!cliente.classificatorio_tipo) return res.json({ classificado: false });
    const ehRede = cliente.classificatorio_tipo === 'Rede';

    // O ano fechado (usado só pra rotular a resposta e fechar os 4 trimestres
    // em calcularRitmoTrimestral) vem do PRÓPRIO Postgres, na mesma consulta -
    // nunca de um "new Date()" separado no Node, que teria que só torcer pra
    // concordar com o fuso do CURRENT_DATE do banco. Cliente Rede usa a
    // variante INDIVIDUAL (sem somar matriz_grupo) - ver comentário na
    // função sqlFaturamentoClassificatorioPorCliente.
    const fatResult = await pool.query(
      `SELECT sub.*, EXTRACT(YEAR FROM ${PERIODO_CLASSIFICATORIO_INICIO_SQL})::int AS ano_fechado,
              EXTRACT(YEAR FROM CURRENT_DATE)::int AS ano_atual,
              EXTRACT(QUARTER FROM CURRENT_DATE)::int - 1 AS trimestre_atual_idx
       FROM (${ehRede ? SQL_FATURAMENTO_CLASSIFICATORIO_INDIVIDUAL_POR_CLIENTE : SQL_FATURAMENTO_CLASSIFICATORIO_POR_CLIENTE} WHERE c.id = $1 GROUP BY c.id) sub`,
      [req.params.id]
    );
    const faturamento12m = fatResult.rows[0] ? Number(fatResult.rows[0].faturamento_12m) : 0;
    const faturamentoAnoCorrente = fatResult.rows[0] ? Number(fatResult.rows[0].faturamento_ano_corrente) : 0;
    const faturamentoMesmoPeriodoAnoAnterior = fatResult.rows[0] ? Number(fatResult.rows[0].faturamento_mesmo_periodo_ano_anterior) : 0;
    const ultimaCompra = fatResult.rows[0] ? fatResult.rows[0].ultima_compra : null;
    const anoPeriodo = fatResult.rows[0] ? Number(fatResult.rows[0].ano_fechado) : new Date().getUTCFullYear() - 1;
    const anoAtual = fatResult.rows[0] ? Number(fatResult.rows[0].ano_atual) : new Date().getUTCFullYear();
    const trimestreAtualIdx = fatResult.rows[0] ? Number(fatResult.rows[0].trimestre_atual_idx) : Math.floor(new Date().getUTCMonth() / 3);

    // Trilha dos últimos trimestres pra "acompanhar os trimestres recentes"
    // (pedido do usuário) - janela móvel encerrando no trimestre EM
    // ANDAMENTO agora, não presa ao ano civil já fechado da faixa (que só
    // mostraria trimestres cada vez mais velhos conforme o ano avança).
    // Calculado ANTES de calcularStatusClassificatorio porque o resultado
    // (situação atrasado/no_ritmo/adiantado) agora também decide se o
    // cliente está de fato em risco de queda (ver comentário na função).
    // Cliente Rede: só o próprio codigo_oficial (sem OR matriz_grupo) - o
    // "grupo" dele é a rede/cooperativa inteira, não empresas irmãs.
    // Soma por data_implantacao (entrada do pedido no ERP), sem filtrar por
    // status - bate com a metodologia do relatório oficial de "Entrada
    // Realizada" (conta carteira + faturado, reconhecimento por pedido
    // lançado, não por nota fiscal emitida). Ver plano "Meta trimestral
    // oficial" pra validação cliente a cliente contra a planilha oficial.
    const trimResult = await pool.query(
      ehRede
        ? `SELECT date_trunc('quarter', poi.data_implantacao) AS trimestre, SUM(poi.valor) AS faturado
           FROM pedidos_oficiais_itens poi
           JOIN clientes c ON c.id = $1
           WHERE poi.cliente_codigo_oficial = c.codigo_oficial
             AND poi.data_implantacao >= date_trunc('quarter', CURRENT_DATE) - INTERVAL '9 months'
           GROUP BY 1 ORDER BY 1`
        : `SELECT date_trunc('quarter', poi.data_implantacao) AS trimestre, SUM(poi.valor) AS faturado
           FROM pedidos_oficiais_itens poi
           JOIN clientes c2 ON poi.cliente_codigo_oficial = c2.codigo_oficial
           JOIN clientes c ON c.id = $1
           WHERE (c2.id = c.id OR (c.matriz_grupo IS NOT NULL AND c2.matriz_grupo = c.matriz_grupo))
             AND poi.data_implantacao >= date_trunc('quarter', CURRENT_DATE) - INTERVAL '9 months'
           GROUP BY 1 ORDER BY 1`,
      [req.params.id]
    );
    // Ritmo medido contra o ANO EM ANDAMENTO (anoAtual/trimestreAtualIdx, vindos
    // do Postgres junto de fatResult) - é o ano que ainda vai ser revisado na
    // próxima janeiro, então é o único que ainda faz sentido "correr atrás".
    // Um trimestre do ano já fechado pode aparecer no histórico (pra dar
    // contexto de trilha no gráfico) mas não entra no cálculo de déficit -
    // calcularRitmoTrimestral já ignora trimestres fora do ano de referência.
    const ritmo = calcularRitmoTrimestral({
      tipo: cliente.classificatorio_tipo,
      pic: cliente.classificatorio_pic,
      vlAcordo: cliente.classificatorio_vl_acordo,
      trimestres: trimResult.rows.map(r => ({ trimestre: r.trimestre, faturado: r.faturado })),
      anoReferencia: anoAtual,
      trimestreReferenciaIdx: trimestreAtualIdx,
    });

    const status = calcularStatusClassificatorio({
      tipo: cliente.classificatorio_tipo,
      pic: cliente.classificatorio_pic,
      vlAcordo: cliente.classificatorio_vl_acordo,
      faturamento12m,
      faturamentoAnoCorrente,
      atrasadoNoRitmo: ritmo.situacao === 'atrasado',
    });

    // Objetivo trimestral customizado (vindo do relatório oficial do ERP,
    // importado em router.post('/classificatorio/objetivos-trimestrais/importar'))
    // - meta explícita por cliente/grupo, diferente da meta automática por
    // FAIXA calculada acima. Só aparece quando existe um objetivo importado
    // pra esse cliente/grupo; convive com (não substitui) a meta por faixa.
    let objetivoTrimestral = null;
    let entradaTrimestral = null;
    let faltaPObjetivo = null;
    const objetivosConfigResult = await pool.query('SELECT valor FROM configuracoes WHERE chave = $1', ['objetivos_trimestrais']);
    const objetivosConfig = objetivosConfigResult.rows[0]?.valor;
    if (objetivosConfig && objetivosConfig.periodoInicio && objetivosConfig.periodoFim) {
      const chaveGrupo = cliente.matriz_grupo || cliente.nome;
      const objetivo = objetivosConfig.objetivos?.[chaveGrupo];
      if (objetivo != null) {
        objetivoTrimestral = Number(objetivo);
        entradaTrimestral = await calcularEntradaTrimestralPeriodo(pool, cliente, objetivosConfig.periodoInicio, objetivosConfig.periodoFim);
        faltaPObjetivo = Math.max(0, objetivoTrimestral - entradaTrimestral);
      }
    }

    res.json({
      ...status,
      ultimaCompra,
      matrizGrupo: cliente.matriz_grupo,
      trimestral: ritmo,
      periodoReferencia: { janela: 'ultimos_12_meses', anoAnterior: anoPeriodo },
      revisao: 'Apuração mensal · ajuste pra baixo em 01/01 e 01/07',
      anoCorrente: anoPeriodo + 1,
      faturamentoAnoCorrente,
      faturamentoMesmoPeriodoAnoAnterior,
      objetivoTrimestral,
      entradaTrimestral,
      faltaPObjetivo,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao calcular status de classificatório.' });
  }
});

// Demais empresas do mesmo grupo (matriz_grupo) - aberto pra qualquer
// usuário logado, uso diário (não é ação de admin). Devolve o faturamento
// de CADA empresa individualmente (não a soma do grupo, que já aparece no
// card principal) pra dar pra comparar quem está comprando menos dentro do
// mesmo grupo. Cliente sem matriz_grupo (ou não encontrado) devolve lista
// vazia - o front decide se mostra ou não a seção de grupo.
router.get('/:id/classificatorio/grupo', async (req, res) => {
  try {
    const clienteResult = await pool.query('SELECT matriz_grupo FROM clientes WHERE id = $1', [req.params.id]);
    const matrizGrupo = clienteResult.rows[0]?.matriz_grupo;
    if (!matrizGrupo) return res.json({ matrizGrupo: null, membros: [] });

    const membrosResult = await pool.query(
      `SELECT c.id, c.nome, c.documento, c.classificatorio_tipo,
              COALESCE(SUM(poi.valor) FILTER (
                WHERE poi.status = 'faturado'
                  AND poi.data_faturamento > ${JANELA_12M_SQL}
              ), 0) AS faturamento_12m,
              COALESCE(SUM(poi.valor) FILTER (
                WHERE poi.status = 'faturado'
                  AND poi.data_faturamento >= ${PERIODO_CLASSIFICATORIO_FIM_SQL}
              ), 0) AS faturamento_ano_corrente,
              MAX(poi.data_faturamento) FILTER (WHERE poi.status = 'faturado') AS ultima_compra
       FROM clientes c
       LEFT JOIN pedidos_oficiais_itens poi ON poi.cliente_codigo_oficial = c.codigo_oficial
       WHERE c.matriz_grupo = $1
       GROUP BY c.id
       ORDER BY faturamento_12m ASC, c.nome ASC`,
      [matrizGrupo]
    );

    res.json({
      matrizGrupo,
      membros: membrosResult.rows.map(r => ({
        id: r.id,
        nome: r.nome,
        documento: r.documento,
        classificatorioTipo: r.classificatorio_tipo,
        faturamento12m: Number(r.faturamento_12m),
        faturamentoAnoCorrente: Number(r.faturamento_ano_corrente),
        ultimaCompra: r.ultima_compra,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar empresas do grupo.' });
  }
});

// Alertas agregados - também aberto pra qualquer usuário logado (uso
// diário, não coisa de admin). Separa clientes classificados em 3 grupos.
router.get('/classificatorio/alertas', async (req, res) => {
  try {
    const [result, clientesResult, anoResult, trimResult] = await Promise.all([
      pool.query(
        `${SQL_FATURAMENTO_CLASSIFICATORIO_POR_CLIENTE}
         WHERE c.classificatorio_tipo IS NOT NULL
         GROUP BY c.id`
      ),
      pool.query(
        `SELECT id, nome, documento, classificatorio_tipo, classificatorio_pic, classificatorio_vl_acordo, matriz_grupo
         FROM clientes WHERE classificatorio_tipo IS NOT NULL`
      ),
      pool.query(`SELECT EXTRACT(YEAR FROM CURRENT_DATE)::int AS ano_atual, EXTRACT(QUARTER FROM CURRENT_DATE)::int - 1 AS trimestre_atual_idx`),
      // Mesma janela móvel de 4 trimestres do status individual, mas pra
      // TODOS os clientes classificados de uma vez só (não N+1) - usada pra
      // saber quem está com o ritmo "atrasado" (ver comentário em
      // calcularStatusClassificatorio sobre por que isso decide o risco de
      // queda, em vez do acumulado bruto do ano contra o piso anual).
      pool.query(
        `SELECT c.id AS cliente_id, date_trunc('quarter', poi.data_implantacao) AS trimestre, SUM(poi.valor) AS faturado
         FROM clientes c
         JOIN clientes c2 ON (c2.id = c.id OR (c.matriz_grupo IS NOT NULL AND c2.matriz_grupo = c.matriz_grupo))
         JOIN pedidos_oficiais_itens poi ON poi.cliente_codigo_oficial = c2.codigo_oficial
         WHERE c.classificatorio_tipo IS NOT NULL
           AND poi.data_implantacao >= date_trunc('quarter', CURRENT_DATE) - INTERVAL '9 months'
         GROUP BY c.id, 2 ORDER BY c.id, 2`
      ),
    ]);
    const porId = new Map(clientesResult.rows.map(c => [c.id, c]));
    const anoAtual = Number(anoResult.rows[0].ano_atual);
    const trimestreAtualIdx = Number(trimResult.rows[0].trimestre_atual_idx);
    const trimestresPorCliente = new Map();
    for (const r of trimResult.rows) {
      const lista = trimestresPorCliente.get(r.cliente_id) || [];
      lista.push({ trimestre: r.trimestre, faturado: r.faturado });
      trimestresPorCliente.set(r.cliente_id, lista);
    }

    const pertoDeSubir = [];
    const riscoDeQueda = [];
    const semComprarRecente = [];
    const hoje = Date.now();

    for (const row of result.rows) {
      const cliente = porId.get(row.cliente_id);
      if (!cliente) continue;
      const ritmo = calcularRitmoTrimestral({
        tipo: cliente.classificatorio_tipo,
        pic: cliente.classificatorio_pic,
        vlAcordo: cliente.classificatorio_vl_acordo,
        trimestres: trimestresPorCliente.get(cliente.id) || [],
        anoReferencia: anoAtual,
        trimestreReferenciaIdx: trimestreAtualIdx,
      });
      const status = calcularStatusClassificatorio({
        tipo: cliente.classificatorio_tipo,
        pic: cliente.classificatorio_pic,
        vlAcordo: cliente.classificatorio_vl_acordo,
        faturamento12m: Number(row.faturamento_12m),
        faturamentoAnoCorrente: Number(row.faturamento_ano_corrente),
        atrasadoNoRitmo: ritmo.situacao === 'atrasado',
      });
      const item = { id: cliente.id, nome: cliente.nome, documento: cliente.documento, ...status };

      if (status.emRiscoDeQueda) {
        riscoDeQueda.push(item);
      } else if (status.faltaPraProximaFaixa != null) {
        const faixa = faixaDoTipo(cliente.classificatorio_tipo);
        const tamanhoFaixa = faixa && faixa.max != null ? faixa.max - faixa.min : null;
        if (tamanhoFaixa && status.faltaPraProximaFaixa <= tamanhoFaixa * LIMIAR_PERTO_DE_SUBIR) {
          pertoDeSubir.push(item);
        }
      }

      if (!status.ehRede && row.ultima_compra) {
        const diasSemComprar = Math.floor((hoje - new Date(row.ultima_compra).getTime()) / 86400000);
        if (diasSemComprar >= DIAS_SEM_COMPRAR_ALERTA) {
          semComprarRecente.push({ ...item, diasSemComprar });
        }
      }
    }

    res.json({ pertoDeSubir, riscoDeQueda, semComprarRecente });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao calcular alertas de classificatório.' });
  }
});

// Import da planilha "Classificatório" do ERP - só admin (carga em lote
// rara, mesmo padrão dos outros imports do app). Casa por codigo_oficial
// primeiro (mais confiável, evita confundir clientes com nome igual e
// CNPJ diferente), com CNPJ como segundo critério.
router.post('/classificatorio/importar', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode importar o classificatório.' });
  const itens = req.body.itens;
  if (!Array.isArray(itens) || itens.length === 0) return res.status(400).json({ erro: 'Envie { itens: [...] }' });

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    let atualizados = 0;
    let naoEncontrados = 0;

    for (const it of itens) {
      const codigoOficial = it.codigoOficial != null ? String(it.codigoOficial) : null;
      const documento = it.cnpj ? normalizarDoc(it.cnpj) : null;
      if (!codigoOficial && !documento) { naoEncontrados++; continue; }

      let cliente = null;
      if (codigoOficial) {
        const r = await client.query('SELECT id, codigo_oficial FROM clientes WHERE codigo_oficial = $1', [codigoOficial]);
        if (r.rows.length > 0) cliente = r.rows[0];
      }
      if (!cliente && documento) {
        const r = await client.query(
          `SELECT id, codigo_oficial FROM clientes WHERE regexp_replace(documento, '\\D', '', 'g') = $1`,
          [documento]
        );
        if (r.rows.length > 0) cliente = r.rows[0];
      }
      if (!cliente) { naoEncontrados++; continue; }

      await client.query(
        `UPDATE clientes SET
           codigo_oficial = COALESCE(codigo_oficial, $1),
           matriz_grupo = COALESCE($2, matriz_grupo),
           classificatorio_pic = $3,
           classificatorio_vl_acordo = COALESCE($4, classificatorio_vl_acordo),
           classificatorio_tipo = COALESCE(classificatorio_tipo, $5),
           classificatorio_desconto = COALESCE(classificatorio_desconto, $6)
         WHERE id = $7`,
        [codigoOficial, it.matrizGrupo || null, !!it.pic, it.vlAcordo ?? null, it.classificatorioTipo || null, it.classificatorioTipo ? descontoPelaPolitica(it.classificatorioTipo, it.classificatorioDesconto ?? null) : null, cliente.id]
      );
      atualizados++;
    }

    await client.query('COMMIT');
    res.json({ atualizados, naoEncontrados, total: itens.length });
  } catch (e) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { console.error('Erro no rollback:', rollbackErr); }
    }
    console.error(e);
    res.status(500).json({ erro: 'Erro ao importar classificatório.' });
  } finally {
    if (client) client.release();
  }
});

// Import do "Objetivo Trimestral" oficial do ERP (ver plano "Meta
// trimestral oficial") - só admin. Recebe { periodoInicio, periodoFim,
// itens: [{ matriz, objetivo }] } (Matriz = mesmo texto de
// COALESCE(matriz_grupo, nome) usado em todo o resto do classificatório;
// objetivo = valor em R$ da meta do trimestre). Cada import SUBSTITUI o
// objetivo salvo por inteiro (não faz merge) - a planilha oficial já vem
// completa a cada trimestre, então mesclar só acumularia lixo de
// trimestres antigos. Clientes Rede são pulados (RDA/Rede fora de escopo
// por enquanto, ver contexto do plano) - genérico pra qualquer Rede, não
// só RDA.
router.post('/classificatorio/objetivos-trimestrais/importar', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode importar objetivos trimestrais.' });
  const { periodoInicio, periodoFim, itens } = req.body;
  if (!periodoInicio || !periodoFim) return res.status(400).json({ erro: 'Envie periodoInicio e periodoFim (YYYY-MM-DD).' });
  if (!Array.isArray(itens) || itens.length === 0) return res.status(400).json({ erro: 'Envie { itens: [...] }' });

  try {
    const objetivos = {};
    let importados = 0;
    let pulosRede = 0;
    const naoReconhecidos = [];

    for (const it of itens) {
      const matriz = String(it.matriz || '').trim();
      const objetivo = Number(it.objetivo);
      if (!matriz || !Number.isFinite(objetivo)) continue;

      const r = await pool.query(
        `SELECT DISTINCT classificatorio_tipo FROM clientes WHERE COALESCE(matriz_grupo, nome) = $1`,
        [matriz]
      );
      if (r.rows.length === 0) { naoReconhecidos.push(matriz); continue; }
      if (r.rows.some(row => row.classificatorio_tipo === 'Rede')) { pulosRede++; continue; }

      objetivos[matriz] = objetivo;
      importados++;
    }

    await pool.query(
      `INSERT INTO configuracoes (chave, valor, atualizado_em) VALUES ($1, $2, now())
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`,
      ['objetivos_trimestrais', JSON.stringify({ periodoInicio, periodoFim, objetivos })]
    );

    console.log(`Objetivos trimestrais (${periodoInicio} a ${periodoFim}) importados por ${req.usuario?.email}: ${importados} objetivo(s), ${pulosRede} Rede pulado(s), ${naoReconhecidos.length} não reconhecido(s).`);
    res.json({ importados, pulosRede, naoReconhecidos, total: itens.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao importar objetivos trimestrais.' });
  }
});

module.exports = router;
module.exports.calcularStatusClassificatorio = calcularStatusClassificatorio;
module.exports.calcularRitmoTrimestral = calcularRitmoTrimestral;
module.exports.FAIXAS = FAIXAS;
module.exports.faixaDoTipo = faixaDoTipo;
module.exports.SQL_FATURAMENTO_CLASSIFICATORIO_POR_CLIENTE = SQL_FATURAMENTO_CLASSIFICATORIO_POR_CLIENTE;
