// =============================================================================
// agent-discover — MCP transport
//
// Maps MCP tool calls to domain services. Each tool is a thin adapter.
// Also merges proxied tools from active servers into the tool list.
//
// Single tool surface: `registry` (MCP server lifecycle) — minimal prompt
// overhead. activate/deactivate live here too rather than a second tool.
// =============================================================================

import type { AppContext } from '../context.js';
import type { ToolDefinition } from '../types.js';
import { RegistryError } from '../types.js';
import { toolHandlers } from './mcp-handlers.js';

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const tools: ToolDefinition[] = [
  {
    name: 'registry',
    description:
      'MCP server registry. Actions: "find_tool" (single-call tool discovery — BM25-ranked search by intent, returns top match with required args, confidence label, and auto-activates server; PREFER THIS for tool discovery), "get_schema" (full input_schema for a tool already returned by find_tool — only needed for fat schemas with optional/polymorphic args), "list" (search local registry by server), "install" (add server from marketplace or manual config), "uninstall" (remove server), "activate" / "deactivate" (start/stop server and expose/hide its tools), "browse" (search official MCP registry), "status" (show active servers and tools).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'find_tool',
            'get_schema',
            'list',
            'install',
            'uninstall',
            'activate',
            'deactivate',
            'browse',
            'status',
          ],
          description: 'Action to perform',
        },
        limit: { type: 'number', description: '[find_tool/browse] Max results' },
        call_as: {
          type: 'string',
          description: '[get_schema] Fully-qualified mcp__server__tool name from find_tool',
        },
        query: { type: 'string', description: '[list/browse] Search query' },
        source: { type: 'string', description: '[list] Filter by source' },
        installed_only: { type: 'boolean', description: '[list] Only installed servers' },
        name: {
          type: 'string',
          description: '[install/uninstall/activate/deactivate] Server name',
        },
        command: { type: 'string', description: '[install] Command to start server' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '[install] Command arguments',
        },
        env: { type: 'object', description: '[install] Environment variables' },
        description: { type: 'string', description: '[install] Server description' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '[install] Tags',
        },
        cursor: { type: 'string', description: '[browse] Pagination cursor' },
      },
      required: ['action'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

export type ToolHandler = (
  name: string,
  args: Record<string, unknown>,
) => unknown | Promise<unknown>;

export function createToolHandler(ctx: AppContext): ToolHandler {
  return async function handleTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const handler = toolHandlers[name];
    if (handler) {
      return handler(ctx, args);
    }

    const parsed = ctx.proxy.parseToolName(name);
    if (parsed) {
      return ctx.proxy.callTool(parsed.serverName, parsed.toolName, args);
    }

    throw new RegistryError(`Unknown tool: ${name}`, 'UNKNOWN_TOOL');
  };
}

export function getToolList(ctx: AppContext): ToolDefinition[] {
  const proxiedTools = ctx.proxy.getAllProxiedTools();
  return [
    ...tools,
    ...proxiedTools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as ToolDefinition['inputSchema'],
    })),
  ];
}
