#!/bin/bash
# Sessão na nuvem: instala as dependências pra `node test/run_tests.js` rodar
# logo de início (o contêiner vem sem node_modules).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
npm install --no-audit --no-fund

# playwright-cli (navegador por linha de comando + skill do Claude Code). Versão
# fixa: trocar aqui quando quiser atualizar. Falha não derruba a sessão.
PLAYWRIGHT_CLI_VERSAO=0.1.22
if [ "$(playwright-cli --version 2>/dev/null || true)" != "$PLAYWRIGHT_CLI_VERSAO" ]; then
  npm install -g --no-audit --no-fund "@playwright/cli@$PLAYWRIGHT_CLI_VERSAO" \
    || echo "aviso: playwright-cli não instalou" >&2
fi
if command -v playwright-cli >/dev/null && [ ! -f "$HOME/.claude/skills/playwright-cli/SKILL.md" ]; then
  (cd "$HOME" && playwright-cli install --skills --global) \
    || echo "aviso: skill do playwright-cli não instalou" >&2
fi
# Ele procura o Google Chrome por padrão; no contêiner só há o Chromium de
# /opt/pw-browsers, que como root precisa rodar sem sandbox.
if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -x /opt/pw-browsers/chromium ]; then
  {
    echo "export PLAYWRIGHT_MCP_BROWSER=chromium"
    echo "export PLAYWRIGHT_MCP_EXECUTABLE_PATH=/opt/pw-browsers/chromium"
    echo "export PLAYWRIGHT_MCP_SANDBOX=false"
  } >> "$CLAUDE_ENV_FILE"
fi
