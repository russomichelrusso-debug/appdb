// Limite de requisições nas rotas de leitura pesadas, por usuário logado
// (revisão de segurança, 10/2026): só login, CNPJ, assistente e importação por
// e-mail tinham limite, e um usuário logado (ou um token vazado) podia martelar
// o Dashboard, a Curva ABC ou as listas da aba Clientes - consultas que varrem
// a carteira inteira - e ocupar as 10 conexões do pool do banco (db.js), deixando
// o app lento ou parado pra equipe toda.
//
// Dois grupos, cada um com a sua conta por usuário (vários aparelhos do mesmo
// vendedor somam juntos):
//  - CARTEIRA: rotas que agregam a carteira inteira. Abrir o app/aba Clientes
//    chama ~6 delas e o Dashboard ~3: o limite cobre reabrir várias vezes por
//    minuto com folga, mas não um laço.
//  - CLIENTE: relatórios de UM cliente. Abrir um cliente chama ~9; o limite
//    cobre olhar ~15 clientes por minuto.
// Só GET: gravação (pedido, levantamento, fila offline) nunca é barrada aqui.
// Fica DEPOIS do requireAuth (precisa de req.usuario); a requisição que passa
// por mais de um app.use('/api…') é contada uma vez só.
const rateLimit = require('express-rate-limit');

const JANELA_MS = 60 * 1000;
const LIMITE_CARTEIRA = Number(process.env.LIMITE_ROTAS_CARTEIRA_POR_MIN) || 40;
const LIMITE_CLIENTE = Number(process.env.LIMITE_ROTAS_CLIENTE_POR_MIN) || 150;

const ROTAS_CARTEIRA = [
  /^\/api\/dashboard\/resumo$/,
  /^\/api\/produtos-abc-geral$/,
  /^\/api\/clientes\/classificatorio\/alertas$/,
  /^\/api\/clientes\/sync$/,
  /^\/api\/recompra$/,
  /^\/api\/visitas$/,
  /^\/api\/reativacao$/,
  /^\/api\/inadimplencia$/,
  /^\/api\/pedidos\/exportar$/,
  /^\/api\/produtos\/[^/]+\/clientes$/,
  /^\/api\/levantamentos\/recentes$/,
  /^\/api\/mix-inicial$/,
];
const ROTAS_CLIENTE = [
  /^\/api\/clientes\/[^/]+\/(historico|rotatividade|recuperar|sugestoes-recompra|comprados-recentes|produtos-abc|levantamentos)$/,
  /^\/api\/clientes\/[^/]+\/classificatorio\/(status|grupo)$/,
  /^\/api\/clientes\/[^/]+\/consumo-estimado\/[^/]+$/,
  /^\/api\/pedidos-oficiais\/\d+(\/resumo)?$/,
];

function criarLimite(limite, mensagem) {
  return rateLimit({
    windowMs: JANELA_MS,
    limit: limite,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `u${req.usuario.id}`,
    message: { erro: mensagem },
  });
}

const limiteCarteira = criarLimite(LIMITE_CARTEIRA,
  'Muitas consultas pesadas em pouco tempo — espera um minuto e tenta de novo.');
const limiteCliente = criarLimite(LIMITE_CLIENTE,
  'Muitas consultas de clientes em pouco tempo — espera um minuto e tenta de novo.');

function grupoDaRota(caminho) {
  const c = caminho.length > 1 ? caminho.replace(/\/+$/, '') : caminho;
  if (ROTAS_CARTEIRA.some(r => r.test(c))) return limiteCarteira;
  if (ROTAS_CLIENTE.some(r => r.test(c))) return limiteCliente;
  return null;
}

function limiteRotasPesadas(req, res, next) {
  if (req.method !== 'GET' || !req.usuario || req.limiteRotasPesadasContado) return next();
  // caminho completo, sem a query (req.path é relativo ao app.use; Express não diferencia maiúscula)
  const limite = grupoDaRota((req.baseUrl + req.path).toLowerCase());
  if (!limite) return next();
  req.limiteRotasPesadasContado = true;
  return limite(req, res, next);
}

module.exports = { limiteRotasPesadas, grupoDaRota, LIMITE_CARTEIRA, LIMITE_CLIENTE };
