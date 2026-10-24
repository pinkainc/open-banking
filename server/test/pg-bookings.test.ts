// Idempotent bookings across a crash (decisions 995-998): the process dies right after the
// ledger booked and before the service saved what it did (a collection SETTLED, a Bacs debit
// BOOKED, an FX deal COMPLETED, a payment off the rails' waiting list, a scheme credit
// remembered). The next run does it again; the booking key makes that book nothing twice,
// the outbox (decision 990) reports the first booking once. Registered when DATABASE_URL is set.
//
// The crash is a throw from the ledger call once the booking's transaction has committed: what
// runs after it in the service does not. (A thrown error lets go of the service's claim in its
// `finally`; a real crash leaves it until its TTL, and the rerun comes after that.)
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { makeIban } from '../src/iban.js'
import type { EmulatorOptions } from '../src/emulator.js'
import type { PgLedger } from '../src/pg/ledger.js'
import { C1, C2, DE_IBAN, balance, call, ddDrain, ddEntry, ddStatus, drain, jsonDrain, pain001, pain008, postgresStore, seed, setup, type Ctx } from './helpers.js'

const url = process.env.DATABASE_URL

/** From now on the ledger's `which` books, then the process "dies" (the call throws). */
function crashAfterBooking(ctx: Ctx, which: 'transfer' | 'commit') {
  const l = ctx.emulator.ledger as any
  const real = l[which].bind(l)
  l[which] = async (...a: unknown[]) => { await real(...a); throw new Error('crash after the booking') }
}
const postings = async (ctx: Ctx, account: string) => (await (ctx.emulator.ledger as PgLedger).postings()).filter((p) => p.account === account)
const notices = async (ctx: Ctx, as: string) => (await drain(ctx, as)).filter((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION').map(ddEntry)

if (url) describe('bookings across a crash before the service saves (Postgres)', () => {
  test('SEPA Direct Debit: a collection booked before the crash is settled after it, booked once', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const res = await call(a, { method: 'POST', url: '/direct-debit/collection', body: pain008([{ pmtInfId: 'PMT-BK1', txs: [{ endToEndId: 'E2E-BK1', amount: '10.00' }] }]) })
    assert.equal(res.statusCode, 202, res.body)
    await ddDrain(a); await ddDrain(a, C2.code)
    const before = [Number(await balance(a, C1.iban)), Number(await balance(a, C2.iban))]
    crashAfterBooking(a, 'transfer')
    a.clock.set('2026-03-12T10:30:00Z')
    assert.equal((await call(a, { method: 'POST', url: '/_sim/direct-debit/settle' })).statusCode, 500)
    assert.equal(Number(await balance(a, C2.iban)), before[1] - 10, 'booked')

    const b = await setup(opts)
    assert.deepEqual((await call(b, { url: '/_sim/direct-debit/collections' })).json().collections.map((x: any) => x.status), ['PENDING'], 'not saved')
    b.clock.set('2026-03-12T10:30:00Z')
    const settled = await call(b, { method: 'POST', url: '/_sim/direct-debit/settle' })
    assert.equal(settled.json().settled, 1)
    assert.deepEqual([Number(await balance(b, C1.iban)), Number(await balance(b, C2.iban))], [before[0] + 10, before[1] - 10], 'booked once')
    assert.equal((await postings(b, C2.iban)).filter((p) => p.amount === -1000n).length, 1)
    const creditor = await ddDrain(b)
    assert.deepEqual(creditor.map((m) => m.type).sort(), ['CREDIT_DEBIT_NOTIFICATION', 'DIRECT_DEBIT_OUTGOING'], 'one camt.054 (recovered) and the status report')
    assert.equal(ddStatus(creditor.find((m) => m.type === 'DIRECT_DEBIT_OUTGOING')!).blocks[0].txs[0].sts, 'ACSC')
    assert.deepEqual((await ddDrain(b, C2.code)).map((m) => ddEntry(m).ind), ['DBIT'])
    assert.deepEqual((await call(b, { url: '/_sim/direct-debit/collections' })).json().collections.map((x: any) => x.status), ['SETTLED'])
  })

  test('Bacs: a debit booked before the crash is BOOKED after it, debited once', async () => {
    const A = makeIban('GB', 'LHVB04031400001234')
    const U1 = { code: '09876543', country: 'GB', name: 'Connect Demo Customer 1' }
    const start = (opts: EmulatorOptions) => {
      const s = seed()
      s.customers.push({ ...U1, accounts: [{ iban: A, balances: { GBP: '1000.00' } }] })
      return setup(opts, s, { flavour: 'UK' })
    }
    const sim = async (ctx: Ctx, path: string, body: object = {}) => (await call(ctx, { method: 'POST', url: `/_sim/bacs${path}`, body, as: null }))
    const opts = await postgresStore()
    const a = await start(opts)
    const m = (await sim(a, '/mandates', { debtorIban: A, creditor: { name: 'Utility Company Ltd', sortCode: '202015', accountNumber: '55555555' }, serviceUserNumber: '539614', reference: 'TEST-BK' })).json()
    a.clock.set(`${m.entryDate}T18:35:00Z`); await sim(a, '/tick')
    a.clock.set('2026-03-12T09:00:00Z')
    const c = (await sim(a, '/collections', { mandateId: m.id, amount: '700.00' })).json()
    await drain(a, U1.code)
    crashAfterBooking(a, 'transfer')
    a.clock.set('2026-03-13T06:00:00Z')
    assert.equal((await sim(a, '/tick')).statusCode, 500)
    const gbp = async (ctx: Ctx) => Number(await ctx.emulator.ledger.available(A, 'GBP'))
    assert.equal(await gbp(a), 30000, 'booked')

    const b = await start(opts)
    b.clock.set('2026-03-13T06:00:00Z'); await sim(b, '/tick')
    assert.equal(await gbp(b), 30000, 'debited once')
    assert.equal((await postings(b, A)).filter((p) => p.amount === -70000n).length, 1)
    assert.deepEqual((await notices(b, U1.code)).map((e) => [e.ind, e.amount]), [['DBIT', '700.00']], 'one camt.054')
    const list = (await call(b, { url: '/_sim/bacs/collections', as: null })).json().collections
    assert.deepEqual(list.map((x: any) => [x.id, x.debit, x.attempts]), [[c.id, 'BOOKED', 1]])
  })

  for (const leg of ['commit', 'transfer'] as const) {
    test(`FX: a SPOT deal whose ${leg === 'commit' ? 'sold leg' : 'two legs'} booked before the crash is COMPLETED after it, each leg once`, async () => {
      const post = async (ctx: Ctx, path: string, body: object) => {
        const res = await call(ctx, { method: 'POST', url: path, body })
        assert.equal(res.statusCode, 202, res.body)
        return (await jsonDrain(ctx)).filter((m) => m.requestId === res.headers['message-request-id']).map((m) => m.json as any)
      }
      const opts = await postgresStore()
      const a = await setup(opts)
      const r = `BK-FX-${leg}`
      await post(a, '/fx/trade-offer', { requestReference: r, accountIBAN: C1.iban, currencyFrom: 'EUR', currencyTo: 'USD', amountFrom: 100, tenor: 'SPOT' })
      assert.equal((await post(a, '/fx/trade-offer-confirmation', { requestReference: r, confirm: true }))[0].tradeStatus, 'SETTLEMENT_PENDING')
      const [eur, usd] = [Number(await balance(a, C1.iban)), Number(await balance(a, C1.iban, 'USD'))]
      const credits = async (ctx: Ctx) => (await postings(ctx, C1.iban)).filter((p) => p.currency === 'USD' && p.amount > 0n).length
      const credits0 = await credits(a)
      crashAfterBooking(a, leg)
      a.clock.set('2026-03-12T06:00:00Z')
      assert.equal((await call(a, { method: 'POST', url: '/_sim/fx/settle' })).statusCode, 500)

      const b = await setup(opts)
      b.clock.set('2026-03-12T06:00:00Z')
      assert.equal((await call(b, { method: 'POST', url: '/_sim/fx/settle' })).json().settled, 1)
      assert.equal(Number(await balance(b, C1.iban)), eur - 100, 'sold once')
      const bought = Number(await balance(b, C1.iban, 'USD')) - usd
      assert.ok(bought > 0)
      assert.equal(await credits(b), credits0 + 1, 'bought once')
      const msgs = await drain(b)
      assert.deepEqual(msgs.filter((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION').map((m) => ddEntry(m).ind).sort(), ['CRDT', 'DBIT'], 'one camt.054 per leg')
      assert.deepEqual(msgs.filter((m) => m.type === 'FX_TRADE_OFFER_CONFIRMATION').map((m) => JSON.parse(m.body).tradeStatus), ['COMPLETED'])
      assert.equal((await call(await setup(opts), { method: 'POST', url: '/_sim/fx/settle' })).json().settled, 0)
    })
  }

  test('a payment: settled at the rails, booked before the crash, reported after it when the outcome comes again, booked once', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    await call(a, { method: 'POST', url: '/_sim/rails/defer', body: {} })
    const before = Number(await balance(a, C1.iban))
    assert.equal((await call(a, { method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '7.00', creditorIban: DE_IBAN }] }]) })).statusCode, 202)
    await drain(a)
    const [ref] = await a.emulator.engine.atRails()
    crashAfterBooking(a, 'commit')
    await assert.rejects(a.emulator.engine.settle(ref, { status: 'settled' }), /crash/)
    assert.equal(Number(await balance(a, C1.iban)), before - 7, 'booked')

    const b = await setup(opts)
    assert.deepEqual(await b.emulator.engine.atRails(), [ref], 'still waiting: booked before the record goes')
    assert.equal(await b.emulator.engine.settle(ref, { status: 'settled' }), true)
    assert.equal(await b.emulator.engine.settle(ref, { status: 'settled' }), false)
    assert.equal(Number(await balance(b, C1.iban)), before - 7, 'booked once')
    assert.equal((await postings(b, C1.iban)).filter((p) => p.ref === ref).length, 1)
    const msgs = await drain(b)
    assert.deepEqual(msgs.filter((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION').map((m) => ddEntry(m).ind), ['DBIT'], 'one camt.054 (recovered)')
    const sts = msgs.filter((m) => m.type === 'PAYMENT').map((m) => /<TxSts>(\w+)<\/TxSts>/.exec(m.body)?.[1])
    assert.deepEqual(sts, ['ACSC'])
  })

  test('a scheme credit booked before the crash is booked once when it comes again, under its first servicer ref', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const before = Number(await balance(a, C2.iban))
    const credit = { ref: 'BRIDGE-BK-1', iban: C2.iban, amount: 700n, currency: 'EUR', scheme: 'SEPA' as const, debtor: { name: 'Outside Payer', iban: DE_IBAN }, remittance: 'crash' }
    crashAfterBooking(a, 'transfer')
    await assert.rejects(a.emulator.engine.received(credit), /crash/)
    const [first] = (await postings(a, C2.iban)).filter((p) => p.amount === 700n)

    const b = await setup(opts)
    assert.deepEqual(await b.emulator.engine.received(credit), { status: 'booked', servicerRef: first.ref })
    assert.equal(Number(await balance(b, C2.iban)), before + 7, 'booked once')
    assert.equal((await b.emulator.journal.entries(C2.iban, 0, Infinity)).filter((e) => e.remittance === 'crash').length, 1)
  })
})
