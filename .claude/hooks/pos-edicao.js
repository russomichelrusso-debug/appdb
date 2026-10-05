#!/usr/bin/env node
// Hook PostToolUse (Edit/Write/MultiEdit): faz na hora as checagens que o
// fluxo de trabalho do CLAUDE.md pede antes de commitar.
//  - página .html da raiz → scripts/checar-html.js (sintaxe dos <script>, CRLF do index.html)
//  - arquivo .js → node --check
//  - backend (routes/, server.js, importadores.js, schema.sql, test/…) → node test/run_tests.js
// Falha sai com código 2: o Claude recebe o erro e corrige antes de seguir.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const raiz = process.env.CLAUDE_PROJECT_DIR || path.resolve(__dirname, '../..');

const BACKEND = [
  /^routes\//, /^middleware\//, /^test\//,
  /^server\.js$/, /^db\.js$/, /^auth-utils\.js$/, /^clientMatcher\.js$/,
  /^importadores\.js$/, /^schema\.sql$/,
];

function rodar(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: raiz, encoding: 'utf8', timeout: 120000 });
  return { ok: r.status === 0, saida: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

function ultimasLinhas(texto, n) {
  return texto.split('\n').slice(-n).join('\n');
}

let entrada = '';
process.stdin.on('data', c => { entrada += c; });
process.stdin.on('end', () => {
  let arquivo;
  try {
    arquivo = JSON.parse(entrada).tool_input.file_path;
  } catch {
    return;
  }
  if (!arquivo) return;
  const rel = path.relative(raiz, path.resolve(raiz, arquivo)).split(path.sep).join('/');
  if (rel.startsWith('..') || rel.startsWith('node_modules/')) return;

  const falhas = [];

  if (/^[^/]+\.html$/.test(rel)) {
    const r = rodar('node', ['scripts/checar-html.js', rel]);
    if (!r.ok) falhas.push(r.saida);
  }

  if (rel.endsWith('.js')) {
    const r = rodar('node', ['--check', rel]);
    if (!r.ok) falhas.push(`node --check ${rel}:\n${r.saida}`);
  }

  if (BACKEND.some(re => re.test(rel)) && fs.existsSync(path.join(raiz, 'node_modules'))) {
    const r = rodar('node', ['test/run_tests.js']);
    if (!r.ok) falhas.push(`node test/run_tests.js falhou depois de editar ${rel}:\n${ultimasLinhas(r.saida, 40)}`);
  }

  if (falhas.length) {
    process.stderr.write(falhas.join('\n\n') + '\n');
    process.exit(2);
  }
});
