// Miniatura da foto do produto pro catálogo sem internet (10/2026). A foto
// cheia (até 600 KB, 900 px) × ~1.800 produtos passaria de 500 MB no celular;
// a miniatura (lado maior de 300 px, ~15 KB) fica em ~30 MB e o app baixa
// todas em lote (POST /api/produto-fotos/miniaturas).
//
// jpeg-js (JavaScript puro) em vez do sharp: sem binário nativo pro Render
// instalar. Decodificar uma foto de 900 px leva dezenas de ms e trava o
// processo nesse tempo - por isso a rota gera poucas por vez e espera o
// próximo ciclo do Node entre uma e outra.
const jpeg = require('jpeg-js');

const MINI_LADO = 300;
const MINI_QUALIDADE = 72;

// Reduz pela média da área (cada pixel novo = média dos pixels que cobre):
// sem o serrilhado de pegar um pixel só.
function reduzir(rgba, w, h, nw, nh) {
  const saida = new Uint8Array(nw * nh * 4);
  const fx = w / nw, fy = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * fy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * fx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < h; yy++) {
        let i = (yy * w + x0) * 4;
        for (let xx = x0; xx < x1 && xx < w; xx++, i += 4) { r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++; }
      }
      const o = (y * nw + x) * 4;
      saida[o] = r / n; saida[o + 1] = g / n; saida[o + 2] = b / n; saida[o + 3] = 255;
    }
  }
  return saida;
}

// Buffer do JPEG cheio -> Buffer da miniatura, ou null se não deu pra ler.
// Foto que já é pequena (lado maior até 300 px) vira a própria miniatura.
function gerarMiniatura(imagem) {
  let img;
  try {
    img = jpeg.decode(imagem, { useTArray: true, formatAsRGBA: true, maxResolutionInMP: 30, maxMemoryUsageInMB: 256 });
  } catch (e) {
    return null;
  }
  if (!img || !img.width || !img.height) return null;
  const escala = Math.min(1, MINI_LADO / Math.max(img.width, img.height));
  if (escala === 1) return Buffer.from(imagem);
  const nw = Math.max(1, Math.round(img.width * escala)), nh = Math.max(1, Math.round(img.height * escala));
  const dados = reduzir(img.data, img.width, img.height, nw, nh);
  return Buffer.from(jpeg.encode({ data: dados, width: nw, height: nh }, MINI_QUALIDADE).data);
}

module.exports = { gerarMiniatura, MINI_LADO };

// ---- Geração numa thread à parte (worker_threads) ----
// O processo principal continua atendendo enquanto a miniatura sai. Uma thread
// só, uma foto por vez (fila de mensagens); se a thread cair, quem esperava
// recebe null e a próxima chamada abre outra.
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
let worker = null;
let proximoId = 0;
const esperando = new Map();

function abrirWorker() {
  const w = new Worker(__filename, { workerData: { miniaturaWorker: true } });
  w.on('message', ({ id, mini }) => {
    const resolve = esperando.get(id);
    if (!resolve) return;
    esperando.delete(id);
    resolve(mini ? Buffer.from(mini) : null);
  });
  const encerrar = () => {
    if (worker === w) worker = null;
    for (const resolve of esperando.values()) resolve(null);
    esperando.clear();
  };
  w.on('error', (e) => { console.error('Miniatura: erro na thread', e && e.message); encerrar(); });
  w.on('exit', encerrar);
  // depois dos listeners (o de 'message' liga de novo): não segura o processo
  // aberto (testes, SIGTERM do deploy)
  w.unref();
  return w;
}

function gerarMiniaturaSemTravar(imagem) {
  return new Promise((resolve) => {
    try {
      if (!worker) worker = abrirWorker();
      const id = ++proximoId;
      esperando.set(id, resolve);
      worker.postMessage({ id, imagem });
    } catch (e) {
      // sem worker_threads (não deveria acontecer no Node 18+): gera aqui mesmo
      resolve(gerarMiniatura(imagem));
    }
  });
}

if (!isMainThread && workerData && workerData.miniaturaWorker) {
  parentPort.on('message', ({ id, imagem }) => {
    let mini = null;
    try { mini = gerarMiniatura(Buffer.from(imagem)); } catch (e) { mini = null; }
    parentPort.postMessage({ id, mini });
  });
}

module.exports.gerarMiniaturaSemTravar = gerarMiniaturaSemTravar;
