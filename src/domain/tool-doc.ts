// =============================================================================
// agent-discover — Tool search documents
//
// Turns an upstream tool definition into the fielded text the FTS index and
// the embedding model see. Pure and deterministic, and a function of the
// tool definition alone — so the tool hash is the cache key for both the FTS
// row and the stored vector, and identical tools on two servers embed once.
//
// Fields (weighted separately by the ranker):
//   name        tool name + title, identifier-split ("createTask" → "createtask create task")
//   description the tool description
//   args        argument names (split) + argument descriptions, one level deep
// =============================================================================

/** The search index: one row per server_tools row (rowid = id), written only by ToolIndex.save. */
export const FTS_SCHEMA = `
  CREATE VIRTUAL TABLE IF NOT EXISTS server_tools_fts USING fts5(
    name, description, args,
    tokenize = 'porter unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER IF NOT EXISTS server_tools_fts_ad AFTER DELETE ON server_tools BEGIN
    DELETE FROM server_tools_fts WHERE rowid = old.id;
  END;`;

export interface DocTool {
  readonly name: string;
  readonly title?: string | null;
  readonly description?: string | null;
  readonly inputSchema?: Record<string, unknown> | null;
}

export interface ToolDocument {
  readonly name: string;
  readonly description: string;
  readonly args: string;
  /** Text given to the embedding model. */
  readonly embedText: string;
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

/**
 * Index-side words: lower-case, split at every non-alphanumeric; a mixed-case
 * word is kept whole AND split ("GitLab" → "gitlab git lab"), so a query
 * matches whether the user types "gitlab", "GitLab" or "git lab".
 */
export function indexWords(text: string): string {
  const out: string[] = [];
  for (const w of text.split(/[^\p{L}\p{N}]+/u)) {
    if (!w) continue;
    const parts = splitIdentifier(w);
    if (parts.includes(' ')) out.push(w.toLowerCase());
    out.push(parts);
  }
  return out.join(' ');
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
    out.push(key);
    if (typeof prop?.description === 'string') out.push(prop.description);
    if (depth < 1) {
      const nested = prop?.properties ? prop : prop?.items?.properties ? prop.items : null;
      if (nested) out.push(...argsText(nested as Record<string, unknown>, depth + 1));
    }
  }
  return out;
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

export function buildDocument(tool: DocTool): ToolDocument {
  const description = clip(tool.description ?? '', 4000);
  const title = tool.title ?? '';
  return {
    name: indexWords(`${tool.name} ${title}`),
    description: indexWords(description),
    args: indexWords(clip(argsText(tool.inputSchema).join(' '), 4000)),
    embedText: clip(
      [`${splitIdentifier(tool.name)} ${title}`.trim(), description].filter(Boolean).join('\n'),
      2000,
    ),
  };
}
