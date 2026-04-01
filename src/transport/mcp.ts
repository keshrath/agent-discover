// =============================================================================
// agent-discover — MCP transport
//
// Maps MCP tool calls to domain services. Each tool is a thin adapter.
// Also merges proxied tools from active servers into the tool list.
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
      'MCP server registry. Actions: "list" (search local registry), "install" (add server from registry or manual config), "uninstall" (remove server), "browse" (search official MCP registry), "status" (show active servers and tools).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'install', 'uninstall', 'browse', 'status'],
          description: 'Action to perform',
        },
        // list params
        query: { type: 'string', description: '[list/browse] Search query' },
        source: { type: 'string', description: '[list] Filter by source' },
        installed_only: { type: 'boolean', description: '[list] Only installed servers' },
        // install params
        name: { type: 'string', description: '[install/uninstall] Server name' },
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
        // browse params
        limit: { type: 'number', description: '[browse] Max results (default 20)' },
        cursor: { type: 'string', description: '[browse] Pagination cursor' },
      },
      required: ['action'],
    },
  },

  {
    name: 'registry_server',
    description:
      'Activate or deactivate an MCP server. Activation starts the server process and exposes its tools. Deactivation stops it.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['activate', 'deactivate'],
          description: 'Action to perform',
        },
        name: { type: 'string', description: 'Server name' },
      },
      required: ['action', 'name'],
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
