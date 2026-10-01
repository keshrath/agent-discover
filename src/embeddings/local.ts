// =============================================================================
// agent-discover — Local embedding provider
//
// Runs an ONNX feature-extraction model in-process via @huggingface/transformers
// (optional dependency: `npm install @huggingface/transformers`). No API key;
// one model download on first use, then fully offline.
//
// Retrieval models need model-specific query/document formatting and pooling,
// so known models carry a preset. Default: multilingual-e5-small — the best
// quality/size trade-off on the retrieval bench (bench/retrieval/README.md),
// and multilingual, so non-English queries match English tool metadata.
// =============================================================================

import type { EmbedKind, EmbeddingProvider } from './types.js';

interface Preset {
  readonly query: string;
  readonly document: string;
  readonly pooling: 'mean' | 'cls' | 'last_token';
}

export const DEFAULT_LOCAL_MODEL = 'Xenova/multilingual-e5-small';

const PRESETS: Record<string, Preset> = {
  'Xenova/multilingual-e5-small': { query: 'query: ', document: 'passage: ', pooling: 'mean' },
  'Xenova/bge-small-en-v1.5': {
    query: 'Represent this sentence for searching relevant passages: ',
    document: '',
    pooling: 'cls',
  },
  'onnx-community/Qwen3-Embedding-0.6B-ONNX': {
    query: 'Instruct: Given a user request, retrieve the tool that fulfils it\nQuery: ',
    document: '',
    pooling: 'last_token',
  },
  'Xenova/all-MiniLM-L6-v2': { query: '', document: '', pooling: 'mean' },
};
const GENERIC: Preset = { query: '', document: '', pooling: 'mean' };

const BATCH_SIZE = 16;

type PipelineFn = (
  texts: string[],
  options: { pooling: string; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

async function loadPipeline(model: string, threads: number): Promise<PipelineFn | null> {
  try {
    // Indirect import: the package is optional and absent from the type graph.
    const moduleName = '@huggingface/transformers';
    const mod = (await import(moduleName).catch(() => null)) as {
      pipeline?: (task: string, m: string, o: Record<string, unknown>) => Promise<unknown>;
    } | null;
    if (!mod?.pipeline) {
      process.stderr.write(
        '[agent-discover] local embeddings need @huggingface/transformers (npm install @huggingface/transformers)\n',
      );
      return null;
    }
    process.stderr.write(`[agent-discover] loading embedding model ${model} (q8)\n`);
    return (await mod.pipeline('feature-extraction', model, {
      dtype: 'q8',
      session_options: { intraOpNumThreads: threads, interOpNumThreads: threads },
    })) as PipelineFn;
  } catch (err) {
    process.stderr.write(
      `[agent-discover] failed to load embedding model ${model}: ${(err as Error).message}\n`,
    );
    return null;
  }
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local';
  readonly model: string;
  private readonly preset: Preset;
  private pipeline: Promise<PipelineFn | null> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    model = DEFAULT_LOCAL_MODEL,
    private readonly idleMs = 60_000,
    private readonly threads = 1,
  ) {
    this.model = model;
    this.preset = PRESETS[model] ?? GENERIC;
  }

  /** Loads the model; false when the package or the model is unavailable. */
  async load(): Promise<boolean> {
    this.pipeline ??= loadPipeline(this.model, this.threads);
    return (await this.pipeline) !== null;
  }

  async embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
    if (!(await this.load())) return texts.map(() => []);
    const pipe = (await this.pipeline)!;
    const prefix = kind === 'query' ? this.preset.query : this.preset.document;
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE).map((t) => prefix + t);
      try {
        const res = await pipe(batch, { pooling: this.preset.pooling, normalize: true });
        out.push(...res.tolist());
      } catch (err) {
        process.stderr.write(
          `[agent-discover] embedding batch failed: ${(err as Error).message}\n`,
        );
        out.push(...batch.map(() => []));
      }
    }
    this.armIdleUnload();
    return out;
  }

  private armIdleUnload(): void {
    if (this.idleMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.pipeline = null;
      this.idleTimer = null;
    }, this.idleMs);
    this.idleTimer.unref();
  }
}
