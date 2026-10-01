# Retrieval bench

Retrieval-only evaluation of tool search: given a natural-language task, does
the ranker put an acceptable tool in its top-k? No LLM calls at eval time, no
network, fully deterministic. Runs in ~10 s.

```
npm run bench:retrieval                        # all rankers, held-out test split
npm run bench:retrieval -- --split=dev         # the only split you may tune on
npm run bench:retrieval -- --ranker=bm25,agent-discover-v1
```

Prints a table per split/category and writes `_results/<ranker>.json`
(aggregates for both splits + per-query step ranks, so regressions can be
diffed query by query).

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

448 hand-labelled queries, authored in `extract/queries.src.json` and compiled
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

55.6% of queries share no content word (>= 3 chars) with the name of any of
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

Within each category, queries are ordered by `sha1(id)`; the first 40% are
`dev` (179), the rest held-out `test` (269). **Ranker tuning (weights,
synonyms, thresholds, prompts for index-time enrichment) may only look at
dev.** Report test numbers. Adding a query only reshuffles its own category.

## Metrics

Per query, a step's rank = rank of its best-ranked alternative in the top 10.

- **R@k** — fraction of steps with an alternative in the top k (for
  single-step queries: hit@k), averaged over queries.
- **MRR** — 1 / rank of the first hit of any step.
- **nDCG@10** — binary gain 1 at each step's first hit (alternatives never
  double-count); ideal = all steps at ranks 1..n.
- **p50/p95 ms** — `search()` latency per query (index time reported in JSON).

All metrics are also broken down per category.

## Baselines (`baselines/`)

| ranker              | what                                                                                                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bm25`              | Okapi BM25 (k1 1.2, b 0.75) over name + description; camel/snake split, small stopword list, no stemming. ≈ Anthropic `tool_search_tool_bm25`.                                                                                              |
| `bm25-args`         | same + argument names/descriptions (the hosted BM25 tool also indexes arguments).                                                                                                                                                           |
| `regex`             | ≈ `tool_search_tool_regex` without the LLM that writes the pattern: case-insensitive alternation of the query's content words over name/description/args, name hits count double. A lower bound for an LLM-written regex.                   |
| `agent-discover-v1` | the **current** ranker on main, not a port: real `RegistryService` + migrations on in-memory SQLite (FTS5 `bm25(4,1)`, VERB_SYNONYMS, singularize, LIKE fallback) through `searchToolsHybrid()`; embeddings off by default (env to enable). |

### Results — held-out test split (n = 269)

| ranker            |   R@1 |   R@5 |  R@10 |   MRR | nDCG@10 | p50 ms |
| ----------------- | ----: | ----: | ----: | ----: | ------: | -----: |
| bm25              | 0.305 | 0.522 | 0.618 | 0.430 |   0.467 |    0.6 |
| bm25-args         | 0.302 | 0.534 | 0.610 | 0.427 |   0.461 |    0.9 |
| regex             | 0.341 | 0.509 | 0.574 | 0.449 |   0.467 |    6.7 |
| agent-discover-v1 | 0.307 | 0.561 | 0.642 | 0.446 |   0.485 |    2.9 |

R@10 by category (test):

| ranker            | paraphrase |  task | cross-server | multi-step | short-typo | german |
| ----------------- | ---------: | ----: | -----------: | ---------: | ---------: | -----: |
| bm25              |      0.459 | 0.472 |        0.905 |      0.806 |      0.879 |  0.389 |
| bm25-args         |      0.459 | 0.514 |        0.833 |      0.767 |      0.848 |  0.389 |
| regex             |      0.351 | 0.444 |        0.857 |      0.778 |      0.939 |  0.333 |
| agent-discover-v1 |      0.473 | 0.528 |        0.905 |      0.789 |      0.939 |  0.389 |

Reading: the current ranker beats plain BM25 by only ~2.4 points R@10 overall;
paraphrase / task / German — the vocabulary-gap categories — sit below 0.53
R@10 for every lexical baseline. That gap is what W1 (enrichment, stemming,
embeddings, hierarchical routing) has to close. Cross-server and short queries
look easy partly because they accept many alternatives.

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
2. Register a factory in `RANKERS` in `run.ts`.
3. Tune with `--split=dev`; report `--split=test`. Commit `_results/<name>.json`.

Index-time work (LLM enrichment, embeddings) belongs in `index()` and must be
cached/deterministic so the bench stays offline and reproducible.
