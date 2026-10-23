// The emulator's control plane at /_sim (JSON in, JSON out).
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { buildApp } from '../src/app.js'
import { C1, C2, DE_IBAN, HAVE_REFERENCE, call, drain, setup, xsd, type Ctx } from './helpers.js'

let ctx: Ctx
beforeEach(async () => { ctx = await setup() })
const json = (r: { body: string }) => JSON.parse(r.body)
const post = (url: string, body: object) => call(ctx, { method: 'POST', url, body })

describe('/_sim', () => {
  test('GET /customers lists the seed with balances', async () => {
    const r = json(await call(ctx, { url: '/_sim/customers' }))
    const c1 = r.customers.find((c: any) => c.code === C1.code)
    assert.equal(c1.name, 'Demo Customer 1')
    assert.equal(c1.camt054, '02')
    assert.deepEqual(c1.accounts[0].balances.EUR, { balance: '10000.00', available: '10000.00' })
    assert.ok(r.customers.find((c: any) => c.connected))
  })

  test('POST /customers creates a customer with funded accounts; duplicates are 409', async () => {
    const body = { code: '55500001', country: 'ee', name: 'Acme', accounts: [{ iban: 'EE38 2200 2210 2014 5685', balances: { EUR: '5.00' } }] }
    const r = await post('/_sim/customers', body)
    assert.equal(r.statusCode, 201)
    assert.deepEqual(json(r), { code: '55500001', country: 'EE', accounts: ['EE382200221020145685'] })
    assert.equal((await post('/_sim/customers', body)).statusCode, 409)
    assert.equal((await call(ctx, { url: '/heartbeat', as: '55500001' })).statusCode, 200, 'the new customer can connect')
    assert.equal(json(await call(ctx, { url: '/_sim/accounts/EE382200221020145685' })).balances.EUR.balance, '5.00')
  })

  test('POST /customers validates its input', async () => {
    assert.equal((await post('/_sim/customers', { code: '1' })).statusCode, 400)
    assert.equal((await post('/_sim/customers', { code: '2', country: 'EE', name: 'X', accounts: [C1.iban] })).statusCode, 400, 'an account already owned')
  })

  test('GET /accounts/:iban, 404 when unknown', async () => {
    const r = json(await call(ctx, { url: `/_sim/accounts/${C2.iban}` }))
    assert.deepEqual(r.owner, { code: C2.code, country: 'EE', name: 'Demo Customer 2' })
    assert.equal((await call(ctx, { url: `/_sim/accounts/${DE_IBAN}` })).statusCode, 404)
  })

  test('POST /accounts/:iban/fund adds money without a notification', async () => {
    const r = await post(`/_sim/accounts/${C2.iban}/fund`, { amount: '50.25', currency: 'EUR' })
    assert.equal(r.statusCode, 200)
    assert.equal(json(r).balances.EUR.balance, '150.25')
    assert.equal((await post(`/_sim/accounts/${C2.iban}/fund`, { amount: 'ten' })).statusCode, 400)
    assert.equal((await post(`/_sim/accounts/${DE_IBAN}/fund`, { amount: '1.00' })).statusCode, 404)
    assert.equal((await call(ctx, { url: '/messages/next', as: C2.code })).statusCode, 204)
  })

  test('POST /incoming books a credit and notifies with camt.054 CRDT', async () => {
    const r = await post('/_sim/incoming', {
      iban: C2.iban, amount: '12.00', scheme: 'INST', debtor: { name: 'Outside Payer', iban: DE_IBAN, bic: 'COBADEFFXXX' },
      remittance: 'Thanks', endToEndId: 'E2E-IN-1',
    })
    assert.equal(r.statusCode, 200)
    const body = json(r)
    assert.match(body.accountServicerReference, /^[0-9A-F]{32}$/)
    assert.equal(body.balances.EUR.balance, '112.00')
    const [m, ...rest] = await drain(ctx, C2.code)
    assert.equal(rest.length, 0)
    assert.equal(m.type, 'CREDIT_DEBIT_NOTIFICATION')
    assert.equal(m.requestId, undefined)
    const n = m.doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn
    assert.equal(n.Ntry.CdtDbtInd, 'CRDT')
    assert.equal(n.Ntry.AcctSvcrRef, body.accountServicerReference)
    assert.equal(n.Ntry.BkTxCd.Prtry.Cd, 'INST')
    assert.equal(n.Ntry.NtryDtls.TxDtls.RltdPties.Dbtr.Nm, 'Outside Payer')
    assert.equal(n.Ntry.NtryDtls.TxDtls.Refs.EndToEndId, 'E2E-IN-1')
    if (HAVE_REFERENCE) assert.deepEqual(await xsd.validate(m.body, 'camt.054.001.02'), [])
  })

  test('POST /incoming validates its input', async () => {
    assert.equal((await post('/_sim/incoming', { amount: '1.00' })).statusCode, 400)
    assert.equal((await post('/_sim/incoming', { iban: DE_IBAN, amount: '1.00' })).statusCode, 404)
    assert.equal((await post('/_sim/incoming', { iban: C2.iban, amount: '1.00', scheme: 'CHEQUE' })).statusCode, 400)
    assert.equal((await post('/_sim/incoming', { iban: C2.iban, amount: 5 })).statusCode, 400)
  })

  test('rails: reject, no-instant, sent, reset', async () => {
    assert.equal((await post('/_sim/rails/reject', {})).statusCode, 400)
    assert.equal((await post('/_sim/rails/no-instant', {})).statusCode, 400)
    assert.deepEqual(json(await call(ctx, { url: '/_sim/rails/sent' })), { payments: [] })
    assert.deepEqual(json(await post('/_sim/rails/reset', {})), { ok: true })
  })

  test('/_sim is not served when disabled', async () => {
    const app = buildApp({ emulator: ctx.emulator, identify: () => ({ serialNumber: C1.code }), sim: false })
    const r = await app.inject({ url: '/_sim/customers' })
    assert.equal(r.statusCode, 404)
  })
})
