// Simula um banco em memória, registrando toda query executada (pra eu
// conferir se o SQL/parâmetros estão corretos) e devolvendo dados coerentes.
const queryLog = [];

let clientes = [];
let vendedores = [];
let produtos = [
  { id: 1, codigo_sku: '60863', nome: 'DISCO DE CORTE DIAMANTADO TURBO PORCELANATO 110 mm', categoria: '09 - CORTE DIAMANTADO' },
  { id: 2, codigo_sku: '61362', nome: 'CORTADOR HD 150', categoria: '01 - CORTADORES MANUAIS' },
];
let pedidos = [];
let pedidoItens = [];
let levantamentos = [];
let levantamentoItens = [];
let usuarios = [];
let sessoes = [];
let rascunhos = {}; // usuario_id -> { rascunho, atualizado_em }
let codigosProduto = {}; // codigo_sku -> { ean13, dun14 }
let clienteCnpjFicha = {}; // cliente_id -> linha de cliente_cnpj_ficha
let pedidosOficiaisItens = []; // relatório oficial de Faturamento (curva ABC de produtos/clientes)
let configuracoes = {}; // chave -> valor (routes/configuracoes.js)
let catalogoPrecos = []; // {codigo_sku, nome, emb, ipi, familia, precos_sem_imposto} (routes/catalogoPrecos.js)
let nextId = { clientes: 1, vendedores: 1, produtos: 3, pedidos: 1, pedido_itens: 1, levantamentos: 1, levantamento_itens: 1, usuarios: 1, sessoes: 1 };

function reset() {
  queryLog.length = 0;
  clientes = [];
  vendedores = [];
  pedidos = [];
  pedidoItens = [];
  levantamentos = [];
  levantamentoItens = [];
  usuarios = [];
  sessoes = [];
  rascunhos = {};
  codigosProduto = {};
  clienteCnpjFicha = {};
  pedidosOficiaisItens = [];
  configuracoes = {};
  catalogoPrecos = [];
  nextId = { clientes: 1, vendedores: 1, produtos: 3, pedidos: 1, pedido_itens: 1, levantamentos: 1, levantamento_itens: 1, usuarios: 1, sessoes: 1 };
}

// Só pra teste: injeta dados diretamente no estado em memória, sem passar
// pela rota de import real (que faz UNNEST em lote) - o que importa aqui é
// testar a leitura (curva ABC), não o pipeline de importação em si.
function seed(partial) {
  if (partial.clientes) clientes.push(...partial.clientes);
  if (partial.pedidosOficiaisItens) pedidosOficiaisItens.push(...partial.pedidosOficiaisItens);
  if (partial.catalogoPrecos) catalogoPrecos.push(...partial.catalogoPrecos);
}

async function query(sql, params = []) {
  queryLog.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
  // normaliza espaço/quebra de linha antes de comparar - as queries reais são
  // template literals multi-linha, então um substring de match precisa ficar
  // igual independente de indentação/quebra de linha.
  const s = sql.replace(/\s+/g, ' ').toUpperCase();

  if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
  if (s.includes('CREATE TABLE')) return { rows: [] };

  // clientes
  if (s.includes('SELECT ID FROM CLIENTES WHERE DOCUMENTO')) {
    const found = clientes.filter(c => c.documento === params[0]);
    return { rows: found };
  }
  if (s.includes('SELECT * FROM CLIENTES WHERE DOCUMENTO')) {
    const found = clientes.filter(c => c.documento === params[0]);
    return { rows: found };
  }
  // clientMatcher.js (acharOuCriarCliente/acharClientePorNome) - usado pela
  // importação de faturamento (classificatório) e por outros fluxos que
  // compartilham essa lógica (pedidos.js, levantamentos.js).
  if (s === 'SELECT CODIGO_OFICIAL FROM CLIENTES WHERE ID = $1') {
    const c = clientes.find(x => Number(x.id) === Number(params[0]));
    return { rows: c ? [{ codigo_oficial: c.codigo_oficial || null }] : [] };
  }
  if (s === 'UPDATE CLIENTES SET CODIGO_OFICIAL = $1 WHERE ID = $2') {
    const c = clientes.find(x => Number(x.id) === Number(params[1]));
    if (c) c.codigo_oficial = params[0];
    return { rows: [] };
  }
  if (s.includes('SELECT ID FROM CLIENTES WHERE CODIGO_OFICIAL')) {
    const found = clientes.filter(c => c.codigo_oficial === params[0]);
    return { rows: found.map(c => ({ id: c.id })) };
  }
  if (s.includes('SELECT ID FROM CLIENTES WHERE REGEXP_REPLACE(DOCUMENTO')) {
    const doc = String(params[0] || '').replace(/\D/g, '');
    const found = clientes.filter(c => (c.documento || '').replace(/\D/g, '') === doc && doc !== '');
    return { rows: found.map(c => ({ id: c.id })) };
  }
  if (s.includes("REGEXP_REPLACE(UPPER(TRIM(NOME)), '\\S+', ' '")) {
    const alvo = String(params[0] || '').trim().toUpperCase().replace(/\s+/g, ' ');
    const found = clientes.filter(c => (c.nome || '').trim().toUpperCase().replace(/\s+/g, ' ') === alvo);
    return { rows: found.map(c => ({ id: c.id })) };
  }
  if (s.includes("REGEXP_REPLACE(UPPER(TRIM(NOME)), '[.,\\S]+', ' '")) {
    const alvo = String(params[0] || '').trim().toUpperCase().replace(/[.,\s]+/g, ' ');
    const found = clientes.filter(c => (c.nome || '').trim().toUpperCase().replace(/[.,\s]+/g, ' ') === alvo);
    return { rows: found.map(c => ({ id: c.id })) };
  }
  if (s.includes('UNNEST') && s.includes('INTO CLIENTES')) {
    const [nomes, documentos] = params;
    let criados = 0, atualizados = 0;
    for (let i = 0; i < nomes.length; i++) {
      const existing = clientes.find(c => c.documento === documentos[i]);
      if (existing) { existing.nome = nomes[i]; atualizados++; }
      else { clientes.push({ id: nextId.clientes++, nome: nomes[i], documento: documentos[i], contato: null }); criados++; }
    }
    return { rows: [{ criados: String(criados), atualizados: String(atualizados) }] };
  }
  if (s.includes('INSERT INTO CLIENTES') && s.includes('CODIGO_OFICIAL')) {
    // clientMatcher.js: INSERT INTO clientes (nome, documento, codigo_oficial, contato)
    const c = { id: nextId.clientes++, nome: params[0], documento: params[1], codigo_oficial: params[2], contato: params[3], classificatorio_tipo: null, classificatorio_desconto: null };
    clientes.push(c);
    return { rows: [{ id: c.id }] };
  }
  if (s.includes('INSERT INTO CLIENTES')) {
    const c = { id: nextId.clientes++, nome: params[0], documento: params[1], contato: params[2], classificatorio_tipo: null, classificatorio_desconto: null };
    clientes.push(c);
    return { rows: [s.includes('RETURNING *') ? c : { id: c.id }] };
  }
  if (s.includes('SELECT ID, NOME, DOCUMENTO, CONTATO, CLASSIFICATORIO_TIPO, CLASSIFICATORIO_DESCONTO FROM CLIENTES')) {
    const busca = params[0] ? params[0].replace(/%/g, '').toUpperCase() : null;
    const found = busca
      ? clientes.filter(c => c.nome.toUpperCase().includes(busca) || (c.documento || '').toUpperCase().includes(busca))
      : clientes;
    return { rows: found.map(c => ({ classificatorio_tipo: null, classificatorio_desconto: null, ...c })) };
  }
  if (s.includes('SELECT * FROM CLIENTES WHERE ID')) {
    return { rows: clientes.filter(c => c.id == params[0]) };
  }
  if (s.includes('SELECT ID, NOME, DOCUMENTO FROM CLIENTES')) {
    return { rows: clientes.map(c => ({ id: c.id, nome: c.nome, documento: c.documento })) };
  }
  if (s.includes('FROM CLIENTES WHERE ID = ANY')) {
    const ids = params[0].map(Number);
    return { rows: clientes.filter(c => ids.includes(Number(c.id))) };
  }
  if (s.includes('UPDATE PEDIDOS SET CLIENTE_ID')) {
    const [novoId, antigoId] = params;
    pedidos.forEach(p => { if (p.cliente_id == antigoId) p.cliente_id = novoId; });
    return { rows: [] };
  }
  if (s.includes('UPDATE LEVANTAMENTOS SET CLIENTE_ID')) {
    const [novoId, antigoId] = params;
    levantamentos.forEach(l => { if (l.cliente_id == antigoId) l.cliente_id = novoId; });
    return { rows: [] };
  }
  if (s.includes('DELETE FROM CLIENTES WHERE ID')) {
    const idRemover = Number(params[0]);
    clientes = clientes.filter(c => Number(c.id) !== idRemover);
    return { rows: [] };
  }
  if (s.startsWith('UPDATE CLIENTES SET') && s.includes('DOCUMENTO = $2')) {
    const [manterId, documento, contato, codigoOficial, classifTipo, classifDesconto, classifAtualizado] = params;
    const c = clientes.find(x => Number(x.id) === Number(manterId));
    if (c) {
      c.documento = documento; c.contato = contato; c.codigo_oficial = codigoOficial;
      c.classificatorio_tipo = classifTipo; c.classificatorio_desconto = classifDesconto; c.classificatorio_atualizado_em = classifAtualizado;
    }
    return { rows: [] };
  }

  // classificatório (matriz/rede, PIC, "quanto falta") - routes/clientesClassificatorio.js
  if (s.includes('ID, CODIGO_OFICIAL FROM CLIENTES WHERE CODIGO_OFICIAL')) {
    const found = clientes.filter(c => c.codigo_oficial === params[0]);
    return { rows: found.map(c => ({ id: c.id, codigo_oficial: c.codigo_oficial })) };
  }
  if (s.includes('ID, CODIGO_OFICIAL FROM CLIENTES WHERE REGEXP_REPLACE(DOCUMENTO')) {
    const found = clientes.filter(c => (c.documento || '').replace(/\D/g, '') === params[0]);
    return { rows: found.map(c => ({ id: c.id, codigo_oficial: c.codigo_oficial })) };
  }
  if (s.startsWith('UPDATE CLIENTES SET') && s.includes('CODIGO_OFICIAL = COALESCE')) {
    const [codigoOficial, matrizGrupo, pic, vlAcordo, classifTipo, classifDesconto, id] = params;
    const c = clientes.find(x => Number(x.id) === Number(id));
    if (c) {
      if (!c.codigo_oficial) c.codigo_oficial = codigoOficial;
      c.matriz_grupo = matrizGrupo;
      c.classificatorio_pic = pic;
      c.classificatorio_vl_acordo = vlAcordo;
      if (!c.classificatorio_tipo) c.classificatorio_tipo = classifTipo;
      if (!c.classificatorio_desconto) c.classificatorio_desconto = classifDesconto;
    }
    return { rows: [] };
  }
  if (s.includes('SELECT C.ID AS CLIENTE_ID') && s.includes('WHERE C.ID = $1')) {
    const { faturamento_12m, ultima_compra } = calcularFaturamentoAnoFechadoParaCliente(params[0]);
    // A rota real envolve essa subconsulta num SELECT externo que também pede
    // EXTRACT(YEAR FROM ...) AS ano_fechado - inclui aqui pra bater com isso.
    return { rows: [{ cliente_id: Number(params[0]), faturamento_12m, ultima_compra, ano_fechado: anoClassificatorioFechado() }] };
  }
  if (s.includes('SELECT C.ID AS CLIENTE_ID') && s.includes("CLASSIFICATORIO_TIPO IS NOT NULL")) {
    const classificados = clientes.filter(c => c.classificatorio_tipo);
    const rows = classificados.map(c => ({ cliente_id: c.id, ...calcularFaturamentoAnoFechadoParaCliente(c.id) }));
    return { rows };
  }
  if (s.includes("DATE_TRUNC('QUARTER', POI.DATA_FATURAMENTO)")) {
    const cliente = clientes.find(c => Number(c.id) === Number(params[0]));
    if (!cliente) return { rows: [] };
    const grupo = cliente.matriz_grupo ? clientes.filter(c => c.matriz_grupo === cliente.matriz_grupo) : [cliente];
    const codigos = grupo.map(c => c.codigo_oficial).filter(Boolean);
    const ano = anoClassificatorioFechado();
    const inicioStr = `${ano}-01-01`;
    const fimStr = `${ano + 1}-01-01`;
    const itens = pedidosOficiaisItens.filter(it => codigos.includes(it.cliente_codigo_oficial) && it.status === 'faturado' && it.data_faturamento && it.data_faturamento >= inicioStr && it.data_faturamento < fimStr);
    const porTrimestre = {};
    for (const it of itens) {
      const d = new Date(it.data_faturamento);
      const q = Math.floor(d.getMonth() / 3);
      const key = `${d.getFullYear()}-${String(q * 3 + 1).padStart(2, '0')}-01`;
      porTrimestre[key] = (porTrimestre[key] || 0) + (Number(it.valor) || 0);
    }
    const rows = Object.entries(porTrimestre).sort(([a], [b]) => a.localeCompare(b)).map(([trimestre, faturado]) => ({ trimestre, faturado }));
    return { rows };
  }

  // Dashboard principal - canal + inatividade de TODOS os clientes (não só
  // classificados), usado pelos cartões "Clientes Ativos por Canal" e
  // "Contas sem comprar" de GET /api/dashboard/resumo.
  if (s.includes('C.CLASSIFICATORIO_TIPO, BASE.ULTIMA_COMPRA')) {
    const rows = clientes.map(c => ({
      id: c.id,
      classificatorio_tipo: c.classificatorio_tipo || null,
      ultima_compra: calcularFaturamentoAnoFechadoParaCliente(c.id).ultima_compra,
    }));
    return { rows };
  }

  // produtos-abc-geral / clientes/:id/produtos-abc (routes/relatorios.js) -
  // agrega pedidos_oficiais_itens por codigo_sku literal, igual a query
  // real faz antes da reconciliação P/P1/P2 (feita em JS depois, no
  // próprio relatorios.js - aqui só precisa devolver os dados crus).
  if (s.includes('COALESCE(P.NOME, POI.CODIGO_SKU) AS PRODUTO')) {
    const porCliente = s.includes('POI.CLIENTE_CODIGO_OFICIAL = $1');
    let idx = 0;
    const clienteCodigo = porCliente ? params[idx++] : null;
    let inicio = null, fim = null;
    if (s.includes('DATA_FATURAMENTO >=')) inicio = params[idx++];
    if (s.includes('DATA_FATURAMENTO <=')) fim = params[idx++];
    let itens = pedidosOficiaisItens.filter(it => it.status === 'faturado');
    if (porCliente) itens = itens.filter(it => it.cliente_codigo_oficial === clienteCodigo);
    if (inicio) itens = itens.filter(it => it.data_faturamento && it.data_faturamento >= inicio);
    if (fim) itens = itens.filter(it => it.data_faturamento && it.data_faturamento <= fim);
    const porCodigo = new Map();
    for (const it of itens) {
      const atual = porCodigo.get(it.codigo_sku) || { codigo_sku: it.codigo_sku, pedidosSet: new Set(), quantidade_total: 0, faturamento_total: 0 };
      atual.pedidosSet.add(it.nr_pedido);
      atual.quantidade_total += Number(it.quantidade) || 0;
      atual.faturamento_total += Number(it.valor) || 0;
      porCodigo.set(it.codigo_sku, atual);
    }
    const rows = [...porCodigo.values()].map(g => {
      const prod = produtos.find(p => p.codigo_sku === g.codigo_sku);
      return {
        codigo_sku: g.codigo_sku,
        produto: prod ? prod.nome : g.codigo_sku,
        categoria: prod ? prod.categoria : null,
        num_pedidos: g.pedidosSet.size,
        quantidade_total: g.quantidade_total,
        faturamento_total: g.faturamento_total,
      };
    }).sort((a, b) => b.faturamento_total - a.faturamento_total);
    return { rows };
  }
  // Fixup de num_pedidos pra grupos reconciliados por código base (evita
  // contar duas vezes um nr_pedido que tem código base + variante P na
  // mesma linha de pedido) - routes/relatorios.js, reconciliarProdutosPorCodigoBase.
  if (s.startsWith('SELECT COUNT(DISTINCT NR_PEDIDO) AS TOTAL FROM PEDIDOS_OFICIAIS_ITENS') && s.includes('CODIGO_SKU = ANY(')) {
    const codigos = params[0];
    let idx = 1;
    let itens = pedidosOficiaisItens.filter(it => it.status === 'faturado' && codigos.includes(it.codigo_sku));
    if (s.includes('CLIENTE_CODIGO_OFICIAL = $')) { const cc = params[idx++]; itens = itens.filter(it => it.cliente_codigo_oficial === cc); }
    if (s.includes('DATA_FATURAMENTO >=')) { const ini = params[idx++]; itens = itens.filter(it => it.data_faturamento && it.data_faturamento >= ini); }
    if (s.includes('DATA_FATURAMENTO <=')) { const fim = params[idx++]; itens = itens.filter(it => it.data_faturamento && it.data_faturamento <= fim); }
    const total = new Set(itens.map(it => it.nr_pedido)).size;
    return { rows: [{ total }] };
  }

  // GET /api/pedidos-oficiais/:clienteId (routes/pedidosOficiais.js) - uma
  // linha por nr_pedido+codigo_sku, com o nome do produto via LEFT JOIN.
  if (s.includes('POI.NR_PEDIDO, POI.CODIGO_SKU, PR.NOME AS PRODUTO')) {
    const itens = pedidosOficiaisItens
      .filter(it => it.cliente_codigo_oficial === params[0])
      .map(it => {
        const prod = produtos.find(p => p.codigo_sku === it.codigo_sku);
        return {
          nr_pedido: it.nr_pedido, codigo_sku: it.codigo_sku, produto: prod ? prod.nome : null,
          quantidade: it.quantidade, valor: it.valor, data_implantacao: it.data_implantacao,
          data_faturamento: it.data_faturamento, nota_fiscal: it.nota_fiscal || null,
          classificatorio: it.classificatorio || null, transportadora: it.transportadora || null,
          situacao_pedido: it.situacao_pedido || null, status: it.status,
        };
      })
      .sort((a, b) => (b.data_implantacao || '').localeCompare(a.data_implantacao || ''));
    return { rows: itens };
  }

  // Dashboard principal (curva-abc.html, GET /api/dashboard/resumo) -
  // agregações mensal/semanal/trimestral pro negócio inteiro (sem JOIN em
  // clientes, diferente do trimestral por cliente do classificatório acima)
  // + top 5 clientes por faturamento.
  if (s.includes("DATE_TRUNC('MONTH', DATA_FATURAMENTO)") || s.includes("DATE_TRUNC('WEEK', DATA_FATURAMENTO)") || s.includes("DATE_TRUNC('QUARTER', DATA_FATURAMENTO)")) {
    const tipo = s.includes("'MONTH'") ? 'month' : s.includes("'WEEK'") ? 'week' : 'quarter';
    const diasCorte = { month: 365, week: 70, quarter: 730 }[tipo];
    const corte = new Date(); corte.setDate(corte.getDate() - diasCorte);
    const corteStr = corte.toISOString().slice(0, 10);
    const itens = pedidosOficiaisItens.filter(it => it.status === 'faturado' && it.data_faturamento && it.data_faturamento >= corteStr);
    const grupos = new Map();
    for (const it of itens) {
      const d = new Date(it.data_faturamento);
      let key;
      if (tipo === 'month') key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
      else if (tipo === 'quarter') { const q = Math.floor(d.getMonth() / 3); key = `${d.getFullYear()}-${String(q * 3 + 1).padStart(2, '0')}-01`; }
      else { const dia = new Date(d); dia.setDate(dia.getDate() - ((dia.getDay() + 6) % 7)); key = dia.toISOString().slice(0, 10); } // segunda-feira da semana
      const atual = grupos.get(key) || { periodo: key, faturamento: 0, pedidosSet: new Set(), clientesSet: new Set() };
      atual.faturamento += Number(it.valor) || 0;
      atual.pedidosSet.add(it.nr_pedido);
      if (it.cliente_codigo_oficial) atual.clientesSet.add(it.cliente_codigo_oficial);
      grupos.set(key, atual);
    }
    const rows = [...grupos.values()].sort((a, b) => a.periodo.localeCompare(b.periodo))
      .map(g => ({ periodo: g.periodo, faturamento: g.faturamento, pedidos: g.pedidosSet.size, clientes: g.clientesSet.size }));
    return { rows };
  }
  if (s.includes('GROUP BY C.ID, C.NOME')) {
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const porCliente = new Map();
    for (const it of pedidosOficiaisItens) {
      if (it.status !== 'faturado' || !it.data_faturamento || it.data_faturamento < cutoffStr) continue;
      const cli = clientes.find(c => c.codigo_oficial === it.cliente_codigo_oficial);
      if (!cli) continue;
      const atual = porCliente.get(cli.id) || { id: cli.id, nome: cli.nome, faturamento: 0 };
      atual.faturamento += Number(it.valor) || 0;
      porCliente.set(cli.id, atual);
    }
    const rows = [...porCliente.values()].sort((a, b) => b.faturamento - a.faturamento).slice(0, 5);
    return { rows };
  }

  if (s.includes('NOME, DOCUMENTO, CLASSIFICATORIO_TIPO, CLASSIFICATORIO_PIC')) {
    return { rows: clientes.filter(c => c.classificatorio_tipo) };
  }

  // codigos_produto (EAN-13 / DUN-14)
  if (s.includes('SELECT CODIGO_SKU, EAN13, DUN14 FROM CODIGOS_PRODUTO')) {
    return { rows: Object.entries(codigosProduto).map(([codigo_sku, v]) => ({ codigo_sku, ean13: v.ean13, dun14: v.dun14 })) };
  }
  if (s.includes('INTO CODIGOS_PRODUTO')) {
    const [skus, eans, duns] = params;
    for (let i = 0; i < skus.length; i++) {
      const existing = codigosProduto[skus[i]];
      codigosProduto[skus[i]] = {
        ean13: eans[i] || (existing ? existing.ean13 : ''),
        dun14: duns[i] || (existing ? existing.dun14 : ''),
      };
    }
    return { rows: [] };
  }
  if (s.includes('SELECT COUNT(*) FROM CODIGOS_PRODUTO')) {
    return { rows: [{ count: String(Object.keys(codigosProduto).length) }] };
  }

  // cliente_cnpj_ficha (ficha de CNPJ, radar-cnpj.com)
  if (s.includes('SELECT * FROM CLIENTE_CNPJ_FICHA WHERE CLIENTE_ID')) {
    const row = clienteCnpjFicha[params[0]];
    return { rows: row ? [row] : [] };
  }
  if (s.includes('INSERT INTO CLIENTE_CNPJ_FICHA')) {
    const [
      cliente_id, razao_social, nome_fantasia, situacao_cadastral, data_situacao_cadastral,
      motivo_situacao, cnae_principal_codigo, cnae_principal_descricao, natureza_juridica, porte,
      data_abertura, capital_social, logradouro, numero, complemento, bairro, municipio, uf, cep,
      telefone, email, matriz_filial, cnae_secundario, socios, dados_brutos,
    ] = params;
    const row = {
      cliente_id, razao_social, nome_fantasia, situacao_cadastral, data_situacao_cadastral,
      motivo_situacao, cnae_principal_codigo, cnae_principal_descricao, natureza_juridica, porte,
      data_abertura, capital_social, logradouro, numero, complemento, bairro, municipio, uf, cep,
      telefone, email, matriz_filial, cnae_secundario,
      socios: typeof socios === 'string' ? JSON.parse(socios) : socios,
      dados_brutos: typeof dados_brutos === 'string' ? JSON.parse(dados_brutos) : dados_brutos,
      atualizado_em: new Date().toISOString(),
    };
    clienteCnpjFicha[cliente_id] = row;
    return { rows: [row] };
  }

  // vendedores
  if (s.includes('SELECT ID FROM VENDEDORES WHERE NOME')) {
    return { rows: vendedores.filter(v => v.nome === params[0]) };
  }
  if (s.includes('INSERT INTO VENDEDORES')) {
    const v = { id: nextId.vendedores++, nome: params[0] };
    vendedores.push(v);
    return { rows: [{ id: v.id }] };
  }

  // produtos
  if (s.includes('SELECT ID FROM PRODUTOS WHERE CODIGO_SKU')) {
    return { rows: produtos.filter(p => p.codigo_sku === params[0]) };
  }
  if (s.includes('SELECT COUNT(*) FROM PRODUTOS')) {
    return { rows: [{ count: String(produtos.length) }] };
  }
  if (s.includes('UNNEST') && s.includes('INTO PRODUTOS')) {
    const [codigos, nomes, categorias] = params;
    let criados = 0, atualizados = 0;
    for (let i = 0; i < codigos.length; i++) {
      const existing = produtos.find(p => p.codigo_sku === codigos[i]);
      if (existing) { existing.nome = nomes[i]; existing.categoria = categorias[i]; atualizados++; }
      else { produtos.push({ id: nextId.produtos++, codigo_sku: codigos[i], nome: nomes[i], categoria: categorias[i] }); criados++; }
    }
    return { rows: [{ criados: String(criados), atualizados: String(atualizados) }] };
  }
  if (s.includes('INSERT INTO PRODUTOS') && s.includes('ON CONFLICT')) {
    const existing = produtos.find(p => p.codigo_sku === params[0]);
    if (existing) { existing.nome = params[1]; existing.categoria = params[2]; return { rows: [{ inserted: false }] }; }
    produtos.push({ id: nextId.produtos++, codigo_sku: params[0], nome: params[1], categoria: params[2] });
    return { rows: [{ inserted: true }] };
  }
  if (s.includes('SELECT ID, CODIGO_SKU, NOME, CATEGORIA FROM PRODUTOS')) {
    return { rows: produtos };
  }
  // Reconciliação P/P1/P2 (routes/lib/skuNormalizacao.js) - busca os
  // produtos conhecidos pra resolver o código base de uma variante.
  if (s === 'SELECT CODIGO_SKU, NOME, CATEGORIA FROM PRODUTOS') {
    return { rows: produtos.map(p => ({ codigo_sku: p.codigo_sku, nome: p.nome, categoria: p.categoria })) };
  }
  if (s === 'SELECT CODIGO_SKU, NOME FROM PRODUTOS') {
    return { rows: produtos.map(p => ({ codigo_sku: p.codigo_sku, nome: p.nome })) };
  }

  // catalogo_precos (routes/catalogoPrecos.js) - usado pela geração em
  // lote de produtos promocionais (routes/produtosPromocionais.js).
  if (s === 'SELECT CODIGO_SKU FROM CATALOGO_PRECOS') {
    return { rows: catalogoPrecos.map(p => ({ codigo_sku: p.codigo_sku })) };
  }
  if (s.startsWith('SELECT CODIGO_SKU, NOME, EMB, IPI, FAMILIA, PRECOS_SEM_IMPOSTO FROM CATALOGO_PRECOS WHERE CODIGO_SKU')) {
    return { rows: catalogoPrecos.filter(p => p.codigo_sku === params[0]) };
  }

  // pedidos
  if (s.includes('INSERT INTO PEDIDOS')) {
    const p = { id: nextId.pedidos++, cliente_id: params[0], vendedor_id: params[1], observacao: params[2], data_pedido: new Date().toISOString() };
    pedidos.push(p);
    return { rows: [{ id: p.id, data_pedido: p.data_pedido }] };
  }
  if (s.includes('INSERT INTO PEDIDO_ITENS')) {
    pedidoItens.push({ id: nextId.pedido_itens++, pedido_id: params[0], produto_id: params[1], quantidade: params[2], preco_unitario: params[3] });
    return { rows: [] };
  }

  // levantamentos
  if (s.includes('INSERT INTO LEVANTAMENTOS')) {
    const l = { id: nextId.levantamentos++, cliente_id: params[0], vendedor_id: params[1], nome: params[2], data_visita: new Date().toISOString() };
    levantamentos.push(l);
    return { rows: [{ id: l.id, data_visita: l.data_visita }] };
  }
  if (s.includes('INSERT INTO LEVANTAMENTO_ITENS')) {
    levantamentoItens.push({ id: nextId.levantamento_itens++, levantamento_id: params[0], produto_id: params[1], quantidade_contada: params[2] });
    return { rows: [] };
  }

  // relatorios
  if (s.includes('FROM PEDIDOS PED') && s.includes('GROUP BY P.ID') && s.includes('MEDIA_DIAS_ENTRE_PEDIDOS') === false && s.includes('PRIMEIRA_COMPRA')) {
    return computeHistorico(params[0]);
  }
  if (s.includes('MEDIA_DIAS_ENTRE_PEDIDOS')) {
    return computeRotatividade(params[0]);
  }
  if (s.includes('FROM LEVANTAMENTOS L') && s.includes('LEFT JOIN VENDEDORES')) {
    return computeLevantamentosDoCliente(params[0]);
  }

  // usuarios / sessoes (login)
  if (s.includes('SELECT COUNT(*) FROM USUARIOS')) {
    return { rows: [{ count: String(usuarios.length) }] };
  }
  if (s.includes('INSERT INTO USUARIOS')) {
    // Login é só via Google (routes/auth.js) - duas variantes reais de INSERT:
    // (a) primeiro usuário do sistema, auto-admin: (nome, email, google_sub, is_admin)
    //     com "true" fixo na própria query (3 params: nome, email, sub);
    // (b) cadastro por um admin, por e-mail: (nome, email, is_admin), is_admin
    //     vem como o 3º param (boolean).
    const email = String(params[1] || '').toLowerCase();
    if (usuarios.some(u => u.email === email)) {
      const err = new Error('duplicate'); err.code = '23505'; throw err;
    }
    const ehVarianteGoogle = s.includes('GOOGLE_SUB');
    // Na variante (a), is_admin é sempre um literal (true/false) na própria
    // query, nunca um param - o código real só manda "true" (1º usuário do
    // sistema), mas scripts de teste também semeiam um 2º usuário não-admin
    // nesse mesmo formato, com "false".
    const isAdmin = ehVarianteGoogle ? s.includes('VALUES ($1, $2, $3, TRUE)') : !!params[2];
    const u = {
      id: nextId.usuarios++,
      nome: params[0],
      email,
      google_sub: ehVarianteGoogle ? params[2] : null,
      is_admin: isAdmin,
    };
    usuarios.push(u);
    return { rows: [{ id: u.id, nome: u.nome, email: u.email, is_admin: u.is_admin }] };
  }
  if (s.includes('INSERT INTO SESSOES')) {
    const dias = Number(params[2]);
    const expira = new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toISOString();
    sessoes.push({ token: params[0], usuario_id: params[1], expira_em: expira });
    return { rows: [] };
  }
  // Cobre tanto o requireAuth (middleware/auth.js, seleciona id/nome/email/is_admin)
  // quanto GET /auth/me (seleciona só nome/email/is_admin) - mesmo padrão de texto
  // SQL nos dois, campos extras não usados por um deles não atrapalham o outro.
  if (s.includes('FROM SESSOES S') && s.includes('JOIN USUARIOS U')) {
    const sessao = sessoes.find(se => se.token === params[0] && new Date(se.expira_em) > new Date());
    if (!sessao) return { rows: [] };
    const u = usuarios.find(us => us.id === sessao.usuario_id);
    return { rows: u ? [{ id: u.id, nome: u.nome, email: u.email, is_admin: u.is_admin }] : [] };
  }
  if (s.includes('DELETE FROM SESSOES')) {
    sessoes = sessoes.filter(se => se.token !== params[0]);
    return { rows: [] };
  }

  // rascunho de levantamento
  if (s.includes('INSERT INTO LEVANTAMENTO_RASCUNHOS')) {
    rascunhos[params[0]] = { rascunho: JSON.parse(params[1]), atualizado_em: new Date().toISOString() };
    return { rows: [] };
  }
  if (s.includes('SELECT RASCUNHO, ATUALIZADO_EM FROM LEVANTAMENTO_RASCUNHOS')) {
    const r = rascunhos[params[0]];
    return { rows: r ? [r] : [] };
  }
  if (s.includes('DELETE FROM LEVANTAMENTO_RASCUNHOS')) {
    delete rascunhos[params[0]];
    return { rows: [] };
  }

  // curva ABC (produtos e clientes) - lê pedidos_oficiais_itens faturados,
  // com filtro opcional de período. Na curva "por cliente" o $1 é sempre o
  // codigo_oficial (pesquisado antes, à parte); na curva geral os params são
  // só [inicio?, fim?], nessa ordem - ver routes/relatorios.js.
  if (s.includes('SELECT CODIGO_OFICIAL FROM CLIENTES WHERE ID')) {
    const cli = clientes.find(c => String(c.id) === String(params[0]));
    return { rows: cli ? [{ codigo_oficial: cli.codigo_oficial || null }] : [] };
  }
  if (s.includes('FROM PEDIDOS_OFICIAIS_ITENS POI')) {
    const porCliente = s.includes('CLIENTE_CODIGO_OFICIAL = $1');
    let idx = porCliente ? 1 : 0;
    const codigoOficial = porCliente ? params[0] : null;
    const inicio = s.includes('DATA_FATURAMENTO >=') ? params[idx++] : null;
    const fim = s.includes('DATA_FATURAMENTO <=') ? params[idx++] : null;
    const itens = pedidosOficiaisItens.filter(it =>
      it.status === 'faturado' &&
      (!porCliente || it.cliente_codigo_oficial === codigoOficial) &&
      (!inicio || it.data_faturamento >= inicio) &&
      (!fim || it.data_faturamento <= fim)
    );
    const porProduto = new Map();
    for (const it of itens) {
      const prod = produtos.find(p => p.codigo_sku === it.codigo_sku);
      const atual = porProduto.get(it.codigo_sku) || {
        codigo_sku: it.codigo_sku, produto: (prod && prod.nome) || it.codigo_sku, categoria: prod && prod.categoria,
        pedidos: new Set(), quantidade_total: 0, faturamento_total: 0,
      };
      atual.pedidos.add(it.nr_pedido);
      atual.quantidade_total += Number(it.quantidade) || 0;
      atual.faturamento_total += Number(it.valor) || 0;
      porProduto.set(it.codigo_sku, atual);
    }
    const rows = [...porProduto.values()]
      .map(r => ({ ...r, num_pedidos: r.pedidos.size, pedidos: undefined }))
      .sort((a, b) => b.faturamento_total - a.faturamento_total);
    return { rows };
  }

  // Carteira antiga (60+ dias, nunca faturado) - contagem e exclusão. O
  // corte de data é calculado aqui em JS (o mock não interpreta SQL de
  // datas de verdade), reproduzindo o mesmo filtro da query real:
  // status = 'carteira' AND data_implantacao < CURRENT_DATE - INTERVAL 'N days'.
  if (s.includes("WHERE STATUS = 'CARTEIRA' AND DATA_IMPLANTACAO <")) {
    const diasMatch = sql.match(/INTERVAL '(\d+) days'/);
    const dias = diasMatch ? Number(diasMatch[1]) : 60;
    const corte = new Date();
    corte.setDate(corte.getDate() - dias);
    const corteISO = corte.toISOString().slice(0, 10);
    const antigos = pedidosOficiaisItens.filter(it => it.status === 'carteira' && it.data_implantacao && it.data_implantacao < corteISO);
    if (s.startsWith('SELECT COUNT(*)')) {
      return { rows: [{ total: antigos.length }] };
    }
    if (s.startsWith('DELETE FROM PEDIDOS_OFICIAIS_ITENS')) {
      const antigosSet = new Set(antigos);
      pedidosOficiaisItens = pedidosOficiaisItens.filter(it => !antigosSet.has(it));
      return { rowCount: antigos.length, rows: [] };
    }
  }

  // Atendido Parcial -> Atendido Total: pedidos que perderam o último item
  // em carteira (ex: após a limpeza da carteira antiga acima) deixam de
  // aparecer como parcialmente atendidos.
  if (s.startsWith("UPDATE PEDIDOS_OFICIAIS_ITENS SET SITUACAO_PEDIDO = 'ATENDIDO TOTAL'")) {
    const nrPedidosEmCarteira = new Set(pedidosOficiaisItens.filter(it => it.status === 'carteira').map(it => it.nr_pedido));
    const nrPedidosAfetados = new Set();
    for (const it of pedidosOficiaisItens) {
      if (it.situacao_pedido === 'Atendido Parcial' && !nrPedidosEmCarteira.has(it.nr_pedido)) {
        it.situacao_pedido = 'Atendido Total';
        nrPedidosAfetados.add(it.nr_pedido);
      }
    }
    return { rowCount: nrPedidosAfetados.size, rows: [] };
  }

  // "Apagar tudo" do relatório oficial (botão preparado no admin, ver
  // routes/pedidosOficiais.js) - contagem/exclusão sem filtro nenhum.
  if (s === 'SELECT COUNT(*) AS TOTAL FROM PEDIDOS_OFICIAIS_ITENS') {
    return { rows: [{ total: pedidosOficiaisItens.length }] };
  }
  if (s === 'DELETE FROM PEDIDOS_OFICIAIS_ITENS') {
    const total = pedidosOficiaisItens.length;
    pedidosOficiaisItens = [];
    return { rowCount: total, rows: [] };
  }

  // Classificatório vindo do relatório oficial (Master/Premium/Exclusive/
  // Rede) - só sobrescreve se este relatório for mais novo que o que já
  // definiu o classificatório atual (routes/pedidosOficiais.js /importar).
  if (s.startsWith('UPDATE CLIENTES SET CLASSIFICATORIO_TIPO = $1, CLASSIFICATORIO_DESCONTO = $2')) {
    const [tipo, desconto, id, dataRef] = params;
    const c = clientes.find(x => Number(x.id) === Number(id));
    if (c && (!c.classificatorio_atualizado_em || !dataRef || c.classificatorio_atualizado_em <= dataRef)) {
      c.classificatorio_tipo = tipo;
      c.classificatorio_desconto = desconto;
      c.classificatorio_atualizado_em = dataRef || c.classificatorio_atualizado_em || new Date().toISOString().slice(0, 10);
      return { rows: [{ id: c.id }] };
    }
    return { rows: [] };
  }

  // Configurações genéricas chave/valor (routes/configuracoes.js) - usado
  // hoje por produtos_promocionais/promocoes e pela meta mensal/produtos
  // foco do Dashboard.
  if (s.includes('FROM CONFIGURACOES WHERE CHAVE')) {
    const registro = configuracoes[params[0]];
    return { rows: registro ? [{ valor: registro.valor, atualizado_em: registro.atualizado_em }] : [] };
  }
  if (s.startsWith('INSERT INTO CONFIGURACOES')) {
    const [chave, valorJson] = params;
    configuracoes[chave] = { valor: JSON.parse(valorJson), atualizado_em: new Date().toISOString() };
    return { rows: [] };
  }

  throw new Error('Mock não sabe responder a esta query: ' + sql.slice(0, 80));
}

// Ano civil fechado usado pela revisão do classificatório (ver
// PERIODO_CLASSIFICATORIO_*/comentário em routes/clientesClassificatorio.js):
// o ano anterior ao atual, inteiro (não uma janela móvel de 12 meses).
function anoClassificatorioFechado() {
  // getUTCFullYear() (não getFullYear()) - bate com o mesmo raciocínio de
  // routes/clientesClassificatorio.js (CURRENT_DATE do Postgres roda em UTC).
  return new Date().getUTCFullYear() - 1;
}

// Reproduz a query SQL_FATURAMENTO_ANO_FECHADO_POR_CLIENTE de routes/clientesClassificatorio.js -
// soma faturado no ano civil fechado mais recente, agrupado por
// matriz_grupo (ou o próprio cliente, se não tiver grupo).
function calcularFaturamentoAnoFechadoParaCliente(clienteId) {
  const cliente = clientes.find(c => Number(c.id) === Number(clienteId));
  if (!cliente) return { faturamento_12m: 0, ultima_compra: null };
  const grupo = cliente.matriz_grupo ? clientes.filter(c => c.matriz_grupo === cliente.matriz_grupo) : [cliente];
  const codigos = grupo.map(c => c.codigo_oficial).filter(Boolean);
  const itensFaturados = pedidosOficiaisItens.filter(it => codigos.includes(it.cliente_codigo_oficial) && it.status === 'faturado');
  const ano = anoClassificatorioFechado();
  const inicioStr = `${ano}-01-01`;
  const fimStr = `${ano + 1}-01-01`;
  const itensJanela = itensFaturados.filter(it => it.data_faturamento && it.data_faturamento >= inicioStr && it.data_faturamento < fimStr);
  const faturamento_12m = itensJanela.reduce((s, it) => s + (Number(it.valor) || 0), 0);
  const datas = itensFaturados.map(it => it.data_faturamento).filter(Boolean).sort();
  const ultima_compra = datas.length ? datas[datas.length - 1] : null;
  return { faturamento_12m, ultima_compra };
}

function computeHistorico(clienteId) {
  const pedidosDoCliente = pedidos.filter(p => p.cliente_id == clienteId);
  const grupos = {};
  for (const ped of pedidosDoCliente) {
    const itens = pedidoItens.filter(pi => pi.pedido_id === ped.id);
    for (const it of itens) {
      const prod = produtos.find(p => p.id === it.produto_id);
      if (!grupos[prod.id]) grupos[prod.id] = { codigo_sku: prod.codigo_sku, produto: prod.nome, datas: [], total: 0, num_pedidos: new Set() };
      grupos[prod.id].datas.push(ped.data_pedido);
      grupos[prod.id].total += Number(it.quantidade);
      grupos[prod.id].num_pedidos.add(ped.id);
    }
  }
  const rows = Object.values(grupos).map(g => ({
    codigo_sku: g.codigo_sku,
    produto: g.produto,
    primeira_compra: g.datas.sort()[0],
    ultima_compra: g.datas.sort().slice(-1)[0],
    num_pedidos: g.num_pedidos.size,
    total_acumulado: g.total,
  }));
  return { rows };
}
function computeRotatividade(clienteId) {
  const { rows } = computeHistorico(clienteId);
  return { rows: rows.map(r => ({ ...r, media_dias_entre_pedidos: r.num_pedidos > 1 ? 15 : null })) };
}
function computeLevantamentosDoCliente(clienteId) {
  const levs = levantamentos.filter(l => l.cliente_id == clienteId);
  return { rows: levs.map(l => ({ id: l.id, nome: l.nome, data_visita: l.data_visita, vendedor: null,
    num_produtos: levantamentoItens.filter(li => li.levantamento_id === l.id).length,
    total_unidades: levantamentoItens.filter(li => li.levantamento_id === l.id).reduce((a,li)=>a+Number(li.quantidade_contada),0) })) };
}

module.exports = {
  pool: { query, connect: async () => ({ query, release: () => {} }) },
  runMigrations: async () => {},
  __queryLog: queryLog,
  __reset: reset,
  __seed: seed,
  __getClientes: () => clientes,
  __anoClassificatorioFechado: anoClassificatorioFechado,
};
