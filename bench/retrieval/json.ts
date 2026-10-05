// JSON.stringify output that `prettier --check` accepts as-is (printWidth 100):
// arrays without objects inside are collapsed onto one line (innermost first)
// when that line fits; everything else keeps JSON.stringify's expanded layout,
// which is what prettier prints for it. Lets the generators rewrite
// catalog/queries/results without a separate format pass.

const WIDTH = 100;
// An expanded array whose items are primitives or already-collapsed arrays.
const EXPANDED =
  /\[\n\s*((?:[^[\]{}\n]|\[[^[\]{}\n]*\])*(?:,\n\s*(?:[^[\]{}\n]|\[[^[\]{}\n]*\])*)*)\n\s*\]/g;

export function toJson(value: unknown): string {
  let text = JSON.stringify(value, null, 2);
  for (let prev = ''; prev !== text; ) {
    prev = text;
    text = prev.replace(EXPANDED, (match: string, body: string, offset: number) => {
      const lineStart = prev.lastIndexOf('\n', offset) + 1;
      const collapsed = `[${body.split(/,\n\s*/).join(', ')}]`;
      const trailing = prev[offset + match.length] === ',' ? 1 : 0;
      return offset - lineStart + collapsed.length + trailing <= WIDTH ? collapsed : match;
    });
  }
  return text + '\n';
}
