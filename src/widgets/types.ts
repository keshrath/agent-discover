// =============================================================================
// structuredContent contract of the meta tools. These zod schemas are the
// tools' advertised outputSchemas (src/mcp/tools.ts) and the input of every
// presentation surface: the markdown fallback (text.ts) and the MCP Apps
// widget (main.js).
// =============================================================================

import * as z from 'zod';

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
  drift: z
    .object({
      changed: z.array(
        z.object({
          tool: z.string(),
          description: z.object({ before: z.string(), after: z.string() }).optional(),
          input_schema: z
            .object({
              added: z.array(z.string()),
              removed: z.array(z.string()),
              changed: z.array(z.string()),
            })
            .optional(),
          annotations: z.object({ before: z.unknown(), after: z.unknown() }).optional(),
        }),
      ),
      added: z.array(z.string()),
      removed: z.array(z.string()),
    })
    .optional()
    .describe('While quarantined: tool changes since the last approval'),
  flagged_tools: flaggedTools,
  registry_status: z
    .enum(['active', 'deprecated', 'deleted'])
    .nullable()
    .describe('deleted = taken down from the MCP Registry (malware/spam): uninstall it'),
  health: z
    .object({ status: z.string(), latency_ms: z.number(), error: z.string().optional() })
    .optional(),
});

/** One fact about where an install comes from; `level` drives the badge tone. */
const provenanceFact = z.object({
  label: z.string(),
  level: z.enum(['ok', 'warn', 'info']),
  detail: z.string().optional(),
});

/**
 * What install_server will do, shown to the user before anything runs: the
 * exact command or endpoint, the env/header keys (never values) and
 * provenance facts. Renderers tolerate missing optional fields.
 */
export const installPlan = z.object({
  name: z.string(),
  transport: z.string(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  url: z.string().optional(),
  package: z.string().optional(),
  repository: z.string().optional(),
  env_keys: z.array(z.string()),
  header_keys: z.array(z.string()),
  provenance: z.array(provenanceFact),
});

export const OUTPUTS = {
  search_servers: z.object({
    query: z.string(),
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
        source: z.enum(['registry', 'npm', 'pypi']),
        name: z.string().describe('Exact name to pass to install_server as `server`'),
        title: z.string().optional(),
        description: z.string(),
        version: z.string(),
        status: z.enum(['active', 'deprecated', 'deleted']),
        repository: z.string().nullable(),
        packages: z.array(
          z.object({
            registry_type: z.string(),
            identifier: z.string(),
            version: z.string().nullable(),
            transport: z.string(),
          }),
        ),
        remotes: z.array(z.object({ type: z.string(), url: z.string() })),
      }),
    ),
    marketplace_errors: z.record(z.string(), z.string()).optional(),
  }),
  install_server: z.object({
    name: z.string(),
    status: z.enum(['installed', 'already_installed', 'declined', 'consent_required']),
    enabled: z.boolean(),
    tool_count: z.number(),
    tools: z.array(z.string()),
    index_error: z.string().optional(),
    missing: z
      .array(z.string())
      .optional()
      .describe('Required env vars / headers without a value (set them as secrets)'),
    plan: installPlan.optional().describe('What was (or would be) installed'),
  }),
  enable_server: z.object({
    name: z.string(),
    enabled: z.boolean(),
    quarantined: z.boolean(),
    tool_count: z.number(),
    tools: z.array(z.string()),
  }),
  disable_server: z.object({ name: z.string(), enabled: z.boolean() }),
  server_status: z.object({ mode: z.enum(['native', 'proxy']), servers: z.array(serverStatus) }),
  search_tools: z.object({
    results: z.array(z.object({ query: z.string(), matches: z.array(toolMatch) })),
  }),
  get_tool: z.object({
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
};

export type Outputs = { [K in keyof typeof OUTPUTS]: z.infer<(typeof OUTPUTS)[K]> };
export type InstallPlan = z.infer<typeof installPlan>;
export type ServerStatusRow = z.infer<typeof serverStatus>;
