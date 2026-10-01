// =============================================================================
// structuredContent ↔ presentation contract, on real results of every meta tool:
// outputSchema conformance, widget view dispatch, markdown text, tool/resource
// _meta and the ext-apps constants the core hardcodes.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RESOURCE_MIME_TYPE, RESOURCE_URI_META_KEY } from '@modelcontextprotocol/ext-apps/server';
import { OUTPUTS, type Outputs } from '../../src/widgets/types.js';
import { resultText } from '../../src/widgets/text.js';
import { DASHBOARD_META_KEY, WIDGET_MIME, WIDGET_URI } from '../../src/widgets/resources.js';
// @ts-expect-error -- plain browser ESM without type declarations
import { viewOf } from '../../src/widgets/lib/view.js';
import { capture, toolOf, type CaptureSession } from './capture.js';

let s: CaptureSession;
beforeAll(async () => {
  s = await capture();
}, 60_000);
afterAll(() => s?.close());

const VIEW_TOOLS = Object.keys(OUTPUTS) as Array<keyof Outputs>;

describe('every meta tool result', () => {
  it('covers every tool with a view', () => {
    expect(new Set(Object.keys(s.results).map(toolOf))).toEqual(
      new Set([...VIEW_TOOLS, 'call_tool']),
    );
  });

  it.each(VIEW_TOOLS)('%s: schema, view dispatch, text and dashboard _meta agree', (tool) => {
    const variants = Object.entries(s.results).filter(([v]) => toolOf(v) === tool);
    for (const [variant, res] of variants) {
      const sc = res.structuredContent as Outputs[typeof tool];
      expect(OUTPUTS[tool].safeParse(sc).success, variant).toBe(true);
      expect(viewOf(sc), variant).toBe(tool);
      expect(res.content, variant).toEqual([
        { type: 'text', text: resultText(tool, sc, { dashboard: s.daemon.base }) },
      ]);
      expect(res._meta?.[DASHBOARD_META_KEY], variant).toBe(s.daemon.base);
    }
  });

  it('never leaks env values, only keys', () => {
    const all = JSON.stringify(s.results) + s.prompts.join('\n');
    expect(all).toContain('API_TOKEN');
    expect(all).not.toContain('secret-value');
  });

  it('call_tool passes the upstream result through verbatim', () => {
    expect(s.results.call_tool.structuredContent).toEqual({ city: 'Graz', celsius: 21 });
    expect(viewOf(s.results.call_tool.structuredContent)).toBeNull();
  });
});

describe('install consent', () => {
  it('elicits with the plan text and reports declines', () => {
    expect(s.prompts[0]).toContain(`Install MCP server "fixture"?`);
    expect(s.prompts[0]).toMatch(/Env vars: FIXTURE_DESCRIPTION, API_TOKEN/);
    expect(s.prompts[0]).toContain('! Manual configuration (not from a registry)');
    expect(s.prompts[1]).toContain('Runs on this machine: npx -y @example/weather-mcp@2.1.3');
    expect(s.prompts[1]).toContain('✓ Version pinned');
    expect(s.results.install_server_declined.structuredContent).toMatchObject({
      status: 'declined',
    });
  });

  it('without elicitation returns the plan as an error result and installs nothing', () => {
    const res = s.results.install_server_consent;
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({
      status: 'consent_required',
      plan: {
        package: '@example/weather-mcp',
        provenance: [
          { label: 'Package @example/weather-mcp', level: 'info' },
          { label: 'Unpinned version', level: 'warn' },
        ],
      },
    });
    expect(s.daemon.ctx.servers.get('weather')).toBeNull();
  });
});

describe('tool and resource metadata', () => {
  it('points every view tool at the widget and sets Claude Code hints', async () => {
    const { tools } = await s.client.listTools();
    const meta = Object.fromEntries(tools.map((t) => [t.name, t._meta ?? {}]));
    for (const t of VIEW_TOOLS) {
      expect(meta[t], t).toMatchObject({
        ui: { resourceUri: WIDGET_URI },
        [RESOURCE_URI_META_KEY]: WIDGET_URI,
      });
    }
    expect(meta.install_server['anthropic/requiresUserInteraction']).toBe(true);
    expect(meta.get_tool['anthropic/maxResultSizeChars']).toBe(200_000);
    expect(meta.call_tool).toEqual({ 'anthropic/maxResultSizeChars': 200_000 });
  });

  it('serves the built widget as an MCP Apps resource', async () => {
    expect(WIDGET_MIME).toBe(RESOURCE_MIME_TYPE);
    const { resources } = await s.client.listResources();
    expect(resources).toMatchObject([{ uri: WIDGET_URI, mimeType: WIDGET_MIME }]);
    const read = await s.client.readResource({ uri: WIDGET_URI });
    const content = read.contents[0] as { mimeType: string; text: string };
    expect(content.mimeType).toBe(WIDGET_MIME);
    expect(content.text.startsWith('<!doctype html>')).toBe(true);
    await expect(s.client.readResource({ uri: 'ui://agent-discover/nope' })).rejects.toThrow();
  });
});
