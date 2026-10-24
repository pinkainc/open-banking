// S5 UK webhooks (G services/webhooks/*) with a recording fake transport: the golden
// X-LHV-HMAC vector of webhook-security.md byte for byte, the published samples against
// the ssot schemas and replayed to the server, configuration CRUD (one per message type,
// secret shown on create and edit only, rotation), host gating, the delivered payload
// (field order, bankCode from the request's X-Bank-Code, metadata, full body, gzip,
// removeAfterDelivery), retries for 24 h on the emulator clock, history filters and
// replay. Every JSON body the server produces is checked with ajv against ssot/json-schemas.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { beforeEach, describe, test } from 'node:test'
import { DAY_MS } from '../src/clock.js'
import { hmacHex, payloadJson, RETRY_DELAYS_MS, RETRY_WINDOW_MS, type UkRequest } from '../src/webhooks/uk.js'
import { C1, C2, MIRROR_DIR, SP, call, camt060, jsonValid, setup, type Ctx } from './helpers.js'

const G = join(MIRROR_DIR, 'docs/gitbook/connect/services/webhooks')
const page = (p: string) => (existsSync(join(G, p)) ? readFileSync(join(G, p), 'utf8') : undefined)

/** JSON as published; G drops commas before some lines (`false\n  "compressionEnabled"`), which are put back. */
function loose(raw: string): any {
  try { return JSON.parse(raw) } catch { return JSON.parse(raw.replace(/([}\]"el\d])(\s*\n\s*)(["{])/g, '$1,$2$3')) }
}
/** The ```json blocks of a G webhooks page, and the <pre><code class="lang-json"> ones. */
function gJson(p: string): any[] {
  const s = page(p)
  if (!s) return []
  return [...s.matchAll(/```json\n([\s\S]*?)```|<code class="lang-json">([\s\S]*?)<\/code>/g)]
    .map((m) => (m[1] ?? m[2].replace(/<\/?strong>/g, '')))
    .filter((raw) => !raw.trimStart().startsWith('<')) // the XML <Errors> of a 403 tab
    .map(loose)
}

// webhook-security.md "Example Payload and HMAC".
const SECRET = 'example_secret_for_docs'
const VECTOR = '{"eventId":"bd960667-37cf-4698-b63a-919aa282ef3c","eventTimestamp":"2024-07-10T10:39:33.295567","subscriptionReference":"2345","messageResponseId":"0566defb-2c1b-4649-9c1d-cda27d2f5a10","messageRequestId":"dd14b64d-0553-4bea-acb5-71f45697e126","messageType":"VIBAN_OPEN","messageCreatedTime":"2024-07-10T10:39:33.263134","clientCode":"123","clientCountry":"GB","bankCode":"LHVUK"}'
const GOLDEN = '79ece3b561a9a95a56edf5d8c63224b1fa43f0198442537abe22a7e3ba99e774'

const UK = { flavour: 'UK' as const }
let ctx: Ctx
let sent: UkRequest[]
let answers: (number | Error)[]
const hooks = () => ctx.emulator.webhooksUk
beforeEach(async () => {
  sent = []
  answers = []
  ctx = await setup({
    ukWebhookDeliver: async (r) => {
      sent.push(r)
      const a = answers.shift() ?? 200
      if (a instanceof Error) throw a
      return { status: a, contentLength: 2 }
    },
  }, undefined, UK)
})

type Who = { as?: string; headers?: Record<string, string> }
const spOwn: Who = { as: SP.code, headers: { 'Client-Code': SP.code, 'Client-Country': 'EE' } }

async function subscribe(body: Record<string, unknown>, who: Who = {}) {
  const res = await call(ctx, { method: 'POST', url: '/notifications/subscription', body, ...who })
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.headers['x-bank-code'], 'LHVUK')
  return jsonValid('webhook-uk-config', res.body)
}
const sub = (messageType: string, extra: Record<string, unknown> = {}, who: Who = {}) =>
  subscribe({ messageType, requestUrl: 'https://hooks.example.org/lhv', active: true, ...extra }, who)

/** A message of C1 (or another customer), then the deliveries it caused. */
async function message(type = 'VIBAN_OPEN', customer = { code: C1.code, country: C1.country }, body = '<VibanOpenResponse/>') {
  const m = await ctx.emulator.inbox.add({ customer, type, body, requestId: 'REQ0123456789abcdef0123456789abcdef' })
  await hooks().idle()
  return m
}
const delivered = (i = sent.length - 1) => jsonValid('webhook-uk-payload', sent[i].body.toString('utf8'))

async function history(query = '', who: Who = {}) {
  const res = await call(ctx, { url: `/notifications/history${query}`, ...who })
  assert.equal(res.statusCode, 200, res.body)
  return jsonValid('webhook-history.response', res.body) as any[]
}
async function replay(eventIds: string[], who: Who = {}) {
  // Ids that are not UUIDs are wrong on purpose: the server reports them, the schema refuses them.
  const body = eventIds.every((id) => /^[0-9a-f-]{36}$/.test(id)) ? jsonValid('webhook-replay.request', { eventIds }) : { eventIds }
  const res = await call(ctx, { method: 'POST', url: '/notifications/replay', body, ...who })
  return { status: res.statusCode, body: jsonValid('webhook-replay.response', res.body) }
}

describe('X-LHV-HMAC golden vector (webhook-security.md)', () => {
  test('our HMAC of the published payload is the published X-LHV-HMAC', () => {
    assert.equal(hmacHex(SECRET, VECTOR), GOLDEN)
    assert.equal(hmacHex(SECRET, Buffer.from(VECTOR, 'utf8')), GOLDEN)
  })

  test('our payload writer produces the vector byte for byte (clientCode naming, compact JSON)', () => {
    const v = JSON.parse(VECTOR)
    const out = payloadJson({
      eventId: v.eventId, eventTimestamp: v.eventTimestamp, subscriptionReference: v.subscriptionReference,
      messageResponseId: v.messageResponseId, messageRequestId: v.messageRequestId, messageType: v.messageType,
      messageCreatedTime: v.messageCreatedTime, code: v.clientCode, country: v.clientCountry, bankCode: v.bankCode,
    }, 'clientCode')
    assert.equal(out, VECTOR)
    assert.equal(hmacHex(SECRET, out), GOLDEN)
    jsonValid('webhook-uk-payload', out)
  })

  test('the mirror page carries the same secret, payload and HMAC, also in Base64', (t) => {
    const s = page('webhook-security.md')
    if (!s) return t.skip('no docs mirror')
    assert.ok(s.includes(`Secret: \`${SECRET}\``))
    assert.ok(s.includes(`Payload: \`${VECTOR}\``))
    assert.ok(s.includes(`\`X-LHV-HMAC\`: \`${GOLDEN}\``))
    const b64 = [...s.matchAll(/(?:Secret|Payload): `([A-Za-z0-9+/=]{20,})`/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8'))
    assert.deepEqual(b64, [SECRET, VECTOR])
  })
})

describe('published samples', () => {
  test('configuration samples (commas restored) match webhook-uk-config', (t) => {
    const blocks = gJson('managing-webhook-configurations.md')
    if (!blocks.length) return t.skip('no docs mirror')
    const configs = blocks.flatMap((b) => (Array.isArray(b) ? b : [b]))
    assert.ok(configs.length >= 7)
    for (const c of configs) jsonValid('webhook-uk-config', c)
  })

  test('payload, history and replay samples match their schemas', (t) => {
    const intro = gJson('introduction-and-payload-format.md')
    if (!intro.length) return t.skip('no docs mirror')
    jsonValid('webhook-uk-payload', intro[0])
    for (const h of gJson('webhook-services/get-list-of-webhook-messages.md')) jsonValid('webhook-history.response', h)
    const [req, ok, fail] = gJson('webhook-services/replay-webhooks.md')
    jsonValid('webhook-replay.request', req)
    jsonValid('webhook-replay.response', ok)
    jsonValid('webhook-replay.response', fail)
  })

  test('the G create request replayed: the response has the sample response\'s fields, in order', async (t) => {
    const blocks = gJson('managing-webhook-configurations.md')
    if (!blocks.length) return t.skip('no docs mirror')
    const [, request, response] = blocks
    const got = await subscribe(request)
    assert.deepEqual(Object.keys(got), Object.keys(response))
    assert.equal(got.active, true) // sent as the string "true"
    assert.equal(got.attachFullBody, true)
    assert.equal(got.attachMetadata, false)
    assert.equal(got.removeAfterDelivery, false)
    assert.equal(got.compressionEnabled, false)
    assert.equal(got.eventType, 'GENERAL_WEBHOOK')
    assert.match(got.sharedSecret, /^[A-Za-z0-9_-]{64}$/)
  })

  test('the G edit request replayed: active "false" applied, the secret rotated', async (t) => {
    const blocks = gJson('managing-webhook-configurations.md')
    if (blocks.length < 7) return t.skip('no docs mirror')
    const created = await sub('VIBAN_OPEN')
    const res = await call(ctx, { method: 'PUT', url: `/notifications/subscription/${created.subscriptionReference}`, body: blocks[5] })
    assert.equal(res.statusCode, 200, res.body)
    const got = jsonValid('webhook-uk-config', res.body)
    assert.deepEqual(Object.keys(got), Object.keys(blocks[6]))
    assert.equal(got.active, false)
    assert.match(got.sharedSecret, /^[A-Za-z0-9_-]{64}$/)
    assert.notEqual(got.sharedSecret, created.sharedSecret)
  })

  test('the G replay request replayed: unknown ids, 400 with the documented error text', async (t) => {
    const [req] = gJson('webhook-services/replay-webhooks.md')
    if (!req) return t.skip('no docs mirror')
    const r = await replay(req.eventIds)
    assert.equal(r.status, 400)
    assert.deepEqual(r.body.dispatched, [])
    assert.deepEqual(r.body.failed.map((f: any) => f.eventId), req.eventIds)
    assert.equal(r.body.failed[0].error, `Cannot replay webhook. WebhookResponse not found for contract ${C1.code} and webhook eventId: ${req.eventIds[0]}`)
  })
})

describe('configurations', () => {
  test('create, list and get without the secret, edit, delete', async () => {
    const a = await sub('VIBAN_OPEN', { sharedSecret: 'my own secret', attachMetadata: true })
    assert.equal(a.sharedSecret, 'my own secret')
    const b = await sub('VIBAN_CLOSE', { active: false, removeAfterDelivery: 'true', compressionEnabled: true })
    const list = await call(ctx, { url: '/notifications/subscription' })
    assert.equal(list.statusCode, 200)
    const arr = JSON.parse(list.body)
    assert.ok(Array.isArray(arr))
    for (const c of arr) jsonValid('webhook-uk-config', c)
    assert.deepEqual(arr.map((c: any) => c.subscriptionReference), [a.subscriptionReference, b.subscriptionReference])
    assert.ok(arr.every((c: any) => !('sharedSecret' in c)))
    const { sharedSecret: _s, ...bNoSecret } = b
    assert.deepEqual(arr[1], bNoSecret)
    assert.equal(b.removeAfterDelivery, true)

    const one = await call(ctx, { url: `/notifications/subscription/${a.subscriptionReference.toUpperCase()}` })
    assert.equal(one.statusCode, 200)
    const got = jsonValid('webhook-uk-config', one.body)
    assert.equal(got.attachMetadata, true)
    assert.ok(!('sharedSecret' in got))

    // Keeping the secret means sending it; everything not sent stays.
    const kept = await call(ctx, { method: 'PUT', url: `/notifications/subscription/${a.subscriptionReference}`, body: { requestUrl: 'https://other.example.org/x', sharedSecret: 'my own secret' } })
    assert.equal(kept.statusCode, 200, kept.body)
    const k = jsonValid('webhook-uk-config', kept.body)
    assert.equal(k.sharedSecret, 'my own secret')
    assert.equal(k.requestUrl, 'https://other.example.org/x')
    assert.equal(k.attachMetadata, true)
    assert.equal(k.messageType, 'VIBAN_OPEN')

    const del = await call(ctx, { method: 'DELETE', url: `/notifications/subscription/${a.subscriptionReference}` })
    assert.equal(del.statusCode, 200)
    assert.equal(del.body, '')
    assert.equal((await call(ctx, { url: `/notifications/subscription/${a.subscriptionReference}` })).statusCode, 404)
    assert.equal((await call(ctx, { method: 'DELETE', url: `/notifications/subscription/${a.subscriptionReference}` })).statusCode, 404)
    assert.equal((await call(ctx, { method: 'PUT', url: `/notifications/subscription/${a.subscriptionReference}`, body: { active: true } })).statusCode, 404)
    // The type is free again.
    await sub('VIBAN_OPEN')
  })

  test('an empty list is an empty array', async () => {
    const res = await call(ctx, { url: '/notifications/subscription' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.body, '[]')
  })

  test('one configuration per message type, even an inactive one; other customers are separate', async () => {
    await sub('PAYMENT', { active: false })
    const dup = await call(ctx, { method: 'POST', url: '/notifications/subscription', body: { messageType: 'PAYMENT', requestUrl: 'https://x.example.org', active: true } })
    assert.equal(dup.statusCode, 400)
    assert.match(JSON.parse(dup.body).errors[0].description, /already exists/)
    await sub('PAYMENT', {}, { as: C2.code })
    // Renaming onto a type already configured is refused too.
    const other = await sub('VIBAN_OPEN')
    const ren = await call(ctx, { method: 'PUT', url: `/notifications/subscription/${other.subscriptionReference}`, body: { messageType: 'PAYMENT' } })
    assert.equal(ren.statusCode, 400)
    // Another customer's reference is unknown.
    assert.equal((await call(ctx, { url: `/notifications/subscription/${other.subscriptionReference}`, as: C2.code })).statusCode, 404)
  })

  test('invalid bodies: 400 in the JSON envelope', async () => {
    const cases: [unknown, RegExp][] = [
      [{ requestUrl: 'https://x.example.org', active: true }, /messageType is mandatory/],
      [{ messageType: 'PAYMENT', active: true }, /requestUrl is mandatory/],
      [{ messageType: 'PAYMENT', requestUrl: 'https://x.example.org' }, /active is mandatory/],
      [{ messageType: 'PAYMENT', requestUrl: 'http://x.example.org', active: true }, /https/],
      [{ messageType: 'PAYMENT', requestUrl: 'ftp://x.example.org', active: true }, /https/],
      [{ messageType: 'PAYMENT', requestUrl: 'not a url', active: true }, /https/],
      [{ messageType: 'payment', requestUrl: 'https://x.example.org', active: true }, /messageType/],
      [{ messageType: 'PAYMENT', requestUrl: 'https://x.example.org', active: 'yes' }, /active must be true or false/],
      [{ messageType: 'PAYMENT', requestUrl: 'https://x.example.org', active: true, eventType: 'OTHER' }, /eventType/],
      [{ messageType: 'PAYMENT', requestUrl: 'https://x.example.org', active: true, sharedSecret: '' }, /sharedSecret/],
      [['PAYMENT'], /JSON object/],
      ['{"messageType":', /JSON parse error/],
    ]
    for (const [body, re] of cases) {
      const res = await call(ctx, { method: 'POST', url: '/notifications/subscription', body: typeof body === 'string' ? body : body as object, contentType: 'application/json' })
      assert.equal(res.statusCode, 400, JSON.stringify(body))
      const e = JSON.parse(res.body)
      assert.equal(e.errors[0].errorCode, 'BAD_REQUEST')
      assert.match(e.errors[0].description, re, JSON.stringify(body))
    }
    // http to a loopback receiver is allowed (local development).
    assert.equal((await call(ctx, { method: 'POST', url: '/notifications/subscription', body: { messageType: 'PAYMENT', requestUrl: 'http://127.0.0.1:9/hook', active: true } })).statusCode, 200)
    // A body naming another subscriptionReference than the path.
    const c = await sub('VIBAN_OPEN')
    const res = await call(ctx, { method: 'PUT', url: `/notifications/subscription/${c.subscriptionReference}`, body: { subscriptionReference: '3dcfe476-2dac-4239-bb42-6ca9e6613d18' } })
    assert.equal(res.statusCode, 400)
  })

  test('UK host only: 404 on the EE host and with x-bank-code LHVEE; 403 without a certificate is XML', async () => {
    const ee = await setup()
    for (const url of ['/notifications/subscription', '/notifications/history']) {
      assert.equal((await call(ee, { url })).statusCode, 404, url)
      assert.equal((await call(ctx, { url, headers: { 'x-bank-code': 'LHVEE' } })).statusCode, 404, url)
    }
    assert.equal((await call(ee, { method: 'POST', url: '/notifications/replay', body: { eventIds: [] } })).statusCode, 404)
    const anon = await call(ctx, { url: '/notifications/history', as: null })
    assert.equal(anon.statusCode, 403)
    assert.match(anon.body, /<ErrorCode>FORBIDDEN<\/ErrorCode>/)
  })
})

describe('delivery', () => {
  test('a new message of a subscribed type: the documented payload, signed, LHVUK', async () => {
    const c = await sub('VIBAN_OPEN')
    await sub('PAYMENT')
    const m = await message('VIBAN_OPEN')
    assert.equal(sent.length, 1)
    const r = sent[0]
    assert.equal(r.url, 'https://hooks.example.org/lhv')
    assert.equal(r.headers['content-type'], 'application/json')
    assert.equal(r.headers['x-lhv-hmac'], hmacHex(c.sharedSecret, r.body))
    assert.equal(r.headers['content-encoding'], undefined)
    const p = delivered()
    const intro = gJson('introduction-and-payload-format.md')[0]
    if (intro) assert.deepEqual(Object.keys(p), Object.keys(intro))
    assert.equal(p.subscriptionReference, c.subscriptionReference)
    assert.equal(p.messageResponseId, m.id)
    assert.equal(p.messageRequestId, m.requestId)
    assert.equal(p.messageType, 'VIBAN_OPEN')
    assert.equal(p.regCode, C1.code)
    assert.equal(p.regCodeIssuer, C1.country)
    assert.equal(p.bankCode, 'LHVUK')
    assert.match(p.eventTimestamp, /^2026-03-10T08:00:00\.000\+00:00$/)
    assert.match(p.messageCreatedTime, /^2026-03-10T08:00:00\.000\+00:00$/)
    assert.ok(!('metadata' in p) && !('messageBase64' in p))
    // Other types, other customers, inactive configurations: nothing.
    await message('VIBAN_CLOSE')
    await message('VIBAN_OPEN', { code: C2.code, country: C2.country })
    await call(ctx, { method: 'PUT', url: `/notifications/subscription/${c.subscriptionReference}`, body: { active: false } })
    await message('VIBAN_OPEN')
    assert.equal(sent.length, 1)
  })

  test('a notification without a request: messageRequestId left out', async () => {
    await sub('CREDIT_DEBIT_NOTIFICATION')
    await ctx.emulator.inbox.add({ customer: { code: C1.code, country: 'EE' }, type: 'CREDIT_DEBIT_NOTIFICATION', body: '<Document/>' })
    await hooks().idle()
    const p = delivered()
    assert.ok(!('messageRequestId' in p))
  })

  test('bankCode is the X-Bank-Code of the request behind the message; metadata as Messages Metadata', async () => {
    await sub('ACCOUNT_BALANCE', { attachMetadata: true })
    for (const headers of [{}, { 'x-bank-code': 'LHVEE' }] as Record<string, string>[]) {
      const res = await call(ctx, { method: 'POST', url: '/account-balance', body: camt060({ kind: 'balance' }), headers })
      assert.equal(res.statusCode, 202, res.body)
      await hooks().idle()
    }
    assert.equal(sent.length, 2)
    const [uk, ee] = [delivered(0), delivered(1)]
    assert.equal(uk.bankCode, 'LHVUK')
    assert.equal(ee.bankCode, 'LHVEE')
    assert.ok(uk.metadata.Reports.length >= 1)
    assert.ok(uk.metadata.Reports.every((r: any) => r['Acct.IBAN'] === C1.iban && /^[A-Z]{3}$/.test(r['Acct.Ccy'])), JSON.stringify(uk.metadata))
    const h = await history()
    assert.deepEqual(h.map((x) => x.message.bankCode), ['LHVEE', 'LHVUK'])
    assert.ok(h.every((x) => !('metadata' in x.message)))
  })

  test('attachFullBody: messageBase64 is the message body; compression: gzip, HMAC of the JSON', async () => {
    const c = await sub('VIBAN_OPEN', { attachFullBody: true, compressionEnabled: true })
    const m = await message('VIBAN_OPEN', undefined, '<VibanOpenResponse>ž€</VibanOpenResponse>')
    const r = sent[0]
    assert.equal(r.headers['content-encoding'], 'gzip')
    const json = gunzipSync(r.body).toString('utf8')
    assert.equal(r.headers['x-lhv-hmac'], hmacHex(c.sharedSecret, json))
    const p = jsonValid('webhook-uk-payload', json)
    assert.equal(Buffer.from(p.messageBase64, 'base64').toString('utf8'), m.body)
  })

  test('removeAfterDelivery: a delivered message is processed; a failed one stays pending', async () => {
    await sub('VIBAN_OPEN', { removeAfterDelivery: true })
    answers = [500]
    const kept = await message('VIBAN_OPEN')
    const gone = await message('VIBAN_OPEN')
    assert.equal(sent.length, 2)
    const next = await call(ctx, { url: '/messages/next' })
    assert.equal(next.headers['message-response-id'], kept.id)
    await call(ctx, { method: 'DELETE', url: `/messages/${kept.id}` })
    assert.equal((await call(ctx, { url: '/messages/next' })).statusCode, 204)
    assert.equal((await call(ctx, { url: `/messages/${gone.id}` })).statusCode, 404)
  })

  test('a service provider\'s configuration covers its connected customers; theirs only themselves', async () => {
    await sub('VIBAN_OPEN', {}, spOwn)
    await message('VIBAN_OPEN', { code: C1.code, country: 'EE' })
    await message('VIBAN_OPEN', { code: SP.code, country: 'EE' })
    assert.deepEqual(sent.map((r) => JSON.parse(r.body.toString()).regCode), [C1.code, SP.code])
    // The provider's whole history, or only its own with serviceProvider=true; the customer sees its own.
    assert.equal((await history('', spOwn)).length, 2)
    assert.deepEqual((await history('?serviceProvider=true', spOwn)).map((x) => x.message.regCode), [SP.code])
    assert.equal((await history('', { as: SP.code, headers: { 'Client-Code': C1.code, 'Client-Country': 'EE' } })).length, 1)
    assert.equal((await history('', { as: C2.code })).length, 0)
  })
})

describe('retries', () => {
  test('non-2xx: RETRY_PENDING with the same eventId and bytes for 24 h, then FAILED', async () => {
    await sub('VIBAN_OPEN')
    answers = Array(50).fill(503)
    await message('VIBAN_OPEN')
    const first = sent[0]
    let h = await history()
    assert.equal(h[0].status, 'RETRY_PENDING')
    assert.equal(h[0].retriesAttempted, 0)
    assert.equal(h[0].httpStatus, 503)
    assert.equal(h[0].responseContentLength, 2)
    assert.equal(typeof h[0].latencyMs, 'number')
    const start = ctx.clock.now().getTime()
    const times: number[] = [0]
    for (let i = 0; i < 40 && h[0].status === 'RETRY_PENDING'; i++) {
      const due = hooks().events()[0].nextAt!
      ctx.clock.advance(due - ctx.clock.now().getTime() - 1)
      assert.equal(await hooks().tick(), 0) // not a millisecond early
      ctx.clock.advance(1)
      assert.equal(await hooks().tick(), 1)
      times.push(ctx.clock.now().getTime() - start)
      h = await history()
    }
    assert.equal(h[0].status, 'FAILED')
    // Delays 1, 5, 15, 30 min, 1, 2 h, then 4 h, while inside the 24 h window.
    const expect = [0]
    for (let i = 0; ; i++) {
      const next = expect[expect.length - 1] + RETRY_DELAYS_MS[Math.min(i, RETRY_DELAYS_MS.length - 1)]
      if (next > RETRY_WINDOW_MS) break
      expect.push(next)
    }
    assert.deepEqual(times.slice(0, expect.length), expect.slice(0, times.length))
    assert.equal(sent.length, expect.length)
    assert.equal(h[0].retriesAttempted, expect.length - 1)
    assert.ok(sent.every((r) => r.body.equals(first.body) && r.headers['x-lhv-hmac'] === first.headers['x-lhv-hmac']))
  })

  test('success on a retry: SUCCESS, retriesAttempted counts the retries; a transport error has no httpStatus', async () => {
    await sub('VIBAN_OPEN')
    answers = [new Error('connect ECONNREFUSED'), 500, 204]
    await message('VIBAN_OPEN')
    let h = await history()
    assert.ok(!('httpStatus' in h[0]))
    ctx.clock.advance(RETRY_DELAYS_MS[0]); await hooks().tick()
    ctx.clock.advance(RETRY_DELAYS_MS[1]); await hooks().tick()
    h = await history()
    assert.equal(h[0].status, 'SUCCESS')
    assert.equal(h[0].retriesAttempted, 2)
    assert.equal(h[0].httpStatus, 204)
    ctx.clock.advance(DAY_MS); assert.equal(await hooks().tick(), 0)
  })

  test('a retry goes to the edited URL, signed with the rotated secret', async () => {
    const c = await sub('VIBAN_OPEN')
    answers = [500]
    await message('VIBAN_OPEN')
    const res = await call(ctx, { method: 'PUT', url: `/notifications/subscription/${c.subscriptionReference}`, body: { requestUrl: 'https://new.example.org/h' } })
    const secret = JSON.parse(res.body).sharedSecret
    ctx.clock.advance(RETRY_DELAYS_MS[0]); await hooks().tick()
    assert.equal(sent[1].url, 'https://new.example.org/h')
    assert.equal(sent[1].headers['x-lhv-hmac'], hmacHex(secret, sent[1].body))
    assert.ok(sent[1].body.equals(sent[0].body))
  })

  test('deleting or deactivating the configuration stops its retries: FAILED', async () => {
    const a = await sub('VIBAN_OPEN')
    const b = await sub('VIBAN_CLOSE')
    answers = [500, 500]
    await message('VIBAN_OPEN')
    await message('VIBAN_CLOSE')
    await call(ctx, { method: 'DELETE', url: `/notifications/subscription/${a.subscriptionReference}` })
    await call(ctx, { method: 'PUT', url: `/notifications/subscription/${b.subscriptionReference}`, body: { active: false } })
    ctx.clock.advance(RETRY_DELAYS_MS[0])
    assert.equal(await hooks().tick(), 0)
    assert.deepEqual((await history()).map((x) => x.status), ['FAILED', 'FAILED'])
  })
})

describe('history', () => {
  test('newest first; eventId, status, responseType, dates, offset and limit', async () => {
    await sub('VIBAN_OPEN')
    await sub('PAYMENT')
    await message('VIBAN_OPEN')
    ctx.clock.advance(DAY_MS)
    answers = [500, 500, 200] // PAYMENT, its retry (due when the next message comes), the last VIBAN_OPEN
    await message('PAYMENT')
    ctx.clock.advance(DAY_MS / 2)
    await message('VIBAN_OPEN')
    const all = await history()
    assert.equal(all.length, 3)
    assert.deepEqual(all.map((x) => x.message.messageType), ['VIBAN_OPEN', 'PAYMENT', 'VIBAN_OPEN'])
    assert.deepEqual(all.map((x) => x.status), ['SUCCESS', 'RETRY_PENDING', 'SUCCESS'])
    const id = all[1].message.eventId
    assert.deepEqual((await history(`?eventId=${id}`)).map((x) => x.message.eventId), [id])
    assert.equal((await history('?status=RETRY_PENDING')).length, 1)
    assert.equal((await history('?status=SUCCESS')).length, 2)
    assert.equal((await history('?responseType=PAYMENT')).length, 1)
    assert.equal(all[1].retriesAttempted, 1)
    assert.equal((await history('?startDate=2026-03-11')).length, 2)
    assert.equal((await history('?endDate=2026-03-10')).length, 1)
    assert.equal((await history('?startDate=2026-03-11&endDate=2026-03-11')).length, 2)
    assert.equal((await history('?startDate=2026-03-12')).length, 0)
    assert.deepEqual((await history('?offset=1&limit=1')).map((x) => x.message.eventId), [id])
    assert.equal((await history('?offset=5')).length, 0)
    for (const q of ['?limit=0', '?limit=x', '?offset=-1', '?status=DONE', '?startDate=2026-02-30', '?endDate=11.03.2026', '?serviceProvider=yes']) {
      const res = await call(ctx, { url: `/notifications/history${q}` })
      assert.equal(res.statusCode, 400, q)
      assert.equal(JSON.parse(res.body).errors[0].errorCode, 'BAD_REQUEST')
    }
  })
})

describe('replay', () => {
  test('a delivered event: a new eventId to the configuration as it is now', async () => {
    await sub('VIBAN_OPEN')
    await message('VIBAN_OPEN')
    const [orig] = await history()
    const r = await replay([orig.message.eventId])
    assert.equal(r.status, 200)
    assert.deepEqual(r.body, { dispatched: [{ eventId: orig.message.eventId }], failed: [] })
    await hooks().idle()
    assert.equal(sent.length, 2)
    const p = delivered(1)
    assert.notEqual(p.eventId, orig.message.eventId)
    assert.equal(p.messageResponseId, orig.message.messageResponseId)
    const h = await history()
    assert.equal(h.length, 2)
    assert.equal(h[0].message.eventId, p.eventId)
    assert.equal(h[1].status, 'SUCCESS')
  })

  test('RETRY_PENDING: the scheduled retry is cancelled (FAILED), the replay delivered', async () => {
    await sub('VIBAN_OPEN')
    answers = [500]
    await message('VIBAN_OPEN')
    const [orig] = await history()
    assert.equal((await replay([orig.message.eventId])).status, 200)
    await hooks().idle()
    ctx.clock.advance(DAY_MS)
    assert.equal(await hooks().tick(), 0)
    const h = await history()
    assert.deepEqual(h.map((x) => x.status), ['SUCCESS', 'FAILED'])
    assert.equal(sent.length, 2)
  })

  test('refusals: a success older than 120 h, a deleted or inactive configuration, another customer; mixed is 200', async () => {
    const c = await sub('VIBAN_OPEN')
    const d = await sub('PAYMENT')
    await message('VIBAN_OPEN')
    await message('PAYMENT')
    const [pay, open] = (await history()).map((x) => x.message.eventId)
    await call(ctx, { method: 'DELETE', url: `/notifications/subscription/${d.subscriptionReference}` })
    let r = await replay([pay])
    assert.equal(r.status, 400)
    assert.equal(r.body.failed[0].error, `Cannot replay webhook. No valid and active webhook configuration found for webhook response with eventId: ${pay}`)
    // Another customer does not see it.
    r = await replay([open], { as: C2.code })
    assert.match(r.body.failed[0].error, /WebhookResponse not found for contract 12340002/)
    // Mixed: 200, both lists.
    r = await replay([open, pay, 'not-an-id', open])
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.dispatched, [{ eventId: open }])
    assert.deepEqual(r.body.failed.map((f: any) => f.eventId), [pay, 'not-an-id'])
    await hooks().idle()
    ctx.clock.advance(5 * DAY_MS + 1)
    r = await replay([open])
    assert.equal(r.status, 400)
    assert.match(r.body.failed[0].error, /older than 120 hours/)
    await call(ctx, { method: 'PUT', url: `/notifications/subscription/${c.subscriptionReference}`, body: { active: false } })
    const fresh = (await history())[0].message.eventId
    r = await replay([fresh])
    assert.match(r.body.failed[0].error, /No valid and active webhook configuration/)
  })

  test('invalid bodies: 400 in the JSON envelope', async () => {
    for (const body of [{}, { eventIds: 'x' }, { eventIds: [1] }, { eventIds: [] }, { eventIds: Array(101).fill('a') }]) {
      const res = await call(ctx, { method: 'POST', url: '/notifications/replay', body })
      assert.equal(res.statusCode, 400, JSON.stringify(body).slice(0, 40))
      assert.equal(JSON.parse(res.body).errors[0].errorCode, 'BAD_REQUEST')
    }
  })
})

describe('/_sim/webhooks/uk', () => {
  test('configurations with secrets, events with attempts, tick', async () => {
    const c = await sub('VIBAN_OPEN')
    answers = [500]
    await message('VIBAN_OPEN')
    const subs = JSON.parse((await call(ctx, { url: '/_sim/webhooks/uk/subscriptions' })).body).subscriptions
    assert.equal(subs[0].sharedSecret, c.sharedSecret)
    let ev = JSON.parse((await call(ctx, { url: '/_sim/webhooks/uk/events' })).body).events
    assert.equal(ev[0].status, 'RETRY_PENDING')
    assert.equal(ev[0].attempts[0].status, 500)
    assert.equal(ev[0].attempts[0].hmac, sent[0].headers['x-lhv-hmac'])
    jsonValid('webhook-uk-payload', ev[0].payload)
    ctx.clock.advance(RETRY_DELAYS_MS[0])
    assert.deepEqual(JSON.parse((await call(ctx, { method: 'POST', url: '/_sim/webhooks/uk/tick' })).body), { attempted: 1 })
    ev = JSON.parse((await call(ctx, { url: '/_sim/webhooks/uk/events' })).body).events
    assert.equal(ev[0].status, 'SUCCESS')
  })
})
