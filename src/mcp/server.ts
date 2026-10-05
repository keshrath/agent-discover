// =============================================================================
// agent-discover — MCP server factory
//
// Builds one low-level SDK `Server` per HTTP request (2026-07-28) or per
// legacy session (2025). All instances share the AppContext, so state is
// single-sourced in the daemon. The low-level API fits a gateway: tools/list
// is computed from the DB per request (deterministic order), and upstream
// schemas are advertised verbatim without per-request conversion.
// =============================================================================

import { randomBytes, randomUUID } from 'node:crypto';
import {
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  Server,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  isInputRequiredResult,
  type CallToolResult,
  type InputRequiredResult,
  type InputResponses,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/server';
import type { AppContext } from '../context.js';
import { splitToolName } from '../domain/lifecycle.js';
import type { ElicitationAnswer, ElicitationContent } from '../domain/pool.js';
import { AuthRequiredError } from '../domain/oauth.js';
import { readPackageMeta } from '../package-meta.js';
import {
  META_TOOLS,
  META_TOOL_DEFS,
  clientCanElicit,
  exposedName,
  runMetaTool,
  type McpRuntime,
  type McpState,
  type MetaToolName,
} from './tools.js';
import { PROMPTS, getPrompt } from './prompts.js';
import { WIDGET_MIME, WIDGET_URI, widgetHtml } from '../widgets/resources.js';

const INSTRUCTIONS = `agent-discover is an MCP gateway: it installs other MCP servers, indexes their tools and proxies calls.
- Need a capability you don't see? search_tools({queries:[...]}) searches every installed server's tools, enabled or not.
- Exposed tools appear as <server>__<tool>; call them directly. Others: call_tool({server, tool, arguments}) or enable_server first.
- Nothing installed fits? search_servers, then install_server (the user confirms the command).
- server_status shows what is installed, enabled and connected.`;

/** How long an upstream call waits for the downstream to answer its question. */
const PARK_TTL_MS = 2 * 60_000;
/** How long a retry after URL-mode sign-in waits for the OAuth callback. */
const SIGN_IN_WAIT_MS = 5 * 60_000;

interface Question {
  message: string;
  requestedSchema: Record<string, unknown>;
  answer(answer: ElicitationAnswer): void;
}

interface RunningCall {
  server: string;
  tool: string;
  /** The downstream round currently waiting on this call (progress goes there). */
  ctx: ServerContext;
  abort: AbortController;
  questions: ReturnType<typeof queue<Question>>;
  result: Promise<CallToolResult | InputRequiredResult | AuthRequiredError>;
}

interface ParkedCall {
  run: RunningCall;
  question: Question;
  timer: NodeJS.Timeout;
}

function queue<T>() {
  const items: T[] = [];
  let waiter: ((item: T) => void) | null = null;
  return {
    push(item: T) {
      if (!waiter) return void items.push(item);
      const w = waiter;
      waiter = null;
      w(item);
    },
    next(): Promise<T> {
      if (items.length) return Promise.resolve(items.shift() as T);
      return new Promise((resolve) => (waiter = resolve));
    },
  };
}

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

export interface McpFactory {
  build(): Server;
}

const WIDGET_RESOURCE = {
  uri: WIDGET_URI,
  name: 'agent-discover-app',
  title: 'agent-discover',
  description: 'MCP Apps view for agent-discover tool results (search, status, install, tester)',
  mimeType: WIDGET_MIME,
};

export function createMcpFactory(app: AppContext): McpFactory {
  const info = readPackageMeta();
  // Single daemon process serves every MRTR round, so a per-process key works.
  const codec = createRequestStateCodec<McpState>({ key: randomBytes(32), ttlSeconds: 600 });

  const exposedTools = (): Tool[] => {
    if (app.config.mode !== 'native') return [];
    return app.index.listEnabled().map((t) => ({
      name: exposedName(t.server, t.name),
      ...(t.title ? { title: t.title } : {}),
      description: `[${t.server}] ${app.trust.cleanToolDescription(t.description)}`,
      inputSchema: t.input_schema as Tool['inputSchema'],
      ...(t.output_schema ? { outputSchema: t.output_schema as Tool['outputSchema'] } : {}),
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }));
  };

  // Upstream calls parked on an elicitation/create push (2025 upstreams), by id.
  const parked = new Map<string, ParkedCall>();

  function startCall(
    server: Server,
    serverName: string,
    tool: string,
    args: Record<string, unknown> | undefined,
    ctx: ServerContext,
  ): RunningCall {
    const state = ctx.mcpReq.requestState<McpState>();
    const upstream =
      state?.kind === 'upstream' && state.server === serverName && state.tool === tool
        ? state
        : undefined;
    const questions = queue<Question>();
    const abort = new AbortController();
    const progressToken = ctx.mcpReq._meta?.progressToken;
    const run: RunningCall = {
      server: serverName,
      tool,
      ctx,
      abort,
      questions,
      result: app.lifecycle
        .callTool(serverName, tool, args, {
          signal: abort.signal,
          inputResponses: upstream ? (ctx.mcpReq.inputResponses as InputResponses) : undefined,
          requestState: upstream?.state,
          // A 2026 downstream answers through an MRTR round, a 2025 one through the SDK's
          // legacy shim; without elicitation support the pane's queue answers.
          onElicit: clientCanElicit(server, ctx)
            ? (q) => new Promise((answer) => questions.push({ ...q, answer }))
            : undefined,
          onprogress: (p) => {
            if (progressToken === undefined) return;
            void run.ctx.mcpReq.notify({
              method: 'notifications/progress',
              params: { ...p, progressToken },
            });
          },
        })
        .catch((err: unknown) =>
          err instanceof AuthRequiredError
            ? err
            : errorResult(err instanceof Error ? err.message : String(err)),
        ),
    };
    return run;
  }

  /** Wait for the call's result or its next upstream question, whichever comes first. */
  /** Hand the authorization URL to a client that can open it (URL-mode elicitation). */
  async function signIn(
    server: Server,
    err: AuthRequiredError,
    run: RunningCall,
    ctx: ServerContext,
  ): Promise<CallToolResult | InputRequiredResult> {
    if (!clientCanElicit(server, ctx, 'url')) return errorResult(err.message);
    return inputRequired({
      inputRequests: {
        signin: inputRequired.elicitUrl({
          message: `Sign in to "${err.server}" so agent-discover can call it.`,
          url: err.authorizeUrl,
        }),
      },
      requestState: await codec.mint({ kind: 'auth', server: run.server, tool: run.tool }, ctx),
    });
  }

  async function relay(
    server: Server,
    run: RunningCall,
    ctx: ServerContext,
  ): Promise<CallToolResult | InputRequiredResult> {
    run.ctx = ctx;
    const onAbort = () => run.abort.abort();
    ctx.mcpReq.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const next = await Promise.race([
        run.result.then((result) => ({ result })),
        run.questions.next().then((question) => ({ question })),
      ]);
      if ('result' in next) {
        const { result } = next;
        if (result instanceof AuthRequiredError) return signIn(server, result, run, ctx);
        if (!isInputRequiredResult(result)) return result;
        return {
          ...result,
          requestState: await codec.mint(
            { kind: 'upstream', server: run.server, tool: run.tool, state: result.requestState },
            ctx,
          ),
        };
      }
      const { question } = next;
      const id = randomUUID();
      const timer = setTimeout(() => {
        if (parked.delete(id)) question.answer({ action: 'cancel' });
      }, PARK_TTL_MS);
      timer.unref();
      parked.set(id, { run, question, timer });
      return inputRequired({
        inputRequests: {
          elicit: inputRequired.elicit({
            message: question.message,
            requestedSchema: question.requestedSchema as never,
          }),
        },
        requestState: await codec.mint({ kind: 'parked', id }, ctx),
      });
    } finally {
      ctx.mcpReq.signal.removeEventListener('abort', onAbort);
    }
  }

  async function forward(
    server: Server,
    serverName: string,
    tool: string,
    args: Record<string, unknown> | undefined,
    ctx: ServerContext,
  ): Promise<CallToolResult | InputRequiredResult> {
    const state = ctx.mcpReq.requestState<McpState>();
    if (state?.kind === 'auth' && state.server === serverName && state.tool === tool) {
      const answer = inputResponse(ctx.mcpReq.inputResponses, 'signin');
      if (answer.kind !== 'elicit' || answer.action !== 'accept') {
        return errorResult(`Sign-in to "${serverName}" was declined.`);
      }
      const done =
        !app.oauth.authorizeUrl(serverName) ||
        (await app.oauth.waitForAuthorization(serverName, SIGN_IN_WAIT_MS, ctx.mcpReq.signal));
      if (!done) return errorResult(`Sign-in to "${serverName}" did not complete; retry the call.`);
    }
    if (state?.kind !== 'parked') {
      return relay(server, startCall(server, serverName, tool, args, ctx), ctx);
    }
    const entry = parked.get(state.id);
    if (!entry || entry.run.server !== serverName || entry.run.tool !== tool) {
      return errorResult('The upstream question expired; call the tool again.');
    }
    parked.delete(state.id);
    clearTimeout(entry.timer);
    const response = inputResponse(ctx.mcpReq.inputResponses, 'elicit');
    entry.question.answer(
      response.kind === 'elicit'
        ? {
            action: response.action,
            ...(response.content ? { content: response.content as ElicitationContent } : {}),
          }
        : { action: 'cancel' },
    );
    return relay(server, entry.run, ctx);
  }

  return {
    build() {
      const server = new Server(
        { name: info.name, version: info.version },
        {
          capabilities: {
            tools: { listChanged: true },
            prompts: { listChanged: false },
            resources: { listChanged: false },
          },
          instructions: INSTRUCTIONS,
          cacheHints: {
            'tools/list': { ttlMs: 0, cacheScope: 'private' },
            'resources/read': { ttlMs: 3_600_000, cacheScope: 'private' },
          },
          requestState: { verify: codec.verify },
          inputRequired: { maxRounds: 8 },
        },
      );
      const rt: McpRuntime = {
        app,
        server,
        mint: (s, ctx) => codec.mint(s, ctx),
        forward: (name, tool, args, ctx) => forward(server, name, tool, args, ctx),
      };
      const allTools = () =>
        [...META_TOOL_DEFS, ...exposedTools()].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        );

      server.setRequestHandler('tools/list', () => ({ tools: allTools() }));
      server.setRequestHandler('tools/call', (req, ctx) => {
        const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
        const protocolVersion = envelope?.[PROTOCOL_VERSION_META_KEY];
        return app.trust.telemetry.serverCall(
          {
            tool: req.params.name,
            requestId: ctx.mcpReq.id,
            protocolVersion:
              typeof protocolVersion === 'string'
                ? protocolVersion
                : server.getNegotiatedProtocolVersion(),
            meta: ctx.mcpReq._meta as Record<string, unknown> | undefined,
          },
          () => callTool(req.params.name, req.params.arguments, ctx),
        );
      });
      const callTool = async (
        name: string,
        args: Record<string, unknown> | undefined,
        ctx: ServerContext,
      ) => {
        if (name in META_TOOLS) {
          const result = await runMetaTool(rt, name as MetaToolName, args, ctx);
          if (isInputRequiredResult(result)) return result;
          const def = META_TOOL_DEFS.find((t) => t.name === name);
          return server.projectCallToolResult(result, def?.outputSchema);
        }
        const parsed = splitToolName(name);
        const def =
          parsed && app.config.mode === 'native' ? app.index.get(parsed.server, parsed.tool) : null;
        if (!parsed || !def || !app.servers.get(parsed.server)?.enabled) {
          throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown tool: ${name}`);
        }
        const result = await rt.forward(parsed.server, parsed.tool, args, ctx);
        if (isInputRequiredResult(result)) return result;
        return server.projectCallToolResult(result, def.output_schema ?? undefined);
      };
      server.setRequestHandler('resources/list', () => ({ resources: [WIDGET_RESOURCE] }));
      server.setRequestHandler('resources/read', (req) => {
        if (req.params.uri !== WIDGET_URI) throw new ResourceNotFoundError(req.params.uri);
        return { contents: [{ uri: WIDGET_URI, mimeType: WIDGET_MIME, text: widgetHtml() }] };
      });
      server.setRequestHandler('prompts/list', () => ({ prompts: PROMPTS }));
      server.setRequestHandler('prompts/get', (req) =>
        getPrompt(req.params.name, req.params.arguments),
      );
      return server;
    },
  };
}
