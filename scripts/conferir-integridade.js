#!/usr/bin/env node
// Confere o hash (SRI) das bibliotecas de CDN: baixa cada endereço da LIBS do
// sw.js e compara o sha384 do arquivo com o hash gravado no sw.js e no index.html
// (INTEGRIDADE_CDN, import map do pdf.js, tag do html2canvas) e na tela-cliente.html.
// Rodar ao trocar a versão de uma biblioteca: endereço novo sem hash sai com o
// hash calculado, pra colar nos lugares acima.
//
// Uso: node scripts/conferir-integridade.js
// (o teste do run_tests.js confere, sem internet, que os lugares concordam entre si)
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const raiz = path.join(__dirname, '..');
const ler = (f) => fs.readFileSync(path.join(raiz, f), 'utf8');
const RE_PAR = /'(https:\/\/[^']+)',\s*'(sha384-[A-Za-z0-9+/=]+)'/g;

function hashesDoSw() {
  const sw = ler('sw.js');
  const bloco = (sw.match(/const LIBS = new Map\(\[([\s\S]*?)\]\);/) || [])[1] || '';
  return new Map([...bloco.matchAll(RE_PAR)].map(m => [m[1], m[2]]));
}

async function main() {
  const libs = hashesDoSw();
  if (libs.size === 0) throw new Error('LIBS do sw.js não encontrada.');
  const paginas = ler('index.html') + ler('tela-cliente.html');
  let erros = 0;
  for (const [url, gravado] of libs) {
    const resp = await fetch(url);
    if (!resp.ok) { console.log(`ERRO ${resp.status}: ${url}`); erros++; continue; }
    const real = 'sha384-' + crypto.createHash('sha384').update(Buffer.from(await resp.arrayBuffer())).digest('base64');
    const naoNasPaginas = !paginas.includes(real);
    if (real !== gravado) {
      console.log(`DIFERENTE: ${url}\n  gravado: ${gravado}\n  arquivo: ${real}`);
      erros++;
    } else if (naoNasPaginas) {
      console.log(`FALTA NAS PÁGINAS: ${url} (${real})`);
      erros++;
    } else {
      console.log(`OK: ${url}`);
    }
  }
  console.log(erros ? `\n${erros} problema(s).` : '\nTodos os hashes conferem.');
  process.exit(erros ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
