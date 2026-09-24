// Reserva da consulta de CNPJ (routes/radarCnpj.js): quando o radar-cnpj.com
// recusa, atinge limite ou está fora do ar, a ficha vem da BrasilAPI
// (brasilapi.com.br, gratuita, sem chave). A BrasilAPI devolve os campos
// planos em snake_case; aqui eles são convertidos pro MESMO formato do
// radar-cnpj (camelCase, com situação/porte/CNAE em objetos aninhados), pra
// que mapearFicha, o cache em cliente_cnpj_ficha (dados_brutos) e as telas
// não precisem saber de onde a ficha veio.
//
// Formato do radar-cnpj conferido contra as fichas reais já gravadas no banco
// (dados_brutos): situacao {codigo, label, data, motivo}, naturezaJuridica
// {codigo, descricao}, cnae {codigo, descricao}, porte/matrizFilial {codigo,
// label}, endereco {tipoLogradouro, logradouro (sem o tipo), numero, ...},
// contato {telefone1 "(44) 32321234", telefone2, email}, cnaeSecundario
// "4742300,4744001,", socios [{nome, qualificacao {codigo, descricao}}].

const BRASILAPI_BASE = 'https://brasilapi.com.br';

// "ATIVA" -> "Ativa", "MATRIZ" -> "Matriz" - o radar-cnpj devolve assim e a
// tela mostra o texto como vier.
function capitalizar(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLocaleLowerCase('pt-BR');
  return s.charAt(0).toLocaleUpperCase('pt-BR') + s.slice(1);
}

const PORTE_COMO_NO_RADAR = {
  'MICRO EMPRESA': 'Microempresa',
  'EMPRESA DE PEQUENO PORTE': 'Empresa de Pequeno Porte',
  'DEMAIS': 'Demais',
  'NAO INFORMADO': 'Não informado',
  'NÃO INFORMADO': 'Não informado',
};

// "4432321234" -> "(44) 32321234", mesmo jeito que o radar-cnpj formata
function formatarTelefone(v) {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length < 10) return d || null;
  return `(${d.slice(0, 2)}) ${d.slice(2)}`;
}

function texto(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function brasilApiParaFormatoRadar(d) {
  const porte = texto(d.porte) || texto(d.descricao_porte);
  return {
    cnpj: texto(d.cnpj),
    razaoSocial: texto(d.razao_social),
    nomeFantasia: texto(d.nome_fantasia),
    situacao: {
      codigo: d.situacao_cadastral ?? null,
      label: capitalizar(d.descricao_situacao_cadastral),
      data: texto(d.data_situacao_cadastral),
      motivo: texto(d.descricao_motivo_situacao_cadastral),
    },
    naturezaJuridica: { codigo: d.codigo_natureza_juridica ?? null, descricao: texto(d.natureza_juridica) },
    cnae: d.cnae_fiscal != null ? { codigo: String(d.cnae_fiscal), descricao: texto(d.cnae_fiscal_descricao) } : null,
    porte: porte ? { codigo: d.codigo_porte ?? null, label: PORTE_COMO_NO_RADAR[porte.toUpperCase()] || capitalizar(porte) } : null,
    dataInicio: texto(d.data_inicio_atividade),
    capitalSocial: d.capital_social != null ? Number(d.capital_social) : null,
    endereco: {
      tipoLogradouro: texto(d.descricao_tipo_de_logradouro),
      logradouro: texto(d.logradouro),
      numero: texto(d.numero),
      complemento: texto(d.complemento),
      bairro: texto(d.bairro),
      municipio: texto(d.municipio),
      uf: texto(d.uf),
      cep: texto(d.cep) ? String(d.cep).replace(/\D/g, '') : null,
    },
    contato: {
      telefone1: formatarTelefone(d.ddd_telefone_1),
      telefone2: formatarTelefone(d.ddd_telefone_2),
      email: texto(d.email),
    },
    matrizFilial: d.descricao_identificador_matriz_filial
      ? { codigo: d.identificador_matriz_filial ?? null, label: capitalizar(d.descricao_identificador_matriz_filial) }
      : null,
    cnaeSecundario: Array.isArray(d.cnaes_secundarios)
      ? d.cnaes_secundarios.map((c) => c && c.codigo).filter((c) => c && Number(c) !== 0).join(',') || null
      : null,
    socios: Array.isArray(d.qsa)
      ? d.qsa.map((s) => ({ nome: texto(s.nome_socio), qualificacao: { codigo: s.codigo_qualificacao_socio ?? null, descricao: texto(s.qualificacao_socio) } }))
      : [],
    // marca de onde veio, só pra diagnóstico - nenhuma tela usa
    origem: 'brasilapi',
  };
}

async function buscarNaBrasilApi(cnpj) {
  const resp = await fetch(`${BRASILAPI_BASE}/api/cnpj/v1/${cnpj}`, { signal: AbortSignal.timeout(8000) });
  if (resp.status === 404) {
    const erro = new Error('CNPJ não encontrado na base da Receita Federal.');
    erro.naoEncontrado = true;
    throw erro;
  }
  if (!resp.ok) throw new Error(`BrasilAPI respondeu ${resp.status}`);
  const body = await resp.json();
  if (!body || !body.cnpj) throw new Error('BrasilAPI devolveu uma resposta sem CNPJ.');
  return brasilApiParaFormatoRadar(body);
}

module.exports = { buscarNaBrasilApi, brasilApiParaFormatoRadar };
