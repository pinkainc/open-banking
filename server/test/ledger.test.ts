// The ledger's semantics, run against every store (helpers LEDGERS: memory always,
// Postgres when DATABASE_URL is set, open-ledger with OPEN_LEDGER_TESTS=1): balances and available, reservations, commit,
// release, transfer, system accounts that may go negative, the journal, and the
// minor-unit conversions. pg-ledger.test.ts covers what only Postgres has.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { InsufficientFunds, MemoryLedger, fromMinor, toMinor, type Ledger, type Posting } from '../src/ledger.js'
import { PgLedger } from '../src/pg/ledger.js'
import type { OpenLedgerLedger } from '../src/ledgers/open-ledger.js'
import { LEDGERS } from './helpers.js'

const postings = async (l: Ledger): Promise<Omit<Posting, 'at'>[]> =>
  (l instanceof MemoryLedger ? l.postings : await (l as PgLedger | OpenLedgerLedger).postings()).map(({ at: _, ...p }) => p)

for (const [store, make] of LEDGERS) describe(`ledger (${store})`, () => {
  test('a funded account has its balance and available; an unknown one has nothing', async () => {
    const l = await make()
    await l.transfer({ ref: 'f1', from: '@funding', to: 'A', amount: 1000n, currency: 'EUR' })
    assert.equal(await l.available('A', 'EUR'), 1000n)
    assert.equal(await l.available('@funding', 'EUR'), -1000n, 'a system account may go negative')
    assert.equal(await l.available('B', 'EUR'), 0n)
    assert.deepEqual(await l.balances('A'), { EUR: { balance: 1000n, available: 1000n } })
    assert.deepEqual(await l.balances('B'), {})
  })

  test('balances list currencies in the order the account first booked them (open-ledger: by symbol)', async () => {
    const l = await make()
    for (const [i, c] of ['USD', 'EUR', 'GBP'].entries()) await l.transfer({ ref: `f${i}`, from: '@funding', to: 'A', amount: 1n, currency: c })
    await l.transfer({ ref: 'f9', from: '@funding', to: 'A', amount: 1n, currency: 'USD' })
    // open-ledger lists a wallet's balances by symbol and keeps no first booking (decision 925).
    assert.deepEqual(Object.keys(await l.balances('A')), store === 'open-ledger' ? ['EUR', 'GBP', 'USD'] : ['USD', 'EUR', 'GBP'])
  })

  test('a reservation lowers available, not the balance; commit books it, release frees it', async () => {
    const l = await make()
    await l.transfer({ ref: 'f', from: '@funding', to: 'A', amount: 1000n, currency: 'EUR' })
    await l.reserve({ ref: 'r1', account: 'A', amount: 300n, currency: 'EUR' })
    await l.reserve({ ref: 'r2', account: 'A', amount: 200n, currency: 'EUR' })
    assert.deepEqual(await l.balances('A'), { EUR: { balance: 1000n, available: 500n } })
    await l.commit('r1', 'B')
    assert.deepEqual(await l.balances('A'), { EUR: { balance: 700n, available: 500n } })
    assert.deepEqual(await l.balances('B'), { EUR: { balance: 300n, available: 300n } })
    await l.release('r2')
    assert.equal(await l.available('A', 'EUR'), 700n)
    await l.release('r2') // releasing twice is harmless
    await assert.rejects(l.commit('r2', 'B'), /no reservation r2/)
    await assert.rejects(l.commit('r1', 'B'), /no reservation r1/, 'a reservation is booked once')
  })

  test('more than available is InsufficientFunds and changes nothing', async () => {
    const l = await make()
    await l.transfer({ ref: 'f', from: '@funding', to: 'A', amount: 100n, currency: 'EUR' })
    await l.reserve({ ref: 'r', account: 'A', amount: 60n, currency: 'EUR' })
    await assert.rejects(l.reserve({ ref: 'r2', account: 'A', amount: 41n, currency: 'EUR' }), InsufficientFunds)
    await assert.rejects(l.transfer({ ref: 't', from: 'A', to: 'B', amount: 41n, currency: 'EUR' }), InsufficientFunds)
    await assert.rejects(l.transfer({ ref: 't', from: 'A', to: 'B', amount: 1n, currency: 'USD' }), InsufficientFunds, 'funds are per currency')
    assert.deepEqual(await l.balances('A'), { EUR: { balance: 100n, available: 40n } })
    assert.deepEqual(await l.balances('B'), {})
    await l.transfer({ ref: 't', from: 'A', to: 'B', amount: 40n, currency: 'EUR' })
    assert.equal(await l.available('A', 'EUR'), 0n, 'exactly available is allowed')
  })

  test('amounts must be positive and a reservation ref is unique', async () => {
    const l = await make()
    await assert.rejects(l.reserve({ ref: 'z', account: '@x', amount: 0n, currency: 'EUR' }), /positive/)
    await assert.rejects(l.transfer({ ref: 'z', from: '@x', to: 'A', amount: -1n, currency: 'EUR' }), /positive/)
    await l.reserve({ ref: 'r', account: '@x', amount: 5n, currency: 'EUR' })
    await assert.rejects(l.reserve({ ref: 'r', account: '@x', amount: 5n, currency: 'EUR' }), /reservation r exists/)
    await assert.rejects(l.transfer({ ref: 'r', from: '@x', to: 'A', amount: 5n, currency: 'EUR' }), /reservation r exists/)
    assert.equal(await l.available('@x', 'EUR'), -5n, 'a system account may reserve beyond its balance')
  })

  test('every booking is two postings, the debit first; a transfer to itself nets to zero', async () => {
    const l = await make()
    await l.transfer({ ref: 'f', from: '@funding', to: 'A', amount: 100n, currency: 'EUR' })
    await l.reserve({ ref: 'r', account: 'A', amount: 30n, currency: 'EUR' })
    await l.commit('r', 'B')
    await l.transfer({ ref: 's', from: 'B', to: 'B', amount: 10n, currency: 'EUR' })
    assert.deepEqual(await postings(l), [
      { ref: 'f', account: '@funding', currency: 'EUR', amount: -100n }, { ref: 'f', account: 'A', currency: 'EUR', amount: 100n },
      { ref: 'r', account: 'A', currency: 'EUR', amount: -30n }, { ref: 'r', account: 'B', currency: 'EUR', amount: 30n },
      { ref: 's', account: 'B', currency: 'EUR', amount: -10n }, { ref: 's', account: 'B', currency: 'EUR', amount: 10n },
    ])
    assert.deepEqual(await l.balances('B'), { EUR: { balance: 30n, available: 30n } })
  })

  test('amounts beyond 2^53 stay exact (open-ledger: refused)', async () => {
    const l = await make()
    const big = 2n ** 60n + 7n
    if (store === 'open-ledger') {
      // open-ledger books JSON numbers (decision 925): beyond 2^53-1 is refused, not rounded.
      await assert.rejects(l.transfer({ ref: 'f', from: '@funding', to: 'A', amount: big, currency: 'EUR' }), RangeError)
      await l.transfer({ ref: 'f', from: '@funding', to: 'A', amount: 2n ** 53n - 1n, currency: 'EUR' })
      assert.equal(await l.available('A', 'EUR'), 2n ** 53n - 1n)
      return
    }
    await l.transfer({ ref: 'f', from: '@funding', to: 'A', amount: big, currency: 'EUR' })
    await l.transfer({ ref: 't', from: 'A', to: 'B', amount: big - 1n, currency: 'EUR' })
    assert.equal(await l.available('A', 'EUR'), 1n)
    assert.equal(await l.available('B', 'EUR'), big - 1n)
  })

  test('concurrent reservations on one account never overdraw', async () => {
    const l = await make()
    await l.transfer({ ref: 'f', from: '@funding', to: 'A', amount: 500n, currency: 'EUR' })
    const out = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => l.reserve({ ref: `r${i}`, account: 'A', amount: 100n, currency: 'EUR' })))
    assert.equal(out.filter((o) => o.status === 'fulfilled').length, 5)
    assert.ok(out.every((o) => o.status === 'fulfilled' || o.reason instanceof InsufficientFunds))
    assert.equal(await l.available('A', 'EUR'), 0n)
  })
})

test('toMinor and fromMinor', () => {
  assert.equal(toMinor('12.3'), 1230n)
  assert.equal(toMinor(' 0.05 '), 5n)
  assert.equal(toMinor('7'), 700n)
  assert.throws(() => toMinor('1.234'), /at most two decimals/)
  assert.throws(() => toMinor('-1'), /at most two decimals/)
  assert.equal(fromMinor(1230n), '12.30')
  assert.equal(fromMinor(-5n), '-0.05')
})
