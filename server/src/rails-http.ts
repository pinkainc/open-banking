// HttpRails: the rails as a client of an external bridge process that speaks to the real
// schemes (SEPA SCT, SEPA Instant, Faster Payments …). Small JSON protocol, documented in
// docs/rails-bridge-protocol.md (decisions 935–938):
//
//   us → bridge   POST /payments, POST /collections, GET /reachability/{iban}
//   bridge → us   POST /rails/events (payment outcomes, credits), railsCallbackApp()
//
// Every request both ways carries X-Rails-HMAC: hex(HMAC-SHA256(key = UTF-8 shared secret,
// message = raw body bytes)), as LHV's X-LHV-HMAC; a GET signs the empty body. A request
// whose HMAC does not match is refused 401. Payments, collections and callbacks are
// idempotent by ref: a repeat answers the current state and changes nothing.
import { createHmac, timingSafeEqual } from 'node:crypto'
import Fastify, { type FastifyInstance } from 'fastify'
import { fromMinor, toMinor } from './ledger.js'
import type {
  CollectionOutcome, CreditResult, IncomingCredit, OutgoingCollection, OutgoingPayment, Rails, RailsAnswer, RailsEvents, RailsOutcome, Scheme,
} from './rails.js'

export const HMAC_HEADER = 'x-rails-hmac'
const SCHEMES: readonly Scheme[] = ['SEPA', 'INST', 'SWIFT', 'TARGET2', 'FAST']

export function railsHmac(secret: string, body: string | Buffer): string {
  return createHmac('sha256', Buffer.from(secret, 'utf8')).update(body).digest('hex')
}

/** Constant-time comparison of a received hex HMAC with the expected one. */
export function hmacMatches(secret: string, body: string | Buffer, got: string | undefined): boolean {
  if (!got || !/^[0-9a-f]{64}$/i.test(got)) return false
  return timingSafeEqual(Buffer.from(railsHmac(secret, body), 'hex'), Buffer.from(got, 'hex'))
}

export interface HttpRailsOptions {
  /** The bridge's base URL (…/v1), or one per scheme; `collections` and `reachability` use `url`. */
  url: string
  urls?: Partial<Record<Scheme, string>>
  secret: string
  /** Per request (default 10 000 ms). */
  timeoutMs?: number
  /** Further attempts after a transport error or 5xx (default 2); the same ref every time. */
  retries?: number
  /** Pause before a further attempt (default 200 ms). */
  retryDelayMs?: number
  fetch?: typeof fetch
}

/** The bridge did not answer usefully (transport, 5xx after the retries, 4xx, or an answer outside the protocol). */
export class RailsBridgeError extends Error {}

/** A creditor's account as the bridge receives it: a 14-digit UK account also as sort code + account number. */
function creditorOf(c: OutgoingPayment['creditor']) {
  const uk = c.account && /^[0-9]{14}$/.test(c.account) ? { sortCode: c.account.slice(0, 6), accountNumber: c.account.slice(6) } : {}
  return { ...c, ...uk }
}

export class HttpRails implements Rails {
  #events?: RailsEvents
  readonly #o: Required<Pick<HttpRailsOptions, 'timeoutMs' | 'retries' | 'retryDelayMs'>> & HttpRailsOptions
  readonly #fetch: typeof fetch

  constructor(o: HttpRailsOptions) {
    if (!o.secret) throw new Error('HttpRails needs a shared secret')
    this.#o = { timeoutMs: 10_000, retries: 2, retryDelayMs: 200, ...o }
    this.#fetch = o.fetch ?? fetch
  }

  listen(events: RailsEvents) { this.#events = events }

  settlementAccount(scheme: string) { return `@settlement:${scheme}` }

  /**
   * POST /payments. A bridge that cannot be reached (after the retries) or answers outside
   * the protocol: `unavailable` (INST automatic → SEPA, else RJCT "Technical problem"),
   * decision 936.
   */
  async send(p: OutgoingPayment): Promise<RailsAnswer> {
    const base = this.#o.urls?.[p.scheme] ?? this.#o.url
    const body = {
      ref: p.ref, scheme: p.scheme, amount: fromMinor(p.amount), currency: p.currency,
      debtor: p.debtor, creditor: creditorOf(p.creditor), endToEndId: p.endToEndId, remittance: p.remittance,
    }
    try {
      const a = await this.#request(base, 'POST', '/payments', body) as { status?: string; reason?: unknown }
      if (a.status === 'accepted' || a.status === 'settled' || a.status === 'unavailable') return { status: a.status }
      if (a.status === 'rejected') return { status: 'rejected', reason: typeof a.reason === 'string' && a.reason ? a.reason : 'Payment declined.' }
      throw new RailsBridgeError(`payment ${p.ref}: status ${String(a.status)} is not in the protocol`)
    } catch (e) {
      if (e instanceof RailsBridgeError) return { status: 'unavailable' }
      throw e
    }
  }

  /** POST /collections: the debtor bank's answer at presentation (decision 933). */
  async collect(c: OutgoingCollection): Promise<CollectionOutcome> {
    const a = await this.#request(this.#o.url, 'POST', '/collections', { ...c, amount: fromMinor(c.amount) }) as { status?: string; code?: unknown }
    if (a.status === 'settled') return { status: 'settled' }
    if (a.status === 'rejected' && typeof a.code === 'string' && /^[A-Z0-9]{4}$/.test(a.code)) return { status: 'rejected', code: a.code }
    throw new RailsBridgeError(`collection ${c.ref}: answer ${JSON.stringify(a)} is not in the protocol`)
  }

  /** GET /reachability/{iban}: not reachable when the bridge does not say so (SEPA instead). */
  async instantReachable(iban: string): Promise<boolean> {
    try {
      const a = await this.#request(this.#o.url, 'GET', `/reachability/${encodeURIComponent(iban)}`) as { instant?: unknown }
      return a.instant === true
    } catch (e) {
      if (e instanceof RailsBridgeError) return false
      throw e
    }
  }

  /**
   * One callback from the bridge (POST /rails/events), raw body and its X-Rails-HMAC.
   * 401 bad HMAC, 400 outside the protocol, 503 before the engine listens; 200 with
   * `applied` (outcome) or the credit's result. Repeats are 200 and change nothing.
   */
  async callback(raw: Buffer, hmac: string | undefined): Promise<{ status: number; body: unknown }> {
    if (!hmacMatches(this.#o.secret, raw, hmac)) return { status: 401, body: { error: 'bad HMAC' } }
    let e: any
    try { e = JSON.parse(raw.toString('utf8')) } catch { return { status: 400, body: { error: 'not JSON' } } }
    if (!this.#events) return { status: 503, body: { error: 'not ready' } }
    if (e?.type === 'payment.outcome') {
      const outcome = outcomeOf(e.outcome)
      if (typeof e.ref !== 'string' || !e.ref || !outcome) return { status: 400, body: { error: 'payment.outcome needs ref and outcome' } }
      return { status: 200, body: { applied: await this.#events.outcome(e.ref, outcome) } }
    }
    if (e?.type === 'credit') {
      const credit = creditOf(e.credit)
      if (typeof credit === 'string') return { status: 400, body: { error: credit } }
      const r: CreditResult = await this.#events.credit(credit)
      return { status: 200, body: r }
    }
    return { status: 400, body: { error: `unknown event type ${String(e?.type)}` } }
  }

  async #request(base: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const raw = body === undefined ? '' : JSON.stringify(body)
    const headers: Record<string, string> = { [HMAC_HEADER]: railsHmac(this.#o.secret, raw), accept: 'application/json' }
    if (body !== undefined) headers['content-type'] = 'application/json'
    const url = base.replace(/\/+$/, '') + path
    let last = ''
    for (let attempt = 0; attempt <= this.#o.retries; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, this.#o.retryDelayMs))
      let res: Response
      try {
        res = await this.#fetch(url, { method, headers, body: body === undefined ? undefined : raw, signal: AbortSignal.timeout(this.#o.timeoutMs) })
      } catch (e) {
        last = `${method} ${url}: ${(e as Error).message}`
        continue
      }
      const text = await res.text()
      if (res.status >= 500) { last = `${method} ${url}: HTTP ${res.status}`; continue }
      if (res.status !== 200) throw new RailsBridgeError(`${method} ${url}: HTTP ${res.status} ${text.slice(0, 200)}`)
      try { return JSON.parse(text) } catch { throw new RailsBridgeError(`${method} ${url}: not JSON`) }
    }
    throw new RailsBridgeError(last)
  }
}

function outcomeOf(o: any): RailsOutcome | undefined {
  if (o?.status === 'settled' || o?.status === 'unavailable') return { status: o.status }
  if (o?.status === 'rejected') return { status: 'rejected', reason: typeof o.reason === 'string' && o.reason ? o.reason : 'Payment declined.' }
  return undefined
}

/** An IncomingCredit from the callback body, or what is wrong with it. */
function creditOf(c: any): IncomingCredit | string {
  if (!c || typeof c !== 'object') return 'credit is required'
  for (const k of ['ref', 'iban', 'amount', 'currency', 'scheme'] as const) if (typeof c[k] !== 'string' || !c[k]) return `credit.${k} is required`
  if (!SCHEMES.includes(c.scheme)) return `unknown scheme ${c.scheme}`
  if (!/^[A-Z]{3}$/.test(c.currency)) return `bad currency ${c.currency}`
  let amount: bigint
  try { amount = toMinor(c.amount) } catch { return `bad amount ${c.amount}` }
  if (amount <= 0n) return `bad amount ${c.amount}`
  const s = (v: unknown) => (typeof v === 'string' && v ? v : undefined)
  const d = c.debtor && typeof c.debtor === 'object' ? c.debtor : {}
  return {
    ref: c.ref, iban: c.iban, amount, currency: c.currency, scheme: c.scheme,
    debtor: { name: s(d.name), iban: s(d.iban), bic: s(d.bic), account: s(d.account) },
    creditorName: s(c.creditorName), remittance: s(c.remittance), reference: s(c.reference), endToEndId: s(c.endToEndId),
  }
}

/** The callback endpoint as its own (plain HTTP, internal) server: POST /rails/events. */
export function railsCallbackApp(rails: HttpRails, o: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({ logger: o.logger ?? false, bodyLimit: 1024 * 1024 })
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))
  app.post('/rails/events', async (req, reply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    const h = req.headers[HMAC_HEADER]
    const r = await rails.callback(raw, Array.isArray(h) ? h[0] : h)
    return reply.code(r.status).send(r.body)
  })
  return app
}
