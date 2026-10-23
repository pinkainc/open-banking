// Response compression of message bodies (G fundamentals/response-compression, UK host
// only): a body of at least 10 MB is sent gzip- or deflate-compressed as the request's
// Accept-Encoding allows (gzip preferred), and is a technical error without either.
// Smaller bodies are never compressed. docs/decisions.md 503.
import { deflateSync, gzipSync } from 'node:zlib'

/** "At least 10 MB" (decimal megabytes; decision 503). */
export const COMPRESSION_THRESHOLD = 10_000_000

export type Encoding = 'gzip' | 'deflate'

/** The encoding to answer with, from an Accept-Encoding header; q=0 excludes, `*` means gzip. */
export function negotiate(header: string | string[] | undefined): Encoding | undefined {
  const accepted = new Set<string>()
  for (const part of (Array.isArray(header) ? header.join(',') : header ?? '').split(',')) {
    const [token, ...params] = part.trim().toLowerCase().split(';').map((x) => x.trim())
    if (!token) continue
    const q = params.find((p) => p.startsWith('q='))
    if (q !== undefined && !(Number(q.slice(2)) > 0)) continue
    accepted.add(token === 'x-gzip' ? 'gzip' : token)
  }
  if (accepted.has('gzip') || accepted.has('*')) return 'gzip'
  return accepted.has('deflate') ? 'deflate' : undefined
}

/** gzip (RFC 1952) or HTTP deflate (zlib, RFC 1950). */
export function compress(body: string | Buffer, encoding: Encoding): Buffer {
  return encoding === 'gzip' ? gzipSync(body) : deflateSync(body)
}
