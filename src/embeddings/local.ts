// =============================================================================
// agent-discover — Local embedding provider
//
// Runs Xenova/all-MiniLM-L6-v2 (or any HF feature-extraction model) inside
// the agent-discover process via @huggingface/transformers. No API key, no
// network call after the initial model download. Default dimensions: 384.
//
// Loaded lazily so installs without @huggingface/transformers don't break —
// the import is dynamic, and isAvailable() returns false if the package or
// the model can't be loaded. Mirrors agent-knowledge's local provider so
// the same model is downloaded once and reused across both servers.
// =============================================================================

import type { EmbeddingProvider } from './types.js';

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
const DEFAULT_DIMENSIONS = 384;
const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_NUM_THREADS = 1;

type PipelineFn = (
  texts: string[],
  options: { pooling: string; normalize: boolean },
) => Promise<{ tolist(): number[][]; dispose?: () => void }>;

let _pipeline: PipelineFn | null = null;
let _pipelineLoading: Promise<PipelineFn | null> | null = null;
let _idleTimer: ReturnType<typeof setTimeout> | null = null;
let _idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;

const _numThreads = parseInt(
  process.env.AGENT_DISCOVER_EMBEDDING_THREADS ?? String(DEFAULT_NUM_THREADS),
  10,
);
process.env.ONNX_NUM_THREADS = String(_numThreads);
process.env.OMP_NUM_THREADS = String(_numThreads);

async function loadPipeline(model: string): Promise<PipelineFn | null> {
  try {
    process.stderr.write(
      `[agent-discover] Loading embedding model ${model} (q8, ${_numThreads} thread(s))...\n`,
    );
    // Indirect import so TypeScript doesn't require the optional
    // @huggingface/transformers package at compile time. The factory only
    // calls this provider when the user explicitly requests local embeddings.
    const moduleName = '@huggingface/transformers';
    const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<unknown>;
    const mod = (await dynamicImport(moduleName).catch(() => null)) as {
      pipeline?: unknown;
    } | null;
    if (!mod || typeof mod.pipeline !== 'function') {
      process.stderr.write(
        '[agent-discover] @huggingface/transformers not installed — local embeddings unavailable. ' +
          'Install with: npm install @huggingface/transformers\n',
      );
      return null;
    }
    const pipelineFn = mod.pipeline as (
      task: string,
      m: string,
      opts: Record<string, unknown>,
    ) => Promise<unknown>;
    const pipe = await pipelineFn('feature-extraction', model, {
      dtype: 'q8',
      session_options: {
        intraOpNumThreads: _numThreads,
        interOpNumThreads: _numThreads,
      },
    });
    if (!pipe || typeof pipe !== 'function') {
      throw new Error('failed to construct transformer pipeline');
    }
    process.stderr.write(`[agent-discover] Embedding model loaded\n`);
    return pipe as PipelineFn;
  } catch (err) {
    process.stderr.write(
      `[agent-discover] Failed to load embedding model ${model}: ${(err as Error).message}\n`,
    );
    return null;
  }
}

function resetIdleTimer(): void {
  if (_idleTimer) clearTimeout(_idleTimer);
  if (_idleTimeoutMs <= 0) return;
  _idleTimer = setTimeout(() => {
    if (_pipeline) {
      process.stderr.write('[agent-discover] Unloading embedding model (idle timeout)\n');
      _pipeline = null;
      _pipelineLoading = null;
    }
    _idleTimer = null;
  }, _idleTimeoutMs);
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local';
  readonly dimensions: number;
  readonly model: string;
  private readonly batchSize: number;

  constructor(modelOverride?: string, batchSize?: number, idleTimeoutMs?: number) {
    this.model = modelOverride || DEFAULT_MODEL;
    this.dimensions = DEFAULT_DIMENSIONS;
    this.batchSize = batchSize ?? DEFAULT_BATCH_SIZE;
    if (idleTimeoutMs !== undefined) _idleTimeoutMs = idleTimeoutMs;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const pipe = await this.getPipeline();
    if (!pipe) return texts.map(() => []);
    resetIdleTimer();
    const results: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      try {
        const output = await pipe(batch, { pooling: 'mean', normalize: true });
        results.push(...output.tolist());
      } catch (err) {
        process.stderr.write(
          `[agent-discover] embedding batch failed: ${(err as Error).message}\n`,
        );
        results.push(...batch.map(() => []));
      }
    }
    resetIdleTimer();
    return results;
  }

  async embedOne(text: string): Promise<number[]> {
    const r = await this.embed([text]);
    return r[0] ?? [];
  }

  async isAvailable(): Promise<boolean> {
    return (await this.getPipeline()) !== null;
  }

  private async getPipeline(): Promise<PipelineFn | null> {
    if (_pipeline) return _pipeline;
    if (!_pipelineLoading) {
      _pipelineLoading = loadPipeline(this.model).then((pipe) => {
        _pipeline = pipe;
        if (pipe) resetIdleTimer();
        return pipe;
      });
    }
    return _pipelineLoading;
  }
}
