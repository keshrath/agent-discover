// =============================================================================
// agent-discover — MCP server factory
//
// Builds one low-level SDK `Server` per HTTP request (2026-07-28) or per
// legacy session (2025). All instances share the AppContext, so state is
// single-sourced in the daemon. The low-level API fits a gateway: tools/list
// is computed from the DB per request (deterministic order), and upstream
// schemas are advertised verbatim without per-request conversion.
// =============================================================================

import { randomBytes } from 'node:crypto';
import {
  ProtocolError,
  ProtocolErrorCode,
  Server,
  createRequestStateCodec,
  isInputRequiredResult,
  type CallToolResult,
  type InputRequiredResult,
  type InputResponses,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import { splitToolName } from '../domain/lifecycle.js';
import { readPackageMeta } from '../package-meta.js';
import {
  META_TOOLS,
  META_TOOL_DEFS,
  exposedName,
  runMetaTool,
  type McpRuntime,
  type McpState,
  type MetaToolName,
} from './tools.js';
import { PROMPTS, getPrompt } from './prompts.js';

const INSTRUCTIONS = `agent-discover is an MCP gateway: it installs other MCP servers, indexes their tools and proxies calls.
- Need a capability you don't see? search_tools({queries:[...]}) searches every installed server's tools, enabled or not.
- Exposed tools appear as <server>__<tool>; call them directly. Others: call_tool({server, tool, arguments}) or enable_server first.
- Nothing installed fits? search_servers, then install_server (the user confirms the command).
- server_status shows what is installed, enabled and connected.`;

export interface McpFactory {
  build(): Server;
}

export function createMcpFactory(app: AppContext): McpFactory {
  const info = readPackageMeta();
  // Single daemon process serves every MRTR round, so a per-process key works.
  const codec = createRequestStateCodec<McpState>({ key: randomBytes(32), ttlSeconds: 600 });

  const exposedTools = (): Tool[] => {
    if (app.config.mode !== 'native') return [];
    return app.index.listEnabled().map((t) => ({
      name: exposedName(t.server, t.name),
      ...(t.title ? { title: t.title } : {}),
      description: `[${t.server}] ${t.description}`,
      inputSchema: t.input_schema as Tool['inputSchema'],
      ...(t.output_schema ? { outputSchema: t.output_schema as Tool['outputSchema'] } : {}),
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }));
  };

  async function forward(
    serverName: string,
    tool: string,
    args: Record<string, unknown> | undefined,
    ctx: ServerContext,
  ): Promise<CallToolResult | InputRequiredResult> {
    const state = ctx.mcpReq.requestState<McpState>();
    const upstreamState =
      state?.kind === 'upstream' && state.server === serverName && state.tool === tool
        ? state.state
        : undefined;
    const progressToken = ctx.mcpReq._meta?.progressToken;
    let result: CallToolResult | InputRequiredResult;
    try {
      result = await app.lifecycle.callTool(serverName, tool, args, {
        signal: ctx.mcpReq.signal,
        inputResponses:
          state?.kind === 'upstream' ? (ctx.mcpReq.inputResponses as InputResponses) : undefined,
        requestState: upstreamState,
        onprogress: (p) => {
          if (progressToken === undefined) return;
          void ctx.mcpReq.notify({ method: 'notifications/progress', params: { ...p, progressToken } });
        },
      });
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }] };
    }
    if (isInputRequiredResult(result)) {
      return {
        ...result,
        requestState: await codec.mint(
          { kind: 'upstream', server: serverName, tool, state: result.requestState },
          ctx,
        ),
      };
    }
    return result;
  }

  return {
    build() {
      const server = new Server(
        { name: info.name, version: info.version },
        {
          capabilities: { tools: { listChanged: true }, prompts: { listChanged: false } },
          instructions: INSTRUCTIONS,
          cacheHints: { 'tools/list': { ttlMs: 0, cacheScope: 'private' } },
          requestState: { verify: codec.verify },
          inputRequired: { maxRounds: 8 },
        },
      );
      const rt: McpRuntime = { app, server, mint: (s, ctx) => codec.mint(s, ctx), forward };
      const allTools = () =>
        [...META_TOOL_DEFS, ...exposedTools()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      server.setRequestHandler('tools/list', () => ({ tools: allTools() }));
      server.setRequestHandler('tools/call', async (req, ctx) => {
        const { name, arguments: args } = req.params;
        if (name in META_TOOLS) {
          const result = await runMetaTool(rt, name as MetaToolName, args, ctx);
          if (isInputRequiredResult(result)) return result;
          const def = META_TOOL_DEFS.find((t) => t.name === name);
          return server.projectCallToolResult(result, def?.outputSchema);
        }
        const parsed = splitToolName(name);
        const def = parsed && app.config.mode === 'native' ? app.index.get(parsed.server, parsed.tool) : null;
        if (!parsed || !def || !app.servers.get(parsed.server)?.enabled) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
        }
        const result = await forward(parsed.server, parsed.tool, args, ctx);
        if (isInputRequiredResult(result)) return result;
        return server.projectCallToolResult(result, def.output_schema ?? undefined);
      });
      server.setRequestHandler('prompts/list', () => ({ prompts: PROMPTS }));
      server.setRequestHandler('prompts/get', (req) => getPrompt(req.params.name, req.params.arguments));
      return server;
    },
  };
}
