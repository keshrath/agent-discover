// =============================================================================
// agent-discover — Embedding provider factory
//
// Resolves AGENT_DISCOVER_EMBEDDING_PROVIDER into a provider, once. Anything
// unavailable (missing key, package or model) resolves to the no-op provider
// with a stderr note, so search degrades to lexical instead of failing.
// =============================================================================

import type { EmbeddingProvider, EmbeddingConfig } from './types.js';
import { getEmbeddingConfig } from './types.js';
import { NoopEmbeddingProvider } from './none.js';

let instance: Promise<EmbeddingProvider> | null = null;

export function getEmbeddingProvider(): Promise<EmbeddingProvider> {
  instance ??= createProvider(getEmbeddingConfig());
  return instance;
}

export async function createProvider(cfg: EmbeddingConfig): Promise<EmbeddingProvider> {
  switch (cfg.provider) {
    case 'none':
      return new NoopEmbeddingProvider();
    case 'local': {
      const { LocalEmbeddingProvider } = await import('./local.js');
      const idle = process.env.AGENT_DISCOVER_EMBEDDING_IDLE_TIMEOUT;
      const threads = parseInt(process.env.AGENT_DISCOVER_EMBEDDING_THREADS ?? '1', 10) || 1;
      const provider = new LocalEmbeddingProvider(
        cfg.modelOverride || undefined,
        idle !== undefined ? parseInt(idle, 10) * 1000 : undefined,
        threads,
      );
      if (await provider.load()) return provider;
      break;
    }
    case 'openai': {
      if (!cfg.openaiApiKey) {
        process.stderr.write(
          '[agent-discover] AGENT_DISCOVER_OPENAI_API_KEY (or OPENAI_API_KEY) not set\n',
        );
        break;
      }
      const { OpenAIEmbeddingProvider } = await import('./openai.js');
      return new OpenAIEmbeddingProvider(cfg.openaiApiKey, cfg.modelOverride);
    }
    default:
      process.stderr.write(`[agent-discover] unknown embedding provider: ${cfg.provider}\n`);
  }
  process.stderr.write('[agent-discover] embeddings unavailable — lexical search only\n');
  return new NoopEmbeddingProvider();
}
