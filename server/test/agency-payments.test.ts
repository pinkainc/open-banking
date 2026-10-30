// S6, payments from and to agency accounts (indirect scheme access, decisions 830–836): an
// agency account as the debtor (IBAN or Othr/Id, the name and address mandatory, the master
// account pays), credits routed to the master account by status (CLOSED refused,
// INST_RESTRICTED refused for SEPA Instant only), and LHV's requester-side VoP/CoP finding
// agency accounts. Every pain.002 and camt.054 is checked against its published XSD.
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { makeIban } from '../src/iban.js'
import type { SimulatorRails } from '../src/rails.js'
import { C1, DE_IBAN, balance, call, drain, jsonDrain, pain001, schemaValid, seed, setup, type Ctx } from './helpers.js'

const EEM = makeIban('EE', '7700771001260199')
const GBM = makeIban('GB', 'LHVB04031400007777')
const AG = { code: '09870001', country: 'GB', name: 'Agent Payments Ltd' }
const AG2 = { code: '09870002', country: 'GB', name: 'Other Agent Ltd' }
/** Agency accounts: NL at RABO (LHV EE, master EEM), GB sort code 401276 (LHV UK, master GBM). */
const NL = makeIban('NL', 'RABO0417164300')
const NL_CLOSED = makeIban('NL', 'RABO0417164301')
const NL_INST = makeIban('NL', 'RABO0417164302')
const NL_OTHER = makeIban('NL', 'RABO0417164303')
const GB_NO = '40127612345678'
const SETUP = {
  agreement: true, cop: true, vop: true,
  ranges: [{ country: 'NL', bank: 'RABO', master: EEM }, { country: 'GB', sortCode: '401276', master: GBM }],
}

let ee: Ctx
let uk: Ctx
beforeEach(async () => {
  const s = seed()
  s.customers.push(
    { ...AG, accounts: [{ iban: EEM, balances: { EUR: '1000.00' } }, { iban: GBM, balances: { GBP: '500.00', EUR: '100.00' } }], agency: SETUP } as any,
    { ...AG2, accounts: [makeIban('EE', '7700771001260288')], agency: { agreement: true, ranges: [{ country: 'NL', bank: 'RABO', master: makeIban('EE', '7700771001260288') }] } } as any,
  )
  ee = await setup({}, s)
  uk = await setup({}, s, { flavour: 'UK' })
  for (const c of [ee, uk]) {
    const store = c.emulator.agency.accounts
    const now = c.clock.now()
    const put = (bank: 'LHVEE' | 'LHVUK', id: string, status: 'ACTIVE' | 'CLOSED' | 'INST_RESTRICTED', name: string, agent = AG, master = EEM) =>
      store.put({ bank, id, country: id.slice(0, 2), ...(id.startsWith('NL') ? { iban: id } : { accountNo: id }), status, name, category: 'PERSONAL', copOptOut: false, agent: { code: agent.code, country: agent.country }, master, createdAt: now, updatedAt: now })
    await put('LHVEE', NL, 'ACTIVE', 'Jan Novak')
    await put('LHVEE', NL_CLOSED, 'CLOSED', 'Closed Holder')
    await put('LHVEE', NL_INST, 'INST_RESTRICTED', 'Inst Restricted')
    await put('LHVEE', NL_OTHER, 'ACTIVE', 'Other Agent Client', AG2, makeIban('EE', '7700771001260288'))
    await put('LHVUK', GB_NO, 'ACTIVE', 'Michael Smith', AG, GBM)
  }
})

/** The pain.001 of the helper with an agency debtor: Othr/Id instead of IBAN, a postal address. */
function agencyPain(debtor: string, o: { name?: string | null; address?: boolean; other?: boolean; scheme?: string; creditorIban?: string; currency?: string } = {}) {
  let xml = pain001([{ debtorIban: debtor, debtorName: o.name ?? 'Jan Novak', scheme: o.scheme, txs: [{ amount: '10.00', creditorIban: o.creditorIban ?? DE_IBAN, currency: o.currency }] }])
  if (o.other) xml = xml.replace(`<DbtrAcct><Id><IBAN>${debtor}</IBAN></Id></DbtrAcct>`, `<DbtrAcct><Id><Othr><Id>${debtor}</Id></Othr></Id></DbtrAcct>`)
  const adr = o.address === false ? '' : '<PstlAdr><StrtNm>High Holborn</StrtNm><BldgNb>88</BldgNb><PstCd>WC1V 6AA</PstCd><TwnNm>London</TwnNm><Ctry>GB</Ctry></PstlAdr>'
  xml = o.name === null ? xml.replace(/<Dbtr><Nm>[^<]*<\/Nm><\/Dbtr>/, `<Dbtr>${adr}</Dbtr>`) : xml.replace(/(<Dbtr><Nm>[^<]*<\/Nm>)<\/Dbtr>/, `$1${adr}</Dbtr>`)
  return xml
}

async function pay(c: Ctx, xml: string, as = AG.code) {
  const res = await call(c, { method: 'POST', url: '/payment', body: xml, as })
  assert.equal(res.statusCode, 202, res.body)
  const msgs = await drain(c, as)
  for (const m of msgs) assert.ok(await schemaValid(m.body), m.type)
  return msgs
}
const statusOf = (m: any) => {
  const r = m.doc.Document.CstmrPmtStsRpt
  const tx = r.OrgnlPmtInfAndSts?.TxInfAndSts
  return { group: r.OrgnlGrpInfAndSts.GrpSts, tx: tx?.TxSts, reason: tx?.StsRsnInf?.AddtlInf ?? r.OrgnlGrpInfAndSts.StsRsnInf?.AddtlInf, debtorAcct: tx?.OrgnlTxRef?.DbtrAcct?.Id }
}
const entry = (m: any) => {
  const n = m.doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn
  return { account: n.Acct.Id.IBAN, ntry: n.Ntry, parties: n.Ntry.NtryDtls.TxDtls.RltdPties }
}

describe('payments from agency accounts', () => {
  test('an agency IBAN pays through the master account: ACSP, ACSC, camt.054 DBIT with the holder as debtor', async () => {
    const msgs = await pay(ee, agencyPain(NL))
    assert.deepEqual(msgs.map((m) => m.type), ['PAYMENT', 'PAYMENT', 'CREDIT_DEBIT_NOTIFICATION'])
    assert.equal(statusOf(msgs[0]).tx, 'ACSP')
    assert.equal(statusOf(msgs[1]).tx, 'ACSC')
    assert.deepEqual(statusOf(msgs[0]).debtorAcct, { IBAN: NL })
    const e = entry(msgs[2])
    assert.equal(e.account, EEM)
    assert.equal(e.ntry.CdtDbtInd, 'DBIT')
    assert.deepEqual(e.parties.Dbtr, { Nm: 'Jan Novak', PstlAdr: { Ctry: 'GB', AdrLine: 'London' } })
    assert.deepEqual(e.parties.DbtrAcct, { Id: { IBAN: NL } })
    assert.equal(await balance(ee, EEM), '990.00')
  })

  test('a sort code and account number as Othr/Id pays from the UK master account', async () => {
    const msgs = await pay(uk, agencyPain(GB_NO, { other: true, currency: 'EUR' }))
    assert.equal(statusOf(msgs[0]).tx, 'ACSP')
    assert.deepEqual(statusOf(msgs[0]).debtorAcct, { Othr: { Id: GB_NO } })
    const e = entry(msgs.at(-1))
    assert.equal(e.account, GBM)
    assert.deepEqual(e.parties.DbtrAcct, { Id: { Othr: { Id: GB_NO } } })
    assert.equal(e.parties.Dbtr.Nm, 'Jan Novak')
  })

  test('refusals: no name, no address, CLOSED, another agent\'s account, unknown Othr/Id, INST_RESTRICTED and SEPA Instant', async () => {
    const rj = async (xml: string, c = ee) => statusOf((await pay(c, xml))[0])
    assert.deepEqual([(await rj(agencyPain(NL, { name: null }))).reason], ['Invalid debtor’s name.'])
    assert.equal((await rj(agencyPain(NL, { address: false }))).reason, 'Invalid debtor’s address.')
    assert.equal((await rj(agencyPain(NL_CLOSED))).reason, 'Debtor’s account not active.')
    const other = await rj(agencyPain(NL_OTHER))
    assert.equal(other.group, 'RJCT')
    assert.equal(other.reason, 'No rights to debtor’s account.')
    const unknown = await rj(agencyPain('12345678901234', { other: true }))
    assert.equal(unknown.reason, 'Uploading file failed. Faulty sender account 12345678901234.')
    // INST_RESTRICTED: SEPA Instant requested is refused, the automatic choice is SEPA.
    assert.equal((await rj(agencyPain(NL_INST, { scheme: 'INST' }))).reason, 'Instant payment forbidden, try European payment.')
    const auto = await pay(ee, agencyPain(NL_INST))
    assert.equal(auto[0].doc.Document.CstmrPmtStsRpt.OrgnlPmtInfAndSts.TxInfAndSts.OrgnlTxRef.PmtTpInf.SvcLvl.Prtry, 'SEPA')
  })
})

describe('payments to agency accounts', () => {
  test('an internal payment to an agency IBAN is booked on the master account with the holder as creditor', async () => {
    const msgs = await pay(ee, pain001([{ txs: [{ amount: '5.00', creditorIban: NL, creditorName: 'J Novak' }] }]), C1.code)
    assert.equal(statusOf(msgs[0]).tx, 'ACSC')
    const agent = await drain(ee, AG.code)
    assert.equal(agent.length, 1)
    assert.ok(await schemaValid(agent[0].body))
    const e = entry(agent[0])
    assert.equal(e.account, EEM)
    assert.equal(e.ntry.CdtDbtInd, 'CRDT')
    assert.deepEqual(e.parties.Cdtr, { Nm: 'Jan Novak' })
    assert.deepEqual(e.parties.CdtrAcct, { Id: { IBAN: NL } })
    assert.equal(await balance(ee, EEM), '1005.00')
    // CLOSED: refused; INST_RESTRICTED: an internal payment is no SEPA Instant.
    assert.equal(statusOf((await pay(ee, pain001([{ txs: [{ amount: '5.00', creditorIban: NL_CLOSED }] }]), C1.code))[0]).reason, 'Creditor account is closed.')
    assert.equal(statusOf((await pay(ee, pain001([{ txs: [{ amount: '5.00', creditorIban: NL_INST, scheme: 'INST' }] }]), C1.code))[0]).tx, 'ACSC')
  })

  test('incoming credits from other banks: master account, CLOSED AC04, INST_RESTRICTED AG01 for SEPA Instant only', async () => {
    const inc = (iban: string, scheme = 'SEPA', c = ee) => call(c, { method: 'POST', url: '/_sim/incoming', body: { iban, amount: '2.00', scheme, debtor: { name: 'Katie Bell', iban: 'ES9121000418450200051332' } } })
    const ok = (await inc(NL)).json()
    assert.equal(ok.masterAccount, EEM)
    const [m] = await drain(ee, AG.code)
    assert.ok(await schemaValid(m.body))
    assert.deepEqual(entry(m).parties.CdtrAcct, { Id: { IBAN: NL } })
    assert.deepEqual(entry(m).parties.Cdtr, { Nm: 'Jan Novak' })
    assert.deepEqual([(await inc(NL_CLOSED)).json().reason, (await inc(NL_INST, 'INST')).json().reason], ['AC04', 'AG01'])
    assert.equal((await inc(NL_INST, 'SEPA')).json().masterAccount, EEM)
    // A sort code and account number on the UK host: the credit shows it as Othr/Id.
    const gb = (await inc(GB_NO, 'SEPA', uk)).json()
    assert.equal(gb.masterAccount, GBM)
    const [g] = await drain(uk, AG.code)
    assert.deepEqual(entry(g).parties.CdtrAcct, { Id: { Othr: { Id: GB_NO } } })
    assert.equal(await balance(ee, EEM), '1004.00')
  })
})

describe('requester-side VoP and CoP find agency accounts (decision 810 closed)', () => {
  test('CoP on a sort code and account number, VoP on an agency IBAN; CLOSED is not answered', async () => {
    const ask = async (path: string, body: object) => {
      const res = await call(uk, { method: 'POST', url: path, body, as: C1.code })
      assert.equal(res.statusCode, 202, res.body)
      const [m] = await jsonDrain(uk, C1.code)
      return JSON.parse(m.body).Data
    }
    const cop = await ask('/payment/cop-request', { AccountCategory: 'PERSONAL', Identification: GB_NO, Name: 'Michael Smith' })
    assert.equal(cop.ReasonCode, 'ACCP')
    const vop = await ask('/payment/vop-request', { Identification: NL, Name: 'Jan Novak' })
    assert.equal(vop.ReasonCode ?? vop.Code, 'MTCH')
    const closed = await ask('/payment/vop-request', { Identification: NL_CLOSED, Name: 'Closed Holder' })
    assert.equal(closed.ReasonCode ?? closed.Code, 'NOAP')
  })
})

describe('returns and recalls of agency payments (decisions 1014, 1015)', () => {
  const rails = (c = ee) => c.emulator.rails as SimulatorRails
  test('a payment from an agency account returned: back on the master account with the holder as the creditor party', async () => {
    const msgs = await pay(ee, agencyPain(NL))
    const ref = msgs[1].doc.Document.CstmrPmtStsRpt.OrgnlPmtInfAndSts.TxInfAndSts.AcctSvcrRef as string
    assert.equal(await balance(ee, EEM), '990.00')
    assert.equal((await rails().returnPayment({ ref, returnRef: 'RTR-AG', code: 'AC04' })).applied, true)
    assert.equal(await balance(ee, EEM), '1000.00')
    const [m] = await drain(ee, AG.code)
    assert.ok(await schemaValid(m.body))
    const e = entry(m)
    assert.deepEqual([e.account, e.ntry.CdtDbtInd, String(e.ntry.RvslInd)], [EEM, 'CRDT', 'true'])
    assert.deepEqual(e.parties.Cdtr, { Nm: 'Jan Novak', PstlAdr: { Ctry: 'GB', AdrLine: 'London' } })
    assert.deepEqual(e.parties.CdtrAcct, { Id: { IBAN: NL } })
    assert.deepEqual(e.parties.DbtrAcct, { Id: { IBAN: DE_IBAN } })
  })

  test('a payment from an agency account settled before decision 1014 (no record) returned the same: the agency party from the journal entry (decision 1020)', async () => {
    ee.emulator.outbox.on('payment-settled', async () => {})
    const msgs = await pay(ee, agencyPain(NL))
    const ref = msgs[1].doc.Document.CstmrPmtStsRpt.OrgnlPmtInfAndSts.TxInfAndSts.AcctSvcrRef as string
    assert.equal((await rails().returnPayment({ ref, returnRef: 'RTR-AG-OLD', code: 'AC04' })).applied, true)
    assert.equal(await balance(ee, EEM), '1000.00')
    const [m] = await drain(ee, AG.code)
    assert.ok(await schemaValid(m.body))
    const e = entry(m)
    assert.deepEqual([e.account, e.ntry.CdtDbtInd, String(e.ntry.RvslInd)], [EEM, 'CRDT', 'true'])
    assert.deepEqual(e.parties.Cdtr, { Nm: 'Jan Novak', PstlAdr: { Ctry: 'GB', AdrLine: 'London' } })
    assert.deepEqual(e.parties.CdtrAcct, { Id: { IBAN: NL } })
    assert.deepEqual(e.parties.DbtrAcct, { Id: { IBAN: DE_IBAN } })
    assert.equal((await rails().returnPayment({ ref, returnRef: 'RTR-AG-OLD', code: 'AC04' })).applied, false, 'once')
  })

  test('a recall of a credit to an agency account debits the master with the agency account as the debtor party', async () => {
    const c = await rails().credit({ ref: 'RC-AG', iban: NL, amount: 300n, currency: 'EUR', scheme: 'SEPA', debtor: { name: 'Katie Bell', iban: 'ES9121000418450200051332' } })
    assert.equal(c.status, 'booked')
    await drain(ee, AG.code)
    assert.equal((await rails().recall({ ref: 'RC-AG', recallRef: 'CXL-AG', code: 'TECH' })).status, 'returned')
    const [m] = await drain(ee, AG.code)
    assert.ok(await schemaValid(m.body))
    const e = entry(m)
    assert.deepEqual([e.account, e.ntry.CdtDbtInd], [EEM, 'DBIT'])
    assert.deepEqual(e.parties.Dbtr, { Nm: 'Jan Novak' })
    assert.deepEqual(e.parties.DbtrAcct, { Id: { IBAN: NL } })
    assert.deepEqual(e.parties.CdtrAcct, { Id: { IBAN: 'ES9121000418450200051332' } })
    assert.equal(await balance(ee, EEM), '1000.00')
  })
})
