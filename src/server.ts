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
import { error as errEnv, toolResult } from './envelope.js';
import * as queryModelTool from './tools/query_model.js';
import * as queryFreeTool from './tools/query_free.js';
import * as listFreeModelsTool from './tools/list_free_models.js';
import type { ToolContext } from './types.js';

const SERVER_NAME = 'openrouter-mcp';
const SERVER_VERSION = '0.1.0';

// All registered tools — definition + handler. Phase 2 will add 19 more.
const TOOLS = [queryModelTool, queryFreeTool, listFreeModelsTool] as const;

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
  // API key but no other state — safe to instantiate per call.
  const ctx: ToolContext = {
    client: new OpenRouterClient({ apiKey }),
  };

  return tool.handler(request.params.arguments ?? {}, ctx);
});

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  `[${SERVER_NAME}] v${SERVER_VERSION} listening on stdio. ${TOOLS.length} tools registered.`,
);
