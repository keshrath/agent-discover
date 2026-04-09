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
    description: `${act[0].toUpperCase()}${act.slice(1)} a ${res} in ${svc}.`,
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
