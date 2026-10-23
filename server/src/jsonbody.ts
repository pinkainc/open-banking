// JSON request bodies of the EE JSON services (FX, contracts, EE webhooks). Those routes
// receive the body as text and parse it themselves: FX answers a malformed body in the
// inbox with the parser's own message (P 12 "Parameter type related errors" shows a
// Jackson text), the others with a JSON error envelope, never fastify's default 400.
import type { FastifyInstance } from 'fastify'

export class JsonBodyError extends Error {}

/**
 * Registers routes in a scope whose application/json bodies arrive as strings, so the
 * handlers can parse (and answer parse errors) the way the service documents.
 */
export function jsonTextScope(app: FastifyInstance, register: (scope: FastifyInstance) => void) {
  app.register(async (scope) => {
    scope.removeContentTypeParser('application/json')
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body))
    register(scope)
  })
}

/** Line and column (1-based) of a character offset. */
function lineColumn(text: string, offset: number) {
  const before = text.slice(0, offset)
  const line = before.split('\n').length
  return { line, column: offset - before.lastIndexOf('\n') }
}

/** Jackson echoes at most this many characters of the source (JsonLocation.MAX_CONTENT_SNIPPET). */
const SNIPPET = 500

/**
 * Where Jackson points: the source echoed raw between quotes (not escaped: the P 12 sample
 * shows its newlines and quotes as they were sent), cut at 500 characters with
 * "[truncated N chars]", then line and column.
 */
const at = (text: string, offset: number) => {
  const { line, column } = lineColumn(text, offset)
  const cut = text.length > SNIPPET ? `[truncated ${text.length - SNIPPET} chars]` : ''
  return `\n at [Source: (String)"${text.slice(0, SNIPPET)}"${cut}; line: ${line}, column: ${column}]`
}

/** The offset of the second digit of the first number with a leading zero (outside strings). */
function leadingZero(text: string): number | undefined {
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === '0' && /[0-9]/.test(text[i + 1] ?? '') && !/[0-9.eE+-]/.test(text[i - 1] ?? '')) return i + 1
  }
  return undefined
}

/**
 * Parses a JSON body. A parse failure throws JsonBodyError with a Jackson-style text:
 * the documented one for a number with leading zeroes, a generic one otherwise.
 */
export function parseJsonBody(body: unknown): unknown {
  if (body !== null && typeof body === 'object') return body
  const text = typeof body === 'string' ? body : ''
  if (!text.trim()) throw new JsonBodyError(`No content to map due to end-of-input${at(text, 0)}`)
  try {
    return JSON.parse(text)
  } catch (e) {
    const lz = leadingZero(text)
    if (lz !== undefined) throw new JsonBodyError(`Invalid numeric value: Leading zeroes not allowed${at(text, lz)}`)
    const pos = /position (\d+)/.exec((e as Error).message)
    throw new JsonBodyError(`JSON parse error: ${(e as Error).message.replace(/ in JSON at position.*$/, '')}${at(text, pos ? Number(pos[1]) + 1 : text.length)}`)
  }
}

/** The body as a plain object, or undefined when it is an array or a scalar. */
export const asObject = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
