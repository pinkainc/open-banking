// L5a EE webhook smoke tests: subscription CRUD (P 15 status codes), delivery of a new
// inbox message with the documented payload, and the retry schedule on the emulator
// clock. Deliveries go to a recording fake instead of the network.
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { RETRY_DELAYS_MS } from '../src/webhooks/ee.js'
import { C1, SP, call, jsonValid, setup, type Ctx } from './helpers.js'

let ctx: Ctx
let sent: { url: string; body: any }[]
let answer: number
beforeEach(async () => {
  sent = []
  answer = 200
  ctx = await setup({ webhookDeliver: async (url, body) => { sent.push({ url, body: JSON.parse(body) }); return answer } })
})

async function subscribe(url = 'https://hooks.example.com/lhv', as = C1.code, headers: Record<string, string> = {}) {
  const body = jsonValid('webhook-ee-subscription.request', { url, eventType: 'GENERAL_WEBHOOK' })
  const res = await call(ctx, { method: 'POST', url: '/notifications/subscribe', body, as, headers })
  assert.equal(res.statusCode, 200, res.body)
  return jsonValid('webhook-ee-subscribe.response', res.body).subscriptionReference as string
}

describe('EE webhooks', () => {
  test('subscribe, list, update (204), delete (200), list again (204)', async () => {
    assert.equal((await call(ctx, { url: '/notifications/subscriptions' })).statusCode, 204)
    const ref = await subscribe()
    const list = await call(ctx, { url: '/notifications/subscriptions' })
    assert.equal(list.statusCode, 200)
    assert.deepEqual(jsonValid('webhook-ee-list.response', list.body).subscriptions, [{ url: 'https://hooks.example.com/lhv', subscriptionReference: ref, eventType: 'GENERAL_WEBHOOK' }])
    const put = await call(ctx, { method: 'PUT', url: `/notifications/subscriptions/${ref}`, body: { url: 'https://hooks.example.com/v2', eventType: 'GENERAL_WEBHOOK' } })
    assert.equal(put.statusCode, 204)
    assert.equal(put.body, '')
    const del = await call(ctx, { method: 'DELETE', url: `/notifications/subscriptions/${ref}` })
    assert.equal(del.statusCode, 200)
    assert.equal(del.body, '')
    assert.equal((await call(ctx, { url: '/notifications/subscriptions' })).statusCode, 204)
  })

  test('a new message is announced with the P 15 payload; a service provider subscribes for its customer', async () => {
    const ref = await subscribe('https://sp.example.com/hook', SP.code, { 'Client-Code': C1.code, 'Client-Country': 'EE' })
    const hb = await call(ctx, { url: '/heartbeat/mq' })
    assert.equal(hb.statusCode, 202)
    await ctx.emulator.webhooksEe.idle()
    assert.equal(sent.length, 1)
    const p = jsonValid('webhook-ee-payload', sent[0].body)
    assert.equal(sent[0].url, 'https://sp.example.com/hook')
    assert.equal(p.subscriptionReference, ref)
    assert.equal(p.messageType, 'HEARTBEAT')
    assert.equal(p.messageRequestId, hb.headers['message-request-id'])
    assert.equal(p.regCode, C1.code)
    assert.equal(p.regCodeIssuer, 'EE')
    assert.equal(p.bankCode, 'LHVEE')
    assert.equal(p.eventTimestamp, '2026-03-10T08:00:00.000+00:00')
  })

  test('failed deliveries are retried on the clock, then FAILED', async () => {
    await subscribe()
    answer = 500
    await call(ctx, { url: '/heartbeat/mq' })
    await ctx.emulator.webhooksEe.idle()
    for (const delay of RETRY_DELAYS_MS) {
      ctx.clock.advance(delay - 1)
      assert.equal(JSON.parse((await call(ctx, { method: 'POST', url: '/_sim/webhooks/ee/tick' })).body).attempted, 0)
      ctx.clock.advance(1)
      assert.equal(JSON.parse((await call(ctx, { method: 'POST', url: '/_sim/webhooks/ee/tick' })).body).attempted, 1)
    }
    assert.equal(sent.length, RETRY_DELAYS_MS.length + 1)
    assert.equal(new Set(sent.map((s) => s.body.eventId)).size, 1)
    const log = JSON.parse((await call(ctx, { url: '/_sim/webhooks/ee/deliveries' })).body).deliveries
    assert.equal(log[0].state, 'FAILED')
  })
})
