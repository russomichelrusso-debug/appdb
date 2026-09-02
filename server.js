const express = require('express');
const rateLimit = require('express-rate-limit');
const { pool, runMigrations } = require('./db');
const { requireAuth } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const clientesRoutes = require('./routes/clientes');
const produtosRoutes = require('./routes/produtos');
const pedidosRoutes = require('./routes/pedidos');
const levantamentosRoutes = require('./routes/levantamentos');
const relatoriosRoutes = require('./routes/relatorios');
const previsaoEstoqueRoutes = require('./routes/previsaoEstoque');
const configuracoesRoutes = require('./routes/configuracoes');
const fichasTecnicasRoutes = require('./routes/fichasTecnicas');
const codigosProdutoRoutes = require('./routes/codigosProduto');
const pedidosOficiaisRoutes = require('./routes/pedidosOficiais');
const assistenteRoutes = require('./routes/assistente');

const app = express();
app.set('trust proxy', 1);  

// CORS simples, sem depender de pacote externo - o app é um PWA hospedado em
// outro domínio (GitHub Pages), então precisa liberar chamadas cross-origin.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '6mb' }));

app.get('/', (req, res) => res.json({ status: 'ok', servico: 'Cortag - histórico e relatórios' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Limite de tentativas na rota de login com Google - protege o endpoint que
// chama a API do Google pra validar o id_token contra abuso/flood (mesmo sem
// senha pra "adivinhar", vale limitar chamadas repetidas de um mesmo IP).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas de login em pouco tempo — espera alguns minutos e tenta de novo.' },
});

// login/logout ficam públicos (senão ninguém consegue nem entrar);
// cadastrar novo usuário exige já estar logado (checado dentro de routes/auth.js).
app.use('/api/auth/google', authLimiter);
app.use('/api/auth', authRoutes);

// todas as rotas de dados exigem estar logado (ver middleware/auth.js)
app.use('/api/clientes', requireAuth, clientesRoutes);
app.use('/api/produtos', requireAuth, produtosRoutes);
app.use('/api/pedidos', requireAuth, pedidosRoutes);
app.use('/api/levantamentos', requireAuth, levantamentosRoutes);
app.use('/api/previsao-estoque', requireAuth, previsaoEstoqueRoutes);
app.use('/api/configuracoes', requireAuth, configuracoesRoutes);
app.use('/api/fichas-tecnicas', requireAuth, fichasTecnicasRoutes);
app.use('/api/codigos-produto', requireAuth, codigosProdutoRoutes);
app.use('/api/pedidos-oficiais', requireAuth, pedidosOficiaisRoutes);
app.use('/api/assistente', requireAuth, assistenteRoutes);
app.use('/api', requireAuth, relatoriosRoutes); // /api/clientes/:id/historico, /rotatividade, etc.

const PORT = process.env.PORT || 10000;

runMigrations()
  .then(() => {
    app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
  })
  .catch(err => {
    console.error('Erro ao rodar migrações do banco:', err);
    process.exit(1);
  });
