// Posição da loja PELO NÚMERO quando o Nominatim só acha a rua
// (routes/lib/geocodificacao.js). O OpenStreetMap quase nunca tem o número da
// loja, mas costuma ter outros números da mesma rua (mercado, banco, prédio):
// com eles e o traçado da rua dá pra calcular onde o número da loja fica.
// Caso real (10/2026): DEPEL, Av. Brasil 4516 em Maringá - o ponto da rua do
// Nominatim ficava a 3,6 km; entre o 3171 e o 4724 do OSM, o calculado caiu a 9 m.
//
// Uma consulta ao Overpass (mesma base do OSM, ODbL - pode guardar) por loja:
// os endereços com número e as vias com o MESMO nome que o Nominatim deu pra
// rua, num raio de RAIO_M do ponto da rua (rua homônima de outra cidade fica
// de fora). Depois, sem rede:
// - entre dois números conhecidos: anda pelo traçado da rua na proporção do
//   número (ou em linha reta quando o traçado não liga os dois: até 600
//   números de vão, erro mediano ~25 m; de 600 a 2500, ~55 m e vira
//   'estimado'); pelo traçado, erro mediano medido ~25-40 m;
// - números só de um lado: precisa de dois deles a 100+ números um do outro
//   (dão a direção e os metros por número - no norte do PR quase sempre ~1 m);
//   anda pelo traçado, se afastando do segundo. Até 300 números do conhecido,
//   erro mediano ~40 m; mais longe, ~65 m (90% até ~250 m) - vira 'estimado'.
// Medido em 10/2026 deixando de fora cada endereço do OSM das 103 cidades da
// carteira (scripts de validação na conversa do PR). Sem dado suficiente
// devolve null e a loja fica com o ponto da rua.
//
// nivel devolvido: 'numero' (o próprio número está no OSM), 'interpolado'
// (preciso como o número: entre dois, ou de um lado até 300 números) ou
// 'estimado' (de um lado, mais longe - o app mostra como aproximado).

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'CortagRevolutionTools/1.0 (+https://github.com/russomichelrusso-debug/appdb)';
const RAIO_M = 6000;
const MAX_PROJECAO_M = 80;        // endereço a mais que isso da rua não serve de referência
const VAO_RETA = 600;             // entre dois números até isso: reta vale (rua quase reta nesse trecho)
const VAO_RETA_MAX = 2500;        // até isso, reta só como 'estimado' (erro mediano ~55 m)
const BASE_MIN = 100;             // de um lado só: os dois conhecidos a pelo menos isso de diferença
const SALTO_INTERPOLADO = 300;    // de um lado só: até isso do conhecido = 'interpolado'
const MAX_ESPALHO_M = 120;        // caminhos possíveis (rua bifurca) muito separados = ambíguo

// [lng, lat]
function distM(a, b) {
  const rad = (g) => g * Math.PI / 180;
  const dLat = rad(b[1] - a[1]), dLng = rad(b[0] - a[0]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const chaveNo = (p) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;

// Traçado da rua como grafo (os trechos do OSM se ligam pelos pontos em comum)
function montarRua(linhas) {
  const nos = new Map(); // chave -> { p, viz: [{ k, w }] }
  const segs = [];
  const no = (p) => {
    const k = chaveNo(p);
    if (!nos.has(k)) nos.set(k, { p: [Number(p[0].toFixed(7)), Number(p[1].toFixed(7))], viz: [] });
    return k;
  };
  for (const linha of linhas) {
    for (let i = 0; i + 1 < linha.length; i++) {
      const a = no(linha[i]), b = no(linha[i + 1]);
      if (a === b) continue;
      const w = distM(nos.get(a).p, nos.get(b).p);
      nos.get(a).viz.push({ k: b, w });
      nos.get(b).viz.push({ k: a, w });
      segs.push({ a, b, w });
    }
  }
  return { nos, segs };
}

// Ponto da rua mais perto de p: { a, b, w, t } (t = fração de a pra b) ou null
function projetar(rua, p) {
  const k = Math.cos(p[1] * Math.PI / 180);
  let melhor = null;
  for (const s of rua.segs) {
    const u = rua.nos.get(s.a).p, v = rua.nos.get(s.b).p;
    const ax = (u[0] - p[0]) * k, ay = u[1] - p[1], dx = (v[0] - u[0]) * k, dy = v[1] - u[1];
    const dd = dx * dx + dy * dy;
    const t = dd === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / dd));
    const d = distM(p, [u[0] + t * (v[0] - u[0]), u[1] + t * (v[1] - u[1])]);
    if (!melhor || d < melhor.d) melhor = { d, a: s.a, b: s.b, w: s.w, t };
  }
  return melhor && melhor.d <= MAX_PROJECAO_M ? melhor : null;
}

// Distância pelo traçado de uma projeção até cada nó (Dijkstra simples - a rua
// tem poucas centenas de nós)
function distancias(rua, pr) {
  const D = new Map();
  const fila = [[pr.t * pr.w, pr.a], [(1 - pr.t) * pr.w, pr.b]];
  while (fila.length) {
    let i = 0;
    for (let j = 1; j < fila.length; j++) if (fila[j][0] < fila[i][0]) i = j;
    const [d, k] = fila.splice(i, 1)[0];
    if (D.has(k)) continue;
    D.set(k, d);
    for (const { k: m, w } of rua.nos.get(k).viz) if (!D.has(m)) fila.push([d + w, m]);
  }
  return D;
}
// Distância pelo traçado da origem de D (projeção pr) até o ponto a x metros
// de s.a no trecho s - inclusive no próprio trecho da origem, que o Dijkstra
// (só de nó em nó) não enxerga
function distNoTrecho(D, pr, s, x) {
  let d = Math.min((D.get(s.a) ?? Infinity) + x, (D.get(s.b) ?? Infinity) + (s.w - x));
  if (pr.a === s.a && pr.b === s.b) d = Math.min(d, Math.abs(x - pr.t * s.w));
  else if (pr.a === s.b && pr.b === s.a) d = Math.min(d, Math.abs((s.w - x) - pr.t * s.w));
  return d;
}
// da origem de D (projeção prOrigem) até a projeção pr
const distAte = (D, prOrigem, pr) => distNoTrecho(D, prOrigem, { a: pr.a, b: pr.b, w: pr.w }, pr.t * pr.w);

// Pontos do traçado a L metros (pelo caminho mais curto) da projeção prA, com
// a distância deles até prB
function pontosA(rua, DA, prA, DB, prB, L) {
  const out = [];
  for (const s of rua.segs) {
    const xs = [L - (DA.get(s.a) ?? Infinity), s.w - (L - (DA.get(s.b) ?? Infinity))];
    if (prA.a === s.a && prA.b === s.b) xs.push(prA.t * s.w - L, prA.t * s.w + L);
    if (prA.a === s.b && prA.b === s.a) xs.push(s.w - (prA.t * s.w - L), s.w - (prA.t * s.w + L));
    for (const x of xs) {
      if (!(x >= 0 && x <= s.w)) continue;
      if (Math.abs(distNoTrecho(DA, prA, s, x) - L) > 0.5) continue;
      const f = s.w ? x / s.w : 0;
      const pa = rua.nos.get(s.a).p, pb = rua.nos.get(s.b).p;
      out.push({ p: [pa[0] + f * (pb[0] - pa[0]), pa[1] + f * (pb[1] - pa[1])], dB: distNoTrecho(DB, prB, s, x) });
    }
  }
  return out;
}

function mediaSeUnica(ps) {
  if (!ps.length) return null;
  const m = [ps.reduce((s, p) => s + p[0], 0) / ps.length, ps.reduce((s, p) => s + p[1], 0) / ps.length];
  return ps.every((p) => distM(m, p) <= MAX_ESPALHO_M) ? m : null;
}

// enderecos: Map numero -> [lng, lat] da mesma rua; linhas: traçado
// ([[lng, lat], ...] por trecho); numero: inteiro. Devolve
// { longitude, latitude, nivel, modo } ou null.
function estimarPeloNumero({ enderecos, linhas, numero }) {
  const n = Number(numero);
  if (!Number.isInteger(n) || n <= 0 || !enderecos || !enderecos.size) return null;
  const pronto = (p, nivel, modo) => ({ longitude: p[0], latitude: p[1], nivel, modo });
  if (enderecos.has(n)) return pronto(enderecos.get(n), 'numero', 'exato');

  const rua = montarRua(linhas || []);
  const proj = new Map();
  for (const [k, p] of enderecos) {
    const pr = rua.segs.length ? projetar(rua, p) : null;
    if (pr) proj.set(k, pr);
  }
  const todos = [...enderecos.keys()].sort((a, b) => a - b);
  const lo = todos.filter((k) => k < n), hi = todos.filter((k) => k > n);

  if (lo.length && hi.length) {
    const A = lo[lo.length - 1], B = hi[0];
    const pa = enderecos.get(A), pb = enderecos.get(B);
    const f = (n - A) / (B - A);
    // reserva quando o traçado não liga os dois (trecho da rua sem nome ou
    // desconectado no OSM - na Av. Brasil de Maringá, por exemplo)
    let reta = null;
    const mpnReta = distM(pa, pb) / (B - A);
    if (B - A <= VAO_RETA_MAX && mpnReta >= (B - A <= VAO_RETA ? 0.3 : 0.75) && mpnReta <= (B - A <= VAO_RETA ? 3 : 1.25)) {
      reta = [pa[0] + f * (pb[0] - pa[0]), pa[1] + f * (pb[1] - pa[1])];
    }
    const prA = proj.get(A), prB = proj.get(B);
    if (prA && prB) {
      const DA = distancias(rua, prA), DB = distancias(rua, prB);
      const dAB = distAte(DA, prA, prB);
      const mpn = dAB / (B - A);
      if (Number.isFinite(dAB) && mpn >= 0.3 && mpn <= 3) {
        const L = f * dAB;
        const m = mediaSeUnica(pontosA(rua, DA, prA, DB, prB, L).filter((c) => Math.abs(c.dB - (dAB - L)) < 30).map((c) => c.p));
        if (m) return pronto(m, 'interpolado', 'entre');
      }
    }
    return reta ? pronto(reta, B - A <= VAO_RETA ? 'interpolado' : 'estimado', 'entre_reta') : null;
  }

  // só de um lado: o conhecido mais perto (A) e outro a BASE_MIN+ dele (B)
  const lado = (lo.length ? [...lo].reverse() : hi).filter((k) => proj.has(k));
  const A = lado[0];
  const B = lado.find((k) => Math.abs(k - A) >= BASE_MIN);
  if (A === undefined || B === undefined) return null;
  const prA = proj.get(A), prB = proj.get(B);
  const DA = distancias(rua, prA), DB = distancias(rua, prB);
  const dAB = distAte(DA, prA, prB);
  const mpn = dAB / Math.abs(B - A);
  if (!Number.isFinite(dAB) || mpn < 0.6 || mpn > 1.6) return null;
  const salto = Math.abs(n - A);
  const L = salto * mpn;
  // se afastando de B: a distância até B cresce junto com o caminho
  const m = mediaSeUnica(pontosA(rua, DA, prA, DB, prB, L).filter((c) => c.dB >= dAB + 0.7 * L).map((c) => c.p));
  if (!m) return null;
  return pronto(m, salto <= SALTO_INTERPOLADO ? 'interpolado' : 'estimado', 'um_lado');
}

const numeroInteiro = (s) => {
  const m = /^\s*(\d+)/.exec(String(s == null ? '' : s));
  return m ? Number(m[1]) : null;
};

// Overpass: endereços com número e vias com o nome exato da rua, perto do ponto
// dela. Devolve { enderecos, linhas }. Lança erro se o serviço falhar.
async function consultarOverpass({ latitude, longitude, rua }, fetchFn = fetch) {
  const nome = String(rua).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const perto = `around:${RAIO_M},${Number(latitude)},${Number(longitude)}`;
  const q = `[out:json][timeout:25];(way(${perto})["highway"]["name"="${nome}"];`
    + `nwr(${perto})["addr:street"="${nome}"]["addr:housenumber"];);out tags geom;`;
  const resp = await fetchFn(OVERPASS_URL, {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ data: q }).toString(),
    signal: AbortSignal.timeout(40000),
  });
  if (!resp.ok) throw new Error(`Overpass respondeu ${resp.status}`);
  const json = await resp.json().catch(() => null);
  if (!json || !Array.isArray(json.elements)) throw new Error('Overpass devolveu resposta inválida');
  const enderecos = new Map();
  const linhas = [];
  for (const el of json.elements) {
    const tags = el.tags || {};
    const geo = Array.isArray(el.geometry) ? el.geometry.filter((g) => g && Number.isFinite(g.lon) && Number.isFinite(g.lat)).map((g) => [g.lon, g.lat]) : [];
    if (tags.highway && el.type === 'way' && geo.length >= 2) linhas.push(geo);
    if (tags['addr:housenumber'] !== undefined) {
      const n = numeroInteiro(tags['addr:housenumber']);
      let p = null;
      if (el.type === 'node' && Number.isFinite(el.lat) && Number.isFinite(el.lon)) p = [el.lon, el.lat];
      else if (geo.length) p = [geo.reduce((s, g) => s + g[0], 0) / geo.length, geo.reduce((s, g) => s + g[1], 0) / geo.length];
      if (n && p && !enderecos.has(n)) enderecos.set(n, p);
    }
  }
  return { enderecos, linhas };
}

// Refina o ponto da rua do Nominatim: { latitude, longitude, nivel } ou null
// (sem dado suficiente). Lança erro se o Overpass falhar.
async function posicaoPeloNumero({ latitude, longitude, rua, numero }, fetchFn = fetch) {
  const n = numeroInteiro(numero);
  if (!n || !rua) return null;
  const { enderecos, linhas } = await consultarOverpass({ latitude, longitude, rua }, fetchFn);
  const r = estimarPeloNumero({ enderecos, linhas, numero: n });
  return r ? { latitude: r.latitude, longitude: r.longitude, nivel: r.nivel } : null;
}

module.exports = { estimarPeloNumero, consultarOverpass, posicaoPeloNumero, numeroInteiro, distM, OVERPASS_URL };
