// Payment initiation: POST /payment (pain.001.001.09 and .03) and the messages it
// leaves in the inbox (pain.002 status reports, camt.054 notifications). Every
// pain.002.001.10 and camt.054 produced is validated against the published XSDs when
// they are available.
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { many } from '../src/xml.js'
import {
  C1, C2, DE_IBAN, HAVE_REFERENCE, NO_REFERENCE, SP, balance, call, drain, pain001, sample, setup, xsd, type Ctx, type TxSpec,
} from './helpers.js'

let ctx: Ctx
beforeEach(async () => { ctx = await setup() })

type Msg = Awaited<ReturnType<typeof drain>>[number]
const NS = (m: Msg) => /xmlns="urn:iso:std:iso:20022:tech:xsd:([^"]+)"/.exec(m.body)?.[1]

/** Every produced message must pass its published schema (when there is one). */
async function validate(msgs: Msg[]) {
  if (!HAVE_REFERENCE) return
  for (const m of msgs) {
    const ns = NS(m)
    if (!ns || !xsd.has(ns)) continue
    assert.deepEqual(await xsd.validate(m.body, ns), [], `${ns} is schema-valid:\n${m.body}`)
  }
}

async function pay(xml: string, as = C1.code, headers: Record<string, string> = {}) {
  const res = await call(ctx, { method: 'POST', url: '/payment', body: xml, as, headers })
  assert.equal(res.statusCode, 202, res.body)
  const requestId = res.headers['message-request-id'] as string
  assert.match(requestId, /^REQ[0-9a-f]{32}$/)
  const msgs = await drain(ctx, as, headers)
  await validate(msgs)
  const reports = msgs.filter((m) => m.type === 'PAYMENT')
  for (const r of reports) assert.equal(r.requestId, requestId, 'pain.002 carries the Message-Request-Id')
  const notes = msgs.filter((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION')
  for (const n of notes) assert.equal(n.requestId, undefined, 'camt.054 has no Message-Request-Id')
  return { msgs, reports: reports.map((r) => rpt(r)), notes: notes.map((n) => ntry(n)), raw: reports }
}
const one = (spec: TxSpec, o: Parameters<typeof pain001>[1] = {}) => pain001([{ txs: [spec] }], o)

/** The interesting bits of a pain.002. */
function rpt(m: Msg) {
  const r = m.doc.Document.CstmrPmtStsRpt
  const g = r.OrgnlGrpInfAndSts
  const txs = many(r.OrgnlPmtInfAndSts).flatMap((b: any) => many(b.TxInfAndSts))
  return {
    ns: NS(m), orgnlMsgId: String(g.OrgnlMsgId), grpSts: g.GrpSts as string | undefined,
    grpReason: g.StsRsnInf?.AddtlInf as string | undefined,
    pmtInfSts: many(r.OrgnlPmtInfAndSts).map((b: any) => b.PmtInfSts),
    txs: txs.map((t: any) => ({ sts: t.TxSts as string, reason: t.StsRsnInf?.AddtlInf as string | undefined, ref: t.AcctSvcrRef as string | undefined, scheme: t.OrgnlTxRef?.PmtTpInf?.SvcLvl?.Prtry })),
    doc: r,
  }
}
/** The interesting bits of a camt.054. */
function ntry(m: Msg) {
  const n = m.doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn
  return {
    ns: NS(m), iban: n.Acct.Id.IBAN as string, ind: n.Ntry.CdtDbtInd as string, amount: String(n.Ntry.Amt['#text'] ?? n.Ntry.Amt),
    ccy: n.Ntry.Amt['@Ccy'], ref: n.Ntry.AcctSvcrRef as string, scheme: n.Ntry.BkTxCd.Prtry.Cd as string, tx: n.Ntry.NtryDtls.TxDtls,
  }
}

describe('internal payment', () => {
  test('pain.001.001.09: ACSC report, DBIT to the debtor, CRDT to the creditor with its own camt.054', async () => {
    const xml = one({ amount: '10.50', creditorName: 'Demo Customer 2', ustrd: 'Invoice 7', reference: '13' }, { msgId: 'INT-1' })
    const { reports, notes } = await pay(xml)
    assert.equal(reports.length, 1)
    const [r] = reports
    assert.equal(r.ns, 'pain.002.001.10')
    assert.equal(r.orgnlMsgId, 'INT-1')
    assert.equal(r.grpSts, 'ACSC')
    assert.deepEqual(r.pmtInfSts, ['ACSC'])
    assert.equal(r.txs[0].sts, 'ACSC')
    assert.match(r.txs[0].ref!, /^[0-9A-F]{32}$/)
    assert.equal(notes.length, 1)
    assert.deepEqual({ ...notes[0], tx: undefined }, { ns: 'camt.054.001.02', iban: C1.iban, ind: 'DBIT', amount: '10.50', ccy: 'EUR', ref: r.txs[0].ref, scheme: 'INTERNAL', tx: undefined })
    assert.equal(notes[0].tx.RltdPties.CdtrAcct.Id.IBAN, C2.iban)

    const credit = await drain(ctx, C2.code)
    await validate(credit)
    assert.equal(credit.length, 1)
    assert.equal(credit[0].type, 'CREDIT_DEBIT_NOTIFICATION')
    const c = ntry(credit[0])
    assert.equal(c.iban, C2.iban)
    assert.equal(c.ind, 'CRDT')
    assert.equal(c.amount, '10.50')
    assert.notEqual(c.ref, r.txs[0].ref, 'each side has its own booking reference')
    assert.equal(c.tx.RltdPties.Dbtr.Nm, 'Demo Customer 1')
    assert.equal(c.tx.RltdPties.DbtrAcct.Id.IBAN, C1.iban)
    assert.equal(c.tx.RmtInf.Ustrd, 'Invoice 7')
    assert.equal(String(c.tx.RmtInf.Strd.CdtrRefInf.Ref), '13')

    assert.equal(await balance(ctx, C1.iban), '9989.50')
    assert.equal(await balance(ctx, C2.iban), '110.50')
  })

  test('camt.054.001.08 for a customer set up for it', async () => {
    await ctx.emulator.directory.update(C1, { camt054: '08' })
    const { notes } = await pay(one({ amount: '1.00' }))
    assert.equal(notes[0].ns, 'camt.054.001.08')
    const credit = await drain(ctx, C2.code)
    assert.equal(ntry(credit[0]).ns, 'camt.054.001.02', 'the creditor keeps its own version')
  })

  test('another currency debits that balance (USD)', async () => {
    await pay(one({ amount: '20.00', currency: 'USD' }))
    assert.equal(await balance(ctx, C1.iban, 'USD'), '480.00')
    assert.equal(await balance(ctx, C2.iban, 'USD'), '20.00')
  })

  test('a service provider pays for a connected customer: messages go to the customer', async () => {
    const headers = { 'Client-Code': C1.code, 'Client-Country': 'EE' }
    const { reports } = await pay(one({ amount: '1.00' }), SP.code, headers)
    assert.equal(reports[0].grpSts, 'ACSC')
    assert.equal((await call(ctx, { url: '/messages/count', as: SP.code, headers: { 'Client-Code': SP.code, 'Client-Country': 'EE', 'Filter-Service-Provider': '1' } })).body, '{"count":0}')
  })
})

describe('external payment', () => {
  test('ACSP report with group status, then ACSC report and DBIT camt.054', async () => {
    const { reports, notes } = await pay(one({ amount: '25.00', creditorIban: DE_IBAN }, { msgId: 'EXT-1' }))
    assert.equal(reports.length, 2)
    const [a, b] = reports
    assert.equal(a.grpSts, 'ACSP')
    assert.deepEqual(a.pmtInfSts, ['ACSP'])
    assert.equal(a.txs[0].sts, 'ACSP')
    assert.equal(a.txs[0].scheme, 'INST', 'automatic selection: EUR to a reachable SEPA bank is instant')
    assert.equal(b.grpSts, undefined, 'later reports carry no group status')
    assert.equal(b.orgnlMsgId, 'EXT-1')
    assert.equal(b.txs[0].sts, 'ACSC')
    assert.equal(b.txs[0].ref, a.txs[0].ref)
    assert.equal(notes.length, 1)
    assert.equal(notes[0].ind, 'DBIT')
    assert.equal(notes[0].scheme, 'INST')
    assert.equal(await balance(ctx, C1.iban), '9975.00')
    const sent = JSON.parse((await call(ctx, { url: '/_sim/rails/sent' })).body).payments
    assert.equal(sent.length, 1)
    assert.equal(sent[0].amount, '25.00')
    assert.equal(sent[0].creditor.iban, DE_IBAN)
  })

  test('scheme rejection (via /_sim): RJCT with the reason, funds released', async () => {
    const rj = await call(ctx, { method: 'POST', url: '/_sim/rails/reject', body: { account: DE_IBAN, reason: 'Account closed.' } })
    assert.equal(rj.statusCode, 200)
    const { reports, notes } = await pay(one({ amount: '25.00', creditorIban: DE_IBAN }))
    assert.equal(reports[0].grpSts, 'ACSP')
    assert.equal(reports[1].txs[0].sts, 'RJCT')
    assert.equal(reports[1].txs[0].reason, 'Account closed.')
    assert.equal(reports[1].txs[0].ref, undefined, 'no booking reference on a rejection')
    assert.equal(notes.length, 0)
    assert.equal(await balance(ctx, C1.iban), '10000.00')
    const acct = JSON.parse((await call(ctx, { url: `/_sim/accounts/${C1.iban}` })).body)
    assert.deepEqual(acct.balances.EUR, { balance: '10000.00', available: '10000.00' })
    await call(ctx, { method: 'POST', url: '/_sim/rails/reset' })
    const again = await pay(one({ amount: '25.00', creditorIban: DE_IBAN }))
    assert.equal(again.reports[1].txs[0].sts, 'ACSC')
  })

  test('instant refused: requested INST to an unreachable bank is rejected', async () => {
    await call(ctx, { method: 'POST', url: '/_sim/rails/no-instant', body: { account: DE_IBAN } })
    const { reports } = await pay(one({ amount: '5.00', creditorIban: DE_IBAN, scheme: 'INST' }))
    assert.equal(reports.length, 1)
    assert.equal(reports[0].grpSts, 'RJCT')
    assert.equal(reports[0].txs[0].reason, 'Instant payment forbidden, try European payment.')
    // Automatic selection falls back to SEPA for the same account.
    const auto = await pay(one({ amount: '5.00', creditorIban: DE_IBAN }))
    assert.equal(auto.reports[0].txs[0].scheme, 'SEPA')
    assert.equal(auto.reports[1].txs[0].sts, 'ACSC')
  })

  test('requested SEPA: EUR only', async () => {
    const { reports } = await pay(one({ amount: '5.00', currency: 'USD', creditorIban: DE_IBAN, scheme: 'SEPA' }))
    assert.equal(reports[0].txs[0].reason, 'Invalid currency.')
  })

  test('non-EUR goes through SWIFT', async () => {
    const { reports } = await pay(one({ amount: '5.00', currency: 'USD', creditorIban: DE_IBAN }))
    assert.equal(reports[0].txs[0].scheme, 'SWIFT')
    assert.equal(reports[1].txs[0].sts, 'ACSC')
  })

  test('IBAN check digits are verified (decision 18)', async () => {
    const { reports } = await pay(one({ amount: '5.00', creditorIban: 'DE00370400440532013000' }))
    assert.equal(reports[0].txs[0].reason, 'Incorrect account number.')
  })
})

describe('transaction-level rejections', () => {
  const rejected = async (spec: TxSpec, reason: string) => {
    const { reports, notes } = await pay(one(spec))
    assert.equal(reports.length, 1)
    assert.equal(reports[0].grpSts, 'RJCT')
    assert.equal(reports[0].txs[0].sts, 'RJCT')
    assert.equal(reports[0].txs[0].reason, reason)
    assert.equal(notes.length, 0)
  }
  test('insufficient funds', async () => {
    await rejected({ amount: '10000.01' }, 'Insufficient funds available.')
    await rejected({ amount: '600.00', creditorIban: DE_IBAN, currency: 'USD' }, 'Insufficient funds available.')
    assert.equal(await balance(ctx, C1.iban), '10000.00')
  })
  test('payment to the same account', () => rejected({ amount: '1.00', creditorIban: C1.iban }, 'Payment to the same account.'))
  test('no remittance information', () => rejected({ amount: '1.00', ustrd: null }, 'Description or reference number must be entered.'))
  test('a reference alone is enough', async () => {
    const { reports } = await pay(one({ amount: '1.00', ustrd: null, reference: '2' }))
    assert.equal(reports[0].grpSts, 'ACSC')
  })

  test('mixed outcome is PART; the rejected one moves no money', async () => {
    const { reports, notes } = await pay(pain001([{ txs: [{ amount: '1.00' }, { amount: '99999.00' }] }]))
    assert.equal(reports[0].grpSts, 'PART')
    assert.deepEqual(reports[0].pmtInfSts, ['PART'])
    assert.deepEqual(reports[0].txs.map((t) => t.sts), ['ACSC', 'RJCT'])
    assert.equal(notes.length, 1)
    assert.equal(await balance(ctx, C1.iban), '9999.00')
  })

  test('several blocks: one report covers them all', async () => {
    const { reports } = await pay(pain001([{ txs: [{ amount: '1.00' }] }, { txs: [{ amount: '2.00', creditorIban: DE_IBAN }] }]))
    assert.equal(reports[0].grpSts, 'ACSP')
    assert.deepEqual(reports[0].pmtInfSts, ['ACSC', 'ACSP'])
    assert.equal(reports[1].txs.length, 1)
  })
})

describe('file-level rejections', () => {
  const groupRejected = async (xml: string, reason: string | RegExp, as = C1.code) => {
    const { reports, notes } = await pay(xml, as)
    assert.equal(reports.length, 1)
    assert.equal(reports[0].grpSts, 'RJCT')
    assert.equal(reports[0].txs.length, 0)
    if (typeof reason === 'string') assert.equal(reports[0].grpReason, reason)
    else assert.match(reports[0].grpReason!, reason)
    assert.equal(notes.length, 0)
    return reports[0]
  }

  test('duplicate MsgId', async () => {
    await pay(one({ amount: '1.00' }, { msgId: 'DUP-1' }))
    const r = await groupRejected(one({ amount: '1.00' }, { msgId: 'DUP-1' }), 'Duplicate message.')
    assert.equal(r.orgnlMsgId, 'DUP-1')
    // Per customer: another customer may use the same MsgId.
    const other = await pay(pain001([{ debtorIban: C2.iban, txs: [{ amount: '1.00', creditorIban: C1.iban }] }], { msgId: 'DUP-1' }), C2.code)
    assert.equal(other.reports[0].grpSts, 'ACSC')
  })
  test('a rejected file does not burn its MsgId (decision 14)', async () => {
    await groupRejected(one({ amount: '1.00' }, { msgId: 'RETRY-1', nbOfTxs: '2' }), 'Uploading file failed. Faulty number of payments in file header.')
    const { reports } = await pay(one({ amount: '1.00' }, { msgId: 'RETRY-1' }))
    assert.equal(reports[0].grpSts, 'ACSC')
  })
  test('duplicate PmtInfId', async () => void await groupRejected(pain001([{ pmtInfId: 'B1', txs: [{ amount: '1.00' }] }, { pmtInfId: 'B1', txs: [{ amount: '1.00' }] }]), 'Duplicate message .'))
  test('wrong control sum in the header', async () => void await groupRejected(one({ amount: '1.00' }, { ctrlSum: '2.00' }), 'Uploading file failed. Faulty control sum in file header.'))
  test('wrong count in a block', async () => void await groupRejected(pain001([{ nbOfTxs: '2', txs: [{ amount: '1.00' }] }], { nbOfTxs: '1' }), 'Uploading file failed. Faulty number of payments in Payment Information block .'))
  test('wrong control sum in a block', async () => void await groupRejected(pain001([{ ctrlSum: '9.00', txs: [{ amount: '1.00' }] }]), 'Uploading file failed. Faulty control sum in Payment Information block .'))
  test('unknown debtor account', async () => void await groupRejected(pain001([{ debtorIban: 'EE047700771009999999', txs: [{ amount: '1.00' }] }]), 'Uploading file failed. Faulty sender account EE047700771009999999.'))
  test("someone else's debtor account", async () => void await groupRejected(pain001([{ debtorIban: C2.iban, txs: [{ amount: '1.00', creditorIban: C1.iban }] }]), 'No rights to debtor’s account.'))
  test('invalid scheme code', async () => void await groupRejected(one({ amount: '1.00', scheme: 'FAST' }), /^Corrupted payment file: /))

  test('XSD-invalid file: Corrupted payment file with the validation error', { skip: NO_REFERENCE }, async () => {
    const xml = one({ amount: '1.00' }).replace('<PmtMtd>TRF</PmtMtd>', '<PmtMtd>XXX</PmtMtd>')
    const r = await groupRejected(xml, /^Corrupted payment file: .*PmtMtd/)
    assert.equal(r.ns, 'pain.002.001.10')
  })
  test('without XSDs, structural checks still reject a broken file', async () => {
    ctx = await setup({ xsdDir: undefined })
    await groupRejected(one({ amount: '1.00' }).replace(/<EndToEndId>[^<]*<\/EndToEndId>/, ''), /^Corrupted payment file: .*EndToEndId/)
  })
  test('a document that is not pain.001', async () => void await groupRejected('<?xml version="1.0"?><Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.060.001.05"><x/></Document>', /^Corrupted payment file: /))
})

describe('synchronous refusals', () => {
  test('a body that is not XML is 400', async () => {
    for (const body of ['not xml at all', '<Document><unclosed></Document>']) {
      const r = await call(ctx, { method: 'POST', url: '/payment', body })
      assert.equal(r.statusCode, 400, body)
      assert.match(r.body, /<ErrorCode>BAD_REQUEST<\/ErrorCode>/)
    }
    assert.equal((await call(ctx, { url: '/messages/next' })).statusCode, 204)
  })
  test('an empty body is 400', async () => {
    assert.equal((await call(ctx, { method: 'POST', url: '/payment', body: '' })).statusCode, 400)
  })
  test('signed containers are 415 (decision 12)', async () => {
    const r = await call(ctx, { method: 'POST', url: '/payment', body: 'PK..', contentType: 'application/vnd.etsi.asic-e+zip' })
    assert.equal(r.statusCode, 415)
  })
  test('POST /payments/oneoff was removed on 06.01.2026: 404, nothing queued (decision 520)', async () => {
    for (const contentType of ['application/xml', 'application/json']) {
      const r = await call(ctx, { method: 'POST', url: '/payments/oneoff', body: contentType === 'application/xml' ? one({ amount: '1.00' }) : '{}', contentType })
      assert.equal(r.statusCode, 404, r.body)
      assert.equal(r.headers['message-request-id'], undefined)
    }
    assert.equal((await call(ctx, { url: '/messages/next' })).statusCode, 204)
    assert.equal(await balance(ctx, C1.iban), '10000.00')
  })
})

describe('pain.001.001.03', () => {
  test('answered with pain.002.001.03 in that version\'s element names', async () => {
    const { reports, raw, notes } = await pay(one({ amount: '3.00' }, { version: '03', msgId: 'V03-1' }))
    assert.equal(reports[0].ns, 'pain.002.001.03')
    assert.equal(reports[0].grpSts, 'ACSC')
    assert.equal(reports[0].orgnlMsgId, 'V03-1')
    assert.equal(reports[0].doc.OrgnlGrpInfAndSts.OrgnlMsgNmId, 'pain.001.001.03')
    assert.match(raw[0].body, /<BICOrBEI>LHVBEE22<\/BICOrBEI>/)
    assert.doesNotMatch(raw[0].body, /<BICFI>|<Pty>/)
    assert.equal(notes[0].ind, 'DBIT')
  })
  test('is refused from 2026-11-15 (decision 20)', async () => {
    ctx.clock.set('2026-11-14T21:59:59Z') // 23:59:59 in Tallinn
    assert.equal((await pay(one({ amount: '1.00' }, { version: '03' }))).reports[0].grpSts, 'ACSC')
    ctx.clock.set('2026-11-15T00:00:00Z')
    const { reports } = await pay(one({ amount: '1.00' }, { version: '03' }))
    assert.equal(reports[0].grpSts, 'RJCT')
    assert.equal(reports[0].ns, 'pain.002.001.03')
    assert.match(reports[0].grpReason!, /^Corrupted payment file: pain\.001\.001\.03 is no longer supported/)
    assert.equal((await pay(one({ amount: '1.00' }))).reports[0].grpSts, 'ACSC', '.09 is unaffected')
  })
  test('the cut-off date is configurable', async () => {
    ctx = await setup({ pain00103Until: '2026-03-01' })
    assert.equal((await pay(one({ amount: '1.00' }, { version: '03' }))).reports[0].grpSts, 'RJCT')
  })
})

describe('published samples', () => {
  // The samples use placeholder creditor IBANs (DE00…), so check digits are not verified.
  const run = async (scenario: string) => {
    const xml = sample(scenario, 'PAYMENT_PAIN.001.xml')
    if (!xml) return undefined
    ctx = await setup({ strictIban: false })
    // The published SEPA sample went out as SEPA (not instant): its receiving bank is not instant-reachable.
    if (scenario === 'PAYMENT_SEPA') await call(ctx, { method: 'POST', url: '/_sim/rails/no-instant', body: { account: /<CdtrAcct><Id><IBAN>([^<]+)/.exec(xml.replace(/\s+/g, ''))![1] } })
    return pay(xml)
  }
  const schemes = (doc: string) => [...doc.matchAll(/<Prtry>([A-Z0-9]+)</g)].map((m) => m[1])
  const statuses = (doc: string) => [...doc.matchAll(/<(GrpSts|TxSts)>([A-Z]+)</g)].map((m) => `${m[1]}=${m[2]}`)

  for (const [scenario, expected] of [
    ['PAYMENT_INTERNAL', ['PAYMENT_PAIN.002A.xml']],
    ['PAYMENT_SEPA', ['PAYMENT_PAIN.002A.xml', 'PAYMENT_PAIN.002B.xml']],
    ['PAYMENT_SEPA_INST', ['PAYMENT_PAIN.002A.xml']],
    ['PAYMENT_MULTI', ['PAYMENT_PAIN.002A.xml', 'PAYMENT_PAIN.002B.xml']],
  ] as const) {
    test(`${scenario}: same statuses as the published responses`, { skip: sample(scenario, 'PAYMENT_PAIN.001.xml') ? false : 'docs mirror not available' }, async () => {
      const r = (await run(scenario))!
      for (const [i, file] of expected.entries()) {
        const want = sample(scenario, file)!
        if (i === 0) {
          assert.deepEqual(statuses(r.raw[i].body), statuses(want), `${scenario} ${file}`)
          assert.deepEqual(schemes(r.raw[i].body), schemes(want), `${scenario} ${file}: scheme selection`)
        } else {
          // Later reports: the reference may split them per payment; the outcome is the same.
          assert.ok(statuses(want).every((s) => statuses(r.raw[i].body).includes(s)), `${scenario} ${file}`)
          assert.equal(r.reports[i].grpSts, undefined)
        }
        const orig = /<OrgnlMsgId>([^<]+)</.exec(want)![1]
        assert.equal(r.reports[i].orgnlMsgId, orig)
      }
    })
  }
})
