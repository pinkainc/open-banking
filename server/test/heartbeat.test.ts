// Communication test: GET /heartbeat (sync), GET /heartbeat/mq and POST /heartbeat (inbox).
import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import { C1, SP, call, drain, setup, type Ctx } from './helpers.js'
import { parseXml } from '../src/xml.js'

describe('heartbeat', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup() })

  test('GET /heartbeat answers the Tallinn time with offset, seven fractional digits', async () => {
    const res = await call(ctx, { url: '/heartbeat' })
    assert.equal(res.statusCode, 200)
    assert.match(String(res.headers['content-type']), /application\/xml/)
    assert.equal(parseXml(res.body).HeartBeatResponse.TimeStamp, '2026-03-10T10:00:00.0000000+02:00')
    assert.equal(await call(ctx, { url: '/messages/next' }).then((r) => r.statusCode), 204, 'sync heartbeat leaves no message')
  })

  test('summer time is +03:00', async () => {
    ctx.clock.set('2026-07-01T09:30:00.123Z')
    const res = await call(ctx, { url: '/heartbeat' })
    assert.equal(parseXml(res.body).HeartBeatResponse.TimeStamp, '2026-07-01T12:30:00.1230000+03:00')
    ctx.clock.set('2026-03-10T08:00:00Z')
  })

  test('GET /heartbeat/mq: 202 + Message-Request-Id, then a HEARTBEAT message in the inbox', async () => {
    const res = await call(ctx, { url: '/heartbeat/mq' })
    assert.equal(res.statusCode, 202)
    assert.equal(res.body, '')
    const reqId = res.headers['message-request-id'] as string
    assert.match(reqId, /^REQ[0-9a-f]{32}$/)
    const [m, ...rest] = await drain(ctx)
    assert.equal(rest.length, 0)
    assert.equal(m.type, 'HEARTBEAT')
    assert.equal(m.requestId, reqId)
    assert.match(m.id, /^RES[0-9a-f]{32}$/)
    const h = m.doc.HeartBeatResponse
    assert.deepEqual(h.AuthorizedUser, { Name: 'Demo Customer 1', Code: C1.code })
    assert.equal(h.Certificates.Certificate.SerialNumber, '0A1B')
    assert.equal(h.Certificates.Certificate.ValidFrom, '2020-01-01T00:00:00')
    assert.equal(h.Certificates.Certificate.ValidTo, '2030-01-01T00:00:00')
  })

  test('POST /heartbeat echoes the request in UserRequest (escaped)', async () => {
    const res = await call(ctx, { method: 'POST', url: '/heartbeat', body: '<root>Content</root>' })
    assert.equal(res.statusCode, 202)
    const [m] = await drain(ctx)
    assert.match(m.body, /<UserRequest>&lt;root&gt;Content&lt;\/root&gt;<\/UserRequest>/)
    assert.equal(m.doc.HeartBeatResponse.UserRequest, '<root>Content</root>')
  })

  test('a service provider: the message goes to the named customer, AuthorizedUser is the provider', async () => {
    const headers = { 'Client-Code': C1.code, 'Client-Country': 'EE' }
    const res = await call(ctx, { url: '/heartbeat/mq', as: SP.code, headers })
    assert.equal(res.statusCode, 202)
    const [m] = await drain(ctx, C1.code)
    assert.equal(m.doc.HeartBeatResponse.AuthorizedUser.Code, SP.code)
  })
})
