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
  nextId = { clientes: 1, vendedores: 1, produtos: 3, pedidos: 1, pedido_itens: 1, levantamentos: 1, levantamento_itens: 1, usuarios: 1, sessoes: 1 };
}

async function query(sql, params = []) {
  queryLog.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
  const s = sql.toUpperCase();

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

  throw new Error('Mock não sabe responder a esta query: ' + sql.slice(0, 80));
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
};
