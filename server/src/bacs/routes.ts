// HTTP surface of Bacs on the UK host: the three Connect operations (XML in, 202, the answer
// in the inbox) and the /_sim/bacs control plane playing the scheme (incoming credits,
// mandates, collections, scheme cancellations, reversals, the clock).
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Caller } from '../auth.js'
import { ConnectError } from '../errors.js'
import type { Emulator } from '../emulator.js'
import { requestId } from '../ids.js'
import { fromMinor, toMinor } from '../ledger.js'
import { accepted } from '../requests.js'
import { XmlSyntaxError } from '../xml.js'
import { BACS_TYPES, BacsRequestError, type Party } from './messages.js'
import { BacsError, isAccountNumber, isServiceUserNumber, isSortCode, type BacsCollection, type IncomingCredit, type Mandate } from './service.js'

/** POST /direct-debit/bacs-mandate-accept, -mandate-cancel, -collection-reject (UK host only, routing.ts). */
export function registerBacs(app: FastifyInstance, emulator: Emulator, caller: (req: FastifyRequest) => Promise<Caller>) {
  const svc = emulator.bacs
  const route = (path: string, what: string, type: string, handle: (xml: string, c: Caller, id: string) => Promise<void>) =>
    app.post(path, async (req, reply) => {
      const c = await caller(req)
      if (typeof req.body !== 'string' || !req.body.trim()) throw new ConnectError(400, 'BAD_REQUEST', `The request body must be a ${what} XML document`)
      const id = requestId()
      try {
        await handle(req.body, c, id)
      } catch (e) {
        if (e instanceof XmlSyntaxError) throw new ConnectError(400, 'BAD_REQUEST', `The request body is not well-formed XML: ${e.message}`)
        if (e instanceof BacsRequestError) throw new ConnectError(400, 'BAD_REQUEST', e.message)
        throw e
      }
      return accepted(emulator.requests, req, reply, c, id, type)
    })
  route('/direct-debit/bacs-mandate-accept', 'pain.012', BACS_TYPES.mandateConfirm, (xml, c, id) => svc.mandateResponse(xml, c.customer, id))
  route('/direct-debit/bacs-mandate-cancel', 'pain.011', BACS_TYPES.mandateCancel, (xml, c, id) => svc.mandateCancel(xml, c.customer, id))
  route('/direct-debit/bacs-collection-reject', 'pain.002', BACS_TYPES.collectionConfirm, (xml, c, id) => svc.collectionResponse(xml, c.customer, id))
}

const who = (c: { code: string; country: string }) => ({ code: c.code, country: c.country })
const at = (d?: Date) => d?.toISOString()

export const mandateView = (m: Mandate) => ({
  id: m.id, msgId: m.msgId, reference: m.reference, serviceUserNumber: m.serviceUserNumber, status: m.status,
  ...(m.reason ? { reason: m.reason } : {}), ...(m.closedBy ? { closedBy: m.closedBy, closedAt: at(m.closedAt) } : {}),
  creditor: m.creditor, debtor: m.debtor, customer: who(m.customer), processingDate: m.processingDate, entryDate: m.entryDate,
  createdAt: at(m.createdAt), ...(m.acceptedAt ? { acceptedAt: at(m.acceptedAt) } : {}), ...(m.activatedAt ? { activatedAt: at(m.activatedAt) } : {}),
  collections: m.collections,
})

export const collectionView = (c: BacsCollection) => ({
  id: c.id, msgId: c.msgId, endToEndId: c.endToEndId, mandateId: c.mandate.id, amount: fromMinor(c.amount), currency: 'GBP',
  ...(c.reference ? { reference: c.reference } : {}), seqTp: c.seqTp, processingDate: c.processingDate, entryDate: c.entryDate,
  status: c.status, ...(c.reason ? { reason: c.reason } : {}), debit: c.debit, attempts: c.attempts,
  ...(c.debitedAt ? { debitedAt: at(c.debitedAt) } : {}),
  ...(c.refund ? { refund: { kind: c.refund.kind, code: c.refund.code, due: new Date(c.refund.due).toISOString(), accountServicerReference: c.refund.ref, ...(c.refund.bookedAt ? { bookedAt: at(c.refund.bookedAt) } : {}) } } : {}),
  ...(c.reversal ? { reversal: { msgId: c.reversal.msgId, code: c.reversal.code, at: at(c.reversal.at) } } : {}),
})

export const creditView = (c: IncomingCredit) => ({
  accountServicerReference: c.ref, iban: c.iban, ...(c.master !== c.iban ? { masterAccount: c.master } : {}), customer: who(c.customer),
  amount: fromMinor(c.amount), currency: 'GBP', beneficiary: c.beneficiary, debtor: c.debtor, reference: c.reference,
  ...(c.numericReference ? { numericReference: c.numericReference } : {}), ...(c.serviceUserNumber ? { serviceUserNumber: c.serviceUserNumber } : {}),
  schemeTransactionId: c.schemeTransactionId, uniqueSchemeId: c.uniqueSchemeId, processingDate: c.processingDate, entryDate: c.entryDate,
  status: c.status, ...(c.bookedAt ? { bookedAt: at(c.bookedAt) } : {}),
})

/** /_sim/bacs (UK host): the Bacs scheme and the other banks. */
export function bacsSimRoutes(emulator: Emulator) {
  const svc = emulator.bacs
  const bad = (msg: string) => new ConnectError(400, 'BAD_REQUEST', msg)
  const run = async <T>(f: () => T | Promise<T>) => {
    try { return await f() } catch (e) {
      if (e instanceof BacsError) throw new ConnectError(e.status, e.status === 404 ? 'NOT_FOUND' : e.status === 409 ? 'CONFLICT' : 'BAD_REQUEST', e.message)
      throw e
    }
  }
  const str = (v: unknown, name: string) => {
    if (v !== undefined && typeof v !== 'string') throw bad(`${name} must be a string`)
    return v as string | undefined
  }
  const money = (v: unknown) => {
    if (typeof v !== 'string') throw bad('amount must be a decimal string')
    let n: bigint
    try { n = toMinor(v) } catch { throw bad(`invalid amount ${v}`) }
    if (n <= 0n) throw bad('amount must be positive')
    return n
  }
  const currency = (v: unknown) => { if (v !== undefined && v !== 'GBP') throw bad('Bacs is in GBP only') }
  /** {name, sortCode (6 digits), accountNumber (8 digits)}; the defaults make a valid external party. */
  const party = (v: unknown, name: string, fallback: string): Party => {
    if (v !== undefined && (typeof v !== 'object' || v === null)) throw bad(`${name} must be an object`)
    const p = (v ?? {}) as Record<string, unknown>
    const sortCode = str(p.sortCode, `${name}.sortCode`)?.replace(/-/g, '') ?? '600102'
    const accountNumber = str(p.accountNumber, `${name}.accountNumber`) ?? '20266221'
    if (!isSortCode(sortCode)) throw bad(`${name}.sortCode must be 6 digits`)
    if (!isAccountNumber(accountNumber)) throw bad(`${name}.accountNumber must be 8 digits`)
    return { name: str(p.name, `${name}.name`) ?? fallback, sortCode, accountNumber }
  }
  const sun = (v: unknown, required: boolean) => {
    const s = str(v, 'serviceUserNumber')
    if (s === undefined) { if (required) return '280421'; return undefined }
    if (!isServiceUserNumber(s)) throw bad('serviceUserNumber must be 6 digits')
    return s
  }
  const param = (req: FastifyRequest) => (req.params as { id: string }).id

  return async (app: FastifyInstance) => {
    // An incoming Bacs credit to a GB account (or VIBAN) here: BACS_INCOMING now, booked on the entry day.
    app.get('/incoming', async () => ({ incoming: svc.credits.map(creditView) }))
    app.post('/incoming', async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      const iban = str(b.iban, 'iban')
      if (!iban) throw bad('iban is required')
      currency(b.currency)
      const c = await run(() => svc.incoming({
        iban, amount: money(b.amount), debtor: party(b.debtor, 'debtor', 'Simulated Debtor'), reference: str(b.reference, 'reference'),
        numericReference: str(b.numericReference, 'numericReference'), serviceUserNumber: sun(b.serviceUserNumber, false),
      }))
      return reply.code(201).send(creditView(c))
    })

    // A Service User's new mandate on an account here: DIRECT_DEBIT_MANDATE_INITIATION (pain.009).
    app.get('/mandates', async () => ({ mandates: svc.mandates.entries().map(([, m]) => mandateView(m)) }))
    app.post('/mandates', async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      const debtorIban = str(b.debtorIban, 'debtorIban')
      if (!debtorIban) throw bad('debtorIban is required')
      const m = await run(() => svc.newMandate({
        debtorIban, creditor: party(b.creditor, 'creditor', 'Simulated Service User'), serviceUserNumber: sun(b.serviceUserNumber, true)!,
        reference: str(b.reference, 'reference'),
      }))
      return reply.code(201).send(mandateView(m))
    })
    app.post('/mandates/:id/scheme-cancel', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      return mandateView(await run(() => svc.schemeCancel(param(req), str(b.reason, 'reason'))))
    })

    // A collection under an active mandate: DIRECT_DEBIT_COLLECTION_NOTIFICATION (pain.008), debit on the entry day.
    app.get('/collections', async () => ({ collections: svc.collections.map(collectionView) }))
    app.post('/collections', async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      const mandateId = str(b.mandateId, 'mandateId')
      if (!mandateId) throw bad('mandateId is required')
      currency(b.currency)
      const c = await run(() => svc.collect({ mandateId, amount: money(b.amount), reference: str(b.reference, 'reference') }))
      return reply.code(201).send(collectionView(c))
    })
    app.post('/collections/:id/reversal', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      return collectionView(await run(() => svc.reverse(param(req), str(b.code, 'code'))))
    })

    // What is due by the emulator clock now (main.ts runs this every minute).
    app.post('/tick', async () => ({ done: await svc.tick() }))
  }
}
