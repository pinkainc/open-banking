// HTTP surface of the LHV UK account reports (decisions 705–713): synchronous JSON on the
// UK host only, with the error bodies of the G pages instead of <Errors> XML. Also the
// /_sim/accounts control plane: incoming payments held as Pending until decided.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Caller } from '../auth.js'
import { ConnectError, JsonBodyError } from '../errors.js'
import type { Emulator } from '../emulator.js'
import { normalizeIban } from '../iban.js'
import { servicerRef } from '../ids.js'
import { fromMinor, toMinor } from '../ledger.js'

/** The AWS API Gateway deny of G get-list-of-accounts "403 - error". */
export const AWS_DENY = { Message: 'User is not authorized to access this resource with an explicit deny in an identity-based policy' }

/**
 * Error bodies of the UK JSON account services: a JsonBodyError as given; a failed
 * identity or contract check (403) as the gateway's `{"Message": ...}`; anything else a
 * bare JSON string with its status (decision 708).
 */
export function ukJsonErrors(err: any, _req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof JsonBodyError) return reply.code(err.status).type('application/json').send(JSON.stringify(err.body))
  if (err instanceof ConnectError && err.status === 403) return reply.code(403).type('application/json').send(JSON.stringify(AWS_DENY))
  const status = err instanceof ConnectError ? err.status : err.statusCode && err.statusCode < 500 ? err.statusCode : 500
  const text = status >= 500 ? 'Technical error' : err.message
  return reply.code(status).type('application/json').send(JSON.stringify(text))
}

export function registerAccounts(app: FastifyInstance, emulator: Emulator, caller: (req: FastifyRequest) => Promise<Caller>) {
  const customerOf = async (req: FastifyRequest) => {
    const c = await caller(req)
    const customer = await emulator.directory.get(c.customer)
    if (!customer) throw new ConnectError(403, 'FORBIDDEN', "User doesn't exist")
    return customer
  }
  const json = (reply: FastifyReply, body: unknown) => reply.code(200).type('application/json').send(JSON.stringify(body))
  app.register(async (scope) => {
    scope.setErrorHandler(ukJsonErrors)
    scope.get('/accounts/list', async (req, reply) =>
      json(reply, await emulator.accounts.list(await customerOf(req), req.query as Record<string, unknown>)))
    scope.get('/accounts/:accountNumber/transactions/:reference', async (req, reply) => {
      const p = req.params as { accountNumber: string; reference: string }
      return json(reply, await emulator.accounts.transaction(await customerOf(req), p.accountNumber, p.reference))
    })
    scope.get('/accounts/:accountNumber/payments', async (req, reply) => {
      const p = req.params as { accountNumber: string }
      return json(reply, emulator.accounts.payments(await customerOf(req), p.accountNumber, req.query as Record<string, unknown>))
    })
  })
}

const SCHEMES = ['SEPA', 'INST', 'SWIFT', 'TARGET2']

/** /_sim/accounts: incoming payments held as Pending (decision 712). */
export function accountsSimRoutes(emulator: Emulator) {
  const bad = (msg: string) => new ConnectError(400, 'BAD_REQUEST', msg)
  return async (app: FastifyInstance) => {
    app.get('/incoming', async () => ({ incoming: emulator.accounts.held().map((p) => ({ ...p, amount: fromMinor(p.amount) })) }))

    // Like /_sim/incoming, but the payment waits as Pending: no booking, no camt.054.
    app.post('/incoming', async (req, reply) => {
      const b = (req.body ?? {}) as {
        iban?: string; amount?: string; currency?: string; scheme?: string
        debtor?: { name?: string; iban?: string; bic?: string }; remittance?: string; reference?: string; endToEndId?: string
      }
      if (!b.iban) throw bad('iban is required')
      const iban = normalizeIban(b.iban)
      if (!await emulator.directory.ownerOf(iban) && !emulator.viban.registry.get(iban)) throw new ConnectError(404, 'NOT_FOUND', `no account ${iban}`)
      let amount: bigint
      try { amount = toMinor(String(b.amount ?? '')) } catch { throw bad('amount must be a positive number with at most two decimals') }
      if (amount <= 0n) throw bad('amount must be positive')
      const scheme = b.scheme ?? 'SEPA'
      if (!SCHEMES.includes(scheme)) throw bad(`unknown scheme ${scheme}`)
      const ref = servicerRef()
      emulator.accounts.hold({
        ref, iban, amount, currency: b.currency ?? 'GBP', scheme, debtor: b.debtor ?? { name: 'Simulated Debtor' },
        remittance: b.remittance, reference: b.reference, endToEndId: b.endToEndId,
      })
      return reply.code(201).send({ iban, accountServicerReference: ref, status: 'Pending' })
    })

    const decide = (approve: boolean) => async (req: FastifyRequest) => {
      const r = await emulator.accounts.decide((req.params as { ref: string }).ref.replace(/-/g, '').toUpperCase(), approve)
      if (!r) throw new ConnectError(404, 'NOT_FOUND', 'no held incoming payment with this reference')
      return r
    }
    app.post('/incoming/:ref/approve', decide(true))
    app.post('/incoming/:ref/reject', decide(false))
  }
}
