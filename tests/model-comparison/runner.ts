/**
 * Model comparison test runner.
 * Executes test cases against specified models and collects results.
 *
 * Usage:
 *   npm run test:models [--group code_reasoning|classification|long_context_reasoning|multimodal_video]
 *   npm run test:models --all (runs all comparison groups)
 *   npm run test:models --group code_reasoning --save (saves results to file)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TEST_CASES, MODEL_COMPARISON_GROUPS, type TestCase } from './test-cases.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TestResult {
  test_id: string;
  model: string;
  category: string;
  title: string;
  timestamp: string;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  output: string;
  output_length: number;
  error?: string;
  manual_score?: {
    accuracy: number; // 0-10
    completeness: number; // 0-10
    reasoning: number; // 0-10
    performance: number; // 0-10
    overall: number; // 0-10
    notes: string;
  };
}

interface ComparisonReport {
  generated_at: string;
  group: string;
  models: string[];
  test_count: number;
  results: TestResult[];
  summary: {
    [model: string]: {
      avg_latency_ms: number;
      avg_tokens_out: number;
      total_cost_usd: number;
      avg_accuracy: number;
      avg_completeness: number;
      avg_reasoning: number;
      overall_rank: number;
      error_count: number;
    };
  };
}

/**
 * Call OpenRouter API with a test prompt.
 */
async function runTestAgainstModel(
  model: string,
  testCase: TestCase,
  apiKey: string
): Promise<Omit<TestResult, 'manual_score'>> {
  const startTime = Date.now();
  const apiUrl = 'https://openrouter.ai/api/v1/chat/completions';
  const timeoutMs = parseInt(process.env.TEST_TIMEOUT_MS ?? '30000', 10);

  try {
    const response = await fetch(apiUrl, {
      signal: AbortSignal.timeout(timeoutMs),
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/JescaLyn/openrouter-mcp',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: testCase.prompt }],
        temperature: 0.3,
        max_tokens: 2000,
      }),
    });

    const latency = Date.now() - startTime;
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      error?: { message?: string };
    };

    if (!response.ok || data.error) {
      return {
        test_id: testCase.id,
        model,
        category: testCase.category,
        title: testCase.title,
        timestamp: new Date().toISOString(),
        latency_ms: latency,
        tokens_in: data.usage?.prompt_tokens ?? 0,
        tokens_out: data.usage?.completion_tokens ?? 0,
        cost_usd: 0,
        output: '',
        output_length: 0,
        error: data.error?.message ?? `HTTP ${response.status}`,
      };
    }

    const output = data.choices?.[0]?.message?.content ?? '';
    const tokensIn = data.usage?.prompt_tokens ?? 0;
    const tokensOut = data.usage?.completion_tokens ?? 0;

    return {
      test_id: testCase.id,
      model,
      category: testCase.category,
      title: testCase.title,
      timestamp: new Date().toISOString(),
      latency_ms: latency,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost_usd: data.usage?.cost ?? 0, // From OpenRouter response; 0 for free models
      output,
      output_length: output.length,
    };
  } catch (err) {
    const latency = Date.now() - startTime;
    return {
      test_id: testCase.id,
      model,
      category: testCase.category,
      title: testCase.title,
      timestamp: new Date().toISOString(),
      latency_ms: latency,
      tokens_in: 0,
      tokens_out: 0,
      cost_usd: 0,
      output: '',
      output_length: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Run all tests in a comparison group.
 */
async function runComparisonGroup(
  groupName: string,
  apiKey: string
): Promise<ComparisonReport> {
  const group = MODEL_COMPARISON_GROUPS[groupName as keyof typeof MODEL_COMPARISON_GROUPS];
  if (!group) {
    throw new Error(`Unknown comparison group: ${groupName}`);
  }

  const tests = TEST_CASES.filter((t) => group.test_ids.includes(t.id));
  const results: TestResult[] = [];

  console.log(`\n📊 Running ${groupName} comparisons...`);
  console.log(`   Models: ${group.models.join(', ')}`);
  console.log(`   Tests: ${group.test_ids.length}`);

  for (const test of tests) {
    console.log(`   Testing: ${test.id} (${test.title})`);

    for (const model of group.models) {
      process.stdout.write(`     → ${model}... `);
      try {
        const result = await runTestAgainstModel(model, test, apiKey);
        results.push(result);
        console.log(`✓ (${result.latency_ms}ms, ${result.tokens_out} tokens)`);
      } catch (err) {
        console.log(`✗ (${err instanceof Error ? err.message : String(err)})`);
      }

      // Rate limit: configurable via RATE_LIMIT_MS env var, default 500ms
      const rateLimitMs = parseInt(process.env.RATE_LIMIT_MS ?? '500', 10);
      await new Promise((resolve) => setTimeout(resolve, rateLimitMs));
    }
  }

  // Generate summary
  const summary: ComparisonReport['summary'] = {};
  for (const model of group.models) {
    const modelResults = results.filter((r) => r.model === model && !r.error);
    const scored = modelResults.filter((r) => r.manual_score);

    summary[model] = {
      avg_latency_ms: modelResults.length
        ? modelResults.reduce((sum, r) => sum + r.latency_ms, 0) / modelResults.length
        : 0,
      avg_tokens_out: modelResults.length
        ? modelResults.reduce((sum, r) => sum + r.tokens_out, 0) / modelResults.length
        : 0,
      total_cost_usd: modelResults.reduce((sum, r) => sum + r.cost_usd, 0),
      avg_accuracy: scored.length
        ? scored.reduce((sum, r) => sum + (r.manual_score?.accuracy ?? 0), 0) / scored.length
        : 0,
      avg_completeness: scored.length
        ? scored.reduce((sum, r) => sum + (r.manual_score?.completeness ?? 0), 0) / scored.length
        : 0,
      avg_reasoning: scored.length
        ? scored.reduce((sum, r) => sum + (r.manual_score?.reasoning ?? 0), 0) / scored.length
        : 0,
      overall_rank: 0, // Will be assigned after all comparisons
      error_count: results.filter((r) => r.model === model && r.error).length,
    };
  }

  // Rank models by overall score
  const ranked = Object.entries(summary).sort(
    (a, b) => (b[1].avg_accuracy + b[1].avg_completeness + b[1].avg_reasoning) / 3 -
              (a[1].avg_accuracy + a[1].avg_completeness + a[1].avg_reasoning) / 3
  );
  ranked.forEach(([model, stats], idx) => {
    summary[model].overall_rank = idx + 1;
  });

  return {
    generated_at: new Date().toISOString(),
    group: groupName,
    models: group.models,
    test_count: tests.length,
    results,
    summary,
  };
}

/**
 * Save report to file.
 */
function saveReport(report: ComparisonReport): string {
  const resultsDir = path.join(__dirname, 'results');
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const filename = `${report.group}_${timestamp}.json`;
  const filepath = path.join(resultsDir, filename);

  fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
  console.log(`\n💾 Report saved: ${filepath}`);
  return filepath;
}

/**
 * Print formatted report to console.
 */
function printReport(report: ComparisonReport): void {
  console.log(`\n${'═'.repeat(80)}`);
  console.log(`📈 Comparison Report: ${report.group}`);
  console.log(`Generated: ${report.generated_at}`);
  console.log(`${'═'.repeat(80)}\n`);

  // Summary table
  console.log('Summary:');
  console.log('─'.repeat(80));
  console.log(
    'Model | Latency | Tokens | Cost | Acc | Comp | Reas | Rank | Errors'.padEnd(80)
  );
  console.log('─'.repeat(80));

  for (const [model, stats] of Object.entries(report.summary)) {
    const row = [
      model.padEnd(30),
      `${stats.avg_latency_ms.toFixed(0)}ms`.padEnd(8),
      `${stats.avg_tokens_out.toFixed(0)}`.padEnd(7),
      `$${stats.total_cost_usd.toFixed(4)}`.padEnd(6),
      `${stats.avg_accuracy.toFixed(1)}/10`.padEnd(5),
      `${stats.avg_completeness.toFixed(1)}/10`.padEnd(6),
      `${stats.avg_reasoning.toFixed(1)}/10`.padEnd(6),
      `${stats.overall_rank}`.padEnd(5),
      `${stats.error_count}`.padEnd(7),
    ].join(' ');
    console.log(row);
  }

  console.log('─'.repeat(80));
  console.log(
    '\n📝 Note: Accuracy, Completeness, and Reasoning scores require manual evaluation.'
  );
  console.log('   Results saved. Review outputs and add scores to results JSON file.\n');
}

/**
 * Main entry point.
 */
async function main() {
  const args = process.argv.slice(2);
  const apiKey = process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    console.error('Error: OPENROUTER_API_KEY environment variable not set');
    process.exit(1);
  }

  let groupsToRun: string[] = [];

  if (args.includes('--all')) {
    groupsToRun = Object.keys(MODEL_COMPARISON_GROUPS);
  } else {
    const groupIdx = args.indexOf('--group');
    if (groupIdx >= 0 && groupIdx + 1 < args.length) {
      groupsToRun = [args[groupIdx + 1]];
    } else {
      console.log('Usage:');
      console.log('  npm run test:models --all');
      console.log('  npm run test:models --group code_reasoning [--save]');
      console.log('  npm run test:models --group classification [--save]');
      console.log('  npm run test:models --group long_context_reasoning [--save]');
      console.log('  npm run test:models --group multimodal_video [--save]');
      process.exit(1);
    }
  }

  const shouldSave = args.includes('--save');
  const reports: ComparisonReport[] = [];

  for (const group of groupsToRun) {
    try {
      const report = await runComparisonGroup(group, apiKey);
      reports.push(report);
      printReport(report);

      if (shouldSave) {
        saveReport(report);
      }
    } catch (err) {
      console.error(`\n❌ Error running ${group}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (reports.length === 0) {
    console.error('No tests ran successfully');
    process.exit(1);
  }

  console.log(
    `\n✓ Completed ${reports.length} comparison group(s). ${shouldSave ? '(Results saved)' : '(Use --save to persist)'}`
  );
}

main().catch(console.error);
