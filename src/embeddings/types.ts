// =============================================================================
// agent-discover — Embedding provider interface
//
// All providers (none, local, openai, claude, gemini) implement this. Mirrors
// agent-knowledge's embedding subsystem so the env-var conventions and the
// switch-on-provider semantics stay identical across the agent-* family.
// =============================================================================

export interface EmbeddingProvider {
  /** Provider identifier — 'none' | 'local' | 'openai' | 'claude' | 'gemini'. */
  readonly name: string;
  /** Vector dimensions produced by this provider. */
  readonly dimensions: number;
  /** Model identifier (provider-specific string). */
  readonly model: string;
  /** Embed one or more texts. Returns one number[] per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
  /** Convenience wrapper for a single text. */
  embedOne(text: string): Promise<number[]>;
  /** True when the provider is usable (model loaded, API key valid, etc.). */
  isAvailable(): Promise<boolean>;
}

export type ProviderName = 'none' | 'local' | 'openai' | 'claude' | 'gemini';

export interface EmbeddingConfig {
  /** Which provider to use. 'none' disables semantic search entirely. */
  provider: ProviderName;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  geminiApiKey?: string;
  /** Override the provider's default model id. */
  modelOverride?: string;
}

/**
 * Read embedding configuration from environment variables.
 *
 * Default provider is 'none' — agent-discover ships disabled-by-default for
 * semantic search so existing installs without an embedding key keep working
 * with BM25-only ranking. Opt in by setting AGENT_DISCOVER_EMBEDDING_PROVIDER.
 *
 * Provider-specific API keys fall back to the generic env vars (OPENAI_API_KEY
 * etc.) when the prefixed AGENT_DISCOVER_* variants aren't set, so a user who
 * already has OPENAI_API_KEY exported just needs to flip the provider flag.
 */
export function getEmbeddingConfig(): EmbeddingConfig {
  return {
    provider: (process.env.AGENT_DISCOVER_EMBEDDING_PROVIDER as ProviderName) || 'none',
    openaiApiKey: process.env.AGENT_DISCOVER_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.AGENT_DISCOVER_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY,
    geminiApiKey: process.env.AGENT_DISCOVER_GEMINI_API_KEY || process.env.GEMINI_API_KEY,
    modelOverride: process.env.AGENT_DISCOVER_EMBEDDING_MODEL,
  };
}
