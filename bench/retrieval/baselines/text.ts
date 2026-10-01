// Shared tokenizer for the lexical baselines. Splits snake_case, kebab-case,
// camelCase and punctuation; lowercases; drops a small English stopword list.
// Deliberately no stemming or synonyms — baselines must stay plain.

const STOP = new Set(
  'a an and are as at be by can do does for from has have how i if in into is it its me my of on or our so that the their them then there these this to us was we what when where which who why will with you your'.split(
    ' ',
  ),
);

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

/** Argument names + argument descriptions, flattened (top-level properties only). */
export function schemaText(schema: Record<string, unknown>): string {
  const props = (schema.properties ?? {}) as Record<string, { description?: unknown }>;
  return Object.entries(props)
    .map(([k, v]) => `${k} ${typeof v?.description === 'string' ? v.description : ''}`)
    .join(' ');
}
