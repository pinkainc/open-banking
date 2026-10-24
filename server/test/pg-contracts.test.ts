// Service provider contracts in Postgres (decisions 982, 983): a contract made before a
// restart of the emulator on the same namespace is still there after it, with its id and
// times, and can be activated and closed after it; the seeded connection's contract is made
// once per namespace, not again at each start; two emulators creating a contract for one
// customer at once make one PENDING contract. Registered only when DATABASE_URL is set.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { C2, SP, call, postgresStore, setup, type Ctx } from './helpers.js'

const url = process.env.DATABASE_URL
const asSp = { as: SP.code, headers: { 'Client-Code': SP.code, 'Client-Country': 'EE' } }

const create = (ctx: Ctx, companyCode = C2.code) =>
  call(ctx, { method: 'POST', url: '/contracts', body: { companyCode, companyCodeIssuer: 'EE' }, ...asSp })
const contracts = async (ctx: Ctx) => (await call(ctx, { url: '/_sim/contracts' })).json().contracts as any[]
const sim = async (ctx: Ctx, id: string, op: 'activate' | 'close') => {
  const res = await call(ctx, { method: 'POST', url: `/_sim/contracts/${id}/${op}` })
  assert.equal(res.statusCode, 200, res.body)
  return res.json()
}
/** [customer code, statuses newest first] as GET /contracts lists them (with CLOSED: a changedAt filter). */
const listed = async (ctx: Ctx, query = '') =>
  ((await call(ctx, { url: `/contracts${query}`, ...asSp })).json().customers as any[]).map((c) => [c.companyCode, c.contracts.map((x: any) => x.status)])

if (url) describe('Service provider contracts across a restart (Postgres)', () => {
  test('a contract made before the restart survives it, is activated and closed after it; the seeded one is made once', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const res = await create(a)
    assert.equal(res.statusCode, 200, res.body)
    const id = res.json().contractId
    const before = await contracts(a)
    assert.ok(before.some((c) => c.id === id && c.status === 'PENDING'))
    assert.ok(before.some((c) => c.status === 'ACTIVE'), 'a seeded connection')

    const b = await setup(opts)
    assert.deepEqual(await contracts(b), before, 'the same contracts, ids and times, no second seeded one')
    assert.equal((await create(b)).statusCode, 400, 'still pending: no second one')
    b.clock.set('2026-03-11T08:00:00Z')
    assert.equal((await sim(b, id, 'activate')).status, 'ACTIVE')

    const c = await setup(opts)
    c.clock.set('2026-03-12T08:00:00Z')
    assert.deepEqual((await contracts(c)).find((x) => x.id === id).status, 'ACTIVE')
    assert.ok((await listed(c)).some(([code, s]) => code === C2.code && s.join() === 'ACTIVE'))
    assert.equal((await sim(c, id, 'close')).status, 'CLOSED')

    const d = await setup(opts)
    assert.equal((await contracts(d)).find((x) => x.id === id).status, 'CLOSED')
    assert.equal((await contracts(d)).length, before.length)
    assert.ok(!(await listed(d)).some(([code]) => code === C2.code), 'closed: not listed without changedAt')
  })

  test('two emulators creating a contract for one customer at once make one', async () => {
    const opts = await postgresStore()
    const [a, b] = [await setup(opts), await setup(opts)]
    const seeded = await Promise.all([contracts(a), contracts(b)])
    assert.equal(seeded[0].length, (await contracts(a)).length)
    const statuses = (await Promise.all([create(a), create(b)])).map((r) => r.statusCode).sort()
    assert.deepEqual(statuses, [200, 400])
    assert.equal((await contracts(b)).filter((c) => c.customer.code === C2.code && c.status === 'PENDING').length, 1)
    assert.equal((await contracts(b)).length, seeded[0].length + 1, 'the seeded contracts once')
  })
})
