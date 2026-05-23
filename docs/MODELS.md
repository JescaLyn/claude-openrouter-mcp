# Models — openrouter-mcp

Per-task curated model map, paid-tier pricing, and the procedure for refreshing both. Source data verified against `https://openrouter.ai/api/frontend/models` on 2026-04-26. **OpenRouter's free tier shifts monthly — run `npm run probe:models` to verify the current state before relying on the list below.**

## How to Refresh This Doc and `src/models.ts`

When models in `src/models.ts` start failing or look stale:

1. **Fetch the full catalog**:
   ```bash
   curl -s https://openrouter.ai/api/frontend/models > /tmp/or_models.json
   ```
   Use `/api/frontend/models`, **not** `/api/v1/models`. The v1 endpoint silently filters out image/audio/video models and returns `pricing: null` for non-chat ones.

2. **Filter for free models**:
   ```bash
   jq '.data[] | select(.endpoint.is_free == true) | {id, name, context_length: .context_length, input_modalities: .architecture.input_modalities, output_modalities: .architecture.output_modalities}' /tmp/or_models.json
   ```

3. **Apply the pricing trap check.** A model is truly free only when **all** of these are zero or absent:
   - `pricing.prompt`
   - `pricing.completion`
   - `pricing.image_output` (per-image or per-MP — the column-based UI hides this)
   - `pricing.audio` (per-character or per-second)
   - `pricing.video_output` (per-clip or per-second)
   - `pricing.request` (flat per-call)

4. **Cross-check curated map.** For every entry in `src/models.ts`:
   - If `endpoint.is_free === false` (or model id no longer exists), log a warning and swap to the next fallback in that task's chain.
   - If a task has no surviving free option, escalate to a paid model (with cost annotation) and update `MODELS.md` accordingly.

5. **Run the project script**:
   ```bash
   npm run probe:models
   ```
   This prints a diff between the curated map and live free models, with action recommendations. Also writes a fresh snapshot to `src/models.snapshot.json` (the offline fallback, see below).

6. **Update this file** and `src/models.ts` together. Commit with a message like "Updated curated model map after free-tier refresh."

## Offline Pricing Snapshot

The build bundles `src/models.snapshot.json` — a captured response from `/api/frontend/models` taken at build time. Used when the live probe fails (network down, OpenRouter outage, malformed response). The free vs paid classification stays correct offline; only newly-added models are missing.

Refresh the snapshot whenever you refresh `src/models.ts`. Pattern adopted from `ryoppippi/ccusage`'s `LiteLLMPricingFetcher`.

## `context_length` Comes from the Live Probe — Not Hardcoded

Hand-maintaining a `MODEL_TOKEN_LIMITS` dict in `src/models.ts` is a known anti-pattern (flagged in `langchain-ai/open_deep_research` and others). The startup probe reads `context_length` directly from the API response and populates the in-memory map. If you find yourself typing a context number into `src/models.ts`, stop — write the lookup function instead.

## Pricing Trap (Critical)

OpenRouter's UI Models page shows columns "Input ($/M)" and "Output ($/M)" — these are **token prices only**. Image/audio/video models *legitimately* show `$0/$0` in those columns because they don't bill by tokens. They bill via separate fields.

| Pricing field | Modality | Example |
|---|---|---|
| `pricing.prompt` | Text input tokens | $0.30/M |
| `pricing.completion` | Text output tokens | $2.50/M |
| `pricing.image_output` | Image generation | $0.030/MP or $0.04/image |
| `pricing.audio` | TTS / STT | $0.0000006/char or $0.0001/min |
| `pricing.video_output` | Video gen | $0.03/sec or $0.15/clip |
| `pricing.request` | Flat per-call | rare |

**Always check all six fields before declaring a model free.**

## Verified Free Models (28, as of 2026-04-26)

### Text-out (27)

| ID | Context | Input modalities | Notes |
|---|---|---|---|
| `inclusionai/ling-2.6-1t` | 262K | text | 1T params; long-context heavyweight |
| `inclusionai/ling-2.6-flash` | 262K | text | Faster Ling variant |
| `tencent/hy3-preview` | 262K | text | Strong on CJK languages, MMMLU 80.15 |
| `nvidia/nemotron-3-super-120b-a12b` | 262K | text | MoE 120B/12B-active. Promising; too new for primary |
| `nvidia/nemotron-3-nano-30b-a3b` | 256K | text | MoE 30B/3B-active |
| `nvidia/nemotron-nano-9b-v2` | 128K | text | Reasoning trace; disable via system prompt for classify |
| `nvidia/nemotron-nano-12b-v2-vl` | 128K | text+image+video | Best free for video understanding |
| `minimax/minimax-m2.5` | 196K | text | RPD 10K |
| `qwen/qwen3-next-80b-a3b-instruct` | 262K | text | MoE 80B/3B-active. Excellent long-context primary |
| `qwen/qwen3-coder` | 262K | text | Coding-tuned. RPM 8 |
| `openai/gpt-oss-120b` | 131K | text | Native tool use + structured outputs. **Workhorse** |
| `openai/gpt-oss-20b` | 131K | text | Smaller, faster, RPD 10K |
| `z-ai/glm-4.5-air` | 131K | text | |
| `liquid/lfm-2.5-1.2b-instruct` | 32K | text | Tiny + fast |
| `liquid/lfm-2.5-1.2b-thinking` | 32K | text | Tiny reasoning model |
| `cognitivecomputations/dolphin-mistral-24b-venice-edition` | 32K | text | Uncensored variant |
| `meta-llama/llama-3.3-70b-instruct` | 65K | text | Solid generalist; structured-outputs verified |
| `meta-llama/llama-3.2-3b-instruct` | 131K | text | Fast small |
| `nousresearch/hermes-3-llama-3.1-405b` | 131K | text | 405B params; heavy |
| `google/gemma-4-26b-a4b-it` | 262K | text+image+video | MoE vision |
| `google/gemma-4-31b-it` | 262K | text+image+video | Best free for visual reasoning |
| `google/gemma-3-27b-it` | 131K | text+image | Best free for general translation |
| `google/gemma-3-12b-it` | 32K | text+image | |
| `google/gemma-3-4b-it` | 32K | text+image | Small vision |
| `google/gemma-3n-e4b-it` | 8K | text | Very small |
| `google/gemma-3n-e2b-it` | 8K | text | Very small |
| `baidu/qianfan-ocr-fast` | 65K | image+text | OCR specialist; #1 OmniDocBench |

### Embeddings (1, not used)

| ID | Notes |
|---|---|
| `nvidia/llama-nemotron-embed-vl-1b-v2` | Multimodal embeddings; skipped (out of scope) |

### Image, audio, video, speech, rerank — 0 free models in any of these categories.

## Per-Task Curated Map

This is the data that goes into `src/models.ts`. Three layers per task: free primary, free fallback, cheap-paid escalation (only used if user opts in).

| Task | Free 1° | Free 2° | Cheap-Paid Escalation |
|---|---|---|---|
| `query_free` default | `openai/gpt-oss-120b` | `qwen/qwen3-next-80b-a3b-instruct` | `google/gemini-2.5-flash` ($0.30/$2.50) |
| `summarize` (short, <8K) | `openai/gpt-oss-20b` | `nvidia/nemotron-nano-9b-v2` | `google/gemini-2.5-flash-lite` ($0.30/M) |
| `summarize` (long, >32K) | `qwen/qwen3-next-80b-a3b-instruct` | `inclusionai/ling-2.6-1t` | `google/gemini-2.5-flash` ($0.30/$2.50) |
| `query_long_context` (>100K) | `qwen/qwen3-next-80b-a3b-instruct` | `inclusionai/ling-2.6-1t` | `google/gemini-2.5-flash` (1M ctx) |
| `extract` (JSON-schema) | `openai/gpt-oss-120b` | `meta-llama/llama-3.3-70b-instruct` | `mistralai/mistral-small-3.2-24b-instruct` ($0.075/$0.20) |
| `classify` | `nvidia/nemotron-nano-9b-v2` | `meta-llama/llama-3.2-3b-instruct` | `openai/gpt-5-nano` ($0.05/$0.40) |
| `translate` | `google/gemma-3-27b-it` | `tencent/hy3-preview` (CJK) | `google/gemini-2.5-flash` ($0.30/$2.50) |
| `rewrite` | `qwen/qwen3-next-80b-a3b-instruct` | `meta-llama/llama-3.3-70b-instruct` | `google/gemini-2.0-flash-001` ($0.10/$0.40) |
| `explain_code` | `qwen/qwen3-coder` | `openai/gpt-oss-120b` | `anthropic/claude-haiku-4-5` ($1/$5) |
| `generate_docstring` | `qwen/qwen3-coder` | `openai/gpt-oss-120b` | `anthropic/claude-haiku-4-5` |
| `generate_regex` | `qwen/qwen3-coder` | `openai/gpt-oss-120b` | `anthropic/claude-haiku-4-5` |
| `generate_sql` | `qwen/qwen3-coder` | `openai/gpt-oss-120b` | `anthropic/claude-haiku-4-5` |
| `commit_message` | `openai/gpt-oss-20b` | `qwen/qwen3-coder` | `anthropic/claude-haiku-4-5` |
| `extract_text` (OCR) | `baidu/qianfan-ocr-fast` | `google/gemma-3-27b-it` | `google/gemini-2.5-flash` (better non-Latin) |
| `analyze_image` (visual reasoning) | `google/gemma-4-31b-it` | `google/gemma-3-27b-it` → `nvidia/nemotron-nano-12b-v2-vl` | `google/gemini-2.5-flash` |
| `read_pdf` | any free chat + `cloudflare-ai` engine | (engine handles fallback) | `engine: 'mistral-ocr'` ($2/1K pages) for scanned/complex |
| `analyze_video` | `nvidia/nemotron-nano-12b-v2-vl` | `google/gemma-4-31b-it` | `google/gemini-2.5-flash` |

### Surprises Worth Knowing

- **`gpt-oss-120b` outperforms `qwen3-coder` on raw coding benchmark** (7.35 vs 6.8). We still keep Qwen primary because of 262K context and tool calling, but gpt-oss-120b is the *smart* fallback for hard typed-language work.
- **Llama 3.3 70B is still a credible 2026 fallback** for structured outputs and multilingual work despite being a 2024 model. Newer ≠ better on the dimensions that matter.
- **Nemotron-3-Super-120B looks great on paper but is too new** to use as primary. Promote after a month of observed stability.
- **`tencent/hy3-preview` beats Gemma 3 on CJK** but is weaker elsewhere. Route translation by source/target language, not by single global default.
- **Qianfan-OCR-Fast beats Gemini 3 Pro on OmniDocBench** (93.12 vs 90.33) — for OCR specifically, free is better than paid frontier.

## Paid Generation Pricing (Cost Annotations for Tool Descriptions)

Paid tools always include the cost in their description and emit cost estimates in the `PAID_CONFIRMATION_REQUIRED` envelope.

### Image generation

| Model | OpenRouter ID | Pricing | 1024×1024 (1MP) | 4MP |
|---|---|---|---|---|
| **FLUX.2 Klein 4B** (default) | `black-forest-labs/flux.2-klein-4b` | $0.014/MP | **$0.014** | $0.056 |
| FLUX.2 Pro | `black-forest-labs/flux.2-pro` | $0.030/MP | $0.030 | $0.12 |
| FLUX.2 Max | `black-forest-labs/flux.2-max` | $0.07/MP | $0.07 | $0.28 |
| FLUX.2 Flex | `black-forest-labs/flux.2-flex` | $0.06/MP | $0.06 | $0.24 |
| Gemini 2.5 Flash Image | `google/gemini-2.5-flash-image` | flat $0.030/img | $0.030 | $0.030 |
| ByteDance Seedream 4.5 | `bytedance-seed/seedream-4.5` | flat $0.04/img | $0.04 | $0.04 |
| Riverflow V2 Fast | `sourceful/riverflow-v2-fast` | flat $0.02 (1024px) | $0.02 | n/a |
| Riverflow V2 Pro | `sourceful/riverflow-v2-pro` | flat $0.15 (1024px) | $0.15 | n/a |
| Gemini 3 Pro Image | `google/gemini-3-pro-image-preview` | $0.12/img | $0.12 | $0.12 |

**Recommendation:** default to FLUX.2 Klein 4B for cost; offer FLUX.2 Pro as upgrade.

### TTS (audio output)

| Model | OpenRouter ID | Pricing | 5-min script (~5K chars) |
|---|---|---|---|
| **OpenAI GPT-4o Mini TTS** (default) | `openai/gpt-4o-mini-tts-2025-12-15` | $0.0000006/char | **$0.003** |
| Kokoro 82M | `hexgrad/kokoro-82m` | $0.00000062/char | $0.003 |
| Mistral Voxtral Mini TTS | `mistralai/voxtral-mini-tts` | $0.000016/char | $0.08 |
| Gemini 3.1 Flash TTS | `google/gemini-3.1-flash-tts-preview` | token-billed (~$0.50/min) | ~$2.50 |

### Video generation

| Model | OpenRouter ID | Pricing | 5s 720p | 5s 1080p+audio |
|---|---|---|---|---|
| **Veo 3.1 Lite** (default, 720p, no audio) | `google/veo-3.1-lite` | $0.03/sec | **$0.15** | $0.50 (with audio) |
| Veo 3.1 Fast | `google/veo-3.1-fast` | $0.10/sec (720p+audio) or $0.12/sec (1080p+audio) | $0.50 | **$0.60** |
| Veo 3.1 standard | `google/veo-3.1` | $0.40/sec (1080p+audio) | $2.00 | $2.00 |
| Seedance 2.0 | `bytedance/seedance-2.0` | $0.34/sec | $1.70 | $1.70 |

**Skip:** Sora 2 / Sora 2 Pro (sunset 2026-04-26).

### STT (audio input)

| Model | OpenRouter ID | Pricing | 10-min audio |
|---|---|---|---|
| **Mistral Voxtral Small** (default, English-strong) | `mistralai/voxtral-small-24b-2507` | per-minute, $0.0001/min input | **$0.001** |
| Gemini 2.5 Flash Lite (multilingual) | `google/gemini-2.5-flash-lite` | $0.30/M audio tokens (~6K/min) | $0.018 |
| Gemini 2.5 Flash | `google/gemini-2.5-flash` | $0.30/M (in) + $2.50/M (out) | ~$0.05 |

## Provider Routing Defaults (apply to all calls)

```jsonc
"provider": {
  "sort": "latency",
  "data_collection": "deny",       // skip prompt-logging providers — important for code/diff content
  "require_parameters": true,      // no silent fallback from json_schema to json_object
  "allow_fallbacks": true
}
```

## Free-Tier Rate Limits

- 20 requests/minute global (across all `:free` models on the account)
- 50 requests/day baseline; **1000/day after $10 lifetime topup** (one-time threshold)
- Failed requests still count against quota
- 429 carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (epoch ms)

User has crossed the $10 threshold → 1000 RPD available.

## Headers

- **Required**: `Authorization: Bearer <key>`, `Content-Type: application/json`
- **Optional**: `HTTP-Referer`, `X-Title` (analytics/attribution; safe to omit)
