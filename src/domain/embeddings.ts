// =============================================================================
// agent-discover — Embeddings provider
//
// Generates dense vector representations of tool names + descriptions for
// semantic search. Uses OpenAI text-embedding-3-small (1536 dims) when an
// OPENAI_API_KEY is available; falls back to a no-op (BM25-only ranking
// stays the default behavior in that case).
//
// The provider is intentionally minimal — no abstractions, no plugin layer,
// no batching beyond the API's natural multi-input request. Adding more
// providers later (Cohere, local sentence-transformers, etc.) is a copy-and-
// modify rather than a framework decision.
// =============================================================================

const EMBEDDING_MODEL = process.env.AGENT_DISCOVER_EMBEDDING_MODEL ?? 'text-embedding-3-small';
const EMBEDDING_DIMS = 1536; // text-embedding-3-small native dimensionality
const OPENAI_API_BASE = process.env.OPENAI_API_BASE ?? 'https://api.openai.com/v1';

export type Embedding = Float32Array;

export interface EmbeddingProvider {
  enabled: boolean;
  model: string;
  /** Embed a batch of texts. Returns one Float32Array per input, in order. */
  embed(texts: string[]): Promise<Embedding[]>;
}

export function makeEmbeddingProvider(): EmbeddingProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      enabled: false,
      model: EMBEDDING_MODEL,
      async embed(texts: string[]): Promise<Embedding[]> {
        return texts.map(() => new Float32Array(EMBEDDING_DIMS));
      },
    };
  }
  return {
    enabled: true,
    model: EMBEDDING_MODEL,
    embed: (texts: string[]) => embedOpenAI(texts, apiKey),
  };
}

// OpenAI embeddings API supports up to ~2048 inputs per request and ~8191
// tokens per input. We chunk large batches into safe-sized requests.
const MAX_BATCH = 256;

async function embedOpenAI(texts: string[], apiKey: string): Promise<Embedding[]> {
  const out: Embedding[] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    const res = await fetch(`${OPENAI_API_BASE}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI embeddings failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
    // The API returns results in input-order, but be defensive: sort by index.
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    for (const row of sorted) {
      out.push(Float32Array.from(row.embedding));
    }
  }
  return out;
}

export function cosineSimilarity(a: Embedding, b: Embedding): number {
  if (a.length !== b.length) return 0;
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

export function encodeEmbedding(emb: Embedding): string {
  // Float32Array → base64 string. Compact (4 bytes per dim, base64-encoded
  // = ~5.3 bytes per dim), and SQLite TEXT-friendly.
  const buf = Buffer.from(emb.buffer, emb.byteOffset, emb.byteLength);
  return buf.toString('base64');
}

export function decodeEmbedding(encoded: string): Embedding {
  const buf = Buffer.from(encoded, 'base64');
  // Buffer's underlying ArrayBuffer may be a slice — pass the right offset+length.
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
