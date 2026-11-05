// Uma linha no log do Render para cada requisição que passa do limite (lote 5 da
// auditoria de performance, 11/2026): até então não havia medida nenhuma de quais
// rotas demoram em produção - só o pg_stat_statements do Supabase, que mede o banco
// e não a ida e volta Render (Oregon) <-> Supabase (São Paulo) nem o servidor
// acordando do plano grátis.
//
// Exemplo: "[lenta] 3412 ms GET /api/clientes/:id/historico 200 u=5 servidor acordou há 8 s"
//
// O endereço vai sem a parte depois do "?" e com todo trecho que tem número (id,
// código do produto, CNPJ) ou "@" trocado por ":id" - o log do Render não guarda
// dado de cliente. A espera longa da tela do cliente (GET /api/segunda-tela/salas/:id,
// até 25 s de propósito) fica de fora.
//
// LOG_REQUISICAO_LENTA_MS no Render troca o limite (padrão 1000; 0 desliga).
const LIMITE_PADRAO_MS = 1000;
// Servidor que subiu há menos que isto quando a requisição chegou = provavelmente
// acordando (o Render grátis dorme depois de 15 min parado).
const ACORDANDO_S = 60;
const SEM_LOG = [/^\/api\/segunda-tela\/salas\/[^/]+$/];

function limiteDoAmbiente() {
  const v = process.env.LOG_REQUISICAO_LENTA_MS;
  if (v === undefined || v === '') return LIMITE_PADRAO_MS;
  const n = Number(v);
  return Number.isFinite(n) ? n : LIMITE_PADRAO_MS;
}

function rotaParaLog(url) {
  const caminho = String(url || '').split('?')[0];
  return caminho.split('/').map(p => (/[0-9@]/.test(p) ? ':id' : p)).join('/');
}

function registrarRequisicoesLentas(opcoes = {}) {
  const limite = opcoes.limiteMs !== undefined ? opcoes.limiteMs : limiteDoAmbiente();
  const log = opcoes.log || ((linha) => console.warn(linha));
  const tempoNoAr = opcoes.tempoNoAr || (() => process.uptime());
  return (req, res, next) => {
    if (!(limite > 0)) return next();
    const inicio = process.hrtime.bigint();
    const noArNoInicio = tempoNoAr();
    let registrado = false;
    const terminar = (cancelada) => {
      if (registrado) return;
      registrado = true;
      const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
      if (ms < limite) return;
      const rota = rotaParaLog(req.originalUrl || req.url);
      if (req.method === 'GET' && SEM_LOG.some(r => r.test(rota))) return;
      const partes = ['[lenta]', `${Math.round(ms)} ms`, req.method, rota, cancelada ? 'cancelada pelo aparelho' : String(res.statusCode)];
      if (req.usuario && req.usuario.id) partes.push('u=' + req.usuario.id);
      if (noArNoInicio < ACORDANDO_S) partes.push(`servidor acordou há ${Math.round(noArNoInicio)} s`);
      try { log(partes.join(' ')); } catch (e) { /* log nunca derruba a resposta */ }
    };
    res.on('finish', () => terminar(false));
    res.on('close', () => terminar(!res.writableFinished));
    next();
  };
}

module.exports = { registrarRequisicoesLentas, rotaParaLog };
