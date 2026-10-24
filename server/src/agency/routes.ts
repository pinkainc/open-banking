// HTTP surface of indirect scheme access (decisions 800–811): the account synchronisation
// (v1 XML on both hosts, v2 JSON on the UK host; 202, the answer in the inbox) and the
// /_sim/agency control plane: the account manager's set-up, the synchronised accounts, the
// scheme's incoming CoP/VoP requests and the RTF deliveries.
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Caller } from '../auth.js'
import { ConnectError, forbidden } from '../errors.js'
import type { Emulator } from '../emulator.js'
import { requestId } from '../ids.js'
import { jsonTextScope } from '../jsonbody.js'
import { accepted } from '../requests.js'
import { bankFor, type Flavour } from '../routing.js'
import { RtfError } from './rtf.js'
import { RTF_SCHEMES, checkSetup, type AgencyAccount, type AgencyBank, type RtfScheme } from './store.js'
import { AGENT_ACCOUNT_SYNC } from './sync.js'

/** 403 unless the customer has an Indirect Scheme Access Service Agreement (decision 801). */
function agent(c: Caller) {
  if (!c.customer.agency?.agreement) throw forbidden('User has not been granted the requested service')
  return c.customer
}

export function registerAgency(app: FastifyInstance, emulator: Emulator, caller: (req: FastifyRequest) => Caller, flavour: Flavour, hostBank: string) {
  app.post('/agent/account/synchronize', async (req, reply) => {
    const c = caller(req)
    const a = agent(c)
    const id = requestId()
    // BankCodes only count on the UK host, and not for a request handed to LHV EE (decision 804).
    const ukHost = flavour === 'UK' && bankFor(req, flavour, hostBank) === 'LHVUK'
    await emulator.agency.sync.syncXml(req.body, a, id, ukHost)
    return accepted(emulator.requests, req, reply, c, id, AGENT_ACCOUNT_SYNC)
  })
  if (flavour !== 'UK') return
  jsonTextScope(app, (scope) => {
    scope.post('/v2/agent/account/synchronize', async (req, reply) => {
      const c = caller(req)
      const a = agent(c)
      const id = requestId()
      await emulator.agency.sync.syncJson(req.body, a, id)
      return accepted(emulator.requests, req, reply, c, id, AGENT_ACCOUNT_SYNC)
    })
  })
}

const at = (d: Date) => d.toISOString()
export const accountView = (a: AgencyAccount) => ({
  bank: a.bank, id: a.id, country: a.country, ...(a.iban ? { iban: a.iban } : {}), ...(a.accountNo ? { accountNo: a.accountNo } : {}),
  status: a.status, ...(a.name ? { name: a.name } : {}), ...(a.category ? { category: a.category } : {}), copOptOut: a.copOptOut,
  agent: { code: a.agent.code, country: a.agent.country }, master: a.master, createdAt: at(a.createdAt), updatedAt: at(a.updatedAt),
})

/** /_sim/agency: the account manager and the schemes. */
export function agencySimRoutes(emulator: Emulator, flavour: Flavour) {
  const bad = (msg: string) => new ConnectError(400, 'BAD_REQUEST', msg)
  const body = (req: FastifyRequest) => {
    const b = req.body ?? {}
    if (typeof b !== 'object' || Array.isArray(b)) throw bad('the body must be a JSON object')
    return b as Record<string, unknown>
  }
  const str = (v: unknown, name: string, required = false) => {
    if (v === undefined || v === null) { if (required) throw bad(`${name} is required`); return undefined }
    if (typeof v !== 'string' || !v.trim()) throw bad(`${name} must be a non-empty string`)
    return v.trim()
  }
  const customer = (req: FastifyRequest) => {
    const p = req.params as { country: string; code: string }
    const c = emulator.directory.get({ code: p.code, country: p.country })
    if (!c) throw new ConnectError(404, 'NOT_FOUND', `no customer ${p.country.toUpperCase()}:${p.code}`)
    return c
  }
  const notified = (r: { agent?: { code: string; country: string }; message?: { id: string } }, body: object) => ({
    notified: r.message ? { code: r.agent!.code, country: r.agent!.country, messageResponseId: r.message.id } : null, ...body,
  })

  return async (app: FastifyInstance) => {
    // The account manager's set-up of a customer's agreement (replaces it; {} removes it).
    app.get('/agents/:country/:code', async (req) => ({ agency: customer(req).agency ?? null }))
    app.put('/agents/:country/:code', async (req) => {
      const c = customer(req)
      const b = body(req)
      try {
        if (Object.keys(b).length === 0) delete c.agency
        else c.agency = checkSetup(b, c.accounts)
      } catch (e) { throw bad((e as Error).message) }
      return { agency: c.agency ?? null }
    })

    // What the agents synchronised; ?bank=LHVEE|LHVUK, ?agent=<country>:<code>.
    app.get('/accounts', async (req) => {
      const q = req.query as { bank?: string; agent?: string }
      if (q.bank !== undefined && q.bank !== 'LHVEE' && q.bank !== 'LHVUK') throw bad('bank must be LHVEE or LHVUK')
      let list = emulator.agency.accounts.all()
      if (q.bank) list = list.filter((a) => a.bank === (q.bank as AgencyBank))
      if (q.agent) list = list.filter((a) => `${a.agent.country}:${a.agent.code}`.toUpperCase() === q.agent!.toUpperCase())
      return { accounts: list.map(accountView) }
    })

    // Another bank's VoP request on an IBAN here: LHV's answer and the agent's notification.
    app.post('/vop-incoming', async (req) => {
      const b = body(req)
      const iban = str(b.iban, 'iban', true)!.replace(/\s+/g, '').toUpperCase()
      const r = await emulator.agency.responder.vop({
        iban, name: str(b.name, 'name', true)!, bic: str(b.bic, 'bic'), requesterBic: str(b.requesterBic, 'requesterBic'),
      })
      return notified(r, { response: r.body })
    })

    // Another bank's CoP request on a sort code and account number of LHV UK.
    if (flavour === 'UK') {
      app.post('/cop-incoming', async (req) => {
        const b = body(req)
        const sortCode = str(b.sortCode, 'sortCode', true)!.replace(/-/g, '')
        const accountNumber = str(b.accountNumber, 'accountNumber', true)!
        if (!/^[0-9]{6}$/.test(sortCode)) throw bad('sortCode must be 6 digits')
        if (!/^[0-9]{8}$/.test(accountNumber)) throw bad('accountNumber must be 8 digits')
        const classification = b.accountClassification ?? 'PERSONAL'
        if (classification !== 'PERSONAL' && classification !== 'BUSINESS') throw bad('accountClassification must be PERSONAL or BUSINESS')
        const r = await emulator.agency.responder.cop({
          sortCode, accountNumber, name: str(b.name, 'name', true)!, classification,
          secondaryIdentification: str(b.secondaryIdentification, 'secondaryIdentification'), requesterBankName: str(b.requesterBankName, 'requesterBankName'),
        })
        return notified(r, { response: r.body })
      })
    }

    // A scheme's Routing Table File: {scheme, customer?: {code, country}, content? (base64) | text?}.
    app.post('/rtf', async (req, reply) => {
      const b = body(req)
      if (!RTF_SCHEMES.includes(b.scheme as RtfScheme)) throw bad(`scheme must be one of ${RTF_SCHEMES.join(', ')}`)
      if (b.content !== undefined && b.text !== undefined) throw bad('give content or text, not both')
      let content: Buffer | undefined
      if (b.content !== undefined) {
        if (typeof b.content !== 'string' || !/^[A-Za-z0-9+/\r\n]*={0,2}$/.test(b.content) || !b.content) throw bad('content must be base64')
        content = Buffer.from(b.content, 'base64')
      } else if (b.text !== undefined) {
        if (typeof b.text !== 'string' || !b.text) throw bad('text must be a non-empty string')
        content = Buffer.from(b.text, 'utf8')
      }
      let who: { code: string; country: string } | undefined
      if (b.customer !== undefined) {
        const k = b.customer as Record<string, unknown>
        if (typeof k !== 'object' || k === null || typeof k.code !== 'string' || typeof k.country !== 'string') throw bad('customer must be {code, country}')
        who = { code: k.code, country: k.country }
      }
      try {
        const sent = await emulator.agency.rtf.deliver({ scheme: b.scheme as RtfScheme, content, customer: who })
        return reply.code(201).send({
          messages: sent.map((m) => ({ messageResponseId: m.id, code: m.clientCode, country: m.clientCountry, contentType: m.contentType, bytes: Buffer.byteLength(m.body) })),
        })
      } catch (e) {
        if (e instanceof RtfError) throw new ConnectError(e.status, e.status === 404 ? 'NOT_FOUND' : e.status === 409 ? 'CONFLICT' : 'BAD_REQUEST', e.message)
        throw e
      }
    })
  }
}
