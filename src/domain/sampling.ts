// =============================================================================
// agent-discover — Sampling provider (OpenAI Chat Completions)
//
// Opt-in: only AGENT_DISCOVER_OPENAI_API_KEY enables it (a plain OPENAI_API_KEY
// in the daemon's env must not let upstream servers spend it). Every request
// is reported through `onRequest` (the audit log).
// =============================================================================

export interface SamplingProvider {
  createMessage(request: {
    serverName: string;
    messages: Array<{ role: string; content: { type: string; text?: string } }>;
    maxTokens?: number;
    temperature?: number;
    systemPrompt?: string;
    modelPreferences?: Record<string, unknown>;
  }): Promise<{
    role: 'assistant';
    content: { type: 'text'; text: string };
    model: string;
    stopReason?: string;
  }>;
}

export interface SamplingEvent {
  server: string;
  model: string;
  duration_ms: number;
  is_error: boolean;
}

const DEFAULT_MODEL = 'gpt-5-mini';
const DEFAULT_MAX_TOKENS = 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function createOpenAISamplingProvider(options: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  onRequest?: (event: SamplingEvent) => void;
}): SamplingProvider {
  const apiKey = options.apiKey;
  const model = options.model ?? DEFAULT_MODEL;
  const baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
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

      const started = Date.now();
      let failed = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        // Reasoning models (gpt-5*, o*) reject max_tokens and any non-default temperature.
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages,
            max_completion_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
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
        failed = false;
        return {
          role: 'assistant',
          content: { type: 'text', text },
          model: body.model ?? model,
          stopReason: choice?.finish_reason,
        };
      } finally {
        clearTimeout(timer);
        options.onRequest?.({
          server: request.serverName,
          model,
          duration_ms: Date.now() - started,
          is_error: failed,
        });
      }
    },
  };
}

export function samplingFromEnv(
  env: NodeJS.ProcessEnv,
  onRequest: (event: SamplingEvent) => void,
): SamplingProvider | undefined {
  const apiKey = env.AGENT_DISCOVER_OPENAI_API_KEY;
  if (!apiKey) return undefined;
  return createOpenAISamplingProvider({
    apiKey,
    model: env.AGENT_DISCOVER_SAMPLING_MODEL || undefined,
    baseUrl: env.AGENT_DISCOVER_OPENAI_BASE_URL || undefined,
    onRequest,
  });
}
