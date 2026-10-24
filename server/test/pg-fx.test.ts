// FX offers in Postgres (decisions 980, 981): an offer made before a restart of the
// emulator on the same namespace can be confirmed after it within its validity, once; its
// requestReference stays taken; the pricing set over /_sim stays; a SPOT deal confirmed
// before the restart is settled after it once, also with two emulators ticking on one
// namespace; two emulators confirming one offer make one deal. Registered only when
// DATABASE_URL is set.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { VALIDITY_MS } from '../src/fx/service.js'
import { C1, balance, call, jsonDrain, postgresStore, setup, type Ctx } from './helpers.js'

const url = process.env.DATABASE_URL
const T0 = '2026-03-10T08:00:00Z' // setup's clock
const SPOT_DAY = '2026-03-12T06:00:00Z' // T+2 TARGET2 days, after 00:00 Tallinn

let n = 0
const ref = () => `PG-FX-${++n}`

async function post(ctx: Ctx, path: string, body: object) {
  const res = await call(ctx, { method: 'POST', url: path, body })
  assert.equal(res.statusCode, 202, res.body)
  const id = res.headers['message-request-id'] as string
  return (await jsonDrain(ctx)).filter((m) => m.requestId === id).map((m) => m.json as any)
}

const offer = async (ctx: Ctx, requestReference: string, tenor = 'TODAY') =>
  (await post(ctx, '/fx/trade-offer', { requestReference, accountIBAN: C1.iban, currencyFrom: 'EUR', currencyTo: 'USD', amountFrom: 100, tenor }))[0]
const confirm = async (ctx: Ctx, requestReference: string) =>
  (await post(ctx, '/fx/trade-offer-confirmation', { requestReference, confirm: true }))[0]

async function settle(ctx: Ctx) {
  ctx.clock.set(SPOT_DAY)
  const res = await call(ctx, { method: 'POST', url: '/_sim/fx/settle' })
  assert.equal(res.statusCode, 200, res.body)
  return res.json().settled as number
}

const money = async (ctx: Ctx) => [await balance(ctx, C1.iban), await balance(ctx, C1.iban, 'USD')]

if (url) describe('FX offers across a restart (Postgres)', () => {
  test('an offer made before the restart is confirmed after it within its validity, once; the reference stays taken', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    await call(a, { method: 'PUT', url: '/_sim/fx/pricing', body: { margin: '0' } })
    const r = ref()
    const o = await offer(a, r)
    assert.equal(o.tradeOfferStatus, 'CONFIRMATION_PENDING')
    assert.equal(o.quote, 1.08, 'the margin set before')
    const before = await money(a)

    const b = await setup(opts)
    assert.equal((await call(b, { url: '/_sim/fx/pricing' })).json().margin, 0, 'the pricing survives')
    assert.deepEqual((await call(b, { url: '/_sim/fx/offers' })).json().offers.map((x: any) => [x.requestReference, x.status]), [[r, 'CONFIRMATION_PENDING']])
    assert.deepEqual((await offer(b, r)).errorCode, [`Trade offer with requestReference ${r} already exists`])
    b.clock.set(new Date(Date.parse(T0) + VALIDITY_MS).toISOString())
    const c = await confirm(b, r)
    assert.equal(c.tradeStatus, 'COMPLETED')
    assert.deepEqual(await money(b), [(Number(before[0]) - 100).toFixed(2), (Number(before[1]) + 108).toFixed(2)])

    const again = await setup(opts)
    assert.deepEqual((await confirm(again, r)).errorCode, [`Trade offer with requestReference ${r} cannot be confirmed`])
    assert.deepEqual(await money(again), [(Number(before[0]) - 100).toFixed(2), (Number(before[1]) + 108).toFixed(2)])
    const d = await confirm(again, (await offer(again, ref())).requestReference)
    assert.ok(d.pmtInfId > c.pmtInfId, 'a new pmtInfId after the restart')
  })

  test('one millisecond past the validity after the restart: expired', async () => {
    const opts = await postgresStore()
    const r = ref()
    await offer(await setup(opts), r)
    const b = await setup(opts)
    b.clock.set(new Date(Date.parse(T0) + VALIDITY_MS + 1).toISOString())
    assert.deepEqual((await confirm(b, r)).errorCode, ['Trade offer quote has expired'])
  })

  test('a SPOT deal confirmed before the restart is settled after it, once; two emulators ticking settle once', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const r = ref()
    await offer(a, r, 'SPOT')
    assert.equal((await confirm(a, r)).tradeStatus, 'SETTLEMENT_PENDING')
    const usd = await balance(a, C1.iban, 'USD')

    const [b, c] = [await setup(opts), await setup(opts)]
    const settled = await Promise.all([settle(b), settle(c)])
    assert.equal(settled[0] + settled[1], 1)
    const done = [...(await jsonDrain(b)), ...(await jsonDrain(c))].filter((m) => m.type === 'FX_TRADE_OFFER_CONFIRMATION')
    assert.deepEqual(done.map((m) => (m.json as any).tradeStatus), ['COMPLETED'])
    assert.ok(Number(await balance(b, C1.iban, 'USD')) > Number(usd))
    const after = await money(b)
    assert.equal(await settle(await setup(opts)), 0)
    assert.deepEqual(await money(b), after)
  })

  test('two emulators confirming one offer make one deal', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const r = ref()
    await offer(a, r)
    const before = await money(a)
    const b = await setup(opts)
    const sent = await Promise.all([a, b].map((ctx) => call(ctx, { method: 'POST', url: '/fx/trade-offer-confirmation', body: { requestReference: r, confirm: true } })))
    const ids = sent.map((res) => res.headers['message-request-id'])
    const answers = (await jsonDrain(a)).filter((m) => ids.includes(m.requestId!)).map((m) => m.json as any)
    assert.deepEqual(answers.map((x) => x.tradeStatus ?? x.errorCode[0]).sort(), ['COMPLETED', `Trade offer with requestReference ${r} cannot be confirmed`])
    assert.equal(Number((await money(a))[0]), Number(before[0]) - 100, 'debited once')
  })
})
