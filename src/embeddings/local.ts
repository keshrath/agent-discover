// =============================================================================
// agent-discover — Local embedding provider
//
// Runs an ONNX feature-extraction model in-process via @huggingface/transformers
// (optional dependency: `npm install @huggingface/transformers`). No API key;
// one model download on first use, then fully offline.
//
// Default: multilingual-e5-small (~130 MB, q8) — the model measured on the
// retrieval bench (bench/retrieval/README.md); multilingual, so German queries
// match English tool metadata. It gets its trained "query: " / "passage: "
// prefixes; any other model id (AGENT_DISCOVER_EMBEDDING_MODEL) runs
// unprefixed with mean pooling.
// =============================================================================

import type { EmbedKind, EmbeddingProvider } from './types.js';

export const DEFAULT_LOCAL_MODEL = 'Xenova/multilingual-e5-small';

/** Input prefixes per side; e5 is trained with "query: " / "passage: ". */
type Prefixes = Record<EmbedKind, string>;
const E5: Prefixes = { query: 'query: ', document: 'passage: ' };
const NONE: Prefixes = { query: '', document: '' };

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
  private readonly prefixes: Prefixes;
  private pipeline: Promise<PipelineFn | null> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    model = DEFAULT_LOCAL_MODEL,
    private readonly idleMs = 60_000,
    private readonly threads = 1,
  ) {
    this.model = model;
    this.prefixes = model === DEFAULT_LOCAL_MODEL ? E5 : NONE;
  }

  /** Loads the model; false when the package or the model is unavailable. */
  async load(): Promise<boolean> {
    this.pipeline ??= loadPipeline(this.model, this.threads);
    return (await this.pipeline) !== null;
  }

  async embed(texts: string[], kind: EmbedKind): Promise<number[][]> {
    if (!(await this.load())) return texts.map(() => []);
    const pipe = (await this.pipeline)!;
    const prefix = this.prefixes[kind];
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE).map((t) => prefix + t);
      try {
        const res = await pipe(batch, { pooling: 'mean', normalize: true });
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
