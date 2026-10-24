// HTTP surface of the EE webhooks: the four subscription operations of P 15 (sync JSON;
// Client-Code/Client-Country select the customer for a service provider) and the
// emulator's own /_sim/webhooks/ee control plane (delivery log, retries now).
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Caller } from '../auth.js'
import { jsonError, notFound } from '../errors.js'
import type { Emulator } from '../emulator.js'
import { asObject, JsonBodyError, parseJsonBody } from '../jsonbody.js'
import { EVENT_TYPE, type Delivery } from './ee.js'

/** { url, eventType } of subscribe and update; texts are ours (P 15 documents none, decision 422). */
function subscriptionBody(raw: unknown): { url: string; eventType: string } {
  let b: Record<string, unknown> | undefined
  try { b = asObject(parseJsonBody(raw)) } catch (e) {
    if (e instanceof JsonBodyError) throw jsonError(400, 'BAD_REQUEST', e.message)
    throw e
  }
  if (!b) throw jsonError(400, 'BAD_REQUEST', 'The request body must be a JSON object')
  if (typeof b.url !== 'string' || !b.url.trim()) throw jsonError(400, 'BAD_REQUEST', 'url is mandatory')
  let u: URL
  try { u = new URL(b.url.trim()) } catch { throw jsonError(400, 'BAD_REQUEST', 'url must be an absolute http or https URL') }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw jsonError(400, 'BAD_REQUEST', 'url must be an absolute http or https URL')
  if (b.eventType === undefined || b.eventType === null) throw jsonError(400, 'BAD_REQUEST', 'eventType is mandatory')
  if (b.eventType !== EVENT_TYPE) throw jsonError(400, 'BAD_REQUEST', `eventType must be ${EVENT_TYPE}`)
  return { url: b.url.trim(), eventType: EVENT_TYPE }
}

export function registerEeWebhooks(app: FastifyInstance, emulator: Emulator, caller: (req: FastifyRequest) => Promise<Caller>) {
  const hooks = emulator.webhooksEe
  const view = (s: { url: string; subscriptionReference: string; eventType: string }) =>
    ({ url: s.url, subscriptionReference: s.subscriptionReference, eventType: s.eventType })
  const ref = (req: FastifyRequest) => (req.params as { ref: string }).ref

  app.post('/notifications/subscribe', async (req) => {
    const c = await caller(req)
    const b = subscriptionBody(req.body)
    return { subscriptionReference: (await hooks.subscribe(c.customer, b.url, b.eventType)).subscriptionReference }
  })

  app.get('/notifications/subscriptions', async (req, reply) => {
    const subs = await hooks.list((await caller(req)).customer)
    if (subs.length === 0) return reply.code(204).send()
    return { subscriptions: subs.map(view) }
  })

  app.put('/notifications/subscriptions/:ref', async (req, reply) => {
    const c = await caller(req)
    const b = subscriptionBody(req.body)
    if (!(await hooks.update(c.customer, ref(req), b.url))) throw notFound()
    return reply.code(204).send()
  })

  app.delete('/notifications/subscriptions/:ref', async (req, reply) => {
    const c = await caller(req)
    if (!(await hooks.remove(c.customer, ref(req)))) throw notFound()
    return reply.code(200).send()
  })
}

function deliveryView(d: Delivery) {
  return {
    eventId: d.eventId, subscriptionReference: d.subscriptionReference, messageResponseId: d.messageResponseId, state: d.state,
    payload: JSON.parse(d.payload),
    attempts: d.attempts.map((a) => ({ at: a.at.toISOString(), url: a.url, ...(a.status !== undefined ? { status: a.status } : {}), ...(a.error ? { error: a.error } : {}) })),
    ...(d.nextAt !== undefined ? { nextAt: new Date(d.nextAt).toISOString() } : {}),
  }
}

export function eeWebhookSimRoutes(emulator: Emulator) {
  const hooks = emulator.webhooksEe
  return async (app: FastifyInstance) => {
    app.get('/subscriptions', async () => ({
      subscriptions: (await hooks.all()).map((s) => ({ ...s, createdAt: s.createdAt.toISOString() })),
    }))
    app.get('/deliveries', async () => {
      await hooks.idle()
      return { deliveries: (await hooks.deliveries()).map(deliveryView) }
    })
    // Runs the attempts due on the emulator clock now and waits for them (main.ts: every 15 s).
    app.post('/tick', async () => {
      await hooks.idle()
      const attempted = await hooks.tick()
      return { attempted }
    })
  }
}
