// Free text the bank echoes back passes through its core systems, which use the
// Windows-1257 code page. Before the code-page restriction a fixed replacement table is
// applied (P 02 "Language and Code Pages", the rows for all receiver countries); what
// Windows-1257 still cannot hold becomes '?'.
const REPLACE: [string, string][] = [
  ['\\', '/'], [']}', ')'], ['[', '('], ['_~', '-'], ['`’', '’'],
  ['ĘĒÉĖ', 'E'], ['ęēéė', 'e'], ['ĆČ', 'C'], ['ćč', 'c'], ['Ģ', 'G'], ['ģ', 'g'],
  ['ĮĪ', 'I'], ['įī', 'i'], ['Ķ', 'K'], ['ķ', 'k'], ['ĻŁ', 'L'], ['ļł', 'l'],
  ['ŃŅ', 'N'], ['ńņ', 'n'], [' ', ' '], ['€', 'E'], ['ĄĀÅ', 'A'], ['æąāå', 'a'],
  ['ÓŌØ', 'O'], ['óōø', 'o'], ['ŪŲ', 'U'], ['ūų', 'u'], ['Ś', 'S'], ['śß', 's'], ['ŹŻ', 'Z'], ['źż', 'z'],
]
const MAP = new Map<string, string>()
for (const [from, to] of REPLACE) for (const ch of from) MAP.set(ch, to)

/** Characters Windows-1257 can encode (printable ASCII and the defined upper half). */
const CP1257 = (() => {
  const set = new Set<string>(['\t', '\n', '\r'])
  const bytes = Uint8Array.from({ length: 0x100 - 0x20 }, (_, i) => i + 0x20)
  const decoded = new TextDecoder('windows-1257').decode(bytes)
  for (const ch of decoded) {
    const cp = ch.codePointAt(0)!
    if (ch !== '�' && !(cp >= 0x7f && cp <= 0x9f)) set.add(ch)
  }
  return set
})()

/** Folds a text the way the bank's core systems store it. */
export function fold1257(s: string): string
export function fold1257(s: string | undefined): string | undefined
export function fold1257(s: string | undefined): string | undefined {
  if (s === undefined) return undefined
  let out = ''
  for (const ch of s) {
    const r = MAP.get(ch) ?? ch
    out += CP1257.has(r) ? r : '?'
  }
  return out
}
