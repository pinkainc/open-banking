// Identity and service-provider scoping (docs/decisions.md 1-5), with the certificate
// identity injected by a test header; mtls.test.ts covers the real TLS transport.
import assert from 'node:assert/strict'
import { before, describe, test } from 'node:test'
import { parseXml } from '../src/xml.js'
import { C1, C2, SP, call, setup, type Ctx } from './helpers.js'

const error = (body: string) => parseXml(body).Errors.Error

describe('identity', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup() })

  const forbidden = async (r: Parameters<typeof call>[1], description: string) => {
    const res = await call(ctx, r)
    assert.equal(res.statusCode, 403)
    assert.match(String(res.headers['content-type']), /application\/xml/)
    assert.equal(error(res.body).ErrorCode, 'FORBIDDEN')
    assert.equal(error(res.body).Description, description)
  }

  test('a customer certificate is the customer', async () => {
    const res = await call(ctx, { url: '/heartbeat', as: C1.code })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['x-bank-code'], 'LHVEE')
  })
  test('no identity at all is 403', () => forbidden({ url: '/heartbeat', as: null }, 'User authentication certificate is missing'))
  test('unknown registration code', () => forbidden({ url: '/heartbeat', as: '99999999' }, "User doesn't exist"))
  test('non-numeric SERIALNUMBER', () => forbidden({ url: '/heartbeat', as: 'ABC123' }, 'Certificate has invalid SERIALNUMBER field'))
  test('without serialNumber the CN is the code', async () => {
    const res = await call(ctx, { url: '/heartbeat', as: null, headers: { 'x-test-cn': C2.code } })
    assert.equal(res.statusCode, 200)
  })
  test('403 carries X-Bank-Code too', async () => {
    const res = await call(ctx, { url: '/heartbeat', as: '99999999' })
    assert.equal(res.headers['x-bank-code'], 'LHVEE')
  })

  test('a customer may name itself in Client-Code', async () => {
    const res = await call(ctx, { url: '/messages/count', as: C1.code, headers: { 'Client-Code': C1.code, 'Client-Country': 'ee' } })
    assert.equal(res.statusCode, 200)
  })
  test('a customer naming someone else', () =>
    forbidden({ url: '/messages/count', as: C1.code, headers: { 'Client-Code': C2.code, 'Client-Country': 'EE' } }, "User doesn't have valid contract"))
  test('Client-Code without Client-Country', () =>
    forbidden({ url: '/messages/count', as: C1.code, headers: { 'Client-Code': C1.code } }, "Missing 'Client-Country' request header"))
  test('Client-Country of the wrong length', () =>
    forbidden({ url: '/messages/count', as: C1.code, headers: { 'Client-Code': C1.code, 'Client-Country': 'EST' } },
      "'Client-Country' request header value is not in correct format. Length should be 2 characters (i.e. EE)"))
})

describe('service provider', () => {
  let ctx: Ctx
  before(async () => { ctx = await setup() })
  const as = (code: string, country = 'EE', extra: Record<string, string> = {}) => ({ 'Client-Code': code, 'Client-Country': country, ...extra })

  test('must send Client-Code', async () => {
    const res = await call(ctx, { url: '/heartbeat', as: SP.code })
    assert.equal(res.statusCode, 403)
    assert.equal(error(res.body).Description, "Can't authenticate. No 'Client-Code' header for service provider")
  })
  test('acts for a connected customer', async () => {
    const res = await call(ctx, { url: '/heartbeat', as: SP.code, headers: as(C1.code) })
    assert.equal(res.statusCode, 200)
  })
  test('unknown customer', async () => {
    const res = await call(ctx, { url: '/heartbeat', as: SP.code, headers: as('55555555') })
    assert.equal(res.statusCode, 403)
    assert.equal(error(res.body).Description, "User doesn't exist")
  })
  test('code and country must both match (decision 4)', async () => {
    const res = await call(ctx, { url: '/heartbeat', as: SP.code, headers: as(C1.code, 'LV') })
    assert.equal(res.statusCode, 403)
  })
  test('a known customer without a contract with this provider', async () => {
    await ctx.emulator.addCustomer({ code: '77700001', country: 'EE', name: 'Not Connected' })
    const res = await call(ctx, { url: '/heartbeat', as: SP.code, headers: as('77700001') })
    assert.equal(res.statusCode, 403)
    assert.equal(error(res.body).Description, "User doesn't have valid contract")
  })

  test('one inbox per customer; the provider sees its own plus every connected one', async () => {
    for (const code of [C1.code, C2.code, SP.code]) {
      const r = await call(ctx, { url: '/heartbeat/mq', as: SP.code, headers: as(code) })
      assert.equal(r.statusCode, 202)
    }
    // The customer's own certificate reads the same message (decision 5).
    const own = await call(ctx, { url: '/messages/count', as: C1.code })
    assert.deepEqual(JSON.parse(own.body), { count: 1 })
    const viaSp = await call(ctx, { url: '/messages/count', as: SP.code, headers: as(C2.code) })
    assert.deepEqual(JSON.parse(viaSp.body), { count: 1 })
    const all = await call(ctx, { url: '/messages', as: SP.code, headers: as(SP.code) })
    const list = JSON.parse(all.body).messages
    assert.deepEqual(list.map((m: any) => m.clientCode).sort(), [SP.code, C1.code, C2.code].sort())
    const onlyOwn = await call(ctx, { url: '/messages', as: SP.code, headers: as(SP.code, 'EE', { 'Filter-Service-Provider': 'true' }) })
    assert.deepEqual(JSON.parse(onlyOwn.body).messages.map((m: any) => m.clientCode), [SP.code])
    // Message headers name the customer the message belongs to.
    const next = await call(ctx, { url: '/messages/next', as: SP.code, headers: as(C2.code) })
    assert.equal(next.headers['client-code'], C2.code)
    assert.equal(next.headers['client-country'], 'EE')
  })
})
