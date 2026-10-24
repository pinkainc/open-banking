// VIBANs and master account agreements in Postgres (decision 984): a VIBAN opened before a
// restart of the emulator on the same namespace is still there after it (info, a payment to
// it credited to its master account, close); a closed one stays closed; the agreement of a
// /_sim customer survives and one ended over /_sim is not signed again by the seed; two
// emulators opening VIBANs at once, and a restarted one, never give out a number twice.
// Registered only when DATABASE_URL is set.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { C1, balance, call, drain, postgresStore, setup, type Ctx } from './helpers.js'

const url = process.env.DATABASE_URL
const C3 = { code: '12340003', country: 'EE', iban: 'EE427700771001260990' }
const X = '<?xml version="1.0" encoding="UTF-8"?>'
const USER = '<User><Person><Name>Donald Duck</Name><BirthDate>1908-11-29</BirthDate><BirthCountry>DE</BirthCountry><Residency>DE</Residency>' +
  '<DocumentNumber>A942819</DocumentNumber></Person><Address><Country>EE</Country><StreetNo>Majaka 47-10</StreetNo><CityCounty>Tallinn</CityCounty></Address></User>'
const openXml = (master: string) => `${X}<VibanOpenRequest><MasterAccount>${master}</MasterAccount>${USER}</VibanOpenRequest>`
const infoXml = (viban: string) => `${X}<VibanInfoRequest><MasterAccount>${C1.iban}</MasterAccount><VirtualIBAN>${viban}</VirtualIBAN></VibanInfoRequest>`
const closeXml = (viban: string) => `${X}<VibanCloseRequest><MasterAccount>${C1.iban}</MasterAccount><VirtualIBAN>${viban}</VirtualIBAN></VibanCloseRequest>`

/** POSTs a VIBAN request and returns its answer's document (the response root, or Errors). */
async function viban(ctx: Ctx, op: string, body: string, as = C1.code) {
  const res = await call(ctx, { method: 'POST', url: `/viban/${op}`, body, as })
  assert.equal(res.statusCode, 202, res.body)
  const m = (await drain(ctx, as)).find((x) => x.requestId === res.headers['message-request-id'])
  assert.ok(m, `an answer to ${op}`)
  return m.doc as any
}
const open = async (ctx: Ctx, master = C1.iban, as = C1.code) => {
  const d = await viban(ctx, 'open', openXml(master), as)
  assert.ok(d.VibanOpenResponse, JSON.stringify(d))
  return d.VibanOpenResponse.VirtualIBAN as string
}
const incoming = async (ctx: Ctx, iban: string) => {
  const res = await call(ctx, { method: 'POST', url: '/_sim/incoming', body: { iban, amount: '7.00', currency: 'EUR' } })
  assert.equal(res.statusCode, 200, res.body)
  return res.json()
}

if (url) describe('VIBANs across a restart (Postgres)', () => {
  test('a VIBAN opened before the restart is there after it: info, a payment to it on the master, close', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const v = await open(a)

    const b = await setup(opts)
    assert.equal((await viban(b, 'info', infoXml(v))).VibanInfoResponse.Status, 'ACTIVE')
    const before = await balance(b, C1.iban)
    const r = await incoming(b, v)
    assert.equal(r.masterAccount, C1.iban)
    assert.equal(await balance(b, C1.iban), (Number(before) + 7).toFixed(2), 'credited to the master account')
    assert.ok((await viban(b, 'close', closeXml(v))).VibanCloseResponse)

    const c = await setup(opts)
    assert.equal((await call(c, { url: `/_sim/viban/${v}` })).json().status, 'CLOSED')
    assert.equal((await incoming(c, v)).returned, true, 'a closed VIBAN returns the payment')
    assert.equal(await balance(c, C1.iban), (Number(before) + 7).toFixed(2))
    assert.notEqual(await open(c), v, 'a new number after the restart')
  })

  test('agreements: a /_sim customer\'s survives the restart, one ended over /_sim is not signed again by the seed', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const res = await call(a, { method: 'POST', url: '/_sim/customers', body: { code: C3.code, country: 'EE', name: 'Demo Customer 3', accounts: [{ iban: C3.iban, viban: true }] } })
    assert.equal(res.statusCode, 201, res.body)
    const end = await call(a, { method: 'POST', url: '/_sim/viban/agreements', body: { iban: C1.iban, active: false } })
    assert.equal(end.json().active, false)

    const b = await setup(opts)
    assert.match(await open(b, C3.iban, C3.code), /^EE/, 'the /_sim customer keeps its agreement')
    const d = await viban(b, 'open', openXml(C1.iban))
    assert.ok(d.Errors, 'the ended agreement stays ended')
  })

  test('two emulators opening VIBANs at once give out different numbers', async () => {
    const opts = await postgresStore()
    const [a, b] = [await setup(opts), await setup(opts)]
    const sent = await Promise.all([a, b, a, b].map((ctx) => call(ctx, { method: 'POST', url: '/viban/open', body: openXml(C1.iban), as: C1.code })))
    const ids = sent.map((res) => res.headers['message-request-id'])
    const opened = (await drain(a)).filter((m) => ids.includes(m.requestId!)).map((m) => (m.doc as any).VibanOpenResponse?.VirtualIBAN)
    assert.equal(opened.length, 4)
    assert.equal(new Set(opened).size, 4, opened.join())
    assert.equal((await call(a, { url: '/_sim/viban' })).json().vibans.length, 4)
  })
})
