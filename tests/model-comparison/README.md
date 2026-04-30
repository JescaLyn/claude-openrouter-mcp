# Model Comparison Test Suite

Comprehensive test harness for comparing OpenRouter free models across different task categories.

## Overview

This suite helps validate and choose between competing free models by running standardized test cases and scoring the outputs.

**Comparison groups:**
- **Code reasoning**: Qwen3 Coder vs Hy3 preview
- **Classification**: Nemotron Nano 9B vs Llama 3.2 3B
- **Long-context reasoning**: Qwen3 Next 80B vs Nemotron 3 Super 120B
- **Multimodal (video)**: Nemotron Nano 12B VL vs Gemma 4 31B

## Quick Start

### 1. Run tests for a specific comparison group

```bash
npm run test:models -- --group code_reasoning --save
npm run test:models -- --group classification --save
npm run test:models -- --group long_context_reasoning --save
npm run test:models -- --group multimodal_video --save
```

### 2. Run all comparisons

```bash
npm run test:models -- --all --save
```

Results are saved to `tests/model-comparison/results/` as JSON files.

### 3. Review and score outputs

1. Open the generated results JSON file
2. For each result, review the test case and model output
3. Follow the [evaluation guide](./EVALUATION_GUIDE.md) to score on four dimensions
4. Update the JSON with your scores under `manual_score`

Example result before scoring:
```json
{
  "test_id": "code_reason_01",
  "model": "qwen/qwen3-coder",
  "output": "SELECT ...",
  "manual_score": null
}
```

After scoring:
```json
{
  "test_id": "code_reason_01",
  "model": "qwen/qwen3-coder",
  "output": "SELECT ...",
  "manual_score": {
    "accuracy": 9,
    "completeness": 10,
    "reasoning": 8,
    "performance": 9,
    "overall": 9,
    "notes": "Excellent SQL with proper joins. Minor: didn't explain HAVING clause."
  }
}
```

### 4. Analyze results

After scoring, generate a comparison report:

```bash
npm run analyze:models -- tests/model-comparison/results/code_reasoning_*.json
```

This will:
- Rank models by average score
- Show performance metrics (latency, tokens, cost)
- Identify category-specific winners
- Provide recommendations for model chain updates

## File Structure

```
tests/model-comparison/
├── README.md                 # This file
├── EVALUATION_GUIDE.md       # Detailed scoring guidance
├── test-cases.ts            # Test scenarios for each comparison group
├── runner.ts                # Test execution engine
├── analyzer.ts              # Result analysis and ranking
├── results/                 # Output directory
│   ├── code_reasoning_2026-04-30T...json
│   ├── classification_2026-04-30T...json
│   └── analysis_2026-04-30T...json
```

## Test Categories

### Code Reasoning (3 tests)
- SQL query generation from natural language
- Regular expression generation with explanation
- Code bug diagnosis and fixing

**Models tested**: Qwen3 Coder vs Hy3 preview

### Classification (2 tests)
- Multi-label sentiment + intent classification
- Complex domain classification (research areas)

**Models tested**: Nemotron Nano 9B vs Llama 3.2 3B

### Long-Context Reasoning (2 tests)
- Multi-document information extraction
- Complex logic puzzle solving

**Models tested**: Qwen3 Next 80B vs Nemotron 3 Super 120B

### Multimodal (2 tests)
- Action recognition from video frames
- Scene understanding with multiple actors

**Models tested**: Nemotron Nano 12B VL vs Gemma 4 31B

## Scoring Dimensions

Each output is scored on a 0-10 scale:

1. **Accuracy** — Does it correctly answer the prompt?
2. **Completeness** — Does it cover all requested aspects?
3. **Reasoning** — Is the explanation clear and logical?
4. **Performance** — How efficient is it (speed, tokens, resources)?
5. **Overall** — Composite score

See [EVALUATION_GUIDE.md](./EVALUATION_GUIDE.md) for detailed scoring guidance.

## Interpreting Results

After analysis, you'll see:

```
Model Rankings (by overall score)
─────────────────────────────────
Rank | Model | Accuracy | ... | Overall | Latency | Cost
  1  | Model A | 8.5/10 | ... | 8.4/10 | 320ms   | $0.0025
  2  | Model B | 7.8/10 | ... | 7.6/10 | 250ms   | $0.0018
```

**Key metrics**:
- **Rank** — Overall winner for this task category
- **Accuracy** — Correctness of answers (most important for reasoning tasks)
- **Completeness** — Coverage of all requirements
- **Reasoning** — Quality of explanations
- **Performance** — Speed and cost efficiency
- **Overall** — Weighted composite score

## Updating Model Chains

Based on comparison results, update `src/models.ts`:

1. **If a better model is found**: Update `free_primary` to the new winner
2. **If current fallback underperforms**: Swap with a higher-scoring alternative
3. **If cost/speed is critical**: Consider promoting a faster/cheaper model despite lower accuracy
4. **If error rate is high**: Add additional fallbacks or adjust paid escalation

Example update:
```typescript
// Before
code: {
  free_primary: 'qwen/qwen3-coder',
  free_fallback: 'openai/gpt-oss-120b',
  ...
}

// After (if Hy3 scores higher)
code: {
  free_primary: 'tencent/hy3-preview',
  free_fallback: 'qwen/qwen3-coder',
  ...
}
```

## Running Periodically

Recommend re-running comparisons:
- **Monthly** — Check if new free models appear on OpenRouter
- **Quarterly** — Validate that primary/fallback choices still hold
- **After major prompt changes** — Verify model performance on updated task definitions

You can automate this with a scheduler:
```bash
npm run test:models -- --all --save
```

## Environment Variables

Required:
- `OPENROUTER_API_KEY` — Your OpenRouter API key (set via Keychain helper or environment)

Optional:
- `TEST_TIMEOUT_MS` — Timeout per request (default: 30000)
- `RATE_LIMIT_MS` — Milliseconds between requests (default: 500)

## Troubleshooting

**"OPENROUTER_API_KEY is not set"**
- Ensure your API key is available in the environment or Keychain helper

**"Unknown comparison group: xyz"**
- Check spelling; valid groups: `code_reasoning`, `classification`, `long_context_reasoning`, `multimodal_video`

**Results have many errors**
- Check if OpenRouter API is accessible
- Verify models still exist on OpenRouter (run `npm run probe:models`)
- Check rate limiting (requests are throttled to 500ms apart)

**Scores show NaN or undefined**
- Ensure all results have `manual_score` fields filled in before running analysis
- Check that scores are numbers between 0-10

## Contributing

To add new test cases:

1. Edit `test-cases.ts` to add a new `TestCase` object
2. Add the test ID to the appropriate `MODEL_COMPARISON_GROUPS` entry
3. Re-run tests to include the new case

To add a new comparison group:

1. Add a new entry to `MODEL_COMPARISON_GROUPS` in `test-cases.ts`
2. Create test cases and add their IDs
3. Run: `npm run test:models -- --group your_new_group`
