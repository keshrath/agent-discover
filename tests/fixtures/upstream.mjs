#!/usr/bin/env node
// =============================================================================
// Test upstream MCP server (SDK v2, stdio, both protocol eras).
//
// Tools exercise the gateway's passthrough and lifecycle paths:
//   echo        text result
//   image       image content block
//   fail        isError result
//   structured  outputSchema + structuredContent
//   confirm     MRTR elicitation round (input_required)
//   crash       exits the process (connection drop)
//   grow        registers tool `extra` and emits tools/list_changed
// FIXTURE_DESCRIPTION overrides echo's description (tool drift tests).
// =============================================================================

import * as z from 'zod';
import { McpServer, inputRequired, acceptedContent } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let grown = false;

function build() {
  const s = new McpServer({ name: 'fixture-upstream', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
  s.registerTool(
    'echo',
    {
      description: process.env.FIXTURE_DESCRIPTION ?? 'Echo text back',
      inputSchema: z.object({ text: z.string() }),
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({ content: [{ type: 'text', text }] }),
  );
  s.registerTool('image', { description: 'Return a tiny png image' }, async () => ({
    content: [{ type: 'image', data: PNG, mimeType: 'image/png' }],
  }));
  s.registerTool('fail', { description: 'Always fails with an error result' }, async () => ({
    isError: true,
    content: [{ type: 'text', text: 'boom' }],
  }));
  s.registerTool(
    'structured',
    {
      description: 'Return structured weather data',
      inputSchema: z.object({ city: z.string() }),
      outputSchema: z.object({ city: z.string(), celsius: z.number() }),
    },
    async ({ city }) => ({
      content: [{ type: 'text', text: `${city}: 21C` }],
      structuredContent: { city, celsius: 21 },
    }),
  );
  s.registerTool('confirm', { description: 'Ask the user to confirm, then answer' }, async (_args, ctx) => {
    const ok = acceptedContent(ctx.mcpReq.inputResponses, 'ok', z.object({ yes: z.boolean() }));
    if (!ok) {
      return inputRequired({
        inputRequests: { ok: inputRequired.elicit({ message: 'Proceed?', requestedSchema: z.object({ yes: z.boolean() }) }) },
        requestState: 'upstream-state-1',
      });
    }
    return { content: [{ type: 'text', text: `confirmed=${ok.yes} state=${ctx.mcpReq.requestState()}` }] };
  });
  s.registerTool('crash', { description: 'Exit the server process' }, async () => {
    setTimeout(() => process.exit(1), 10);
    return { content: [{ type: 'text', text: 'bye' }] };
  });
  s.registerTool('grow', { description: 'Add the extra tool' }, async () => {
    grown = true;
    for (const inst of instances) {
      inst.registerTool('extra', { description: 'Extra tool added at runtime' }, async () => ({
        content: [{ type: 'text', text: 'extra' }],
      }));
    }
    return { content: [{ type: 'text', text: 'grown' }] };
  });
  if (grown) {
    s.registerTool('extra', { description: 'Extra tool added at runtime' }, async () => ({
      content: [{ type: 'text', text: 'extra' }],
    }));
  }
  instances.add(s);
  return s;
}

const instances = new Set();
serveStdio(() => build());
