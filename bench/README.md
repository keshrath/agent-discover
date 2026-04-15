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

### The practical win that isn't in the bench: no session restart

Every MCP client today — **including Claude Code** — requires a full
agent-session restart to pick up a newly registered MCP server. The tool
catalog is loaded once at startup and frozen. Long-running sessions,
scheduled agents, and IDE-attached agents all have to be torn down and
rebuilt every time you plug in another integration.

With agent-discover, you `register` a new server through the registry
(REST, MCP action, or the declarative setup file) and it becomes
discoverable via `find_tool` in the same session — **no restart, no
reload**. The host sees the same 5 registry tools throughout the
lifetime of the session; agent-discover handles new child servers
internally.

This is the one differentiator that survives against every host,
including hosts with their own built-in deferred-tool loaders — because
a built-in loader still can't register a brand-new MCP server without
restarting its own catalog watcher. It's not measured in the bench below
(benches are single-shot runs, not long-lived sessions), but it's the
motivation behind the project.

### Headline — scaling of first-turn input tokens

**Discover's first-turn input tokens are flat in N; eager's grow linearly
and eventually exceed the model's context window.** That's a structural
property of the two designs and the cleanest signal the bench produces.

OpenCode + gpt-5-mini, `adv-create` task, 1 run per cell, captured event
stream in `_results/`. First-turn input tokens (model-independent proxy
for system-prompt size):

|    N | eager turn-1 input        | discover turn-1 input | discover advantage                    |
| ---: | :------------------------ | --------------------: | ------------------------------------- |
|   10 | 20,893                    |                20,836 | ~equal (overhead dominates)           |
|  100 | 32,389                    |                20,836 | 1.55× cheaper                         |
| 1000 | 160,868                   |                20,840 | **7.72× cheaper**                     |
| 3000 | context overflow — failed |                20,837 | eager unusable; discover still scales |

At N=3000 eager's system prompt no longer fits alongside the task in
gpt-5-mini's context budget; the agent loops without making progress and
hits the wall timeout. Discover's first turn still fits cleanly at ~20.8k.
That is the capability ceiling — discover scales past the point where
eager can no longer run.

### End-to-end accuracy and cost (adversarial CRUD pack, N=1000)

5 adversarial verb tasks × 2 arms × N=1000 on OpenCode + gpt-5-mini:

| arm      | choice accuracy | success rate | cost / task | turns |
| -------- | :-------------: | :----------: | ----------: | ----: |
| eager    |      100%       |     100%     |      $0.068 |   2.0 |
| discover |      100%       |     100%     |      $0.086 |   3.0 |

Both arms disambiguate the adversarial verbs correctly on gpt-5-mini —
no accuracy gap at this model strength. End-to-end cost per task is
slightly higher for discover because of the multi-turn cost caveat below.

### Multi-turn cost caveat

Discover's first turn is much smaller than eager's, but the `find_tool`
tool output stays in conversation history and inflates every subsequent
turn's input. Measured on `adv-list` at N=1000:

| turn | eager input |                                 discover input |
| ---: | ----------: | ---------------------------------------------: |
|    1 |     160,868 |                                         20,840 |
|    2 |     161,381 |                                        173,671 |
|    3 |           — | ~500 (final tool call, minimal context replay) |

The cost win is unambiguous only for workloads that resolve in one or
two turns **and** where the catalog is large. Reducing `find_tool`'s
payload size (or evicting it from history after the referenced tool is
invoked) would widen the discover advantage on multi-turn tasks.

### Where this matters most: hosts that don't already defer

OpenCode loads MCP tools eagerly with no built-in deferred-tool loader
— representative of Cursor, Aider, Codex CLI, Continue, and plain MCP
clients. For these hosts, agent-discover delivers:

1. **First-turn cost**: 7.7× cheaper at N=1000, gap widens with N
2. **Capability ceiling**: works past the catalog size where eager can
   no longer fit in context (at N=3000 eager fails)
3. **Runtime config changes** (see top of this section) — no session restart needed

Claude Code ships its own MCP Tool Search that auto-defers catalogs above
~10% of context, so the eager arm there isn't actually eager — the
first-turn cost gap collapses and only the runtime-config benefit
remains as a clear differentiator.

| host class                                    | first-turn cost | capability ceiling | runtime config |
| --------------------------------------------- | :-------------: | :----------------: | :------------: |
| OpenCode / Cursor / Aider / Codex / plain MCP |       ✅        |         ✅         |       ✅       |
| Claude Code (built-in MCP Tool Search)        |    marginal     |      marginal      |       ✅       |

### Configuring embeddings

Embeddings are **opt-in and pluggable**. agent-discover ships with semantic
search disabled by default (BM25 + verb synonyms only) so existing installs
keep working with zero configuration. Enable a provider via:

```bash
# OpenAI text-embedding-3-small (1536 dims) — used for the bench above
export AGENT_DISCOVER_EMBEDDING_PROVIDER=openai
export OPENAI_API_KEY=sk-...

# Local @huggingface/transformers + Xenova/all-MiniLM-L6-v2 (384 dims)
# requires `npm install @huggingface/transformers` (optional peer dep)
export AGENT_DISCOVER_EMBEDDING_PROVIDER=local

# Disable explicitly (default)
export AGENT_DISCOVER_EMBEDDING_PROVIDER=none
```

Optional knobs:

| env var                                 | meaning                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `AGENT_DISCOVER_EMBEDDING_PROVIDER`     | `none` (default) \| `local` \| `openai`                                        |
| `AGENT_DISCOVER_EMBEDDING_MODEL`        | override the default model id for the chosen provider                          |
| `AGENT_DISCOVER_EMBEDDING_THREADS`      | local provider only — onnx runtime thread count (default 1)                    |
| `AGENT_DISCOVER_EMBEDDING_IDLE_TIMEOUT` | local provider only — seconds before unloading the model from RAM (default 60) |
| `AGENT_DISCOVER_OPENAI_API_KEY`         | overrides `OPENAI_API_KEY` for the embedding call only                         |

The provider interface mirrors `agent-knowledge`'s embedding subsystem so the
two servers can share an embeddings API key and conventions.

### Architecture (what's in the box)

agent-discover exposes a single `registry` MCP tool with these actions,
each measured by the bench:

| action       | what it does                                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `find_tool`  | hybrid BM25+semantic ranking → top match with confidence label + compact required_args + 4 ranked alternatives                          |
| `find_tools` | batch variant — discover N tools in one round-trip for multi-step tasks                                                                 |
| `get_schema` | full input_schema for a discovered tool, only when the compact summary isn't enough                                                     |
| `proxy_call` | invoke a discovered tool **through** agent-discover without exposing it to the host catalog — keeps the host at 5 tools regardless of N |

Retrieval pipeline behind `find_tool` / `find_tools`:

1. **Semantic candidates**: brute-force cosine similarity over OpenAI
   `text-embedding-3-small` vectors for the entire embedded catalog
2. **BM25 candidates**: FTS5 with name×4 / description×1 weighting + verb
   synonym expansion + plural singularization
3. **Hybrid re-rank**: union of both candidate sets, scored 70% semantic +
   30% lexical
4. **Confidence label**: derived from the BM25-score gap between top-1 and
   top-2 (high / medium / low)
5. **`did_you_mean` recovery**: when a proxied tool call fails, the proxy
   intercepts the error and attaches BM25-ranked similar-tool suggestions
   so the agent can correct in one extra turn instead of giving up

### How the bench was actually run

```bash
# Scaling sweep — proves the structural claim (eager ∝ N, discover flat)
npm run bench:run -- --real --driver=opencode --model=openai/gpt-5-mini \
  --sweep --sizes=10,100,1000,3000 \
  --ids=adv-create --budget=0.50

# Full 5-task adversarial pack at a single N (accuracy / end-to-end cost)
npm run bench:run -- --real --driver=opencode --model=openai/gpt-5-mini \
  --sweep --sizes=1000 \
  --ids=adv-create,adv-get,adv-list,adv-update,adv-delete --budget=1.00
```

The discover arm auto-seeds the bench DB with `N` fake tools + embeddings
before running (requires `OPENAI_API_KEY` for `text-embedding-3-small`).

Combined cost of both runs above: **~$1.00 in API spend**, ~15 min wall.

Raw per-task results (including captured event streams for every run):
[`bench/_results/latest.json`](_results/latest.json).

### Caveats

- **n=1 per (task, arm, N)** — pilot numbers, not statistically replicated.
  The scaling signal (first-turn input tokens) is deterministic and
  survives n=1 cleanly. The accuracy and end-to-end cost numbers do not —
  both can shift ±20pp per task on rerun and should be treated as
  indicative.
- **Scaling claim is the load-bearing result.** First-turn input tokens
  at N ∈ {10, 100, 1000, 3000} reproduce cleanly: eager grows linearly,
  discover stays flat. This is independent of the model and of
  verb-collision accuracy noise.
- **5-task adversarial subset.** The full 25-task workload
  (`bench/workloads/tasks.json`) is also runnable; the adversarial pack
  is the most direct test of the "tool confusion" hypothesis, though
  gpt-5-mini currently solves it at 100% on both arms.
- **OpenCode + gpt-5-mini specifically.** Against Claude Code the
  first-turn scaling is flattened by the built-in MCP Tool Search; only
  the runtime-config benefit remains a clear differentiator there.
- **Stub tools return success unconditionally** — we measure discovery
  and selection, not real-world tool reliability.
- **Embedding cost**: ~$0.003 per 1000 tools to seed (OpenAI
  `text-embedding-3-small`). One-time at registration; queries are pure
  cosine over the local store with no further API spend.
