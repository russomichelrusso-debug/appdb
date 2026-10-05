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
let titulosAvistaPendentes = []; // aba Pendentes à Vista (títulos em aberto)
let classificatorioErp = {}; // cliente_id -> foto financeira da planilha Classificatório (cliente_classificatorio_erp)
let pedidosPendentesPagamento = []; // aba de pedidos à vista aguardando pagamento
let pedidosOficiaisItens = []; // relatório oficial de Faturamento (curva ABC de produtos/clientes)
let configuracoes = {}; // chave -> valor (routes/configuracoes.js)
let novidades = []; // routes/lib/novidades.js
let importacoesEmail = []; // routes/importacaoEmail.js
let pedidosBloqueados = []; // pedidos_bloqueados
let previsaoEstoque = []; // previsao_estoque
let nextNovidadeId = 1;
let pushInscricoes = []; // push_inscricoes
let nextPushId = 1;
let recompraAdiamentos = []; // routes/recompra.js ("Já falei")
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
  pedidosPendentesPagamento = [];
  titulosAvistaPendentes = [];
  classificatorioErp = {};
  configuracoes = {};
  catalogoPrecos = [];
  recompraAdiamentos = [];
  novidades = [];
  importacoesEmail = [];
  pedidosBloqueados = [];
  previsaoEstoque = [];
  nextNovidadeId = 1;
  pushInscricoes = [];
  nextPushId = 1;
  nextId = { clientes: 1, vendedores: 1, produtos: 3, pedidos: 1, pedido_itens: 1, levantamentos: 1, levantamento_itens: 1, usuarios: 1, sessoes: 1 };
}

// Só pra teste: injeta dados diretamente no estado em memória, sem passar
// pela rota de import real (que faz UNNEST em lote) - o que importa aqui é
// testar a leitura (curva ABC), não o pipeline de importação em si.
function seed(partial) {
  if (partial.clientes) clientes.push(...partial.clientes);
  if (partial.pedidosOficiaisItens) pedidosOficiaisItens.push(...partial.pedidosOficiaisItens);
  if (partial.catalogoPrecos) catalogoPrecos.push(...partial.catalogoPrecos);
  if (partial.produtos) produtos.push(...partial.produtos);
  if (partial.pedidos) pedidos.push(...partial.pedidos);
  if (partial.pedidoItens) pedidoItens.push(...partial.pedidoItens);
  if (partial.levantamentos) levantamentos.push(...partial.levantamentos);
  if (partial.levantamentoItens) levantamentoItens.push(...partial.levantamentoItens);
  if (partial.fichasCnpj) Object.assign(clienteCnpjFicha, partial.fichasCnpj);
}

// Reproduz sqlBloqueioAtivo (routes/lib/pedidosBloqueados.js): menos de 30
// dias e o pedido ainda não apareceu faturado
function bloqueiosAtivos() {
  const limite = Date.now() - 30 * 86400000;
  return pedidosBloqueados.filter(b => new Date(b.recebido_em).getTime() > limite
    && !pedidosOficiaisItens.some(i => i.nr_pedido === b.nr_pedido && i.status === 'faturado'));
}

// Reproduz sqlFaturadoDeFato (routes/lib/faturadoDeFato.js): item faturado cujo
// título à vista (nota fiscal) ainda está pendente não conta no faturamento.
// sqlDiaDoPedido (routes/lib/comprasApp.js): meia-noite UTC exata = "só a data"
// (pedido de PDF/faturamento), o resto vai pro dia de Brasília
const DIA_BR = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' });
function diaDoPedidoBr(dataPedido) {
  const t = new Date(dataPedido);
  if (t.getTime() % 86400000 === 0) return t.toISOString().slice(0, 10);
  return DIA_BR.format(t);
}
function hojeBr() { return DIA_BR.format(new Date()); }
function diasAntes(iso, n) { return new Date(new Date(`${iso}T00:00:00Z`).getTime() - n * 86400000).toISOString().slice(0, 10); }

function faturadoDeFato(it) {
  return it.status === 'faturado' && !titulosAvistaPendentes.some(t => t.titulo === it.nota_fiscal);
}

async function query(sql, params = []) {
  queryLog.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
  // normaliza espaço/quebra de linha antes de comparar - as queries reais são
  // template literals multi-linha, então um substring de match precisa ficar
  // igual independente de indentação/quebra de linha.
  const s = sql.replace(/\s+/g, ' ').toUpperCase();
  if (s.includes('HEALTH:BANCO')) return { rows: [{ '?column?': 1 }], rowCount: 1 };

  if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) return { rows: [] };
  if (s.includes('CREATE TABLE')) return { rows: [] };

  // Importação por e-mail - routes/importacaoEmail.js
  if (s.includes('/* IMPORTACAO-EMAIL:BLOQUEADO */')) {
    const [nr, cod, nome, motivo, recebido] = params;
    const atual = pedidosBloqueados.find(b => b.nr_pedido === nr);
    if (atual) Object.assign(atual, { cliente_codigo_oficial: cod || atual.cliente_codigo_oficial, cliente_nome: nome || atual.cliente_nome, motivo,
      recebido_em: new Date(recebido) > new Date(atual.recebido_em) ? recebido : atual.recebido_em });
    else pedidosBloqueados.push({ nr_pedido: nr, cliente_codigo_oficial: cod, cliente_nome: nome, motivo, recebido_em: recebido });
    return { rows: [] };
  }
  if (s.includes('/* IMPORTACAO-EMAIL:BLOQUEIO-ATIVO */')) {
    return { rows: bloqueiosAtivos().filter(b => b.nr_pedido === params[0]).map(() => ({ '?column?': 1 })) };
  }
  if (s.includes('/* PEDIDOS-OFICIAIS:BLOQUEADOS */')) {
    return { rows: bloqueiosAtivos().filter(b => b.cliente_codigo_oficial === params[0]).map(b => ({ nr_pedido: b.nr_pedido, motivo: b.motivo, recebido_em: b.recebido_em })) };
  }
  if (s.includes('/* IMPORTACAO-EMAIL:CLIENTE-POR-CODIGO */')) {
    return { rows: clientes.filter(c => c.codigo_oficial === params[0]).map(c => ({ nome: c.nome })) };
  }
  if (s.includes('/* IMPORTACAO-EMAIL:RELATORIO-MAIS-NOVO */')) {
    return { rows: importacoesEmail.filter(i => i.tipo === 'relatorio' && i.status === 'ok' && i.recebido_em && new Date(i.recebido_em) > new Date(params[0])).slice(0, 1).map(() => ({ '?column?': 1 })) };
  }
  if (s.includes('/* IMPORTACAO-EMAIL:CLIENTE-DO-PEDIDO */')) {
    return { rows: pedidosOficiaisItens.filter(i => i.nr_pedido === params[0]).slice(0, 1).map(i => ({ cliente_codigo_oficial: i.cliente_codigo_oficial })) };
  }
  if (s.includes('/* IMPORTACAO-EMAIL:CODIGO-DO-CLIENTE */')) {
    return { rows: clientes.filter(c => String(c.id) === String(params[0])).map(c => ({ codigo_oficial: c.codigo_oficial || null })) };
  }
  if (s.includes('/* IMPORTACAO-EMAIL:AVISTA */')) {
    const [nr, cod, nome, valor, data] = params;
    const atual = pedidosPendentesPagamento.find(p => p.nr_pedido === nr);
    if (atual) Object.assign(atual, { cliente_codigo_oficial: cod || atual.cliente_codigo_oficial, cliente_nome: nome || atual.cliente_nome, valor });
    else pedidosPendentesPagamento.push({ nr_pedido: nr, cliente_codigo_oficial: cod, cliente_nome: nome, valor, data_implantacao: data });
    return { rows: [] };
  }
  if (s.includes('/* IMPORTACAO-EMAIL:JA-IMPORTADO */')) {
    return { rows: importacoesEmail.filter(i => i.hash === params[0] && i.status === 'ok').map(i => ({ tipo: i.tipo })) };
  }
  if (s.includes('/* IMPORTACAO-EMAIL:REGISTRAR */')) {
    const [hash, nome_arquivo, tipo, remetente, assunto, mensagem_id, recebido_em, status, erro, resultado] = params;
    const linha = { hash, nome_arquivo, tipo, remetente, assunto, mensagem_id, recebido_em, status, erro, resultado, atualizado_em: new Date() };
    const i = importacoesEmail.findIndex(x => x.hash === hash);
    if (i === -1) importacoesEmail.push(linha); else importacoesEmail[i] = linha;
    return { rows: [] };
  }
  if (s.includes('/* IMPORTACAO-EMAIL:STATUS */')) {
    const porTipo = new Map();
    for (const l of importacoesEmail) {
      if (!l.tipo) continue;
      const atual = porTipo.get(l.tipo);
      if (!atual || l.atualizado_em >= atual.atualizado_em) porTipo.set(l.tipo, l);
    }
    return { rows: [...porTipo.values()].map(l => ({ tipo: l.tipo, nome_arquivo: l.nome_arquivo, status: l.status, erro: l.erro, recebido_em: l.recebido_em, atualizado_em: l.atualizado_em })) };
  }
  // previsão de estoque (routes/previsaoEstoque.js)
  if (s.startsWith('DELETE FROM PREVISAO_ESTOQUE')) { previsaoEstoque = []; return { rows: [] }; }
  if (s.includes('INSERT INTO PREVISAO_ESTOQUE')) {
    const [cods, disp, cart, compra, prev, saldo] = params;
    cods.forEach((c, i) => previsaoEstoque.push({ codigo_sku: c, qt_disponivel: disp[i], qt_carteira: cart[i], qt_compra: compra[i], previsao: prev[i], saldo: saldo[i] }));
    return { rows: [] };
  }
  // catálogo de preços (routes/catalogoPrecos.js)
  // produto novo da Lista de Preços entra em produtos (só os que não existem)
  if (s.includes('/* CATALOGO-PRECOS:PRODUTOS-NOVOS */')) {
    let n = 0;
    params[0].forEach((c, i) => {
      if (produtos.some(p => p.codigo_sku === c)) return;
      produtos.push({ id: nextId.produtos++, codigo_sku: c, nome: (params[1][i] || '').trim() || c, categoria: params[2][i] ?? null });
      n++;
    });
    return { rows: [], rowCount: n };
  }
  // pedido/levantamento com produto que ainda não está em produtos: cria do catálogo (routes/lib/produtoPorSku.js)
  if (s.includes('/* PRODUTO:DO-CATALOGO */')) {
    const cat = catalogoPrecos.find(p => p.codigo_sku === params[0]);
    if (!cat || produtos.some(p => p.codigo_sku === params[0])) return { rows: [] };
    const novo = { id: nextId.produtos++, codigo_sku: cat.codigo_sku, nome: (cat.nome || '').trim() || cat.codigo_sku, categoria: cat.familia ?? null };
    produtos.push(novo);
    return { rows: [{ id: novo.id }] };
  }
  if (s.includes('/* CATALOGO-PRECOS:CONFERIR-REMOCAO */')) {
    return { rows: [{ total: catalogoPrecos.length, sairiam: catalogoPrecos.filter(p => !params[0].includes(p.codigo_sku)).length }] };
  }
  if (s.includes('INSERT INTO CATALOGO_PRECOS')) {
    const [cods, nomes, embs, ncms, ipis, familias, fixos, canaisFx, precos, semImposto] = params;
    cods.forEach((c, i) => {
      const linha = { codigo_sku: c, nome: nomes[i], emb: embs[i], ncm: ncms[i], ipi: ipis[i], familia: familias[i], preco_fixo: fixos[i],
        canais_fx: JSON.parse(canaisFx[i]), precos: JSON.parse(precos[i]), precos_sem_imposto: JSON.parse(semImposto[i]) };
      const j = catalogoPrecos.findIndex(p => p.codigo_sku === c);
      if (j === -1) catalogoPrecos.push(linha); else catalogoPrecos[j] = linha;
    });
    return { rows: [] };
  }
  if (s.startsWith('DELETE FROM CATALOGO_PRECOS WHERE CODIGO_SKU <> ALL')) {
    const removidos = catalogoPrecos.filter(p => !params[0].includes(p.codigo_sku));
    catalogoPrecos = catalogoPrecos.filter(p => params[0].includes(p.codigo_sku));
    return { rows: removidos.map(p => ({ codigo_sku: p.codigo_sku })), rowCount: removidos.length };
  }

  // Novidades / avisos no celular - routes/lib/novidades.js e routes/novidades.js
  if (s.includes('/* NOVIDADES:RECENTE */')) {
    const limite = Date.now() - Number(params[1]) * 60000;
    const n = novidades.filter(x => x.tipo === params[0] && x.atualizado_em.getTime() > limite)
      .sort((a, b) => b.atualizado_em - a.atualizado_em)[0];
    return { rows: n ? [{ id: n.id }] : [] };
  }
  if (s.includes('/* NOVIDADES:ATUALIZAR */')) {
    const n = novidades.find(x => x.id === params[0]);
    if (n) Object.assign(n, { texto: params[1], atualizado_em: new Date(), push_pendente: true, push_enviar_em: new Date(params[2]) });
    return { rows: [], rowCount: n ? 1 : 0 };
  }
  if (s.includes('/* NOVIDADES:INSERIR */')) {
    const agora = new Date();
    const n = { id: nextNovidadeId++, tipo: params[0], titulo: params[1], texto: params[2], criado_em: agora, atualizado_em: agora,
      push_enviar_em: new Date(params[3]), push_pendente: true, push_enviado_em: null };
    novidades.push(n);
    return { rows: [{ id: n.id }] };
  }
  if (s.includes('/* NOVIDADES:SUBSTITUIR-PENDENTES */')) {
    let n = 0;
    novidades.forEach(x => { if (x.tipo === params[0] && x.push_pendente && x.id !== params[1]) { x.push_pendente = false; n++; } });
    return { rows: [], rowCount: n };
  }
  if (s.includes('/* NOVIDADES:RESERVAR-PUSH */')) {
    const agora = new Date();
    const prontas = novidades.filter(n => n.push_pendente && n.push_enviar_em <= agora);
    prontas.forEach(n => { n.push_pendente = false; n.push_enviado_em = agora; });
    return { rows: prontas.map(n => ({ id: n.id, tipo: n.tipo, titulo: n.titulo, texto: n.texto })) };
  }
  if (s.includes('/* NOVIDADES:LISTA */')) {
    const limite = Date.now() - Number(params[0]) * 86400000;
    return { rows: novidades.filter(n => n.atualizado_em.getTime() > limite)
      .sort((a, b) => b.atualizado_em - a.atualizado_em).slice(0, Number(params[1]))
      .map(n => ({ id: n.id, tipo: n.tipo, titulo: n.titulo, texto: n.texto, criado_em: n.criado_em, atualizado_em: n.atualizado_em })) };
  }
  if (s.includes('/* NOVIDADES:VISTAS */')) {
    const u = usuarios.find(x => x.id === params[0]);
    return { rows: u ? [{ novidades_vistas_ate: u.novidades_vistas_ate || null }] : [] };
  }
  if (s.includes('/* NOVIDADES:MARCAR-VISTAS */')) {
    const u = usuarios.find(x => x.id === params[0]);
    if (!u) return { rows: [] };
    const nova = new Date(params[1]);
    if (!u.novidades_vistas_ate || nova > u.novidades_vistas_ate) u.novidades_vistas_ate = nova;
    return { rows: [{ novidades_vistas_ate: u.novidades_vistas_ate }] };
  }
  if (s.includes('/* NOVIDADES:PEDIDOS-ATE */')) {
    const datas = pedidosOficiaisItens.map(it => it.data_implantacao).filter(Boolean).map(d => String(d).slice(0, 10)).sort();
    return { rows: [{ ate: datas.length ? datas[datas.length - 1] : null }] };
  }
  if (s.includes('/* PUSH:INSCREVER */')) {
    const atual = pushInscricoes.find(i => i.endpoint === params[1]);
    if (atual) Object.assign(atual, { usuario_id: params[0], p256dh: params[2], auth: params[3] });
    else pushInscricoes.push({ id: nextPushId++, usuario_id: params[0], endpoint: params[1], p256dh: params[2], auth: params[3] });
    return { rows: [] };
  }
  if (s.includes('/* PUSH:CANCELAR */')) {
    const antes = pushInscricoes.length;
    pushInscricoes = pushInscricoes.filter(i => !(i.endpoint === params[0] && i.usuario_id === params[1]));
    return { rows: [], rowCount: antes - pushInscricoes.length };
  }
  if (s.includes('/* PUSH:INSCRICOES-USUARIO */')) {
    return { rows: pushInscricoes.filter(i => i.usuario_id === params[0]) };
  }
  if (s.includes('/* PUSH:INSCRICOES */')) {
    return { rows: pushInscricoes.slice() };
  }
  if (s.includes('/* PUSH:ENVIADO */')) {
    const i = pushInscricoes.find(x => x.id === params[0]);
    if (i) i.ultimo_envio_em = new Date();
    return { rows: [] };
  }
  if (s.includes('/* PUSH:APAGAR */')) {
    pushInscricoes = pushInscricoes.filter(i => i.id !== params[0]);
    return { rows: [] };
  }

  // GET /api/pedidos/salvos (routes/pedidos.js) - pedidos do app do próprio
  // usuário, com os itens e os dados do cliente, mais recente primeiro
  if (s.includes("WHERE PED.ORIGEM = 'APP' AND PED.USUARIO_ID = $1")) {
    const limite = Date.now() - params[1] * 86400000;
    const quando = (p) => new Date(p.atualizado_em || p.data_pedido).getTime();
    return { rows: pedidos
      .filter(p => p.origem === 'app' && p.usuario_id === params[0] && quando(p) >= limite)
      .sort((a, b) => quando(b) - quando(a))
      .slice(0, params[2])
      .map(p => {
        const c = clientes.find(x => String(x.id) === String(p.cliente_id)) || {};
        return {
          id: p.id, data_pedido: p.data_pedido, atualizado_em: p.atualizado_em || null, id_envio: p.id_envio || null,
          contexto: p.contexto ? JSON.parse(p.contexto) : null,
          cliente_id: c.id, cliente_nome: c.nome, cliente_documento: c.documento || null,
          classificatorio_tipo: c.classificatorio_tipo || null, classificatorio_desconto: c.classificatorio_desconto ?? null,
          codigo_oficial: c.codigo_oficial || null,
          itens: pedidoItens.filter(i => String(i.pedido_id) === String(p.id)).map(i => ({
            codigo_sku: (produtos.find(pr => pr.id === i.produto_id) || {}).codigo_sku,
            quantidade: i.quantidade, preco_unitario: i.preco_unitario,
          })),
        };
      })
      .filter(p => p.itens.length > 0) };
  }
  // PATCH /api/pedidos/:id: pedido travado pra edição...
  if (s.includes('SELECT ID, CLIENTE_ID, ORIGEM, USUARIO_ID, DATA_PEDIDO, ATUALIZADO_EM, VERSAO_APP, CONTEXTO FROM PEDIDOS WHERE ID = $1 FOR UPDATE')) {
    return { rows: pedidos.filter(p => String(p.id) === String(params[0]))
      .map(p => ({ id: p.id, cliente_id: p.cliente_id, origem: p.origem, usuario_id: p.usuario_id, data_pedido: p.data_pedido, atualizado_em: p.atualizado_em || null, versao_app: p.versao_app || null, contexto: p.contexto ? JSON.parse(p.contexto) : null })) };
  }
  // itens do pedido com o código (POST com o mesmo id_envio: os itens mudaram?)
  if (s.includes('/* ITENS-DO-PEDIDO */')) {
    return { rows: pedidoItens.filter(i => String(i.pedido_id) === String(params[0])).map(i => {
      const prod = produtos.find(p => p.id === i.produto_id);
      return { codigo_sku: prod ? prod.codigo_sku : null, quantidade: i.quantidade, preco_unitario: i.preco_unitario };
    }) };
  }
  // reenvio com os mesmos itens: a versão gravada só sobe (GREATEST ignora NULL)
  if (s.includes('/* VERSAO-APP */')) {
    const p = pedidos.find(x => String(x.id) === String(params[1]));
    if (p && (!p.versao_app || new Date(params[0]) > new Date(p.versao_app))) p.versao_app = new Date(params[0]).toISOString();
    return { rows: [] };
  }
  // POST com o mesmo id_envio e itens novos: cabeçalho da alteração
  if (s.includes('UPDATE PEDIDOS SET CONTEXTO = $1::JSONB, ATUALIZADO_EM = COALESCE($2::TIMESTAMPTZ, NOW())')) {
    const p = pedidos.find(x => String(x.id) === String(params[4]));
    if (!p) return { rows: [] };
    p.contexto = params[0];
    p.atualizado_em = params[1] ? new Date(params[1]).toISOString() : new Date().toISOString();
    if (params[2] != null) p.vendedor_id = params[2];
    if (params[3]) p.versao_app = params[3];
    return { rows: [] };
  }
  // ...e a atualização do cabeçalho (itens são trocados pelo DELETE/INSERT de pedido_itens)
  if (s.includes('UPDATE PEDIDOS SET CONTEXTO = $1::JSONB, ATUALIZADO_EM = COALESCE($5::TIMESTAMPTZ, NOW())')) {
    const p = pedidos.find(x => String(x.id) === String(params[3]));
    if (!p) return { rows: [] };
    p.contexto = params[0];
    p.atualizado_em = params[4] ? new Date(params[4]).toISOString() : new Date().toISOString();
    if (params[1] != null) p.vendedor_id = params[1];
    if (params[2] != null) p.observacao = params[2];
    if (params[5]) p.versao_app = params[5];
    return { rows: [{ id: p.id, cliente_id: p.cliente_id, data_pedido: p.data_pedido, atualizado_em: p.atualizado_em }] };
  }

  // Pedidos à vista aguardando pagamento (routes/pedidosOficiais.js) - no
  // topo porque os casos genéricos de INSERT INTO PEDIDOS / FROM
  // PEDIDOS_OFICIAIS_ITENS POI mais abaixo também casariam com estes SQLs.
  if (s.startsWith('DELETE FROM TITULOS_AVISTA_PENDENTES')) {
    titulosAvistaPendentes = [];
    return { rows: [] };
  }
  if (s.startsWith('INSERT INTO TITULOS_AVISTA_PENDENTES')) {
    const [tits, parcs, clis, nomes, vencs, valores] = params;
    tits.forEach((t, i) => titulosAvistaPendentes.push({
      titulo: t, parcela: parcs[i], cliente_codigo_oficial: clis[i], cliente_nome: nomes[i], vencimento: vencs[i], valor: valores[i],
    }));
    return { rows: [] };
  }
  if (s.includes('FROM TITULOS_AVISTA_PENDENTES TAP')) {
    const cod = params[0];
    return { rows: titulosAvistaPendentes
      .filter(t => t.cliente_codigo_oficial === cod
        || pedidosOficiaisItens.some(it => it.nota_fiscal === t.titulo && it.cliente_codigo_oficial === cod))
      .map(t => ({ titulo: t.titulo, parcela: t.parcela, vencimento: t.vencimento, valor: t.valor })) };
  }
  if (s.startsWith('DELETE FROM PEDIDOS_PENDENTES_PAGAMENTO')) {
    pedidosPendentesPagamento = [];
    return { rows: [] };
  }
  if (s.startsWith('INSERT INTO PEDIDOS_PENDENTES_PAGAMENTO')) {
    const [nrs, clis, nomes, valores, datas] = params;
    nrs.forEach((nr, i) => pedidosPendentesPagamento.push({
      nr_pedido: nr, cliente_codigo_oficial: clis[i], cliente_nome: nomes[i], valor: valores[i], data_implantacao: datas[i],
    }));
    return { rows: [] };
  }
  if (s.includes('FROM PEDIDOS_PENDENTES_PAGAMENTO PPP')) {
    const cod = params[0];
    return { rows: pedidosPendentesPagamento
      .filter(p => p.cliente_codigo_oficial === cod
        || pedidosOficiaisItens.some(it => it.nr_pedido === p.nr_pedido && it.cliente_codigo_oficial === cod))
      .map(p => ({ nr_pedido: p.nr_pedido, valor: p.valor, data_implantacao: p.data_implantacao })) };
  }
  // Pedidos oficiais de um cliente (GET /api/pedidos-oficiais/:clienteId).
  if (s.includes('COALESCE(PR.NOME, POI.DESCRICAO) AS PRODUTO, POI.QUANTIDADE')) {
    return { rows: pedidosOficiaisItens
      .filter(it => it.cliente_codigo_oficial === params[0])
      .map(it => {
        const prod = produtos.find(p => p.codigo_sku === it.codigo_sku);
        return { ...it, produto: prod ? prod.nome : (it.descricao || null) };
      }) };
  }


  // Sugestões de recompra (routes/relatorios.js) - última compra por SKU no
  // faturado oficial e nos pedidos do app.
  // sugestões de recompra: uma linha por (SKU, pedido); o app sem as cópias
  // da importação antiga de faturamento (origem 'faturamento')
  if (s.includes('/* SUGESTOES-RECOMPRA:OFICIAL */')) {
    const vistos = new Set(), rows = [];
    for (const it of pedidosOficiaisItens) {
      if (it.status !== 'faturado' || it.cliente_codigo_oficial !== params[0] || !it.data_faturamento) continue;
      const k = `${it.codigo_sku}|${it.data_faturamento}|${it.nr_pedido}`;
      if (!vistos.has(k)) { vistos.add(k); rows.push({ codigo_sku: it.codigo_sku, data: it.data_faturamento, pedido: it.nr_pedido }); }
    }
    return { rows };
  }
  if (s.includes('/* SUGESTOES-RECOMPRA:APP */')) {
    const rows = [];
    for (const ped of pedidos.filter(p => String(p.cliente_id) === String(params[0]) && p.origem !== 'faturamento')) {
      for (const it of pedidoItens.filter(i => i.pedido_id === ped.id)) {
        const prod = produtos.find(p => p.id === it.produto_id);
        if (prod) rows.push({ codigo_sku: prod.codigo_sku, data: diaDoPedidoBr(ped.data_pedido), pedido: 'app' + ped.id });
      }
    }
    return { rows };
  }

  // comprasDoCliente (routes/relatorios.js) - Histórico, Rotatividade,
  // Recuperar e consumo estimado: faturado oficial + app, sem corte de data.
  if (s.includes('/* COMPRAS-CLIENTE:OFICIAL */')) {
    return { rows: pedidosOficiaisItens
      .filter(it => it.status === 'faturado' && it.cliente_codigo_oficial === params[0] && it.data_faturamento)
      .map(it => ({ codigo_sku: it.codigo_sku, data: it.data_faturamento, quantidade: it.quantidade, pedido: it.nr_pedido, descricao: it.descricao || null })) };
  }
  if (s.includes('/* COMPRAS-CLIENTE:APP */')) {
    const rows = [];
    for (const ped of pedidos.filter(p => String(p.cliente_id) === String(params[0]) && p.origem !== 'faturamento')) {
      for (const it of pedidoItens.filter(i => i.pedido_id === ped.id)) {
        const prod = produtos.find(p => p.id === it.produto_id);
        if (prod) rows.push({ codigo_sku: prod.codigo_sku, data: diaDoPedidoBr(ped.data_pedido), quantidade: it.quantidade, pedido: 'app' + ped.id });
      }
    }
    return { rows };
  }
  // /clientes/:id/recuperar - leitura mais recente de cada produto no levantamento
  if (s.includes('SELECT DISTINCT ON (LI.PRODUTO_ID) P.CODIGO_SKU, LI.QUANTIDADE_CONTADA, L.DATA_VISITA')) {
    const porProduto = new Map();
    for (const l of levantamentos.filter(l => String(l.cliente_id) === String(params[0]))) {
      for (const li of levantamentoItens.filter(i => i.levantamento_id === l.id)) {
        const atual = porProduto.get(li.produto_id);
        if (!atual || new Date(l.data_visita) > new Date(atual.data_visita)) {
          const prod = produtos.find(p => p.id === li.produto_id);
          if (prod) porProduto.set(li.produto_id, { codigo_sku: prod.codigo_sku, quantidade_contada: li.quantidade_contada, data_visita: l.data_visita });
        }
      }
    }
    return { rows: [...porProduto.values()] };
  }
  // /clientes/:id/consumo-estimado/:produtoId - leituras do produto em ordem
  if (s.includes('SELECT L.DATA_VISITA, LI.QUANTIDADE_CONTADA') && s.includes('ORDER BY L.DATA_VISITA ASC')) {
    const rows = [];
    for (const l of levantamentos.filter(l => String(l.cliente_id) === String(params[0]))) {
      for (const li of levantamentoItens.filter(i => i.levantamento_id === l.id && String(i.produto_id) === String(params[1]))) {
        rows.push({ data_visita: l.data_visita, quantidade_contada: li.quantidade_contada });
      }
    }
    return { rows: rows.sort((a, b) => new Date(a.data_visita) - new Date(b.data_visita)) };
  }
  if (s.includes('SELECT 1 FROM LEVANTAMENTOS WHERE CLIENTE_ID = $1')) {
    return { rows: levantamentos.some(l => String(l.cliente_id) === String(params[0])) ? [{ '?column?': 1 }] : [] };
  }
  if (s.includes('SELECT CODIGO_SKU FROM PRODUTOS WHERE ID = $1')) {
    return { rows: produtos.filter(p => String(p.id) === String(params[0])).map(p => ({ codigo_sku: p.codigo_sku })) };
  }

  // Recompra da semana - routes/recompra.js
  if (s.includes('/* RECOMPRA:CLIENTES */')) {
    return { rows: clientes.map(c => ({ id: c.id, nome: c.nome, documento: c.documento, codigo_oficial: c.codigo_oficial || null, classificatorio_tipo: c.classificatorio_tipo || null })) };
  }
  if (s.includes('/* RECOMPRA:OFICIAL */')) {
    const inicio = new Date(`${params[0]}T00:00:00Z`).getTime() - Number(params[1]) * 86400000;
    return { rows: pedidosOficiaisItens
      .map(it => ({ it, data: it.data_implantacao || it.data_faturamento }))
      .filter(({ it, data }) => data && new Date(`${String(data).slice(0, 10)}T00:00:00Z`).getTime() > inicio && String(it.nr_pedido).length <= 6)
      .map(({ it, data }) => ({ cliente_codigo_oficial: it.cliente_codigo_oficial, codigo_sku: it.codigo_sku, quantidade: it.quantidade, data, data_faturamento: it.data_faturamento || null })) };
  }
  if (s.includes('/* RECOMPRA:APP */')) {
    const inicio = diasAntes(params[0], Number(params[1]));
    const rows = [];
    for (const ped of pedidos.filter(p => p.cliente_id != null && diaDoPedidoBr(p.data_pedido) > inicio && p.origem !== 'faturamento')) {
      for (const it of pedidoItens.filter(i => i.pedido_id === ped.id)) {
        const prod = produtos.find(p => p.id === it.produto_id);
        if (prod) rows.push({ cliente_id: ped.cliente_id, codigo_sku: prod.codigo_sku, quantidade: it.quantidade, data: diaDoPedidoBr(ped.data_pedido) });
      }
    }
    return { rows };
  }
  if (s.includes('/* RECOMPRA:ADIAMENTOS */')) {
    return { rows: recompraAdiamentos.filter(a => a.ate >= params[0]).map(a => ({ cliente_id: a.cliente_id, ate: a.ate })) };
  }
  if (s.includes('/* RECOMPRA:DADOS-ATE */')) {
    const datas = pedidosOficiaisItens.map(it => it.data_implantacao).filter(Boolean).map(d => String(d).slice(0, 10)).sort();
    return { rows: [{ ate: datas.length ? datas[datas.length - 1] : null }] };
  }
  if (s.includes('/* RECOMPRA:ADIAR */')) {
    const [clienteId, ate, usuarioId] = params;
    const atual = recompraAdiamentos.find(a => String(a.cliente_id) === String(clienteId));
    if (atual) { atual.ate = atual.ate > ate ? atual.ate : ate; atual.usuario_id = usuarioId; return { rows: [{ ate: atual.ate }] }; }
    recompraAdiamentos.push({ cliente_id: Number(clienteId), ate, usuario_id: usuarioId });
    return { rows: [{ ate }] };
  }
  if (s.startsWith('SELECT ID FROM CLIENTES WHERE ID = $1')) {
    return { rows: clientes.filter(c => String(c.id) === String(params[0])).map(c => ({ id: c.id })) };
  }

  if (s.includes('/* COMPRADOS-RECENTES:OFICIAL */')) {
    const limite = diasAntes(hojeBr(), Number(params[1]));
    return { rows: pedidosOficiaisItens
      .filter(it => it.status === 'faturado' && it.cliente_codigo_oficial === params[0] && it.data_faturamento && String(it.data_faturamento).slice(0, 10) > limite)
      .map(it => ({ codigo_sku: it.codigo_sku, data: it.data_faturamento, quantidade: it.quantidade, pedido: it.nr_pedido })) };
  }
  if (s.includes('/* COMPRADOS-RECENTES:APP */')) {
    const limite = diasAntes(hojeBr(), Number(params[1]));
    const rows = [];
    for (const ped of pedidos.filter(p => String(p.cliente_id) === String(params[0]) && diaDoPedidoBr(p.data_pedido) > limite && p.origem !== 'faturamento')) {
      for (const it of pedidoItens.filter(i => i.pedido_id === ped.id)) {
        const prod = produtos.find(p => p.id === it.produto_id);
        if (prod) rows.push({ codigo_sku: prod.codigo_sku, data: diaDoPedidoBr(ped.data_pedido), quantidade: it.quantidade, pedido: 'app' + ped.id });
      }
    }
    return { rows };
  }

  // GET /api/produtos/:codigo/clientes ("Já compraram" / "Levantamento" da
  // aba Produtos) - routes/relatorios.js.
  if (s.includes('SELECT ID, CODIGO_SKU, NOME FROM PRODUTOS WHERE CODIGO_SKU = $1')) {
    return { rows: produtos.filter(p => p.codigo_sku === params[0]).map(p => ({ id: p.id, codigo_sku: p.codigo_sku, nome: p.nome })) };
  }
  if (s.includes('/* PRODUTO-COMPRADORES:OFICIAL */')) {
    const rows = [];
    for (const it of pedidosOficiaisItens) {
      if (it.status !== 'faturado' || !it.data_faturamento || !params[0].includes(it.codigo_sku)) continue;
      const c = clientes.find(cl => cl.codigo_oficial === it.cliente_codigo_oficial);
      if (c) rows.push({ id: c.id, nome: c.nome, documento: c.documento, quantidade: it.quantidade, data: it.data_faturamento, nota_fiscal: it.nota_fiscal || null });
    }
    return { rows };
  }
  if (s.includes('/* PRODUTO-COMPRADORES:APP */')) {
    const rows = [];
    for (const it of pedidoItens) {
      const prod = produtos.find(p => p.id === it.produto_id);
      const ped = pedidos.find(p => p.id === it.pedido_id && p.origem !== 'faturamento');
      const c = ped && clientes.find(cl => String(cl.id) === String(ped.cliente_id));
      if (prod && c && params[0].includes(prod.codigo_sku)) {
        rows.push({ id: c.id, nome: c.nome, documento: c.documento, quantidade: it.quantidade, data: diaDoPedidoBr(ped.data_pedido) });
      }
    }
    return { rows };
  }
  if (s.includes('SELECT DISTINCT ON (C.ID) C.ID, C.NOME, C.DOCUMENTO, LI.QUANTIDADE_CONTADA')) {
    return { rows: [] };
  }

  // clientes
  if (s.includes('SELECT ID FROM CLIENTES WHERE DOCUMENTO')) {
    const found = clientes.filter(c => c.documento === params[0]);
    return { rows: found };
  }
  if (s.includes('SELECT * FROM CLIENTES WHERE DOCUMENTO')) {
    const found = clientes.filter(c => c.documento === params[0]);
    return { rows: found };
  }
  // routes/clientes.js POST / (B5) - compara documento normalizado (só
  // dígitos), pra "12345678000199" e "12.345.678/0001-99" baterem no mesmo cliente.
  if (s.includes("SELECT * FROM CLIENTES WHERE REGEXP_REPLACE(DOCUMENTO")) {
    const alvo = String(params[0] || '').replace(/\D/g, '');
    const found = clientes.filter(c => (c.documento || '').replace(/\D/g, '') === alvo && alvo !== '');
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
  if (s.includes('SELECT ID, NOME, DOCUMENTO, CONTATO, CLASSIFICATORIO_TIPO, CLASSIFICATORIO_DESCONTO')) {
    const busca = params[0] ? params[0].replace(/%/g, '').toUpperCase() : null;
    const found = busca
      ? clientes.filter(c => c.nome.toUpperCase().includes(busca) || (c.documento || '').toUpperCase().includes(busca))
      : clientes;
    return { rows: found.map(c => ({ classificatorio_tipo: null, classificatorio_desconto: null, ...c })) };
  }
  if (s.includes('SELECT * FROM CLIENTES WHERE ID')) {
    return { rows: clientes.filter(c => c.id == params[0]) };
  }
  if (s === 'SELECT MATRIZ_GRUPO FROM CLIENTES WHERE ID = $1') {
    const c = clientes.find(x => x.id == params[0]);
    return { rows: c ? [{ matriz_grupo: c.matriz_grupo || null }] : [] };
  }
  if (s.startsWith('UPDATE CLIENTES SET MATRIZ_GRUPO')) {
    const [matrizGrupo, id] = params;
    const c = clientes.find(x => Number(x.id) === Number(id));
    if (c) c.matriz_grupo = matrizGrupo;
    return { rows: c ? [{ nome: c.nome }] : [] };
  }
  if (s.includes('AS BLOQUEADOS FROM CLIENTES C')) {
    const regime = (brutos) => {
      if (!brutos) return null;
      if (brutos.mei && brutos.mei.optante === true) return 'mei';
      if (brutos.simples && brutos.simples.optante === true) return 'simples';
      if (brutos.simples && brutos.simples.optante === false) return 'normal';
      return null;
    };
    return { rows: clientes.map(c => ({
      id: c.id, nome: c.nome, documento: c.documento, codigo_oficial: c.codigo_oficial || null,
      nome_arquivo: c.nome_arquivo || null, nome_arquivo_em: c.nome_arquivo_em || null,
      regime_tributario: regime(clienteCnpjFicha[c.id] && clienteCnpjFicha[c.id].dados_brutos),
      bloqueados: (() => {
        const l = bloqueiosAtivos().filter(b => c.codigo_oficial && b.cliente_codigo_oficial === c.codigo_oficial)
          .map(b => ({ nr_pedido: b.nr_pedido, motivo: b.motivo, recebido_em: b.recebido_em }));
        return l.length ? l : null;
      })(),
    })) };
  }
  if (s.includes('FROM CLIENTES WHERE ID = ANY')) {
    const ids = params[0].map(Number);
    return { rows: clientes.filter(c => ids.includes(Number(c.id))) };
  }
  if (s.includes('UPDATE PEDIDOS SET CLIENTE_ID') && !s.includes('VENDEDOR_ID = $2')) {
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
    const [codigoOficial, matrizGrupo, pic, vlAcordo, classifTipo, classifDesconto, id, dataRelatorio] = params;
    const c = clientes.find(x => Number(x.id) === Number(id));
    if (c) {
      if (!c.codigo_oficial) c.codigo_oficial = codigoOficial;
      if (matrizGrupo) c.matriz_grupo = matrizGrupo;
      c.classificatorio_pic = pic;
      if (vlAcordo != null) c.classificatorio_vl_acordo = vlAcordo;
      // Relatório datado tão ou mais novo que o classificatório atual troca a
      // faixa; sem data, só preenche quem não tem (comportamento antigo).
      const trocar = classifTipo && dataRelatorio
        && (!c.classificatorio_atualizado_em || String(c.classificatorio_atualizado_em) <= dataRelatorio);
      if (trocar) {
        c.classificatorio_tipo = classifTipo;
        c.classificatorio_desconto = classifDesconto;
        c.classificatorio_atualizado_em = dataRelatorio;
      } else {
        if (!c.classificatorio_tipo) c.classificatorio_tipo = classifTipo;
        if (!c.classificatorio_desconto) c.classificatorio_desconto = classifDesconto;
      }
    }
    return { rows: [] };
  }
  if (s.startsWith('INSERT INTO CLIENTE_CLASSIFICATORIO_ERP')) {
    const [clienteId, dataRelatorio, apuradoAte, fatAnoAnterior, fatAcumulado, fat12mCliente, fat12mMatriz,
      diferenca, gestor, situacao, cidade, uf, clienteDesde, ultimaCompra] = params;
    const atual = classificatorioErp[clienteId];
    if (!atual || atual.data_relatorio <= dataRelatorio) {
      classificatorioErp[clienteId] = {
        data_relatorio: dataRelatorio, apurado_ate: apuradoAte, fat_ano_anterior: fatAnoAnterior, fat_acumulado: fatAcumulado,
        fat_12m_cliente: fat12mCliente, fat_12m_matriz: fat12mMatriz, diferenca, gestor, situacao, cidade, uf,
        cliente_desde: clienteDesde, ultima_compra: ultimaCompra,
      };
    }
    return { rows: [] };
  }
  // Conciliação ERP × app do status individual (vendas depois da apuração /
  // que o ERP ainda conta e o app já tirou da janela de 12 meses)
  if (s.includes('AS DEPOIS_12M')) {
    const [id, apuradoAte] = params;
    const cliente = clientes.find(c => Number(c.id) === Number(id));
    const ehRede = s.includes("JOIN CLIENTES C2 ON C2.ID = C.ID JOIN");
    const grupo = !cliente ? [] : (!ehRede && cliente.matriz_grupo ? clientes.filter(c => c.matriz_grupo === cliente.matriz_grupo) : [cliente]);
    const codigos = grupo.map(c => c.codigo_oficial).filter(Boolean);
    const itens = pedidosOficiaisItens.filter(it => codigos.includes(it.cliente_codigo_oficial) && faturadoDeFato(it) && it.data_faturamento);
    const iso = d => d.toISOString().slice(0, 10);
    const ap = new Date(apuradoAte + 'T00:00:00Z');
    const inicioErp = iso(new Date(Date.UTC(ap.getUTCFullYear() - 1, ap.getUTCMonth(), ap.getUTCDate() + 1)));
    const janela = inicioJanela12m();
    const hoje = iso(new Date());
    const inicioAno = `${hoje.slice(0, 4)}-01-01`;
    const soma = f => itens.filter(f).reduce((acc, it) => acc + (Number(it.valor) || 0), 0);
    const dJanela = new Date(janela + 'T00:00:00Z'); dJanela.setUTCDate(dJanela.getUTCDate() + 1);
    return { rows: [{
      depois_12m: String(soma(it => it.data_faturamento > apuradoAte && it.data_faturamento > janela)),
      fora_janela_app: String(soma(it => it.data_faturamento >= inicioErp && it.data_faturamento <= janela)),
      depois_ano: String(soma(it => it.data_faturamento > apuradoAte && it.data_faturamento >= inicioAno)),
      inicio_erp: inicioErp, inicio_app: iso(dJanela), fim_fora_janela_app: janela, hoje,
      mesmo_ano: apuradoAte.slice(0, 4) === hoje.slice(0, 4),
    }] };
  }
  // Alertas em lote: foto do ERP + parte da matriz que vem de empresas fora do app
  if (s.includes('AS FAT_12M_OUTRAS_EMPRESAS')) {
    const rows = clientes.filter(c => c.classificatorio_tipo && classificatorioErp[c.id]).map(c => {
      const e = classificatorioErp[c.id];
      const soma = clientes
        .filter(c2 => Number(c2.id) === Number(c.id) || (c.matriz_grupo && c2.matriz_grupo === c.matriz_grupo))
        .map(c2 => classificatorioErp[c2.id])
        .filter(e2 => e2 && e2.data_relatorio === e.data_relatorio)
        .reduce((acc, e2) => acc + (Number(e2.fat_12m_cliente) || 0), 0);
      return { cliente_id: c.id, fat_12m_matriz: String(e.fat_12m_matriz), diferenca: e.diferenca == null ? null : String(e.diferenca),
        fat_12m_outras_empresas: String((Number(e.fat_12m_matriz) || 0) - soma) };
    });
    return { rows };
  }
  if (s.includes('SUM(E.FAT_12M_CLIENTE)')) {
    const [id, dataRelatorio, matrizGrupo] = params;
    const soma = clientes
      .filter(c => Number(c.id) === Number(id) || (matrizGrupo && c.matriz_grupo === matrizGrupo))
      .map(c => classificatorioErp[c.id])
      .filter(e => e && e.data_relatorio === dataRelatorio)
      .reduce((acc, e) => acc + (Number(e.fat_12m_cliente) || 0), 0);
    return { rows: [{ soma: String(soma) }] };
  }
  if (s.includes('FROM CLIENTE_CLASSIFICATORIO_ERP WHERE CLIENTE_ID = $1')) {
    const linha = classificatorioErp[Number(params[0])];
    // NUMERIC chega do pg como texto
    const txt = v => (v == null ? null : String(v));
    return { rows: linha ? [{
      ...linha,
      fat_ano_anterior: txt(linha.fat_ano_anterior), fat_acumulado: txt(linha.fat_acumulado),
      fat_12m_cliente: txt(linha.fat_12m_cliente), fat_12m_matriz: txt(linha.fat_12m_matriz), diferenca: txt(linha.diferenca),
    }] : [] };
  }
  if (s.includes('SELECT C.ID AS CLIENTE_ID') && s.includes('WHERE C.ID = $1')) {
    const clienteDoStatus = clientes.find(c => Number(c.id) === Number(params[0]));
    const agruparPorMatrizGrupo = !clienteDoStatus || clienteDoStatus.classificatorio_tipo !== 'Rede';
    const { faturamento_12m, faturamento_ano_corrente, faturamento_mesmo_periodo_ano_anterior, ultima_compra } = calcularFaturamentoAnoFechadoParaCliente(params[0], agruparPorMatrizGrupo);
    // A rota real envolve essa subconsulta num SELECT externo que também pede
    // EXTRACT(YEAR FROM ...) AS ano_fechado/ano_atual/trimestre_atual_idx -
    // inclui aqui pra bater com isso.
    return { rows: [{
      cliente_id: Number(params[0]), faturamento_12m, faturamento_ano_corrente, faturamento_mesmo_periodo_ano_anterior, ultima_compra,
      ano_fechado: anoClassificatorioFechado(), ano_atual: anoAtual(), trimestre_atual_idx: trimestreAtualIdxAgora(),
    }] };
  }
  // Ano/trimestre atual "de verdade" (não o ano fechado da faixa) - usado
  // pela rota de alertas em lote pra alimentar calcularRitmoTrimestral de
  // cada cliente com a mesma referência que a rota individual usa.
  if (s === 'SELECT EXTRACT(YEAR FROM CURRENT_DATE)::INT AS ANO_ATUAL, EXTRACT(QUARTER FROM CURRENT_DATE)::INT - 1 AS TRIMESTRE_ATUAL_IDX') {
    return { rows: [{ ano_atual: anoAtual(), trimestre_atual_idx: trimestreAtualIdxAgora() }] };
  }
  // Trimestres recentes de TODOS os clientes classificados de uma vez
  // (janela móvel de 4 trimestres, mesma lógica da rota individual) -
  // checado ANTES do "SELECT C.ID AS CLIENTE_ID ... CLASSIFICATORIO_TIPO IS
  // NOT NULL" abaixo, que também bateria com esse texto sem essa checagem.
  if (s.includes('C.ID AS CLIENTE_ID') && s.includes("DATE_TRUNC('QUARTER'")) {
    const classificados = clientes.filter(c => c.classificatorio_tipo);
    const inicioStr = inicioJanelaTrimestralMovel();
    const rows = [];
    for (const cliente of classificados) {
      const grupo = cliente.matriz_grupo ? clientes.filter(c => c.matriz_grupo === cliente.matriz_grupo) : [cliente];
      const codigos = grupo.map(c => c.codigo_oficial).filter(Boolean);
      const itens = pedidosOficiaisItens.filter(it => codigos.includes(it.cliente_codigo_oficial) && it.data_implantacao && it.data_implantacao >= inicioStr);
      const porTrimestre = {};
      for (const it of itens) {
        const d = new Date(it.data_implantacao);
        const q = Math.floor(d.getUTCMonth() / 3);
        const key = `${d.getUTCFullYear()}-${String(q * 3 + 1).padStart(2, '0')}-01`;
        porTrimestre[key] = (porTrimestre[key] || 0) + (Number(it.valor) || 0);
      }
      for (const [trimestre, faturado] of Object.entries(porTrimestre)) rows.push({ cliente_id: cliente.id, trimestre, faturado });
    }
    return { rows };
  }
  if (s.includes('SELECT C.ID AS CLIENTE_ID') && s.includes("CLASSIFICATORIO_TIPO IS NOT NULL")) {
    const classificados = clientes.filter(c => c.classificatorio_tipo);
    const rows = classificados.map(c => ({ cliente_id: c.id, ...calcularFaturamentoAnoFechadoParaCliente(c.id) }));
    return { rows };
  }
  // PUT /api/clientes/:id/nome-arquivo
  if (s.startsWith('UPDATE CLIENTES SET NOME_ARQUIVO = $1, NOME_ARQUIVO_EM = NOW() WHERE ID = $2')) {
    const c = clientes.find(x => String(x.id) === String(params[1]));
    if (!c) return { rows: [] };
    c.nome_arquivo = params[0];
    c.nome_arquivo_em = new Date().toISOString();
    return { rows: [{ id: c.id, nome: c.nome, nome_arquivo: c.nome_arquivo, nome_arquivo_em: c.nome_arquivo_em }] };
  }
  if (s.includes('WHERE C.MATRIZ_GRUPO = $1')) {
    // Faturamento de CADA empresa individualmente (só o próprio
    // codigo_oficial, sem expandir pro grupo inteiro como
    // calcularFaturamentoAnoFechadoParaCliente faz) - é o ponto desta
    // consulta, comparar quem no grupo compra menos.
    const grupo = clientes.filter(c => c.matriz_grupo === params[0]);
    const ano = anoClassificatorioFechado();
    const fimStr = `${ano + 1}-01-01`;
    const inicio12m = inicioJanela12m();
    const rows = grupo.map(c => {
      const itensDoCliente = pedidosOficiaisItens.filter(it => it.cliente_codigo_oficial === c.codigo_oficial && faturadoDeFato(it));
      const faturamento_12m = itensDoCliente.filter(it => it.data_faturamento && it.data_faturamento > inicio12m)
        .reduce((s, it) => s + (Number(it.valor) || 0), 0);
      const faturamento_ano_corrente = itensDoCliente.filter(it => it.data_faturamento && it.data_faturamento >= fimStr)
        .reduce((s, it) => s + (Number(it.valor) || 0), 0);
      const datas = itensDoCliente.map(it => it.data_faturamento).filter(Boolean).sort();
      return {
        id: c.id, nome: c.nome, documento: c.documento, classificatorio_tipo: c.classificatorio_tipo,
        faturamento_12m, faturamento_ano_corrente, ultima_compra: datas.length ? datas[datas.length - 1] : null,
      };
    }).sort((a, b) => a.faturamento_12m - b.faturamento_12m || a.nome.localeCompare(b.nome));
    return { rows };
  }
  if (s.includes("DATE_TRUNC('QUARTER', POI.DATA_IMPLANTACAO)")) {
    const cliente = clientes.find(c => Number(c.id) === Number(params[0]));
    if (!cliente) return { rows: [] };
    // Rede: só o próprio cliente (matriz_grupo ali é a rede/cooperativa,
    // não empresas irmãs) - mesma regra da rota real.
    const grupo = cliente.classificatorio_tipo !== 'Rede' && cliente.matriz_grupo
      ? clientes.filter(c => c.matriz_grupo === cliente.matriz_grupo)
      : [cliente];
    const codigos = grupo.map(c => c.codigo_oficial).filter(Boolean);
    // Janela móvel dos últimos 4 trimestres terminando no trimestre EM
    // ANDAMENTO agora (não presa ao ano civil já fechado) - mesma mudança
    // feita na rota real, pra "acompanhar os trimestres recentes".
    const inicioStr = inicioJanelaTrimestralMovel();
    const itens = pedidosOficiaisItens.filter(it => codigos.includes(it.cliente_codigo_oficial) && it.data_implantacao && it.data_implantacao >= inicioStr);
    const porTrimestre = {};
    for (const it of itens) {
      const d = new Date(it.data_implantacao);
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
      nome: c.nome,
      classificatorio_tipo: c.classificatorio_tipo || null,
      ultima_compra: calcularFaturamentoAnoFechadoParaCliente(c.id).ultima_compra,
    }));
    return { rows };
  }

  // produtos-abc-geral / clientes/:id/produtos-abc (routes/relatorios.js) -
  // agrega pedidos_oficiais_itens por codigo_sku literal, igual a query
  // real faz antes da reconciliação P/P1/P2 (feita em JS depois, no
  // próprio relatorios.js - aqui só precisa devolver os dados crus).
  if (s.includes('COALESCE(P.NOME, MAX(POI.DESCRICAO), POI.CODIGO_SKU) AS PRODUTO')) {
    const porCliente = s.includes('POI.CLIENTE_CODIGO_OFICIAL = $1');
    let idx = 0;
    const clienteCodigo = porCliente ? params[idx++] : null;
    let inicio = null, fim = null;
    if (s.includes('DATA_FATURAMENTO >=')) inicio = params[idx++];
    if (s.includes('DATA_FATURAMENTO <=')) fim = params[idx++];
    let itens = pedidosOficiaisItens.filter(it => faturadoDeFato(it));
    if (porCliente) itens = itens.filter(it => it.cliente_codigo_oficial === clienteCodigo);
    if (inicio) itens = itens.filter(it => it.data_faturamento && it.data_faturamento >= inicio);
    if (fim) itens = itens.filter(it => it.data_faturamento && it.data_faturamento <= fim);
    const porCodigo = new Map();
    for (const it of itens) {
      const atual = porCodigo.get(it.codigo_sku) || { codigo_sku: it.codigo_sku, pedidosSet: new Set(), quantidade_total: 0, faturamento_total: 0, descricao: null };
      atual.pedidosSet.add(it.nr_pedido);
      if (it.descricao && (!atual.descricao || it.descricao > atual.descricao)) atual.descricao = it.descricao; // MAX(poi.descricao)
      atual.quantidade_total += Number(it.quantidade) || 0;
      atual.faturamento_total += Number(it.valor) || 0;
      porCodigo.set(it.codigo_sku, atual);
    }
    const rows = [...porCodigo.values()].map(g => {
      const prod = produtos.find(p => p.codigo_sku === g.codigo_sku);
      return {
        codigo_sku: g.codigo_sku,
        produto: prod ? prod.nome : (g.descricao || g.codigo_sku),
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
    let itens = pedidosOficiaisItens.filter(it => faturadoDeFato(it) && codigos.includes(it.codigo_sku));
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

  // Entrada de pedidos mensal do Dashboard (SQL_ENTRADA_PEDIDOS_MENSAL em
  // routes/relatorios.js): pela data de implantação, carteira + faturado, só
  // a série de pedidos de até 6 dígitos, a partir do 1º dia de 11 meses atrás.
  if (s.includes("DATE_TRUNC('MONTH', DATA_IMPLANTACAO)")) {
    const hoje = new Date();
    const corteStr = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - 11, 1)).toISOString().slice(0, 10);
    const grupos = new Map();
    for (const it of pedidosOficiaisItens) {
      if (!it.data_implantacao || it.data_implantacao < corteStr || String(it.nr_pedido).length > 6) continue;
      const key = `${it.data_implantacao.slice(0, 7)}-01`;
      const atual = grupos.get(key) || { periodo: key, valor: 0, pedidosSet: new Set(), clientesSet: new Set() };
      atual.valor += Number(it.valor) || 0;
      atual.pedidosSet.add(it.nr_pedido);
      if (it.cliente_codigo_oficial) atual.clientesSet.add(it.cliente_codigo_oficial);
      grupos.set(key, atual);
    }
    // Os 12 meses sempre, terminando no atual; mês sem pedido vem zerado
    // (generate_series + LEFT JOIN no SQL real).
    const rows = [];
    for (let i = 11; i >= 0; i--) {
      const periodo = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - i, 1)).toISOString().slice(0, 10);
      const g = grupos.get(periodo);
      rows.push({ periodo, valor: g ? g.valor : 0, pedidos: g ? g.pedidosSet.size : 0, clientes: g ? g.clientesSet.size : 0 });
    }
    return { rows };
  }

  // Entrada do mês anterior até o mesmo dia de hoje
  // (SQL_ENTRADA_MES_ANTERIOR_ATE_HOJE em routes/relatorios.js).
  if (s.includes('AS ATE, COALESCE(SUM(POI.VALOR), 0) AS VALOR')) {
    const hoje = new Date();
    const inicio = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - 1, 1));
    const ultimoDia = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 0)).getUTCDate();
    const ate = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth() - 1, Math.min(hoje.getUTCDate(), ultimoDia))).toISOString().slice(0, 10);
    const inicioStr = inicio.toISOString().slice(0, 10);
    const valor = pedidosOficiaisItens
      .filter(it => it.data_implantacao && it.data_implantacao >= inicioStr && it.data_implantacao <= ate && String(it.nr_pedido).length <= 6)
      .reduce((soma, it) => soma + (Number(it.valor) || 0), 0);
    return { rows: [{ ate, valor }] };
  }

  // Pedidos do mês atual por trás do cartão "Valor Entrada de Pedidos Mês"
  // (SQL_ENTRADA_PEDIDOS_DO_MES em routes/relatorios.js) - um por pedido, com
  // o nome do cliente (null se não houver cliente com aquele codigo_oficial).
  if (s.includes('GROUP BY POI.NR_PEDIDO, POI.CLIENTE_CODIGO_OFICIAL')) {
    const hoje = new Date();
    const inicioMes = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const porPedido = new Map();
    for (const it of pedidosOficiaisItens) {
      if (!it.data_implantacao || it.data_implantacao < inicioMes || String(it.nr_pedido).length > 6) continue;
      const chave = `${it.nr_pedido}::${it.cliente_codigo_oficial}`;
      const cli = clientes.find(c => c.codigo_oficial === it.cliente_codigo_oficial);
      const atual = porPedido.get(chave) || { nr_pedido: it.nr_pedido, cliente_codigo_oficial: it.cliente_codigo_oficial, cliente_nome: cli ? cli.nome : null, data_implantacao: it.data_implantacao, valor: 0 };
      atual.valor += Number(it.valor) || 0;
      if (it.data_implantacao < atual.data_implantacao) atual.data_implantacao = it.data_implantacao;
      porPedido.set(chave, atual);
    }
    const rows = [...porPedido.values()].sort((a, b) => b.data_implantacao.localeCompare(a.data_implantacao) || b.valor - a.valor);
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
    const itens = pedidosOficiaisItens.filter(it => faturadoDeFato(it) && it.data_faturamento && it.data_faturamento >= corteStr);
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
  if (s.includes('SELECT ATUALIZADO_EM, MUNICIPIO, UF FROM CLIENTE_CNPJ_FICHA WHERE CLIENTE_ID')) {
    const row = clienteCnpjFicha[params[0]];
    return { rows: row ? [{ atualizado_em: row.atualizado_em, municipio: row.municipio || null, uf: row.uf || null }] : [] };
  }
  // progresso do preenchimento automático (routes/lib/preenchimentoCnpj.js) -
  // o mock não guarda falhas, então desistidos é sempre 0
  if (s.includes('AS DESISTIDOS')) {
    const comCnpj = clientes.filter(c => String(c.documento || '').replace(/\D/g, '').length === 14);
    return { rows: [{
      com_cnpj: String(comCnpj.length),
      com_ficha: String(comCnpj.filter(c => clienteCnpjFicha[c.id]).length),
      desistidos: '0',
    }] };
  }
  // UF do cliente pro saldo mínimo em carteira (GET /api/pedidos-oficiais/:clienteId)
  if (s.includes('SELECT UF FROM CLIENTE_CNPJ_FICHA WHERE CLIENTE_ID')) {
    const row = clienteCnpjFicha[params[0]];
    return { rows: row ? [{ uf: row.uf ?? null }] : [] };
  }
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
  // PDF com produto que não está nem no catálogo (routes/lib/produtoPorSku.js): ON CONFLICT DO NOTHING RETURNING id
  if (s.includes('INSERT INTO PRODUTOS (CODIGO_SKU, NOME) VALUES ($1, $2) ON CONFLICT (CODIGO_SKU) DO NOTHING RETURNING ID')) {
    if (produtos.some(p => p.codigo_sku === params[0])) return { rows: [] };
    const novo = { id: nextId.produtos++, codigo_sku: params[0], nome: params[1], categoria: null };
    produtos.push(novo);
    return { rows: [{ id: novo.id }] };
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
  // POST /api/pedidos-oficiais/importar (UNNEST em lote + ON CONFLICT) - vem
  // antes do INSERT INTO PEDIDOS abaixo, que também casaria com este SQL.
  if (s.includes('INSERT INTO PEDIDOS_OFICIAIS_ITENS') && s.includes('UNNEST')) {
    const [nrs, skus, clis, qtds, valores, impls, fats, nfs, classis, transps, sits, status, descs, chaves] = params;
    // chave da linha: nr_pedido + codigo_sku + nota_chave (nota fiscal na
    // linha faturada, '' no saldo em carteira) - ver schema.sql
    const chaveDe = (it) => it.nota_chave ?? (it.status === 'faturado' && it.nota_fiscal != null ? String(it.nota_fiscal) : '');
    nrs.forEach((nr, i) => {
      const novo = {
        nr_pedido: nr, codigo_sku: skus[i], cliente_codigo_oficial: clis[i], quantidade: qtds[i], valor: valores[i],
        data_implantacao: impls[i], data_faturamento: fats[i], nota_fiscal: nfs[i], classificatorio: classis[i],
        transportadora: transps[i], situacao_pedido: sits[i], status: status[i], descricao: descs ? descs[i] : null,
        nota_chave: chaves ? chaves[i] : '',
      };
      const atual = pedidosOficiaisItens.find(it => it.nr_pedido === nr && it.codigo_sku === skus[i] && chaveDe(it) === novo.nota_chave);
      if (!atual) { pedidosOficiaisItens.push(novo); return; }
      const novoFaturado = novo.status === 'faturado';
      if (novoFaturado || atual.status !== 'faturado') { atual.quantidade = novo.quantidade; atual.valor = novo.valor; }
      atual.data_implantacao = novo.data_implantacao ?? atual.data_implantacao;
      atual.descricao = novo.descricao ?? atual.descricao;
      if (novoFaturado) Object.assign(atual, { data_faturamento: novo.data_faturamento, nota_fiscal: novo.nota_fiscal, situacao_pedido: novo.situacao_pedido, status: 'faturado' });
    });
    return { rows: [] };
  }
  // importação: saldo em carteira que deixou de existir (planejarCarteira) -
  // pedido "Atendido Total" no relatório e produto que saiu da Carteira
  if (s.startsWith("DELETE FROM PEDIDOS_OFICIAIS_ITENS WHERE STATUS = 'CARTEIRA' AND NR_PEDIDO = ANY($1::TEXT[])")) {
    const antes = pedidosOficiaisItens.length;
    pedidosOficiaisItens = pedidosOficiaisItens.filter(it => !(it.status === 'carteira' && params[0].includes(it.nr_pedido)));
    return { rowCount: antes - pedidosOficiaisItens.length, rows: [] };
  }
  if (s.startsWith('DELETE FROM PEDIDOS_OFICIAIS_ITENS POI USING UNNEST')) {
    const pares = new Set(params[0].map((nr, i) => `${nr}::${params[1][i]}`));
    const antes = pedidosOficiaisItens.length;
    pedidosOficiaisItens = pedidosOficiaisItens.filter(it => !(it.status === 'carteira' && pares.has(`${it.nr_pedido}::${it.codigo_sku}`)));
    return { rowCount: antes - pedidosOficiaisItens.length, rows: [] };
  }
  // GET /api/pedidos/exportar (routes/relatorios.js): período pelo dia do pedido em Brasília
  if (s.includes('/* PEDIDOS:EXPORTAR */')) {
    const rows = [];
    for (const ped of pedidos) {
      const dia = diaDoPedidoBr(ped.data_pedido);
      if (dia < params[0] || dia > params[1]) continue;
      const c = clientes.find(cl => String(cl.id) === String(ped.cliente_id));
      const v = vendedores.find(vd => vd.id === ped.vendedor_id);
      for (const it of pedidoItens.filter(i => i.pedido_id === ped.id)) {
        const prod = produtos.find(p => p.id === it.produto_id);
        if (c && prod) rows.push({ data_pedido: ped.data_pedido, dia, cliente_nome: c.nome, cliente_documento: c.documento || null,
          vendedor_nome: v ? v.nome : null, codigo_sku: prod.codigo_sku, produto_nome: prod.nome, quantidade: it.quantidade,
          preco_unitario: it.preco_unitario, origem: ped.origem, numero_cotacao: ped.numero_cotacao || null });
      }
    }
    rows.sort((a, b) => (a.dia === b.dia ? new Date(b.data_pedido) - new Date(a.data_pedido) : (a.dia < b.dia ? 1 : -1)));
    return { rows };
  }
  // GET /api/pedidos/duplicados: mesmo cliente, mesmo dia (Brasília), algum produto em comum
  if (s.includes('/* PEDIDOS:DUPLICADOS */')) {
    const prodsDe = (ped) => new Set(pedidoItens.filter(i => i.pedido_id === ped.id).map(i => i.produto_id));
    const dup = pedidos.filter(p2 => pedidos.some(p3 => p3.id !== p2.id && String(p3.cliente_id) === String(p2.cliente_id)
      && diaDoPedidoBr(p3.data_pedido) === diaDoPedidoBr(p2.data_pedido) && [...prodsDe(p3)].some(id => prodsDe(p2).has(id))));
    const rows = dup.map(ped => {
      const c = clientes.find(cl => String(cl.id) === String(ped.cliente_id));
      return { pedido_id: ped.id, cliente_id: ped.cliente_id, cliente_nome: c ? c.nome : null, data_pedido: ped.data_pedido,
        dia: diaDoPedidoBr(ped.data_pedido), origem: ped.origem, numero_cotacao: ped.numero_cotacao || null,
        itens: pedidoItens.filter(i => i.pedido_id === ped.id).map(i => {
          const prod = produtos.find(p => p.id === i.produto_id);
          return { codigo_sku: prod?.codigo_sku, produto: prod?.nome, quantidade: i.quantidade };
        }) };
    });
    rows.sort((a, b) => (Number(a.cliente_id) - Number(b.cliente_id)) || (a.dia < b.dia ? 1 : a.dia > b.dia ? -1 : 0));
    return { rows };
  }
  if (s.includes('INSERT INTO PEDIDOS')) {
    // params: cliente_id, vendedor_id, observacao, numero_cotacao, origem, data_pedido, pdf_modificado_em, usuario_id, contexto, id_envio
    const numeroCotacao = params[3] ?? null;
    if (params[9] && pedidos.some(p => p.id_envio === params[9])) {
      // índice único parcial idx_pedidos_id_envio
      const err = new Error('duplicate key value violates unique constraint "idx_pedidos_id_envio"');
      err.code = '23505'; err.constraint = 'idx_pedidos_id_envio';
      throw err;
    }
    if (numeroCotacao && pedidos.some(p => p.numero_cotacao === numeroCotacao)) {
      // mesmo comportamento do índice único parcial idx_pedidos_numero_cotacao
      const err = new Error('duplicate key value violates unique constraint "idx_pedidos_numero_cotacao"');
      err.code = '23505'; err.constraint = 'idx_pedidos_numero_cotacao';
      throw err;
    }
    const p = {
      id: nextId.pedidos++, cliente_id: params[0], vendedor_id: params[1], observacao: params[2],
      numero_cotacao: numeroCotacao, pdf_modificado_em: params[6] ?? null, usuario_id: params[7] ?? null,
      origem: params[4] || 'app', contexto: params[8] ?? null, id_envio: params[9] ?? null, versao_app: params[10] ?? null,
      data_pedido: params[5] ? new Date(params[5]).toISOString() : new Date().toISOString(),
    };
    pedidos.push(p);
    return { rows: [{ id: p.id, data_pedido: p.data_pedido }] };
  }
  // trava por id_envio (pg_advisory_xact_lock): no mock as consultas não se intercalam
  if (s.includes('PG_ADVISORY_XACT_LOCK')) return { rows: [{}] };
  // POST /api/pedidos com id_envio: o reenvio do mesmo pedido devolve o gravado
  if (s.includes('FROM PEDIDOS WHERE ID_ENVIO = $1')) {
    return { rows: pedidos.filter(p => p.id_envio && p.id_envio === params[0])
      .map(p => ({ id: p.id, cliente_id: p.cliente_id, data_pedido: p.data_pedido, usuario_id: p.usuario_id, versao_app: p.versao_app || null, contexto: p.contexto ? JSON.parse(p.contexto) : null })) };
  }
  // POST /api/pedidos com numero_cotacao: busca (com lock) da cotação já gravada
  if (s.includes('FROM PEDIDOS WHERE NUMERO_COTACAO = $1')) {
    return { rows: pedidos.filter(p => p.numero_cotacao === params[0])
      .map(p => ({ id: p.id, cliente_id: p.cliente_id, data_pedido: p.data_pedido, pdf_modificado_em: p.pdf_modificado_em, usuario_id: p.usuario_id })) };
  }
  // ...e a atualização dela quando chega um PDF mais novo
  if (s.includes('UPDATE PEDIDOS SET CLIENTE_ID = $1, VENDEDOR_ID = $2')) {
    const p = pedidos.find(x => String(x.id) === String(params[5]));
    if (!p) return { rows: [] };
    Object.assign(p, { cliente_id: params[0], vendedor_id: params[1], observacao: params[2], pdf_modificado_em: params[4] });
    if (params[3]) p.data_pedido = params[3];
    return { rows: [{ id: p.id, data_pedido: p.data_pedido }] };
  }
  if (s.startsWith('DELETE FROM PEDIDO_ITENS WHERE PEDIDO_ID = $1')) {
    for (let i = pedidoItens.length - 1; i >= 0; i--) if (String(pedidoItens[i].pedido_id) === String(params[0])) pedidoItens.splice(i, 1);
    return { rows: [] };
  }
  if (s.includes('INSERT INTO PEDIDO_ITENS')) {
    pedidoItens.push({ id: nextId.pedido_itens++, pedido_id: params[0], produto_id: params[1], quantidade: params[2], preco_unitario: params[3] });
    return { rows: [] };
  }

  // levantamentos
  if (s.includes('/* LEVANTAMENTO:MESMO-ENVIO */')) {
    return { rows: levantamentos.filter(l => l.id_envio && l.id_envio === params[0]).map(l => ({ id: l.id, cliente_id: l.cliente_id, data_visita: l.data_visita })) };
  }
  if (s.includes('INSERT INTO LEVANTAMENTOS')) {
    if (params[6] && levantamentos.some(l => l.id_envio === params[6])) {
      // índice único parcial idx_levantamentos_id_envio
      const err = new Error('duplicate key value violates unique constraint "idx_levantamentos_id_envio"');
      err.code = '23505'; err.constraint = 'idx_levantamentos_id_envio';
      throw err;
    }
    const l = {
      id: nextId.levantamentos++, cliente_id: params[0], vendedor_id: params[1], nome: params[2], data_visita: new Date().toISOString(),
      latitude: params[3] ?? null, longitude: params[4] ?? null, localizacao_precisao_m: params[5] ?? null, id_envio: params[6] ?? null,
    };
    levantamentos.push(l);
    return { rows: [{ id: l.id, data_visita: l.data_visita }] };
  }
  // localização da loja (routes/levantamentos.js) - mesma regra do WHERE real:
  // sem posição, leitura igual ou mais precisa, ou posição atual velha.
  if (s.includes('UPDATE CLIENTES SET LATITUDE')) {
    const [id, latitude, longitude, precisao, validadeDias] = params;
    const c = clientes.find(x => x.id === id);
    if (!c) return { rowCount: 0, rows: [] };
    const velha = c.localizacao_atualizada_em && (Date.now() - new Date(c.localizacao_atualizada_em).getTime()) > validadeDias * 86400000;
    if (c.latitude == null || c.localizacao_precisao_m == null || precisao <= c.localizacao_precisao_m || velha) {
      Object.assign(c, { latitude, longitude, localizacao_precisao_m: precisao, localizacao_atualizada_em: new Date().toISOString() });
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
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
  if (s.includes('FROM LEVANTAMENTO_ITENS LI') && s.includes('JOIN PRODUTOS P')) {
    const levantamentoId = params[0];
    const itens = levantamentoItens.filter(li => li.levantamento_id == levantamentoId);
    // NUMERIC no Postgres real vem como string via node-postgres - simula
    // isso aqui pra pegar bug de concatenação em vez de soma (ver
    // doOpenSavedSurvey em index.html, que precisa de Number(...) nisso).
    return { rows: itens.map(li => {
      const prod = produtos.find(p => p.id === li.produto_id);
      return { codigo_sku: prod ? prod.codigo_sku : null, quantidade_contada: String(li.quantidade_contada) };
    }) };
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
      ativo: true,
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
    // "AND u.ativo": usuário desativado pelo admin não passa (middleware/auth.js, /auth/me)
    if (u && s.includes('AND U.ATIVO') && u.ativo === false) return { rows: [] };
    return { rows: u ? [{ id: u.id, nome: u.nome, email: u.email, is_admin: u.is_admin }] : [] };
  }
  if (s.includes('DELETE FROM SESSOES WHERE USUARIO_ID')) {
    const antes = sessoes.length;
    sessoes = sessoes.filter(se => se.usuario_id != params[0]);
    return { rows: [], rowCount: antes - sessoes.length };
  }
  if (s.includes('DELETE FROM SESSOES')) {
    sessoes = sessoes.filter(se => se.token !== params[0]);
    return { rows: [] };
  }
  if (s.includes('DELETE FROM PUSH_INSCRICOES WHERE USUARIO_ID')) {
    const antes = pushInscricoes.length;
    pushInscricoes = pushInscricoes.filter(i => i.usuario_id != params[0]);
    return { rows: [], rowCount: antes - pushInscricoes.length };
  }
  // usuários - routes/auth.js (login Google, lista, desativar/excluir)
  if (s.startsWith('LOCK TABLE USUARIOS')) return { rows: [] };
  if (s.includes('FROM USUARIOS WHERE GOOGLE_SUB = $1')) {
    return { rows: usuarios.filter(u => u.google_sub === params[0]).map(u => ({ ...u })) };
  }
  if (s.includes('FROM USUARIOS WHERE EMAIL = $1 AND GOOGLE_SUB IS NULL')) {
    return { rows: usuarios.filter(u => u.email === params[0] && !u.google_sub).map(u => ({ ...u })) };
  }
  if (s.startsWith('UPDATE USUARIOS SET GOOGLE_SUB')) {
    const u = usuarios.find(x => x.id == params[1]);
    if (u) u.google_sub = params[0];
    return { rows: [] };
  }
  if (s.includes('FROM USUARIOS WHERE IS_ADMIN = TRUE')) {
    const soAtivos = s.includes('AND ATIVO = TRUE');
    return { rows: usuarios.filter(u => u.is_admin && (!soAtivos || u.ativo !== false)).map(u => ({ id: u.id })) };
  }
  if (s.startsWith('SELECT') && s.includes('FROM USUARIOS WHERE ID = $1')) {
    return { rows: usuarios.filter(u => u.id == params[0]).map(u => ({ ...u })) };
  }
  if (s.startsWith('UPDATE USUARIOS SET ATIVO')) {
    const u = usuarios.find(x => x.id == params[0]);
    if (!u) return { rows: [] };
    u.ativo = params[1];
    return { rows: [{ id: u.id, nome: u.nome, email: u.email, is_admin: u.is_admin, ativo: u.ativo }] };
  }
  if (s.startsWith('SELECT ID, NOME, EMAIL, IS_ADMIN, ATIVO, CRIADO_EM FROM USUARIOS')) {
    return { rows: usuarios.slice().sort((a, b) => (b.ativo !== false) - (a.ativo !== false) || String(a.nome).localeCompare(b.nome))
      .map(u => ({ id: u.id, nome: u.nome, email: u.email, is_admin: u.is_admin, ativo: u.ativo !== false })) };
  }
  if (s.startsWith('DELETE FROM USUARIOS WHERE ID')) {
    // chave estrangeira sem ON DELETE: pedidos.usuario_id e import_log.usuario_id
    if (pedidos.some(p => p.usuario_id == params[0])) { const err = new Error('violates foreign key constraint'); err.code = '23503'; throw err; }
    const u = usuarios.find(x => x.id == params[0]);
    usuarios = usuarios.filter(x => x.id != params[0]);
    sessoes = sessoes.filter(se => se.usuario_id != params[0]);
    return { rows: u ? [{ nome: u.nome, email: u.email }] : [] };
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

  // Objetivo trimestral (ERP) - resolve o classificatorio_tipo de quem bate
  // com a chave COALESCE(matriz_grupo, nome) da planilha ("Matriz"), pra
  // decidir se pula (Rede) ou não encontrou ninguém (routes/clientesClassificatorio.js
  // POST /classificatorio/objetivos-trimestrais/importar). Checado ANTES do
  // catch-all de "FROM PEDIDOS_OFICIAIS_ITENS POI" da curva ABC logo abaixo,
  // que bateria com esse texto também (mesma tabela na consulta).
  if (s === 'SELECT DISTINCT CLASSIFICATORIO_TIPO FROM CLIENTES WHERE COALESCE(MATRIZ_GRUPO, NOME) = $1') {
    const chave = params[0];
    const tipos = [...new Set(clientes.filter(c => (c.matriz_grupo || c.nome) === chave).map(c => c.classificatorio_tipo))];
    return { rows: tipos.map(t => ({ classificatorio_tipo: t })) };
  }
  // Entrada trimestral do período do objetivo importado (mesma fórmula
  // corrigida do histórico trimestral - carteira+faturado por
  // data_implantacao, sem filtro de status) pro grupo (matriz_grupo) do
  // cliente, dentro de [periodoInicio, periodoFim] - alimenta
  // faltaPObjetivo em GET /:id/classificatorio/status.
  if (s.includes('AS ENTRADA') && s.includes('POI.DATA_IMPLANTACAO >=') && s.includes('POI.DATA_IMPLANTACAO <=')) {
    let itens, periodoInicio, periodoFim;
    if (s.includes('POI.CLIENTE_CODIGO_OFICIAL = $1')) {
      const [codigoOficial, ini, fim] = params;
      periodoInicio = ini; periodoFim = fim;
      itens = pedidosOficiaisItens.filter(it => it.cliente_codigo_oficial === codigoOficial);
    } else {
      const [clienteId, ini, fim, matrizGrupo] = params;
      periodoInicio = ini; periodoFim = fim;
      const grupo = matrizGrupo ? clientes.filter(c => c.matriz_grupo === matrizGrupo) : clientes.filter(c => Number(c.id) === Number(clienteId));
      const codigos = grupo.map(c => c.codigo_oficial).filter(Boolean);
      itens = pedidosOficiaisItens.filter(it => codigos.includes(it.cliente_codigo_oficial));
    }
    const entrada = itens
      .filter(it => it.data_implantacao && it.data_implantacao >= periodoInicio && it.data_implantacao <= periodoFim)
      .reduce((sum, it) => sum + (Number(it.valor) || 0), 0);
    return { rows: [{ entrada }] };
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
      faturadoDeFato(it) &&
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

  // Rastro de quem fez cada importação em massa (registrarImportacao, db.js) -
  // o teste não confere o conteúdo, só que a chamada não derruba a rota.
  if (s.startsWith('INSERT INTO IMPORT_LOG')) {
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
function anoAtual() { return new Date().getUTCFullYear(); }
// CURRENT_DATE - INTERVAL '12 months' (YYYY-MM-DD)
function inicioJanela12m() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear() - 1, d.getUTCMonth(), d.getUTCDate())).toISOString().slice(0, 10);
}
function trimestreAtualIdxAgora() { return Math.floor(new Date().getUTCMonth() / 3); } // 0-3
// Início (YYYY-MM-DD) do trimestre civil de 3 trimestres atrás, contando do
// trimestre em andamento agora - mesma janela de `date_trunc('quarter',
// CURRENT_DATE) - INTERVAL '3 quarters'` da rota real.
function inicioJanelaTrimestralMovel() {
  const now = new Date();
  const mesInicioTrimestreAtual = trimestreAtualIdxAgora() * 3;
  const d = new Date(Date.UTC(now.getUTCFullYear(), mesInicioTrimestreAtual - 9, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`;
}

// Reproduz sqlFaturamentoClassificatorioPorCliente de routes/clientesClassificatorio.js -
// soma faturado no ano civil fechado mais recente, agrupado por
// matriz_grupo (ou o próprio cliente, se não tiver grupo) - ou só o
// próprio cliente quando `agruparPorMatrizGrupo` é false (usado pra Rede,
// onde matriz_grupo guarda o nome da rede/cooperativa, não empresas
// irmãs - somar tudo misturaria lojas sem relação societária entre si).
function calcularFaturamentoAnoFechadoParaCliente(clienteId, agruparPorMatrizGrupo = true) {
  const cliente = clientes.find(c => Number(c.id) === Number(clienteId));
  if (!cliente) return { faturamento_12m: 0, faturamento_ano_corrente: 0, faturamento_mesmo_periodo_ano_anterior: 0, ultima_compra: null };
  const grupo = agruparPorMatrizGrupo && cliente.matriz_grupo ? clientes.filter(c => c.matriz_grupo === cliente.matriz_grupo) : [cliente];
  const codigos = grupo.map(c => c.codigo_oficial).filter(Boolean);
  const itensFaturados = pedidosOficiaisItens.filter(it => codigos.includes(it.cliente_codigo_oficial) && faturadoDeFato(it));
  const ano = anoClassificatorioFechado();
  const inicioStr = `${ano}-01-01`;
  const fimStr = `${ano + 1}-01-01`;
  // Últimos 12 meses (régua móvel) - `data_faturamento > CURRENT_DATE -
  // INTERVAL '12 months'` da rota real (Política Comercial rev. 06).
  const inicio12m = inicioJanela12m();
  const itensJanela = itensFaturados.filter(it => it.data_faturamento && it.data_faturamento > inicio12m);
  const faturamento_12m = itensJanela.reduce((s, it) => s + (Number(it.valor) || 0), 0);
  // Ano em andamento (ainda não fechado) - mesma ideia de
  // faturamento_ano_corrente em SQL_FATURAMENTO_CLASSIFICATORIO_POR_CLIENTE.
  const itensAnoCorrente = itensFaturados.filter(it => it.data_faturamento && it.data_faturamento >= fimStr);
  const faturamento_ano_corrente = itensAnoCorrente.reduce((s, it) => s + (Number(it.valor) || 0), 0);
  // Mesmo período do ano fechado (mesma contagem de dias decorridos no ano
  // corrente, mas no ano fechado) - espelha a lógica SQL adicionada em
  // SQL_FATURAMENTO_CLASSIFICATORIO_POR_CLIENTE (PERIODO_CLASSIFICATORIO_INICIO_SQL
  // + (CURRENT_DATE - PERIODO_CLASSIFICATORIO_FIM_SQL)).
  const agora = new Date();
  const diasDecorridos = Math.floor((Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()) - Date.UTC(agora.getUTCFullYear(), 0, 1)) / 86400000);
  const limiteMesmoPeriodoStr = new Date(Date.UTC(ano, 0, 1) + diasDecorridos * 86400000).toISOString().slice(0, 10);
  const itensMesmoPeriodo = itensFaturados.filter(it => it.data_faturamento && it.data_faturamento >= inicioStr && it.data_faturamento < limiteMesmoPeriodoStr);
  const faturamento_mesmo_periodo_ano_anterior = itensMesmoPeriodo.reduce((s, it) => s + (Number(it.valor) || 0), 0);
  const datas = itensFaturados.map(it => it.data_faturamento).filter(Boolean).sort();
  const ultima_compra = datas.length ? datas[datas.length - 1] : null;
  return { faturamento_12m, faturamento_ano_corrente, faturamento_mesmo_periodo_ano_anterior, ultima_compra };
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
  registrarImportacao: async (usuarioId, rota, itensProcessados) => {
    await query('INSERT INTO import_log (usuario_id, rota, itens_processados) VALUES ($1, $2, $3)', [usuarioId || null, rota, itensProcessados || 0]);
  },
  __queryLog: queryLog,
  __reset: reset,
  __seed: seed,
  __getClientes: () => clientes,
  __getLevantamentos: () => levantamentos,
  __getPedidoItens: () => pedidoItens,
  __getPedidos: () => pedidos,
  __getPedidosOficiaisItens: () => pedidosOficiaisItens,
  __getRecompraAdiamentos: () => recompraAdiamentos,
  __getNovidades: () => novidades,
  __getImportacoesEmail: () => importacoesEmail,
  __getPedidosBloqueados: () => pedidosBloqueados,
  __getPrevisaoEstoque: () => previsaoEstoque,
  __getCatalogoPrecos: () => catalogoPrecos,
  __getProdutos: () => produtos,
  __getLevantamentoItens: () => levantamentoItens,
  __getPushInscricoes: () => pushInscricoes,
  __getUsuarios: () => usuarios,
  __getSessoes: () => sessoes,
  __getPedidosPendentesPagamento: () => pedidosPendentesPagamento,
  __anoClassificatorioFechado: anoClassificatorioFechado,
  __inicioJanela12m: inicioJanela12m,
};
