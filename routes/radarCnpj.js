const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { pool } = require('../db');
const { validarIdInteiro } = require('../middleware/validarId');
const { buscarNaBrasilApi } = require('./lib/cnpjBrasilApi');
const { completarNomesSocios, temSocioAbreviado } = require('./lib/nomesSocios');
const { statusPreenchimento } = require('./lib/preenchimentoCnpj');
const { statusGeocodificacao } = require('./lib/geocodificacao');

router.param('id', validarIdInteiro);

// Por usuário - protege a origem (radar-cnpj.com) contra um uso repetido
// demais vindo de dentro do app (ela mesma já cacheia 6h, mas isso é do
// lado deles; aqui é sobre não sobrecarregar quem está do outro lado).
const radarCnpjLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.usuario?.id || req.ip),
  message: { erro: 'Muitas consultas de CNPJ em pouco tempo — espera um pouco e tenta de novo.' },
});

// Consulta pública da Receita Federal via radar-cnpj.com - sem chave, sem
// conta, cacheada 6h na origem - com a BrasilAPI de reserva (ver
// buscarFichaNaOrigem). Aqui guardamos nosso próprio cache (tabela
// cliente_cnpj_ficha) por mais tempo (30 dias) porque dado cadastral de
// empresa muda pouco, e assim evitamos bater na API a cada abertura da tela.
const RADAR_CNPJ_BASE = 'https://radar-cnpj.com';
const CACHE_MAX_IDADE_DIAS = 30;

function normalizarCnpj(v) {
  return String(v || '').replace(/\D/g, '');
}

async function buscarNoRadar(cnpj) {
  const resp = await fetch(`${RADAR_CNPJ_BASE}/api/cnpj/${cnpj}`, { signal: AbortSignal.timeout(8000) });
  if (resp.status === 404) {
    const erro = new Error('CNPJ não encontrado na base da Receita Federal.');
    erro.naoEncontrado = true;
    throw erro;
  }
  if (!resp.ok) throw new Error(`radar-cnpj respondeu ${resp.status}`);
  const body = await resp.json();
  if (!body || body.ok === false) throw new Error((body && body.error) || 'radar-cnpj recusou a consulta.');
  return body.data || body;
}

// radar-cnpj primeiro; se ele recusar, atingir limite, cair ou não achar o
// CNPJ (base dele pode atrasar pra empresa recém-aberta), tenta a BrasilAPI,
// já convertida pro mesmo formato (ver routes/lib/cnpjBrasilApi.js) - quem
// chama não sabe qual das duas respondeu. "Não encontrado" só sai se
// nenhuma das duas achou e pelo menos uma disse isso explicitamente.
async function buscarFichaNaOrigem(cnpj) {
  try {
    return await buscarNoRadar(cnpj);
  } catch (erroRadar) {
    try {
      const dados = await buscarNaBrasilApi(cnpj);
      console.warn(`radar-cnpj falhou (${erroRadar.message}) - ficha consultada na BrasilAPI.`);
      return dados;
    } catch (erroBrasilApi) {
      if (erroRadar.naoEncontrado) throw erroRadar;
      if (erroBrasilApi.naoEncontrado) throw erroBrasilApi;
      throw new Error(`${erroRadar.message}; reserva: ${erroBrasilApi.message}`);
    }
  }
}

// Vários campos da origem vêm como objeto aninhado {codigo, label/descricao}
// em vez de string solta (confirmado com uma resposta real em produção,
// cruzada com o comprovante oficial do CNPJ: situacao, naturezaJuridica,
// porte e cnae chegam assim). Esse helper desembrulha isso pro texto que
// interessa mostrar.
function campoTexto(v) {
  if (v == null) return null;
  if (typeof v === 'object') return v.label || v.descricao || v.nome || v.texto || null;
  return v;
}

// Contrato confirmado contra uma resposta real da origem (comparada com o
// comprovante oficial do Cadastro Nacional da Pessoa Jurídica): a API usa
// camelCase e agrupa situação/natureza jurídica/porte/CNAE em objetos
// aninhados {codigo, label/descricao}. As variantes snake_case ficam só
// como fallback (robustez caso a origem mude de formato de novo) - mas todo
// valor candidato passa por campoTexto() antes de virar o campo final, pra
// nunca devolver o objeto cru independente de qual branch bateu.
function mapearFicha(data) {
  const situacao = data.situacao || data.situacao_cadastral;
  const naturezaJuridica = data.naturezaJuridica || data.natureza_juridica;
  const cnae = data.cnae || data.cnae_principal || data.cnae_fiscal;
  const endereco = data.endereco && typeof data.endereco === 'object' ? data.endereco : {};
  const contato = data.contato && typeof data.contato === 'object' ? data.contato : {};

  return {
    razao_social: data.razaoSocial || data.razao_social || data.nome || null,
    nome_fantasia: data.nomeFantasia || data.nome_fantasia || data.fantasia || null,
    situacao_cadastral: campoTexto(situacao),
    data_situacao_cadastral: (situacao && typeof situacao === 'object' && situacao.data) || data.data_situacao_cadastral || null,
    motivo_situacao: (situacao && typeof situacao === 'object' && situacao.motivo) || data.motivo_situacao || null,
    cnae_principal_codigo: (cnae && typeof cnae === 'object' && cnae.codigo) || (typeof cnae === 'string' || typeof cnae === 'number' ? cnae : null),
    cnae_principal_descricao: campoTexto(cnae),
    natureza_juridica: campoTexto(naturezaJuridica),
    porte: campoTexto(data.porte),
    data_abertura: data.dataInicio || data.data_abertura || null,
    capital_social: data.capitalSocial != null ? Number(data.capitalSocial) : (data.capital_social != null ? Number(data.capital_social) : null),
    logradouro: endereco.logradouro || null,
    numero: endereco.numero || null,
    complemento: endereco.complemento || null,
    bairro: endereco.bairro || null,
    municipio: campoTexto(endereco.municipio) || null,
    uf: endereco.uf || null,
    cep: endereco.cep || null,
    telefone: contato.telefone1 || contato.telefone || null,
    email: contato.email || null,
    matriz_filial: campoTexto(data.matrizFilial),
    cnae_secundario: typeof data.cnaeSecundario === 'string' ? data.cnaeSecundario : null,
    socios: Array.isArray(data.socios)
      ? data.socios.map((s) => ({
        nome: s.nome || null,
        qualificacao: campoTexto(s.qualificacao),
        // data sem hora: guarda só o "AAAA-MM-DD" do texto ("2026-04-22T00:00:00.000Z")
        dataEntrada: s.dataEntrada ? String(s.dataEntrada).slice(0, 10) : null,
        // código da Receita (1 = até 12 anos ... 9 = mais de 80); 0 = não se aplica (sócio empresa)
        faixaEtaria: Number(s.faixaEtaria) > 0 ? Number(s.faixaEtaria) : null,
      })).filter((s) => s.nome)
      : null,
  };
}

// Nome completo dos sócios (routes/lib/nomesSocios.js): o radar-cnpj manda
// abreviado desde 25/09/2026. A BrasilAPI (nome inteiro, quadro atual) vale
// primeiro; a ficha gravada antes só entra se ela falhar - sozinha ela poria o
// nome de um ex-sócio com as mesmas iniciais no lugar do sócio novo, por isso
// ali a data de entrada também tem de bater quando as duas têm.
// conferidos: true = a BrasilAPI respondeu (ou não tem o CNPJ), não pergunta de
// novo por 30 dias; false = falhou, espera SOCIOS_ESPERA_FALHA_MS.
const falhaSociosEm = new Map(); // clienteId -> quando a BrasilAPI falhou (em memória)
const SOCIOS_ESPERA_FALHA_MS = 6 * 60 * 60 * 1000;

function anterioresCompativeis(socios, anteriores) {
  if (!Array.isArray(anteriores)) return [];
  return anteriores.filter((a) => a && a.nome && !(Array.isArray(socios) && socios.some((s) => s
    && s.dataEntrada && a.dataEntrada && s.dataEntrada !== a.dataEntrada
    && String(s.nome).split(/\s+/)[0] === String(a.nome).split(/\s+/)[0])));
}

async function sociosComNomeCompleto(clienteId, cnpj, socios, sociosAnteriores, veioDaBrasilApi) {
  if (!temSocioAbreviado(socios) || veioDaBrasilApi) return { socios, conferidos: !!veioDaBrasilApi };
  try {
    const brasil = await buscarNaBrasilApi(cnpj);
    falhaSociosEm.delete(String(clienteId));
    return { socios: completarNomesSocios(socios, mapearFicha(brasil).socios), conferidos: true };
  } catch (e) {
    if (e.naoEncontrado) return { socios: completarNomesSocios(socios, anterioresCompativeis(socios, sociosAnteriores)), conferidos: true };
    falhaSociosEm.set(String(clienteId), Date.now());
    return { socios: completarNomesSocios(socios, anterioresCompativeis(socios, sociosAnteriores)), conferidos: false };
  }
}

const SOCIOS_RECONFERIR_DIAS = 30;
function sociosPrecisamConferir(row) {
  if (!row || !temSocioAbreviado(row.socios)) return false;
  const falhou = falhaSociosEm.get(String(row.cliente_id));
  if (falhou && Date.now() - falhou < SOCIOS_ESPERA_FALHA_MS) return false;
  if (!row.socios_completados_em) return true;
  return Date.now() - new Date(row.socios_completados_em).getTime() > SOCIOS_RECONFERIR_DIAS * 24 * 60 * 60 * 1000;
}

// socios: a lista já com o nome completo (sociosComNomeCompleto); sem ela, a da ficha.
// sociosConferidos: true = a BrasilAPI respondeu na consulta dos nomes (marca a hora),
// false = não respondeu (limpa a marca), null = não mexe na marca.
async function salvarFichaEmCache(clienteId, ficha, dadosBrutos, socios, sociosConferidos) {
  const campos = mapearFicha(ficha);
  if (socios !== undefined) campos.socios = socios;
  const result = await pool.query(
    `INSERT INTO cliente_cnpj_ficha (
       cliente_id, razao_social, nome_fantasia, situacao_cadastral, data_situacao_cadastral,
       motivo_situacao, cnae_principal_codigo, cnae_principal_descricao, natureza_juridica, porte,
       data_abertura, capital_social, logradouro, numero, complemento, bairro, municipio, uf, cep,
       telefone, email, matriz_filial, cnae_secundario, socios, dados_brutos, atualizado_em, socios_completados_em
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25, now(),
       CASE WHEN $26::boolean THEN now() END)
     ON CONFLICT (cliente_id) DO UPDATE SET
       razao_social = EXCLUDED.razao_social, nome_fantasia = EXCLUDED.nome_fantasia,
       situacao_cadastral = EXCLUDED.situacao_cadastral, data_situacao_cadastral = EXCLUDED.data_situacao_cadastral,
       motivo_situacao = EXCLUDED.motivo_situacao, cnae_principal_codigo = EXCLUDED.cnae_principal_codigo,
       cnae_principal_descricao = EXCLUDED.cnae_principal_descricao, natureza_juridica = EXCLUDED.natureza_juridica,
       porte = EXCLUDED.porte, data_abertura = EXCLUDED.data_abertura, capital_social = EXCLUDED.capital_social,
       logradouro = EXCLUDED.logradouro, numero = EXCLUDED.numero, complemento = EXCLUDED.complemento,
       bairro = EXCLUDED.bairro, municipio = EXCLUDED.municipio, uf = EXCLUDED.uf, cep = EXCLUDED.cep,
       telefone = EXCLUDED.telefone, email = EXCLUDED.email, matriz_filial = EXCLUDED.matriz_filial,
       cnae_secundario = EXCLUDED.cnae_secundario, socios = EXCLUDED.socios, dados_brutos = EXCLUDED.dados_brutos,
       atualizado_em = now(), socios_completados_em = CASE WHEN $26::boolean IS NULL
         THEN cliente_cnpj_ficha.socios_completados_em ELSE EXCLUDED.socios_completados_em END
     RETURNING *`,
    [
      clienteId, campos.razao_social, campos.nome_fantasia, campos.situacao_cadastral, campos.data_situacao_cadastral,
      campos.motivo_situacao, campos.cnae_principal_codigo, campos.cnae_principal_descricao, campos.natureza_juridica, campos.porte,
      campos.data_abertura, campos.capital_social, campos.logradouro, campos.numero, campos.complemento, campos.bairro, campos.municipio,
      campos.uf, campos.cep, campos.telefone, campos.email, campos.matriz_filial, campos.cnae_secundario,
      campos.socios ? JSON.stringify(campos.socios) : null, JSON.stringify(dadosBrutos), sociosConferidos == null ? null : !!sociosConferidos,
    ]
  );
  return result.rows[0];
}

function fichaEstaFresca(row) {
  if (!row) return false;
  const idadeMs = Date.now() - new Date(row.atualizado_em).getTime();
  return idadeMs < CACHE_MAX_IDADE_DIAS * 24 * 60 * 60 * 1000;
}

// Sinal de que essa linha foi gravada por uma versão antiga do mapeamento,
// que salvava o objeto aninhado inteiro (ex: situacao_cadastral) em vez do
// texto - o driver pg serializa objeto em coluna TEXT como JSON, então o
// valor gravado começa com "{".
function pareceCacheComBugAntigo(row) {
  if (!row) return false;
  return [row.situacao_cadastral, row.natureza_juridica, row.porte].some(
    (v) => typeof v === 'string' && v.trim().startsWith('{')
  );
}

async function obterFicha(clienteId, forcarAtualizacao) {
  const clienteResult = await pool.query('SELECT * FROM clientes WHERE id = $1', [clienteId]);
  const cliente = clienteResult.rows[0];
  if (!cliente) { const e = new Error('Cliente não encontrado.'); e.status = 404; throw e; }

  const cnpj = normalizarCnpj(cliente.documento);
  if (cnpj.length !== 14) { const e = new Error('Cliente sem CNPJ cadastrado (precisa ter 14 dígitos).'); e.status = 400; throw e; }

  const cacheResult = await pool.query('SELECT * FROM cliente_cnpj_ficha WHERE cliente_id = $1', [clienteId]);
  const cache = cacheResult.rows[0] || null;

  // Cache já existe mas foi gravado com o bug de mapeamento antigo - reprocessa
  // a partir do dado bruto já salvo (sem gastar uma nova chamada à origem) e
  // corrige sozinho, sem esperar os 30 dias de validade do cache vencerem.
  if (cache && cache.dados_brutos && pareceCacheComBugAntigo(cache)) {
    const socios = completarNomesSocios(mapearFicha(cache.dados_brutos).socios, cache.socios);
    const corrigida = await salvarFichaEmCache(clienteId, cache.dados_brutos, cache.dados_brutos, socios, null);
    if (!forcarAtualizacao) return { ficha: corrigida, fonte: 'cache' };
  }

  if (!forcarAtualizacao && fichaEstaFresca(cache)) {
    // Ficha gravada com os sócios abreviados: completa pela BrasilAPI uma vez
    // (de novo só depois de 30 dias), sem esperar a ficha vencer.
    if (sociosPrecisamConferir(cache)) {
      const base = (cache.dados_brutos && mapearFicha(cache.dados_brutos).socios) || cache.socios;
      const { socios, conferidos } = await sociosComNomeCompleto(clienteId, cnpj, base, cache.socios, false);
      if (conferidos) {
        const r = await pool.query(
          'UPDATE cliente_cnpj_ficha SET socios = $2, socios_completados_em = now() WHERE cliente_id = $1 RETURNING *',
          [clienteId, JSON.stringify(socios)]
        );
        return { ficha: r.rows[0] || cache, fonte: 'cache' };
      }
    }
    return { ficha: cache, fonte: 'cache' };
  }

  try {
    const dados = await buscarFichaNaOrigem(cnpj);
    const { socios, conferidos } = await sociosComNomeCompleto(
      clienteId, cnpj, mapearFicha(dados).socios, cache && cache.socios, dados.origem === 'brasilapi'
    );
    const salva = await salvarFichaEmCache(clienteId, dados, dados, socios, conferidos);
    return { ficha: salva, fonte: 'origem' };
  } catch (erroOrigem) {
    // Sem internet ou origem fora do ar - se já tem algo em cache (mesmo
    // vencido), devolve isso em vez de deixar a tela vazia.
    if (cache) return { ficha: cache, fonte: 'cache_vencido', aviso: erroOrigem.message };
    if (erroOrigem.naoEncontrado) { const e = new Error(erroOrigem.message); e.status = 404; throw e; }
    const e = new Error('Não foi possível consultar o CNPJ agora: ' + erroOrigem.message);
    e.status = 502;
    throw e;
  }
}

// e.status só vem setado quando o erro foi lançado deliberadamente por
// obterFicha/buscarFichaNaOrigem com uma mensagem pensada pro usuário ler
// (ex: "CNPJ precisa ter 14 dígitos") - um erro sem .status é algo
// inesperado (ex: banco fora do ar), e nesse caso não expõe e.message cru.
function respostaDeErro(res, e) {
  console.error(e);
  if (e.status) return res.status(e.status).json({ erro: e.message });
  res.status(500).json({ erro: 'Erro ao consultar ficha de CNPJ.' });
}

router.get('/clientes/:id/ficha-cnpj', radarCnpjLimiter, async (req, res) => {
  try {
    const { ficha, fonte, aviso } = await obterFicha(req.params.id, false);
    res.json({ ficha, fonte, aviso });
  } catch (e) {
    respostaDeErro(res, e);
  }
});

// Só diz se o cliente já tem ficha guardada - lê o banco, NUNCA consulta a
// Receita (sem limitador de origem). Usado pra mostrar o atalho "Ficha
// cadastral" na barra do cliente sem gastar consulta.
router.get('/clientes/:id/ficha-cnpj/existe', async (req, res) => {
  try {
    const r = await pool.query('SELECT atualizado_em, municipio, uf FROM cliente_cnpj_ficha WHERE cliente_id = $1', [req.params.id]);
    const f = r.rows[0];
    // município/UF vão junto pro pedido mínimo por região (SP Capital tem
    // mínimo diferente do resto de SP - ver pedidoMinimoCif em index.html)
    res.json({ existe: !!f, atualizado_em: f ? f.atualizado_em : null, municipio: f ? f.municipio : null, uf: f ? f.uf : null });
  } catch (e) {
    respostaDeErro(res, e);
  }
});

// Progresso do preenchimento automático (routes/lib/preenchimentoCnpj.js),
// mostrado no Painel Administrativo.
router.get('/cnpj-preenchimento/status', async (req, res) => {
  try {
    res.json(await statusPreenchimento(pool));
  } catch (e) {
    respostaDeErro(res, e);
  }
});

// Posição das lojas (GPS do levantamento ou pelo endereço da ficha, ver
// routes/lib/geocodificacao.js), mostrada no Painel Administrativo.
router.get('/geocodificacao/status', async (req, res) => {
  try {
    res.json(await statusGeocodificacao(pool));
  } catch (e) {
    respostaDeErro(res, e);
  }
});

router.post('/clientes/:id/ficha-cnpj/atualizar', radarCnpjLimiter, async (req, res) => {
  try {
    const { ficha, fonte, aviso } = await obterFicha(req.params.id, true);
    res.json({ ficha, fonte, aviso });
  } catch (e) {
    respostaDeErro(res, e);
  }
});

// Autopreenchimento no cadastro de cliente novo - o cliente ainda não existe
// no banco, então não há onde cachear; consulta direto e devolve só o
// essencial. Best effort: qualquer falha aqui não deve travar o cadastro
// manual, então o front-end trata erro como "não preencheu nada".
router.get('/radar-cnpj/:cnpj', radarCnpjLimiter, async (req, res) => {
  const cnpj = normalizarCnpj(req.params.cnpj);
  if (cnpj.length !== 14) return res.status(400).json({ erro: 'CNPJ precisa ter 14 dígitos.' });
  try {
    const dados = await buscarFichaNaOrigem(cnpj);
    const campos = mapearFicha(dados);
    res.json({
      razao_social: campos.razao_social,
      nome_fantasia: campos.nome_fantasia,
      situacao_cadastral: campos.situacao_cadastral,
    });
  } catch (e) {
    if (e.naoEncontrado) return res.status(404).json({ erro: e.message });
    console.error(e);
    res.status(502).json({ erro: 'Não foi possível consultar o CNPJ agora.' });
  }
});

module.exports = router;
// reaproveitado pelo preenchimento automático (server.js)
module.exports.obterFicha = obterFicha;
