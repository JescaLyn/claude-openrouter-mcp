# openrouter-mcp

MCP server / Claude Code plugin that lets Claude delegate routine work — summarize, extract, classify, OCR, code explanation, commit messages, image/audio/video gen — to OpenRouter models. Free for most tasks; paid options gated behind explicit per-call user approval.

## Quick Start

### 1. Get an OpenRouter API key

Sign up at [openrouter.ai/keys](https://openrouter.ai/keys). The free tier is enough for most usage; one-time $10 top-up raises daily limits from 50 to 1000 requests.

### 2. Install

**Build from source and register the server with `claude mcp add`.** The goal is to keep your API key out of `~/.claude.json` so Claude cannot read it — both credential store approaches below achieve this.

> **Claude Code plugin (coming soon).** Once published to npm, install via marketplace — the plugin prompts for your key and stores it securely. Use the source install below in the meantime.

```bash
# Clone, install, and build
git clone https://github.com/JescaLyn/openrouter-mcp && cd openrouter-mcp
npm install && npm run build
```

**Option 1 — Environment variable (all platforms):**

```bash
# 1. Create a helper script that reads from your environment
mkdir -p ~/.claude/helpers
cat > ~/.claude/helpers/start-openrouter-mcp.sh << 'EOF'
#!/bin/bash
# OPENROUTER_API_KEY is inherited from the shell environment at launch time.
exec node /absolute/path/to/openrouter-mcp/dist/server.js
EOF
chmod +x ~/.claude/helpers/start-openrouter-mcp.sh

# 2. Register the server
claude mcp add -s user openrouter -- /path/to/.claude/helpers/start-openrouter-mcp.sh

# 3. Export your key in your shell profile (~/.bashrc, ~/.zshrc, etc.)
export OPENROUTER_API_KEY="sk-or-..."
```

The key must be present in the shell environment when Claude Code launches.

**Option 2 — macOS Keychain (recommended on Mac):**

```bash
# 1. Store the key in Keychain (paste your API key when prompted)
security add-generic-password -a "openrouter-mcp" -s "openrouter-api-key" -w

# 2. Create a helper script (~/.claude/helpers/start-openrouter-mcp.sh)
mkdir -p ~/.claude/helpers
cat > ~/.claude/helpers/start-openrouter-mcp.sh << 'EOF'
#!/bin/bash
export OPENROUTER_API_KEY="$(security find-generic-password -a "openrouter-mcp" -s "openrouter-api-key" -w)"
exec node /absolute/path/to/openrouter-mcp/dist/server.js
EOF
chmod +x ~/.claude/helpers/start-openrouter-mcp.sh

# 3. Register the server (replace /absolute/path with your actual path)
claude mcp add -s user openrouter -- /path/to/.claude/helpers/start-openrouter-mcp.sh

# 4. Verify it registered
claude mcp list
```

The key stays in Keychain (macOS-native, no passphrase needed). Claude never sees the key — `~/.claude.json` only stores the path to the helper script.

**View, update, or delete the stored key (macOS):**
```bash
security find-generic-password -a "openrouter-mcp" -s "openrouter-api-key" -w   # view
security add-generic-password -a "openrouter-mcp" -s "openrouter-api-key" -w -U # update
security delete-generic-password -a "openrouter-mcp" -s "openrouter-api-key"    # delete
```

**After registering:** start a new Claude Code session, or type `/mcp` in an active session to reload. Tools won't appear until one of those two things happens.

**Scope reference** (`-s` flag):

| Scope | When it loads |
|---|---|
| `local` (default) | Only when Claude is opened from this project's directory |
| `user` | Every Claude Code session, any directory |
| `project` | Saved to `.mcp.json`; loads for anyone who clones the repo |

### 3. Verify

In a Claude Code session:

> "Use the openrouter list_free_models tool to show me what's available."

You should see ~28 free models grouped by capability. If you get `MISSING_CREDENTIAL`, the key isn't reaching the server — re-check your `claude mcp add` command and run `claude mcp list` to verify the server registered correctly.

## What Claude Sees vs. Doesn't See

- **Keychain approach (recommended):** Claude never sees the key. `~/.claude.json` stores the path to a helper script only. The helper script runs at server-spawn time; the key is retrieved from Keychain and injected directly into the server process environment, never entering Claude's context.
- **`-e` flag approach (testing only):** Passing `-e OPENROUTER_API_KEY=...` to `claude mcp add` writes the key to `~/.claude.json` in plaintext. Claude can read that file. Use this only for local testing.
- **Plugin (once published):** Key is handled via `userConfig` and stored securely by Claude Code; Claude never sees the plaintext value.
- The project's `.claude/settings.local.json` deny list blocks common exfiltration vectors (reading `.env*` files, keychain commands, `printenv OPENROUTER*`) to prevent accidental credential leakage via tool calls.

## Why this MCP exists

Claude Code sessions are excellent for orchestration, reasoning, and multi-step work — but burn context on routine leaf-node tasks (summarizing search results, classifying log lines, OCR-ing a screenshot) that a small free model handles fine. This server is the delegation surface: Claude calls a named tool, a free OpenRouter model does the work, the result comes back. No loss of orchestration, lower token cost, more headroom for Claude to do what it's actually good at.

**Operating principle: free is the default. Paid is a rare, user-approved exception.**

## Tools

22 tools, grouped by purpose. Full schemas in [`docs/TOOLS.md`](docs/TOOLS.md).

### Foundation
- **`query_model`** — raw passthrough; full control
- **`query_free`** — generic query against a curated free model (use as escape hatch)
- **`list_free_models`** — list currently-available free models

### Text
- **`summarize`** — compress text to a brief summary
- **`extract`** — pull fields into a JSON schema
- **`classify`** — assign input(s) to a closed label set
- **`translate`** — translate to another language
- **`rewrite`** — rewrite per an instruction

### Code
- **`explain_code`** — plain-language explanation
- **`generate_docstring`** — docstring / JSDoc / TSDoc
- **`generate_regex`** — regex from description + examples (validated against examples)
- **`generate_sql`** — SQL from schema + intent
- **`commit_message`** — commit message from staged diff (consistent style — past-tense, sentence case, period, what+why)

### Free input-processing
- **`extract_text`** — OCR via Qianfan-OCR-Fast (specialist; #1 on OmniDocBench)
- **`analyze_image`** — visual reasoning via Gemma 4 31B
- **`read_pdf`** — Q&A over PDFs (free Cloudflare extraction by default; opt-in `mistral-ocr` for complex layouts)
- **`analyze_video`** — frame-sampled video understanding (≤60s typical)
- **`query_long_context`** — route to 262K-context free models for haystack queries

### Paid generation (opt-in, per-call user approval)
- **`generate_image`** — FLUX.2 Klein 4B default (~$0.014/MP); FLUX.2 Pro upgrade
- **`generate_audio`** — TTS via OpenAI GPT-4o Mini TTS (~$0.003 per 5-min script)
- **`generate_video`** — Veo 3.1 Lite (~$0.15 per 5s 720p clip)

### Paid input-processing (opt-in)
- **`transcribe`** — STT via Mistral Voxtral Small (~$0.001 per 10 min)

## Paid Confirmation Flow

Paid tools never charge silently. The first call returns a structured error:

```json
{ "error": {
    "code": "PAID_CONFIRMATION_REQUIRED",
    "estimated_cost_usd": 0.031,
    "cost_breakdown": "FLUX.2 Pro · 1024×1024 · 1MP × $0.030",
    "suggested_action": "Retry with allow_paid: true to charge."
}}
```

Claude shows this to you. You explicitly approve. Claude retries with `allow_paid: true`. There's no env-var override and no daily budget cap — every paid call is its own consent moment.

## Configuration

Required:
- `OPENROUTER_API_KEY` — get one at [openrouter.ai/keys](https://openrouter.ai/keys). Plugin install handles this via `userConfig`; standalone install needs it in `.mcp.json` env.

That's it. No other configuration. The server picks sensible models per task; you can override via the `model` parameter on any tool.

## Free-Tier Notes

- 20 requests/minute global ceiling
- 50 requests/day baseline; **1000/day after a one-time $10 lifetime topup** on your OpenRouter account
- Failed requests still count against the daily quota
- The server reads `X-RateLimit-Reset` on 429s and retries once before falling back to the next model in the curated chain

## Project Documentation

- [`docs/PLAN.md`](docs/PLAN.md) — build plan, architecture, decisions
- [`docs/RESEARCH.md`](docs/RESEARCH.md) — consolidated research findings (free models, paid models, prior art, anti-patterns)
- [`docs/TOOLS.md`](docs/TOOLS.md) — full tool API specifications
- [`docs/MODELS.md`](docs/MODELS.md) — verified free model list, per-task curated map, refresh procedure
- [`CLAUDE.md`](CLAUDE.md) — contributor guide for Claude Code sessions working on this repo (auto-loaded by Claude Code)

## Examples

Claude calls these tools from a session — you don't usually call them directly. But to test connectivity once installed, ask Claude something like:

> "Use the openrouter list_free_models tool to show me what's available."

> "Summarize this article: <paste>. Use the openrouter summarize tool."

> "Generate an image of a sunset over a mountain. Use the openrouter generate_image tool — go ahead and approve the cost."

For the third example, Claude will first call `generate_image` *without* `allow_paid: true`. The tool returns a `PAID_CONFIRMATION_REQUIRED` envelope with the estimated cost (e.g. `~$0.014 for FLUX.2 Klein 4B at 1024×1024`). Claude shows that to you, you approve, Claude retries with `allow_paid: true`.

## Development

```bash
git clone https://github.com/JescaLyn/openrouter-mcp
cd openrouter-mcp
npm install
npm run build       # tsc → dist/
npm test            # vitest run, all tests (no API key needed)
npm run typecheck   # tsc --noEmit
npm run probe:models  # refresh src/models.snapshot.json against the live API
```

The regular test suite runs entirely against mocked clients — no API key required. For the live model comparison suite (`npm run test:models`), you also need an `OPENROUTER_API_KEY` and test fixture files — see [`tests/fixture/README.md`](tests/fixture/README.md).

Project layout:

```
src/
├── server.ts           # MCP entry point with stdout-discipline guard + lazy credential gate
├── client.ts           # OpenRouterClient — three-tier fallback, 429 retry, paid gate
├── models.ts           # per-task curated map; Provider routing defaults
├── models.snapshot.json # offline fallback for /api/frontend/models
├── probe.ts            # live model probe with v1 + snapshot fallbacks
├── envelope.ts         # success/error envelope builders
├── prompt.ts           # composeMessages() + wrapUntrusted()
├── types.ts            # shared types
└── tools/              # 22 tool implementations, one file each
tests/                  # vitest unit tests, one per tool + foundation tests
scripts/probe-models.ts # CLI for refreshing the snapshot
docs/                   # PLAN, RESEARCH, TOOLS, MODELS — see CLAUDE.md
```

### How tools route models

Each task has a curated chain in `src/models.ts`: free primary → free fallback → cheap-paid escalation. The client walks the chain on each call: 5xx or 404 falls through immediately; 429 honors `Retry-After` and `X-RateLimit-Reset` headers and retries once before falling through. The paid step only runs when the caller passes `allow_paid: true` — otherwise the chain returns `PAID_CONFIRMATION_REQUIRED` with the cost estimate after both free attempts fail.

### Refreshing the curated free model list

OpenRouter's free tier shifts. If a curated model returns `MODEL_NOT_FOUND`:

```bash
npm run probe:models
```

Prints a diff between `src/models.ts` and the live free list, surfaces newly-added free options, and writes a fresh offline snapshot to `src/models.snapshot.json`. Then update the affected entry in `src/models.ts`.

See [`docs/MODELS.md`](docs/MODELS.md) for the full refresh procedure and the **pricing trap** (image/audio/video models legitimately show $0/$0 in OpenRouter's UI token columns; the actual price lives in `pricing.image_output`, `pricing.audio`, or `pricing.video_output`).

## License

MIT — see [LICENSE](LICENSE).
