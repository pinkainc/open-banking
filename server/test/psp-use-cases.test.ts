// S6, the G "Payment Service Provider use cases" 1–8 as end-to-end chains on the UK host
// (decisions 840–849): the published pain.001 replayed as it is → pain.002 ACSP → pain.002
// ACSC → camt.054, every message valid against its published XSD and compared with the
// published response samples field by field. What differs by nature (ids, times, the bank's
// references) is normalised; every remaining difference is listed per case as a recorded
// divergence, so a new one fails the test.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { parseXml } from '../src/xml.js'
import { MIRROR_DIR, call, drain, sample, schemaValid, seed, setup, type Ctx } from './helpers.js'

const DIR = join(MIRROR_DIR, 'docs/gitbook/connect/services/payments/payment-examples/payment-service-provider-use-cases')
const PAGES: Record<number, string> = {
  1: 'use-case-1-psps-payment.md', 2: 'use-case-2-psps-client-payment.md', 3: 'use-case-3-level2-psp-client-payment.md',
  4: 'use-case-4-viban-payment.md', 5: 'use-case-5-level2-viban-payment.md', 6: 'use-case-6-level2-viban-payment-plus-ultimate-debtor.md',
  7: 'use-case-7-indirect-scheme-participant-client-payment.md', 8: 'use-case-8-level2-indirect-scheme-participant-client-payment.md',
}
const NO_PAGES = existsSync(join(DIR, PAGES[1])) ? false : 'no G PSP use case pages in the docs mirror'

/** The XML of each tab of a G page, by tab title. */
function tabs(n: number): Record<string, string> {
  const t = readFileSync(join(DIR, PAGES[n]), 'utf8')
  const out: Record<string, string> = {}
  for (const m of t.matchAll(/\{% tab title="([^"]+)" %\}([\s\S]*?)\{% endtab %\}/g)) {
    const x = /```xml\n([\s\S]*?)```/.exec(m[2])
    if (x) out[m[1]] = x[1].trim()
  }
  return out
}

/** Values that differ by nature: generated ids, times and the bank's own references. */
const VOLATILE = new Set(['MsgId', 'CreDtTm', 'AcctSvcrRef', 'DtTm'])
function normalise(v: any, key = ''): any {
  if (Array.isArray(v)) return v.map((x) => normalise(x, key))
  if (v && typeof v === 'object') {
    const o: any = {}
    for (const [k, x] of Object.entries(v)) {
      if (k === '?xml' || k.startsWith('@xmlns') || k === '@xsi:schemaLocation' || k === '@schemaLocation') continue
      o[k] = normalise(x, k)
    }
    return o
  }
  return VOLATILE.has(key) ? '*' : v
}
/** Paths where two parsed documents differ: `-path` only in the sample, `+path` only produced, `~path` different values. */
function differences(sample: any, produced: any, path = ''): string[] {
  if (sample === produced) return []
  const obj = (x: any) => x && typeof x === 'object'
  if (!obj(sample) || !obj(produced)) {
    if (sample === undefined) return [`+${path}`]
    if (produced === undefined) return [`-${path}`]
    return [`~${path}: ${JSON.stringify(sample)} != ${JSON.stringify(produced)}`]
  }
  const keys = [...new Set([...Object.keys(sample), ...Object.keys(produced)])]
  return keys.flatMap((k) => differences(sample[k], produced[k], path ? `${path}/${k}` : k))
}
const doc = (xml: string) => normalise(parseXml(xml).Document)
/** Ntfctn/Id is the MsgId and the currency (the EE samples: a sequence number and the currency). */
const ntfctnId = (d: any) => {
  const n = d?.BkToCstmrDbtCdtNtfctn?.Ntfctn
  if (n?.Id) n.Id = String(n.Id).replace(/^([0-9a-f]{32}|[0-9]+)(?=[A-Z]{3}$)/, '*')
  return d
}

interface Chain { ctx: Ctx; as: string; request?: string; tabs: Record<string, string> }

/** Replays the published request and returns the messages, each XSD-checked. */
async function replay(c: Chain, at?: string) {
  if (at) c.ctx.clock.set(at)
  const res = await call(c.ctx, { method: 'POST', url: '/payment', body: c.request ?? c.tabs['Payment Request'], as: c.as })
  assert.equal(res.statusCode, 202, res.body)
  const msgs = await drain(c.ctx, c.as)
  for (const m of msgs) assert.ok(await schemaValid(m.body), `${m.type} not checked against an XSD`)
  return msgs
}

/** The three messages of an outgoing chain against the three published samples: the differences of each. */
async function outgoing(c: Chain) {
  // The emulator's clock on the sample's booking day.
  const day = /<BookgDt>\s*<Dt>([0-9-]{10})<\/Dt>/.exec(c.tabs['Transaction Notification'])![1]
  const msgs = await replay(c, `${day}T12:00:00Z`)
  assert.deepEqual(msgs.map((m) => m.type), ['PAYMENT', 'PAYMENT', 'CREDIT_DEBIT_NOTIFICATION'], msgs.map((m) => m.body).join('\n'))
  const [acsp, acsc, camt] = msgs
  assert.equal(acsp.doc.Document.CstmrPmtStsRpt.OrgnlPmtInfAndSts.TxInfAndSts.TxSts, 'ACSP')
  assert.equal(acsc.doc.Document.CstmrPmtStsRpt.OrgnlPmtInfAndSts.TxInfAndSts.TxSts, 'ACSC')
  // The same AcctSvcrRef through the chain.
  const ref = acsp.doc.Document.CstmrPmtStsRpt.OrgnlPmtInfAndSts.TxInfAndSts.AcctSvcrRef
  assert.equal(acsc.doc.Document.CstmrPmtStsRpt.OrgnlPmtInfAndSts.TxInfAndSts.AcctSvcrRef, ref)
  assert.equal(camt.doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn.Ntry.AcctSvcrRef, ref)
  return {
    acsp: differences(doc(c.tabs['Payment Response 1']), doc(acsp.body)),
    acsc: differences(doc(c.tabs['Payment Response 2']), doc(acsc.body)),
    camt: differences(ntfctnId(doc(c.tabs['Transaction Notification'])), ntfctnId(doc(camt.body))),
    msgs,
  }
}

// --- The parties of the samples -------------------------------------------------------
const PSP = { code: '13245678', country: 'GB', name: 'Connect Demo Customer 1' }
const AGENT = { code: '1231243243', country: 'GB', name: 'Indirect Participant' }
const AGENT_MASTER = 'GB47LHVB04031300004653'

async function uk(customers: any[]): Promise<Ctx> {
  const s = seed()
  s.customers.push(...customers)
  return setup({}, s, { flavour: 'UK' })
}
/** A VIBAN of the master account with a company holder. */
function viban(ctx: Ctx, iban: string, master: string, holder: { name: string; country: string; street: string }) {
  ctx.emulator.viban.registry.add({
    iban, master, owner: { code: PSP.code, country: 'GB' }, status: 'ACTIVE', createdAt: ctx.clock.now(), activatedAt: ctx.clock.now(),
    user: { company: { Name: holder.name } as any, address: { Country: holder.country, StreetNo: holder.street, CityCounty: 'City' } },
  })
}
/** Synchronised LHV UK agency accounts of the sample agent (sort code 040325). */
async function agency(ctx: Ctx, accounts: [string, string][]) {
  const now = ctx.clock.now()
  for (const [no, name] of accounts) {
    await ctx.emulator.agency.accounts.put({
      bank: 'LHVUK', id: no, country: 'GB', accountNo: no, status: 'ACTIVE', name, category: 'PERSONAL', copOptOut: false,
      agent: { code: AGENT.code, country: AGENT.country }, master: AGENT_MASTER, createdAt: now, updatedAt: now,
    })
  }
}
const agentCustomer = {
  ...AGENT, accounts: [{ iban: AGENT_MASTER, balances: { GBP: '100.00', EUR: '100.00' } }],
  agency: { agreement: true, ranges: [{ country: 'GB', sortCode: '040325', master: AGENT_MASTER }] },
}

const PAUL = { code: PSP.code, country: 'GB', name: 'Paul Atreides' }
const VIBAN_MASTER = 'GB47LHVB04031300004652'
const NONE = { acsp: [], acsc: [], camt: [] }
/** The documented divergences of the agency cases (decision 848): the account currency of an EUR entry, the creditor bank's name. */
const AGENCY_CAMT = [
  '~BkToCstmrDbtCdtNtfctn/Ntfctn/Id: "*GBP" != "*EUR"',
  '~BkToCstmrDbtCdtNtfctn/Ntfctn/Acct/Ccy: "GBP" != "EUR"',
  '-BkToCstmrDbtCdtNtfctn/Ntfctn/Ntry/NtryDtls/TxDtls/RltdAgts/CdtrAgt/FinInstnId/Nm',
]
const same = (d: { acsp: string[]; acsc: string[]; camt: string[] }, expected: { acsp: string[]; acsc: string[]; camt: string[] }) =>
  assert.deepEqual({ acsp: d.acsp, acsc: d.acsc, camt: d.camt }, expected)

describe('PSP use cases (G payment examples)', { skip: NO_PAGES }, () => {
  test('use case 1: the PSP pays from its own account by Faster Payments', async () => {
    const ctx = await uk([{ ...PSP, accounts: [{ iban: 'GB20LHVB04031512345678', balances: { GBP: '10.00' } }] }])
    const d = await outgoing({ ctx, as: PSP.code, tabs: tabs(1) })
    same(d, NONE)
    // UltmtCdtr: the name only (the request also has an address and an LEI).
    assert.deepEqual(d.msgs[2].doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn.Ntry.NtryDtls.TxDtls.RltdPties.UltmtCdtr, { Nm: 'Business Customer' })
    assert.equal((ctx.emulator.rails as any).sent[0].scheme, 'FAST')
  })

  for (const n of [2, 3]) {
    test(`use case ${n}: the PSP pays for ${n === 2 ? 'its client' : 'a level-2 PSP\'s client'}, the Ultimate Debtor echoed`, async () => {
      const ctx = await uk([{ ...PSP, accounts: [{ iban: 'GB31LHVB04031300004649', balances: { GBP: '10.00' } }] }])
      same(await outgoing({ ctx, as: PSP.code, tabs: tabs(n) }), NONE)
    })
  }

  for (const n of [4, 5, 6]) {
    test(`use case ${n}: ${n === 4 ? 'VIBAN payment' : n === 5 ? 'level-2 VIBAN payment' : 'level-2 VIBAN payment with an Ultimate Debtor'}`, async () => {
      const ctx = await uk([{ ...PAUL, accounts: [{ iban: VIBAN_MASTER, balances: { GBP: '10.00' }, viban: true }] }])
      if (n === 6) viban(ctx, 'GB49LHVB04030600272224', VIBAN_MASTER, { name: 'Shanghai Tech Innovations Co., Ltd.', country: 'CN', street: '88 Zhangjiang Road' })
      else viban(ctx, 'GB42LHVB04030600271186', VIBAN_MASTER, { name: 'Salman Limited', country: 'PT', street: 'Rua do Comércio 25' })
      const d = await outgoing({ ctx, as: PAUL.code, tabs: tabs(n) })
      // Use case 4's sample carries the address double-encoded (UTF-8 read as Latin-1); use case 5's has it right.
      same(d, n === 4 ? { ...NONE, camt: ['~BkToCstmrDbtCdtNtfctn/Ntfctn/Ntry/NtryDtls/TxDtls/RltdPties/Dbtr/PstlAdr/AdrLine: "Rua do ComÃ©rcio 25" != "Rua do Comércio 25"'] } : NONE)
    })
  }

  for (const n of [7, 8]) {
    test(`use case ${n}: ${n === 7 ? 'indirect scheme participant client payment' : 'level-2 indirect scheme participant client payment'}`, async () => {
      const ctx = await uk([agentCustomer])
      await agency(ctx, [['04032510097184', 'Jan Novak'], ['04032510097185', 'Nordic Data Oy']])
      const t = tabs(n)
      // Repair (decision 846): the published request has InitgPty/OrgId without the Id wrapper, which the XSD refuses.
      assert.match(t['Payment Request'], /<InitgPty>\s*<OrgId>/)
      const request = t['Payment Request'].replace(/<InitgPty>\s*<OrgId>([\s\S]*?)<\/OrgId>\s*<\/InitgPty>/, '<InitgPty><Id><OrgId>$1</OrgId></Id></InitgPty>')
      const d = await outgoing({ ctx, as: AGENT.code, tabs: t, request })
      same(d, { ...NONE, camt: AGENCY_CAMT })
      assert.equal(d.msgs[2].doc.Document.BkToCstmrDbtCdtNtfctn.Ntfctn.Acct.Id.IBAN, AGENT_MASTER)
    })
  }

  test('use case 7, incoming: by sort code and account number (Faster Payments) and by IBAN (SEPA), on the master account', async () => {
    const ctx = await uk([agentCustomer])
    await agency(ctx, [['04032510097184', 'Jan Novak']])
    const t = tabs(7)
    const credit = async (tab: string, body: object) => {
      const sample = t[tab]
      ctx.clock.set(`${/<BookgDt>\s*<Dt>([0-9-]{10})/.exec(sample)![1]}T12:00:00Z`)
      const res = await call(ctx, { method: 'POST', url: '/_sim/incoming', body })
      assert.equal(res.statusCode, 200, res.body)
      assert.equal(res.json().masterAccount, AGENT_MASTER)
      const [m, ...rest] = await drain(ctx, AGENT.code)
      assert.equal(rest.length, 0)
      assert.equal(m.type, 'CREDIT_DEBIT_NOTIFICATION')
      assert.ok(await schemaValid(m.body))
      return differences(ntfctnId(doc(sample)), ntfctnId(doc(m.body)))
    }
    const fps = await credit('Sort Code + Account Number', {
      iban: '04032510097184', amount: '1.01', currency: 'GBP', scheme: 'FAST', endToEndId: 'EndToEndId220920261', reference: 'Payment',
      debtor: { name: 'Michael Smith', account: '21201575555555' },
    })
    assert.deepEqual(fps, [])
    const sepa = await credit('IBAN', {
      iban: 'GB22PSPB04032510097184', amount: '1.01', currency: 'EUR', scheme: 'SEPA', remittance: 'Payment',
      endToEndId: 'EndToEndId220920264', pmtInfId: 'PmtInfId220920264', instrId: 'InstrId220920654',
      debtor: { name: 'Katie Bell', iban: 'ES9121000418450200051332', bic: 'CAIXESBBXXX' },
    })
    assert.deepEqual(sepa, AGENCY_CAMT.slice(0, 2))
  })
})


// --- The partner site's PAYMENT_PSP_USECASES samples (step F, decisions 950–955) ----------
// The same eight use cases as published on partners.lhv.ee: EE accounts, pain.001 → pain.002
// ACSP → ACSC → camt.054.001.02, replayed on the EE host and diffed as above. The samples come
// from LHV's test environment (BIC LHVBEE20, "AS LHV Pank") and are of two runs (2023-10-05,
// 2023-10-10); cases 3–8 share one camt.054 and one pair of pain.002, so what is specific to a
// use case (ultimate parties, VIBAN, agency) is not in them (decision 953).
const PARTNER = 'PAYMENT_PSP_USECASES'
const NO_PARTNER = sample(PARTNER, 'case1_pain.001.xml') ? false : 'no PAYMENT_PSP_USECASES samples (docs mirror or scripts/fetch-reference.sh)'
/** The four files of a partner case under the tab names of the G pages. */
function partnerTabs(n: number): Record<string, string> {
  const f = (file: string) => sample(PARTNER, `case${n}_${file}`)!
  return {
    'Payment Request': f('pain.001.xml'), 'Payment Response 1': f('pain.002_ACSP.xml'),
    'Payment Response 2': f('pain.002_ACSC.xml'), 'Transaction Notification': f('CAMT.054.001.02.xml'),
  }
}
/** The account owner of the samples (camt.054 Ownr: "Connect Demo Customer 1", 12340001). */
const DEMO = { code: '12340001', country: 'EE', name: 'Connect Demo Customer 1' }
/** The EE host as LHV's test environment: its BIC and name; the sample IBANs fail the checksum (decision 952). */
async function testEnvironment(iban: string): Promise<Ctx> {
  const s = seed()
  s.bank = { bic: 'LHVBEE20', name: 'AS LHV Pank' }
  s.customers.push({ ...DEMO, accounts: [{ iban, balances: { EUR: '10.00' } }] } as any)
  return setup({ strictIban: false }, s)
}

const N = 'BkToCstmrDbtCdtNtfctn/Ntfctn/Ntry/NtryDtls/TxDtls'
/** pain.002 GrpHdr/InitgPty: the samples echo the request's, the emulator names the bank (decision 954). */
const initgPty = (psp: 1 | 2) => [`~CstmrPmtStsRpt/GrpHdr/InitgPty/Id/OrgId/AnyBIC: "PSP${psp}CCCCXXX" != "LHVBEE20"`]
// What the partner camt.054 samples have and the emulator does not write (decision 954).
const CDTR_ADR = `-${N}/RltdPties/Cdtr/PstlAdr` // an empty <PstlAdr/>
const CDTR_ID = `-${N}/RltdPties/Cdtr/Id` // the creditor's LEI as Othr with SchmeNm LEI
const CDTR_AGT = `-${N}/RltdAgts/CdtrAgt` // the creditor bank by BIC and name, from the IBAN
// The emulator writes ValDt; no published EE camt.054.001.02 sample has it (decision 954).
const VALDT = '+BkToCstmrDbtCdtNtfctn/Ntfctn/Ntry/ValDt'
// The ultimate parties of the request the emulator echoes (decision 841) and the shared camt.054 of cases 3–8 lacks (decision 953).
const ULTMT_DBTR = `+${N}/RltdPties/UltmtDbtr`
const ULTMT_CDTR = `+${N}/RltdPties/UltmtCdtr`
/** The recorded divergences of each case: pain.002 ACSP and ACSC alike, then the camt.054 in document order. */
const PARTNER_DIVERGENCES: Record<number, { pain002: string[]; camt: string[] }> = {
  // The responses are of the 2023-10-10 run (the request repaired to it), whose request had NOTPROVIDED, the creditor's LEI and no UltmtCdtr.
  1: { pain002: initgPty(1), camt: [`+${N}/Refs/EndToEndId`, CDTR_ADR, CDTR_ID, ULTMT_CDTR, CDTR_AGT, VALDT] },
  // The camt.054 is of a request with another Ultimate Debtor ("of PSP2", identified by its LEI).
  2: { pain002: initgPty(1), camt: [
    `~${N}/RltdPties/UltmtDbtr/Nm: "Business Customer of PSP2" != "Business Customer of PSP1"`,
    `-${N}/RltdPties/UltmtDbtr/Id`, `+${N}/RltdPties/UltmtDbtr/PstlAdr`, CDTR_ADR, CDTR_AGT, VALDT,
  ] },
  3: { pain002: initgPty(2), camt: [CDTR_ADR, CDTR_ID, ULTMT_DBTR, CDTR_AGT, VALDT] },
  4: { pain002: initgPty(1), camt: [CDTR_ADR, CDTR_ID, CDTR_AGT, VALDT] },
  5: { pain002: initgPty(2), camt: [CDTR_ADR, CDTR_ID, ULTMT_DBTR, ULTMT_CDTR, CDTR_AGT, VALDT] },
  6: { pain002: initgPty(2), camt: [CDTR_ADR, CDTR_ID, ULTMT_DBTR, ULTMT_CDTR, CDTR_AGT, VALDT] },
  7: { pain002: initgPty(1), camt: [CDTR_ADR, CDTR_ID, ULTMT_CDTR, CDTR_AGT, VALDT] },
  // The camt.054 names another creditor account than the request.
  8: { pain002: initgPty(1), camt: [
    CDTR_ADR, CDTR_ID, `~${N}/RltdPties/CdtrAcct/Id/IBAN: "PL97109013910000000109909666" != "PL97109013910000000112345678"`,
    ULTMT_DBTR, ULTMT_CDTR, CDTR_AGT, VALDT,
  ] },
}

describe('PSP use cases (partner site PAYMENT_PSP_USECASES samples)', { skip: NO_PARTNER }, () => {
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
    test(`case ${n}: replayed on the EE host, the published pain.002 ACSP, ACSC and camt.054`, async () => {
      const t = partnerTabs(n)
      let request = t['Payment Request']
      if (n === 1) {
        // Repair (decision 953): case 1's request is of the 2023-10-05 run, its three responses of the 2023-10-10 run.
        assert.match(request, /MSGIDTEST2023-10-05T11:14:06/)
        assert.match(t['Payment Response 1'], /MSGIDTEST2023-10-10T11:42:16/)
        request = request.replaceAll('2023-10-05T11:14:06', '2023-10-10T11:42:16').replace('<Dt>2023-10-05</Dt>', '<Dt>2023-10-10</Dt>')
      }
      const iban = /<DbtrAcct>\s*<Id>\s*<IBAN>([A-Z0-9]+)</.exec(request)![1]
      const creditor = /<CdtrAcct>\s*<Id>\s*<IBAN>([A-Z0-9]+)</.exec(request)![1]
      const ctx = await testEnvironment(iban)
      // The published payments went by SEPA: the creditor bank is not instant-reachable (cases 1, 2 ask for no scheme).
      assert.equal((await call(ctx, { method: 'POST', url: '/_sim/rails/no-instant', body: { account: creditor } })).statusCode, 200)
      const d = await outgoing({ ctx, as: DEMO.code, tabs: t, request })
      const want = PARTNER_DIVERGENCES[n]
      same(d, { acsp: want.pain002, acsc: want.pain002, camt: want.camt })
      assert.equal((ctx.emulator.rails as any).sent[0].scheme, 'SEPA')
    })
  }
})
