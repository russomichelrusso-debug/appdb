const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Busca clientes por nome ou documento - usado pelo app pra autocompletar
// "qual cliente é esse" ao salvar um levantamento ou pedido.
router.get('/', async (req, res) => {
  const busca = (req.query.busca || '').trim();
  try {
    const result = busca
      ? await pool.query(
          `SELECT id, nome, documento, contato, classificatorio_tipo, classificatorio_desconto FROM clientes
           WHERE nome ILIKE $1 OR documento ILIKE $1
           ORDER BY nome LIMIT 20`,
          [`%${busca}%`]
        )
      : await pool.query('SELECT id, nome, documento, contato, classificatorio_tipo, classificatorio_desconto FROM clientes ORDER BY nome LIMIT 50');
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar clientes.' });
  }
});

// Lista TODOS os clientes sem limite - usado só pelo diagnóstico de
// integridade no Admin (comparar com uma planilha de referência). Nome
// diferente de "/" de propósito, pra não confundir com a busca do dia a dia
// (que tem limite baixo, pensada pra autocompletar).
router.get('/todos', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode listar todos os clientes.' });
  try {
    const result = await pool.query('SELECT id, nome, documento, contato, classificatorio_tipo, classificatorio_desconto FROM clientes ORDER BY nome');
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao listar clientes.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clientes WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    res.json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao buscar cliente.' });
  }
});

// Cria um cliente novo, ou devolve o já existente se o documento (CNPJ/CPF)
// já estiver cadastrado - evita duplicar o mesmo cliente em visitas diferentes.
router.post('/', async (req, res) => {
  const { nome, documento, contato } = req.body;
  if (!nome) return res.status(400).json({ erro: 'Nome é obrigatório.' });
  try {
    if (documento) {
      const existing = await pool.query('SELECT * FROM clientes WHERE documento = $1', [documento]);
      if (existing.rows.length > 0) return res.json(existing.rows[0]);
    }
    const result = await pool.query(
      'INSERT INTO clientes (nome, documento, contato) VALUES ($1, $2, $3) RETURNING *',
      [nome, documento || null, contato || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao criar cliente.' });
  }
});

// Importa clientes em lote (ex: planilha de Razão Social + CNPJ). Mesma
// lógica de "uma operação só" usada no sync de produtos - evita o mesmo
// problema de tempo limite que já vimos lá. Não apaga ninguém, só cria ou
// atualiza o nome de quem já existe (por CNPJ).
router.post('/import', async (req, res) => {
  const clientes = req.body.clientes;
  if (!Array.isArray(clientes)) return res.status(400).json({ erro: 'Envie { clientes: [...] }' });

  const validos = clientes.filter(c => c.nome && c.cnpj);
  if (validos.length === 0) return res.json({ criados: 0, atualizados: 0, total: clientes.length });

  const nomes = validos.map(c => c.nome);
  const documentos = validos.map(c => String(c.cnpj));

  try {
    const result = await pool.query(
      `WITH entrada AS (
         SELECT * FROM UNNEST($1::text[], $2::text[]) AS t(nome, documento)
       ),
       upsert AS (
         INSERT INTO clientes (nome, documento)
         SELECT nome, documento FROM entrada
         ON CONFLICT (documento) DO UPDATE SET nome = EXCLUDED.nome
         RETURNING (xmax = 0) AS inserted
       )
       SELECT
         COUNT(*) FILTER (WHERE inserted) AS criados,
         COUNT(*) FILTER (WHERE NOT inserted) AS atualizados
       FROM upsert`,
      [nomes, documentos]
    );
    const { criados, atualizados } = result.rows[0];
    console.log(`Import de clientes: ${criados} criado(s), ${atualizados} atualizado(s) de ${clientes.length}.`);
    res.json({ criados: Number(criados), atualizados: Number(atualizados), total: clientes.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ erro: 'Erro ao importar clientes.' });
  }
});

// Exclui um cliente. Por padrão, se ele já tiver pedidos ou levantamentos
// registrados, o banco recusa (chave estrangeira) de propósito - evita
// apagar histórico de venda sem querer. Um administrador pode forçar a
// Corrige o documento (CNPJ) de um cliente já cadastrado - usado pelo
// diagnóstico de integridade, pra consertar registros que entraram com o
// CNPJ errado (ex: o da própria Cortag, por um bug já corrigido na extração
// de PDF). Só admin.
router.patch('/:id/documento', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode corrigir o documento de um cliente.' });
  const { documento } = req.body;
  if (!documento) return res.status(400).json({ erro: 'Informe o documento correto.' });
  try {
    const result = await pool.query('UPDATE clientes SET documento = $1 WHERE id = $2 RETURNING nome', [documento, req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    console.log(`Documento corrigido: ${result.rows[0].nome} (id ${req.params.id}) por ${req.usuario?.email}.`);
    res.json({ ok: true, nome: result.rows[0].nome });
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ erro: 'Esse CNPJ já pertence a outro cliente cadastrado — use mesclar em vez de corrigir.' });
    console.error(e);
    res.status(500).json({ erro: 'Erro ao corrigir documento.' });
  }
});

// Mescla dois clientes duplicados: todo o histórico (pedidos e levantamentos)
// do cliente "remover" passa a pertencer ao "manter", e o duplicado é
// excluído. Só admin - é uma operação que reescreve histórico de vendas.
router.post('/mesclar', async (req, res) => {
  if (!req.usuario?.is_admin) return res.status(403).json({ erro: 'Só administrador pode mesclar clientes.' });
  const { manter_id, remover_id } = req.body;
  if (!manter_id || !remover_id) return res.status(400).json({ erro: 'Informe manter_id e remover_id.' });
  if (manter_id === remover_id) return res.status(400).json({ erro: 'Escolha dois clientes diferentes.' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ambos = await client.query('SELECT id, nome FROM clientes WHERE id = ANY($1::int[])', [[manter_id, remover_id]]);
    if (ambos.rows.length !== 2) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Um dos dois clientes não foi encontrado.' });
    }
    const manterInfo = ambos.rows.find(r => r.id === Number(manter_id));
    const removerInfo = ambos.rows.find(r => r.id === Number(remover_id));

    await client.query('UPDATE pedidos SET cliente_id = $1 WHERE cliente_id = $2', [manter_id, remover_id]);
    await client.query('UPDATE levantamentos SET cliente_id = $1 WHERE cliente_id = $2', [manter_id, remover_id]);
    await client.query('DELETE FROM clientes WHERE id = $1', [remover_id]);
    await client.query('COMMIT');
    console.log(`Clientes mesclados: "${removerInfo.nome}" (id ${remover_id}) → "${manterInfo.nome}" (id ${manter_id}), por ${req.usuario?.email}.`);
    res.json({ ok: true, manteve: manterInfo.nome, removeu: removerInfo.nome });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ erro: 'Erro ao mesclar clientes.' });
  } finally {
    client.release();
  }
});

// Exclui um cliente. Por padrão, se ele já tiver pedidos ou levantamentos
// registrados, o banco recusa (chave estrangeira) de propósito - evita
// apagar histórico de venda sem querer. Um administrador pode forçar a
// exclusão total (cliente + histórico junto) mandando ?forcar=1 - usuários
// comuns não conseguem, mesmo mandando o mesmo parâmetro.
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const forcar = req.query.forcar === '1' && !!req.usuario?.is_admin;

  if (!forcar) {
    try {
      const result = await pool.query('DELETE FROM clientes WHERE id = $1 RETURNING nome', [id]);
      if (result.rows.length === 0) return res.status(404).json({ erro: 'Cliente não encontrado.' });
      console.log(`Cliente excluído: ${result.rows[0].nome} (id ${id}) por ${req.usuario?.email || '?'}`);
      return res.json({ ok: true });
    } catch (e) {
      if (e.code === '23503') {
        return res.status(400).json({ erro: 'Esse cliente já tem pedidos ou levantamentos registrados — só um administrador pode excluir junto com o histórico.' });
      }
      console.error(e);
      return res.status(500).json({ erro: 'Erro ao excluir cliente.' });
    }
  }

  // exclusão forçada (só admin chega aqui) - apaga o histórico ligado a esse
  // cliente antes, numa transação só, pra não deixar registro órfão.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM pedido_itens WHERE pedido_id IN (SELECT id FROM pedidos WHERE cliente_id = $1)`, [id]
    );
    await client.query('DELETE FROM pedidos WHERE cliente_id = $1', [id]);
    await client.query(
      `DELETE FROM levantamento_itens WHERE levantamento_id IN (SELECT id FROM levantamentos WHERE cliente_id = $1)`, [id]
    );
    await client.query('DELETE FROM levantamentos WHERE cliente_id = $1', [id]);
    const result = await client.query('DELETE FROM clientes WHERE id = $1 RETURNING nome', [id]);
    if (result.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ erro: 'Cliente não encontrado.' });
    }
    await client.query('COMMIT');
    console.log(`Cliente EXCLUÍDO COM HISTÓRICO: ${result.rows[0].nome} (id ${id}) por ${req.usuario?.email || '?'} (admin)`);
    res.json({ ok: true, historico_apagado: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ erro: 'Erro ao excluir cliente e histórico.' });
  } finally {
    client.release();
  }
});

module.exports = router;
