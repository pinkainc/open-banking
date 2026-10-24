// S5 UK webhooks over real HTTP (the default fetch transport) to a node:http receiver on
// a loopback port: the receiver verifies X-LHV-HMAC with the docs' own NodeJS verifyHmac
// (webhook-security.md) on the raw request bytes, gunzips a compressed body, and answers
// 500 then 200 so the retry and the history fields (httpStatus, responseContentLength,
// latencyMs) come from a real exchange; a receiver that is not listening is a failure
// without httpStatus.
import assert from 'node:assert/strict'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, test } from 'node:test'
import { RETRY_DELAYS_MS } from '../src/webhooks/uk.js'
import { C1, call, jsonValid, setup, type Ctx } from './helpers.js'

// webhook-security.md, "Typescript" tab, verbatim.
function generateHmac(payload: Buffer, secret: string): Buffer {
  const secretBytes = Buffer.from(secret, 'utf8')
  const hmac = createHmac('sha256', secretBytes)
  hmac.update(payload)
  return hmac.digest()
}
function verifyHmac(payload: Buffer, secret: string, receivedHmacHeader: string): boolean {
  const receivedHmac = Buffer.from(receivedHmacHeader, 'hex')
  const expectedHmac = generateHmac(payload, secret)
  return timingSafeEqual(receivedHmac, expectedHmac)
}

interface Hit { headers: IncomingHttpHeaders; raw: Buffer }
class Receiver {
  hits: Hit[] = []
  statuses: number[] = []
  #server: Server
  constructor() {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        this.hits.push({ headers: req.headers, raw: Buffer.concat(chunks) })
        res.statusCode = this.statuses.shift() ?? 200
        res.end('received')
      })
    })
  }
  async start() { await new Promise<void>((r) => this.#server.listen(0, '127.0.0.1', r)); return this }
  get url() { return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}/lhv` }
  async stop() { this.#server.closeAllConnections(); await new Promise<void>((r) => this.#server.close(() => r())) }
}

let ctx: Ctx
let rx: Receiver
beforeEach(async () => {
  ctx = await setup({}, undefined, { flavour: 'UK' })
  rx = await new Receiver().start()
})
afterEach(async () => { await rx.stop() })

async function subscribe(requestUrl: string, extra: Record<string, unknown> = {}) {
  const res = await call(ctx, { method: 'POST', url: '/notifications/subscription', body: { messageType: 'VIBAN_OPEN', requestUrl, active: true, ...extra } })
  assert.equal(res.statusCode, 200, res.body)
  return JSON.parse(res.body)
}
const add = async () => {
  const m = await ctx.emulator.inbox.add({ customer: { code: C1.code, country: C1.country }, type: 'VIBAN_OPEN', body: '<VibanOpenResponse/>', requestId: 'REQ00000000000000000000000000000001' })
  await ctx.emulator.webhooksUk.idle()
  return m
}

test('signed, gzipped, retried and recorded over HTTP', async () => {
  const cfg = await subscribe(rx.url, { compressionEnabled: true, sharedSecret: 'receiver secret' })
  rx.statuses = [500]
  const m = await add()
  ctx.clock.advance(RETRY_DELAYS_MS[0])
  await ctx.emulator.webhooksUk.tick()
  assert.equal(rx.hits.length, 2)
  for (const h of rx.hits) {
    assert.equal(h.headers['content-type'], 'application/json')
    assert.equal(h.headers['content-encoding'], 'gzip')
    const json = gunzipSync(h.raw)
    assert.ok(verifyHmac(json, cfg.sharedSecret, String(h.headers['x-lhv-hmac'])))
    assert.ok(!verifyHmac(h.raw, cfg.sharedSecret, String(h.headers['x-lhv-hmac'])))
    const p = jsonValid('webhook-uk-payload', json.toString('utf8'))
    assert.equal(p.messageResponseId, m.id)
  }
  const res = await call(ctx, { url: '/notifications/history' })
  const [e] = jsonValid('webhook-history.response', res.body)
  assert.equal(e.status, 'SUCCESS')
  assert.equal(e.retriesAttempted, 1)
  assert.equal(e.httpStatus, 200)
  assert.equal(e.responseContentLength, 'received'.length)
  assert.ok(Number.isInteger(e.latencyMs) && e.latencyMs >= 0)
})

test('uncompressed: the HMAC is of the raw body; nobody listening is RETRY_PENDING without httpStatus', async () => {
  const cfg = await subscribe(rx.url)
  await add()
  const [h] = rx.hits
  assert.equal(h.headers['content-encoding'], undefined)
  assert.ok(verifyHmac(h.raw, cfg.sharedSecret, String(h.headers['x-lhv-hmac'])))

  const dead = rx.url
  await rx.stop()
  rx = await new Receiver().start()
  await add()
  const res = await call(ctx, { url: `/notifications/history?status=RETRY_PENDING` })
  const [e] = jsonValid('webhook-history.response', res.body)
  assert.ok(e && !('httpStatus' in e), `${dead}: ${res.body}`)
})
