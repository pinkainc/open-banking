// Rails that answer `accepted` and settle later (decisions 930–932): the engine books and
// reports exactly as with an immediate outcome, only later. The simulator's deferred mode
// (/_sim/rails/defer, /_sim/rails/deliver) and a test double that calls back before its
// answer; credits from the scheme through the same events, once per ref.
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { many } from '../src/xml.js'
import { FUNDING } from '../src/emulator.js'
import { SimulatorRails, type OutgoingPayment, type RailsAnswer, type RailsEvents } from '../src/rails.js'
import { C1, C2, DE_IBAN, FR_IBAN, balance, call, drain, pain001, postgresStore, setup, type Ctx, type TxSpec } from './helpers.js'

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
const available = async (iban: string, c = ctx) => (await call(c, { url: `/_sim/accounts/${iban}` })).json().balances.EUR.available as string
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
    assert.deepEqual(await ctx.emulator.engine.atRails(), [h[0].ref])

    assert.deepEqual((await sim('deliver')).json(), { delivered: 1 })
    const later = await messages()
    assert.deepEqual(shape({ reports: [...first.reports, ...later.reports], notes: later.notes }), shape(immediate))
    assert.equal(later.reports[0].txs[0].ref, h[0].ref, 'one AcctSvcrRef throughout')
    assert.equal(later.notes[0].ref, h[0].ref)
    assert.equal(await balance(ctx, C1.iban), '9993.00')
    assert.deepEqual(await ctx.emulator.engine.atRails(), [])
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
    assert.deepEqual(await c.emulator.engine.atRails(), [])
    assert.equal(await balance(c, C1.iban), '9993.00')
  })
})

/** Calls back `rejected`, then answers `settled`: a bridge contradicting itself. */
class ContradictingRails extends SimulatorRails {
  #events?: RailsEvents
  override listen(e: RailsEvents) { this.#events = e; super.listen(e) }
  override async send(p: OutgoingPayment): Promise<RailsAnswer> {
    await this.#events!.outcome(p.ref, { status: 'rejected', reason: 'Account closed.' })
    return { status: 'settled' }
  }
}

describe('outcome before the answer, another one (decision 1003)', () => {
  test('the callback stored first wins: RJCT, released; the immediate `settled` books nothing', async () => {
    const c = await setup({ rails: new ContradictingRails() })
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }], c)
    const r = await messages(c)
    assert.deepEqual(r.reports.map((x) => [x.txs[0].sts, x.txs[0].reason]), [['ACSP', undefined], ['RJCT', 'Account closed.']])
    assert.deepEqual(r.notes, [])
    assert.deepEqual(await c.emulator.engine.atRails(), [])
    assert.equal(await balance(c, C1.iban), '10000.00')
    assert.equal(await available(C1.iban, c), '10000.00')
  })
})

describe('two outcomes for one payment (decision 1003)', () => {
  test('a rejection while the settlement is being booked is refused; the settlement reports', async () => {
    await sim('defer')
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    await messages()
    const [ref] = await ctx.emulator.engine.atRails()
    const l = ctx.emulator.ledger as any
    const commit = l.commit.bind(l)
    let open!: () => void
    let reached!: () => void
    const gate = new Promise<void>((r) => { open = r })
    const atCommit = new Promise<void>((r) => { reached = r })
    l.commit = async (...a: unknown[]) => { reached(); await gate; return commit(...a) }
    const settling = ctx.emulator.engine.settle(ref, { status: 'settled' })
    await atCommit
    assert.equal(await ctx.emulator.engine.settle(ref, { status: 'rejected', reason: 'Scheme says no' }), false, 'another outcome than the stored one')
    open()
    assert.equal(await settling, true)
    const r = await messages()
    assert.deepEqual(r.reports.map((x) => x.txs[0].sts), ['ACSC'])
    assert.deepEqual(r.notes.map((n) => n.ind), ['DBIT'])
    assert.equal(await balance(ctx, C1.iban), '9993.00')
  })

  test('two at once: one applies, reports and balance agree', async () => {
    await sim('defer')
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    await messages()
    const [ref] = await ctx.emulator.engine.atRails()
    const applied = await Promise.all([
      ctx.emulator.engine.settle(ref, { status: 'rejected', reason: 'Scheme says no' }), ctx.emulator.engine.settle(ref, { status: 'settled' }),
    ])
    assert.equal(applied.filter(Boolean).length, 1)
    const r = await messages()
    const sts = r.reports.map((x) => x.txs[0].sts)
    if (applied[1]) {
      assert.deepEqual([sts, r.notes.length, await balance(ctx, C1.iban)], [['ACSC'], 1, '9993.00'])
    } else {
      assert.deepEqual([sts, r.notes.length, await balance(ctx, C1.iban), await available(C1.iban)], [['RJCT'], 0, '10000.00', '10000.00'])
    }
  })

  test('an outcome for another scheme than the waiting attempt is not applied', async () => {
    await sim('defer')
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    const [ref] = await ctx.emulator.engine.atRails()
    assert.equal(await ctx.emulator.engine.settle(ref, { status: 'settled' }, 'SEPA'), false, 'the INST attempt waits')
    assert.equal(await ctx.emulator.engine.settle(ref, { status: 'settled' }, 'INST'), true)
  })
})

describe('reconciliation after a timeout (decision 1002)', () => {
  test('answered `unknown`: ACSP and waiting; reconciled after a minute from what the rails tell: ACSC', async () => {
    assert.deepEqual((await sim('timeout')).json(), { timeouts: true })
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    assert.deepEqual((await messages()).reports.map((x) => x.txs[0].sts), ['ACSP'])
    const [ref] = await ctx.emulator.engine.atRails()
    assert.ok(ref)
    assert.equal(await available(C1.iban), '9993.00', 'reserved')
    assert.equal(await ctx.emulator.engine.reconcile(), 0, 'younger than a minute')
    ctx.clock.advance(61_000)
    assert.equal(await ctx.emulator.engine.reconcile(), 1)
    const r = await messages()
    assert.deepEqual(r.reports.map((x) => [x.txs[0].sts, x.txs[0].ref]), [['ACSC', ref]])
    assert.deepEqual(r.notes.map((n) => [n.ind, n.ref]), [['DBIT', ref]])
    assert.equal(await balance(ctx, C1.iban), '9993.00')
    assert.equal(await ctx.emulator.engine.reconcile({ minAgeMs: 0 }), 0, 'nothing left')
  })

  test('a rejection told by the rails: RJCT, released; a held payment keeps waiting until delivered', async () => {
    await sim('timeout')
    await sim('reject', { account: DE_IBAN, reason: 'Account closed.' })
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    await sim('defer')
    await pay([{ amount: '3.00', creditorIban: FR_IBAN }])
    await messages()
    assert.equal((await sim('reconcile')).json().settled, 1)
    assert.deepEqual((await messages()).reports.map((x) => [x.txs[0].sts, x.txs[0].reason]), [['RJCT', 'Account closed.']])
    assert.equal((await held()).length, 1, 'the deferred one is held: accepted at the rails')
    assert.equal((await sim('reconcile')).json().settled, 0)
    assert.equal((await sim('deliver')).json().delivered, 1)
    assert.deepEqual((await messages()).reports.map((x) => x.txs[0].sts), ['ACSC'])
    assert.equal(await available(C1.iban), '9997.00')
  })

  test('never taken by the rails (absent): unavailable, so the automatic INST goes as SEPA', async () => {
    await sim('timeout')
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    await messages()
    const rails = ctx.emulator.rails as SimulatorRails
    rails.sent.length = 0 // the rails never got it
    rails.timeouts(false)
    assert.equal(await ctx.emulator.engine.reconcile({ minAgeMs: 0 }), 1)
    const r = await messages()
    assert.deepEqual(r.reports.map((x) => x.txs.map((t) => [t.sts, t.scheme])), [[['ACWC', 'SEPA']], [['ACSC', 'SEPA']]])
    assert.deepEqual(rails.sent.map((p) => p.scheme), ['SEPA'])
    assert.equal(await balance(ctx, C1.iban), '9993.00')
  })

  test('reset turns timeouts off', async () => {
    await sim('timeout')
    await sim('reset')
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }])
    assert.deepEqual((await messages()).reports.map((x) => x.txs[0].sts), ['ACSP', 'ACSC'])
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

describe('recalls of credits received (camt.056, decision 1001)', () => {
  const rails = () => ctx.emulator.rails as SimulatorRails
  const credit = (ref: string, iban = C2.iban, amount = 1234n) => rails().credit({
    ref, iban, amount, currency: 'EUR', scheme: 'SEPA', debtor: { name: 'Hans Muster', iban: DE_IBAN, bic: 'COBADEFFXXX' }, endToEndId: `E2E-${ref}`,
  })
  const recall = (ref: string, code = 'DUPL', recallRef = `RCL-${ref}`) => sim('recall', { ref, code, recallRef })

  test('DUPL, TECH, FRAD: returned at once, camt.054 DBIT with RtrInf; a repeat answers the first', async () => {
    const r = await credit('RC-1')
    assert.equal(r.status, 'booked')
    await drain(ctx, C2.code)
    const res = await recall('RC-1', 'FRAD', 'CXL-1')
    assert.equal(res.statusCode, 200, res.body)
    const a = res.json()
    assert.equal(a.status, 'returned')
    const msgs = await drain(ctx, C2.code)
    assert.equal(msgs.length, 1)
    const n = msgs[0].doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn.Ntry
    assert.deepEqual([n.CdtDbtInd, String(n.Amt['#text'] ?? n.Amt), n.AcctSvcrRef], ['DBIT', '12.34', a.servicerRef])
    assert.match(msgs[0].body, /<Fmly><Cd>RCDT<\/Cd><SubFmlyCd>RRTN<\/SubFmlyCd>/)
    assert.match(msgs[0].body, /<RtrInf><Rsn><Cd>FRAD<\/Cd><\/Rsn><AddtlInf>CXL-1<\/AddtlInf><AddtlInf>[^<]+<\/AddtlInf><\/RtrInf>/)
    assert.equal(await balance(ctx, C2.iban), '100.00')
    assert.deepEqual((await recall('RC-1', 'FRAD', 'CXL-1')).json(), a, 'the same answer')
    assert.deepEqual((await recall('RC-1', 'DUPL', 'CXL-2')).json(), a, 'returned once')
    assert.deepEqual(await drain(ctx, C2.code), [])
    assert.equal(await balance(ctx, C2.iban), '100.00')
    assert.deepEqual((await credit('RC-1')), r, 'the credit itself still answers its first result')
  })

  test('refused: NOOR unknown, ARDT returned on arrival, NOAS needs consent, AM04 without the funds (then returned)', async () => {
    assert.deepEqual((await recall('RC-NONE')).json(), { status: 'refused', code: 'NOOR' })
    await credit('RC-2', 'EE127700771001260999')
    assert.deepEqual((await recall('RC-2')).json(), { status: 'refused', code: 'ARDT' })
    await credit('RC-3')
    assert.deepEqual((await recall('RC-3', 'CUST')).json(), { status: 'refused', code: 'NOAS' })
    assert.deepEqual((await recall('RC-3', 'DUPL')).json(), { status: 'refused', code: 'NOAS' }, 'the first answer stays')
    await credit('RC-4', C2.iban, 50000n)
    await drain(ctx, C2.code)
    await ctx.emulator.ledger.transfer({ ref: 'spend', from: C2.iban, to: FUNDING, amount: 60000n, currency: 'EUR' })
    assert.deepEqual((await recall('RC-4', 'TECH')).json(), { status: 'refused', code: 'AM04' })
    assert.deepEqual(await drain(ctx, C2.code), [])
    await ctx.emulator.ledger.transfer({ ref: 'back', from: FUNDING, to: C2.iban, amount: 60000n, currency: 'EUR' })
    assert.equal((await recall('RC-4', 'TECH')).json().status, 'returned', 'not remembered: returned once the funds are there')
    assert.equal((await recall('RC-4', 'zz')).statusCode, 400)
  })
})

if (process.env.DATABASE_URL) test('payments accepted by the rails settle after a restart on the same Postgres namespace (decision 948)', async () => {
  const opts = await postgresStore() // one namespace for both instances
  const a = await setup(opts)
  await sim('defer', {}, a)
  await pay([{ amount: '7.00', creditorIban: DE_IBAN }, { amount: '3.00', creditorIban: DE_IBAN }], a)
  const refs = (await messages(a)).reports[0].txs.map((t) => t.ref!)
  assert.equal(refs.length, 2)
  // Restarted: a new engine and simulator, the same Postgres state.
  const b = await setup(opts)
  assert.deepEqual(await b.emulator.engine.atRails(), refs)
  assert.equal(await b.emulator.engine.settle(refs[0], { status: 'settled' }), true)
  assert.equal(await b.emulator.engine.settle(refs[0], { status: 'settled' }), false, 'settled once')
  assert.equal(await a.emulator.engine.settle(refs[0], { status: 'settled' }), false, 'not by the old instance either')
  assert.equal(await b.emulator.engine.settle(refs[1], { status: 'rejected', reason: 'Scheme says no' }), true)
  const later = await messages(b)
  assert.deepEqual(later.reports.map((r) => r.txs.map((t) => [t.sts, t.ref, t.reason])), [[['ACSC', refs[0], undefined]], [['RJCT', undefined, 'Scheme says no']]])
  assert.deepEqual(later.notes.map((n) => [n.ind, n.ref]), [['DBIT', refs[0]]])
  assert.equal(await balance(b, C1.iban), '9993.00', 'booked once')
  assert.equal((await call(b, { url: `/_sim/accounts/${C1.iban}` })).json().balances.EUR.available, '9993.00', 'the rejected one released')
  assert.deepEqual(await b.emulator.engine.atRails(), [])
})

// The rails (a bridge) outlive our process: the same SimulatorRails serves both instances.
if (process.env.DATABASE_URL) describe('reconciliation across a restart on the same Postgres namespace (decisions 1002, 1003)', () => {
  test('payments a timeout left in doubt are settled by the restarted engine from what the rails tell, once', async () => {
    const rails = new SimulatorRails()
    const opts = { ...(await postgresStore()), rails }
    const a = await setup(opts)
    await sim('timeout', {}, a)
    await sim('reject', { account: FR_IBAN, reason: 'Account closed.' }, a)
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }, { amount: '3.00', creditorIban: FR_IBAN }], a)
    const refs = (await messages(a)).reports[0].txs.map((t) => t.ref!)
    assert.deepEqual(await a.emulator.engine.atRails(), refs)

    const b = await setup(opts) // restarted; the rails kept what they did
    assert.deepEqual(await b.emulator.engine.atRails(), refs)
    assert.equal(await b.emulator.engine.reconcile({ minAgeMs: 0 }), 2)
    assert.equal(await b.emulator.engine.reconcile({ minAgeMs: 0 }), 0)
    assert.equal(await a.emulator.engine.reconcile({ minAgeMs: 0 }), 0, 'nor by the old instance')
    const later = await messages(b)
    assert.deepEqual(later.reports.map((r) => r.txs.map((t) => [t.sts, t.ref, t.reason])), [[['ACSC', refs[0], undefined]], [['RJCT', undefined, 'Account closed.']]])
    assert.deepEqual(later.notes.map((n) => [n.ind, n.ref]), [['DBIT', refs[0]]])
    assert.equal(await balance(b, C1.iban), '9993.00')
    assert.equal(await available(C1.iban, b), '9993.00', 'the rejected one released')
  })

  test('an outcome stored before a crash wins after it: another one is refused, reconcile settles from the stored one', async () => {
    const rails = new SimulatorRails()
    const opts = { ...(await postgresStore()), rails }
    const a = await setup(opts)
    await sim('defer', {}, a)
    await pay([{ amount: '7.00', creditorIban: DE_IBAN }], a)
    await messages(a)
    const [ref] = await a.emulator.engine.atRails()
    const l = a.emulator.ledger as any
    const commit = l.commit.bind(l)
    l.commit = async (...x: unknown[]) => { await commit(...x); throw new Error('crash after the booking') }
    await assert.rejects(a.emulator.engine.settle(ref, { status: 'settled' }), /crash/)

    const b = await setup(opts)
    assert.equal(await b.emulator.engine.settle(ref, { status: 'rejected', reason: 'Scheme says no' }), false, 'settled was stored first')
    assert.equal(await b.emulator.engine.reconcile({ minAgeMs: 0 }), 1, 'from the stored outcome; the rails would still say accepted')
    const m = await messages(b)
    assert.deepEqual(m.reports.map((r) => r.txs[0].sts), ['ACSC'])
    assert.deepEqual(m.notes.map((n) => n.ind), ['DBIT'])
    assert.equal(await balance(b, C1.iban), '9993.00', 'booked once')
    assert.deepEqual(await b.emulator.engine.atRails(), [])
  })
})
