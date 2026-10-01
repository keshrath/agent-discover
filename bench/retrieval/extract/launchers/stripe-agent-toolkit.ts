// stdio launcher for @stripe/agent-toolkit's MCP server with every action
// enabled. @stripe/mcp >= 0.3 is only a proxy to the hosted mcp.stripe.com
// (needs a real key), so the corpus uses the toolkit's local definitions —
// the same tools the hosted server is built from. W1_PKG_DIR = install dir.
// Spawned by extract-catalog.ts via `node --import tsx`.
import { createRequire } from 'node:module';
import * as path from 'node:path';

const req = createRequire(path.join(process.env.W1_PKG_DIR!, 'package.json'));
const { StripeAgentToolkit } = req('@stripe/agent-toolkit/modelcontextprotocol');
const { StdioServerTransport } = req('@modelcontextprotocol/sdk/server/stdio.js');

const all = { create: true, update: true, read: true };
const objects = [
  'customers',
  'disputes',
  'invoices',
  'invoiceItems',
  'paymentLinks',
  'products',
  'prices',
  'balance',
  'refunds',
  'paymentIntents',
  'subscriptions',
  'documentation',
  'coupons',
];
const server = new StripeAgentToolkit({
  secretKey: 'sk_test_dummy',
  configuration: { actions: Object.fromEntries(objects.map((o) => [o, all])) },
});
void server.connect(new StdioServerTransport());
