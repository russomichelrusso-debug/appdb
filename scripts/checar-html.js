#!/usr/bin/env node
// Checagem das páginas .html sem bundler (CLAUDE.md, "Comandos"):
//  - sintaxe de cada bloco <script> inline (só compila, não executa);
//  - index.html tem que continuar todo em CRLF.
// Uso: node scripts/checar-html.js [arquivo.html ...]   (sem argumento: todos da raiz)
// Sai com 1 e lista os problemas quando algum falha.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const raiz = path.resolve(__dirname, '..');
const SO_CRLF = new Set(['index.html']);

function arquivosPadrao() {
  return fs.readdirSync(raiz).filter(f => f.endsWith('.html')).map(f => path.join(raiz, f));
}

function linhaDoOffset(texto, offset) {
  let n = 0;
  for (let i = 0; i < offset; i++) if (texto.charCodeAt(i) === 10) n++;
  return n;
}

function checarArquivo(arquivo) {
  const problemas = [];
  const nome = path.relative(raiz, arquivo) || arquivo;
  const texto = fs.readFileSync(arquivo, 'utf8');

  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  let blocos = 0;
  while ((m = re.exec(texto))) {
    const atributos = m[1];
    if (/\bsrc\s*=/i.test(atributos)) continue;
    const tipo = (atributos.match(/\btype\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (tipo && !/^(text\/javascript|application\/javascript|module)$/i.test(tipo)) continue;
    blocos++;
    const inicio = m.index + m[0].indexOf('>') + 1;
    try {
      new vm.Script(m[2], { filename: nome, lineOffset: linhaDoOffset(texto, inicio) });
    } catch (err) {
      const onde = (String(err.stack).match(new RegExp(nome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':(\\d+)')) || [])[1];
      problemas.push(`${nome}${onde ? ':' + onde : ''}: erro de sintaxe no <script> — ${err.message}`);
    }
  }

  if (SO_CRLF.has(path.basename(arquivo))) {
    const linhas = texto.split('\n');
    const soLf = [];
    for (let i = 0; i < linhas.length - 1; i++) {
      if (!linhas[i].endsWith('\r')) soLf.push(i + 1);
    }
    if (soLf.length) {
      problemas.push(`${nome}: ${soLf.length} linha(s) com fim de linha LF, o arquivo é CRLF ` +
        `(ex.: linha ${soLf.slice(0, 5).join(', ')}). Editar preservando CRLF.`);
    }
  }

  return { problemas, blocos };
}

const alvos = process.argv.slice(2).map(a => path.resolve(a));
const arquivos = alvos.length ? alvos : arquivosPadrao();
let total = 0;
const todos = [];
for (const arquivo of arquivos) {
  const { problemas, blocos } = checarArquivo(arquivo);
  total += blocos;
  todos.push(...problemas);
}

if (todos.length) {
  console.error(todos.join('\n'));
  process.exit(1);
}
console.log(`OK: ${arquivos.length} página(s), ${total} bloco(s) <script> inline sem erro de sintaxe.`);
