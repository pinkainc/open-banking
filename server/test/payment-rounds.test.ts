// A payment round's pain.002 across a crash (decisions 1005-1006, 1017, 1018, 1019): a file's transactions are
// checked and planned in the outbox before anything books, each booking keeps its entry of
// the round's report, and a crash after any booking resumes the round from the plan: one
// pain.002 with every transaction, the same grouping and group statuses, nothing booked or
// reported twice. The same for a decision on parked payments, and for a crash before the
// round is planned: the file kept before its MsgId is marked is checked again (1017). On
// memory the "restart" is recover() on the same emulator (its outbox survives); on Postgres
// a new emulator on the same store (registered when DATABASE_URL is set).
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { C1, C2, DE_IBAN, balance, call, ddDrain, ddStatus, drain, pain001, pain008, postgresStore, seed, setup, type Ctx } from './helpers.js'
import type { EmulatorOptions } from '../src/emulator.js'
import type { SimulatorRails } from '../src/rails.js'
import { MemoryRailsPending } from '../src/payments/pending.js'

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
/**
 * The process "dies" at the first `ledger.outbox.put` of a round's item of `type` (decision
 * 1017): `plan` before it is put (a crash during the checks: the MsgId is marked, nothing is
 * planned), `file` right after it is put (before the MsgId is marked). Once.
 */
function crashAtPut(ctx: Ctx, type: 'plan' | 'file') {
  const o = ctx.emulator.ledger.outbox as any
  const real = o.put
  o.put = async (items: { kind: string; payload: any }[]) => {
    const hit = items.some((i) => i.kind === 'pain002' && i.payload?.type === type)
    if (hit) o.put = real
    if (hit && type === 'plan') throw new Error('crash during the checks')
    await real.call(o, items)
    if (hit) throw new Error('crash before the MsgId is marked')
  }
}
/** A file's group rejections as reported (a duplicate: RJCT, no blocks). */
const duplicate = (msgs: { type: string; body: string; doc: any }[]) => {
  assert.deepEqual(reports(msgs), [{ grp: 'RJCT', blocks: [] }])
  assert.ok(msgs[0].body.includes('Duplicate message.'))
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
  test('a crash during the checks (the MsgId marked, nothing planned): a resubmission is a duplicate, recover processes the file once', async () => {
    const ctx = await setup()
    const [d0, c0] = [Number(await balance(ctx, C1.iban)), Number(await balance(ctx, C2.iban))]
    const body = FILE()
    crashAtPut(ctx, 'plan')
    assert.equal((await call(ctx, { method: 'POST', url: '/payment', body })).statusCode, 500)
    assert.equal((await call(ctx, { method: 'POST', url: '/payment', body })).statusCode, 202)
    duplicate(await drain(ctx))
    assert.ok((await ctx.emulator.outbox.recover()) > 0, 'the kept file is resumed')
    await checkResumed(ctx, d0, c0)
    assert.equal(await ctx.emulator.outbox.recover(), 0)
    assert.deepEqual(await ctx.emulator.ledger.outbox.pending(), [])
    assert.equal((await call(ctx, { method: 'POST', url: '/payment', body })).statusCode, 202)
    duplicate(await drain(ctx))
  })

  for (const first of ['resubmission', 'recover'] as const) {
    test(`a crash after the file is kept, before its MsgId is marked: processed once (${first} first), the other is a duplicate or dropped`, async () => {
      const ctx = await setup()
      const [d0, c0] = [Number(await balance(ctx, C1.iban)), Number(await balance(ctx, C2.iban))]
      const body = FILE()
      crashAtPut(ctx, 'file')
      assert.equal((await call(ctx, { method: 'POST', url: '/payment', body })).statusCode, 500)
      if (first === 'resubmission') {
        assert.equal((await call(ctx, { method: 'POST', url: '/payment', body })).statusCode, 202)
        await checkResumed(ctx, d0, c0)
        await ctx.emulator.outbox.recover() // the kept file of the first submission: the MsgId is another's, dropped
        assert.deepEqual(await drain(ctx), [])
      } else {
        assert.ok((await ctx.emulator.outbox.recover()) > 0)
        await checkResumed(ctx, d0, c0)
        assert.equal((await call(ctx, { method: 'POST', url: '/payment', body })).statusCode, 202)
        duplicate(await drain(ctx))
      }
      assert.deepEqual(await ctx.emulator.ledger.outbox.pending(), [])
      assert.equal(Number(await balance(ctx, C1.iban)), d0 - 6, 'booked once')
    })
  }
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

  test('a crash during the checks (the MsgId marked, nothing planned): after the restart the file is processed once, a resubmission is a duplicate', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const [d0, c0] = [Number(await balance(a, C1.iban)), Number(await balance(a, C2.iban))]
    const body = FILE()
    crashAtPut(a, 'plan')
    assert.equal((await call(a, { method: 'POST', url: '/payment', body })).statusCode, 500)
    const b = await setup(opts) // fromSeed recovers: the kept file is checked again and planned
    await checkResumed(b, d0, c0)
    assert.deepEqual(await b.emulator.ledger.outbox.pending(), [])
    assert.equal((await call(b, { method: 'POST', url: '/payment', body })).statusCode, 202)
    duplicate(await drain(b))
    const c = await setup(opts)
    assert.deepEqual(await drain(c), [], 'another restart sends nothing again')
    assert.equal(Number(await balance(c, C1.iban)), d0 - 6)
  })

  test('a crash after the file is kept, before its MsgId is marked: after the restart processed once, a resubmission is a duplicate', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const [d0, c0] = [Number(await balance(a, C1.iban)), Number(await balance(a, C2.iban))]
    const body = FILE()
    crashAtPut(a, 'file')
    assert.equal((await call(a, { method: 'POST', url: '/payment', body })).statusCode, 500)
    const b = await setup(opts)
    await checkResumed(b, d0, c0)
    assert.equal((await call(b, { method: 'POST', url: '/payment', body })).statusCode, 202)
    duplicate(await drain(b))
    assert.deepEqual(await b.emulator.ledger.outbox.pending(), [])
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

// --- Later rounds across a crash (decision 1018) ---------------------------------------
// The next round is planned in the same put as the round's report entries: a crash after a
// round's pain.002 and before the next round's resumes the next steps (the rails, manual
// review), and an immediate rails outcome keeps its entry before its record is taken.

const sim = (ctx: Ctx) => ctx.emulator.rails as SimulatorRails
/** The process "dies" right after the n-th delivery of a round's pain.002: reported, its next steps not run. Once. */
function crashAfterReport(ctx: Ctx, n = 1) {
  const o = ctx.emulator.outbox
  const real = o.deliver.bind(o)
  let k = 0
  o.deliver = async (items) => {
    await real(items)
    if (items.some((i) => i.kind === 'pain002') && ++k === n) { o.deliver = real; throw new Error('crash after the report') }
  }
}
/** The process "dies" at the first commit: before it books (`before`) or right after. Once. */
function crashAtCommit(ctx: Ctx, before: boolean) {
  const l = ctx.emulator.ledger as any
  const real = l.commit
  l.commit = async (...a: unknown[]) => {
    l.commit = real
    if (!before) await real.apply(l, a)
    throw new Error('crash at the commit')
  }
}
/** The process "dies" at the first put of a later round's RJCT entry: before it is put (`before`) or right after. Once. */
function crashAtRejection(ctx: Ctx, before: boolean) {
  const o = ctx.emulator.ledger.outbox as any
  const real = o.put
  o.put = async (items: { kind: string; payload: any }[]) => {
    const hit = items.some((i) => i.kind === 'pain002' && i.payload?.type === 'entry' && !i.payload.first && i.payload.status?.status === 'RJCT')
    if (!hit) return real.call(o, items)
    o.put = real
    if (!before) await real.call(o, items)
    throw new Error('crash at the rejection')
  }
}
const ROUND_TWO_RJCT = { grp: undefined, blocks: [['RND-B', undefined, 'RJCT']] }
const ACWC = { grp: undefined, blocks: [['RND-B', undefined, 'ACWC']] }
/** Reserved funds of C1 (none left once every payment is booked or released). */
const reservedOf = async (ctx: Ctx) => { const b = (await ctx.emulator.ledger.balances(C1.iban)).EUR; return b.balance - b.available }

/**
 * After the restart: the first round reported before the crash, the later rounds after it,
 * every payment sent to the rails once, booked once, nothing reserved or waiting, nothing
 * left in the outbox, another recovery and a reconciliation change nothing.
 */
async function checkLater(before: Ctx, after: Ctx, msgs0: Awaited<ReturnType<typeof drain>>, o: { first?: unknown[]; later: unknown[]; sent: string[]; d: number; c: number; debits: number }) {
  const msgs = await drain(after)
  assert.deepEqual(reports(msgs0), o.first ?? [ROUND_ONE], 'the rounds reported before the crash')
  assert.deepEqual(reports(msgs), o.later, 'each later round reported once')
  assert.equal(debits(msgs0) + debits(msgs), o.debits, 'a camt.054 per debit, once')
  const sent = before === after ? sim(after).sent : [...sim(before).sent, ...sim(after).sent]
  assert.deepEqual(sent.map((p) => p.scheme), o.sent, 'sent to the rails once per attempt')
  assert.equal(Number(await balance(after, C1.iban)), o.d, 'each payment booked once')
  assert.equal(Number(await balance(after, C2.iban)), o.c)
  assert.equal(await reservedOf(after), 0n, 'no reservation left')
  assert.deepEqual(await after.emulator.engine.atRails(), [])
  assert.deepEqual(await after.emulator.ledger.outbox.pending(), [])
  assert.equal(await after.emulator.outbox.recover(), 0)
  assert.equal(await after.emulator.engine.reconcile({ minAgeMs: 0 }), 0)
  assert.deepEqual(await drain(after), [])
}

describe('later rounds across a crash (memory: recover on the same emulator, decision 1018)', () => {
  test('a crash after the first round\'s report, before the rails: recover sends the payment once, the next round reported', async () => {
    const ctx = await setup()
    const [d0, c0] = [Number(await balance(ctx, C1.iban)), Number(await balance(ctx, C2.iban))]
    crashAfterReport(ctx)
    assert.equal((await call(ctx, { method: 'POST', url: '/payment', body: FILE() })).statusCode, 500)
    const msgs0 = await drain(ctx)
    assert.equal(sim(ctx).sent.length, 0, 'not sent before the crash')
    assert.ok((await ctx.emulator.outbox.recover()) > 0)
    await checkLater(ctx, ctx, msgs0, { later: [ROUND_TWO], sent: ['INST'], d: d0 - 6, c: c0 + 3, debits: 3 })
  })

  for (const before of [true, false]) {
    test(`an immediate settled outcome cut ${before ? 'before' : 'after'} its commit: recover books and reports it once`, async () => {
      const ctx = await setup()
      const [d0, c0] = [Number(await balance(ctx, C1.iban)), Number(await balance(ctx, C2.iban))]
      crashAtCommit(ctx, before)
      assert.equal((await call(ctx, { method: 'POST', url: '/payment', body: FILE() })).statusCode, 500)
      const msgs0 = await drain(ctx)
      await ctx.emulator.outbox.recover()
      await checkLater(ctx, ctx, msgs0, { later: [ROUND_TWO], sent: ['INST'], d: d0 - 6, c: c0 + 3, debits: 3 })
    })

    test(`an immediate rejection cut ${before ? 'before' : 'after'} its entry is kept: recover reports it once, the funds released once`, async () => {
      const ctx = await setup()
      const [d0, c0] = [Number(await balance(ctx, C1.iban)), Number(await balance(ctx, C2.iban))]
      sim(ctx).reject(DE_IBAN, 'Account closed.')
      crashAtRejection(ctx, before)
      assert.equal((await call(ctx, { method: 'POST', url: '/payment', body: FILE() })).statusCode, 500)
      const msgs0 = await drain(ctx)
      await ctx.emulator.outbox.recover()
      await checkLater(ctx, ctx, msgs0, { later: [ROUND_TWO_RJCT], sent: ['INST'], d: d0 - 3, c: c0 + 3, debits: 2 })
    })
  }

  for (const n of [1, 2]) {
    test(`SEPA Instant failed (ACWC), a crash after report ${n}: recover goes on to SEPA once`, async () => {
      const ctx = await setup()
      const [d0, c0] = [Number(await balance(ctx, C1.iban)), Number(await balance(ctx, C2.iban))]
      sim(ctx).instantFails(DE_IBAN)
      crashAfterReport(ctx, n)
      assert.equal((await call(ctx, { method: 'POST', url: '/payment', body: FILE() })).statusCode, 500)
      const msgs0 = await drain(ctx)
      await ctx.emulator.outbox.recover()
      await checkLater(ctx, ctx, msgs0, { first: n === 1 ? [ROUND_ONE] : [ROUND_ONE, ACWC], later: n === 1 ? [ACWC, ROUND_TWO] : [ROUND_TWO], sent: ['INST', 'SEPA'], d: d0 - 6, c: c0 + 3, debits: 3 })
    })
  }

  test('a crash after the first round\'s report, before manual review: recover parks the payment once, PDNG reported, approved later', async () => {
    const ctx = await setup()
    const d0 = Number(await balance(ctx, C1.iban))
    crashAfterReport(ctx)
    const body = pain001([{ pmtInfId: 'MR', txs: [{ amount: '4.00', creditorIban: DE_IBAN, creditorName: 'Robba Bank' }] }])
    assert.equal((await call(ctx, { method: 'POST', url: '/payment', body })).statusCode, 500)
    assert.deepEqual(reports(await drain(ctx)), [{ grp: 'ACSP', blocks: [['MR', 'ACSP', 'ACSP']] }])
    await ctx.emulator.outbox.recover()
    assert.deepEqual(reports(await drain(ctx)), [{ grp: undefined, blocks: [['MR', undefined, 'PDNG']] }])
    const parked = await ctx.emulator.engine.parked()
    assert.equal(parked.length, 1)
    assert.equal(await reservedOf(ctx), 400n, 'reserved once')
    assert.equal(await ctx.emulator.outbox.recover(), 0)
    assert.equal((await call(ctx, { method: 'POST', url: '/_sim/payments/pending/approve', as: null, body: { refs: [parked[0].ref] } })).statusCode, 200)
    assert.deepEqual(reports(await drain(ctx)), [{ grp: undefined, blocks: [['MR', undefined, 'ACSC']] }])
    assert.equal(sim(ctx).sent.length, 1)
    assert.equal(Number(await balance(ctx, C1.iban)), d0 - 4)
    assert.equal(await reservedOf(ctx), 0n)
  })
  test('an approved payment from manual review rejected by the rails, cut before its entry is kept: recover reports it once (decision 1006)', async () => {
    const ctx = await setup()
    const d0 = Number(await balance(ctx, C1.iban))
    await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ pmtInfId: 'MR', txs: [{ amount: '4.00', creditorIban: DE_IBAN, creditorName: 'Robba Bank' }] }]) })
    await drain(ctx)
    const [{ ref }] = await ctx.emulator.engine.parked()
    sim(ctx).reject(DE_IBAN, 'Account closed.')
    crashAtRejection(ctx, true)
    assert.equal((await call(ctx, { method: 'POST', url: '/_sim/payments/pending/approve', as: null, body: { refs: [ref] } })).statusCode, 500)
    assert.deepEqual(await drain(ctx), [])
    await ctx.emulator.outbox.recover()
    assert.deepEqual(reports(await drain(ctx)), [{ grp: undefined, blocks: [['MR', undefined, 'RJCT']] }])
    assert.equal(sim(ctx).sent.length, 1, 'sent once')
    assert.equal(Number(await balance(ctx, C1.iban)), d0)
    assert.equal(await reservedOf(ctx), 0n)
    assert.deepEqual(await ctx.emulator.engine.atRails(), [])
    assert.equal(await ctx.emulator.engine.reconcile({ minAgeMs: 0 }), 0)
    assert.equal(await ctx.emulator.outbox.recover(), 0)
    assert.deepEqual(await drain(ctx), [])
  })
})

if (process.env.DATABASE_URL) describe('later rounds across a crash (Postgres: a restart on the same store, decision 1018)', () => {
  test('a crash after the first round\'s report, before the rails: after the restart the payment is sent once, the next round reported', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const [d0, c0] = [Number(await balance(a, C1.iban)), Number(await balance(a, C2.iban))]
    crashAfterReport(a)
    assert.equal((await call(a, { method: 'POST', url: '/payment', body: FILE() })).statusCode, 500)
    const msgs0 = await drain(a)
    const b = await setup(opts)
    await checkLater(a, b, msgs0, { later: [ROUND_TWO], sent: ['INST'], d: d0 - 6, c: c0 + 3, debits: 3 })
    assert.deepEqual(await drain(await setup(opts)), [], 'another restart sends nothing again')
  })

  test('an immediate settled outcome cut before its commit: after the restart booked and reported once', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const [d0, c0] = [Number(await balance(a, C1.iban)), Number(await balance(a, C2.iban))]
    crashAtCommit(a, true)
    assert.equal((await call(a, { method: 'POST', url: '/payment', body: FILE() })).statusCode, 500)
    const msgs0 = await drain(a)
    const b = await setup(opts)
    await checkLater(a, b, msgs0, { later: [ROUND_TWO], sent: ['INST'], d: d0 - 6, c: c0 + 3, debits: 3 })
  })

  test('an immediate rejection cut before its entry is kept: after the restart reported once, the funds released', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const [d0, c0] = [Number(await balance(a, C1.iban)), Number(await balance(a, C2.iban))]
    sim(a).reject(DE_IBAN, 'Account closed.')
    crashAtRejection(a, true)
    assert.equal((await call(a, { method: 'POST', url: '/payment', body: FILE() })).statusCode, 500)
    const msgs0 = await drain(a)
    const b = await setup(opts)
    await checkLater(a, b, msgs0, { later: [ROUND_TWO_RJCT], sent: ['INST'], d: d0 - 3, c: c0 + 3, debits: 2 })
  })

  test('SEPA Instant failed (ACWC), a crash after the ACWC report: after the restart SEPA once', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const [d0, c0] = [Number(await balance(a, C1.iban)), Number(await balance(a, C2.iban))]
    sim(a).instantFails(DE_IBAN)
    crashAfterReport(a, 2)
    assert.equal((await call(a, { method: 'POST', url: '/payment', body: FILE() })).statusCode, 500)
    const msgs0 = await drain(a)
    assert.deepEqual(reports(msgs0), [ROUND_ONE, ACWC])
    const b = await setup(opts)
    const msgs = await drain(b)
    assert.deepEqual(reports(msgs), [ROUND_TWO])
    assert.deepEqual([...sim(a).sent, ...sim(b).sent].map((p) => p.scheme), ['INST', 'SEPA'])
    assert.equal(debits(msgs0) + debits(msgs), 3)
    assert.equal(Number(await balance(b, C1.iban)), d0 - 6)
    assert.equal(Number(await balance(b, C2.iban)), c0 + 3)
    assert.equal(await reservedOf(b), 0n)
    assert.deepEqual(await b.emulator.ledger.outbox.pending(), [])
  })
})

// --- Outcomes from the bridge's callback across a crash (decision 1019) -------------------
// An outcome that comes later through the events (settle) and is not settled keeps its round's
// entry and plan (and, after SEPA Instant failed, the plan of the SEPA round) before its rails
// record is taken: a crash at the take reports it once, the SEPA leg is sent once, the funds
// are released once. The same for an immediate ACWC cut after its record was taken.

/**
 * Rails records whose next `take` the test can make the process "die" at, once: before it
 * takes (`before`) or right after. `opts` with the wrapped store, `arm` sets the crash.
 */
function crashingTakes(opts: EmulatorOptions = {}) {
  let armed: 'before' | 'after' | undefined
  const make = opts.railsPending ?? (() => new MemoryRailsPending())
  const railsPending = () => {
    const p = make()
    const real = p.take.bind(p)
    p.take = async (ref, scheme) => {
      const a = armed
      if (!a) return real(ref, scheme)
      armed = undefined
      if (a === 'after') await real(ref, scheme)
      throw new Error(`crash ${a} the take`)
    }
    return p
  }
  return { opts: { ...opts, railsPending }, arm: (a: 'before' | 'after') => { armed = a } }
}

describe('callback outcomes across a crash (memory: recover on the same emulator, decision 1019)', () => {
  for (const at of ['before', 'after'] as const) {
    test(`a rejection from the callback, a crash ${at} its record is taken: recover reports it once, the funds released once`, async () => {
      const t = crashingTakes()
      const ctx = await setup(t.opts)
      const [d0, c0] = [Number(await balance(ctx, C1.iban)), Number(await balance(ctx, C2.iban))]
      sim(ctx).defer()
      assert.equal((await call(ctx, { method: 'POST', url: '/payment', body: FILE() })).statusCode, 202)
      const msgs0 = await drain(ctx)
      t.arm(at)
      await assert.rejects(sim(ctx).deliver(undefined, { status: 'rejected', reason: 'Account closed.' }))
      await ctx.emulator.outbox.recover()
      await checkLater(ctx, ctx, msgs0, { later: [ROUND_TWO_RJCT], sent: ['INST'], d: d0 - 3, c: c0 + 3, debits: 2 })
    })

    test(`SEPA Instant failed (ACWC) from the callback, a crash ${at} its record is taken: recover reports ACWC once and sends SEPA once`, async () => {
      const t = crashingTakes()
      const ctx = await setup(t.opts)
      const [d0, c0] = [Number(await balance(ctx, C1.iban)), Number(await balance(ctx, C2.iban))]
      sim(ctx).defer()
      sim(ctx).instantFails(DE_IBAN)
      assert.equal((await call(ctx, { method: 'POST', url: '/payment', body: FILE() })).statusCode, 202)
      const msgs0 = await drain(ctx)
      t.arm(at)
      await assert.rejects(sim(ctx).deliver())
      await ctx.emulator.outbox.recover()
      assert.deepEqual(reports(await drain(ctx)), [ACWC], 'ACWC reported once')
      assert.deepEqual(sim(ctx).sent.map((p) => p.scheme), ['INST', 'SEPA'], 'SEPA sent once')
      assert.equal(await reservedOf(ctx), 300n, 'still reserved once for SEPA')
      assert.equal(await sim(ctx).deliver(), 1)
      await checkLater(ctx, ctx, msgs0, { later: [ROUND_TWO], sent: ['INST', 'SEPA'], d: d0 - 6, c: c0 + 3, debits: 3 })
    })
  }

  test('an immediate ACWC cut after its record is taken, before the SEPA round is planned: recover sends SEPA once', async () => {
    const t = crashingTakes()
    const ctx = await setup(t.opts)
    const [d0, c0] = [Number(await balance(ctx, C1.iban)), Number(await balance(ctx, C2.iban))]
    sim(ctx).instantFails(DE_IBAN)
    t.arm('after')
    assert.equal((await call(ctx, { method: 'POST', url: '/payment', body: FILE() })).statusCode, 500)
    const msgs0 = await drain(ctx)
    await ctx.emulator.outbox.recover()
    await checkLater(ctx, ctx, msgs0, { later: [ACWC, ROUND_TWO], sent: ['INST', 'SEPA'], d: d0 - 6, c: c0 + 3, debits: 3 })
  })
})

if (process.env.DATABASE_URL) describe('callback outcomes across a crash (Postgres: a restart on the same store, decision 1019)', () => {
  test('a rejection from the callback, a crash after its record is taken: after the restart reported once, the funds released once', async () => {
    const opts = await postgresStore()
    const t = crashingTakes(opts)
    const a = await setup(t.opts)
    const [d0, c0] = [Number(await balance(a, C1.iban)), Number(await balance(a, C2.iban))]
    sim(a).defer()
    assert.equal((await call(a, { method: 'POST', url: '/payment', body: FILE() })).statusCode, 202)
    const msgs0 = await drain(a)
    t.arm('after')
    await assert.rejects(sim(a).deliver(undefined, { status: 'rejected', reason: 'Account closed.' }))
    const b = await setup(opts)
    await checkLater(a, b, msgs0, { later: [ROUND_TWO_RJCT], sent: ['INST'], d: d0 - 3, c: c0 + 3, debits: 2 })
    assert.deepEqual(await drain(await setup(opts)), [], 'another restart sends nothing again')
  })

  for (const at of ['before', 'after'] as const) {
    test(`SEPA Instant failed (ACWC) from the callback, a crash ${at} its record is taken: after the restart ACWC once, SEPA once`, async () => {
      const opts = await postgresStore()
      const t = crashingTakes(opts)
      const a = await setup(t.opts)
      const [d0, c0] = [Number(await balance(a, C1.iban)), Number(await balance(a, C2.iban))]
      sim(a).defer()
      sim(a).instantFails(DE_IBAN)
      assert.equal((await call(a, { method: 'POST', url: '/payment', body: FILE() })).statusCode, 202)
      const msgs0 = await drain(a)
      t.arm(at)
      await assert.rejects(sim(a).deliver())
      const b = await setup(opts)
      sim(b).defer()
      // The restart's recovery runs at start, before deferring: SEPA may have settled at once.
      await sim(b).deliver()
      const msgs = await drain(b)
      assert.deepEqual(reports(msgs0), [ROUND_ONE])
      assert.deepEqual(reports(msgs), [ACWC, ROUND_TWO], 'ACWC once, then SEPA settled once')
      assert.deepEqual([...sim(a).sent, ...sim(b).sent].map((p) => p.scheme), ['INST', 'SEPA'])
      assert.equal(debits(msgs0) + debits(msgs), 3)
      assert.equal(Number(await balance(b, C1.iban)), d0 - 6)
      assert.equal(Number(await balance(b, C2.iban)), c0 + 3)
      assert.equal(await reservedOf(b), 0n)
      assert.deepEqual(await b.emulator.engine.atRails(), [])
      assert.deepEqual(await b.emulator.ledger.outbox.pending(), [])
      assert.equal(await b.emulator.engine.reconcile({ minAgeMs: 0 }), 0)
      assert.deepEqual(await drain(await setup(opts)), [], 'another restart sends nothing again')
    })
  }

  test('an immediate ACWC cut after its record is taken: after the restart SEPA once', async () => {
    const opts = await postgresStore()
    const t = crashingTakes(opts)
    const a = await setup(t.opts)
    const [d0, c0] = [Number(await balance(a, C1.iban)), Number(await balance(a, C2.iban))]
    sim(a).instantFails(DE_IBAN)
    t.arm('after')
    assert.equal((await call(a, { method: 'POST', url: '/payment', body: FILE() })).statusCode, 500)
    const msgs0 = await drain(a)
    const b = await setup(opts)
    await checkLater(a, b, msgs0, { later: [ACWC, ROUND_TWO], sent: ['INST', 'SEPA'], d: d0 - 6, c: c0 + 3, debits: 3 })
  })
})

// --- A SEPA Direct Debit file across a crash (decision 1021) ------------------------------
// The pain.008 is kept in the outbox before its MsgId is claimed, its collections' ids drawn
// then: a crash during the checks, after the first pain.002 or between the collections' saves
// resumes the file from the outbox. Each collection is saved, reported ACCP and notified to
// the debtor once, and settled (ACSC, booked) once.

const DD_FILE = () => pain008([{ pmtInfId: 'PMT-KEPT', txs: [{ endToEndId: 'E2E-K1', amount: '10.00' }, { endToEndId: 'E2E-K2', amount: '20.00' }] }])
const DD_CUTS = ['before the report', 'after the report', 'after the first save'] as const
type DdCut = typeof DD_CUTS[number]
/**
 * The process "dies" in a pain.008's handling, once: at the creditor's first pain.002 before
 * it is added (the MsgId claimed, nothing reported or saved), right after it (nothing saved),
 * or right after the first collection's debtor notification (one collection saved).
 */
function crashInFile(ctx: Ctx, at: DdCut) {
  const inbox = ctx.emulator.inbox
  const real = inbox.add.bind(inbox)
  inbox.add = async (m) => {
    const hit = at === 'after the first save' ? m.type === 'DIRECT_DEBIT_INCOMING_COLLECTION_NOTIFICATION' : m.type === 'DIRECT_DEBIT_OUTGOING'
    if (!hit) return real(m)
    inbox.add = real
    if (at === 'before the report') throw new Error('crash during the checks')
    await real(m)
    throw new Error(`crash ${at}`)
  }
}
/** The process "dies" right after the pain.008 is kept in the outbox, before its MsgId is claimed. Once. */
function crashAfterKeep(ctx: Ctx) {
  const o = ctx.emulator.ledger.outbox as any
  const real = o.put
  o.put = async (items: { kind: string }[]) => {
    await real.call(o, items)
    if (items.some((i) => i.kind === 'dd-file')) { o.put = real; throw new Error('crash before the MsgId is claimed') }
  }
}
/** Each creditor pain.002 as [group status, EndToEndId:status...]. */
const ddOutgoing = (msgs: { type: string; doc: any }[]) => msgs.filter((m) => m.type === 'DIRECT_DEBIT_OUTGOING').map((m) => {
  const r = ddStatus(m)
  return [r.grp, ...r.blocks.flatMap((b: any) => b.txs.map((t: any) => `${t.endToEndId}:${t.sts}`))]
})
const ACCP = ['ACCP', 'E2E-K1:ACCP', 'E2E-K2:ACCP']
const ddDuplicate = async (ctx: Ctx) => {
  const msgs = await ddDrain(ctx)
  assert.deepEqual(ddOutgoing(msgs), [['RJCT']])
  assert.ok(msgs[0].body.includes('Duplicate message.'))
}
/**
 * After the resume: the creditor's first pain.002 of the file once (counting `before`, those
 * drained already), both collections saved once and notified once; at the settlement one
 * ACSC pain.002, each booked once.
 */
async function checkKeptFile(ctx: Ctx, c0: number, d0: number, before: string[][] = []) {
  assert.deepEqual([...before, ...ddOutgoing(await ddDrain(ctx))], [ACCP], 'one first report')
  assert.deepEqual((await ddDrain(ctx, C2.code)).map((m) => m.type), ['DIRECT_DEBIT_INCOMING_COLLECTION_NOTIFICATION', 'DIRECT_DEBIT_INCOMING_COLLECTION_NOTIFICATION'], 'each collection notified once')
  const listed = (await call(ctx, { url: '/_sim/direct-debit/collections' })).json().collections
  assert.deepEqual(listed.map((x: any) => `${x.endToEndId}:${x.status}`), ['E2E-K1:PENDING', 'E2E-K2:PENDING'], 'each collection saved once')
  ctx.clock.set('2026-03-12T10:30:00Z')
  assert.equal((await call(ctx, { method: 'POST', url: '/_sim/direct-debit/settle' })).statusCode, 200)
  assert.deepEqual(ddOutgoing(await ddDrain(ctx)), [[undefined, 'E2E-K1:ACSC', 'E2E-K2:ACSC']], 'one settlement report (no group status)')
  assert.equal(Number(await balance(ctx, C1.iban)), c0 + 30, 'credited once')
  assert.equal(Number(await balance(ctx, C2.iban)), d0 - 30, 'debited once')
  assert.deepEqual((await ddDrain(ctx, C2.code)).map((m) => m.type), ['CREDIT_DEBIT_NOTIFICATION', 'CREDIT_DEBIT_NOTIFICATION'], 'a camt.054 per debit')
  assert.deepEqual(await ctx.emulator.ledger.outbox.pending(), [])
}
const collectDd = (ctx: Ctx, body: string) => call(ctx, { method: 'POST', url: '/direct-debit/collection', body })

describe('a SEPA Direct Debit file across a crash (memory: recover on the same emulator, decision 1021)', () => {
  for (const at of DD_CUTS) {
    test(`a crash ${at}: a resubmission is a duplicate, recover saves, reports and settles each collection once`, async () => {
      const ctx = await setup()
      const [c0, d0] = [Number(await balance(ctx, C1.iban)), Number(await balance(ctx, C2.iban))]
      const body = DD_FILE()
      crashInFile(ctx, at)
      assert.equal((await collectDd(ctx, body)).statusCode, 500)
      const before = ddOutgoing(await ddDrain(ctx))
      assert.deepEqual(before, at === 'before the report' ? [] : [ACCP])
      assert.equal((await collectDd(ctx, body)).statusCode, 202)
      await ddDuplicate(ctx)
      assert.ok((await ctx.emulator.outbox.recover()) > 0, 'the kept file is resumed')
      assert.equal(await ctx.emulator.outbox.recover(), 0)
      await checkKeptFile(ctx, c0, d0, before)
      assert.equal((await collectDd(ctx, body)).statusCode, 202)
      await ddDuplicate(ctx)
    })
  }

  for (const first of ['resubmission', 'recover'] as const) {
    test(`a crash after the file is kept, before its MsgId is claimed: processed once (${first} first), the other a duplicate or dropped`, async () => {
      const ctx = await setup()
      const [c0, d0] = [Number(await balance(ctx, C1.iban)), Number(await balance(ctx, C2.iban))]
      const body = DD_FILE()
      crashAfterKeep(ctx)
      assert.equal((await collectDd(ctx, body)).statusCode, 500)
      if (first === 'resubmission') {
        assert.equal((await collectDd(ctx, body)).statusCode, 202)
        await ctx.emulator.outbox.recover() // the first submission's kept file: the MsgId is another's, dropped
        await checkKeptFile(ctx, c0, d0)
      } else {
        assert.ok((await ctx.emulator.outbox.recover()) > 0)
        await checkKeptFile(ctx, c0, d0)
        assert.equal((await collectDd(ctx, body)).statusCode, 202)
        await ddDuplicate(ctx)
      }
    })
  }

  test('the timer\'s recovery leaves a kept file to the process handling it for 10 minutes', async () => {
    const ctx = await setup()
    crashInFile(ctx, 'before the report')
    assert.equal((await collectDd(ctx, DD_FILE())).statusCode, 500)
    assert.equal(await ctx.emulator.outbox.recover({ minAgeMs: 60_000 }), 0, 'too young')
    ctx.clock.set('2026-03-10T08:11:00Z')
    assert.equal(await ctx.emulator.outbox.recover({ minAgeMs: 60_000 }), 1)
    assert.deepEqual(ddOutgoing(await ddDrain(ctx)), [ACCP])
  })
})

if (process.env.DATABASE_URL) describe('a SEPA Direct Debit file across a crash (Postgres: a restart on the same store, decision 1021)', () => {
  for (const at of DD_CUTS) {
    test(`a crash ${at}: after the restart each collection saved, reported and settled once, a resubmission a duplicate`, async () => {
      const opts = await postgresStore()
      const a = await setup(opts)
      const [c0, d0] = [Number(await balance(a, C1.iban)), Number(await balance(a, C2.iban))]
      const body = DD_FILE()
      crashInFile(a, at)
      assert.equal((await collectDd(a, body)).statusCode, 500)
      const b = await setup(opts) // fromSeed recovers: the kept file is resumed
      assert.equal((await collectDd(b, body)).statusCode, 202)
      const msgs = await ddDrain(b)
      assert.deepEqual(ddOutgoing(msgs), [ACCP, ['RJCT']], 'the first report once, the resubmission a duplicate')
      await checkKeptFile(b, c0, d0, [ACCP])
      const c = await setup(opts)
      assert.deepEqual(await ddDrain(c), [], 'another restart sends nothing again')
      assert.deepEqual(await ddDrain(c, C2.code), [])
    })
  }

  test('a crash after the file is kept, before its MsgId is claimed: after the restart processed once, a resubmission a duplicate', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const [c0, d0] = [Number(await balance(a, C1.iban)), Number(await balance(a, C2.iban))]
    const body = DD_FILE()
    crashAfterKeep(a)
    assert.equal((await collectDd(a, body)).statusCode, 500)
    const b = await setup(opts)
    await checkKeptFile(b, c0, d0)
    assert.equal((await collectDd(b, body)).statusCode, 202)
    await ddDuplicate(b)
  })
})
