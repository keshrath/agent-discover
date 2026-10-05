# Retrieval bench

Retrieval-only evaluation of tool search: given a natural-language task, does
the ranker put an acceptable tool in its top-k, and does it answer nothing
when no tool fits? No LLM calls at eval time, no network, fully
deterministic. The zero-config run takes about 15 s.

```
npm run bench:retrieval                        # zero-config rankers, held-out test split
npm run bench:retrieval -- --split=dev         # the only split you may tune on
npm run bench:retrieval -- --ranker=bm25,agent-discover-v2
npm run bench:retrieval -- --ranker=agent-discover-v2-e5    # opt-in, see Rankers
npm run bench:retrieval -- --check             # CI: exit 1 if R@10 or MRR fell
```

The run prints a table per split and category. It writes
`_results/<ranker>.json` with the aggregates for both splits plus per-query
step ranks, so regressions can be diffed query by query.

CI runs `--check` on the zero-config rankers. It fails when dev or test R@10
or MRR drops below the committed `_results` file. To change a ranker on
purpose, commit the new results alongside the change.

## Corpus — `catalog.json`

50 real MCP servers, 1674 tools (name, description, inputSchema), captured by
spawning each server and calling `tools/list` with dummy credentials. Every
server carries its provenance (`npm:<pkg>@<version>`, `pip:<pkg>@<version>`,
`go:<module>@<version>`). Includes the reference servers (filesystem, git,
fetch, time, memory, sequential-thinking, everything, sqlite, postgres,
puppeteer, slack, gitlab, brave-search, google-maps, ...) and vendor servers
(GitHub, Atlassian, Grafana, Playwright, Chrome DevTools, Notion, Linear,
Stripe, Supabase, Sentry, DigitalOcean, Postman, Contentful, Mailgun, Azure
DevOps, CircleCI, Firecrawl, Tavily, Exa, Perplexity, Pinecone, Mapbox, ...).

The tool-count distribution is deliberately realistic and skewed (DigitalOcean
353, Postman 204, Linear 198 ... single-tool servers), and descriptions range
from rich to empty (Todoist, DigitalOcean ship none) — exactly what a ranker
faces in practice. The legacy `bench/fake-tools` catalog is not included: it is
synthetic and would dilute the point.

Stripe: `@stripe/mcp` >= 0.3 is only a proxy to the hosted mcp.stripe.com, so
the corpus uses `@stripe/agent-toolkit@0.7.9` (last release with local tool
definitions) via `extract/launchers/stripe-agent-toolkit.ts`.

Dropped because they would not answer `tools/list` offline within the 90 s
hard deadline (need a live backend, real auth, or crash on start): redis,
heroku, kubernetes, neon, mongodb, elasticsearch, twilio, paypal,
desktop-commander, google-calendar, railway, apify, mysql, auth0, clickup,
monday, cloudflare.

Refreshing the corpus (not run in CI; the committed JSON is the frozen corpus):

```
python -m venv .venv && .venv/bin/pip install mcp-server-git mcp-server-fetch mcp-server-time mcp-server-sqlite mcp-atlassian
GOBIN=$PWD/.gobin go install github.com/github/github-mcp-server/cmd/github-mcp-server@latest
GOBIN=$PWD/.gobin go install github.com/grafana/mcp-grafana/cmd/mcp-grafana@latest
W1_VENV=.venv W1_GOBIN=.gobin npx tsx bench/retrieval/extract/extract-catalog.ts [--only=id,...]
npx tsx bench/retrieval/extract/build-queries.ts   # re-validates every label
```

Knobs: `W1_SPAWN_TIMEOUT_MS` (per-server hard deadline, default 20000; the
whole process tree is killed on expiry), `W1_CONCURRENCY` (default 6),
`W1_NPM_REGISTRY`. Launch specs live in `extract/servers.json`.

## Queries — `queries.json`

468 hand-labelled queries, authored in `extract/queries.src.json` and compiled
by `extract/build-queries.ts` (assigns ids + split, fails on any label that is
not a tool in the catalog).

| category       |   n | what it tests                                                                            |
| -------------- | --: | ---------------------------------------------------------------------------------------- |
| `paraphrase`   | 123 | one specific tool, described in different words ("land an approved GitHub PR into main") |
| `task`         | 120 | the user's goal, not the operation ("find out why CI failed on my PR")                   |
| `cross-server` |  70 | generic intents several servers can serve ("take a screenshot of the current page")      |
| `multi-step`   |  50 | decomposable tasks needing 2-3 tools ("create a Stripe product, price and payment link") |
| `short-typo`   |  55 | 1-3 word and misspelled queries ("git stauts", "slak msg")                               |
| `german`       |  30 | German phrasing over English tool metadata                                               |
| `none`         |  20 | unanswerable by any catalog tool ("book a flight", "turn off the lights"); `targets: []` |

55.6% of answerable queries share no content word (>= 3 chars) with the name of any of
their acceptable tools (printed by the builder) — name-matching alone cannot
solve the set.

### Label policy

- `targets` is a list of **steps**; each step lists **acceptable alternatives**
  (`server/tool`). Multi-label by design (ToolEX: alternatives are often
  equally valid) — e.g. "take a screenshot" accepts Playwright, Puppeteer and
  Chrome DevTools.
- An alternative is listed when calling it would directly accomplish the step
  with no extra tool. Tools that merely could help (e.g. a generic "run code"
  tool) are not listed.
- A query that names a platform ("... in Stripe") is labelled with that
  platform's tools only; unnamed intents get every server that can do it.
- Single-step queries have one step. Multi-step queries list steps in order;
  every step must be covered for full recall.

### Splits

Within each category, queries are ordered by `sha1(id)`. The first 40% are
`dev`: 187 queries, 179 answerable and 8 `none`. The rest are held-out
`test`: 281 queries, 269 answerable and 12 `none`. **Ranker tuning (weights,
thresholds, fusion) may only look at dev.** Report test numbers. Adding a
query only reshuffles its own category.

## Metrics

Per query, a step's rank = rank of its best-ranked alternative in the top 10.

- **R@k** — fraction of steps with an alternative in the top k (for
  single-step queries: hit@k), averaged over queries.
- **MRR** — 1 / rank of the first hit of any step.
- **nDCG@10** — binary gain 1 at each step's first hit (alternatives never
  double-count); ideal = all steps at ranks 1..n.
- **p50/p95 ms** — `search()` latency per query (index time reported in JSON).
- **none-rejected** — share of unanswerable queries answered with an empty
  list (higher is better).
- **false-rejected** — share of answerable queries answered with an empty list
  (lower is better).

Recall, MRR and nDCG cover answerable queries only. Every metric is also
broken down per category.

## Rankers (`baselines/`)

| ranker                       | what                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bm25`                       | Okapi BM25 (k1 1.2, b 0.75) over name + description; camel/snake split, small stopword list, no stemming. ≈ Anthropic `tool_search_tool_bm25`.                                                                                                                                        |
| `bm25-args`                  | same + argument names/descriptions (the hosted BM25 tool also indexes arguments).                                                                                                                                                                                                     |
| `regex`                      | ≈ `tool_search_tool_regex` without the LLM that writes the pattern: case-insensitive alternation of the query's content words over name/description/args, name hits count double. A lower bound for an LLM-written regex.                                                             |
| `agent-discover-v1`          | the 1.4 ranker: FTS5 `bm25(4,1)`, VERB_SYNONYMS, singularize and LIKE fallback, measured through the real 1.4 `RegistryService`. That code is gone in 2.0, so the result is **frozen** in `_results/agent-discover-v1.frozen.json`. It was scored on the same 448 answerable queries. |
| `agent-discover-v2`          | the shipped 2.0 path, zero-config: in-memory DB with all migrations, `ToolIndex.save` per server, then `ToolIndex.search`. No key, no download.                                                                                                                                       |
| `agent-discover-v2-e5`       | same path with `AGENT_DISCOVER_EMBEDDING_PROVIDER=local` (multilingual-e5-small). Opt-in: `npm install --no-save @huggingface/transformers` first. The first run downloads ~130 MB, and indexing the 1674 tools takes ~3 min on one CPU thread. Not run in CI.                        |
| `agent-discover-v2-enriched` | **not a shipped feature.** `agent-discover-v2` with each tool's description extended by the committed LLM enrichment cache `enrichment.json` (when-to-use, 5 synthetic queries, keywords incl. German; keyed by tool hash). Runs offline.                                             |

### What tuning on dev chose

- **Field weights** name 6 / description 1.5 / args 0.5. Args 0 cost about 3 points R@10; a server-text field gave nothing and was dropped.
- **Porter stemming**, with mixed-case words indexed whole and split. The query side had split `GitLab` while descriptions kept `gitlab`; fixing that asymmetry was the largest lexical gain.
- **No IDF-coverage multiplier.** It cost about 3 points R@10.
- **Typo repair on.** short-typo dev R@10 is .773 without it and .864 with it.
- **Server routing** 0.3 / 0.3. Without it, R@1 drops by about 2 points.
- **Dense fusion** weighted 0.5, with per-query min-max rescaling. It beat RRF (k 10 and 60) and median rescaling.

**No-match.** On the 8 dev `none` queries, no candidate signal separates them from answerable queries: IDF-weighted query coverage of the best hit, its BM25 score, and raw or rescaled cosine all fail. The lowest-coverage answerable queries ("slak msg", "cat file") score below "book a flight to Lisbon". 2.0 therefore ships no score floor. The plain baselines reject some `none` queries only because they return nothing when no word matches; 2.0's typo repair always finds a nearest word.

### Results — held-out test split (269 answerable + 12 unanswerable)

| ranker                     |   R@1 |   R@5 |  R@10 |   MRR | nDCG@10 | p50 ms | none-rejected | false-rejected |
| -------------------------- | ----: | ----: | ----: | ----: | ------: | -----: | ------------: | -------------: |
| bm25                       | 0.305 | 0.522 | 0.618 | 0.430 |   0.467 |    0.3 |         0.417 |          0.041 |
| bm25-args                  | 0.302 | 0.534 | 0.610 | 0.427 |   0.461 |    0.4 |         0.417 |          0.033 |
| regex                      | 0.341 | 0.509 | 0.574 | 0.449 |   0.467 |    4.1 |         0.250 |          0.004 |
| agent-discover-v1 (frozen) | 0.307 | 0.561 | 0.642 | 0.446 |   0.485 |    3.2 |             – |              – |
| **agent-discover-v2**      | 0.338 | 0.576 | 0.661 | 0.474 |   0.507 |    2.4 |         0.000 |          0.000 |
| agent-discover-v2-e5       | 0.381 | 0.618 | 0.722 | 0.522 |   0.559 |   16.3 |         0.000 |          0.000 |
| agent-discover-v2-enriched | 0.610 | 0.876 | 0.922 | 0.750 |   0.785 |    3.9 |         0.000 |          0.000 |

R@10 by category (test):

| ranker                     | paraphrase |  task | cross-server | multi-step | short-typo | german |
| -------------------------- | ---------: | ----: | -----------: | ---------: | ---------: | -----: |
| bm25                       |      0.459 | 0.472 |        0.905 |      0.806 |      0.879 |  0.389 |
| bm25-args                  |      0.459 | 0.514 |        0.833 |      0.767 |      0.848 |  0.389 |
| regex                      |      0.351 | 0.444 |        0.857 |      0.778 |      0.939 |  0.333 |
| agent-discover-v1 (frozen) |      0.473 | 0.528 |        0.905 |      0.789 |      0.939 |  0.389 |
| **agent-discover-v2**      |      0.568 | 0.500 |        0.857 |      0.794 |      0.939 |  0.500 |
| agent-discover-v2-e5       |      0.662 | 0.514 |        0.952 |      0.844 |      0.939 |  0.667 |
| agent-discover-v2-enriched |      0.946 | 0.903 |        1.000 |      0.867 |      0.939 |  0.778 |

### Reading the results

- **Zero-config 2.0 vs plain BM25:** +4.3 points R@10 and +4.4 MRR. Most of the gain is in paraphrase (+11) and German (+11).
- **Adding multilingual-e5-small:** another +6 R@10 and +5 MRR, at ~16 ms per query and a 3-minute first index.
- **Task-style queries** ("find out why CI failed") stay near 0.5 for every configuration without enrichment.
- **Enrichment** measures .922 R@10 offline, by far the biggest lever. It needs an LLM at index time, so it is not shipped in 2.0.
- **Caveat on enrichment:** the cache came from agent sessions that saw only tool definitions, never `queries.json`. The queries were also LLM-written, so treat .922 as an upper bound.

## Adding a ranker

1. Implement `Ranker` from `types.ts`:
   ```ts
   interface Ranker {
     name: string;
     index(tools: ToolDoc[]): Promise<void>; // whole catalog, once
     search(query: string, k: number): Promise<Hit[]>; // { server, tool, score }
     close?(): Promise<void>;
   }
   ```
2. Register a factory in `RANKERS` in `run.ts` (add it to `ZERO_CONFIG` if it
   needs no key or download, so CI guards it).
3. Tune with `--split=dev`; report `--split=test`. Commit `_results/<name>.json`.

Index-time work (embeddings, cached enrichment) belongs in `index()` and must
be cached/deterministic so the bench stays offline and reproducible.
