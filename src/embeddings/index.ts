// =============================================================================
// agent-discover — Embeddings module barrel + shared math/encoding helpers
// =============================================================================

export type { EmbeddingProvider, EmbeddingConfig, ProviderName } from './types.js';
export { getEmbeddingConfig } from './types.js';
export { getEmbeddingProvider, resetProvider } from './factory.js';
export { NoopEmbeddingProvider } from './none.js';
export { OpenAIEmbeddingProvider } from './openai.js';
export { LocalEmbeddingProvider } from './local.js';

export type Embedding = Float32Array;

export function cosineSimilarity(a: Embedding, b: Embedding): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Encode a Float32Array as base64 for SQLite TEXT storage. Compact (~5.3
 * bytes per dim) and round-trips losslessly via decodeEmbedding.
 */
export function encodeEmbedding(emb: Embedding | number[]): string {
  const f32 = emb instanceof Float32Array ? emb : Float32Array.from(emb);
  const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
  return buf.toString('base64');
}

export function decodeEmbedding(encoded: string): Embedding {
  const buf = Buffer.from(encoded, 'base64');
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
