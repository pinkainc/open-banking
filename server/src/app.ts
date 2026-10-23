// The HTTP surface. Everything outside /_sim is the Connect-compatible API; /_sim is
// the emulator's own control plane (customers, funding, incoming payments, rails).
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import { identifyFromTls, resolveCaller, type Caller, type Identify } from './auth.js'
import { ConnectError, jsonError, notFound, sendError } from './errors.js'
import { keyOf } from './directory.js'
import type { Emulator } from './emulator.js'
import { requestId } from './ids.js'
import type { Message, Scope } from './inbox.js'
import { heartbeatTallinn, listTimeTallinn } from './time.js'
import { XmlSyntaxError, el, toXml } from './xml.js'
import { simRoutes } from './sim.js'
import { registerViban, vibanSimRoutes } from './viban/routes.js'

export interface AppOptions {
  emulator: Emulator
  identify?: Identify
  /** Serve the /_sim control plane (default true). */
  sim?: boolean
  logger?: boolean
  https?: { key: string | Buffer; cert: string | Buffer; ca: string | Buffer }
  /** X-Bank-Code on every response (LHVEE or LHVUK); default LHVEE. */
  bankCode?: string
}

/** Request bodies above this are refused with 413 (the reference's nginx limit). */
export const BODY_LIMIT = 5 * 1024 * 1024
/** How long an X-Idempotency-Key is remembered (the documented guarantee). */
const IDEMPOTENCY_MS = 24 * 60 * 60 * 1000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function buildApp(opts: AppOptions): FastifyInstance {
  const { emulator } = opts
  const identify = opts.identify ?? identifyFromTls
  const base = { logger: opts.logger ?? false, bodyLimit: BODY_LIMIT }
  const app = (opts.https
    ? Fastify({ ...base, https: { ...opts.https, requestCert: true, rejectUnauthorized: true } })
    : Fastify(base)) as unknown as FastifyInstance

  // Request bodies other than JSON (pain.001 XML, BDOC test payloads) arrive as text.
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, body, done) => done(null, body))

  const bankCode = opts.bankCode ?? 'LHVEE'
  app.addHook('onRequest', async (_req, reply) => { reply.header('X-Bank-Code', bankCode) })

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ConnectError) return sendError(reply, err)
    if (err.statusCode === 413) return sendError(reply, new ConnectError(413, '413', 'Request Entity Too Large'))
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500
    return sendError(reply, new ConnectError(status, status === 500 ? 'TECHNICAL_ERROR' : 'BAD_REQUEST', status === 500 ? 'Technical error' : err.message))
  })

  const caller = (req: FastifyRequest): Caller => resolveCaller(req, emulator.directory, identify)
  const filterType = (req: FastifyRequest) => {
    const v = req.headers['filter-response-type']
    return (Array.isArray(v) ? v[0] : v) || undefined
  }
  const scope = (req: FastifyRequest, c: Caller): Scope => ({ customers: c.visible, type: filterType(req) })

  const sendMessage = (reply: FastifyReply, m: Message) => {
    reply.header('Message-Response-Id', m.id).header('Message-Response-Type', m.type)
      .header('Client-Code', m.clientCode).header('Client-Country', m.clientCountry)
    if (m.requestId) reply.header('Message-Request-Id', m.requestId)
    return reply.code(200).type(m.contentType).send(m.body)
  }
  const accepted = (reply: FastifyReply, id: string) => reply.code(202).header('Message-Request-Id', id).send()

  // X-Idempotency-Key: a key seen on a successful POST within 24 hours is answered 409.
  const idempotency = new Map<string, number>()
  const idemKey = (req: FastifyRequest) => {
    const v = req.headers['x-idempotency-key']
    const key = Array.isArray(v) ? v[0] : v
    if (key === undefined || req.method !== 'POST' || req.url.startsWith('/_sim')) return undefined
    return `${keyOf(caller(req).user)}|${key.toLowerCase()}`
  }
  app.addHook('preHandler', async (req) => {
    const k = idemKey(req)
    if (!k) return
    if (!UUID.test(k.slice(k.indexOf('|') + 1))) throw new ConnectError(400, 'BAD_REQUEST', 'X-Idempotency-Key must be a UUID')
    const until = idempotency.get(k)
    if (until !== undefined && until > emulator.clock.now().getTime()) {
      throw new ConnectError(409, 'CONFLICT', 'Request with this X-Idempotency-Key has already been received')
    }
  })
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode >= 300) return
    let k: string | undefined
    try { k = idemKey(req) } catch { return }
    if (k) idempotency.set(k, emulator.clock.now().getTime() + IDEMPOTENCY_MS)
  })

  // --- Communication test -------------------------------------------------------
  app.get('/heartbeat', async (req, reply) => {
    caller(req)
    return reply.type('application/xml').send(toXml(el('HeartBeatResponse', el('TimeStamp', heartbeatTallinn(emulator.clock.now())))))
  })

  const heartbeatMessage = (c: Caller, userRequest: string) => toXml(el('HeartBeatResponse',
    el('TimeStamp', heartbeatTallinn(emulator.clock.now())),
    el('AuthorizedUser', el('Name', c.user.name), el('Code', c.user.code)),
    el('Certificates', el('Certificate',
      el('SerialNumber', c.cert.certSerial ?? ''),
      el('ValidFrom', c.cert.validFrom ? new Date(c.cert.validFrom).toISOString().slice(0, 19) : ''),
      el('ValidTo', c.cert.validTo ? new Date(c.cert.validTo).toISOString().slice(0, 19) : ''))),
    el('Signatures'),
    el('UserRequest', userRequest)))

  app.get('/heartbeat/mq', async (req, reply) => {
    const c = caller(req)
    const id = requestId()
    emulator.inbox.add({ customer: c.customer, type: 'HEARTBEAT', requestId: id, body: heartbeatMessage(c, '') })
    return accepted(reply, id)
  })

  app.post('/heartbeat', async (req, reply) => {
    const c = caller(req)
    const id = requestId()
    const body = typeof req.body === 'string' ? req.body : req.body ? JSON.stringify(req.body) : ''
    emulator.inbox.add({ customer: c.customer, type: 'HEARTBEAT', requestId: id, body: heartbeatMessage(c, body) })
    return accepted(reply, id)
  })

  // --- Messages -----------------------------------------------------------------
  app.get('/messages/next', async (req, reply) => {
    const c = caller(req)
    const m = emulator.inbox.next(scope(req, c))
    return m ? sendMessage(reply, m) : reply.code(204).send()
  })

  app.get('/messages/count', async (req) => {
    const c = caller(req)
    return { count: emulator.inbox.count(scope(req, c)) }
  })

  app.get('/messages', async (req, reply) => {
    const c = caller(req)
    const q = req.query as { limit?: string }
    let limit = q.limit === undefined ? 10 : Number(q.limit)
    if (!/^\d+$/.test(q.limit ?? '10') || !Number.isInteger(limit) || limit < 1) throw jsonError(400, 'BAD_REQUEST', 'limit must be a positive integer')
    limit = Math.min(limit, 100)
    const messages = emulator.inbox.list(scope(req, c), limit)
    if (messages.length === 0) return reply.code(204).send()
    return {
      messages: messages.map((m) => ({
        messageResponseId: m.id,
        ...(m.requestId ? { messageRequestId: m.requestId } : {}),
        messageResponseType: m.type,
        clientCode: m.clientCode,
        clientCountry: m.clientCountry,
        messageCreatedTime: listTimeTallinn(m.createdAt),
      })),
    }
  })

  app.get('/messages/:id', async (req, reply) => {
    const c = caller(req)
    const m = emulator.inbox.get(scope(req, c), (req.params as { id: string }).id)
    if (!m) throw notFound()
    return sendMessage(reply, m)
  })

  app.delete('/messages/:id', async (req, reply) => {
    const c = caller(req)
    if (emulator.inbox.delete(scope(req, c), (req.params as { id: string }).id) === 'unknown') throw notFound()
    return reply.code(200).send()
  })

  // Bulk confirm: 200 when every id was deleted, 207 when some were, 400 when none.
  app.post('/messages/delete', async (req, reply) => {
    const c = caller(req)
    const ids = (req.body as { messageResponseIds?: unknown } | undefined)?.messageResponseIds
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((i) => typeof i !== 'string')) {
      throw jsonError(400, 'BAD_REQUEST', 'messageResponseIds must be a non-empty array of strings')
    }
    if (ids.length > 100) throw jsonError(400, 'BAD_REQUEST', 'At most 100 messages can be deleted at once')
    const s = scope(req, c)
    const messages = ids.map((id: string) => ({ messageResponseId: id, status: emulator.inbox.delete(s, id) === 'deleted' ? 200 : 400 }))
    const ok = messages.filter((m) => m.status === 200).length
    return reply.code(ok === messages.length ? 200 : ok === 0 ? 400 : 207).send({ messages })
  })

  // --- Payment initiation ---------------------------------------------------------
  app.post('/payment', async (req, reply) => {
    const c = caller(req)
    const type = String(req.headers['content-type'] ?? '')
    if (type.startsWith('application/vnd.etsi.asic-e+zip')) {
      throw new ConnectError(415, 'UNSUPPORTED', 'Signed payment containers are not supported by this server')
    }
    if (typeof req.body !== 'string' || !req.body.trim()) throw new ConnectError(400, 'BAD_REQUEST', 'The request body must be a pain.001 XML document')
    const id = requestId()
    try {
      await emulator.engine.submit(req.body, c.customer, id)
    } catch (e) {
      if (e instanceof XmlSyntaxError) throw new ConnectError(400, 'BAD_REQUEST', `The request body is not well-formed XML: ${e.message}`)
      throw e
    }
    return accepted(reply, id)
  })

  // --- Virtual IBANs ---------------------------------------------------------------
  registerViban(app, emulator, caller)

  if (opts.sim !== false) {
    app.register(simRoutes(emulator), { prefix: '/_sim' })
    app.register(vibanSimRoutes(emulator), { prefix: '/_sim/viban' })
  }
  return app
}
