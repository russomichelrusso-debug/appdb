// Preenchimento automático das fichas de CNPJ que ainda faltam
// (cliente_cnpj_ficha) - sem isso, a ficha só era buscada quando alguém
// abria a tela ou gerava o PDF do orçamento (que tira o endereço de entrega
// dela), e os clientes nunca abertos ficavam de fora de tudo que depende de
// município/UF/CEP.
//
// Roda sozinho no servidor, só de madrugada (01h-06h de Brasília, quando
// ninguém está consultando ficha na mão), no máximo LIMITE_DIARIO consultas
// por dia e uma a cada INTERVALO_MS - deixa folga pro limite das origens
// (radar-cnpj, com a BrasilAPI de reserva) pras consultas manuais do dia.
// Primeiro quem NÃO tem ficha nenhuma; com o que sobrar do saldo da noite,
// atualiza fichas já gravadas (10/2026, decisão do usuário): as que ainda não
// têm a conferência de devedor contumaz (o radar-cnpj só manda desde 10/2026)
// e, depois, as com mais de 30 dias - a lista da Receita muda.
//
// A lógica (rodarRodada) recebe as dependências por parâmetro pra poder ser
// testada sem banco nem rede - ver test/run_tests.js.

const LIMITE_DIARIO = 40;
const INTERVALO_MS = 15 * 1000;
const JANELA = { inicio: 1, fim: 6 }; // hora de Brasília: [01h, 06h)
const MAX_TENTATIVAS = 3;
const CHAVE_ESTADO = 'cnpj_preenchimento_auto';
const TICK_MS = 15 * 60 * 1000;

// Dia e hora em Brasília, independente do fuso do servidor (o Render roda em UTC).
function agoraBrasilia(data) {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(data).map((p) => [p.type, p.value])
  );
  return { dia: `${partes.year}-${partes.month}-${partes.day}`, hora: Number(partes.hour) };
}

function dentroDaJanela(data) {
  const { hora } = agoraBrasilia(data);
  return hora >= JANELA.inicio && hora < JANELA.fim;
}

// Uma rodada: consulta clientes pendentes até acabar o saldo do dia, a lista,
// ou a janela da madrugada. Devolve { consultas, motivo } só pra log/teste.
async function rodarRodada(deps) {
  const agora = deps.agora || (() => new Date());
  const esperar = deps.esperar || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const limite = deps.limiteDiario ?? LIMITE_DIARIO;
  const intervalo = deps.intervaloMs ?? INTERVALO_MS;

  if (!dentroDaJanela(agora())) return { consultas: 0, motivo: 'fora_da_janela' };

  const { dia } = agoraBrasilia(agora());
  const salvo = (await deps.lerEstado()) || {};
  const estado = salvo.dia === dia
    ? { ...salvo }
    : { dia, consultas: 0, pausado_no_dia: null, ultimo_erro: null };
  if (estado.pausado_no_dia === dia) return { consultas: 0, motivo: 'pausado_hoje' };

  const saldo = limite - (estado.consultas || 0);
  if (saldo <= 0) return { consultas: 0, motivo: 'limite_diario' };

  const pendentes = await deps.listarPendentes(saldo);
  let feitas = 0;
  let motivo = pendentes.length ? 'saldo_ou_lista_acabou' : 'nada_pendente';

  for (const item of pendentes) {
    // item: id (cliente sem ficha) ou { id, atualizar } (ficha que já existe)
    const clienteId = typeof item === 'object' ? item.id : item;
    const atualizar = typeof item === 'object' && !!item.atualizar;
    if (feitas > 0) {
      await esperar(intervalo);
      if (!dentroDaJanela(agora())) { motivo = 'janela_fechou'; break; }
    }
    feitas++;
    estado.consultas = (estado.consultas || 0) + 1;
    estado.ultima_rodada_em = agora().toISOString();
    try {
      await deps.obterFicha(clienteId, atualizar);
    } catch (e) {
      if (e.status === 404 || e.status === 400) {
        // problema DESSE cliente (CNPJ que a Receita não conhece, documento
        // inválido) - anota e segue pro próximo
        await deps.registrarFalha(clienteId, e.message);
      } else {
        // as duas origens fora do ar ou no limite - para a noite toda, sem
        // insistir, e tenta de novo amanhã
        estado.pausado_no_dia = dia;
        estado.ultimo_erro = e.message;
        await deps.salvarEstado(estado);
        return { consultas: feitas, motivo: 'origem_indisponivel' };
      }
    }
    await deps.salvarEstado(estado);
  }
  return { consultas: feitas, motivo };
}

// ---- Dependências reais (banco + obterFicha de routes/radarCnpj.js) ----

// Clientes com CNPJ de 14 dígitos, sem ficha nenhuma, que não esgotaram as
// tentativas e não foram tentados nas últimas 20h. Quem compra (tem código
// oficial) primeiro. Depois, fichas já gravadas pra atualizar: sem a
// conferência de devedor contumaz (gravada há mais de 3 dias - a que veio da
// BrasilAPI, sem a lista, não volta toda noite) e as com mais de 30 dias, a
// mais velha primeiro.
const SQL_PENDENTES = `
  SELECT id, atualizar FROM (
    SELECT c.id, false AS atualizar, 0 AS grupo, false AS sem_conferencia, (c.codigo_oficial IS NULL) AS sem_codigo,
      NULL::timestamptz AS gravada_em
    FROM clientes c
    LEFT JOIN cliente_cnpj_ficha f ON f.cliente_id = c.id
    LEFT JOIN cnpj_preenchimento_falhas x ON x.cliente_id = c.id
    WHERE f.cliente_id IS NULL
      AND length(regexp_replace(coalesce(c.documento, ''), '[^0-9]', '', 'g')) = 14
      AND (x.cliente_id IS NULL OR (x.tentativas < $2 AND x.ultima_tentativa < now() - interval '20 hours'))
    UNION ALL
    SELECT c.id, true, 1, NOT (coalesce(f.dados_brutos, '{}'::jsonb) ? 'devedorContumaz'), (c.codigo_oficial IS NULL),
      f.atualizado_em
    FROM cliente_cnpj_ficha f
    JOIN clientes c ON c.id = f.cliente_id
    LEFT JOIN cnpj_preenchimento_falhas x ON x.cliente_id = f.cliente_id
    WHERE length(regexp_replace(coalesce(c.documento, ''), '[^0-9]', '', 'g')) = 14
      -- falha de antes da ficha gravada não conta; depois dela, a mesma regra de quem não tem ficha
      AND (x.cliente_id IS NULL OR x.ultima_tentativa < f.atualizado_em
        OR (x.tentativas < $2 AND x.ultima_tentativa < now() - interval '20 hours'))
      AND (
        (NOT (coalesce(f.dados_brutos, '{}'::jsonb) ? 'devedorContumaz') AND f.atualizado_em < now() - interval '3 days')
        OR f.atualizado_em < now() - interval '30 days'
      )
  ) p
  ORDER BY grupo, sem_conferencia DESC, sem_codigo, gravada_em, id
  LIMIT $1`;

// Atualizar ficha que já existe: com a origem falhando, obterFicha devolve a
// gravada ('cache_vencido') em vez de lançar erro - aqui isso vira erro de novo,
// pra rodada pausar a noite (origem fora do ar) ou registrar a falha do cliente
// (CNPJ que nenhuma origem acha mais), como na ficha nova.
function obterFichaDaRodada(obterFicha) {
  return async (clienteId, atualizar) => {
    const r = await obterFicha(clienteId, !!atualizar);
    if (atualizar && r && r.fonte === 'cache_vencido') {
      const e = new Error(r.aviso || 'Origem indisponível.');
      if (r.naoEncontrado) e.status = 404;
      throw e;
    }
    return r;
  };
}

function dependenciasReais(pool, obterFicha) {
  return {
    lerEstado: async () => {
      const r = await pool.query('SELECT valor FROM configuracoes WHERE chave = $1', [CHAVE_ESTADO]);
      return r.rows[0] ? r.rows[0].valor : null;
    },
    salvarEstado: (estado) => pool.query(
      `INSERT INTO configuracoes (chave, valor, atualizado_em) VALUES ($1, $2, now())
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`,
      [CHAVE_ESTADO, JSON.stringify(estado)]
    ),
    listarPendentes: async (limite) => (await pool.query(SQL_PENDENTES, [limite, MAX_TENTATIVAS])).rows
      .map((r) => (r.atualizar ? { id: r.id, atualizar: true } : r.id)),
    obterFicha: obterFichaDaRodada(obterFicha),
    registrarFalha: (clienteId, erro) => pool.query(
      `INSERT INTO cnpj_preenchimento_falhas (cliente_id, tentativas, ultima_tentativa, erro) VALUES ($1, 1, now(), $2)
       ON CONFLICT (cliente_id) DO UPDATE SET tentativas = cnpj_preenchimento_falhas.tentativas + 1,
         ultima_tentativa = now(), erro = EXCLUDED.erro`,
      [clienteId, String(erro || '').slice(0, 500)]
    ),
  };
}

// Progresso pro Painel Administrativo.
async function statusPreenchimento(pool) {
  const r = await pool.query(
    `SELECT
       (SELECT count(*) FROM clientes c WHERE length(regexp_replace(coalesce(c.documento, ''), '[^0-9]', '', 'g')) = 14) AS com_cnpj,
       (SELECT count(*) FROM clientes c JOIN cliente_cnpj_ficha f ON f.cliente_id = c.id
         WHERE length(regexp_replace(coalesce(c.documento, ''), '[^0-9]', '', 'g')) = 14) AS com_ficha,
       (SELECT count(*) FROM cnpj_preenchimento_falhas x
         WHERE x.tentativas >= $1 AND NOT EXISTS (SELECT 1 FROM cliente_cnpj_ficha f WHERE f.cliente_id = x.cliente_id)) AS desistidos,
       (SELECT count(*) FROM cliente_cnpj_ficha f
         WHERE NOT (coalesce(f.dados_brutos, '{}'::jsonb) ? 'devedorContumaz')) AS sem_conferencia_contumaz`,
    [MAX_TENTATIVAS]
  );
  const est = await pool.query('SELECT valor FROM configuracoes WHERE chave = $1', [CHAVE_ESTADO]);
  const estado = est.rows[0] ? est.rows[0].valor : {};
  const hoje = agoraBrasilia(new Date()).dia;
  const comCnpj = Number(r.rows[0].com_cnpj);
  const comFicha = Number(r.rows[0].com_ficha);
  return {
    com_cnpj: comCnpj,
    com_ficha: comFicha,
    faltam: Math.max(0, comCnpj - comFicha),
    desistidos: Number(r.rows[0].desistidos),
    // fichas ainda sem a conferência de devedor contumaz (atualizadas de madrugada)
    sem_conferencia_contumaz: Number(r.rows[0].sem_conferencia_contumaz || 0),
    hoje: { consultas: estado.dia === hoje ? (estado.consultas || 0) : 0, limite: LIMITE_DIARIO },
    janela: `${String(JANELA.inicio).padStart(2, '0')}h–${String(JANELA.fim).padStart(2, '0')}h`,
  };
}

// Liga o preenchimento no boot do servidor. Checa a cada 15 min se está na
// janela; nunca roda duas rodadas ao mesmo tempo; erro numa rodada só vira
// log. PREENCHIMENTO_CNPJ_DESLIGADO=1 no Render desliga sem precisar de deploy.
function iniciarPreenchimentoAutomatico(pool, obterFicha) {
  if (process.env.NODE_ENV === 'test' || process.env.PREENCHIMENTO_CNPJ_DESLIGADO === '1') return null;
  const deps = dependenciasReais(pool, obterFicha);
  let rodando = false;
  const tick = async () => {
    if (rodando || !dentroDaJanela(new Date())) return;
    rodando = true;
    try {
      const r = await rodarRodada(deps);
      if (r.consultas > 0 || r.motivo === 'origem_indisponivel') {
        console.log(`Preenchimento de fichas de CNPJ: ${r.consultas} consulta(s) (${r.motivo}).`);
      }
    } catch (e) {
      console.error('Erro no preenchimento automático de fichas de CNPJ:', e);
    } finally {
      rodando = false;
    }
  };
  const timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  obterFichaDaRodada,
  agoraBrasilia, dentroDaJanela, rodarRodada, statusPreenchimento, iniciarPreenchimentoAutomatico, dependenciasReais,
  SQL_PENDENTES, LIMITE_DIARIO, MAX_TENTATIVAS,
};
