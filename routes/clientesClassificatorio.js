const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Faixas de faturamento (ano civil fechado, somado por Matriz/grupo de
// "empresas irmãs" - ver PERIODO_CLASSIFICATORIO_* mais abaixo)
// reverse-engineered da planilha "Classificatório" exportada do ERP em
// 02/09/2026 - a coluna "Diferença" daquele relatório bateu exatamente
// com estes limiares em ~280 linhas conferidas manualmente (na época, a
// janela ainda era móvel de 12 meses; a windowing mudou depois, os
// limiares de valor não). Fixas por decisão do usuário; se a ERP mudar
// as faixas no futuro, ajustar aqui.
const FAIXAS = {
  'Varejo Exclusive': { min: 0, max: 30000, proximaFaixa: 'Varejo Premium' },
  'Varejo Premium': { min: 30000, max: 50000, proximaFaixa: 'Varejo Master', faixaAnterior: 'Varejo Exclusive' },
  'Varejo Master': { min: 50000, max: null, faixaAnterior: 'Varejo Premium' },
  'Atacado Premium': { min: 300000, max: null },
};

const LIMIAR_PERTO_DE_SUBIR = 0.15; // falta <= 15% do tamanho da faixa conta como "perto"
const DIAS_SEM_COMPRAR_ALERTA = 60; // mesmo limiar já usado na "carteira antiga"

function normalizarDoc(v) {
  return String(v || '').replace(/\D/g, '');
}

// Calcula o status de classificatório (quanto falta pra subir/cair) de um
// cliente, dado o tipo, a meta individual (PIC/Vl.Acordo, se houver) e o
// faturamento já apurado (últimos 12 meses, somado por grupo Matriz).
// Função pura - sem acesso a banco - pra ser testável direto.
function calcularStatusClassificatorio({ tipo, pic, vlAcordo, faturamento12m }) {
  const fat = Number(faturamento12m) || 0;
  if (!tipo) return { classificado: false };

  const base = { classificado: true, tipo, faturamento12m: fat };

  if (tipo === 'Rede') {
    // Acordo bilateral com a rede/cooperativa de compras - não depende de
    // faturamento, nunca tem "falta pra subir/cair".
    return { ...base, ehRede: true, semMeta: true };
  }

  if (pic && vlAcordo) {
    // Meta individual negociada à parte (PIC), substitui a faixa padrão.
    const falta = Math.max(0, Number(vlAcordo) - fat);
    return { ...base, metaIndividual: Number(vlAcordo), faltaPraMeta: falta, emRiscoDeQueda: false, faixaMin: 0, faixaMax: Number(vlAcordo) };
  }

  const faixa = FAIXAS[tipo];
  if (!faixa) return { ...base, semFaixaDefinida: true };

  if (fat < faixa.min) {
    // Abaixo do mínimo da própria faixa - risco de cair pra faixa anterior.
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
  // Já bateu o teto da faixa (ou a faixa não tem teto definido) - qualifica.
  return { ...base, emRiscoDeQueda: false, jaQualificaProximaFaixa: !!faixa.proximaFaixa, proximaFaixa: faixa.proximaFaixa || null };
}

// Quebra o faturamento em até 4 trimestres civis (mais recentes primeiro
// na entrada, devolvido em ordem cronológica) e calcula o ritmo necessário
// pros trimestres restantes do ano de referência baterem a meta anual/da
// faixa. `trimestres` = [{ trimestre: 'YYYY-MM-DD' (início do trimestre), faturado }].
// `anoReferencia`/`trimestreReferenciaIdx` (0-3) dizem qual ano e qual é o
// "trimestre atual" pra fins de déficit acumulado/trimestres restantes -
// por padrão usam a data de hoje, mas a rota de status passa um ano
// FECHADO (ver PERIODO_CLASSIFICATORIO_*) com trimestreReferenciaIdx=4,
// já que ali os 4 trimestres já terminaram (não sobra "próximo trimestre").
function calcularRitmoTrimestral({ tipo, pic, vlAcordo, trimestres, anoReferencia, trimestreReferenciaIdx }) {
  const historico = (trimestres || []).map(t => ({ trimestre: t.trimestre, faturado: Number(t.faturado) || 0 }));
  if (tipo === 'Rede') return { historico, semMeta: true };

  let metaAnual = null;
  if (pic && vlAcordo) metaAnual = Number(vlAcordo);
  else if (FAIXAS[tipo]) metaAnual = FAIXAS[tipo].max != null ? FAIXAS[tipo].max : FAIXAS[tipo].min;
  if (metaAnual == null) return { historico, semMeta: true };

  // Piso por trimestre = quanto precisa faturar por trimestre pra não cair
  // da faixa atual (mínimo da própria faixa, dividido em 4). Não se aplica
  // quando não há risco de queda possível (Exclusive, min=0) nem quando a
  // meta é individual (PIC/Vl.Acordo não tem "piso" separado, só a meta).
  const faixaAtual = !pic || !vlAcordo ? FAIXAS[tipo] : null;
  const pisoPorTrimestre = faixaAtual && faixaAtual.min > 0 ? faixaAtual.min / 4 : null;

  const metaPorTrimestre = metaAnual / 4;
  const hoje = new Date();
  const trimestreAtualIdx = trimestreReferenciaIdx != null ? trimestreReferenciaIdx : Math.floor(hoje.getMonth() / 3);
  // Trimestres do ano de referência já decorridos (inclusive o atual), na ordem em que aparecem em `historico`.
  const anoCorrente = anoReferencia != null ? anoReferencia : hoje.getFullYear();
  let deficitAcumulado = 0;
  let trimestresRestantes = 0;
  for (const t of historico) {
    const d = new Date(t.trimestre);
    if (d.getFullYear() !== anoCorrente) continue;
    const idx = Math.floor(d.getMonth() / 3);
    if (idx < trimestreAtualIdx) {
      // Trimestre já fechado - soma o déficit (ou crédito) em relação à cota.
      deficitAcumulado += metaPorTrimestre - t.faturado;
    }
  }
  trimestresRestantes = 4 - trimestreAtualIdx; // inclui o trimestre atual
  const ritmoNecessarioProximoTrimestre = trimestresRestantes > 0
    ? Math.max(0, (metaPorTrimestre * trimestresRestantes + deficitAcumulado) / trimestresRestantes)
    : null;

  let situacao = 'no_ritmo';
  if (deficitAcumulado > metaPorTrimestre * 0.05) situacao = 'atrasado';
  else if (deficitAcumulado < -metaPorTrimestre * 0.05) situacao = 'adiantado';

  return { historico, metaAnual, metaPorTrimestre, pisoPorTrimestre, situacao, ritmoNecessarioProximoTrimestre };
}

// A revisão do classificatório é feita pela empresa em janeiro, olhando o
// ano civil fechado anterior (ex: revisão de janeiro/2027 usa o
// faturamento de jan-dez/2026 inteiro) - não uma janela móvel de "últimos
// 12 meses até hoje". Por decisão do usuário, simplificamos pra tratar
// todo cliente nesse único ciclo de janeiro (sem o caso à parte de
// clientes reativados em julho, que teriam 1º ciclo em julho antes de
// migrar pra janeiro - não temos hoje nenhuma data de "reativação"
// salva pra sustentar essa exceção). O número fica travado o ano
// inteiro e só muda quando o ano civil vira.
const PERIODO_CLASSIFICATORIO_INICIO_SQL = `date_trunc('year', CURRENT_DATE) - INTERVAL '1 year'`;
const PERIODO_CLASSIFICATORIO_FIM_SQL = `date_trunc('year', CURRENT_DATE)`; // exclusivo

// Monta a subconsulta que soma faturamento (do ano civil fechado mais
// recente, ver comentário acima) agrupado por "grupo" (matriz_grupo
// quando existe, senão o próprio cliente) - reaproveitada pelo status
// individual e pelos alertas em lote. Também traz o acumulado do ano EM
// ANDAMENTO (ainda não fechado, não usado pra decidir faixa - só pra o
// vendedor acompanhar o progresso do ano corrente lado a lado com o
// último ano fechado).
const SQL_FATURAMENTO_ANO_FECHADO_POR_CLIENTE = `
  SELECT c.id AS cliente_id,
         COALESCE(SUM(poi.valor) FILTER (
           WHERE poi.status = 'faturado'
             AND poi.data_faturamento >= ${PERIODO_CLASSIFICATORIO_INICIO_SQL}
             AND poi.data_faturamento < ${PERIODO_CLASSIFICATORIO_FIM_SQL}
         ), 0) AS faturamento_12m,
         COALESCE(SUM(poi.valor) FILTER (
           WHERE poi.status = 'faturado'
             AND poi.data_faturamento >= ${PERIODO_CLASSIFICATORIO_FIM_SQL}
         ), 0) AS faturamento_ano_corrente,
         MAX(poi.data_faturamento) FILTER (WHERE poi.status = 'faturado') AS ultima_compra
  FROM clientes c
  LEFT JOIN clientes c2 ON c2.id = c.id
    OR (c.matriz_grupo IS NOT NULL AND c2.matriz_grupo = c.matriz_grupo)
  LEFT JOIN pedidos_oficiais_itens poi ON poi.cliente_codigo_oficial = c2.codigo_oficial
`;

// Status de classificatório de UM cliente - aberto pra qualquer usuário
// logado (não é ação de admin, é consulta do dia a dia na ficha do cliente).
router.get('/:id/classificatorio/status', async (req, res) => {
  try {
    const clienteResult = await pool.query('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
    const cliente = clienteResult.rows[0];
    if (!cliente) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    if (!cliente.classificatorio_tipo) return res.json({ classificado: false });

    // O ano fechado (usado só pra rotular a resposta e fechar os 4 trimestres
    // em calcularRitmoTrimestral) vem do PRÓPRIO Postgres, na mesma consulta -
    // nunca de um "new Date()" separado no Node, que teria que só torcer pra
    // concordar com o fuso do CURRENT_DATE do banco.
    const fatResult = await pool.query(
      `SELECT sub.*, EXTRACT(YEAR FROM ${PERIODO_CLASSIFICATORIO_INICIO_SQL})::int AS ano_fechado
       FROM (${SQL_FATURAMENTO_ANO_FECHADO_POR_CLIENTE} WHERE c.id = $1 GROUP BY c.id) sub`,
      [req.params.id]
    );
    const faturamento12m = fatResult.rows[0] ? Number(fatResult.rows[0].faturamento_12m) : 0;
    const faturamentoAnoCorrente = fatResult.rows[0] ? Number(fatResult.rows[0].faturamento_ano_corrente) : 0;
    const ultimaCompra = fatResult.rows[0] ? fatResult.rows[0].ultima_compra : null;
    const anoPeriodo = fatResult.rows[0] ? Number(fatResult.rows[0].ano_fechado) : new Date().getUTCFullYear() - 1;

    const status = calcularStatusClassificatorio({
      tipo: cliente.classificatorio_tipo,
      pic: cliente.classificatorio_pic,
      vlAcordo: cliente.classificatorio_vl_acordo,
      faturamento12m,
    });

    const trimResult = await pool.query(
      `SELECT date_trunc('quarter', poi.data_faturamento) AS trimestre, SUM(poi.valor) AS faturado
       FROM pedidos_oficiais_itens poi
       JOIN clientes c2 ON poi.cliente_codigo_oficial = c2.codigo_oficial
       JOIN clientes c ON c.id = $1
       WHERE (c2.id = c.id OR (c.matriz_grupo IS NOT NULL AND c2.matriz_grupo = c.matriz_grupo))
         AND poi.status = 'faturado'
         AND poi.data_faturamento >= ${PERIODO_CLASSIFICATORIO_INICIO_SQL}
         AND poi.data_faturamento < ${PERIODO_CLASSIFICATORIO_FIM_SQL}
       GROUP BY 1 ORDER BY 1`,
      [req.params.id]
    );
    // anoPeriodo (calculado acima, junto de fatResult) é passado explicitamente
    // pra calcularRitmoTrimestral em vez de deixar a função assumir "hoje", já
    // que o período em análise está inteiramente fechado (nenhum trimestre
    // "restante").
    const ritmo = calcularRitmoTrimestral({
      tipo: cliente.classificatorio_tipo,
      pic: cliente.classificatorio_pic,
      vlAcordo: cliente.classificatorio_vl_acordo,
      trimestres: trimResult.rows.map(r => ({ trimestre: r.trimestre, faturado: r.faturado })),
      anoReferencia: anoPeriodo,
      trimestreReferenciaIdx: 4,
    });

    res.json({
      ...status,
      ultimaCompra,
      matrizGrupo: cliente.matriz_grupo,
      trimestral: ritmo,
      periodoReferencia: { anoInicio: anoPeriodo, anoFim: anoPeriodo },
      proximaRevisao: `janeiro/${anoPeriodo + 2}`,
      anoCorrente: anoPeriodo + 1,
      faturamentoAnoCorrente,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao calcular status de classificatório.' });
  }
});

// Alertas agregados - também aberto pra qualquer usuário logado (uso
// diário, não coisa de admin). Separa clientes classificados em 3 grupos.
router.get('/classificatorio/alertas', async (req, res) => {
  try {
    const result = await pool.query(
      `${SQL_FATURAMENTO_ANO_FECHADO_POR_CLIENTE}
       WHERE c.classificatorio_tipo IS NOT NULL
       GROUP BY c.id`
    );
    const clientesResult = await pool.query(
      `SELECT id, nome, documento, classificatorio_tipo, classificatorio_pic, classificatorio_vl_acordo, matriz_grupo
       FROM clientes WHERE classificatorio_tipo IS NOT NULL`
    );
    const porId = new Map(clientesResult.rows.map(c => [c.id, c]));

    const pertoDeSubir = [];
    const riscoDeQueda = [];
    const semComprarRecente = [];
    const hoje = Date.now();

    for (const row of result.rows) {
      const cliente = porId.get(row.cliente_id);
      if (!cliente) continue;
      const status = calcularStatusClassificatorio({
        tipo: cliente.classificatorio_tipo,
        pic: cliente.classificatorio_pic,
        vlAcordo: cliente.classificatorio_vl_acordo,
        faturamento12m: Number(row.faturamento_12m),
      });
      const item = { id: cliente.id, nome: cliente.nome, documento: cliente.documento, ...status };

      if (status.emRiscoDeQueda) {
        riscoDeQueda.push(item);
      } else if (status.faltaPraProximaFaixa != null) {
        const faixa = FAIXAS[cliente.classificatorio_tipo];
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

  const client = await pool.connect();
  try {
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
           matriz_grupo = $2,
           classificatorio_pic = $3,
           classificatorio_vl_acordo = $4,
           classificatorio_tipo = COALESCE(classificatorio_tipo, $5),
           classificatorio_desconto = COALESCE(classificatorio_desconto, $6)
         WHERE id = $7`,
        [codigoOficial, it.matrizGrupo || null, !!it.pic, it.vlAcordo || null, it.classificatorioTipo || null, it.classificatorioDesconto || null, cliente.id]
      );
      atualizados++;
    }

    await client.query('COMMIT');
    res.json({ atualizados, naoEncontrados, total: itens.length });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ erro: 'Erro ao importar classificatório.' });
  } finally {
    client.release();
  }
});

module.exports = router;
module.exports.calcularStatusClassificatorio = calcularStatusClassificatorio;
module.exports.calcularRitmoTrimestral = calcularRitmoTrimestral;
module.exports.FAIXAS = FAIXAS;
module.exports.SQL_FATURAMENTO_ANO_FECHADO_POR_CLIENTE = SQL_FATURAMENTO_ANO_FECHADO_POR_CLIENTE;
