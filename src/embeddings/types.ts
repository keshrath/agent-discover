// =============================================================================
// agent-discover — Embedding provider interface
//
// Retrieval models embed queries and documents differently (instruction or
// "query:"/"passage:" prefixes), so callers say which side they embed.
// =============================================================================

export type EmbedKind = 'query' | 'document';

export interface EmbeddingProvider {
  /** Provider identifier — 'none' | 'local' | 'openai'. */
  readonly name: string;
  /** Model identifier; stored vectors are only compared within one model. */
  readonly model: string;
  /** One vector per input, in order (empty vector where embedding failed). */
  embed(texts: string[], kind: EmbedKind): Promise<number[][]>;
}

export type ProviderName = 'none' | 'local' | 'openai';

export interface EmbeddingConfig {
  /** 'none' (default) disables semantic search. */
  provider: ProviderName;
  openaiApiKey?: string;
  /** Override the provider's default model id. */
  modelOverride?: string;
}

/**
 * AGENT_DISCOVER_EMBEDDING_PROVIDER selects the provider (default 'none':
 * lexical search only, no download, no key). AGENT_DISCOVER_EMBEDDING_MODEL
 * overrides the model; the OpenAI key falls back to OPENAI_API_KEY.
 */
export function getEmbeddingConfig(env = process.env): EmbeddingConfig {
  return {
    provider: (env.AGENT_DISCOVER_EMBEDDING_PROVIDER as ProviderName) || 'none',
    openaiApiKey: env.AGENT_DISCOVER_OPENAI_API_KEY || env.OPENAI_API_KEY,
    modelOverride: env.AGENT_DISCOVER_EMBEDDING_MODEL,
  };
}
