// Payment engine state in Postgres beyond the shared semantics (the whole suite runs on the
// keyed store with OPEN_BANKING_STORE=postgres): an emulator restarted on the same
// namespace refuses a file and a payment submitted before the restart as duplicates,
// decides payments parked before it (SCA and manual review), still counts an in-flight
// debit against the limits and books a scheme credit once. Registered only when DATABASE_URL is set.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { many } from '../src/xml.js'
import { C1, C2, DE_IBAN, call, drain, pain001, postgresStore, seed, setup, type Ctx } from './helpers.js'

const url = process.env.DATABASE_URL

async function pay(ctx: Ctx, xml: string) {
  const res = await call(ctx, { method: 'POST', url: '/payment', body: xml })
  assert.equal(res.statusCode, 202, res.body)
  return messages(ctx)
}
async function messages(ctx: Ctx) {
  const msgs = await drain(ctx, C1.code)
  const reports = msgs.filter((m) => m.type === 'PAYMENT').map((m) => {
    const r = m.doc.Document.CstmrPmtStsRpt
    return {
      grpSts: r.OrgnlGrpInfAndSts.GrpSts as string | undefined, grpReason: r.OrgnlGrpInfAndSts.StsRsnInf?.AddtlInf as string | undefined,
      txs: many<any>(r.OrgnlPmtInfAndSts).flatMap((b) => many<any>(b.TxInfAndSts)).map((t) => ({ sts: t.TxSts as string, reason: t.StsRsnInf?.AddtlInf as string | undefined, ref: t.AcctSvcrRef as string | undefined })),
    }
  })
  return { reports, notes: msgs.filter((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION').length }
}
const available = async (ctx: Ctx, iban: string) => (await call(ctx, { url: `/_sim/accounts/${iban}` })).json().balances.EUR.available as string

if (url) describe('payment engine state across a restart (Postgres)', () => {
  test('a file and a payment submitted before the restart are refused as duplicates', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const file = pain001([{ txs: [{ amount: '1.00', instrId: 'INSTR-G-1' }] }], { msgId: 'MSG-G-1' })
    assert.equal((await pay(a, file)).reports[0].txs[0].sts, 'ACSC')

    const b = await setup(opts)
    const again = await pay(b, file)
    assert.deepEqual([again.reports[0].grpSts, again.reports[0].grpReason], ['RJCT', 'Duplicate message.'])
    const same = await pay(b, pain001([{ txs: [{ amount: '1.00', instrId: 'INSTR-G-1' }] }], { msgId: 'MSG-G-2' }))
    assert.deepEqual(same.reports[0].txs.map((t) => [t.sts, t.reason]), [['RJCT', 'Duplicate payment.']])
    // Another amount under the same InstrId is another payment (decision 525).
    assert.equal((await pay(b, pain001([{ txs: [{ amount: '2.00', instrId: 'INSTR-G-1' }] }], { msgId: 'MSG-G-3' }))).reports[0].txs[0].sts, 'ACSC')
  })

  test('a payment waiting for SCA before the restart is approved after it, once', async () => {
    const opts = await postgresStore()
    const s = seed()
    s.customers[0].payments = 'PENDING'
    const a = await setup(opts, s)
    const first = await pay(a, pain001([{ txs: [{ amount: '3.00', endToEndId: 'E2E-SCA' }, { amount: '4.00' }] }]))
    assert.deepEqual(first.reports[0].txs.map((t) => t.sts), ['PDNG', 'PDNG'])
    const [ref, other] = first.reports[0].txs.map((t) => t.ref!)

    const b = await setup(opts, s)
    const list = (await call(b, { url: '/_sim/payments/pending' })).json().payments
    assert.deepEqual(list.map((p: any) => [p.ref, p.kind, p.amount]), [[ref, 'SCA', '3.00'], [other, 'SCA', '4.00']])
    const before = await available(b, C1.iban)
    assert.equal((await call(b, { method: 'POST', url: '/_sim/payments/pending/approve', as: null, body: { refs: [ref] } })).statusCode, 200)
    const done = await messages(b)
    assert.deepEqual(done.reports.map((r) => r.txs.map((t) => [t.sts, t.ref])), [[['ACSC', ref]]])
    assert.equal(done.notes, 1, 'the camt.054 debit to the payer')
    assert.equal(Number(await available(b, C1.iban)), Number(before) - 3)
    assert.equal((await call(b, { method: 'POST', url: '/_sim/payments/pending/approve', as: null, body: { refs: [ref] } })).statusCode, 404, 'decided once')
    // Refused after a second restart: the other one, rejected by the customer.
    const c = await setup(opts, s)
    assert.equal((await call(c, { method: 'POST', url: '/_sim/payments/pending/reject', as: null, body: { refs: [other] } })).statusCode, 200)
    assert.deepEqual((await messages(c)).reports.map((r) => r.txs.map((t) => [t.sts, t.reason])), [[['RJCT', 'Requested by customer.']]])
    assert.deepEqual((await call(c, { url: '/_sim/payments/pending' })).json().payments, [])
  })

  test('a payment in manual review counts against the limits after the restart and settles on approval', async () => {
    const opts = await postgresStore()
    const s = seed()
    s.customers[0].limits = { daily: '25.00' }
    const a = await setup(opts, s)
    const review = await pay(a, pain001([{ txs: [{ amount: '20.00', creditorIban: DE_IBAN, creditorName: 'Robba Bank' }] }]))
    assert.deepEqual(review.reports.map((r) => r.txs.map((t) => t.sts)), [['ACSP'], ['PDNG']])
    const ref = review.reports[0].txs[0].ref!

    const b = await setup(opts, s)
    // 20.00 reserved and not booked: 10.00 more is over the daily 25.00.
    const over = await pay(b, pain001([{ txs: [{ amount: '10.00' }] }]))
    assert.deepEqual(over.reports[0].txs.map((t) => [t.sts, t.reason]), [['RJCT', 'Insufficient daily limit available.']])
    const tx = await call(b, { url: `/_sim/payments/pending` })
    assert.deepEqual(tx.json().payments.map((p: any) => [p.ref, p.kind]), [[ref, 'REVIEW']])
    assert.equal((await call(b, { method: 'POST', url: '/_sim/payments/pending/approve', as: null, body: { refs: [ref] } })).statusCode, 200)
    assert.deepEqual((await messages(b)).reports.map((r) => r.txs.map((t) => t.sts)), [['ACSC']])
    // Booked now: in the journal and no longer in flight, so the limit stays used, not doubled.
    assert.equal((await pay(b, pain001([{ txs: [{ amount: '5.00' }] }]))).reports[0].txs[0].sts, 'ACSC')
  })

  test('a scheme credit is booked once per ref across a restart', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const credit = { ref: 'BRIDGE-G-1', iban: C2.iban, amount: 700n, currency: 'EUR', scheme: 'SEPA' as const, debtor: { name: 'Outside Payer', iban: DE_IBAN }, remittance: 'once' }
    const first = await a.emulator.engine.received(credit)
    assert.equal(first.status, 'booked')
    const b = await setup(opts)
    assert.deepEqual(await b.emulator.engine.received(credit), first)
    const entries = (await b.emulator.journal.entries(C2.iban, 0, Infinity)).filter((e) => e.remittance === 'once')
    assert.equal(entries.length, 1)
  })
})
