// Webhooks in Postgres (decisions 985, 986): UK configurations with their secrets and EE
// subscriptions survive a restart of the emulator on the same namespace; a UK delivery
// whose retry was scheduled before the restart is retried after it on schedule, once, with
// the same eventId and bytes, even with two emulators ticking at once; history and replay
// work after it; an EE delivery is retried after the restart once, and a new message gets
// the next eventId, not 1 again. Registered only when DATABASE_URL is set.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { EmulatorOptions } from '../src/emulator.js'
import { RETRY_DELAYS_MS, type UkRequest } from '../src/webhooks/uk.js'
import { C1, call, postgresStore, setup, type Ctx } from './helpers.js'

const url = process.env.DATABASE_URL
const UK = { flavour: 'UK' as const }

/** A UK emulator on the namespace whose deliveries are recorded and answered from `answers` (default 200). */
async function ukEmulator(opts: EmulatorOptions, sent: UkRequest[], answers: number[] = []) {
  return setup({ ...opts, ukWebhookDeliver: async (r) => { sent.push(r); return { status: answers.shift() ?? 200, contentLength: 2 } } }, undefined, UK)
}
const message = async (ctx: Ctx, type = 'VIBAN_OPEN') => {
  const m = await ctx.emulator.inbox.add({ customer: { code: C1.code, country: C1.country }, type, body: '<VibanOpenResponse/>' })
  await ctx.emulator.webhooksUk.idle()
  await ctx.emulator.webhooksEe.idle()
  return m
}
const json = async (ctx: Ctx, path: string) => (await call(ctx, { url: path })).json()

if (url) describe('Webhooks across a restart (Postgres)', () => {
  test('UK: configuration and secret survive; a scheduled retry runs after the restart once; history and replay', async () => {
    const opts = await postgresStore()
    const sentA: UkRequest[] = []
    const a = await ukEmulator(opts, sentA, [500])
    const created = await call(a, { method: 'POST', url: '/notifications/subscription', body: { messageType: 'VIBAN_OPEN', requestUrl: 'https://hooks.example.org/lhv', active: true } })
    assert.equal(created.statusCode, 200, created.body)
    const config = created.json()
    await message(a)
    assert.equal(sentA.length, 1)
    const [before] = (await json(a, '/_sim/webhooks/uk/events')).events
    assert.equal(before.status, 'RETRY_PENDING')
    const due = Date.parse(before.nextAt)
    assert.equal(due, Date.parse('2026-03-10T08:00:00Z') + RETRY_DELAYS_MS[0])

    // Restarted twice over: two emulators on the namespace, each ticking.
    const sentB: UkRequest[] = []
    const sentC: UkRequest[] = []
    const [b, c] = [await ukEmulator(opts, sentB), await ukEmulator(opts, sentC)]
    const subs = (await json(b, '/_sim/webhooks/uk/subscriptions')).subscriptions
    assert.deepEqual(subs.map((s: any) => [s.subscriptionReference, s.sharedSecret]), [[config.subscriptionReference, config.sharedSecret]])
    const got = await call(b, { url: `/notifications/subscription/${config.subscriptionReference}` })
    assert.equal(got.statusCode, 200)
    assert.equal((await call(b, { method: 'POST', url: '/notifications/subscription', body: { messageType: 'VIBAN_OPEN', requestUrl: 'https://x.example.org', active: true } })).statusCode, 400, 'still one per type')

    b.clock.set(new Date(due - 1)); c.clock.set(new Date(due - 1))
    assert.deepEqual(await Promise.all([b.emulator.webhooksUk.tick(), c.emulator.webhooksUk.tick()]), [0, 0], 'not a millisecond early')
    b.clock.set(new Date(due)); c.clock.set(new Date(due))
    const ran = await Promise.all([b.emulator.webhooksUk.tick(), c.emulator.webhooksUk.tick()])
    assert.equal(ran[0] + ran[1], 1, 'retried once')
    const retried = [...sentB, ...sentC]
    assert.equal(retried.length, 1)
    assert.deepEqual(retried[0].body, sentA[0].body, 'the same bytes, the same eventId')
    assert.equal(retried[0].headers['x-lhv-hmac'], sentA[0].headers['x-lhv-hmac'])
    assert.equal((await Promise.all([b.emulator.webhooksUk.tick(), c.emulator.webhooksUk.tick()])).join(), '0,0', 'delivered: nothing more')

    const history = (await call(b, { url: '/notifications/history' })).json()
    assert.equal(history.length, 1)
    assert.equal(history[0].status, 'SUCCESS')
    assert.equal(history[0].retriesAttempted, 1)
    assert.equal(history[0].message.eventId, before.eventId)

    const replay = await call(c, { method: 'POST', url: '/notifications/replay', body: { eventIds: [before.eventId] } })
    assert.equal(replay.statusCode, 200, replay.body)
    await c.emulator.webhooksUk.idle()
    assert.equal(sentC.length + sentB.length, 2, 'the replay sent')
    const d = await ukEmulator(opts, [])
    const events = (await json(d, '/_sim/webhooks/uk/events')).events
    assert.deepEqual(events.map((e: any) => [e.status, e.replayOf ?? null]), [['SUCCESS', before.eventId], ['SUCCESS', null]])
  })

  test('UK: a configuration removed after a restart stops the retries scheduled before it', async () => {
    const opts = await postgresStore()
    const sent: UkRequest[] = []
    const a = await ukEmulator(opts, sent, [500])
    const ref = (await call(a, { method: 'POST', url: '/notifications/subscription', body: { messageType: 'VIBAN_OPEN', requestUrl: 'https://hooks.example.org/lhv', active: true } })).json().subscriptionReference
    await message(a)
    const b = await ukEmulator(opts, sent)
    assert.equal((await call(b, { method: 'DELETE', url: `/notifications/subscription/${ref}` })).statusCode, 200)
    b.clock.advance(RETRY_DELAYS_MS[0])
    assert.equal(await b.emulator.webhooksUk.tick(), 0)
    assert.equal(sent.length, 1)
    const [e] = (await json(b, '/_sim/webhooks/uk/events')).events
    assert.deepEqual([e.status, e.reason], ['FAILED', 'Webhook configuration was deleted'])
  })

  test('EE: the subscription survives; a failed delivery is retried after the restart once; eventIds go on', async () => {
    const opts = await postgresStore()
    const sentA: string[] = []
    const a = await setup({ ...opts, webhookDeliver: async (_u, body) => { sentA.push(body); return 503 } })
    const sub = await call(a, { method: 'POST', url: '/notifications/subscribe', body: { url: 'https://hooks.example.org/ee', eventType: 'GENERAL_WEBHOOK' } })
    assert.equal(sub.statusCode, 200, sub.body)
    await message(a)
    assert.equal(sentA.length, 1)

    const sent: string[] = []
    const deliver = async (_u: string, body: string) => { sent.push(body); return 200 }
    const [b, c] = [await setup({ ...opts, webhookDeliver: deliver }), await setup({ ...opts, webhookDeliver: deliver })]
    const listed = await call(b, { url: '/notifications/subscriptions' })
    assert.deepEqual(listed.json().subscriptions.map((s: any) => s.subscriptionReference), [sub.json().subscriptionReference])
    b.clock.advance(RETRY_DELAYS_MS[0]); c.clock.advance(RETRY_DELAYS_MS[0])
    const ran = await Promise.all([b.emulator.webhooksEe.tick(), c.emulator.webhooksEe.tick()])
    assert.equal(ran[0] + ran[1], 1)
    assert.deepEqual(sent, sentA, 'retried once, the same payload')

    await message(b)
    const deliveries = (await json(c, '/_sim/webhooks/ee/deliveries')).deliveries
    assert.deepEqual(deliveries.map((d: any) => [d.eventId, d.state, d.attempts.length]), [[1, 'DELIVERED', 2], [2, 'DELIVERED', 1]])
  })
})
