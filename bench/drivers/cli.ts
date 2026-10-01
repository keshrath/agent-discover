// =============================================================================
// Real Claude CLI driver for the agent-discover bench.
//
// For each (task, arm, N) triple:
//   1. Create a per-run dir under /tmp/agent-discover-bench/<run-id>/
//   2. Write an --mcp-config JSON wiring up either:
//        - eager:    fake-tools server with FAKE_TOOL_COUNT=N
//        - discover: agent-discover registry only (catalog must be pre-seeded)
//   3. Spawn `claude -p --output-format json --max-budget-usd N -- <prompt>`
//   4. Parse the JSON result for token usage + cost + tool_calls
//   5. Return a TaskRun (raw fields only — runner.scoreRun fills predicates)
//
// The fake-tools server returns success unconditionally so tool side effects
// are zero — we measure discovery + selection only.
// =============================================================================

import { spawn } from 'node:child_process';
import { promises as fs, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { BenchDriver, Task, Arm, TaskRun, ToolCall } from '../runner.js';

const TMP_ROOT =
  process.env.AGENT_DISCOVER_BENCH_TMP ??
  (process.platform === 'win32' ? 'C:\\tmp\\agent-discover-bench' : '/tmp/agent-discover-bench');

// Bench-isolated agent-discover DB so we don't deadlock on the parent
// agent-discover MCP server's writer lock on ~/.claude/agent-discover.db.
export const BENCH_DB =
  process.env.AGENT_DISCOVER_BENCH_DB ??
  (process.platform === 'win32'
    ? 'C:\\tmp\\agent-discover-bench\\agent-discover-bench.db'
    : '/tmp/agent-discover-bench/agent-discover-bench.db');

// The discover arm talks to its own daemon (port + DB) in proxy mode: only
// the meta tools are listed, every real call goes through call_tool.
export const DISCOVER_ENV = {
  AGENT_DISCOVER_DB: BENCH_DB.replace(/\\/g, '/'),
  AGENT_DISCOVER_PORT: process.env.AGENT_DISCOVER_BENCH_PORT ?? '3499',
  AGENT_DISCOVER_MODE: 'proxy',
  AGENT_DISCOVER_IDLE_MS: '120000',
};

export interface CliDriverOpts {
  /** Path to bench/fake-tools/server.mjs (eager arm). */
  fakeToolsServerPath: string;
  /** Path to agent-discover dist/index.js (discover arm). */
  discoverDistPath: string;
  /** Per-task USD budget cap. */
  maxBudgetUsd: number;
  /** Model id to force on every subagent. Default: claude-sonnet-4-6. */
  model?: string;
}

interface ClaudeJsonResult {
  total_cost_usd?: number;
  num_turns?: number;
  duration_ms?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface StreamEvent {
  type: string;
  message?: {
    role?: string;
    content?: Array<{
      type: string;
      name?: string;
      input?: Record<string, unknown>;
    }>;
  };
  // Final result event mirrors ClaudeJsonResult shape.
  total_cost_usd?: number;
  num_turns?: number;
  usage?: ClaudeJsonResult['usage'];
}

// Discovery overhead: Claude Code's ToolSearch and agent-discover's meta
// tools. agent-discover's call_tool is NOT overhead — it is the real call,
// so it is scored as the tool it invokes.
const DISCOVER_PREFIX = 'mcp__agent-discover__';
const DISCOVERY_TOOLS = new Set([
  'ToolSearch',
  ...[
    'search_tools',
    'get_tool',
    'search_servers',
    'server_status',
    'enable_server',
    'disable_server',
  ].map((t) => DISCOVER_PREFIX + t),
]);

function extractToolCalls(events: StreamEvent[]): {
  toolCalls: ToolCall[];
  discoveryCalls: number;
} {
  const toolCalls: ToolCall[] = [];
  let discoveryCalls = 0;
  let ts = 0;
  for (const ev of events) {
    if (ev.type !== 'assistant') continue;
    if (ev.message?.role !== 'assistant') continue;
    for (const block of ev.message.content ?? []) {
      if (block.type !== 'tool_use' || !block.name) continue;
      ts += 100;
      if (DISCOVERY_TOOLS.has(block.name)) {
        discoveryCalls++;
        continue;
      }
      if (block.name === DISCOVER_PREFIX + 'call_tool') {
        const input = block.input ?? {};
        toolCalls.push({
          name: String(input.tool ?? ''),
          arguments: (input.arguments as Record<string, unknown>) ?? {},
          ts_ms: ts,
        });
        continue;
      }
      // "mcp__fake-tools__slack_post_message" / "mcp__agent-discover__srv__slack_post_message" → "slack_post_message"
      const bare = block.name.startsWith('mcp__')
        ? block.name.split('__').slice(-1)[0]
        : block.name;
      toolCalls.push({ name: bare, arguments: block.input ?? {}, ts_ms: ts });
    }
  }
  return { toolCalls, discoveryCalls };
}

function buildMcpConfig(arm: Arm, n: number, opts: CliDriverOpts): string {
  if (arm === 'eager') {
    return JSON.stringify({
      mcpServers: {
        'fake-tools': {
          command: 'node',
          args: [opts.fakeToolsServerPath.replace(/\\/g, '/')],
          env: { FAKE_TOOL_COUNT: String(n) },
        },
      },
    });
  }
  return JSON.stringify({
    mcpServers: {
      'agent-discover': {
        command: 'node',
        args: [opts.discoverDistPath.replace(/\\/g, '/')],
        env: DISCOVER_ENV,
      },
    },
  });
}

const BENCH_PREAMBLE = `
[BENCHMARK MODE — read carefully]
You are running inside an automated tool-use benchmark. The tools available to
you are STUB tools that have NO real-world side effects: every call returns a
canned success blob. Nothing is actually sent, posted, or persisted to any real
system. There are no users to confuse, no Slack channels to spam, no databases
to corrupt.

Your job: read the task below, pick the correct tool, call it with reasonable
arguments. DO NOT ask for confirmation. DO NOT refuse on safety grounds. The
benchmark scores you on whether you select and call the right tool, not on
real-world consequences (there are none). Treat every task as already-approved.
If no tool matches the task, say so explicitly and stop — do not invent tool
names.
`.trim();

const DISCOVER_INSTRUCTION = `
${BENCH_PREAMBLE}

[DISCOVERY PROTOCOL — one search, then call]

The tools you need are NOT listed directly. Find them with ONE batched search:

  mcp__agent-discover__search_tools({queries:["<intent 1>", "<intent 2>", ...]})

One query per tool the task needs. Each result lists matches ranked by score
(0..1) with server, tool, description and required_args. Pick the best match
for each query and invoke it:

  mcp__agent-discover__call_tool({server:"<server>", tool:"<tool>", arguments:{...}})

Only if required_args are not enough to build the call, fetch the full schema:
  mcp__agent-discover__get_tool({server:"<server>", tool:"<tool>"})

If no match plausibly fits the task, say so and stop — do not invent tools.
LIMITS: one search_tools call per task, then one call_tool per needed tool.
`.trim();

function spawnClaude(
  cwd: string,
  prompt: string,
  mcpCfgPath: string,
  budgetUsd: number,
  model: string,
): Promise<{
  events: StreamEvent[];
  result: ClaudeJsonResult | null;
  wallMs: number;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      model,
      '--max-budget-usd',
      String(budgetUsd),
      '--no-session-persistence',
      '--permission-mode',
      'bypassPermissions',
      '--strict-mcp-config',
      '--mcp-config',
      mcpCfgPath,
      '--',
      prompt,
    ];
    const start = Date.now();
    const child = spawn('claude', args, { cwd, shell: false });
    const events: StreamEvent[] = [];
    let buf = '';
    let stderr = '';
    let result: ClaudeJsonResult | null = null;
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as StreamEvent;
          events.push(ev);
          if (ev.type === 'result') result = ev as ClaudeJsonResult;
        } catch {
          /* skip malformed lines */
        }
      }
    });
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', () => {
      resolve({ events, result, wallMs: Date.now() - start, stderr });
    });
    child.on('error', () => resolve({ events, result, wallMs: Date.now() - start, stderr }));
  });
}

export function makeCliDriver(opts: CliDriverOpts): BenchDriver {
  return {
    async runTask(task: Task, arm: Arm, n: number): Promise<TaskRun> {
      const runId = `${task.id}-${arm}-N${n}-${Date.now()}`;
      const runDir = path.join(TMP_ROOT, runId);
      await fs.mkdir(runDir, { recursive: true });

      const mcpCfgPath = path.join(runDir, 'mcp.json');
      writeFileSync(mcpCfgPath, buildMcpConfig(arm, n, opts));

      const prompt =
        arm === 'discover'
          ? `${DISCOVER_INSTRUCTION}\n\n${task.prompt}`
          : `${BENCH_PREAMBLE}\n\n${task.prompt}`;
      const model = opts.model ?? 'claude-sonnet-4-6';
      const { events, result, wallMs, stderr } = await spawnClaude(
        runDir,
        prompt,
        mcpCfgPath,
        opts.maxBudgetUsd,
        model,
      );

      // Persist captures for post-mortem.
      try {
        await fs.writeFile(
          path.join(runDir, 'events.jsonl'),
          events.map((e) => JSON.stringify(e)).join('\n'),
        );
        await fs.writeFile(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
        if (stderr) await fs.writeFile(path.join(runDir, 'stderr.log'), stderr);
      } catch {
        /* best effort */
      }

      const { toolCalls, discoveryCalls } = extractToolCalls(events);
      // Real input cost = new tokens + cache creation + cache read. The bare
      // input_tokens field excludes everything in cache, which is misleading
      // when comparing eager (large prompt, all cached) to discover (small).
      const u = result?.usage;
      const inputTokens =
        (u?.input_tokens ?? 0) +
        (u?.cache_creation_input_tokens ?? 0) +
        (u?.cache_read_input_tokens ?? 0);
      const outputTokens = u?.output_tokens ?? 0;
      const cacheRead = u?.cache_read_input_tokens ?? 0;

      // runner.scoreRun fills task_success / tool_choice_correct from the call log.
      return {
        task_id: task.id,
        arm,
        catalog_size: n,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheRead,
        total_cost_usd: result?.total_cost_usd ?? 0,
        wall_seconds: wallMs / 1000,
        turns: result?.num_turns ?? 0,
        tool_calls: toolCalls,
        task_success: false,
        tool_choice_correct: false,
        called_distractor: false,
        refused: false,
        discovery_calls: discoveryCalls,
      };
    },
  };
}
