// L5a EE webhooks (P 15), subscription side and the retry schedule with a recording fake
// transport: CRUD with the documented status codes, the published samples, validation
// errors in the JSON envelope, another customer's reference, one subscription per URL,
// service providers subscribing for customers. Deliveries over real HTTP are in
// webhooks-ee-http.test.ts. Every JSON body is checked against the ssot schemas.
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { RETRY_DELAYS_MS } from '../src/webhooks/ee.js'
import { C1, C2, SP, call, docJson, jsonInvalid, jsonValid, setup, type Ctx } from './helpers.js'

let ctx: Ctx
let sent: { url: string; body: any }[]
let answer: number
beforeEach(async () => {
  sent = []
  answer = 200
  ctx = await setup({ webhookDeliver: async (url, body) => { sent.push({ url, body: jsonValid('webhook-ee-payload', body) }); return answer } })
})

type Who = { as?: string; headers?: Record<string, string> }
const forC1: Who = { as: SP.code, headers: { 'Client-Code': C1.code, 'Client-Country': 'EE' } }

async function subscribe(url = 'https://hooks.example.com/lhv', who: Who = {}) {
  const body = jsonValid('webhook-ee-subscription.request', { url, eventType: 'GENERAL_WEBHOOK' })
  const res = await call(ctx, { method: 'POST', url: '/notifications/subscribe', body, ...who })
  assert.equal(res.statusCode, 200, res.body)
  return jsonValid('webhook-ee-subscribe.response', res.body).subscriptionReference as string
}

async function subscriptions(who: Who = {}) {
  const res = await call(ctx, { url: '/notifications/subscriptions', ...who })
  if (res.statusCode === 204) { assert.equal(res.body, ''); return [] }
  assert.equal(res.statusCode, 200, res.body)
  return jsonValid('webhook-ee-list.response', res.body).subscriptions as any[]
}

/** A JSON error envelope with one error. */
function jsonErr(res: { statusCode: number; body: string }, status: number, code: string, description: string) {
  assert.equal(res.statusCode, status, res.body)
  assert.deepEqual(jsonValid('error-json', res.body).errors.map((e: any) => [e.errorCode, e.description]), [[code, description]])
}

const tick = async () => JSON.parse((await call(ctx, { method: 'POST', url: '/_sim/webhooks/ee/tick' })).body).attempted as number

describe('EE webhooks: the P 15 samples', () => {
  test('the published request, response, list and payload samples are schema-valid; our answers have their fields in order', async () => {
    const [subReq, subRes, putReq, listRes, payload] = docJson('15-webhooks.md').filter((b) => b.json).map((b) => b.json)
    jsonValid('webhook-ee-subscription.request', subReq)
    jsonValid('webhook-ee-subscribe.response', subRes)
    jsonValid('webhook-ee-subscription.request', putReq)
    jsonValid('webhook-ee-list.response', listRes)
    jsonValid('webhook-ee-payload', payload)
    const ref = await subscribe(subReq.url)
    const list = await subscriptions()
    assert.deepEqual(Object.keys(list[0]), Object.keys(listRes.subscriptions[0]))
    assert.deepEqual(list, [{ url: subReq.url, subscriptionReference: ref, eventType: 'GENERAL_WEBHOOK' }])
    await call(ctx, { url: '/heartbeat/mq' })
    await ctx.emulator.webhooksEe.idle()
    assert.equal(sent.length, 1)
    assert.deepEqual(Object.keys(sent[0].body), Object.keys(payload), 'the sample\'s fields, in order (a message with a request id)')
  })
})

describe('EE webhooks: subscriptions', () => {
  test('subscribe 200, list 200, update 204 (no body), delete 200 (no body), list 204', async () => {
    assert.deepEqual(await subscriptions(), [])
    const ref = await subscribe()
    assert.deepEqual(await subscriptions(), [{ url: 'https://hooks.example.com/lhv', subscriptionReference: ref, eventType: 'GENERAL_WEBHOOK' }])
    const body = jsonValid('webhook-ee-subscription.request', { url: 'https://hooks.example.com/v2', eventType: 'GENERAL_WEBHOOK' })
    const put = await call(ctx, { method: 'PUT', url: `/notifications/subscriptions/${ref}`, body })
    assert.equal(put.statusCode, 204)
    assert.equal(put.body, '')
    assert.deepEqual((await subscriptions()).map((s) => [s.url, s.subscriptionReference]), [['https://hooks.example.com/v2', ref]])
    const del = await call(ctx, { method: 'DELETE', url: `/notifications/subscriptions/${ref}` })
    assert.equal(del.statusCode, 200)
    assert.equal(del.body, '')
    assert.deepEqual(await subscriptions(), [])
    jsonErr(await call(ctx, { method: 'DELETE', url: `/notifications/subscriptions/${ref}` }), 404, 'NOT_FOUND', 'Requested resource not found')
  })

  test('one GENERAL_WEBHOOK subscription per URL: the same URL again returns the same reference (decision 420)', async () => {
    const a = await subscribe()
    assert.equal(await subscribe(), a)
    const b = await subscribe('https://hooks.example.com/other')
    assert.notEqual(a, b)
    assert.deepEqual((await subscriptions()).map((s) => s.subscriptionReference), [a, b])
    // A message is announced once per subscription, not per subscribe call.
    await call(ctx, { url: '/heartbeat/mq' })
    await ctx.emulator.webhooksEe.idle()
    assert.deepEqual(sent.map((s) => [s.url, s.body.subscriptionReference]).sort(), [['https://hooks.example.com/lhv', a], ['https://hooks.example.com/other', b]])
    assert.notEqual(sent[0].body.eventId, sent[1].body.eventId)
  })

  test('another customer\'s reference: PUT and DELETE are 404, its subscription is untouched', async () => {
    const ref = await subscribe('https://c2.example.com/hook', { as: C2.code })
    const body = jsonValid('webhook-ee-subscription.request', { url: 'https://evil.example.com/', eventType: 'GENERAL_WEBHOOK' })
    jsonErr(await call(ctx, { method: 'PUT', url: `/notifications/subscriptions/${ref}`, body }), 404, 'NOT_FOUND', 'Requested resource not found')
    jsonErr(await call(ctx, { method: 'DELETE', url: `/notifications/subscriptions/${ref}` }), 404, 'NOT_FOUND', 'Requested resource not found')
    // Also not through a provider acting for C1.
    jsonErr(await call(ctx, { method: 'DELETE', url: `/notifications/subscriptions/${ref}`, ...forC1 }), 404, 'NOT_FOUND', 'Requested resource not found')
    assert.deepEqual(await subscriptions(), [])
    assert.deepEqual((await subscriptions({ as: C2.code })).map((s) => s.url), ['https://c2.example.com/hook'])
    jsonErr(await call(ctx, { method: 'PUT', url: '/notifications/subscriptions/00000000-0000-4000-8000-000000000000', body }), 404, 'NOT_FOUND', 'Requested resource not found')
    // The reference is matched case-insensitively.
    assert.equal((await call(ctx, { method: 'DELETE', url: `/notifications/subscriptions/${ref.toUpperCase()}`, as: C2.code })).statusCode, 200)
  })

  test('validation errors: 400 BAD_REQUEST in the JSON envelope (decision 422), for subscribe and update', async () => {
    const ref = await subscribe()
    const cases: [string | object, string][] = [
      ['{"url": ', ''],
      [[], 'The request body must be a JSON object'],
      [{ eventType: 'GENERAL_WEBHOOK' }, 'url is mandatory'],
      [{ url: '', eventType: 'GENERAL_WEBHOOK' }, 'url is mandatory'],
      [{ url: 'hooks.example.com/x', eventType: 'GENERAL_WEBHOOK' }, 'url must be an absolute http or https URL'],
      [{ url: 'ftp://hooks.example.com/x', eventType: 'GENERAL_WEBHOOK' }, 'url must be an absolute http or https URL'],
      [{ url: 'https://hooks.example.com/x' }, 'eventType is mandatory'],
      [{ url: 'https://hooks.example.com/x', eventType: 'OTHER' }, 'eventType must be GENERAL_WEBHOOK'],
    ]
    for (const [method, url] of [['POST', '/notifications/subscribe'], ['PUT', `/notifications/subscriptions/${ref}`]]) {
      for (const [body, text] of cases) {
        // ftp:// is a URI the schema accepts; the server wants http(s).
        if (typeof body === 'object') (JSON.stringify(body).includes('ftp:') ? jsonValid : jsonInvalid)('webhook-ee-subscription.request', body)
        const res = await call(ctx, { method, url, body, contentType: 'application/json' })
        if (text) jsonErr(res, 400, 'BAD_REQUEST', text)
        else assert.match(jsonValid('error-json', res.body).errors[0].description, /^JSON parse error: /)
      }
    }
    // A bad body on an unknown reference is still a 400: the body is checked first.
    const res = await call(ctx, { method: 'PUT', url: '/notifications/subscriptions/nope', body: { url: 'x' } })
    assert.equal(res.statusCode, 400)
    assert.deepEqual((await subscriptions()).map((s) => s.url), ['https://hooks.example.com/lhv'])
  })

  test('a service provider: Client-Code selects the customer; its own subscriptions are separate', async () => {
    const spOwn: Who = { as: SP.code, headers: { 'Client-Code': SP.code, 'Client-Country': 'EE' } }
    const forC1Ref = await subscribe('https://sp.example.com/c1', forC1)
    const ownRef = await subscribe('https://sp.example.com/own', spOwn)
    assert.deepEqual((await subscriptions(forC1)).map((s) => s.subscriptionReference), [forC1Ref])
    assert.deepEqual((await subscriptions(spOwn)).map((s) => s.subscriptionReference), [ownRef])
    // C1 itself sees the subscription made for it.
    assert.deepEqual((await subscriptions()).map((s) => s.subscriptionReference), [forC1Ref])
    // Without Client-Code a provider is refused.
    assert.equal((await call(ctx, { url: '/notifications/subscriptions', as: SP.code })).statusCode, 403)
    // A provider cannot subscribe for an unconnected customer.
    await call(ctx, { method: 'POST', url: '/_sim/customers', body: { code: '12340003', country: 'EE', name: 'Demo Customer 3', accounts: ['EE427700771001260990'] } })
    const body = jsonValid('webhook-ee-subscription.request', { url: 'https://sp.example.com/c3', eventType: 'GENERAL_WEBHOOK' })
    assert.equal((await call(ctx, { method: 'POST', url: '/notifications/subscribe', body, as: SP.code, headers: { 'Client-Code': '12340003', 'Client-Country': 'EE' } })).statusCode, 403)

    const hb = await call(ctx, { url: '/heartbeat/mq', ...forC1 })
    await ctx.emulator.webhooksEe.idle()
    assert.deepEqual(sent.map((s) => s.url), ['https://sp.example.com/c1'])
    const p = sent[0].body
    assert.deepEqual([p.subscriptionReference, p.messageType, p.messageRequestId, p.regCode, p.regCodeIssuer, p.bankCode], [forC1Ref, 'HEARTBEAT', hb.headers['message-request-id'], C1.code, 'EE', 'LHVEE'])
    assert.equal(p.eventTimestamp, '2026-03-10T08:00:00.000+00:00')
  })
})

describe('EE webhooks: retries on the emulator clock (fake transport)', () => {
  test('1 min, 5 min, 30 min, 2 h after each failure, then FAILED; every attempt the same body', async () => {
    await subscribe()
    answer = 500
    await call(ctx, { url: '/heartbeat/mq' })
    await ctx.emulator.webhooksEe.idle()
    for (const delay of RETRY_DELAYS_MS) {
      ctx.clock.advance(delay - 1)
      assert.equal(await tick(), 0)
      ctx.clock.advance(1)
      assert.equal(await tick(), 1)
    }
    ctx.clock.advance(24 * 3600_000)
    assert.equal(await tick(), 0, 'nothing after the last attempt')
    assert.equal(sent.length, RETRY_DELAYS_MS.length + 1)
    assert.equal(new Set(sent.map((s) => JSON.stringify(s.body))).size, 1)
    const [d] = JSON.parse((await call(ctx, { url: '/_sim/webhooks/ee/deliveries' })).body).deliveries
    assert.equal(d.state, 'FAILED')
    assert.equal(d.nextAt, undefined)
    assert.deepEqual(d.attempts.map((a: any) => a.status), [500, 500, 500, 500, 500])
    assert.deepEqual(d.attempts.map((a: any) => Date.parse(a.at) - Date.parse(d.attempts[0].at)), [0, 60_000, 360_000, 2_160_000, 9_360_000])
  })

  test('a 3xx or 4xx answer is a failure too; 204 is a success', async () => {
    await subscribe()
    for (const [status, state] of [[302, 'PENDING'], [404, 'PENDING'], [204, 'DELIVERED']] as const) {
      answer = status
      await call(ctx, { url: '/heartbeat/mq' })
      await ctx.emulator.webhooksEe.idle()
      const ds = JSON.parse((await call(ctx, { url: '/_sim/webhooks/ee/deliveries' })).body).deliveries
      assert.equal(ds.at(-1).state, state, String(status))
    }
  })

  test('a transport error is a failure and is retried', async () => {
    await subscribe()
    let fail = true
    ctx.emulator.webhooksEe.deliver = async (url, body) => { if (fail) throw new Error('connect ECONNREFUSED'); sent.push({ url, body: JSON.parse(body) }); return 200 }
    await call(ctx, { url: '/heartbeat/mq' })
    await ctx.emulator.webhooksEe.idle()
    fail = false
    ctx.clock.advance(RETRY_DELAYS_MS[0])
    assert.equal(await tick(), 1)
    const [d] = JSON.parse((await call(ctx, { url: '/_sim/webhooks/ee/deliveries' })).body).deliveries
    assert.deepEqual([d.state, d.attempts[0].error, d.attempts[1].status], ['DELIVERED', 'connect ECONNREFUSED', 200])
  })
})
