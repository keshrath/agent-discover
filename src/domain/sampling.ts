// =============================================================================
// agent-discover — Sampling provider (OpenAI Chat Completions)
// =============================================================================

import type { SamplingProvider } from './proxy.js';

const DEFAULT_MODEL = 'gpt-5-mini';
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export function createOpenAISamplingProvider(options: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): SamplingProvider {
  const apiKey = options.apiKey;
  const model = options.model ?? process.env.AGENT_DISCOVER_SAMPLING_MODEL ?? DEFAULT_MODEL;
  const baseUrl =
    options.baseUrl ?? process.env.AGENT_DISCOVER_OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async createMessage(request) {
      const messages: OpenAIMessage[] = [];
      if (request.systemPrompt) {
        messages.push({ role: 'system', content: request.systemPrompt });
      }
      for (const m of request.messages) {
        const role: OpenAIMessage['role'] = m.role === 'assistant' ? 'assistant' : 'user';
        const text =
          m.content && m.content.type === 'text' && typeof m.content.text === 'string'
            ? m.content.text
            : '';
        messages.push({ role, content: text });
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
            temperature: request.temperature ?? 0.7,
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          throw new Error(`OpenAI ${res.status}: ${detail.slice(0, 500)}`);
        }
        const body = (await res.json()) as {
          choices?: Array<{
            message?: { content?: string };
            finish_reason?: string;
          }>;
          model?: string;
        };
        const choice = body.choices?.[0];
        const text = choice?.message?.content ?? '';
        return {
          role: 'assistant',
          content: { type: 'text', text },
          model: body.model ?? model,
          stopReason: choice?.finish_reason,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function maybeCreateDefaultSamplingProvider(): SamplingProvider | undefined {
  const apiKey =
    process.env.AGENT_DISCOVER_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY ?? undefined;
  if (!apiKey) return undefined;
  return createOpenAISamplingProvider({ apiKey });
}
