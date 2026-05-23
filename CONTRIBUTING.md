# Contributing

## Setup

```bash
git clone https://github.com/JescaLyn/openrouter-mcp
cd openrouter-mcp
npm install
npm run build
npm test
```

See [DEVELOPMENT.md](DEVELOPMENT.md) for the full guide — model chain updates, adding tools, running the model comparison suite, and the release checklist.

## Claude Code users

The `.claude/` folder contains Claude Code-specific tooling: the `model-evaluator` agent definition and the `run-tests` skill. These are optional — the core `npm run test:models` workflow works without them. Users of other AI coding assistants would use their tool's equivalent configuration directory.

## Key rules (from CLAUDE.md)

- Text-in / text-out only. Don't add `file_path` parameters to tools.
- Use `max_chars`, not `max_tokens`, for length caps.
- Wrap user-supplied text with `wrapUntrusted()` from `src/prompt.ts`.
- No `console.log` from import-time code — MCP transport is stdio JSON-RPC.
- ~400 LOC per tool file; ~600 for `client.ts`.
- No host-fingerprinting telemetry.

## Pull requests

- One logical change per PR.
- Run `npm run typecheck && npm test` before opening.
- If replacing a primary model in `src/models.ts`, include comparison test results in the PR description.
- Update `docs/TOOLS.md` and `docs/MODELS.md` if the tool surface or model list changes.
