const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Acha ou cria o cliente (por documento, se enviado) e o vendedor (por nome).
async function acharOuCriarCliente(client, { cliente_id, nome, documento, contato }) {
  if (cliente_id) return cliente_id;
  if (documento) {
    const existing = await client.query(
      `SELECT id FROM clientes WHERE regexp_replace(documento, '\\D', '', 'g') = regexp_replace($1, '\\D', '', 'g') LIMIT 1`,
      [documento]
    );
    if (existing.rows.length > 0) return existing.rows[0].id;
  }
  // sem documento, tenta achar por nome "normalizado" antes de criar um novo -
  // evita duplicar o mesmo cliente só porque o PDF escreveu o nome com espaço
  // ou maiúscula diferente da planilha cadastrada. Não é fuzzy demais: ainda
  // exige que o texto seja o mesmo depois de tirar espaço duplo e maiúscula/
  // minúscula, então não mistura duas empresas parecidas por engano.
  if (!documento && nome) {
    const existingByName = await client.query(
      `SELECT id FROM clientes
       WHERE regexp_replace(upper(trim(nome)), '\\s+', ' ', 'g') = regexp_replace(upper(trim($1)), '\\s+', ' ', 'g')
       LIMIT 1`,
      [nome]
    );
    if (existingByName.rows.length > 0) return existingByName.rows[0].id;
  }
  const result = await client.query(
    'INSERT INTO clientes (nome, documento, contato) VALUES ($1, $2, $3) RETURNING id',
    [nome, documento || null, contato || null]
  );
  return result.rows[0].id;
}
async function acharOuCriarVendedor(client, nomeVendedor) {
  if (!nomeVendedor) return null;
  const existing = await client.query('SELECT id FROM vendedores WHERE nome = $1', [nomeVendedor]);
  if (existing.rows.length > 0) return existing.rows[0].id;
  const result = await client.query('INSERT INTO vendedores (nome) VALUES ($1) RETURNING id', [nomeVendedor]);
  return result.rows[0].id;
}
// Acha o produto pelo código. Se não existir e vier uma descrição (caso do
// PDF oficial, que já traz o nome do item), cria na hora em vez de recusar -
// diferente do "Finalizar pedido" manual, que exige sincronizar o catálogo
// antes (lá o código vem só de digitação/scanner, sem descrição junto).
async function acharOuCriarProdutoPorSku(client, codigo_sku, descricaoSeNovo) {
  const result = await client.query('SELECT id FROM produtos WHERE codigo_sku = $1', [codigo_sku]);
  if (result.rows.length > 0) return result.rows[0].id;
  if (!descricaoSeNovo) {
    throw new Error(`Produto com código ${codigo_sku} não encontrado - rode /api/produtos/sync primeiro.`);
  }
  const criado = await client.query(
    'INSERT INTO produtos (codigo_sku, nome) VALUES ($1, $2) RETURNING id',
    [codigo_sku, descricaoSeNovo]
  );
  return criado.rows[0].id;
}

// Finaliza/grava um pedido. Corpo esperado:
// {
//   cliente: { cliente_id? , nome, documento?, contato? },
//   vendedor_nome?: "...",
//   observacao?: "...",
//   numero_cotacao?: "...",       // se vier e já existir, compara data (ver pdf_modificado_em) antes de decidir
//   data_pedido?: "2026-08-01",   // data original do documento, se souber (senão usa agora)
//   pdf_modificado_em?: "...",    // data de modificação do ARQUIVO PDF (metadado), pra saber qual versão é mais nova
//   origem?: "app" | "pdf",       // de onde veio esse registro
//   itens: [{ codigo_sku, quantidade, preco_unitario, descricao? }, ...]
// }
router.post('/', async (req, res) => {
  const { cliente, vendedor_nome, observacao, itens, numero_cotacao, data_pedido, pdf_modificado_em, origem } = req.body;
  if (!cliente || !cliente.nome) return res.status(400).json({ erro: 'Informe os dados do cliente (nome).' });
  if (!Array.isArray(itens) || itens.length === 0) return res.status(400).json({ erro: 'Informe ao menos um item.' });

  // checa duplicidade ANTES de abrir a transação. Se a mesma cotação já foi
  // consolidada antes, só substitui os itens se o PDF novo for mais recente
  // que o que já está gravado (comparando a data de modificação do arquivo,
  // não a data de emissão do documento - a emissão pode não mudar numa
  // reimpressão/correção, o metadado do arquivo sim). Sem essa informação
  // dos dois lados, mantém o comportamento antigo: recusa como duplicado.
  let pedidoParaAtualizar = null;
  if (numero_cotacao) {
    const existente = await pool.query(
      'SELECT id, cliente_id, data_pedido, pdf_modificado_em FROM pedidos WHERE numero_cotacao = $1',
      [numero_cotacao]
    );
    if (existente.rows.length > 0) {
      const atual = existente.rows[0];
      const novoEhMaisRecente = pdf_modificado_em && (!atual.pdf_modificado_em || new Date(pdf_modificado_em) > new Date(atual.pdf_modificado_em));
      if (!novoEhMaisRecente) {
        return res.status(200).json({ ja_existia: true, pedido_id: atual.id, cliente_id: atual.cliente_id, data_pedido: atual.data_pedido });
      }
      pedidoParaAtualizar = atual.id;
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const clienteId = await acharOuCriarCliente(client, cliente);
    const vendedorId = await acharOuCriarVendedor(client, vendedor_nome);
    const criarProdutosDesconhecidos = origem === 'pdf';

    let pedidoId, dataPedidoFinal, atualizado = false;
    if (pedidoParaAtualizar) {
      // PDF mais novo pra uma cotação já existente: atualiza o cabeçalho e
      // substitui os itens (apaga os antigos, grava os novos) em vez de criar
      // um pedido paralelo - fica um registro só por cotação, sempre a versão mais recente.
      const upd = await client.query(
        `UPDATE pedidos SET cliente_id = $1, vendedor_id = $2, observacao = $3,
                            data_pedido = COALESCE($4::timestamptz, data_pedido),
                            pdf_modificado_em = $5
         WHERE id = $6 RETURNING id, data_pedido`,
        [clienteId, vendedorId, observacao || null, data_pedido || null, pdf_modificado_em || null, pedidoParaAtualizar]
      );
      pedidoId = upd.rows[0].id;
      dataPedidoFinal = upd.rows[0].data_pedido;
      await client.query('DELETE FROM pedido_itens WHERE pedido_id = $1', [pedidoId]);
      atualizado = true;
    } else {
      const pedidoResult = await client.query(
        `INSERT INTO pedidos (cliente_id, vendedor_id, observacao, numero_cotacao, origem, data_pedido, pdf_modificado_em)
         VALUES ($1, $2, $3, $4, $5, COALESCE($6::timestamptz, now()), $7)
         RETURNING id, data_pedido`,
        [clienteId, vendedorId, observacao || null, numero_cotacao || null, origem || 'app', data_pedido || null, pdf_modificado_em || null]
      );
      pedidoId = pedidoResult.rows[0].id;
      dataPedidoFinal = pedidoResult.rows[0].data_pedido;
    }

    for (const item of itens) {
      const produtoId = await acharOuCriarProdutoPorSku(client, item.codigo_sku, criarProdutosDesconhecidos ? item.descricao : null);
      await client.query(
        'INSERT INTO pedido_itens (pedido_id, produto_id, quantidade, preco_unitario) VALUES ($1, $2, $3, $4)',
        [pedidoId, produtoId, item.quantidade, item.preco_unitario]
      );
    }

    await client.query('COMMIT');
    console.log(`Pedido #${pedidoId} ${atualizado ? 'ATUALIZADO (versão mais nova do PDF)' : 'gravado'} (cliente ${clienteId}, ${itens.length} item(ns))${numero_cotacao ? ` [cotação ${numero_cotacao}]` : ''}.`);
    res.status(201).json({ pedido_id: pedidoId, cliente_id: clienteId, data_pedido: dataPedidoFinal, atualizado });
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === '23505') {
      // corrida rara: dois envios da mesma cotação quase ao mesmo tempo
      return res.status(200).json({ ja_existia: true, erro_corrida: true });
    }
    console.error(e);
    res.status(400).json({ erro: e.message || 'Erro ao gravar pedido.' });
  } finally {
    client.release();
  }
});

module.exports = router;
