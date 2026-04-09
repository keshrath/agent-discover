// =============================================================================
// agent-discover — Embedding provider factory
//
// Resolves AGENT_DISCOVER_EMBEDDING_PROVIDER (or an explicit config object)
// into a concrete provider instance. Default is 'none' — semantic search is
// opt-in. When the requested provider is unavailable (missing API key, model
// can't load, etc.) returns the noop provider so callers transparently fall
// back to BM25-only ranking.
// =============================================================================

import type { EmbeddingProvider, EmbeddingConfig } from './types.js';
import { getEmbeddingConfig } from './types.js';
import { NoopEmbeddingProvider } from './none.js';

let _instance: EmbeddingProvider | null = null;
let _instanceProvider: string | null = null;

export async function getEmbeddingProvider(config?: EmbeddingConfig): Promise<EmbeddingProvider> {
  const cfg = config ?? getEmbeddingConfig();
  if (_instance && _instanceProvider === cfg.provider) return _instance;
  _instance = (await createProvider(cfg)) ?? new NoopEmbeddingProvider();
  _instanceProvider = cfg.provider;
  return _instance;
}

async function createProvider(cfg: EmbeddingConfig): Promise<EmbeddingProvider | null> {
  switch (cfg.provider) {
    case 'none':
      return new NoopEmbeddingProvider();
    case 'local': {
      const { LocalEmbeddingProvider } = await import('./local.js');
      const idleEnv = process.env.AGENT_DISCOVER_EMBEDDING_IDLE_TIMEOUT;
      const idleMs = idleEnv !== undefined ? parseInt(idleEnv, 10) * 1000 : 60_000;
      const provider = new LocalEmbeddingProvider(cfg.modelOverride, undefined, idleMs);
      if (await provider.isAvailable()) return provider;
      process.stderr.write('[agent-discover] local embedding provider unavailable\n');
      return null;
    }
    case 'openai': {
      if (!cfg.openaiApiKey) {
        process.stderr.write(
          '[agent-discover] AGENT_DISCOVER_OPENAI_API_KEY (or OPENAI_API_KEY) not set\n',
        );
        return null;
      }
      const { OpenAIEmbeddingProvider } = await import('./openai.js');
      return new OpenAIEmbeddingProvider(cfg.openaiApiKey, cfg.modelOverride);
    }
    case 'claude':
    case 'gemini':
      process.stderr.write(
        `[agent-discover] embedding provider "${cfg.provider}" not yet implemented in agent-discover ` +
          `(see agent-knowledge/src/embeddings/${cfg.provider}.ts for the reference impl)\n`,
      );
      return null;
    default:
      process.stderr.write(`[agent-discover] unknown embedding provider: ${cfg.provider}\n`);
      return null;
  }
}

export function resetProvider(): void {
  _instance = null;
  _instanceProvider = null;
}
