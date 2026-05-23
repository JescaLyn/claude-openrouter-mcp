# Tool Specifications — openrouter-mcp

Full API reference for the 22 MCP tools. See `docs/PLAN.md` for envelope/error specifications and `docs/MODELS.md` for model selection.

## Tool Naming

No prefix. MCP hosts namespace by server name internally (e.g. `mcp__openrouter__summarize`). In-name prefixes are redundant.

## Common Success Envelope

```jsonc
{
  "result": "string | object",
  "model_used": "openai/gpt-oss-120b",
  "usage": { "tokens_in": 1234, "tokens_out": 567 },
  "finish_reason": "stop | length | content_filter",
  "fallback_chain": ["openai/gpt-oss-120b"],   // models actually tried
  "cost_usd": 0                                 // 0 for free; non-zero only when allow_paid
}
```

For paid tools, also includes `"cost_breakdown": "human-readable"`.

## Common Error Envelope

```jsonc
{
  "error": {
    "code": "FREE_EXHAUSTED",
    "message": "All free fallbacks failed for task `summarize`.",
    "retryable": true,
    "suggested_action": "Retry with allow_paid: true to escalate to a paid model.",
    "estimated_cost_usd": 0.0004,             // when applicable
    "cost_breakdown": "gemini-2.5-flash-lite · ~2K input + 500 output tokens"
  }
}
```

Codes: `UPSTREAM_HTTP`, `UPSTREAM_TIMEOUT`, `MODEL_NOT_FOUND`, `RATE_LIMITED`, `FREE_EXHAUSTED`, `PAID_CONFIRMATION_REQUIRED`, `RESOURCE_TOO_LARGE`, `INVALID_INPUT`, `MISSING_CREDENTIAL`.

## Common Parameters Across Tools

- `model?: string` — explicit override. Bypasses curated map. Use `list_free_models` to discover valid ids.
- `allow_paid?: boolean = false` — opt into cheap-paid escalation when free fallbacks fail. Default false; user must explicitly opt in per call.
- `system?: string` — optional system prompt addendum. Most wrappers have a built-in system prompt; this appends.

---

# Foundation (3)

## `query_model`

Raw passthrough to OpenRouter's chat completions. Use when you need full control or want a model not covered by curated tools.

```jsonc
{
  "name": "query_model",
  "description": "Generic OpenRouter chat completion. Use when no purpose-specific tool fits or for ad-hoc one-off queries. For routine tasks, prefer a named tool (summarize, extract, classify, etc.).",
  "params": {
    "prompt": "string (required)",
    "model": "string (required) — full OpenRouter model id, e.g. 'meta-llama/llama-3.3-70b-instruct:free'",
    "system": "string? — optional system prompt",
    "max_tokens": "integer? = 2048",
    "temperature": "number? = 0.3",
    "allow_paid": "boolean? = false",
    "extra": "object? — passthrough to OpenRouter request body. Use for provider preferences, structured-output formats, and other OpenRouter-specific fields not modeled here. NOT validated server-side; whatever you pass is splatted into the request alongside the typed params (typed params win on conflict)."
  }
}
```

The `extra` passthrough exists so we don't have to track every new OpenRouter feature in our typed surface. Pattern adopted from `TechNickAI/claude_telemetry` — pass-through forwarding eliminates breakage when OpenRouter adds parameters.

## `query_free`

Curated free-model query. Picks the right free model for the task hint, with a fallback chain.

```jsonc
{
  "name": "query_free",
  "description": "Generic query against a curated free model. Use as the default escape hatch when no named tool fits. Routes via task_type hint to a sensibly tuned free model. For routine tasks (summarize, extract, classify), prefer the specific named tool.",
  "params": {
    "prompt": "string (required)",
    "task_type": "enum? = 'general' | 'reasoning' | 'code' | 'creative' | 'long_context'",
    "system": "string?",
    "max_tokens": "integer? = 2048",
    "temperature": "number? = 0.3",
    "model": "string? — explicit override",
    "allow_paid": "boolean? = false"
  }
}
```

## `list_free_models`

Live probe of currently-available free models on OpenRouter. Cached for the session; calling this refreshes the cache.

```jsonc
{
  "name": "list_free_models",
  "description": "List currently-available free models on OpenRouter, grouped by capability. Useful when a curated model returns MODEL_NOT_FOUND, or to discover newly-added free options.",
  "params": {
    "category": "enum? = 'all' | 'text' | 'vision' | 'long_context' | 'embedding'",
    "refresh": "boolean? = false — force re-fetch even if cached"
  }
}
```

Returns: `{ models: [{id, name, context_length, input_modalities, output_modalities, rate_limit_rpm, rate_limit_rpd}], probed_at, source: "frontend"|"v1"|"cache" }`.

---

# Text Wrappers (5)

## `summarize`

```jsonc
{
  "name": "summarize",
  "description": "Compress text to a brief summary. Use for routine summarization of search results, log dumps, file contents, web fetches. NOT for: long-document selective summarization with strict exclusion criteria (use Claude directly).",
  "params": {
    "text": "string (required)",
    "style": "enum? = 'concise' | 'detailed' | 'bullets' | 'tldr'  (default: concise)",
    "max_chars": "integer? = 400 — approximate character cap",
    "focus": "string? — optional aspect to emphasize, e.g. 'security implications'",
    "model": "string?",
    "allow_paid": "boolean? = false"
  }
}
```

## `extract`

```jsonc
{
  "name": "extract",
  "description": "Pull fields from text into a JSON schema. Use for entity extraction, structured note-taking, parsing semi-structured input. NOT for: multi-hop extraction that requires linking entities across sections (use Claude).",
  "params": {
    "text": "string (required)",
    "schema": "object (required) — JSON Schema for the fields to extract. Each field's description is shown to the model and should be specific.",
    "instructions": "string? — optional extra guidance",
    "allow_missing": "boolean? = true — if true, missing fields return null; if false, error",
    "model": "string?",
    "allow_paid": "boolean? = false"
  }
}
```

Result is a JSON object matching the schema, validated server-side. On schema-validation failure, returns `INVALID_INPUT` with the failing field path.

## `classify`

```jsonc
{
  "name": "classify",
  "description": "Assign input(s) to one of a closed label set. Use for routing decisions, triage, bucketing. NOT for: rubric-scored review where the rubric is fuzzy (use Claude).",
  "params": {
    "text": "string? — single item",
    "items": "array<string>? — multiple items (use one of text or items, not both)",
    "labels": "array<string> (required) — closed set of allowed labels",
    "multi_label": "boolean? = false — if true, returns array per item",
    "rationale": "boolean? = false — if true, also returns 1-sentence reason per item",
    "model": "string?",
    "allow_paid": "boolean? = false"
  }
}
```

Server-side validation rejects labels not in the input set (anti-hallucination); retries once with stricter prompt before failing.

## `translate`

```jsonc
{
  "name": "translate",
  "description": "Translate text into another natural language. Use for translating error messages, documentation, user content. Source language auto-detected if omitted.",
  "params": {
    "text": "string (required)",
    "target_lang": "string (required) — BCP-47 code or English name (e.g. 'es', 'Japanese')",
    "source_lang": "string? — optional; auto-detected if omitted",
    "tone": "enum? = 'neutral' | 'formal' | 'casual'  (default: neutral)",
    "model": "string?",
    "allow_paid": "boolean? = false"
  }
}
```

## `rewrite`

```jsonc
{
  "name": "rewrite",
  "description": "Rewrite text per an instruction. Combines simplify, tighten, formalize, paraphrase, etc. Use `preserve` to protect code blocks, quotes, numbers from being mangled.",
  "params": {
    "text": "string (required)",
    "instruction": "string (required) — how to rewrite, e.g. 'tighten by 30%', 'convert to passive voice'",
    "preserve": "array<enum>? — values: 'code' | 'quotes' | 'formatting' | 'numbers' | 'links'  (default: [])",
    "model": "string?",
    "allow_paid": "boolean? = false"
  }
}
```

---

# Code Wrappers (5)

## `explain_code`

```jsonc
{
  "name": "explain_code",
  "description": "Plain-language explanation of a code snippet. Use for understanding unfamiliar code, third-party library internals, or generating teaching material. NOT for: explanations that require repo-wide context (use Claude).",
  "params": {
    "code": "string (required)",
    "language": "string? — hint, e.g. 'typescript'",
    "focus": "enum? = 'behavior' | 'complexity' | 'errors' | 'security'  (default: behavior)",
    "model": "string?",
    "allow_paid": "boolean? = false"
  }
}
```

## `generate_docstring`

```jsonc
{
  "name": "generate_docstring",
  "description": "Generate a docstring/JSDoc/TSDoc for a function. Use for self-contained functions; the model has no repo context. NOT for: functions whose behavior depends on framework lifecycle or caller assumptions.",
  "params": {
    "code": "string (required)",
    "language": "string (required) — 'python' | 'javascript' | 'typescript' | 'go' | etc.",
    "style": "enum? — 'google' | 'numpy' | 'jsdoc' | 'tsdoc' | 'rust'  (defaults pick by language)",
    "model": "string?",
    "allow_paid": "boolean? = false"
  }
}
```

## `generate_regex`

```jsonc
{
  "name": "generate_regex",
  "description": "Generate a regex from a description plus positive/negative examples. Server-side validates the regex against examples before returning.",
  "params": {
    "description": "string (required)",
    "positive_examples": "array<string> (required) — strings the regex must match",
    "negative_examples": "array<string>? — strings the regex must NOT match",
    "flavor": "enum? = 'pcre' | 'js' | 'python' | 'go'  (default: 'js')",
    "model": "string?",
    "allow_paid": "boolean? = false"
  }
}
```

Returns the regex + the validation results per example. On validation failure, retries once with the failed examples appended to the prompt before failing.

## `generate_sql`

```jsonc
{
  "name": "generate_sql",
  "description": "Generate a SQL query from a schema and natural-language intent. Use for read queries against a single schema. NOT for: cross-DB joins, vendor-specific window-function syntax, write/DDL operations.",
  "params": {
    "schema": "string (required) — DDL or schema description",
    "intent": "string (required) — what the query should do",
    "dialect": "enum? = 'postgres' | 'mysql' | 'sqlite' | 'bigquery' | 'mssql'  (default: 'postgres')",
    "model": "string?",
    "allow_paid": "boolean? = false"
  }
}
```

## `commit_message`

```jsonc
{
  "name": "commit_message",
  "description": "Generate a commit message from a git diff. Accepts any diff format — staged, branch-to-branch, worktree, or patch. Style is fixed: past-tense verbs, sentence case, ends with period, parallel structure for multi-change ('Fixed X, added Y, and removed Z.'), plain ASCII, 'and' not symbols. Describes what and why, not where. Use diff_context to describe the diff scope when passing non-staged diffs.",
  "params": {
    "diff": "string (required) — any git diff output: staged (git diff --cached), unstaged (git diff), branch-to-branch (git diff main..HEAD), worktree diff, or a patch file",
    "diff_context": "string? — describes what the diff represents, e.g. 'staged changes', 'branch vs main', 'worktree changes', 'last 3 commits'. Frames the message for multi-commit ranges vs. a single staged unit.",
    "scope_hint": "string? — repo or area hint, e.g. 'auth module' or 'frontend'",
    "instructions": "string? — custom style rules appended to the default system prompt",
    "model": "string?",
    "allow_paid": "boolean? = false"
  }
}
```

Returns a single-line commit message. No `style` parameter — style is non-negotiable per project spec.

---

# Free Input-Processing (5)

## `extract_text` (OCR)

```jsonc
{
  "name": "extract_text",
  "description": "Extract text from an image. Use for screenshots of code/error messages, photos of documents, OCR of UI captures. Specialist OCR model (Qianfan-OCR-Fast) — better than the visual-reasoning model for pure transcription.",
  "params": {
    "image": "string (required) — URL or data:image/png;base64,...",
    "language_hint": "string? — improves accuracy for non-Latin scripts",
    "preserve_layout": "boolean? = false — if true, attempt to preserve spatial layout (slower)",
    "model": "string?",
    "allow_paid": "boolean? = false"
  }
}
```

## `analyze_image`

```jsonc
{
  "name": "analyze_image",
  "description": "Visual reasoning over an image — UI mockup interpretation, diagram understanding, chart reading, screenshot debugging. NOT for: pure text extraction (use extract_text).",
  "params": {
    "image": "string (required) — URL or data URL",
    "prompt": "string (required) — what to analyze, e.g. 'What error is shown?' or 'Describe this UI flow.'",
    "model": "string?",
    "allow_paid": "boolean? = false"
  }
}
```

## `read_pdf`

```jsonc
{
  "name": "read_pdf",
  "description": "Extract and answer questions about a PDF document. Default engine is free (Cloudflare markdown extraction). For scanned/complex layouts, set engine: 'mistral-ocr' (paid, $2/1K pages, requires allow_paid).",
  "params": {
    "pdf": "string (required) — URL or data:application/pdf;base64,...",
    "prompt": "string (required) — question or extraction task",
    "engine": "enum? = 'cloudflare-ai' | 'mistral-ocr'  (default: 'cloudflare-ai')",
    "model": "string? — chat model used after extraction (default: openai/gpt-oss-120b, a free model)",
    "allow_paid": "boolean? = false  — required if engine='mistral-ocr' or model is non-free"
  }
}
```

## `analyze_video`

```jsonc
{
  "name": "analyze_video",
  "description": "Frame-sampled analysis of a short video clip (≤60s for most free models). Describes actions, scenes, and visible text. NOT for: transcribing speech in video (use transcribe instead — separate audio path).",
  "params": {
    "video": "string (required) — URL or data:video/mp4;base64,...",
    "prompt": "string (required)",
    "fps_hint": "integer? = 1 — sampling rate; higher costs more context",
    "model": "string?",
    "allow_paid": "boolean? = false"
  }
}
```

## `query_long_context`

```jsonc
{
  "name": "query_long_context",
  "description": "Route a query with very large input (>100K tokens) to a free 262K-context model. Use for whole-repo dump questions, log haystack search, multi-document Q&A.",
  "params": {
    "prompt": "string (required) — combined input + question",
    "model": "string? — defaults to qwen/qwen3-next-80b-a3b-instruct (free)",
    "max_tokens": "integer? = 4096",
    "allow_paid": "boolean? = false"
  }
}
```

---

# Paid Generation (3, opt-in)

All paid tools follow the cost-confirmation flow: first call without `allow_paid: true` returns `PAID_CONFIRMATION_REQUIRED` with `estimated_cost_usd` and `cost_breakdown`. Caller surfaces to user, user explicitly retries with `allow_paid: true` to charge.

## `generate_image`

```jsonc
{
  "name": "generate_image",
  "description": "Generate an image from a text prompt. PAID — no free option exists on OpenRouter. Default: FLUX.2 Klein 4B (~$0.014 for 1024×1024). Set model: 'black-forest-labs/flux.2-pro' for higher quality (~$0.030/MP).",
  "params": {
    "prompt": "string (required)",
    "size": "enum? = '1K' | '2K' | '4K'  (default: '1K' — 1024×1024)",
    "aspect_ratio": "enum? = '1:1' | '16:9' | '9:16' | '4:3'  (default: '1:1')",
    "reference_image": "string? — optional URL or data URL for image-to-image",
    "model": "string?  (default: 'black-forest-labs/flux.2-klein-4b')",
    "allow_paid": "boolean (required to charge)"
  }
}
```

Returns: `{ image_base64, mime_type, cost_usd, model_used, ... }`.

## `generate_audio` (TTS)

```jsonc
{
  "name": "generate_audio",
  "description": "Text-to-speech. PAID — no free option. Default: OpenAI GPT-4o Mini TTS (~$0.0000006/char, 5-min script ≈ $0.003).",
  "params": {
    "text": "string (required)",
    "voice": "string? = 'alloy'  — voice id; depends on model",
    "format": "enum? = 'mp3' | 'pcm' | 'wav'  (default: 'mp3')",
    "model": "string?  (default: 'openai/gpt-4o-mini-tts-2025-12-15')",
    "allow_paid": "boolean (required to charge)"
  }
}
```

Returns: `{ audio_base64, mime_type, cost_usd, model_used }`.

## `generate_video`

```jsonc
{
  "name": "generate_video",
  "description": "Generate a short video clip from a text prompt. PAID, async (job-id polling). Default: Veo 3.1 Lite, 720p, 5s, no audio (~$0.15). Set with_audio: true and resolution: '1080p' for synced-audio higher-fidelity at higher cost.",
  "params": {
    "prompt": "string (required)",
    "duration_seconds": "integer? = 5 — clip length; max varies by model",
    "resolution": "enum? = '720p' | '1080p'  (default: '720p')",
    "aspect_ratio": "enum? = '16:9' | '9:16' | '1:1'  (default: '16:9')",
    "with_audio": "boolean? = false",
    "model": "string?  (default: 'google/veo-3.1-lite')",
    "poll_timeout_seconds": "integer? = 300",
    "allow_paid": "boolean (required to charge)"
  }
}
```

Behavior: synchronous from caller's perspective; internally posts to `/api/v1/videos`, polls until `completed` or `poll_timeout_seconds`. Returns: `{ video_url, cost_usd, duration_seconds, model_used }`. On timeout returns `UPSTREAM_TIMEOUT` with the polling URL so caller can poll later.

---

# Paid Input-Processing (1, opt-in)

## `transcribe` (STT)

```jsonc
{
  "name": "transcribe",
  "description": "Transcribe audio to text. PAID — no free OpenRouter option for audio input. Default: Mistral Voxtral Small (per-minute billing, 10-min audio ≈ $0.001). For multilingual / harder audio, set model: 'google/gemini-2.5-flash-lite' (~$0.018 per 10 min).",
  "params": {
    "audio": "string (required) — base64-encoded audio",
    "format": "enum (required) — 'wav' | 'mp3' | 'm4a' | 'flac' | 'ogg'",
    "prompt": "string? = 'Transcribe this audio verbatim.'",
    "language_hint": "string? — improves accuracy for non-English",
    "model": "string?  (default: 'mistralai/voxtral-small-24b-2507')",
    "allow_paid": "boolean (required to charge)"
  }
}
```

Returns: `{ text, cost_usd, model_used, duration_seconds }`.

---

## Tool Description Style (for the MCP `description` field)

Every tool's `description` follows the "onboarding notes" style Anthropic recommends:
- One-line *what it does*
- *When to use* (concrete trigger)
- *When NOT to use* (the most common misuse)
- For paid tools: explicit cost annotation in the description

This is what Claude reads when deciding which tool to invoke — make it specific.
