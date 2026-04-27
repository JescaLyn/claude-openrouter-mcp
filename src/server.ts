#!/usr/bin/env node
/**
 * openrouter-mcp — MCP server entry point.
 *
 * Phase 0: scaffold only. Tools come in Phase 1+.
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

const SERVER_NAME = 'openrouter-mcp';
const SERVER_VERSION = '0.1.0';

/**
 * Lazy credential gate.
 *
 * If OPENROUTER_API_KEY is missing, the server still starts and registers tools.
 * Any tool call returns a structured MISSING_CREDENTIAL error rather than crashing
 * the process before the MCP handshake completes. This lets the plugin surface a
 * useful error in the host UI instead of a silent connection failure.
 */
function getApiKey(): string | null {
  const key = process.env.OPENROUTER_API_KEY;
  return key && key.trim() !== '' ? key : null;
}

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // Phase 1+ will register the 22 tools here.
  return { tools: [] };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: {
              code: 'MISSING_CREDENTIAL',
              message: 'OPENROUTER_API_KEY is not set.',
              retryable: false,
              suggested_action:
                'Configure the plugin (it will prompt for the key) or set OPENROUTER_API_KEY in .mcp.json env.',
            },
          }),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: {
            code: 'INVALID_INPUT',
            message: `Tool '${request.params.name}' is not registered. Phase 0 scaffold has zero tools; Phase 1+ adds them.`,
            retryable: false,
            suggested_action: 'Wait for Phase 1 implementation, or check the tool name spelling.',
          },
        }),
      },
    ],
    isError: true,
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);

// Log to stderr so it doesn't corrupt the protocol channel.
console.error(`[${SERVER_NAME}] v${SERVER_VERSION} listening on stdio.`);
