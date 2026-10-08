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
import { validateServerInput } from '../domain/servers.js';
import { LOADER_ENV, manualPlan, type InstallPlan } from '../domain/install-plan.js';
import { ValidationError } from '../types.js';
import type { ServerStatus } from '../domain/lifecycle.js';
import type { HealthResult } from '../domain/pool.js';
import type { IndexedTool } from '../types.js';
import type { TrustReport } from '../domain/trust/index.js';
import { scanTool } from '../domain/trust/hygiene.js';
import { OUTPUTS, type InstallPlan as PlanView, type Outputs } from '../widgets/types.js';
import { installPlanText, resultText } from '../widgets/text.js';
import { WIDGET_META, WIDGET_TOOLS } from '../widgets/resources.js';

export type McpState =
  | { kind: 'install' | 'approve'; digest: string }
  | { kind: 'upstream'; server: string; tool: string; state?: string }
  /** An upstream call parked on a pushed elicitation/create (2025 upstream). */
  | { kind: 'parked'; id: string }
  /** The upstream needs OAuth sign-in; the client was handed the authorization URL. */
  | { kind: 'auth'; server: string; tool: string };

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
  tool: K,
  structured: Outputs[K],
  isError = false,
): CallToolResult {
  return {
    content: [{ type: 'text', text: resultText(tool, structured) }],
    structuredContent: structured,
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

/** Whether the downstream client accepts elicitation (`url` mode needs `elicitation.url`). */
export function clientCanElicit(
  server: Server,
  ctx: ServerContext,
  mode: 'form' | 'url' = 'form',
): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const caps = (envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? server.getClientCapabilities()) as
    | { elicitation?: { url?: unknown } }
    | undefined;
  return mode === 'url' ? Boolean(caps?.elicitation?.url) : Boolean(caps?.elicitation);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const transportEnum = z.enum(['stdio', 'sse', 'streamable-http']);
const stringMap = z.record(z.string(), z.string());

const installArgs = z.object({
  server: z
    .string()
    .optional()
    .describe(
      'Exact name from search_servers: MCP Registry name (io.github.org/server), npm package or PyPI project. Omit for a manual command/url.',
    ),
  source: z
    .enum(['registry', 'npm', 'pypi'])
    .optional()
    .describe('Where `server` comes from (default registry)'),
  version: z.string().optional().describe('Exact version to install (default: latest)'),
  name: z
    .string()
    .optional()
    .describe('Local name (letters, digits, . _ -); default derived from `server`'),
  transport: transportEnum
    .optional()
    .describe('Pick a remote (streamable-http/sse) over a package, or the manual transport'),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: stringMap.optional().describe('Manual install only (registry secrets are set by the user)'),
  url: z.string().optional().describe('Endpoint for manual sse / streamable-http servers'),
  headers: stringMap.optional().describe('Manual install only'),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  enable: z.boolean().optional().describe('Enable (expose) the server right after install'),
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

async function proposedPlan(rt: McpRuntime, a: z.infer<typeof installArgs>): Promise<InstallPlan> {
  if (a.server) {
    if (a.env || a.headers) {
      throw new ValidationError(
        'env and headers apply only to a manual install; the user sets the secrets of a registry/npm/PyPI server in /discover',
      );
    }
    const server = a.name ? rt.app.servers.get(a.name) : null;
    return rt.app.marketplace.plan({
      source: a.source,
      name: a.server,
      version: a.version,
      local_name: a.name,
      transport: a.transport,
      storedSecrets: server ? Object.keys(rt.app.secrets.getEnvForServer(server)) : [],
    });
  }
  if (!a.name) throw new ValidationError('name is required for a manual install');
  return manualPlan({
    name: a.name,
    description: a.description,
    tags: a.tags,
    env: a.env,
    headers: a.headers,
    source: 'manual',
    transport: a.transport ?? (a.url ? 'streamable-http' : 'stdio'),
    command: a.command,
    args: a.args,
    url: a.url,
  });
}

/** Presentation view of a domain InstallPlan for the consent prompt, widget and markdown. */
function planView(plan: InstallPlan): PlanView {
  const p = plan.provenance;
  const facts: PlanView['provenance'] = [];
  if (p.registry) {
    facts.push({
      label: `Registry: ${p.registry.name}`,
      level: p.registry.status === 'active' ? 'ok' : 'warn',
      detail: `${p.registry.status}, publisher ${p.registry.publisher}`,
    });
  } else if (plan.source === 'manual') {
    facts.push({ label: 'Manual configuration', level: 'warn', detail: 'not from a registry' });
  }
  if (p.package) {
    const v = p.package.version;
    facts.push({
      label: `${p.package.ecosystem} ${p.package.name}${v ? `@${v}` : ''}`,
      level: 'info',
    });
  }
  facts.push(
    p.pinned
      ? { label: 'Version pinned', level: 'ok' }
      : { label: 'Unpinned version', level: 'warn', detail: 'resolves to latest at start' },
  );
  for (const c of p.checks) {
    facts.push({
      label: c.id,
      level: c.status === 'pass' ? 'ok' : c.status === 'skipped' ? 'info' : 'warn',
      detail: c.detail,
    });
  }
  for (const w of plan.warnings) facts.push({ label: 'Warning', level: 'warn', detail: w });
  const loaderEnv = Object.entries(plan.input.env ?? {}).filter(
    ([k, v]) => v !== '' && LOADER_ENV.test(k),
  );
  return {
    name: plan.server,
    transport: plan.transport,
    ...(plan.command ? { command: plan.command, args: plan.args ?? [] } : {}),
    ...(plan.url ? { url: plan.url } : {}),
    ...(p.package ? { package: p.package.name } : {}),
    ...(p.repository ? { repository: p.repository } : {}),
    env_keys: plan.requirements.filter((r) => r.kind === 'env').map((r) => r.key),
    ...(loaderEnv.length ? { loader_env: Object.fromEntries(loaderEnv) } : {}),
    header_keys: plan.requirements.filter((r) => r.kind === 'header').map((r) => r.key),
    provenance: facts,
  };
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
    noElicitation: () => CallToolResult;
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
  if (!clientCanElicit(rt.server, ctx)) {
    return { kind: 'pending', result: request.noElicitation() };
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
    output: OUTPUTS.search_servers,
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
      const out: Outputs['search_servers'] = { query, installed, marketplace: [] };
      if (marketplace) {
        const res = await rt.app.marketplace.search(query, limit);
        out.marketplace = res.servers.map((m) => ({
          ...m,
          description: rt.app.trust.cleanServerDescription(m.description),
        }));
        if (Object.keys(res.errors).length) out.marketplace_errors = res.errors;
      }
      return ok('search_servers', out);
    },
  }),

  install_server: defineTool({
    title: 'Install an MCP server',
    description:
      'Install a server found by search_servers (exact `server` name; version pinned) or from a manual command/url, then index its tools. The user confirms the exact command and provenance first. Tools become searchable immediately; pass enable=true (or call enable_server) to expose them.',
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
      const plan = await proposedPlan(rt, args);
      const view = planView(plan);
      const missing = plan.requirements.filter((r) => r.required && !r.present).map((r) => r.key);
      const summary = (status: Outputs['install_server']['status'], indexError?: string) => {
        const s = rt.app.servers.get(plan.server);
        const tools = s ? rt.app.index.list(s.id).map((t) => t.name) : [];
        return ok(
          'install_server',
          {
            name: plan.server,
            status,
            enabled: s?.enabled ?? false,
            tool_count: tools.length,
            tools,
            ...(indexError ? { index_error: indexError } : {}),
            ...(missing.length ? { missing } : {}),
            plan: view,
          },
          status === 'consent_required',
        );
      };
      const existing = rt.app.servers.get(plan.server);
      if (existing) {
        const same = plan.input.registry_name
          ? existing.registry_name === plan.input.registry_name
          : existing.package_name === (plan.input.package_name ?? null);
        if (same) return summary('already_installed');
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `"${plan.server}" is already installed from ${existing.registry_name ?? existing.package_name ?? existing.source}; pass \`name\` to install this server under another local name`,
            },
          ],
        };
      }
      if (plan.blocked) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Cannot install: ${plan.blocked}` }],
        };
      }
      const input = plan.input;
      validateServerInput(input);
      const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');

      if (!rt.app.config.allowUnconfirmedInstall) {
        const answer = await confirm(rt, ctx, {
          kind: 'install',
          digest,
          message: installPlanText(view),
          schema: consentSchema,
          noElicitation: () => summary('consent_required'),
        });
        if (answer.kind === 'pending') return answer.result;
        if (answer.kind === 'declined') {
          rt.app.trust.record({ action: 'deny', server: plan.server, detail: { kind: 'install' } });
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
    output: OUTPUTS.enable_server,
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
          noElicitation: () => ({
            isError: true,
            content: [
              {
                type: 'text',
                text: `Server "${name}" is quarantined because its tools changed, and this client cannot show the approval prompt. Review and approve it in Claude Code with /discover.`,
              },
            ],
          }),
        });
        if (answer.kind === 'pending') return answer.result;
        if (answer.kind === 'declined') {
          rt.app.trust.record({ action: 'deny', server: name, detail: { kind: 'approve' } });
          return ok('enable_server', {
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
      return ok('enable_server', {
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
    output: OUTPUTS.disable_server,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    async run(rt, { name }) {
      const server = await rt.app.lifecycle.disable(name);
      return ok('disable_server', { name, enabled: server.enabled });
    },
  }),

  server_status: defineTool({
    title: 'Server status',
    description:
      'State of installed servers (enabled, quarantined + drift, indexed, connected, tool count, flagged tools, health). check_health=true runs a live probe.',
    input: z.object({ name: z.string().optional(), check_health: z.boolean().optional() }),
    output: OUTPUTS.server_status,
    annotations: { readOnlyHint: true, openWorldHint: false },
    async run(rt, { name, check_health }) {
      const servers: Array<ServerStatus & { health?: HealthResult }> = rt.app.lifecycle
        .status(name)
        .map((s) => ({ ...s, description: rt.app.trust.cleanServerDescription(s.description) }));
      if (check_health) {
        for (const s of servers) s.health = await rt.app.lifecycle.health(s.name);
      }
      return ok('server_status', { mode: rt.app.config.mode, servers });
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
            description: rt.app.trust.cleanToolDescription(h.description),
            score: h.score,
            enabled: enabled.has(h.server),
            exposed: isExposed(rt, enabled.has(h.server)),
            ...requiredArgs(h.input_schema),
            ...flagsOf(h),
          })),
        });
      }
      return ok('search_tools', { results });
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
      if (!t) return ok('get_tool', { found: false, server, tool });
      const row = rt.app.servers.get(server);
      if (row?.quarantined) return ok('get_tool', { found: true, server, tool, quarantined: true });
      const enabled = row?.enabled ?? false;
      return ok('get_tool', {
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
    meta: { 'anthropic/maxResultSizeChars': 200_000 },
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
