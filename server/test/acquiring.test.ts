// S6, merchant payment report (P 13, decisions 820–827): POST /acq/merchant-report answered
// in the inbox as ACQ_REPORT (camt.054.001.02, checked against the published XSD), the P 13
// request sample replayed, the P 13 response sample reproduced from simulated card
// transactions, every documented error code, and the EE-only gate on the UK host.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { maskPan } from '../src/acquiring/service.js'
import { parseXml } from '../src/xml.js'
import { C1, MIRROR_DIR, call, drain, reportError, schemaValid, seed, setup, type Ctx } from './helpers.js'

const P13_FILE = join(MIRROR_DIR, 'docs/partners/13-merchant-payment-report.md')
const P13 = existsSync(P13_FILE) ? readFileSync(P13_FILE, 'utf8') : ''
const xmlBlocks = [...P13.matchAll(/```xml\n([\s\S]*?)```/g)].map((m) => m[1].trim())
const REQUEST_SAMPLE = xmlBlocks.find((x) => x.startsWith('<MerchantReportRequest>'))
const RESPONSE_SAMPLE = xmlBlocks.find((x) => x.includes('<BkToCstmrDbtCdtNtfctn>'))
const NO_P13 = REQUEST_SAMPLE && RESPONSE_SAMPLE ? false : 'no P 13 page in the docs mirror'

/** The P 13 sample merchant (its IBAN as published). */
const M = { code: '62540001', country: 'EE', name: 'Legal Merchant', iban: 'EE777700771000845879' }
const M2 = 'EE367700771000845880'

let ctx: Ctx
beforeEach(async () => {
  const s = seed()
  s.customers.push({ code: M.code, country: M.country, name: M.name, accounts: [M.iban, M2] })
  ctx = await setup({}, s)
})

const sim = (url: string, body: object, method = 'POST') => call(ctx, { method, url: `/_sim/acq${url}`, body })
async function merchant(o: object = { userCode: '6254', accounts: [M.iban] }) {
  const r = await sim(`/merchants/EE/${M.code}`, o, 'PUT')
  assert.equal(r.statusCode, 200, r.body)
}
async function tx(o: object) {
  const r = await sim('/transactions', { account: M.iban, ...o })
  assert.equal(r.statusCode, 201, r.body)
  return r.json().transaction
}
const request = (type: string | null, start: string | null, end: string | null) =>
  `<MerchantReportRequest>${type === null ? '' : `<Type>${type}</Type>`}${start === null ? '' : `<PeriodStart>${start}</PeriodStart>`}${end === null ? '' : `<PeriodEnd>${end}</PeriodEnd>`}</MerchantReportRequest>`

/** POSTs a report request and returns the one ACQ_REPORT message, XSD-checked unless it is <Errors>. */
async function report(body: string, o: { c?: Ctx; headers?: Record<string, string>; as?: string } = {}) {
  const c = o.c ?? ctx
  const res = await call(c, { method: 'POST', url: '/acq/merchant-report', body, as: o.as ?? M.code, headers: o.headers })
  assert.equal(res.statusCode, 202, res.body)
  const msgs = await drain(c, o.as ?? M.code, o.headers)
  assert.equal(msgs.length, 1)
  const m = msgs[0]
  assert.equal(m.type, 'ACQ_REPORT')
  assert.equal(m.requestId, res.headers['message-request-id'])
  if (!m.doc.Errors) await schemaValid(m.body)
  return m
}
const ntfctns = (m: { doc: any }) => [m.doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn].flat()
const entries = (n: any) => (n.Ntry === undefined ? [] : [n.Ntry].flat())

describe('merchant payment report (P 13)', () => {
  test('the P 13 response sample is reproduced from a simulated card transaction', { skip: NO_P13 }, async () => {
    await merchant()
    const t = await tx({
      amount: '84.26', fee: '1.23', transactionDate: '2016-01-15', settlementDate: '2016-03-15', terminal: '87654321 001',
      stan: '12345', pan: '5326101234563339', mid: '1234567', orderRef: '4904', location: 'www.abcdef.com \\Tallinn \\10116 ESTEST', scheme: '689MC',
    })
    assert.equal(t.pan, '532610******3339')
    const m = await report(request('CAMT_SETTLEMENT', '2016-03-15', '2016-03-15'))
    assert.ok(await schemaValid(m.body))
    assert.equal(m.doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn.Ntry.NtryRef, t.ref)
    const sampleDoc = parseXml(RESPONSE_SAMPLE!)
    // What differs by nature: the message id, the creation times, the running entry reference.
    const norm = (d: any) => {
      const b = d.Document.BkToCstmrDbtCdtNtfctn
      b.GrpHdr = { MsgId: 'X', CreDtTm: 'X' }
      b.Ntfctn.CreDtTm = 'X'
      b.Ntfctn.Ntry.NtryRef = 'X'
      b.Ntfctn.Ntry.AcctSvcrRef = 'X'
      delete d['?xml']
      delete d.Document['@xmlns']
      return d
    }
    assert.deepEqual(norm(m.doc), norm(sampleDoc))
    assert.equal(m.doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn.Id, '625402016031520160315EUR')
  })

  test('the P 13 request sample is accepted: a period without card payments gives an empty EUR block', { skip: NO_P13 }, async () => {
    await merchant()
    const m = await report(REQUEST_SAMPLE!)
    assert.ok(await schemaValid(m.body))
    const [n] = ntfctns(m)
    assert.equal(n.Acct.Id.IBAN, M.iban)
    assert.equal(n.Acct.Ccy, 'EUR')
    assert.deepEqual(n.TxsSummry, { TtlCdtNtries: { NbOfNtries: '0', Sum: '0.00' }, TtlDbtNtries: { NbOfNtries: '0', Sum: '0.00' } })
    assert.equal(n.Ntry, undefined)
  })

  test('settlement report by settlement date, transaction report by transaction date with unsettled payments', async () => {
    await merchant({ userCode: '6254' })
    await tx({ amount: '10.00', fee: '0.20', transactionDate: '2026-03-01', settlementDate: '2026-03-02' })
    await tx({ amount: '5.00', direction: 'DBIT', transactionDate: '2026-03-02', settlementDate: '2026-03-03' })
    await tx({ amount: '7.50', transactionDate: '2026-03-03', settlementDate: null })
    await tx({ amount: '3.00', currency: 'USD', transactionDate: '2026-03-02' })
    await tx({ account: M2, amount: '1.00', fee: '1.00', transactionDate: '2026-03-02' })

    const s = await report(request('CAMT_SETTLEMENT', '2026-03-02', '2026-03-03'))
    const sb = ntfctns(s)
    assert.deepEqual(sb.map((n) => `${n.Acct.Id.IBAN}/${n.Acct.Ccy}`), [`${M.iban}/EUR`, `${M.iban}/USD`, `${M2}/EUR`])
    assert.deepEqual(sb.map((n) => n.Id), ['625402026030220260303EUR', '625412026030220260303USD', '625422026030220260303EUR'])
    const eur = entries(sb[0])
    assert.deepEqual(eur.map((e: any) => [e.Amt['#text'], e.CdtDbtInd, e.BkTxCd.Domn.Fmly.SubFmlyCd, e.ValDt.Dt]),
      [['9.800000', 'CRDT', 'POSP', '2026-03-02'], ['5.000000', 'DBIT', 'DAJT', '2026-03-03']])
    assert.deepEqual(sb[0].TxsSummry, { TtlCdtNtries: { NbOfNtries: '1', Sum: '10.00' }, TtlDbtNtries: { NbOfNtries: '1', Sum: '5.00' } })
    // A zero net amount (amount = fee) is a credit (P 13 2.59).
    const zero = entries(sb[2])[0]
    assert.equal(zero.Amt['#text'], '0.000000')
    assert.equal(zero.CdtDbtInd, 'CRDT')
    assert.equal(zero.NtryDtls.TxDtls.Chrgs.Amt['#text'], '1.000000')

    const t = await report(request('CAMT_TRANSACTION', '2026-03-03', '2026-03-03'))
    const tb = ntfctns(t)
    assert.deepEqual(tb.map((n) => `${n.Acct.Id.IBAN}/${n.Acct.Ccy}`), [`${M.iban}/EUR`, `${M2}/EUR`])
    const [unsettled] = entries(tb[0])
    assert.equal(unsettled.BookgDt.Dt, '2026-03-03')
    assert.equal(unsettled.ValDt, undefined)
    assert.equal(unsettled.NtryDtls.TxDtls.Chrgs, undefined)
    assert.equal(unsettled.NtryDtls.TxDtls.Refs.AcctSvcrRef, undefined)
    assert.equal(entries(tb[1]).length, 0)
  })

  test('the documented error codes, each as an <Errors> ACQ_REPORT', async () => {
    const err = async (body: string, as = M.code) => reportError(await report(body, { as }))
    // Not a merchant at all.
    assert.equal((await err(request('CAMT_SETTLEMENT', '2026-03-01', '2026-03-01')))!.code, 'errMerchantReport_3')
    await merchant({ userCode: '6254', accounts: [] })
    assert.equal((await err(request('CAMT_SETTLEMENT', '2026-03-01', '2026-03-01')))!.code, 'errMerchantReport_7')
    await merchant()
    const cases: [string, string, string?][] = [
      ['not xml', 'errMerchantReport_InvalidInput'],
      ['<Other/>', 'errMerchantReport_InvalidInput'],
      [request(null, '2026-03-01', '2026-03-01'), 'errMerchantReport_NotNull', 'Type'],
      [request('', '2026-03-01', '2026-03-01'), 'errMerchantReport_NotEmpty', 'Type'],
      [request('CAMT_BALANCE', '2026-03-01', '2026-03-01'), 'errMerchantReport_1', 'Type'],
      [request('CAMT_SETTLEMENT', null, '2026-03-01'), 'errMerchantReport_NotNull', 'PeriodStart'],
      [request('CAMT_SETTLEMENT', '2026-03-01', '01.03.2026'), 'errMerchantReport_NotNull', 'PeriodEnd'],
      [request('CAMT_SETTLEMENT', '2026-02-30', '2026-03-01'), 'errMerchantReport_NotNull', 'PeriodStart'],
      [request('CAMT_SETTLEMENT', '2026-01-01', '2026-02-05'), 'errMerchantReport_2'],
      [request('CAMT_SETTLEMENT', '2026-03-02', '2026-03-01'), 'errMerchantReport_9'],
      [request('CAMT_TRANSACTION', '2026-03-10', '2026-03-11'), 'errStatement_PeriodInvalid'],
    ]
    for (const [body, code, field] of cases) {
      const e = await err(body)
      assert.equal(e?.code, code, body)
      assert.equal(e?.field, field, body)
    }
    // 35 days inclusive is the maximum; today is ready.
    assert.equal(ntfctns(await report(request('CAMT_SETTLEMENT', '2026-02-04', '2026-03-10'))).length, 1)
  })

  test('the UK host answers only with X-Bank-Code: LHVEE; the control plane checks its input', async () => {
    const s = seed()
    s.customers.push({ code: M.code, country: M.country, name: M.name, accounts: [M.iban] })
    const uk = await setup({}, s, { flavour: 'UK' })
    const body = request('CAMT_SETTLEMENT', '2026-03-01', '2026-03-01')
    const no = await call(uk, { method: 'POST', url: '/acq/merchant-report', body, as: M.code })
    assert.equal(no.statusCode, 404)
    await call(uk, { method: 'PUT', url: `/_sim/acq/merchants/EE/${M.code}`, body: {} })
    const put = await call(uk, { method: 'PUT', url: `/_sim/acq/merchants/EE/${M.code}`, body: { userCode: '6254' } })
    assert.deepEqual(put.json().merchant, { userCode: '6254', accounts: [M.iban] })
    const m = await report(body, { c: uk, headers: { 'x-bank-code': 'LHVEE' } })
    assert.equal(ntfctns(m).length, 1)

    assert.equal((await sim(`/merchants/EE/${M.code}`, { accounts: [C1.iban] }, 'PUT')).statusCode, 400)
    assert.equal((await sim('/merchants/EE/99999999', {}, 'PUT')).statusCode, 404)
    assert.equal((await sim('/transactions', { account: M.iban, amount: '1.00' })).statusCode, 400, 'no set-up yet')
    await merchant()
    assert.equal((await sim('/transactions', { account: M2, amount: '1.00' })).statusCode, 400, 'not a settlement account')
    assert.equal((await sim('/transactions', { account: M.iban, amount: '-1.00' })).statusCode, 400)
    assert.equal((await sim('/transactions', { account: M.iban, amount: '1.00', settlementDate: '2026-01-01', transactionDate: '2026-02-01' })).statusCode, 400)
    await tx({ amount: '2.00' })
    const list = await call(ctx, { url: `/_sim/acq/transactions?account=${M.iban}` })
    assert.equal(list.json().transactions.length, 1)
    assert.equal(list.json().transactions[0].settlementDate, '2026-03-11')
    assert.equal((await sim(`/merchants/EE/${M.code}`, {}, 'PUT')).json().merchant, null)
    assert.equal(maskPan('4111111111111111'), '411111******1111')
  })
})
