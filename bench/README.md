# agent-discover bench

Two benches live here.

| Bench                | Question                                                                              | Needs an LLM | Where                               |
| -------------------- | ------------------------------------------------------------------------------------- | :----------: | ----------------------------------- |
| **Retrieval bench**  | Given a task, does the ranker put an acceptable tool in its top-k?                    |      no      | [`retrieval/`](retrieval/README.md) |
| **Agent-loop bench** | Is a deferred, search-then-call flow cheaper than loading every tool schema up front? |     yes      | this file                           |

The retrieval bench is the one that gates changes (CI runs `npm run bench:retrieval -- --check`). Its results are in the [top-level README](../README.md#search-quality) and its own README: on the held-out test split, zero-config 2.0 reaches R@10 .661 against .618 for plain BM25 and .642 for 1.x, and .722 with the opt-in `multilingual-e5-small` embeddings. An LLM-enrichment row (.922) is bench-only and an upper bound; see that README for why.

The rest of this file is the agent-loop bench.

## What it asks

> When an agent has access to a large MCP catalog, is it cheaper, faster and still correct to expose agent-discover's meta tools and fetch tools on demand, instead of putting every tool's full JSON schema into the prompt up front?

Positioning note: current hosts ship their own tool search, so on those hosts the "eager" arm is not really eager and the first-turn gap collapses. This bench measures the hosts that do load every schema (OpenCode is the reference one here) and agent-discover's proxy mode. It is not evidence about hosts with native tool search.

## Two arms

| Arm          | Tools loaded into the agent                                               | Discovery model                                                                                   |
| ------------ | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| **eager**    | All N stub tools from the `fake-tools` server, full schemas in the prompt | Built in: the model sees every tool from the start                                                |
| **discover** | agent-discover only, in proxy mode (`AGENT_DISCOVER_MODE=proxy`)          | `search_tools({queries})` once, then `call_tool({server, tool, arguments})`; `get_tool` if needed |

Both arms run the same task set against the same N stub tools; only the delivery differs. The discover arm talks to its own daemon (own port, own database) seeded with the N stub tools through the real install path (`npm run bench:seed -- --n=100`).

## Workload

`workloads/tasks.json` holds the task set (obvious-name, ambiguous, multi-tool, distractor and an adversarial CRUD pack). Each task has a natural-language goal, the expected tool calls, a loose argument shape and a success predicate checked against the captured call log. Distractor tasks have no matching tool, to catch an arm that hallucinates a plausible name.

`fake-tools/server.mjs` is a small MCP server that emits N stub tools (`FAKE_TOOL_COUNT`, default 100) drawn from realistic tool-name patterns with small, medium and fat schemas. Calls return a structured success blob with no side effects; the runner asserts on the call log.

## Metrics

Per task and arm: `input_tokens`, `output_tokens`, `cache_read_tokens`, `total_cost_usd`, `wall_seconds`, `turns`, `task_success`, `tool_choice_correct`, and `discovery_calls` (calls to the meta tools other than `call_tool`). Token counts come from the agent CLI's own output, not estimates.

## Layout

```
bench/
  runner.ts                 pilot dispatch and results write
  drivers/cli.ts            Claude CLI driver (headless `claude -p`)
  drivers/opencode.ts       OpenCode driver
  fake-tools/               stub MCP server, tool catalog, seed-registry.ts
  workloads/tasks.json
  rescore.ts                re-score captured runs
  _results/latest.json      written by each run
  retrieval/                the retrieval bench (own README)
```

## How to run

```bash
# Smoke test with the mock driver (no agents, fake numbers)
npm run bench:run

# Single point: all tasks at N=100 in both arms
npm run bench:run -- --real --n=100

# Sweep
npm run bench:run -- --real --driver=opencode --model=openai/gpt-5-mini \
  --sweep --sizes=10,100,1000,3000 --ids=adv-create --budget=0.50
```

Real runs cost money (the eager arm dominates the bill) and need the agent CLI you choose installed and authenticated. The discover arm seeds its database with the N stub tools first; set `AGENT_DISCOVER_EMBEDDING_PROVIDER=openai` and a key to include embeddings in the seed.

## Results (measured on agent-discover 1.4, not re-run on 2.0)

These numbers come from the 1.4 `registry({action: "find_tool"})` flow on OpenCode with gpt-5-mini, one run per cell, captured event streams in `_results/`. The 2.0 discover arm is a different tool surface (`search_tools` then `call_tool`), so treat the cost figures as indicative of the idea, not of 2.0. Re-run the sweep before quoting them.

### Scaling of first-turn input tokens

Eager's grow linearly with N and eventually exceed the context window; discover's stay flat. This is structural and the most reproducible signal here.

|    N | eager turn-1 input       | discover turn-1 input | discover advantage                    |
| ---: | :----------------------- | --------------------: | ------------------------------------- |
|   10 | 20,893                   |                20,836 | about equal (overhead dominates)      |
|  100 | 32,389                   |                20,836 | 1.55x cheaper                         |
| 1000 | 160,868                  |                20,840 | 7.72x cheaper                         |
| 3000 | context overflow, failed |                20,837 | eager unusable; discover still scales |

### End-to-end accuracy and cost (adversarial CRUD pack, N=1000)

| arm      | choice accuracy | success rate | cost / task | turns |
| -------- | :-------------: | :----------: | ----------: | ----: |
| eager    |      100%       |     100%     |      $0.068 |   2.0 |
| discover |      100%       |     100%     |      $0.086 |   3.0 |

Both arms disambiguate the adversarial verbs on gpt-5-mini. Discover costs slightly more end to end because the search result stays in the conversation and inflates later turns (on `adv-list` at N=1000, turn 2 input was 173,671 for discover against 161,381 for eager). The cost win is clear only for workloads that resolve in one or two turns and have a large catalog.

### Caveats

- n=1 per (task, arm, N). The first-turn scaling is deterministic and survives that; accuracy and end-to-end cost can shift by 20 points per task on a rerun.
- OpenCode and gpt-5-mini only. Hosts with their own tool search (Claude Code, Codex, the Anthropic and OpenAI APIs) flatten the eager arm, so the gap does not apply there.
- Stub tools return success unconditionally: this measures discovery and selection, not tool reliability.
- Embedding the 1000-tool catalog with OpenAI `text-embedding-3-small` costs about $0.003 per 1000 tools, once at index time.
