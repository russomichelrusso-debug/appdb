// Inadimplência: títulos vencidos e não pagos, pelo Relatório de Inadimplência
// do ERP (noreply@cortag.com.br, "Previa Relatório de Inadimplência Período
// ...", sem dia fixo - chega pela importação por e-mail ou pelo Painel;
// leitura em importadores.js).
//
// Cada relatório é a foto da inadimplência NA DATA DO FIM DO PERÍODO: a
// importação troca a lista inteira (título que sumiu = pago) e relatório com
// período mais antigo que o importado não muda nada. Os títulos entre um
// relatório e outro podem já ter sido pagos - a tela mostra sempre "posição
// de DD/MM".
//
// Só alerta: não impede pedido (quem bloqueia é o financeiro da Cortag).
const express = require('express');
const router = express.Router();
const { pool, registrarImportacao } = require('../db');
const { avisarImportacao } = require('./lib/novidades');
const { diaISO } = require('./lib/ritmoCompra');

const CHAVE_RELATORIO = 'inadimplencia_relatorio';
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
// cabe no corpo de 1 MB do Painel (~250 bytes por título); o real de 08/2026 tinha 42
const MAX_TITULOS = 3000;

function brl(v) {
  return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Só admin pelo Painel (mesma regra do Classificatório e dos clientes sem
// compra); a importação por e-mail chama a função direto.
router.post('/importar', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode importar o relatório de inadimplência.' });
  const r = await importarInadimplencia(req.body || {}, req.usuario);
  res.status(r.status).json(r.json);
});

// { periodoInicio, periodoFim, titulos } (importadores.lerInadimplencia) ->
// { status, json }. Relatório sem nenhum título também vale: ninguém em atraso.
async function importarInadimplencia(dados, usuario) {
  const { periodoInicio, periodoFim, titulos } = dados || {};
  if (!RE_DIA.test(String(periodoFim || ''))) return { status: 400, json: { erro: 'Fim do período do relatório inválido.' } };
  if (!Array.isArray(titulos) || titulos.length > MAX_TITULOS) return { status: 400, json: { erro: 'Envie { periodoFim, titulos: [...] }.' } };
  const texto = (v, max = 300) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
  const validos = [];
  const vistos = new Set();
  for (const t of titulos) {
    const titulo = texto(t && t.titulo, 30);
    const parcela = texto(t && t.parcela, 10) || '';
    const codigo = String((t && t.codigo_oficial) || '').trim();
    const saldo = Number(t && t.saldo);
    if (!titulo || !/^\d{1,12}$/.test(codigo) || !RE_DIA.test(String(t.vencimento || '')) || !Number.isFinite(saldo)) continue;
    const chave = `${titulo}::${parcela}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    const liquido = Number(t.valor_liquido);
    validos.push({
      titulo, parcela, codigo, saldo,
      nome: texto(t.cliente_nome), cidade: texto(t.cidade, 100), uf: texto(t.uf, 2),
      emissao: RE_DIA.test(String(t.emissao || '')) ? t.emissao : null,
      vencimento: t.vencimento,
      liquido: Number.isFinite(liquido) ? liquido : null,
      terceirizada: !!t.cobranca_terceirizada,
    });
  }
  if (titulos.length > 0 && validos.length === 0) return { status: 400, json: { erro: 'Nenhum título válido no relatório.' } };

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    // Painel e e-mail ao mesmo tempo (o e-mail costuma vir repetido): um de
    // cada vez, e a data conferida aqui dentro
    await client.query(`/* inadimplencia:trava */ SELECT pg_advisory_xact_lock(hashtext('inadimplencia-importar'))`);
    const atual = await client.query(`/* inadimplencia:meta */ SELECT valor FROM configuracoes WHERE chave = $1`, [CHAVE_RELATORIO]);
    const metaAtual = (atual.rows[0] && atual.rows[0].valor) || {};
    const fimAtual = metaAtual.periodo_fim;
    if (fimAtual && fimAtual > periodoFim) {
      await client.query('ROLLBACK');
      return { status: 200, json: { ok: true, ignorado: true, aviso: `Relatório até ${periodoFim} é mais antigo que o já importado (até ${fimAtual}) — nada mudou.` } };
    }
    // cliente só pelo código do ERP (o relatório não traz CNPJ); quem não está
    // no app fica com cliente_id vazio e aparece pelo nome do relatório
    const codigos = [...new Set(validos.map(v => v.codigo))];
    const clientes = codigos.length
      ? await client.query('/* inadimplencia:clientes */ SELECT id, codigo_oficial FROM clientes WHERE codigo_oficial = ANY($1::text[])', [codigos])
      : { rows: [] };
    const idPorCodigo = new Map(clientes.rows.map(c => [String(c.codigo_oficial), c.id]));
    await client.query('/* inadimplencia:limpar */ DELETE FROM titulos_inadimplentes');
    if (validos.length) {
      await client.query(
        `/* inadimplencia:gravar */
         INSERT INTO titulos_inadimplentes (titulo, parcela, codigo_oficial, cliente_id, cliente_nome, cidade, uf,
           emissao, vencimento, saldo, valor_liquido, cobranca_terceirizada, data_relatorio)
         SELECT u.titulo, u.parcela, u.codigo, u.cliente_id, u.nome, u.cidade, u.uf, u.emissao, u.vencimento,
           u.saldo, u.liquido, u.terceirizada, $1::date
         FROM UNNEST($2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[], $8::text[], $9::date[],
           $10::date[], $11::numeric[], $12::numeric[], $13::boolean[])
           AS u(titulo, parcela, codigo, cliente_id, nome, cidade, uf, emissao, vencimento, saldo, liquido, terceirizada)`,
        [periodoFim,
          validos.map(v => v.titulo), validos.map(v => v.parcela), validos.map(v => v.codigo),
          validos.map(v => idPorCodigo.get(v.codigo) || null), validos.map(v => v.nome), validos.map(v => v.cidade),
          validos.map(v => v.uf), validos.map(v => v.emissao), validos.map(v => v.vencimento), validos.map(v => v.saldo),
          validos.map(v => v.liquido), validos.map(v => v.terceirizada)]);
    }
    const total = validos.reduce((s, v) => s + v.saldo, 0);
    const meta = {
      periodo_inicio: RE_DIA.test(String(periodoInicio || '')) ? periodoInicio : null,
      periodo_fim: periodoFim,
      titulos: validos.length,
      clientes: codigos.length,
      total: Math.round(total * 100) / 100,
    };
    await client.query(
      `/* inadimplencia:gravar-meta */
       INSERT INTO configuracoes (chave, valor, atualizado_em) VALUES ($1, $2, now())
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`,
      [CHAVE_RELATORIO, JSON.stringify(meta)]);
    await client.query('COMMIT');
    console.log(`Inadimplência (até ${periodoFim}) importada: ${validos.length} título(s) de ${codigos.length} cliente(s), por ${usuario ? usuario.email : '?'}.`);
    await registrarImportacao(usuario && usuario.id, 'inadimplencia/importar', validos.length);
    // o e-mail às vezes vem repetido (arquivo regerado, outro hash): mesmo
    // período e mesmos números regrava sem avisar de novo
    const repetido = fimAtual === periodoFim && metaAtual.titulos === meta.titulos && metaAtual.total === meta.total;
    if (!repetido) await avisarImportacao('inadimplencia', codigos.length
      ? `${codigos.length} cliente${codigos.length === 1 ? '' : 's'} · ${brl(total)} em atraso`
      : 'Nenhum título em atraso');
    return { status: 200, json: { ok: true, ...meta, semCliente: codigos.filter(c => !idPorCodigo.has(c)).length } };
  } catch (e) {
    if (client) { try { await client.query('ROLLBACK'); } catch (err) { console.error('Erro no rollback:', err); } }
    console.error(e);
    return { status: 500, json: { erro: 'Erro ao importar o relatório de inadimplência.' } };
  } finally {
    if (client) client.release();
  }
}

// Lista por cliente (maior valor em atraso primeiro), com os títulos. Datas
// saem como texto (AAAA-MM-DD) - nunca new Date() na tela.
router.get('/', async (req, res) => {
  try {
    const [meta, titulos] = await Promise.all([
      pool.query(`/* inadimplencia:meta */ SELECT valor FROM configuracoes WHERE chave = $1`, [CHAVE_RELATORIO]),
      pool.query(
        `/* inadimplencia:titulos */
         SELECT t.titulo, t.parcela, t.codigo_oficial, c.id AS cliente_id, COALESCE(c.nome, t.cliente_nome) AS nome,
                t.cidade, t.uf, t.emissao::text AS emissao, t.vencimento::text AS vencimento, t.saldo,
                t.cobranca_terceirizada
         FROM titulos_inadimplentes t
         -- cliente que ganhou o código do ERP depois da importação também abre
         LEFT JOIN clientes c ON c.id = COALESCE(t.cliente_id,
           (SELECT id FROM clientes WHERE codigo_oficial = t.codigo_oficial ORDER BY id LIMIT 1))
         ORDER BY t.vencimento, t.titulo, t.parcela`),
    ]);
    const porCliente = new Map();
    for (const t of titulos.rows) {
      const chave = String(t.codigo_oficial);
      if (!porCliente.has(chave)) {
        porCliente.set(chave, {
          cliente_id: t.cliente_id, codigo_oficial: t.codigo_oficial, nome: t.nome, cidade: t.cidade, uf: t.uf,
          total: 0, mais_antigo: null, cobranca_terceirizada: false, titulos: [],
        });
      }
      const c = porCliente.get(chave);
      c.total += Number(t.saldo);
      if (!c.mais_antigo || t.vencimento < c.mais_antigo) c.mais_antigo = diaISO(t.vencimento);
      c.cobranca_terceirizada = c.cobranca_terceirizada || t.cobranca_terceirizada;
      c.titulos.push({
        titulo: t.titulo, parcela: t.parcela, emissao: t.emissao ? diaISO(t.emissao) : null,
        vencimento: diaISO(t.vencimento), saldo: Number(t.saldo), cobranca_terceirizada: t.cobranca_terceirizada,
      });
    }
    const clientes = [...porCliente.values()]
      .map(c => ({ ...c, total: Math.round(c.total * 100) / 100 }))
      .sort((a, b) => b.total - a.total || String(a.nome).localeCompare(String(b.nome)));
    res.json({ relatorio: meta.rows[0] ? meta.rows[0].valor : null, clientes });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar a inadimplência.' });
  }
});

module.exports = router;
module.exports.importarInadimplencia = importarInadimplencia;
