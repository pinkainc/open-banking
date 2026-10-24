// Message box semantics: oldest first, next until DELETE, list / count / get by id,
// confirmation (single and bulk), Filter-Response-Type, five-day expiry.
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { DAY_MS } from '../src/clock.js'
import { C1, C2, INBOXES, call, setup, type Ctx } from './helpers.js'

let ctx: Ctx

/** Puts a message in C1's inbox (or another customer's), one second apart. */
async function put(type = 'PAYMENT', body = '<x/>', customer = C1) {
  ctx.clock.advance(1000)
  return ctx.emulator.inbox.add({ customer, type, body, requestId: `REQ${'0'.repeat(32)}` })
}
const json = (r: { body: string }) => JSON.parse(r.body)
const del = (id: string, as = C1.code) => call(ctx, { method: 'DELETE', url: `/messages/${id}`, as })
const bulk = (ids: unknown) => call(ctx, { method: 'POST', url: '/messages/delete', body: { messageResponseIds: ids } })
const NOT_FOUND = { errors: [{ errorCode: 'NOT_FOUND', description: 'Requested resource not found' }] }

for (const [store, inbox] of INBOXES) describe(`inbox (${store})`, () => {
  beforeEach(async () => { ctx = await setup(await inbox()) })

  describe('next', () => {
    test('empty inbox is 204 with no body', async () => {
      const r = await call(ctx, { url: '/messages/next' })
      assert.equal(r.statusCode, 204)
      assert.equal(r.body, '')
    })

    test('returns the oldest message, the same one until it is deleted', async () => {
      const a = await put('PAYMENT', '<a/>'), b = await put('HEARTBEAT', '<b/>')
      for (let i = 0; i < 3; i++) {
        const r = await call(ctx, { url: '/messages/next' })
        assert.equal(r.statusCode, 200)
        assert.equal(r.headers['message-response-id'], a.id)
        assert.equal(r.headers['message-response-type'], 'PAYMENT')
        assert.equal(r.headers['message-request-id'], a.requestId)
        assert.equal(r.headers['client-code'], C1.code)
        assert.match(String(r.headers['content-type']), /application\/xml/)
        assert.equal(r.body, '<a/>')
      }
      assert.equal((await del(a.id)).statusCode, 200)
      const r = await call(ctx, { url: '/messages/next' })
      assert.equal(r.headers['message-response-id'], b.id)
    })

    test('messages created in the same instant keep their order', async () => {
      const ids: string[] = []
      for (let i = 0; i < 3; i++) ids.push((await ctx.emulator.inbox.add({ customer: C1, type: 'PAYMENT', body: '<x/>' })).id)
      const got = []
      for (const _ of ids) {
        const r = await call(ctx, { url: '/messages/next' })
        got.push(r.headers['message-response-id'])
        await del(String(r.headers['message-response-id']))
      }
      assert.deepEqual(got, ids)
    })

    test('a message without a request has no Message-Request-Id', async () => {
      await ctx.emulator.inbox.add({ customer: C1, type: 'CREDIT_DEBIT_NOTIFICATION', body: '<n/>' })
      const r = await call(ctx, { url: '/messages/next' })
      assert.equal(r.headers['message-request-id'], undefined)
    })

    test('Filter-Response-Type selects one type (next, list, count)', async () => {
      await put('PAYMENT'); const hb = await put('HEARTBEAT'); await put('PAYMENT')
      const headers = { 'Filter-Response-Type': 'HEARTBEAT' }
      const r = await call(ctx, { url: '/messages/next', headers })
      assert.equal(r.headers['message-response-id'], hb.id)
      assert.deepEqual(json(await call(ctx, { url: '/messages/count', headers })), { count: 1 })
      assert.equal(json(await call(ctx, { url: '/messages', headers })).messages.length, 1)
      assert.equal((await call(ctx, { url: '/messages/next', headers: { 'Filter-Response-Type': 'ACCOUNT_STATEMENT' } })).statusCode, 204)
    })

    test("customers do not see each other's messages", async () => {
      const m = await put('PAYMENT', '<x/>', C2)
      assert.equal((await call(ctx, { url: '/messages/next' })).statusCode, 204)
      assert.equal((await call(ctx, { url: `/messages/${m.id}` })).statusCode, 404)
      assert.equal((await del(m.id)).statusCode, 404)
      assert.equal((await call(ctx, { url: '/messages/next', as: C2.code })).statusCode, 200, 'still there for its owner')
    })
  })

  describe('list, count, get', () => {
    test('empty list is 204, count is 0', async () => {
      assert.equal((await call(ctx, { url: '/messages' })).statusCode, 204)
      assert.deepEqual(json(await call(ctx, { url: '/messages/count' })), { count: 0 })
    })

    test('list shape: oldest first, documented fields, EE local time without offset', async () => {
      ctx.clock.set('2026-03-10T08:00:00.067Z')
      const a = await ctx.emulator.inbox.add({ customer: C1, type: 'PAYMENT', body: '<a/>', requestId: 'REQ1' })
      ctx.clock.advance(1000)
      const b = await ctx.emulator.inbox.add({ customer: C1, type: 'CREDIT_DEBIT_NOTIFICATION', body: '<b/>' })
      const r = await call(ctx, { url: '/messages' })
      assert.equal(r.statusCode, 200)
      assert.match(String(r.headers['content-type']), /application\/json/)
      assert.deepEqual(json(r), { messages: [
        { messageResponseId: a.id, messageRequestId: 'REQ1', messageResponseType: 'PAYMENT', clientCode: C1.code, clientCountry: 'EE', messageCreatedTime: '2026-03-10 10:00:00:067' },
        { messageResponseId: b.id, messageResponseType: 'CREDIT_DEBIT_NOTIFICATION', clientCode: C1.code, clientCountry: 'EE', messageCreatedTime: '2026-03-10 10:00:01:067' },
      ] })
      assert.deepEqual(json(await call(ctx, { url: '/messages/count' })), { count: 2 })
    })

    test('limit: default 10, maximum 100, invalid is 400', async () => {
      for (let i = 0; i < 120; i++) await put()
      assert.equal(json(await call(ctx, { url: '/messages' })).messages.length, 10)
      assert.equal(json(await call(ctx, { url: '/messages?limit=3' })).messages.length, 3)
      assert.equal(json(await call(ctx, { url: '/messages?limit=500' })).messages.length, 100)
      assert.deepEqual(json(await call(ctx, { url: '/messages/count' })), { count: 120 })
      for (const bad of ['0', '-1', 'abc', '1.5']) {
        const r = await call(ctx, { url: `/messages?limit=${bad}` })
        assert.equal(r.statusCode, 400, bad)
        assert.equal(json(r).errors[0].errorCode, 'BAD_REQUEST')
      }
    })

    test('listing does not consume: messages stay until deleted', async () => {
      await put(); await put()
      await call(ctx, { url: '/messages' })
      assert.deepEqual(json(await call(ctx, { url: '/messages/count' })), { count: 2 })
    })

    test('GET by id returns the message with its headers, in any order', async () => {
      await put('PAYMENT', '<a/>'); const b = await put('HEARTBEAT', '<b/>')
      const r = await call(ctx, { url: `/messages/${b.id}` })
      assert.equal(r.statusCode, 200)
      assert.equal(r.body, '<b/>')
      assert.equal(r.headers['message-response-id'], b.id)
      assert.equal(r.headers['message-response-type'], 'HEARTBEAT')
    })

    test('GET of an unknown id is 404 with the JSON error', async () => {
      const r = await call(ctx, { url: '/messages/RES00000000000000000000000000000000' })
      assert.equal(r.statusCode, 404)
      assert.match(String(r.headers['content-type']), /application\/json/)
      assert.deepEqual(json(r), NOT_FOUND)
    })
  })

  describe('delete', () => {
    test('DELETE is 200, and 200 again for an already deleted message', async () => {
      const m = await put()
      assert.equal((await del(m.id)).statusCode, 200)
      assert.equal((await del(m.id)).statusCode, 200)
      assert.equal((await call(ctx, { url: `/messages/${m.id}` })).statusCode, 404)
    })

    test('DELETE of an id that never existed is 404', async () => {
      const r = await del('RES00000000000000000000000000000000')
      assert.equal(r.statusCode, 404)
      assert.deepEqual(json(r), NOT_FOUND)
    })

    test('bulk: all deleted is 200 with a status per id', async () => {
      const ids = [(await put()).id, (await put()).id, (await put()).id]
      const r = await bulk(ids)
      assert.equal(r.statusCode, 200)
      assert.deepEqual(json(r), { messages: ids.map((id) => ({ messageResponseId: id, status: 200 })) })
      assert.deepEqual(json(await call(ctx, { url: '/messages/count' })), { count: 0 })
    })

    test('bulk: already deleted ids count as deleted', async () => {
      const a = await put()
      await del(a.id)
      assert.equal((await bulk([a.id])).statusCode, 200)
    })

    test('bulk: some unknown is 207, all unknown is 400', async () => {
      const a = (await put()).id
      const partial = await bulk([a, 'RESnope'])
      assert.equal(partial.statusCode, 207)
      assert.deepEqual(json(partial).messages, [{ messageResponseId: a, status: 200 }, { messageResponseId: 'RESnope', status: 400 }])
      const none = await bulk(['RESnope', 'RESnope2'])
      assert.equal(none.statusCode, 400)
      assert.deepEqual(json(none).messages.map((m: any) => m.status), [400, 400])
    })

    test('bulk: at most 100 ids; malformed bodies are 400', async () => {
      const ids: string[] = []
      for (let i = 0; i < 100; i++) ids.push((await put()).id)
      assert.equal((await bulk([...ids, 'RESextra'])).statusCode, 400)
      assert.deepEqual(json(await call(ctx, { url: '/messages/count' })), { count: 100 }, 'nothing deleted')
      assert.equal((await bulk(ids)).statusCode, 200)
      for (const body of [{}, { messageResponseIds: 'RES1' }, { messageResponseIds: [1] }, { messageResponseIds: [] }]) {
        const r = await call(ctx, { method: 'POST', url: '/messages/delete', body })
        assert.equal(r.statusCode, 400, JSON.stringify(body))
      }
    })
  })

  describe('expiry', () => {
    test('unread messages older than five days are gone', async () => {
      const old = await put()
      ctx.clock.advance(3 * DAY_MS)
      const recent = await put()
      ctx.clock.advance(2 * DAY_MS - 1001)
      assert.deepEqual(json(await call(ctx, { url: '/messages/count' })), { count: 2 }, 'exactly five days is still there')
      ctx.clock.advance(2)
      assert.deepEqual(json(await call(ctx, { url: '/messages/count' })), { count: 1 })
      assert.equal((await call(ctx, { url: '/messages/next' })).headers['message-response-id'], recent.id)
      assert.equal((await call(ctx, { url: `/messages/${old.id}` })).statusCode, 404)
      assert.equal(await ctx.emulator.inbox.purge(), 1)
      assert.equal((await del(old.id)).statusCode, 200, 'an expired message counts as deleted')
      ctx.clock.advance(5 * DAY_MS)
      assert.equal((await call(ctx, { url: '/messages/next' })).statusCode, 204)
    })
  })
})
