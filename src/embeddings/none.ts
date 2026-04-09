// =============================================================================
// agent-discover — No-op embedding provider
//
// Returned when AGENT_DISCOVER_EMBEDDING_PROVIDER is unset or 'none'. Lets
// callers use the same EmbeddingProvider interface throughout the codebase
// without branching on whether semantic search is enabled — this provider
// just refuses to embed and reports unavailable, so saveToolsWithEmbeddings
// transparently falls back to BM25-only ranking.
// =============================================================================

import type { EmbeddingProvider } from './types.js';

export class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'none';
  readonly dimensions = 0;
  readonly model = 'none';

  async embed(): Promise<number[][]> {
    return [];
  }
  async embedOne(): Promise<number[]> {
    return [];
  }
  async isAvailable(): Promise<boolean> {
    return false;
  }
}
