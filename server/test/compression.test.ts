// Response compression of message bodies of 10 MB or more (UK host; decision 503).
import assert from 'node:assert/strict'
import { gunzipSync, inflateSync } from 'node:zlib'
import { before, describe, test } from 'node:test'
import { COMPRESSION_THRESHOLD, negotiate } from '../src/compression.js'
import { mockLargeStatement } from '../src/statements/mock-large.js'
import { C1, HAVE_ISO, HAVE_REFERENCE, call, schemaValid, setup, type Ctx } from './helpers.js'

/** An inbox message whose body is exactly `bytes` long. */
function big(ctx: Ctx, bytes: number) {
  const head = '<Doc>', tail = '</Doc>'
  return ctx.emulator.inbox.add({ customer: C1, type: 'ACCOUNT_STATEMENT', body: head + 'x'.repeat(bytes - head.length - tail.length) + tail })
}

describe('Accept-Encoding negotiation', () => {
  const cases: [string | undefined, string | undefined][] = [
    ['gzip', 'gzip'], ['deflate', 'deflate'], ['gzip, deflate', 'gzip'], ['deflate, gzip', 'gzip'],
    ['gzip, deflate, br', 'gzip'], ['deflate, gzip;q=0', 'deflate'], ['GZIP;q=0.5', 'gzip'], ['x-gzip', 'gzip'],
    ['*', 'gzip'], ['br', undefined], ['identity', undefined], ['gzip;q=0, deflate;q=0', undefined], ['', undefined], [undefined, undefined],
  ]
  for (const [header, want] of cases) test(`${JSON.stringify(header)} → ${want}`, () => assert.equal(negotiate(header), want))
})

describe('compression on the UK host', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup({}, undefined, { flavour: 'UK' }) })

  test('the default threshold is 10 MB (decimal)', () => assert.equal(COMPRESSION_THRESHOLD, 10_000_000))

  test('at 10 MB: gzip or deflate as asked, with the message headers', async () => {
    const m = await big(ctx, COMPRESSION_THRESHOLD)
    const gz = await call(ctx, { url: '/messages/next', headers: { 'Accept-Encoding': 'gzip, deflate' } })
    assert.equal(gz.statusCode, 200)
    assert.equal(gz.headers['content-encoding'], 'gzip')
    assert.equal(gz.headers['message-response-id'], m.id)
    assert.match(String(gz.headers['content-type']), /application\/xml/)
    assert.ok(gz.rawPayload.length < 100_000)
    assert.equal(gunzipSync(gz.rawPayload).toString(), m.body)
    const df = await call(ctx, { url: `/messages/${m.id}`, headers: { 'Accept-Encoding': 'deflate' } })
    assert.equal(df.headers['content-encoding'], 'deflate')
    assert.equal(inflateSync(df.rawPayload).toString(), m.body)
    await call(ctx, { method: 'DELETE', url: `/messages/${m.id}` })
  })

  test('at 10 MB without a supported Accept-Encoding: 500, and the message stays', async () => {
    const m = await big(ctx, COMPRESSION_THRESHOLD)
    for (const headers of [{}, { 'Accept-Encoding': 'br' }, { 'Accept-Encoding': 'identity' }] as Record<string, string>[]) {
      for (const url of ['/messages/next', `/messages/${m.id}`]) {
        const r = await call(ctx, { url, headers })
        assert.equal(r.statusCode, 500, `${url} ${JSON.stringify(headers)}`)
        assert.equal(r.headers['message-response-id'], undefined)
        assert.equal(JSON.parse(r.body).errors[0].errorCode, 'TECHNICAL_ERROR')
      }
    }
    const ok = await call(ctx, { url: '/messages/next', headers: { 'Accept-Encoding': 'gzip' } })
    assert.equal(ok.headers['message-response-id'], m.id)
    await call(ctx, { method: 'DELETE', url: `/messages/${m.id}` })
  })

  test('one byte under 10 MB: never compressed, also when asked', async () => {
    const m = await big(ctx, COMPRESSION_THRESHOLD - 1)
    for (const headers of [{}, { 'Accept-Encoding': 'gzip' }] as Record<string, string>[]) {
      const r = await call(ctx, { url: '/messages/next', headers })
      assert.equal(r.statusCode, 200)
      assert.equal(r.headers['content-encoding'], undefined)
      assert.equal(r.body.length, COMPRESSION_THRESHOLD - 1)
    }
    await call(ctx, { method: 'DELETE', url: `/messages/${m.id}` })
  })

  test('GET /messages/test/next?mockLargeMessage=true: a schema-valid camt.053 of about 10.6 MB', async () => {
    const r = await call(ctx, { url: '/messages/test/next?mockLargeMessage=true', headers: { 'Accept-Encoding': 'gzip, deflate, br' } })
    assert.equal(r.statusCode, 200)
    assert.equal(r.headers['content-encoding'], 'gzip')
    assert.equal(r.headers['x-bank-code'], 'LHVUK')
    const body = gunzipSync(r.rawPayload).toString()
    assert.ok(body.length >= 10_550_000 && body.length <= 10_700_000, String(body.length))
    assert.match(body, /xmlns="urn:iso:std:iso:20022:tech:xsd:camt\.053\.001\.02"/)
    // The mock itself against the ISO camt.053.001.02 schema (decision 550); the same writer
    // and entries as camt.053.001.08 against the published XSD.
    if (HAVE_REFERENCE) assert.equal(await schemaValid(body), HAVE_ISO)
    if (HAVE_REFERENCE) assert.equal(await schemaValid(mockLargeStatement(ctx.clock.now(), ctx.emulator.bank, 300_000, '08')), true)
    assert.equal((await call(ctx, { url: '/messages/test/next?mockLargeMessage=true' })).statusCode, 500)
    // Without the flag it is the ordinary next message; the mock is in no inbox.
    assert.equal((await call(ctx, { url: '/messages/test/next' })).statusCode, 204)
  })
})

describe('no compression on the EE host', () => {
  test('a 10 MB message is sent plain, whatever the request accepts; no test endpoint', async () => {
    const ctx = await setup()
    const m = await big(ctx, COMPRESSION_THRESHOLD)
    for (const headers of [{}, { 'Accept-Encoding': 'gzip' }] as Record<string, string>[]) {
      const r = await call(ctx, { url: '/messages/next', headers })
      assert.equal(r.statusCode, 200)
      assert.equal(r.headers['content-encoding'], undefined)
      assert.equal(r.body, m.body)
    }
    assert.equal((await call(ctx, { url: '/messages/test/next?mockLargeMessage=true' })).statusCode, 404)
  })
})
