// Payments that wait: pending payments (SCA in the internet bank, decided via
// /_sim/payments/pending) and the bank's manual review (PDNG "In manual review").
// Every produced pain.002 / camt.054 is validated against the published XSDs.
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { many } from '../src/xml.js'
import { C1, C2, DE_IBAN, HAVE_REFERENCE, balance, call, drain, pain001, sample, seed, setup, xsd, type Ctx, type TxSpec } from './helpers.js'

let ctx: Ctx
beforeEach(async () => { ctx = await setup() })

type Msg = Awaited<ReturnType<typeof drain>>[number]
const NS = (m: Msg) => /xmlns="urn:iso:std:iso:20022:tech:xsd:([^"]+)"/.exec(m.body)?.[1]

async function messages(as = C1.code) {
  const msgs = await drain(ctx, as)
  if (HAVE_REFERENCE) {
    for (const m of msgs) {
      const ns = NS(m)
      if (ns && xsd.has(ns)) assert.deepEqual(await xsd.validate(m.body, ns), [], `${ns} is schema-valid:\n${m.body}`)
    }
  }
  return {
    reports: msgs.filter((m) => m.type === 'PAYMENT').map(rpt),
    notes: msgs.filter((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION').map((m) => {
      const n = m.doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn
      return { iban: n.Acct.Id.IBAN as string, ind: n.Ntry.CdtDbtInd as string, amount: String(n.Ntry.Amt['#text'] ?? n.Ntry.Amt), ref: n.Ntry.AcctSvcrRef as string }
    }),
    raw: msgs,
  }
}

function rpt(m: Msg) {
  const r = m.doc.Document.CstmrPmtStsRpt
  const g = r.OrgnlGrpInfAndSts
  const txs = many(r.OrgnlPmtInfAndSts).flatMap((b: any) => many(b.TxInfAndSts))
  return {
    requestId: m.requestId, orgnlMsgId: String(g.OrgnlMsgId), grpSts: g.GrpSts as string | undefined,
    pmtInfSts: many(r.OrgnlPmtInfAndSts).map((b: any) => b.PmtInfSts as string | undefined),
    txs: txs.map((t: any) => ({
      sts: t.TxSts as string, reason: t.StsRsnInf?.AddtlInf as string | undefined, hasReason: t.StsRsnInf !== undefined,
      ref: t.AcctSvcrRef as string | undefined, scheme: t.OrgnlTxRef?.PmtTpInf?.SvcLvl?.Prtry as string | undefined, instrId: t.OrgnlInstrId as string | undefined,
    })),
  }
}

async function pay(xml: string, as = C1.code) {
  const res = await call(ctx, { method: 'POST', url: '/payment', body: xml, as })
  assert.equal(res.statusCode, 202, res.body)
  return { requestId: res.headers['message-request-id'] as string, ...(await messages(as)) }
}
const one = (spec: TxSpec, o: Parameters<typeof pain001>[1] = {}) => pain001([{ txs: [spec] }], o)
const available = async (iban: string) => (await call(ctx, { url: `/_sim/accounts/${iban}` })).json().balances.EUR.available as string
const pendingList = async () => (await call(ctx, { url: '/_sim/payments/pending' })).json().payments as any[]
const decide = (action: 'approve' | 'reject', body: object) => call(ctx, { method: 'POST', url: `/_sim/payments/pending/${action}`, body })
const setPending = async (code = C1.code) => {
  const r = await call(ctx, { method: 'PATCH', url: `/_sim/customers/EE/${code}`, body: { payments: 'PENDING' } })
  assert.equal(r.statusCode, 200, r.body)
  assert.equal(r.json().payments, 'PENDING')
}

describe('pending payments (SCA in the internet bank, decision 521)', () => {
  test('internal: PDNG on every level, nothing booked; approval books it with ACSC and both camt.054', async () => {
    await setPending()
    const first = await pay(one({ amount: '12.50', instrId: 'P-1' }))
    assert.equal(first.reports.length, 1)
    const r = first.reports[0]
    assert.equal(r.grpSts, 'PDNG')
    assert.deepEqual(r.pmtInfSts, ['PDNG'])
    assert.equal(r.txs[0].sts, 'PDNG')
    assert.equal(r.txs[0].hasReason, false, 'waiting for SCA carries no narrative')
    assert.match(r.txs[0].ref!, /^[0-9A-F]{32}$/)
    assert.equal(r.txs[0].scheme, 'INTERNAL')
    assert.equal(first.notes.length, 0)
    assert.equal(await balance(ctx, C1.iban), '10000.00')

    const list = await pendingList()
    assert.equal(list.length, 1)
    assert.deepEqual({ ref: list[0].ref, kind: list[0].kind, instrId: list[0].instrId, amount: list[0].amount }, { ref: r.txs[0].ref, kind: 'SCA', instrId: 'P-1', amount: '12.50' })

    const ok = await decide('approve', { refs: [r.txs[0].ref] })
    assert.equal(ok.statusCode, 200, ok.body)
    const after = await messages()
    assert.equal(after.reports.length, 1)
    assert.equal(after.reports[0].grpSts, undefined, 'group status only in the first report')
    assert.deepEqual(after.reports[0].pmtInfSts, [undefined])
    assert.equal(after.reports[0].requestId, first.requestId)
    assert.equal(after.reports[0].orgnlMsgId, r.orgnlMsgId)
    assert.equal(after.reports[0].txs[0].sts, 'ACSC')
    assert.deepEqual(after.notes.map((n) => [n.iban, n.ind, n.amount]), [[C1.iban, 'DBIT', '12.50']])
    assert.deepEqual((await messages(C2.code)).notes.map((n) => [n.iban, n.ind]), [[C2.iban, 'CRDT']])
    assert.equal(await balance(ctx, C1.iban), '9987.50')
    assert.deepEqual(await pendingList(), [])
  })

  test('external: approval gives ACSP, then the rails\' ACSC with the camt.054', async () => {
    await setPending()
    const first = await pay(one({ amount: '5.00', creditorIban: DE_IBAN }))
    assert.equal(first.reports[0].txs[0].sts, 'PDNG')
    assert.equal(first.reports[0].txs[0].scheme, 'INST')
    assert.equal(await available(C1.iban), '10000.00', 'nothing reserved before SCA')
    await decide('approve', { refs: [first.reports[0].txs[0].ref] })
    const after = await messages()
    assert.deepEqual(after.reports.map((x) => x.txs.map((t) => t.sts)), [['ACSP'], ['ACSC']])
    assert.ok(after.reports.every((x) => x.grpSts === undefined))
    assert.deepEqual(after.notes.map((n) => n.ind), ['DBIT'])
    assert.equal(await balance(ctx, C1.iban), '9995.00')
  })

  test('refused in the internet bank: RJCT "Requested by customer.", no money moves', async () => {
    await setPending()
    const first = await pay(pain001([{ txs: [{ amount: '1.00' }, { amount: '2.00' }] }]))
    const refs = first.reports[0].txs.map((t) => t.ref!)
    const r = await decide('reject', { refs })
    assert.equal(r.statusCode, 200, r.body)
    const after = await messages()
    assert.equal(after.reports.length, 1, 'one report for the file')
    assert.deepEqual(after.reports[0].txs.map((t) => [t.sts, t.reason]), [['RJCT', 'Requested by customer.'], ['RJCT', 'Requested by customer.']])
    assert.equal(after.notes.length, 0)
    assert.equal(await balance(ctx, C1.iban), '10000.00')
  })

  test('funds are checked at approval', async () => {
    await setPending()
    const first = await pay(one({ amount: '9000.00' }))
    await call(ctx, { method: 'POST', url: '/payment', body: one({ amount: '8000.00' }) })
    const second = (await messages()).reports[0]
    await decide('approve', { refs: [first.reports[0].txs[0].ref, second.txs[0].ref] })
    const reports = (await messages()).reports
    assert.deepEqual(reports.map((x) => x.txs.map((t) => [t.sts, t.reason])), [[['ACSC', undefined]], [['RJCT', 'Insufficient funds available.']]])
  })

  test('checks that need no money still reject at once; the file is PDNG', async () => {
    await setPending()
    const first = await pay(pain001([{ txs: [{ amount: '1.00' }, { amount: '1.00', ustrd: null }] }]))
    assert.equal(first.reports[0].grpSts, 'PDNG')
    assert.deepEqual(first.reports[0].txs.map((t) => [t.sts, t.reason]), [['PDNG', undefined], ['RJCT', 'Description or reference number must be entered.']])
    assert.equal((await pendingList()).length, 1)
  })

  test('set in the seed; PATCH switches back to direct processing', async () => {
    const s = seed()
    s.customers[0].payments = 'PENDING'
    ctx = await setup({}, s)
    assert.equal((await pay(one({ amount: '1.00' }))).reports[0].txs[0].sts, 'PDNG')
    const customers = (await call(ctx, { url: '/_sim/customers' })).json().customers
    assert.equal(customers.find((c: any) => c.code === C1.code).payments, 'PENDING')
    await call(ctx, { method: 'PATCH', url: `/_sim/customers/EE/${C1.code}`, body: { payments: 'DIRECT' } })
    assert.equal((await pay(one({ amount: '1.00' }))).reports[0].txs[0].sts, 'ACSC')
  })

  test('/_sim refusals: unknown ref 404 (nothing decided), bad bodies 400', async () => {
    await setPending()
    const ref = (await pay(one({ amount: '1.00' }))).reports[0].txs[0].ref!
    assert.equal((await decide('approve', { refs: [ref, 'NOPE'] })).statusCode, 404)
    assert.equal((await pendingList()).length, 1)
    assert.equal((await decide('approve', { refs: [] })).statusCode, 400)
    assert.equal((await decide('approve', { refs: [ref], reason: 'x' })).statusCode, 400)
    assert.equal((await decide('reject', { refs: [ref], reason: '' })).statusCode, 400)
    assert.equal((await call(ctx, { method: 'PATCH', url: `/_sim/customers/EE/${C1.code}`, body: { payments: 'LATER' } })).statusCode, 400)
    assert.equal((await call(ctx, { method: 'PATCH', url: '/_sim/customers/EE/999', body: { payments: 'DIRECT' } })).statusCode, 404)
    assert.equal((await messages()).reports.length, 0)
  })
})

describe('manual review (decision 522)', () => {
  test('a screening name: ACSP, then PDNG "In manual review" with the funds reserved; approval settles', async () => {
    const first = await pay(one({ amount: '20.00', creditorIban: DE_IBAN, creditorName: 'Robba Bank' }))
    assert.deepEqual(first.reports.map((r) => r.txs.map((t) => t.sts)), [['ACSP'], ['PDNG']])
    assert.equal(first.reports[0].grpSts, 'ACSP')
    const pdng = first.reports[1]
    assert.equal(pdng.grpSts, undefined)
    assert.equal(pdng.txs[0].reason, 'In manual review')
    assert.equal(pdng.txs[0].ref, first.reports[0].txs[0].ref, 'same AcctSvcrRef as the ACSP')
    assert.equal(first.notes.length, 0)
    assert.equal(await available(C1.iban), '9980.00')
    assert.equal(await balance(ctx, C1.iban), '10000.00')
    assert.equal((await pendingList())[0].kind, 'REVIEW')
    // Not automatically resolved.
    ctx.clock.advance(86_400_000)
    assert.equal((await messages()).reports.length, 0)

    await decide('approve', { refs: [pdng.txs[0].ref] })
    const after = await messages()
    assert.deepEqual(after.reports.map((r) => r.txs.map((t) => t.sts)), [['ACSC']])
    assert.deepEqual(after.notes.map((n) => [n.ind, n.amount]), [['DBIT', '20.00']])
    assert.equal(await balance(ctx, C1.iban), '9980.00')
  })

  test('refused after review: RJCT, the reservation released', async () => {
    const first = await pay(one({ amount: '20.00', creditorIban: DE_IBAN, creditorName: '  steela   KOINZ ' }))
    const ref = first.reports[1].txs[0].ref!
    await decide('reject', { refs: [ref] })
    const after = await messages()
    assert.deepEqual(after.reports[0].txs.map((t) => [t.sts, t.reason]), [['RJCT', 'Payment declined. Regulatory reasons']])
    assert.equal(await available(C1.iban), '10000.00')
    // Own reason text.
    const again = await pay(one({ amount: '1.00', creditorIban: DE_IBAN, creditorName: 'Skimmi Cardar' }))
    await decide('reject', { refs: [again.reports[1].txs[0].ref!], reason: 'Reason not given.' })
    assert.equal((await messages()).reports[0].txs[0].reason, 'Reason not given.')
  })

  test('internal payment to a screening name: reviewed too, then both camt.054', async () => {
    const first = await pay(one({ amount: '3.00', creditorName: 'Frauda Lott' }))
    assert.deepEqual(first.reports.map((r) => r.txs.map((t) => [t.sts, t.scheme])), [[['ACSP', 'INTERNAL']], [['PDNG', 'INTERNAL']]])
    await decide('approve', { refs: [first.reports[0].txs[0].ref!] })
    const after = await messages()
    assert.deepEqual(after.reports.map((r) => r.txs.map((t) => t.sts)), [['ACSC']])
    assert.deepEqual(after.notes.map((n) => n.ind), ['DBIT'])
    assert.deepEqual((await messages(C2.code)).notes.map((n) => [n.ind, n.amount]), [['CRDT', '3.00']])
    assert.equal(await balance(ctx, C2.iban), '103.00')
  })

  test('pending customer + screening name: SCA first, review after approval', async () => {
    await setPending()
    const first = await pay(one({ amount: '4.00', creditorIban: DE_IBAN, creditorName: 'Laundra Cashwell' }))
    assert.equal(first.reports[0].txs[0].sts, 'PDNG')
    await decide('approve', { refs: [first.reports[0].txs[0].ref!] })
    const after = await messages()
    assert.deepEqual(after.reports.map((r) => r.txs.map((t) => [t.sts, t.reason])), [[['ACSP', undefined]], [['PDNG', 'In manual review']]])
    assert.equal((await pendingList())[0].kind, 'REVIEW')
  })

  test('PAYMENT_MANUAL_REVIEW sample with a screening name: the published statuses', { skip: sample('PAYMENT_MANUAL_REVIEW', 'PAYMENT_PAIN.001.xml') ? false : 'docs mirror not available' }, async () => {
    const xml = sample('PAYMENT_MANUAL_REVIEW', 'PAYMENT_PAIN.001.xml')!
      .replace(/EE477700771001388940/g, C1.iban).replace('Martin George', 'Robba Bank')
    ctx = await setup({ strictIban: false })
    // The published payment went as SEPA: its receiving bank is not instant-reachable.
    await call(ctx, { method: 'POST', url: '/_sim/rails/no-instant', body: { account: 'GB87BARC20498440880914' } })
    const r = await pay(xml)
    const statuses = (doc: string) => [...doc.matchAll(/<(GrpSts|PmtInfSts|TxSts|Prtry|AddtlInf)>([^<]+)</g)].map((m) => `${m[1]}=${m[2]}`)
    for (const [i, file] of ['PAYMENT_PAIN.002A.xml', 'PAYMENT_PAIN.002B.xml'].entries()) {
      const want = sample('PAYMENT_MANUAL_REVIEW', file)!
      const got = r.raw.filter((m) => m.type === 'PAYMENT')[i].body
      assert.deepEqual(statuses(got), statuses(want), file)
      assert.equal(/<OrgnlMsgId>([^<]+)</.exec(got)![1], /<OrgnlMsgId>([^<]+)</.exec(want)![1])
      assert.equal(/<OrgnlInstrId>([^<]+)</.exec(got)![1], /<OrgnlInstrId>([^<]+)</.exec(want)![1])
    }
  })
})
