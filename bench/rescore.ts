// =============================================================================
// Re-score captured bench runs without re-running them.
//
// Walks every run dir under the bench tmp root, parses the captured
// events.jsonl, applies the current driver's extractToolCalls + scoreRun
// logic, and prints an aggregated report. Use this when you fix a scoring
// bug and want to know what the OLD runs would have looked like under the
// NEW logic — no API spend, just file I/O.
//
// Usage:
//   npx tsx bench/rescore.ts                 # rescore all runs
//   npx tsx bench/rescore.ts --tasks=adv-*   # filter by task id pattern
//   npx tsx bench/rescore.ts --n=1000        # only catalog size 1000
// =============================================================================

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import {
  scoreRun,
  aggregate,
  type Task,
  type TaskRun,
  type Arm,
  type ArmReport,
} from './runner.js';

const TMP_ROOT =
  process.env.AGENT_DISCOVER_BENCH_TMP ??
  (process.platform === 'win32' ? 'C:\\tmp\\agent-discover-bench' : '/tmp/agent-discover-bench');
const TASKS_PATH = path.resolve('bench/workloads/tasks.json');

interface OpencodeToolUse {
  type: 'tool_use';
  part: {
    tool: string;
    state: { input: Record<string, unknown>; output: string };
  };
}
interface OpencodeStepFinish {
  type: 'step_finish';
  part: {
    cost: number;
    tokens?: { input: number; output: number; cache?: { read: number } };
  };
}

const META_TOOLS = new Set(['ToolSearch']);
const OPENCODE_PREFIXES = ['fake-tools', 'fake-tools-bench', 'agent-discover'];
const PROXY_PREFIXES = ['fake-tools-bench', 'fake-tools'];

function isMetaTool(name: string): boolean {
  if (META_TOOLS.has(name)) return true;
  return name.startsWith('mcp__agent-discover__');
}

function stripServerPrefix(name: string): string {
  let stripped = name;
  for (const srv of OPENCODE_PREFIXES) {
    if (stripped.startsWith(srv + '_')) {
      stripped = stripped.slice(srv.length + 1);
      break;
    }
  }
  for (const srv of PROXY_PREFIXES) {
    if (stripped.startsWith(srv + '__')) {
      stripped = stripped.slice(srv.length + 2);
      break;
    }
  }
  return stripped;
}

interface ParsedRun {
  tool_calls: Array<{ name: string; arguments: Record<string, unknown>; ts_ms: number }>;
  discovery_calls: number;
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number;
  turns: number;
}

function parseRunDir(dir: string): ParsedRun | null {
  const eventsPath = path.join(dir, 'events.jsonl');
  if (!existsSync(eventsPath)) return null;
  const lines = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean);
  const events = lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as Array<{ type: string; part?: Record<string, unknown> }>;

  const tool_calls: ParsedRun['tool_calls'] = [];
  let discovery_calls = 0;
  let input_tokens = 0;
  let output_tokens = 0;
  let total_cost_usd = 0;
  let turns = 0;
  let ts = 0;

  for (const ev of events) {
    if (ev.type === 'tool_use') {
      const tu = ev as unknown as OpencodeToolUse;
      const toolName = tu.part?.tool;
      if (!toolName) continue;
      ts += 100;
      // Detect agent-discover proxy_call invocation and extract inner tool name.
      if (toolName === 'agent-discover_registry') {
        const input = (tu.part.state?.input ?? {}) as Record<string, unknown>;
        const action = typeof input.action === 'string' ? input.action : '';
        if (action === 'proxy_call') {
          const callAs = typeof input.call_as === 'string' ? input.call_as : '';
          if (callAs) {
            const m = /^mcp__[^_]+(?:__)(.+)$/.exec(callAs);
            const bare = m ? m[1] : callAs;
            const inner = stripServerPrefix(bare);
            const innerArgs =
              typeof input.arguments === 'object' && input.arguments !== null
                ? (input.arguments as Record<string, unknown>)
                : {};
            tool_calls.push({ name: inner, arguments: innerArgs, ts_ms: ts });
            continue;
          }
        }
        discovery_calls++;
        continue;
      }
      if (isMetaTool(toolName)) {
        discovery_calls++;
        continue;
      }
      const inner = stripServerPrefix(toolName);
      const args = (tu.part.state?.input ?? {}) as Record<string, unknown>;
      tool_calls.push({ name: inner, arguments: args, ts_ms: ts });
    } else if (ev.type === 'step_finish') {
      const sf = ev as unknown as OpencodeStepFinish;
      total_cost_usd += sf.part?.cost ?? 0;
      input_tokens += sf.part?.tokens?.input ?? 0;
      output_tokens += sf.part?.tokens?.output ?? 0;
      turns += 1;
    }
  }
  return { tool_calls, discovery_calls, input_tokens, output_tokens, total_cost_usd, turns };
}

function parseDirName(name: string): { task: string; arm: Arm; n: number; ts: number } | null {
  // verb-create-eager-N1000-oc-1775761404258
  const m = /^(.+)-(eager|discover)-N(\d+)-oc-(\d+)$/.exec(name);
  if (!m) return null;
  return { task: m[1], arm: m[2] as Arm, n: parseInt(m[3], 10), ts: parseInt(m[4], 10) };
}

function fmt(r: ArmReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  return `${r.arm.padEnd(10)} N=${String(r.catalog_size).padStart(6)} n=${r.n_tasks} cost=$${r.mean_total_cost_usd.toFixed(4)} succ=${pct(r.success_rate)} choice=${pct(r.choice_accuracy)} distract=${pct(r.distractor_call_rate)} refuse=${pct(r.refusal_rate)} turns=${r.mean_turns.toFixed(1)}`;
}

function main(): void {
  const args = process.argv.slice(2);
  const taskFilter = args.find((a) => a.startsWith('--tasks='))?.slice(8);
  const nFilter = args.find((a) => a.startsWith('--n='))?.slice(4);

  const tasks: Task[] = JSON.parse(readFileSync(TASKS_PATH, 'utf8'));
  const taskById = new Map(tasks.map((t) => [t.id, t]));

  // Group dirs by (arm, n), keeping only the latest run per (task, arm, n).
  const latestByKey = new Map<
    string,
    { task: string; arm: Arm; n: number; dir: string; ts: number }
  >();
  for (const entry of readdirSync(TMP_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const meta = parseDirName(entry.name);
    if (!meta) continue;
    if (taskFilter && !meta.task.startsWith(taskFilter.replace(/\*/g, ''))) continue;
    if (nFilter && String(meta.n) !== nFilter) continue;
    const key = `${meta.task}|${meta.arm}|${meta.n}`;
    const prev = latestByKey.get(key);
    if (!prev || meta.ts > prev.ts) {
      latestByKey.set(key, { ...meta, dir: path.join(TMP_ROOT, entry.name) });
    }
  }

  // Group by (arm, n), score each, aggregate.
  const groups = new Map<string, TaskRun[]>();
  for (const { task, arm, n, dir } of latestByKey.values()) {
    const taskDef = taskById.get(task);
    if (!taskDef) continue;
    const parsed = parseRunDir(dir);
    if (!parsed) continue;
    const raw: TaskRun = {
      task_id: task,
      arm,
      catalog_size: n,
      input_tokens: parsed.input_tokens,
      output_tokens: parsed.output_tokens,
      cache_read_tokens: 0,
      total_cost_usd: parsed.total_cost_usd,
      wall_seconds: 0,
      turns: parsed.turns,
      tool_calls: parsed.tool_calls,
      task_success: false,
      tool_choice_correct: false,
      called_distractor: false,
      refused: false,
      discovery_calls: parsed.discovery_calls,
    };
    const scored = scoreRun(taskDef, raw);
    const key = `${arm}|${n}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(scored);
  }

  // Sort by N then arm and print.
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    const [aa, an] = a.split('|');
    const [ba, bn] = b.split('|');
    const dn = parseInt(an, 10) - parseInt(bn, 10);
    if (dn !== 0) return dn;
    return aa.localeCompare(ba);
  });
  for (const key of sortedKeys) {
    const runs = groups.get(key)!;
    const [arm, nStr] = key.split('|');
    const report = aggregate(runs, arm as Arm, parseInt(nStr, 10));
    console.log(fmt(report));
    for (const r of runs) {
      const calls = r.tool_calls.map((c) => c.name).join(', ') || '<none>';
      const flag = r.task_success ? 'OK' : r.refused ? 'REFUSE' : 'WRONG';
      console.log(`  ${flag.padEnd(6)} ${r.task_id.padEnd(12)} -> ${calls}`);
    }
  }
}

main();
