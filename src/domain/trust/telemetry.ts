// =============================================================================
// agent-discover — OpenTelemetry (opt-in)
//
// Off unless OTEL_EXPORTER_OTLP_ENDPOINT or AGENT_DISCOVER_OTEL=1 is set; then
// @opentelemetry/api + sdk-node (optional deps) are imported lazily and the
// SDK configures exporters from the standard OTEL_* env. When off, the no-op
// implementation costs one function call per tools/call.
//
// Spans follow the MCP semantic conventions (semconv gen-ai, mcp.md):
//   SERVER  "tools/call <tool>" for incoming calls (mcp.method.name,
//           gen_ai.tool.name, gen_ai.operation.name=execute_tool,
//           jsonrpc.request.id, mcp.protocol.version, error.type)
//   CLIENT  "tools/call <tool>" for the upstream hop (+ network.transport,
//           server.address/server.port for remote upstreams)
// W3C trace context rides in params._meta.traceparent/tracestate (SEP-414):
// extracted from incoming calls, injected into upstream calls.
// Metrics: mcp.server.operation.duration / mcp.client.operation.duration (s).
// =============================================================================

import type * as OtelApi from '@opentelemetry/api';

export interface ServerCallInfo {
  tool: string;
  requestId?: string | number;
  protocolVersion?: string;
  /** Incoming params._meta (traceparent / tracestate). */
  meta?: Record<string, unknown>;
}

export interface ClientCallInfo {
  server: string;
  tool: string;
  transport: string;
  url?: string | null;
}

type Meta = Record<string, string>;

export interface Telemetry {
  readonly enabled: boolean;
  serverCall<T>(info: ServerCallInfo, fn: () => Promise<T>): Promise<T>;
  /** `fn` receives the _meta (traceparent/tracestate) to send upstream. */
  clientCall<T>(info: ClientCallInfo, fn: (meta: Meta) => Promise<T>): Promise<T>;
  shutdown(): Promise<void>;
}

export const NOOP_TELEMETRY: Telemetry = {
  enabled: false,
  serverCall: (_info, fn) => fn(),
  clientCall: (_info, fn) => fn({}),
  shutdown: async () => {},
};

export function telemetryRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT) || env.AGENT_DISCOVER_OTEL === '1';
}

function errorType(result: unknown): string | undefined {
  return result && typeof result === 'object' && (result as { isError?: unknown }).isError === true
    ? 'tool_error'
    : undefined;
}

function metaCarrier(meta: Record<string, unknown> | undefined): Meta {
  const out: Meta = {};
  for (const key of ['traceparent', 'tracestate']) {
    const v = meta?.[key];
    if (typeof v === 'string') out[key] = v;
  }
  return out;
}

/** Build a Telemetry over the (already registered) global OTel API. */
export function createTelemetry(
  api: typeof OtelApi,
  version: string,
  shutdown: () => Promise<void> = async () => {},
): Telemetry {
  const tracer = api.trace.getTracer('agent-discover', version);
  const meter = api.metrics.getMeter('agent-discover', version);
  const histogram = (name: string, description: string) =>
    meter.createHistogram(name, {
      unit: 's',
      description,
      advice: {
        explicitBucketBoundaries: [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300],
      },
    });
  const serverDuration = histogram(
    'mcp.server.operation.duration',
    'Duration of MCP requests handled by agent-discover',
  );
  const clientDuration = histogram(
    'mcp.client.operation.duration',
    'Duration of MCP requests agent-discover sent upstream',
  );

  async function run<T>(
    span: OtelApi.Span,
    ctx: OtelApi.Context,
    attrs: OtelApi.Attributes,
    record: OtelApi.Histogram,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = performance.now();
    let error: string | undefined;
    try {
      const result = await api.context.with(ctx, fn);
      error = errorType(result);
      return result;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      error = typeof code === 'string' ? code : err instanceof Error ? err.name : 'Error';
      span.recordException(err instanceof Error ? err : String(err));
      throw err;
    } finally {
      if (error) {
        span.setAttribute('error.type', error);
        span.setStatus({ code: api.SpanStatusCode.ERROR });
      }
      span.end();
      record.record((performance.now() - start) / 1000, {
        ...attrs,
        ...(error ? { 'error.type': error } : {}),
      });
    }
  }

  return {
    enabled: true,
    serverCall(info, fn) {
      const parent = api.propagation.extract(api.ROOT_CONTEXT, metaCarrier(info.meta));
      const attrs: OtelApi.Attributes = {
        'mcp.method.name': 'tools/call',
        'gen_ai.tool.name': info.tool,
        'gen_ai.operation.name': 'execute_tool',
        ...(info.protocolVersion ? { 'mcp.protocol.version': info.protocolVersion } : {}),
      };
      const span = tracer.startSpan(
        `tools/call ${info.tool}`,
        {
          kind: api.SpanKind.SERVER,
          attributes: {
            ...attrs,
            ...(info.requestId !== undefined
              ? { 'jsonrpc.request.id': String(info.requestId) }
              : {}),
          },
        },
        parent,
      );
      return run(span, api.trace.setSpan(parent, span), attrs, serverDuration, fn);
    },
    clientCall(info, fn) {
      const parent = api.context.active();
      let address: OtelApi.Attributes = {};
      if (info.url) {
        const u = new URL(info.url);
        address = {
          'server.address': u.hostname,
          'server.port': Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
        };
      }
      const attrs: OtelApi.Attributes = {
        'mcp.method.name': 'tools/call',
        'gen_ai.tool.name': info.tool,
        'gen_ai.operation.name': 'execute_tool',
      };
      const span = tracer.startSpan(
        `tools/call ${info.tool}`,
        {
          kind: api.SpanKind.CLIENT,
          attributes: {
            ...attrs,
            ...address,
            'network.transport': info.transport === 'stdio' ? 'pipe' : 'tcp',
            'agent_discover.upstream': info.server,
          },
        },
        parent,
      );
      const ctx = api.trace.setSpan(parent, span);
      const meta: Meta = {};
      api.propagation.inject(ctx, meta);
      return run(span, ctx, attrs, clientDuration, () => fn(meta));
    },
    shutdown,
  };
}

export interface TelemetryOverrides {
  /** Extra NodeSDK configuration (tests pass in-memory span processors / metric readers). */
  sdk?: Record<string, unknown>;
}

/** Start the OTel SDK when requested by env; otherwise the no-op. */
export async function loadTelemetry(
  version: string,
  env: NodeJS.ProcessEnv = process.env,
  overrides: TelemetryOverrides = {},
): Promise<Telemetry> {
  if (!telemetryRequested(env)) return NOOP_TELEMETRY;
  try {
    const api = await import('@opentelemetry/api');
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const sdk = new NodeSDK({ serviceName: 'agent-discover', ...overrides.sdk });
    sdk.start();
    process.stderr.write('[agent-discover] OpenTelemetry enabled\n');
    return createTelemetry(api, version, () => sdk.shutdown());
  } catch (err) {
    process.stderr.write(
      `[agent-discover] OpenTelemetry requested but unavailable (${err instanceof Error ? err.message : String(err)}); install @opentelemetry/api and @opentelemetry/sdk-node\n`,
    );
    return NOOP_TELEMETRY;
  }
}
