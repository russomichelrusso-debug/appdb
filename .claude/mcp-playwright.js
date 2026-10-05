#!/usr/bin/env node
// Sobe o servidor MCP do Playwright (registrado em .mcp.json) com tela de
// celular (Pixel 7). Na sessão do Claude Code na nuvem o Chromium já vem
// instalado em /opt/pw-browsers e não pode ser baixado: usa ele, sem janela
// (e sem sandbox, que o Chromium recusa rodando como root no contêiner).
// Na máquina de alguém, o Playwright usa o navegador que achar/baixar.
const { spawn } = require('child_process');
const fs = require('fs');

const CHROMIUM_NUVEM = '/opt/pw-browsers/chromium';
const args = ['-y', '@playwright/mcp@latest', '--device', 'Pixel 7', '--isolated'];
if (fs.existsSync(CHROMIUM_NUVEM)) args.push('--headless', '--no-sandbox', '--executable-path', CHROMIUM_NUVEM);
args.push(...process.argv.slice(2));

const filho = spawn('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
filho.on('exit', codigo => process.exit(codigo ?? 1));
// o Claude Code encerra este processo; sem repassar, o navegador ficaria órfão
for (const sinal of ['SIGINT', 'SIGTERM']) process.on(sinal, () => filho.kill(sinal));
