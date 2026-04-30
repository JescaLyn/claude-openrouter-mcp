/**
 * Analyzer for model comparison results.
 * Reads scored results and generates insights and recommendations.
 *
 * Usage:
 *   npm run analyze:models -- tests/model-comparison/results/code_reasoning_*.json
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TestResult {
  test_id: string;
  model: string;
  category: string;
  title: string;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  output_length: number;
  manual_score?: {
    accuracy: number;
    completeness: number;
    reasoning: number;
    performance: number;
    overall: number;
    notes: string;
  };
  error?: string;
}

interface AnalysisResult {
  timestamp: string;
  files_analyzed: string[];
  model_rankings: Array<{
    rank: number;
    model: string;
    avg_accuracy: number;
    avg_completeness: number;
    avg_reasoning: number;
    avg_performance: number;
    avg_overall: number;
    latency_ms: number;
    tokens_out: number;
    cost_usd: number;
    success_rate: number;
    recommendation: string;
  }>;
  category_insights: {
    [category: string]: {
      overall_winner: string;
      accuracy_leader: string;
      speed_leader: string;
      cost_efficiency_leader: string;
      notes: string;
    };
  };
  recommendations: string[];
}

function loadResults(filepath: string): TestResult[] {
  const content = fs.readFileSync(filepath, 'utf-8');
  const data = JSON.parse(content);
  return data.results || [];
}

function calculateStats(results: TestResult[], model: string) {
  const modelResults = results.filter((r) => r.model === model && r.manual_score);
  const withErrors = results.filter((r) => r.model === model && r.error);

  if (modelResults.length === 0) {
    return null;
  }

  const avg = (key: keyof Exclude<TestResult['manual_score'], undefined>) =>
    modelResults.reduce((sum, r) => sum + (r.manual_score?.[key] ?? 0), 0) / modelResults.length;

  const latencies = results
    .filter((r) => r.model === model && !r.error)
    .map((r) => r.latency_ms);
  const avgLatency = latencies.length ? latencies.reduce((a, b) => a + b) / latencies.length : 0;

  const tokens = results
    .filter((r) => r.model === model && !r.error)
    .map((r) => r.tokens_out);
  const avgTokens = tokens.length ? tokens.reduce((a, b) => a + b) / tokens.length : 0;

  const costs = results.filter((r) => r.model === model && !r.error).map((r) => r.cost_usd);
  const totalCost = costs.reduce((a, b) => a + b, 0);

  const totalTests = results.filter((r) => r.model === model).length;
  const successRate = ((totalTests - withErrors.length) / totalTests) * 100;

  return {
    avg_accuracy: avg('accuracy'),
    avg_completeness: avg('completeness'),
    avg_reasoning: avg('reasoning'),
    avg_performance: avg('performance'),
    avg_overall: avg('overall'),
    latency_ms: avgLatency,
    tokens_out: avgTokens,
    cost_usd: totalCost,
    success_rate: successRate,
  };
}

function analyzeFiles(filepaths: string[]): AnalysisResult {
  const allResults: TestResult[] = [];
  const models = new Set<string>();
  const categories = new Set<string>();

  // Load all results
  for (const filepath of filepaths) {
    const results = loadResults(filepath);
    allResults.push(...results);
    results.forEach((r) => {
      models.add(r.model);
      categories.add(r.category);
    });
  }

  // Calculate per-model stats
  const modelStats = Array.from(models)
    .map((model) => ({
      model,
      stats: calculateStats(allResults, model),
    }))
    .filter((m) => m.stats !== null)
    .map(({ model, stats }, idx) => ({
      rank: idx + 1,
      model,
      ...(stats as Exclude<ReturnType<typeof calculateStats>, null>),
      recommendation: stats
        ? generateRecommendation(stats, models.size, Array.from(models))
        : '',
    }))
    .sort((a, b) => b.avg_overall - a.avg_overall)
    .map((item, idx) => ({ ...item, rank: idx + 1 }));

  // Analyze by category
  const categoryInsights: AnalysisResult['category_insights'] = {};
  for (const category of categories) {
    const categoryResults = allResults.filter((r) => r.category === category);

    const modelScores = Array.from(models).map((model) => ({
      model,
      accuracy: calculateStats(categoryResults, model)?.avg_accuracy ?? 0,
      speed: 1 / (calculateStats(categoryResults, model)?.latency_ms ?? 1),
      cost_efficiency:
        (calculateStats(categoryResults, model)?.avg_accuracy ?? 0) /
        Math.max(calculateStats(categoryResults, model)?.cost_usd ?? 0, 0.000001),
    }));

    const accuracyLeader = modelScores.reduce((a, b) => (a.accuracy > b.accuracy ? a : b));
    const speedLeader = modelScores.reduce((a, b) => (a.speed > b.speed ? a : b));
    const costLeader = modelScores.reduce((a, b) => (a.cost_efficiency > b.cost_efficiency ? a : b));
    const overallLeader = modelStats.find((m) =>
      categoryResults.some((r) => r.model === m.model && r.category === category)
    );

    categoryInsights[category] = {
      overall_winner: overallLeader?.model ?? 'unknown',
      accuracy_leader: accuracyLeader.model,
      speed_leader: speedLeader.model,
      cost_efficiency_leader: costLeader.model,
      notes: generateCategoryNotes(categoryResults, category),
    };
  }

  return {
    timestamp: new Date().toISOString(),
    files_analyzed: filepaths,
    model_rankings: modelStats,
    category_insights: categoryInsights,
    recommendations: generateRecommendations(modelStats, categoryInsights),
  };
}

function generateRecommendation(
  stats: Exclude<ReturnType<typeof calculateStats>, null>,
  modelCount: number,
  allModels: string[]
): string {
  const overall = stats.avg_overall;

  if (overall >= 8.5 && stats.success_rate === 100) {
    return 'Recommended as primary model';
  } else if (overall >= 7.5 && stats.success_rate >= 95) {
    return 'Good choice; consider as fallback';
  } else if (overall >= 6.5) {
    return 'Acceptable but needs comparison';
  } else if (stats.success_rate < 80) {
    return 'Not recommended; too many failures';
  }
  return 'Needs further evaluation';
}

function generateCategoryNotes(results: TestResult[], category: string): string {
  const withScores = results.filter((r) => r.manual_score);
  if (withScores.length === 0) {
    return 'No scored results yet';
  }

  const avgAccuracy =
    withScores.reduce((sum, r) => sum + (r.manual_score?.accuracy ?? 0), 0) / withScores.length;
  const highestAccuracy = Math.max(...withScores.map((r) => r.manual_score?.accuracy ?? 0));

  return `Average accuracy: ${avgAccuracy.toFixed(1)}/10, Max: ${highestAccuracy}/10`;
}

function generateRecommendations(
  modelStats: AnalysisResult['model_rankings'],
  insights: AnalysisResult['category_insights']
): string[] {
  const recommendations: string[] = [];

  // Overall winner
  const topModel = modelStats[0];
  if (topModel) {
    recommendations.push(
      `Consider using ${topModel.model} as primary model (avg score: ${topModel.avg_overall.toFixed(1)}/10)`
    );
  }

  // Category-specific
  for (const [category, insight] of Object.entries(insights)) {
    if (
      insight.overall_winner &&
      insight.overall_winner !== 'unknown' &&
      insight.overall_winner !== modelStats[0]?.model
    ) {
      recommendations.push(`For ${category}: prefer ${insight.overall_winner}`);
    }

    if (insight.cost_efficiency_leader && insight.cost_efficiency_leader !== topModel?.model) {
      recommendations.push(`For cost-conscious ${category}: consider ${insight.cost_efficiency_leader}`);
    }
  }

  // Models to deprioritize
  const lowScorers = modelStats.filter((m) => m.avg_overall < 6.5);
  if (lowScorers.length > 0) {
    recommendations.push(
      `Consider replacing ${lowScorers.map((m) => m.model).join(', ')} in fallback chains`
    );
  }

  return recommendations.length > 0
    ? recommendations
    : ['All models performing adequately. No immediate changes recommended.'];
}

function formatReport(analysis: AnalysisResult): string {
  let output = '';
  output += `\n${'═'.repeat(100)}\n`;
  output += `📊 Model Comparison Analysis\n`;
  output += `Generated: ${analysis.timestamp}\n`;
  output += `Files analyzed: ${analysis.files_analyzed.length}\n`;
  output += `${'═'.repeat(100)}\n\n`;

  // Rankings
  output += '🏆 Model Rankings (by overall score)\n';
  output += '─'.repeat(100) + '\n';
  output += 'Rank | Model | Accuracy | Completeness | Reasoning | Performance | Overall | Latency | Cost | Success\n';
  output += '─'.repeat(100) + '\n';

  for (const model of analysis.model_rankings) {
    const row = [
      `${model.rank}`.padEnd(5),
      model.model.padEnd(30),
      `${model.avg_accuracy.toFixed(1)}/10`.padEnd(9),
      `${model.avg_completeness.toFixed(1)}/10`.padEnd(13),
      `${model.avg_reasoning.toFixed(1)}/10`.padEnd(10),
      `${model.avg_performance.toFixed(1)}/10`.padEnd(12),
      `${model.avg_overall.toFixed(1)}/10`.padEnd(8),
      `${model.latency_ms.toFixed(0)}ms`.padEnd(8),
      `$${model.cost_usd.toFixed(4)}`.padEnd(6),
      `${model.success_rate.toFixed(0)}%`.padEnd(8),
    ].join(' ');
    output += row + '\n';
  }

  output += '\n';

  // Category insights
  output += '📈 Category Insights\n';
  output += '─'.repeat(100) + '\n';

  for (const [category, insight] of Object.entries(analysis.category_insights)) {
    output += `\n${category}:\n`;
    output += `  Overall Winner: ${insight.overall_winner}\n`;
    output += `  Accuracy Leader: ${insight.accuracy_leader}\n`;
    output += `  Speed Leader: ${insight.speed_leader}\n`;
    output += `  Cost Efficiency: ${insight.cost_efficiency_leader}\n`;
    output += `  Notes: ${insight.notes}\n`;
  }

  output += '\n';

  // Recommendations
  output += '💡 Recommendations\n';
  output += '─'.repeat(100) + '\n';
  for (const rec of analysis.recommendations) {
    output += `  • ${rec}\n`;
  }

  output += '\n' + '═'.repeat(100) + '\n\n';

  return output;
}

async function main() {
  const filepaths = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));

  if (filepaths.length === 0) {
    console.error('Usage: npm run analyze:models -- <file.json> [<file2.json> ...]');
    process.exit(1);
  }

  // Resolve paths
  const resolvedPaths = filepaths.map((fp) => path.resolve(fp));

  // Verify files exist
  for (const fp of resolvedPaths) {
    if (!fs.existsSync(fp)) {
      console.error(`File not found: ${fp}`);
      process.exit(1);
    }
  }

  try {
    const analysis = analyzeFiles(resolvedPaths);
    const report = formatReport(analysis);
    console.log(report);

    // Save analysis
    const outputDir = path.join(__dirname, 'results');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const outputFile = path.join(outputDir, `analysis_${timestamp}.json`);
    fs.writeFileSync(outputFile, JSON.stringify(analysis, null, 2));
    console.log(`💾 Analysis saved: ${outputFile}\n`);
  } catch (err) {
    console.error(`Error analyzing results: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main().catch(console.error);
