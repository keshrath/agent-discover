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
  'campaign',
  'cart',
  'order',
  'payment',
  'shipment',
  'discount',
  'product',
  'cluster',
  'node',
  'volume',
  'snapshot',
  'backup',
  'rule',
  'audit',
  'session',
  'tag',
];

// Resource aliases — natural-language synonyms for the canonical resource
// names. Bench uses these to enrich tool descriptions so embeddings have
// real semantic signal to latch onto. Mirrors how real-world tool catalogs
// (Stripe API, Linear API) include domain language in their descriptions.
const RESOURCE_ALIASES: Record<string, string> = {
  user: 'user account / customer profile / member',
  account: 'account / customer / user record',
  project: 'project / workspace / repository',
  event: 'event / activity / occurrence / log entry',
  record: 'record / row / entry',
  invoice: 'invoice / bill / charge / receipt',
  subscription: 'subscription / recurring billing arrangement / recurring plan / membership',
  webhook: 'webhook / callback URL / event listener / notification endpoint',
  workflow: 'workflow / pipeline / automation / process',
  pipeline: 'pipeline / build / CI run / deployment process',
  job: 'job / task / scheduled run / background work',
  metric: 'metric / data point / measurement / statistic',
  alert: 'alert / incident / notification / warning',
  dashboard: 'dashboard / report view / chart panel',
  report: 'report / summary / analysis document',
  token: 'token / API key / credential / secret',
  campaign: 'campaign / marketing push / promotion',
  cart: 'cart / shopping basket / checkout',
  order: 'order / purchase / transaction',
  payment: 'payment / charge / transaction',
  shipment: 'shipment / delivery / fulfillment',
  discount: 'discount / coupon / promo code',
  product: 'product / SKU / item / listing',
  cluster: 'cluster / kubernetes cluster / node group',
  node: 'node / server / instance',
  volume: 'volume / disk / storage attachment',
  snapshot: 'snapshot / backup point / restore image',
  backup: 'backup / archive / restore copy',
  rule: 'rule / policy / firewall rule',
  audit: 'audit / log / compliance trail',
  session: 'session / login / authentication',
  tag: 'tag / label / category',
};

const ACTION_ALIASES: Record<string, string> = {
  list: 'list / show all / pull / fetch all / browse / enumerate',
  get: 'get / fetch / look up / retrieve / read / show one',
  create: 'create / make / add / set up / open / register / provision new',
  update: 'update / change / edit / modify / patch / move to',
  delete: 'delete / remove / cancel / end / destroy / terminate',
  search: 'search / find / query / lookup',
  export: 'export / download / dump',
  import: 'import / upload / load',
};

// Service domain aliases — describes what each service IS so embeddings can
// match queries that name a domain rather than the service brand. Without
// these, the bench's adv-get task ("recurring billing arrangement") matches
// stripe_get_subscription AND twilio_get_subscription equally because both
// have the same resource description. Embedding "stripe = billing platform"
// vs "twilio = sms provider" gives the model semantic signal to prefer the
// right one.
const SERVICE_ALIASES: Record<string, string> = {
  stripe:
    'payment processor / billing platform / subscription billing / online payments / charge cards',
  shopify: 'ecommerce platform / online store / retail commerce',
  twilio: 'sms / voice / communications API / phone messaging',
  pagerduty: 'incident management / on-call alerting / paging system',
  opsgenie: 'incident management / alerting / on-call schedule',
  snowflake: 'data warehouse / cloud database / analytics SQL',
  redshift: 'data warehouse / aws analytics database',
  bigquery: 'data warehouse / google analytics SQL / serverless query',
  azure: 'microsoft cloud / cloud infrastructure',
  gcp: 'google cloud / cloud infrastructure',
  cloudflare: 'CDN / edge network / DNS / DDoS protection',
  fastly: 'CDN / edge compute / cache',
  auth0: 'authentication / identity / login / SSO',
  okta: 'identity / SSO / enterprise authentication',
  segment: 'analytics pipeline / customer data platform / event tracking',
  mixpanel: 'product analytics / event tracking / user behavior',
  amplitude: 'product analytics / user journey / behavior tracking',
  intercom: 'customer support chat / messaging / help desk',
  zendesk: 'customer support / help desk / ticketing',
  hubspot: 'CRM / marketing automation / sales pipeline',
  salesforce: 'CRM / sales / customer relationship management',
  asana: 'project management / task tracking / team workflow',
  trello: 'kanban board / task tracking / project management',
  monday: 'project management / work tracking / team collaboration',
  figma: 'design tool / UI mockup / collaborative design',
  miro: 'whiteboard / collaborative diagram / brainstorming',
  confluence: 'wiki / documentation / knowledge base',
  bitbucket: 'git hosting / code repository / version control',
  gitlab: 'git hosting / CI/CD / devops platform',
  circleci: 'CI/CD / build automation / continuous integration',
  jenkins: 'CI/CD / build server / automation',
  argocd: 'gitops / kubernetes deployment / continuous delivery',
  terraform: 'infrastructure as code / cloud provisioning',
  vault: 'secrets management / credentials store',
  consul: 'service discovery / configuration / service mesh',
  nomad: 'workload orchestration / scheduler',
  kafka: 'event streaming / message bus / log pipeline',
  rabbitmq: 'message queue / AMQP broker',
  redis: 'in-memory cache / key-value store',
  memcached: 'in-memory cache / key-value store',
  mysql: 'relational database / SQL',
  mongodb: 'document database / NoSQL',
  dynamodb: 'aws nosql database / key-value store',
  elasticsearch: 'search engine / log analytics',
  opensearch: 'search engine / log analytics / aws fork of elasticsearch',
  splunk: 'log analytics / security information event management',
  newrelic: 'application monitoring / observability / APM',
  grafana: 'metrics dashboard / observability / time series visualization',
  prometheus: 'metrics / monitoring / time series database',
};

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
  const resAlias = RESOURCE_ALIASES[res] ?? res;
  const actAlias = ACTION_ALIASES[act] ?? act;
  const svcAlias = SERVICE_ALIASES[svc] ?? svc;
  const description =
    `${act[0].toUpperCase()}${act.slice(1)} a ${res} in ${svc}. ` +
    `Service: ${svc} (${svcAlias}). ` +
    `Action synonyms: ${actAlias}. ` +
    `Resource synonyms: ${resAlias}.`;
  return {
    name,
    description,
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
export async function seedRegistry(n: number): Promise<number> {
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
    // Use the embedding-aware variant when OPENAI_API_KEY is set in this
    // process — otherwise it transparently falls back to plain saveTools.
    const result = await ctx.registry.saveToolsWithEmbeddings(server.id, tools);
    if (result.embedded > 0) {
      console.log(`embedded ${result.embedded} tools`);
    }

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
  seedRegistry(n)
    .then((count) => console.log(`seeded ${count} tools under server "${SERVER_NAME}"`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
