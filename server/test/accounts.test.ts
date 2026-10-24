// S5, the LHV UK account reports in JSON (decisions 705–713): GET /accounts/list, GET
// /accounts/{acc}/transactions/{ref}, GET /accounts/{acc}/payments, their error bodies
// (bare JSON strings, the AWS-gateway {"Message"}), the UK host only, and the
// /_sim/accounts held incoming payments. Every JSON answer is checked with ajv against
// ssot/json-schemas; the G samples are replayed against the same schemas.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, test } from 'node:test'
import { DAY_MS } from '../src/clock.js'
import { makeIban } from '../src/iban.js'
import { ACCESS_DENIED, NO_TRANSACTION, transactionId } from '../src/accounts/service.js'
import { AWS_DENY } from '../src/accounts/routes.js'
import { MIRROR_DIR, call, drain, jsonValid, pain001, seed, setup, type Ctx } from './helpers.js'

const G = 'docs/gitbook/connect/services/account-reports'
/** The ```json blocks of a G account-reports page, parsed. */
function gJson(page: string): unknown[] {
  const p = join(MIRROR_DIR, G, page)
  if (!existsSync(p)) return []
  return [...readFileSync(p, 'utf8').matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]))
}

const A = makeIban('GB', 'LHVB04031400001234')
const B = makeIban('GB', 'LHVB04031400004321')
const C = makeIban('GB', 'LHVB04030700012345')
const EE_OWN = makeIban('EE', '7700771001260970')
const U1 = { code: '09876543', country: 'GB', name: 'Connect Demo Customer 1' }
const U2 = { code: '09876544', country: 'GB', name: 'Katie Bell' }
const bban = (iban: string) => iban.slice(8)

let ctx: Ctx
beforeEach(async () => {
  const s = seed()
  s.customers.push(
    { ...U1, accounts: [
      { iban: A, balances: { GBP: '1000.00' }, nickname: 'Main Operating Account', opened: '2024-06-20', viban: true },
      { iban: B, opened: '2024-04-01', closed: true },
      EE_OWN,
    ] },
    { ...U2, accounts: [{ iban: C, balances: { GBP: '500.00' } }] },
  )
  ctx = await setup({}, s, { flavour: 'UK' })
})

const get = (url: string, as: string | null = U1.code, headers: Record<string, string> = {}) => call(ctx, { url, as, headers })
async function ok(url: string, schema: string, as = U1.code) {
  const r = await get(url, as)
  assert.equal(r.statusCode, 200, `${url}: ${r.body}`)
  assert.match(String(r.headers['content-type']), /^application\/json/)
  assert.equal(r.headers['x-bank-code'], 'LHVUK')
  return jsonValid(schema, r.body)
}
async function fails(url: string, status: number, as: string | null = U1.code) {
  const r = await get(url, as)
  assert.equal(r.statusCode, status, `${url}: ${r.body}`)
  assert.match(String(r.headers['content-type']), /^application\/json/)
  return JSON.parse(r.body)
}

/** An internal GBP payment from U1's account A; returns the debtor's servicer reference. */
async function pay(creditorIban: string, amount: string, creditorName = 'Katie Bell') {
  const body = pain001([{ debtorIban: A, debtorName: U1.name, txs: [{ amount, currency: 'GBP', creditorIban, creditorName, endToEndId: `E2E-${amount}` }] }])
  const r = await call(ctx, { method: 'POST', url: '/payment', as: U1.code, body })
  assert.equal(r.statusCode, 202, r.body)
  const e = ctx.emulator.journal.entries(A, 0, Infinity).filter((x) => x.endToEndId === `E2E-${amount}`)
  return e.length ? e[0].servicerRef : ctx.emulator.engine.parked().find((p) => p.endToEndId === `E2E-${amount}`)!.ref
}

function addViban(master: string, status: 'ACTIVE' | 'CLOSED', name: string) {
  const reg = ctx.emulator.viban.registry
  return reg.add({
    iban: reg.generate(master), master, owner: { code: U1.code, country: 'GB' }, status, createdAt: ctx.clock.now(),
    user: { company: { Name: name } as never, address: { Country: 'GB', StreetNo: '1 High Street', CityCounty: 'London' } },
  }).iban
}

describe('G samples', () => {
  test('the published 200 bodies fit the schemas', () => {
    const list = gJson('get-list-of-accounts.md')
    const tx = gJson('get-transaction-by-reference.md')
    const pay = gJson('get-list-of-pending-and-rejected-transactions.md')
    if (!list.length) return
    jsonValid('accounts-list.response', list[0])
    assert.deepEqual(list[1], AWS_DENY)
    jsonValid('accounts-transaction.response', tx[0])
    assert.deepEqual(tx.slice(1), [NO_TRANSACTION, ACCESS_DENIED])
    jsonValid('accounts-payments.response', pay[0])
    jsonValid('accounts-payments.response', pay[1])
  })
})

describe('GET /accounts/list', () => {
  test('the UK current accounts in the G shape: IBAN and sort code, LHVBGB2L, closed ones Deleted, EE accounts left out', async () => {
    const body = await ok('/accounts/list?pageNumber=1', 'accounts-list.response')
    assert.deepEqual(body, {
      Data: { Account: [
        { Status: 'Enabled', Currency: 'GBP', Nickname: 'Main Operating Account', OpeningDate: '2024-06-20',
          Account: [{ SchemeName: 'IBAN', Identification: A, Name: U1.name }, { SchemeName: 'SortCodeAccountNumber', Identification: bban(A), Name: U1.name }],
          Servicer: { SchemeName: 'BICFI', Identification: 'LHVBGB2L' } },
        { Status: 'Deleted', Currency: 'GBP', OpeningDate: '2024-04-01',
          Account: [{ SchemeName: 'IBAN', Identification: B, Name: U1.name }, { SchemeName: 'SortCodeAccountNumber', Identification: bban(B), Name: U1.name }],
          Servicer: { SchemeName: 'BICFI', Identification: 'LHVBGB2L' } },
      ] },
      Links: {}, Meta: {},
    })
    // The G sample has the same keys, in the same order.
    const g = gJson('get-list-of-accounts.md')[0] as any
    if (g) assert.deepEqual(Object.keys(body.Data.Account[0]), Object.keys(g.Data.Account[1]))
    // Opening day defaults to the day the account was added (UK date).
    const c = await ok('/accounts/list?pageNumber=1', 'accounts-list.response', U2.code)
    assert.equal(c.Data.Account[0].OpeningDate, '2026-03-10')
    assert.equal(c.Data.Account[0].Nickname, undefined)
  })

  test('includeClosedAccounts, pages, and the parameter errors as bare JSON strings', async () => {
    const ibans = async (q: string) => (await ok(`/accounts/list?${q}`, 'accounts-list.response')).Data.Account.map((a: any) => a.Account[0].Identification)
    assert.deepEqual(await ibans('pageNumber=1&includeClosedAccounts=false'), [A])
    assert.deepEqual(await ibans('pageNumber=1&includeClosedAccounts=TRUE'), [A, B])
    assert.deepEqual(await ibans('pageNumber=2&pageSize=1'), [B])
    assert.deepEqual(await ibans('pageNumber=3&pageSize=1'), [])
    assert.deepEqual(await ibans('pageNumber=1&pageSize=500'), [A, B])
    assert.equal(await fails('/accounts/list', 400), 'pageNumber is required')
    for (const q of ['pageNumber=0', 'pageNumber=x', 'pageNumber=1&pageSize=0', 'pageNumber=1&includeClosedAccounts=yes']) {
      assert.equal(typeof await fails(`/accounts/list?${q}`, 400), 'string', q)
    }
  })

  test('a customer with no UK accounts gets an empty list; a failed identity check is the AWS-style 403', async () => {
    assert.deepEqual((await ok('/accounts/list?pageNumber=1', 'accounts-list.response', '12340001')).Data.Account, [])
    assert.deepEqual(await fails('/accounts/list?pageNumber=1', 403, null), AWS_DENY)
    assert.deepEqual(await fails('/accounts/list?pageNumber=1', 403, '99999999'), AWS_DENY)
  })

  test('UK host only: 404 on the EE host and for LHV EE on the UK host', async () => {
    const ee = await setup()
    assert.equal((await call(ee, { url: '/accounts/list?pageNumber=1' })).statusCode, 404)
    const r = await get('/accounts/list?pageNumber=1', U1.code, { 'x-bank-code': 'LHVEE' })
    assert.equal(r.statusCode, 404)
  })
})

describe('GET /accounts/{acc}/transactions/{ref}', () => {
  test('a booked internal payment, seen by both sides, with or without hyphens', async () => {
    const ref = await pay(C, '1.00')
    const debit = await ok(`/accounts/${A}/transactions/${ref}`, 'accounts-transaction.response')
    assert.deepEqual(debit, {
      EndToEndId: 'E2E-1.00', IsVirtualAccountPayment: false, Amount: { Amount: '1.00', Currency: 'GBP' },
      CreditDebitIndicator: 'Debit', Status: 'Booked', BookingDateTime: '2026-03-10', ValueDateTime: '2026-03-10',
      CreditorAgent: { SchemeName: 'BIC', Identification: 'LHVBGB2LXXX' },
      CreditorAccount: { Identification: C, Name: 'Katie Bell' },
      TransactionId: transactionId(ref),
    })
    const g = gJson('get-transaction-by-reference.md')[0] as any
    if (g) assert.deepEqual(Object.keys(debit), Object.keys(g))
    assert.deepEqual(await ok(`/accounts/${A}/transactions/${transactionId(ref).toLowerCase()}`, 'accounts-transaction.response'), debit)
    const credit = ctx.emulator.journal.entries(C, 0, Infinity).at(-1)!
    const c = await ok(`/accounts/${C}/transactions/${credit.servicerRef}`, 'accounts-transaction.response', U2.code)
    assert.equal(c.CreditDebitIndicator, 'Credit')
    assert.deepEqual(c.DebtorAccount, { Identification: A, Name: U1.name })
    assert.deepEqual(c.DebtorAgent, { SchemeName: 'BIC', Identification: 'LHVBGB2LXXX' })
    assert.equal(c.CreditorAccount, undefined)
  })

  test('an incoming credit from another bank: its BIC, eight letters padded', async () => {
    const r = await call(ctx, { method: 'POST', url: '/_sim/incoming', as: null, body: { iban: A, amount: '25.50', currency: 'GBP', debtor: { name: 'Other Ltd', iban: 'DE89370400440532013000', bic: 'COBADEFF' }, endToEndId: 'IN-1' } })
    const ref = JSON.parse(r.body).accountServicerReference
    const t = await ok(`/accounts/${A}/transactions/${ref}`, 'accounts-transaction.response')
    assert.equal(t.CreditDebitIndicator, 'Credit')
    assert.deepEqual(t.DebtorAgent, { SchemeName: 'BIC', Identification: 'COBADEFFXXX' })
    assert.deepEqual(t.DebtorAccount, { Identification: 'DE89370400440532013000', Name: 'Other Ltd' })
  })

  test('a payment through a VIBAN: IsVirtualAccountPayment and the VIBAN', async () => {
    const v = addViban(A, 'ACTIVE', 'Viban Holder Ltd')
    const r = await call(ctx, { method: 'POST', url: '/_sim/incoming', as: null, body: { iban: v, amount: '3.00', currency: 'GBP' } })
    const t = await ok(`/accounts/${A}/transactions/${JSON.parse(r.body).accountServicerReference}`, 'accounts-transaction.response')
    assert.equal(t.IsVirtualAccountPayment, true)
    assert.deepEqual(t.VirtualAccount, { Identification: v, Name: 'Viban Holder Ltd' })
    // The VIBAN itself is no account for this service.
    assert.equal(await fails(`/accounts/${v}/transactions/${JSON.parse(r.body).accountServicerReference}`, 403), ACCESS_DENIED)
  })

  test('in manual review: Pending, no booking date', async () => {
    const ref = await pay(C, '2.00', 'Robba Bank')
    const t = await ok(`/accounts/${A}/transactions/${ref}`, 'accounts-transaction.response')
    assert.equal(t.Status, 'Pending')
    assert.equal(t.CreditDebitIndicator, 'Debit')
    assert.equal(t.BookingDateTime, undefined)
    assert.deepEqual(t.Amount, { Amount: '2.00', Currency: 'GBP' })
  })

  test('404 and 403 as the G bare strings', async () => {
    const ref = await pay(C, '1.00')
    assert.equal(await fails(`/accounts/${A}/transactions/${'0'.repeat(32)}`, 404), NO_TRANSACTION)
    assert.equal(await fails(`/accounts/${A}/transactions/not-a-ref`, 404), NO_TRANSACTION)
    assert.equal(await fails(`/accounts/${C}/transactions/${ref}`, 403), ACCESS_DENIED)
    assert.equal(await fails(`/accounts/${EE_OWN}/transactions/${ref}`, 403), ACCESS_DENIED)
    assert.deepEqual(await fails(`/accounts/${A}/transactions/${ref}`, 403, null), AWS_DENY)
    // The 14-day lookup window.
    ctx.clock.advance(14 * DAY_MS + 1000)
    assert.equal(await fails(`/accounts/${A}/transactions/${ref}`, 404), NO_TRANSACTION)
  })
})

describe('GET /accounts/{acc}/payments', () => {
  const list = (acc: string, q = '', as = U2.code) => ok(`/accounts/${acc}/payments${q}`, 'accounts-payments.response', as)

  test('an internal payment in manual review is Pending for its creditor; rejected, it is Rejected; approved, it is gone', async () => {
    assert.deepEqual(await list(C), { Data: { Transaction: [] }, Links: {}, Meta: { TotalElements: 0, Page: 0, PageSize: 20 } })
    const ref = await pay(C, '600.00', 'Robba Bank')
    const body = await list(C)
    assert.deepEqual(body, {
      Data: { Transaction: [{
        AccountId: C, Amount: { Amount: '600.00', Currency: 'GBP' }, CreditDebitIndicator: 'Credit', Status: 'Pending', ValueDateTime: '2026-03-10',
        CreditorAccount: { Identification: bban(C), Name: U2.name }, DebtorAccount: { Identification: bban(A), Name: U1.name },
        TransactionId: transactionId(ref),
      }] },
      Links: {}, Meta: { TotalElements: 1, Page: 0, PageSize: 20 },
    })
    const g = gJson('get-list-of-pending-and-rejected-transactions.md')[0] as any
    if (g) assert.deepEqual(Object.keys(body.Data.Transaction[0]), Object.keys(g.Data.Transaction[0]))
    // The sort code and account number name the same account.
    assert.deepEqual(await list(bban(C)), body)
    await call(ctx, { method: 'POST', url: '/_sim/payments/pending/reject', as: null, body: { refs: [ref] } })
    assert.equal((await list(C)).Data.Transaction[0].Status, 'Rejected')
    assert.deepEqual((await list(C, '?status=Pending')).Data.Transaction, [])
    assert.equal((await list(C, '?status=Rejected&status=Pending')).Data.Transaction.length, 1)
    const second = await pay(C, '7.00', 'Robba Bank')
    assert.equal((await list(C, '?status=Pending')).Data.Transaction.length, 1)
    await call(ctx, { method: 'POST', url: '/_sim/payments/pending/approve', as: null, body: { refs: [second] } })
    assert.deepEqual((await list(C, '?status=Pending')).Data.Transaction, [])
    assert.equal((await ok(`/accounts/${A}/transactions/${second}`, 'accounts-transaction.response')).Status, 'Booked')
  })

  test('a payment to a closed VIBAN is Rejected: listed under the VIBAN and its master account', async () => {
    const closed = addViban(A, 'CLOSED', 'Gone Ltd')
    const other = addViban(A, 'ACTIVE', 'Still Here Ltd')
    const r = await call(ctx, { method: 'POST', url: '/_sim/incoming', as: null, body: { iban: closed, amount: '9.99', currency: 'GBP', debtor: { name: 'Payer', iban: C } } })
    assert.equal(JSON.parse(r.body).returned, true)
    const viaViban = await list(closed, '', U1.code)
    assert.equal(viaViban.Data.Transaction.length, 1)
    assert.deepEqual(viaViban.Data.Transaction[0].CreditorAccount, { Identification: bban(closed), Name: 'Gone Ltd' })
    assert.equal(viaViban.Data.Transaction[0].AccountId, A)
    assert.equal(viaViban.Data.Transaction[0].Status, 'Rejected')
    assert.deepEqual((await list(A, '', U1.code)).Data.Transaction, viaViban.Data.Transaction)
    assert.deepEqual((await list(bban(closed), '', U1.code)).Data.Transaction, viaViban.Data.Transaction)
    assert.deepEqual((await list(other, '', U1.code)).Data.Transaction, [])
    // An internal payment to the closed VIBAN, too.
    const body = pain001([{ debtorIban: C, debtorName: U2.name, txs: [{ amount: '1.00', currency: 'GBP', creditorIban: closed, creditorName: 'Gone Ltd' }] }])
    assert.equal((await call(ctx, { method: 'POST', url: '/payment', as: U2.code, body })).statusCode, 202)
    assert.equal((await list(closed, '', U1.code)).Meta.TotalElements, 2)
  })

  test('held incoming payments (/_sim/accounts/incoming): Pending, then booked with the same reference or rejected', async () => {
    const hold = async (amount: string) => {
      const r = await call(ctx, { method: 'POST', url: '/_sim/accounts/incoming', as: null, body: { iban: C, amount, debtor: { name: 'Katie', iban: A } } })
      assert.equal(r.statusCode, 201, r.body)
      return JSON.parse(r.body).accountServicerReference as string
    }
    const one = await hold('10.00')
    const two = await hold('20.00')
    assert.equal((await list(C)).Meta.TotalElements, 2)
    assert.equal(JSON.parse((await call(ctx, { url: '/_sim/accounts/incoming', as: null })).body).incoming.length, 2)
    assert.equal(await drain(ctx, U2.code).then((m) => m.length), 0, 'nothing booked or notified while held')
    const booked = JSON.parse((await call(ctx, { method: 'POST', url: `/_sim/accounts/incoming/${one}/approve`, as: null })).body)
    assert.deepEqual(booked, { ref: one, status: 'Booked', accountServicerReference: one })
    assert.equal((await ok(`/accounts/${C}/transactions/${one}`, 'accounts-transaction.response', U2.code)).Status, 'Booked')
    assert.deepEqual((await drain(ctx, U2.code)).map((m) => m.type), ['CREDIT_DEBIT_NOTIFICATION'])
    await call(ctx, { method: 'POST', url: `/_sim/accounts/incoming/${two}/reject`, as: null })
    const left = await list(C)
    assert.deepEqual(left.Data.Transaction.map((t: any) => [t.TransactionId, t.Status]), [[transactionId(two), 'Rejected']])
    assert.equal((await call(ctx, { method: 'POST', url: `/_sim/accounts/incoming/${two}/approve`, as: null })).statusCode, 404)
  })

  test('dates (UK days, 14 days back by default), paging, and the 400s as bare JSON strings', async () => {
    const hold = (amount: string) => call(ctx, { method: 'POST', url: '/_sim/accounts/incoming', as: null, body: { iban: C, amount } })
    await hold('1.00')
    ctx.clock.advance(DAY_MS)
    await hold('2.00')
    await hold('3.00')
    assert.deepEqual((await list(C, '?size=2&page=1')).Data.Transaction.map((t: any) => t.Amount.Amount), ['3.00'])
    assert.deepEqual((await list(C, '?size=2&page=1')).Meta, { TotalElements: 3, Page: 1, PageSize: 2 })
    assert.deepEqual((await list(C, '?fromDate=2026-03-11')).Data.Transaction.map((t: any) => t.Amount.Amount), ['2.00', '3.00'])
    assert.deepEqual((await list(C, '?toDate=2026-03-10')).Data.Transaction.map((t: any) => t.Amount.Amount), ['1.00'])
    ctx.clock.advance(14 * DAY_MS - 60_000)
    assert.deepEqual((await list(C)).Data.Transaction.map((t: any) => t.Amount.Amount), ['2.00', '3.00'])
    assert.equal((await list(C, '?fromDate=2026-03-10')).Meta.TotalElements, 3)
    for (const q of ['status=Booked', 'fromDate=2026-02-30', 'toDate=10.03.2026', 'fromDate=2026-03-12&toDate=2026-03-11', 'page=-1', 'size=0', 'size=101', 'page=x']) {
      assert.equal(typeof await fails(`/accounts/${C}/payments?${q}`, 400, U2.code), 'string', q)
    }
  })

  test('another customer\'s, an EE or an unknown account: 403 bare string; no certificate: AWS-style 403', async () => {
    assert.equal(await fails(`/accounts/${A}/payments`, 403, U2.code), ACCESS_DENIED)
    assert.equal(await fails(`/accounts/${EE_OWN}/payments`, 403), ACCESS_DENIED)
    assert.equal(await fails('/accounts/04039999999999/payments', 403), ACCESS_DENIED)
    assert.deepEqual(await fails(`/accounts/${C}/payments`, 403, null), AWS_DENY)
  })
})
