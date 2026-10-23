// L5a contract management smoke tests: the seeded connections listed as ACTIVE, a new
// pending contract activated by the control plane, and the provider-only rule. Bodies are
// checked against the ssot schemas (jsonValid).
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { C1, SP, call, jsonValid, setup, type Ctx } from './helpers.js'

let ctx: Ctx
beforeEach(async () => { ctx = await setup() })

const asSp = { as: SP.code, headers: { 'Client-Code': SP.code, 'Client-Country': 'EE' } }

describe('contracts', () => {
  test('a new customer: pending contract with a BDOC, then active after LHV activates it', async () => {
    await call(ctx, { method: 'POST', url: '/_sim/customers', body: { code: '12340003', country: 'EE', name: 'Demo Customer 3', accounts: ['EE427700771001260990'] } })
    const before = jsonValid('contracts-list.response', (await call(ctx, { url: '/contracts', ...asSp })).body)
    assert.deepEqual(before.customers.map((c: any) => c.companyCode), ['12340001', '12340002'])
    assert.ok(before.customers.every((c: any) => c.contracts[0].status === 'ACTIVE'))

    const body = jsonValid('contracts-create.request', { companyCode: '12340003', companyCodeIssuer: 'EE' })
    const res = await call(ctx, { method: 'POST', url: '/contracts', body, ...asSp })
    assert.equal(res.statusCode, 200, res.body)
    const created = jsonValid('contracts-create.response', res.body)
    assert.equal(created.contractStatus, 'pending')
    assert.equal(Buffer.from(created.contractContainer, 'base64').subarray(30, 38).toString(), 'mimetype')

    const listed = jsonValid('contracts-list.response', (await call(ctx, { url: '/contracts', ...asSp })).body)
    const c3 = listed.customers.find((c: any) => c.companyCode === '12340003')
    assert.deepEqual(c3.contracts.map((c: any) => c.status), ['PENDING'])
    assert.deepEqual(c3.contracts[0].services.find((s: any) => s.name === 'CREDIT_DEBIT_NOTIFICATION').ibans, ['EE427700771001260990'])

    // Not yet connected: the provider cannot act for the customer.
    const h = { as: SP.code, headers: { 'Client-Code': '12340003', 'Client-Country': 'EE' } }
    assert.equal((await call(ctx, { url: '/messages/count', ...h })).statusCode, 403)
    assert.equal((await call(ctx, { method: 'POST', url: `/_sim/contracts/${created.contractId}/activate` })).statusCode, 200)
    assert.equal((await call(ctx, { url: '/messages/count', ...h })).statusCode, 200)
    const after = jsonValid('contracts-list.response', (await call(ctx, { url: '/contracts', ...asSp })).body)
    assert.equal(after.customers.find((c: any) => c.companyCode === '12340003').contracts[0].status, 'ACTIVE')
  })

  test('only a service provider, for itself; unknown customer is CONTRACT_CREATION_FAILED', async () => {
    assert.equal((await call(ctx, { url: '/contracts', as: C1.code })).statusCode, 403)
    const res = await call(ctx, { method: 'POST', url: '/contracts', body: { companyCode: '99999999', companyCodeIssuer: 'EE' }, ...asSp })
    assert.equal(res.statusCode, 400)
    const e = jsonValid('error-json', res.body)
    assert.equal(e.errors[0].errorCode, 'CONTRACT_CREATION_FAILED')
  })
})
