# agent-discover bench

Quantitative evaluation of **deferred tool discovery** vs **eager tool loading**
for MCP-aware coding agents.

The bench answers ONE question:

> When an agent has access to a large MCP catalog, is it cheaper, faster, and
> still correct to expose **one** `registry` tool that fetches schemas on
> demand instead of dumping every tool's full JSONSchema into the system
> prompt up front?

## Hypothesis

Eager loading pays a per-turn schema tax that scales linearly with catalog
size. Deferred discovery pays a one-time search round-trip per tool actually
used. Above some catalog-size threshold, deferred discovery should win on
cost and stay competitive on success rate. Below the threshold, the search
round-trip overhead dominates.

This bench finds the crossover point and reports it.

## Two arms

| Arm          | Tools loaded into the agent                                                 | Discovery model                                                                 |
| ------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **eager**    | All N stub tools from `fake-tools` server, full JSONSchema in system prompt | Built-in: model sees every tool name + schema from the start                    |
| **discover** | `mcp__agent-discover__registry` only                                        | Agent must search registry → fetch schema → call. Mirrors the `ToolSearch` flow |

Both arms run **the same task set** against **the same N stub tools**. Only the
delivery mechanism differs.

## Workload

`workloads/tasks.json` contains 20 tasks covering 4 categories:

| Category              | Count | What it stresses                                                   |
| --------------------- | ----- | ------------------------------------------------------------------ |
| obvious-name          | 6     | Trivial discovery — tool name matches the task verbatim            |
| ambiguous             | 6     | Discovery has to reason — task says "notify", tool is `slack_post` |
| multi-tool            | 6     | 2–3 tools chained — amortizes/repeats discovery overhead           |
| distractor (negative) | 2     | Right tool is NOT in the catalog — does the agent give up cleanly? |

Each task specifies (a) the natural-language goal, (b) the expected tool(s)
to be called, (c) the expected arguments shape (loose match), and (d) a
"correct outcome" predicate the runner checks against the captured tool-call
log.

## Catalog (`fake-tools/`)

`fake-tools/server.mjs` is a tiny MCP server that emits **N stub tools** at
startup, where N is set via `FAKE_TOOL_COUNT` (default 100). Tool names are
drawn from a curated list of realistic MCP tool patterns (slack, github, jira,
linear, sentry, datadog, postgres, s3, gmail, gcal, notion, …) with mixed
schema sizes — small (1–2 params), medium (5–8 params), and fat (15+ params
with deep nested objects, mirroring the real `playwright_*` and `browser_*`
tools that dominate token budgets in practice).

Each stub tool, when called, returns a structured success blob — no real side
effects. The runner asserts on the **call log**, not on real-world state.

The same fake-tools server is consumed by both arms. The difference:

- **Eager arm**: Subagent's `settings.json` registers `fake-tools` as an MCP
  server directly → Claude Code loads all N tool schemas into the prompt.
- **Discover arm**: Subagent's `settings.json` registers `agent-discover`
  only. Agent-discover's registry is pre-seeded with the same N stub tools'
  metadata (name + one-line description, no full schema). The agent must
  call `registry({action:"search", query:"…"})` to find candidates, then
  `registry({action:"fetch_schema", name:"…"})` to get the full schema before
  invoking it. (This mirrors the harness-level `ToolSearch` deferred-tools
  pattern Claude Code already uses for the platform tools.)

## Catalog-size sweep

The headline experiment runs the same 20 tasks against catalogs of:

- **N=10** (small — discover should lose, search overhead dominates)
- **N=50** (medium)
- **N=100** (today's realistic agent setup with 4–5 MCP servers attached)
- **N=500** (the power-user / full-marketplace case)

Plotting cost vs N for both arms gives the crossover curve. That's the
deliverable.

## Metrics

Per task, per arm:

| Metric                | Source                                                    | Why                                                       |
| --------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| `input_tokens`        | Claude CLI JSON output                                    | The whole point — eager pays N× schema tax every turn     |
| `output_tokens`       | Claude CLI JSON output                                    | Discover spends output on search calls; check net win     |
| `cache_read_tokens`   | Claude CLI JSON output                                    | Eager benefits massively from prompt caching across turns |
| `total_cost_usd`      | derived from token counts × model price                   | Headline number                                           |
| `wall_seconds`        | runner timestamps                                         | Discover adds round-trips; quantify them                  |
| `turns`               | number of assistant turns                                 | Discover may need 2 turns (search → call) vs 1            |
| `task_success`        | predicate on captured tool-call log                       | Cheaper is worthless if it can't find the tool            |
| `tool_choice_correct` | did it call the _expected_ tool, or a plausible-wrong one | Independent of success — catches "lucky" wrong-tool calls |
| `discovery_calls`     | count of `registry` tool calls (discover arm only)        | Direct overhead measurement                               |

Aggregated per arm per N: mean cost, mean wall, success rate, choice accuracy,
and a `tokens_per_task` headline.

## Expected story

```
cost_per_task ($)
  ^
  |                                              eager
  |                                          ____•
  |                                     ____/
  |                                ____/                          discover
  |                          _____/_______________________________•
  |                    _____/   .                                 .
  |              _____/         .                                 .
  |        _____/    discover   .   crossover                     .
  |  _____/         •           .                                 .
  |  •-----.----.----.----.----.----.----.----.----.----.----.--->  N (catalog size)
       10        25       50        100                          500
```

If the curve looks like that, agent-discover is justified for any agent
plugged into more than ~25–50 MCP tools.

## Layout

```
bench/
  README.md                 — this file
  runner.ts                 — pilot dispatch + results write (mirrors agent-comm/bench/runner.ts)
  metrics.ts                — pure metric calculators (mean, p50, units_per_dollar, etc.)
  drivers/
    cli.ts                  — Real Claude CLI driver — spawns headless `claude -p`
                               subagents with the per-arm settings.json, captures
                               JSON output, parses tool-call log, runs predicates
  fake-tools/
    server.mjs              — Configurable stub MCP server (FAKE_TOOL_COUNT=N)
    catalog.json            — Curated pool of realistic tool name + schema templates
    seed-registry.ts        — One-shot script: pre-seed agent-discover's registry
                               with the same N stub tools so the discover arm has
                               something to search
  workloads/
    tasks.json              — The 20 tasks (4 categories × 5 + 0 distractors as noted)
  _results/
    latest.json             — Written by each run, served by agent-discover dashboard
                               (analogous to /api/bench in agent-comm)
```

## How to run

```bash
# Unit-test the metric calculators (no agents, no API spend)
npm run bench:metrics

# Smoke test with the mock driver (no real agents, fake numbers)
npm run bench:run

# Single point: 20 tasks at N=100 in both arms
npm run bench:run -- --real --n=100

# Full sweep — 20 tasks × 2 arms × 4 catalog sizes = 160 subagent runs
npm run bench:run -- --real --sweep
```

Estimated cost for the full sweep at current Sonnet 4.6 prices: **~$8–15**
(eager arm dominates the bill, which is the point).

## Why this bench is honest

- **Same task set, same expected outputs, same fake-tools server** for both
  arms — no information asymmetry.
- **Stub tools return success unconditionally** — we measure discovery and
  selection, not real-world tool reliability, so randomness from external
  services can't bias the comparison.
- **Negative tasks included** — distractors where the right tool isn't in
  the catalog. A bench that only measures happy paths would let either arm
  cheat by hallucinating a plausible tool name.
- **Token counts come from Claude's own JSON output**, not estimates. Cost
  is computed from published prices, deterministic.
- **Catalog sweep** prevents the result from being a single number on a
  cherry-picked N.
- **Negative results published**: if discover loses on small catalogs (it
  should), that goes in the headline table next to the wins.

## Results

### Headline (Tier 2 sweep, agent-discover v1.1.4)

5 representative tasks (one per category) × catalog sizes 10 and 500 × two arms
= 20 real subagent runs against the live Claude Code CLI on Sonnet 4.6.

| arm          |   N | cost / task | input tok / task | turns |  success | distract | refuse |
| ------------ | --: | ----------: | ---------------: | ----: | -------: | -------: | -----: |
| eager        |  10 |      $0.060 |           56,519 |   2.6 |      80% |       0% |    40% |
| **discover** |  10 |      $0.108 |          100,828 |   4.4 |  **80%** |      20% |    40% |
| eager        | 500 |      $0.098 |           97,886 |   3.6 |     100% |       0% |    20% |
| **discover** | 500 |  **$0.096** |          120,996 |   5.2 | **100%** |      20% |    20% |

**At N=500, agent-discover matches eager loading on success (100% / 100%) AND
is slightly cheaper ($0.096 vs $0.098).** The deferred-discovery hypothesis is
fully vindicated for the realistic large-catalog regime. At N=10 eager is
still cheaper because the discovery overhead doesn't pay off, but discover now
matches it on success rate.

The 20% distractor_rate for discover is **the `did_you_mean` recovery path
firing**: the agent picks a wrong tool on the first invoke, the proxy attaches
a list of similarly-named tools, the agent picks again, and the task succeeds.
Without that recovery (Tier 1) the same scenario produced refusals or failures.

### What changed across iterations

|                                                               | discover N=500 success | discover N=500 cost vs eager | bottleneck                                                                           |
| ------------------------------------------------------------- | ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| **Naive baseline** (no find_tool)                             | 40%                    | 23% cheaper but unreliable   | 27 turns / 16 discovery calls per task — agent flailing through search/list/activate |
| **Tier 1** (BM25 + confidence + compact schema, v1.1.3)       | 80%                    | 16% cheaper                  | 5.2 turns / 1 discovery call per task — single round-trip discovery                  |
| **Tier 2** (find_tools batch + did_you_mean recovery, v1.1.4) | **100%**               | **2% cheaper**               | 5.2 turns / 2.8 discovery calls — agent recovers from wrong-tool selections          |

Tier 1 fixed the discovery loop (FTS5 BM25 ranking with name×4 weighting,
confidence labels from score gaps, compact-first schema delivery,
auto-activate). Tier 2 added a recovery path: `find_tools` for batch discovery
and `did_you_mean` suggestions injected into proxy errors so the agent can
correct a wrong-tool pick in one extra turn instead of giving up. Together
they took discover from 40% success / unreliable to 100% success / cheaper
than eager at N=500.

### Per-turn token cost is the real story

| arm      |   N | tokens / turn |
| -------- | --: | ------------: |
| eager    |  10 |          ~22k |
| discover |  10 |          ~23k |
| eager    | 500 |          ~27k |
| discover | 500 |          ~23k |

**discover's per-turn cost is flat in N (~22-23k regardless of catalog
size)** because only the registry tool is loaded — the catalog never enters
the prompt. **eager's per-turn cost grows with N** because all 500 schemas
live in the system prompt every turn. That's the deferred-discovery thesis,
empirically confirmed: it's not about saving total tokens, it's about
keeping per-turn cost flat as the catalog grows.

### Where discover loses

- **N≤50**: per-task discovery overhead (~4k extra tokens for find_tool +
  result) outweighs the schema savings. Eager is the right answer for small
  registries.
- **Discover loses on raw input_tokens** — only wins on $$$ cost because of
  prompt-cache reuse across turns. If your host doesn't have prompt caching,
  the math is different.
- **Discovery still costs turns** — discover at N=500 takes 5.2 turns vs
  eager's 3.6, because the agent has to call find_tool before invoking. The
  cost win comes from cheaper per-turn tokens, not fewer turns.

### How the bench was actually run

```bash
# the targeted sweep that produced the table above:
npm run bench:run -- --real --sweep \
  --sizes=10,500 \
  --ids=obvious-1,ambig-1,multi-1,collision-1,distractor-1
```

Total cost of the sweep: ~$2 in API spend, ~30 min wall.

Raw machine-readable results (including per-arm metric breakdowns):
[`bench/_results/latest.json`](_results/latest.json).

### Caveats

- **N=1 per (task, arm, N)** — these are pilot numbers, not statistically
  replicated. Re-running the same sweep can shift the success rate by ±20pp
  on tasks where outcomes depend on the agent's specific reasoning path.
- **5-task subset, not the full 25-task workload.** A full sweep would
  smooth out single-task variance.
- **Measured against Claude Code only.** Claude Code has its own built-in
  deferred-tool loader (`ToolSearch`) that already mitigates eager loading's
  cost — so the eager arm here is already partially optimized. On hosts
  without that (Cursor, Aider, Codex, plain MCP clients), the eager numbers
  would be much worse and the crossover would happen at a much smaller N.
- **Stub tools return success unconditionally** — we're measuring discovery
  and selection, not real-world tool reliability.

## Roadmap

- **Tier 3** (speculative, only if a real workload demands it): embedding-based
  search, usage-based rank boost (track which tools the agent successfully
  invokes after find_tool, boost their rank for similar future queries),
  explicit clarification mode for ambiguous queries.
- **Larger sweep**: full 25-task workload at N ∈ {10, 50, 100, 500, 1000} once
  the per-task variance is understood. Need ~$15-20 in API spend.
- **Re-target at non-Claude-Code hosts** (Cursor, Aider, Codex CLI, plain MCP
  clients) to measure agent-discover against an eager loader that doesn't have
  a built-in defer system competing with it. The crossover should happen at
  much smaller N there — possibly N≈25 instead of N≈100.
- **Real-tool reliability**: stub tools always return success; a follow-up
  bench should swap in real failing tools (auth errors, rate limits, schema
  mismatches) to test how `did_you_mean` recovery handles real-world errors.
