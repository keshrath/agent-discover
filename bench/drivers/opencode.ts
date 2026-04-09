// =============================================================================
// OpenCode CLI driver for the agent-discover bench.
//
// Why this driver exists: the Claude Code driver in cli.ts measures
// agent-discover against an "eager" arm that ISN'T actually eager — Claude
// Code's harness has built-in MCP Tool Search that auto-defers tool catalogs
// above ~10% of context, transparently turning the eager arm into a
// deferred-discovery arm. This makes the bench under-measure agent-discover's
// value for agents that don't have a built-in equivalent.
//
// OpenCode (https://opencode.ai) is a smaller open-source CLI agent that
// loads MCP tools eagerly with no built-in defer system. Running the bench
// against OpenCode + an OpenAI model gives us the unconfounded
// "true eager vs agent-discover" comparison the original hypothesis wanted.
//
// Per-task layout:
//   /tmp/agent-discover-bench/<run-id>/
//     opencode.json        — per-run config registering only the bench MCP server
//     events.jsonl         — captured event stream
//     result.json          — final aggregated result blob
//
// Spawn: opencode run --dir <runDir> --format json -m <model> "<prompt>"
//
// Auth: reads OPENAI_API_KEY from process.env. Never written to disk.
// =============================================================================

import { spawn } from 'node:child_process';
import { promises as fs, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import type { BenchDriver, Task, Arm, TaskRun, ToolCall } from '../runner.js';

const TMP_ROOT =
  process.env.AGENT_DISCOVER_BENCH_TMP ??
  (process.platform === 'win32' ? 'C:\\tmp\\agent-discover-bench' : '/tmp/agent-discover-bench');

const BENCH_DB =
  process.env.AGENT_DISCOVER_BENCH_DB ??
  (process.platform === 'win32'
    ? 'C:\\tmp\\agent-discover-bench\\agent-discover-bench.db'
    : '/tmp/agent-discover-bench/agent-discover-bench.db');

export interface OpencodeDriverOpts {
  fakeToolsServerPath: string;
  discoverDistPath: string;
  /** OpenCode model id, e.g. "openai/gpt-5-mini". Default: openai/gpt-5-mini. */
  model?: string;
  /** Per-task budget cap in USD. Soft cap — opencode does not enforce; we
   *  abandon a task if cumulative cost exceeds this in the captured stream. */
  maxBudgetUsd: number;
}

interface OpencodeStepFinish {
  type: 'step_finish';
  part: {
    type: 'step-finish';
    reason: string;
    cost: number;
    tokens: {
      total: number;
      input: number;
      output: number;
      reasoning: number;
      cache: { read: number; write: number };
    };
  };
}

interface OpencodeToolUse {
  type: 'tool_use';
  part: {
    type: 'tool';
    tool: string;
    state: {
      status: string;
      input: Record<string, unknown>;
      output: string;
    };
  };
}

interface OpencodeText {
  type: 'text';
  part: { type: 'text'; text: string };
}

type OpencodeEvent = OpencodeStepFinish | OpencodeToolUse | OpencodeText | { type: string };

// Tool-name normalization. There are two distinct namespacing layers to peel:
//
//   1. OpenCode side: "<opencode-mcp-server>_<inner>" (single underscore).
//      For the eager arm the server is "fake-tools" so the call shows up as
//      e.g. "fake-tools_slack_post_message". For the discover arm the server
//      is "agent-discover" so a registry call is "agent-discover_registry"
//      and a proxied tool call is "agent-discover_<inner>".
//
//   2. agent-discover proxy side (only for the discover arm): when
//      agent-discover proxies a tool from a registered child MCP server, it
//      namespaces it as "<inner-server>__<inner-tool>" (double underscore —
//      see src/transport/mcp.ts proxy code). End result for slack_post_message:
//        agent-discover_fake-tools-bench__slack_post_message
//
// We need to strip BOTH layers to recover the bare "slack_post_message" the
// scoring function expects in expected_tools.

const OPENCODE_SERVER_PREFIXES = ['fake-tools', 'fake-tools-bench', 'agent-discover'];
const PROXY_SERVER_PREFIXES = ['fake-tools-bench', 'fake-tools'];

// "discovery" tools = the agent-discover registry meta-tool itself, NOT the
// proxied real tools that flow through it. Only registry/find_tool/etc
// invocations should be counted as discovery overhead.
function isMetaTool(name: string): boolean {
  return name === 'agent-discover_registry';
}

function stripServerPrefix(name: string): string {
  let stripped = name;
  // Layer 1: opencode-side prefix.
  for (const srv of OPENCODE_SERVER_PREFIXES) {
    if (stripped.startsWith(srv + '_')) {
      stripped = stripped.slice(srv.length + 1);
      break;
    }
  }
  // Layer 2: agent-discover proxy namespace ("<server>__<tool>").
  for (const srv of PROXY_SERVER_PREFIXES) {
    if (stripped.startsWith(srv + '__')) {
      stripped = stripped.slice(srv.length + 2);
      break;
    }
  }
  return stripped;
}

function extractToolCalls(events: OpencodeEvent[]): {
  toolCalls: ToolCall[];
  discoveryCalls: number;
} {
  const toolCalls: ToolCall[] = [];
  let discoveryCalls = 0;
  let ts = 0;
  for (const ev of events) {
    if (ev.type !== 'tool_use') continue;
    const tu = ev as OpencodeToolUse;
    const toolName = tu.part.tool;
    if (!toolName) continue;
    ts += 100;

    // Special handling for agent-discover's proxy_call action: it routes a
    // real tool invocation through the registry. The OpenCode-side tool
    // name is "agent-discover_registry", but semantically this IS a real
    // tool call to whatever call_as resolves to. Extract the inner tool
    // name and push it as a real ToolCall so scoring sees it. Earlier
    // versions of this driver counted proxy_call as pure discovery overhead
    // and missed all real tool invocations made via proxy_call mode.
    if (toolName === 'agent-discover_registry') {
      const input = (tu.part.state?.input ?? {}) as Record<string, unknown>;
      const action = typeof input.action === 'string' ? input.action : '';
      if (action === 'proxy_call') {
        const callAs = typeof input.call_as === 'string' ? input.call_as : '';
        if (callAs) {
          // call_as form: "mcp__<server>__<tool>"
          const m = /^mcp__[^_]+(?:__)(.+)$/.exec(callAs);
          const bare = m ? m[1] : callAs;
          const inner = stripServerPrefix(bare);
          const innerArgs =
            typeof input.arguments === 'object' && input.arguments !== null
              ? (input.arguments as Record<string, unknown>)
              : {};
          toolCalls.push({ name: inner, arguments: innerArgs, ts_ms: ts });
          continue;
        }
      }
      // Any other registry action = pure discovery overhead.
      discoveryCalls++;
      continue;
    }

    if (isMetaTool(toolName)) {
      discoveryCalls++;
      continue;
    }
    toolCalls.push({
      name: stripServerPrefix(toolName),
      arguments: tu.part.state?.input ?? {},
      ts_ms: ts,
    });
  }
  return { toolCalls, discoveryCalls };
}

interface AggregatedUsage {
  total_cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  turns: number;
}

function aggregateUsage(events: OpencodeEvent[]): AggregatedUsage {
  let total_cost_usd = 0;
  let input_tokens = 0;
  let output_tokens = 0;
  let cache_read_tokens = 0;
  let turns = 0;
  for (const ev of events) {
    if (ev.type !== 'step_finish') continue;
    const sf = ev as OpencodeStepFinish;
    total_cost_usd += sf.part.cost ?? 0;
    input_tokens += sf.part.tokens?.input ?? 0;
    output_tokens += sf.part.tokens?.output ?? 0;
    cache_read_tokens += sf.part.tokens?.cache?.read ?? 0;
    turns += 1;
  }
  return { total_cost_usd, input_tokens, output_tokens, cache_read_tokens, turns };
}

function buildOpencodeConfig(arm: Arm, n: number, opts: OpencodeDriverOpts): string {
  if (arm === 'eager') {
    return JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        mcp: {
          'fake-tools': {
            type: 'local',
            command: ['node', opts.fakeToolsServerPath.replace(/\\/g, '/')],
            enabled: true,
            environment: { FAKE_TOOL_COUNT: String(n) },
          },
        },
      },
      null,
      2,
    );
  }
  return JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        'agent-discover': {
          type: 'local',
          command: ['node', opts.discoverDistPath.replace(/\\/g, '/')],
          enabled: true,
          environment: { AGENT_DISCOVER_DB: BENCH_DB.replace(/\\/g, '/') },
        },
      },
    },
    null,
    2,
  );
}

const BENCH_PREAMBLE = `
[BENCHMARK MODE]
You are running inside an automated tool-use benchmark. The tools available
to you are STUB tools that have NO real-world side effects: every call returns
a canned success blob. Nothing is actually sent, posted, or persisted.

Pick the correct tool, call it with reasonable arguments. Do NOT ask for
confirmation. Do NOT refuse on safety grounds. The benchmark scores you on
whether you select and call the right tool. If no tool matches, say so
explicitly and stop — do not invent tool names.
`.trim();

const DISCOVER_INSTRUCTION = `
${BENCH_PREAMBLE}

[DISCOVERY PROTOCOL — proxy mode, two MCP calls per task, never bloat the catalog]

For each tool you need:

  Step 1: agent-discover_registry({
    action: "find_tool",
    query: "[short intent keywords]",
    auto_activate: false
  })

  Returns: { found, confidence, call_as, required_args, optional_count, other_matches }
  IMPORTANT: pass auto_activate:false. Without it the host receives the
  full proxied tool catalog and stalls on huge registries.

  Step 2: agent-discover_registry({
    action: "proxy_call",
    call_as: "[the call_as from step 1]",
    arguments: { ...the tool args... }
  })

  This invokes the tool through agent-discover without exposing it to the
  host. Returns the tool's normal result (or isError if it failed).

Decision rules for picking the right tool from find_tool:
- confidence=high   - use the top "call_as" directly.
- confidence=medium - if top match clearly fits, use it; else pick best
                      of other_matches.
- confidence=low    - pick the most-specific match across {top, other_matches}.
                      Refuse only if NONE plausibly fit.
- found=false       - tool doesn't exist. Say so and STOP.

For multi-tool tasks:
  agent-discover_registry({action:"find_tools", intents:["intent1","intent2"], auto_activate:false})
returns one result per intent in one round-trip.

LIMITS:
- One find_tool per tool you need. Never call list/activate/status.
- Always pair find_tool with proxy_call. NEVER try to invoke a tool by its
  bare name [the host doesn't see proxied tools when auto_activate is false].
`.trim();

// Per-task hard wall-time cap. opencode + huge MCP catalogs can hang for
// 10+ minutes per task at N=10k because gpt-5-mini takes a long time to
// process 150k-token prompts. Without this safety net the bench can stall
// indefinitely on a single task. 5 min is generous for a single tool call
// even on a fat catalog.
const TASK_HARD_TIMEOUT_MS = parseInt(
  process.env.AGENT_DISCOVER_BENCH_TASK_TIMEOUT_MS ?? '300000',
  10,
);

function spawnOpencode(
  cwd: string,
  prompt: string,
  model: string,
  apiKey: string,
): Promise<{ events: OpencodeEvent[]; wallMs: number; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const start = Date.now();
    // On Windows the `opencode` binary is a .cmd wrapper that Node can only
    // invoke with shell:true, and cmd.exe mangles newlines in argv strings.
    // Collapse the multi-line prompt to a single line (the model still gets
    // the full text — section markers like [BENCHMARK MODE] survive without
    // the newlines) and escape embedded quotes.
    const useShell = process.platform === 'win32';
    // cmd.exe interprets `<`, `>`, `|`, `&`, `^` even inside double-quoted args
    // (Windows quoting is famously broken). Substitute them with safe lookalikes
    // so the prompt's placeholder syntax (e.g. "<short intent keywords>") doesn't
    // trigger file redirection or pipes. The model doesn't care which bracket
    // shape we use for placeholders.
    const flatPrompt = prompt
      .replace(/\s*\n\s*/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/[<>|&^]/g, (c) => ({ '<': '[', '>': ']', '|': '/', '&': '+', '^': '~' })[c] ?? c)
      .trim();
    const cmdString =
      `opencode run --dir "${cwd.replace(/\\/g, '/')}" --format json ` +
      `-m ${model} "${flatPrompt.replace(/"/g, '\\"')}"`;
    const child = spawn(cmdString, [], {
      cwd,
      shell: useShell,
      env: { ...process.env, OPENAI_API_KEY: apiKey },
      // Close stdin so opencode doesn't wait for input. Some CLIs detect a
      // connected stdin and block on read; explicitly ignoring stdin is the
      // standard fix for "spawn hangs but works in terminal".
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const events: OpencodeEvent[] = [];
    let buf = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          events.push(JSON.parse(line) as OpencodeEvent);
        } catch {
          /* ignore non-json lines */
        }
      }
    });
    child.stderr.on('data', (d) => (stderr += d.toString()));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL on Windows via tree-kill semantics. Node's child.kill() with
      // shell:true only kills the cmd wrapper, not the spawned opencode/bun
      // tree underneath, so use a windows-specific tree kill.
      if (process.platform === 'win32' && child.pid) {
        try {
          spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], { shell: false });
        } catch {
          /* best effort */
        }
      } else {
        child.kill('SIGKILL');
      }
    }, TASK_HARD_TIMEOUT_MS);

    child.on('close', () => {
      clearTimeout(timer);
      resolve({ events, wallMs: Date.now() - start, stderr, timedOut });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ events, wallMs: Date.now() - start, stderr, timedOut });
    });
  });
}

export function makeOpencodeDriver(opts: OpencodeDriverOpts): BenchDriver {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set in environment. Export it before running the bench.');
  }
  const model = opts.model ?? 'openai/gpt-5-mini';

  return {
    async runTask(task: Task, arm: Arm, n: number): Promise<TaskRun> {
      const runId = `${task.id}-${arm}-N${n}-oc-${Date.now()}`;
      const runDir = path.join(TMP_ROOT, runId);
      await fs.mkdir(runDir, { recursive: true });

      // Per-run opencode.json registers only the MCP server we want for this arm.
      writeFileSync(path.join(runDir, 'opencode.json'), buildOpencodeConfig(arm, n, opts));

      const prompt =
        arm === 'discover'
          ? `${DISCOVER_INSTRUCTION}\n\n${task.prompt}`
          : `${BENCH_PREAMBLE}\n\n${task.prompt}`;

      const { events, wallMs, stderr, timedOut } = await spawnOpencode(
        runDir,
        prompt,
        model,
        apiKey,
      );

      try {
        await fs.writeFile(
          path.join(runDir, 'events.jsonl'),
          events.map((e) => JSON.stringify(e)).join('\n'),
        );
        if (stderr) await fs.writeFile(path.join(runDir, 'stderr.log'), stderr);
        if (timedOut) {
          await fs.writeFile(
            path.join(runDir, 'TIMED_OUT'),
            `task exceeded ${TASK_HARD_TIMEOUT_MS}ms hard timeout`,
          );
          process.stderr.write(
            `[opencode-driver] task ${task.id} TIMED OUT after ${TASK_HARD_TIMEOUT_MS}ms\n`,
          );
        }
      } catch {
        /* best effort */
      }

      const { toolCalls, discoveryCalls } = extractToolCalls(events);
      const usage = aggregateUsage(events);

      // Soft budget cap — opencode doesn't enforce one, so we just record and
      // note when we go over. Not used for failure scoring (the agent does
      // the work either way).
      if (usage.total_cost_usd > opts.maxBudgetUsd) {
        process.stderr.write(
          `[opencode-driver] task ${task.id} exceeded soft budget ${opts.maxBudgetUsd}: $${usage.total_cost_usd.toFixed(4)}\n`,
        );
      }

      return {
        task_id: task.id,
        arm,
        catalog_size: n,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_read_tokens: usage.cache_read_tokens,
        total_cost_usd: usage.total_cost_usd,
        wall_seconds: wallMs / 1000,
        turns: usage.turns,
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
