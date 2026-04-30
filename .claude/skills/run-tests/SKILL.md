---
name: run-tests
description: Run all OpenRouter model comparisons and generate evaluation report
when_to_use: When you want to validate model performance across code reasoning, classification, long-context reasoning, and multimodal tasks. Runs tests, evaluates outputs, and recommends model chain updates.
user-invocable: true
---

# /run-tests

Run all OpenRouter model comparison groups, evaluate outputs with scoring and reasoning, and generate an analysis report with recommendations for updating model chains.

## What it does

1. **Executes all comparisons** — Runs 4 comparison groups (code_reasoning, classification, long_context_reasoning, multimodal_video) in sequence
2. **Saves results** — Writes raw model outputs to `tests/model-comparison/results/`
3. **Evaluates automatically** — Spawns the model-evaluator agent to review outputs, score on accuracy/completeness/reasoning/performance, and flag uncertainties
4. **Generates analysis** — Produces a formatted report with rankings, category insights, and specific recommendations

## Time estimate

- Tests: ~2-3 minutes (rate-limited to 500ms between requests)
- Evaluation: ~1-2 minutes
- **Total: ~4 minutes**

## Output format

You'll receive:
- **Model rankings** by overall score (0-10)
- **Per-dimension breakdown** (accuracy, completeness, reasoning, performance)
- **Category insights** (which model wins for each comparison group)
- **Recommendations** (e.g., "Update code task free_primary from X to Y")
- **Flagged uncertainties** (scores marked as low-confidence)

## Next steps after evaluation

- Review the recommendations
- If you agree, update `src/models.ts` model chains
- Optionally re-run specific groups to validate changes

## Requirements

- OpenRouter API key in Keychain (configured via helper script)
- `npm run build` completed (tests use `dist/server.js`)

---

## Implementation

1. Run all 4 comparison groups and save results:

```bash
npm run test:models -- --all --save
```

2. Invoke the model-evaluator agent on the saved results in `tests/model-comparison/results/`.

3. Present rankings, category insights, and model chain recommendations.
