#!/bin/bash
set -euo pipefail

# Resolve OPENROUTER_API_KEY from the environment or macOS Keychain.
#
# Platform support:
#   - All platforms: set OPENROUTER_API_KEY in your shell environment.
#   - macOS (optional): store in Keychain instead (see DEVELOPMENT.md).
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  : # already in environment — nothing to do
elif command -v security >/dev/null 2>&1; then
  OPENROUTER_API_KEY="$(security find-generic-password -a "openrouter-mcp" -s "openrouter-api-key" -w 2>/dev/null)" \
    || { echo "ERROR: OPENROUTER_API_KEY not set and not found in macOS Keychain." >&2
         echo "  Set it as an environment variable or store it: security add-generic-password -a openrouter-mcp -s openrouter-api-key -w" >&2
         exit 1; }
  export OPENROUTER_API_KEY
else
  echo "ERROR: OPENROUTER_API_KEY is not set." >&2
  echo "  Export it in your shell: export OPENROUTER_API_KEY=your_key_here" >&2
  exit 1
fi

exec npm run test:models:_internal -- "$@"
