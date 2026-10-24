// A payment round's pain.002 across a crash (decisions 1005-1006): a file's transactions are
// checked and planned in the outbox before anything books, each booking keeps its entry of
// the round's report, and a crash after any booking resumes the round from the plan: one
// pain.002 with every transaction, the same grouping and group statuses, nothing booked or
// reported twice. The same for a decision on parked payments. On memory the "restart" is
// recover() on the same emulator (its outbox survives); on Postgres a new emulator on the
// same store (registered when DATABASE_URL is set).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { C1, C2, DE_IBAN, balance, call, ddDrain, ddStatus, drain, pain001, pain008, postgresStore, seed, setup, type Ctx } from './helpers.js'
import type { EmulatorOptions } from '../src/emulator.js'

/** From the k-th call on, the ledger's `which` books, then the process "dies" (the call throws); returns the restore. */
function crashAtBooking(ctx: Ctx, which: 'transfer' | 'commit', k: number) {
  const l = ctx.emulator.ledger as any
  const real = l[which]
  let n = 0
  l[which] = async (...a: unknown[]) => {
    const r = await real.apply(l, a)
    if (++n >= k) throw new Error('crash after the booking')
    return r
  }
  return () => { l[which] = real }
}
/** Each pain.002 as [group status, [tx status...] per block]. */
const reports = (msgs: { type: string; doc: any }[]) => msgs.filter((m) => m.type === 'PAYMENT').map((m) => {
  const r = m.doc.Document.CstmrPmtStsRpt
  const many = (x: any) => (x === undefined ? [] : Array.isArray(x) ? x : [x])
  return { grp: r.OrgnlGrpInfAndSts.GrpSts as string | undefined, blocks: many(r.OrgnlPmtInfAndSts).map((b: any) => [b.OrgnlPmtInfId, b.PmtInfSts, ...many(b.TxInfAndSts).map((t: any) => t.TxSts)]) }
})
const debits = (msgs: { type: string; doc: any }[]) => msgs.filter((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION' && m.doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn.Ntry.CdtDbtInd === 'DBIT').length
// Two blocks: an internal payment, a rejection (no remittance), an internal payment; then an external one (reserved, ACSP; the simulator settles it in the next round).
const FILE = () => pain001([
  { pmtInfId: 'RND-A', txs: [{ amount: '1.00', creditorIban: C2.iban }, { amount: '9.00', creditorIban: C2.iban, ustrd: null }] },
  { pmtInfId: 'RND-B', txs: [{ amount: '2.00', creditorIban: C2.iban }, { amount: '3.00', creditorIban: DE_IBAN }] },
])
const ROUND_ONE = { grp: 'PART', blocks: [['RND-A', 'PART', 'ACSC', 'RJCT'], ['RND-B', 'ACSP', 'ACSC', 'ACSP']] }
const ROUND_TWO = { grp: undefined, blocks: [['RND-B', undefined, 'ACSC']] }

async function checkResumed(ctx: Ctx, d0: number, c0: number) {
  const msgs = await drain(ctx)
  assert.deepEqual(reports(msgs), [ROUND_ONE, ROUND_TWO], 'one pain.002 per round, every transaction once, grouped as without the crash')
  assert.equal(debits(msgs), 3, 'a camt.054 per debit, once')
  assert.equal(Number(await balance(ctx, C1.iban)), d0 - 6, 'each payment booked once')
  assert.equal(Number(await balance(ctx, C2.iban)), c0 + 3)
  assert.equal((await drain(ctx, C2.code)).filter((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION').length, 2)
}

describe('a payment round across a crash (memory: recover on the same emulator)', () => {
  test('without a crash: the same reports as before (two rounds, grouped)', async () => {
    const ctx = await setup()
    const [d0, c0] = [Number(await balance(ctx, C1.iban)), Number(await balance(ctx, C2.iban))]
    assert.equal((await call(ctx, { method: 'POST', url: '/payment', body: FILE() })).statusCode, 202)
    await checkResumed(ctx, d0, c0)
    assert.deepEqual(await ctx.emulator.ledger.outbox.pending(), [], 'the round leaves nothing in the outbox')
  })

  for (const k of [1, 2]) {
    test(`a crash after booking ${k} of the round: resumed by recover, one pain.002 with all four transactions`, async () => {
      const ctx = await setup()
      const [d0, c0] = [Number(await balance(ctx, C1.iban)), Number(await balance(ctx, C2.iban))]
      const restore = crashAtBooking(ctx, 'transfer', k)
      assert.equal((await call(ctx, { method: 'POST', url: '/payment', body: FILE() })).statusCode, 500)
      restore()
      assert.deepEqual((await drain(ctx)).filter((m) => m.type === 'PAYMENT'), [], 'nothing reported before the restart')
      assert.ok((await ctx.emulator.outbox.recover()) > 0)
      await checkResumed(ctx, d0, c0)
      assert.equal(await ctx.emulator.outbox.recover(), 0, 'a second recovery finds nothing')
      assert.deepEqual(await drain(ctx), [])
    })
  }

  test('a decision on parked payments cut after its first booking: resumed, one pain.002 with both', async () => {
    const s = seed()
    s.customers[0].payments = 'PENDING'
    const ctx = await setup({}, s)
    const d0 = Number(await balance(ctx, C1.iban))
    await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ pmtInfId: 'PRK', txs: [{ amount: '1.00', creditorIban: C2.iban }, { amount: '2.00', creditorIban: C2.iban }] }]) })
    assert.deepEqual(reports(await drain(ctx)), [{ grp: 'PDNG', blocks: [['PRK', 'PDNG', 'PDNG', 'PDNG']] }])
    const refs = (await ctx.emulator.engine.parked()).map((p) => p.ref)
    const restore = crashAtBooking(ctx, 'transfer', 1)
    assert.equal((await call(ctx, { method: 'POST', url: '/_sim/payments/pending/approve', as: null, body: { refs } })).statusCode, 500)
    restore()
    assert.equal(Number(await balance(ctx, C1.iban)), d0 - 1, 'the first booked before the crash')
    await ctx.emulator.outbox.recover()
    const msgs = await drain(ctx)
    assert.deepEqual(reports(msgs), [{ grp: undefined, blocks: [['PRK', undefined, 'ACSC', 'ACSC']] }])
    assert.equal(debits(msgs), 2)
    assert.equal(Number(await balance(ctx, C1.iban)), d0 - 3, 'each booked once')
    assert.deepEqual(await ctx.emulator.engine.parked(), [])
    assert.equal(await ctx.emulator.outbox.recover(), 0)
  })

  test('a payment listed twice in one decision is decided once', async () => {
    const s = seed()
    s.customers[0].payments = 'PENDING'
    const ctx = await setup({}, s)
    const d0 = Number(await balance(ctx, C1.iban))
    await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '1.00', creditorIban: C2.iban }] }]) })
    await drain(ctx)
    const [ref] = (await ctx.emulator.engine.parked()).map((p) => p.ref)
    assert.equal((await call(ctx, { method: 'POST', url: '/_sim/payments/pending/approve', as: null, body: { refs: [ref, ref] } })).statusCode, 200)
    assert.deepEqual(reports(await drain(ctx)).map((r) => r.blocks.map((b: unknown[]) => b.slice(1))), [[[undefined, 'ACSC']]], 'one report, the payment in it once')
    assert.equal(Number(await balance(ctx, C1.iban)), d0 - 1)
  })
})

describe('SEPA Direct Debit rejections across a crash (memory: recover on the same emulator, decision 1007)', () => {
  const ddReports = async (ctx: Ctx) => (await ddDrain(ctx)).filter((m) => m.type === 'DIRECT_DEBIT_OUTGOING').map((m) => ddStatus(m).blocks.flatMap((x: any) => x.txs.map((t: any) => t.sts)))
  const collect = async (ctx: Ctx) => {
    // The debtor (C2, 100 EUR) cannot pay: both collections AM04, nothing booked.
    const res = await call(ctx, { method: 'POST', url: '/direct-debit/collection', body: pain008([{ pmtInfId: 'PMT-RJ', txs: [{ endToEndId: 'E2E-RJ1', amount: '500.00' }, { endToEndId: 'E2E-RJ2', amount: '600.00' }] }]) })
    assert.equal(res.statusCode, 202, res.body)
    await ddDrain(ctx); await ddDrain(ctx, C2.code)
    ctx.clock.set('2026-03-12T10:30:00Z')
  }
  const statuses = async (ctx: Ctx) => (await call(ctx, { url: '/_sim/direct-debit/collections' })).json().collections.map((x: any) => x.status)

  test('saved REJECTED, cut before the tick\'s report: recover sends the one report of the file', async () => {
    const ctx = await setup()
    await collect(ctx)
    const deliver = ctx.emulator.outbox.deliver.bind(ctx.emulator.outbox)
    ctx.emulator.outbox.deliver = async (items) => { if (items.some((i) => i.kind === 'dd-report')) throw new Error('crash before the report'); return deliver(items) }
    assert.equal((await call(ctx, { method: 'POST', url: '/_sim/direct-debit/settle' })).statusCode, 500)
    ctx.emulator.outbox.deliver = deliver
    assert.deepEqual(await statuses(ctx), ['REJECTED', 'REJECTED'])
    await ctx.emulator.outbox.recover()
    assert.deepEqual(await ddReports(ctx), [['RJCT', 'RJCT']])
    await call(ctx, { method: 'POST', url: '/_sim/direct-debit/settle' })
    assert.equal(await ctx.emulator.outbox.recover(), 0)
    assert.deepEqual(await ddDrain(ctx), [], 'nothing again')
  })

  test('cut after the entry was kept and before the save: recover drops it, the next tick reports the rejection once', async () => {
    const ctx = await setup()
    await collect(ctx)
    const store = ctx.emulator.ledger.outbox
    const put = store.put.bind(store)
    store.put = async (items) => { await put(items); throw new Error('crash before the save') }
    assert.equal((await call(ctx, { method: 'POST', url: '/_sim/direct-debit/settle' })).statusCode, 500)
    store.put = put
    assert.deepEqual(await statuses(ctx), ['PENDING', 'PENDING'], 'not saved')
    await ctx.emulator.outbox.recover()
    assert.deepEqual(await ddReports(ctx), [], 'the collection is not REJECTED: no report')
    await call(ctx, { method: 'POST', url: '/_sim/direct-debit/settle' })
    assert.deepEqual(await statuses(ctx), ['REJECTED', 'REJECTED'])
    assert.deepEqual(await ddReports(ctx), [['RJCT', 'RJCT']], 'one report of the rerun tick')
    assert.deepEqual(await store.pending(), [])
  })
})

if (process.env.DATABASE_URL) describe('a payment round across a crash (Postgres: a restart on the same store)', () => {
  for (const k of [1, 2]) {
    test(`a crash after booking ${k} of the round: after the restart one pain.002 with all four transactions, the next round run`, async () => {
      const opts = await postgresStore()
      const a = await setup(opts)
      const [d0, c0] = [Number(await balance(a, C1.iban)), Number(await balance(a, C2.iban))]
      crashAtBooking(a, 'transfer', k)
      assert.equal((await call(a, { method: 'POST', url: '/payment', body: FILE() })).statusCode, 500)
      const b = await setup(opts) // fromSeed recovers: the round is resumed
      await checkResumed(b, d0, c0)
      assert.deepEqual(await b.emulator.ledger.outbox.pending(), [])
      const c = await setup(opts)
      assert.deepEqual(await drain(c), [], 'another restart sends nothing again')
    })
  }

  test('a round that books nothing (all rejected): a crash before its report sends it after the restart', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const deliver = a.emulator.outbox.deliver.bind(a.emulator.outbox)
    a.emulator.outbox.deliver = async (items) => { if (items.some((i) => i.kind === 'pain002')) throw new Error('crash before the report'); return deliver(items) }
    const body = pain001([{ pmtInfId: 'RJ', txs: [{ amount: '1.00', creditorIban: C2.iban, ustrd: null }, { amount: '0.00', creditorIban: C2.iban }] }])
    assert.equal((await call(a, { method: 'POST', url: '/payment', body })).statusCode, 500)
    const b = await setup(opts)
    assert.deepEqual(reports(await drain(b)), [{ grp: 'RJCT', blocks: [['RJ', 'RJCT', 'RJCT', 'RJCT']] }])
    // The file was seen before the crash: sent again it is a duplicate, as before.
    assert.equal((await call(b, { method: 'POST', url: '/payment', body })).statusCode, 202)
    assert.equal(reports(await drain(b))[0].grp, 'RJCT')
  })

  test('a decision on parked payments cut after its first booking: after the restart one pain.002 with both, each booked once', async () => {
    const s = seed()
    s.customers[0].payments = 'PENDING'
    const opts: EmulatorOptions = await postgresStore()
    const a = await setup(opts, s)
    const d0 = Number(await balance(a, C1.iban))
    await call(a, { method: 'POST', url: '/payment', body: pain001([{ pmtInfId: 'PRK', txs: [{ amount: '1.00', creditorIban: C2.iban }, { amount: '2.00', creditorIban: C2.iban }] }]) })
    await drain(a)
    const refs = (await a.emulator.engine.parked()).map((p) => p.ref)
    crashAtBooking(a, 'transfer', 1)
    assert.equal((await call(a, { method: 'POST', url: '/_sim/payments/pending/approve', as: null, body: { refs } })).statusCode, 500)
    const b = await setup(opts, s)
    const msgs = await drain(b)
    assert.deepEqual(reports(msgs), [{ grp: undefined, blocks: [['PRK', undefined, 'ACSC', 'ACSC']] }])
    assert.equal(debits(msgs), 2)
    assert.equal(Number(await balance(b, C1.iban)), d0 - 3)
    assert.deepEqual(await b.emulator.engine.parked(), [])
    assert.equal(await b.emulator.outbox.recover(), 0)
  })

  test('SEPA Direct Debit: a tick whose collections were all rejected, cut before its report, sends the report after the restart, once', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    // The debtor (C2) cannot pay: both collections AM04, nothing booked.
    const res = await call(a, { method: 'POST', url: '/direct-debit/collection', body: pain008([{ pmtInfId: 'PMT-RJ', txs: [{ endToEndId: 'E2E-RJ1', amount: '500.00' }, { endToEndId: 'E2E-RJ2', amount: '600.00' }] }]) })
    assert.equal(res.statusCode, 202, res.body)
    await ddDrain(a); await ddDrain(a, C2.code)
    const deliver = a.emulator.outbox.deliver.bind(a.emulator.outbox)
    a.emulator.outbox.deliver = async (items) => { if (items.some((i) => i.kind === 'dd-report')) throw new Error('crash before the report'); return deliver(items) }
    a.clock.set('2026-03-12T10:30:00Z')
    assert.equal((await call(a, { method: 'POST', url: '/_sim/direct-debit/settle' })).statusCode, 500)
    assert.deepEqual((await call(a, { url: '/_sim/direct-debit/collections' })).json().collections.map((x: any) => x.status), ['REJECTED', 'REJECTED'])

    const b = await setup(opts)
    const out = (await ddDrain(b)).filter((m) => m.type === 'DIRECT_DEBIT_OUTGOING').map((m) => ddStatus(m).blocks.flatMap((x: any) => x.txs.map((t: any) => t.sts)))
    assert.deepEqual(out, [['RJCT', 'RJCT']], 'one pain.002 of the file with both rejections')
    b.clock.set('2026-03-12T10:30:00Z')
    await call(b, { method: 'POST', url: '/_sim/direct-debit/settle' })
    assert.deepEqual(await ddDrain(b), [], 'nothing again')
  })
})
