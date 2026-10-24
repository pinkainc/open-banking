// S5, Bacs on the UK host (decisions 740–749): the Bacs calendar, incoming Bacs credits
// (BACS_INCOMING on day 2, camt.054 on day 3), mandates (pain.009 in, pain.012 accept or
// reject, activation, pain.011 cancellation, scheme cancellation), collections (pain.008
// notification, debit on the entry day with retries, pain.002 rejection and the day-5
// return), reversals (pain.007), UK webhooks of Bacs messages and the host gates. Every XML
// message is checked against the ISO XSD, every JSON one with ajv against ssot/json-schemas;
// the G samples are replayed through the same checks and the operations.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { bankHolidays, isBacsDay, londonInstant, nextBacsDay } from '../src/bacs/calendar.js'
import { makeIban } from '../src/iban.js'
import { parseXml } from '../src/xml.js'
import type { UkRequest } from '../src/webhooks/uk.js'
import { MIRROR_DIR, call, ddEntry, drain, jsonValid, schemaValid, seed, setup, xsd, type Ctx } from './helpers.js'

const BACS = 'docs/gitbook/connect/services/indirect-scheme-access/payment-collection-services/bacs-direct-debit'
const gPage = (p: string) => { const f = join(MIRROR_DIR, p); return existsSync(f) ? readFileSync(f, 'utf8') : '' }
const samples = gPage(`${BACS}/samples.md`)
/** The ```xml blocks of the G samples page, by root element. */
const gXml = (rootTag: string) => [...samples.matchAll(/```xml\n([\s\S]*?)```/g)].map((m) => m[1].trim()).filter((x) => x.includes(`<${rootTag}>`))
/** JSON as published; some G blocks miss a comma or carry a stray brace, which are repaired. */
function loose(raw: string): any {
  try { return JSON.parse(raw) } catch { /* repaired below */ }
  const fixed = raw.replace(/([}\]"el\d])(\s*\n\s*)(["{])/g, '$1,$2$3').replace(/(true|false)\s*\n\s*}\s*\n(\s*})/g, '$1\n$2')
  return JSON.parse(fixed)
}
const gJson = (page: string) => [...gPage(page).matchAll(/```(?:json)?\n(\{[\s\S]*?)```/g)].map((m) => loose(m[1]))

const A = makeIban('GB', 'LHVB04031400001234')
const LOW = makeIban('GB', 'LHVB04031400005678')
const C = makeIban('GB', 'LHVB04030700012345')
const EE_OWN = makeIban('EE', '7700771001260970')
const U1 = { code: '09876543', country: 'GB', name: 'Connect Demo Customer 1' }
const U2 = { code: '09876544', country: 'GB', name: 'Katie Bell' }
const CREDITOR = { name: 'Utility Company Ltd', sortCode: '202015', accountNumber: '55555555' }

let ctx: Ctx
let sent: UkRequest[]
beforeEach(async () => {
  sent = []
  const s = seed()
  s.customers.push(
    { ...U1, accounts: [{ iban: A, balances: { GBP: '1000.00' } }, { iban: LOW, balances: { GBP: '10.00' } }, EE_OWN] },
    { ...U2, accounts: [{ iban: C, balances: { GBP: '500.00' } }] },
  )
  ctx = await setup({ ukWebhookDeliver: async (r) => { sent.push(r); return { status: 200, contentLength: 2 } } }, s, { flavour: 'UK' })
})

const sim = async (url: string, body: object = {}, status = 201) => {
  const r = await call(ctx, { method: 'POST', url: `/_sim/bacs${url}`, body, as: null })
  assert.equal(r.statusCode, status, `${url}: ${r.body}`)
  return r.body.startsWith('{') ? JSON.parse(r.body) : r.body
}
const tick = () => sim('/tick', {}, 200)
const at = async (t: string) => { ctx.clock.set(t); return tick() }
/** Every message of a customer, read and deleted; XML ones XSD-checked, JSON ones parsed. */
async function inbox(as = U1.code) {
  const msgs = await drain(ctx, as)
  for (const m of msgs) if (m.doc) assert.ok(await schemaValid(m.body) || !xsd.has('pain.009.001.07'), `${m.type} not checked`)
  return msgs.map((m) => ({ ...m, json: m.doc ? undefined : JSON.parse(m.body) }))
}
const one = async (type: string, as = U1.code) => {
  const msgs = await inbox(as)
  assert.deepEqual(msgs.map((m) => m.type), [type])
  return msgs[0]
}
const post = (url: string, body: string, as = U1.code, headers: Record<string, string> = {}) =>
  call(ctx, { method: 'POST', url, body, as, headers })
async function submit(url: string, body: string, as = U1.code) {
  const r = await post(url, body, as)
  assert.equal(r.statusCode, 202, r.body)
  assert.equal(r.headers['x-bank-code'], 'LHVUK')
  assert.match(String(r.headers['message-request-id']), /^REQ[0-9a-f]{32}$/)
  return String(r.headers['message-request-id'])
}
const balance = async (iban: string) => ctx.emulator.ledger.available(iban, 'GBP').then((b) => (Number(b) / 100).toFixed(2))

// --- Request documents -------------------------------------------------------------------

const ISO = (ns: string, body: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<Document xmlns="urn:iso:std:iso:20022:tech:xsd:${ns}">${body}</Document>`
function pain012(items: { msgId: string; mandateId?: string; accepted: string; reason?: string }[], msgId = 'RESP-1') {
  return ISO('pain.012.001.07', `<MndtAccptncRpt><GrpHdr><MsgId>${msgId}</MsgId><CreDtTm>2026-03-10T10:00:00</CreDtTm></GrpHdr>${items.map((i) =>
    `<UndrlygAccptncDtls><OrgnlMsgInf><MsgId>${i.msgId}</MsgId><MsgNmId>pain.009.001.07</MsgNmId></OrgnlMsgInf><AccptncRslt><Accptd>${i.accepted}</Accptd>${i.reason ? `<RjctRsn><Cd>${i.reason}</Cd></RjctRsn>` : ''}</AccptncRslt>${
      i.mandateId ? `<OrgnlMndt><OrgnlMndtId>${i.mandateId}</OrgnlMndtId></OrgnlMndt>` : ''}</UndrlygAccptncDtls>`).join('')}</MndtAccptncRpt>`)
}
function pain011(items: { mandateId: string; reason?: string }[], msgId = 'CXL-1') {
  return ISO('pain.011.001.07', `<MndtCxlReq><GrpHdr><MsgId>${msgId}</MsgId><CreDtTm>2026-03-12T09:30:47</CreDtTm></GrpHdr>${items.map((i) =>
    `<UndrlygCxlDtls>${i.reason ? `<CxlRsn><Rsn><Cd>${i.reason}</Cd></Rsn></CxlRsn>` : ''}<OrgnlMndt><OrgnlMndtId>${i.mandateId}</OrgnlMndtId></OrgnlMndt></UndrlygCxlDtls>`).join('')}</MndtCxlReq>`)
}
function pain002(originalMsgId: string, items: { pmtInfId: string; sts: string; reason?: string }[], msgId = 'P002-1') {
  const rsn = (r?: string) => (r ? `<StsRsnInf><Rsn><Cd>${r}</Cd></Rsn></StsRsnInf>` : '')
  return ISO('pain.002.001.14', `<CstmrPmtStsRpt><GrpHdr><MsgId>${msgId}</MsgId><CreDtTm>2026-03-10T13:37:00Z</CreDtTm></GrpHdr><OrgnlGrpInfAndSts><OrgnlMsgId>${originalMsgId}</OrgnlMsgId><OrgnlMsgNmId>pain.008.001.11</OrgnlMsgNmId></OrgnlGrpInfAndSts>${items.map((i) =>
    `<OrgnlPmtInfAndSts><OrgnlPmtInfId>${i.pmtInfId}</OrgnlPmtInfId><PmtInfSts>${i.sts}</PmtInfSts>${rsn(i.reason)}</OrgnlPmtInfAndSts>`).join('')}</CstmrPmtStsRpt>`)
}
/** The request documents the tests send are schema-valid themselves. */
async function valid(body: string) { if (xsd.has('pain.012.001.07')) assert.ok(await schemaValid(body)) }

/** A mandate on A, made ACTIVE by the clock (no answer: active at 18:35 on the entry day). */
async function activeMandate(iban = A) {
  const m = await sim('/mandates', { debtorIban: iban, creditor: CREDITOR, serviceUserNumber: '539614', reference: 'TEST-112' })
  await inbox()
  await at(`${m.entryDate}T18:35:00Z`)
  return m
}

describe('Bacs calendar', () => {
  test('bank holidays of England and Wales with weekend substitutes; working days; UK wall-clock instants', () => {
    assert.deepEqual([...bankHolidays(2026)].sort(), ['2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28'])
    assert.deepEqual([...bankHolidays(2027)].sort(), ['2027-01-01', '2027-03-26', '2027-03-29', '2027-05-03', '2027-05-31', '2027-08-30', '2027-12-27', '2027-12-28'])
    assert.deepEqual([...bankHolidays(2022)].filter((d) => d.startsWith('2022-01') || d.startsWith('2022-12')).sort(), ['2022-01-03', '2022-12-26', '2022-12-27'])
    assert.equal(isBacsDay('2026-03-10'), true)
    assert.equal(isBacsDay('2026-03-14'), false)
    assert.equal(nextBacsDay('2026-04-02'), '2026-04-07') // Good Friday, the weekend, Easter Monday
    assert.equal(nextBacsDay('2026-03-12', 2), '2026-03-16')
    assert.equal(new Date(londonInstant('2026-03-11', '06:00')).toISOString(), '2026-03-11T06:00:00.000Z')
    assert.equal(new Date(londonInstant('2026-07-01', '18:35')).toISOString(), '2026-07-01T17:35:00.000Z')
    assert.equal(new Date(londonInstant('2026-03-29', '05:00')).toISOString(), '2026-03-29T04:00:00.000Z') // BST starts at 01:00 GMT
  })
})

describe('Incoming Bacs credit', () => {
  test('BACS_INCOMING on day 2 (schema-valid, a UK webhook), Pending until booked on day 3 with camt.054 and the same reference', async () => {
    const s = await call(ctx, { method: 'POST', url: '/notifications/subscription', as: U1.code, body: { messageType: 'BACS_INCOMING', requestUrl: 'https://hooks.example.org/lhv', active: true } })
    assert.equal(s.statusCode, 200, s.body)
    const c = await sim('/incoming', { iban: A, amount: '10.01', debtor: { name: 'Debtor Name', sortCode: '60-01-02', accountNumber: '20266221' }, reference: 'REFERENCE', numericReference: '0002', serviceUserNumber: '280421' })
    assert.equal(c.status, 'PENDING')
    assert.deepEqual([c.processingDate, c.entryDate], ['2026-03-10', '2026-03-11'])
    await ctx.emulator.webhooksUk.idle()
    assert.equal(sent.length, 1)
    const hook = jsonValid('webhook-uk-payload', sent[0].body.toString('utf8'))
    assert.equal(hook.messageType, 'BACS_INCOMING')
    assert.equal(hook.bankCode, 'LHVUK')

    const m = await one('BACS_INCOMING')
    const p = jsonValid('bacs-incoming', m.json).Payment
    assert.deepEqual(p.Beneficiary, { AccountName: U1.name, AccountNumber: '00001234', AccountNumberCode: 'BBAN', Bank: { BankId: '040314', BankIdCode: 'GBDSC' } })
    assert.deepEqual(p.Debtor.Bank, { BankId: '600102', BankIdCode: 'GBDSC' })
    assert.equal(p.Amount, '10.01')
    assert.equal(p.ClearingId, '280421')
    assert.equal(p.NumericReference, '0002')
    assert.equal(p.ProcessingDate, '2026-03-11')
    assert.equal(p.SchemeProcessingDate, '2026-03-10')
    assert.equal(p.AccountServicerReference, c.accountServicerReference)
    assert.match(p.SchemeTransactionId, /^[0-9]{17}$/)
    assert.match(p.UniqueSchemeId, /^[0-9A-F]{8}$/)

    const pending = await call(ctx, { url: `/accounts/${A}/payments`, as: U1.code })
    const list = jsonValid('accounts-payments.response', pending.body).Data.Transaction
    assert.equal(list.length, 1)
    assert.equal(list[0].Status, 'Pending')
    assert.equal(list[0].DebtorAccount.Identification, '60010220266221')
    assert.equal(await balance(A), '1000.00')

    assert.equal((await at('2026-03-11T05:59:00Z')).done, 0)
    assert.equal((await at('2026-03-11T06:00:00Z')).done, 1)
    const n = await one('CREDIT_DEBIT_NOTIFICATION')
    const e = ddEntry(n)
    assert.deepEqual([e.ind, e.amount, e.prtry, e.dbtr], ['CRDT', '10.01', 'BACS', 'Debtor Name'])
    assert.equal(n.doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn.Ntry.AcctSvcrRef, c.accountServicerReference)
    assert.equal(await balance(A), '1010.01')
    const tx = await call(ctx, { url: `/accounts/${A}/transactions/${c.accountServicerReference}`, as: U1.code })
    assert.equal(tx.statusCode, 200, tx.body)
    const booked = jsonValid('accounts-transaction.response', tx.body)
    assert.deepEqual([booked.Status, booked.CreditDebitIndicator, booked.DebtorAccount], ['Booked', 'Credit', { Identification: '60010220266221', Name: 'Debtor Name' }])
    const after = await call(ctx, { url: `/accounts/${A}/payments`, as: U1.code })
    assert.equal(JSON.parse(after.body).Data.Transaction.length, 0)
    assert.equal((await tick()).done, 0)
  })

  test('a credit on a Friday is booked on Monday; GBP and GB accounts only; unknown accounts 404', async () => {
    ctx.clock.set('2026-03-13T15:00:00Z')
    const c = await sim('/incoming', { iban: A, amount: '5.00' })
    assert.deepEqual([c.processingDate, c.entryDate], ['2026-03-13', '2026-03-16'])
    ctx.clock.set('2026-03-14T10:00:00Z')
    const w = await sim('/incoming', { iban: A, amount: '5.00' })
    assert.deepEqual([w.processingDate, w.entryDate], ['2026-03-16', '2026-03-17'])
    await sim('/incoming', { iban: EE_OWN, amount: '5.00' }, 400)
    await sim('/incoming', { iban: makeIban('GB', 'LHVB04031499999999'), amount: '5.00' }, 404)
    await sim('/incoming', { iban: A, amount: '5.00', currency: 'EUR' }, 400)
    await sim('/incoming', { iban: A, amount: '-1' }, 400)
    await sim('/incoming', { iban: A, amount: '5.00', debtor: { sortCode: '1234' } }, 400)
    await sim('/incoming', { iban: A, amount: '5.00', serviceUserNumber: 'ABC' }, 400)
  })

  test('the G sample matches bacs-incoming', () => {
    const blocks = gJson('docs/gitbook/connect/services/account-reports/incoming-bacs-credit-notification.md')
    if (MIRROR_DIR && samples) assert.equal(blocks.length, 1)
    for (const b of blocks) jsonValid('bacs-incoming', b)
  })
})

describe('Bacs mandates', () => {
  test('pain.009 to the debtor; pain.012 acceptance before 11:35 activates at 11:35; the confirmation carries the request id', async () => {
    const m = await sim('/mandates', { debtorIban: A, creditor: CREDITOR, serviceUserNumber: '539614', reference: 'TEST-112' })
    assert.equal(m.status, 'PENDING')
    const n = await one('DIRECT_DEBIT_MANDATE_INITIATION')
    const r = n.doc.Document.MndtInitnReq
    assert.equal(r.GrpHdr.MsgId, m.msgId)
    assert.equal(r.Mndt.MndtId, m.id)
    assert.equal(r.Mndt.MndtReqId, 'TEST-112')
    assert.equal(r.Mndt.CdtrAcct.Id.Othr.Id, '20201555555555')
    assert.equal(r.Mndt.DbtrAcct.Id.Othr.Id, '04031400001234')
    assert.equal(r.Mndt.DbtrAgt.FinInstnId.ClrSysMmbId.MmbId, '040314')
    assert.equal(r.Mndt.Cdtr.Id.OrgId.Othr.Id, '539614')

    const body = pain012([{ msgId: m.msgId, mandateId: m.id, accepted: '0' }], 'TEST-111')
    await valid(body)
    ctx.clock.set('2026-03-11T09:00:00Z')
    const id = await submit('/direct-debit/bacs-mandate-accept', body)
    const c = await one('DIRECT_DEBIT_MANDATE_CONFIRM')
    assert.equal(c.requestId, id)
    assert.deepEqual(jsonValid('bacs-confirmation', c.json), { 'GrpHdr.MsgId': 'TEST-111', AcceptanceStatus: 'OK', Messages: [{ 'OrgnlMsgInf.MsgId': m.msgId, Confirmed: true }] })
    const req = ctx.emulator.requests.list(new Set(['GB:09876543']))
    assert.deepEqual(req.map((x) => [x.type, x.body]), [['DIRECT_DEBIT_MANDATE_CONFIRM', body]])

    await at('2026-03-11T11:34:00Z')
    assert.equal(ctx.emulator.bacs.mandates.get(m.id)!.status, 'ACCEPTED')
    await at('2026-03-11T11:35:00Z')
    assert.equal(ctx.emulator.bacs.mandates.get(m.id)!.status, 'ACTIVE')

    // Answered again: no longer PENDING.
    await submit('/direct-debit/bacs-mandate-accept', pain012([{ msgId: m.msgId, accepted: 'true' }]))
    const again = jsonValid('bacs-confirmation', (await one('DIRECT_DEBIT_MANDATE_CONFIRM')).json)
    assert.equal(again.AcceptanceStatus, 'FAILED')
    assert.deepEqual(again.Messages[0].ErrorInfo, { ErrorCode: 'MANDATE_INVALID_STATUS', ErrorDescription: 'Mandate is expected to be in status PENDING, but is in status ACTIVE' })
  })

  test('rejection with a reason returns the mandate; PARTIAL with the documented error codes', async () => {
    const m1 = await sim('/mandates', { debtorIban: A })
    const m2 = await sim('/mandates', { debtorIban: A })
    const m3 = await sim('/mandates', { debtorIban: A })
    const other = await sim('/mandates', { debtorIban: C })
    await inbox()
    await inbox(U2.code)
    await submit('/direct-debit/bacs-mandate-accept', pain012([
      { msgId: m1.msgId, accepted: '1', reason: 'AC01' },
      { msgId: m1.msgId, accepted: 'true' },
      { msgId: 'unknown', accepted: 'true' },
      { msgId: other.msgId, accepted: 'true' },
      { msgId: m2.msgId, mandateId: 'not-this-one', accepted: 'true' },
      { msgId: m3.msgId, accepted: 'false' },
    ]))
    const c = jsonValid('bacs-confirmation', (await one('DIRECT_DEBIT_MANDATE_CONFIRM')).json)
    assert.equal(c.AcceptanceStatus, 'PARTIAL')
    assert.deepEqual(c.Messages.map((x: any) => x.ErrorInfo?.ErrorCode ?? 'OK'),
      ['OK', 'DUPLICATE_MESSAGE_ID', 'MANDATE_FILE_NOT_FOUND', 'NO_RIGHTS_TO_DEBTOR_ACCOUNT', 'MANDATE_NOT_FOUND', 'INVALID_ACCEPTANCE_DATA'])
    const bacs = ctx.emulator.bacs
    assert.equal(bacs.mandates.get(m1.id)!.status, 'RETURNED')
    assert.equal(bacs.mandates.get(m1.id)!.reason, 'AC01')
    await at('2026-03-11T18:35:00Z')
    // No answer counts as accepted: active at the 18:35 retry; a returned one stays returned.
    assert.deepEqual([m1, m2, m3, other].map((m) => bacs.mandates.get(m.id)!.status), ['RETURNED', 'ACTIVE', 'ACTIVE', 'ACTIVE'])
    await sim('/collections', { mandateId: m1.id, amount: '1.00' }, 409)
  })

  test('malformed or foreign documents are 400; the routes are on the UK host for LHV UK only', async () => {
    for (const body of ['', '<Document', ISO('pain.012.001.06', '<MndtAccptncRpt/>'), ISO('pain.012.001.07', '<MndtAccptncRpt><GrpHdr><MsgId>X</MsgId></GrpHdr></MndtAccptncRpt>')]) {
      const r = await post('/direct-debit/bacs-mandate-accept', body)
      assert.equal(r.statusCode, 400, body)
      assert.match(r.body, /<ErrorCode>BAD_REQUEST<\/ErrorCode>/)
    }
    const ee = await post('/direct-debit/bacs-mandate-accept', pain012([{ msgId: 'x', accepted: 'true' }]), U1.code, { 'X-Bank-Code': 'LHVEE' })
    assert.equal(ee.statusCode, 404)
    assert.equal(ee.headers['x-bank-code'], 'LHVEE')
    const eeHost = await setup({}, undefined, {})
    for (const url of ['/direct-debit/bacs-mandate-accept', '/direct-debit/bacs-mandate-cancel', '/direct-debit/bacs-collection-reject', '/_sim/bacs/tick']) {
      assert.equal((await call(eeHost, { method: 'POST', url, body: '<x/>' })).statusCode, 404, url)
    }
    assert.equal(ctx.emulator.requests.size, 0)
  })

  test('pain.011 cancels an active mandate (pain.012 answer); refusals with the documented reasons', async () => {
    const pending = await sim('/mandates', { debtorIban: A })
    const m = await activeMandate()
    const other = await sim('/mandates', { debtorIban: C })
    await inbox(U2.code)
    const body = pain011([{ mandateId: m.id, reason: 'MD16' }, { mandateId: m.id, reason: 'MD16' }, { mandateId: 'nope', reason: 'MD16' },
      { mandateId: other.id, reason: 'MD16' }, { mandateId: pending.id, reason: 'XX99' }])
    await valid(body)
    ctx.clock.set('2026-03-12T10:00:00Z')
    const pendingNow = ctx.emulator.bacs.mandates.get(pending.id)!
    assert.equal(pendingNow.status, 'ACTIVE') // activated at 18:35 with the other one
    const id = await submit('/direct-debit/bacs-mandate-cancel', body)
    const n = await one('DIRECT_DEBIT_MANDATE_CANCEL')
    assert.equal(n.requestId, id)
    const r = n.doc.Document.MndtAccptncRpt
    const rows = [r.UndrlygAccptncDtls].flat().map((u: any) => [u.AccptncRslt.Accptd, u.AccptncRslt.RjctRsn?.Cd, u.AccptncRslt.AddtlRjctRsnInf])
    assert.deepEqual(rows, [['true', undefined, undefined], ['false', 'AM05', undefined], ['false', 'MD01', undefined],
      ['false', 'NARR', 'User has no rights to debtor account'], ['false', 'NARR', 'Mandate cancel request contains invalid data']])
    assert.equal([r.UndrlygAccptncDtls].flat()[0].OrgnlMsgInf.MsgId, 'CXL-1')
    assert.equal(ctx.emulator.bacs.mandates.get(m.id)!.status, 'CANCELLED')
    await sim('/collections', { mandateId: m.id, amount: '1.00' }, 409)
    // A mandate not active yet cannot be cancelled ("Mandate cancel failed.").
    const fresh = await sim('/mandates', { debtorIban: A })
    await inbox()
    await submit('/direct-debit/bacs-mandate-cancel', pain011([{ mandateId: fresh.id, reason: 'MD16' }]))
    const f = (await one('DIRECT_DEBIT_MANDATE_CANCEL')).doc.Document.MndtAccptncRpt.UndrlygAccptncDtls.AccptncRslt
    assert.deepEqual([f.Accptd, f.RjctRsn.Cd, f.AddtlRjctRsnInf], ['false', 'NARR', 'Mandate cancel failed.'])
  })

  test('scheme cancellation: DIRECT_DEBIT_MANDATE_SCHEME_CANCEL (schema-valid); only an active mandate', async () => {
    const m = await activeMandate()
    ctx.clock.set('2026-03-12T10:00:00Z')
    const v = await sim(`/mandates/${m.id}/scheme-cancel`, {}, 200)
    assert.deepEqual([v.status, v.closedBy, v.reason], ['CANCELLED', 'SCHEME', 'MD17'])
    const n = jsonValid('bacs-mandate-scheme-cancel', (await one('DIRECT_DEBIT_MANDATE_SCHEME_CANCEL')).json)
    assert.deepEqual(n.Mandate.Beneficiary, { AccountName: CREDITOR.name, AccountNumber: '55555555', AccountNumberCode: 'BBAN', Bank: { BankId: '202015', BankIdCode: 'GBDSC' } })
    assert.equal(n.Mandate.Debtor.AccountNumber, '00001234')
    assert.deepEqual([n.Mandate.OriginalMandateId, n.Mandate.Reference, n.Mandate.ClearingId], [m.id, 'TEST-112', '539614'])
    assert.deepEqual([n.Status, n.ReasonCode, n.Reason, n.DateClosed], ['CANCELLED_BY_SCHEME', 'MD17', 'Cancelled by Service User/creditor', '2026-03-12'])
    await sim(`/mandates/${m.id}/scheme-cancel`, {}, 409)
    await sim('/mandates/unknown/scheme-cancel', {}, 404)
  })

  test('a mandate initiation is delivered as a UK webhook', async () => {
    const s = await call(ctx, { method: 'POST', url: '/notifications/subscription', as: U1.code, body: { messageType: 'DIRECT_DEBIT_MANDATE_INITIATION', requestUrl: 'https://hooks.example.org/lhv', active: true, attachFullBody: true } })
    assert.equal(s.statusCode, 200, s.body)
    await sim('/mandates', { debtorIban: A })
    await ctx.emulator.webhooksUk.idle()
    assert.equal(sent.length, 1)
    const p = jsonValid('webhook-uk-payload', sent[0].body.toString('utf8'))
    assert.equal(p.messageType, 'DIRECT_DEBIT_MANDATE_INITIATION')
    assert.equal(p.messageRequestId ?? undefined, undefined)
    assert.match(Buffer.from(p.messageBase64, 'base64').toString('utf8'), /<MndtInitnReq>/)
  })
})

describe('Bacs collections', () => {
  test('notification on day 2 (pain.008.001.11), debit at 06:00 on the entry day, FRST then RCUR', async () => {
    const m = await activeMandate()
    ctx.clock.set('2026-03-12T09:00:00Z')
    const c = await sim('/collections', { mandateId: m.id, amount: '700.00', reference: 'INV-1' })
    assert.deepEqual([c.processingDate, c.entryDate, c.status, c.debit, c.seqTp], ['2026-03-12', '2026-03-13', 'RECEIVED', 'PENDING', 'FRST'])
    const n = await one('DIRECT_DEBIT_COLLECTION_NOTIFICATION')
    const d = n.doc.Document.CstmrDrctDbtInitn
    assert.equal(d.GrpHdr.MsgId, c.msgId)
    assert.equal(d.PmtInf.PmtInfId, c.id)
    assert.equal(d.PmtInf.ReqdColltnDt, '2026-03-13')
    assert.equal(d.PmtInf.DrctDbtTxInf.InstdAmt['#text'], '700.00')
    assert.equal(d.PmtInf.DrctDbtTxInf.DbtrAcct.Id.Othr.Id, '04031400001234')
    assert.equal(await balance(A), '1000.00')
    await at('2026-03-13T06:00:00Z')
    const e = ddEntry(await one('CREDIT_DEBIT_NOTIFICATION'))
    assert.deepEqual([e.ind, e.amount, e.prtry, e.family, e.subFamily, e.pmtInfId, e.mandateId, e.cdtr], ['DBIT', '700.00', 'BACS', 'RDDT', 'PMDD', c.id, m.id, CREDITOR.name])
    assert.equal(await balance(A), '300.00')
    const tx = await call(ctx, { url: `/accounts/${A}/transactions/${c.id}`, as: U1.code })
    assert.deepEqual(jsonValid('accounts-transaction.response', tx.body).CreditorAccount, { Identification: '20201555555555', Name: CREDITOR.name })
    const c2 = await sim('/collections', { mandateId: m.id, amount: '1.00' })
    assert.equal(c2.seqTp, 'RCUR')
  })

  test('no partial payments: retried at 11:30, 15:00 and 18:30, then unpaid', async () => {
    const m = await activeMandate(LOW)
    ctx.clock.set('2026-03-12T09:00:00Z')
    const c = await sim('/collections', { mandateId: m.id, amount: '50.00' })
    await inbox()
    await at('2026-03-13T06:00:00Z')
    await at('2026-03-13T11:30:00Z')
    assert.equal(ctx.emulator.bacs.collection(c.id)!.attempts, 2)
    await ctx.emulator.fund(LOW, '45.00', 'GBP')
    await at('2026-03-13T15:00:00Z')
    assert.equal(ctx.emulator.bacs.collection(c.id)!.debit, 'BOOKED')
    assert.equal(await balance(LOW), '5.00')
    const c2 = await sim('/collections', { mandateId: m.id, amount: '50.00' })
    await inbox()
    await at('2026-03-16T20:00:00Z')
    const v = ctx.emulator.bacs.collection(c2.id)!
    assert.deepEqual([v.debit, v.attempts], ['UNPAID', 4])
    assert.deepEqual((await inbox()).map((x) => x.type), [])
  })

  test('pain.002 rejection: confirmed, debited on day 3 all the same, paid back on day 5 at 05:00 with the reason', async () => {
    const m = await activeMandate()
    ctx.clock.set('2026-03-12T09:00:00Z')
    const c = await sim('/collections', { mandateId: m.id, amount: '100.00' })
    await inbox()
    const body = pain002(c.msgId, [{ pmtInfId: c.id, sts: 'RJCT', reason: 'AC04' }], 'pain002_message_id')
    await valid(body)
    const id = await submit('/direct-debit/bacs-collection-reject', body)
    const conf = await one('DIRECT_DEBIT_COLLECTION_CONFIRMATION')
    assert.equal(conf.requestId, id)
    assert.deepEqual(jsonValid('bacs-confirmation', conf.json), {
      'GrpHdr.MsgId': 'pain002_message_id', 'OrgnlGrpInfAndSts.OrgnlMsgId': c.msgId, AcceptanceStatus: 'OK', Messages: [{ OrgnlPmtInfId: c.id, Confirmed: true }],
    })
    await at('2026-03-13T06:00:00Z')
    assert.equal(ddEntry(await one('CREDIT_DEBIT_NOTIFICATION')).ind, 'DBIT')
    await at('2026-03-17T04:59:00Z')
    assert.deepEqual((await inbox()).map((x) => x.type), [])
    await at('2026-03-17T05:00:00Z') // day 5: Fri 13 + two working days
    const back = ddEntry(await one('CREDIT_DEBIT_NOTIFICATION'))
    assert.deepEqual([back.ind, back.amount, back.subFamily, back.returnCode], ['CRDT', '100.00', 'UPDD', 'AC04'])
    assert.equal(await balance(A), '1000.00')
  })

  test('collection responses: the documented error codes, the 18:30 cut-off, pain.002.001.13 too', async () => {
    const m = await activeMandate()
    ctx.clock.set('2026-03-12T09:00:00Z')
    const c1 = await sim('/collections', { mandateId: m.id, amount: '1.00' })
    const c2 = await sim('/collections', { mandateId: m.id, amount: '2.00' })
    const c3 = await sim('/collections', { mandateId: m.id, amount: '3.00' })
    await inbox()
    await submit('/direct-debit/bacs-collection-reject', pain002(c1.msgId, [
      { pmtInfId: c1.id, sts: 'ACSP' }, { pmtInfId: c1.id, sts: 'ACSP' }, { pmtInfId: c2.id, sts: 'ACSP' }, { pmtInfId: 'NOPE', sts: 'ACSP' },
    ]))
    const a = jsonValid('bacs-confirmation', (await one('DIRECT_DEBIT_COLLECTION_CONFIRMATION')).json)
    assert.equal(a.AcceptanceStatus, 'PARTIAL')
    assert.deepEqual(a.Messages.map((x: any) => x.ErrorInfo?.ErrorCode ?? 'OK'), ['OK', 'DUPLICATE_PAYMENT_ID', 'DIRECT_DEBIT_FILE_INVALID', 'DIRECT_DEBIT_NOT_FOUND'])
    await submit('/direct-debit/bacs-collection-reject', pain002(c1.msgId, [{ pmtInfId: c1.id, sts: 'RJCT', reason: 'AC04' }]))
    await submit('/direct-debit/bacs-collection-reject', pain002(c2.msgId, [{ pmtInfId: c2.id, sts: 'RJCT', reason: 'ZZ99' }, { pmtInfId: c2.id + 'X', sts: 'PDNG' }]))
    await submit('/direct-debit/bacs-collection-reject', pain002('unknown', [{ pmtInfId: c2.id, sts: 'RJCT', reason: 'AC04' }]))
    const [b, d, e] = (await inbox()).map((x) => jsonValid('bacs-confirmation', x.json))
    assert.equal(b.Messages[0].ErrorInfo.ErrorCode, 'DIRECT_DEBIT_RESPONSE_PROCESSED')
    assert.deepEqual(d.Messages.map((x: any) => x.ErrorInfo.ErrorCode), ['INVALID_REASON_CODE', 'DIRECT_DEBIT_NOT_FOUND'])
    assert.deepEqual([e.AcceptanceStatus, e.Messages[0].ErrorInfo.ErrorCode], ['FAILED', 'DIRECT_DEBIT_FILE_NOT_FOUND'])
    // Another customer's collection.
    const r = await post('/direct-debit/bacs-collection-reject', pain002(c3.msgId, [{ pmtInfId: c3.id, sts: 'RJCT', reason: 'AC04' }]), U2.code)
    assert.equal(r.statusCode, 202)
    assert.equal(jsonValid('bacs-confirmation', (await one('DIRECT_DEBIT_COLLECTION_CONFIRMATION', U2.code)).json).Messages[0].ErrorInfo.ErrorCode, 'NO_RIGHTS_TO_DEBTOR_ACCOUNT')
    // After 18:30 on the entry day the collection counts as accepted.
    ctx.clock.set('2026-03-13T18:31:00Z')
    const late = pain002(c3.msgId, [{ pmtInfId: c3.id, sts: 'RJCT', reason: 'AC04' }]).replace(/pain\.002\.001\.14/, 'pain.002.001.13')
    await submit('/direct-debit/bacs-collection-reject', late)
    const l = (await inbox()).find((x) => x.type === 'DIRECT_DEBIT_COLLECTION_CONFIRMATION')!
    assert.deepEqual(jsonValid('bacs-confirmation', l.json).Messages[0].ErrorInfo, { ErrorCode: 'DIRECT_DEBIT_INVALID_STATUS', ErrorDescription: 'Direct Debit is expected to be in status RECEIVED, but is in status ACCEPTED' })
  })

  test('reversal: after the debit credited the next working day at 05:00; before it the two cancel out; at most 6 days later', async () => {
    const m = await activeMandate()
    ctx.clock.set('2026-03-12T09:00:00Z')
    const c = await sim('/collections', { mandateId: m.id, amount: '700.03' })
    const early = await sim('/collections', { mandateId: m.id, amount: '9.00' })
    await inbox()
    const x = await sim(`/collections/${early.id}/reversal`, { code: 'R' }, 200)
    assert.equal(x.debit, 'CANCELLED')
    const rv = (await one('DIRECT_DEBIT_REVERSAL_NOTIFICATION')).doc.Document.CstmrPmtRvsl
    assert.equal(rv.OrgnlGrpInf.OrgnlMsgId, early.msgId)
    assert.equal(rv.OrgnlPmtInfAndRvsl.OrgnlPmtInfId, early.id)
    assert.deepEqual([rv.OrgnlPmtInfAndRvsl.RvslRsnInf.Rsn.Prtry, rv.OrgnlPmtInfAndRvsl.RvslRsnInf.AddtlInf], ['R', 'Same day reversal item by Bacs'])
    await at('2026-03-13T06:00:00Z')
    assert.equal((await inbox()).length, 1) // only the 700.03 debit
    assert.equal(await balance(A), '299.97')
    ctx.clock.set('2026-03-16T10:00:00Z')
    await sim(`/collections/${c.id}/reversal`, { code: '?' }, 400)
    const v = await sim(`/collections/${c.id}/reversal`, { code: 'Q' }, 200)
    assert.equal(v.refund.due, '2026-03-17T05:00:00.000Z')
    assert.equal((await one('DIRECT_DEBIT_REVERSAL_NOTIFICATION')).doc.Document.CstmrPmtRvsl.GrpHdr.CtrlSum, '700.03')
    await sim(`/collections/${c.id}/reversal`, {}, 409)
    await at('2026-03-17T05:00:00Z')
    const back = ddEntry(await one('CREDIT_DEBIT_NOTIFICATION'))
    assert.deepEqual([back.ind, back.amount, back.subFamily, back.returnCode], ['CRDT', '700.03', 'PRDD', 'Q'])
    assert.equal(await balance(A), '1000.00')
    // Six days after the debit is the last day.
    ctx.clock.set('2026-03-17T09:00:00Z')
    const c3 = await sim('/collections', { mandateId: m.id, amount: '1.00' })
    await at('2026-03-18T06:00:00Z')
    ctx.clock.set('2026-03-25T09:00:00Z')
    await sim(`/collections/${c3.id}/reversal`, {}, 409)
    ctx.clock.set('2026-03-24T09:00:00Z')
    await sim(`/collections/${c3.id}/reversal`, {}, 200)
  })
})

describe('Bacs: the published samples', () => {
  test('the G XML samples are schema-valid and go through the operations', async (t) => {
    const blocks = ['MndtInitnReq', 'MndtAccptncRpt', 'MndtCxlReq', 'CstmrDrctDbtInitn', 'CstmrPmtStsRpt', 'CstmrPmtRvsl'].map(gXml)
    if (!samples) { t.diagnostic('no docs mirror: samples not replayed'); return }
    assert.deepEqual(blocks.map((b) => b.length), [1, 4, 1, 1, 2, 1])
    // The customer's pain.012 samples omit OrgnlMsgInf/MsgNmId, which the ISO XSD requires; the
    // server reads requests structurally, so they are accepted all the same (decision 748).
    for (const x of blocks.flat()) {
      const own = x.includes('CreDtTm>2024-04-17')
      if (!xsd.has('pain.009.001.07')) continue
      if (own) await assert.rejects(schemaValid(x), /Expected is .*MsgNmId/)
      else assert.ok(await schemaValid(x), x.slice(0, 200))
    }
    // The customer's pain.012 samples (acceptance "0", rejection "1" + AC01) against a mandate of ours.
    const [accept, reject] = blocks[1].filter((x) => x.includes('CreDtTm>2024-04-17'))
    const m1 = await sim('/mandates', { debtorIban: A })
    const m2 = await sim('/mandates', { debtorIban: A })
    await inbox()
    const swap = (x: string, m: { msgId: string; id: string }) => x.replace('43642128e20c435387444d9c806b4f65', m.msgId).replace('9665c298f1cc4f9294598a4fc97ac060', m.id)
    await submit('/direct-debit/bacs-mandate-accept', swap(accept, m1))
    await submit('/direct-debit/bacs-mandate-accept', swap(reject, m2))
    assert.deepEqual((await inbox()).map((x) => jsonValid('bacs-confirmation', x.json).AcceptanceStatus), ['OK', 'OK'])
    assert.deepEqual([ctx.emulator.bacs.mandates.get(m1.id)!.status, ctx.emulator.bacs.mandates.get(m2.id)!.status], ['ACCEPTED', 'RETURNED'])
    // The pain.011 sample names an unknown mandate: refused with MD01.
    await submit('/direct-debit/bacs-mandate-cancel', blocks[2][0])
    assert.equal(parseXml((await one('DIRECT_DEBIT_MANDATE_CANCEL')).body).Document.MndtAccptncRpt.UndrlygAccptncDtls.AccptncRslt.RjctRsn.Cd, 'MD01')
    // The pain.002 samples name an unknown pain.008.
    await submit('/direct-debit/bacs-collection-reject', blocks[4][1])
    assert.equal(jsonValid('bacs-confirmation', (await one('DIRECT_DEBIT_COLLECTION_CONFIRMATION')).json).Messages[0].ErrorInfo.ErrorCode, 'DIRECT_DEBIT_FILE_NOT_FOUND')
  })

  test('the G JSON samples match bacs-confirmation and bacs-mandate-scheme-cancel (repaired where G lost a comma)', (t) => {
    const confirm = [...gJson(`${BACS}/bacs-direct-debit-mandate-initiation-response-confirmation.md`), ...gJson(`${BACS}/direct-debit-collection-notification-response-confirmation.md`),
      ...[...samples.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => loose(m[1]))]
    const cancel = gJson(`${BACS}/incoming-bacs-credit-notification.md`)
    if (!samples) { t.diagnostic('no docs mirror'); return }
    assert.equal(confirm.length, 8)
    for (const c of confirm) jsonValid('bacs-confirmation', c)
    assert.equal(cancel.length, 1)
    jsonValid('bacs-mandate-scheme-cancel', cancel[0])
  })
})
