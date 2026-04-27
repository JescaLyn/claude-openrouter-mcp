# Research Findings — openrouter-mcp

This document consolidates findings from 9 research agents spawned during planning (2026-04-26 to 2026-04-27). Sources are linked inline; representative ones included so future-Claude can re-derive or refresh.

## 1. OpenRouter API Endpoints — Critical Distinction

OpenRouter exposes **two** model-listing endpoints with different coverage:

| Endpoint | Returns | Stable? | Use for |
|---|---|---|---|
| `GET /api/v1/models` | **360** chat-completion-style models only (text+vision-in / text-out). Silently filters out image/audio/video output. Returns `pricing: null` for non-chat models even when they appear. | Documented, stable | Fallback / reference |
| `GET /api/frontend/models` | **710** models — full catalog with all modalities. Includes `endpoint.is_free` flag and authoritative pricing in `pricing.image_output`, `pricing.audio`, `pricing.video_output`. | **Undocumented**, used by openrouter.ai UI | Primary — full picture |

**Implication:** the MCP client must probe `/api/frontend/models` at startup for full coverage. Fall back to `/api/v1/models` only if the frontend response shape changes (it could break without notice).

This was discovered the hard way: an early verification agent reported "30 free models, 0 image-gen" by hitting only `/api/v1/models`, missing the entire image catalog.

## 2. The Pricing Trap

OpenRouter's UI Models page shows columns "Input ($/M)" and "Output ($/M)" — **these are token prices only.** Image, audio, and video models legitimately show `$0/$0` in those columns because they don't bill by tokens. They bill via separate fields:

- `pricing.image_output` — per-image (e.g., $0.04 flat) or per-megapixel (e.g., $0.030/MP)
- `pricing.audio` — per-character (TTS) or per-minute (STT)
- `pricing.video_output` — per-clip or per-second
- `pricing.request` — flat per-call (rare)

**A model is truly free only when *all* non-zero pricing fields are zero or absent**, AND `endpoint.is_free === true` in the frontend response.

This trap caught the user's own visual inspection of the OpenRouter UI (Seedream 4.5 looked free, but actually $0.04/image).

## 3. Verified Free Models (28, as of 2026-04-26)

From `/api/frontend/models` filtered `endpoint.is_free === true`. Full table in `docs/MODELS.md`. Summary:

- **27 text-out models** — chat, code, reasoning, instruction-following. Strong options: `openai/gpt-oss-120b`, `qwen/qwen3-coder` (262K), `qwen/qwen3-next-80b-a3b-instruct` (262K), `meta-llama/llama-3.3-70b-instruct`, `nvidia/nemotron-3-super-120b-a12b` (262K), `inclusionai/ling-2.6-1t` (262K), `tencent/hy3-preview` (CJK strong), `google/gemma-4-31b-it`, `baidu/qianfan-ocr-fast`.
- **1 free embedding model** — `nvidia/llama-nemotron-embed-vl-1b-v2`. Not used (skipping embeddings — wrong API shape, no in-session use).
- **Zero free models** for: image generation, audio output (TTS), video output, audio input (STT), reranking, dedicated speech.

The aggregator sites (costgoat, teamday, brainroad) had stale data. Always go to the API.

## 4. Per-Task Free Model Recommendations

Full table in `docs/MODELS.md`. Key findings:

- **`openai/gpt-oss-120b`** is the single best workhorse — native tool use, structured-output support, strong on extract/classify, beats Qwen3-Coder on raw coding benchmark (7.35 vs 6.8). MoE 120B/12B-active is fast for the size.
- **`qwen/qwen3-coder` is the right code primary** for the 262K context window and tool-calling, with `gpt-oss-120b` as the *smart* fallback (not just availability fallback) for hard typed-language work.
- **`google/gemma-3-27b-it` for translation generally**, **`tencent/hy3-preview` for CJK** — Hy3 wins on Chinese/Japanese/Korean, Gemma weak on Hindi/Arabic.
- **`baidu/qianfan-ocr-fast` for OCR**: #1 on OmniDocBench v1.5 (93.12, beating Gemini 3 Pro's 90.33), #1 on OlmOCR Bench (79.8). 192 languages.
- **`nvidia/nemotron-3-super-120b-a12b` is a trap as primary for long-context** — too new (released April 2026). Use `qwen/qwen3-next-80b-a3b-instruct` (262K) primary, Nemotron as fallback after a month of observed stability.

### Strict JSON-schema support (verified)

OpenRouter's structured outputs require `supported_parameters` to include `structured_outputs`. Among free models, verified support:
- `openai/gpt-oss-120b`, `openai/gpt-oss-20b` — strongest free option for `extract`
- `google/gemma-3-27b-it`
- `meta-llama/llama-3.3-70b-instruct`
- `qwen/qwen3-coder` (weaker schema adherence)

NOT verified (newer models OpenRouter hasn't enabled the flag for): `inclusionai/ling-2.6-*`, `tencent/hy3-preview`, `nvidia/nemotron-3-*`. Treat these as "JSON via prompt instruction only" until the flag flips.

## 5. Free Input-Processing Capabilities

Verified via `architecture.input_modalities` field in `/api/frontend/models`:

| Modality (X → text) | Free path? | Best free model | Catch |
|---|---|---|---|
| Image → text (OCR) | Yes | `baidu/qianfan-ocr-fast` | OCR-only behavior; ctx 64K |
| Image → text (visual reasoning) | Yes | `google/gemma-4-31b-it` | Daily caps apply globally to `:free` pool |
| Image → text (general description) | Yes | `google/gemma-3-27b-it` | Older but proven, 131K ctx |
| Video → text | Yes (frame-sampled at 1fps, max ~60s) | `nvidia/nemotron-nano-12b-v2-vl` | Doesn't transcribe audio — frame analysis only |
| PDF / document → text | Yes — orthogonal to model | Any free chat model + `cloudflare-ai` engine via `file-parser` plugin | Free path is markdown extraction; loses fidelity on tables/math/multi-column. `mistral-ocr` engine ($2/1K pages) for those, paid-confirm |
| Audio → text (STT) | **No free option** | — | All audio-input models paid. Cheapest: `mistralai/voxtral-small-24b-2507` |
| Embeddings | Yes (1 free model) | `nvidia/llama-nemotron-embed-vl-1b-v2` | Skipping — wrong API shape, no in-session use |

PDF request shape (uses `file-parser` plugin):
```json
{
  "messages": [{
    "role": "user",
    "content": [
      { "type": "text", "text": "Summarize this PDF." },
      { "type": "file", "file": { "filename": "doc.pdf", "file_data": "data:application/pdf;base64,..." }}
    ]
  }],
  "plugins": [{ "id": "file-parser", "pdf": { "engine": "cloudflare-ai" }}]
}
```

## 6. Cheap Paid Generation Models

There are **no** free image / audio (TTS) / video / STT models on OpenRouter. Recommended cheap-but-good picks (per call costs at typical sizes):

| Modality | Recommended | OpenRouter ID | Per-call cost example |
|---|---|---|---|
| Image (cheapest) | FLUX.2 Klein 4B | `black-forest-labs/flux.2-klein-4b` | 1024×1024 (1MP): **$0.014** |
| Image (best <$0.05) | FLUX.2 Pro | `black-forest-labs/flux.2-pro` | 1MP: **$0.030**; 4MP: $0.12 |
| TTS (cheapest) | OpenAI GPT-4o Mini TTS | `openai/gpt-4o-mini-tts-2025-12-15` | 100 chars: **$0.00006**; 5-min script (5K chars): **$0.003** |
| Video (cheapest) | Veo 3.1 Lite (720p, no audio) | `google/veo-3.1-lite` | 5s 720p: **$0.15**; 10s 1080p: $0.50 |
| Video (best <$1) | Veo 3.1 Fast | `google/veo-3.1-fast` | 5s 1080p+audio: **$0.60** |
| STT (premium, cheap) | Mistral Voxtral Small | `mistralai/voxtral-small-24b-2507` | 10-min audio: **$0.001** |
| STT (multilingual) | Gemini 2.5 Flash Lite | `google/gemini-2.5-flash-lite` | 10-min audio: **$0.018** |

**Skip:**
- Sora 2 / Sora 2 Pro — sunset 2026-04-26
- Music generation (Lyria 3) — out of scope for a Claude Code MCP
- Audio-to-audio realtime — niche, expensive, no clear use case

### API call shapes

| Modality | Endpoint | Sync? |
|---|---|---|
| Image gen | `/api/v1/chat/completions` with `modalities: ["image","text"]` | Sync |
| TTS | `/api/v1/audio/speech` (dedicated, returns raw bytes) | Sync |
| STT | `/api/v1/chat/completions` with `input_audio` content block | Sync |
| Video gen | `POST /api/v1/videos` then poll `GET /api/v1/videos/{id}` | **Async (poll or webhook)** |

## 7. Industry Patterns — How Production Coding Agents Delegate

The "strong thinker / cheap doer" split is universal. Specifics:

- **Aider — `--weak-model`**: explicitly used for commit messages and chat-history summarization. Architect/editor split routes plans (architect, strong) → file edits (editor, can be cheaper).
- **Cursor — "Fast Apply"**: a fine-tuned Llama-3-70B speculative-edit specialist runs at ~1000 tok/s purely to apply a diff/edit produced by the strong model. Generic apply was abandoned because it kept reverting agent changes.
- **Continue.dev — model roles**: explicit role tags (`chat`, `autocomplete`, `edit`, `apply`, `embed`, `rerank`, `summarize`). Each role has its own promptTemplate slot.
- **Cline — Plan/Act with `planActSeparateModelsSetting`**: plan mode (read-only strategy) on cheaper model, act mode (file edits) on capable model.
- **Sourcegraph Cody**: switched autocomplete default to DeepSeek V2 (P75 latency −350ms, CAR +4%). Chat retains Claude/GPT/Gemini.
- **Roo Code Boomerang**: orchestrator delegates each subtask to a specialized mode in isolated context, returns only a summary — closest analog to what `openrouter-mcp` is doing.

**Universally routed-to-cheap-model jobs:** commit messages, fast-apply, autocomplete, summarization. Universally kept on the strong model: cross-file refactor, multi-step reasoning, anything tool-using.

## 8. Anti-Patterns Discovered

From audit of ~15 existing `openrouter-mcp` projects and similar:

1. **Stale model IDs hardcoded in README** — every generic OpenRouter MCP eventually ships a dead default. Mitigation: startup probe + `list_free_models` tool.
2. **No rate-limit handling** — free-tier 429s daily; many projects retry blindly. Mitigation: read `X-RateLimit-Reset`, single retry, then fall back.
3. **Generic `chat` tool only** — Claude has no affordance to choose it over its own reasoning. Servers with named task tools (`review_diff`, `summarize_files`) get used; generic ones don't.
4. **No SSRF / path safety** on file/URL-accepting tools. Mitigation: text-in/text-out, no file paths.
5. **Wrapping API endpoints 1:1** instead of agent affordances — forces multi-call sequencing the agent gets wrong.
6. **Over-parameterized signatures** — `create_extraction_chain(schema, llm, prompt, tags, verbose)` was deprecated. Lesson: required params should be 1–2.
7. **Opaque error blobs** — Anthropic guidance: errors must communicate "specific and actionable improvements." Use `suggested_action` field.
8. **`max_tokens` on summary tools** — tokens are model-specific; agents under/over-estimate. Use `max_chars`.
9. **Returning the entire raw LLM payload** — Anthropic: "return only high-signal information." Strip to envelope.
10. **JSON-mode without schema** — OpenAI now classifies plain JSON mode as legacy; use strict `json_schema`.
11. **Free-text labels for classification** — model invents categories. Always pass closed `labels` set.
12. **Cursor's generic apply model** — non-specialist apply "kept reverting agent changes" until they replaced it with a speculative-edits-tuned Llama. Lesson: don't route apply to a generalist free model casually.

## 9. Tools We Considered and Deferred or Dropped

| Tool | Status | Why |
|---|---|---|
| `pr_description` | Dropped | Overlaps `commit_message` |
| `explain_stacktrace` | Dropped | Claude already excellent; free model would be a downgrade |
| `apply_edit` (fast-apply pattern) | Deferred to v2 | No purpose-built free model; Claude's native Edit tool covers the case; paid Morph is good but violates "paid as rare exception" |
| `batch_transform` | Deferred to v2 | Claude fans out tool calls in parallel natively; marginal token savings; adds complexity |
| `compare_models` (fan-out) | Deferred to v2 | Cheap to add, validated by prior art, but speculative use case |
| `review_diff` | Deferred to v2 | Overlaps `commit_message`'s context; Claude itself reviews well |
| `summarize_files` with id-based content cache (Braffolk pattern) | Deferred to v2 | Genuine token-savings win, but adds server state; revisit if heavily used |
| `embed` | Skipped | Wrong API shape, no in-session use, separate ecosystem |
| Image generation tool | **Included as paid** | No free option exists |
| Audio gen / TTS | **Included as paid** | No free option |
| Video gen | **Included as paid** | No free option |
| Audio in / STT | **Included as paid (`transcribe`)** | No free option |
| `analyze_media` mega-tool | Skipped | Anthropic guidance: separate affordances win |

## 10. Cost / Safety Knobs (locked in by user)

- `OPENROUTER_API_KEY` (required, via `userConfig`)
- **NO `OPENROUTER_ALLOW_PAID` env override** — paid is always per-call user approval
- **NO daily budget cap** — every paid call requires its own confirmation
- Per-call `allow_paid?: boolean` — default `false`. When `false` and free fallbacks exhausted, return `PAID_CONFIRMATION_REQUIRED` with cost estimate. User retries with `allow_paid: true` to charge.

## 11. Provider Routing Defaults

```jsonc
"provider": {
  "sort": "latency",
  "data_collection": "deny",       // skip prompt-logging providers
  "require_parameters": true,      // no silent JSON-schema → json_object fallback
  "allow_fallbacks": true
}
```

`data_collection: "deny"` matters because the MCP routes user code/diffs/text — must not be retained for training.

## 12. Free-Tier Rate Limits (current)

- 20 requests/minute global ceiling across `:free` models
- 50 requests/day base; **1000 requests/day after $10 lifetime topup** (one-time threshold). User has crossed this.
- Failed requests still consume daily quota
- 429 response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (epoch ms). No `Retry-After`.

## 13. Headers — What's Actually Required

- **Required**: `Authorization: Bearer <key>`, `Content-Type: application/json`
- **Optional**: `HTTP-Referer`, `X-Title` — control whether the app appears in OpenRouter's public rankings/analytics. Not required for functionality. Skip unless we want attribution.

## 14. Plugin Packaging — Current Best Practice (April 2026)

- Manifest: `.claude-plugin/plugin.json`
- `userConfig.openrouter_api_key` with `sensitive: true, required: true` — Claude prompts at install, key lives in keychain
- `mcpServers: "./.mcp.json"` field auto-registers the bundled MCP server when plugin is enabled
- `.mcp.json` uses `${user_config.openrouter_api_key}` for substitution
- Distribute as plugin (marketplace) AND as standalone npm (for non-plugin users)

## 15. Findings from Repo-Analysis Inquiry (April 2026)

A separate inquiry surveyed 120 repositories for patterns relevant to building openrouter-mcp; 41 ranked high-relevance. Findings package: `~/Documents/dev/repo-analysis/findings/inquiries/openrouter-mcp/`.

The inquiry's framing assumed a general-purpose LLM gateway (multi-tier routing, scenario trees, circuit breakers, OTLP). That's a different shape than what we're building — a leaf-node delegator with 22 named tools — so most of the proposed action plan (adaptive concurrency, complexity scoring, multi-tenant patterns) does **not** apply. But several lower-level reliability and correctness patterns transferred cleanly and have been integrated into the design:

| Finding | Source | Integrated into |
|---|---|---|
| Stdout-discipline guard (stdio JSON-RPC corrupts on stray stdout writes) | `milla-jovovich/mempalace` `mcp_server.py:26-43` | `docs/PLAN.md § Architecture`, `CLAUDE.md` |
| DI client, no module-level singletons | `eyjolfurgudnivatne/mcp.gateway`, `orneryd/Mimir` | `docs/PLAN.md § Architecture`, `CLAUDE.md` |
| Honor `Retry-After` AND `X-RateLimit-Reset` | `adi-family/lib-client-openrouter`, `virattt/ai-hedge-fund` | `docs/PLAN.md § Architecture`, `CLAUDE.md` |
| `AbortSignal.timeout(60_000)` on every upstream call | `dzhng/deep-research` | `docs/PLAN.md § Architecture` |
| Pass-through `extra` parameter on `query_model` | `TechNickAI/claude_telemetry` | `docs/TOOLS.md § query_model` |
| Lazy-init credential gate; structured `MISSING_CREDENTIAL` error | `allenhutchison/gemini-cli-deep-research`, `virattt/dexter` | `docs/PLAN.md § Architecture` and § error taxonomy, `docs/TOOLS.md` |
| Untrusted-content wrapping in prompt composition | `Yeachan-Heo/oh-my-claudecode` `wrapUntrustedFileContent()` | `CLAUDE.md`, planned `src/prompt.ts` |
| Offline pricing snapshot fallback | `ryoppippi/ccusage` `LiteLLMPricingFetcher` | `docs/MODELS.md § Offline Pricing Snapshot` |
| Hash-map model lookup, not linear scan | `promptfoo` (400-entry registry pain) | `docs/PLAN.md § Architecture` |
| `context_length` from live probe, never hardcoded | `langchain-ai/open_deep_research` | `docs/MODELS.md`, `CLAUDE.md` |
| No host-fingerprinting telemetry | `kyegomez/swarms` (MAC/hostname collection on import) | `CLAUDE.md` |
| Await all async cost writes | `assafelovic/gpt-researcher` `add_costs` bug | `CLAUDE.md` |
| Real cancel for video poll loop | `ruvnet/agentic-flow` `cancelRun()` no-op | `CLAUDE.md` |
| File-size soft cap | `Yeachan-Heo/oh-my-claudecode` 2423-LOC bridge monolith | `CLAUDE.md` |

Patterns the inquiry **suggested but were rejected** as out-of-scope for our shape:

- Routing scenario tree / complexity scorer (`Kocoro-lab/Shannon`, `musistudio/claude-code-router`) — we have curated per-task models and a 3-step fallback chain
- Adaptive concurrency / circuit breakers (`promptfoo` scheduler) — single-user MCP, not a multi-tenant gateway
- OTLP / `gen_ai.*` telemetry (`TechNickAI/claude_telemetry`, `zcquant/claude-code-monitor`) — out of scope, and telemetry collection has trust risks
- OAuth / multi-user auth (`theimaginaryfoundation/code-bot`, `bytedance/deer-flow`) — `userConfig.openrouter_api_key` via plugin is sufficient
- Anthropic-shaped response envelope (`777genius/claude-multimodel`'s `codex-fetch-adapter.ts`) — our envelope is task-shaped, not chat-shaped, so the translation layer doesn't apply

## Sources (Representative)

### OpenRouter
- [OpenRouter Models page (UI)](https://openrouter.ai/models)
- [Free models collection](https://openrouter.ai/collections/free-models)
- [Multimodal overview](https://openrouter.ai/docs/guides/overview/multimodal/overview)
- [PDF docs](https://openrouter.ai/docs/guides/overview/multimodal/pdfs)
- [Image generation docs](https://openrouter.ai/docs/guides/overview/multimodal/image-generation)
- [TTS docs](https://openrouter.ai/docs/guides/overview/multimodal/tts)
- [Audio (STT) docs](https://openrouter.ai/docs/guides/overview/multimodal/audio)
- [Video generation docs](https://openrouter.ai/docs/guides/overview/multimodal/video-generation)
- [Provider routing guide](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Structured outputs guide](https://openrouter.ai/docs/guides/features/structured-outputs)
- [Free models meta-router (`openrouter/free`)](https://openrouter.ai/openrouter/free)
- [API rate limits](https://openrouter.ai/docs/api/reference/limits)
- [App attribution headers](https://openrouter.ai/docs/app-attribution)

### Industry / patterns
- [Anthropic — Writing tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [Anthropic — How and when to use subagents](https://claude.com/blog/subagents-in-claude-code)
- [OpenAI — Introducing Structured Outputs](https://openai.com/index/introducing-structured-outputs-in-the-api/)
- [Aider chat modes](https://aider.chat/docs/usage/modes.html)
- [Continue.dev model roles](https://docs.continue.dev/customize/model-roles)
- [Cline plan & act modes](https://docs.cline.bot/core-workflows/plan-and-act)
- [Cursor — Editing files at 1000 tok/s (Fast Apply)](https://cursor.com/blog/instant-apply)
- [Morph Fast Apply architectures](https://www.morphllm.com/cursor-fast-apply)
- [Roo Code Boomerang Tasks](https://docs.roocode.com/features/boomerang-tasks)
- [RouteLLM (arXiv 2406.18665)](https://arxiv.org/abs/2406.18665)
- [FrugalGPT (arXiv 2305.05176)](https://arxiv.org/abs/2305.05176)

### Prior art (existing MCPs)
- [stabgan/openrouter-mcp-multimodal](https://github.com/stabgan/openrouter-mcp-multimodal) — closest existing project; error taxonomy + SSRF guards
- [physics91/openrouter-mcp](https://github.com/physics91/openrouter-mcp) — splits free/paid into separate tools
- [stopman/codereview-openrouter-mcp](https://github.com/stopman/codereview-openrouter-mcp) — task-specific tools (`review_diff` etc.)
- [tj60647/openrouter-mcp-registry](https://github.com/tj60647/openrouter-mcp-registry) — Postgres-backed catalog with lifecycle flags (idea source for `list_free_models`)
- [0xshellming/mcp-summarizer](https://github.com/0xshellming/mcp-summarizer) — `max_chars` not `max_tokens`
- [Braffolk/mcp-summarization-functions](https://github.com/Braffolk/mcp-summarization-functions) — id-based content cache pattern (deferred for v2)

### Plugin packaging
- [Claude Code plugins reference](https://code.claude.com/docs/en/plugins-reference)
- [MCP bundling in plugins](https://code.claude.com/docs/en/mcp#plugin-provided-mcp-servers)

### Benchmarks
- [GPT-OSS-120b coding evaluation](https://eval.16x.engineer/blog/gpt-oss-120b-coding-evaluation-results)
- [GPT-OSS vs Qwen3 / DeepSeek (Clarifai)](https://www.clarifai.com/blog/openai-gpt-oss-benchmarks-how-it-compares-to-glm-4.5-qwen3-deepseek-and-kimi-k2)
- [Qianfan-OCR #1 OmniDocBench](https://reeboot.fr/en/blog/qianfan-ocr)
- [LMSYS Arena April 2026 rankings](https://aidevdayindia.org/blogs/lmsys-chatbot-arena-current-rankings/lmsys-chatbot-arena-leaderboard-current-top-models.html)
