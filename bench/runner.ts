// =============================================================================
// agent-discover bench runner — eager vs deferred tool discovery.
//
// `npm run bench:run` runs the mock driver (no API spend).
// `npm run bench:run -- --real --n=100` runs both arms at one catalog size.
// `npm run bench:run -- --real --sweep` runs the full N ∈ {10,50,100,500} sweep.
//
// Mirrors mcp-servers/agent-comm/bench/runner.ts in shape: results land in
// bench/_results/latest.json so a future agent-discover dashboard endpoint
// can read them the same way agent-comm exposes /api/bench.
//
// STATUS: scaffolding only. The CLI driver and metric calculators are not yet
// implemented. See bench/README.md for the design and the TODOs below.
// =============================================================================

import * as path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { makeCliDriver } from './drivers/cli.js';
import { seedRegistry as seedRegistryInProc } from './fake-tools/seed-registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Arm = 'eager' | 'discover';

export interface Task {
  id: string;
  category: 'obvious-name' | 'ambiguous' | 'multi-tool' | 'distractor';
  prompt: string;
  expected_tools: string[];
  expected_args?: Record<string, Record<string, unknown>>;
  match?: 'any' | 'all-in-order';
  expected_outcome?: 'give-up-cleanly';
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
  ts_ms: number;
}

export interface TaskRun {
  task_id: string;
  arm: Arm;
  catalog_size: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  total_cost_usd: number;
  wall_seconds: number;
  turns: number;
  tool_calls: ToolCall[];
  // Derived predicates — populated by scoreRun()
  task_success: boolean;
  tool_choice_correct: boolean;
  /** Agent called a tool that was NOT in expected_tools (wrong-tool error). */
  called_distractor: boolean;
  /** Agent gave up without making any tool call (and the task expected one). */
  refused: boolean;
  discovery_calls: number;
}

export interface ArmReport {
  arm: Arm;
  catalog_size: number;
  n_tasks: number;
  mean_input_tokens: number;
  mean_output_tokens: number;
  mean_total_cost_usd: number;
  mean_wall_seconds: number;
  mean_turns: number;
  success_rate: number;
  choice_accuracy: number;
  /** % of tasks where the agent called a tool not in expected_tools. */
  distractor_call_rate: number;
  /** % of tasks the agent refused / gave up on. */
  refusal_rate: number;
  mean_discovery_calls: number;
}

// ---------------------------------------------------------------------------
// Driver interface — implemented by drivers/cli.ts (real) and below (mock)
// ---------------------------------------------------------------------------

export interface BenchDriver {
  /** Run a single task in a single arm at a given catalog size. */
  runTask(task: Task, arm: Arm, catalogSize: number): Promise<TaskRun>;
}

// ---------------------------------------------------------------------------
// Mock driver — deterministic synthetic numbers shaped like the hypothesis.
// Eager cost scales linearly with N; discover cost is roughly flat.
// Used for harness sanity checks without spending API tokens.
// ---------------------------------------------------------------------------

export const mockDriver: BenchDriver = {
  async runTask(task, arm, n) {
    const isDistractor = task.category === 'distractor';
    const base = arm === 'eager' ? 800 + n * 60 : 1100 + 30 * n ** 0.4;
    const cost = base * 0.000003 + (arm === 'discover' ? 0.0008 * task.expected_tools.length : 0);
    return {
      task_id: task.id,
      arm,
      catalog_size: n,
      input_tokens: Math.round(base),
      output_tokens: arm === 'discover' ? 220 : 120,
      cache_read_tokens: arm === 'eager' ? Math.round(base * 0.6) : 0,
      total_cost_usd: cost,
      wall_seconds: arm === 'eager' ? 4.1 : 5.7,
      turns: arm === 'eager' ? 1 : 2 + (task.match === 'all-in-order' ? 1 : 0),
      tool_calls: isDistractor
        ? []
        : task.expected_tools.map((name, i) => ({
            name,
            arguments: task.expected_args?.[name] ?? {},
            ts_ms: 100 * (i + 1),
          })),
      task_success: true,
      tool_choice_correct: true,
      called_distractor: false,
      refused: false,
      discovery_calls: arm === 'discover' ? task.expected_tools.length + 1 : 0,
    };
  },
};

// ---------------------------------------------------------------------------
// Scoring — predicates from task definition vs captured tool_calls
// ---------------------------------------------------------------------------

export function scoreRun(task: Task, run: TaskRun): TaskRun {
  const calledNames = run.tool_calls.map((c) => c.name);

  // Distractor tasks: success = no real tool was called (give up cleanly)
  if (task.expected_outcome === 'give-up-cleanly') {
    const success = calledNames.length === 0;
    return {
      ...run,
      task_success: success,
      tool_choice_correct: success,
      called_distractor: !success, // any call here IS a distractor call
      refused: success, // refusing is the correct outcome
    };
  }

  let choiceCorrect: boolean;
  if (task.match === 'any') {
    choiceCorrect = calledNames.some((n) => task.expected_tools.includes(n));
  } else if (task.match === 'all-in-order') {
    let idx = 0;
    for (const n of calledNames) {
      if (n === task.expected_tools[idx]) idx++;
      if (idx === task.expected_tools.length) break;
    }
    choiceCorrect = idx === task.expected_tools.length;
  } else {
    choiceCorrect = task.expected_tools.every((n) => calledNames.includes(n));
  }
  let success = choiceCorrect;

  // Loose argument check on first expected tool with declared expected_args
  if (success && task.expected_args) {
    for (const [tool, expectedArgs] of Object.entries(task.expected_args)) {
      const call = run.tool_calls.find((c) => c.name === tool);
      if (!call) continue;
      for (const [k, v] of Object.entries(expectedArgs)) {
        if (call.arguments[k] !== v) {
          success = false;
          break;
        }
      }
    }
  }

  // Distractor call: agent called any tool that's NOT in expected_tools.
  // Refusal: agent made zero tool calls but the task required one.
  const calledDistractor = calledNames.some((n) => !task.expected_tools.includes(n));
  const refused = calledNames.length === 0;

  return {
    ...run,
    task_success: success,
    tool_choice_correct: choiceCorrect,
    called_distractor: calledDistractor,
    refused,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function aggregate(runs: TaskRun[], arm: Arm, catalogSize: number): ArmReport {
  return {
    arm,
    catalog_size: catalogSize,
    n_tasks: runs.length,
    mean_input_tokens: mean(runs.map((r) => r.input_tokens)),
    mean_output_tokens: mean(runs.map((r) => r.output_tokens)),
    mean_total_cost_usd: mean(runs.map((r) => r.total_cost_usd)),
    mean_wall_seconds: mean(runs.map((r) => r.wall_seconds)),
    mean_turns: mean(runs.map((r) => r.turns)),
    success_rate: mean(runs.map((r) => (r.task_success ? 1 : 0))),
    choice_accuracy: mean(runs.map((r) => (r.tool_choice_correct ? 1 : 0))),
    distractor_call_rate: mean(runs.map((r) => (r.called_distractor ? 1 : 0))),
    refusal_rate: mean(runs.map((r) => (r.refused ? 1 : 0))),
    mean_discovery_calls: mean(runs.map((r) => r.discovery_calls)),
  };
}

// ---------------------------------------------------------------------------
// Pilot dispatch
// ---------------------------------------------------------------------------

const TASKS_PATH = path.resolve('bench/workloads/tasks.json');
const RESULTS_DIR = path.resolve('bench/_results');
const RESULTS_FILE = path.join(RESULTS_DIR, 'latest.json');

interface PersistedResults {
  version: string;
  generated_at: string;
  reports: ArmReport[];
}

function persist(reports: ArmReport[]): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const out: PersistedResults = {
    version: '0.1.0',
    generated_at: new Date().toISOString(),
    reports,
  };
  writeFileSync(RESULTS_FILE, JSON.stringify(out, null, 2));
}

function seedRegistry(n: number): void {
  // In-process call. Earlier we used spawnSync which hung when the runner's
  // stdio was piped through a background task — the child seed-registry
  // process never had its stdio fds drained. Calling inline avoids the
  // child process entirely.
  const count = seedRegistryInProc(n);
  console.log(`seeded ${count} tools (N=${n})`);
}

export async function runPoint(
  driver: BenchDriver,
  n: number,
  limit?: number,
  seed = false,
  ids?: string[],
  priorReports: ArmReport[] = [],
): Promise<ArmReport[]> {
  let tasks: Task[] = JSON.parse(readFileSync(TASKS_PATH, 'utf8'));
  if (ids && ids.length > 0) tasks = tasks.filter((t) => ids.includes(t.id));
  if (limit && limit > 0) tasks = tasks.slice(0, limit);
  const reports: ArmReport[] = [];
  for (const arm of ['eager', 'discover'] as const) {
    if (arm === 'discover' && seed) seedRegistry(n);
    const runs: TaskRun[] = [];
    for (const t of tasks) {
      const raw = await driver.runTask(t, arm, n);
      runs.push(scoreRun(t, raw));
      // Persist after every task. Includes ALL prior arm reports + the
      // currently in-progress arm so a crash mid-sweep doesn't lose data.
      persistPartial([...priorReports, ...reports, aggregate(runs, arm, n)]);
    }
    reports.push(aggregate(runs, arm, n));
  }
  return reports;
}

function persistPartial(allReports: ArmReport[]): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const out: PersistedResults = {
    version: '0.1.0',
    generated_at: new Date().toISOString(),
    reports: allReports,
  };
  writeFileSync(RESULTS_FILE, JSON.stringify(out, null, 2));
}

export async function runSweep(
  driver: BenchDriver,
  sizes: number[],
  seed = false,
  ids?: string[],
): Promise<ArmReport[]> {
  const all: ArmReport[] = [];
  for (const n of sizes) {
    const reports = await runPoint(driver, n, undefined, seed, ids, all);
    all.push(...reports);
  }
  return all;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fmt(r: ArmReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return [
    `  ${r.arm.padEnd(10)} N=${String(r.catalog_size).padStart(4)} n_tasks=${r.n_tasks}`,
    `    input_tokens     ${r.mean_input_tokens.toFixed(0)}`,
    `    output_tokens    ${r.mean_output_tokens.toFixed(0)}`,
    `    cost_per_task    $${r.mean_total_cost_usd.toFixed(5)}`,
    `    wall_seconds     ${r.mean_wall_seconds.toFixed(1)}s`,
    `    turns            ${r.mean_turns.toFixed(1)}`,
    `    success_rate     ${pct(r.success_rate)}`,
    `    choice_accuracy  ${pct(r.choice_accuracy)}`,
    `    distractor_rate  ${pct(r.distractor_call_rate)}`,
    `    refusal_rate     ${pct(r.refusal_rate)}`,
    `    discovery_calls  ${r.mean_discovery_calls.toFixed(1)}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const real = args.includes('--real');
  const sweep = args.includes('--sweep');
  const smoke = args.includes('--smoke');
  const nArg = args.find((a) => a.startsWith('--n='));
  const idsArg = args.find((a) => a.startsWith('--ids='));
  const sizesArg = args.find((a) => a.startsWith('--sizes='));
  const n = nArg ? parseInt(nArg.slice(4), 10) : 100;
  const limit = smoke ? 1 : undefined;
  const ids = idsArg ? idsArg.slice(6).split(',').filter(Boolean) : undefined;
  const sizes = sizesArg
    ? sizesArg
        .slice(8)
        .split(',')
        .map((s) => parseInt(s, 10))
    : [10, 50, 100, 500];

  const driver = real
    ? makeCliDriver({
        fakeToolsServerPath: path.resolve('bench/fake-tools/server.mjs'),
        discoverDistPath: path.resolve('dist/index.js'),
        maxBudgetUsd: 0.4,
      })
    : mockDriver;
  const reports = sweep
    ? await runSweep(driver, sizes, real, ids)
    : await runPoint(driver, n, limit, real, ids);
  for (const r of reports) console.log(fmt(r));
  persist(reports);
  console.log(`\nresults → ${RESULTS_FILE}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
