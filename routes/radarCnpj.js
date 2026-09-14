const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Consulta pública da Receita Federal via radar-cnpj.com - sem chave, sem
// conta, cacheada 6h na origem. Aqui guardamos nosso próprio cache (tabela
// cliente_cnpj_ficha) por mais tempo (30 dias) porque dado cadastral de
// empresa muda pouco, e assim evitamos bater na API a cada abertura da tela.
const RADAR_CNPJ_BASE = 'https://radar-cnpj.com';
const CACHE_MAX_IDADE_DIAS = 30;

function normalizarCnpj(v) {
  return String(v || '').replace(/\D/g, '');
}

async function buscarFichaNaOrigem(cnpj) {
  const resp = await fetch(`${RADAR_CNPJ_BASE}/api/cnpj/${cnpj}`);
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
      ? data.socios.map((s) => ({ nome: s.nome || null, qualificacao: campoTexto(s.qualificacao) })).filter((s) => s.nome)
      : null,
  };
}

async function salvarFichaEmCache(clienteId, ficha, dadosBrutos) {
  const campos = mapearFicha(ficha);
  const result = await pool.query(
    `INSERT INTO cliente_cnpj_ficha (
       cliente_id, razao_social, nome_fantasia, situacao_cadastral, data_situacao_cadastral,
       motivo_situacao, cnae_principal_codigo, cnae_principal_descricao, natureza_juridica, porte,
       data_abertura, capital_social, logradouro, numero, complemento, bairro, municipio, uf, cep,
       telefone, email, matriz_filial, cnae_secundario, socios, dados_brutos, atualizado_em
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25, now())
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
       atualizado_em = now()
     RETURNING *`,
    [
      clienteId, campos.razao_social, campos.nome_fantasia, campos.situacao_cadastral, campos.data_situacao_cadastral,
      campos.motivo_situacao, campos.cnae_principal_codigo, campos.cnae_principal_descricao, campos.natureza_juridica, campos.porte,
      campos.data_abertura, campos.capital_social, campos.logradouro, campos.numero, campos.complemento, campos.bairro, campos.municipio,
      campos.uf, campos.cep, campos.telefone, campos.email, campos.matriz_filial, campos.cnae_secundario,
      campos.socios ? JSON.stringify(campos.socios) : null, JSON.stringify(dadosBrutos),
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
    const corrigida = await salvarFichaEmCache(clienteId, cache.dados_brutos, cache.dados_brutos);
    if (!forcarAtualizacao) return { ficha: corrigida, fonte: 'cache' };
  }

  if (!forcarAtualizacao && fichaEstaFresca(cache)) {
    return { ficha: cache, fonte: 'cache' };
  }

  try {
    const dados = await buscarFichaNaOrigem(cnpj);
    const salva = await salvarFichaEmCache(clienteId, dados, dados);
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

router.get('/clientes/:id/ficha-cnpj', async (req, res) => {
  try {
    const { ficha, fonte, aviso } = await obterFicha(req.params.id, false);
    res.json({ ficha, fonte, aviso });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ erro: e.message });
  }
});

router.post('/clientes/:id/ficha-cnpj/atualizar', async (req, res) => {
  try {
    const { ficha, fonte, aviso } = await obterFicha(req.params.id, true);
    res.json({ ficha, fonte, aviso });
  } catch (e) {
    console.error(e);
    res.status(e.status || 500).json({ erro: e.message });
  }
});

// Autopreenchimento no cadastro de cliente novo - o cliente ainda não existe
// no banco, então não há onde cachear; consulta direto e devolve só o
// essencial. Best effort: qualquer falha aqui não deve travar o cadastro
// manual, então o front-end trata erro como "não preencheu nada".
router.get('/radar-cnpj/:cnpj', async (req, res) => {
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
    res.status(502).json({ erro: e.message });
  }
});

module.exports = router;
