// Posição aproximada das lojas pelo endereço da ficha de CNPJ
// (cliente_geocodificacao) - o GPS só é gravado quando alguém salva um
// levantamento na loja (6 clientes em 10/2026), e sem posição o cliente não
// aparece em "Clientes perto de mim" (aba Clientes, index.html).
//
// Roda sozinho no servidor, de madrugada (mesma janela 01h-06h de Brasília do
// preenchimento de fichas), pelo Nominatim (OpenStreetMap): grátis, sem chave,
// e pode guardar o resultado - o geocodificador do Google só deixa guardar por
// pouco tempo e usar em mapa do Google. Política de uso do Nominatim: no
// máximo 1 consulta por segundo e User-Agent que identifique o app (aqui, 1 a
// cada INTERVALO_MS). Uma consulta por cliente; só quem tem ficha com rua e
// município e ainda não tem GPS. Ficha com endereço novo é consultada de novo.
//
// Precisão: no Brasil o OpenStreetMap quase nunca tem o número do prédio, então
// o resultado costuma ser um ponto da RUA (nivel 'rua') - numa avenida longa
// pode ficar a quilômetros da loja. Serve pra "quem está perto", não pra
// navegar: a rota usa o endereço por extenso (o Google acha o número).
//
// A lógica (rodarRodada, geocodificarEndereco) recebe as dependências por
// parâmetro pra poder ser testada sem banco nem rede - ver test/run_tests.js.

const { agoraBrasilia, dentroDaJanela } = require('./preenchimentoCnpj');

const LIMITE_DIARIO = 150;
const INTERVALO_MS = 2000;
const MAX_TENTATIVAS = 3;
const CHAVE_ESTADO = 'geocodificacao_auto';
const TICK_MS = 15 * 60 * 1000;
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'CortagRevolutionTools/1.0 (+https://github.com/russomichelrusso-debug/appdb)';

// só letras e números: "São João del-Rei" do OSM = "SAO JOAO DEL REI" da ficha
const normalizar = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

// Endereço que foi consultado, pra saber se a ficha mudou desde então. A mesma
// expressão monta o valor gravado (pela linha de SQL_PENDENTES) e o compara no
// /api/clientes/sync - não montar esse texto em JS.
const sqlChaveEndereco = (f) => `concat_ws('|',
  upper(trim(coalesce(${f}.dados_brutos->'endereco'->>'tipoLogradouro', ''))), upper(trim(coalesce(${f}.logradouro, ''))),
  upper(trim(coalesce(${f}.numero, ''))), upper(trim(coalesce(${f}.municipio, ''))), upper(trim(coalesce(${f}.uf, ''))))`;

// "AVENIDA" + "COLOMBO" (a coluna logradouro vem sem o tipo; a BrasilAPI às
// vezes já traz junto) e o número, sem "S/N"/"0". Mesma regra do
// enderecoParaNavegacao do index.html.
function ruaENumero(e) {
  const limpo = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const tipo = limpo(e.tipo), nomeRua = limpo(e.logradouro);
  const rua = tipo && !normalizar(nomeRua).startsWith(normalizar(tipo) + ' ') ? `${tipo} ${nomeRua}` : nomeRua;
  const numero = limpo(e.numero);
  return { rua, numero: numero && !/^(s\.?\/?\s*n\.?|0+)$/i.test(numero) ? numero : '' };
}

function erroDaOrigem(msg) {
  const e = new Error(msg);
  e.origem = true; // Nominatim fora do ar/no limite: para a noite, não é culpa do cliente
  return e;
}

// Devolve { latitude, longitude, nivel } ou null (endereço não encontrado).
// Lança erro com .origem = true quando o problema é do serviço.
async function geocodificarEndereco(e, fetchFn = fetch) {
  const { rua, numero } = ruaENumero(e);
  if (!rua || !String(e.municipio || '').trim()) return null;
  const params = new URLSearchParams({
    format: 'jsonv2', limit: '1', countrycodes: 'br',
    street: numero ? `${numero} ${rua}` : rua, city: String(e.municipio).trim(),
  });
  if (e.uf) params.set('state', String(e.uf).trim());
  let resp;
  try {
    resp = await fetchFn(`${NOMINATIM_URL}?${params}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR' }, signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw erroDaOrigem(`Nominatim não respondeu: ${err.message}`);
  }
  if (!resp.ok) throw erroDaOrigem(`Nominatim respondeu ${resp.status}`);
  const lista = await resp.json().catch(() => null);
  if (!Array.isArray(lista)) throw erroDaOrigem('Nominatim devolveu resposta inválida');
  const r = lista[0];
  if (!r) return null;
  const latitude = Number(r.lat), longitude = Number(r.lon);
  // place_rank 26+ = rua ou prédio (abaixo disso é bairro/cidade: não serve pra
  // "perto de mim"); fora do Brasil ou de outro município = homônimo, descarta
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Number(r.place_rank) < 26) return null;
  if (latitude < -34 || latitude > 6 || longitude < -74 || longitude > -34) return null;
  if (!normalizar(r.display_name).includes(normalizar(e.municipio))) return null;
  return { latitude, longitude, nivel: Number(r.place_rank) >= 28 ? 'numero' : 'rua' };
}

// Uma rodada: consulta os pendentes até acabar o saldo do dia, a lista ou a
// janela da madrugada. Devolve { consultas, motivo } só pra log/teste.
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

  for (const cliente of pendentes) {
    if (feitas > 0) {
      await esperar(intervalo);
      if (!dentroDaJanela(agora())) { motivo = 'janela_fechou'; break; }
    }
    feitas++;
    estado.consultas = (estado.consultas || 0) + 1;
    estado.ultima_rodada_em = agora().toISOString();
    try {
      const pos = await deps.geocodificar(cliente);
      if (pos) await deps.gravarPosicao(cliente, pos);
      else await deps.registrarFalha(cliente, 'endereço não encontrado');
    } catch (e) {
      if (!e.origem) throw e;
      estado.pausado_no_dia = dia;
      estado.ultimo_erro = e.message;
      await deps.salvarEstado(estado);
      return { consultas: feitas, motivo: 'origem_indisponivel' };
    }
    await deps.salvarEstado(estado);
  }
  return { consultas: feitas, motivo };
}

// ---- Dependências reais (banco + Nominatim) ----

// Clientes sem GPS com ficha que tem rua e município, nunca consultados, com
// endereço diferente do consultado, ou não achados (até 3 vezes, 1 por noite).
// Nunca consultados primeiro; quem compra (tem código oficial) na frente.
const SQL_PENDENTES = `
  SELECT c.id, f.dados_brutos->'endereco'->>'tipoLogradouro' AS tipo, f.logradouro, f.numero, f.municipio, f.uf,
         ${sqlChaveEndereco('f')} AS chave
  FROM clientes c
  JOIN cliente_cnpj_ficha f ON f.cliente_id = c.id
  LEFT JOIN cliente_geocodificacao g ON g.cliente_id = c.id
  WHERE c.latitude IS NULL
    AND nullif(trim(f.logradouro), '') IS NOT NULL AND nullif(trim(f.municipio), '') IS NOT NULL
    AND (g.cliente_id IS NULL OR g.endereco <> ${sqlChaveEndereco('f')}
         OR (g.latitude IS NULL AND g.tentativas < $2 AND g.consultado_em < now() - interval '20 hours'))
  ORDER BY (g.cliente_id IS NOT NULL), (c.codigo_oficial IS NULL), c.id
  LIMIT $1`;

function dependenciasReais(pool, fetchFn = fetch) {
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
    listarPendentes: async (limite) => (await pool.query(SQL_PENDENTES, [limite, MAX_TENTATIVAS])).rows,
    geocodificar: (cliente) => geocodificarEndereco(cliente, fetchFn),
    gravarPosicao: (cliente, pos) => pool.query(
      `INSERT INTO cliente_geocodificacao (cliente_id, endereco, latitude, longitude, nivel, tentativas, consultado_em, erro)
       VALUES ($1, $2, $3, $4, $5, 0, now(), NULL)
       ON CONFLICT (cliente_id) DO UPDATE SET endereco = EXCLUDED.endereco, latitude = EXCLUDED.latitude,
         longitude = EXCLUDED.longitude, nivel = EXCLUDED.nivel, tentativas = 0, consultado_em = now(), erro = NULL`,
      [cliente.id, cliente.chave, pos.latitude, pos.longitude, pos.nivel]
    ),
    // endereço novo recomeça a contagem de tentativas
    registrarFalha: (cliente, erro) => pool.query(
      `INSERT INTO cliente_geocodificacao (cliente_id, endereco, tentativas, consultado_em, erro)
       VALUES ($1, $2, 1, now(), $3)
       ON CONFLICT (cliente_id) DO UPDATE SET
         tentativas = CASE WHEN cliente_geocodificacao.endereco = EXCLUDED.endereco AND cliente_geocodificacao.latitude IS NULL
                           THEN cliente_geocodificacao.tentativas + 1 ELSE 1 END,
         endereco = EXCLUDED.endereco, latitude = NULL, longitude = NULL, nivel = NULL, consultado_em = now(), erro = EXCLUDED.erro`,
      [cliente.id, cliente.chave, String(erro || '').slice(0, 500)]
    ),
  };
}

// Progresso pro Painel Administrativo: de quantos clientes o app sabe onde a
// loja fica (GPS do levantamento ou pelo endereço) e quantos faltam.
async function statusGeocodificacao(pool) {
  const r = await pool.query(
    `SELECT
       count(*) FILTER (WHERE c.latitude IS NOT NULL) AS com_gps,
       count(*) FILTER (WHERE c.latitude IS NULL AND g.latitude IS NOT NULL AND g.endereco = ${sqlChaveEndereco('f')}) AS pelo_endereco,
       count(*) FILTER (WHERE c.latitude IS NULL AND f.cliente_id IS NOT NULL
         AND nullif(trim(f.logradouro), '') IS NOT NULL AND nullif(trim(f.municipio), '') IS NOT NULL) AS com_endereco_sem_gps,
       count(*) FILTER (WHERE c.latitude IS NULL AND g.latitude IS NULL AND g.tentativas >= $1
         AND g.endereco = ${sqlChaveEndereco('f')}) AS nao_encontrados
     FROM clientes c
     LEFT JOIN cliente_cnpj_ficha f ON f.cliente_id = c.id
     LEFT JOIN cliente_geocodificacao g ON g.cliente_id = c.id`,
    [MAX_TENTATIVAS]
  );
  const linha = r.rows[0] || {};
  const comEndereco = Number(linha.com_endereco_sem_gps || 0);
  const peloEndereco = Number(linha.pelo_endereco || 0);
  const naoEncontrados = Number(linha.nao_encontrados || 0);
  return {
    com_gps: Number(linha.com_gps || 0),
    pelo_endereco: peloEndereco,
    nao_encontrados: naoEncontrados,
    faltam: Math.max(0, comEndereco - peloEndereco - naoEncontrados),
    limite: LIMITE_DIARIO,
  };
}

// Liga no boot do servidor (mesmo esquema do preenchimento de fichas).
// GEOCODIFICACAO_DESLIGADA=1 no Render desliga sem deploy.
function iniciarGeocodificacaoAutomatica(pool) {
  if (process.env.NODE_ENV === 'test' || process.env.GEOCODIFICACAO_DESLIGADA === '1') return null;
  const deps = dependenciasReais(pool);
  let rodando = false;
  const tick = async () => {
    if (rodando || !dentroDaJanela(new Date())) return;
    rodando = true;
    try {
      const r = await rodarRodada(deps);
      if (r.consultas > 0 || r.motivo === 'origem_indisponivel') {
        console.log(`Posição das lojas pelo endereço: ${r.consultas} consulta(s) (${r.motivo}).`);
      }
    } catch (e) {
      console.error('Erro na geocodificação automática dos clientes:', e);
    } finally {
      rodando = false;
    }
  };
  const timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  geocodificarEndereco, rodarRodada, statusGeocodificacao, iniciarGeocodificacaoAutomatica, dependenciasReais,
  sqlChaveEndereco, ruaENumero, SQL_PENDENTES, LIMITE_DIARIO, MAX_TENTATIVAS,
};
