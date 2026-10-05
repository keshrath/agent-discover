// agent-discover — No-op embedding provider: the default, lexical search only.

import type { EmbeddingProvider } from './types.js';

export class NoopEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'none';
  readonly model = 'none';

  async embed(): Promise<number[][]> {
    return [];
  }
}
