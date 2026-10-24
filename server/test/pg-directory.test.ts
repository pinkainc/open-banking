// Customers and accounts in Postgres beyond the shared semantics (the whole suite runs on
// PgDirectory with OPEN_BANKING_STORE=postgres, decisions 970-974): an emulator restarted on
// the same namespace keeps a customer added through /_sim with its account details, the
// PENDING switch, and decides a payment of that non-seed customer parked before the
// restart; the seed does not overwrite what is stored; two emulators on one namespace see
// each other's customers at once; namespaces stay apart. Registered only when DATABASE_URL is set.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, test } from 'node:test'
import { ManualClock } from '../src/clock.js'
import { makeIban } from '../src/iban.js'
import { PgDirectory } from '../src/pg/directory.js'
import { many } from '../src/xml.js'
import { C1, C2, call, drain, pain001, pgDb, postgresStore, setup } from './helpers.js'

const url = process.env.DATABASE_URL
const LATE = { code: '30000999', country: 'EE', name: 'Late Customer OÜ' }
const LATE_IBAN = makeIban('EE', '7700771234567891')
const LATE_IBAN2 = makeIban('EE', '7700771234567892')

const statuses = (msgs: { type: string; doc: any }[]) => msgs.filter((m) => m.type === 'PAYMENT').map((m) =>
  many<any>(m.doc.Document.CstmrPmtStsRpt.OrgnlPmtInfAndSts).flatMap((b) => many<any>(b.TxInfAndSts)).map((t) => [t.TxSts as string, t.AcctSvcrRef as string | undefined]))

if (url) describe('customers and accounts across a restart (Postgres)', () => {
  test('a /_sim customer, its account details and the PENDING switch survive; its parked payment is approved after the restart', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const add = await call(a, { method: 'POST', url: '/_sim/customers', as: null, body: {
      ...LATE, accounts: [{ iban: LATE_IBAN, balances: { EUR: '50.00' } }, { iban: LATE_IBAN2, opened: '2026-01-02', nickname: 'Savings' }],
    } })
    assert.equal(add.statusCode, 201, add.body)
    const patch = await call(a, { method: 'PATCH', url: `/_sim/customers/EE/${LATE.code}`, as: null, body: { payments: 'PENDING', directDebit: { agreement: true } } })
    assert.equal(patch.json().payments, 'PENDING')
    const pay = await call(a, { method: 'POST', url: '/payment', as: LATE.code, body: pain001([{ debtorIban: LATE_IBAN, debtorName: LATE.name, txs: [{ amount: '7.00', creditorIban: C2.iban }] }]) })
    assert.equal(pay.statusCode, 202, pay.body)
    const [[[sts, ref]]] = statuses(await drain(a, LATE.code))
    assert.equal(sts, 'PDNG')

    const b = await setup(opts)
    const late = (await call(b, { url: '/_sim/customers' })).json().customers.find((c: any) => c.code === LATE.code)
    assert.deepEqual([late.name, late.payments, late.directDebit, late.accounts.map((x: any) => [x.iban, x.balances.EUR?.available])],
      [LATE.name, 'PENDING', { agreement: true, debtorNotification: false }, [[LATE_IBAN, '50.00'], [LATE_IBAN2, undefined]]])
    assert.deepEqual(await b.emulator.directory.account(LATE_IBAN2), { opened: '2026-01-02', nickname: 'Savings' })
    assert.equal((await call(b, { url: `/_sim/accounts/${LATE_IBAN}` })).json().owner.code, LATE.code)
    // The certificate still resolves to the customer; a new payment still waits for SCA.
    assert.equal((await call(b, { url: '/heartbeat', as: LATE.code })).statusCode, 200)
    const list = (await call(b, { url: '/_sim/payments/pending' })).json().payments
    assert.deepEqual(list.map((p: any) => [p.ref, p.kind, p.customer.code]), [[ref, 'SCA', LATE.code]])
    assert.equal((await call(b, { method: 'POST', url: '/_sim/payments/pending/approve', as: null, body: { refs: [ref] } })).statusCode, 200)
    assert.deepEqual(statuses(await drain(b, LATE.code)), [[['ACSC', ref]]])
    assert.equal((await call(b, { url: `/_sim/accounts/${LATE_IBAN}` })).json().balances.EUR.available, '43.00')
    // A second /_sim add of the same customer is still a conflict.
    assert.equal((await call(b, { method: 'POST', url: '/_sim/customers', as: null, body: LATE })).statusCode, 409)
  })

  test('the seed does not overwrite a stored customer; two emulators on one namespace share the directory', async () => {
    const opts = await postgresStore()
    const a = await setup(opts)
    const b = await setup(opts)
    // b was started after a: it kept a's seed customers, their accounts once, no duplicate.
    assert.equal((await b.emulator.directory.all()).filter((c) => c.code === C1.code).length, 1)
    assert.equal((await call(a, { method: 'PATCH', url: `/_sim/customers/EE/${C1.code}`, as: null, body: { payments: 'PENDING' } })).statusCode, 200)
    assert.equal((await b.emulator.directory.get(C1))!.payments, 'PENDING', 'no cache: b sees a\'s switch at once')
    assert.equal((await call(a, { method: 'POST', url: '/_sim/customers', as: null, body: { ...LATE, accounts: [LATE_IBAN] } })).statusCode, 201)
    assert.equal((await call(b, { method: 'POST', url: '/_sim/customers', as: null, body: LATE })).statusCode, 409)
    // A restart with the same seed (which says DIRECT) keeps the switch.
    const c = await setup(opts)
    const view = (await call(c, { url: '/_sim/customers' })).json().customers.find((x: any) => x.code === C1.code)
    assert.equal(view.payments, 'PENDING')
    assert.deepEqual(view.accounts.map((x: any) => x.iban), (await a.emulator.directory.get(C1))!.accounts)
  })

  test('PgDirectory: namespaces apart, an account of another customer refused across emulators, a failed add leaves nothing', async () => {
    const db = await pgDb()
    const clock = new ManualClock('2026-03-10T08:00:00Z')
    const ns = randomUUID()
    const one = new PgDirectory(db, clock, { namespace: ns })
    const two = new PgDirectory(db, clock, { namespace: ns })
    const other = new PgDirectory(db, clock)
    await one.add({ code: '1', country: 'ee', name: 'One', accounts: [LATE_IBAN] })
    assert.equal((await two.ownerOf(LATE_IBAN.toLowerCase()))?.code, '1')
    assert.equal(await other.ownerOf(LATE_IBAN), undefined)
    assert.deepEqual(await other.all(), [])
    await assert.rejects(two.add({ code: '2', country: 'EE', name: 'Two', accounts: [LATE_IBAN2, LATE_IBAN] }), /already belongs to EE:1/)
    assert.equal(await one.get({ code: '2', country: 'EE' }), undefined)
    assert.equal(await one.ownerOf(LATE_IBAN2), undefined)
    // Both racing for one account: exactly one wins.
    const race = await Promise.allSettled([one.add({ code: '3', country: 'EE', name: 'Three', accounts: [LATE_IBAN2] }), two.add({ code: '4', country: 'EE', name: 'Four', accounts: [LATE_IBAN2] })])
    assert.deepEqual(race.map((r) => r.status).sort(), ['fulfilled', 'rejected'])
    // ifAbsent keeps the stored; a replace keeps the place and releases unlisted accounts.
    assert.equal((await one.add({ code: '1', country: 'EE', name: 'Changed' }, { ifAbsent: true })).name, 'One')
    await one.add({ code: '1', country: 'EE', name: 'Replaced' })
    assert.equal((await two.all())[0].name, 'Replaced')
    assert.equal(await two.ownerOf(LATE_IBAN), undefined)
    assert.deepEqual((await two.update({ code: '1', country: 'ee' }, { connected: [{ code: '3', country: 'EE' }] }))?.connected, [{ code: '3', country: 'EE' }])
    assert.equal(await two.update({ code: '9', country: 'EE' }, { name: 'x' }), undefined)
  })
})
