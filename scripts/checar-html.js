#!/usr/bin/env node
// Checagem das páginas .html sem bundler (CLAUDE.md, "Comandos"):
//  - sintaxe de cada bloco <script> inline (só compila, não executa);
//  - index.html tem que continuar todo em CRLF;
//  - página sem regra `.hidden` genérica (index.html): todo elemento com id que liga/desliga
//    a classe `hidden` (classList.add/remove/toggle('hidden') ou class="... hidden" no HTML)
//    precisa de uma regra `#id.hidden`/`.classe.hidden` com display: none, e não pode ter
//    display no style="" inline (o inline ganha e ele nunca some — PR #128).
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

  problemas.push(...checarHidden(texto, nome));

  return { problemas, blocos };
}

// ---- elementos que somem com .hidden ----
function regrasCss(texto) {
  const regras = [];
  const reStyle = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
  let m;
  while ((m = reStyle.exec(texto))) {
    const css = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
    const reRegra = /([^{}]+)\{([^{}]*)\}/g;
    let r;
    while ((r = reRegra.exec(css))) {
      const decl = r[2];
      const porDisplay = /(^|[;\s])display\s*:\s*none/i.test(decl);
      // .shareSheet/.loadingScreen somem com animação (transform/opacity), de propósito
      const porAnimacao = /(^|[;\s])(transform\s*:|opacity\s*:\s*0\s*(;|$)|visibility\s*:\s*hidden)/i.test(decl);
      if (!porDisplay && !porAnimacao) continue;
      const importante = /display\s*:\s*none\s*!important/i.test(decl);
      for (const sel of r[1].split(',')) regras.push({ sel: sel.trim(), porDisplay, importante });
    }
  }
  return regras;
}

// Último trecho composto do seletor (o que casa com o próprio elemento): "#a .b.hidden" → ".b.hidden".
function compostoFinal(sel) {
  const partes = sel.split(/[\s>+~]+/).filter(Boolean);
  return partes[partes.length - 1] || '';
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// O offset `off` está dentro do elemento `pai` ({ tag, off })? Conta abre/fecha da mesma tag.
function dentroDe(texto, pai, off) {
  if (!pai || off <= pai.off) return false;
  const nomeTag = pai.tag.match(/^<([\w-]+)/)[1];
  const re = new RegExp('<(/?)' + nomeTag + '\\b[^>]*>', 'gi');
  re.lastIndex = pai.off + pai.tag.length;
  let nivel = 1;
  let m;
  while ((m = re.exec(texto))) {
    if (m.index >= off) return true;
    nivel += m[1] ? -1 : 1;
    if (nivel === 0) return false;
  }
  return false;
}

function checarHidden(texto, nome) {
  const regras = regrasCss(texto)
    .map(r => ({ ...r, fim: compostoFinal(r.sel) }))
    .filter(r => /\.hidden(?![\w-])/.test(r.fim));
  if (regras.some(r => r.sel === '.hidden')) return []; // página com .hidden genérico

  // Tag de abertura que tem id="X" (no HTML ou em template de JS).
  const tags = new Map();
  const reTag = /<[a-zA-Z][\w-]*\b[^<>]*?\bid\s*=\s*"([\w-]+)"[^<>]*>/g;
  let t;
  while ((t = reTag.exec(texto))) if (!tags.has(t[1])) tags.set(t[1], { tag: t[0], off: t.index });

  const alvos = new Map(); // id -> linha onde liga/desliga
  const anota = (id, off) => { if (!alvos.has(id)) alvos.set(id, linhaDoOffset(texto, off) + 1); };

  // 1) document.getElementById('X')(?.)classList.*('hidden'
  const reDireto = /getElementById\(\s*['"]([\w-]+)['"]\s*\)\??\.classList\??\.(?:toggle|add|remove|contains)\(\s*['"]hidden['"]/g;
  let d;
  while ((d = reDireto.exec(texto))) anota(d[1], d.index);
  // 2) variavel.classList.*('hidden') → a atribuição mais próxima antes dela:
  //    variavel = document.getElementById('X') (ou $('X')).
  const reVar = /([A-Za-z_$][\w$]*)\??\.classList\??\.(?:toggle|add|remove)\(\s*['"]hidden['"]/g;
  let v;
  while ((v = reVar.exec(texto))) {
    const antes = texto.slice(Math.max(0, v.index - 6000), v.index);
    // a ÚLTIMA atribuição da variável, de qualquer tipo: só conta se ela for o
    // getElementById (uma `wrap = el.closest(...)` mais perto não pode herdar o id
    // de outra função - falso positivo achado pelo revisor-cortag)
    const reDecl = new RegExp('(?:^|[^\\w$.])' + escapeRe(v[1]) + '\\s*=(?!=)\\s*([^;\\n]*)', 'g');
    let ultimo = null;
    let x;
    while ((x = reDecl.exec(antes))) ultimo = x[1];
    const id = ultimo && (ultimo.match(/^(?:document\.getElementById|\$)\(\s*['"]([\w-]+)['"]\s*\)/) || [])[1];
    if (id) anota(id, v.index);
  }
  // 3) class="... hidden" já no HTML
  for (const [id, { tag, off }] of tags) {
    const cls = (tag.match(/\bclass\s*=\s*"([^"]*)"/) || [])[1] || '';
    if (/(^|\s)hidden(\s|$)/.test(cls)) anota(id, off);
  }

  const problemas = [];
  for (const [id, linha] of alvos) {
    const achado = tags.get(id);
    if (!achado) continue; // id montado em tempo de execução: não dá pra conferir aqui
    const classes = ((achado.tag.match(/\bclass\s*=\s*"([^"]*)"/) || [])[1] || '').split(/\s+/).filter(Boolean);
    const casam = regras.filter(r => {
      const fim = r.fim;
      if (/[:[]/.test(fim)) return false; // pseudo-classe/atributo: não dá pra garantir
      const ids = (fim.match(/#[\w-]+/g) || []).map(s => s.slice(1));
      const cls = (fim.match(/\.[\w-]+/g) || []).map(s => s.slice(1)).filter(c => c !== 'hidden');
      if (ids.some(i => i !== id)) return false;
      if (cls.some(c => !classes.includes(c))) return false;
      if (ids.length > 0 || cls.length > 0) return true;
      // "#pai .hidden": vale pro que está dentro de #pai
      const pai = (r.sel.match(/^#([\w-]+)\s+\.hidden$/) || [])[1];
      return !!pai && dentroDe(texto, tags.get(pai), achado.off);
    });
    if (!casam.length) {
      problemas.push(`${nome}:${linha}: #${id} liga/desliga .hidden mas não tem regra ` +
        `"#${id}.hidden { display: none }" (a página não tem .hidden genérico) — ele nunca some.`);
      continue;
    }
    const estilo = (achado.tag.match(/\bstyle\s*=\s*"([^"]*)"/) || [])[1] || '';
    if (/(^|;)\s*display\s*:/i.test(estilo) && casam.every(r => r.porDisplay) && !casam.some(r => r.importante)) {
      problemas.push(`${nome}:${linha}: #${id} liga/desliga .hidden mas tem display no style="" inline ` +
        `— o inline ganha da regra .hidden e ele nunca some (CLAUDE.md, "Pegadinhas").`);
    }
  }
  return problemas;
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
