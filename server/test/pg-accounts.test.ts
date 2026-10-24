// UK account report state in Postgres (decision 988): a pending incoming Bacs credit made
// before a restart still shows as Pending in /accounts/{acc}/payments after it and leaves
// the list once booked; a payment held over /_sim/accounts/incoming survives a restart and
// is booked once when two emulators approve it at once; a rejected one stays Rejected.
// Registered only when DATABASE_URL is set.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { makeIban } from '../src/iban.js'
import type { EmulatorOptions } from '../src/emulator.js'
import { call, postgresStore, seed, setup, type Ctx } from './helpers.js'

const url = process.env.DATABASE_URL
const A = makeIban('GB', 'LHVB04031400001234')
const C = makeIban('GB', 'LHVB04030700012345')
const U1 = { code: '09876543', country: 'GB', name: 'Connect Demo Customer 1' }
const U2 = { code: '09876544', country: 'GB', name: 'Katie Bell' }

const start = (opts: EmulatorOptions) => {
  const s = seed()
  s.customers.push({ ...U1, accounts: [{ iban: A, balances: { GBP: '1000.00' } }] }, { ...U2, accounts: [{ iban: C, balances: { GBP: '500.00' } }] })
  return setup(opts, s, { flavour: 'UK' })
}
const payments = async (ctx: Ctx, iban: string, as: string) => {
  const r = await call(ctx, { url: `/accounts/${iban}/payments`, as })
  assert.equal(r.statusCode, 200, r.body)
  return (r.json().Data.Transaction as any[]).map((t) => [t.Amount.Amount, t.Status])
}
const post = (ctx: Ctx, path: string, body: object = {}) => call(ctx, { method: 'POST', url: path, body, as: null })

if (url) describe('UK account reports across a restart (Postgres)', () => {
  test('a pending Bacs credit is Pending after the restart and leaves the list once booked', async () => {
    const opts = await postgresStore()
    const a = await start(opts)
    const r = await post(a, '/_sim/bacs/incoming', { iban: A, amount: '10.01', debtor: { name: 'Debtor Name', sortCode: '60-01-02', accountNumber: '20266221' } })
    assert.equal(r.statusCode, 201, r.body)
    assert.deepEqual(await payments(a, A, U1.code), [['10.01', 'Pending']])

    const b = await start(opts)
    assert.deepEqual(await payments(b, A, U1.code), [['10.01', 'Pending']])
    b.clock.set('2026-03-11T08:00:00Z')
    assert.equal((await post(b, '/_sim/bacs/tick')).statusCode, 200)
    const c = await start(opts)
    c.clock.set('2026-03-11T09:00:00Z')
    assert.deepEqual(await payments(c, A, U1.code), [], 'booked: no longer pending')
  })

  test('a held payment survives the restart, is booked once by two emulators; a rejected one stays Rejected', async () => {
    const opts = await postgresStore()
    const a = await start(opts)
    const hold = async (amount: string) => {
      const r = await post(a, '/_sim/accounts/incoming', { iban: C, amount, debtor: { name: 'Katie', iban: A } })
      assert.equal(r.statusCode, 201, r.body)
      return r.json().accountServicerReference as string
    }
    const one = await hold('10.00')
    const two = await hold('20.00')

    const [b, c] = [await start(opts), await start(opts)]
    assert.equal((await call(b, { url: '/_sim/accounts/incoming', as: null })).json().incoming.length, 2)
    assert.deepEqual(await payments(b, C, U2.code), [['10.00', 'Pending'], ['20.00', 'Pending']])
    const statuses = (await Promise.all([post(b, `/_sim/accounts/incoming/${one}/approve`), post(c, `/_sim/accounts/incoming/${one}/approve`)])).map((x) => x.statusCode).sort()
    assert.deepEqual(statuses, [200, 404], 'booked once')
    assert.equal(await c.emulator.ledger.available(C, 'GBP'), 51000n)
    assert.equal((await post(c, `/_sim/accounts/incoming/${two}/reject`)).statusCode, 200)

    const d = await start(opts)
    assert.deepEqual(await payments(d, C, U2.code), [['20.00', 'Rejected']])
    assert.equal((await call(d, { url: '/_sim/accounts/incoming', as: null })).json().incoming.length, 0)
    assert.equal((await post(d, `/_sim/accounts/incoming/${two}/approve`)).statusCode, 404)
  })
})
