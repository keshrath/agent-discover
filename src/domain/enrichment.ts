// =============================================================================
// agent-discover — Index-time tool enrichment (optional, off by default)
//
// An LLM writes, once per tool definition, the words users actually search
// with: when the tool is the right call, a handful of realistic requests, and
// synonyms / non-English keywords. The ToolIndex stores results by
// (tool_hash, model) so a tool is enriched once per definition, never per
// search, and a changed upstream definition is re-enriched automatically.
//
// Providers (AGENT_DISCOVER_ENRICH_PROVIDER):
//   openai     any OpenAI-compatible Chat Completions endpoint (OpenAI,
//              Ollama, LM Studio, vLLM, ...): AGENT_DISCOVER_ENRICH_BASE_URL,
//              AGENT_DISCOVER_ENRICH_API_KEY (or OPENAI_API_KEY),
//              AGENT_DISCOVER_ENRICH_MODEL
//   anthropic  Claude via @anthropic-ai/sdk (optional dependency, install it
//              to use): ANTHROPIC_API_KEY / `ant auth login`,
//              AGENT_DISCOVER_ENRICH_MODEL
// =============================================================================

import type { DocServer, DocTool, Enrichment } from './tool-doc.js';

export interface EnrichmentProvider {
  /** Cache key component: results are stored per (tool_hash, model). */
  readonly model: string;
  /** One result per input, in order; null where the model gave nothing usable. */
  enrich(batch: Array<{ tool: DocTool; server: DocServer }>): Promise<Array<Enrichment | null>>;
}

/** Tools per LLM request. */
export const ENRICH_BATCH = 10;

export const ENRICH_SYSTEM_PROMPT = `You write search metadata for tools exposed to an AI agent through MCP servers.
For every tool you get, return:
- "when_to_use": one or two plain sentences on the situations in which this tool is the right call, in terms of the user's goal (not the API).
- "queries": 5 short, varied requests a user might type when they need this tool, in natural English. Prefer goal-oriented wording and everyday synonyms over repeating the tool name.
- "keywords": 8-12 single words or short phrases: synonyms, related concepts, and German translations of the key terms.
Only describe what the tool really does according to its definition. Answer with JSON: {"tools":[{"name":...,"when_to_use":...,"queries":[...],"keywords":[...]}]} in the input order.`;

/** The user message for one batch: compact JSON of each tool's definition. */
export function enrichUserPrompt(batch: Array<{ tool: DocTool; server: DocServer }>): string {
  return JSON.stringify(
    batch.map(({ tool, server }) => ({
      server: server.name,
      server_description: (server.description ?? '').slice(0, 300),
      name: tool.name,
      description: (tool.description ?? '').slice(0, 1500),
      arguments: Object.keys((tool.inputSchema?.properties as object | undefined) ?? {}),
    })),
  );
}

interface RawEnrichment {
  name?: unknown;
  when_to_use?: unknown;
  queries?: unknown;
  keywords?: unknown;
}

const strings = (v: unknown, max: number): string[] =>
  Array.isArray(v)
    ? v
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map((s) => s.trim().slice(0, 200))
        .slice(0, max)
    : [];

/** Parse a model answer into per-tool enrichments, matched by name (falling back to position). */
export function parseEnrichment(text: string, names: string[]): Array<Enrichment | null> {
  let tools: RawEnrichment[] = [];
  try {
    const start = text.indexOf('{');
    const parsed = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1)) as {
      tools?: RawEnrichment[];
    };
    tools = Array.isArray(parsed.tools) ? parsed.tools : [];
  } catch {
    return names.map(() => null);
  }
  const byName = new Map(tools.map((t) => [String(t.name ?? ''), t]));
  return names.map((name, i) => {
    const raw = byName.get(name) ?? tools[i];
    if (!raw) return null;
    const out: Enrichment = {
      whenToUse: typeof raw.when_to_use === 'string' ? raw.when_to_use.trim().slice(0, 500) : '',
      queries: strings(raw.queries, 8),
      keywords: strings(raw.keywords, 16),
    };
    return out.whenToUse || out.queries.length || out.keywords.length ? out : null;
  });
}

const TIMEOUT_MS = 120_000;

export function createOpenAIEnrichmentProvider(options: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): EnrichmentProvider {
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = options.model ?? 'gpt-5-mini';
  return {
    model: `openai:${model}`,
    async enrich(batch) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: ENRICH_SYSTEM_PROMPT },
            { role: 'user', content: enrichUserPrompt(batch) },
          ],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`enrichment ${res.status}: ${(await res.text()).slice(0, 300)}`);
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return parseEnrichment(
        body.choices?.[0]?.message?.content ?? '',
        batch.map((b) => b.tool.name),
      );
    },
  };
}

interface AnthropicLike {
  messages: {
    create(params: Record<string, unknown>): Promise<{
      stop_reason?: string;
      content: Array<{ type: string; text?: string }>;
    }>;
  };
}

export function createAnthropicEnrichmentProvider(options: { model?: string }): EnrichmentProvider {
  const model = options.model ?? 'claude-opus-5-5';
  let client: Promise<AnthropicLike> | null = null;
  const getClient = () =>
    (client ??= (async () => {
      // Optional dependency: only loaded when this provider is configured.
      const moduleName = '@anthropic-ai/sdk';
      const mod = (await import(moduleName)) as { default: new () => AnthropicLike };
      return new mod.default();
    })());
  return {
    model: `anthropic:${model}`,
    async enrich(batch) {
      const response = await (
        await getClient()
      ).messages.create({
        model,
        max_tokens: 16000,
        output_config: { effort: 'low' },
        system: ENRICH_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: enrichUserPrompt(batch) }],
      });
      if (response.stop_reason === 'refusal') return batch.map(() => null);
      const text = response.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      return parseEnrichment(
        text,
        batch.map((b) => b.tool.name),
      );
    },
  };
}

/** Provider from env, or null (enrichment off — the default). */
export function enrichmentProviderFromEnv(env = process.env): EnrichmentProvider | null {
  const model = env.AGENT_DISCOVER_ENRICH_MODEL || undefined;
  switch (env.AGENT_DISCOVER_ENRICH_PROVIDER) {
    case 'openai':
      return createOpenAIEnrichmentProvider({
        apiKey: env.AGENT_DISCOVER_ENRICH_API_KEY || env.OPENAI_API_KEY,
        baseUrl: env.AGENT_DISCOVER_ENRICH_BASE_URL || undefined,
        model,
      });
    case 'anthropic':
      return createAnthropicEnrichmentProvider({ model });
    default:
      return null;
  }
}
