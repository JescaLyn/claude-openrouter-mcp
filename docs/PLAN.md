# Build Plan — openrouter-mcp

## Vision

MCP server packaged as a Claude Code plugin (also distributed standalone via npm). Exposes OpenRouter models as named tools so Claude Code sessions can delegate leaf-node work — summarize, extract, classify, translate, OCR, code explanation, commit messages, etc. — to free models. Paid options exist for capabilities with no free path (image/audio/video generation, audio-in transcription) but require explicit per-call user approval.

## Operating Principle (locked in)

**Claude/free is the normal workflow. Paid OpenRouter is a rare, user-approved exception.** The MCP exists to save Claude's reasoning budget on tasks that don't need a frontier model — not to replace Claude.

## User Specs (locked in)

These reflect explicit user direction over the planning conversation. Don't quietly relax them.

- **No tool-name prefix.** MCP hosts namespace by server name; an `or_` / `openrouter_` prefix is redundant. Tools are `summarize`, `extract`, `commit_message`, etc.
- **`commit_message` style baked in.** Past-tense verbs, sentence case, ends with period. Parallel structure for multi-change ("Fixed X, added Y, and removed Z."). Plain ASCII. "and" not symbols. Describe what and why, not where. No `style` parameter; only optional `scope_hint?`.
- **Paid escalation default OFF.** Tool returns `PAID_CONFIRMATION_REQUIRED` error envelope with `estimated_cost_usd` + `cost_breakdown`. User must explicitly retry with `allow_paid: true` per call. **No global env override that bypasses the prompt. No daily budget cap.**
- **Skip embeddings.** Wrong API shape, no in-session use.
- **Skip filesystem-style file-path tools.** Text-in / text-out only. Don't duplicate the official `server-filesystem` MCP and inherit its sandboxing surface (CVE-2025-53109/53110).
- **Plugin packaging is primary.** `userConfig.openrouter_api_key` (sensitive, required) prompts at install. Also publish standalone npm.
- **README for users; CLAUDE.md for Claude sessions.** Both required, both shipped.
- **Build draft of all 22 tools — no deferrals.**

## Architecture

- **Language**: TypeScript (best MCP SDK support, most examples)
- **Transport**: stdio (local tool, no ports)
- **SDK**: `@modelcontextprotocol/sdk`
- **Distribution**: Claude Code plugin (`.claude-plugin/plugin.json`) + standalone npm bin
- **Key management**: API key via plugin `userConfig` → injected as `OPENROUTER_API_KEY` env. Never in `settings.json`.
- **Stdout discipline**: stdio JSON-RPC channels corrupt if any import writes to stdout. Save fd1 to a fallback before any module that could log (probe, dotenv, SDK init), restore after handshake setup. Cheap insurance even when no current dep is noisy.
- **DI, no module-level singletons**: `OpenRouterClient` is instantiated once at server startup and **passed** into each tool handler as context. Tools never `import` the client at module scope. Makes tool-level testing trivial (instantiate against a fake) and avoids the dominant testing-pain pattern from prior-art audit.
- **Per-call timeout**: `AbortSignal.timeout(60_000)` wraps every fetch to OpenRouter. Override at the tool level only for `generate_video` (poll loop has its own `poll_timeout_seconds`).
- **Provider routing defaults** (server-level, NOT per-tool params): `data_collection: "deny"` (skip prompt-logging providers — matters because we route code/diffs/text), `require_parameters: true` (no silent JSON-schema fallback), `sort: "latency"`, `allow_fallbacks: true`. The only way to override these is via `query_model.extra` passthrough — keeps the tool surface small.
- **Startup probe**: `GET https://openrouter.ai/api/frontend/models`, fall back to `/api/v1/models` if frontend shape changes, fall back to bundled offline pricing snapshot (`src/models.snapshot.json`, refreshed at build time) if both fail. Validate curated `models.ts` map against live free list; warn on stale entries.
- **Lazy-init credential gate**: if `OPENROUTER_API_KEY` is missing/empty at startup, register tools normally but every handler returns a structured `MISSING_CREDENTIAL` error rather than crashing. Lets the plugin flow surface a useful error instead of a process-exit before MCP handshake.
- **Three-tier fallback** (per call): free primary → free fallback → cheap-paid escalation (only if `allow_paid: true`) → surfaced error.
- **429 retry**: read both `Retry-After` (HTTP standard) and `X-RateLimit-Reset` (OpenRouter-specific). If `Retry-After` ≤ 60s, sleep + single retry. If > 60s or absent and `X-RateLimit-Reset` is far future, fail fast with `RATE_LIMITED`. **Don't parse the header and ignore it** — that was the #1 lesson from the repo-analysis audit.
- **`models.ts` lookup**: hash-map keyed by `task_type` and a separate `Map<string, ModelEntry>` keyed by full model id. O(1) lookups; cleaner code than linear scan even at 40 entries.
- **`context_length` from live probe, NOT hardcoded.** Hand-maintaining a `MODEL_TOKEN_LIMITS` dict is a known anti-pattern. The startup probe populates it.
- **Iteration cap**: max 3 fallbacks per call (per global iteration-caps rule).
- **No silent failures** (per global rule): every failed agent / failed call logs `(stage, error_code, message)`.

## Common Response Envelopes

Success:
```json
{
  "result": "...",
  "model_used": "openai/gpt-oss-120b",
  "usage": { "tokens_in": 0, "tokens_out": 0 },
  "finish_reason": "stop",
  "fallback_chain": ["openai/gpt-oss-120b"],
  "cost_usd": 0
}
```

Error:
```json
{
  "error": {
    "code": "PAID_CONFIRMATION_REQUIRED",
    "message": "Free fallbacks exhausted; paid escalation requires approval.",
    "retryable": true,
    "suggested_action": "Retry with allow_paid: true to charge $0.031.",
    "estimated_cost_usd": 0.031,
    "cost_breakdown": "FLUX.2 Pro · 1 image · 1024×1024 · 1MP × $0.030"
  }
}
```

### Error code taxonomy
- `UPSTREAM_HTTP` — non-success from OpenRouter
- `UPSTREAM_TIMEOUT`
- `MODEL_NOT_FOUND` (hint: call `list_free_models`)
- `RATE_LIMITED` (echoes `X-RateLimit-Reset` and `Retry-After`)
- `FREE_EXHAUSTED` (all free fallbacks failed; no paid permission)
- `PAID_CONFIRMATION_REQUIRED` (paid escalation needs `allow_paid: true`)
- `RESOURCE_TOO_LARGE` (input exceeds context)
- `INVALID_INPUT` (schema validation failure)
- `MISSING_CREDENTIAL` (`OPENROUTER_API_KEY` unset; suggested action: configure plugin or `.mcp.json` env)

## Tool Surface — 22 Tools

Full specifications in `docs/TOOLS.md`. Quick map:

| Group | Tools |
|---|---|
| Foundation (3) | `query_model`, `query_free`, `list_free_models` |
| Text wrappers (5) | `summarize`, `extract`, `classify`, `translate`, `rewrite` |
| Code wrappers (5) | `explain_code`, `generate_docstring`, `generate_regex`, `generate_sql`, `commit_message` |
| Free input-processing (5) | `extract_text` (OCR), `analyze_image`, `read_pdf`, `analyze_video`, `query_long_context` |
| Paid generation (3) | `generate_image`, `generate_audio` (TTS), `generate_video` |
| Paid input-processing (1) | `transcribe` (STT) |

## Plugin Layout

```
openrouter-mcp/
├── .claude-plugin/
│   └── plugin.json              # manifest + userConfig.openrouter_api_key (sensitive)
├── src/
│   ├── server.ts                # MCP entry (stdio); stdout discipline guard runs FIRST
│   ├── client.ts                # OpenRouterClient — fallback chain, retries, paid gate
│   ├── models.ts                # per-task curated model map (primary + fallback + paid)
│   ├── models.snapshot.json     # offline fallback for /api/frontend/models (build-time prefetch)
│   ├── envelope.ts              # success/error envelope builders
│   ├── probe.ts                 # /api/frontend/models with /api/v1/models, then snapshot fallback
│   ├── prompt.ts                # wrapUntrusted() + shared prompt composition helpers
│   └── tools/
│       ├── query_model.ts
│       ├── query_free.ts
│       ├── list_free_models.ts
│       ├── summarize.ts
│       ├── extract.ts
│       ├── classify.ts
│       ├── translate.ts
│       ├── rewrite.ts
│       ├── explain_code.ts
│       ├── generate_docstring.ts
│       ├── generate_regex.ts
│       ├── generate_sql.ts
│       ├── commit_message.ts
│       ├── extract_text.ts
│       ├── analyze_image.ts
│       ├── read_pdf.ts
│       ├── analyze_video.ts
│       ├── query_long_context.ts
│       ├── generate_image.ts
│       ├── generate_audio.ts
│       ├── generate_video.ts
│       └── transcribe.ts
├── tests/
├── scripts/
│   └── probe-models.ts          # npm run probe:models — diff curated map vs live free list
├── .mcp.json                    # uses ${user_config.openrouter_api_key}
├── CLAUDE.md
├── README.md
├── docs/
│   ├── PLAN.md (this file)
│   ├── RESEARCH.md
│   ├── TOOLS.md
│   └── MODELS.md
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

## Build Phases

### Phase 0 — Plugin scaffold *(direct, no subagent)*
- `package.json` (TS, vitest, MCP SDK), `tsconfig.json`, `.gitignore`
- `.claude-plugin/plugin.json` with `userConfig.openrouter_api_key` (type: string, sensitive: true, required: true)
- `.mcp.json` template using `${user_config.openrouter_api_key}`
- npm bin entry, basic stdio MCP server skeleton
- ~1 commit

### Phase 1 — Core client + foundation tools *(direct)*
- `client.ts`: auth, request, three-tier fallback, 429-with-`X-RateLimit-Reset` retry (cap at 1), 5xx fallback, paid-gate logic, error taxonomy, provider routing defaults
- `probe.ts`: startup probe of `/api/frontend/models` (fallback to `/api/v1/models`), apply pricing trap check, validate curated map
- `envelope.ts`: success/error envelope builders
- `models.ts`: per-task curated model map (see `docs/MODELS.md`)
- Tools: `query_model`, `query_free`, `list_free_models`
- `scripts/probe-models.ts` for offline diff
- Tests: retry/fallback/paid-gate/error-shape/envelope round-trip
- ~2 commits

### Phase 2 — Wrappers *(4 parallel subagents)*
Each agent gets a related cluster, same brief shape (schema, prompt template, input validation, response envelope, tool description with "when to use / when NOT to use", smoke-test fixture).

- **Agent A — Text (5)**: `summarize`, `extract`, `classify`, `translate`, `rewrite`
- **Agent B — Code (5)**: `explain_code`, `generate_docstring`, `generate_regex`, `generate_sql`, `commit_message`
- **Agent C — Free input-processing (5)**: `extract_text`, `analyze_image`, `read_pdf` (with `file-parser` plugin + `cloudflare-ai` engine, opt-in `mistral-ocr`), `analyze_video`, `query_long_context`
- **Agent D — Paid (4)**: `generate_image`, `generate_audio` (TTS via `/api/v1/audio/speech`), `generate_video` (async polling), `transcribe` (STT). All with cost-confirmation flow.

Each agent's deliverable: tool file + tests + tool description copy.

### Phase 3 — Docs *(2 parallel subagents)*
- **Agent E — README.md**: install (plugin + npm paths), per-tool one-liner usage examples, free-vs-paid policy, troubleshooting (rate limits, model deprecation, plugin keychain prompt)
- **Agent F — CLAUDE.md**: tool decision tree, free-as-default principle, paid-confirm flow, refresh procedure, pricing trap warning

### Phase 4 — Review + ship *(2 parallel subagents, then direct)*
- `code-reviewer` on full diff
- `/security-review` (env/key handling, prompt-injection on pass-through inputs, log scrubbing for `commit_message`/`pr_description` diffs that may leak secrets)
- Direct: address findings, stage commit (user commits per global git rule)

## Reference Reading

- `docs/RESEARCH.md` — consolidated findings from 9 research agents over planning
- `docs/TOOLS.md` — full tool API specs
- `docs/MODELS.md` — verified free model list, per-task map, paid pricing, refresh procedure
- `CLAUDE.md` — Claude operational guide (loaded every session)
- `README.md` — human onramp

## Open Items

None blocking implementation. To revisit if/when usage data shapes them:

1. Whether to merge `extract_text` and `analyze_image` into one tool with `mode` param. Research recommends keeping separate (Claude routinely confuses transcribe-vs-describe; specialist OCR model is materially better at OCR).
2. Whether to add `compare_models`, `review_diff`, or id-based `summarize_files` (token-saving cache). Validated by prior art but speculative for our use case.
3. Whether `analyze_media` mega-tool would simplify the multimodal surface. Anthropic guidance: separate affordances win.
4. **Streaming**: v1 is non-streaming (leaf-node tasks are short). If added later, day-one requirements are: `if (!content) continue;` skip-empty-chunks guard, `AbortSignal.timeout` per chunk, real cancel path that actually stops the upstream stream (not just stops returning to caller).
5. **Preset surfacing**: at 22 tools, total tool-description weight is probably ~4–6K tokens. Measure after Phase 2; if it exceeds ~5K, consider preset groups (`text`/`code`/`media`) selectable via env var, modeled on the Cranot-roam-code 102→3 reduction.
6. **Anthropic-shaped response envelope** (vs our task-shaped envelope): rejected for v1 — our envelope is task-shaped, not chat-shaped, so the question doesn't apply.
7. **Tool-name collision check**: at v1, none of our 22 names collide with reserved Claude Code tool names. Add a one-time test that asserts this; revisit if Claude Code's built-in tool list grows.
