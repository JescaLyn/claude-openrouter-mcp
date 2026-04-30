#!/bin/bash
set -euo pipefail

# Fetch OpenRouter API key from Keychain and run tests
OPENROUTER_API_KEY="$(security find-generic-password -a "openrouter-mcp" -s "openrouter-api-key" -w 2>/dev/null)" \
  || { echo "ERROR: failed to fetch openrouter-api-key from Keychain" >&2; exit 1; }
export OPENROUTER_API_KEY

# Run the test runner with all passed arguments
exec npm run test:models:_internal -- "$@"
