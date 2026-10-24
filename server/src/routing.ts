// Which LHV entity answers a request (decisions 700–703). The EE host (connect.lhv.eu) is
// LHV Pank only. The UK host (connect.lhv.com) answers as LHV UK, and hands a request to
// LHV EE when it carries `X-Bank-Code: LHVEE` (G lhv-uk-and-estonia-integrations
// "Override Option": "any API request is processed in LHV EE"). Services that exist on
// one side only are gated here, in one table, so a route registered anywhere gets the
// same rule: on the UK host an EE-only service needs the header, a UK-only one refuses
// it, both with the 404 of an unknown route. The response X-Bank-Code says who answered.
import type { FastifyInstance, FastifyReply, FastifyRequest, RouteOptions } from 'fastify'

export type BankCode = 'LHVEE' | 'LHVUK'
export type Flavour = 'EE' | 'UK'

/** The X-Bank-Code request header, when it names an entity (any case); anything else is ignored. */
export function requestedBank(req: FastifyRequest): BankCode | undefined {
  const v = req.headers['x-bank-code']
  const s = String((Array.isArray(v) ? v[0] : v) ?? '').trim().toUpperCase()
  return s === 'LHVEE' || s === 'LHVUK' ? s : undefined
}

/**
 * The entity that processes a request on this host: the host's own bank, or on the UK
 * host the one the X-Bank-Code header asks for. The EE host ignores the header (it has
 * no UK services since 2023-08-22).
 */
export function bankFor(req: FastifyRequest, flavour: Flavour, hostBank: string): string {
  if (flavour !== 'UK') return hostBank
  return requestedBank(req) ?? hostBank
}

/** A UK payment account: the IBAN starts with GB (G "LHV UK migration and details"). */
export const isUkAccount = (iban: string) => /^GB/i.test(iban)

type Rule = { method?: string; path: RegExp }
/** LHV EE services the UK host only reaches with `X-Bank-Code: LHVEE` (`ssot/ee-vs-uk.md` "EE only"). */
export const EE_ONLY: Rule[] = [
  { path: /^\/fx\// },
  { path: /^\/contracts(\/|$)/ },
  { path: /^\/acq\// },
  { path: /^\/direct-debit\/(collection|incoming-collection)$/ },
  { method: 'POST', path: /^\/heartbeat$/ },
  { path: /^\/notifications\/subscribe$/ },
  { path: /^\/notifications\/subscriptions(\/|$)/ },
]
/**
 * LHV UK services (`ssot/ee-vs-uk.md` "UK only"): registered on the UK host only; there a
 * request with `X-Bank-Code: LHVEE` goes to LHV EE, which has no such service.
 */
export const UK_ONLY: Rule[] = [
  { path: /^\/accounts\// },
  { path: /^\/v2\// },
  { path: /^\/messages\/test\/next$/ },
  { path: /^\/payment\/(vop|cop)-request$/ },
  { path: /^\/direct-debit\/bacs-/ },
  { path: /^\/notifications\/subscription(\/|$)/ },
  { path: /^\/notifications\/(history|replay)(\/|$)/ },
]

const methods = (m: RouteOptions['method']) => (Array.isArray(m) ? m : [m]).map((x) => String(x).toUpperCase())
const matches = (rules: Rule[], r: RouteOptions) =>
  rules.some((x) => x.path.test(r.url) && (!x.method || methods(r.method).includes(x.method)))

/**
 * Sets X-Bank-Code on every response (the entity that processes the request) and gates
 * the one-sided services on the UK host. Call before any route is registered.
 */
export function hostRouting(app: FastifyInstance, flavour: Flavour, hostBank: string) {
  app.addHook('onRequest', async (req, reply) => { reply.header('X-Bank-Code', bankFor(req, flavour, hostBank)) })
  if (flavour !== 'UK') return
  app.addHook('onRoute', (r) => {
    if (r.url.startsWith('/_sim')) return
    const ee = matches(EE_ONLY, r)
    const uk = !ee && matches(UK_ONLY, r)
    if (!ee && !uk) return
    const gate = async (req: FastifyRequest, reply: FastifyReply) => {
      const lhvEe = bankFor(req, flavour, hostBank) === 'LHVEE'
      if (ee ? !lhvEe : lhvEe) {
        reply.callNotFound()
        return reply
      }
    }
    const before = r.onRequest
    r.onRequest = before === undefined ? [gate] : Array.isArray(before) ? [...before, gate] : [before, gate]
  })
}
