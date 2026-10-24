// The Postgres ledger beyond the shared semantics (ledger.test.ts runs those against both
// stores): two processes (two pools) on one namespace never overdraw, a transaction that
// fails leaves nothing, namespaces keep ledgers apart, postings are append-only and take
// the emulator's clock. Registered only when DATABASE_URL is set (npm run check sets it).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, describe, test } from 'node:test'
import { ManualClock } from '../src/clock.js'
import { InsufficientFunds } from '../src/ledger.js'
import { PgDb } from '../src/pg/db.js'
import { PgLedger } from '../src/pg/ledger.js'
import { C1, C2, pgDb, postgresStore, setup } from './helpers.js'

const url = process.env.DATABASE_URL

if (url) describe('PgLedger (Postgres)', () => {
  const pools: PgDb[] = []
  after(async () => { for (const p of pools) await p.close() })
  const pool = async () => { const p = await PgDb.connect(url, { max: 4 }); pools.push(p); return p }

  test('two instances on two pools hammering one account never overdraw', async () => {
    const namespace = randomUUID()
    const [a, b] = [new PgLedger(await pool(), { namespace }), new PgLedger(await pool(), { namespace })]
    await a.transfer({ ref: 'fund', from: '@funding', to: 'alice', amount: 500n, currency: 'EUR' })
    const out = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => {
      const l = i % 2 ? b : a
      return i % 4 < 2
        ? l.reserve({ ref: `r${i}`, account: 'alice', amount: 50n, currency: 'EUR' })
        : l.transfer({ ref: `t${i}`, from: 'alice', to: 'bob', amount: 50n, currency: 'EUR' })
    }))
    assert.equal(out.filter((o) => o.status === 'fulfilled').length, 10)
    assert.ok(out.every((o) => o.status === 'fulfilled' || o.reason instanceof InsufficientFunds), 'only InsufficientFunds, no deadlock or serialisation error')
    assert.equal(await a.available('alice', 'EUR'), 0n)
    assert.equal(await b.available('alice', 'EUR'), 0n)
    const bob = (await b.balances('bob')).EUR?.balance ?? 0n
    assert.equal((await a.balances('alice')).EUR.balance + bob, 500n, 'money is neither made nor lost')
  })

  test('bookings in both directions at once between two accounts do not deadlock', async () => {
    const namespace = randomUUID()
    const [a, b] = [new PgLedger(await pool(), { namespace }), new PgLedger(await pool(), { namespace })]
    for (const who of ['x', 'y']) await a.transfer({ ref: `f-${who}`, from: '@funding', to: who, amount: 1000n, currency: 'EUR' })
    await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? b : a).transfer({ ref: `t${i}`, from: i % 2 ? 'x' : 'y', to: i % 2 ? 'y' : 'x', amount: 10n, currency: 'EUR' })))
    assert.equal(await a.available('x', 'EUR'), 1000n)
    assert.equal(await a.available('y', 'EUR'), 1000n)
    assert.equal((await a.postings()).length, 2 * 32)
  })

  test('a failed transaction leaves nothing behind', async () => {
    const l = new PgLedger(await pgDb())
    await l.transfer({ ref: 'f', from: '@funding', to: 'A', amount: 100n, currency: 'EUR' })
    // The debit's row is updated before the posting insert fails (ref null is refused).
    await assert.rejects(l.transfer({ ref: null as unknown as string, from: 'A', to: 'B', amount: 40n, currency: 'EUR' }))
    assert.deepEqual(await l.balances('A'), { EUR: { balance: 100n, available: 100n } })
    assert.deepEqual(await l.balances('B'), {})
    assert.equal((await l.postings()).length, 2)
    await assert.rejects(l.transfer({ ref: 'g', from: 'A', to: 'B', amount: 101n, currency: 'EUR' }), InsufficientFunds)
    assert.equal((await l.postings()).length, 2)
  })

  test('namespaces keep ledgers apart; one namespace is one ledger', async () => {
    const db = await pgDb()
    const [n1, n2] = [randomUUID(), randomUUID()]
    const a = new PgLedger(db, { namespace: n1 })
    await a.transfer({ ref: 'f', from: '@funding', to: 'A', amount: 100n, currency: 'EUR' })
    await a.reserve({ ref: 'r', account: 'A', amount: 30n, currency: 'EUR' })
    const other = new PgLedger(db, { namespace: n2 })
    assert.deepEqual(await other.balances('A'), {})
    await assert.rejects(other.commit('r', 'B'), /no reservation r/)
    await other.reserve({ ref: 'r', account: '@x', amount: 1n, currency: 'EUR' }) // the same ref in another namespace
    const again = new PgLedger(db, { namespace: n1 })
    assert.deepEqual(await again.balances('A'), { EUR: { balance: 100n, available: 70n } })
    await again.commit('r', 'B')
    assert.equal(await a.available('B', 'EUR'), 30n)
  })

  test('postings are append-only and carry the clock time', async () => {
    const db = await pgDb()
    const clock = new ManualClock('2026-03-10T08:00:00Z')
    const l = new PgLedger(db, { clock })
    await l.transfer({ ref: 'f', from: '@funding', to: 'A', amount: 100n, currency: 'EUR' })
    assert.deepEqual((await l.postings()).map((p) => p.at), [clock.now().getTime(), clock.now().getTime()])
    await assert.rejects(db.pool.query('update ledger_postings set amount = 0 where ns = $1', [l.namespace]), /append-only/)
    await assert.rejects(db.pool.query('delete from ledger_postings where ns = $1', [l.namespace]), /append-only/)
  })
})

if (url) test('an emulator restarted on the same Postgres namespace keeps its money and does not fund the seed again', async () => {
  const store = await postgresStore() // one namespace for both
  const a = await setup(store)
  const before = (await a.emulator.ledger.balances(C1.iban)).EUR
  assert.ok(before && before.balance > 0n, 'the seed funds C1')
  await a.emulator.ledger.transfer({ ref: 'spend', from: C1.iban, to: C2.iban, amount: 100n, currency: 'EUR' })
  const b = await setup(store)
  assert.equal((await b.emulator.ledger.balances(C1.iban)).EUR.balance, before.balance - 100n)
})
