// HTTP surface of the UK webhooks (UK host only; routing.ts keeps them from LHV EE):
// configurations under /notifications/subscription, GET /notifications/history and
// POST /notifications/replay (G services/webhooks/*), and the emulator's own
// /_sim/webhooks/uk control plane (configurations with secrets, events, retries now).
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Caller } from '../auth.js'
import { keyOf } from '../directory.js'
import { jsonError, notFound } from '../errors.js'
import type { Emulator } from '../emulator.js'
import { asObject, JsonBodyError, parseJsonBody } from '../jsonbody.js'
import { dateLondon } from '../time.js'
import { configView, EVENT_TYPE, type ConfigInput, type UkEvent } from './uk.js'

const bad = (text: string) => jsonError(400, 'BAD_REQUEST', text)
const MESSAGE_TYPE = /^[A-Z][A-Z0-9_]*(\.[A-Z0-9_]+)*$/
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
/** Event ids one replay request may carry (decision 728). */
export const MAX_REPLAY = 100
/** Largest history page (decision 727). */
export const MAX_HISTORY_LIMIT = 1000

function objectBody(raw: unknown): Record<string, unknown> {
  let b: Record<string, unknown> | undefined
  try { b = asObject(parseJsonBody(raw)) } catch (e) {
    if (e instanceof JsonBodyError) throw bad(e.message)
    throw e
  }
  if (!b) throw bad('The request body must be a JSON object')
  return b
}

/** A boolean, also as the string "true"/"false" (the G create sample sends `"active": "true"`). */
function flag(b: Record<string, unknown>, k: string): boolean | undefined {
  const v = b[k]
  if (v === undefined || v === null) return undefined
  if (typeof v === 'boolean') return v
  if (typeof v === 'string' && /^(true|false)$/i.test(v.trim())) return v.trim().toLowerCase() === 'true'
  throw bad(`${k} must be true or false`)
}

/** https (G: "must be an https:// URL"); http only to a loopback host, for local receivers (decision 722). */
function requestUrl(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw bad('requestUrl must be an https URL')
  let u: URL
  try { u = new URL(v.trim()) } catch { throw bad('requestUrl must be an https URL') }
  if (!u.hostname || !(u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname)))) throw bad('requestUrl must be an https URL')
  return v.trim()
}

/** The fields of a create or edit body that are present, checked. */
function configInput(b: Record<string, unknown>): ConfigInput {
  const out: ConfigInput = {}
  if (b.eventType !== undefined && b.eventType !== null && b.eventType !== EVENT_TYPE) throw bad(`eventType must be ${EVENT_TYPE}`)
  if (b.messageType !== undefined && b.messageType !== null) {
    if (typeof b.messageType !== 'string' || !MESSAGE_TYPE.test(b.messageType.trim())) throw bad('messageType must be a message type, e.g. VIBAN_OPEN')
    out.messageType = b.messageType.trim()
  }
  if (b.requestUrl !== undefined && b.requestUrl !== null) out.requestUrl = requestUrl(b.requestUrl)
  if (b.sharedSecret !== undefined && b.sharedSecret !== null) {
    if (typeof b.sharedSecret !== 'string' || b.sharedSecret === '') throw bad('sharedSecret must be a non-empty string')
    out.sharedSecret = b.sharedSecret
  }
  for (const k of ['active', 'attachMetadata', 'attachFullBody', 'removeAfterDelivery', 'compressionEnabled'] as const) {
    const v = flag(b, k)
    if (v !== undefined) out[k] = v
  }
  return out
}

const json = (reply: FastifyReply, body: unknown) => reply.code(200).type('application/json').send(JSON.stringify(body))

/** The customers whose events a request sees: as for messages, `serviceProvider=true` narrows a provider to itself. */
function customersOf(c: Caller, serviceProvider: boolean): Set<string> {
  return serviceProvider && keyOf(c.customer) === keyOf(c.user) ? new Set([keyOf(c.user)]) : c.visible
}

function one(q: Record<string, unknown>, k: string): string | undefined {
  const v = q[k]
  const s = Array.isArray(v) ? v[0] : v
  return s === undefined ? undefined : String(s)
}

function intParam(q: Record<string, unknown>, k: string, dflt: number, min: number, max: number): number {
  const s = one(q, k)
  if (s === undefined || s === '') return dflt
  if (!/^\d+$/.test(s) || Number(s) < min || Number(s) > max) throw bad(`${k} must be an integer from ${min} to ${max}`)
  return Number(s)
}

function dateParam(q: Record<string, unknown>, k: string): string | undefined {
  const s = one(q, k)
  if (s === undefined || s === '') return undefined
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T00:00:00Z`) : undefined
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) throw bad(`${k} must be a date YYYY-MM-DD`)
  return s
}

export function historyItem(emulator: Emulator, e: UkEvent) {
  const last = e.attempts[e.attempts.length - 1]
  return {
    message: emulator.webhooksUk.summary(e),
    status: e.status,
    retriesAttempted: Math.max(0, e.attempts.length - 1),
    ...(last?.status !== undefined ? { httpStatus: last.status } : {}),
    ...(last?.contentLength !== undefined ? { responseContentLength: last.contentLength } : {}),
    ...(last ? { latencyMs: last.latencyMs } : {}),
  }
}

export function registerUkWebhooks(app: FastifyInstance, emulator: Emulator, caller: (req: FastifyRequest) => Promise<Caller>) {
  const hooks = emulator.webhooksUk
  const ref = (req: FastifyRequest) => (req.params as { ref: string }).ref

  app.post('/notifications/subscription', async (req, reply) => {
    const c = await caller(req)
    const input = configInput(objectBody(req.body))
    if (input.messageType === undefined) throw bad('messageType is mandatory')
    if (input.requestUrl === undefined) throw bad('requestUrl is mandatory')
    if (input.active === undefined) throw bad('active is mandatory')
    if (hooks.forType(c.customer, input.messageType)) throw bad(`A webhook configuration for messageType ${input.messageType} already exists`)
    const cfg = hooks.create(c.customer, { ...input, messageType: input.messageType, requestUrl: input.requestUrl, active: input.active })
    return json(reply, configView(cfg, true))
  })

  app.get('/notifications/subscription', async (req, reply) => json(reply, hooks.list((await caller(req)).customer).map((x) => configView(x))))

  app.get('/notifications/subscription/:ref', async (req, reply) => {
    const cfg = hooks.get((await caller(req)).customer, ref(req))
    if (!cfg) throw notFound()
    return json(reply, configView(cfg))
  })

  app.put('/notifications/subscription/:ref', async (req, reply) => {
    const c = await caller(req)
    const cfg = hooks.get(c.customer, ref(req))
    if (!cfg) throw notFound()
    const b = objectBody(req.body)
    if (typeof b.subscriptionReference === 'string' && b.subscriptionReference.toLowerCase() !== cfg.subscriptionReference) {
      throw bad('subscriptionReference in the body does not match the path')
    }
    const input = configInput(b)
    if (input.messageType !== undefined && input.messageType !== cfg.messageType && hooks.forType(c.customer, input.messageType)) {
      throw bad(`A webhook configuration for messageType ${input.messageType} already exists`)
    }
    return json(reply, configView(hooks.update(cfg, input), true))
  })

  app.delete('/notifications/subscription/:ref', async (req, reply) => {
    const cfg = hooks.get((await caller(req)).customer, ref(req))
    if (!cfg) throw notFound()
    hooks.remove(cfg)
    return reply.code(200).send()
  })

  app.get('/notifications/history', async (req, reply) => {
    const c = await caller(req)
    const q = (req.query ?? {}) as Record<string, unknown>
    const offset = intParam(q, 'offset', 0, 0, Number.MAX_SAFE_INTEGER)
    const limit = intParam(q, 'limit', 100, 1, MAX_HISTORY_LIMIT)
    const status = one(q, 'status')?.trim().toUpperCase()
    if (status !== undefined && status !== '' && !['SUCCESS', 'FAILED', 'RETRY_PENDING'].includes(status)) throw bad('status must be SUCCESS, FAILED or RETRY_PENDING')
    const sp = one(q, 'serviceProvider')?.trim().toLowerCase()
    if (sp !== undefined && sp !== '' && !['true', 'false', '1', '0'].includes(sp)) throw bad('serviceProvider must be true, false, 1 or 0')
    const start = dateParam(q, 'startDate')
    const end = dateParam(q, 'endDate')
    const eventId = one(q, 'eventId')?.trim().toLowerCase()
    const type = one(q, 'responseType')?.trim()
    await hooks.idle()
    const items = hooks.events(customersOf(c, sp === 'true' || sp === '1')).filter((e) => {
      const day = dateLondon(e.createdAt)
      return (!eventId || e.eventId === eventId) && (!status || e.status === status) && (!type || e.message.type === type)
        && (!start || day >= start) && (!end || day <= end)
    })
    return json(reply, items.slice(offset, offset + limit).map((e) => historyItem(emulator, e)))
  })

  app.post('/notifications/replay', async (req, reply) => {
    const c = await caller(req)
    const b = objectBody(req.body)
    const ids = b.eventIds
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw bad('eventIds must be an array of event ids')
    if (ids.length === 0) throw bad('eventIds must not be empty')
    if (ids.length > MAX_REPLAY) throw bad(`At most ${MAX_REPLAY} events can be replayed at once`)
    await hooks.idle()
    const customers = customersOf(c, false)
    const dispatched: { eventId: string }[] = []
    const failed: { eventId: string; error: string }[] = []
    for (const id of [...new Set(ids as string[])]) {
      const r = hooks.replay(customers, c.customer.code, id)
      if (typeof r === 'string') failed.push({ eventId: id, error: r })
      else dispatched.push({ eventId: id })
    }
    return reply.code(dispatched.length ? 200 : 400).type('application/json').send(JSON.stringify({ dispatched, failed }))
  })
}

function eventView(emulator: Emulator, e: UkEvent) {
  return {
    eventId: e.eventId, subscriptionReference: e.subscriptionReference, messageResponseId: e.message.id, status: e.status,
    customer: e.customer, createdAt: e.createdAt.toISOString(),
    payload: JSON.parse(emulator.webhooksUk.body(e)),
    attempts: e.attempts.map((a) => ({
      at: a.at.toISOString(), url: a.url, hmac: a.hmac, compressed: a.compressed, latencyMs: a.latencyMs,
      ...(a.status !== undefined ? { status: a.status } : {}), ...(a.contentLength !== undefined ? { contentLength: a.contentLength } : {}),
      ...(a.error ? { error: a.error } : {}),
    })),
    ...(e.nextAt !== undefined ? { nextAt: new Date(e.nextAt).toISOString() } : {}),
    ...(e.replayOf ? { replayOf: e.replayOf } : {}),
    ...(e.reason ? { reason: e.reason } : {}),
  }
}

export function ukWebhookSimRoutes(emulator: Emulator) {
  const hooks = emulator.webhooksUk
  return async (app: FastifyInstance) => {
    // Secrets included: the emulator's operator may verify signatures.
    app.get('/subscriptions', async () => ({
      subscriptions: hooks.all().map((c) => ({ ...configView(c, true), owner: c.owner, createdAt: c.createdAt.toISOString() })),
    }))
    app.get('/events', async () => {
      await hooks.idle()
      return { events: hooks.events().map((e) => eventView(emulator, e)) }
    })
    // Runs the attempts due on the emulator clock now and waits for them (main.ts: every 15 s).
    app.post('/tick', async () => {
      await hooks.idle()
      return { attempted: await hooks.tick() }
    })
  }
}
