// =============================================================================
// Sampling provider: opt-in key, reasoning-model request shape, audit hook.
// =============================================================================

import { describe, it, expect, afterEach, vi } from 'vitest';
import { samplingFromEnv, type SamplingEvent } from '../src/domain/sampling.js';

afterEach(() => vi.unstubAllGlobals());

const request = {
  serverName: 'up',
  messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
  maxTokens: 50,
};

describe('sampling', () => {
  it('is not enabled by a plain OPENAI_API_KEY', () => {
    expect(samplingFromEnv({ OPENAI_API_KEY: 'sk-x' }, () => {})).toBeUndefined();
  });

  it('sends max_completion_tokens, no default temperature, and reports each request', async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
    const events: SamplingEvent[] = [];
    const provider = samplingFromEnv({ AGENT_DISCOVER_OPENAI_API_KEY: 'sk-x' }, (e) =>
      events.push(e),
    )!;
    const out = await provider.createMessage(request);
    expect(out.content.text).toBe('ok');
    expect(bodies[0]).toMatchObject({ model: 'gpt-5-mini', max_completion_tokens: 50 });
    expect(bodies[0]).not.toHaveProperty('max_tokens');
    expect(bodies[0]).not.toHaveProperty('temperature');
    await provider.createMessage({ ...request, temperature: 0.2 });
    expect(bodies[1]).toMatchObject({ temperature: 0.2 });
    expect(events).toEqual([
      expect.objectContaining({ server: 'up', model: 'gpt-5-mini', is_error: false }),
      expect.objectContaining({ server: 'up', is_error: false }),
    ]);
  });

  it('reports a failed request as an error', async () => {
    vi.stubGlobal('fetch', async () => new Response('bad', { status: 400 }));
    const events: SamplingEvent[] = [];
    const provider = samplingFromEnv({ AGENT_DISCOVER_OPENAI_API_KEY: 'sk-x' }, (e) =>
      events.push(e),
    )!;
    await expect(provider.createMessage(request)).rejects.toThrow(/OpenAI 400/);
    expect(events[0]).toMatchObject({ server: 'up', is_error: true });
  });
});
