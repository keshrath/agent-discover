// =============================================================================
// agent-discover — MCP tool handlers
//
// Implementation of each MCP tool. Thin adapters that delegate to
// domain services.
// =============================================================================

import type { AppContext } from '../context.js';
import { ValidationError } from '../types.js';

type HandlerFn = (ctx: AppContext, args: Record<string, unknown>) => unknown | Promise<unknown>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function optStr(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function optBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function optNum(v: unknown, fallback: number): number {
  return typeof v === 'number' ? v : fallback;
}

// ---------------------------------------------------------------------------
// registry — MCP server lifecycle dispatcher
// ---------------------------------------------------------------------------

const handleRegistry: HandlerFn = async (ctx, args) => {
  const action = str(args.action);
  switch (action) {
    case 'list':
      return registryList(ctx, args);
    case 'install':
      return registryInstall(ctx, args);
    case 'uninstall':
      return registryUninstall(ctx, args);
    case 'activate':
      return registryActivate(ctx, args);
    case 'deactivate':
      return registryDeactivate(ctx, args);
    case 'browse':
      return registryBrowse(ctx, args);
    case 'status':
      return registryStatus(ctx, args);
    case 'find_tool':
      return registryFindTool(ctx, args);
    case 'find_tools':
      return registryFindTools(ctx, args);
    case 'get_schema':
      return registryGetSchema(ctx, args);
    case 'proxy_call':
      return registryProxyCall(ctx, args);
    default:
      throw new ValidationError(
        `Unknown registry action: "${action}". Valid: list, install, uninstall, activate, deactivate, browse, status, find_tool, find_tools, get_schema, proxy_call`,
      );
  }
};

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

const registryList: HandlerFn = (ctx, args) => {
  const query = optStr(args.query);
  const source = optStr(args.source);
  const installedOnly = optBool(args.installed_only);

  const servers = ctx.registry.list({ query, source, installedOnly });

  return servers.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    source: s.source,
    tags: s.tags,
    installed: s.installed,
    active: ctx.proxy.isActive(s.name),
    transport: s.transport,
    health_status: s.health_status,
    last_health_check: s.last_health_check,
    error_count: s.error_count,
    tool_count: ctx.registry.getTools(s.id).length,
  }));
};

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

const registryInstall: HandlerFn = async (ctx, args) => {
  const name = str(args.name);
  if (!name) throw new ValidationError('name is required');

  const source = optStr(args.source);

  const existing = ctx.registry.getByName(name);
  if (existing) {
    return { status: 'already_registered', server: existing.name };
  }

  // If source is 'registry', try to fetch from marketplace first
  if (source === 'registry') {
    try {
      const result = await ctx.marketplace.browse(name, 5);
      const match = result.servers.find((s) => s.name === name || s.name.includes(name));

      if (match) {
        const npmPkg = match.packages.find((p) => p.runtime === 'node');
        const pyPkg = match.packages.find((p) => p.runtime === 'python');
        const pkg = npmPkg ?? pyPkg;

        if (pkg) {
          const installConfig = ctx.installer.detectInstallConfig(pkg.name, pkg.runtime);
          const input = ctx.installer.buildServerInput(match.name, installConfig, {
            description: match.description,
            repository: match.repository ?? undefined,
            version: match.version,
          });

          const server = ctx.registry.register(input);
          ctx.events.emit('server:installed', { server });
          return {
            status: 'installed',
            server: server.name,
            source: 'registry',
            command: server.command,
            args: server.args,
          };
        }
      }
    } catch {
      // Fall through to manual registration
    }
  }

  // Manual registration
  const command = optStr(args.command);
  if (!command) {
    throw new ValidationError(
      'command is required for manual installation (or use source: "registry" to auto-detect)',
    );
  }

  const serverArgs = Array.isArray(args.args) ? (args.args as string[]) : [];
  const env =
    typeof args.env === 'object' && args.env !== null ? (args.env as Record<string, string>) : {};
  const tags = Array.isArray(args.tags) ? (args.tags as string[]) : [];

  const server = ctx.registry.register({
    name,
    description: optStr(args.description) ?? '',
    source: 'manual',
    command,
    args: serverArgs,
    env,
    tags,
  });

  ctx.events.emit('server:installed', { server });
  return {
    status: 'installed',
    server: server.name,
    command: server.command,
    args: server.args,
  };
};

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

const registryUninstall: HandlerFn = async (ctx, args) => {
  const name = str(args.name);
  if (!name) throw new ValidationError('name is required');

  // Deactivate if active
  if (ctx.proxy.isActive(name)) {
    await ctx.proxy.deactivate(name);
    ctx.registry.setActive(name, false);
  }

  const server = ctx.registry.getByName(name);
  if (server) {
    ctx.registry.clearTools(server.id);
  }

  ctx.registry.unregister(name);
  ctx.events.emit('server:uninstalled', { name });
  return { status: 'uninstalled', name };
};

// ---------------------------------------------------------------------------
// activate
// ---------------------------------------------------------------------------

const registryActivate: HandlerFn = async (ctx, args) => {
  const name = str(args.name);
  if (!name) throw new ValidationError('name is required');

  if (ctx.proxy.isActive(name)) {
    return { status: 'already_active', name };
  }

  const server = ctx.registry.getByName(name);
  if (!server) throw new ValidationError(`Server "${name}" not found in registry`);

  const isRemote = server.transport === 'sse' || server.transport === 'streamable-http';
  if (!isRemote && !server.command) {
    throw new ValidationError(`Server "${name}" has no command configured`);
  }
  if (isRemote && !server.homepage && !server.repository) {
    throw new ValidationError(`Server "${name}" has no URL configured for remote transport`);
  }

  const tools = await ctx.proxy.activate({
    name: server.name,
    command: server.command ?? undefined,
    args: server.args,
    env: server.env,
    transport: server.transport,
    url: server.homepage ?? undefined,
  });

  ctx.registry.setActive(name, true);
  ctx.registry.saveTools(
    server.id,
    tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    })),
  );

  ctx.events.emit('server:activated', { name, tool_count: tools.length });

  return {
    status: 'activated',
    name,
    tools: tools.map((t) => ({
      name: `${name}__${t.name}`,
      description: t.description ?? '',
    })),
  };
};

// ---------------------------------------------------------------------------
// deactivate
// ---------------------------------------------------------------------------

const registryDeactivate: HandlerFn = async (ctx, args) => {
  const name = str(args.name);
  if (!name) throw new ValidationError('name is required');

  if (!ctx.proxy.isActive(name)) {
    return { status: 'not_active', name };
  }

  await ctx.proxy.deactivate(name);
  ctx.registry.setActive(name, false);

  const server = ctx.registry.getByName(name);
  if (server) {
    ctx.registry.clearTools(server.id);
  }

  ctx.events.emit('server:deactivated', { name });

  return { status: 'deactivated', name };
};

// ---------------------------------------------------------------------------
// browse
// ---------------------------------------------------------------------------

const registryBrowse: HandlerFn = async (ctx, args) => {
  const query = optStr(args.query);
  const limit = optNum(args.limit, 20);
  const cursor = optStr(args.cursor);

  const result = await ctx.marketplace.browse(query, limit, cursor);

  return {
    servers: result.servers.map((s) => ({
      name: s.name,
      description: s.description,
      version: s.version,
      repository: s.repository,
      packages: s.packages.map((p) => ({
        name: p.name,
        runtime: p.runtime,
        version: p.version,
      })),
    })),
    next_cursor: result.next_cursor,
  };
};

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

const registryStatus: HandlerFn = (ctx) => {
  const activeNames = ctx.proxy.getActiveServerNames();

  if (activeNames.length === 0) {
    return { active_count: 0, servers: [] };
  }

  const servers = activeNames.map((name) => {
    const tools = ctx.proxy.getServerTools(name);
    const dbServer = ctx.registry.getByName(name);
    return {
      name,
      description: dbServer?.description ?? '',
      tool_count: tools.length,
      tools: tools.map((t) => t.name),
    };
  });

  return { active_count: servers.length, servers };
};

// ---------------------------------------------------------------------------
// find_tool — single round-trip tool discovery
// ---------------------------------------------------------------------------
//
// Searches the cross-server tool index for the best match, auto-activates the
// owning server if needed, and returns the tool's full schema + the
// fully-qualified MCP name the agent should call next. Designed to collapse
// the typical search → fetch_schema → activate → invoke flow into one round-trip
// before the actual tool call. Without this, agents do 5–10 round-trips per
// task on a non-trivial registry.

// Compact tool summary returned by find_tool. Excludes the full input_schema
// (which can be 1–2k tokens for fat tools like browser_navigate). Required
// args + their types are usually enough for the agent to either invoke
// directly or decide it's the wrong tool. If the agent needs the full schema
// it calls get_schema(call_as) explicitly.
function compactSchema(schema: Record<string, unknown> | unknown): {
  required_args: Array<{ name: string; type: string; description?: string }>;
  optional_count: number;
} {
  if (!schema || typeof schema !== 'object') return { required_args: [], optional_count: 0 };
  const s = schema as {
    properties?: Record<string, { type?: string; description?: string }>;
    required?: string[];
  };
  const props = s.properties ?? {};
  const required = s.required ?? [];
  const required_args = required.map((name) => ({
    name,
    type: props[name]?.type ?? 'unknown',
    description: props[name]?.description,
  }));
  const optional_count = Math.max(0, Object.keys(props).length - required.length);
  return { required_args, optional_count };
}

// Derive a confidence label from the BM25 score gap. If the top match scores
// significantly above the runner-up the agent should trust it; if not, the
// query is genuinely ambiguous and the agent should look at other_matches or
// ask for disambiguation. Threshold tuned empirically (BM25 differences of
// >0.5 typically indicate a clearly-better match).
function deriveConfidence(scores: number[]): 'high' | 'medium' | 'low' {
  if (scores.length === 0) return 'low';
  if (scores[0] === 0) return 'medium'; // LIKE fallback — no signal
  if (scores.length === 1) return 'high';
  const gap = scores[0] - scores[1];
  if (gap >= 0.5) return 'high';
  if (gap >= 0.15) return 'medium';
  return 'low';
}

const registryFindTool: HandlerFn = async (ctx, args) => {
  const query = str(args.query);
  if (!query) throw new ValidationError('query is required');
  const limit = optNum(args.limit, 5);
  // When auto_activate is true (default), find_tool starts the owning child
  // server AND emits notifications/tools/list_changed so the host can refetch
  // the proxied tools and call them directly. This is convenient at small N
  // but at large N (>1k tools) it causes the host to receive a huge tool
  // catalog that may not fit in the model context. When false, the server is
  // started silently and the agent must use action:"proxy_call" to invoke
  // the tool via agent-discover instead of directly. Use false for huge
  // catalogs.
  const autoActivate = args.auto_activate !== false;

  // Prefer hybrid (BM25 + semantic) when embeddings are available — closes
  // the natural-language gap that pure BM25 misses (e.g., "billing
  // arrangement" → "subscription"). Falls back to pure BM25 internally if
  // the embedding provider is disabled.
  const matches = await ctx.registry.searchToolsHybrid(query, limit);
  if (matches.length === 0) {
    return {
      found: false,
      matches: [],
      hint: 'no tools matched — try different keywords or registry({action:"list"}) to browse',
    };
  }

  const top = matches[0];
  const confidence = deriveConfidence(matches.map((m) => m.score));

  // Activate the owning server so the proxy is connected and ready. When
  // autoActivate is true, ALL of the server's tools also get exposed to the
  // host via getToolList — the bloat trigger at large N. When false, we
  // still spin up the proxy connection (so proxy_call works) but don't mark
  // the server as "active" in the registry, which keeps getToolList minimal.
  const server = ctx.registry.getByName(top.server_name);
  const canActivate =
    server &&
    (server.command || server.transport === 'sse' || server.transport === 'streamable-http');
  if (canActivate && !ctx.proxy.isActive(top.server_name)) {
    try {
      await ctx.proxy.activate({
        name: server.name,
        command: server.command ?? undefined,
        args: server.args,
        env: server.env,
        transport: server.transport,
        url: server.homepage ?? undefined,
      });
      // Only flip the registry's active flag (which makes getToolList expose
      // proxied tools to the host) when autoActivate was requested. Otherwise
      // the proxy is connected behind agent-discover and reachable via
      // proxy_call without leaking thousands of tool schemas to the host.
      if (autoActivate) ctx.registry.setActive(server.name, true);
    } catch {
      /* fall through — agent can still see the schema summary even if activation failed */
    }
  }

  const compact = compactSchema(top.input_schema);
  return {
    found: true,
    confidence,
    score: top.score,
    call_as: `mcp__${top.server_name}__${top.name}`,
    server: top.server_name,
    tool: top.name,
    description: top.description,
    required_args: compact.required_args,
    optional_count: compact.optional_count,
    // Hint to the agent: if confidence is high, just invoke. If medium, glance
    // at other_matches first. If low, ask the user.
    next_step:
      confidence === 'high'
        ? 'invoke call_as directly'
        : confidence === 'medium'
          ? 'check other_matches; pick one and invoke (without re-searching)'
          : 'ambiguous — ask the user to disambiguate or pick from other_matches',
    other_matches: matches.slice(1).map((m) => ({
      call_as: `mcp__${m.server_name}__${m.name}`,
      tool: m.name,
      description: m.description,
      score: m.score,
    })),
  };
};

// Multi-intent variant of find_tool. Halves the number of round-trips for
// tasks that chain N tools (e.g., "query Sentry then create a Linear issue"):
// the agent submits all intents in one call and gets back N independent
// results. Each result has the same shape as a single find_tool response.
const registryFindTools: HandlerFn = async (ctx, args) => {
  const intents = Array.isArray(args.intents) ? (args.intents as string[]).filter(Boolean) : [];
  if (intents.length === 0) throw new ValidationError('intents (string[]) is required');
  if (intents.length > 10) throw new ValidationError('max 10 intents per call');
  const limit = optNum(args.limit, 5);

  // Run sequentially so we share auto-activation across the batch (the second
  // intent's owning server may already be active from the first).
  const results = [];
  for (const intent of intents) {
    const matches = await ctx.registry.searchToolsHybrid(intent, limit);
    if (matches.length === 0) {
      results.push({ intent, found: false, hint: 'no tools matched' });
      continue;
    }
    const top = matches[0];
    const confidence = deriveConfidence(matches.map((m) => m.score));
    if (!ctx.proxy.isActive(top.server_name)) {
      const server = ctx.registry.getByName(top.server_name);
      if (
        server &&
        (server.command || server.transport === 'sse' || server.transport === 'streamable-http')
      ) {
        try {
          await ctx.proxy.activate({
            name: server.name,
            command: server.command ?? undefined,
            args: server.args,
            env: server.env,
            transport: server.transport,
            url: server.homepage ?? undefined,
          });
          ctx.registry.setActive(server.name, true);
        } catch {
          /* fall through */
        }
      }
    }
    const compact = compactSchema(top.input_schema);
    results.push({
      intent,
      found: true,
      confidence,
      score: top.score,
      call_as: `mcp__${top.server_name}__${top.name}`,
      tool: top.name,
      description: top.description,
      required_args: compact.required_args,
      optional_count: compact.optional_count,
      other_matches: matches.slice(1, 3).map((m) => ({
        call_as: `mcp__${m.server_name}__${m.name}`,
        tool: m.name,
        description: m.description,
        score: m.score,
      })),
    });
  }
  return { results };
};

// Invoke a proxied tool through agent-discover WITHOUT exposing it to the
// host's tool catalog. The agent calls find_tool first (with auto_activate:
// false), gets a call_as identifier, then uses proxy_call to invoke the tool
// indirectly. This keeps agent-discover at a constant 5-tool surface area
// regardless of how many tools its registered child servers actually expose
// — critical at large catalog sizes where firing notifications/tools/
// list_changed would flood the host with thousands of schemas.
const registryProxyCall: HandlerFn = async (ctx, args) => {
  const callAs = str(args.call_as);
  const directServer = str(args.server);
  const directTool = str(args.tool);
  const toolArgs =
    typeof args.arguments === 'object' && args.arguments !== null
      ? (args.arguments as Record<string, unknown>)
      : {};

  let serverName: string;
  let toolName: string;
  if (callAs) {
    const m = /^mcp__([^_]+(?:[^_]|_(?!_))*)__(.+)$/.exec(callAs);
    if (!m) {
      throw new ValidationError(
        `call_as must be of the form "mcp__<server>__<tool>" — got "${callAs}"`,
      );
    }
    serverName = m[1];
    toolName = m[2];
  } else if (directServer && directTool) {
    serverName = directServer;
    toolName = directTool;
  } else {
    throw new ValidationError('proxy_call requires either call_as or both server+tool');
  }

  // Auto-spin-up the server if it isn't connected yet (silent — no
  // list_changed notification, no host catalog reload). Mirrors the
  // find_tool({auto_activate:false}) path.
  if (!ctx.proxy.isActive(serverName)) {
    const server = ctx.registry.getByName(serverName);
    if (!server) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown server "${serverName}"` }],
      };
    }
    if (!server.command && server.transport !== 'sse' && server.transport !== 'streamable-http') {
      return {
        isError: true,
        content: [{ type: 'text', text: `server "${serverName}" has no command` }],
      };
    }
    try {
      await ctx.proxy.activate({
        name: server.name,
        command: server.command ?? undefined,
        args: server.args,
        env: server.env,
        transport: server.transport,
        url: server.homepage ?? undefined,
      });
    } catch (err) {
      return {
        isError: true,
        content: [
          { type: 'text', text: `failed to activate "${serverName}": ${(err as Error).message}` },
        ],
      };
    }
  }

  try {
    return await ctx.proxy.callTool(serverName, toolName, toolArgs);
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: `tool call failed: ${(err as Error).message}` }],
    };
  }
};

// Returns the full input_schema for a tool the agent already discovered via
// find_tool. Use this only when the compact required_args list isn't enough
// to invoke the tool (e.g., for tools with conditional or polymorphic args).
const registryGetSchema: HandlerFn = (ctx, args) => {
  const callAs = str(args.call_as) || str(args.name);
  if (!callAs) throw new ValidationError('call_as (or name) is required');

  // Accept both bare tool name and the namespaced "mcp__<server>__<tool>" form.
  const m = /^mcp__([^_]+(?:[^_]|_(?!_))*)__(.+)$/.exec(callAs);
  let serverName: string | null = null;
  let toolName: string;
  if (m) {
    serverName = m[1];
    toolName = m[2];
  } else {
    toolName = callAs;
  }

  // Cross-server lookup. If the agent only gave a bare tool name, scan for it.
  const matches = ctx.registry
    .searchTools(toolName, 5)
    .filter((t) => (serverName ? t.server_name === serverName : true) && t.name === toolName);

  if (matches.length === 0) {
    return { found: false, hint: `no tool named "${toolName}" — call find_tool first` };
  }
  const tool = matches[0];
  return {
    found: true,
    call_as: `mcp__${tool.server_name}__${tool.name}`,
    description: tool.description,
    input_schema: tool.input_schema,
  };
};

// ---------------------------------------------------------------------------
// Export handler map
// ---------------------------------------------------------------------------

export const toolHandlers: Record<string, HandlerFn> = {
  registry: handleRegistry,
};
