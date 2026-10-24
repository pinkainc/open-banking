// Cross-cutting HTTP behaviour: X-Bank-Code, the 5 MB body limit, X-Idempotency-Key.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { before, describe, test } from 'node:test'
import { BODY_LIMIT } from '../src/app.js'
import { DAY_MS } from '../src/clock.js'
import { parseXml } from '../src/xml.js'
import { C2, call, setup, type Ctx } from './helpers.js'

// POST /heartbeat (BDOC) is an LHV EE service: the UK host reaches it with X-Bank-Code: LHVEE (decision 701).
const EE = { 'x-bank-code': 'LHVEE' }

describe('http', () => {
  let ctx: Ctx, ee: Ctx
  // X-Idempotency-Key is a UK-host feature (decision 500): these run as the UK flavour.
  before(async () => { ctx = await setup({}, undefined, { flavour: 'UK' }); ee = await setup() })

  test('X-Bank-Code on every response: LHVEE on the EE host, LHVUK on the UK host', async () => {
    for (const url of ['/heartbeat', '/messages/next', '/messages/count', '/messages/RESx']) {
      assert.equal((await call(ee, { url })).headers['x-bank-code'], 'LHVEE', url)
      assert.equal((await call(ctx, { url })).headers['x-bank-code'], 'LHVUK', url)
    }
  })

  test('the EE host ignores X-Idempotency-Key: a repeat and a non-UUID value are processed', async () => {
    const key = randomUUID()
    for (const k of [key, key, 'abc']) {
      const r = await call(ee, { url: '/heartbeat', method: 'POST', body: 'x', headers: { 'X-Idempotency-Key': k } })
      assert.equal(r.statusCode, 202, k)
    }
    assert.deepEqual(JSON.parse((await call(ee, { url: '/messages/count' })).body), { count: 3 })
  })

  test('a body over 5 MB is 413', async () => {
    const r = await call(ctx, { method: 'POST', url: '/payment', body: '<a>' + 'x'.repeat(BODY_LIMIT) + '</a>' })
    assert.equal(r.statusCode, 413)
    assert.equal(parseXml(r.body).Errors.Error.ErrorCode, '413')
  })

  test('X-Idempotency-Key: a repeat within 24 h is 409, the first one stays done', async () => {
    const key = randomUUID()
    const first = await call(ctx, { url: '/heartbeat', method: 'POST', body: 'x', headers: { ...EE, 'X-Idempotency-Key': key } })
    assert.equal(first.statusCode, 202)
    const again = await call(ctx, { url: '/heartbeat', method: 'POST', body: 'x', headers: { ...EE, 'X-Idempotency-Key': key } })
    assert.equal(again.statusCode, 409)
    assert.equal(parseXml(again.body).Errors.Error.ErrorCode, 'CONFLICT')
    // Keys are per client: another customer may use the same value.
    const other = await call(ctx, { url: '/heartbeat', method: 'POST', as: C2.code, body: 'x', headers: { ...EE, 'X-Idempotency-Key': key } })
    assert.equal(other.statusCode, 202)
    assert.deepEqual(JSON.parse((await call(ctx, { url: '/messages/count' })).body), { count: 1 })
    ctx.clock.advance(DAY_MS + 1)
    const later = await call(ctx, { url: '/heartbeat', method: 'POST', body: 'x', headers: { ...EE, 'X-Idempotency-Key': key } })
    assert.equal(later.statusCode, 202)
  })

  test('X-Idempotency-Key must be a UUID', async () => {
    const r = await call(ctx, { url: '/heartbeat', method: 'POST', body: 'x', headers: { ...EE, 'X-Idempotency-Key': 'abc' } })
    assert.equal(r.statusCode, 400)
  })

  test('a failed request does not use up its key', async () => {
    const key = randomUUID()
    const bad = await call(ctx, { url: '/payment', method: 'POST', body: 'not xml', headers: { 'X-Idempotency-Key': key } })
    assert.equal(bad.statusCode, 400)
    const retry = await call(ctx, { url: '/heartbeat', method: 'POST', body: 'x', headers: { ...EE, 'X-Idempotency-Key': key } })
    assert.equal(retry.statusCode, 202)
  })
})
