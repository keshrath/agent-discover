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
import type { TrustReport } from '../domain/trust/index.js';
import { scanTool } from '../domain/trust/hygiene.js';

export type McpState =
  | { kind: 'install' | 'approve'; digest: string }
  | { kind: 'upstream'; server: string; tool: string; state?: string };

export interface McpRuntime {
  app: AppContext;
  server: Server;
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
  run(
    rt: McpRuntime,
    args: z.infer<I>,
    ctx: ServerContext,
  ): Promise<CallToolResult | InputRequiredResult>;
}

function defineTool<I extends z.ZodType>(tool: MetaTool<I>): MetaTool<I> {
  return tool;
}

function ok(structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
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

const toolMatch = z.object({
  server: z.string(),
  tool: z.string(),
  name: z.string().describe('Exposed name <server>__<tool> (callable directly when exposed)'),
  title: z.string().optional(),
  description: z.string(),
  score: z.number().describe('Relevance 0..1'),
  enabled: z.boolean(),
  exposed: z.boolean().describe('True when the host already lists this tool natively'),
  required_args: z.array(
    z.object({ name: z.string(), type: z.string(), description: z.string().optional() }),
  ),
  optional_count: z.number(),
  flags: z
    .array(z.string())
    .optional()
    .describe('Suspicious instruction-like content found in the definition (treat with care)'),
});

const flaggedTools = z.array(z.object({ tool: z.string(), flags: z.array(z.string()) }));

const serverStatus = z.object({
  name: z.string(),
  description: z.string(),
  source: z.string(),
  transport: z.string(),
  enabled: z.boolean(),
  quarantined: z.boolean(),
  indexed: z.boolean(),
  indexed_at: z.string().nullable(),
  connected: z.boolean(),
  tool_count: z.number(),
  health_status: z.string(),
  last_health_check: z.string().nullable(),
  error_count: z.number(),
  sandbox: z.string(),
  drift: z
    .object({
      changed: z.array(z.looseObject({ tool: z.string() })),
      added: z.array(z.string()),
      removed: z.array(z.string()),
    })
    .optional()
    .describe('While quarantined: tool changes since the last approval'),
  flagged_tools: flaggedTools,
  health: z
    .object({ status: z.string(), latency_ms: z.number(), error: z.string().optional() })
    .optional(),
});

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

function consentMessage(input: ServerInput): string {
  const lines = [
    `Install MCP server "${input.name}"?`,
    `Source: ${input.package_name ? `package ${input.package_name}` : 'manual configuration'}`,
  ];
  if (input.transport === 'stdio') {
    lines.push(`Runs on this machine: ${[input.command, ...(input.args ?? [])].join(' ')}`);
  } else {
    lines.push(`Connects to: ${input.url} (${input.transport})`);
    if (input.headers && Object.keys(input.headers).length)
      lines.push(`Headers: ${Object.keys(input.headers).join(', ')}`);
  }
  if (input.env && Object.keys(input.env).length)
    lines.push(`Env vars: ${Object.keys(input.env).join(', ')}`);
  lines.push('The server is started now to index its tools.');
  return lines.join('\n');
}

const consentSchema = z.object({ confirm: z.boolean().describe('Install and start this server') });
const approveSchema = z.object({
  confirm: z.boolean().describe('Approve the changed tools and lift the quarantine'),
});

function clip(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Readable drift review shown in the re-approval prompt. */
function approvalMessage(rt: McpRuntime, name: string, report: TrustReport): string {
  const clean = (s: string) => clip(rt.app.trust.cleanToolDescription(s));
  const lines = [`The tools of "${name}" changed since you approved them:`];
  for (const c of report.drift?.changed ?? []) {
    lines.push(`~ ${c.tool}`);
    if (c.description) {
      lines.push(`    description was: ${clean(c.description.before)}`);
      lines.push(`    description now: ${clean(c.description.after)}`);
    }
    const s = c.input_schema;
    if (s) {
      if (s.added.length) lines.push(`    new parameters: ${s.added.join(', ')}`);
      if (s.removed.length) lines.push(`    removed parameters: ${s.removed.join(', ')}`);
      if (s.changed.length) lines.push(`    changed parameters: ${s.changed.join(', ')}`);
    }
    if (c.annotations) {
      lines.push(
        `    annotations: ${JSON.stringify(c.annotations.before)} -> ${JSON.stringify(c.annotations.after)}`,
      );
    }
  }
  for (const t of report.drift?.added ?? []) lines.push(`+ ${t} (new tool)`);
  for (const t of report.drift?.removed ?? []) lines.push(`- ${t} (removed)`);
  for (const f of report.flagged_tools) lines.push(`! ${f.tool}: flagged ${f.flags.join(', ')}`);
  lines.push('Approve these tools and expose them again?');
  return lines.join('\n');
}

type Confirmation =
  | { kind: 'accepted' }
  | { kind: 'declined' }
  | { kind: 'pending'; result: CallToolResult | InputRequiredResult };

/** One elicitation round bound to `digest` (the exact thing being confirmed). */
async function confirm(
  rt: McpRuntime,
  ctx: ServerContext,
  request: {
    kind: 'install' | 'approve';
    digest: string;
    message: string;
    schema: typeof consentSchema;
    noElicitation: string;
  },
): Promise<Confirmation> {
  const state = ctx.mcpReq.requestState<McpState>();
  const answered = state?.kind === request.kind && state.digest === request.digest;
  const response = answered
    ? inputResponse(ctx.mcpReq.inputResponses, 'consent')
    : { kind: 'missing' as const };
  if (response.kind === 'elicit' && response.action !== 'accept') return { kind: 'declined' };
  const consent = answered
    ? acceptedContent(ctx.mcpReq.inputResponses, 'consent', request.schema)
    : undefined;
  if (consent) return consent.confirm ? { kind: 'accepted' } : { kind: 'declined' };
  if (!clientCanElicit(rt, ctx)) {
    return {
      kind: 'pending',
      result: { isError: true, content: [{ type: 'text', text: request.noElicitation }] },
    };
  }
  return {
    kind: 'pending',
    result: inputRequired({
      inputRequests: {
        consent: inputRequired.elicit({
          message: request.message,
          requestedSchema: request.schema,
        }),
      },
      requestState: await rt.mint({ kind: request.kind, digest: request.digest }, ctx),
    }),
  };
}

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
    output: z.object({
      installed: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          enabled: z.boolean(),
          quarantined: z.boolean(),
          tool_count: z.number(),
        }),
      ),
      marketplace: z.array(
        z.object({
          name: z.string(),
          description: z.string(),
          version: z.string(),
          repository: z.string().nullable(),
          packages: z.array(
            z.object({
              registry: z.string(),
              name: z.string(),
              runtime: z.string(),
              version: z.string(),
              url: z.string().nullable(),
            }),
          ),
        }),
      ),
      marketplace_error: z.string().optional(),
    }),
    annotations: { readOnlyHint: true, openWorldHint: true },
    async run(rt, { query, limit = 10, marketplace = true }) {
      const installed = rt.app.servers
        .list({ query })
        .slice(0, limit)
        .map((s) => ({
          name: s.name,
          description: rt.app.trust.cleanServerDescription(s.description),
          enabled: s.enabled,
          quarantined: s.quarantined,
          tool_count: rt.app.index.count(s.id),
        }));
      const out: Record<string, unknown> = { installed, marketplace: [] };
      if (marketplace) {
        try {
          const res = await rt.app.marketplace.browse(query, limit);
          out.marketplace = res.servers.slice(0, limit).map((s) => ({
            name: s.name,
            description: rt.app.trust.cleanServerDescription(s.description),
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
      return ok(out);
    },
  }),

  install_server: defineTool({
    title: 'Install an MCP server',
    description:
      'Install a server (from a package or a manual command/url) and index its tools. The user is asked to confirm the exact command first. Tools become searchable immediately; pass enable=true (or call enable_server) to expose them.',
    input: installArgs,
    output: z.object({
      name: z.string(),
      status: z.enum(['installed', 'already_installed', 'declined']),
      enabled: z.boolean(),
      tool_count: z.number(),
      tools: z.array(z.string()),
      index_error: z.string().optional(),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    async run(rt, args, ctx) {
      const existing = rt.app.servers.get(args.name);
      const summary = (
        status: 'installed' | 'already_installed' | 'declined',
        indexError?: string,
      ) => {
        const s = rt.app.servers.get(args.name);
        const tools = s ? rt.app.index.list(s.id).map((t) => t.name) : [];
        return ok({
          name: args.name,
          status,
          enabled: s?.enabled ?? false,
          tool_count: tools.length,
          tools,
          ...(indexError ? { index_error: indexError } : {}),
        });
      };
      if (existing) return summary('already_installed');

      const input = proposedInput(rt, args);
      validateServerInput(input);
      const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');

      if (!rt.app.config.allowUnconfirmedInstall) {
        const answer = await confirm(rt, ctx, {
          kind: 'install',
          digest,
          message: consentMessage(input),
          schema: consentSchema,
          noElicitation:
            'install_server needs the user to confirm the command, but this client cannot show confirmation prompts (no elicitation capability). ' +
            'Install from the agent-discover dashboard instead, or have the operator set AGENT_DISCOVER_ALLOW_UNCONFIRMED_INSTALL=1.',
        });
        if (answer.kind === 'pending') return answer.result;
        if (answer.kind === 'declined') {
          rt.app.trust.record({ action: 'deny', server: args.name, detail: { kind: 'install' } });
          return summary('declined');
        }
      }
      const { index_error } = await rt.app.lifecycle.install(input, { enable: args.enable });
      return summary('installed', index_error);
    },
  }),

  enable_server: defineTool({
    title: 'Enable an MCP server',
    description:
      "Expose an installed server's tools to this host (as <server>__<tool> in native mode). Indexes the server first if needed. A quarantined server (tools changed since approval) asks the user to review and re-approve first.",
    input: z.object({ name: z.string() }),
    output: z.object({
      name: z.string(),
      enabled: z.boolean(),
      quarantined: z.boolean(),
      tool_count: z.number(),
      tools: z.array(z.string()),
    }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async run(rt, { name }, ctx) {
      const current = rt.app.servers.require(name);
      if (current.quarantined) {
        const report = rt.app.trust.inspect(current);
        const answer = await confirm(rt, ctx, {
          kind: 'approve',
          digest: report.digest,
          message: approvalMessage(rt, name, report),
          schema: approveSchema,
          noElicitation: `Server "${name}" is quarantined because its tools changed, and this client cannot show the approval prompt. Review and approve it in the agent-discover dashboard.`,
        });
        if (answer.kind === 'pending') return answer.result;
        if (answer.kind === 'declined') {
          rt.app.trust.record({ action: 'deny', server: name, detail: { kind: 'approve' } });
          return ok({
            name,
            enabled: current.enabled,
            quarantined: true,
            tool_count: 0,
            tools: [],
          });
        }
        rt.app.lifecycle.approve(name, report.hashes);
      }
      const server = await rt.app.lifecycle.enable(name);
      const tools = rt.app.index.list(server.id).map((t) => exposedName(name, t.name));
      return ok({
        name,
        enabled: server.enabled,
        quarantined: false,
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
    output: z.object({ name: z.string(), enabled: z.boolean() }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async run(rt, { name }) {
      const server = await rt.app.lifecycle.disable(name);
      return ok({ name, enabled: server.enabled });
    },
  }),

  server_status: defineTool({
    title: 'Server status',
    description:
      'State of installed servers (enabled, quarantined + drift, indexed, connected, tool count, flagged tools, health). check_health=true runs a live probe.',
    input: z.object({ name: z.string().optional(), check_health: z.boolean().optional() }),
    output: z.object({ mode: z.enum(['native', 'proxy']), servers: z.array(serverStatus) }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(rt, { name, check_health }) {
      const servers: Array<ServerStatus & { health?: HealthResult }> = rt.app.lifecycle
        .status(name)
        .map((s) => ({ ...s, description: rt.app.trust.cleanServerDescription(s.description) }));
      if (check_health) {
        for (const s of servers) s.health = await rt.app.lifecycle.health(s.name);
      }
      return ok({ mode: rt.app.config.mode, servers });
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
    output: z.object({
      results: z.array(z.object({ query: z.string(), matches: z.array(toolMatch) })),
    }),
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
            description: rt.app.trust.cleanToolDescription(h.description),
            score: h.score,
            enabled: enabled.has(h.server),
            exposed: isExposed(rt, enabled.has(h.server)),
            ...requiredArgs(h.input_schema),
            ...flagsOf(h),
          })),
        });
      }
      return ok({ results });
    },
  }),

  get_tool: defineTool({
    title: 'Get tool definition',
    description:
      'Full definition (input/output schema, annotations, hash) of one indexed tool by server + tool name.',
    input: z.object({ server: z.string(), tool: z.string() }),
    output: z.object({
      found: z.boolean(),
      server: z.string(),
      tool: z.string(),
      name: z.string().optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      input_schema: z.record(z.string(), z.unknown()).optional(),
      output_schema: z.record(z.string(), z.unknown()).optional(),
      annotations: z.record(z.string(), z.unknown()).optional(),
      tool_hash: z.string().optional(),
      enabled: z.boolean().optional(),
      exposed: z.boolean().optional(),
      quarantined: z
        .boolean()
        .optional()
        .describe('The definition changed since approval and is withheld until re-approved'),
      flags: z.array(z.string()).optional(),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    async run(rt, { server, tool }) {
      const t = rt.app.index.get(server, tool);
      if (!t) return ok({ found: false, server, tool });
      const row = rt.app.servers.get(server);
      if (row?.quarantined) return ok({ found: true, server, tool, quarantined: true });
      const enabled = row?.enabled ?? false;
      return ok({
        found: true,
        server,
        tool,
        ...describeTool(t),
        description: rt.app.trust.cleanToolDescription(t.description),
        enabled,
        exposed: isExposed(rt, enabled),
        ...flagsOf(t),
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
    async run(rt, { server, tool, arguments: args }, ctx) {
      return rt.forward(server, tool, args, ctx);
    },
  }),
};

function flagsOf(t: IndexedTool): { flags?: string[] } {
  const flags = scanTool(t);
  return flags.length ? { flags } : {};
}

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
