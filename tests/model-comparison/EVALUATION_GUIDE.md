# Model Comparison Evaluation Guide

This guide explains how to evaluate test results and score model outputs.

## Overview

The test runner collects raw outputs from OpenRouter models. You then manually evaluate each output against predefined criteria and add scores to the results file.

## Scoring Scale

Each output is scored on four dimensions (0-10 scale):

### 1. **Accuracy** (0-10)
Does the output correctly address the test requirement?
- **10** — Perfect, no errors, directly answers the prompt
- **8-9** — Minor issues or slight inaccuracies that don't affect core answer
- **6-7** — Correct answer but with some flaws or missing details
- **4-5** — Partially correct; some significant gaps or errors
- **2-3** — Mostly incorrect; barely addresses the prompt
- **0-1** — Wrong or nonsensical response

### 2. **Completeness** (0-10)
Did the output cover all requested aspects?
- **10** — Includes all requested elements (if applicable)
- **8-9** — Minor elements missing but covers 90%+ of requirements
- **6-7** — Missing some requested elements (70-89%)
- **4-5** — Major gaps; only 50-70% of requirements covered
- **2-3** — Minimal coverage; <50% of requirements
- **0-1** — Completely incomplete

### 3. **Reasoning** (0-10)
Is the reasoning clear, logical, and well-explained?
- **10** — Excellent step-by-step explanation, easy to follow
- **8-9** — Clear reasoning with minor gaps
- **6-7** — Mostly clear but some jumps or unclear steps
- **4-5** — Sparse reasoning; hard to follow in places
- **2-3** — Minimal explanation; mostly just answers
- **0-1** — No reasoning provided or incoherent

### 4. **Performance** (0-10)
How efficient was the output? (speed, token count, resource usage)
- **10** — Extremely efficient; minimal wasted tokens
- **8-9** — Very efficient; appropriate verbosity
- **6-7** — Good efficiency; some unnecessary verbosity
- **4-5** — Acceptable but verbose; could be more efficient
- **2-3** — Quite verbose; wastes tokens
- **0-1** — Extremely inefficient or timed out

### 5. **Overall** (0-10)
Composite score. Generally: (Accuracy + Completeness + Reasoning + Performance) / 4, but override if needed.

## Evaluation Process

1. **Open the results JSON file** (in `tests/model-comparison/results/`)
2. **For each test result**, review:
   - The test case (in `test-cases.ts`)
   - The expected qualities
   - The eval criteria
   - The model's output (in the result)
3. **Score on each dimension** using the scale above
4. **Add a notes field** for any important observations
5. **Update the JSON** with the scores

Example scoring entry:
```json
{
  "test_id": "code_reason_01",
  "model": "qwen/qwen3-coder",
  "...other fields...",
  "manual_score": {
    "accuracy": 9,
    "completeness": 10,
    "reasoning": 8,
    "performance": 9,
    "overall": 9,
    "notes": "Excellent SQL with proper JOINs and GROUP BY. Minor: didn't explicitly explain the HAVING clause."
  }
}
```

## Key Evaluation Tips

### Code Reasoning Tasks
- **Accuracy**: Does the code/regex/SQL actually work?
- **Completeness**: Are all constraints/requirements met?
- **Reasoning**: Is the explanation clear enough for someone to understand why?

### Classification Tasks
- **Accuracy**: Are the selected labels correct?
- **Completeness**: Are all applicable labels included?
- **Reasoning**: Is the justification sound?

### Long-Context Reasoning
- **Accuracy**: Is the final answer correct?
- **Completeness**: Are all constraints/documents considered?
- **Reasoning**: Is the deduction chain logical and followable?

### Multimodal Tasks
- **Accuracy**: Are descriptions accurate to the scenario?
- **Completeness**: All actions/objects/participants identified?
- **Reasoning**: Are predictions justified by the scenario?

## Comparison Analysis

After scoring all results, analyze patterns:

1. **By model**: Which model scores highest overall?
2. **By category**: Which category is harder for each model?
3. **By criterion**: Do models excel in specific dimensions (speed vs. accuracy)?
4. **Cost-benefit**: Does the cheaper/faster model trade off too much accuracy?

## Output Report

Run the analysis script to generate a comparison report:
```bash
npm run analyze:models -- tests/model-comparison/results/your_results.json
```

This will show:
- Per-model averages across all dimensions
- Confidence intervals and standard deviation
- Recommendation on which model is best for the task category
- Suggested model chain updates (if warranted)
