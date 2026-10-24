// HTTP surface of the merchant payment report (P 13, decisions 820–827): POST
// /acq/merchant-report (XML, 202, the camt.054 or <Errors> in the inbox as ACQ_REPORT; LHV EE
// only, on the UK host with X-Bank-Code: LHVEE, routing.ts) and the /_sim/acq control plane:
// a customer's acquiring set-up and the card transactions of the simulated card scheme.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Caller } from '../auth.js'
import { ConnectError } from '../errors.js'
import type { Emulator } from '../emulator.js'
import { requestId } from '../ids.js'
import { fromMinor } from '../ledger.js'
import { accepted } from '../requests.js'
import { ACQ_REPORT, type CardTransaction } from './service.js'

export function registerAcquiring(app: FastifyInstance, emulator: Emulator, caller: (req: FastifyRequest) => Promise<Caller>) {
  app.post('/acq/merchant-report', async (req, reply) => {
    const c = await caller(req)
    const id = requestId()
    await emulator.acquiring.report(typeof req.body === 'string' ? req.body : '', c.customer, id)
    return accepted(emulator.requests, req, reply, c, id, ACQ_REPORT)
  })
}

const view = (t: CardTransaction) => ({
  ref: t.ref, account: t.account, currency: t.currency, direction: t.direction, amount: fromMinor(t.amount), fee: fromMinor(t.fee),
  transactionDate: t.transactionDate, settlementDate: t.settlementDate ?? null, terminal: t.terminal, ...(t.stan ? { stan: t.stan } : {}),
  pan: t.pan, mid: t.mid, ...(t.location ? { location: t.location } : {}), scheme: t.scheme, ...(t.orderRef ? { orderRef: t.orderRef } : {}),
  subFamily: t.subFamily,
})

/** /_sim/acq: the account manager's merchant set-up and the card scheme's transactions. */
export function acquiringSimRoutes(emulator: Emulator) {
  const bad = (msg: string) => new ConnectError(400, 'BAD_REQUEST', msg)
  const body = (req: FastifyRequest) => {
    const b = req.body ?? {}
    if (typeof b !== 'object' || Array.isArray(b)) throw bad('the body must be a JSON object')
    return b as Record<string, any>
  }
  const customer = async (req: FastifyRequest) => {
    const p = req.params as { country: string; code: string }
    const c = await emulator.directory.get({ code: p.code, country: p.country })
    if (!c) throw new ConnectError(404, 'NOT_FOUND', `no customer ${p.country.toUpperCase()}:${p.code}`)
    return c
  }
  return async (app: FastifyInstance) => {
    app.get('/merchants/:country/:code', async (req) => ({ merchant: (await emulator.acquiring.merchant(await customer(req))) ?? null }))
    // {userCode?, accounts?} replaces the set-up; {} removes it.
    app.put('/merchants/:country/:code', async (req) => {
      const c = await customer(req)
      const b = body(req)
      try {
        return { merchant: (await emulator.acquiring.setMerchant(c, Object.keys(b).length ? b : undefined)) ?? null }
      } catch (e) { throw bad((e as Error).message) }
    })
    app.post('/transactions', async (req, reply) => {
      const b = body(req)
      try {
        return reply.code(201).send({ transaction: view(await emulator.acquiring.addTransaction(b as any)) })
      } catch (e) { throw bad((e as Error).message) }
    })
    app.get('/transactions', async (req) => {
      const q = req.query as { account?: string }
      return { transactions: (await emulator.acquiring.transactions(q.account)).map(view) }
    })
  }
}
