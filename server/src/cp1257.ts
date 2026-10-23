// Free text as the bank's core keeps it (P 02 / G "Language and Code Pages",
// decision 526): Connect's documented character replacements first (some depend on the
// receiver bank's BIC country), then every character outside Windows-1257 becomes "?".

/** The printable characters of Windows-1257 above ASCII (bytes 0x80–0xFF that are assigned). */
const HIGH = '€‚„…†‡‰‹¨ˇ¸‘’“”•–—™›¯˛ ¢£¤¦§Ø©Ŗ«¬­®Æ°±²³´µ¶·ø¹ŗ»¼½¾æĄĮĀĆÄÅĘĒČÉŹĖĢĶĪĻŠŃŅÓŌÕÖ×ŲŁŚŪÜŻŽßąįāćäåęēčéźėģķīļšńņóōõö÷ųłśūüżž˙'
const ALLOWED = new Set([...HIGH])

/** "Character replacements for all payments". */
const ALL: Record<string, string> = {}
for (const [chars, to] of [
  ['\\', '/'], [']}', ')'], ['[', '('], ['_~', '-'], ['`’', "'"],
  ['ĘĒÉĖ', 'E'], ['ęēéė', 'e'], ['ĆČ', 'C'], ['ćč', 'c'], ['Ģ', 'G'], ['ģ', 'g'], ['ĮĪ', 'I'], ['įī', 'i'],
  ['Ķ', 'K'], ['ķ', 'k'], ['ĻŁ', 'L'], ['ļł', 'l'], ['ŃŅ', 'N'], ['ńņ', 'n'], [' ', ' '], ['€', 'E'],
  ['ĄĀÅ', 'A'], ['æąāå', 'a'], ['ÓŌØ', 'O'], ['óōø', 'o'], ['ŪŲ', 'U'], ['ūų', 'u'], ['Ś', 'S'], ['śß', 's'],
  ['ŹŻ', 'Z'], ['źż', 'z'],
] as const) for (const c of chars) ALL[c] = to

/** "Additional replacements based on receiver bank BIC country": ISO = all but EE and GB. */
type Zone = 'ISO' | 'EE' | 'GB'
const ZONE: [string, string, Zone[]][] = [
  ['{', '(', ['ISO', 'EE']], [';', 'č', ['ISO', 'EE']],
  ['Ä', 'A', ['ISO', 'GB']], ['ä', 'a', ['ISO', 'GB']], ['ÕÖ', 'O', ['ISO', 'GB']], ['õö', 'o', ['ISO', 'GB']],
  ['Ü', 'U', ['ISO', 'GB']], ['ü', 'u', ['ISO', 'GB']], ['Š', 'S', ['ISO', 'GB']], ['š', 's', ['ISO', 'GB']],
  ['Ž', 'Z', ['ISO', 'GB']], ['ž', 'z', ['ISO', 'GB']],
]
const BY_ZONE: Record<Zone, Record<string, string>> = { ISO: {}, EE: {}, GB: {} }
for (const [chars, to, zones] of ZONE) for (const z of zones) for (const c of chars) BY_ZONE[z][c] = to

const zoneOf = (country?: string): Zone => (country === 'EE' ? 'EE' : country === 'GB' ? 'GB' : 'ISO')

/** Is this character kept by Windows-1257 (printable ASCII, tab and line breaks included)? */
export function inCp1257(c: string): boolean {
  const n = c.codePointAt(0)!
  return (n >= 0x20 && n <= 0x7e) || n === 0x09 || n === 0x0a || n === 0x0d || ALLOWED.has(c)
}

/** Only the code page: characters outside Windows-1257 become "?" (one per code point). */
export function codePage(text: string): string
export function codePage(text: string | undefined): string | undefined
export function codePage(text: string | undefined) {
  if (text === undefined) return undefined
  let out = ''
  for (const c of text) out += inCp1257(c) ? c : '?'
  return out
}

/**
 * Outgoing payment text for a receiver bank in `country` (ISO 3166 alpha-2 of its BIC;
 * EE for LHV itself): the documented replacements, then the code page.
 */
export function fold(text: string, country?: string): string
export function fold(text: string | undefined, country?: string): string | undefined
export function fold(text: string | undefined, country?: string) {
  if (text === undefined) return undefined
  const zone = BY_ZONE[zoneOf(country)]
  let out = ''
  for (const c of text) {
    const r = zone[c] ?? ALL[c] ?? c
    out += inCp1257(r) ? r : '?'
  }
  return out
}
