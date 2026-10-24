// HTTP surface of SEPA Direct Debit: the two Connect operations and the emulator's own
// /_sim/direct-debit control plane (collections from other banks, R-transactions,
// settlement, the debtor bank's rejections).
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Caller } from '../auth.js'
import { ConnectError } from '../errors.js'
import type { Emulator } from '../emulator.js'
import { normalizeIban } from '../iban.js'
import { requestId } from '../ids.js'
import { accepted } from '../requests.js'
import { fromMinor, toMinor } from '../ledger.js'
import { SimulatorRails } from '../rails.js'
import { isDate } from '../statements/camt060.js'
import { XmlSyntaxError } from '../xml.js'
import type { Collection } from './messages.js'
import { DD_TYPES, DirectDebitError, type ExternalCollection } from './service.js'

export function registerDirectDebit(app: FastifyInstance, emulator: Emulator, caller: (req: FastifyRequest) => Promise<Caller>) {
  const route = (path: string, handle: (xml: string, c: Caller, id: string) => Promise<void>, what: string, type: string) =>
    app.post(path, async (req, reply) => {
      const c = await caller(req)
      if (typeof req.body !== 'string' || !req.body.trim()) throw new ConnectError(400, 'BAD_REQUEST', `The request body must be a ${what} XML document`)
      const id = requestId()
      try {
        await handle(req.body, c, id)
      } catch (e) {
        if (e instanceof XmlSyntaxError) throw new ConnectError(400, 'BAD_REQUEST', `The request body is not well-formed XML: ${e.message}`)
        throw e
      }
      return accepted(emulator.requests, req, reply, c, id, type)
    })
  route('/direct-debit/collection', (xml, c, id) => emulator.directDebit.collect(xml, c.customer, id), 'pain.008', DD_TYPES.outgoing)
  route('/direct-debit/incoming-collection', (xml, c, id) => emulator.directDebit.refuse(xml, c.customer, id), 'pain.007', DD_TYPES.incoming)
}

/** A collection as the control plane shows it (amounts as decimal strings, customers as codes). */
export function collectionView(c: Collection) {
  const who = (x?: { code: string; country: string }) => (x ? { code: x.code, country: x.country } : undefined)
  return {
    id: c.id, status: c.status, ...(c.reason ? { reason: c.reason } : {}),
    msgId: c.msgId, pmtInfId: c.pmtInfId, endToEndId: c.endToEndId, ...(c.instrId ? { instrId: c.instrId } : {}),
    amount: fromMinor(c.amount), currency: c.currency, dueDate: c.dueDate, settlementDate: c.settlementDate,
    mandateId: c.mandateId, creditor: c.creditor, debtor: c.debtor,
    creditorCustomer: who(c.creditorCustomer), debtorCustomer: who(c.debtorCustomer),
    ...(c.settledAt ? { settledAt: c.settledAt.toISOString() } : {}),
    ...(c.returnOnSettle ? { returnOnSettle: c.returnOnSettle } : {}),
  }
}

export function directDebitSimRoutes(emulator: Emulator) {
  const bad = (msg: string) => new ConnectError(400, 'BAD_REQUEST', msg)
  const svc = emulator.directDebit
  const str = (v: unknown, name: string) => {
    if (v !== undefined && typeof v !== 'string') throw bad(`${name} must be a string`)
    return v as string | undefined
  }
  const run = async <T>(f: () => Promise<T>) => {
    try { return await f() } catch (e) {
      if (e instanceof DirectDebitError) throw new ConnectError(e.status, e.status === 404 ? 'NOT_FOUND' : e.status === 409 ? 'CONFLICT' : 'BAD_REQUEST', e.message)
      throw e
    }
  }
  const simRails = () => {
    if (!(emulator.rails instanceof SimulatorRails)) throw bad('the rails are not the simulator')
    return emulator.rails
  }

  return async (app: FastifyInstance) => {
    app.get('/collections', async () => ({ collections: svc.collections.map(collectionView) }))

    // A creditor at another bank collects from an account here.
    app.post('/incoming', async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown> & { creditor?: Record<string, unknown> }
      const debtorIban = str(b.debtorIban, 'debtorIban')
      if (!debtorIban) throw bad('debtorIban is required')
      if (typeof b.amount !== 'string') throw bad('amount must be a decimal string')
      let amount: bigint
      try { amount = toMinor(b.amount) } catch { throw bad(`invalid amount ${b.amount}`) }
      if (amount <= 0n) throw bad('amount must be positive')
      const dueDate = str(b.dueDate, 'dueDate')
      if (dueDate !== undefined && !isDate(dueDate)) throw bad('dueDate must be YYYY-MM-DD')
      if (b.currency !== undefined && b.currency !== 'EUR') throw bad('SEPA Direct Debit is in EUR only')
      const cr = b.creditor ?? {}
      if (typeof cr !== 'object') throw bad('creditor must be an object')
      const x: ExternalCollection = {
        debtorIban, amount, dueDate,
        creditor: { name: str(cr.name, 'creditor.name'), iban: str(cr.iban, 'creditor.iban'), bic: str(cr.bic, 'creditor.bic'), schemeId: str(cr.schemeId, 'creditor.schemeId') },
        debtorName: str(b.debtorName, 'debtorName'), mandateId: str(b.mandateId, 'mandateId'), signedOn: str(b.signedOn, 'signedOn'),
        seqTp: str(b.seqTp, 'seqTp'), pmtInfId: str(b.pmtInfId, 'pmtInfId'), endToEndId: str(b.endToEndId, 'endToEndId'),
        instrId: str(b.instrId, 'instrId'), remittance: str(b.remittance, 'remittance'), reference: str(b.reference, 'reference'),
      }
      const c = await run(() => svc.incoming(x))
      return reply.code(201).send(collectionView(c))
    })

    // An R-transaction from the debtor's bank about a collection our creditor sent out.
    app.post('/return', async (req) => {
      const b = (req.body ?? {}) as Record<string, unknown>
      const endToEndId = str(b.endToEndId, 'endToEndId')
      const code = str(b.code, 'code')
      if (!endToEndId || !code) throw bad('endToEndId and code are required')
      return collectionView(await run(() => svc.externalReturn(endToEndId, code, str(b.pmtInfId, 'pmtInfId'))))
    })

    // Settles the due collections now (main.ts does this every minute).
    app.post('/settle', async () => ({ settled: await svc.tick() }))

    // Collections from this (external) debtor account are rejected by its bank.
    app.post('/rails/reject', async (req) => {
      const b = (req.body ?? {}) as { debtorIban?: unknown; code?: unknown }
      const iban = str(b.debtorIban, 'debtorIban')
      const code = str(b.code, 'code')
      if (!iban || !code) throw bad('debtorIban and code are required')
      simRails().rejectCollections(normalizeIban(iban), code)
      return { ok: true }
    })

    app.get('/rails/collections', async () => ({
      collections: simRails().collections.map((c) => ({ ...c, amount: fromMinor(c.amount) })),
    }))
  }
}
