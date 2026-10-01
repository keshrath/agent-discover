// =============================================================================
// agent-discover — MCP meta tools
//
// The stable tool surface (SPEC §3). Schemas are authored in zod and
// advertised as JSON Schema; every tool except call_tool declares an
// outputSchema and returns matching structuredContent. call_tool is a
// verbatim passthrough of the upstream CallToolResult, so it cannot promise
// a shape.
// =============================================================================

import { createHash } from 'node:crypto';
import * as z from 'zod';
import {
  CLIENT_CAPABILITIES_META_KEY,
  acceptedContent,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type InputRequiredResult,
  type Server,
  type ServerContext,
  type Tool,
  type ToolAnnotations,
} from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import type { ServerInput } from '../types.js';
import { validateServerInput } from '../domain/servers.js';
import type { ServerStatus } from '../domain/lifecycle.js';
import type { HealthResult } from '../domain/pool.js';
import type { IndexedTool } from '../types.js';
import { OUTPUTS, type InstallPlan, type Outputs } from '../widgets/types.js';
import { installPlanText, resultText } from '../widgets/text.js';
import { DASHBOARD_META_KEY, WIDGET_META, WIDGET_TOOLS } from '../widgets/resources.js';

export type McpState =
  | { kind: 'install'; digest: string }
  | { kind: 'upstream'; server: string; tool: string; state?: string };

export interface McpRuntime {
  app: AppContext;
  server: Server;
  /** Dashboard origin (http://host:port) for deep links in results. */
  dashboard: string;
  mint(state: McpState, ctx: ServerContext): Promise<string>;
  /** Forward a call to an upstream tool, relaying MRTR rounds. */
  forward(
    server: string,
    tool: string,
    args: Record<string, unknown> | undefined,
    ctx: ServerContext,
  ): Promise<CallToolResult | InputRequiredResult>;
}

interface MetaTool<I extends z.ZodType> {
  title: string;
  description: string;
  input: I;
  output?: z.ZodType;
  annotations: ToolAnnotations;
  /** Host hints beyond the widget link (Claude Code honors the anthropic/* keys). */
  meta?: Record<string, unknown>;
  run(
    rt: McpRuntime,
    args: z.infer<I>,
    ctx: ServerContext,
  ): Promise<CallToolResult | InputRequiredResult>;
}

function defineTool<I extends z.ZodType>(tool: MetaTool<I>): MetaTool<I> {
  return tool;
}

/** A meta tool result: structuredContent plus its markdown rendering for text-only hosts. */
function ok<K extends keyof Outputs>(
  rt: McpRuntime,
  tool: K,
  structured: Outputs[K],
  isError = false,
): CallToolResult {
  return {
    content: [{ type: 'text', text: resultText(tool, structured, { dashboard: rt.dashboard }) }],
    structuredContent: structured,
    _meta: { [DASHBOARD_META_KEY]: rt.dashboard },
    ...(isError ? { isError } : {}),
  };
}

/** The name a native-mode host sees for an upstream tool. */
export function exposedName(server: string, tool: string): string {
  return `${server}__${tool}`;
}

function requiredArgs(schema: Record<string, unknown>) {
  const props = (schema.properties ?? {}) as Record<
    string,
    { type?: unknown; description?: string }
  >;
  const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  return {
    required_args: required.map((name) => ({
      name,
      type: typeof props[name]?.type === 'string' ? (props[name].type as string) : 'unknown',
      ...(props[name]?.description ? { description: props[name].description } : {}),
    })),
    optional_count: Math.max(0, Object.keys(props).length - required.length),
  };
}

function isExposed(rt: McpRuntime, enabled: boolean): boolean {
  return enabled && rt.app.config.mode === 'native';
}

function clientCanElicit(rt: McpRuntime, ctx: ServerContext): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const caps = (envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? rt.server.getClientCapabilities()) as
    | { elicitation?: unknown }
    | undefined;
  return Boolean(caps?.elicitation);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const transportEnum = z.enum(['stdio', 'sse', 'streamable-http']);
const stringMap = z.record(z.string(), z.string());

const installArgs = z.object({
  name: z.string().describe('Local name for the server (letters, digits, . _ -)'),
  package: z
    .string()
    .optional()
    .describe('Package identifier; derives command/args from `runtime` (npx / uvx / docker)'),
  runtime: z.enum(['node', 'python', 'docker']).optional(),
  transport: transportEnum.optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: stringMap.optional(),
  url: z.string().optional().describe('Endpoint for sse / streamable-http servers'),
  headers: stringMap.optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  enable: z.boolean().optional().describe('Enable (expose) the server right after install'),
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function proposedInput(rt: McpRuntime, a: z.infer<typeof installArgs>): ServerInput {
  const base: ServerInput = {
    name: a.name,
    description: a.description,
    tags: a.tags,
    env: a.env,
    headers: a.headers,
    source: a.package ? 'registry' : 'manual',
  };
  if (a.package) {
    const cfg = rt.app.installer.detectInstallConfig(a.package, a.runtime);
    return {
      ...base,
      transport: 'stdio',
      command: cfg.command,
      args: cfg.args,
      package_name: cfg.package_name,
    };
  }
  return {
    ...base,
    transport: a.transport ?? (a.url ? 'streamable-http' : 'stdio'),
    command: a.command,
    args: a.args,
    url: a.url,
  };
}

/** An exact npm version (`pkg@1.2.3`); other package specs cannot carry a version yet. */
const PINNED = /^(@[^/@]+\/)?[^@]+@\d+\.\d+\.\d+[\w.+-]*$/;

function installPlan(input: ServerInput): InstallPlan {
  const pkg = input.package_name;
  return {
    name: input.name,
    transport: input.transport ?? 'stdio',
    ...(input.transport === 'stdio'
      ? { command: input.command, args: input.args ?? [] }
      : { url: input.url }),
    ...(pkg ? { package: pkg } : {}),
    env_keys: Object.keys(input.env ?? {}),
    header_keys: Object.keys(input.headers ?? {}),
    provenance: pkg
      ? [
          { label: `Package ${pkg}`, level: 'info' },
          PINNED.test(pkg)
            ? { label: 'Version pinned', level: 'ok' }
            : { label: 'Unpinned version', level: 'warn', detail: 'resolves to latest at start' },
        ]
      : [{ label: 'Manual configuration', level: 'warn', detail: 'not from a registry' }],
  };
}

const consentSchema = z.object({ confirm: z.boolean().describe('Install and start this server') });

export const META_TOOLS = {
  search_servers: defineTool({
    title: 'Search MCP servers',
    description:
      'Find MCP servers: installed ones (local registry) and, unless marketplace=false, the public MCP registry plus npm/PyPI. Use before install_server.',
    input: z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
      marketplace: z
        .boolean()
        .optional()
        .describe('Also search the public registries (default true)'),
    }),
    output: OUTPUTS.search_servers,
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(rt, { query, limit = 10, marketplace = true }) {
      const installed = rt.app.servers
        .list({ query })
        .slice(0, limit)
        .map((s) => ({
          name: s.name,
          description: s.description,
          enabled: s.enabled,
          tool_count: rt.app.index.count(s.id),
        }));
      const out: Outputs['search_servers'] = { query, installed, marketplace: [] };
      if (marketplace) {
        try {
          const res = await rt.app.marketplace.browse(query, limit);
          out.marketplace = res.servers.slice(0, limit).map((s) => ({
            name: s.name,
            description: s.description,
            version: s.version,
            repository: s.repository,
            packages: s.packages.map((p) => ({
              registry: p.registry_name,
              name: p.name,
              runtime: p.runtime,
              version: p.version,
              url: p.url,
            })),
          }));
        } catch (err) {
          out.marketplace_error = err instanceof Error ? err.message : String(err);
        }
      }
      return ok(rt, 'search_servers', out);
    },
  }),

  install_server: defineTool({
    title: 'Install an MCP server',
    description:
      'Install a server (from a package or a manual command/url) and index its tools. The user is asked to confirm the exact command first. Tools become searchable immediately; pass enable=true (or call enable_server) to expose them.',
    input: installArgs,
    output: OUTPUTS.install_server,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    // Claude Code shows its permission prompt on every call, even in bypass/auto mode.
    meta: { 'anthropic/requiresUserInteraction': true },
    async run(rt, args, ctx) {
      const existing = rt.app.servers.get(args.name);
      const summary = (
        status: Outputs['install_server']['status'],
        plan?: InstallPlan,
        indexError?: string,
      ) => {
        const s = rt.app.servers.get(args.name);
        const tools = s ? rt.app.index.list(s.id).map((t) => t.name) : [];
        return ok(
          rt,
          'install_server',
          {
            name: args.name,
            status,
            enabled: s?.enabled ?? false,
            tool_count: tools.length,
            tools,
            ...(indexError ? { index_error: indexError } : {}),
            ...(plan ? { plan } : {}),
          },
          status === 'consent_required',
        );
      };
      if (existing) return summary('already_installed');

      const input = proposedInput(rt, args);
      validateServerInput(input);
      const plan = installPlan(input);
      const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');

      if (!rt.app.config.allowUnconfirmedInstall) {
        const state = ctx.mcpReq.requestState<McpState>();
        const answered = state?.kind === 'install' && state.digest === digest;
        const response = answered
          ? inputResponse(ctx.mcpReq.inputResponses, 'consent')
          : { kind: 'missing' as const };
        if (response.kind === 'elicit' && response.action !== 'accept')
          return summary('declined', plan);
        const consent = answered
          ? acceptedContent(ctx.mcpReq.inputResponses, 'consent', consentSchema)
          : undefined;
        if (consent && !consent.confirm) return summary('declined', plan);
        if (!consent) {
          if (!clientCanElicit(rt, ctx)) return summary('consent_required', plan);
          return inputRequired({
            inputRequests: {
              consent: inputRequired.elicit({
                message: installPlanText(plan),
                requestedSchema: consentSchema,
              }),
            },
            requestState: await rt.mint({ kind: 'install', digest }, ctx),
          });
        }
      }
      const { index_error } = await rt.app.lifecycle.install(input, { enable: args.enable });
      return summary('installed', plan, index_error);
    },
  }),

  enable_server: defineTool({
    title: 'Enable an MCP server',
    description:
      "Expose an installed server's tools to this host (as <server>__<tool> in native mode). Indexes the server first if needed.",
    input: z.object({ name: z.string() }),
    output: OUTPUTS.enable_server,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async run(rt, { name }) {
      const server = await rt.app.lifecycle.enable(name);
      const tools = rt.app.index.list(server.id).map((t) => exposedName(name, t.name));
      return ok(rt, 'enable_server', {
        name,
        enabled: server.enabled,
        tool_count: tools.length,
        tools,
      });
    },
  }),

  disable_server: defineTool({
    title: 'Disable an MCP server',
    description:
      "Stop exposing a server's tools. The server stays installed and its tools stay searchable.",
    input: z.object({ name: z.string() }),
    output: OUTPUTS.disable_server,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async run(rt, { name }) {
      const server = await rt.app.lifecycle.disable(name);
      return ok(rt, 'disable_server', { name, enabled: server.enabled });
    },
  }),

  server_status: defineTool({
    title: 'Server status',
    description:
      'State of installed servers (enabled, indexed, connected, tool count, health). check_health=true runs a live probe.',
    input: z.object({ name: z.string().optional(), check_health: z.boolean().optional() }),
    output: OUTPUTS.server_status,
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(rt, { name, check_health }) {
      const servers: Array<ServerStatus & { health?: HealthResult }> =
        rt.app.lifecycle.status(name);
      if (check_health) {
        for (const s of servers) s.health = await rt.app.lifecycle.health(s.name);
      }
      return ok(rt, 'server_status', { mode: rt.app.config.mode, servers });
    },
  }),

  search_tools: defineTool({
    title: 'Search tools',
    description:
      'Search the tool index of ALL installed servers (enabled or not) — one entry per query, batch several needs in one call. Exposed tools can be called directly; others via call_tool or after enable_server.',
    input: z.object({
      queries: z.array(z.string().min(1)).min(1).max(10),
      limit: z.number().int().min(1).max(20).optional(),
    }),
    output: OUTPUTS.search_tools,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async run(rt, { queries, limit = 5 }) {
      const enabled = new Set(rt.app.servers.enabledNames());
      const results = [];
      for (const query of queries) {
        const hits = await rt.app.index.search(query, limit);
        results.push({
          query,
          matches: hits.map((h) => ({
            server: h.server,
            tool: h.name,
            name: exposedName(h.server, h.name),
            ...(h.title ? { title: h.title } : {}),
            description: h.description,
            score: h.score,
            enabled: enabled.has(h.server),
            exposed: isExposed(rt, enabled.has(h.server)),
            ...requiredArgs(h.input_schema),
          })),
        });
      }
      return ok(rt, 'search_tools', { results });
    },
  }),

  get_tool: defineTool({
    title: 'Get tool definition',
    description:
      'Full definition (input/output schema, annotations, hash) of one indexed tool by server + tool name.',
    input: z.object({ server: z.string(), tool: z.string() }),
    output: OUTPUTS.get_tool,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    meta: { 'anthropic/maxResultSizeChars': 200_000 },
    async run(rt, { server, tool }) {
      const t = rt.app.index.get(server, tool);
      if (!t) return ok(rt, 'get_tool', { found: false, server, tool });
      const enabled = rt.app.servers.get(server)?.enabled ?? false;
      return ok(rt, 'get_tool', {
        found: true,
        server,
        tool,
        ...describeTool(t),
        enabled,
        exposed: isExposed(rt, enabled),
      });
    },
  }),

  call_tool: defineTool({
    title: 'Call a tool',
    description:
      'Invoke any indexed tool of an installed server (enabled or not) and return its result unchanged. Prefer calling exposed tools directly.',
    input: z.object({
      server: z.string(),
      tool: z.string(),
      arguments: z.record(z.string(), z.unknown()).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    meta: { 'anthropic/maxResultSizeChars': 200_000 },
    async run(rt, { server, tool, arguments: args }, ctx) {
      return rt.forward(server, tool, args, ctx);
    },
  }),
};

function describeTool(t: IndexedTool) {
  return {
    name: exposedName(t.server, t.name),
    ...(t.title ? { title: t.title } : {}),
    description: t.description,
    input_schema: t.input_schema,
    ...(t.output_schema ? { output_schema: t.output_schema } : {}),
    ...(t.annotations ? { annotations: t.annotations } : {}),
    tool_hash: t.tool_hash,
  };
}

export type MetaToolName = keyof typeof META_TOOLS;

function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): Tool['inputSchema'] {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { io }) as Record<string, unknown>;
  void _ignored;
  return rest as Tool['inputSchema'];
}

/** Advertised definitions of the meta tools. */
export const META_TOOL_DEFS: Tool[] = Object.entries(META_TOOLS).map(([name, t]) => ({
  name,
  title: t.title,
  description: t.description,
  inputSchema: jsonSchema(t.input, 'input'),
  ...(t.output ? { outputSchema: jsonSchema(t.output, 'output') } : {}),
  annotations: { title: t.title, ...t.annotations },
  ...(WIDGET_TOOLS.has(name) || t.meta
    ? { _meta: { ...(WIDGET_TOOLS.has(name) ? WIDGET_META : {}), ...t.meta } }
    : {}),
}));

/** Run a meta tool: validate input, map domain errors to isError results. */
export async function runMetaTool(
  rt: McpRuntime,
  name: MetaToolName,
  rawArgs: unknown,
  ctx: ServerContext,
): Promise<CallToolResult | InputRequiredResult> {
  const tool = META_TOOLS[name] as MetaTool<z.ZodType>;
  const parsed = tool.input.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return {
      isError: true,
      content: [
        { type: 'text', text: `Invalid arguments for ${name}: ${z.prettifyError(parsed.error)}` },
      ],
    };
  }
  try {
    return await tool.run(rt, parsed.data, ctx);
  } catch (err) {
    if (err instanceof Error) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
    throw err;
  }
}
