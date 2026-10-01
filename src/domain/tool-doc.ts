// =============================================================================
// agent-discover — Tool search documents
//
// Turns an upstream tool definition (+ its server, + optional enrichment)
// into the fielded text the FTS index and the embedding model see. Pure and
// deterministic: the same inputs always produce the same document, and
// `docHash` changes exactly when the embedded text would.
//
// Fields (weighted separately by the ranker, BM25F-style):
//   name        identifier split into words ("createTask" → "create task") + title
//   description the tool description
//   args        argument names (split) + argument descriptions, one level deep
//   enrichment  index-time enrichment: when-to-use, synthetic queries, keywords
//   server      server name (split) + server description
// =============================================================================

import { createHash } from 'node:crypto';

/** The search index: one row per server_tools row (rowid = id), written only by ToolIndex.save. */
export const FTS_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS server_tools_fts USING fts5(
    name, description, args, enrichment, server,
    tokenize = 'porter unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS server_tools_fts_ad AFTER DELETE ON server_tools BEGIN
    DELETE FROM server_tools_fts WHERE rowid = old.id;
  END;`;

export interface Enrichment {
  /** One or two sentences: the situations in which this tool is the right call. */
  readonly whenToUse: string;
  /** Realistic user requests this tool answers, in the user's words. */
  readonly queries: readonly string[];
  /** Synonyms and non-English (e.g. German) keywords for the tool's purpose. */
  readonly keywords: readonly string[];
}

export interface DocTool {
  readonly name: string;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly inputSchema?: Record<string, unknown> | null;
}

export interface DocServer {
  readonly name: string;
  readonly description?: string | null;
}

export interface ToolDocument {
  readonly name: string;
  readonly description: string;
  readonly args: string;
  readonly enrichment: string;
  readonly server: string;
  /** Text given to the embedding model. */
  readonly embedText: string;
  /** sha256 over every field — changes exactly when the indexed text does; embedding cache key. */
  readonly docHash: string;
}

/** "slack_post_message" / "createTask" / "API-get-self" / "maps.v2" → lower-case words. */
export function splitIdentifier(id: string): string {
  return id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

interface SchemaProp {
  description?: unknown;
  properties?: Record<string, SchemaProp>;
  items?: SchemaProp;
}

function argsText(schema: Record<string, unknown> | null | undefined, depth = 0): string[] {
  const props = (schema?.properties ?? {}) as Record<string, SchemaProp>;
  const out: string[] = [];
  for (const [key, prop] of Object.entries(props)) {
    out.push(splitIdentifier(key));
    if (typeof prop?.description === 'string') out.push(prop.description);
    if (depth < 1) {
      const nested = prop?.properties ? prop : prop?.items?.properties ? prop.items : null;
      if (nested) out.push(...argsText(nested as Record<string, unknown>, depth + 1));
    }
  }
  return out;
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

export function buildDocument(
  tool: DocTool,
  server: DocServer,
  enrichment?: Enrichment | null,
): ToolDocument {
  const name = [splitIdentifier(tool.name), tool.title ?? ''].filter(Boolean).join(' ');
  const description = clip(tool.description ?? '', 4000);
  const args = clip(argsText(tool.inputSchema).join(' '), 4000);
  const enrichmentText = enrichment
    ? [enrichment.whenToUse, ...enrichment.queries, ...enrichment.keywords].join(' ')
    : '';
  const serverText = [splitIdentifier(server.name), server.description ?? ''].join(' ').trim();
  const embedText = clip(
    [
      `${name} (${splitIdentifier(server.name)})`,
      description,
      enrichment ? [enrichment.whenToUse, ...enrichment.queries].join(' ') : '',
    ]
      .filter(Boolean)
      .join('\n'),
    2000,
  );
  const fields = { name, description, args, enrichment: enrichmentText, server: serverText };
  const docHash = createHash('sha256')
    .update(JSON.stringify([fields, embedText]))
    .digest('hex');
  return { ...fields, embedText, docHash };
}
