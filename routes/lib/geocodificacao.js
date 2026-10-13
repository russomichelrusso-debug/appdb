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
// Quando só acha a rua, tenta a posição PELO NÚMERO com os outros números da
// mesma rua no OSM (routes/lib/posicaoPeloNumero.js, via Overpass): nivel
// 'interpolado' (preciso como o número) ou 'estimado' (aproximado). Loja que
// ficou só com a rua é tentada de novo a cada DIAS_NOVA_TENTATIVA_NUMERO (o
// OSM ganha endereços com o tempo); Overpass fora do ar não para a noite - a
// loja fica com a rua e tenta na noite seguinte.
//
// A lógica (rodarRodada, geocodificarEndereco) recebe as dependências por
// parâmetro pra poder ser testada sem banco nem rede - ver test/run_tests.js.

const { agoraBrasilia, dentroDaJanela } = require('./preenchimentoCnpj');
const { posicaoPeloNumero } = require('./posicaoPeloNumero');

const LIMITE_DIARIO = 150;
const INTERVALO_MS = 2000;
const ESPERA_ENTRE_BUSCAS_MS = 1100;
const MAX_TENTATIVAS = 3;
const DIAS_NOVA_TENTATIVA_NUMERO = 60;
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

// Abreviações da ficha de CNPJ que o OpenStreetMap escreve por extenso
// ("AV PRES CASTELO BRANCO" = "Avenida Presidente Castelo Branco"). Só a
// palavra inteira; o ponto depois dela sai junto ("GOV. PAULO" -> "GOVERNADOR PAULO").
const ABREVIACOES = {
  AV: 'AVENIDA', R: 'RUA', PCA: 'PRACA', ROD: 'RODOVIA', AL: 'ALAMEDA', TV: 'TRAVESSA', EST: 'ESTRADA',
  PRES: 'PRESIDENTE', GOV: 'GOVERNADOR', DR: 'DOUTOR', DRA: 'DOUTORA', DES: 'DESEMBARGADOR',
  PROF: 'PROFESSOR', PROFA: 'PROFESSORA', VER: 'VEREADOR', PREF: 'PREFEITO', SEN: 'SENADOR', DEP: 'DEPUTADO',
  ENG: 'ENGENHEIRO', CEL: 'CORONEL', CAP: 'CAPITAO', TEN: 'TENENTE', SGT: 'SARGENTO', MAL: 'MARECHAL',
  GAL: 'GENERAL', GEN: 'GENERAL', BRIG: 'BRIGADEIRO', ALM: 'ALMIRANTE', MONS: 'MONSENHOR', PE: 'PADRE',
  FR: 'FREI', D: 'DOM', STO: 'SANTO', STA: 'SANTA', NSA: 'NOSSA SENHORA', PION: 'PIONEIRO',
  JORN: 'JORNALISTA', COM: 'COMENDADOR', INT: 'INTERVENTOR',
};

function expandirAbreviacoes(rua) {
  return String(rua || '').split(/\s+/).filter(Boolean).map((p, i) => {
    const chave = normalizar(p.replace(/\.$/, ''));
    // letra sozinha ("R", "D") só no começo: no meio costuma ser inicial ("DIDIO B BELLO")
    if (chave.length === 1 && i > 0) return p;
    return ABREVIACOES[chave] || p;
  }).join(' ');
}

// Buscas tentadas em ordem, até uma dar certo (sem repetir a mesma):
// 1) como está na ficha, com número; 2) abreviações por extenso; 3) sem o
// número (o número que não existe no OSM às vezes derruba a busca da rua);
// 4) busca livre "rua, cidade, UF" (acha rua que a busca por campos não acha).
function buscasDoEndereco(e) {
  const { rua, numero } = ruaENumero(e);
  const cidade = String(e.municipio || '').trim();
  const uf = String(e.uf || '').trim();
  const ruaLonga = expandirAbreviacoes(rua);
  const campos = (street) => {
    const p = { street, city: cidade };
    if (uf) p.state = uf;
    return p;
  };
  const buscas = [
    campos(numero ? `${numero} ${rua}` : rua),
    campos(numero ? `${numero} ${ruaLonga}` : ruaLonga),
    campos(ruaLonga),
    { q: [ruaLonga, cidade, uf].filter(Boolean).join(', ') },
  ];
  const vistas = new Set();
  return buscas.filter((b) => {
    const k = JSON.stringify(b);
    if (vistas.has(k)) return false;
    vistas.add(k);
    return true;
  });
}

// Uma consulta ao Nominatim: { latitude, longitude, nivel } ou null.
async function consultarNominatim(busca, municipio, fetchFn) {
  const params = new URLSearchParams({ format: 'jsonv2', limit: '1', countrycodes: 'br', addressdetails: '1', namedetails: '1', ...busca });
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
  if (!normalizar(r.display_name).includes(normalizar(municipio))) return null;
  const nivel = Number(r.place_rank) >= 28 ? 'numero' : 'rua';
  // nome da rua como está no OSM ("Avenida Brasil") - é por ele que o Overpass
  // acha os outros números da mesma rua. namedetails.name = a etiqueta "name"
  // crua (address.road pode vir traduzida pelo Accept-Language)
  const ruaOsm = nivel === 'rua'
    ? String((r.namedetails && r.namedetails.name) || (r.address && r.address.road) || r.name || '').trim() : '';
  return ruaOsm ? { latitude, longitude, nivel, ruaOsm } : { latitude, longitude, nivel };
}

// Devolve { latitude, longitude, nivel, numeroTentado } ou null (endereço não
// encontrado em nenhuma das buscas). Lança erro com .origem = true quando o
// problema é do Nominatim. Entre uma busca e outra do mesmo cliente espera
// ESPERA_ENTRE_BUSCAS_MS (política do Nominatim: no máximo 1 por segundo).
// numeroTentado: a posição pelo número foi tentada (achando ou não); false se
// o Overpass falhou (overpassFalhou: conta pra desistir por 60 dias depois de
// MAX_TENTATIVAS noites) ou foi pulado porque já tinha falhado nesta noite
// (erro com .pausado) - aí tenta de novo na próxima noite.
async function geocodificarEndereco(e, fetchFn = fetch, esperar = (ms) => new Promise((r) => setTimeout(r, ms)), pelonumero = posicaoPeloNumero) {
  const { rua, numero } = ruaENumero(e);
  if (!rua || !String(e.municipio || '').trim()) return null;
  const buscas = buscasDoEndereco(e);
  for (let i = 0; i < buscas.length; i++) {
    if (i > 0) await esperar(ESPERA_ENTRE_BUSCAS_MS);
    const pos = await consultarNominatim(buscas[i], String(e.municipio).trim(), fetchFn);
    if (!pos) continue;
    const { ruaOsm, ...achado } = pos;
    if (achado.nivel !== 'rua' || !ruaOsm || !/^\s*\d/.test(numero)) return { ...achado, numeroTentado: true };
    await esperar(ESPERA_ENTRE_BUSCAS_MS);
    try {
      const melhor = await pelonumero({ latitude: achado.latitude, longitude: achado.longitude, rua: ruaOsm, numero,
        municipio: String(e.municipio).trim() }, fetchFn);
      return { ...(melhor || achado), numeroTentado: true };
    } catch (err) {
      if (!err.pausado) console.warn(`Posição pelo número (Overpass) falhou, fica a da rua: ${err.message}`);
      return { ...achado, numeroTentado: false, overpassFalhou: !err.pausado };
    }
  }
  return null;
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
// endereço diferente do consultado, não achados (até 3 vezes, 1 por noite) ou
// que ficaram só com a rua (ou 'estimado') e têm número na ficha: a posição
// pelo número é tentada de novo a cada DIAS_NOVA_TENTATIVA_NUMERO (ou na noite
// seguinte, se o Overpass falhou). Nunca consultados primeiro; quem compra
// (tem código oficial) na frente.
const SQL_PENDENTES = `
  SELECT c.id, f.dados_brutos->'endereco'->>'tipoLogradouro' AS tipo, f.logradouro, f.numero, f.municipio, f.uf,
         ${sqlChaveEndereco('f')} AS chave
  FROM clientes c
  JOIN cliente_cnpj_ficha f ON f.cliente_id = c.id
  LEFT JOIN cliente_geocodificacao g ON g.cliente_id = c.id
  WHERE c.latitude IS NULL
    AND nullif(trim(f.logradouro), '') IS NOT NULL AND nullif(trim(f.municipio), '') IS NOT NULL
    AND (g.cliente_id IS NULL OR g.endereco <> ${sqlChaveEndereco('f')}
         OR (g.latitude IS NULL AND g.tentativas < $2 AND g.consultado_em < now() - interval '20 hours')
         OR (g.nivel IN ('rua', 'estimado') AND f.numero ~ '^\\s*[1-9]' AND g.consultado_em < now() - interval '20 hours'
             AND (g.numero_tentado_em IS NULL OR g.numero_tentado_em < now() - make_interval(days => $3))))
  ORDER BY (g.cliente_id IS NOT NULL), (g.numero_tentado_em IS NOT NULL), (c.codigo_oficial IS NULL), c.id
  LIMIT $1`;

// Ranking dos níveis: nova tentativa com o mesmo endereço nunca troca a posição
// por uma pior (o Overpass pode falhar ou um endereço sair do OSM)
const SQL_RANK_NIVEL = (x) => `coalesce(array_position(ARRAY['rua', 'estimado', 'interpolado', 'numero'], ${x}), 0)`;

function dependenciasReais(pool, fetchFn = fetch) {
  // Overpass falhou nesta noite: não chama mais até o dia seguinte (cada
  // tentativa podia esperar 40 s; as lojas ficam com a rua e voltam amanhã)
  let overpassForaNoDia = null;
  const pelonumeroComDisjuntor = async (q, f) => {
    const { dia } = agoraBrasilia(new Date());
    if (overpassForaNoDia === dia) {
      const e = new Error('Overpass já falhou nesta noite');
      e.pausado = true;
      throw e;
    }
    try {
      return await posicaoPeloNumero(q, f);
    } catch (e) {
      overpassForaNoDia = dia;
      throw e;
    }
  };
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
    listarPendentes: async (limite) => (await pool.query(SQL_PENDENTES, [limite, MAX_TENTATIVAS, DIAS_NOVA_TENTATIVA_NUMERO])).rows,
    geocodificar: (cliente) => geocodificarEndereco(cliente, fetchFn, undefined, pelonumeroComDisjuntor),
    // Mesmo endereço já com posição (nova tentativa pelo número): não troca por
    // nível pior. tentativas aqui conta as noites seguidas com o Overpass
    // falhando pra esta loja; na MAX_TENTATIVAS-ésima marca numero_tentado_em
    // (espera os 60 dias - uma rua cuja consulta sempre falha não fica em loop).
    gravarPosicao: (cliente, pos) => {
      const mesmo = `cliente_geocodificacao.endereco = EXCLUDED.endereco AND cliente_geocodificacao.latitude IS NOT NULL`;
      const pior = `${mesmo} AND ${SQL_RANK_NIVEL('EXCLUDED.nivel')} < ${SQL_RANK_NIVEL('cliente_geocodificacao.nivel')}`;
      return pool.query(
        `INSERT INTO cliente_geocodificacao (cliente_id, endereco, latitude, longitude, nivel, tentativas, consultado_em, erro, numero_tentado_em)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $7 THEN 1 ELSE 0 END, now(), CASE WHEN $7 THEN 'Overpass falhou' END,
                 CASE WHEN $6 THEN now() END)
         ON CONFLICT (cliente_id) DO UPDATE SET
           latitude = CASE WHEN ${pior} THEN cliente_geocodificacao.latitude ELSE EXCLUDED.latitude END,
           longitude = CASE WHEN ${pior} THEN cliente_geocodificacao.longitude ELSE EXCLUDED.longitude END,
           nivel = CASE WHEN ${pior} THEN cliente_geocodificacao.nivel ELSE EXCLUDED.nivel END,
           tentativas = CASE WHEN $7 AND ${mesmo} THEN cliente_geocodificacao.tentativas + 1 WHEN $7 THEN 1
                             WHEN NOT $6 AND ${mesmo} THEN cliente_geocodificacao.tentativas ELSE 0 END,
           numero_tentado_em = CASE WHEN $6 OR ($7 AND ${mesmo} AND cliente_geocodificacao.tentativas + 1 >= $8) THEN now() END,
           endereco = EXCLUDED.endereco, consultado_em = now(), erro = EXCLUDED.erro`,
        [cliente.id, cliente.chave, pos.latitude, pos.longitude, pos.nivel, pos.numeroTentado !== false, pos.overpassFalhou === true, MAX_TENTATIVAS]
      );
    },
    // endereço novo recomeça a contagem de tentativas. Nova tentativa pelo
    // número que não achou nada (mesmo endereço, já com posição): mantém a
    // posição que tinha e só marca a tentativa.
    registrarFalha: (cliente, erro) => pool.query(
      `INSERT INTO cliente_geocodificacao (cliente_id, endereco, tentativas, consultado_em, erro)
       VALUES ($1, $2, 1, now(), $3)
       ON CONFLICT (cliente_id) DO UPDATE SET
         tentativas = CASE WHEN cliente_geocodificacao.endereco = EXCLUDED.endereco AND cliente_geocodificacao.latitude IS NOT NULL
                           THEN cliente_geocodificacao.tentativas
                           WHEN cliente_geocodificacao.endereco = EXCLUDED.endereco
                           THEN cliente_geocodificacao.tentativas + 1 ELSE 1 END,
         numero_tentado_em = CASE WHEN cliente_geocodificacao.endereco = EXCLUDED.endereco AND cliente_geocodificacao.latitude IS NOT NULL
                                  THEN now() END,
         latitude = CASE WHEN cliente_geocodificacao.endereco = EXCLUDED.endereco THEN cliente_geocodificacao.latitude END,
         longitude = CASE WHEN cliente_geocodificacao.endereco = EXCLUDED.endereco THEN cliente_geocodificacao.longitude END,
         nivel = CASE WHEN cliente_geocodificacao.endereco = EXCLUDED.endereco THEN cliente_geocodificacao.nivel END,
         endereco = EXCLUDED.endereco, consultado_em = now(), erro = EXCLUDED.erro`,
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
       count(*) FILTER (WHERE c.latitude IS NULL AND g.latitude IS NOT NULL AND g.endereco = ${sqlChaveEndereco('f')}
         AND g.nivel IN ('numero', 'interpolado', 'estimado')) AS pelo_numero,
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
    pelo_numero: Number(linha.pelo_numero || 0),
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
  sqlChaveEndereco, ruaENumero, expandirAbreviacoes, buscasDoEndereco, SQL_PENDENTES, LIMITE_DIARIO, MAX_TENTATIVAS,
  DIAS_NOVA_TENTATIVA_NUMERO,
};
