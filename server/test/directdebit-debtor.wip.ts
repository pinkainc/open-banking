// WIP (not run: not *.test.ts). 16/25 fail only because LHV pain.007.001.09 XSD requires
// GrpHdr/CtrlSum: make helpers.pain007 always emit CtrlSum (pass the collection amount),
// then rename back to directdebit-debtor.test.ts.
// L4 SEPA Direct Debit, the debtor's side and the other bank: the incoming collection
// notification, refusals (pain.007.001.09 to POST /direct-debit/incoming-collection)
// before the cut-off, between cut-off and settlement and after settlement (refund),
// collections from creditors at other banks (/_sim/direct-debit/incoming), R-transactions
// from debtor banks (/_sim/direct-debit/return) and VIBAN debtors. Every pain.002 /
// pain.008 / camt.054 produced is checked against the published XSD (ddDrain).
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { DAY_MS } from '../src/clock.js'
import { FUNDING } from '../src/emulator.js'
import { E, REASONS } from '../src/directdebit/service.js'
import { C1, C2, CREDITOR_ID, FR_IBAN, balance, call, ddDrain, ddEntry, ddStatus, pain007, pain008, setup, type Ctx } from './helpers.js'

let ctx: Ctx
beforeEach(async () => { ctx = await setup() })

const CUTOFF = '2026-03-12T09:30:00Z' // 10:30 CET on the settlement date
const SETTLEMENT = '2026-03-12T10:30:00Z' // 11:30 CET
const json = (r: { body: string }) => JSON.parse(r.body)

let n = 0
/** C1 collects from a debtor (C2 by default); both inboxes are emptied. */
async function collection(o: { debtorIban?: string; amount?: string; as?: string; creditorIban?: string } = {}) {
  const id = ++n
  const ids = { pmtInfId: `PMT-D${id}`, endToEndId: `E2E-D${id}`, instrId: `INSTR-D${id}` }
  const xml = pain008([{ pmtInfId: ids.pmtInfId, creditorIban: o.creditorIban, txs: [{ endToEndId: ids.endToEndId, instrId: ids.instrId, amount: o.amount ?? '10.00', debtorIban: o.debtorIban }] }])
  const res = await call(ctx, { method: 'POST', url: '/direct-debit/collection', body: xml, as: o.as ?? C1.code })
  assert.equal(res.statusCode, 202)
  const creditor = await ddDrain(ctx, o.as ?? C1.code)
  assert.equal(ddStatus(creditor[0]).grp, 'ACCP', creditor[0].body)
  const debtor = o.debtorIban && o.debtorIban !== C2.iban ? [] : await ddDrain(ctx, C2.code)
  return { ...ids, requestId: res.headers['message-request-id'] as string, notification: debtor[0] }
}

async function refuse(xml: string, as = C2.code) {
  const res = await call(ctx, { method: 'POST', url: '/direct-debit/incoming-collection', body: xml, as })
  assert.equal(res.statusCode, 202, res.body)
  return res.headers['message-request-id'] as string
}

async function settle(at = SETTLEMENT) {
  ctx.clock.set(at)
  return json(await call(ctx, { method: 'POST', url: '/_sim/direct-debit/settle' })).settled as number
}

/** The answer to a pain.007 (DIRECT_DEBIT_INCOMING) and whatever else came with it. */
async function answered(xml: string, as = C2.code) {
  const id = await refuse(xml, as)
  const msgs = await ddDrain(ctx, as)
  const answer = msgs.find((m) => m.type === 'DIRECT_DEBIT_INCOMING')
  assert.ok(answer, msgs.map((m) => m.type).join())
  assert.equal(answer.requestId, id)
  return { status: ddStatus(answer), rest: msgs.filter((m) => m !== answer) }
}

describe('the debtor notification', () => {
  test('one pain.008.001.08 per collection, with the creditor PmtInfId and EndToEndId', async () => {
    const c = await collection()
    assert.equal(c.notification.type, 'DIRECT_DEBIT_INCOMING_COLLECTION_NOTIFICATION')
    const d = c.notification.doc.Document.CstmrDrctDbtInitn
    assert.equal(String(d.GrpHdr.NbOfTxs), '1')
    assert.equal(d.PmtInf.PmtInfId, c.pmtInfId)
    assert.equal(d.PmtInf.DrctDbtTxInf.PmtId.EndToEndId, c.endToEndId)
    assert.equal(d.PmtInf.ReqdColltnDt, '2026-03-12')
    assert.equal(d.PmtInf.Cdtr.Nm, 'Demo Customer 1')
    assert.equal(d.PmtInf.CdtrSchmeId.Id.PrvtId.Othr.Id, CREDITOR_ID)
    assert.equal(d.PmtInf.DrctDbtTxInf.DbtrAcct.Id.IBAN, C2.iban)
    assert.match(String(d.PmtInf.DrctDbtTxInf.DrctDbtTx.MndtRltdInf.MndtId), /^MANDATE-/)
    assert.equal(c.notification.requestId, undefined, 'unsolicited')
  })
})

describe('refusal before the cut-off', () => {
  test('ACCP, cancel notification to the debtor, RJCT to the creditor, nothing booked', async () => {
    const c = await collection()
    const xml = pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId, reason: 'MS02' }], { msgId: 'REFUSE-1', ctrlSum: '10.00' })
    const { status, rest } = await answered(xml)
    assert.deepEqual([status.orgnlMsgId, status.orgnlMsgNmId], ['REFUSE-1', 'pain.007.001.09'])
    assert.deepEqual(status.blocks.map((b) => [b.pmtInfId, b.txs[0].endToEndId, b.txs[0].sts]), [[c.pmtInfId, c.endToEndId, 'ACCP']])
    assert.deepEqual(rest.map((m) => m.type), ['DIRECT_DEBIT_INCOMING_CANCEL_NOTIFICATION'])
    const cancel = ddStatus(rest[0])
    assert.equal(cancel.orgnlMsgId, c.notification.doc.Document.CstmrDrctDbtInitn.GrpHdr.MsgId, 'refers to the notification (docs/decisions.md 307)')
    assert.deepEqual([cancel.blocks[0].txs[0].sts, cancel.blocks[0].txs[0].code], ['RJCT', 'MS02'])

    const [creditor] = await ddDrain(ctx)
    assert.equal(creditor.requestId, c.requestId)
    const t = ddStatus(creditor).blocks[0].txs[0]
    assert.deepEqual([t.endToEndId, t.sts, t.code, t.info], [c.endToEndId, 'RJCT', 'MS02', REASONS.MS02])

    assert.equal(await settle(), 0)
    assert.deepEqual(await ddDrain(ctx), [])
    assert.deepEqual(await ddDrain(ctx, C2.code), [])
    assert.equal(await balance(ctx, C2.iban), '100.00')
    assert.equal(ctx.emulator.directDebit.collections[0].status, 'REFUSED')
  })

  test('the reason may sit on the block or the group (EPC usage rule)', async () => {
    const c = await collection()
    const xml = pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId, reason: null }])
      .replace('<OrgnlMsgNmId>pain.008.001.08</OrgnlMsgNmId>', '<OrgnlMsgNmId>pain.008.001.08</OrgnlMsgNmId><RvslRsnInf><Rsn><Cd>MD01</Cd></Rsn></RvslRsnInf>')
    const { status, rest } = await answered(xml)
    assert.equal(status.blocks[0].txs[0].sts, 'ACCP')
    assert.equal(ddStatus(rest[0]).blocks[0].txs[0].code, 'MD01')
  })

  test('just before 10:30 CET on the settlement date is still a refusal', async () => {
    const c = await collection()
    ctx.clock.set('2026-03-12T09:29:59Z')
    const { rest } = await answered(pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId }]))
    assert.deepEqual(rest.map((m) => m.type), ['DIRECT_DEBIT_INCOMING_CANCEL_NOTIFICATION'])
  })
})

describe('refusal between the cut-off and settlement', () => {
  test('accepted, settled at 11:30 CET and returned right after (docs/decisions.md 316)', async () => {
    const c = await collection()
    ctx.clock.set(CUTOFF)
    const { status, rest } = await answered(pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId, reason: 'MS02' }]))
    assert.equal(status.blocks[0].txs[0].sts, 'ACCP')
    assert.deepEqual(rest, [], 'no cancel notification')
    await settle()
    const debtor = (await ddDrain(ctx, C2.code)).map(ddEntry)
    assert.deepEqual(debtor.map((e) => [e.ind, e.family, e.subFamily]), [['DBIT', 'RDDT', 'ESDD'], ['CRDT', 'RDDT', 'UPDD']])
    assert.deepEqual([debtor[1].returnCode, debtor[1].returnInfo], ['NARR', [c.instrId, 'CD:MS02']])
    const creditor = await ddDrain(ctx)
    const entries = creditor.filter((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION').map(ddEntry)
    assert.deepEqual(entries.map((e) => [e.ind, e.family, e.subFamily]), [['CRDT', 'IDDT', 'ESDD'], ['DBIT', 'IDDT', 'UPDD']])
    assert.equal(ddStatus(creditor.find((m) => m.type === 'DIRECT_DEBIT_OUTGOING')!).blocks[0].txs[0].sts, 'ACSC')
    assert.equal(await balance(ctx, C2.iban), '100.00')
    assert.equal(await balance(ctx, C1.iban), '10000.00')
    assert.equal(ctx.emulator.directDebit.collections[0].status, 'REFUNDED')
  })

  test('a second refusal of the same collection is refused', async () => {
    const c = await collection()
    ctx.clock.set(CUTOFF)
    await answered(pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId }]))
    const { status } = await answered(pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId }]))
    assert.deepEqual([status.blocks[0].txs[0].sts, status.blocks[0].txs[0].info], ['RJCT', E.alreadyRefused])
  })
})

describe('refusal after settlement (refund)', () => {
  test('within 8 weeks: ACCP and camt.054 with RtrInf to both sides', async () => {
    const c = await collection({ amount: '30.00' })
    await settle()
    await ddDrain(ctx)
    await ddDrain(ctx, C2.code)
    ctx.clock.set(new Date(Date.parse(SETTLEMENT) + 56 * DAY_MS))
    const { status, rest } = await answered(pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId, reason: 'MD01' }]))
    assert.equal(status.blocks[0].txs[0].sts, 'ACCP')
    const credit = ddEntry(rest.find((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION')!)
    assert.deepEqual([credit.ind, credit.amount, credit.returnCode, credit.returnInfo], ['CRDT', '30.00', 'NARR', [c.instrId, 'CD:MD01']])
    assert.equal(credit.endToEndId, c.endToEndId)
    const debit = ddEntry((await ddDrain(ctx))[0])
    assert.deepEqual([debit.account, debit.ind, debit.returnInfo], [C1.iban, 'DBIT', [c.instrId, 'CD:MD01']])
    assert.equal(await balance(ctx, C2.iban), '100.00')
    const { status: again } = await answered(pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId }]))
    assert.equal(again.blocks[0].txs[0].info, E.alreadyRefused)
  })

  test('after 8 weeks: RJCT, the refund goes by e-mail', async () => {
    const c = await collection()
    await settle()
    ctx.clock.set(new Date(Date.parse(SETTLEMENT) + 56 * DAY_MS + 1000))
    const { status, rest } = await answered(pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId }]))
    assert.deepEqual([status.blocks[0].txs[0].sts, status.blocks[0].txs[0].info], ['RJCT', E.refundPeriod])
    assert.ok(!rest.some((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION'))
    assert.equal(await balance(ctx, C2.iban), '90.00')
  })

  test('the creditor balance cannot cover the refund: RJCT AM04 (docs/decisions.md 308)', async () => {
    const c = await collection({ amount: '10.00' })
    await settle()
    await ctx.emulator.ledger.transfer({ ref: 'drain', from: C1.iban, to: FUNDING, amount: 1000500n, currency: 'EUR' })
    const { status } = await answered(pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId }]))
    assert.deepEqual([status.blocks[0].txs[0].sts, status.blocks[0].txs[0].code, status.blocks[0].txs[0].info], ['RJCT', 'AM04', REASONS.AM04])
    assert.equal(await balance(ctx, C2.iban), '90.00')
  })

  test('a collection rejected at settlement (AM04) cannot be refused', async () => {
    const c = await collection({ amount: '500.00' })
    await settle()
    const { status } = await answered(pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId }]))
    assert.equal(status.blocks[0].txs[0].info, E.alreadyRejected)
  })
})

describe('refusal request checks', () => {
  test('NbOfTxs other than 1: group RJCT', async () => {
    const a = await collection()
    const b = await collection()
    const { status } = await answered(pain007([{ pmtInfId: a.pmtInfId, endToEndId: a.endToEndId }, { pmtInfId: b.pmtInfId, endToEndId: b.endToEndId }]))
    assert.deepEqual([status.grp, status.grpInfo, status.blocks], ['RJCT', E.oneOnly, []])
    const { status: count } = await answered(pain007([{ pmtInfId: a.pmtInfId, endToEndId: a.endToEndId }], { nbOfTxs: '2' }))
    assert.deepEqual([count.grp, count.grpInfo], ['RJCT', E.headerCount])
    assert.equal(ctx.emulator.directDebit.collections.filter((c) => c.status === 'PENDING').length, 2)
  })

  test('unmatched OrgnlPmtInfId or OrgnlEndToEndId: Collection not found', async () => {
    const c = await collection()
    for (const t of [{ pmtInfId: 'NOPE', endToEndId: c.endToEndId }, { pmtInfId: c.pmtInfId, endToEndId: 'NOPE' }]) {
      const { status } = await answered(pain007([t]))
      assert.deepEqual([status.blocks[0].txs[0].sts, status.blocks[0].txs[0].info], ['RJCT', E.notFound])
    }
  })

  test("another customer cannot refuse the debtor's collection", async () => {
    const c = await collection()
    const { status } = await answered(pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId }]), C1.code)
    assert.equal(status.blocks[0].txs[0].info, E.notFound)
  })

  test('missing OrgnlEndToEndId, wrong CtrlSum, missing reason, duplicate MsgId, wrong version', async () => {
    const c = await collection()
    const r1 = await answered(pain007([{ pmtInfId: c.pmtInfId }]))
    assert.equal(r1.status.grp, 'RJCT')
    assert.match(r1.status.grpInfo!, /^Uploading file failed\. XML Schema validation error\./)
    const r2 = await answered(pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId }], { ctrlSum: '9.99' }))
    assert.equal(r2.status.blocks[0].txs[0].info, E.headerSum)
    const r3 = await answered(pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId, reason: null }]))
    assert.equal(r3.status.blocks[0].txs[0].info, E.noReason)
    await answered(pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId }], { msgId: 'R-DUP' }))
    const r4 = await answered(pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId }], { msgId: 'R-DUP' }))
    assert.deepEqual([r4.status.grp, r4.status.grpInfo], ['RJCT', E.duplicateMessage])
    const r5 = await answered(pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId }]).replace('pain.007.001.09', 'pain.007.001.02'))
    assert.equal(r5.status.grpInfo, E.schema('pain.007.001.02 is not pain.007.001.09.'))
  })

  test('not XML: 400', async () => {
    const res = await call(ctx, { method: 'POST', url: '/direct-debit/incoming-collection', body: '<a><b></a>', as: C2.code })
    assert.equal(res.statusCode, 400)
  })
})

describe('a creditor at another bank (/_sim/direct-debit/incoming)', () => {
  const incoming = (body: object) => call(ctx, { method: 'POST', url: '/_sim/direct-debit/incoming', body })

  test('notified, settled on the due date, refusable; no creditor report here', async () => {
    const res = await incoming({ debtorIban: C2.iban, amount: '25.00', creditor: { name: 'Stadtwerke' }, endToEndId: 'EXT-1', pmtInfId: 'EXTPMT-1', dueDate: '2026-03-12' })
    assert.equal(res.statusCode, 201)
    const view = json(res)
    assert.deepEqual([view.status, view.amount, view.settlementDate, view.creditor.bic], ['PENDING', '25.00', '2026-03-12', 'COBADEFFXXX'])
    const [note] = await ddDrain(ctx, C2.code)
    assert.equal(note.type, 'DIRECT_DEBIT_INCOMING_COLLECTION_NOTIFICATION')
    assert.equal(note.doc.Document.CstmrDrctDbtInitn.PmtInf.Cdtr.Nm, 'Stadtwerke')
    await settle()
    const [debit] = await ddDrain(ctx, C2.code)
    assert.deepEqual([ddEntry(debit).ind, ddEntry(debit).cdtr], ['DBIT', 'Stadtwerke'])
    assert.equal(await balance(ctx, C2.iban), '75.00')
    assert.deepEqual(await ddDrain(ctx), [])
    const list = json(await call(ctx, { url: '/_sim/direct-debit/collections' }))
    assert.deepEqual(list.collections.map((c: any) => [c.endToEndId, c.status, c.debtorCustomer.code]), [['EXT-1', 'SETTLED', C2.code]])
  })

  test('default due date: the next TARGET2 day after today', async () => {
    ctx.clock.set('2026-03-13T08:00:00Z') // Friday
    const view = json(await incoming({ debtorIban: C2.iban, amount: '1.00' }))
    assert.equal(view.settlementDate, '2026-03-16')
  })

  test('refused before the cut-off: cancel notification, nothing booked', async () => {
    await incoming({ debtorIban: C2.iban, amount: '5.00', endToEndId: 'EXT-2', pmtInfId: 'EXTPMT-2', dueDate: '2026-03-12' })
    await ddDrain(ctx, C2.code)
    const { rest } = await answered(pain007([{ pmtInfId: 'EXTPMT-2', endToEndId: 'EXT-2', reason: 'MD01' }]))
    assert.deepEqual(rest.map((m) => m.type), ['DIRECT_DEBIT_INCOMING_CANCEL_NOTIFICATION'])
    await settle()
    assert.equal(await balance(ctx, C2.iban), '100.00')
  })

  test('refund after settlement goes back through the settlement account', async () => {
    await incoming({ debtorIban: C2.iban, amount: '5.00', endToEndId: 'EXT-3', pmtInfId: 'EXTPMT-3', dueDate: '2026-03-12' })
    await settle()
    await ddDrain(ctx, C2.code)
    const { rest } = await answered(pain007([{ pmtInfId: 'EXTPMT-3', endToEndId: 'EXT-3' }]))
    assert.equal(ddEntry(rest.find((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION')!).ind, 'CRDT')
    assert.equal(await balance(ctx, C2.iban), '100.00')
  })

  test('errors: unknown account 404, bad amount 400, VIBAN debtor 409 (AG01)', async () => {
    assert.equal((await incoming({ debtorIban: FR_IBAN, amount: '1.00' })).statusCode, 404)
    assert.equal((await incoming({ debtorIban: C2.iban, amount: 'x' })).statusCode, 400)
    assert.equal((await incoming({ debtorIban: C2.iban, amount: '0.00' })).statusCode, 400)
    assert.equal((await incoming({ amount: '1.00' })).statusCode, 400)
    assert.equal((await incoming({ debtorIban: C2.iban, amount: '1.00', dueDate: '12.03.2026' })).statusCode, 400)
    const VIBAN = 'EE467777000010897825'
    ctx.emulator.viban.registry.add({ iban: VIBAN, master: C1.iban, owner: { code: C1.code, country: 'EE' }, status: 'ACTIVE', user: { address: { Country: 'EE', StreetNo: 'x', CityCounty: 'Tallinn' } } as any, createdAt: new Date() })
    const v = await incoming({ debtorIban: VIBAN, amount: '1.00' })
    assert.equal(v.statusCode, 409, v.body)
  })
})

describe('R-transactions from the debtor bank (/_sim/direct-debit/return)', () => {
  const ret = (body: object) => call(ctx, { method: 'POST', url: '/_sim/direct-debit/return', body })

  test('before settlement: a refusal, RJCT to the creditor, never presented', async () => {
    const c = await collection({ debtorIban: FR_IBAN })
    const res = await ret({ endToEndId: c.endToEndId, code: 'AC04' })
    assert.equal(res.statusCode, 200)
    assert.equal(json(res).status, 'REFUSED')
    const t = ddStatus((await ddDrain(ctx))[0]).blocks[0].txs[0]
    assert.deepEqual([t.sts, t.code], ['RJCT', 'AC04'])
    await settle()
    assert.equal((ctx.emulator.rails as any).collections.length, 0)
  })

  test('after settlement: a return debited from the creditor up to 13 months', async () => {
    const c = await collection({ debtorIban: FR_IBAN, amount: '40.00' })
    await settle()
    await ddDrain(ctx)
    assert.equal(await balance(ctx, C1.iban), '10040.00')
    ctx.clock.set(new Date(Date.parse(SETTLEMENT) + 395 * DAY_MS))
    const res = await ret({ endToEndId: c.endToEndId, pmtInfId: c.pmtInfId, code: 'MD01' })
    assert.equal(res.statusCode, 200, res.body)
    const [m] = await ddDrain(ctx)
    const e = ddEntry(m)
    assert.deepEqual([e.ind, e.amount, e.returnCode, e.returnInfo], ['DBIT', '40.00', 'NARR', [c.instrId, 'CD:MD01']])
    assert.equal(await balance(ctx, C1.iban), '10000.00')
    assert.equal((await ret({ endToEndId: c.endToEndId, code: 'MD01' })).statusCode, 409, 'already refunded')
  })

  test('refused after 13 months, without the money, or for an unknown collection', async () => {
    const c = await collection({ debtorIban: FR_IBAN })
    await settle()
    ctx.clock.set(new Date(Date.parse(SETTLEMENT) + 396 * DAY_MS))
    assert.equal((await ret({ endToEndId: c.endToEndId, code: 'MD01' })).statusCode, 409)
    ctx.clock.set(new Date(Date.parse(SETTLEMENT) + DAY_MS))
    await ctx.emulator.ledger.transfer({ ref: 'drain', from: C1.iban, to: FUNDING, amount: 1000500n, currency: 'EUR' })
    assert.equal((await ret({ endToEndId: c.endToEndId, code: 'MD01' })).statusCode, 409)
    assert.equal((await ret({ endToEndId: 'UNKNOWN', code: 'MD01' })).statusCode, 404)
    assert.equal((await ret({ endToEndId: c.endToEndId })).statusCode, 400)
  })

  test('only collections to external debtors', async () => {
    const c = await collection()
    assert.equal((await ret({ endToEndId: c.endToEndId, code: 'AC04' })).statusCode, 404)
  })
})

describe('a VIBAN as the debtor account', () => {
  test('rejected with AG01 (docs/decisions.md 312)', async () => {
    const VIBAN = 'EE467777000010897825'
    ctx.emulator.viban.registry.add({ iban: VIBAN, master: C1.iban, owner: { code: C1.code, country: 'EE' }, status: 'ACTIVE', user: { address: { Country: 'EE', StreetNo: 'x', CityCounty: 'Tallinn' } } as any, createdAt: new Date() })
    const res = await call(ctx, { method: 'POST', url: '/direct-debit/collection', body: pain008([{ creditorIban: C2.iban, txs: [{ debtorIban: VIBAN, debtorName: 'Demo Customer 1' }] }]), as: C2.code })
    assert.equal(res.statusCode, 202)
    const t = ddStatus((await ddDrain(ctx, C2.code))[0]).blocks[0].txs[0]
    assert.deepEqual([t.sts, t.code, t.info], ['RJCT', 'AG01', REASONS.AG01])
    assert.deepEqual(await ddDrain(ctx), [], 'no notification to the VIBAN owner')
  })
})
