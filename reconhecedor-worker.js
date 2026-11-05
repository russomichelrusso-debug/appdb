// Reconhecedor por foto ("📷 Pela etiqueta") fora da tela (11/2026, relato do usuário: "uns 5 segundos do
// clique até a foto ser capturada"). O onnxruntime com 1 thread roda o DINOv2 inteiro de uma vez no fio
// que roda: na página, travava a tela ~3 s por foto num celular (medido com CPU 6x: 2,6-2,9 s) e o toque
// seguinte no botão da câmera só era atendido depois. Aqui ele roda num worker e a câmera continua livre.
//
// A página baixa e confere os 4 arquivos pelo hash (fetchConferido + cache do sw.js) e manda pra cá o
// texto dos dois scripts e os dois binários: este arquivo não baixa nada da CDN (importScripts não confere
// SRI). Mensagens: { tipo: 'carregar', ort, mjs, wasm, modelo } -> { tipo: 'carregado' } | { erro };
// { tipo: 'rodar', id, dados (Float32Array 3x224x224) } -> { id, vetor (Float32Array) } | { id, erro }.
'use strict';
let sessao = null;
self.onmessage = async (ev) => {
  const m = ev.data || {};
  if (m.tipo === 'carregar') {
    try {
      const ortUrl = URL.createObjectURL(new Blob([m.ort], { type: 'text/javascript' }));
      const mjsUrl = URL.createObjectURL(new Blob([m.mjs], { type: 'text/javascript' }));
      importScripts(ortUrl);
      self.ort.env.wasm.numThreads = 1; // GitHub Pages não tem cross-origin isolation: sem threads
      self.ort.env.wasm.wasmPaths = { mjs: mjsUrl }; // o .wasm vai pronto (wasmBinary), não é baixado
      self.ort.env.wasm.wasmBinary = m.wasm;
      sessao = await self.ort.InferenceSession.create(m.modelo, { executionProviders: ['wasm'] });
      self.ort.env.wasm.wasmBinary = null;
      self.postMessage({ tipo: 'carregado' });
    } catch (e) {
      self.postMessage({ tipo: 'carregado', erro: String((e && e.message) || e) });
    }
    return;
  }
  if (m.tipo === 'rodar') {
    try {
      if (!sessao) throw new Error('reconhecedor não carregado');
      const saida = await sessao.run({ pixel_values: new self.ort.Tensor('float32', m.dados, [1, 3, 224, 224]) });
      const vetor = saida.last_hidden_state.data.slice(0, m.dim);
      self.postMessage({ id: m.id, vetor }, [vetor.buffer]);
    } catch (e) {
      self.postMessage({ id: m.id, erro: String((e && e.message) || e) });
    }
  }
};
