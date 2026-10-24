// The request log and X-Idempotency-Key in Postgres (decision 989): a request answered 202
// before a restart of the emulator on the same namespace is listed by GET /v2/requests
// after it with its body; a key used before the restart is still a 409 after it, of two
// emulators taking one key at once one answers 202, and a failed request gives its key
// back. Registered only when DATABASE_URL is set.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, test } from 'node:test'
import { C1, call, camt060, postgresStore, setup, type Ctx } from './helpers.js'

const url = process.env.DATABASE_URL
const UK = { flavour: 'UK' as const }
const BODY = camt060({ kind: 'balance' })
const balance = (ctx: Ctx, key: string) =>
  call(ctx, { url: '/account-balance', method: 'POST', body: BODY, headers: { 'X-Idempotency-Key': key } })

if (url) describe('Request log and idempotency keys across a restart (Postgres)', () => {
  test('a request recorded before the restart is listed after it; its key is still a 409', async () => {
    const opts = await postgresStore()
    const a = await setup(opts, undefined, UK)
    const key = randomUUID()
    const first = await balance(a, key)
    assert.equal(first.statusCode, 202)
    const id = first.headers['message-request-id'] as string

    const b = await setup(opts, undefined, UK)
    assert.equal((await balance(b, key)).statusCode, 409, 'remembered across the restart')
    const listed = await call(b, { url: '/v2/requests' })
    assert.equal(listed.statusCode, 200, listed.body)
    assert.deepEqual(listed.json().messages.map((m: any) => [m.messageRequestId, m.bankCode, m.clientCode]), [[id, 'LHVUK', C1.code]])
    const one = await call(b, { url: `/v2/requests/${id}` })
    assert.deepEqual([one.statusCode, one.body], [200, BODY])
    assert.equal(await b.emulator.requests.bankCodeOf(id), 'LHVUK')
    b.clock.advance(24 * 3600_000 + 1)
    assert.equal((await balance(b, key)).statusCode, 202, 'forgotten after 24 h')
  })

  test('two emulators taking one key at once: one 202, one 409; a failed request gives its key back', async () => {
    const opts = await postgresStore()
    const [a, b] = [await setup(opts, undefined, UK), await setup(opts, undefined, UK)]
    const key = randomUUID()
    assert.deepEqual((await Promise.all([balance(a, key), balance(b, key)])).map((r) => r.statusCode).sort(), [202, 409])
    assert.equal(await b.emulator.requests.size(), 1)
    const other = randomUUID()
    const subscribe = (ctx: Ctx, body: object) => call(ctx, { method: 'POST', url: '/notifications/subscription', body, headers: { 'X-Idempotency-Key': other } })
    assert.equal((await subscribe(a, { requestUrl: 'https://hooks.example.org/lhv', active: true })).statusCode, 400, 'messageType missing')
    assert.equal((await subscribe(b, { messageType: 'VIBAN_OPEN', requestUrl: 'https://hooks.example.org/lhv', active: true })).statusCode, 200, 'the key given back')
    assert.equal((await subscribe(a, { messageType: 'PAYMENT', requestUrl: 'https://hooks.example.org/lhv', active: true })).statusCode, 409)
  })
})
