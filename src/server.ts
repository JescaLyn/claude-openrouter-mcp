#!/usr/bin/env node
/**
 * openrouter-mcp — MCP server entry point.
 *
 * CRITICAL: stdio JSON-RPC corrupts on stray stdout writes. Any import-time
 * chatter (probe logs, dotenv warnings, transitive `console.log` calls) must
 * be redirected to stderr. The shim below runs BEFORE any other import.
 */

// Redirect console.log to stderr immediately, before any other module loads.
// MCP protocol messages go through process.stdout.write directly; user code
// that calls console.log would otherwise corrupt the channel.
console.log = (...args: unknown[]) => console.error(...args);

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { OpenRouterClient } from './client.js';
import { probeModels, freeModels } from './probe.js';
import { error as errEnv, toolResult } from './envelope.js';
// Foundation (3)
import * as queryModelTool from './tools/query_model.js';
import * as queryFreeTool from './tools/query_free.js';
import * as listFreeModelsTool from './tools/list_free_models.js';
// Text wrappers (5)
import * as summarizeTool from './tools/summarize.js';
import * as extractTool from './tools/extract.js';
import * as classifyTool from './tools/classify.js';
import * as translateTool from './tools/translate.js';
import * as rewriteTool from './tools/rewrite.js';
// Code wrappers (5)
import * as explainCodeTool from './tools/explain_code.js';
import * as generateDocstringTool from './tools/generate_docstring.js';
import * as generateRegexTool from './tools/generate_regex.js';
import * as generateSqlTool from './tools/generate_sql.js';
import * as commitMessageTool from './tools/commit_message.js';
// Free input-processing (5)
import * as extractTextTool from './tools/extract_text.js';
import * as analyzeImageTool from './tools/analyze_image.js';
import * as readPdfTool from './tools/read_pdf.js';
import * as analyzeVideoTool from './tools/analyze_video.js';
import * as queryLongContextTool from './tools/query_long_context.js';
// Paid generation (3) + paid input-processing (1)
import * as generateImageTool from './tools/generate_image.js';
import * as generateAudioTool from './tools/generate_audio.js';
import * as generateVideoTool from './tools/generate_video.js';
import * as transcribeTool from './tools/transcribe.js';
import type { ToolContext } from './types.js';

const SERVER_NAME = 'openrouter-mcp';
const SERVER_VERSION = '0.1.1';

// Populated by the startup probe once it resolves. Used to gate chatDirect on
// named-tool model overrides. Undefined until the probe completes — callers
// degrade gracefully (no gate) until then.
let cachedFreeModelIds: Set<string> | undefined;

// All 22 registered tools — definition + handler.
const TOOLS = [
  // Foundation
  queryModelTool,
  queryFreeTool,
  listFreeModelsTool,
  // Text
  summarizeTool,
  extractTool,
  classifyTool,
  translateTool,
  rewriteTool,
  // Code
  explainCodeTool,
  generateDocstringTool,
  generateRegexTool,
  generateSqlTool,
  commitMessageTool,
  // Free input-processing
  extractTextTool,
  analyzeImageTool,
  readPdfTool,
  analyzeVideoTool,
  queryLongContextTool,
  // Paid generation + input-processing
  generateImageTool,
  generateAudioTool,
  generateVideoTool,
  transcribeTool,
] as const;

/**
 * Lazy credential gate — server starts even without an API key, but every
 * tool call returns MISSING_CREDENTIAL until the key is set. This lets the
 * plugin host surface a useful error in the UI instead of a silent failure.
 */
function getApiKey(): string | null {
  const key = process.env.OPENROUTER_API_KEY;
  return key && key.trim() !== '' ? key : null;
}

function missingCredentialResult() {
  return toolResult(
    errEnv({
      code: 'MISSING_CREDENTIAL',
      message: 'OPENROUTER_API_KEY is not set.',
      suggested_action:
        'Configure the plugin (it prompts for the key at install) or set OPENROUTER_API_KEY in your .mcp.json env block.',
    }),
  );
}

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => t.definition),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const apiKey = getApiKey();
  if (!apiKey) return missingCredentialResult();

  const tool = TOOLS.find((t) => t.definition.name === request.params.name);
  if (!tool) {
    return toolResult(
      errEnv({
        code: 'INVALID_INPUT',
        message: `Tool '${request.params.name}' is not registered. Known: ${TOOLS.map((t) => t.definition.name).join(', ')}.`,
        suggested_action: 'Check the tool name spelling, or call list_free_models to see what is available.',
      }),
    );
  }

  // Build per-call context with a fresh DI'd client. The client carries the
  // API key and, once the startup probe resolves, the set of verified free
  // model IDs used to gate chatDirect on named-tool model overrides.
  const ctx: ToolContext = {
    client: new OpenRouterClient({ apiKey, freeModelIds: cachedFreeModelIds }),
  };

  return tool.handler(request.params.arguments ?? {}, ctx);
});

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  `[${SERVER_NAME}] v${SERVER_VERSION} listening on stdio. ${TOOLS.length} tools registered.`,
);

// Warm startup probe: detect stale curated models and populate the free model cache
// used by chatDirect's allow_paid gate. Not awaited — the probe is read-only and
// correctness degrades gracefully (no gate) until it resolves.
probeModels()
  .then((result) => {
    cachedFreeModelIds = new Set(freeModels(result).map((m) => m.id));
  })
  .catch((e) =>
    console.error(`[probe] startup probe failed: ${e instanceof Error ? e.message : String(e)}`),
  );
