// Account balances: POST /account-balance (camt.060.001.05 / .03) answered in the inbox
// with camt.052.001.08 / .06: intraday (ITBD, ITAV), PAYMENT_LIMITS and, in .08 only,
// END_OF_DAY_BALANCE. Every camt.052.001.08 is validated against the published XSD
// when available (camt.052.001.06 has none: structural checks).
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { DAY_MS } from '../src/clock.js'
import { many, text } from '../src/xml.js'
import { C2, SP, call, camt060, drain, pain001, report, reportError, schemaValid, setup, type Ctx, type ReportReq } from './helpers.js'

let ctx: Ctx
beforeEach(async () => { ctx = await setup() })

async function balance(o: ReportReq = {}, opts: { as?: string; headers?: Record<string, string> } = {}) {
  const r = await report(ctx, { ...o, kind: 'balance' }, opts)
  assert.equal(r.msgs.length, 1)
  const m = r.msgs[0]
  assert.equal(m.type, 'ACCOUNT_BALANCE')
  assert.equal(m.requestId, r.id)
  if (!m.doc.Errors) await schemaValid(m.body)
  return m
}

/** Per currency: the balances as "CODE amount" (DBIT amounts negative). */
function rpt(m: { doc: any }) {
  const r = m.doc.Document.BkToCstmrAcctRpt
  return {
    created: String(r.GrpHdr.CreDtTm),
    blocks: many<any>(r.Rpt).map((x) => ({
      ccy: String(x.Acct.Ccy), from: String(x.FrToDt.FrDtTm), to: String(x.FrToDt.ToDtTm),
      bal: many<any>(x.Bal).map((b) => `${b.Tp.CdOrPrtry.Cd ?? b.Tp.CdOrPrtry.Prtry} ${b.CdtDbtInd === 'DBIT' ? '-' : ''}${text(b.Amt)}`),
      dates: [...new Set(many<any>(x.Bal).map((b) => String(b.Dt.Dt)))],
      entries: x.Ntry,
    })),
  }
}

const LIMITS = (dailyFree = '10000.00', monthlyFree = '100000.00') => [
  'PAYMENT_LIMIT_MONTHLY_TOTAL 100000.00', `PAYMENT_LIMIT_MONTHLY_FREE ${monthlyFree}`,
  'PAYMENT_LIMIT_DAILY_TOTAL 10000.00', `PAYMENT_LIMIT_DAILY_FREE ${dailyFree}`, 'PAYMENT_LIMIT_INSTANT 15000.00',
]

describe('POST /account-balance (camt.052.001.08)', () => {
  test('202, then ACCOUNT_BALANCE: intraday ITBD and ITAV per currency, EUR first, at the moment of the answer', async () => {
    const res = await call(ctx, { method: 'POST', url: '/account-balance', body: camt060({ kind: 'balance' }) })
    assert.equal(res.statusCode, 202)
    assert.match(res.headers['message-request-id'] as string, /^REQ[0-9a-f]{32}$/)
    await drain(ctx)
    const r = rpt(await balance())
    assert.deepEqual(r.blocks.map((b) => [b.ccy, ...b.bal]), [
      ['EUR', 'ITBD 10000.00', 'ITAV 10000.00'], ['GBP', 'ITBD 500.00', 'ITAV 500.00'], ['USD', 'ITBD 500.00', 'ITAV 500.00']])
    assert.equal(r.created, '2026-03-10T10:00:00.000+02:00')
    assert.equal(r.blocks[0].from, '2026-03-10T10:00:00.000+02:00')
    assert.equal(r.blocks[0].to, r.blocks[0].from)
    assert.deepEqual(r.blocks[0].dates, ['2026-03-10'])
    assert.equal(r.blocks[0].entries, undefined)
  })

  test('DATE, DATETIME or any other Prtry: intraday; FrToDt is ignored', async () => {
    for (const prtry of ['DATE', 'DATETIME', 'SOMETHING']) {
      const r = rpt(await balance({ prtry, frDt: '2026-01-01', toDt: '2026-01-02' }))
      assert.deepEqual(r.blocks[0].bal, ['ITBD 10000.00', 'ITAV 10000.00'], prtry)
      assert.deepEqual(r.blocks[0].dates, ['2026-03-10'])
    }
    // RptgPrd may be left out for intraday balances.
    assert.deepEqual(rpt(await balance({ frDt: null })).blocks[0].bal, ['ITBD 10000.00', 'ITAV 10000.00'])
  })

  test('balances follow payments in real time', async () => {
    await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '12.34' }] }]) })
    await drain(ctx)
    assert.deepEqual(rpt(await balance()).blocks[0].bal, ['ITBD 9987.66', 'ITAV 9987.66'])
    assert.deepEqual(rpt(await balance({ iban: C2.iban }, { as: C2.code })).blocks[0].bal, ['ITBD 112.34', 'ITAV 112.34'])
  })

  test('an account without any balance: one EUR block at 0.00', async () => {
    await call(ctx, { method: 'POST', url: '/_sim/customers', body: { code: '55550001', country: 'EE', name: 'Empty', accounts: ['EE047700771001260929'] } })
    const r = rpt(await balance({ iban: 'EE047700771001260929' }, { as: '55550001' }))
    assert.deepEqual(r.blocks.map((b) => [b.ccy, ...b.bal]), [['EUR', 'ITBD 0.00', 'ITAV 0.00']])
  })

  describe('PAYMENT_LIMITS', () => {
    test('the documented limits on the EUR block, reported as CRDT; other currencies balances only', async () => {
      const r = rpt(await balance({ prtry: 'PAYMENT_LIMITS' }))
      assert.deepEqual(r.blocks[0].bal, ['ITBD 10000.00', 'ITAV 10000.00', ...LIMITS()])
      assert.deepEqual(r.blocks.slice(1).map((b) => b.bal.length), [2, 2])
    })

    test('free limits shrink with today’s and this month’s EUR debits', async () => {
      await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '100.00' }] }]) })
      ctx.clock.advance(DAY_MS)
      await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '25.50' }, { amount: '5.00', currency: 'USD' }] }]) })
      await drain(ctx)
      const r = rpt(await balance({ prtry: 'PAYMENT_LIMITS' }))
      assert.deepEqual(r.blocks[0].bal.slice(2), LIMITS('9974.50', '99874.50'))
      // A new month starts afresh.
      ctx.clock.set('2026-04-01T09:00:00Z')
      assert.deepEqual(rpt(await balance({ prtry: 'PAYMENT_LIMITS' })).blocks[0].bal.slice(2), LIMITS())
    })

    test('limits set through /_sim/reports; a free limit never goes below zero', async () => {
      const put = await call(ctx, { method: 'PUT', url: '/_sim/reports/EE/12340001', body: { limits: { daily: '50.00', instant: '20.00' } } })
      assert.equal(put.json().limits.daily, '50.00')
      await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '60.00' }] }]) })
      await drain(ctx)
      const bal = rpt(await balance({ prtry: 'PAYMENT_LIMITS' })).blocks[0].bal
      assert.deepEqual(bal.slice(2), ['PAYMENT_LIMIT_MONTHLY_TOTAL 100000.00', 'PAYMENT_LIMIT_MONTHLY_FREE 99940.00',
        'PAYMENT_LIMIT_DAILY_TOTAL 50.00', 'PAYMENT_LIMIT_DAILY_FREE 0.00', 'PAYMENT_LIMIT_INSTANT 20.00'])
    })

    test('an account without EUR still reports the limits in a EUR block', async () => {
      await call(ctx, { method: 'POST', url: '/_sim/customers', body: { code: '55550002', country: 'EE', name: 'Dollars', accounts: [{ iban: 'EE047700771001260929', balances: { USD: '7.00' } }] } })
      const r = rpt(await balance({ iban: 'EE047700771001260929', prtry: 'PAYMENT_LIMITS' }, { as: '55550002' }))
      assert.deepEqual(r.blocks.map((b) => [b.ccy, b.bal.length]), [['EUR', 7], ['USD', 2]])
      assert.deepEqual(r.blocks[0].bal.slice(0, 2), ['ITBD 0.00', 'ITAV 0.00'])
    })
  })

  describe('END_OF_DAY_BALANCE', () => {
    test('CLBD per currency at the end of a past Tallinn day', async () => {
      ctx.clock.advance(DAY_MS)
      await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '1.00' }] }]) }) // the next day
      await drain(ctx)
      const r = rpt(await balance({ prtry: 'END_OF_DAY_BALANCE', frDt: '2026-03-10', toDt: '2026-03-10' }))
      assert.deepEqual(r.blocks.map((b) => [b.ccy, ...b.bal]), [['EUR', 'CLBD 10000.00'], ['GBP', 'CLBD 500.00'], ['USD', 'CLBD 500.00']])
      assert.equal(r.blocks[0].from, '2026-03-10T23:59:59.999+02:00')
      assert.equal(r.blocks[0].to, '2026-03-10T23:59:59.999+02:00')
      assert.deepEqual(r.blocks[0].dates, ['2026-03-10'])
      assert.equal(r.created, '2026-03-11T10:00:00.000+02:00')
    })

    test('a day before the account had money: one EUR block at 0.00', async () => {
      const r = rpt(await balance({ prtry: 'END_OF_DAY_BALANCE', frDt: '2026-03-09' }))
      assert.deepEqual(r.blocks.map((b) => [b.ccy, ...b.bal]), [['EUR', 'CLBD 0.00']])
    })

    test('a summer day ends at 23:59:59.999+03:00', async () => {
      ctx.clock.set('2026-07-02T09:00:00Z')
      const r = rpt(await balance({ prtry: 'END_OF_DAY_BALANCE', frDt: '2026-07-01' }))
      assert.equal(r.blocks[0].from, '2026-07-01T23:59:59.999+03:00')
    })

    test('FrDt today or later: From date cannot be in the future; no RptgPrd: From date is required', async () => {
      const period = (d: string) => ({ code: 'errStatement_PeriodInvalid', description: d, field: undefined })
      assert.deepEqual(reportError(await balance({ prtry: 'END_OF_DAY_BALANCE', frDt: '2026-03-10' })), period('From date cannot be in the future.'))
      assert.deepEqual(reportError(await balance({ prtry: 'END_OF_DAY_BALANCE', frDt: '2026-03-11' })), period('From date cannot be in the future.'))
      assert.deepEqual(reportError(await balance({ prtry: 'END_OF_DAY_BALANCE', frDt: null })), period('From date is required.'))
    })
  })

  describe('errors (an <Errors> message of type ACCOUNT_BALANCE)', () => {
    test('foreign and unknown accounts: errStatement_NoAccess', async () => {
      for (const iban of [C2.iban, 'EE057700771009999999']) {
        assert.deepEqual(reportError(await balance({ iban })), { code: 'errStatement_NoAccess', description: 'No access to the account.', field: undefined })
      }
    })
    test('duplicate MsgId', async () => {
      await balance({ msgId: 'BAL-DUP' })
      assert.equal(reportError(await balance({ msgId: 'BAL-DUP' }))!.code, 'errStatement_DuplicateRequest')
    })
    test('a statement ReqdMsgNmId on the balance endpoint: RequestInvalid, Field ReqdMsgNmId', async () => {
      assert.deepEqual(reportError(await balance({ reqd: 'camt.053.001.08' })),
        { code: 'errStatement_RequestInvalid', description: 'Request message fails xsd validation.', field: 'ReqdMsgNmId' })
      assert.equal(reportError(await balance({ version: '03', reqd: 'camt.052.001.08' }))!.field, 'ReqdMsgNmId')
    })
    test('an unexpected failure: errStatement_TechnicalError', async () => {
      ctx.emulator.ledger.balances = async () => { throw new Error('ledger down') }
      assert.deepEqual(reportError(await balance()), { code: 'errStatement_TechnicalError', description: 'Technical error', field: undefined })
    })
    test('not XML: RequestInvalid', async () => {
      const r = await report(ctx, '<Document>', { kind: 'balance' })
      assert.equal(r.msgs[0].type, 'ACCOUNT_BALANCE')
      assert.equal(reportError(r.msgs[0])!.code, 'errStatement_RequestInvalid')
    })
  })

  test('a service provider with Client-Code / Client-Country', async () => {
    const headers = { 'Client-Code': C2.code, 'Client-Country': 'EE' }
    const m = await balance({ iban: C2.iban }, { as: SP.code, headers })
    assert.deepEqual(rpt(m).blocks[0].bal, ['ITBD 100.00', 'ITAV 100.00'])
    // Its own account without the headers.
    assert.deepEqual(rpt(await balance({ iban: SP.iban }, { as: SP.code, headers: { 'Client-Code': SP.code, 'Client-Country': 'EE' } })).blocks[0].bal, ['ITBD 1000.00', 'ITAV 1000.00'])
  })
})

describe('camt.052.001.06 (answer to camt.060.001.03)', () => {
  test('local date-times with microseconds, intraday balances', async () => {
    const m = await balance({ version: '03' })
    assert.match(m.body, /xmlns="urn:iso:std:iso:20022:tech:xsd:camt\.052\.001\.06"/)
    const r = rpt(m)
    assert.equal(r.created, '2026-03-10T10:00:00.000000')
    assert.equal(r.blocks[0].from, '2026-03-10T10:00:00.000000')
    assert.deepEqual(r.blocks.map((b) => b.ccy), ['EUR', 'GBP', 'USD'])
    assert.deepEqual(r.blocks[0].bal, ['ITBD 10000.00', 'ITAV 10000.00'])
  })

  test('payment limits are reported as DBIT', async () => {
    const r = rpt(await balance({ version: '03', prtry: 'PAYMENT_LIMITS' }))
    assert.deepEqual(r.blocks[0].bal.slice(2), LIMITS().map((l) => l.replace(' ', ' -')))
  })

  test('END_OF_DAY_BALANCE does not exist in .03: answered as intraday', async () => {
    const r = rpt(await balance({ version: '03', prtry: 'END_OF_DAY_BALANCE', frDt: '2026-03-09' }))
    assert.deepEqual(r.blocks[0].bal, ['ITBD 10000.00', 'ITAV 10000.00'])
  })
})
