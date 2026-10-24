// L4 SEPA Direct Debit, the creditor's side: POST /direct-debit/collection (pain.008.001.08),
// the pain.002 reports at submission and settlement, the group and transaction error
// tables of P 09, the TARGET2 calendar, the published sample and authentication. Every
// pain.002 / pain.008 / camt.054 produced is checked against the published XSD (ddDrain).
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { E, REASONS } from '../src/directdebit/service.js'
import { easter, isTarget2Day, previousTarget2Day, settlementDate, submissionCutoff } from '../src/directdebit/target2.js'
import { SimulatorRails } from '../src/rails.js'
import {
  C1, C2, CREDITOR_ID, DE_IBAN, FR_IBAN, HAVE_REFERENCE, SP, balance, call, ddDrain, ddEntry, ddStatus, pain008, report, sample, schemaValid, setup, type Ctx,
} from './helpers.js'
import { many, text } from '../src/xml.js'

let ctx: Ctx
beforeEach(async () => { ctx = await setup() })

/** 11:30 CET on 2026-03-12, the default due date (Tallinn is UTC+2 in March). */
const SETTLEMENT = '2026-03-12T10:30:00Z'

async function collect(xml: string, as = C1.code, headers: Record<string, string> = {}) {
  const res = await call(ctx, { method: 'POST', url: '/direct-debit/collection', body: xml, as, headers })
  assert.equal(res.statusCode, 202, res.body)
  const id = res.headers['message-request-id'] as string
  assert.match(id, /^REQ[0-9a-f]{32}$/)
  return id
}

async function settle(at = SETTLEMENT) {
  ctx.clock.set(at)
  const res = await call(ctx, { method: 'POST', url: '/_sim/direct-debit/settle' })
  assert.equal(res.statusCode, 200)
  return JSON.parse(res.body).settled as number
}

/** Submits one file and returns its first (submission) report. */
async function submitted(xml: string) {
  const id = await collect(xml)
  const msgs = await ddDrain(ctx)
  assert.equal(msgs.length, 1, msgs.map((m) => m.type).join())
  assert.equal(msgs[0].type, 'DIRECT_DEBIT_OUTGOING')
  assert.equal(msgs[0].requestId, id)
  return ddStatus(msgs[0])
}

/** A file refused as a whole: group RJCT, NARR with the documented text, nothing recorded. */
async function groupRejected(xml: string, text: string, msgId?: string): Promise<void> {
  const r = await submitted(xml)
  assert.equal(r.grp, 'RJCT')
  assert.equal(r.grpCode, 'NARR')
  assert.equal(r.grpInfo, text)
  assert.deepEqual(r.blocks, [])
  assert.equal((await ctx.emulator.directDebit.collections()).length, 0)
  if (msgId) assert.equal(r.orgnlMsgId, msgId)
}

describe('collection from a debtor here', () => {
  test('ACCP at submission, debtor notified, ACSC and camt.054 to both sides at 11:30 CET', async () => {
    const xml = pain008([{ pmtInfId: 'PMT-A', txs: [{ endToEndId: 'E2E-A', amount: '25.50', ustrd: 'Invoice 7' }] }], { msgId: 'MSG-A' })
    const id = await collect(xml)
    const [first] = await ddDrain(ctx)
    assert.equal(first.requestId, id)
    const r = ddStatus(first)
    assert.equal(r.orgnlMsgId, 'MSG-A')
    assert.equal(r.orgnlMsgNmId, 'pain.008.001.08')
    assert.equal(r.grp, 'ACCP')
    assert.equal(r.blocks[0].sts, 'ACCP')
    assert.deepEqual(r.blocks[0].txs.map((t) => [t.endToEndId, t.sts]), [['E2E-A', 'ACCP']])
    assert.ok(r.blocks[0].txs[0].ref, 'AcctSvcrRef on an accepted collection')

    const [note] = await ddDrain(ctx, C2.code)
    assert.equal(note.type, 'DIRECT_DEBIT_INCOMING_COLLECTION_NOTIFICATION')
    assert.equal(await balance(ctx, C2.iban), '100.00', 'nothing booked before the settlement date')

    assert.equal(await settle('2026-03-12T10:29:59Z'), 0, 'not before 11:30 CET')
    assert.equal(await settle(), 1)
    const c1 = await ddDrain(ctx)
    assert.deepEqual(c1.map((m) => m.type).sort(), ['CREDIT_DEBIT_NOTIFICATION', 'DIRECT_DEBIT_OUTGOING'])
    c1.sort((a, b) => b.type.localeCompare(a.type))
    const later = ddStatus(c1[0])
    assert.equal(c1[0].requestId, id, 'later reports carry the Message-Request-Id')
    assert.equal(later.grp, undefined, 'no GrpSts after the first report')
    assert.equal(later.blocks[0].sts, undefined, 'no PmtInfSts after the first report')
    assert.equal(later.blocks[0].txs[0].sts, 'ACSC')
    const credit = ddEntry(c1[1])
    assert.deepEqual([credit.account, credit.ind, credit.amount, credit.family, credit.subFamily, credit.prtry],
      [C1.iban, 'CRDT', '25.50', 'IDDT', 'ESDD', 'SEPADD'])
    assert.equal(credit.endToEndId, 'E2E-A')
    assert.equal(credit.mandateId, later.blocks[0].txs[0].mandateId)

    const c2 = await ddDrain(ctx, C2.code)
    assert.deepEqual(c2.map((m) => m.type), ['CREDIT_DEBIT_NOTIFICATION'])
    const debit = ddEntry(c2[0])
    assert.deepEqual([debit.account, debit.ind, debit.amount, debit.family, debit.subFamily], [C2.iban, 'DBIT', '25.50', 'RDDT', 'ESDD'])
    assert.equal(await balance(ctx, C1.iban), '10025.50')
    assert.equal(await balance(ctx, C2.iban), '74.50')
    assert.equal(await settle('2026-03-13T10:30:00Z'), 0, 'settled once')
  })

  test('the settlement entries reach the journal (account statements)', async () => {
    await collect(pain008([{ txs: [{ amount: '5.00' }] }]))
    await settle()
    const range = [0, Date.parse('2027-01-01')] as const
    const debit = (await ctx.emulator.journal.entries(C2.iban, ...range)).filter((e) => e.scheme === 'SEPADD')
    const credit = (await ctx.emulator.journal.entries(C1.iban, ...range)).filter((e) => e.scheme === 'SEPADD')
    assert.deepEqual([debit.length, debit[0].direction, credit.length, credit[0].direction], [1, 'DBIT', 1, 'CRDT'])
  })

  test('camt.053 entries carry the direct debit\'s own BkTxCd (IDDT / RDDT, ESDD), as its camt.054 does (decision 408)', async () => {
    await collect(pain008([{ pmtInfId: 'PMT-ST', txs: [{ endToEndId: 'E2E-ST', amount: '7.25' }] }]))
    await ddDrain(ctx)
    await ddDrain(ctx, C2.code)
    await settle()
    const notes = new Map<string, ReturnType<typeof ddEntry>>()
    for (const [who] of [[C1.code], [C2.code]]) {
      for (const m of await ddDrain(ctx, who)) if (m.type === 'CREDIT_DEBIT_NOTIFICATION') notes.set(who, ddEntry(m))
    }
    const rows = []
    for (const [who, iban] of [[C1.code, C1.iban], [C2.code, C2.iban]]) {
      const r = await report(ctx, { kind: 'statement', iban, frDt: '2026-03-12' }, { as: who })
      assert.equal(r.msgs.length, 1)
      assert.ok(!r.msgs[0].doc.Errors, r.msgs[0].body)
      await schemaValid(r.msgs[0].body)
      const entries = many<any>(r.msgs[0].doc.Document.BkToCstmrStmt.Stmt).flatMap((st) => many<any>(st.Ntry)).filter((e) => e.BkTxCd.Prtry?.Cd === 'SEPADD')
      assert.equal(entries.length, 1, who)
      const e = entries[0]
      const row = [who, e.CdtDbtInd, text(e.Amt), e.BkTxCd.Domn.Cd, e.BkTxCd.Domn.Fmly.Cd, e.BkTxCd.Domn.Fmly.SubFmlyCd, String(e.NtryDtls.TxDtls.Refs.PmtInfId), String(e.NtryDtls.TxDtls.Refs.EndToEndId)]
      const n = notes.get(who)!
      assert.deepEqual([n.ind, n.family, n.subFamily, n.pmtInfId], [row[1], row[4], row[5], row[6]], `${who}: camt.053 entry = camt.054`)
      rows.push(row)
    }
    assert.deepEqual(rows, [
      [C1.code, 'CRDT', '7.25', 'PMNT', 'IDDT', 'ESDD', 'PMT-ST', 'E2E-ST'],
      [C2.code, 'DBIT', '7.25', 'PMNT', 'RDDT', 'ESDD', 'PMT-ST', 'E2E-ST'],
    ])
  })

  test('AM04: not enough money on the settlement date; the debtor gets no message', async () => {
    await collect(pain008([{ txs: [{ amount: '100.01' }] }]))
    await ddDrain(ctx)
    await ddDrain(ctx, C2.code)
    await settle()
    const [m, ...rest] = await ddDrain(ctx)
    assert.equal(rest.length, 0)
    const t = ddStatus(m).blocks[0].txs[0]
    assert.deepEqual([t.sts, t.code, t.info], ['RJCT', 'AM04', REASONS.AM04])
    assert.deepEqual(await ddDrain(ctx, C2.code), [])
    assert.equal(await balance(ctx, C2.iban), '100.00')
    assert.equal(await balance(ctx, C1.iban), '10000.00')
    assert.equal((await ctx.emulator.directDebit.collections())[0].status, 'REJECTED')
    assert.equal(await settle('2026-03-13T10:30:00Z'), 0, 'one settlement attempt (docs/decisions.md 305)')
  })
})

describe('collection from a debtor at another bank', () => {
  const external = (o: { amount?: string } = {}) =>
    pain008([{ txs: [{ debtorIban: FR_IBAN, debtorBic: 'SATPFRP0', debtorName: 'SATP Debtor', endToEndId: 'E2E-FR', amount: o.amount ?? '12.00' }] }])

  test('presented through the rails on the settlement date, credited on ACSC', async () => {
    await collect(external())
    assert.equal((await ddDrain(ctx)).length, 1)
    const rails = ctx.emulator.rails as SimulatorRails
    assert.equal(rails.collections.length, 0, 'not before the settlement date')
    await settle()
    assert.equal(rails.collections.length, 1)
    assert.equal(rails.collections[0].debtor.iban, FR_IBAN)
    assert.equal(rails.collections[0].settlementDate, '2026-03-12')
    const msgs = (await ddDrain(ctx)).sort((a, b) => b.type.localeCompare(a.type))
    assert.deepEqual(msgs.map((m) => m.type), ['DIRECT_DEBIT_OUTGOING', 'CREDIT_DEBIT_NOTIFICATION'])
    assert.equal(ddStatus(msgs[0]).blocks[0].txs[0].sts, 'ACSC')
    assert.equal(ddEntry(msgs[1]).dbtr, 'SATP Debtor')
    assert.equal(await balance(ctx, C1.iban), '10012.00')
    const log = JSON.parse((await call(ctx, { url: '/_sim/direct-debit/rails/collections' })).body)
    assert.equal(log.collections[0].amount, '12.00')
  })

  test('the debtor bank rejects (/_sim/direct-debit/rails/reject): RJCT with its SEPA code', async () => {
    const r = await call(ctx, { method: 'POST', url: '/_sim/direct-debit/rails/reject', body: { debtorIban: FR_IBAN, code: 'AC04' } })
    assert.equal(r.statusCode, 200)
    await collect(external())
    await ddDrain(ctx)
    await settle()
    const msgs = await ddDrain(ctx)
    assert.equal(msgs.length, 1, 'no camt.054')
    const t = ddStatus(msgs[0]).blocks[0].txs[0]
    assert.deepEqual([t.sts, t.code, t.info], ['RJCT', 'AC04', REASONS.AC04])
    assert.equal(await balance(ctx, C1.iban), '10000.00')
    assert.equal((await call(ctx, { method: 'POST', url: '/_sim/direct-debit/rails/reject', body: { code: 'AC04' } })).statusCode, 400)
  })

  test('no debtor BIC: the agents read NOTPROVIDED and stay schema-valid', async () => {
    await collect(pain008([{ txs: [{ debtorIban: DE_IBAN, debtorBic: null, debtorName: 'Max' }] }]))
    const [m] = await ddDrain(ctx)
    assert.match(m.body, /<DbtrAgt><FinInstnId><Othr><Id>NOTPROVIDED<\/Id><\/Othr><\/FinInstnId><\/DbtrAgt>/)
  })
})

describe('file-level checks (P 09 group level errors)', () => {
  test('pain.008.001.02 is refused (docs/decisions.md 301)', async () => {
    await groupRejected(pain008([{ txs: [{}] }], { version: '02', msgId: 'OLD-1' }), E.schema('pain.008.001.02 is not pain.008.001.08.'), 'OLD-1')
  })

  test('not XML: 400 like /payment; an empty body: 400', async () => {
    const bad = await call(ctx, { method: 'POST', url: '/direct-debit/collection', body: '<Document><oops></Document>' })
    assert.equal(bad.statusCode, 400)
    assert.match(bad.body, /not well-formed XML/)
    const empty = await call(ctx, { method: 'POST', url: '/direct-debit/collection', body: ' ' })
    assert.equal(empty.statusCode, 400)
  })

  test('XSD validation error', { skip: HAVE_REFERENCE ? false : 'no XSDs' }, async () => {
    const xml = pain008([{ txs: [{}] }]).replace('<PmtMtd>DD</PmtMtd>', '<PmtMtd>TRF</PmtMtd>')
    const r = await submitted(xml)
    assert.equal(r.grp, 'RJCT')
    assert.match(r.grpInfo!, /^Uploading file failed\. XML Schema validation error\. /)
  })

  test('duplicate message: the same MsgId again from the same customer', async () => {
    const xml = pain008([{ txs: [{}] }], { msgId: 'DUP-1' })
    assert.equal((await submitted(xml)).grp, 'ACCP')
    await ddDrain(ctx, C2.code)
    const again = await submitted(pain008([{ txs: [{}] }], { msgId: 'DUP-1' }))
    assert.equal(again.grp, 'RJCT')
    assert.equal(again.grpInfo, E.duplicateMessage)
    assert.equal((await ctx.emulator.directDebit.collections()).length, 1)
  })

  test('a MsgId of a file refused as a whole can be used again (docs/decisions.md 314)', async () => {
    await groupRejected(pain008([{ txs: [{}] }], { msgId: 'RETRY-1', ctrlSum: '99.00' }), E.headerSum)
    assert.equal((await submitted(pain008([{ txs: [{}] }], { msgId: 'RETRY-1' }))).grp, 'ACCP')
  })

  test('duplicate Payment Information block', () =>
    groupRejected(pain008([{ pmtInfId: 'B1', txs: [{}] }, { pmtInfId: 'B1', txs: [{}] }]), E.duplicateBlock('B1')))
  test('duplicate Direct Debit Transaction block', () =>
    groupRejected(pain008([{ txs: [{ endToEndId: 'X1' }, { endToEndId: 'X1' }] }]), E.duplicateTx('X1')))
  test('faulty number of transactions in the header', () => groupRejected(pain008([{ txs: [{}] }], { nbOfTxs: '2' }), E.headerCount))
  test('faulty control sum in the header', () => groupRejected(pain008([{ txs: [{}] }], { ctrlSum: '10.01' }), E.headerSum))
  test('faulty number of transactions in a block', () =>
    groupRejected(pain008([{ pmtInfId: 'BN', nbOfTxs: '3', txs: [{}] }]), E.blockCount('BN')))
  test('faulty control sum in a block', () =>
    groupRejected(pain008([{ pmtInfId: 'BS', ctrlSum: '1.00', txs: [{}] }]), E.blockSum('BS')))
  test('creditor scheme identification other than SEPA', () =>
    groupRejected(pain008([{ schemeName: 'XYZ', txs: [{}] }]), E.schemeName('XYZ')))
  test('routing code other than SEPADD', () => groupRejected(pain008([{ scheme: 'SEPA', txs: [{}] }]), E.routing('SEPA')))
  test('faulty creditor account: not an account here', () =>
    groupRejected(pain008([{ creditorIban: DE_IBAN, txs: [{}] }]), E.creditorAccount(DE_IBAN)))
  test("no rights to the creditor's account", () =>
    groupRejected(pain008([{ creditorIban: C2.iban, txs: [{ debtorIban: DE_IBAN }] }]), E.noRights(C2.iban)))
  test('debtor name missing', () => groupRejected(pain008([{ txs: [{ debtorName: null }] }]), E.debtorName))
  test('creditor name missing', () => groupRejected(pain008([{ creditorName: null, txs: [{}] }]), E.creditorName))
  test('invalid creditor identifier', () =>
    groupRejected(pain008([{ creditorId: 'EE00ZZZEE00012345678', txs: [{}] }]), E.creditorId('EE00ZZZEE00012345678')))
})

describe('collection-level checks (P 09 transaction level errors)', () => {
  test('mixed file: PART, each rejection with its text or SEPA code', async () => {
    const r = await submitted(pain008([{
      pmtInfId: 'MIX',
      txs: [
        { endToEndId: 'OK' },
        { endToEndId: 'NOMANDATE', mandateId: null },
        { endToEndId: 'BADIBAN', debtorIban: 'EE000000000000000000' },
        { endToEndId: 'BADCHECK', debtorIban: 'DE89370400440532013001' },
        { endToEndId: 'SELF', debtorIban: C1.iban, debtorName: 'Demo Customer 1' },
      ],
    }]))
    assert.equal(r.grp, 'PART')
    assert.equal(r.blocks[0].sts, 'PART')
    const by = Object.fromEntries(r.blocks[0].txs.map((t) => [t.endToEndId, [t.sts, t.code, t.info]]))
    assert.deepEqual(by, {
      OK: ['ACCP', undefined, undefined],
      NOMANDATE: ['RJCT', 'NARR', E.mandate],
      BADIBAN: ['RJCT', 'NARR', E.ibanFormat],
      BADCHECK: ['RJCT', 'NARR', E.ibanFormat],
      SELF: ['RJCT', 'AG01', REASONS.AG01],
    })
    assert.equal((await ctx.emulator.directDebit.collections()).length, 1, 'only the accepted collection is kept')
    const notes = await ddDrain(ctx, C2.code)
    assert.equal(notes.length, 1, 'the debtor hears only of the accepted collection')
  })

  test('a zero amount is AM02 (reachable only without the XSD, which requires 0.01)', async () => {
    ctx = await setup({ xsdDir: undefined })
    const r = await submitted(pain008([{ txs: [{ amount: '0.00' }] }]))
    assert.deepEqual([r.blocks[0].txs[0].code, r.blocks[0].txs[0].info], ['AM02', REASONS.AM02])
  })

  test('the XSD requires MndtId and an amount of at least 0.01', { skip: HAVE_REFERENCE ? false : 'no XSDs' }, async () => {
    const r = await submitted(pain008([{ txs: [{ amount: '0.00' }] }]))
    assert.match(r.grpInfo!, /XML Schema validation error\. Element 'InstdAmt'/)
  })

  test('every collection rejected: group and block RJCT', async () => {
    const r = await submitted(pain008([{ txs: [{ mandateId: null }] }]))
    assert.equal(r.grp, 'RJCT')
    assert.equal(r.blocks[0].sts, 'RJCT')
    assert.equal(r.grpInfo, undefined, 'no group reason when only collections are rejected')
  })

  test('a block-level rejection status per block in a two-block file', async () => {
    const r = await submitted(pain008([{ pmtInfId: 'G', txs: [{}] }, { pmtInfId: 'R', txs: [{ mandateId: null }] }]))
    assert.deepEqual(r.blocks.map((b) => [b.pmtInfId, b.sts]), [['G', 'ACCP'], ['R', 'RJCT']])
    assert.equal(r.grp, 'PART')
  })
})

describe('TARGET2 calendar and the collection window', () => {
  test('Easter, Good Friday, Easter Monday, 1 May, Christmas, New Year, weekends', () => {
    assert.equal(easter(2026), '2026-04-05')
    assert.equal(easter(2027), '2027-03-28')
    for (const d of ['2026-04-03', '2026-04-06', '2026-05-01', '2026-12-25', '2026-12-26', '2027-01-01', '2026-03-14', '2026-03-15']) {
      assert.equal(isTarget2Day(d), false, d)
    }
    for (const d of ['2026-04-02', '2026-04-07', '2026-03-16', '2026-12-24', '2026-12-31']) assert.equal(isTarget2Day(d), true, d)
  })

  test('the P 09 due date / cut-off / settlement table', () => {
    const row = (due: string) => {
      const s = settlementDate(due)
      return [previousTarget2Day(s), s]
    }
    assert.deepEqual(row('2026-12-25'), ['2026-12-24', '2026-12-28'])
    assert.deepEqual(row('2026-01-01'), ['2025-12-31', '2026-01-02'])
    assert.deepEqual(row('2026-03-14'), ['2026-03-13', '2026-03-16'], 'Saturday: Friday / Monday')
    assert.deepEqual(row('2026-03-15'), ['2026-03-13', '2026-03-16'], 'Sunday')
    assert.deepEqual(row('2026-03-16'), ['2026-03-13', '2026-03-16'], 'Monday')
    assert.deepEqual(row('2026-04-03'), ['2026-04-02', '2026-04-07'], 'Good Friday: Thursday / Tuesday')
    assert.deepEqual(row('2026-04-06'), ['2026-04-02', '2026-04-07'], 'Easter Monday')
    assert.deepEqual(row('2026-03-13'), ['2026-03-12', '2026-03-13'], 'Friday: Thursday / Friday')
    // 15:30 CET on the day before: 16:30 in Tallinn (UTC+2 in winter).
    assert.equal(new Date(submissionCutoff('2026-03-16')).toISOString(), '2026-03-13T14:30:00.000Z')
  })

  test('a Saturday due date settles on Monday at 11:30 CET', async () => {
    await collect(pain008([{ dueDate: '2026-03-14', txs: [{}] }]))
    assert.equal(await settle('2026-03-14T12:00:00Z'), 0)
    assert.equal(await settle('2026-03-16T10:29:00Z'), 0)
    assert.equal(await settle('2026-03-16T10:30:00Z'), 1)
  })

  test('summer time: 11:30 CEST is 09:30 UTC', async () => {
    ctx.clock.set('2026-06-01T08:00:00Z')
    await collect(pain008([{ dueDate: '2026-06-03', txs: [{}] }]))
    assert.equal(await settle('2026-06-03T09:29:00Z'), 0)
    assert.equal(await settle('2026-06-03T09:30:00Z'), 1)
  })

  test('at most 14 calendar days before the due date', async () => {
    const r = await submitted(pain008([{ pmtInfId: 'D14', dueDate: '2026-03-24', txs: [{}] }, { pmtInfId: 'D15', dueDate: '2026-03-25', txs: [{}] }]))
    assert.deepEqual(r.blocks.map((b) => [b.pmtInfId, b.txs[0].sts, b.txs[0].info]), [['D14', 'ACCP', undefined], ['D15', 'RJCT', E.date]])
  })

  test('the creditor cut-off: 15:30 CET on the TARGET2 day before', async () => {
    ctx.clock.set('2026-03-11T14:29:59Z')
    assert.equal((await submitted(pain008([{ dueDate: '2026-03-12', txs: [{}] }]))).grp, 'ACCP')
    ctx.clock.set('2026-03-11T14:30:01Z')
    const late = await submitted(pain008([{ dueDate: '2026-03-12', txs: [{}] }]))
    assert.deepEqual([late.grp, late.blocks[0].txs[0].info], ['RJCT', E.date])
    const past = await submitted(pain008([{ dueDate: '2026-03-01', txs: [{}] }]))
    assert.equal(past.blocks[0].txs[0].info, E.date)
  })
})

describe('the published sample DIRECT_DEBIT_PAIN.008.xml', { skip: sample('DIRECT_DEBIT_SEPA', 'DIRECT_DEBIT_PAIN.008.xml') ? false : 'reference material not available' }, () => {
  const raw = () => sample('DIRECT_DEBIT_SEPA', 'DIRECT_DEBIT_PAIN.008.xml')!
  const CREDITOR = { code: '22200001', country: 'EE', name: 'DirectdebitCreditoractive', iban: 'EE447700771002491205' }
  beforeEach(async () => { await ctx.emulator.addCustomer({ code: CREDITOR.code, country: 'EE', name: CREDITOR.name, accounts: [CREDITOR.iban], directDebit: { agreement: true } }) })

  test('as published it is a pain.008.001.02 and refused (docs/decisions.md 302)', async () => {
    await collect(raw(), CREDITOR.code)
    const [m] = await ddDrain(ctx, CREDITOR.code)
    const r = ddStatus(m)
    assert.equal(r.orgnlMsgId, 'lhvtestmsgid-pain008-220407aa101')
    assert.equal(r.grp, 'RJCT')
    assert.equal(r.grpInfo, E.schema('pain.008.001.02 is not pain.008.001.08.'))
  })

  test('patched to the documented pain.008.001.08 rules it is accepted and settled', async () => {
    // The sample disagrees with P 09 and its own XSD in four places; patched here:
    //  1. namespace pain.008.001.02 → .08
    //  2. SvcLvl/Cd SEPA → SvcLvl/Prtry SEPADD (the routing code the group errors name)
    //  3. LclInstrm NORM → CORE
    //  4. DtAndPlcOfBirth: CityOfBirth before CtryOfBirth (XSD order)
    // and the dates are moved from 2022 to the test clock.
    const xml = raw()
      .replace('pain.008.001.02', 'pain.008.001.08')
      .replace('<Cd>SEPA</Cd>', '<Prtry>SEPADD</Prtry>')
      .replace('<Cd>NORM</Cd>', '<Cd>CORE</Cd>')
      .replace(/(<CtryOfBirth>EE<\/CtryOfBirth>)\s*(<CityOfBirth>Tartu<\/CityOfBirth>)/, '$2$1')
      .replace('2022-04-08', '2026-03-12')
    await collect(xml, CREDITOR.code)
    const [m] = await ddDrain(ctx, CREDITOR.code)
    const r = ddStatus(m)
    assert.deepEqual([r.grp, r.blocks[0].pmtInfId, r.blocks[0].txs[0].endToEndId, r.blocks[0].txs[0].sts],
      ['ACCP', 'lhvtestpmtinfid220407aa101', 'lhvtestendtoendid220407aa101', 'ACCP'])
    assert.equal(r.blocks[0].txs[0].mandateId, 'MANDATEID1')
    await settle()
    const done = (await ddDrain(ctx, CREDITOR.code)).sort((a, b) => b.type.localeCompare(a.type))
    assert.deepEqual(done.map((x) => x.type), ['DIRECT_DEBIT_OUTGOING', 'CREDIT_DEBIT_NOTIFICATION'])
    assert.equal(ddEntry(done[1]).amount, '1.00')
    assert.equal(await balance(ctx, CREDITOR.iban), '1.00')
    assert.equal(CREDITOR_ID, 'EE49ZZZEE00012345678', 'the sample creditor identifier is a valid one')
  })
})

describe('authentication on the direct debit endpoints', () => {
  const xml = () => pain008([{ txs: [{}] }])
  for (const url of ['/direct-debit/collection', '/direct-debit/incoming-collection']) {
    test(`${url}: no certificate identity → 403`, async () => {
      const res = await call(ctx, { method: 'POST', url, body: xml(), as: null })
      assert.equal(res.statusCode, 403)
      assert.match(res.body, /User authentication certificate is missing/)
    })
    test(`${url}: unknown customer → 403`, async () => {
      const res = await call(ctx, { method: 'POST', url, body: xml(), as: '99999999' })
      assert.equal(res.statusCode, 403)
    })
    test(`${url}: a service provider without Client-Code → 403`, async () => {
      const res = await call(ctx, { method: 'POST', url, body: xml(), as: SP.code })
      assert.equal(res.statusCode, 403)
    })
  }

  test('a service provider collects for a connected customer; reports go to that customer', async () => {
    const headers = { 'Client-Code': C1.code, 'Client-Country': 'EE' }
    const id = await collect(xml(), SP.code, headers)
    const msgs = await ddDrain(ctx, SP.code, headers)
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].requestId, id)
    assert.equal(ddStatus(msgs[0]).grp, 'ACCP')
  })
})
