// Rails that answer `accepted` and settle later (decisions 930–932): the engine books and
// reports exactly as with an immediate outcome, only later. The simulator's deferred mode
// (/_sim/rails/defer, /_sim/rails/deliver) and a test double that calls back before its
// answer; credits from the scheme through the same events, once per ref.
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { many } from '../src/xml.js'
import { SimulatorRails, type OutgoingPayment, type RailsAnswer, type RailsEvents } from '../src/rails.js'
import { C1, C2, DE_IBAN, balance, call, drain, pain001, setup, type Ctx, type TxSpec } from './helpers.js'

let ctx: Ctx
beforeEach(async () => { ctx = await setup() })

async function messages(c = ctx, as = C1.code) {
  const msgs = await drain(c, as)
  return {
    reports: msgs.filter((m) => m.type === 'PAYMENT').map((m) => {
      const r = m.doc.Document.CstmrPmtStsRpt
      return {
        grpSts: r.OrgnlGrpInfAndSts.GrpSts as string | undefined,
        txs: many(r.OrgnlPmtInfAndSts).flatMap((b: any) => many(b.TxInfAndSts)).map((t: any) => ({
          sts: t.TxSts as string, reason: t.StsRsnInf?.AddtlInf as string | undefined, scheme: t.OrgnlTxRef?.PmtTpInf?.SvcLvl?.Prtry as string | undefined,
          ref: t.AcctSvcrRef as string | undefined, instrId: t.OrgnlInstrId as string | undefined,
        })),
      }
    }),
    notes: msgs.filter((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION').map((m) => {
      const n = m.doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn
      return { ind: n.Ntry.CdtDbtInd as string, amount: String(n.Ntry.Amt['#text'] ?? n.Ntry.Amt), ref: n.Ntry.AcctSvcrRef as string, scheme: /<Prtry><Cd>([A-Z0-9]+)<\/Cd><\/Prtry>/.exec(m.body)?.[1] }
    }),
  }
}
const pay = async (txs: TxSpec[], c = ctx) => {
  const res = await call(c, { method: 'POST', url: '/payment', body: pain001([{ txs }]) })
  assert.equal(res.statusCode, 202, res.body)
}
const sim = (url: string, body: object = {}, c = ctx) => call(c, { method: 'POST', url: `/_sim/rails/${url}`, body })
const held = async () => (await call(ctx, { url: '/_sim/rails/held' })).json().payments as { ref: string; outcome: { status: string } }[]
const available = async (iban: string) => (await call(ctx, { url: `/_sim/accounts/${iban}` })).json().balances.EUR.available as string
/** Report statuses and notes without the refs (they differ between two runs). */
const shape = (m: Awaited<ReturnType<typeof messages>>) => ({
  reports: m.reports.map((r) => ({ grpSts: r.grpSts, txs: r.txs.map((t) => [t.sts, t.scheme, t.reason]) })),
  notes: m.notes.map((n) => [n.ind, n.amount, n.scheme]),
})

describe('deferred simulator rails: accepted, then the outcome (decision 931)', () => {
  test('settled later: ACSP now; ACSC + camt.054 DBIT on delivery, the same as at once', async () => {
    // At once, for comparison.
    const now = await setup()
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }], now)
    const immediate = await messages(now)

    assert.deepEqual((await sim('defer')).json(), { deferred: true })
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    const first = await messages()
    assert.deepEqual(first.reports.map((r) => r.txs.map((t) => t.sts)), [['ACSP']])
    assert.deepEqual(first.notes, [])
    assert.equal(await available(C1.iban), '9993.00', 'reserved')
    assert.equal(await balance(ctx, C1.iban), '10000.00', 'not booked')
    const h = await held()
    assert.deepEqual(h.map((x) => x.outcome.status), ['settled'])
    assert.equal(h[0].ref, first.reports[0].txs[0].ref)
    assert.deepEqual(ctx.emulator.engine.atRails(), [h[0].ref])

    assert.deepEqual((await sim('deliver')).json(), { delivered: 1 })
    const later = await messages()
    assert.deepEqual(shape({ reports: [...first.reports, ...later.reports], notes: later.notes }), shape(immediate))
    assert.equal(later.reports[0].txs[0].ref, h[0].ref, 'one AcctSvcrRef throughout')
    assert.equal(later.notes[0].ref, h[0].ref)
    assert.equal(await balance(ctx, C1.iban), '9993.00')
    assert.deepEqual(ctx.emulator.engine.atRails(), [])
  })

  test('rejected after accept: RJCT with the scheme reason, funds released', async () => {
    await sim('defer')
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    await messages()
    await sim('deliver', { reject: 'Account closed.' })
    const r = await messages()
    assert.deepEqual(r.reports.map((x) => x.txs.map((t) => [t.sts, t.reason])), [[['RJCT', 'Account closed.']]])
    assert.deepEqual(r.notes, [])
    assert.equal(await available(C1.iban), '10000.00')
    assert.equal(await balance(ctx, C1.iban), '10000.00')
  })

  test('INST unavailable after accept: ACWC, SEPA accepted again, then ACSC (SEPA)', async () => {
    await sim('defer')
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    const first = await messages()
    assert.deepEqual(first.reports.map((x) => x.txs.map((t) => [t.sts, t.scheme])), [[['ACSP', 'INST']]])
    await sim('deliver', { unavailable: true })
    const fallback = await messages()
    assert.deepEqual(fallback.reports.map((x) => x.txs.map((t) => [t.sts, t.scheme, t.reason])), [[['ACWC', 'SEPA', 'Payment processed as European payment']]])
    assert.equal(fallback.notes.length, 0)
    assert.equal((await held()).length, 1, 'the SEPA attempt waits at the rails')
    await sim('deliver')
    const done = await messages()
    assert.deepEqual(done.reports.map((x) => x.txs.map((t) => [t.sts, t.scheme])), [[['ACSC', 'SEPA']]])
    assert.deepEqual(done.notes.map((n) => [n.ind, n.amount, n.scheme]), [['DBIT', '7.00', 'SEPA']])
    const sent = (await call(ctx, { url: '/_sim/rails/sent' })).json().payments
    assert.deepEqual(sent.map((p: any) => p.scheme), ['INST', 'SEPA'])
  })

  test('requested INST unavailable after accept: RJCT "Payment declined, try European payment.", released', async () => {
    await sim('defer')
    await pay([{ amount: '7.00', creditorIban: DE_IBAN, scheme: 'INST' }])
    await messages()
    await sim('deliver', { unavailable: true })
    assert.deepEqual((await messages()).reports.map((x) => x.txs.map((t) => [t.sts, t.reason])), [[['RJCT', 'Payment declined, try European payment.']]])
    assert.equal(await available(C1.iban), '10000.00')
  })

  test('two payments in a file settle one by one: one report each, only that payment', async () => {
    await sim('defer')
    await pay([{ amount: '1.00', creditorIban: DE_IBAN, instrId: 'A' }, { amount: '2.00', creditorIban: DE_IBAN, instrId: 'B' }])
    const first = await messages()
    assert.equal(first.reports[0].grpSts, 'ACSP')
    const [a, b] = (await held()).map((x) => x.ref)
    await sim('deliver', { ref: b, reject: 'No such account.' })
    await sim('deliver', { ref: a })
    const r = await messages()
    assert.deepEqual(r.reports.map((x) => ({ grpSts: x.grpSts, txs: x.txs.map((t) => [t.instrId, t.sts]) })), [
      { grpSts: undefined, txs: [['B', 'RJCT']] }, { grpSts: undefined, txs: [['A', 'ACSC']] },
    ])
    assert.deepEqual(r.notes.map((n) => [n.ind, n.amount]), [['DBIT', '1.00']])
    assert.equal(await available(C1.iban), '9999.00')
  })

  test('a repeated outcome is ignored: nothing booked or reported twice', async () => {
    await sim('defer')
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    await messages()
    const [{ ref }] = await held()
    await sim('deliver')
    assert.equal((await messages()).notes.length, 1)
    assert.equal(await ctx.emulator.engine.settle(ref, { status: 'settled' }), false)
    assert.equal(await ctx.emulator.engine.settle(ref, { status: 'rejected', reason: 'late' }), false)
    assert.equal(await ctx.emulator.engine.settle('NOSUCHREF', { status: 'settled' }), false)
    assert.deepEqual(await messages(), { reports: [], notes: [] })
    assert.equal(await balance(ctx, C1.iban), '9993.00')
    assert.equal((await sim('deliver', { ref })).statusCode, 400)
  })

  test('manual review approved: continues to the rails, settles on delivery', async () => {
    await sim('defer')
    await pay([{ amount: '7.00', creditorIban: DE_IBAN, creditorName: 'Robba Bank' }])
    assert.deepEqual((await messages()).reports.map((x) => x.txs[0].sts), ['ACSP', 'PDNG'])
    const pending = (await call(ctx, { url: '/_sim/payments/pending' })).json().payments as any[]
    await call(ctx, { method: 'POST', url: '/_sim/payments/pending/approve', body: { refs: [pending[0].ref] } })
    assert.deepEqual(await messages(), { reports: [], notes: [] })
    await sim('deliver')
    const r = await messages()
    assert.deepEqual(r.reports.map((x) => x.txs[0].sts), ['ACSC'])
    assert.deepEqual(r.notes.map((n) => n.ind), ['DBIT'])
  })

  test('reset turns deferral off and forgets held outcomes', async () => {
    await sim('defer')
    await sim('reset')
    await pay([{ amount: '1.00', creditorIban: DE_IBAN }])
    assert.deepEqual((await messages()).reports.map((x) => x.txs[0].sts), ['ACSP', 'ACSC'])
    assert.deepEqual(await held(), [])
  })
})

/** Rails whose bridge calls back with the outcome before its own answer (accepted) arrives. */
class EagerRails extends SimulatorRails {
  #events?: RailsEvents
  override listen(e: RailsEvents) { this.#events = e; super.listen(e) }
  override async send(p: OutgoingPayment): Promise<RailsAnswer> {
    await this.#events!.outcome(p.ref, { status: 'settled' })
    return { status: 'accepted' }
  }
}

describe('outcome before the answer', () => {
  test('the callback wins; the late `accepted` changes nothing', async () => {
    const c = await setup({ rails: new EagerRails() })
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }], c)
    const r = await messages(c)
    assert.deepEqual(r.reports.map((x) => x.txs[0].sts), ['ACSP', 'ACSC'])
    assert.deepEqual(r.notes.map((n) => n.ind), ['DBIT'])
    assert.deepEqual(c.emulator.engine.atRails(), [])
    assert.equal(await balance(c, C1.iban), '9993.00')
  })
})

describe('credits from the scheme through the rails events (decision 932)', () => {
  const credit = (ref: string, iban = C2.iban) => (ctx.emulator.rails as SimulatorRails).credit({
    ref, iban, amount: 1234n, currency: 'EUR', scheme: 'INST', debtor: { name: 'Hans Muster', iban: DE_IBAN, bic: 'COBADEFFXXX' }, remittance: 'Invoice 7',
  })

  test('booked once per ref: camt.054 CRDT, a repeat answers the same AcctSvcrRef', async () => {
    const r = await credit('BRIDGE-1')
    assert.equal(r.status, 'booked')
    const again = await credit('BRIDGE-1')
    assert.deepEqual(again, r)
    const m = await messages(ctx, C2.code)
    assert.deepEqual(m.notes.map((n) => [n.ind, n.amount, n.scheme, n.ref]), [['CRDT', '12.34', 'INST', r.status === 'booked' ? r.servicerRef : '']])
    assert.equal(await balance(ctx, C2.iban), '112.34')
    assert.equal((await credit('BRIDGE-2')).status, 'booked')
    assert.equal(await balance(ctx, C2.iban), '124.68')
  })

  test('an account not here: returned AC01, nothing booked', async () => {
    assert.deepEqual(await credit('BRIDGE-3', 'EE127700771001260999'), { status: 'returned', code: 'AC01', reason: 'Incorrect account number.' })
    assert.deepEqual((await messages(ctx, C2.code)).notes, [])
  })
})
