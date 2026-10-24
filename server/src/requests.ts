// Submitted requests (decisions 630–632): every request answered 202 with a
// Message-Request-Id is recorded here, in one place (`accepted`), with its body exactly
// as it arrived, for GET /v2/requests and GET /v2/requests/{RequestId}. Bounded like the
// inbox (decision 504): five days, at most 10 000 by default. Kept in the keyed store
// (decision 989), so a restart keeps them.
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { Caller } from './auth.js'
import { DEFAULT_BOUNDS, type Bounds } from './bounded.js'
import type { Clock } from './clock.js'
import { keyOf, type CustomerKey } from './directory.js'
import { closeRequest } from './ids.js'
import { memoryKeyed, type KeyedFactory, type KeyedStore } from './keyed.js'

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

/** Stored form (decision 989): the time in ms. */
interface StoredRequest extends Omit<SubmittedRequest, 'createdAt'> { createdAt: number }

export class RequestLog {
  readonly #m: KeyedStore<StoredRequest>
  #seq = 0
  constructor(private clock: Clock, bounds: Bounds = DEFAULT_BOUNDS.requests, keyed: KeyedFactory = memoryKeyed(clock)) {
    this.#m = keyed('requests', bounds)
  }

  /** How many are remembered. */
  async size() { return (await this.#m.entries()).length }

  async record(r: { id: string; customer: CustomerKey; type: string; bankCode: string; body: string; contentType: string }): Promise<SubmittedRequest> {
    const s: SubmittedRequest = {
      id: r.id, type: r.type, clientCode: r.customer.code, clientCountry: r.customer.country, bankCode: r.bankCode,
      createdAt: this.clock.now(), body: r.body, contentType: r.contentType, seq: ++this.#seq,
    }
    try {
      await this.#m.set(s.id, { ...s, createdAt: s.createdAt.getTime() })
    } finally {
      closeRequest(s.id)
    }
    return s
  }

  async #get(id: string): Promise<SubmittedRequest | undefined> {
    const r = await this.#m.get(id)
    return r && { ...r, createdAt: new Date(r.createdAt) }
  }

  /** A request of one of the customers, or undefined (unknown, someone else's, forgotten). */
  async get(customers: Set<string>, id: string): Promise<SubmittedRequest | undefined> {
    const r = await this.#get(id)
    return r && customers.has(keyOf({ code: r.clientCode, country: r.clientCountry })) ? r : undefined
  }

  /** The bank code a request was answered under, while it is remembered. */
  async bankCodeOf(id: string): Promise<string | undefined> { return (await this.#get(id))?.bankCode }

  /** The customers' requests, oldest first (the stored order breaks ties of equal times). */
  async list(customers: Set<string>): Promise<SubmittedRequest[]> {
    return (await this.#m.entries()).map(([, r]) => ({ ...r, createdAt: new Date(r.createdAt) }))
      .filter((r) => customers.has(keyOf({ code: r.clientCode, country: r.clientCountry })))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
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
export async function accepted(requests: RequestLog, req: FastifyRequest, reply: FastifyReply, c: Caller, id: string, type: string) {
  const ct = req.headers['content-type']
  await requests.record({
    id, customer: c.customer, type, bankCode: String(reply.getHeader('X-Bank-Code') ?? ''),
    body: rawBody(req.body), contentType: (Array.isArray(ct) ? ct[0] : ct) || 'application/xml',
  })
  return reply.code(202).header('Message-Request-Id', id).send()
}
