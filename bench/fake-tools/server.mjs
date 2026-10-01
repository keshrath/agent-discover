#!/usr/bin/env node
// =============================================================================
// fake-tools — configurable MCP server emitting N stub tools.
//
// Used by the agent-discover bench to compare eager tool loading (this server
// attached directly) vs deferred discovery (only agent-discover attached, with
// this server's catalog pre-seeded into its registry).
//
// Config:
//   FAKE_TOOL_COUNT  — number of tools to emit (default 100, max = catalog.json size)
//   FAKE_TOOL_SEED   — RNG seed for deterministic selection (default 1)
//
// Stub tools return { ok: true, tool, args } unconditionally — no side effects.
// The bench runner asserts on the captured tool-call log, not on world state.
//
// Speaks the MCP stdio protocol minimally: initialize, tools/list, tools/call.
// =============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REAL_CATALOG = JSON.parse(readFileSync(path.join(__dirname, 'catalog.json'), 'utf8'));
const COUNT = parseInt(process.env.FAKE_TOOL_COUNT ?? '100', 10);
const SEED = parseInt(process.env.FAKE_TOOL_SEED ?? '1', 10);

// Failure injection. When > 0, the stub returns isError for a deterministic
// subset of tool calls. Used by the bench to exercise the discover arm's
// did_you_mean recovery path — without injected failures the unconditionally-
// successful stubs hide whether the recovery actually fires.
const ERROR_RATE = parseFloat(process.env.FAKE_TOOL_ERROR_RATE ?? '0');

function shouldFail(toolName) {
  if (ERROR_RATE <= 0) return false;
  // Hash tool name to [0,1). Deterministic — same tool always fails or
  // always succeeds for a given ERROR_RATE, so runs are reproducible.
  let h = 0;
  for (let i = 0; i < toolName.length; i++) h = (h * 31 + toolName.charCodeAt(i)) | 0;
  return (Math.abs(h) % 1000) / 1000 < ERROR_RATE;
}

// Synthesize filler tools when COUNT exceeds the curated catalog. The filler
// tools are deterministic (seeded by index) and have realistic-looking names
// drawn from a service × action × resource matrix, so the discover arm has a
// non-trivial search problem at high N.
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
const RESOURCE_ALIASES = {
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

const ACTION_ALIASES = {
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
const SERVICE_ALIASES = {
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

function synthTool(idx) {
  // Vary RESOURCES fastest, then ACTIONS, then SERVICES — gives a small N
  // catalog with diverse tool names instead of 50× the same resource. At
  // N=500 this covers ~3 services × 16 resources × 8 actions ≈ 384 tools
  // including the CRUD on subscription/invoice/webhook the bench's
  // collision tasks expect to exist.
  const res = RESOURCES[idx % RESOURCES.length];
  const act = ACTIONS[Math.floor(idx / RESOURCES.length) % ACTIONS.length];
  const svc = SERVICES[Math.floor(idx / (RESOURCES.length * ACTIONS.length)) % SERVICES.length];
  const name = `${svc}_${act}_${res}`;
  // Mix schema sizes: 25% small, 50% medium, 25% fat — mirrors real-world distribution.
  const bucket = idx % 4;
  const props = bucket === 0 ? 2 : bucket === 3 ? 14 : 6;
  const properties = {};
  for (let i = 0; i < props; i++) {
    properties[`field_${i}`] = {
      type: i % 3 === 0 ? 'string' : i % 3 === 1 ? 'number' : 'boolean',
      description: `Filler field ${i} for ${name}.`,
    };
  }
  return {
    name,
    description:
      `${act[0].toUpperCase()}${act.slice(1)} a ${res} in ${svc}. ` +
      `Service: ${svc} (${SERVICE_ALIASES[svc] ?? svc}). ` +
      `Action synonyms: ${ACTION_ALIASES[act] ?? act}. ` +
      `Resource synonyms: ${RESOURCE_ALIASES[res] ?? res}.`,
    inputSchema: { type: 'object', properties, required: [`field_0`] },
  };
}

function buildCatalog() {
  if (COUNT <= REAL_CATALOG.length) return REAL_CATALOG.slice(0, COUNT);
  const filler = [];
  for (let i = 0; i < COUNT - REAL_CATALOG.length; i++) filler.push(synthTool(i));
  return [...REAL_CATALOG, ...filler];
}

// Deterministic shuffle so a given (COUNT, SEED) pair always picks the same tools.
function mulberry32(seed) {
  return () => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const FULL = buildCatalog();
const TOOLS = FULL.sort(() => rand() - 0.5);

// ---- minimal MCP stdio loop ------------------------------------------------
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function handle(req) {
  const { id, method, params } = req;
  switch (method) {
    case 'initialize':
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'fake-tools', version: '0.1.0' },
          capabilities: { tools: {} },
        },
      });
    case 'ping':
      return send({ jsonrpc: '2.0', id, result: {} });
    case 'notifications/initialized':
      return;
    case 'tools/list':
      return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    case 'tools/call': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      const known = TOOLS.find((t) => t.name === name);
      if (!known) {
        return send({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `unknown tool: ${name}` },
        });
      }
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify({ ok: true, tool: name, args }) }],
        },
      });
    }
    default:
      return send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `unknown method: ${method}` },
      });
  }
}

let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try {
      handle(JSON.parse(line));
    } catch (e) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: String(e) } });
    }
  }
});
