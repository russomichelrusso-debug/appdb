// "Para reativar": clientes que pararam de comprar, a partir do Relatório de
// Clientes Sem Compra do ERP (noreply@cortag.com.br, todo dia 2 - chega pela
// importação por e-mail ou pelo Painel; leitura em importadores.js).
//
// O relatório traz todo cliente que comprou nos 12 meses do período, com o mês
// da última compra. Daí saem três faixas, pelas cores do próprio ERP:
//  - 🟡 3 a 5 meses sem compra e 🔴 6 a 12 meses (estão no relatório);
//  - 💤 mais de 12 meses: cliente com código do ERP que NÃO está no relatório,
//    com a última compra conhecida no app antes do período do relatório.
// "Meses sem compra" é recontado a cada dia pelo mês de hoje (o relatório de
// 02/10 diz "1" pra quem comprou em setembro - a mesma conta) e pela compra
// mais nova que o app conhece depois dele (relatório oficial pela data de
// implantação, carteira + faturado, sem a série de 7 dígitos de itens
// avulsos - mesma régua da Recompra - ou pedido do app) - quem pede sai da
// lista na hora, sem esperar o relatório do mês seguinte.
//
// "Já falei" tira o cliente por 30 dias; "Não reativar" (fechou, mudou de
// ramo...) até ele comprar de novo. Vale em todos os aparelhos.
const express = require('express');
const router = express.Router();
const { pool, registrarImportacao } = require('../db');
const { limparNomeCliente } = require('../clientMatcher');
const { SQL_PEDIDO_APP_VALIDO, sqlDiaDoPedido } = require('./lib/comprasApp');
const { diaISO, somarDias, diasEntre } = require('./lib/ritmoCompra');
const { sqlFaturadoDeFato } = require('./lib/faturadoDeFato');
const { avisarImportacao } = require('./lib/novidades');
const { validarIdInteiro } = require('../middleware/validarId');
const { importarContasSalesforce, CHAVE_RELATORIO: CHAVE_CONTAS_SF } = require('./contasSalesforce');
const { primeiroTelefone } = require('./lib/contasSalesforce');

router.param('id', validarIdInteiro);

const CHAVE_RELATORIO = 'clientes_sem_compra_relatorio';
const ADIAR_DIAS = 30;
const MESES_MINIMO = 3; // 1-2 meses = "Verde" no ERP: compra normal
const MAX_ITENS = 5000;
const ORDEM_FAIXA = { amarelo: 0, vermelho: 1, perdido: 2 };

function hojeBrasil() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}
// 'AAAA-MM' (ou 'AAAA-MM-DD') -> nº do mês, pra contar meses entre duas datas
function indiceMes(iso) {
  const [a, m] = String(iso).split('-').map(Number);
  return a * 12 + (m - 1);
}
function faixaDosMeses(meses) {
  if (meses < MESES_MINIMO) return null;
  if (meses <= 5) return 'amarelo';
  if (meses <= 12) return 'vermelho';
  return 'perdido';
}
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
const RE_MES = /^\d{4}-\d{2}$/;
const soDigitos = (s) => String(s || '').replace(/\D/g, '');

// Só admin (mesma regra da planilha Classificatório): troca a foto de todo
// mundo e dá código do ERP a cliente achado pelo CNPJ. A importação por e-mail
// chama a função direto.
router.post('/importar', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode importar o relatório de clientes sem compra.' });
  const r = await importarClientesSemCompra(req.body || {}, req.usuario);
  res.status(r.status).json(r.json);
});

// Relatório "Todas Contas" do Salesforce (routes/contasSalesforce.js): só
// admin - cria cliente e marca conta de outro vendedor pra todo mundo.
router.post('/contas-salesforce', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode importar o relatório de contas do Salesforce.' });
  const r = await importarContasSalesforce(req.body || {}, req.usuario);
  res.status(r.status).json(r.json);
});

// Também chamada pela importação por e-mail (routes/importacaoEmail.js) -
// devolve { status, json }. Troca a foto inteira; relatório mais antigo que o
// já importado não muda nada (o script importa do mais antigo pro mais novo,
// mas o Painel aceita qualquer arquivo).
async function importarClientesSemCompra(dados, usuario) {
  const { dataRelatorio, periodoInicio, periodoFim, itens } = dados || {};
  if (!RE_DIA.test(String(dataRelatorio || ''))) return { status: 400, json: { erro: 'Data do relatório inválida.' } };
  if (!Array.isArray(itens) || itens.length === 0 || itens.length > MAX_ITENS) return { status: 400, json: { erro: 'Envie { dataRelatorio, itens: [...] }.' } };
  const validos = [];
  const vistos = new Set();
  for (const it of itens) {
    const codigo = String((it && it.codigo_oficial) || '').trim();
    const mes = String((it && it.mes_ultima_compra) || '');
    if (!/^\d{1,12}$/.test(codigo) || !RE_MES.test(mes) || vistos.has(codigo)) continue;
    vistos.add(codigo);
    const texto = (v, max = 300) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
    const fat = Number(it.fat_12m);
    const meses = Number(it.meses_sem_compra);
    validos.push({
      codigo, mes: `${mes}-01`,
      meses: Number.isInteger(meses) && meses >= 0 && meses < 1000 ? meses : null,
      fat: Number.isFinite(fat) ? Math.round(fat * 100) / 100 : null, // a planilha traz 1908.2599999999998
      nome: limparNomeCliente(texto(it.nome)) || texto(it.nome),
      documento: texto(it.documento, 30),
      grupo: texto(it.grupo, 100), matriz: texto(it.matriz), telefone: texto(it.telefone, 100),
      cidade: texto(it.cidade, 100), uf: texto(it.uf, 2), gestor: texto(it.gestor, 150),
    });
  }
  if (validos.length === 0) return { status: 400, json: { erro: 'Nenhum cliente válido no relatório.' } };

  let client;
  try {
    const atual = await pool.query(`/* reativacao:meta */ SELECT valor FROM configuracoes WHERE chave = $1`, [CHAVE_RELATORIO]);
    const dataAtual = atual.rows[0] && atual.rows[0].valor && atual.rows[0].valor.data;
    if (dataAtual && dataAtual > dataRelatorio) {
      return { status: 200, json: { ok: true, ignorado: true, aviso: `Relatório de ${dataRelatorio} é mais antigo que o já importado (${dataAtual}) — nada mudou.` } };
    }

    // cliente pelo código do ERP; senão pelo CNPJ (e o código passa a ser dele,
    // se ele ainda não tem um). NÃO cria cliente: sem casar por nome (regra do
    // relatório oficial) criaria duplicado de cliente cadastrado à mão sem
    // código; quem cria cadastro é o relatório oficial. Em 10/2026 todos os 296
    // já estavam no app pelo código.
    const clientes = await pool.query(
      `/* reativacao:clientes-import */ SELECT id, codigo_oficial, regexp_replace(coalesce(documento, ''), '\\D', '', 'g') AS doc FROM clientes`);
    const porCodigo = new Map();
    const porDoc = new Map();
    for (const c of clientes.rows) {
      if (c.codigo_oficial) porCodigo.set(String(c.codigo_oficial), c);
      if (c.doc && c.doc.length >= 11 && !porDoc.has(c.doc)) porDoc.set(c.doc, c);
    }
    let codigosNovos = 0;
    for (const v of validos) {
      const existente = porCodigo.get(v.codigo);
      if (existente) { v.clienteId = existente.id; continue; }
      const doc = soDigitos(v.documento);
      const peloDoc = doc.length >= 11 ? porDoc.get(doc) : null;
      if (peloDoc && !peloDoc.codigo_oficial) {
        await pool.query('/* reativacao:codigo-pelo-cnpj */ UPDATE clientes SET codigo_oficial = $1 WHERE id = $2 AND codigo_oficial IS NULL', [v.codigo, peloDoc.id]);
        peloDoc.codigo_oficial = v.codigo;
        porCodigo.set(v.codigo, peloDoc);
        v.clienteId = peloDoc.id;
        codigosNovos++;
        continue;
      }
      v.clienteId = null; // fica na foto; entra na lista quando o relatório oficial trouxer o cliente
    }

    client = await pool.connect();
    await client.query('BEGIN');
    // Painel e e-mail ao mesmo tempo: um de cada vez, e a data conferida de novo
    // aqui dentro (senão o mais velho podia gravar por último)
    await client.query(`/* reativacao:trava */ SELECT pg_advisory_xact_lock(hashtext('reativacao-importar'))`);
    const naTrava = await client.query(`/* reativacao:meta */ SELECT valor FROM configuracoes WHERE chave = $1`, [CHAVE_RELATORIO]);
    const dataNaTrava = naTrava.rows[0] && naTrava.rows[0].valor && naTrava.rows[0].valor.data;
    if (dataNaTrava && dataNaTrava > dataRelatorio) {
      await client.query('ROLLBACK');
      return { status: 200, json: { ok: true, ignorado: true, aviso: `Relatório de ${dataRelatorio} é mais antigo que o já importado (${dataNaTrava}) — nada mudou.` } };
    }
    await client.query('/* reativacao:limpar */ DELETE FROM clientes_sem_compra');
    await client.query(
      `/* reativacao:gravar */
       INSERT INTO clientes_sem_compra (codigo_oficial, cliente_id, data_relatorio, meses_sem_compra, mes_ultima_compra,
         fat_12m, grupo, matriz, telefone, cidade, uf, gestor)
       SELECT u.codigo, u.cliente_id, $1::date, u.meses, u.mes, u.fat, u.grupo, u.matriz, u.telefone, u.cidade, u.uf, u.gestor
       FROM UNNEST($2::text[], $3::int[], $4::int[], $5::date[], $6::numeric[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[])
         AS u(codigo, cliente_id, meses, mes, fat, grupo, matriz, telefone, cidade, uf, gestor)`,
      [dataRelatorio,
        validos.map(v => v.codigo), validos.map(v => v.clienteId), validos.map(v => v.meses), validos.map(v => v.mes),
        validos.map(v => v.fat), validos.map(v => v.grupo), validos.map(v => v.matriz), validos.map(v => v.telefone),
        validos.map(v => v.cidade), validos.map(v => v.uf), validos.map(v => v.gestor)]);
    const meta = {
      data: dataRelatorio,
      periodo_inicio: RE_DIA.test(String(periodoInicio || '')) ? periodoInicio : null,
      periodo_fim: RE_DIA.test(String(periodoFim || '')) ? periodoFim : null,
      total: validos.length,
    };
    await client.query(
      `/* reativacao:gravar-meta */
       INSERT INTO configuracoes (chave, valor, atualizado_em) VALUES ($1, $2, now())
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`,
      [CHAVE_RELATORIO, JSON.stringify(meta)]);
    await client.query('COMMIT');

    const amarelo = validos.filter(v => v.meses >= 3 && v.meses <= 5).length;
    const vermelho = validos.filter(v => v.meses >= 6).length;
    const semCliente = validos.filter(v => !v.clienteId).length;
    console.log(`Clientes sem compra (${dataRelatorio}) importado: ${validos.length} cliente(s), ${semCliente} fora do app, por ${usuario ? usuario.email : '?'}.`);
    await registrarImportacao(usuario && usuario.id, 'reativacao/importar', validos.length);
    await avisarImportacao('clientes-sem-compra', `${amarelo + vermelho} para reativar · ${amarelo} de 3 a 5 meses, ${vermelho} de 6 a 12`);
    return { status: 200, json: { ok: true, total: validos.length, amarelo, vermelho, codigosNovos, semCliente } };
  } catch (e) {
    if (client) { try { await client.query('ROLLBACK'); } catch (err) { console.error('Erro no rollback:', err); } }
    console.error(e);
    return { status: 500, json: { erro: 'Erro ao importar o relatório de clientes sem compra.' } };
  } finally {
    if (client) client.release();
  }
}

router.get('/', async (req, res) => {
  try {
    const hoje = hojeBrasil();
    const meta = await pool.query(`/* reativacao:meta */ SELECT valor FROM configuracoes WHERE chave = $1`, [CHAVE_RELATORIO]);
    const relatorio = meta.rows[0] ? meta.rows[0].valor : null;
    if (!relatorio || !relatorio.data) return res.json({ hoje, relatorio: null, clientes: [] });
    // sem período no título: os 12 meses antes do relatório
    const inicioPeriodo = relatorio.periodo_inicio || somarDias(relatorio.data, -365);

    const [clientes, foto, oficial, app, fatAnterior, adiamentos, salesforce, metaSf, recuperados] = await Promise.all([
      pool.query(
        `/* reativacao:clientes */
         SELECT c.id, c.nome, c.documento, c.codigo_oficial, c.classificatorio_tipo, f.municipio, f.uf
         FROM clientes c LEFT JOIN cliente_cnpj_ficha f ON f.cliente_id = c.id`),
      pool.query(
        `/* reativacao:foto */
         SELECT codigo_oficial, cliente_id, to_char(mes_ultima_compra, 'YYYY-MM') AS mes, fat_12m, grupo, telefone, cidade, uf
         FROM clientes_sem_compra WHERE cliente_id IS NOT NULL`),
      pool.query(
        `/* reativacao:ultima-oficial */
         SELECT cliente_codigo_oficial AS codigo, max(COALESCE(data_implantacao, data_faturamento))::text AS ultima
         FROM pedidos_oficiais_itens WHERE length(nr_pedido) <= 6 GROUP BY 1`),
      pool.query(
        `/* reativacao:ultima-app */
         SELECT ped.cliente_id, max(${sqlDiaDoPedido()})::text AS ultima
         FROM pedidos ped WHERE ped.cliente_id IS NOT NULL AND ${SQL_PEDIDO_APP_VALIDO} GROUP BY 1`),
      // pra quem está fora do relatório (mais de 12 meses): quanto comprou no
      // último ano em que comprou - o "comprava R$ X/ano" da lista
      pool.query(
        `/* reativacao:fat-ultimo-ano */
         WITH u AS (
           SELECT cliente_codigo_oficial AS codigo, max(data_faturamento) AS ultima
           FROM pedidos_oficiais_itens poi WHERE ${sqlFaturadoDeFato('poi')} GROUP BY 1
         )
         SELECT u.codigo, sum(poi.valor) AS total
         FROM u JOIN pedidos_oficiais_itens poi ON poi.cliente_codigo_oficial = u.codigo
         WHERE ${sqlFaturadoDeFato('poi')} AND poi.data_faturamento > u.ultima - 365
         GROUP BY 1`),
      pool.query('/* reativacao:adiamentos */ SELECT cliente_id, tipo, desde::text AS desde, ate::text AS ate FROM reativacao_adiamentos'),
      // relatório "Todas Contas" do Salesforce: última compra com QUALQUER
      // vendedor, dono da conta e telefone (routes/contasSalesforce.js)
      pool.query(
        `/* reativacao:salesforce */
         SELECT cliente_id, proprietario, situacao, de_outro_vendedor, ultima_compra::text AS ultima_compra, telefone, email, cidade, uf
         FROM contas_salesforce WHERE cliente_id IS NOT NULL`),
      pool.query(`/* reativacao:meta */ SELECT valor FROM configuracoes WHERE chave = $1`, [CHAVE_CONTAS_SF]),
      // placar "Recuperados": inativo no Salesforce que pediu depois do dia em
      // que entrou na lista (entrada do pedido sem a série de 7 dígitos, ou
      // pedido do app); valor = o que entrou no ERP depois desse dia
      pool.query(
        `/* reativacao:recuperados */
         SELECT a.cliente_id, c.nome, a.desde::text AS desde, a.proprietario,
                (SELECT min(COALESCE(p.data_implantacao, p.data_faturamento)) FROM pedidos_oficiais_itens p
                 WHERE p.cliente_codigo_oficial = c.codigo_oficial AND length(p.nr_pedido) <= 6
                   AND COALESCE(p.data_implantacao, p.data_faturamento) > a.desde)::text AS primeira_oficial,
                (SELECT sum(p.valor) FROM pedidos_oficiais_itens p
                 WHERE p.cliente_codigo_oficial = c.codigo_oficial AND length(p.nr_pedido) <= 6
                   AND COALESCE(p.data_implantacao, p.data_faturamento) > a.desde) AS valor,
                (SELECT min(${sqlDiaDoPedido()}) FROM pedidos ped
                 WHERE ped.cliente_id = a.cliente_id AND ${SQL_PEDIDO_APP_VALIDO} AND ${sqlDiaDoPedido()} > a.desde)::text AS primeira_app
         FROM reativacao_alvos a JOIN clientes c ON c.id = a.cliente_id`),
    ]);

    const ultimaOficial = new Map(oficial.rows.map(l => [String(l.codigo), l.ultima && diaISO(l.ultima)]));
    const ultimaApp = new Map(app.rows.map(l => [String(l.cliente_id), l.ultima && diaISO(l.ultima)]));
    const fatUltimoAno = new Map(fatAnterior.rows.map(l => [String(l.codigo), Number(l.total)]));
    const fotoPorCliente = new Map(foto.rows.map(l => [String(l.cliente_id), l]));
    const adiamentoPorCliente = new Map(adiamentos.rows.map(a => [String(a.cliente_id), a]));
    const sfPorCliente = new Map(salesforce.rows.map(l => [String(l.cliente_id), l]));
    const principal = metaSf.rows[0] && metaSf.rows[0].valor ? metaSf.rows[0].valor.principal : null;
    const mesHoje = indiceMes(hoje);

    const lista = [];
    for (const c of clientes.rows) {
      const id = String(c.id);
      const sf = sfPorCliente.get(id);
      // ativo com outro vendedor: compra, só que não com o representante
      if (sf && sf.de_outro_vendedor) continue;
      const naFoto = fotoPorCliente.get(id);
      const ultimaSf = sf && sf.ultima_compra ? diaISO(sf.ultima_compra) : null;
      const ultimaConhecida = [c.codigo_oficial ? ultimaOficial.get(String(c.codigo_oficial)) : null, ultimaApp.get(id),
        ultimaSf && ultimaSf <= hoje ? ultimaSf : null].filter(Boolean).sort().pop() || null;
      let mes;
      if (naFoto) {
        mes = naFoto.mes;
        if (ultimaConhecida && ultimaConhecida.slice(0, 7) > mes) mes = ultimaConhecida.slice(0, 7);
      } else {
        // fora do relatório: só quem tem código do ERP (é da carteira do
        // representante) e comprou antes do período - sem compra conhecida não
        // dá pra dizer há quanto tempo, e compra dentro do período sem estar no
        // relatório é outro caso (cliente novo depois do relatório, outro
        // representante) - a não ser que o Salesforce diga que a conta está
        // Inativa (a compra no período foi com outro vendedor)
        const inativaNoSf = sf && sf.situacao === 'Inativo';
        if (!c.codigo_oficial || !ultimaConhecida || (ultimaConhecida >= inicioPeriodo && !inativaNoSf)) continue;
        mes = ultimaConhecida.slice(0, 7);
      }
      const faixa = faixaDosMeses(mesHoje - indiceMes(mes));
      if (!faixa) continue;
      const adiamento = adiamentoPorCliente.get(id);
      if (adiamento && adiamento.tipo === 'nao_reativar' && !(ultimaConhecida && ultimaConhecida > diaISO(adiamento.desde))) continue;
      lista.push({
        cliente_id: c.id,
        nome: c.nome,
        documento: c.documento || null,
        codigo_oficial: c.codigo_oficial || null,
        classificatorio_tipo: c.classificatorio_tipo || null,
        no_relatorio: !!naFoto,
        mes_ultima_compra: mes,
        // dia exato quando a compra mais nova é a que o app conhece
        ultima_compra: ultimaConhecida && ultimaConhecida.slice(0, 7) === mes ? ultimaConhecida : null,
        fat: naFoto ? (naFoto.fat_12m != null ? Number(naFoto.fat_12m) : null) : (fatUltimoAno.get(String(c.codigo_oficial)) || null),
        fat_origem: naFoto ? 'erp_12m' : 'ultimo_ano',
        grupo: naFoto ? naFoto.grupo : null,
        telefone: (naFoto && naFoto.telefone) || (sf && primeiroTelefone(sf.telefone)) || null,
        email: sf ? sf.email || null : null,
        // conta de outro vendedor no Salesforce, parada: dá pra trazer pra carteira
        era_de: sf && sf.proprietario && principal && sf.proprietario !== principal ? sf.proprietario : null,
        cidade: (naFoto && naFoto.cidade) || c.municipio || (sf && sf.cidade) || null,
        uf: (naFoto && naFoto.uf) || c.uf || (sf && sf.uf) || null,
        adiado_ate: adiamento && adiamento.tipo === 'ja_falei' ? diaISO(adiamento.ate) : null,
      });
    }
    // dentro da faixa, quem comprava mais primeiro (vale mais reativar); sem
    // valor conhecido (conta que era de outro vendedor), quem parou há menos tempo
    lista.sort((a, b) => ORDEM_FAIXA[faixaDosMeses(mesHoje - indiceMes(a.mes_ultima_compra))]
      - ORDEM_FAIXA[faixaDosMeses(mesHoje - indiceMes(b.mes_ultima_compra))]
      || (b.fat || 0) - (a.fat || 0) || String(b.mes_ultima_compra).localeCompare(String(a.mes_ultima_compra))
      || String(a.nome).localeCompare(String(b.nome)));
    const recuperadosLista = [];
    for (const r of recuperados.rows) {
      const dia = [r.primeira_oficial && diaISO(r.primeira_oficial), r.primeira_app && diaISO(r.primeira_app)]
        .filter(d => d && d <= hoje).sort()[0];
      if (!dia) continue;
      recuperadosLista.push({ cliente_id: r.cliente_id, nome: r.nome, desde: diaISO(r.desde), dia,
        valor: r.valor != null ? Math.round(Number(r.valor) * 100) / 100 : 0, era_de: r.proprietario && principal && r.proprietario !== principal ? r.proprietario : null });
    }
    recuperadosLista.sort((a, b) => b.dia.localeCompare(a.dia));
    const desdeAlvos = recuperados.rows.map(r => diaISO(r.desde)).filter(Boolean).sort()[0] || null;
    res.json({ hoje, relatorio, clientes: lista,
      recuperados: { desde: desdeAlvos, alvos: recuperados.rows.length, clientes: recuperadosLista } });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao montar a lista de clientes para reativar.' });
  }
});

// "Já falei" (30 dias) ou "Não reativar" (até comprar de novo). `em`
// (AAAA-MM-DD) = dia do toque - a fila offline pode mandar dias depois; vale
// no máximo 30 dias pra trás e nunca no futuro.
router.post('/:id/adiar', async (req, res) => {
  try {
    const hoje = hojeBrasil();
    const tipo = req.body && req.body.tipo === 'nao_reativar' ? 'nao_reativar' : 'ja_falei';
    const em = String((req.body && req.body.em) || '');
    const recente = RE_DIA.test(em) && em <= hoje && diasEntre(em, hoje) <= 30;
    const desde = recente ? em : hoje;
    const ate = tipo === 'ja_falei' ? somarDias(desde, ADIAR_DIAS) : null;
    const cliente = await pool.query('/* reativacao:cliente-existe */ SELECT id FROM clientes WHERE id = $1', [req.params.id]);
    if (cliente.rows.length === 0) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    // "Já falei" nunca encurta um "Já falei" mais longo nem desfaz um "Não
    // reativar" do mesmo dia ou de depois (o da fila offline chega atrasado);
    // depois de um "Não reativar" que já perdeu efeito (o cliente comprou e
    // voltou pra lista), vale o "Já falei" novo
    const r = await pool.query(
      `/* reativacao:adiar */
       INSERT INTO reativacao_adiamentos (cliente_id, tipo, desde, ate, usuario_id) VALUES ($1, $2, $3::date, $4::date, $5)
       ON CONFLICT (cliente_id) DO UPDATE SET
         tipo = CASE WHEN reativacao_adiamentos.tipo = 'nao_reativar' AND EXCLUDED.tipo = 'ja_falei' AND EXCLUDED.desde <= reativacao_adiamentos.desde THEN reativacao_adiamentos.tipo ELSE EXCLUDED.tipo END,
         desde = CASE WHEN reativacao_adiamentos.tipo = 'nao_reativar' AND EXCLUDED.tipo = 'ja_falei' AND EXCLUDED.desde <= reativacao_adiamentos.desde THEN reativacao_adiamentos.desde ELSE EXCLUDED.desde END,
         ate = CASE WHEN reativacao_adiamentos.tipo = 'nao_reativar' AND EXCLUDED.tipo = 'ja_falei' AND EXCLUDED.desde <= reativacao_adiamentos.desde THEN NULL
                    WHEN EXCLUDED.tipo = 'nao_reativar' THEN NULL
                    WHEN reativacao_adiamentos.tipo = 'nao_reativar' THEN EXCLUDED.ate
                    ELSE GREATEST(reativacao_adiamentos.ate, EXCLUDED.ate) END,
         usuario_id = EXCLUDED.usuario_id, criado_em = now()
       RETURNING tipo, ate::text AS ate`,
      [req.params.id, tipo, desde, ate, req.usuario ? req.usuario.id : null]);
    const linha = r.rows[0] || {};
    res.json({ cliente_id: Number(req.params.id), tipo: linha.tipo || tipo, adiado_ate: linha.ate ? diaISO(linha.ate) : null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao tirar o cliente da lista de reativação.' });
  }
});

module.exports = router;
module.exports.importarClientesSemCompra = importarClientesSemCompra;
module.exports.faixaDosMeses = faixaDosMeses;
