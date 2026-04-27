# openrouter-mcp

MCP server (also packaged as a Claude Code plugin) that exposes OpenRouter models as named tools for Claude Code sessions. Lets Claude delegate routine, leaf-node work — summarize, extract, classify, OCR, code explanation, commit messages, etc. — to free OpenRouter models to save context and tokens. Paid options exist for capabilities with no free path (image / audio / video generation, audio transcription) but require explicit per-call user approval.

> **Status: v0.1.0 draft.** All 22 tools are implemented and unit-tested. The plugin manifest is in place. End-to-end live testing against OpenRouter is the next step; see `docs/PLAN.md` for the build phase status.

## Why

Claude Code sessions are excellent for orchestration, reasoning, and multi-step work. But sessions burn context on routine leaf-node tasks (summarizing search results, classifying log lines, OCR-ing a screenshot) that a small free model handles fine. This MCP server is the delegation surface: Claude calls a named tool, a free OpenRouter model does the work, the result comes back. No loss of orchestration, lower token cost, more headroom for Claude to do what it's actually good at.

## Operating Principle

**Free OpenRouter is the default. Paid is a rare, user-approved exception.** This server is not trying to replace Claude or run side-by-side as a second brain — it's specifically for the work that doesn't need a frontier model.

## Quick Start

### Option 1 — Install as a Claude Code plugin (recommended)

```bash
# Coming soon: marketplace install command
claude plugin install openrouter-mcp@<source>
```

The plugin prompts for your OpenRouter API key at install time and stores it in your system keychain. Get a key at [openrouter.ai/keys](https://openrouter.ai/keys).

### Option 2 — Standalone MCP server (npm)

```bash
npm install -g openrouter-mcp
```

Add to your `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "openrouter": {
      "command": "npx",
      "args": ["openrouter-mcp"],
      "env": { "OPENROUTER_API_KEY": "your-key-here" }
    }
  }
}
```

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
- [`CLAUDE.md`](CLAUDE.md) — operational guide for Claude Code sessions (loaded automatically)

## Examples

Claude calls these tools from a session — you don't usually call them directly. But to test connectivity once installed, ask Claude something like:

> "Use the openrouter list_free_models tool to show me what's available."

> "Summarize this article: <paste>. Use the openrouter summarize tool."

> "Generate an image of a sunset over a mountain. Use the openrouter generate_image tool — go ahead and approve the cost."

For the third example, Claude will first call `generate_image` *without* `allow_paid: true`. The tool returns a `PAID_CONFIRMATION_REQUIRED` envelope with the estimated cost (e.g. `~$0.014 for FLUX.2 Klein 4B at 1024×1024`). Claude shows that to you, you approve, Claude retries with `allow_paid: true`.

## Development

```bash
git clone <repo>
cd openrouter-mcp
npm install
npm run build       # tsc → dist/
npm test            # vitest run, all tests
npm run typecheck   # tsc --noEmit
npm run probe:models  # refresh src/models.snapshot.json against the live API
```

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

## Build phase status

- ✅ **Phase 0** — Plugin scaffold (TS + MCP SDK + `.claude-plugin/plugin.json` with `userConfig.openrouter_api_key`)
- ✅ **Phase 1** — Core client + foundation tools (`query_model`, `query_free`, `list_free_models`)
- ✅ **Phase 2** — All 19 wrapper tools (text, code, free input-processing, paid generation)
- ✅ **Phase 3** — Docs polish
- ⏳ **Phase 4** — Code review + security review
- ⏳ Live end-to-end test against the OpenRouter API
- ⏳ Marketplace / npm publish

## License

MIT — see [LICENSE](LICENSE).
