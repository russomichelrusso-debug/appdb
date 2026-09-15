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
  nextId = { clientes: 1, vendedores: 1, produtos: 3, pedidos: 1, pedido_itens: 1, levantamentos: 1, levantamento_itens: 1, usuarios: 1, sessoes: 1 };
}

// Só pra teste: injeta dados diretamente no estado em memória, sem passar
// pela rota de import real (que faz UNNEST em lote) - o que importa aqui é
// testar a leitura (curva ABC), não o pipeline de importação em si.
function seed(partial) {
  if (partial.clientes) clientes.push(...partial.clientes);
  if (partial.pedidosOficiaisItens) pedidosOficiaisItens.push(...partial.pedidosOficiaisItens);
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
    const { faturamento_12m, ultima_compra } = calcularFaturamento12mParaCliente(params[0]);
    return { rows: [{ cliente_id: Number(params[0]), faturamento_12m, ultima_compra }] };
  }
  if (s.includes('SELECT C.ID AS CLIENTE_ID') && s.includes("CLASSIFICATORIO_TIPO IS NOT NULL")) {
    const classificados = clientes.filter(c => c.classificatorio_tipo);
    const rows = classificados.map(c => ({ cliente_id: c.id, ...calcularFaturamento12mParaCliente(c.id) }));
    return { rows };
  }
  if (s.includes("DATE_TRUNC('QUARTER', POI.DATA_FATURAMENTO)")) {
    const cliente = clientes.find(c => Number(c.id) === Number(params[0]));
    if (!cliente) return { rows: [] };
    const grupo = cliente.matriz_grupo ? clientes.filter(c => c.matriz_grupo === cliente.matriz_grupo) : [cliente];
    const codigos = grupo.map(c => c.codigo_oficial).filter(Boolean);
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const itens = pedidosOficiaisItens.filter(it => codigos.includes(it.cliente_codigo_oficial) && it.status === 'faturado' && it.data_faturamento && it.data_faturamento >= cutoffStr);
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
      const atual = grupos.get(key) || { periodo: key, faturamento: 0, pedidosSet: new Set() };
      atual.faturamento += Number(it.valor) || 0;
      atual.pedidosSet.add(it.nr_pedido);
      grupos.set(key, atual);
    }
    const rows = [...grupos.values()].sort((a, b) => a.periodo.localeCompare(b.periodo))
      .map(g => ({ periodo: g.periodo, faturamento: g.faturamento, pedidos: g.pedidosSet.size }));
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
    if (usuarios.some(u => u.usuario === params[1])) {
      const err = new Error('duplicate'); err.code = '23505'; throw err;
    }
    // /setup grava "VALUES ($1, $2, $3, true)" com o admin fixo na própria query
    // (só 3 params); /usuarios manda is_admin como $4 de verdade.
    const isAdmin = s.includes('VALUES ($1, $2, $3, TRUE)') ? true : !!params[3];
    const u = { id: nextId.usuarios++, nome: params[0], usuario: params[1], senha_hash: params[2], is_admin: isAdmin };
    usuarios.push(u);
    return { rows: [{ id: u.id, nome: u.nome, usuario: u.usuario, is_admin: u.is_admin }] };
  }
  if (s.includes('SELECT * FROM USUARIOS WHERE USUARIO')) {
    return { rows: usuarios.filter(u => u.usuario === params[0]) };
  }
  if (s.includes('INSERT INTO SESSOES')) {
    const dias = Number(params[2]);
    const expira = new Date(Date.now() + dias * 24 * 60 * 60 * 1000).toISOString();
    sessoes.push({ token: params[0], usuario_id: params[1], expira_em: expira });
    return { rows: [] };
  }
  if (s.includes('FROM SESSOES S') && s.includes('JOIN USUARIOS U')) {
    const sessao = sessoes.find(se => se.token === params[0] && new Date(se.expira_em) > new Date());
    if (!sessao) return { rows: [] };
    const u = usuarios.find(us => us.id === sessao.usuario_id);
    return { rows: u ? [{ id: u.id, nome: u.nome, usuario: u.usuario, is_admin: u.is_admin }] : [] };
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

  throw new Error('Mock não sabe responder a esta query: ' + sql.slice(0, 80));
}

// Reproduz a query SQL_FATURAMENTO_12M_POR_CLIENTE de routes/clientesClassificatorio.js -
// soma faturado nos últimos 12 meses, agrupado por matriz_grupo (ou o próprio
// cliente, se não tiver grupo).
function calcularFaturamento12mParaCliente(clienteId) {
  const cliente = clientes.find(c => Number(c.id) === Number(clienteId));
  if (!cliente) return { faturamento_12m: 0, ultima_compra: null };
  const grupo = cliente.matriz_grupo ? clientes.filter(c => c.matriz_grupo === cliente.matriz_grupo) : [cliente];
  const codigos = grupo.map(c => c.codigo_oficial).filter(Boolean);
  const itensFaturados = pedidosOficiaisItens.filter(it => codigos.includes(it.cliente_codigo_oficial) && it.status === 'faturado');
  const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 12);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const itensJanela = itensFaturados.filter(it => it.data_faturamento && it.data_faturamento >= cutoffStr);
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
};
