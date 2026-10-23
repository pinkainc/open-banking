// L5a EE webhooks delivered over real HTTP (the emulator's default transport, fetch) to a
// node:http receiver on an ephemeral local port: the P 15 payload for a heartbeat, an
// incoming payment (camt.054, no request id) and an FX offer, matched against the inbox
// message; the retry schedule against a receiver answering 500 or not listening, success
// stopping the retries, unsubscribe cancelling them, PUT redirecting later attempts, and
// deliveries for a service provider's connected customer.
import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, test } from 'node:test'
import { RETRY_DELAYS_MS } from '../src/webhooks/ee.js'
import { C1, C2, SP, call, drain, jsonDrain, jsonValid, setup, type Ctx } from './helpers.js'

interface Hit { method: string; path: string; headers: IncomingHttpHeaders; raw: string; body: any }

/** A local receiver: records every request and answers with the next queued status (default 200). */
class Receiver {
  hits: Hit[] = []
  statuses: number[] = []
  #server: Server
  constructor() {
    this.#server = createServer((req, res) => {
      let raw = ''
      req.setEncoding('utf8')
      req.on('data', (c) => { raw += c })
      req.on('end', () => {
        this.hits.push({ method: req.method!, path: req.url!, headers: req.headers, raw, body: jsonValid('webhook-ee-payload', raw) })
        res.statusCode = this.statuses.shift() ?? 200
        res.end('ok')
      })
    })
  }
  async start() { await new Promise<void>((r) => this.#server.listen(0, '127.0.0.1', r)); return this }
  get url() { return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}` }
  async stop() { this.#server.closeAllConnections(); await new Promise<void>((r) => this.#server.close(() => r())) }
}

/** A URL nobody listens on (a port that was just free). */
async function deadUrl() {
  const r = await new Receiver().start()
  const url = r.url
  await r.stop()
  return `${url}/gone`
}

let ctx: Ctx
let rx: Receiver
beforeEach(async () => {
  ctx = await setup() // no webhookDeliver: the real HTTP transport
  rx = await new Receiver().start()
})
afterEach(async () => { await rx.stop() })

type Who = { as?: string; headers?: Record<string, string> }
const forC1: Who = { as: SP.code, headers: { 'Client-Code': C1.code, 'Client-Country': 'EE' } }

async function subscribe(url: string, who: Who = {}) {
  const body = jsonValid('webhook-ee-subscription.request', { url, eventType: 'GENERAL_WEBHOOK' })
  const res = await call(ctx, { method: 'POST', url: '/notifications/subscribe', body, ...who })
  assert.equal(res.statusCode, 200, res.body)
  return jsonValid('webhook-ee-subscribe.response', res.body).subscriptionReference as string
}

const idle = () => ctx.emulator.webhooksEe.idle()
const tick = async () => JSON.parse((await call(ctx, { method: 'POST', url: '/_sim/webhooks/ee/tick' })).body).attempted as number
const deliveries = async () => JSON.parse((await call(ctx, { url: '/_sim/webhooks/ee/deliveries' })).body).deliveries as any[]

/** The payload matches the inbox message it announces (id, type, request id). */
function announces(p: any, m: { id: string; type: string; requestId?: string }, ref: string, customer = C1) {
  assert.equal(p.subscriptionReference, ref)
  assert.equal(p.messageResponseId, m.id)
  assert.equal(p.messageType, m.type)
  assert.equal(p.messageRequestId, m.requestId)
  assert.deepEqual([p.regCode, p.regCodeIssuer, p.bankCode], [customer.code, 'EE', 'LHVEE'])
  assert.match(p.eventId, /^\d+$/)
  assert.match(p.eventTimestamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+00:00$/)
  assert.match(p.messageCreatedTime, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+00:00$/)
}

describe('EE webhooks over HTTP: the payload', () => {
  test('a heartbeat: POST application/json to the subscribed path (query kept), no signature, the inbox message\'s ids', async () => {
    const ref = await subscribe(`${rx.url}/lhv/hook?tenant=7`)
    const hb = await call(ctx, { url: '/heartbeat/mq' })
    await idle()
    assert.equal(rx.hits.length, 1)
    const h = rx.hits[0]
    assert.deepEqual([h.method, h.path], ['POST', '/lhv/hook?tenant=7'])
    assert.match(String(h.headers['content-type']), /^application\/json/)
    assert.equal(Object.keys(h.headers).filter((k) => /signature|hmac/i.test(k)).length, 0)
    const [m] = await drain(ctx)
    assert.equal(m.requestId, hb.headers['message-request-id'])
    announces(h.body, m, ref)
    assert.deepEqual([h.body.eventTimestamp, h.body.messageCreatedTime], ['2026-03-10T08:00:00.000+00:00', '2026-03-10T08:00:00.000+00:00'])
    const [d] = await deliveries()
    assert.deepEqual([d.state, d.attempts.length, d.attempts[0].status, d.attempts[0].url], ['DELIVERED', 1, 200, `${rx.url}/lhv/hook?tenant=7`])
  })

  test('an incoming payment (camt.054): no messageRequestId at all (decision 423)', async () => {
    const ref = await subscribe(rx.url)
    const r = await call(ctx, { method: 'POST', url: '/_sim/incoming', body: { iban: C1.iban, amount: '12.00', debtor: { name: 'Outside Payer', iban: 'DE89370400440532013000', bic: 'COBADEFFXXX' } } })
    assert.equal(r.statusCode, 200, r.body)
    await idle()
    assert.equal(rx.hits.length, 1)
    assert.equal('messageRequestId' in rx.hits[0].body, false)
    const [m] = await drain(ctx)
    assert.equal(m.type, 'CREDIT_DEBIT_NOTIFICATION')
    assert.equal(m.requestId, undefined)
    announces(rx.hits[0].body, m, ref)
  })

  test('an FX deal: offer, confirmation and both camt.054 legs each announced, in order, with distinct event ids', async () => {
    const ref = await subscribe(rx.url)
    await call(ctx, { method: 'PUT', url: '/_sim/fx/pricing', body: { margin: '0' } })
    const offer = jsonValid('fx-trade-offer.request', { requestReference: 'W1', accountIBAN: C1.iban, currencyFrom: 'EUR', currencyTo: 'USD', amountFrom: 10, tenor: 'TODAY' })
    await call(ctx, { method: 'POST', url: '/fx/trade-offer', body: offer })
    await idle()
    ctx.clock.advance(5_000)
    await call(ctx, { method: 'POST', url: '/fx/trade-offer-confirmation', body: jsonValid('fx-trade-offer-confirmation.request', { requestReference: 'W1', confirm: true }) })
    await idle()
    const msgs = await jsonDrain(ctx)
    assert.deepEqual(msgs.map((m) => m.type), ['FX_TRADE_OFFER', 'CREDIT_DEBIT_NOTIFICATION', 'CREDIT_DEBIT_NOTIFICATION', 'FX_TRADE_OFFER_CONFIRMATION'])
    jsonValid('fx-trade-offer.response', msgs[0].body)
    jsonValid('fx-trade-offer-confirmation.response', msgs[3].body)
    const byId = new Map(rx.hits.map((h) => [h.body.messageResponseId, h.body]))
    assert.equal(byId.size, 4)
    for (const m of msgs) announces(byId.get(m.id), m, ref)
    assert.equal(new Set(rx.hits.map((h) => h.body.eventId)).size, 4)
    assert.equal(byId.get(msgs[3].id).eventTimestamp, '2026-03-10T08:00:05.000+00:00')
  })

  test('only the subscribing customer\'s messages; a provider\'s subscription for C1 gets C1\'s, its own gets its own', async () => {
    const own = await new Receiver().start()
    try {
      const c1Ref = await subscribe(`${rx.url}/c1`, forC1)
      const ownRef = await subscribe(`${own.url}/own`, { as: SP.code, headers: { 'Client-Code': SP.code, 'Client-Country': 'EE' } })
      await call(ctx, { url: '/heartbeat/mq', as: C2.code })
      const hb1 = await call(ctx, { url: '/heartbeat/mq', ...forC1 })
      const hbSp = await call(ctx, { url: '/heartbeat/mq', as: SP.code, headers: { 'Client-Code': SP.code, 'Client-Country': 'EE' } })
      await idle()
      assert.deepEqual(rx.hits.map((h) => [h.path, h.body.messageRequestId, h.body.regCode, h.body.subscriptionReference]), [['/c1', hb1.headers['message-request-id'], C1.code, c1Ref]])
      assert.deepEqual(own.hits.map((h) => [h.path, h.body.messageRequestId, h.body.regCode, h.body.subscriptionReference]), [['/own', hbSp.headers['message-request-id'], SP.code, ownRef]])
    } finally { await own.stop() }
  })

  test('a subscription made by a provider outlives its contract (decision 424)', async () => {
    await subscribe(rx.url, forC1)
    const c1 = JSON.parse((await call(ctx, { url: '/_sim/contracts' })).body).contracts.find((c: any) => c.customer.code === C1.code)
    await call(ctx, { method: 'POST', url: `/_sim/contracts/${c1.id}/close` })
    assert.equal((await call(ctx, { url: '/notifications/subscriptions', ...forC1 })).statusCode, 403)
    await call(ctx, { url: '/heartbeat/mq' })
    await idle()
    assert.equal(rx.hits.length, 1, 'still announced: the subscription is C1\'s')
    // C1 can see and remove it.
    const list = jsonValid('webhook-ee-list.response', (await call(ctx, { url: '/notifications/subscriptions' })).body)
    assert.equal(list.subscriptions[0].url, rx.url)
  })
})

describe('EE webhooks over HTTP: retries (decision 421)', () => {
  test('500, 500, then 200: delivered on the second retry, nothing more afterwards', async () => {
    await subscribe(rx.url)
    rx.statuses = [500, 500]
    await call(ctx, { url: '/heartbeat/mq' })
    await idle()
    assert.equal(rx.hits.length, 1)
    ctx.clock.advance(RETRY_DELAYS_MS[0] - 1)
    assert.equal(await tick(), 0)
    ctx.clock.advance(1)
    assert.equal(await tick(), 1)
    ctx.clock.advance(RETRY_DELAYS_MS[1])
    assert.equal(await tick(), 1)
    assert.equal(rx.hits.length, 3)
    ctx.clock.advance(RETRY_DELAYS_MS[2] + RETRY_DELAYS_MS[3])
    assert.equal(await tick(), 0)
    assert.equal(rx.hits.length, 3)
    assert.equal(new Set(rx.hits.map((h) => h.raw)).size, 1, 'the same body, eventId and eventTimestamp on every attempt')
    const [d] = await deliveries()
    assert.deepEqual([d.state, d.attempts.map((a: any) => a.status)], ['DELIVERED', [500, 500, 200]])
  })

  test('a receiver that is down: five attempts on the schedule, then FAILED', async () => {
    await subscribe(await deadUrl())
    await call(ctx, { url: '/heartbeat/mq' })
    await idle()
    for (const delay of RETRY_DELAYS_MS) {
      ctx.clock.advance(delay)
      assert.equal(await tick(), 1)
    }
    ctx.clock.advance(RETRY_DELAYS_MS.at(-1)! * 10)
    assert.equal(await tick(), 0)
    const [d] = await deliveries()
    assert.equal(d.state, 'FAILED')
    assert.equal(d.attempts.length, 5)
    assert.ok(d.attempts.every((a: any) => a.status === undefined && a.error), JSON.stringify(d.attempts))
  })

  test('PUT changes the URL for later attempts: the retry reaches the new receiver', async () => {
    const dead = await deadUrl()
    const ref = await subscribe(dead)
    await call(ctx, { url: '/heartbeat/mq' })
    await idle()
    const body = jsonValid('webhook-ee-subscription.request', { url: `${rx.url}/v2`, eventType: 'GENERAL_WEBHOOK' })
    assert.equal((await call(ctx, { method: 'PUT', url: `/notifications/subscriptions/${ref}`, body })).statusCode, 204)
    ctx.clock.advance(RETRY_DELAYS_MS[0])
    assert.equal(await tick(), 1)
    assert.deepEqual(rx.hits.map((h) => h.path), ['/v2'])
    const [d] = await deliveries()
    assert.deepEqual([d.state, d.attempts.map((a: any) => a.url)], ['DELIVERED', [dead, `${rx.url}/v2`]])
    // New messages go to the new URL at once.
    await call(ctx, { url: '/heartbeat/mq' })
    await idle()
    assert.equal(rx.hits.length, 2)
  })

  test('unsubscribing cancels the pending retries', async () => {
    const ref = await subscribe(rx.url)
    rx.statuses = [503]
    await call(ctx, { url: '/heartbeat/mq' })
    await idle()
    assert.equal((await call(ctx, { method: 'DELETE', url: `/notifications/subscriptions/${ref}` })).statusCode, 200)
    ctx.clock.advance(RETRY_DELAYS_MS[0])
    assert.equal(await tick(), 0)
    assert.equal(rx.hits.length, 1)
    const [d] = await deliveries()
    assert.deepEqual([d.state, d.nextAt], ['CANCELLED', undefined])
    // And nothing new is announced.
    await call(ctx, { url: '/heartbeat/mq' })
    await idle()
    assert.equal(rx.hits.length, 1)
  })

  test('several subscriptions retry independently', async () => {
    const other = await new Receiver().start()
    try {
      await subscribe(rx.url)
      await subscribe(other.url)
      other.statuses = [500]
      await call(ctx, { url: '/heartbeat/mq' })
      await idle()
      ctx.clock.advance(RETRY_DELAYS_MS[0])
      assert.equal(await tick(), 1, 'only the failed one')
      assert.deepEqual([rx.hits.length, other.hits.length], [1, 2])
      assert.deepEqual((await deliveries()).map((d) => d.state), ['DELIVERED', 'DELIVERED'])
    } finally { await other.stop() }
  })
})
