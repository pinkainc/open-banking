// L5a FX smoke tests: a TODAY deal end to end, a SPOT deal settled on its settlement
// date, and the leading-zero parse error. Every JSON body is checked against the ssot
// schema (jsonValid); camt.054 against the XSD (schemaValid).
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { C1, balance, call, jsonDrain, jsonValid, schemaValid, setup, type Ctx } from './helpers.js'

let ctx: Ctx
beforeEach(async () => {
  ctx = await setup()
  // No margin: quotes are the mid rates (GBP 0.85, USD 1.08 per EUR).
  await call(ctx, { method: 'PUT', url: '/_sim/fx/pricing', body: { margin: '0' } })
})

async function post(url: string, body: string | object) {
  if (typeof body === 'object') jsonValid(url.endsWith('confirmation') ? 'fx-trade-offer-confirmation.request' : 'fx-trade-offer.request', body)
  const res = await call(ctx, { method: 'POST', url, body, contentType: 'application/json' })
  assert.equal(res.statusCode, 202, res.body)
  const id = res.headers['message-request-id'] as string
  const msgs = (await jsonDrain(ctx)).filter((m) => m.requestId === id)
  return msgs
}

describe('FX', () => {
  test('TODAY: quote, confirm, settled at once on the ledger and in camt.054', async () => {
    const [offer] = await post('/fx/trade-offer', {
      requestReference: 1234005, accountIBAN: C1.iban, currencyFrom: 'EUR', currencyTo: 'USD', amountFrom: 100, amountTo: null, comment: 'test1', tenor: 'TODAY',
    })
    assert.equal(offer.type, 'FX_TRADE_OFFER')
    const o = jsonValid('fx-trade-offer.response', offer.body)
    assert.equal(o.tradeOfferStatus, 'CONFIRMATION_PENDING')
    assert.equal(o.requestReference, '1234005')
    assert.equal(o.baseCurrency, 'EUR')
    assert.equal(o.quote, 1.08)
    assert.equal(o.amountTo, 108)
    assert.equal(o.tradeDate, '2026-03-10T23:59:59+02:00')

    const res = await call(ctx, { method: 'POST', url: '/fx/trade-offer-confirmation', body: { requestReference: '1234005', confirm: true } })
    assert.equal(res.statusCode, 202)
    const all = await jsonDrain(ctx)
    const conf = all.find((m) => m.type === 'FX_TRADE_OFFER_CONFIRMATION')!
    const c = jsonValid('fx-trade-offer-confirmation.response', conf.body)
    assert.equal(c.tradeStatus, 'COMPLETED')
    assert.equal(typeof c.pmtInfId, 'number')
    assert.equal(await balance(ctx, C1.iban, 'EUR'), '9900.00')
    assert.equal(await balance(ctx, C1.iban, 'USD'), '608.00')
    const notes = all.filter((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION')
    assert.equal(notes.length, 2)
    for (const n of notes) {
      await schemaValid(n.body)
      assert.match(n.body, new RegExp(`<PmtInfId>${c.pmtInfId}</PmtInfId>`))
      assert.match(n.body, /<Cd>FORX<\/Cd>/)
    }
  })

  test('SPOT: reserved at confirmation, settled on the settlement date with a second message', async () => {
    const [offer] = await post('/fx/trade-offer', {
      requestReference: 'S1', accountIBAN: C1.iban, currencyFrom: 'EUR', currencyTo: 'GBP', amountFrom: null, amountTo: 85, tenor: 'SPOT',
    })
    const o = jsonValid('fx-trade-offer.response', offer.body)
    assert.equal(o.amountFrom, 100)
    assert.equal(o.settlementDate, '2026-03-12T23:59:59+02:00')
    const [conf] = await post('/fx/trade-offer-confirmation', { requestReference: 'S1', confirm: 'true' })
    assert.equal(jsonValid('fx-trade-offer-confirmation.response', conf.body).tradeStatus, 'SETTLEMENT_PENDING')
    const b = (await ctx.emulator.ledger.balances(C1.iban)).EUR
    assert.equal(b.available, 990000n)
    assert.equal(b.balance, 1000000n)

    ctx.clock.set('2026-03-11T22:30:00Z') // 00:30 on 12 March in Tallinn
    const res = await call(ctx, { method: 'POST', url: '/_sim/fx/settle' })
    assert.equal(JSON.parse(res.body).settled, 1)
    const done = (await jsonDrain(ctx)).find((m) => m.type === 'FX_TRADE_OFFER_CONFIRMATION')!
    assert.equal(done.requestId, conf.requestId)
    const d = jsonValid('fx-trade-offer-confirmation.response', done.body)
    assert.equal(d.tradeStatus, 'COMPLETED')
    assert.equal(await balance(ctx, C1.iban, 'GBP'), '585.00')
  })

  test('a number with leading zeroes is answered in the inbox with the parser text', async () => {
    const body = '{\n  "requestReference": 000111222334455,\n  "accountIBAN": "EE337700771001260958",\n  "tenor": "TODAY"\n}'
    const [m] = await post('/fx/trade-offer', body)
    const e = jsonValid('fx-error', m.body)
    assert.match(e.errorCode[0], /^Invalid numeric value: Leading zeroes not allowed\n at \[Source: \(String\)".*"; line: 2, column: 24\]$/s)
  })
})
