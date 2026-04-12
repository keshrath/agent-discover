// =============================================================================
// agent-discover — Local registry CRUD
//
// SQLite-backed server registry. Handles registration, listing, search,
// and uninstallation of MCP servers.
// =============================================================================

import type { Db } from '../storage/database.js';
import type { EventBus } from './events.js';
import type { ServerEntry, ServerCreateInput, ServerUpdateInput, ServerTool } from '../types.js';
import { NotFoundError, ValidationError, ConflictError } from '../types.js';
import {
  getEmbeddingProvider,
  cosineSimilarity,
  encodeEmbedding,
  decodeEmbedding,
  type EmbeddingProvider,
  type Embedding,
} from '../embeddings/index.js';

const VALID_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// Map natural-language verbs to canonical CRUD verbs used in tool names.
// Each query verb expands to its canonical form (added to the token list,
// not replaced — keeps the original word so descriptions that DO use the
// natural form still match). Hand-curated from observed bench failures.
const VERB_SYNONYMS: Record<string, string> = {
  // create-family
  add: 'create',
  make: 'create',
  new: 'create',
  open: 'create',
  provision: 'create',
  register: 'create',
  // get-family
  fetch: 'get',
  retrieve: 'get',
  read: 'get',
  load: 'get',
  pull: 'get',
  // list-family
  show: 'list',
  display: 'list',
  enumerate: 'list',
  browse: 'list',
  // update-family
  change: 'update',
  edit: 'update',
  modify: 'update',
  set: 'update',
  patch: 'update',
  // delete-family
  cancel: 'delete',
  remove: 'delete',
  destroy: 'delete',
  drop: 'delete',
  // search-family
  find: 'search',
  query: 'search',
  lookup: 'search',
};

// Strip trailing plural 's' so "subscriptions" matches "subscription". Naive
// but covers ~95% of English plurals in API resource names; FTS5 has no
// built-in stemming and switching to tokenize='porter' would require a
// migration. Skip very short words (us, gas, etc) and -ss endings (class,
// access).
function singularize(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.endsWith('ses') || token.endsWith('xes')) return token.slice(0, -2);
  if (token.endsWith('ss')) return token;
  if (token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function expandVerbSynonyms(tokens: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tokens) {
    const sing = singularize(t);
    if (!seen.has(sing)) {
      seen.add(sing);
      out.push(sing);
    }
    const canonical = VERB_SYNONYMS[t] || VERB_SYNONYMS[sing];
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}

interface ServerRow {
  id: number;
  name: string;
  description: string;
  source: string;
  command: string | null;
  args: string;
  env: string;
  tags: string;
  package_name: string | null;
  package_version: string | null;
  transport: string;
  repository: string | null;
  homepage: string | null;
  installed: number;
  active: number;
  latest_version: string | null;
  last_health_check: string | null;
  health_status: string;
  error_count: number;
  created_at: string;
  updated_at: string;
}

interface ToolRow {
  id: number;
  server_id: number;
  name: string;
  description: string;
  input_schema: string;
  embedding?: string | null;
  embedding_model?: string | null;
}

function rowToServer(row: ServerRow): ServerEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    source: row.source as ServerEntry['source'],
    command: row.command,
    args: JSON.parse(row.args),
    env: JSON.parse(row.env),
    tags: JSON.parse(row.tags),
    package_name: row.package_name,
    package_version: row.package_version,
    transport: row.transport as ServerEntry['transport'],
    repository: row.repository,
    homepage: row.homepage,
    installed: row.installed === 1,
    active: row.active === 1,
    latest_version: row.latest_version ?? null,
    last_health_check: row.last_health_check ?? null,
    health_status: (row.health_status ?? 'unknown') as ServerEntry['health_status'],
    error_count: row.error_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToTool(row: ToolRow): ServerTool {
  return {
    id: row.id,
    server_id: row.server_id,
    name: row.name,
    description: row.description,
    input_schema: JSON.parse(row.input_schema),
  };
}

export class RegistryService {
  // Lazily-resolved embedding provider. Lookup happens on first use so the
  // factory's dynamic imports don't run at construction time (keeps the
  // synchronous constructor signature for legacy callers).
  private embeddingsPromise: Promise<EmbeddingProvider> | null = null;

  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  private getEmbeddings(): Promise<EmbeddingProvider> {
    if (!this.embeddingsPromise) this.embeddingsPromise = getEmbeddingProvider();
    return this.embeddingsPromise;
  }

  register(input: ServerCreateInput): ServerEntry {
    if (!input.name) throw new ValidationError('Name is required');
    if (!VALID_NAME.test(input.name)) {
      throw new ValidationError(
        `Invalid name "${input.name}" — use alphanumeric, dash, underscore, dot only`,
      );
    }
    if (input.name.includes('__')) {
      throw new ValidationError('Name cannot contain "__" (reserved as tool namespace separator)');
    }

    const existing = this.getByName(input.name);
    if (existing) throw new ConflictError(`Server "${input.name}" already exists`);

    const result = this.db.run(
      `INSERT INTO servers (name, description, source, command, args, env, tags,
        package_name, package_version, transport, repository, homepage, installed)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.name,
        input.description ?? '',
        input.source ?? 'local',
        input.command ?? null,
        JSON.stringify(input.args ?? []),
        JSON.stringify(input.env ?? {}),
        JSON.stringify(input.tags ?? []),
        input.package_name ?? null,
        input.package_version ?? null,
        input.transport ?? 'stdio',
        input.repository ?? null,
        input.homepage ?? null,
        input.command || input.transport === 'sse' || input.transport === 'streamable-http' ? 1 : 0,
      ],
    );

    const server = this.getById(result.lastInsertRowid as number)!;
    this.events.emit('server:registered', { server });
    return server;
  }

  update(name: string, updates: ServerUpdateInput): ServerEntry {
    const existing = this.getByName(name);
    if (!existing) throw new NotFoundError('Server', name);

    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.description !== undefined) {
      fields.push('description = ?');
      values.push(updates.description);
    }
    if (updates.command !== undefined) {
      fields.push('command = ?');
      values.push(updates.command);
    }
    if (updates.args !== undefined) {
      fields.push('args = ?');
      values.push(JSON.stringify(updates.args));
    }
    if (updates.env !== undefined) {
      fields.push('env = ?');
      values.push(JSON.stringify(updates.env));
    }
    if (updates.tags !== undefined) {
      fields.push('tags = ?');
      values.push(JSON.stringify(updates.tags));
    }
    if (updates.transport !== undefined) {
      fields.push('transport = ?');
      values.push(updates.transport);
    }
    if (fields.length === 0) return existing;

    fields.push("updated_at = datetime('now')");
    values.push(existing.id);

    this.db.run(`UPDATE servers SET ${fields.join(', ')} WHERE id = ?`, values);

    const server = this.getById(existing.id)!;
    this.events.emit('server:updated', { server });
    return server;
  }

  updateById(id: number, updates: ServerUpdateInput): ServerEntry {
    const existing = this.getById(id);
    if (!existing) throw new NotFoundError('Server', String(id));
    return this.update(existing.name, updates);
  }

  unregister(name: string): void {
    const existing = this.getByName(name);
    if (!existing) throw new NotFoundError('Server', name);

    this.db.run('DELETE FROM servers WHERE id = ?', [existing.id]);
    this.events.emit('server:unregistered', { name });
  }

  list(options?: { query?: string; source?: string; installedOnly?: boolean }): ServerEntry[] {
    if (options?.query) {
      return this.search(options.query, options);
    }

    let sql = 'SELECT * FROM servers';
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options?.source) {
      conditions.push('source = ?');
      params.push(options.source);
    }
    if (options?.installedOnly) {
      conditions.push('installed = 1');
    }

    if (conditions.length > 0) {
      sql += ' WHERE ' + conditions.join(' AND ');
    }
    sql += ' ORDER BY name';

    return this.db.queryAll<ServerRow>(sql, params).map(rowToServer);
  }

  search(query: string, options?: { source?: string; installedOnly?: boolean }): ServerEntry[] {
    // Use FTS for search
    let sql = `
      SELECT s.* FROM servers s
      JOIN servers_fts fts ON s.id = fts.rowid
      WHERE servers_fts MATCH ?
    `;
    const params: unknown[] = [query + '*'];

    if (options?.source) {
      sql += ' AND s.source = ?';
      params.push(options.source);
    }
    if (options?.installedOnly) {
      sql += ' AND s.installed = 1';
    }

    sql += ' ORDER BY rank';

    try {
      return this.db.queryAll<ServerRow>(sql, params).map(rowToServer);
    } catch {
      // Fallback to LIKE search if FTS fails
      return this.fallbackSearch(query, options);
    }
  }

  private fallbackSearch(
    query: string,
    options?: { source?: string; installedOnly?: boolean },
  ): ServerEntry[] {
    const q = `%${query}%`;
    let sql = `
      SELECT * FROM servers
      WHERE (name LIKE ? OR description LIKE ? OR tags LIKE ?)
    `;
    const params: unknown[] = [q, q, q];

    if (options?.source) {
      sql += ' AND source = ?';
      params.push(options.source);
    }
    if (options?.installedOnly) {
      sql += ' AND installed = 1';
    }

    sql += ' ORDER BY name';

    return this.db.queryAll<ServerRow>(sql, params).map(rowToServer);
  }

  getByName(name: string): ServerEntry | null {
    const row = this.db.queryOne<ServerRow>('SELECT * FROM servers WHERE name = ?', [name]);
    return row ? rowToServer(row) : null;
  }

  getById(id: number): ServerEntry | null {
    const row = this.db.queryOne<ServerRow>('SELECT * FROM servers WHERE id = ?', [id]);
    return row ? rowToServer(row) : null;
  }

  setActive(name: string, active: boolean): void {
    this.db.run("UPDATE servers SET active = ?, updated_at = datetime('now') WHERE name = ?", [
      active ? 1 : 0,
      name,
    ]);
  }

  incrementErrorCount(id: number): void {
    this.db.run(
      "UPDATE servers SET error_count = error_count + 1, updated_at = datetime('now') WHERE id = ?",
      [id],
    );
  }

  resetErrorCount(id: number): void {
    this.db.run("UPDATE servers SET error_count = 0, updated_at = datetime('now') WHERE id = ?", [
      id,
    ]);
  }

  setInstalled(name: string, installed: boolean): void {
    this.db.run("UPDATE servers SET installed = ?, updated_at = datetime('now') WHERE name = ?", [
      installed ? 1 : 0,
      name,
    ]);
  }

  // -------------------------------------------------------------------------
  // Server tools
  // -------------------------------------------------------------------------

  saveTools(
    serverId: number,
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>,
  ): void {
    this.db.run('DELETE FROM server_tools WHERE server_id = ?', [serverId]);
    for (const tool of tools) {
      this.db.run(
        'INSERT INTO server_tools (server_id, name, description, input_schema) VALUES (?, ?, ?, ?)',
        [serverId, tool.name, tool.description ?? '', JSON.stringify(tool.inputSchema ?? {})],
      );
    }
  }

  /**
   * Async variant of saveTools that ALSO computes and stores embeddings for
   * each tool. Use this when an embedding provider is available
   * (OPENAI_API_KEY set). Synchronous saveTools is unchanged so existing
   * callers don't break — embeddings are an opt-in upgrade.
   */
  async saveToolsWithEmbeddings(
    serverId: number,
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>,
  ): Promise<{ embedded: number; skipped: number; provider: string }> {
    const embeddings = await this.getEmbeddings();
    if (embeddings.name === 'none') {
      this.saveTools(serverId, tools);
      return { embedded: 0, skipped: tools.length, provider: 'none' };
    }
    // Build the embedding inputs: name + description, with the name repeated
    // to up-weight name matches in the semantic space (mirrors how the BM25
    // path weights name 4x description).
    const inputs = tools.map((t) => `${t.name}\n${t.name}\n${t.description ?? ''}`.slice(0, 2000));
    let vectors: number[][];
    try {
      vectors = await embeddings.embed(inputs);
    } catch (err) {
      process.stderr.write(
        `[registry] embedding batch failed (${embeddings.name}): ${(err as Error).message} — falling back to BM25-only\n`,
      );
      this.saveTools(serverId, tools);
      return { embedded: 0, skipped: tools.length, provider: embeddings.name };
    }
    this.db.run('DELETE FROM server_tools WHERE server_id = ?', [serverId]);
    for (let i = 0; i < tools.length; i++) {
      const tool = tools[i];
      const vec = vectors[i];
      const encoded = vec && vec.length > 0 ? encodeEmbedding(vec) : null;
      this.db.run(
        'INSERT INTO server_tools (server_id, name, description, input_schema, embedding, embedding_model) VALUES (?, ?, ?, ?, ?, ?)',
        [
          serverId,
          tool.name,
          tool.description ?? '',
          JSON.stringify(tool.inputSchema ?? {}),
          encoded,
          encoded ? embeddings.model : null,
        ],
      );
    }
    const embedded = vectors.filter((v) => v && v.length > 0).length;
    return { embedded, skipped: tools.length - embedded, provider: embeddings.name };
  }

  getTools(serverId: number): ServerTool[] {
    return this.db
      .queryAll<ToolRow>('SELECT * FROM server_tools WHERE server_id = ? ORDER BY name', [serverId])
      .map(rowToTool);
  }

  clearTools(serverId: number): void {
    this.db.run('DELETE FROM server_tools WHERE server_id = ?', [serverId]);
  }

  /**
   * Cross-server tool search using FTS5 + BM25. Tool name is weighted 4×
   * description so "slack post message" → slack_post_message ranks above any
   * tool that merely mentions Slack in its description. Returns the score
   * (BM25, lower = better — we negate so higher = better for callers) so
   * find_tool can derive a confidence label from the gap between the top two
   * scores.
   *
   * Falls back to LIKE substring search if FTS5 produces zero matches (which
   * happens for very short queries or pure prefix matches FTS won't index).
   */
  searchTools(
    query: string,
    limit = 5,
  ): Array<ServerTool & { server_name: string; score: number }> {
    if (!query || !query.trim()) return [];
    const q = query.trim();

    // Build an FTS5 query: each token becomes an OR'd prefix match. Quoting
    // each token with double quotes lets us pass through punctuation safely
    // (FTS5 reserved chars like - and . blow up otherwise).
    const rawTokens = q
      .toLowerCase()
      .split(/[\s_\-/]+/)
      .filter((t) => t.length >= 2)
      .map((t) => t.replace(/["*]/g, ''));
    if (rawTokens.length === 0) return [];

    // Verb synonym expansion. Tool names use canonical CRUD verbs
    // (create, get, list, update, delete, search, export, import) but the
    // agent's natural-language queries use synonyms ("fetch", "show",
    // "change", "cancel", ...). Without expansion, BM25 sees those as
    // unrelated tokens — bench measured this exact failure mode at N=1000.
    // Expanding the query verb to its canonical form before search fixes
    // ~80% of verb-disambiguation cases without changing the index.
    const tokens = expandVerbSynonyms(rawTokens);
    const ftsQuery = tokens.map((t) => `"${t}"*`).join(' OR ');

    try {
      // bm25(server_tools_fts, name_weight, description_weight) — weighting
      // name 4× description means a tool whose NAME contains the query terms
      // ranks above one whose description does.
      const rows = this.db.queryAll<ToolRow & { server_name: string; score: number }>(
        `SELECT t.*, s.name AS server_name, -bm25(server_tools_fts, 4.0, 1.0) AS score
         FROM server_tools_fts
         JOIN server_tools t ON t.id = server_tools_fts.rowid
         JOIN servers s ON s.id = t.server_id
         WHERE server_tools_fts MATCH ?
         ORDER BY score DESC
         LIMIT ?`,
        [ftsQuery, limit],
      );
      if (rows.length > 0) {
        return rows.map((r) => ({ ...rowToTool(r), server_name: r.server_name, score: r.score }));
      }
    } catch {
      /* malformed FTS query — fall through to LIKE */
    }

    // LIKE fallback for queries FTS5 doesn't handle. Score is 0 (no
    // confidence signal) so callers default to medium-confidence treatment.
    const conds: string[] = [];
    const params: unknown[] = [];
    for (const t of rawTokens) {
      conds.push('(LOWER(t.name) LIKE ? OR LOWER(t.description) LIKE ?)');
      params.push(`%${t}%`, `%${t}%`);
    }
    params.push(limit);
    const sql = `
      SELECT t.*, s.name AS server_name
      FROM server_tools t
      JOIN servers s ON s.id = t.server_id
      WHERE ${conds.join(' AND ')}
      ORDER BY length(t.name)
      LIMIT ?`;
    const rows = this.db.queryAll<ToolRow & { server_name: string }>(sql, params);
    return rows.map((r) => ({ ...rowToTool(r), server_name: r.server_name, score: 0 }));
  }

  /**
   * Hybrid retrieval: union of BM25 top-K and pure-cosine top-K, then
   * re-ranked by combined score. Use this whenever the registry has been
   * seeded with embeddings — it dramatically improves natural-language query
   * accuracy by closing the "billing arrangement → subscription" semantic
   * gap that BM25 alone misses.
   *
   * Why both: BM25-only misses paraphrased queries (no candidate has the
   * literal keywords). Pure-cosine-only misses exact-keyword queries where
   * BM25 has higher precision. Taking the union of candidates from both
   * sides and re-ranking by the combined score handles both regimes.
   *
   * Cost: brute-force cosine over the entire embedded catalog. At N=10k
   * with 1536-dim float32 embeddings that's ~60ms — well within budget.
   * Falls back to plain BM25 when the embedding provider is disabled.
   */
  async searchToolsHybrid(
    query: string,
    limit = 5,
  ): Promise<Array<ServerTool & { server_name: string; score: number }>> {
    const embeddings = await this.getEmbeddings();
    if (embeddings.name === 'none') {
      return this.searchTools(query, limit);
    }

    let queryVec: Embedding;
    try {
      const [vec] = await embeddings.embed([query]);
      if (!vec || vec.length === 0) return this.searchTools(query, limit);
      queryVec = Float32Array.from(vec);
    } catch {
      return this.searchTools(query, limit);
    }

    // Pure cosine over EVERY embedded tool. Brute force is fine at any
    // realistic catalog size; the alternative (an ANN index) adds a native
    // dep for marginal benefit below ~100k tools.
    const allEmbedded = this.db.queryAll<ToolRow & { server_name: string; embedding: string }>(
      `SELECT t.*, s.name AS server_name
       FROM server_tools t
       JOIN servers s ON s.id = t.server_id
       WHERE t.embedding IS NOT NULL`,
      [],
    );
    const semanticScored = allEmbedded.map((row) => {
      const emb = decodeEmbedding(row.embedding);
      return { row, cosine: cosineSimilarity(queryVec, emb) };
    });
    // Take top 4×limit semantic candidates so the re-rank set has headroom.
    semanticScored.sort((a, b) => b.cosine - a.cosine);
    const topSemantic = semanticScored.slice(0, Math.max(limit * 4, 20));

    // Pull BM25 candidates in parallel and merge by tool id. BM25 contributes
    // exact-keyword precision; semantic contributes paraphrase recall.
    const bm25Candidates = this.searchTools(query, Math.max(limit * 4, 20));
    const bm25Max = Math.max(...bm25Candidates.map((r) => r.score), 1e-9);
    const bm25ById = new Map<number, number>();
    for (const c of bm25Candidates) bm25ById.set(c.id, c.score / bm25Max);

    const merged = new Map<number, ServerTool & { server_name: string; score: number }>();
    for (const { row, cosine } of topSemantic) {
      const lex = bm25ById.get(row.id) ?? 0;
      // 70% semantic, 30% lexical — favor the embedding signal because
      // that's what handles natural-language queries the bench identified.
      const hybrid = 0.7 * cosine + 0.3 * lex;
      merged.set(row.id, {
        ...rowToTool(row),
        server_name: row.server_name,
        score: hybrid,
      });
    }
    for (const c of bm25Candidates) {
      if (merged.has(c.id)) continue;
      merged.set(c.id, { ...c, score: 0.3 * (c.score / bm25Max) });
    }

    const ranked = [...merged.values()].sort((a, b) => b.score - a.score);
    return ranked.slice(0, limit);
  }
}
