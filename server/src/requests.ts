// Submitted requests (decisions 630–632): every request answered 202 with a
// Message-Request-Id is recorded here, in one place (`accepted`), with its body exactly
// as it arrived, for GET /v2/requests and GET /v2/requests/{RequestId}. Bounded like the
// inbox (decision 504): five days, at most 10 000 by default.
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Caller } from './auth.js'
import { BoundedMap, DEFAULT_BOUNDS, type Bounds } from './bounded.js'
import type { Clock } from './clock.js'
import { keyOf, type CustomerKey } from './directory.js'
import { closeRequest } from './ids.js'

export interface SubmittedRequest {
  id: string
  /** The response type the request is answered with (messageResponseType). */
  type: string
  clientCode: string
  clientCountry: string
  /** The X-Bank-Code of the 202 (LHVEE for EE VoP on the UK host, decision 607). */
  bankCode: string
  createdAt: Date
  body: string
  contentType: string
  seq: number
}

export class RequestLog {
  #m: BoundedMap<string, SubmittedRequest>
  #seq = 0
  constructor(private clock: Clock, bounds: Bounds = DEFAULT_BOUNDS.requests) { this.#m = new BoundedMap(clock, bounds) }

  get size() { return this.#m.size }
  purge() { return this.#m.purge() }

  record(r: { id: string; customer: CustomerKey; type: string; bankCode: string; body: string; contentType: string }): SubmittedRequest {
    const s: SubmittedRequest = {
      id: r.id, type: r.type, clientCode: r.customer.code, clientCountry: r.customer.country, bankCode: r.bankCode,
      createdAt: this.clock.now(), body: r.body, contentType: r.contentType, seq: ++this.#seq,
    }
    this.#m.set(s.id, s)
    closeRequest(s.id)
    return s
  }

  /** A request of one of the customers, or undefined (unknown, someone else's, forgotten). */
  get(customers: Set<string>, id: string): SubmittedRequest | undefined {
    const r = this.#m.get(id)
    return r && customers.has(keyOf({ code: r.clientCode, country: r.clientCountry })) ? r : undefined
  }

  /** The bank code a request was answered under, while it is remembered. */
  bankCodeOf(id: string): string | undefined { return this.#m.get(id)?.bankCode }

  /** The customers' requests, oldest first. */
  list(customers: Set<string>): SubmittedRequest[] {
    return this.#m.entries().map(([, r]) => r)
      .filter((r) => customers.has(keyOf({ code: r.clientCode, country: r.clientCountry })))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.seq - b.seq)
  }
}

/** The request body as text: what the route received (raw for XML and jsonTextScope routes). */
function rawBody(body: unknown): string {
  if (typeof body === 'string') return body
  if (body === undefined || body === null) return ''
  return Buffer.isBuffer(body) ? body.toString('utf8') : JSON.stringify(body)
}

/**
 * The 202 of every asynchronous operation: records the request (its body as submitted,
 * the caller's customer, the response type, the X-Bank-Code already set on the reply)
 * and answers with its Message-Request-Id.
 */
export function accepted(requests: RequestLog, req: FastifyRequest, reply: FastifyReply, c: Caller, id: string, type: string) {
  const ct = req.headers['content-type']
  requests.record({
    id, customer: c.customer, type, bankCode: String(reply.getHeader('X-Bank-Code') ?? ''),
    body: rawBody(req.body), contentType: (Array.isArray(ct) ? ct[0] : ct) || 'application/xml',
  })
  return reply.code(202).header('Message-Request-Id', id).send()
}
