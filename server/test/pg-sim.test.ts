// The payee simulator accounts and the /_sim/viban settings in Postgres (decision 989): a
// simulated payee account, the screening list, the fault count (used once) and the error
// delivery survive a restart of the emulator on the same namespace. Registered only when
// DATABASE_URL is set.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { C1, call, postgresStore, setup } from './helpers.js'

const url = process.env.DATABASE_URL
const IT_IBAN = 'IT76L0300203280825973665778'

if (url) describe('Simulator settings across a restart (Postgres)', () => {
  test('payee simulator accounts and the /_sim/viban settings survive the restart', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    assert.equal((await call(a, { method: 'PUT', url: `/_sim/payee/accounts/${IT_IBAN}`, body: { name: 'John Edward Doe' } })).statusCode, 200)
    assert.equal((await call(a, { method: 'POST', url: '/_sim/viban/screening', body: { names: ['Donald Duck'] } })).statusCode, 200)
    assert.equal((await call(a, { method: 'POST', url: '/_sim/viban/fault', body: { count: 1 } })).statusCode, 200)
    assert.equal((await call(a, { method: 'POST', url: '/_sim/viban/errors', body: { delivery: 'sync' } })).statusCode, 200)

    const b = await setup(opts)
    const accounts = (await call(b, { url: '/_sim/payee/accounts' })).json().accounts
    assert.equal(accounts.length, 1)
    assert.equal(accounts[0].name, 'John Edward Doe')
    assert.equal((await b.emulator.payee.lookup({ iban: IT_IBAN })).holder?.name, 'John Edward Doe')
    assert.deepEqual(await b.emulator.viban.screening(), ['donald duck'])
    assert.equal(await b.emulator.viban.errorDelivery(), 'sync')
    const customer = { code: C1.code, country: C1.country }
    const faulted = await b.emulator.viban.handle('info', '<x/>', customer)
    assert.deepEqual('errors' in faulted && faulted.errors.map((e) => e.code), ['TECHNICAL_ERROR'])
    const c = await setup(opts)
    const next = await c.emulator.viban.handle('info', '<x/>', customer)
    assert.ok('errors' in next && next.errors.every((e) => e.code !== 'TECHNICAL_ERROR'), 'the fault used once')
    assert.equal((await call(c, { method: 'DELETE', url: `/_sim/payee/accounts/${IT_IBAN}` })).statusCode, 204)
    assert.equal((await call(await setup(opts), { url: '/_sim/payee/accounts' })).json().accounts.length, 0)
  })
})
