const express = require('express');
const { runMigrations } = require('./db');
const { requireApiKey } = require('./middleware/auth');

const clientesRoutes = require('./routes/clientes');
const produtosRoutes = require('./routes/produtos');
const pedidosRoutes = require('./routes/pedidos');
const levantamentosRoutes = require('./routes/levantamentos');
const relatoriosRoutes = require('./routes/relatorios');

const app = express();

// CORS simples, sem depender de pacote externo - o app é um PWA hospedado em
// outro domínio (GitHub Pages), então precisa liberar chamadas cross-origin.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '2mb' }));

app.get('/', (req, res) => res.json({ status: 'ok', servico: 'Cortag - histórico e relatórios' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// todas as rotas de dados exigem a chave de API (ver middleware/auth.js)
app.use('/api/clientes', requireApiKey, clientesRoutes);
app.use('/api/produtos', requireApiKey, produtosRoutes);
app.use('/api/pedidos', requireApiKey, pedidosRoutes);
app.use('/api/levantamentos', requireApiKey, levantamentosRoutes);
app.use('/api', requireApiKey, relatoriosRoutes); // /api/clientes/:id/historico, /rotatividade, etc.

const PORT = process.env.PORT || 3000;

runMigrations()
  .then(() => {
    app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
  })
  .catch((e) => {
    console.error('Falha ao rodar migrações do banco:', e);
    process.exit(1);
  });
