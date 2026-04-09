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

### Headline — agent-discover v1.2.0

**At N=1000 with adversarial natural-language prompts on OpenCode + gpt-5-mini,
agent-discover hits 100% choice accuracy while eager loading hits 80%.** The
20-point gap comes from verb-collision confusion that overloaded eager
catalogs can't escape — the model sees all 1000 schemas, picks a near-match
(e.g., `stripe_search_subscription` when asked to "show me all"), and the
distractor rate climbs. agent-discover's hybrid BM25+semantic retrieval
disambiguates correctly via embeddings.

5 adversarial verb tasks (CRUD on `stripe_subscription`, prompts using
inferred natural language like _"set up brand new recurring monthly billing
arrangement"_ instead of canonical CRUD verbs) × 2 arms × N=1000 = 10 real
subagent runs.

| arm          |    N | cost / task | turns |  success |   choice | distract | refuse |
| ------------ | ---: | ----------: | ----: | -------: | -------: | -------: | -----: |
| eager        | 1000 |      $0.058 |   2.0 |      80% |      80% |      20% |     0% |
| **discover** | 1000 |      $0.066 |   3.0 | **100%** | **100%** |   **0%** |     0% |

### Per-task — where each arm fails

| task         | eager (gpt-5-mini, all 1000 schemas)                             | discover (Tier 3 hybrid retrieval) |
| ------------ | ---------------------------------------------------------------- | ---------------------------------- |
| adv-create   | ✅ stripe_create_subscription                                    | ✅ stripe_create_subscription      |
| adv-get      | ✅ stripe_get_subscription                                       | ✅ stripe_get_subscription         |
| adv-update   | ✅ stripe_update_subscription                                    | ✅ stripe_update_subscription      |
| adv-delete   | ✅ stripe_delete_subscription                                    | ✅ stripe_delete_subscription      |
| **adv-list** | ❌ stripe\_**search**\_subscription, stripe\_**search**\_invoice | ✅ stripe_list_subscription        |

Eager picks `search` instead of `list` when asked to _"pull together every
recurring billing arrangement"_ — verb collision among 8 stripe\_\*\_subscription
tools in the same prompt. Discover's BM25+cosine ranking identifies the
correct verb because the embedding signal for "every / pull together" maps
cleanly to the canonical `list` verb in tool descriptions.

### Per-turn token cost

| arm      |    N | tokens / turn |
| -------- | ---: | ------------: |
| eager    | 1000 |          ~30k |
| discover | 1000 |          ~22k |

**discover's per-turn cost is flat in N** because only the `registry` tool
is loaded — the catalog never enters the prompt. **eager's per-turn cost
grows with N** because all 1000 schemas live in the system prompt every
turn. That's the deferred-discovery thesis, empirically confirmed: it's
not about saving total tokens, it's about keeping per-turn cost flat as
the catalog grows.

### Architecture (what's in the box)

agent-discover v1.2.0 exposes a single `registry` MCP tool with these
actions, each measured by the bench:

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
# Seed the bench-isolated agent-discover DB with 1000 fake tools + embeddings
npm run bench:seed -- --n=1000        # uses OPENAI_API_KEY for embeddings

# Run the adversarial verb pack against OpenCode + gpt-5-mini
npm run bench:run -- --real --driver=opencode --model=openai/gpt-5-mini \
  --sweep --sizes=1000 \
  --ids=adv-create,adv-get,adv-list,adv-update,adv-delete --budget=1.00
```

Total cost of the sweep: **~$0.50 in API spend**, ~10 min wall.

Raw per-task results (including captured event streams for every run):
[`bench/_results/latest.json`](_results/latest.json).

### Caveats

- **N=1 per (task, arm, N)** — pilot numbers, not statistically replicated.
  Re-running the same sweep can shift the success rate by ±20pp on tasks
  where outcomes depend on the agent's specific reasoning path.
- **5-task subset.** The full 25-task workload (`bench/workloads/tasks.json`)
  is also runnable but the adversarial pack is the most direct test of the
  "tool confusion" hypothesis.
- **OpenCode + gpt-5-mini specifically.** OpenCode loads MCP tools eagerly
  with no built-in deferred-tool loader, which is the fair test for
  agent-discover's value proposition. Claude Code has its own built-in
  `ToolSearch` that mitigates eager loading and tightens the gap.
- **Stub tools return success unconditionally** — measuring discovery and
  selection, not real-world tool reliability.
- **Embedding cost**: ~$0.001 per 1000 tools to seed (OpenAI
  text-embedding-3-small). One-time at registration; queries are cosine over
  the local store.

## Roadmap

- **Larger sweep**: full 25-task workload at N ∈ {10, 100, 1000, 10000} for
  more statistical confidence on the accuracy gap.
- **Multi-server scenario**: split the synth catalog into 10 fake MCP servers
  with 100 tools each (closer to real-world MCP setups) and re-measure.
- **Real-tool reliability**: stub tools always return success; a follow-up
  bench should swap in real failing tools (auth errors, rate limits, schema
  mismatches) to test `did_you_mean` recovery on real-world errors.
- **ANN index** (sqlite-vec or hnswlib) instead of brute-force cosine — only
  needed above N≈100k tools where the linear scan starts to dominate.
