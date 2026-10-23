// HTTP surface of the VIBAN services: the five Connect operations and the emulator's
// own /_sim/viban control plane (bank decisions, screening list, agreements, faults).
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Caller } from '../auth.js'
import { ConnectError, errorsXml } from '../errors.js'
import type { Emulator } from '../emulator.js'
import { normalizeIban } from '../iban.js'
import { requestId } from '../ids.js'
import { vibanDate, type Op } from './messages.js'
import type { VibanStatus } from './registry.js'

const OPS: Op[] = ['open', 'bulk', 'modify', 'info', 'close']

export function registerViban(app: FastifyInstance, emulator: Emulator, caller: (req: FastifyRequest) => Caller) {
  for (const op of OPS) {
    app.post(`/viban/${op}`, async (req, reply) => {
      const c = caller(req)
      const body = typeof req.body === 'string' ? req.body : ''
      const out = await emulator.viban.handle(op, body, c.customer)
      if ('errors' in out && emulator.viban.errorDelivery === 'sync') {
        const codes = out.errors.map((e) => e.code)
        const status = codes.includes('FORBIDDEN') ? 403 : codes.includes('TECHNICAL_ERROR') ? 500 : 400
        return reply.code(status).type('application/xml').send(errorsXml(out.errors))
      }
      const id = requestId()
      emulator.inbox.add({ customer: c.customer, type: out.type, requestId: id, body: 'errors' in out ? errorsXml(out.errors) : out.body })
      return reply.code(202).header('Message-Request-Id', id).send()
    })
  }
}

const STATUSES: VibanStatus[] = ['ACTIVE', 'PENDING', 'ON_HOLD', 'CLOSED', 'REJECTED', 'BLOCKED']

export function vibanSimRoutes(emulator: Emulator) {
  const bad = (msg: string) => new ConnectError(400, 'BAD_REQUEST', msg)
  const svc = emulator.viban
  return async (app: FastifyInstance) => {
    app.get('/', async () => ({ vibans: svc.registry.all().map(view) }))

    app.get('/:iban', async (req) => {
      const v = svc.registry.get((req.params as { iban: string }).iban)
      if (!v) throw new ConnectError(404, 'NOT_FOUND', 'no such VIBAN')
      return view(v)
    })

    // A decision of the bank: ON_HOLD → ACTIVE / REJECTED, ACTIVE ⇄ BLOCKED, → CLOSED.
    app.post('/:iban/status', async (req) => {
      const iban = (req.params as { iban: string }).iban
      const status = (req.body as { status?: string } | undefined)?.status as VibanStatus
      if (!STATUSES.includes(status)) throw bad(`status must be one of ${STATUSES.join(', ')}`)
      if (!svc.registry.get(iban)) throw new ConnectError(404, 'NOT_FOUND', 'no such VIBAN')
      const why = svc.bankStatus(iban, status)
      if (why) throw new ConnectError(409, 'CONFLICT', why)
      return view(svc.registry.get(iban)!)
    })

    // Holder names the background check flags (their VIBANs open ON_HOLD). Replaces the list.
    app.post('/screening', async (req) => {
      const names = (req.body as { names?: unknown } | undefined)?.names
      if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) throw bad('names must be an array of strings')
      svc.screening.clear()
      for (const n of names as string[]) svc.screening.add(n.toLowerCase())
      return { names: [...svc.screening] }
    })

    app.post('/agreements', async (req) => {
      const b = (req.body ?? {}) as { iban?: string; active?: boolean }
      if (!b.iban) throw bad('iban is required')
      if (!emulator.directory.ownerOf(b.iban)) throw new ConnectError(404, 'NOT_FOUND', `no account ${normalizeIban(b.iban)}`)
      svc.registry.agreement(b.iban, b.active !== false)
      return { iban: normalizeIban(b.iban), active: svc.registry.hasAgreement(b.iban) }
    })

    // The next `count` VIBAN requests fail with TECHNICAL_ERROR.
    app.post('/fault', async (req) => {
      const count = (req.body as { count?: number } | undefined)?.count ?? 1
      if (!Number.isInteger(count) || count < 0) throw bad('count must be a non-negative integer')
      svc.faults = count
      return { count }
    })

    // How business errors are delivered: "inbox" (default) or "sync".
    app.post('/errors', async (req) => {
      const delivery = (req.body as { delivery?: string } | undefined)?.delivery
      if (delivery !== 'inbox' && delivery !== 'sync') throw bad('delivery must be "inbox" or "sync"')
      svc.errorDelivery = delivery
      return { delivery }
    })
  }
}

function view(v: ReturnType<Emulator['viban']['registry']['all']>[number]) {
  return {
    iban: v.iban, masterAccount: v.master, owner: v.owner, status: v.status,
    ...(v.clientReference ? { clientReference: v.clientReference } : {}),
    ...(v.user ? { user: v.user } : {}),
    ...(v.activatedAt ? { dateActivated: vibanDate(v.activatedAt) } : {}),
    ...(v.closedAt ? { dateClosed: vibanDate(v.closedAt) } : {}),
  }
}
