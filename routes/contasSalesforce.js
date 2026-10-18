// Importação do relatório "Todas Contas - Representante" do Salesforce (Painel,
// só admin; leitura da planilha em importadores.js - lerContasSalesforce).
// Rota: POST /api/reativacao/contas-salesforce (routes/reativacao.js).
//
// Decisões do usuário (10/2026):
//  - conta ATIVA de outro vendedor (Rodrigo, Marina...) não conta na carteira:
//    sai das listas de oportunidade (de_outro_vendedor), continua na busca;
//  - conta INATIVA de qualquer vendedor está "pro jogo": a que não está no app
//    vira cliente (código do ERP, CNPJ, classificatório pela política) e entra
//    no "Para reativar" com a última compra do Salesforce - a ficha de CNPJ e a
//    posição pelo endereço se completam sozinhas de madrugada;
//  - inativo entra no placar "Recuperados" (reativacao_alvos) a partir do dia
//    da importação.
// A foto (contas_salesforce) é trocada inteira a cada importação.
const { pool, registrarImportacao } = require('../db');
const { limparNomeCliente } = require('../clientMatcher');
const { classificatorioDaPolitica } = require('./lib/politicaComercial');
const { proprietarioPrincipal } = require('./lib/contasSalesforce');

const CHAVE_RELATORIO = 'contas_salesforce_relatorio';
const MAX_CONTAS = 5000;
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
const soDigitos = (s) => String(s || '').replace(/\D/g, '');
// CNPJ/CPF sem máscara vem como NÚMERO na planilha e perde o zero da frente
// ("01234567000190" -> 1234567000190): completa e formata; só 11 ou 14 dígitos
function documentoNormalizado(texto) {
  let d = soDigitos(texto);
  if (d.length === 12 || d.length === 13) d = d.padStart(14, '0');
  else if (d.length === 9 || d.length === 10) d = d.padStart(11, '0');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return null;
}
// só "Ativo" e "Inativo" valem; outro texto (vazio, "Prospect"...) fica sem
// situação: não cria cliente, não entra no placar nem vira "outro vendedor"
function situacaoDaConta(texto) {
  const t = String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase();
  return t === 'ATIVO' ? 'Ativo' : t === 'INATIVO' ? 'Inativo' : null;
}
// mesma normalização do clientMatcher (comparação tolerante: sem pontuação)
const chaveNome = (s) => limparNomeCliente(s).toUpperCase().replace(/[.,\s]+/g, ' ').trim();

function hojeBrasil() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

function primeiroNome(nome) {
  return String(nome || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toUpperCase().split(/\s+/)[0] || '';
}

function ehContaDoRepresentante(c) {
  return /^REPRESENTANTE/i.test(String(c.classificatorio || '').trim());
}

// De quem é a base da conta: região "VENDAS INTERNAS" = telemarketing da Cortag
// (pela política, a conta inativa passa do representante pra outro e, depois,
// pro telemarketing); senão, o proprietário.
function baseDaConta(c) {
  if (ehContaDoRepresentante(c)) return null;
  if (/VENDAS\s*INTERNAS/i.test(String(c.regiao || '').normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) return 'Telemarketing';
  return c.proprietario || null;
}

// "Varejo Exclusive (15)" -> { tipo: 'Varejo Exclusive', desconto: 15 } pela
// política (o número do Salesforce é o da política antiga); "Sem Classificatório",
// "Representante" e o que não está na política ficam sem classificatório.
function classificatorioDaConta(texto) {
  const tipo = String(texto || '').replace(/\s*\(\d+\)\s*$/, '').trim();
  const c = classificatorioDaPolitica(tipo);
  return c ? { tipo: c.tipo, desconto: c.pct } : null;
}

async function importarContasSalesforce(dados, usuario) {
  const entrada = dados && Array.isArray(dados.contas) ? dados.contas : null;
  if (!entrada || entrada.length === 0 || entrada.length > MAX_CONTAS) return { status: 400, json: { erro: 'Envie { contas: [...] }.' } };
  const texto = (v, max = 300) => (v == null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));
  const contas = [];
  const vistos = new Set();
  for (const c of entrada) {
    const codigo = String((c && c.codigo_oficial) || '').trim();
    const nome = limparNomeCliente(texto(c && c.nome));
    if (!/^\d{1,12}$/.test(codigo) || !nome || vistos.has(codigo)) continue;
    vistos.add(codigo);
    const ultima = String((c && c.ultima_compra) || '');
    contas.push({
      codigo, nome,
      documento: documentoNormalizado(c.documento),
      proprietario: texto(c.proprietario, 100),
      regiao: texto(c.regiao, 60),
      situacao: situacaoDaConta(c.situacao),
      ultima: RE_DIA.test(ultima) ? ultima : null,
      cidade: texto(c.cidade, 100), uf: texto(c.uf, 2),
      telefone: texto(c.telefone, 100), email: texto(c.email, 200),
      classificatorio: texto(c.classificatorio, 100), transportadora: texto(c.transportadora, 150),
    });
  }
  if (contas.length === 0) return { status: 400, json: { erro: 'Nenhuma conta válida no relatório.' } };
  const principal = proprietarioPrincipal(contas);
  // Gerência (gerente de vendas/regional, supervisor - Vilmar em 10/2026) também
  // aparece como proprietário no Salesforce e não é outro vendedor: é quem está
  // na coluna "Gestor" da planilha Classificatório do ERP (primeiro nome)
  let gestores = new Set();
  try {
    const g = await pool.query(`/* contas-sf:gestores */ SELECT DISTINCT gestor FROM cliente_classificatorio_erp WHERE gestor IS NOT NULL`);
    gestores = new Set(g.rows.map(r => primeiroNome(r.gestor)).filter(Boolean));
  } catch (e) { console.error('Gestores do Classificatório:', e.message); }
  for (const c of contas) {
    // classificatório "Representante" = a conta da própria representação (a
    // RUSSO'S): nunca é "de outro vendedor"; nem conta da gerência
    c.daGestao = !!c.proprietario && gestores.has(primeiroNome(c.proprietario));
    c.deOutro = c.situacao === 'Ativo' && !!c.proprietario && c.proprietario !== principal && !ehContaDoRepresentante(c) && !c.daGestao;
    c.base = c.daGestao ? null : baseDaConta(c);
  }
  const hoje = hojeBrasil();

  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query(`/* contas-sf:trava */ SELECT pg_advisory_xact_lock(hashtext('contas-salesforce-importar'))`);

    // cliente pelo código do ERP; senão pelo CNPJ (o código passa a ser dele se
    // ainda não tem); senão pelo nome, só cliente sem código e sem CNPJ e só se
    // for um (filiais com o mesmo nome são clientes diferentes)
    const clientes = await client.query(
      `/* contas-sf:clientes */ SELECT id, nome, codigo_oficial, documento,
              regexp_replace(coalesce(documento, ''), '\\D', '', 'g') AS doc FROM clientes`);
    const porCodigo = new Map();
    const porDoc = new Map();
    const semChavePorNome = new Map();
    for (const c of clientes.rows) {
      if (c.codigo_oficial) porCodigo.set(String(c.codigo_oficial), c);
      if (c.doc && c.doc.length >= 11 && !porDoc.has(c.doc)) porDoc.set(c.doc, c);
      if (!c.codigo_oficial && !c.doc) {
        const k = chaveNome(c.nome);
        semChavePorNome.set(k, semChavePorNome.has(k) ? null : c);
      }
    }
    let codigosNovos = 0;
    let documentosNovos = 0;
    const criar = [];
    for (const c of contas) {
      const doc = soDigitos(c.documento);
      let cli = porCodigo.get(c.codigo);
      if (!cli && doc.length >= 11) {
        const peloDoc = porDoc.get(doc);
        if (peloDoc && !peloDoc.codigo_oficial) cli = peloDoc;
      }
      if (!cli) {
        const peloNome = semChavePorNome.get(chaveNome(c.nome));
        if (peloNome && !peloNome.codigo_oficial) cli = peloNome;
      }
      if (cli) {
        c.clienteId = cli.id;
        if (!cli.codigo_oficial) {
          await client.query('/* contas-sf:codigo */ UPDATE clientes SET codigo_oficial = $1 WHERE id = $2 AND codigo_oficial IS NULL', [c.codigo, cli.id]);
          cli.codigo_oficial = c.codigo;
          porCodigo.set(c.codigo, cli);
          codigosNovos++;
        }
        // cliente sem CNPJ ganha o do Salesforce (a ficha de CNPJ se completa
        // de madrugada) - se nenhum outro cliente já tem esse CNPJ
        if (!cli.doc && doc.length >= 11 && !porDoc.has(doc)) {
          await client.query('/* contas-sf:documento */ UPDATE clientes SET documento = $1 WHERE id = $2 AND documento IS NULL', [c.documento, cli.id]);
          cli.doc = doc;
          porDoc.set(doc, cli);
          documentosNovos++;
        }
        continue;
      }
      // fora do app: só a inativa vira cliente (a ativa de outro vendedor não é da carteira)
      if (c.situacao === 'Inativo' && !(doc.length >= 11 && porDoc.has(doc))) criar.push(c);
    }

    if (criar.length) {
      const classi = criar.map(c => classificatorioDaConta(c.classificatorio));
      const novos = await client.query(
        `/* contas-sf:criar */
         INSERT INTO clientes (nome, documento, codigo_oficial, classificatorio_tipo, classificatorio_desconto, classificatorio_atualizado_em)
         SELECT u.nome, u.documento, u.codigo, u.tipo, u.desconto, NULL::date
         FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::numeric[]) AS u(nome, documento, codigo, tipo, desconto)
         ON CONFLICT DO NOTHING
         RETURNING id, codigo_oficial`,
        [criar.map(c => c.nome), criar.map(c => c.documento), criar.map(c => c.codigo),
          classi.map(x => (x ? x.tipo : null)), classi.map(x => (x ? x.desconto : null))]);
      const idPorCodigo = new Map(novos.rows.map(r => [String(r.codigo_oficial), r.id]));
      for (const c of criar) c.clienteId = idPorCodigo.get(c.codigo) || null;
    }
    const criados = criar.filter(c => c.clienteId).length;

    await client.query('/* contas-sf:limpar */ DELETE FROM contas_salesforce');
    await client.query(
      `/* contas-sf:gravar */
       INSERT INTO contas_salesforce (codigo_oficial, cliente_id, data_relatorio, nome, documento, proprietario, situacao,
         de_outro_vendedor, ultima_compra, cidade, uf, telefone, email, classificatorio, transportadora, regiao, base)
       SELECT u.codigo, u.cliente_id, $1::date, u.nome, u.documento, u.proprietario, u.situacao, u.de_outro, u.ultima,
              u.cidade, u.uf, u.telefone, u.email, u.classificatorio, u.transportadora, u.regiao, u.base
       FROM UNNEST($2::text[], $3::int[], $4::text[], $5::text[], $6::text[], $7::text[], $8::bool[], $9::date[],
                   $10::text[], $11::text[], $12::text[], $13::text[], $14::text[], $15::text[], $16::text[], $17::text[])
         AS u(codigo, cliente_id, nome, documento, proprietario, situacao, de_outro, ultima, cidade, uf, telefone, email, classificatorio, transportadora, regiao, base)`,
      [hoje, contas.map(c => c.codigo), contas.map(c => c.clienteId || null), contas.map(c => c.nome), contas.map(c => c.documento),
        contas.map(c => c.proprietario), contas.map(c => c.situacao), contas.map(c => c.deOutro), contas.map(c => c.ultima),
        contas.map(c => c.cidade), contas.map(c => c.uf), contas.map(c => c.telefone), contas.map(c => c.email),
        contas.map(c => c.classificatorio), contas.map(c => c.transportadora), contas.map(c => c.regiao), contas.map(c => c.base)]);
    // placar: inativo entra uma vez só (o "desde" é o da 1ª importação em que apareceu inativo)
    const alvos = contas.filter(c => c.situacao === 'Inativo' && c.clienteId);
    if (alvos.length) {
      await client.query(
        `/* contas-sf:alvos */
         INSERT INTO reativacao_alvos (cliente_id, desde, proprietario, ultima_compra_antes)
         SELECT u.cliente_id, $1::date, u.proprietario, u.ultima
         FROM UNNEST($2::int[], $3::text[], $4::date[]) AS u(cliente_id, proprietario, ultima)
         ON CONFLICT (cliente_id) DO NOTHING`,
        [hoje, alvos.map(c => c.clienteId), alvos.map(c => c.base), alvos.map(c => c.ultima)]);
    }
    const resumo = {
      data: hoje,
      principal,
      total: contas.length,
      ativos: contas.filter(c => c.situacao === 'Ativo').length,
      inativos: contas.filter(c => c.situacao === 'Inativo').length,
      deOutroVendedor: contas.filter(c => c.deOutro).length,
    };
    await client.query(
      `/* contas-sf:gravar-meta */
       INSERT INTO configuracoes (chave, valor, atualizado_em) VALUES ($1, $2, now())
       ON CONFLICT (chave) DO UPDATE SET valor = EXCLUDED.valor, atualizado_em = now()`,
      [CHAVE_RELATORIO, JSON.stringify(resumo)]);
    await client.query('COMMIT');

    const foraDoApp = contas.filter(c => !c.clienteId).length;
    console.log(`Contas do Salesforce importadas: ${contas.length} conta(s), ${criados} cliente(s) criado(s), ${resumo.deOutroVendedor} de outro vendedor, por ${usuario ? usuario.email : '?'}.`);
    await registrarImportacao(usuario && usuario.id, 'reativacao/contas-salesforce', contas.length);
    return { status: 200, json: { ok: true, ...resumo, criados, codigosNovos, documentosNovos, foraDoApp } };
  } catch (e) {
    if (client) { try { await client.query('ROLLBACK'); } catch (err) { console.error('Erro no rollback:', err); } }
    console.error(e);
    return { status: 500, json: { erro: 'Erro ao importar o relatório de contas do Salesforce.' } };
  } finally {
    if (client) client.release();
  }
}

module.exports = { importarContasSalesforce, classificatorioDaConta, baseDaConta, documentoNormalizado, situacaoDaConta, CHAVE_RELATORIO };
