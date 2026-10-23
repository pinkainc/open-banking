// L5a FX (P 12): the published samples replayed, TODAY and SPOT deals end to end on the
// ledger (balances, the reservation seen through account.balance, camt.054 for both legs,
// camt.053 entries with the deal's PmtInfId), SPOT settlement dates across weekends and
// TARGET2 holidays, the 2-minute validity, and a service provider trading for its
// customers. Every JSON body is checked against the ssot schema (jsonValid); XML against
// the published XSDs (schemaValid). The error matrix is in fx-errors.test.ts.
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { VALIDITY_MS } from '../src/fx/service.js'
import { many, text } from '../src/xml.js'
import { C1, C2, SP, balance, call, ddEntry, docJson, jsonDrain, jsonValid, report, schemaValid, setup, type Ctx } from './helpers.js'

let ctx: Ctx
beforeEach(async () => {
  ctx = await setup()
  // No margin: quotes are the mid rates (GBP 0.85, USD 1.08, AUD 1.65 per EUR).
  await call(ctx, { method: 'PUT', url: '/_sim/fx/pricing', body: { margin: '0' } })
})

type Who = { as?: string; headers?: Record<string, string> }
type Msg = Awaited<ReturnType<typeof jsonDrain>>[number]

/** POSTs a schema-valid FX request (202) and returns the inbox messages answering it, plus every other message drained. */
async function send(url: '/fx/trade-offer' | '/fx/trade-offer-confirmation', body: object, who: Who = {}) {
  jsonValid(url === '/fx/trade-offer' ? 'fx-trade-offer.request' : 'fx-trade-offer-confirmation.request', body)
  const res = await call(ctx, { method: 'POST', url, body, as: who.as, headers: who.headers })
  assert.equal(res.statusCode, 202, res.body)
  assert.equal(res.body, '')
  const id = res.headers['message-request-id'] as string
  assert.match(id, /\S/)
  const all = await jsonDrain(ctx, who.as ?? C1.code, who.headers)
  return { id, msgs: all.filter((m) => m.requestId === id), all }
}

/** An FX_TRADE_OFFER, schema-checked. */
async function offer(body: object, who: Who = {}) {
  const r = await send('/fx/trade-offer', body, who)
  assert.equal(r.msgs.length, 1)
  assert.equal(r.msgs[0].type, 'FX_TRADE_OFFER')
  return { ...r, o: jsonValid('fx-trade-offer.response', r.msgs[0].body) }
}

/** An FX_TRADE_OFFER_CONFIRMATION, schema-checked; `notes` are the camt.054 of the same drain. */
async function confirm(requestReference: string, c: boolean | string = true, who: Who = {}) {
  const r = await send('/fx/trade-offer-confirmation', { requestReference, confirm: c }, who)
  assert.equal(r.msgs.length, 1)
  assert.equal(r.msgs[0].type, 'FX_TRADE_OFFER_CONFIRMATION')
  return { ...r, c: jsonValid('fx-trade-offer-confirmation.response', r.msgs[0].body), notes: r.all.filter((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION') }
}

const deal = (ref: string, o: Record<string, unknown> = {}) =>
  ({ requestReference: ref, accountIBAN: C1.iban, currencyFrom: 'EUR', currencyTo: 'USD', amountFrom: 100, tenor: 'TODAY', ...o })

const settle = async (at: string) => {
  ctx.clock.set(at)
  return JSON.parse((await call(ctx, { method: 'POST', url: '/_sim/fx/settle' })).body).settled as number
}

/** ITBD / ITAV of a currency through account.balance (camt.052, XSD-checked). */
async function intraday(ccy: string, who: Who = {}) {
  const r = await report(ctx, { kind: 'balance' }, who)
  const m = r.msgs[0]
  assert.equal(m.type, 'ACCOUNT_BALANCE')
  await schemaValid(m.body)
  const rpt = many<any>(m.doc.Document.BkToCstmrAcctRpt.Rpt).find((x) => String(x.Acct.Ccy) === ccy)
  return Object.fromEntries(many<any>(rpt.Bal).map((b) => [b.Tp.CdOrPrtry.Cd, text(b.Amt)]))
}

/** The camt.054 legs of a deal (both XSD-checked), as [indicator, currency account, amount, BkTxCd]. */
async function legs(notes: Msg[], pmtInfId: number) {
  assert.equal(notes.length, 2)
  const out = []
  for (const n of notes) {
    await schemaValid(n.body)
    assert.match(n.body, /<Domn><Cd>FORX<\/Cd><Fmly><Cd>OTHR<\/Cd><SubFmlyCd>OTHR<\/SubFmlyCd><\/Fmly><\/Domn>/)
    const e = ddEntry(n)
    assert.equal(e.pmtInfId, String(pmtInfId))
    assert.equal(e.prtry, 'INTERNAL')
    assert.equal(e.account, C1.iban)
    out.push([e.ind, /<Amt Ccy="([A-Z]{3})"/.exec(n.body)![1], e.amount])
  }
  return out
}

/** Keys of a value in order (for comparing structure with a time-dependent sample). */
const keys = (v: object) => Object.keys(v)

describe('FX: the P 12 samples', () => {
  const samples = docJson('12-foreign-exchange.md').filter((b) => b.json)

  test('the published samples are schema-valid (the schemas match the page)', { skip: samples.length === 0 && 'no docs mirror' }, () => {
    const [offerSample, confirmReq, confirmSample, noFunds, noAmount, expired, account, pricing] = samples.map((s) => s.json)
    jsonValid('fx-trade-offer.response', offerSample)
    jsonValid('fx-trade-offer-confirmation.request', confirmReq)
    jsonValid('fx-trade-offer-confirmation.response', confirmSample)
    jsonValid('fx-trade-offer.response', noFunds)
    jsonValid('fx-trade-offer.response', noAmount)
    for (const e of [expired, account, pricing]) jsonValid('fx-error', e)
  })

  test('"Sell TODAY" replayed: the response and confirmation have the samples\' fields in order', async () => {
    await call(ctx, { method: 'PUT', url: '/_sim/fx/pricing', body: { rates: { GBP: '1', USD: '1.32031' } } })
    const req = { requestReference: 1234005, accountIBAN: 'EE337700771001260958', currencyFrom: 'GBP', currencyTo: 'USD', amountFrom: 1, amountTo: null, comment: 'test1', tenor: 'TODAY' }
    const { o } = await offer(req)
    const [offerSample, , confirmSample] = samples.map((s) => s.json)
    if (offerSample) assert.deepEqual(keys(o), keys(offerSample))
    assert.deepEqual(
      [o.requestReference, o.accountIban, o.currencyFrom, o.amountFrom, o.currencyTo, o.amountTo, o.baseCurrency, o.tenor, o.quote, o.tradeOfferStatus, o.comment],
      ['1234005', C1.iban, 'GBP', 1, 'USD', 1.32, 'GBP', 'TODAY', 1.32031, 'CONFIRMATION_PENDING', 'test1'])
    assert.equal(o.orderDateTime, '2026-03-10T10:00:00.000+02:00')
    assert.equal(o.tradeDate, '2026-03-10T23:59:59+02:00')
    assert.equal(o.settlementDate, '2026-03-10T23:59:59+02:00')
    assert.equal(o.validityTime, '2026-03-10T10:02:00.000+02:00')
    assert.match(o.accountServicerReference, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

    ctx.clock.advance(29_000)
    const { c } = await confirm('1234005', true)
    if (confirmSample) assert.deepEqual(keys(c), keys(confirmSample))
    assert.deepEqual([c.tradeStatus, c.amountFrom, c.amountTo, c.quote, c.accountServicerReference], ['COMPLETED', 1, 1.32, 1.32031, o.accountServicerReference])
    assert.equal(c.settlementDoneDateTime, '2026-03-10T10:00:29.000+02:00')
    assert.equal(await balance(ctx, C1.iban, 'GBP'), '499.00')
    assert.equal(await balance(ctx, C1.iban, 'USD'), '501.32')
  })

  test('"Buy SPOT" replayed (amountTo, trailing comma removed, our IBAN)', async () => {
    const { o } = await offer({ requestReference: '12345678', accountIBAN: C1.iban, currencyFrom: 'EUR', currencyTo: 'GBP', amountFrom: null, amountTo: 1, comment: 'test1', tenor: 'SPOT' })
    assert.deepEqual([o.amountFrom, o.amountTo, o.baseCurrency, o.quote, o.tenor], [1.18, 1, 'EUR', 0.85, 'SPOT'])
    assert.equal(o.settlementDate, '2026-03-12T23:59:59+02:00')
  })
})

describe('FX: TODAY', () => {
  test('settled inside the confirmation: one COMPLETED message, both legs in camt.054 and camt.053 with the PmtInfId', async () => {
    const { o } = await offer(deal('T1', { comment: 'invoice 7' }))
    assert.deepEqual([o.quote, o.amountTo, o.baseCurrency], [1.08, 108, 'EUR'])
    const { c, msgs, notes, all } = await confirm('T1')
    assert.equal(msgs.length, 1)
    assert.equal(c.tradeStatus, 'COMPLETED')
    assert.equal(typeof c.pmtInfId, 'number')
    assert.ok(c.pmtInfId > 10357000)
    assert.equal(all.filter((m) => m.type === 'FX_TRADE_OFFER_CONFIRMATION').length, 1)
    assert.deepEqual(await legs(notes, c.pmtInfId), [['DBIT', 'EUR', '100.00'], ['CRDT', 'USD', '108.00']])
    for (const n of notes) assert.match(n.body, /<Ustrd>invoice 7<\/Ustrd>/)
    assert.equal(await balance(ctx, C1.iban, 'EUR'), '9900.00')
    assert.equal(await balance(ctx, C1.iban, 'USD'), '608.00')
    assert.deepEqual(await intraday('EUR'), { ITBD: '9900.00', ITAV: '9900.00' })

    const st = await report(ctx, { kind: 'statement' })
    assert.equal(st.msgs.length, 1)
    await schemaValid(st.msgs[0].body)
    const fx = many<any>(st.msgs[0].doc.Document.BkToCstmrStmt.Stmt).flatMap((s) =>
      many<any>(s.Ntry).filter((e) => e.BkTxCd.Domn.Cd === 'FORX').map((e) => [String(s.Acct.Ccy), e.CdtDbtInd, text(e.Amt), e.BkTxCd.Domn.Fmly.Cd, e.BkTxCd.Domn.Fmly.SubFmlyCd, String(e.NtryDtls.TxDtls.Refs.PmtInfId)]))
    assert.deepEqual(fx, [['EUR', 'DBIT', '100.00', 'OTHR', 'OTHR', String(c.pmtInfId)], ['USD', 'CRDT', '108.00', 'OTHR', 'OTHR', String(c.pmtInfId)]])
  })

  test('the remittance without a comment names the pair and the quote; each deal gets its own pmtInfId', async () => {
    await offer(deal('T2', { currencyFrom: 'USD', currencyTo: 'GBP', amountFrom: 10 }))
    const a = await confirm('T2')
    for (const n of a.notes) assert.match(n.body, /<Ustrd>FX USD\/GBP 1\.27059<\/Ustrd>/)
    await offer(deal('T3'))
    const b = await confirm('T3')
    assert.equal(b.c.pmtInfId, a.c.pmtInfId + 1)
  })

  test('confirm "true" as a string (the field table) works like the boolean', async () => {
    await offer(deal('T4'))
    assert.equal((await confirm('T4', 'true')).c.tradeStatus, 'COMPLETED')
  })

  test('confirm false rejects the offer: the full dataset CANCELLED without errorCode, nothing booked', async () => {
    const { o } = await offer(deal('T5'))
    const { c, notes } = await confirm('T5', false)
    assert.equal(c.tradeStatus, 'CANCELLED')
    assert.equal(c.errorCode, undefined)
    assert.equal(c.pmtInfId, undefined)
    assert.equal(c.settlementDoneDateTime, undefined)
    assert.deepEqual([c.requestReference, c.amountFrom, c.amountTo, c.accountServicerReference], ['T5', 100, 108, o.accountServicerReference])
    assert.deepEqual(notes, [])
    assert.equal(await balance(ctx, C1.iban, 'EUR'), '10000.00')
    await offer(deal('T6'))
    assert.equal((await confirm('T6', 'false')).c.tradeStatus, 'CANCELLED')
  })
})

describe('FX: validity (2 minutes, decisions 404 and 416)', () => {
  test('confirmed 1 ms before and at exactly validityTime; expired 1 ms after', async () => {
    for (const [ref, after] of [['V1', VALIDITY_MS - 1], ['V2', VALIDITY_MS]] as const) {
      ctx.clock.set('2026-03-10T08:00:00Z')
      await offer(deal(ref))
      ctx.clock.advance(after)
      assert.equal((await confirm(ref)).c.tradeStatus, 'COMPLETED', ref)
    }
    ctx.clock.set('2026-03-10T09:00:00Z')
    const { o } = await offer(deal('V3'))
    assert.equal(Date.parse(o.validityTime) - Date.parse(o.orderDateTime), VALIDITY_MS)
    ctx.clock.advance(VALIDITY_MS + 1)
    const r = await send('/fx/trade-offer-confirmation', { requestReference: 'V3', confirm: true })
    assert.deepEqual(jsonValid('fx-error', r.msgs[0].body), { errorCode: ['Trade offer quote has expired'] })
    assert.equal(await balance(ctx, C1.iban, 'EUR'), '9800.00', 'V1 and V2 only')
  })
})

describe('FX: SPOT', () => {
  test('the reservation lowers the available balance (account.balance ITAV) until the settlement date', async () => {
    const { o } = await offer(deal('S1', { amountFrom: 250, tenor: 'SPOT' }))
    assert.equal(o.settlementDate, '2026-03-12T23:59:59+02:00')
    const { c, notes, id } = await confirm('S1')
    assert.equal(c.tradeStatus, 'SETTLEMENT_PENDING')
    assert.equal(typeof c.pmtInfId, 'number')
    assert.equal(c.settlementDoneDateTime, undefined)
    assert.deepEqual(notes, [], 'nothing booked before settlement')
    assert.deepEqual(await intraday('EUR'), { ITBD: '10000.00', ITAV: '9750.00' })
    assert.deepEqual(await intraday('USD'), { ITBD: '500.00', ITAV: '500.00' })

    // The reserved money cannot be sold twice.
    const { o: o2 } = await offer(deal('S2', { amountFrom: 9800 }))
    assert.equal(o2.tradeOfferStatus, 'CANCELLED')
    assert.match(o2.errorCode[0], /^Conversion not possible, because there are no funds for currency \(9800\.00 EUR -> 10584\.00 USD, 1\.08000\)$/)

    assert.equal(await settle('2026-03-11T21:59:59Z'), 0, '23:59:59 on 11 March in Tallinn')
    assert.equal(await settle('2026-03-11T22:00:00Z'), 1, '00:00 on 12 March in Tallinn')
    const all = await jsonDrain(ctx)
    const done = all.filter((m) => m.type === 'FX_TRADE_OFFER_CONFIRMATION')
    assert.equal(done.length, 1)
    assert.equal(done[0].requestId, id)
    const d = jsonValid('fx-trade-offer-confirmation.response', done[0].body)
    assert.deepEqual([d.tradeStatus, d.pmtInfId, d.settlementDoneDateTime], ['COMPLETED', c.pmtInfId, '2026-03-12T00:00:00.000+02:00'])
    assert.deepEqual(await legs(all.filter((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION'), c.pmtInfId), [['DBIT', 'EUR', '250.00'], ['CRDT', 'USD', '270.00']])
    assert.deepEqual(await intraday('EUR'), { ITBD: '9750.00', ITAV: '9750.00' })
    assert.equal(await balance(ctx, C1.iban, 'USD'), '770.00')
    assert.equal(await settle('2026-03-12T10:00:00Z'), 0, 'settled once')
  })

  test('the second message carries the confirmation\'s Message-Request-Id', async () => {
    await offer(deal('S3', { tenor: 'SPOT' }))
    const { id } = await confirm('S3')
    await settle('2026-03-12T06:00:00Z')
    const [m] = (await jsonDrain(ctx)).filter((x) => x.type === 'FX_TRADE_OFFER_CONFIRMATION')
    assert.equal(m.requestId, id)
  })

  test('across a weekend: Thursday 12 March settles on Monday 16 March', async () => {
    ctx.clock.set('2026-03-12T09:00:00Z')
    const { o } = await offer(deal('S4', { tenor: 'SPOT' }))
    assert.deepEqual([o.tradeDate, o.settlementDate], ['2026-03-12T23:59:59+02:00', '2026-03-16T23:59:59+02:00'])
    await confirm('S4')
    assert.equal(await settle('2026-03-15T21:59:00Z'), 0, 'Sunday 23:59 in Tallinn')
    assert.equal(await settle('2026-03-15T22:00:00Z'), 1, 'Monday 00:00 in Tallinn')
  })

  test('across Easter (TARGET2 closed Good Friday and Easter Monday): Thursday 2 April settles on Wednesday 8 April', async () => {
    ctx.clock.set('2026-04-02T09:00:00Z')
    const { o } = await offer(deal('S5', { tenor: 'SPOT' }))
    assert.deepEqual([o.tradeDate, o.settlementDate], ['2026-04-02T23:59:59+03:00', '2026-04-08T23:59:59+03:00'])
    await confirm('S5')
    assert.equal(await settle('2026-04-07T20:59:00Z'), 0, 'Tuesday 23:59 in Tallinn')
    assert.equal(await settle('2026-04-07T21:00:00Z'), 1)
  })

  test('over 1 May (a Friday) and the weekend: Thursday 30 April settles on Tuesday 5 May', async () => {
    ctx.clock.set('2026-04-30T09:00:00Z')
    const { o } = await offer(deal('S6', { tenor: 'SPOT' }))
    assert.equal(o.settlementDate, '2026-05-05T23:59:59+03:00')
  })
})

describe('FX: a service provider', () => {
  const forC1 = { as: SP.code, headers: { 'Client-Code': C1.code, 'Client-Country': 'EE' } }

  test('trades for a connected customer; the messages are the customer\'s', async () => {
    const { o } = await offer(deal('P1'), forC1)
    assert.equal(o.tradeOfferStatus, 'CONFIRMATION_PENDING')
    const { c, notes } = await confirm('P1', true, forC1)
    assert.equal(c.tradeStatus, 'COMPLETED')
    assert.equal(notes.length, 2)
    assert.equal(await balance(ctx, C1.iban, 'EUR'), '9900.00')
    // The provider's own inbox stays empty.
    const own = await jsonDrain(ctx, SP.code, { 'Client-Code': SP.code, 'Client-Country': 'EE', 'Filter-Service-Provider': 'true' })
    assert.deepEqual(own.map((m) => m.type), [])
  })

  test('acting for itself it cannot sell a customer\'s account: Incorrect Account', async () => {
    const r = await send('/fx/trade-offer', deal('P2'), { as: SP.code, headers: { 'Client-Code': SP.code, 'Client-Country': 'EE', 'Filter-Service-Provider': 'true' } })
    assert.deepEqual(jsonValid('fx-error', r.msgs[0].body), { errorCode: ['Incorrect Account'] })
  })

  test('for an unconnected customer: 403, no offer', async () => {
    await call(ctx, { method: 'POST', url: '/_sim/customers', body: { code: '12340003', country: 'EE', name: 'Demo Customer 3', accounts: ['EE427700771001260990'] } })
    const body = deal('P3', { accountIBAN: 'EE427700771001260990' })
    jsonValid('fx-trade-offer.request', body)
    const res = await call(ctx, { method: 'POST', url: '/fx/trade-offer', body, as: SP.code, headers: { 'Client-Code': '12340003', 'Client-Country': 'EE' } })
    assert.equal(res.statusCode, 403)
    assert.match(res.body, /User doesn't have valid contract/)
    assert.deepEqual(JSON.parse((await call(ctx, { url: '/_sim/fx/offers' })).body).offers, [])
  })

  test('requestReference is unique per customer: C2 may reuse C1\'s', async () => {
    await offer(deal('P4'))
    const { o } = await offer(deal('P4', { accountIBAN: C2.iban, amountFrom: 10 }), { as: C2.code })
    assert.equal(o.tradeOfferStatus, 'CONFIRMATION_PENDING')
  })
})
