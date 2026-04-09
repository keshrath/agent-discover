// =============================================================================
// Seed agent-discover's registry with the same N stub tools the eager arm's
// fake-tools server would emit at FAKE_TOOL_COUNT=N. Run once before the
// discover arm of the bench so the agent has something to search.
//
// Usage:
//   npm run bench:seed -- --n=100
//   npm run bench:seed -- --n=500
//
// Idempotent: re-running replaces the prior `fake-tools-bench` server entry
// and its tools with the new N. Other registered servers are untouched.
//
// The synthetic server entry points at bench/fake-tools/server.mjs as the
// launcher with FAKE_TOOL_COUNT=N in env, so when the discover arm calls
// registry({action:"get"}) and then proxies an actual tool call, the same
// fake server backs it as the eager arm — closing the loop.
// =============================================================================

import * as path from 'node:path';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext } from '../../src/lib.js';

// Use the same isolated DB as the bench cli driver to avoid deadlocking on
// the parent agent-discover MCP server's writer lock on ~/.claude/agent-discover.db.
const BENCH_DB =
  process.env.AGENT_DISCOVER_BENCH_DB ??
  (process.platform === 'win32'
    ? 'C:\\tmp\\agent-discover-bench\\agent-discover-bench.db'
    : '/tmp/agent-discover-bench/agent-discover-bench.db');
mkdirSync(path.dirname(BENCH_DB), { recursive: true });
process.env.AGENT_DISCOVER_DB = BENCH_DB;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_NAME = 'fake-tools-bench';
const SERVER_PATH = path.join(__dirname, 'server.mjs').replace(/\\/g, '/');
const REAL_CATALOG = JSON.parse(readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));

// Mirror server.mjs filler logic so the seeded names match what the agent
// would actually see at runtime. Keep in sync with server.mjs.
const SERVICES = [
  'stripe',
  'shopify',
  'twilio',
  'pagerduty',
  'opsgenie',
  'snowflake',
  'redshift',
  'bigquery',
  'azure',
  'gcp',
  'cloudflare',
  'fastly',
  'auth0',
  'okta',
  'segment',
  'mixpanel',
  'amplitude',
  'intercom',
  'zendesk',
  'hubspot',
  'salesforce',
  'asana',
  'trello',
  'monday',
  'figma',
  'miro',
  'confluence',
  'bitbucket',
  'gitlab',
  'circleci',
  'jenkins',
  'argocd',
  'terraform',
  'vault',
  'consul',
  'nomad',
  'kafka',
  'rabbitmq',
  'redis',
  'memcached',
  'mysql',
  'mongodb',
  'dynamodb',
  'elasticsearch',
  'opensearch',
  'splunk',
  'newrelic',
  'grafana',
  'prometheus',
];
const ACTIONS = ['list', 'get', 'create', 'update', 'delete', 'search', 'export', 'import'];
const RESOURCES = [
  'user',
  'account',
  'project',
  'event',
  'record',
  'invoice',
  'subscription',
  'webhook',
  'workflow',
  'pipeline',
  'job',
  'metric',
  'alert',
  'dashboard',
  'report',
  'token',
];

function synthTool(idx: number) {
  // Keep in sync with bench/fake-tools/server.mjs — see note there.
  const res = RESOURCES[idx % RESOURCES.length];
  const act = ACTIONS[Math.floor(idx / RESOURCES.length) % ACTIONS.length];
  const svc = SERVICES[Math.floor(idx / (RESOURCES.length * ACTIONS.length)) % SERVICES.length];
  const name = `${svc}_${act}_${res}`;
  const bucket = idx % 4;
  const props = bucket === 0 ? 2 : bucket === 3 ? 14 : 6;
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < props; i++) {
    properties[`field_${i}`] = {
      type: i % 3 === 0 ? 'string' : i % 3 === 1 ? 'number' : 'boolean',
      description: `Filler field ${i} for ${name}.`,
    };
  }
  return {
    name,
    description: `${act[0].toUpperCase()}${act.slice(1)} a ${res} in ${svc}.`,
    inputSchema: { type: 'object', properties, required: [`field_0`] },
  };
}

function buildCatalog(n: number) {
  if (n <= REAL_CATALOG.length) return REAL_CATALOG.slice(0, n);
  const filler = [];
  for (let i = 0; i < n - REAL_CATALOG.length; i++) filler.push(synthTool(i));
  return [...REAL_CATALOG, ...filler];
}

/**
 * Seed (or re-seed) the bench-isolated agent-discover registry with N stub
 * tools. Returns the actual tool count seeded. Idempotent — re-seeding with
 * a different N replaces the prior fake-tools-bench entry.
 *
 * Used both from the bench runner (in-process) and from the CLI
 * (`npm run bench:seed -- --n=100`).
 */
export function seedRegistry(n: number): number {
  if (!Number.isFinite(n) || n <= 0) throw new Error('n must be a positive integer');

  const ctx = createContext();
  try {
    const existing = ctx.registry.list().find((s) => s.name === SERVER_NAME);
    if (existing) ctx.registry.unregister(SERVER_NAME);

    const server = ctx.registry.register({
      name: SERVER_NAME,
      description: `Bench fake-tools server with ${n} stub tools (synthetic).`,
      source: 'local',
      command: 'node',
      args: [SERVER_PATH],
      env: { FAKE_TOOL_COUNT: String(n) },
      tags: ['bench', 'fake'],
      transport: 'stdio',
    });

    const tools = buildCatalog(n);
    ctx.registry.saveTools(server.id, tools);

    return tools.length;
  } finally {
    ctx.close?.();
  }
}

// CLI entry — only run when invoked directly, not when imported.
const isCli = process.argv[1] && process.argv[1].includes('seed-registry');
if (isCli) {
  const nArg = process.argv.find((a) => a.startsWith('--n='));
  const n = nArg ? parseInt(nArg.slice(4), 10) : 100;
  try {
    const count = seedRegistry(n);
    console.log(`seeded ${count} tools under server "${SERVER_NAME}"`);
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
