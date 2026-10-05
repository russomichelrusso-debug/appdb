#!/bin/bash
# Sessão na nuvem: instala as dependências pra `node test/run_tests.js` rodar
# logo de início (o contêiner vem sem node_modules).
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
npm install --no-audit --no-fund
