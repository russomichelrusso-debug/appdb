const express = require('express');
// Faz o Express 4 encaminhar rejeições de promise de handlers async pro
// middleware de erro abaixo, em vez de virar unhandledRejection e derrubar
// o processo Node inteiro (precisa ser importado antes das rotas).
require('express-async-errors');
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
const catalogoPrecosRoutes = require('./routes/catalogoPrecos');
const radarCnpjRoutes = require('./routes/radarCnpj');
const clientesClassificatorioRoutes = require('./routes/clientesClassificatorio');
const produtosPromocionaisRoutes = require('./routes/produtosPromocionais');
const recompraRoutes = require('./routes/recompra');
const novidadesRoutes = require('./routes/novidades');
const importacaoEmailRoutes = require('./routes/importacaoEmail');
const { iniciarPreenchimentoAutomatico } = require('./routes/lib/preenchimentoCnpj');
const { iniciarEnvioAgendado } = require('./routes/lib/novidades');

const app = express();
app.set('trust proxy', 1);  

// CORS simples, sem depender de pacote externo - o app é um PWA hospedado em
// outro domínio (GitHub Pages), então precisa liberar chamadas cross-origin.
// ALLOWED_ORIGINS (lista separada por vírgula, ex: "https://usuario.github.io")
// restringe quem pode chamar a API com um token roubado - sem essa variável
// definida no Render, mantém o comportamento de sempre (qualquer origem),
// pra não quebrar nada em produção sem alguém definir a lista primeiro.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
app.use((req, res, next) => {
  const origin = req.header('Origin');
  if (ALLOWED_ORIGINS.length === 0) {
    res.header('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // PUT: nome do arquivo do cliente (PUT /api/clientes/:id/nome-arquivo) - sem ele o
  // navegador barrava a chamada do app publicado (outro domínio) antes de chegar aqui
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// A maioria das rotas manda JSON pequeno (já processado no cliente) - 1mb é
// mais que suficiente e limita o corpo aceito por rotas públicas (login) antes
// mesmo de autenticar. Só duas rotas mandam payload grande de verdade: a
// planilha "LISTA PADRÃO" de preços em base64 (routes/catalogoPrecos.js - o
// .xlsx cresce ~33% ao virar base64) e fotos de fichas técnicas em base64
// (routes/fichasTecnicas.js) - essas duas usam um parser à parte, com limite
// maior, escolhido dinamicamente pelo caminho da rota (um único parser roda
// por requisição - não dá pra encadear dois express.json, o segundo não teria
// mais nada pra ler do corpo já consumido pelo primeiro).
const jsonPadrao = express.json({ limit: '1mb' });
const jsonGrande = express.json({ limit: '25mb' });
const ROTAS_PAYLOAD_GRANDE = ['/api/catalogo-precos', '/api/fichas-tecnicas'];
// Importação por e-mail (routes/importacaoEmail.js): arquivo grande, mas sem
// login - só aceita quem manda a chave certa, conferida ANTES de ler o corpo.
const ROTA_IMPORTACAO_EMAIL = '/api/importacao-email/arquivo';
app.use((req, res, next) => {
  if (req.path === ROTA_IMPORTACAO_EMAIL) {
    if (!importacaoEmailRoutes.chaveImportacaoValida(req)) return res.status(401).json({ erro: 'Chave de importação inválida.' });
    return jsonGrande(req, res, next);
  }
  const parser = ROTAS_PAYLOAD_GRANDE.some(p => req.path.startsWith(p)) ? jsonGrande : jsonPadrao;
  parser(req, res, next);
});

app.get('/', (req, res) => res.json({ status: 'ok', servico: 'Cortag - histórico e relatórios' }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));
// Servidor no ar E banco respondendo - usado pelo script do Gmail antes de
// mandar arquivo: com o banco fora, a rodada acaba sem contar tentativa (senão
// o script desistia de e-mails bons numa queda longa do banco). O /health
// continua sem tocar no banco (keep-alive, e o Render pode usá-lo pra decidir
// se reinicia o serviço).
// Rota pública: a resposta fica guardada por 15 s e requisições ao mesmo tempo
// esperam a mesma consulta - quem chamar em loop não ocupa conexões do banco
// (no máximo 1 consulta a cada 15 s, qualquer que seja o volume).
const HEALTH_BANCO_CACHE_MS = Number(process.env.HEALTH_BANCO_CACHE_MS) || 15000;
const healthBanco = { ok: false, em: 0, emAndamento: null };
function conferirBanco() {
  if (Date.now() - healthBanco.em < HEALTH_BANCO_CACHE_MS) return Promise.resolve(healthBanco.ok);
  if (!healthBanco.emAndamento) {
    const consulta = (async () => {
      let timer;
      try {
        await Promise.race([
          pool.query('/* health:banco */ SELECT 1'),
          new Promise((_, rejeitar) => { timer = setTimeout(() => rejeitar(new Error('tempo esgotado')), 5000); }),
        ]);
        healthBanco.ok = true;
      } catch (e) {
        console.error('Health do banco:', e.message);
        healthBanco.ok = false;
      } finally {
        clearTimeout(timer);
        healthBanco.em = Date.now();
      }
      return healthBanco.ok;
    })();
    // limpa por fora: se a consulta terminasse antes desta atribuição (erro
    // síncrono), um "= null" lá dentro seria sobrescrito e nada consultaria mais
    healthBanco.emAndamento = consulta;
    consulta.finally(() => { if (healthBanco.emAndamento === consulta) healthBanco.emAndamento = null; });
  }
  return healthBanco.emAndamento;
}
app.get('/health/banco', async (req, res) => {
  if (await conferirBanco()) return res.json({ status: 'ok', banco: 'ok' });
  res.status(503).json({ status: 'erro', banco: 'fora do ar' });
});

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
app.use('/api/clientes', requireAuth, clientesClassificatorioRoutes); // /classificatorio/... - registrado depois, cai aqui só se clientesRoutes não bater
app.use('/api/produtos', requireAuth, produtosRoutes);
app.use('/api/pedidos', requireAuth, pedidosRoutes);
app.use('/api/levantamentos', requireAuth, levantamentosRoutes);
app.use('/api/previsao-estoque', requireAuth, previsaoEstoqueRoutes);
app.use('/api/configuracoes', requireAuth, configuracoesRoutes);
app.use('/api/fichas-tecnicas', requireAuth, fichasTecnicasRoutes);
app.use('/api/codigos-produto', requireAuth, codigosProdutoRoutes);
app.use('/api/pedidos-oficiais', requireAuth, pedidosOficiaisRoutes);
app.use('/api/assistente', requireAuth, assistenteRoutes);
app.use('/api/catalogo-precos', requireAuth, catalogoPrecosRoutes);
app.use('/api/produtos-promocionais', requireAuth, produtosPromocionaisRoutes);
app.use('/api/recompra', requireAuth, recompraRoutes);
app.use('/api/novidades', requireAuth, novidadesRoutes);
// /arquivo pela chave do script do Gmail; /status exige login (dentro da rota)
app.use('/api/importacao-email', rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false }), importacaoEmailRoutes);
app.use('/api', requireAuth, relatoriosRoutes); // /api/clientes/:id/historico, /rotatividade, etc.
app.use('/api', requireAuth, radarCnpjRoutes); // /api/clientes/:id/ficha-cnpj, /api/radar-cnpj/:cnpj

// Rede de segurança final: qualquer erro que escape dos try/catch das rotas
// (síncrono ou de promise, via express-async-errors) cai aqui em vez de
// derrubar o servidor - resposta genérica pro cliente, detalhe só no log.
app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

const PORT = process.env.PORT || 10000;

runMigrations()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Servidor rodando na porta ${PORT}`);
      // completa sozinho, de madrugada, as fichas de CNPJ que faltam
      iniciarPreenchimentoAutomatico(pool, radarCnpjRoutes.obterFicha);
      // avisos no celular de importação feita fora do horário (dia útil, 7h-20h)
      iniciarEnvioAgendado();
    });
  })
  .catch(err => {
    console.error('Erro ao rodar migrações do banco:', err);
    process.exit(1);
  });
