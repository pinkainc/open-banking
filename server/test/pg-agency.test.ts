// Agency and acquiring state in Postgres beyond the shared semantics (the whole suite runs
// on them with OPEN_BANKING_STORE=postgres): an agency account round-trips under every key
// form, namespaces keep stores apart, set-ups and removals persist, bounds hold, and an
// emulator restarted on the same namespace sees what the agents synchronised, what the
// account manager set up and the card transactions. Registered only when DATABASE_URL is set.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, test } from 'node:test'
import type { AgencyAccount } from '../src/agency/store.js'
import { ManualClock } from '../src/clock.js'
import { makeIban } from '../src/iban.js'
import { PgAcquiringStore } from '../src/pg/acquiring.js'
import { PgAgencyStore } from '../src/pg/agency.js'
import { call, pgDb, postgresStore, seed, setup } from './helpers.js'

const url = process.env.DATABASE_URL

const EEM = makeIban('EE', '7700771001260199')
const GBM = makeIban('GB', 'LHVB04031400007777')
const AG = { code: '09870001', country: 'GB', name: 'Agent Payments Ltd' }
const NL = makeIban('NL', 'RABO0417164300')
const GB_IBAN = makeIban('GB', 'LHVB40127612345678')

const account = (o: Partial<AgencyAccount> & Pick<AgencyAccount, 'bank' | 'id'>, at = new Date('2026-03-10T08:00:00.123Z')): AgencyAccount => ({
  country: o.id.slice(0, 2).replace(/^\d\d$/, 'GB'), status: 'ACTIVE', copOptOut: false,
  agent: { code: AG.code, country: AG.country }, master: GBM, createdAt: at, updatedAt: at, ...o,
})

if (url) describe('PgAgencyStore and PgAcquiringStore (Postgres)', () => {
  const clock = new ManualClock('2026-03-10T08:00:00Z')
  const store = async (namespace = randomUUID(), max = 100) => new PgAgencyStore(await pgDb(), clock, { namespace, bounds: { max } })

  test('an agency account round-trips and is found by IBAN, GB IBAN and sort code + account number', async () => {
    const s = await store()
    const nl = account({ bank: 'LHVEE', id: NL, country: 'NL', iban: NL, name: 'Jan Novak', category: 'PERSONAL', master: EEM })
    const gbNo = account({ bank: 'LHVUK', id: '40127612345678', accountNo: '40127612345678', status: 'INST_RESTRICTED', copOptOut: true })
    const gbBoth = account({ bank: 'LHVEE', id: '40127612345678', iban: GB_IBAN, accountNo: '40127612345678', name: 'Jane Doe', category: 'BUSINESS' })
    for (const a of [nl, gbNo, gbBoth]) await s.put(a)
    assert.deepEqual(await s.get('LHVEE', NL), nl, 'every field, the dates to the millisecond')
    assert.deepEqual(await s.get('LHVEE', NL.toLowerCase().replace(/(.{4})/g, '$1 ')), nl, 'normalised')
    assert.deepEqual(await s.get('LHVUK', '40127612345678'), gbNo)
    assert.deepEqual(await s.get('LHVUK', GB_IBAN), gbNo, 'a GB IBAN finds the sort code + account number')
    assert.deepEqual((await s.find(GB_IBAN)).map((a) => a.bank), ['LHVEE', 'LHVUK'], 'LHV EE first')
    assert.deepEqual(await s.find('INV-42'), [])
    assert.equal(await s.get('LHVUK', NL), undefined)
    assert.equal(await s.count(), 3)
    // A rewrite replaces the account and moves it to the end.
    await s.put({ ...nl, status: 'CLOSED' })
    assert.deepEqual((await s.all()).map((a) => `${a.bank}:${a.id}:${a.status}`), ['LHVUK:40127612345678:INST_RESTRICTED', 'LHVEE:40127612345678:ACTIVE', `LHVEE:${NL}:CLOSED`])
    assert.deepEqual((await s.ofAgent({ code: AG.code, country: 'gb' }, 'LHVUK')).map((a) => a.id), ['40127612345678'])
  })

  test('namespaces keep agency and acquiring state apart; one namespace is one store', async () => {
    const ns = randomUUID()
    const [a, b, other] = [await store(ns), await store(ns), await store()]
    await a.put(account({ bank: 'LHVUK', id: '40127600000001', accountNo: '40127600000001' }))
    await a.setSetup(AG, { agreement: true })
    assert.equal((await b.get('LHVUK', '40127600000001'))?.id, '40127600000001')
    assert.deepEqual(await b.setup(AG), { agreement: true })
    assert.equal(await other.get('LHVUK', '40127600000001'), undefined)
    assert.equal(await other.setup(AG), undefined)
    assert.equal((await other.setups()).size, 0)
    const db = await pgDb()
    const [q1, q2, q3] = [new PgAcquiringStore(db, clock, { namespace: ns }), new PgAcquiringStore(db, clock, { namespace: ns }), new PgAcquiringStore(db, clock)]
    await q1.setMerchant('EE:1', { userCode: 'X1', accounts: [EEM] })
    assert.deepEqual([await q1.nextRef(), await q2.nextRef(), await q3.nextRef()], ['4901', '4902', '4901'], 'one counter per namespace')
    assert.deepEqual(await q2.merchant('EE:1'), { userCode: 'X1', accounts: [EEM] })
    assert.equal(await q3.merchant('EE:1'), undefined)
  })

  test('set-ups: replaced, removed, and a removal outlives a seed written only if absent', async () => {
    const s = await store()
    await s.setSetup(AG, { agreement: true, cop: true }, { ifAbsent: true })
    await s.setSetup(AG, { agreement: false }, { ifAbsent: true })
    assert.deepEqual(await s.setup(AG), { agreement: true, cop: true })
    await s.setSetup(AG, undefined)
    assert.equal(await s.setup(AG), undefined)
    await s.setSetup(AG, { agreement: true }, { ifAbsent: true })
    assert.equal(await s.setup(AG), undefined, 'the removal is remembered')
  })

  test('bounds: the oldest accounts over the maximum go first, expired ones are gone', async () => {
    const s = await store(randomUUID(), 2)
    for (const n of [1, 2, 3]) await s.put(account({ bank: 'LHVUK', id: `4012760000000${n}`, accountNo: `4012760000000${n}` }))
    assert.deepEqual((await s.all()).map((a) => a.id), ['40127600000002', '40127600000003'])
    const t = new PgAgencyStore(await pgDb(), clock, { bounds: { max: 10, ttlMs: 60_000 } })
    await t.put(account({ bank: 'LHVUK', id: '40127600000009', accountNo: '40127600000009' }))
    clock.advance(60_000)
    assert.equal(await t.get('LHVUK', '40127600000009'), undefined)
    assert.equal(await t.count(), 0)
  })
})

if (url) test('an emulator restarted on the same namespace sees synced agency accounts, set-ups and card transactions', async () => {
  const opts = await postgresStore() // one namespace for both
  const s = seed()
  s.customers.push({
    ...AG, accounts: [{ iban: EEM, balances: { EUR: '10.00' } }, GBM],
    agency: { agreement: true, cop: true, ranges: [{ country: 'GB', sortCode: '401276', master: GBM }] },
  } as any)
  const a = await setup(opts, s)
  const agent = a.emulator.directory.get(AG)!
  // The account manager turns on notifications; a restart must keep it over the seed's set-up.
  const put = await call(a, { method: 'PUT', url: `/_sim/agency/agents/GB/${AG.code}`, body: { agreement: true, cop: true, notifications: true, ranges: [{ country: 'GB', sortCode: '401276', master: GBM }] } })
  assert.equal(put.statusCode, 200)
  await a.emulator.agency.sync.syncJson({ Accounts: [{ Country: 'GB', Identification: '40127600000001', Name: 'Jane Doe', AccountCategory: 'PERSONAL' }] }, agent, 'sync-1')
  await a.emulator.acquiring.setMerchant(agent, { userCode: 'AG1', accounts: [EEM] })
  const t1 = await a.emulator.acquiring.addTransaction({ account: EEM, amount: '12.34', fee: '0.10', currency: 'EUR' })

  const b = await setup(opts, s, { flavour: 'UK' })
  const synced = await b.emulator.agency.accounts.get('LHVUK', GB_IBAN.replace('12345678', '00000001'))
  assert.equal(synced?.name, 'Jane Doe')
  assert.equal(synced?.master, GBM)
  assert.equal((await b.emulator.agency.accounts.setup(AG))?.notifications, true, 'the /_sim change outlives the seed')
  const list = await call(b, { method: 'GET', url: '/_sim/agency/accounts?agent=GB:09870001' })
  assert.deepEqual(list.json().accounts.map((x: { id: string }) => x.id), ['40127600000001'])
  // The responder answers from the persisted account and notifies with the persisted set-up.
  const cop = await call(b, { method: 'POST', url: '/_sim/agency/cop-incoming', body: { sortCode: '401276', accountNumber: '00000001', name: 'Jane Doe', accountClassification: 'PERSONAL' } })
  assert.equal(cop.json().response.Response.Data.Attributes.Answer, 'CONFIRMED')
  assert.ok(cop.json().notified, 'notified with the set-up as changed')
  assert.deepEqual(await b.emulator.acquiring.merchant(AG), { userCode: 'AG1', accounts: [EEM] })
  const txs = await b.emulator.acquiring.transactions(EEM)
  // Optional fields left out come back absent, not undefined.
  assert.deepEqual(txs, [Object.fromEntries(Object.entries(t1).filter(([, v]) => v !== undefined))])
  const t2 = await b.emulator.acquiring.addTransaction({ account: EEM, amount: '1.00' })
  assert.equal(Number(t2.ref), Number(t1.ref) + 1, 'references go on after the restart')
})
