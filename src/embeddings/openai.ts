// =============================================================================
// agent-discover — OpenAI embedding provider
//
// Wraps the OpenAI embeddings REST API. Default model is
// text-embedding-3-small — same as agent-knowledge so the two
// servers can share an embeddings DB if you want to. No SDK dependency,
// just native fetch.
// =============================================================================

import type { EmbeddingProvider } from './types.js';

const DEFAULT_MODEL = 'text-embedding-3-small';
const MAX_BATCH = 256;
const ENDPOINT = process.env.OPENAI_API_BASE
  ? `${process.env.OPENAI_API_BASE}/embeddings`
  : 'https://api.openai.com/v1/embeddings';

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly model: string;
  private readonly apiKey: string;

  constructor(apiKey: string, modelOverride?: string) {
    this.apiKey = apiKey;
    this.model = modelOverride || DEFAULT_MODEL;
  }

  /** OpenAI embedding models are symmetric: queries and documents embed alike. */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const batch = texts.slice(i, i + MAX_BATCH);
      out.push(...(await this.requestBatch(batch)));
    }
    return out;
  }

  private async requestBatch(texts: string[]): Promise<number[][]> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI embeddings HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
    const sorted = [...json.data].sort((a, b) => a.index - b.index);
    return sorted.map((d) => d.embedding);
  }
}
