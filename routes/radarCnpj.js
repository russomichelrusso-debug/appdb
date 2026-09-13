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

// Os nomes de campo exatos da ficha da origem ainda não foram confirmados
// contra uma resposta real (sem acesso de rede neste ambiente de dev) - por
// isso aceitamos variações prováveis e guardamos a resposta crua inteira em
// `dados_brutos`, pra nunca perder informação mesmo se o mapeamento abaixo
// precisar de ajuste depois de ver o formato real em produção.
function mapearFicha(data) {
  return {
    razao_social: data.razao_social || data.nome || data.razaoSocial || null,
    nome_fantasia: data.nome_fantasia || data.fantasia || data.nomeFantasia || null,
    situacao_cadastral: data.situacao_cadastral || data.situacao || data.situacaoCadastral || null,
    data_situacao_cadastral: data.data_situacao_cadastral || data.data_situacao || data.dataSituacaoCadastral || null,
    motivo_situacao: data.motivo_situacao || data.motivoSituacao || null,
    cnae_principal_codigo: data.cnae_fiscal || data.cnae_principal_codigo || data.cnaePrincipal || null,
    cnae_principal_descricao: data.cnae_fiscal_descricao || data.cnae_principal_descricao || data.cnaePrincipalDescricao || null,
    natureza_juridica: data.natureza_juridica || data.naturezaJuridica || null,
    porte: data.porte || null,
    data_abertura: data.data_inicio_atividade || data.data_abertura || data.dataAbertura || null,
    capital_social: data.capital_social != null ? Number(data.capital_social) : (data.capitalSocial != null ? Number(data.capitalSocial) : null),
    logradouro: data.logradouro || null,
    numero: data.numero || null,
    bairro: data.bairro || null,
    municipio: data.municipio || null,
    uf: data.uf || null,
    cep: data.cep || null,
    telefone: data.ddd_telefone_1 || data.telefone || null,
    email: data.email || null,
  };
}

async function salvarFichaEmCache(clienteId, ficha, dadosBrutos) {
  const campos = mapearFicha(ficha);
  const result = await pool.query(
    `INSERT INTO cliente_cnpj_ficha (
       cliente_id, razao_social, nome_fantasia, situacao_cadastral, data_situacao_cadastral,
       motivo_situacao, cnae_principal_codigo, cnae_principal_descricao, natureza_juridica, porte,
       data_abertura, capital_social, logradouro, numero, bairro, municipio, uf, cep, telefone, email,
       dados_brutos, atualizado_em
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21, now())
     ON CONFLICT (cliente_id) DO UPDATE SET
       razao_social = EXCLUDED.razao_social, nome_fantasia = EXCLUDED.nome_fantasia,
       situacao_cadastral = EXCLUDED.situacao_cadastral, data_situacao_cadastral = EXCLUDED.data_situacao_cadastral,
       motivo_situacao = EXCLUDED.motivo_situacao, cnae_principal_codigo = EXCLUDED.cnae_principal_codigo,
       cnae_principal_descricao = EXCLUDED.cnae_principal_descricao, natureza_juridica = EXCLUDED.natureza_juridica,
       porte = EXCLUDED.porte, data_abertura = EXCLUDED.data_abertura, capital_social = EXCLUDED.capital_social,
       logradouro = EXCLUDED.logradouro, numero = EXCLUDED.numero, bairro = EXCLUDED.bairro,
       municipio = EXCLUDED.municipio, uf = EXCLUDED.uf, cep = EXCLUDED.cep, telefone = EXCLUDED.telefone,
       email = EXCLUDED.email, dados_brutos = EXCLUDED.dados_brutos, atualizado_em = now()
     RETURNING *`,
    [
      clienteId, campos.razao_social, campos.nome_fantasia, campos.situacao_cadastral, campos.data_situacao_cadastral,
      campos.motivo_situacao, campos.cnae_principal_codigo, campos.cnae_principal_descricao, campos.natureza_juridica, campos.porte,
      campos.data_abertura, campos.capital_social, campos.logradouro, campos.numero, campos.bairro, campos.municipio,
      campos.uf, campos.cep, campos.telefone, campos.email, JSON.stringify(dadosBrutos),
    ]
  );
  return result.rows[0];
}

function fichaEstaFresca(row) {
  if (!row) return false;
  const idadeMs = Date.now() - new Date(row.atualizado_em).getTime();
  return idadeMs < CACHE_MAX_IDADE_DIAS * 24 * 60 * 60 * 1000;
}

async function obterFicha(clienteId, forcarAtualizacao) {
  const clienteResult = await pool.query('SELECT * FROM clientes WHERE id = $1', [clienteId]);
  const cliente = clienteResult.rows[0];
  if (!cliente) { const e = new Error('Cliente não encontrado.'); e.status = 404; throw e; }

  const cnpj = normalizarCnpj(cliente.documento);
  if (cnpj.length !== 14) { const e = new Error('Cliente sem CNPJ cadastrado (precisa ter 14 dígitos).'); e.status = 400; throw e; }

  const cacheResult = await pool.query('SELECT * FROM cliente_cnpj_ficha WHERE cliente_id = $1', [clienteId]);
  const cache = cacheResult.rows[0] || null;

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
