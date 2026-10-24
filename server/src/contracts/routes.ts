// HTTP surface of contract management: the two Connect operations (sync JSON, service
// providers only) and the emulator's own /_sim/contracts control plane (LHV Client
// Services activating or closing a contract).
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Caller } from '../auth.js'
import { keyOf } from '../directory.js'
import { ConnectError, forbidden, jsonError } from '../errors.js'
import type { Emulator } from '../emulator.js'
import { asObject, JsonBodyError, parseJsonBody } from '../jsonbody.js'
import { isDate } from '../statements/camt060.js'
import { ContractError, type Contract } from './service.js'

/** The only documented error code of P 14, with its description. */
export const CONTRACT_CREATION_FAILED = () => jsonError(400, 'CONTRACT_CREATION_FAILED', 'Unable to create the contract')

/**
 * P 14: "Mandatory headers: Client-Code / Client-Country - [service provider registry
 * code]". A caller that is not a service provider, or one acting for a customer, has not
 * been granted the service (the documented FORBIDDEN text).
 */
function provider(c: Caller) {
  if (!c.user.connected || keyOf(c.customer) !== keyOf(c.user)) throw forbidden('User has not been granted the requested service')
  return c.user
}

export function registerContracts(app: FastifyInstance, emulator: Emulator, caller: (req: FastifyRequest) => Promise<Caller>) {
  app.post('/contracts', async (req) => {
    const sp = provider(await caller(req))
    let b: Record<string, unknown> | undefined
    try { b = asObject(parseJsonBody(req.body)) } catch (e) {
      if (e instanceof JsonBodyError) throw jsonError(400, 'BAD_REQUEST', e.message)
      throw e
    }
    if (!b) throw jsonError(400, 'BAD_REQUEST', 'The request body must be a JSON object')
    for (const f of ['companyCode', 'companyCodeIssuer'] as const) {
      if (typeof b[f] !== 'string' || !(b[f] as string).trim()) throw jsonError(400, 'BAD_REQUEST', `${f} is mandatory`)
    }
    const code = (b.companyCode as string).trim()
    const country = (b.companyCodeIssuer as string).trim().toUpperCase()
    if (!/^[A-Z]{2}$/.test(country)) throw jsonError(400, 'BAD_REQUEST', 'companyCodeIssuer must be a 2-letter country code')
    try {
      const { contract, container } = await emulator.contracts.create(sp, { code, country })
      return {
        companyCode: contract.customer.code, companyCodeIssuer: contract.customer.country,
        contractStatus: 'pending', contractId: contract.id, contractContainer: container,
      }
    } catch (e) {
      if (e instanceof ContractError) throw CONTRACT_CREATION_FAILED()
      throw e
    }
  })

  app.get('/contracts', async (req) => {
    const sp = provider(await caller(req))
    const q = req.query as Record<string, string | undefined>
    for (const k of ['createdAtMin', 'createdAtMax', 'changedAtMin', 'changedAtMax']) {
      if (q[k] !== undefined && !isDate(q[k])) throw jsonError(400, 'BAD_REQUEST', `${k} must be a date (YYYY-MM-DD)`)
    }
    return await emulator.contracts.list(sp, q)
  })
}

function view(c: Contract) {
  return {
    id: c.id, status: c.status, provider: c.provider, customer: c.customer, services: c.services,
    createdAt: c.createdAt.toISOString(), changedAt: c.changedAt.toISOString(), ...(c.startDate ? { startDate: c.startDate } : {}),
  }
}

export function contractsSimRoutes(emulator: Emulator) {
  const svc = emulator.contracts
  const run = async (f: () => Promise<Contract>) => {
    try { return view(await f()) } catch (e) {
      if (e instanceof ContractError) throw new ConnectError(e.message.startsWith('no contract') ? 404 : 409, e.message.startsWith('no contract') ? 'NOT_FOUND' : 'CONFLICT', e.message)
      throw e
    }
  }
  return async (app: FastifyInstance) => {
    app.get('/', async () => {
      // Seeded connections become contracts on first look, for every provider.
      for (const c of await emulator.directory.all()) if (c.connected) await svc.of(c)
      return { contracts: (await svc.all()).map(view) }
    })
    app.post('/:id/activate', async (req) => run(() => svc.activate((req.params as { id: string }).id)))
    app.post('/:id/close', async (req) => run(() => svc.close((req.params as { id: string }).id)))
  }
}
