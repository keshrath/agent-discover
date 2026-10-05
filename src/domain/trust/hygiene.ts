// =============================================================================
// agent-discover — Description hygiene
//
// Upstream tool/server descriptions are untrusted text that ends up in the
// model's context. Before they are passed on:
//   - control, zero-width and bidi-override characters are stripped (they
//     hide instructions from humans reviewing the text);
//   - length is capped (configurable) so one server can't flood the context.
// Separately, a small set of explicit heuristics FLAGS (never drops)
// instruction-like content; flags surface in server_status, search results
// and the audit log. No LLM, no scoring: each flag is one readable regex.
// =============================================================================

// C0/C1 controls except \t \n, zero-width chars, bidi embeddings/overrides/isolates,
// word joiner + invisible operators, BOM, interlinear annotations, tag characters.
/* eslint-disable no-control-regex */
const INVISIBLE = new RegExp(
  '[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB]|\uDB40[\uDC00-\uDC7F]',
  'g',
);
/* eslint-enable no-control-regex */

export type HygieneFlag =
  | 'invisible-chars'
  | 'instruction-override'
  | 'hidden-tag'
  | 'exfiltration'
  | 'secret-access'
  | 'conceal-from-user';

const HEURISTICS: Array<[HygieneFlag, RegExp]> = [
  // "ignore all previous instructions", "disregard the above rules"
  [
    'instruction-override',
    /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|system)\b[^.\n]{0,30}\b(instructions?|prompts?|rules|directions|guidelines)\b/i,
  ],
  // <IMPORTANT>, <system>, <instructions>, <hidden> ... tags aimed at the model
  [
    'hidden-tag',
    /<\s*\/?\s*(important|system|instructions?|secret|hidden|admin|assistant)\b[^>]*>/i,
  ],
  // "send ... to https://", "curl -d @file http://"
  [
    'exfiltration',
    /\b(send|post|upload|forward|transmit|exfiltrate|report)\b[^\n]{0,80}\bto\b[^\n]{0,20}https?:\/\/|\b(curl|wget)\b[^\n]{0,80}https?:\/\//i,
  ],
  // reading other credentials: ~/.ssh, id_rsa, .env, mcp.json, other tools' API keys
  [
    'secret-access',
    /(~\/\.ssh|\bid_rsa\b|\.aws\/credentials|\bmcp\.json\b|\b(read|cat|include|pass|send|copy|provide)\b[^.\n]{0,40}\b(\.env|api[ _-]?keys?|access[ _-]?tokens?|passwords?|credentials|private[ _-]?keys?)\b)/i,
  ],
  // "do not tell the user", "never mention this to the user"
  [
    'conceal-from-user',
    /\b(do not|don't|never|without)\b[^.\n]{0,20}\b(tell|telling|inform|informing|mention|mentioning|reveal|revealing|show|showing|notify|notifying)\b[^.\n]{0,30}\buser\b/i,
  ],
];

/** Strip invisible characters and cap the length (adds an ellipsis when cut). */
export function cleanText(text: string, maxLength: number): string {
  const stripped = text.replace(INVISIBLE, '');
  if (maxLength <= 0 || stripped.length <= maxLength) return stripped;
  return `${stripped.slice(0, Math.max(0, maxLength - 1))}…`;
}

/** Flags raised by `text` (scanned BEFORE cleaning, so hidden content still counts). */
export function scanText(text: string): HygieneFlag[] {
  const flags: HygieneFlag[] = [];
  INVISIBLE.lastIndex = 0;
  if (INVISIBLE.test(text)) flags.push('invisible-chars');
  const visible = text.replace(INVISIBLE, '');
  for (const [flag, re] of HEURISTICS) if (re.test(visible)) flags.push(flag);
  return flags;
}

/** Flags for a tool: its description plus every string inside its input schema. */
export function scanTool(tool: { description: string; input_schema: unknown }): HygieneFlag[] {
  const flags = new Set(scanText(tool.description));
  for (const f of scanText(JSON.stringify(tool.input_schema ?? {}))) flags.add(f);
  return [...flags];
}
