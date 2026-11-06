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
//
// Quanto do tempo foi banco (11/2026, diagnóstico da auditoria): cada consulta custa ~1 s de ida e volta
// Oregon <-> São Paulo e o log não dizia se a rota lenta era banco, conta no servidor ou espera de conexão.
// instrumentarBanco (chamado no db.js) mede cada client.query e cada pool.connect feitos dentro da
// requisição (AsyncLocalStorage) e a linha ganha "banco 4 consultas 3890 ms", "espera conexão 820 ms"
// (conexão livre do pool + abrir uma nova) e "conexão nova". O tempo das consultas é somado: consultas
// em paralelo (Promise.all) podem somar mais que o total da requisição.
const { AsyncLocalStorage } = require('async_hooks');
const medida = new AsyncLocalStorage();
const ESPERA_MINIMA_LOG_MS = 50;

function instrumentarBanco(pool, Client) {
  if (Client && Client.prototype && !Client.prototype.__medidaLenta) {
    const original = Client.prototype.query;
    Client.prototype.query = function (...args) {
      const st = medida.getStore();
      if (!st) return original.apply(this, args);
      st.consultas++;
      const t0 = process.hrtime.bigint();
      const fim = () => { st.bancoMs += Number(process.hrtime.bigint() - t0) / 1e6; };
      const u = args.length - 1;
      if (u >= 0 && typeof args[u] === 'function') {
        const cb = args[u];
        args[u] = function (...r) { fim(); return cb.apply(this, r); };
        return original.apply(this, args);
      }
      const r = original.apply(this, args);
      // devolve a promise medida (não pendura um handler à parte): consulta sem catch continua avisando no log
      if (r && typeof r.then === 'function') return r.then((v) => { fim(); return v; }, (e) => { fim(); throw e; });
      return r;
    };
    Client.prototype.__medidaLenta = true;
  }
  if (pool && typeof pool.connect === 'function' && !pool.__medidaLenta) {
    const conectar = pool.connect.bind(pool);
    // a conexão que esperou na fila do pool é entregue a partir do socket de outra requisição: o callback roda
    // de novo dentro da medida de quem pediu (ou de nenhuma), senão a consulta de A ia pra linha de B
    pool.connect = function (cb) {
      const st = medida.getStore();
      if (!st) return typeof cb === 'function' ? conectar((...r) => medida.run(undefined, () => cb(...r))) : conectar();
      const t0 = process.hrtime.bigint();
      // conexão que o pool nunca entregou = aberta agora pra esta requisição
      const fim = (client) => {
        st.esperaMs += Number(process.hrtime.bigint() - t0) / 1e6;
        if (client && typeof client === 'object' && !client.__medidaEntregue) { client.__medidaEntregue = true; st.conexoesNovas++; }
      };
      if (typeof cb === 'function') return conectar((err, client, ...r) => { fim(!err && client); return medida.run(st, () => cb(err, client, ...r)); });
      const p = conectar();
      if (p && typeof p.then === 'function') return p.then((c) => { fim(c); return c; }, (e) => { fim(); throw e; });
      return p;
    };
    pool.__medidaLenta = true;
  }
}
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
    const st = { consultas: 0, bancoMs: 0, esperaMs: 0, conexoesNovas: 0 };
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
      if (st.consultas) partes.push(`banco ${st.consultas} ${st.consultas === 1 ? 'consulta' : 'consultas'} ${Math.round(st.bancoMs)} ms`);
      if (st.esperaMs >= ESPERA_MINIMA_LOG_MS) partes.push(`espera conexão ${Math.round(st.esperaMs)} ms`);
      if (st.conexoesNovas) partes.push(st.conexoesNovas === 1 ? 'conexão nova' : `${st.conexoesNovas} conexões novas`);
      if (noArNoInicio < ACORDANDO_S) partes.push(`servidor acordou há ${Math.round(noArNoInicio)} s`);
      try { log(partes.join(' ')); } catch (e) { /* log nunca derruba a resposta */ }
    };
    res.on('finish', () => terminar(false));
    res.on('close', () => terminar(!res.writableFinished));
    medida.run(st, next);
  };
}

module.exports = { registrarRequisicoesLentas, rotaParaLog, instrumentarBanco };
