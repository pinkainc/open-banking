// Bounded memory (decision 504): tombstones, MsgIds and idempotency keys are forgotten
// after their window or beyond a count, oldest first.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, test } from 'node:test'
import { BoundedMap, BoundedSet, DEFAULT_BOUNDS } from '../src/bounded.js'
import { DAY_MS, ManualClock } from '../src/clock.js'
import { C1, call, drain, pain001, report, reportError, setup } from './helpers.js'

describe('BoundedMap', () => {
  test('an entry lives exactly its TTL', () => {
    const clock = new ManualClock()
    const m = new BoundedMap<string, number>(clock, { ttlMs: 1000, max: 10 })
    m.set('a', 1)
    clock.advance(999)
    assert.equal(m.get('a'), 1)
    clock.advance(1)
    assert.equal(m.get('a'), undefined)
    assert.equal(m.size, 0, 'an expired read frees the entry')
  })

  test('beyond max the oldest goes first; setting again makes a key the newest', () => {
    const m = new BoundedMap<string, number>(new ManualClock(), { max: 2 })
    m.set('a', 1).set('b', 2).set('a', 3).set('c', 4)
    assert.deepEqual([m.has('a'), m.has('b'), m.has('c'), m.size], [true, false, true, 2])
    assert.equal(m.get('a'), 3)
  })

  test('writes drop expired entries at the front; purge drops them all', () => {
    const clock = new ManualClock()
    const m = new BoundedMap<string, number>(clock, { ttlMs: 1000, max: 100 })
    for (let i = 0; i < 50; i++) m.set(`k${i}`, i)
    clock.advance(1000)
    m.set('fresh', 1)
    assert.equal(m.size, 1)
    for (let i = 0; i < 5; i++) m.set(`x${i}`, i)
    clock.advance(1000)
    assert.equal(m.purge(), 6)
    assert.equal(m.size, 0)
  })

  test('max must be at least 1; defaults follow the documented windows', () => {
    assert.throws(() => new BoundedSet(new ManualClock(), { max: 0 }))
    assert.deepEqual(DEFAULT_BOUNDS, {
      tombstones: { ttlMs: 5 * DAY_MS, max: 100_000 }, msgIds: { max: 200_000 }, idempotencyKeys: { ttlMs: DAY_MS, max: 100_000 },
      processed: { ttlMs: 7 * DAY_MS, max: 10_000 }, requests: { ttlMs: 5 * DAY_MS, max: 10_000 },
    })
  })
})

describe('inbox tombstones', () => {
  const confirmed = async (n: number, opts = {}) => {
    const ctx = await setup(opts)
    const ids: string[] = []
    for (let i = 0; i < n; i++) ids.push((await ctx.emulator.inbox.add({ customer: C1, type: 'HEARTBEAT', body: '<x/>' })).id)
    for (const id of ids) assert.equal((await call(ctx, { method: 'DELETE', url: `/messages/${id}` })).statusCode, 200)
    return { ctx, ids }
  }

  test('a repeat DELETE is 200 while the message is kept as processed (a week from creation, decision 621), then 404', async () => {
    const { ctx, ids } = await confirmed(1)
    ctx.clock.advance(7 * DAY_MS - 1)
    assert.equal((await call(ctx, { method: 'DELETE', url: `/messages/${ids[0]}` })).statusCode, 200)
    ctx.clock.advance(1)
    assert.equal((await call(ctx, { method: 'DELETE', url: `/messages/${ids[0]}` })).statusCode, 404)
  })

  test('confirmed late, the tombstone answers 200 for five days after the confirmation', async () => {
    const ctx = await setup()
    const id = (await ctx.emulator.inbox.add({ customer: C1, type: 'HEARTBEAT', body: '<x/>' })).id
    ctx.clock.advance(4 * DAY_MS)
    assert.equal((await call(ctx, { method: 'DELETE', url: `/messages/${id}` })).statusCode, 200)
    ctx.clock.advance(5 * DAY_MS - 1)
    assert.equal((await call(ctx, { method: 'DELETE', url: `/messages/${id}` })).statusCode, 200)
    ctx.clock.advance(1)
    assert.equal((await call(ctx, { method: 'DELETE', url: `/messages/${id}` })).statusCode, 404)
  })

  test('purge drops expired tombstones and archived processed messages too', async () => {
    const { ctx } = await confirmed(3)
    assert.equal(await ctx.emulator.inbox.tombstones(), 3)
    assert.equal(await ctx.emulator.inbox.processedKept(), 3)
    ctx.clock.advance(5 * DAY_MS)
    await ctx.emulator.inbox.purge()
    assert.equal(await ctx.emulator.inbox.tombstones(), 0)
    assert.equal(await ctx.emulator.inbox.processedKept(), 3)
    ctx.clock.advance(2 * DAY_MS)
    await ctx.emulator.inbox.purge()
    assert.equal(await ctx.emulator.inbox.processedKept(), 0)
  })

  test('beyond the cap the oldest tombstone is forgotten', async () => {
    const { ctx, ids } = await confirmed(3, { memory: { tombstones: { max: 2 }, processed: { max: 2 } } })
    assert.equal(await ctx.emulator.inbox.tombstones(), 2)
    assert.equal(await ctx.emulator.inbox.processedKept(), 2)
    assert.equal((await call(ctx, { method: 'DELETE', url: `/messages/${ids[0]}` })).statusCode, 404)
    assert.equal((await call(ctx, { method: 'DELETE', url: `/messages/${ids[2]}` })).statusCode, 200)
  })
})

describe('remembered MsgIds', () => {
  const duplicate = async (ctx: Awaited<ReturnType<typeof setup>>, msgId: string) => {
    const r = await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '1.00' }] }], { msgId }) })
    assert.equal(r.statusCode, 202)
    return (await drain(ctx)).some((m) => m.body.includes('Duplicate message.'))
  }

  test('pain.001: kept without a time limit, forgotten only beyond the cap', async () => {
    const ctx = await setup({ memory: { msgIds: { max: 2 } } })
    assert.equal(await duplicate(ctx, 'M-1'), false)
    ctx.clock.advance(400 * DAY_MS)
    assert.equal(await duplicate(ctx, 'M-1'), true, 'still known after 400 days')
    assert.equal(await duplicate(ctx, 'M-2'), false)
    assert.equal(await duplicate(ctx, 'M-3'), false)
    assert.equal(await duplicate(ctx, 'M-1'), false, 'evicted by M-2 and M-3')
  })

  test('camt.060: the same cap', async () => {
    const ctx = await setup({ memory: { msgIds: { max: 1 } } })
    const dup = async (msgId: string) => reportError((await report(ctx, { msgId, kind: 'balance' })).msgs[0])?.code === 'errStatement_DuplicateRequest'
    assert.equal(await dup('S-1'), false)
    assert.equal(await dup('S-1'), true)
    assert.equal(await dup('S-2'), false)
    assert.equal(await dup('S-1'), false)
  })
})

describe('remembered idempotency keys (UK host)', () => {
  test('beyond the cap the oldest key is forgotten', async () => {
    const ctx = await setup({}, undefined, { flavour: 'UK', idempotencyKeys: { max: 2 } })
    const post = async (key: string) => (await call(ctx, { url: '/heartbeat', method: 'POST', body: 'x', headers: { 'x-bank-code': 'LHVEE', 'X-Idempotency-Key': key } })).statusCode
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()]
    assert.deepEqual([await post(a), await post(b), await post(a)], [202, 202, 409])
    assert.equal(await post(c), 202)
    assert.equal(await post(b), 409)
    assert.equal(await post(a), 202, 'evicted')
  })
})
