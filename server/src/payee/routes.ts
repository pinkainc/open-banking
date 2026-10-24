// HTTP surface of payee verification (decisions 600–610): 202 with Message-Request-Id, the
// answer in the inbox. The EE XML service is on both hosts (the UK host "always" hands it
// to LHV EE); the UK JSON services only on the UK host, a 404 on the EE one. Also the EE
// TEST-only GET /test/accounts/ibans (decision 608) and the /_sim/payee control plane.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Caller } from '../auth.js'
import { ConnectError } from '../errors.js'
import type { Emulator } from '../emulator.js'
import { requestId } from '../ids.js'
import { accepted } from '../requests.js'
import { jsonTextScope } from '../jsonbody.js'
import { ANSWERS, CATEGORIES, COP, VOP_EE, accountKey, type Category, type SimAccount } from './service.js'

export function registerPayee(app: FastifyInstance, emulator: Emulator, caller: (req: FastifyRequest) => Caller, flavour: 'EE' | 'UK') {
  app.post('/verification-of-payee', async (req, reply) => {
    const c = caller(req)
    const id = requestId()
    emulator.payee.requestEe(req.body, c.customer, id)
    // On the UK host the request is answered by LHV EE (decision 607).
    if (flavour === 'UK') reply.header('X-Bank-Code', 'LHVEE')
    return accepted(emulator.requests, req, reply, c, id, VOP_EE)
  })

  if (flavour === 'UK') {
    jsonTextScope(app, (scope) => {
      scope.post('/payment/vop-request', async (req, reply) => {
        const c = caller(req)
        const id = requestId()
        emulator.payee.requestUk(req.body, c.customer, id)
        return accepted(emulator.requests, req, reply, c, id, VOP_EE)
      })
      scope.post('/payment/cop-request', async (req, reply) => {
        const c = caller(req)
        const id = requestId()
        emulator.payee.requestCop(req.body, c.customer, id)
        return accepted(emulator.requests, req, reply, c, id, COP)
      })
    })
  } else {
    // P 02 "Testing Environment Changes": the sandbox's account IBANs. Shape undocumented:
    // a JSON array of the selected customer's account IBANs (decision 608).
    app.get('/test/accounts/ibans', async (req, reply) => {
      const c = caller(req)
      const customer = emulator.directory.get(c.customer)
      return reply.code(200).type('application/json').send(JSON.stringify(customer?.accounts ?? []))
    })
  }
}

const view = (account: string, a: SimAccount) => ({ account, ...a })

/** /_sim/payee: accounts of other banks (holder name, category) and forced answers. */
export function payeeSimRoutes(emulator: Emulator) {
  const bad = (msg: string) => new ConnectError(400, 'BAD_REQUEST', msg)
  const key = (raw: string) => {
    const k = accountKey(decodeURIComponent(raw))
    if (!k) throw bad('account must be an IBAN with valid check digits or a 14-digit UK sort code and account number')
    return k
  }
  return async (app: FastifyInstance) => {
    app.get('/accounts', async () => ({ accounts: emulator.payee.accounts.entries().map(([k, a]) => view(k, a)) }))

    // { name?, category?: PERSONAL|BUSINESS, answer?: FULL_MATCH|…|MTCH|…|ACCP|… }
    app.put('/accounts/:account', async (req) => {
      const account = key((req.params as { account: string }).account)
      const b = (req.body ?? {}) as Record<string, unknown>
      if (typeof b !== 'object' || Array.isArray(b)) throw bad('the body must be a JSON object')
      for (const k of Object.keys(b)) if (!['name', 'category', 'answer'].includes(k)) throw bad(`unknown field ${k}`)
      if (b.name !== undefined && (typeof b.name !== 'string' || !b.name.trim())) throw bad('name must be a non-empty string')
      if (b.category !== undefined && !CATEGORIES.includes(b.category as Category)) throw bad('category must be PERSONAL or BUSINESS')
      if (b.answer !== undefined && (typeof b.answer !== 'string' || !ANSWERS.has(b.answer))) {
        throw bad('answer must be a PartyNameMatch value, a VoP reason code or a CoP reason code')
      }
      if (b.name === undefined && b.answer === undefined) throw bad('name or answer is required')
      const a: SimAccount = {
        ...(b.name !== undefined ? { name: (b.name as string).trim() } : {}),
        ...(b.category !== undefined ? { category: b.category as Category } : {}),
        ...(b.answer !== undefined ? { answer: b.answer as string } : {}),
      }
      emulator.payee.accounts.set(account, a)
      return view(account, a)
    })

    app.delete('/accounts/:account', async (req, reply) => {
      const account = key((req.params as { account: string }).account)
      if (!emulator.payee.accounts.delete(account)) throw new ConnectError(404, 'NOT_FOUND', `no simulated account ${account}`)
      return reply.code(204).send()
    })
  }
}
