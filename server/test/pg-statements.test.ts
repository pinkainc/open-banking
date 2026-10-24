// Statements in Postgres beyond the shared semantics (the whole suite runs on PgJournal
// with OPEN_BANKING_STORE=postgres): an emulator restarted on the same namespace reports
// the bookings made before the restart, and open ranges and namespaces behave as in
// memory. Registered only when DATABASE_URL is set.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ManualClock } from '../src/clock.js'
import { PgJournal } from '../src/pg/journal.js'
import { C1, C2, call, pain001, pgDb, postgresStore, report, setup } from './helpers.js'
import { many, text } from '../src/xml.js'

const url = process.env.DATABASE_URL

if (url) describe('PgJournal (Postgres)', () => {
  test('an emulator restarted the next day lists yesterday\'s bookings in the statement', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const r = await call(a, { method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '12.34', endToEndId: 'E2E-RESTART' }] }]) })
    assert.equal(r.statusCode, 202, r.body)

    // The next day, a new process on the same namespace.
    const b = await setup({ ...opts, clock: new ManualClock('2026-03-11T08:00:00Z') })
    const { msgs } = await report(b, { kind: 'statement', frDt: '2026-03-10', toDt: '2026-03-10' })
    assert.equal(msgs.length, 1)
    const st = msgs[0].doc.Document.BkToCstmrStmt.Stmt
    const stmts = many<any>(st)
    const eur = stmts.find((s) => String(s.Acct.Ccy) === 'EUR')
    const entries = many<any>(eur.Ntry)
    const debit = entries.find((e) => e.CdtDbtInd === 'DBIT')
    assert.ok(debit, 'the payment made before the restart')
    assert.equal(text(debit.Amt), '12.34')
    assert.equal(String(debit.NtryDtls.TxDtls.Refs.EndToEndId), 'E2E-RESTART')
    // Opening (funding before the day starts: none) and closing balances reconcile.
    const bal = (code: string) => many<any>(eur.Bal).find((x) => x.Tp.CdOrPrtry.Cd === code)
    assert.equal(text(bal('CLBD').Amt), (10000 - 12.34).toFixed(2))

    // The payee's account in the same namespace sees the credit too.
    const c = (await b.emulator.journal.entries(C2.iban, 0, Infinity)).filter((e) => e.endToEndId === 'E2E-RESTART')
    assert.deepEqual(c.map((e) => [e.direction, e.amount, e.bookedAt.toISOString()]), [['CRDT', 1234n, '2026-03-10T08:00:00.000Z']])
  })

  test('namespaces keep journals apart; entries round-trip, ordered by time then booking order', async () => {
    const db = await pgDb()
    const [j1, j2] = [new PgJournal(db), new PgJournal(db)]
    const at = new Date('2026-03-10T08:00:00Z')
    const base = { owner: { name: 'X', code: C1.code }, currency: 'EUR', scheme: 'SEPA', counterparty: { name: 'Y', iban: C2.iban } }
    const e2 = await j1.record({ ...base, account: C1.iban, direction: 'DBIT', amount: 250n, servicerRef: 'R2', bookedAt: new Date(at.getTime() + 1000) })
    const e1 = await j1.record({ ...base, account: C1.iban, direction: 'CRDT', amount: 1000n, servicerRef: 'R1', bookedAt: at, remittance: 'first' })
    const e3 = await j1.record({ ...base, account: C1.iban, direction: 'CRDT', amount: 5n, servicerRef: 'R3', bookedAt: at, currency: 'USD' })
    assert.ok(e1.seq > e2.seq && e3.seq > e1.seq)
    assert.deepEqual((await j1.entries(C1.iban, -Infinity, Infinity)).map((e) => e.servicerRef), ['R1', 'R3', 'R2'])
    assert.deepEqual(await j1.entries(C1.iban, at.getTime(), at.getTime() + 1), [e1, e3])
    assert.deepEqual(await j2.entries(C1.iban, -Infinity, Infinity), [])
    assert.deepEqual(await j1.balancesBefore(C1.iban, Infinity), new Map([['EUR', 750n], ['USD', 5n]]))
    assert.deepEqual(await j1.balancesBefore(C1.iban, at.getTime() + 1000), new Map([['EUR', 1000n], ['USD', 5n]]))
    assert.equal(await j1.debits([C1.iban, C2.iban], 'EUR', at.getTime(), at.getTime() + 1000), 250n)
    assert.equal(await j1.debits([C1.iban], 'EUR', at.getTime(), at.getTime() + 999), 0n)
    assert.equal(await j2.debits([C1.iban], 'EUR', 0, Infinity), 0n)
  })
})
