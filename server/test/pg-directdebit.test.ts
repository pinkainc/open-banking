// SEPA Direct Debit collections in Postgres (decisions 975, 976): an emulator restarted on
// the same namespace settles a collection accepted before the restart on its settlement
// day, once; a refusal after the cut-off made before the restart is still returned right
// after the settlement; two emulators ticking on one namespace settle a collection once.
// Registered only when DATABASE_URL is set.
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { C1, C2, balance, call, ddDrain, ddEntry, ddStatus, pain007, pain008, postgresStore, setup, type Ctx } from './helpers.js'

const url = process.env.DATABASE_URL
const CUTOFF = '2026-03-12T09:30:00Z' // 10:30 CET on the settlement date
const SETTLEMENT = '2026-03-12T10:30:00Z' // 11:30 CET

let n = 0
/** C1 collects 10.00 from C2; both inboxes are emptied. */
async function collection(ctx: Ctx) {
  const id = ++n
  const ids = { pmtInfId: `PMT-PG${id}`, endToEndId: `E2E-PG${id}`, instrId: `INSTR-PG${id}` }
  const res = await call(ctx, { method: 'POST', url: '/direct-debit/collection', body: pain008([{ pmtInfId: ids.pmtInfId, txs: [{ ...ids, amount: '10.00' }] }]) })
  assert.equal(res.statusCode, 202, res.body)
  assert.equal(ddStatus((await ddDrain(ctx))[0]).grp, 'ACCP')
  assert.deepEqual((await ddDrain(ctx, C2.code)).map((m) => m.type), ['DIRECT_DEBIT_INCOMING_COLLECTION_NOTIFICATION'])
  return ids
}

async function settle(ctx: Ctx, at = SETTLEMENT) {
  ctx.clock.set(at)
  const res = await call(ctx, { method: 'POST', url: '/_sim/direct-debit/settle' })
  assert.equal(res.statusCode, 200, res.body)
  return res.json().settled as number
}

if (url) describe('SEPA Direct Debit collections across a restart (Postgres)', () => {
  test('a collection accepted before the restart is settled after it, once', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const c = await collection(a)
    const before = [await balance(a, C1.iban), await balance(a, C2.iban)]

    const b = await setup(opts)
    const list = (await call(b, { url: '/_sim/direct-debit/collections' })).json().collections
    assert.deepEqual(list.map((x: any) => [x.endToEndId, x.status]), [[c.endToEndId, 'PENDING']])
    assert.equal(await settle(b, '2026-03-12T10:29:59Z'), 0, 'not before 11:30 CET')
    assert.equal(await settle(b), 1)
    const creditor = await ddDrain(b)
    assert.deepEqual(creditor.map((m) => m.type).sort(), ['CREDIT_DEBIT_NOTIFICATION', 'DIRECT_DEBIT_OUTGOING'])
    assert.equal(ddStatus(creditor.find((m) => m.type === 'DIRECT_DEBIT_OUTGOING')!).blocks[0].txs[0].sts, 'ACSC')
    assert.deepEqual((await ddDrain(b, C2.code)).map((m) => ddEntry(m).ind), ['DBIT'])
    assert.deepEqual([await balance(b, C1.iban), await balance(b, C2.iban)], [(Number(before[0]) + 10).toFixed(2), (Number(before[1]) - 10).toFixed(2)])

    const again = await setup(opts)
    assert.equal(await settle(again, '2026-03-13T10:30:00Z'), 0, 'settled once')
    assert.deepEqual([await balance(again, C1.iban), await balance(again, C2.iban)], [(Number(before[0]) + 10).toFixed(2), (Number(before[1]) - 10).toFixed(2)])
    assert.deepEqual((await call(again, { url: '/_sim/direct-debit/collections' })).json().collections.map((x: any) => x.status), ['SETTLED'])
  })

  test('a refusal after the cut-off before the restart is returned after the settlement, once', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const c = await collection(a)
    a.clock.set(CUTOFF)
    const res = await call(a, { method: 'POST', url: '/direct-debit/incoming-collection', body: pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId, reason: 'MS02' }]), as: C2.code })
    assert.equal(res.statusCode, 202, res.body)
    assert.equal(ddStatus((await ddDrain(a, C2.code))[0]).blocks[0].txs[0].sts, 'ACCP')
    const before = [await balance(a, C1.iban), await balance(a, C2.iban)]

    const b = await setup(opts)
    assert.equal(await settle(b), 1)
    const debtor = (await ddDrain(b, C2.code)).map(ddEntry)
    assert.deepEqual(debtor.map((e) => [e.ind, e.subFamily]), [['DBIT', 'ESDD'], ['CRDT', 'UPDD']])
    assert.deepEqual((await call(b, { url: '/_sim/direct-debit/collections' })).json().collections.map((x: any) => x.status), ['REFUNDED'])
    const again = await setup(opts)
    assert.equal(await settle(again, '2026-03-13T10:30:00Z'), 0)
    assert.deepEqual([await balance(again, C1.iban), await balance(again, C2.iban)], before, 'debited and paid back once')
    // A second refusal is refused: the collection's state outlived the restarts.
    const late = await call(again, { method: 'POST', url: '/direct-debit/incoming-collection', body: pain007([{ pmtInfId: c.pmtInfId, endToEndId: c.endToEndId, reason: 'MS02' }]), as: C2.code })
    assert.equal(late.statusCode, 202)
    assert.equal(ddStatus((await ddDrain(again, C2.code))[0]).blocks[0].txs[0].sts, 'RJCT')
  })

  test('two emulators ticking on one namespace settle a collection once', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    await collection(a)
    const before = await balance(a, C2.iban)
    const b = await setup(opts)
    a.clock.set(SETTLEMENT)
    b.clock.set(SETTLEMENT)
    const settled = await Promise.all([a.emulator.directDebit.tick(), b.emulator.directDebit.tick(), a.emulator.directDebit.tick()])
    assert.equal(settled.reduce((x, y) => x + y, 0), 1, settled.join())
    assert.equal(await balance(b, C2.iban), (Number(before) - 10).toFixed(2))
    assert.deepEqual((await ddDrain(a, C2.code)).map((m) => ddEntry(m).ind), ['DBIT'], 'one debit notification')
  })
})
