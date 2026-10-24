// Name matching for payee verification (VoP, CoP; docs/decisions.md 601). Deterministic
// and documented, so a client can predict the answer:
//   FULL  — equal after case folding, removing diacritics and collapsing whitespace;
//   CLOSE — equal word sets once punctuation and a trailing legal form are dropped
//           (reordered words, "Ltd" missing), the shorter name's words in order inside
//           the longer one with the same first and last word (a middle name missing),
//           initials for words, or a small typo (edit distance 1 from 4 characters, 2 from 10);
//   NONE  — anything else.

export type NameMatch = 'FULL' | 'CLOSE' | 'NONE'

/** Case, diacritics and whitespace folded: what FULL compares. */
export function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/** Legal forms dropped from the end of a name before the CLOSE rules. */
const LEGAL_FORMS = new Set(['ltd', 'limited', 'plc', 'llp', 'llc', 'inc', 'corp', 'ou', 'as', 'uab', 'sia', 'oy', 'ab', 'gmbh', 'ag', 'sa', 'bv', 'nv', 'srl'])

/** Words of a folded name without punctuation and without a trailing legal form. */
export function words(s: string): string[] {
  const w = fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean)
  return w.length > 1 && LEGAL_FORMS.has(w[w.length - 1]) ? w.slice(0, -1) : w
}

/** Optimal string alignment distance (Levenshtein plus adjacent transpositions). */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ')

/** `short` in order inside `long`, at least two words, the same first and last word. */
function middleOmitted(short: string[], long: string[]) {
  if (short.length < 2 || short.length >= long.length) return false
  if (short[0] !== long[0] || short[short.length - 1] !== long[long.length - 1]) return false
  let i = 0
  for (const w of long) if (w === short[i]) i++
  return i === short.length
}

/** Word for word equal or one an initial of the other, with at least one whole word equal. */
function initials(a: string[], b: string[]) {
  if (a.length !== b.length || a.length < 2) return false
  let whole = 0
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) { whole++; continue }
    const [x, y] = a[i].length === 1 ? [a[i], b[i]] : [b[i], a[i]]
    if (x.length !== 1 || y.length < 2 || !y.startsWith(x)) return false
  }
  return whole > 0
}

/** How the name given in a request compares with the account holder's name. */
export function matchName(given: string, actual: string): NameMatch {
  const g = fold(given)
  const a = fold(actual)
  if (!g || !a) return 'NONE'
  if (g === a) return 'FULL'
  const gw = words(given)
  const aw = words(actual)
  if (!gw.length || !aw.length) return 'NONE'
  if (sameSet(gw, aw) || middleOmitted(gw, aw) || middleOmitted(aw, gw) || initials(gw, aw)) return 'CLOSE'
  const gs = gw.join(' ')
  const as = aw.join(' ')
  const longer = Math.max(gs.length, as.length)
  const limit = longer >= 10 ? 2 : longer >= 4 ? 1 : 0
  return limit > 0 && editDistance(gs, as) <= limit ? 'CLOSE' : 'NONE'
}
