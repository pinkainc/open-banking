// Bacs in Postgres (decisions 977, 978): an emulator restarted on the same namespace
// activates a mandate made before the restart, debits a collection submitted before it on
// the entry day (once, the next one under the mandate RCUR), books a pending incoming
// credit on its entry day (once), pays back a collection the customer rejected before the
// restart on day 5 (once); four emulators ticking on one namespace debit a collection once.
// Registered only when DATABASE_URL is set.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { makeIban } from '../src/iban.js'
import type { EmulatorOptions } from '../src/emulator.js'
import { call, ddEntry, drain, postgresStore, seed, setup, type Ctx } from './helpers.js'

const url = process.env.DATABASE_URL
const A = makeIban('GB', 'LHVB04031400001234')
const U1 = { code: '09876543', country: 'GB', name: 'Connect Demo Customer 1' }
const CREDITOR = { name: 'Utility Company Ltd', sortCode: '202015', accountNumber: '55555555' }

const start = (opts: EmulatorOptions) => {
  const s = seed()
  s.customers.push({ ...U1, accounts: [{ iban: A, balances: { GBP: '1000.00' } }] })
  return setup(opts, s, { flavour: 'UK' })
}
const sim = async (ctx: Ctx, path: string, body: object = {}, status = 201) => {
  const r = await call(ctx, { method: 'POST', url: `/_sim/bacs${path}`, body, as: null })
  assert.equal(r.statusCode, status, `${path}: ${r.body}`)
  return JSON.parse(r.body)
}
const at = (ctx: Ctx, t: string) => { ctx.clock.set(t); return sim(ctx, '/tick', {}, 200) }
const types = async (ctx: Ctx) => (await drain(ctx, U1.code)).map((m) => m.type)
const balance = async (ctx: Ctx) => (Number(await ctx.emulator.ledger.available(A, 'GBP')) / 100).toFixed(2)
const list = async (ctx: Ctx, what: string) => (await call(ctx, { url: `/_sim/bacs/${what}`, as: null })).json()[what]

if (url) describe('Bacs across a restart (Postgres)', () => {
  test('a mandate and a collection from before the restart: activated, debited once on the entry day, the next one RCUR', async () => {
    const opts = await postgresStore()
    const a = await start(opts)
    const m = await sim(a, '/mandates', { debtorIban: A, creditor: CREDITOR, serviceUserNumber: '539614', reference: 'TEST-112' })
    assert.deepEqual(await types(a), ['DIRECT_DEBIT_MANDATE_INITIATION'])

    const b = await start(opts)
    assert.deepEqual((await list(b, 'mandates')).map((x: any) => [x.id, x.status]), [[m.id, 'PENDING']])
    await at(b, `${m.entryDate}T18:35:00Z`)
    assert.deepEqual((await list(b, 'mandates')).map((x: any) => x.status), ['ACTIVE'])
    b.clock.set('2026-03-12T09:00:00Z')
    const c = await sim(b, '/collections', { mandateId: m.id, amount: '700.00' })
    assert.equal(c.seqTp, 'FRST')
    assert.deepEqual(await types(b), ['DIRECT_DEBIT_COLLECTION_NOTIFICATION'])

    const d = await start(opts)
    await at(d, '2026-03-13T05:59:00Z')
    assert.equal(await balance(d), '1000.00', 'not before 06:00 on the entry day')
    await at(d, '2026-03-13T06:00:00Z')
    const debit = (await drain(d, U1.code)).map(ddEntry)
    assert.deepEqual(debit.map((e) => [e.ind, e.amount, e.pmtInfId]), [['DBIT', '700.00', c.id]])
    assert.equal(await balance(d), '300.00')

    const e = await start(opts)
    await at(e, '2026-03-13T18:30:00Z')
    assert.deepEqual(await types(e), [], 'debited once')
    assert.equal(await balance(e), '300.00')
    assert.deepEqual((await list(e, 'collections')).map((x: any) => [x.id, x.debit, x.attempts]), [[c.id, 'BOOKED', 1]])
    assert.equal((await sim(e, '/collections', { mandateId: m.id, amount: '1.00' })).seqTp, 'RCUR', 'the mandate counts its collections across the restarts')
  })

  test('a pending incoming credit is booked on its entry day after the restart, once', async () => {
    const opts = await postgresStore()
    const a = await start(opts)
    const c = await sim(a, '/incoming', { iban: A, amount: '10.01', debtor: { name: 'Debtor Name', sortCode: '600102', accountNumber: '20266221' }, reference: 'REFERENCE' })
    assert.deepEqual(await types(a), ['BACS_INCOMING'])

    const b = await start(opts)
    assert.deepEqual((await list(b, 'incoming')).map((x: any) => [x.accountServicerReference, x.status]), [[c.accountServicerReference, 'PENDING']])
    await at(b, `${c.entryDate}T12:00:00Z`)
    const credit = (await drain(b, U1.code)).map(ddEntry)
    assert.deepEqual(credit.map((e) => [e.ind, e.amount]), [['CRDT', '10.01']])
    assert.equal(await balance(b), '1010.01')

    const d = await start(opts)
    await at(d, `${c.entryDate}T20:00:00Z`)
    assert.deepEqual(await types(d), [], 'booked once')
    assert.equal(await balance(d), '1010.01')
    assert.deepEqual((await list(d, 'incoming')).map((x: any) => x.status), ['BOOKED'])
  })

  test('a collection rejected before the restart is debited and paid back on day 5 after it, once', async () => {
    const opts = await postgresStore()
    const a = await start(opts)
    const m = await sim(a, '/mandates', { debtorIban: A, creditor: CREDITOR, serviceUserNumber: '539614' })
    await at(a, `${m.entryDate}T18:35:00Z`)
    a.clock.set('2026-03-12T09:00:00Z')
    const c = await sim(a, '/collections', { mandateId: m.id, amount: '100.00' })
    await drain(a, U1.code)
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.002.001.14"><CstmrPmtStsRpt><GrpHdr><MsgId>P002-PG</MsgId><CreDtTm>2026-03-12T10:00:00Z</CreDtTm></GrpHdr><OrgnlGrpInfAndSts><OrgnlMsgId>${c.msgId}</OrgnlMsgId><OrgnlMsgNmId>pain.008.001.11</OrgnlMsgNmId></OrgnlGrpInfAndSts><OrgnlPmtInfAndSts><OrgnlPmtInfId>${c.id}</OrgnlPmtInfId><PmtInfSts>RJCT</PmtInfSts><StsRsnInf><Rsn><Cd>AC04</Cd></Rsn></StsRsnInf></OrgnlPmtInfAndSts></CstmrPmtStsRpt></Document>`
    const r = await call(a, { method: 'POST', url: '/direct-debit/bacs-collection-reject', body, as: U1.code })
    assert.equal(r.statusCode, 202, r.body)
    assert.deepEqual(await types(a), ['DIRECT_DEBIT_COLLECTION_CONFIRMATION'])

    const b = await start(opts)
    await at(b, '2026-03-13T06:00:00Z')
    assert.deepEqual((await drain(b, U1.code)).map((x) => ddEntry(x).ind), ['DBIT'])
    const d = await start(opts)
    await at(d, '2026-03-17T05:00:00Z')
    const back = (await drain(d, U1.code)).map(ddEntry)
    assert.deepEqual(back.map((e) => [e.ind, e.amount, e.subFamily, e.returnCode]), [['CRDT', '100.00', 'UPDD', 'AC04']])
    const e = await start(opts)
    await at(e, '2026-03-18T05:00:00Z')
    assert.deepEqual(await types(e), [], 'paid back once')
    assert.equal(await balance(e), '1000.00')
  })

  test('four emulators ticking on one namespace debit a collection once', async () => {
    const opts = await postgresStore()
    const a = await start(opts)
    const m = await sim(a, '/mandates', { debtorIban: A, creditor: CREDITOR, serviceUserNumber: '539614' })
    await at(a, `${m.entryDate}T18:35:00Z`)
    a.clock.set('2026-03-12T09:00:00Z')
    await sim(a, '/collections', { mandateId: m.id, amount: '100.00' })
    await drain(a, U1.code)
    const all = [a, await start(opts), await start(opts), await start(opts)]
    for (const x of all) x.clock.set('2026-03-13T06:00:00Z')
    const b = all[1]
    await Promise.all(all.map((x) => x.emulator.bacs.tick()))
    assert.equal(await balance(b), '900.00', 'enough money for two debits: debited once all the same')
    assert.deepEqual((await drain(a, U1.code)).map((x) => ddEntry(x).ind), ['DBIT'], 'one debit notification')
    assert.deepEqual((await list(b, 'collections')).map((x: any) => [x.debit, x.attempts]), [['BOOKED', 1]])
  })
})
