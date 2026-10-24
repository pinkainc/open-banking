// An emulator whose ledger is an OpenLedgerLedger on a real open-ledger server (decision
// 927): payments end to end, the money moved in open-ledger. Not a *.test.ts, so `npm test`
// does not run it; scripts/check.sh runs it with OPEN_LEDGER_TESTS=1 when open-ledger is
// there (server/test/open-ledger-server.ts starts it).
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, test } from 'node:test'
import { OpenLedgerLedger, OpenLedgerError, encodeHandle } from '../src/ledgers/open-ledger.js'
import { C1, C2, DE_IBAN, balance, call, drain, pain001, setup } from './helpers.js'
import { openLedgerUrl } from './open-ledger-server.js'

const ledger = async () => new OpenLedgerLedger({ url: await openLedgerUrl(), namespace: randomUUID() })

describe('emulator on open-ledger', () => {
  test('pain.001 to a customer of the bank: pain.002 ACSC, camt.054 to both, money moved in open-ledger', async () => {
    const l = await ledger()
    const ctx = await setup({ ledger: l })
    const before = await l.balances(C1.iban)
    const res = await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '10.50', creditorIban: C2.iban }] }]) })
    assert.equal(res.statusCode, 202, res.body)
    const types = (await drain(ctx)).map((m) => m.type)
    assert.ok(types.includes('PAYMENT') && types.includes('CREDIT_DEBIT_NOTIFICATION'), types.join())
    assert.deepEqual((await drain(ctx, C2.code)).map((m) => m.type), ['CREDIT_DEBIT_NOTIFICATION'])
    assert.equal((await l.balances(C1.iban)).EUR.balance, before.EUR.balance - 1050n)
    assert.equal(await balance(ctx, C2.iban), '110.50')
  })

  test('pain.001 abroad: reserved, settled by the rails, booked to the settlement account; a rejection releases', async () => {
    const l = await ledger()
    const ctx = await setup({ ledger: l })
    const res = await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '25.00', creditorIban: DE_IBAN }] }]) })
    assert.equal(res.statusCode, 202, res.body)
    const msgs = await drain(ctx)
    assert.ok(msgs.some((m) => m.type === 'CREDIT_DEBIT_NOTIFICATION'), msgs.map((m) => m.type).join())
    assert.equal(await balance(ctx, C1.iban), '9975.00')
    assert.equal((await l.balances(C1.iban)).EUR.available, 997500n, 'nothing left reserved')
    const settlement = (await l.postings()).filter((p) => p.account.startsWith('@settlement'))
    assert.deepEqual(settlement.map((p) => p.amount), [2500n], 'the debit went to the scheme settlement account')

    await call(ctx, { method: 'POST', url: '/_sim/rails/reject', body: { account: DE_IBAN, reason: 'Account closed.' } })
    assert.equal((await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '5.00', creditorIban: DE_IBAN }] }]) })).statusCode, 202)
    await drain(ctx)
    assert.deepEqual((await l.balances(C1.iban)).EUR, { balance: 997500n, available: 997500n }, 'released')
  })

  test('another key cannot use the ledger', async () => {
    const namespace = randomUUID()
    const url = await openLedgerUrl()
    const mine = new OpenLedgerLedger({ url, namespace })
    await mine.transfer({ ref: 'f', from: '@funding', to: 'A', amount: 100n, currency: 'EUR' })
    const other = new OpenLedgerLedger({ url, namespace })
    await assert.rejects(other.transfer({ ref: 'g', from: 'A', to: 'B', amount: 1n, currency: 'EUR' }), (e) => e instanceof OpenLedgerError && e.status === 403)
    assert.equal(await mine.available('A', 'EUR'), 100n)
  })
})

test('account names map to distinct handles', () => {
  assert.equal(encodeHandle('@settlement:SEPA'), '_40settlement_3aSEPA')
  assert.equal(encodeHandle('EE337700771001260958'), 'EE337700771001260958')
  assert.notEqual(encodeHandle('a_40'), encodeHandle('a@'))
  assert.equal(encodeHandle('Õ'), '_c3_95')
})
