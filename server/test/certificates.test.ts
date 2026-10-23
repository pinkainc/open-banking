// Certificate checks against the contract and the clock (decision 502), by inject; the
// real transport with generated certificates is in mtls.test.ts.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { DAY_MS } from '../src/clock.js'
import { parseXml } from '../src/xml.js'
import { C1, C2, SP, call, seed, setup, type Ctx } from './helpers.js'

const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'
const OTHER = '11'.repeat(32)

async function forbidden(ctx: Ctx, headers: Record<string, string>, text: string, as = C1.code) {
  const r = await call(ctx, { url: '/heartbeat', as, headers })
  assert.equal(r.statusCode, 403, text)
  assert.deepEqual(parseXml(r.body).Errors.Error, { ErrorCode: 'FORBIDDEN', Description: text })
}

describe('certificate validity period', () => {
  test('not yet valid, valid, expired: by the emulator clock, to the second', async () => {
    const ctx = await setup() // clock 2026-03-10T08:00:00Z
    const period = { 'x-test-valid-from': 'Mar 10 08:00:01 2026 GMT', 'x-test-valid-to': 'Mar 11 08:00:00 2026 GMT' }
    await forbidden(ctx, period, 'User authentication certificate is not yet valid')
    ctx.clock.advance(1000)
    assert.equal((await call(ctx, { url: '/heartbeat', headers: period })).statusCode, 200)
    ctx.clock.advance(DAY_MS - 1000)
    assert.equal((await call(ctx, { url: '/heartbeat', headers: period })).statusCode, 200, 'validTo itself is still valid')
    ctx.clock.advance(1)
    await forbidden(ctx, period, 'User authentication certificate is expired')
  })

  test('the messages API and a service provider are checked the same way', async () => {
    const ctx = await setup()
    const expired = { 'x-test-valid-to': 'Jan  1 00:00:00 2026 GMT' }
    const r = await call(ctx, { url: '/messages/next', headers: expired })
    assert.equal(r.statusCode, 403)
    await forbidden(ctx, { ...expired, 'Client-Code': C1.code, 'Client-Country': 'EE' }, 'User authentication certificate is expired', SP.code)
  })
})

describe('certificate on the contract', () => {
  const withCerts = async (certs: string[] | undefined) => {
    const s = seed()
    s.customers.find((c) => c.code === C1.code)!.certificates = certs
    s.customers.find((c) => c.code === SP.code)!.certificates = certs
    return setup({}, s)
  }

  test('the registered certificate passes, in any hex notation', async () => {
    const ctx = await withCerts([FP.replace(/:/g, '').toLowerCase()])
    assert.equal((await call(ctx, { url: '/heartbeat', headers: { 'x-test-fingerprint': FP } })).statusCode, 200)
  })

  test('another certificate with the right code: "different than expected"', async () => {
    const ctx = await withCerts([FP])
    await forbidden(ctx, { 'x-test-fingerprint': OTHER }, 'User authentication certificate is different than expected')
    await forbidden(ctx, {}, 'User authentication certificate is different than expected')
    // A provider's certificate is its own, whoever it acts for.
    await forbidden(ctx, { 'x-test-fingerprint': OTHER, 'Client-Code': C2.code, 'Client-Country': 'EE' }, 'User authentication certificate is different than expected', SP.code)
  })

  test('a contract without any certificate', async () => {
    const ctx = await withCerts([])
    await forbidden(ctx, { 'x-test-fingerprint': FP }, "User doesn't have valid certificate for authentication")
  })

  test('the contract check comes before the validity period', async () => {
    const ctx = await withCerts([FP])
    await forbidden(ctx, { 'x-test-fingerprint': OTHER, 'x-test-valid-to': 'Jan  1 00:00:00 2026 GMT' }, 'User authentication certificate is different than expected')
    await forbidden(ctx, { 'x-test-fingerprint': FP, 'x-test-valid-to': 'Jan  1 00:00:00 2026 GMT' }, 'User authentication certificate is expired')
  })

  test('customers without registered certificates accept any (the default)', async () => {
    const ctx = await withCerts(undefined)
    assert.equal((await call(ctx, { url: '/heartbeat', headers: { 'x-test-fingerprint': OTHER } })).statusCode, 200)
  })
})
