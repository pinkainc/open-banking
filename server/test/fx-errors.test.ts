// L5a FX error matrix (P 12 "Errors", decisions 404-406): technical errors answer only
// {errorCode} and store no offer; business errors answer the offer dataset CANCELLED with
// errorCode. Documented texts are compared exactly. Requests that are wrong on purpose
// are asserted to violate the ssot request schema (jsonInvalid), every answer is
// schema-checked (fx-error and the offer/confirmation response schemas).
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { FX_E } from '../src/fx/service.js'
import { C1, C2, call, jsonDrain, jsonInvalid, jsonValid, setup, type Ctx } from './helpers.js'

let ctx: Ctx
beforeEach(async () => {
  ctx = await setup()
  await call(ctx, { method: 'PUT', url: '/_sim/fx/pricing', body: { margin: '0' } })
})

type Url = '/fx/trade-offer' | '/fx/trade-offer-confirmation'
const schemaOf = (url: Url) => (url === '/fx/trade-offer' ? 'fx-trade-offer.request' : 'fx-trade-offer-confirmation.request')

/**
 * POSTs a body (an object is checked against the request schema: valid unless `invalid`)
 * and returns the one inbox answer, parsed.
 */
async function answer(url: Url, body: string | object, o: { invalid?: boolean; as?: string } = {}) {
  if (typeof body === 'object') (o.invalid ? jsonInvalid : jsonValid)(schemaOf(url), body)
  const res = await call(ctx, { method: 'POST', url, body, contentType: 'application/json', as: o.as })
  assert.equal(res.statusCode, 202, res.body)
  const id = res.headers['message-request-id'] as string
  const msgs = (await jsonDrain(ctx, o.as ?? C1.code)).filter((m) => m.requestId === id)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].type, url === '/fx/trade-offer' ? 'FX_TRADE_OFFER' : 'FX_TRADE_OFFER_CONFIRMATION')
  return msgs[0].body
}

const offers = async () => JSON.parse((await call(ctx, { url: '/_sim/fx/offers' })).body).offers as any[]

/** A technical error: exactly {errorCode: [text]} and no offer stored by it. */
async function technical(url: Url, body: string | object, o: { invalid?: boolean; as?: string } = {}) {
  const before = (await offers()).length
  const e = jsonValid('fx-error', await answer(url, body, o))
  assert.deepEqual(Object.keys(e), ['errorCode'])
  assert.equal(e.errorCode.length, 1)
  assert.equal((await offers()).length, before, 'no offer stored')
  return e.errorCode[0] as string
}

/** A business error: the offer dataset CANCELLED with one errorCode, stored. */
async function business(body: object, o: { invalid?: boolean } = {}) {
  const raw = await answer('/fx/trade-offer', body, o)
  jsonValid('fx-error', raw)
  const v = jsonValid('fx-trade-offer.response', raw)
  assert.equal(v.tradeOfferStatus, 'CANCELLED')
  assert.equal(v.validityTime, undefined)
  assert.equal(v.errorCode.length, 1)
  assert.equal((await offers()).find((x) => x.requestReference === v.requestReference)?.status, 'CANCELLED')
  return v
}

const deal = (ref: string, o: Record<string, unknown> = {}) =>
  ({ requestReference: ref, accountIBAN: C1.iban, currencyFrom: 'EUR', currencyTo: 'USD', amountFrom: 100, tenor: 'TODAY', ...o })

async function quoted(ref: string, o: Record<string, unknown> = {}) {
  const v = jsonValid('fx-trade-offer.response', await answer('/fx/trade-offer', deal(ref, o)))
  assert.equal(v.tradeOfferStatus, 'CONFIRMATION_PENDING', JSON.stringify(v))
  return v
}

describe('FX technical errors: trade offer', () => {
  test('a number with leading zeroes: the documented Jackson text, the source echoed raw (decision 406)', async () => {
    // The P 12 sample request, as sent (pretty-printed with two spaces).
    const src = '{\n  "requestReference": 000111222334455,\n  "accountIBAN": "EE317700771001316284",\n  "currencyFrom": "USD",\n  "amountFrom": 100,\n  "currencyTo": "EUR",\n  "tenor": "TODAY",\n  "comment": "test"\n}'
    assert.equal(await technical('/fx/trade-offer', src),
      `Invalid numeric value: Leading zeroes not allowed\n at [Source: (String)"${src}"; line: 2, column: 24]`)
  })

  test('a long source is cut at 500 characters with Jackson\'s [truncated N chars]', async () => {
    const src = `{"comment": "${'x'.repeat(600)}", "requestReference": 01}`
    const e = await technical('/fx/trade-offer', src)
    assert.equal(e, `Invalid numeric value: Leading zeroes not allowed\n at [Source: (String)"${src.slice(0, 500)}"[truncated ${src.length - 500} chars]; line: 1, column: ${src.indexOf('01') + 2}]`)
  })

  test('other malformed JSON and an empty body', async () => {
    assert.match(await technical('/fx/trade-offer', '{"requestReference": "x",'), /^JSON parse error: .+\n at \[Source: \(String\)"\{"requestReference": "x","; line: 1, column: \d+\]$/s)
    assert.match(await technical('/fx/trade-offer', ''), /^No content to map due to end-of-input\n at \[Source: \(String\)""; line: 1, column: 1\]$/)
    assert.equal(await technical('/fx/trade-offer', [deal('A0')], { invalid: true }), FX_E.type('body', 'TradeOfferRequest', [deal('A0')]))
  })

  test('missing requestReference or tenor; wrong JSON types; a tenor outside TODAY/SPOT', async () => {
    const { requestReference: _, ...noRef } = deal('x')
    assert.equal(await technical('/fx/trade-offer', noRef, { invalid: true }), 'Missing required field requestReference')
    assert.equal(await technical('/fx/trade-offer', deal(''), {}), 'Missing required field requestReference')
    const { tenor: __, ...noTenor } = deal('A1')
    assert.equal(await technical('/fx/trade-offer', noTenor, { invalid: true }), 'Missing required field tenor')
    assert.equal(await technical('/fx/trade-offer', deal('A2', { tenor: 'TOM' }), { invalid: true }),
      'Cannot deserialize value of type `Tenor` from String "TOM": not one of the values accepted for Enum class: [SPOT, TODAY]')
    assert.equal(await technical('/fx/trade-offer', deal({ a: 1 } as never), { invalid: true }), 'Cannot deserialize value of type `java.lang.String` from {"a":1} (field requestReference)')
    assert.equal(await technical('/fx/trade-offer', deal('A3', { currencyFrom: 978 }), { invalid: true }), 'Cannot deserialize value of type `java.lang.String` from 978 (field currencyFrom)')
    assert.equal(await technical('/fx/trade-offer', deal('A4', { accountIBAN: 1 }), { invalid: true }), 'Cannot deserialize value of type `java.lang.String` from 1 (field accountIBAN)')
    assert.equal(await technical('/fx/trade-offer', deal('A5', { amountFrom: 'ten' }), { invalid: true }), 'Cannot deserialize value of type `java.math.BigDecimal` from String "ten" (field amountFrom)')
    assert.equal(await technical('/fx/trade-offer', deal('A6', { amountFrom: null, amountTo: true }), { invalid: true }), 'Cannot deserialize value of type `java.math.BigDecimal` from true (field amountTo)')
  })

  test('Incorrect Account: unknown, another customer\'s, a VIBAN, missing (documented text)', async () => {
    const reg = (ctx.emulator as any).viban.registry
    const viban = await reg.generate(C1.iban)
    await reg.add({ iban: viban, master: C1.iban, status: 'ACTIVE', owner: { code: C1.code, country: 'EE' }, createdAt: ctx.clock.now() })
    const { accountIBAN: _, ...noIban } = deal('B0')
    for (const [ref, iban] of [['B1', 'EE017700770000000000'], ['B2', C2.iban], ['B3', viban], ['B4', 'not an iban']]) {
      assert.equal(await technical('/fx/trade-offer', deal(ref, { accountIBAN: iban })), 'Incorrect Account', iban)
    }
    assert.equal(await technical('/fx/trade-offer', noIban, { invalid: true }), 'Incorrect Account')
    // The answer is the documented body, byte for byte.
    const res = await call(ctx, { method: 'POST', url: '/fx/trade-offer', body: deal('B5', { accountIBAN: C2.iban }) })
    const m = (await jsonDrain(ctx)).find((x) => x.requestId === res.headers['message-request-id'])!
    assert.equal(m.body, '{"errorCode":["Incorrect Account"]}')
  })

  test('Pricing not available, try again later (documented text), then quotes again', async () => {
    await call(ctx, { method: 'PUT', url: '/_sim/fx/pricing', body: { available: false } })
    assert.equal(await technical('/fx/trade-offer', deal('C1')), 'Pricing not available, try again later')
    await call(ctx, { method: 'PUT', url: '/_sim/fx/pricing', body: { available: true } })
    await quoted('C1')
  })

  test('a duplicate requestReference, also of a CANCELLED offer, also when the first was a number', async () => {
    await quoted('D1')
    assert.equal(await technical('/fx/trade-offer', deal('D1')), 'Trade offer with requestReference D1 already exists')
    await business(deal('D2', { currencyTo: 'JPY' }))
    assert.equal(await technical('/fx/trade-offer', deal('D2')), 'Trade offer with requestReference D2 already exists')
    await quoted(77 as never)
    assert.equal(await technical('/fx/trade-offer', deal('77')), 'Trade offer with requestReference 77 already exists')
  })
})

describe('FX business errors: CANCELLED offer with errorCode', () => {
  test('no amount: the "Not enough parameters" sample replayed, same fields in the same order', async () => {
    const v = await business({ requestReference: '000111222334455888990011', accountIBAN: C1.iban, currencyFrom: 'USD', currencyTo: 'EUR', comment: 'test', tenor: 'TODAY' }, { invalid: true })
    assert.deepEqual(v.errorCode, ['At least one amount for the trade must be given'])
    assert.deepEqual(Object.keys(v), ['requestReference', 'accountIban', 'currencyFrom', 'currencyTo', 'baseCurrency', 'orderDateTime', 'tradeDate', 'tenor', 'tradeOfferStatus', 'comment', 'accountServicerReference', 'errorCode'])
    assert.deepEqual([v.baseCurrency, v.tradeDate], ['EUR', '2026-03-10T23:59:59+02:00'])
    // Both null is the same.
    const w = await business(deal('E2', { amountFrom: null, amountTo: null }), { invalid: true })
    assert.deepEqual(w.errorCode, ['At least one amount for the trade must be given'])
  })

  test('exactly one of amountFrom / amountTo', async () => {
    const v = await business(deal('E3', { amountFrom: 100, amountTo: 108 }))
    assert.deepEqual(v.errorCode, ['Only one of amountFrom or amountTo can be given'])
    assert.equal(v.quote, undefined)
  })

  test('invalid amounts: zero, negative, three decimals; numeric strings are coerced', async () => {
    assert.deepEqual((await business(deal('E4', { amountFrom: 0 }))).errorCode, [FX_E.amount('0')])
    assert.deepEqual((await business(deal('E5', { amountFrom: -5 }))).errorCode, ['Invalid amount -5: must be positive with at most 2 decimals'])
    assert.deepEqual((await business(deal('E6', { amountFrom: 1.234 }))).errorCode, ['Invalid amount 1.234: must be positive with at most 2 decimals'])
    assert.deepEqual((await business(deal('E7', { amountFrom: null, amountTo: 0.001 }))).errorCode, [FX_E.amount('0.001')])
    // "100.50" and 1.50 (trailing zero) are fine.
    const e8 = jsonValid('fx-trade-offer.response', await answer('/fx/trade-offer', deal('E8', { amountFrom: '100.50' }), { invalid: true }))
    assert.deepEqual([e8.tradeOfferStatus, e8.amountFrom], ['CONFIRMATION_PENDING', 100.5])
    assert.equal((await quoted('E9', { amountFrom: 1.5 })).amountTo, 1.62)
    // A converted amount that rounds to zero.
    assert.deepEqual((await business(deal('E10', { currencyFrom: 'CZK', currencyTo: 'EUR', amountFrom: 0.01 }))).errorCode, [FX_E.amount('0.00')])
  })

  test('unsupported, equal and missing currencies', async () => {
    assert.deepEqual((await business(deal('F1', { currencyTo: 'JPY' }))).errorCode, ['Currency JPY is not supported'])
    assert.deepEqual((await business(deal('F2', { currencyFrom: 'HUF' }))).errorCode, ['Currency HUF is not supported'])
    assert.deepEqual((await business(deal('F3', { currencyTo: 'EUR' }))).errorCode, ['currencyFrom and currencyTo must differ'])
    const { currencyTo: _, ...noTo } = deal('F4')
    assert.deepEqual((await business(noTo, { invalid: true })).errorCode, ['Missing required field currencyTo'])
    // Lower case is accepted.
    assert.equal((await quoted('F5', { currencyFrom: 'eur', currencyTo: 'usd' })).currencyTo, 'USD')
  })

  test('no funds at the quote: the documented sample text (amounts with 2 decimals, the quote with 5)', async () => {
    await call(ctx, { method: 'PUT', url: '/_sim/fx/pricing', body: { rates: { AUD: '1.45' } } })
    const v = await business({ requestReference: '12345629', accountIBAN: C1.iban, currencyFrom: 'AUD', amountFrom: 100000000.0, currencyTo: 'EUR', comment: 'testkommentaar', tenor: 'TODAY' })
    assert.deepEqual(v.errorCode, ['Conversion not possible, because there are no funds for currency (100000000.00 AUD -> 68965517.24 EUR, 1.45000)'])
    assert.deepEqual([v.amountFrom, v.amountTo, v.baseCurrency, v.quote, v.settlementDate], [100000000, 68965517.24, 'EUR', 1.45, '2026-03-10T23:59:59+02:00'])
    // One cent over the balance.
    assert.match((await business(deal('G2', { amountFrom: 10000.01 }))).errorCode[0], /^Conversion not possible, because there are no funds for currency \(10000\.01 EUR -> 10800\.01 USD, 1\.08000\)$/)
  })
})

describe('FX confirmation errors', () => {
  test('technical: malformed, missing fields, a non-boolean confirm, an unknown requestReference', async () => {
    const url = '/fx/trade-offer-confirmation' as const
    assert.match(await technical(url, '{"confirm": tru'), /^JSON parse error: /)
    assert.equal(await technical(url, { confirm: true }, { invalid: true }), 'Missing required field requestReference')
    assert.equal(await technical(url, { requestReference: 'H1' }, { invalid: true }), 'Missing required field confirm')
    assert.equal(await technical(url, { requestReference: 'H1', confirm: 'yes' }), 'Cannot deserialize value of type `boolean` from String "yes": only "true" or "false" recognized')
    assert.equal(await technical(url, { requestReference: 'H1', confirm: true }), 'Trade offer with requestReference H1 not found')
    // Another customer's offer is unknown too.
    await quoted('H2')
    assert.equal(await technical(url, { requestReference: 'H2', confirm: true }, { as: C2.code }), 'Trade offer with requestReference H2 not found')
  })

  test('a second confirmation, a confirmation after false, of a CANCELLED offer: technical', async () => {
    const url = '/fx/trade-offer-confirmation' as const
    await quoted('J1')
    jsonValid('fx-trade-offer-confirmation.response', await answer(url, { requestReference: 'J1', confirm: true }))
    assert.equal(await technical(url, { requestReference: 'J1', confirm: true }), 'Trade offer with requestReference J1 cannot be confirmed')
    await quoted('J2')
    jsonValid('fx-trade-offer-confirmation.response', await answer(url, { requestReference: 'J2', confirm: false }))
    assert.equal(await technical(url, { requestReference: 'J2', confirm: true }), 'Trade offer with requestReference J2 cannot be confirmed')
    await business(deal('J3', { currencyTo: 'JPY' }))
    assert.equal(await technical(url, { requestReference: 'J3', confirm: true }), 'Trade offer with requestReference J3 cannot be confirmed')
    assert.equal(await technical(url, { requestReference: 'J3', confirm: false }), 'Trade offer with requestReference J3 cannot be confirmed')
  })

  test('an expired offer stays expired, also for confirm false', async () => {
    await quoted('K1')
    ctx.clock.advance(3 * 60_000)
    const url = '/fx/trade-offer-confirmation' as const
    assert.equal(await technical(url, { requestReference: 'K1', confirm: true }), 'Trade offer quote has expired')
    assert.equal(await technical(url, { requestReference: 'K1', confirm: false }), 'Trade offer quote has expired')
  })

  test('no funds at confirmation: CANCELLED with the documented text, no pmtInfId, nothing reserved', async () => {
    await quoted('L1', { amountFrom: 6000 })
    await quoted('L2', { amountFrom: 6000 })
    const url = '/fx/trade-offer-confirmation' as const
    assert.equal(jsonValid('fx-trade-offer-confirmation.response', await answer(url, { requestReference: 'L1', confirm: true })).tradeStatus, 'COMPLETED')
    const raw = await answer(url, { requestReference: 'L2', confirm: true })
    jsonValid('fx-error', raw)
    const c = jsonValid('fx-trade-offer-confirmation.response', raw)
    assert.equal(c.tradeStatus, 'CANCELLED')
    assert.deepEqual(c.errorCode, ['Conversion not possible, because there are no funds for currency (6000.00 EUR -> 6480.00 USD, 1.08000)'])
    assert.equal(c.pmtInfId, undefined)
    const b = (await ctx.emulator.ledger.balances(C1.iban)).EUR
    assert.deepEqual([b.balance, b.available], [400000n, 400000n])
    assert.equal(await technical(url, { requestReference: 'L2', confirm: true }), 'Trade offer with requestReference L2 cannot be confirmed')
  })
})
