// Importação automática por e-mail: um script do Google no Gmail que recebe
// os relatórios da Cortag (scripts/gmail-importacao/Codigo.gs) manda cada
// anexo pra cá e o app publica sozinho - mesma leitura da planilha do Painel
// (importadores.js) e mesma gravação das rotas de importação manual.
//
// Decisões do usuário (10/2026): publica DIRETO (sem confirmação), inclusive a
// Lista de Preços; arquivo recusado não avisa ninguém no app - o script marca
// o e-mail com "Cortag/Falhou" e o admin importa na mão. Chegam por e-mail:
//  - noreply@cortag.com.br: Carteira/Faturamento (Repres-*.xlsx, todo dia de
//    madrugada), Classificatório (DD.MM.AAAA_..._Classificatorio.xlsx) e
//    itens em falta (ESCE007-*.xlsx = previsão de estoque);
//  - vendas@cortag.com: LISTA PADRÃO ... SUL SUDESTE ... .xlsx (catálogo).
//
// Autenticação: não é login do Google, é a chave IMPORTACAO_EMAIL_CHAVE (Render)
// no cabeçalho X-Chave-Importacao - conferida no server.js ANTES de ler o
// corpo (até 25 MB), pra ninguém sem a chave fazer o servidor ler arquivo.
// O mesmo arquivo (hash) não é importado duas vezes.
const crypto = require('crypto');
const express = require('express');
const XLSX = require('@e965/xlsx');
const router = express.Router();
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const Importadores = require('../importadores');
const { importarRelatorioOficial } = require('./pedidosOficiais');
const { importarCatalogoPrecos } = require('./catalogoPrecos');
const { importarPrevisaoEstoque } = require('./previsaoEstoque');
const { importarClassificatorioErp } = require('./clientesClassificatorio');

const TAMANHO_MAX_BYTES = 10 * 1024 * 1024;
const USUARIO_EMAIL = { id: null, email: 'importação por e-mail', is_admin: true };
const ROTULO_TIPO = {
  relatorio: 'Relatório oficial',
  precos: 'Lista de Preços',
  classificatorio: 'Classificatório',
  previsao: 'Itens em falta (previsão de estoque)',
};

function chaveImportacaoValida(req) {
  const esperada = process.env.IMPORTACAO_EMAIL_CHAVE || '';
  if (esperada.length < 32) return false; // sem chave configurada, a rota fica fechada
  const recebida = req.get('X-Chave-Importacao') || '';
  // compara o hash (mesmo tamanho) em tempo constante
  const a = crypto.createHash('sha256').update(esperada).digest();
  const b = crypto.createHash('sha256').update(recebida).digest();
  return crypto.timingSafeEqual(a, b);
}

class Recusado extends Error {}

// Lê a planilha do tipo reconhecido e grava pelo mesmo caminho da importação
// manual. Devolve { status, json } da função de importação.
async function importarPorTipo(tipo, buffer, nomeArquivo) {
  if (tipo === 'relatorio') {
    const { itens, classificacoes, pendentesPagamento, titulosAvista } = Importadores.lerRelatorioOficial(XLSX, buffer);
    if (itens.length === 0 && pendentesPagamento === null && titulosAvista === null) {
      throw new Recusado('Nenhum item reconhecido nas abas "Carteira"/"Faturamento" desta planilha.');
    }
    return importarRelatorioOficial({
      itens, classificacoes,
      ...(pendentesPagamento !== null ? { pendentes_pagamento: pendentesPagamento } : {}),
      ...(titulosAvista !== null ? { titulos_avista: titulosAvista } : {}),
    }, USUARIO_EMAIL);
  }
  if (tipo === 'precos') {
    // só a lista da região do representante - outra região sobrescreveria o catálogo
    if (!/SUL\s*SUDESTE/i.test(nomeArquivo)) throw new Recusado('Lista de Preços que não é a SUL SUDESTE - não importada.');
    return importarCatalogoPrecos(buffer, USUARIO_EMAIL);
  }
  if (tipo === 'classificatorio') {
    const itens = Importadores.lerClassificatorio(XLSX, buffer);
    const dataRelatorio = Importadores.dataRelatorioClassificatorio(nomeArquivo);
    const apuradoAte = itens.reduce((max, it) => (it.ultimaCompra && it.ultimaCompra > (max || '') ? it.ultimaCompra : max), null);
    return importarClassificatorioErp({ itens, dataRelatorio, apuradoAte });
  }
  if (tipo === 'previsao') {
    const mapa = Importadores.lerPrevisao(XLSX, buffer);
    const itens = Object.entries(mapa).map(([codigo_sku, p]) => ({
      codigo_sku, qt_disponivel: p.qtDisponivel, qt_carteira: p.qtCarteira,
      qt_compra: p.qtCompra, previsao: p.previsao, saldo: p.saldo,
    }));
    if (itens.length === 0) throw new Recusado('Nenhuma linha reconhecida — confira se a coluna "Item" existe na planilha.');
    return importarPrevisaoEstoque(itens, USUARIO_EMAIL);
  }
  throw new Recusado('Tipo de planilha não importado por e-mail.');
}

async function registrar(hash, corpo, tipo, status, erro, resultado) {
  await pool.query(
    `/* importacao-email:registrar */
     INSERT INTO importacoes_email (hash, nome_arquivo, tipo, remetente, assunto, mensagem_id, recebido_em, status, erro, resultado)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (hash) DO UPDATE SET nome_arquivo = EXCLUDED.nome_arquivo, tipo = EXCLUDED.tipo, remetente = EXCLUDED.remetente,
       assunto = EXCLUDED.assunto, mensagem_id = EXCLUDED.mensagem_id, recebido_em = EXCLUDED.recebido_em,
       status = EXCLUDED.status, erro = EXCLUDED.erro, resultado = EXCLUDED.resultado, atualizado_em = now()`,
    [hash, String(corpo.nome || '').slice(0, 300), tipo, String(corpo.remetente || '').slice(0, 300) || null,
     String(corpo.assunto || '').slice(0, 300) || null, String(corpo.mensagemId || '').slice(0, 100) || null,
     isNaN(new Date(corpo.recebidoEm).getTime()) ? null : new Date(corpo.recebidoEm).toISOString(),
     status, erro ? String(erro).slice(0, 1000) : null, resultado ? JSON.stringify(resultado) : null]);
}

// Respostas pro script: 200 = importado (ou já importado antes); 422 = arquivo
// recusado (marca "Cortag/Falhou", não tenta de novo); 5xx = tentar de novo na
// próxima rodada (servidor/banco com problema).
router.post('/arquivo', async (req, res) => {
  // a chave já foi conferida antes de ler o corpo (server.js); de novo aqui
  // pra rota nunca ficar aberta se o middleware mudar
  if (!chaveImportacaoValida(req)) return res.status(401).json({ erro: 'Chave de importação inválida.' });
  const corpo = req.body || {};
  const nome = String(corpo.nome || '');
  if (!/\.xlsx?$/i.test(nome) || typeof corpo.arquivoBase64 !== 'string' || !corpo.arquivoBase64) {
    return res.status(422).json({ erro: 'Envie { nome: "...xlsx", arquivoBase64 }.' });
  }
  if (corpo.arquivoBase64.length > TAMANHO_MAX_BYTES * 4 / 3 + 4) return res.status(422).json({ erro: 'Arquivo maior que 10 MB.' });
  const buffer = Buffer.from(corpo.arquivoBase64, 'base64');
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');

  try {
    const ja = await pool.query("/* importacao-email:ja-importado */ SELECT tipo FROM importacoes_email WHERE hash = $1 AND status = 'ok'", [hash]);
    if (ja.rows.length) return res.json({ ok: true, duplicado: true, tipo: ja.rows[0].tipo });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ erro: 'Erro ao consultar importações anteriores.' });
  }

  let tipo = null;
  try {
    try { tipo = Importadores.detectarTipoPlanilha(XLSX, buffer); } catch (e) { throw new Recusado('Não foi possível abrir a planilha: ' + e.message); }
    if (!ROTULO_TIPO[tipo]) throw new Recusado(tipo ? `Planilha de "${tipo}" não é importada por e-mail.` : 'Tipo de planilha não reconhecido.');
    const r = await importarPorTipo(tipo, buffer, nome);
    if (r.status >= 500) {
      // falha nossa (banco): o script tenta de novo na próxima rodada
      await registrar(hash, corpo, tipo, 'falhou', r.json && r.json.erro, null).catch(() => { });
      return res.status(503).json({ erro: (r.json && r.json.erro) || 'Erro ao importar.', tipo });
    }
    if (r.status >= 400) throw new Recusado((r.json && r.json.erro) || 'Planilha recusada.');
    await registrar(hash, corpo, tipo, 'ok', null, r.json);
    console.log(`Importação por e-mail: ${ROTULO_TIPO[tipo]} "${nome}" importado.`);
    res.json({ ok: true, tipo, resultado: r.json });
  } catch (e) {
    // erro de banco volta como status 500 das funções de importação (acima);
    // o que chega aqui é a planilha recusada pelos leitores (aba/coluna
    // faltando, valor corrompido etc.) - não adianta tentar de novo
    if (!(e instanceof Recusado)) console.error('Importação por e-mail:', e);
    await registrar(hash, corpo, tipo, 'falhou', e.message, null).catch(err => console.error(err));
    console.warn(`Importação por e-mail recusada: "${nome}" - ${e.message}`);
    res.status(422).json({ erro: e.message, tipo });
  }
});

// Painel (⚙): o último arquivo recebido de cada tipo.
router.get('/status', requireAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `/* importacao-email:status */
       SELECT DISTINCT ON (tipo) tipo, nome_arquivo, status, erro, recebido_em, atualizado_em
       FROM importacoes_email WHERE tipo IS NOT NULL
       ORDER BY tipo, atualizado_em DESC`);
    res.json({ tipos: r.rows.map(l => ({ ...l, rotulo: ROTULO_TIPO[l.tipo] || l.tipo })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar a importação por e-mail.' });
  }
});

module.exports = router;
module.exports.chaveImportacaoValida = chaveImportacaoValida;
