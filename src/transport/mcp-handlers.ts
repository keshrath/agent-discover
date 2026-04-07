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
    default:
      throw new ValidationError(
        `Unknown registry action: "${action}". Valid: list, install, uninstall, activate, deactivate, browse, status`,
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
// Export handler map
// ---------------------------------------------------------------------------

export const toolHandlers: Record<string, HandlerFn> = {
  registry: handleRegistry,
};
