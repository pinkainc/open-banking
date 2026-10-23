// Account statements: POST /account-statement (camt.060.001.05 / .03) answered in the
// inbox with camt.053.001.08 / .02 pages or an <Errors> document, and the automatic
// end-of-day statement. Every camt.053.001.08 produced is validated against the
// published XSD when it is available (camt.053.001.02 has none: structural checks).
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { DAY_MS } from '../src/clock.js'
import type { Booking } from '../src/payments/camt054.js'
import { fold1257 } from '../src/statements/codepage.js'
import { MAX_TRANSACTIONS, PAGE_SIZE } from '../src/statements/reports.js'
import { many, parseXml, text } from '../src/xml.js'
import {
  C1, C2, SP, call, camt060, drain, pain001, report, reportError, sample, schemaValid, setup, xsd, type Ctx, type ReportReq,
} from './helpers.js'

let ctx: Ctx
beforeEach(async () => { ctx = await setup() })

const TODAY = '2026-03-10' // the clock starts at 2026-03-10T10:00:00+02:00
type Msg = Awaited<ReturnType<typeof report>>['msgs'][number]

/** The parts of a camt.053 page the tests look at. */
function page(m: Msg | { doc: any }) {
  const s = m.doc.Document.BkToCstmrStmt
  return {
    pg: s.GrpHdr.MsgPgntn ? { nb: String(s.GrpHdr.MsgPgntn.PgNb), last: String(s.GrpHdr.MsgPgntn.LastPgInd) } : undefined,
    blocks: many<any>(s.Stmt).map((st) => {
      const bal = (code: string) => {
        const b = many<any>(st.Bal).find((x) => x.Tp.CdOrPrtry.Cd === code)
        const amt = text(b.Amt)!
        return { amt: b.CdtDbtInd === 'DBIT' && amt !== '0.00' ? `-${amt}` : amt, intm: b.Tp.SubTp?.Cd === 'INTM', dt: b.Dt.Dt ?? b.Dt.DtTm }
      }
      const entries = many<any>(st.Ntry)
      return {
        ccy: String(st.Acct.Ccy), from: String(st.FrToDt.FrDtTm), to: String(st.FrToDt.ToDtTm),
        open: bal('OPBD'), close: bal('CLBD'), n: entries.length, entries,
        cdt: String(st.TxsSummry.TtlCdtNtries.NbOfNtries), dbt: String(st.TxsSummry.TtlDbtNtries.NbOfNtries),
      }
    }),
  }
}

/** opening + entries = closing, per block. */
function reconciles(b: ReturnType<typeof page>['blocks'][number]) {
  let sum = Math.round(Number(b.open.amt) * 100)
  for (const e of b.entries) sum += (e.CdtDbtInd === 'CRDT' ? 1 : -1) * Math.round(Number(text(e.Amt)) * 100)
  assert.equal((sum / 100).toFixed(2), Number(b.close.amt).toFixed(2), `${b.ccy}: opening + entries = closing`)
}

async function statement(o: ReportReq = {}, opts: { as?: string; headers?: Record<string, string> } = {}) {
  const r = await report(ctx, { ...o, kind: 'statement' }, opts)
  for (const m of r.msgs) {
    assert.equal(m.type, 'ACCOUNT_STATEMENT')
    if (!m.doc.Errors) await schemaValid(m.body)
  }
  return r
}

let refN = 0
/** A booking straight into the journal (for volume and timing); the ledger is not touched. */
function book(o: { at?: number; amount?: string; ccy?: string; dir?: 'CRDT' | 'DBIT'; account?: string; remittance?: string } = {}) {
  const b: Booking = {
    account: o.account ?? C1.iban, owner: { name: 'Demo Customer 1', code: C1.code }, direction: o.dir ?? 'CRDT',
    amount: BigInt(Math.round(Number(o.amount ?? '1.00') * 100)), currency: o.ccy ?? 'EUR',
    servicerRef: `REF${String(++refN).padStart(29, '0')}`, scheme: 'SEPA', bookedAt: new Date(o.at ?? ctx.clock.now().getTime()),
    counterparty: { name: 'Counter Party', iban: C2.iban }, remittance: o.remittance,
  }
  return ctx.emulator.journal.record(b)
}

describe('POST /account-statement', () => {
  test('202 with Message-Request-Id; the camt.053.001.08 arrives as ACCOUNT_STATEMENT with the same id', async () => {
    const res = await call(ctx, { method: 'POST', url: '/account-statement', body: camt060() })
    assert.equal(res.statusCode, 202)
    assert.match(res.headers['message-request-id'] as string, /^REQ[0-9a-f]{32}$/)
    assert.equal(res.body, '')
    const [m] = await drain(ctx)
    assert.equal(m.type, 'ACCOUNT_STATEMENT')
    assert.equal(m.requestId, res.headers['message-request-id'])
    assert.match(m.body, /xmlns="urn:iso:std:iso:20022:tech:xsd:camt\.053\.001\.08"/)
    await schemaValid(m.body)
  })

  test('multi-currency: one Stmt per currency, EUR first; funding shows as credits', async () => {
    const { msgs } = await statement()
    assert.equal(msgs.length, 1)
    const p = page(msgs[0])
    assert.equal(p.pg, undefined)
    assert.deepEqual(p.blocks.map((b) => [b.ccy, b.open.amt, b.close.amt, b.n, b.cdt]),
      [['EUR', '0.00', '10000.00', 1, '1'], ['GBP', '0.00', '500.00', 1, '1'], ['USD', '0.00', '500.00', 1, '1']])
    // Today's period reaches into the future: it ends now (inclusive end = the current ms).
    assert.equal(p.blocks[0].from, '2026-03-10T00:00:00.000+02:00')
    assert.equal(p.blocks[0].to, '2026-03-10T10:00:00.000+02:00')
    assert.equal(p.blocks[0].open.dt, '2026-03-10T00:00:00.000+02:00')
    assert.equal(p.blocks[0].close.dt, '2026-03-10T10:00:00.000+02:00')
    const e = p.blocks[0].entries[0]
    assert.equal(e.CdtDbtInd, 'CRDT')
    assert.equal(e.ValDt.DtTm, '2026-03-10T10:00:00.000+02:00')
    assert.match(String(e.AcctSvcrRef), /^[0-9A-F]{32}$/)
  })

  test('missing ToDt means today; a ToDt in the future is capped at now', async () => {
    const a = page((await statement({ frDt: TODAY })).msgs[0])
    const b = page((await statement({ frDt: TODAY, toDt: '2026-12-31' })).msgs[0])
    assert.equal(a.blocks[0].to, '2026-03-10T10:00:00.000+02:00')
    assert.equal(b.blocks[0].to, '2026-03-10T10:00:00.000+02:00')
  })

  test('a date range: entries of those days only, opening = balance before, full-day dates', async () => {
    ctx.clock.advance(DAY_MS) // 2026-03-11 10:00
    book({ amount: '10.00' })
    ctx.clock.advance(DAY_MS) // 2026-03-12
    book({ amount: '2.50', dir: 'DBIT' })
    ctx.clock.advance(DAY_MS) // 2026-03-13
    book({ amount: '99.00' })
    const p = page((await statement({ frDt: '2026-03-11', toDt: '2026-03-12' })).msgs[0])
    const eur = p.blocks.find((b) => b.ccy === 'EUR')!
    assert.deepEqual([eur.open.amt, eur.close.amt, eur.n, eur.cdt, eur.dbt], ['10000.00', '10007.50', 2, '1', '1'])
    assert.equal(eur.from, '2026-03-11T00:00:00.000+02:00')
    assert.equal(eur.to, '2026-03-12T23:59:59.999+02:00')
    assert.equal(eur.open.dt, '2026-03-11')
    assert.equal(eur.close.dt, '2026-03-12')
    reconciles(eur)
    // v08 reports every currency with history, also without entries in the period.
    assert.deepEqual(p.blocks.map((b) => [b.ccy, b.open.amt, b.close.amt, b.n]).slice(1), [['GBP', '500.00', '500.00', 0], ['USD', '500.00', '500.00', 0]])
  })

  test('daylight saving: a summer day is reported with +03:00', async () => {
    ctx.clock.set('2026-07-01T12:00:00Z')
    book({ at: Date.parse('2026-06-15T09:00:00Z') })
    const p = page((await statement({ frDt: '2026-06-15', toDt: '2026-06-15' })).msgs[0])
    assert.equal(p.blocks[0].from, '2026-06-15T00:00:00.000+03:00')
    assert.equal(p.blocks[0].to, '2026-06-15T23:59:59.999+03:00')
    assert.equal(p.blocks[0].entries[0].ValDt.DtTm, '2026-06-15T12:00:00.000+03:00')
  })

  test('empty period: an account without history gets one EUR block at 0.00', async () => {
    const p = page((await statement({ frDt: '2026-03-01', toDt: '2026-03-09' })).msgs[0])
    assert.deepEqual(p.blocks.map((b) => [b.ccy, b.open.amt, b.close.amt, b.n, b.cdt, b.dbt]), [['EUR', '0.00', '0.00', 0, '0', '0']])
  })

  test('DATETIME: FrTm/ToTm with offsets, ToTm exclusive, inclusive end reported', async () => {
    const before = page((await statement({ prtry: 'DATETIME', frTm: '09:00:00+02:00', toTm: '10:00:00+02:00' })).msgs[0])
    assert.equal(before.blocks[0].to, '2026-03-10T09:59:59.999+02:00')
    // Nothing booked before 10:00: no currency has history yet, so one EUR block.
    assert.deepEqual(before.blocks.map((b) => [b.ccy, b.n]), [['EUR', 0]])
    const at = page((await statement({ prtry: 'DATETIME', frTm: '10:00:00', toTm: '10:00:01' })).msgs[0])
    assert.deepEqual(at.blocks.map((b) => b.n), [1, 1, 1])
    // ToTm 10:00:01 is still in the future: the period ends now.
    assert.equal(at.blocks[0].close.dt, '2026-03-10T10:00:00.000+02:00')
    // A UTC time: 08:00Z is 10:00 in Tallinn.
    const utc = page((await statement({ prtry: 'DATETIME', frTm: '08:00:00Z', toTm: '08:00:01Z' })).msgs[0])
    assert.deepEqual(utc.blocks.map((b) => b.n), [1, 1, 1])
    // DATE ignores FrToTm.
    const date = page((await statement({ prtry: 'DATE', frTm: '09:00:00', toTm: '09:30:00' })).msgs[0])
    assert.equal(date.blocks[0].from, '2026-03-10T00:00:00.000+02:00')
  })

  test('statements reconcile with the ledger after internal payments', async () => {
    const res = await call(ctx, { method: 'POST', url: '/payment', body: pain001([{ txs: [{ amount: '25.00' }, { amount: '0.10' }] }]) })
    assert.equal(res.statusCode, 202)
    await drain(ctx); await drain(ctx, C2.code)
    const c1 = page((await statement()).msgs[0]).blocks[0]
    assert.deepEqual([c1.close.amt, c1.n, c1.dbt], ['9974.90', 3, '2'])
    reconciles(c1)
    const ntry = c1.entries[1]
    assert.equal(ntry.CdtDbtInd, 'DBIT')
    assert.equal(ntry.NtryDtls.TxDtls.RltdPties.CdtrAcct.Id.IBAN, C2.iban)
    assert.equal(ntry.BkTxCd.Domn.Fmly.Cd, 'ICDT')
    const c2 = page((await statement({ iban: C2.iban }, { as: C2.code })).msgs[0]).blocks[0]
    assert.deepEqual([c2.close.amt, c2.cdt], ['125.10', '3'])
  })

  describe('errors (an <Errors> message of type ACCOUNT_STATEMENT)', () => {
    const err = async (o: ReportReq | string, opts: { as?: string; headers?: Record<string, string> } = {}) => {
      const r = await report(ctx, o, { ...opts, kind: 'statement' })
      assert.equal(r.msgs.length, 1)
      assert.equal(r.msgs[0].type, 'ACCOUNT_STATEMENT')
      return reportError(r.msgs[0])
    }
    const period = (description: string) => ({ code: 'errStatement_PeriodInvalid', description, field: undefined })

    test('RptgPrd missing: From date is required.', async () => {
      assert.deepEqual(await err({ frDt: null }), period('From date is required.'))
    })
    test('FrDt in the future', async () => {
      assert.deepEqual(await err({ frDt: '2026-03-11' }), period('From date cannot be in the future.'))
      assert.deepEqual(await err({ prtry: 'DATETIME', frTm: '10:00:01' }), period('From date cannot be in the future.'))
    })
    test('FrDt after ToDt', async () => {
      assert.deepEqual(await err({ frDt: '2026-03-10', toDt: '2026-03-09' }), period('From date cannot be later than to date.'))
      assert.deepEqual(await err({ prtry: 'DATETIME', frTm: '09:00:00', toTm: '09:00:00' }), period('From date cannot be later than to date.'))
    })
    test('a foreign or unknown account: errStatement_NoAccess', async () => {
      const noAccess = { code: 'errStatement_NoAccess', description: 'No access to the account.', field: undefined }
      assert.deepEqual(await err({ iban: C2.iban }), noAccess)
      assert.deepEqual(await err({ iban: 'EE057700771009999999' }), noAccess)
      // A service provider acting for another connected customer.
      assert.deepEqual(await err({}, { as: SP.code, headers: { 'Client-Code': C2.code, 'Client-Country': 'EE' } }), noAccess)
    })
    test('duplicate MsgId: errStatement_DuplicateRequest; the balance endpoint keeps its own MsgIds', async () => {
      const msgId = 'DUP-STATEMENT-1'
      assert.equal(page((await statement({ msgId })).msgs[0]).blocks.length, 3)
      assert.deepEqual(await err({ msgId }), { code: 'errStatement_DuplicateRequest', description: 'Duplicate request.', field: undefined })
      const b = await report(ctx, { msgId, kind: 'balance' })
      assert.equal(reportError(b.msgs[0]), undefined)
      // Another customer may use the same MsgId.
      assert.equal(reportError((await report(ctx, { msgId, iban: C2.iban }, { as: C2.code })).msgs[0]), undefined)
    })
    test('a refused request does not use up its MsgId', async () => {
      assert.equal((await err({ msgId: 'RETRY-1', frDt: '2026-03-11' }))!.code, 'errStatement_PeriodInvalid')
      assert.equal(reportError((await statement({ msgId: 'RETRY-1' })).msgs[0]), undefined)
    })
    test('not XML / not camt.060 / schema-invalid: errStatement_RequestInvalid', async () => {
      const invalid = { code: 'errStatement_RequestInvalid', description: 'Request message fails xsd validation.', field: undefined }
      assert.deepEqual(await err('this is not xml <'), invalid)
      assert.deepEqual(await err(''), invalid)
      assert.deepEqual(await err(camt060().replace('camt.060.001.05', 'camt.060.001.04')), invalid)
      // Only the schema catches a missing AcctOwnr.
      if (xsd.has('camt.060.001.05')) assert.deepEqual(await err(camt060().replace('<AcctOwnr><Pty/></AcctOwnr>', '')), invalid)
      // Not a calendar date: the schema says so, or (without it) the structural check with Field.
      assert.equal((await err(camt060({ frDt: '2026-02-30' })))!.code, 'errStatement_RequestInvalid')
    })
    test('more than one RptgReq: RequestInvalid with Field RptgReq', async () => {
      const xml = camt060().replace(/(<RptgReq>[\s\S]*<\/RptgReq>)/, '$1$1')
      assert.deepEqual(await err(xml), { code: 'errStatement_RequestInvalid', description: 'Request message fails xsd validation.', field: 'RptgReq' })
    })
    test('a ReqdMsgNmId that does not match the request version: RequestInvalid with Field', async () => {
      const f = (await err({ reqd: 'camt.052.001.08' }))!
      assert.deepEqual([f.code, f.field], ['errStatement_RequestInvalid', 'ReqdMsgNmId'])
      assert.equal((await err({ version: '03', reqd: 'camt.053.001.08' }))!.field, 'ReqdMsgNmId')
    })
    test('too many transactions: errStatement_TransactionLimitExceeded (injected cap)', async () => {
      ctx = await setup({ reports: { maxTransactions: 3 } })
      book(); book() // with the three funding credits: 5 > 3
      assert.deepEqual(await err({}), { code: 'errStatement_TransactionLimitExceeded', description: 'The requested period contains too many transactions', field: undefined })
      // The cap counts the period only.
      assert.equal(reportError((await statement({ prtry: 'DATETIME', frTm: '00:00:00', toTm: '10:00:00' })).msgs[0]), undefined)
    })
    test('the documented cap: 100 000 transactions', async () => {
      assert.equal(MAX_TRANSACTIONS, 100_000)
      const at = ctx.clock.now().getTime()
      for (let i = 0; i < MAX_TRANSACTIONS - 2; i++) book({ at })
      assert.equal((await err({}))!.code, 'errStatement_TransactionLimitExceeded')
    })
  })

  describe('paging (GrpHdr/MsgPgntn)', () => {
    test('page boundaries: INTM balances at the boundary entry, currencies in order', async () => {
      ctx = await setup({ reports: { pageSize: 3 } })
      const t0 = ctx.clock.now().getTime()
      for (let i = 1; i <= 4; i++) book({ at: t0 + i * 1000, amount: `${i}.00` })
      // EUR: funding + 4 = 5 entries, GBP 1, USD 1 → [EUR×3] [EUR×2, GBP] [USD]
      ctx.clock.advance(10_000)
      const { msgs } = await statement()
      assert.equal(msgs.length, 3)
      const pages = msgs.map(page)
      assert.deepEqual(pages.map((p) => p.pg), [{ nb: '1', last: 'false' }, { nb: '2', last: 'false' }, { nb: '3', last: 'true' }])
      assert.deepEqual(pages.map((p) => p.blocks.map((b) => `${b.ccy}×${b.n}`)), [['EUR×3'], ['EUR×2', 'GBP×1'], ['USD×1']])
      const [e1, e2] = [pages[0].blocks[0], pages[1].blocks[0]]
      assert.deepEqual([e1.open, e1.close], [
        { amt: '0.00', intm: false, dt: '2026-03-10T00:00:00.000+02:00' },
        { amt: '10003.00', intm: true, dt: '2026-03-10T10:00:02.000+02:00' }])
      assert.deepEqual([e2.open, e2.close], [
        { amt: '10003.00', intm: true, dt: '2026-03-10T10:00:02.000+02:00' },
        { amt: '10010.00', intm: false, dt: '2026-03-10T10:00:10.000+02:00' }])
      for (const p of pages) for (const b of p.blocks) reconciles(b)
      // Every page carries the same period and its own MsgId.
      assert.equal(new Set(pages.flatMap((p) => p.blocks.map((b) => `${b.from}|${b.to}`))).size, 1)
      assert.equal(new Set(msgs.map((m) => m.doc.Document.BkToCstmrStmt.GrpHdr.MsgId)).size, 3)
    })

    test('exactly one page of entries: no MsgPgntn', async () => {
      ctx = await setup({ reports: { pageSize: 3 } })
      const { msgs } = await statement()
      assert.equal(msgs.length, 1)
      assert.equal(page(msgs[0]).pg, undefined)
    })

    test('the last page carries the currencies without entries in the period', async () => {
      ctx = await setup({ reports: { pageSize: 3 } })
      ctx.clock.advance(DAY_MS)
      for (let i = 0; i < 4; i++) book({ amount: '1.00' })
      const pages = (await statement({ frDt: '2026-03-11' })).msgs.map(page)
      assert.deepEqual(pages.map((p) => p.blocks.map((b) => `${b.ccy}×${b.n}`)), [['EUR×3'], ['EUR×1', 'GBP×0', 'USD×0']])
      assert.deepEqual(pages[1].blocks.slice(1).map((b) => [b.open.amt, b.close.amt, b.open.intm]), [['500.00', '500.00', false], ['500.00', '500.00', false]])
    })

    test(`the documented page size: ${PAGE_SIZE} entries per message`, async () => {
      assert.equal(PAGE_SIZE, 10_000)
      const at = ctx.clock.now().getTime()
      for (let i = 0; i < PAGE_SIZE; i++) book({ at }) // + 1 EUR funding = 10 001 EUR entries
      const pages = (await report(ctx, { kind: 'statement' })).msgs.map(page)
      assert.deepEqual(pages.map((p) => p.blocks.map((b) => `${b.ccy}×${b.n}`)), [['EUR×10000'], ['EUR×1', 'GBP×1', 'USD×1']])
    })
  })

  test('a service provider asks for a connected customer with Client-Code / Client-Country', async () => {
    const headers = { 'Client-Code': C1.code, 'Client-Country': 'EE' }
    const r = await statement({}, { as: SP.code, headers })
    assert.equal(r.msgs.length, 1)
    assert.equal(page(r.msgs[0]).blocks[0].close.amt, '10000.00')
    // The answer belongs to the customer: C1 itself sees it too.
    const again = await report(ctx, {}, { as: SP.code, headers })
    const res = await call(ctx, { url: `/messages`, as: C1.code })
    assert.equal(res.statusCode, 204) // drained by the service provider already
    assert.equal(again.msgs[0].type, 'ACCOUNT_STATEMENT')
    const list = await call(ctx, { method: 'POST', url: '/account-statement', body: camt060(), as: SP.code, headers })
    const viaList = await call(ctx, { url: '/messages', as: SP.code, headers })
    assert.equal(viaList.json().messages[0].clientCode, C1.code)
    assert.equal(viaList.json().messages[0].messageRequestId, list.headers['message-request-id'])
  })

  test('free text is folded to Windows-1257', async () => {
    await call(ctx, { method: 'POST', url: '/_sim/incoming', body: {
      iban: C1.iban, amount: '1.00', remittance: 'Ąžuolų g. [5] — 100€ 😀 Gęsiński\\x', debtor: { name: 'Łukasz Ćwikła' }, reference: 'RF18_539007547034',
    } })
    await drain(ctx)
    const e = page((await statement()).msgs[0]).blocks[0].entries.find((x: any) => x.NtryDtls.TxDtls.RmtInf?.Strd)
    const tx = e.NtryDtls.TxDtls
    assert.equal(tx.RmtInf.Ustrd, 'Ažuolu g. (5) — 100E ? Gesinski/x')
    assert.equal(tx.RmtInf.Strd.CdtrRefInf.Ref, 'RF18-539007547034')
    assert.equal(tx.RltdPties.Dbtr.Pty.Nm, 'Lukasz Cwikla')
  })

  test('fold1257: replacement table first, then the code page', () => {
    assert.equal(fold1257('Šēta Žaliųjų ąžuolų'), 'Šeta Žaliuju ažuolu')
    assert.equal(fold1257('ÄÖÜõ äöü'), 'ÄÖÜõ äöü') // in Windows-1257 as they are
    assert.equal(fold1257('{x}[y]_`~'), '{x)(y)-’-')
    assert.equal(fold1257('Привет 中'), '?????? ?')
    assert.equal(fold1257('æøå ß ś'), 'aoa s s')
  })
})

describe('camt.053.001.02 (answer to camt.060.001.03)', () => {
  test('local times without offset, BIC, no ValDt, no Pty wrapper', async () => {
    const { msgs } = await report(ctx, { version: '03', kind: 'statement' })
    assert.equal(msgs.length, 1)
    const m = msgs[0]
    assert.match(m.body, /xmlns="urn:iso:std:iso:20022:tech:xsd:camt\.053\.001\.02"/)
    const s = m.doc.Document.BkToCstmrStmt
    assert.match(s.GrpHdr.CreDtTm, /^2026-03-10T10:00:00\.000000$/)
    const p = page(m)
    // v02 for a part of the day: only currencies with entries; balances with dates.
    assert.deepEqual(p.blocks.map((b) => b.ccy), ['EUR', 'GBP', 'USD'])
    assert.equal(p.blocks[0].from, '2026-03-10T00:00:00')
    assert.equal(p.blocks[0].to, '2026-03-10T10:00:00')
    assert.equal(p.blocks[0].open.dt, '2026-03-10')
    const st = many<any>(s.Stmt)[0]
    assert.equal(st.Acct.Svcr.FinInstnId.BIC, 'LHVBEE22')
    const e = p.blocks[0].entries[0]
    assert.equal(e.ValDt, undefined)
    assert.equal(e.Sts, 'BOOK')
    assert.ok(!m.body.includes('<Pty>'))
  })

  test('replays the published PAYMENT_VIBAN_SEPA statement request', { skip: sample('PAYMENT_VIBAN_SEPA', 'ACCOUNT_STATEMENT_CAMT.060.xml') ? false : 'docs mirror not available' }, async () => {
    const req = sample('PAYMENT_VIBAN_SEPA', 'ACCOUNT_STATEMENT_CAMT.060.xml')!
    const want = sample('PAYMENT_VIBAN_SEPA', 'ACCOUNT_STATEMENT_CAMT.053A.xml')!
    const iban = /<IBAN>([^<]+)<\/IBAN>/.exec(req)![1]
    ctx.clock.set('2021-08-03T15:52:11.530Z')
    const s = await setup({ clock: ctx.clock }, { customers: [{ code: '12349999', country: 'EE', name: 'Company of John', accounts: [iban] }] })
    ctx = { ...s, clock: ctx.clock }
    // The booking of the sample: 1.00 EUR SEPA to John Smith at 18:20 Tallinn time.
    ctx.emulator.journal.record({
      account: iban, owner: { name: 'Company of John', code: '12349999' }, direction: 'DBIT', amount: 100n, currency: 'EUR',
      servicerRef: 'F56A3D416EF4EB11911400155D41A83F', scheme: 'SEPA', bookedAt: new Date('2021-08-03T15:20:00Z'),
      pmtInfId: 'PMTINFID-58974', instrId: 'INSTRID-58974', endToEndId: 'E2E-58974',
      counterparty: { name: 'John Smith', iban: 'ES9121000418450200051332', bic: 'CAIXESBBXXX' }, remittance: 'Payment Description 58974', reference: '58974',
    })
    const { msgs } = await report(ctx, req, { as: '12349999' })
    assert.equal(msgs.length, 1)
    const got = msgs[0]
    // Same element structure as the published answer (minus the parts the emulator does not have).
    const paths = (xml: string) => {
      const out = new Set<string>()
      const walk = (n: any, p: string) => {
        out.add(p)
        if (n === null || typeof n !== 'object') return
        for (const [k, v] of Object.entries(n)) if (!k.startsWith('@') && k !== '#text') for (const x of many(v)) walk(x, `${p}/${k}`)
      }
      walk(parseXml(xml).Document, '')
      return out
    }
    const theirs = paths(want), ours = paths(got.body)
    const extra = [...ours].filter((p) => !theirs.has(p) && !/\/(Dbtr|Cdtr)\/Id(\/|$)/.test(p))
    assert.deepEqual(extra, [], 'no elements the reference does not send')
    const missing = [...theirs].filter((p) => !ours.has(p) && !/PstlAdr|CdtrAgt\/FinInstnId\/Nm/.test(p))
    assert.deepEqual(missing, [], 'every element the reference sends')
    const p = page(got).blocks[0]
    const w = page({ doc: parseXml(want) }).blocks[0]
    assert.deepEqual([p.from, p.to, p.open.amt, p.close.amt, p.open.dt, p.n], [w.from, w.to, w.open.amt, w.close.amt, w.open.dt, w.n])
  })
})

describe('automatic end-of-day statement', () => {
  const put = (body: object, who = 'EE/12340001') => call(ctx, { method: 'PUT', url: `/_sim/reports/${who}`, body })

  test('configured per customer; sent once per finished day, without Message-Request-Id', async () => {
    assert.equal((await put({ automaticStatement: '08' })).statusCode, 200)
    // Nothing for the day still running.
    assert.equal((await call(ctx, { method: 'POST', url: '/_sim/end-of-day', body: {} })).json().messages, 0)
    book({ amount: '3.00', dir: 'DBIT' })
    ctx.clock.advance(DAY_MS)
    book({ amount: '7.00' }) // the next day: not in the statement
    assert.equal((await call(ctx, { method: 'POST', url: '/_sim/end-of-day', body: {} })).json().messages, 1)
    assert.equal(ctx.emulator.reports.tick(), 0)
    const msgs = await drain(ctx)
    const st = msgs.filter((m) => m.type === 'ACCOUNT_STATEMENT')
    assert.equal(st.length, 1)
    assert.equal(st[0].requestId, undefined)
    await schemaValid(st[0].body)
    const p = page(st[0])
    assert.deepEqual(p.blocks.map((b) => [b.ccy, b.open.amt, b.close.amt, b.n]), [['EUR', '0.00', '9997.00', 2], ['GBP', '0.00', '500.00', 1], ['USD', '0.00', '500.00', 1]])
    assert.equal(p.blocks[0].to, '2026-03-10T23:59:59.999+02:00')
    // Other customers did not ask for it.
    assert.equal((await drain(ctx, C2.code)).length, 0)
  })

  test('the clock-driven tick catches up on every finished day; an explicit date is sent once', async () => {
    await put({ automaticStatement: '02' })
    ctx.clock.advance(3 * DAY_MS)
    assert.equal(ctx.emulator.reports.tick(), 3) // 10, 11, 12 March
    assert.equal(ctx.emulator.reports.tick(), 0)
    const r = await call(ctx, { method: 'POST', url: '/_sim/end-of-day', body: { date: '2026-03-11' } })
    assert.deepEqual(r.json(), { date: '2026-03-11', messages: 0 })
    const st = (await drain(ctx)).filter((m) => m.type === 'ACCOUNT_STATEMENT')
    assert.equal(st.length, 3)
    assert.match(st[0].body, /camt\.053\.001\.02/)
    assert.deepEqual(st.map((m) => page(m).blocks[0].from), ['2026-03-10T00:00:00', '2026-03-11T00:00:00', '2026-03-12T00:00:00'])
    // v02 full days list every currency with history.
    assert.deepEqual(page(st[1]).blocks.map((b) => [b.ccy, b.n]), [['EUR', 0], ['GBP', 0], ['USD', 0]])
  })

  test('/_sim/reports: settings, validation, switching off', async () => {
    const g = await call(ctx, { url: '/_sim/reports/ee/12340001' })
    assert.deepEqual(g.json(), { code: C1.code, country: 'EE', automaticStatement: null, limits: { daily: '10000.00', monthly: '100000.00', instant: '15000.00' } })
    assert.equal((await put({ automaticStatement: '05' })).statusCode, 400)
    assert.equal((await put({ limits: { weekly: '1.00' } })).statusCode, 400)
    assert.equal((await put({ limits: { daily: 'abc' } })).statusCode, 400)
    assert.equal((await put({}, 'EE/99999999')).statusCode, 404)
    await put({ automaticStatement: '08' })
    assert.equal((await put({ automaticStatement: null })).json().automaticStatement, null)
    ctx.clock.advance(DAY_MS)
    assert.equal(ctx.emulator.reports.tick(), 0)
    const bad = await call(ctx, { method: 'POST', url: '/_sim/end-of-day', body: { date: '2026-03-11' } })
    assert.equal(bad.statusCode, 400)
    assert.equal((await call(ctx, { method: 'POST', url: '/_sim/end-of-day', body: { date: '11.03.2026' } })).statusCode, 400)
  })
})
