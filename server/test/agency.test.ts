// S6, indirect scheme access (decisions 800–811): agency account synchronisation v1 (XML,
// both hosts, bank codes) and v2 (JSON, UK host), the agency account store, the CoP and VoP
// responder notifications and the RTF deliveries. Every XML message is checked against
// account.agent.sync.xsd, every JSON one with ajv against ssot/json-schemas; the published
// samples (P 11, G) are replayed through the operations.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { beforeEach, describe, test } from 'node:test'
import { agencyKey, rangeFor, receivable } from '../src/agency/store.js'
import { t2Directory } from '../src/agency/rtf.js'
import { makeIban } from '../src/iban.js'
import { parseXml } from '../src/xml.js'
import type { UkRequest } from '../src/webhooks/uk.js'
import { C1, MIRROR_DIR, call, drain, jsonInvalid, jsonValid, seed, setup, xsd, type Ctx } from './helpers.js'

const G = 'docs/gitbook/connect/services'
const page = (p: string) => { const f = join(MIRROR_DIR, p); return existsSync(f) ? readFileSync(f, 'utf8') : '' }
const SYNC_PAGE = page(`${G}/indirect-scheme-access/agency-account-synchronization.md`)
const P11 = page('docs/partners/11-indirect-scheme-access.md')
const xmlBlocks = (text: string, root: string) => [...text.matchAll(/```xml\n([\s\S]*?)```/g)].map((m) => m[1].trim()).filter((x) => x.includes(`<${root}>`))
/** JSON as published; the G OK sample stops before its closing `]}`, which is added back. */
function loose(raw: string): any {
  for (const fix of [(s: string) => s, (s: string) => `${s.trimEnd()}\n  ]\n}`]) {
    try { return JSON.parse(fix(raw)) } catch { /* next */ }
  }
  throw new Error(`unparseable sample: ${raw.slice(0, 200)}`)
}
const jsonBlocks = (text: string) => [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => loose(m[1]))
/** G responder samples: the code blocks of the three tabs (one in a <pre> with <strong> tags). */
function responderSamples(p: string): any[] {
  const text = page(p)
  const fenced = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1])
  const pre = [...text.matchAll(/<code class="lang-json">([\s\S]*?)<\/code>/g)].map((m) => m[1].replace(/<\/?strong>/g, '').replace(/&#x3C;/g, '<'))
  return [...fenced, ...pre].map((s) => JSON.parse(s))
}

const GBM = makeIban('GB', 'LHVB04031400007777')
const EEM = makeIban('EE', '7700771001260199')
const AG = { code: '09870001', country: 'GB', name: 'Agent Payments Ltd' }
const AG2 = { code: '09870002', country: 'GB', name: 'Other Agent Ltd' }
const FR = makeIban('FR', '10278067010002005307633')
const SETUP = {
  agreement: true, cop: true, vop: true, notifications: true, rtf: ['t2', 'rt1.in', 'step2.in'],
  ranges: [
    { country: 'GB', sortCode: '401276', master: GBM }, { country: 'GB', sortCode: '123456', master: GBM },
    { country: 'NL', bank: 'RABO', master: EEM }, { country: 'CY', master: EEM }, { country: 'FR', bank: '10278', master: EEM, bic: 'CCBPFRPPMTZ' },
  ],
}

let ctx: Ctx
let ee: Ctx
let sent: UkRequest[]
beforeEach(async () => {
  sent = []
  const s = seed()
  s.customers.push(
    { ...AG, accounts: [{ iban: GBM, balances: { GBP: '100.00' } }, EEM], agency: SETUP } as any,
    { ...AG2, accounts: [makeIban('GB', 'LHVB04031400008888')], agency: { agreement: true, ranges: [{ country: 'GB', sortCode: '777777', master: makeIban('GB', 'LHVB04031400008888') }] } } as any,
  )
  ctx = await setup({ ukWebhookDeliver: async (r) => { sent.push(r); return { status: 200, contentLength: 2 } } }, s, { flavour: 'UK' })
  ee = await setup({}, s)
})

const accounts = (c: Ctx = ctx) => c.emulator.agency.accounts
/** Every message of a customer, read and deleted. */
const inbox = (as = AG.code, c: Ctx = ctx) => drain(c, as)
async function one(as = AG.code, c: Ctx = ctx) {
  const msgs = await inbox(as, c)
  assert.equal(msgs.length, 1, JSON.stringify(msgs.map((m) => m.type)))
  return msgs[0]
}
/** POSTs a v1 sync and returns the AGENT_ACCOUNT_SYNC message, XSD-checked unless it is <Errors>. */
async function syncXml(body: string, o: { c?: Ctx; headers?: Record<string, string>; as?: string } = {}) {
  const c = o.c ?? ctx
  const r = await call(c, { method: 'POST', url: '/agent/account/synchronize', body, as: o.as ?? AG.code, headers: o.headers })
  assert.equal(r.statusCode, 202, r.body)
  const id = String(r.headers['message-request-id'])
  assert.match(id, /^REQ[0-9a-f]{32}$/)
  const m = await one(o.as ?? AG.code, c)
  assert.equal(m.type, 'AGENT_ACCOUNT_SYNC')
  assert.equal(m.requestId, id)
  if (m.doc.AgentAccountSyncResponse && xsd.has('account.agent.sync')) assert.deepEqual(await xsd.validate(m.body, 'account.agent.sync'), [])
  return { ...m, xKey: r.headers['x-bank-code'] }
}
const errorsOf = (doc: any) => [doc.Errors.Error].flat().map((e: any) => [e.ErrorCode, e.Field ?? null])
const accountsOf = (doc: any) => [doc.AgentAccountSyncResponse.Accounts.Account].flat()
const v1 = (accts: string, bankCodes?: string[]) => `<?xml version="1.0" encoding="UTF-8"?>
<AgentAccountSyncRequest>${bankCodes ? `<BankCodes>${bankCodes.map((b) => `<BankCode>${b}</BankCode>`).join('')}</BankCodes>` : ''}<Accounts>${accts}</Accounts></AgentAccountSyncRequest>`
const acct = (o: { region?: string; no?: string; iban?: string; status?: string; name?: string; extra?: string }) =>
  `<Account><Region>${o.region ?? 'GB'}</Region>${o.no ? `<AccountNo>${o.no}</AccountNo>` : ''}${o.iban ? `<Iban>${o.iban}</Iban>` : ''}${o.status ? `<Status>${o.status}</Status>` : ''}${o.name ? `<Name>${o.name}</Name>` : ''}${o.extra ?? ''}</Account>`

async function syncJson(body: unknown, o: { as?: string; schema?: boolean } = {}) {
  if (o.schema !== false) jsonValid('agent-account-sync-v2.request', body)
  const r = await call(ctx, { method: 'POST', url: '/v2/agent/account/synchronize', body: body as object, as: o.as ?? AG.code })
  assert.equal(r.statusCode, 202, r.body)
  const m = await one(o.as ?? AG.code)
  assert.equal(m.type, 'AGENT_ACCOUNT_SYNC')
  assert.equal(m.requestId, r.headers['message-request-id'])
  const j = jsonValid('agent-account-sync-v2.response', m.body)
  assert.equal(j.OriginalMsgId, m.requestId)
  return j
}
const gb = (id: string, more: object = {}) => ({ Country: 'GB', Identification: id, Name: 'Jane Holder', AccountCategory: 'PERSONAL', ...more })

// --- v1: samples and the response ---------------------------------------------------------

describe('agent.account.sync (v1, XML)', () => {
  test('the published request and response samples are valid against account.agent.sync.xsd', async (t) => {
    const reqs = [...xmlBlocks(SYNC_PAGE, 'AgentAccountSyncRequest'), ...xmlBlocks(P11, 'AgentAccountSyncRequest')]
    const resps = xmlBlocks(SYNC_PAGE, 'AgentAccountSyncResponse')
    if (!reqs.length || !xsd.has('account.agent.sync')) return t.skip('no docs mirror')
    assert.ok(reqs.length >= 7 && resps.length >= 1)
    for (const x of [...reqs, ...resps]) assert.deepEqual(await xsd.validate(x, 'account.agent.sync'), [], x)
  })

  test('every published request sample is answered: accounts, or INVALID_IBAN for the samples with wrong check digits', async () => {
    const reqs = [...xmlBlocks(SYNC_PAGE, 'AgentAccountSyncRequest'), ...xmlBlocks(P11, 'AgentAccountSyncRequest')]
    const bad = ['NL91RAB00417164300', 'CY46002001280000001200527700']
    for (const x of reqs) {
      const m = await syncXml(x)
      if (bad.some((b) => x.includes(b))) assert.ok(errorsOf(m.doc).every(([c]: string[]) => c === 'INVALID_IBAN'), m.body)
      else assert.equal(accountsOf(m.doc).length, [...x.matchAll(/<Account>/g)].length, m.body)
    }
  })

  test('the G UK bank code sample gets exactly the G successful response, synced to LHV UK only', async (t) => {
    const req = xmlBlocks(SYNC_PAGE, 'AgentAccountSyncRequest').find((x) => x.includes('LHVBGB2L') && !x.includes('LHVBEE22'))
    const resp = xmlBlocks(SYNC_PAGE, 'AgentAccountSyncResponse')[0]
    if (!req) return t.skip('no docs mirror')
    const m = await syncXml(req)
    assert.equal(m.xKey, 'LHVUK')
    assert.deepEqual(m.doc, parseXml(resp))
    assert.equal(accounts().get('LHVUK', '40127612345678')?.status, 'ACTIVE')
    assert.equal(accounts().get('LHVEE', '40127612345678'), undefined)
    assert.equal(accounts().get('LHVUK', '40127612345678')?.master, GBM)
  })

  test('bank codes: none is LHV EE, LHVBEE22 EE, LHVBGB2L(XXX) UK, both codes both entities', async () => {
    await syncXml(v1(acct({ no: '40127600000001' })))
    assert.deepEqual(accounts().find('40127600000001').map((a) => a.bank), ['LHVEE'])
    await syncXml(v1(acct({ no: '40127600000002' }), ['LHVBGB2LXXX']))
    assert.deepEqual(accounts().find('40127600000002').map((a) => a.bank), ['LHVUK'])
    await syncXml(v1(acct({ no: '40127600000003' }), ['LHVBEE22XXX', 'LHVBGB2L']))
    assert.deepEqual(accounts().find('40127600000003').map((a) => a.bank), ['LHVEE', 'LHVUK'])
  })

  test('an unsupported bank code, a UK code on the EE host or handed to LHV EE, three codes: INVALID_REQUEST, nothing stored', async () => {
    let m = await syncXml(v1(acct({ no: '40127600000004' }), ['DEUTDEFF']))
    assert.deepEqual(errorsOf(m.doc), [['INVALID_REQUEST', 'BankCodes.BankCode']])
    m = await syncXml(v1(acct({ no: '40127600000004' }), ['LHVBGB2L']), { c: ee })
    assert.deepEqual(errorsOf(m.doc), [['INVALID_REQUEST', 'BankCodes.BankCode']])
    m = await syncXml(v1(acct({ no: '40127600000004' }), ['LHVBGB2L']), { headers: { 'x-bank-code': 'LHVEE' } })
    assert.equal(m.xKey, 'LHVEE')
    assert.deepEqual(errorsOf(m.doc), [['INVALID_REQUEST', 'BankCodes.BankCode']])
    m = await syncXml(v1(acct({ no: '40127600000004' }), ['LHVBGB2L', 'LHVBEE22', 'LHVBEE22XXX']))
    assert.deepEqual(errorsOf(m.doc), [['INVALID_REQUEST', 'BankCodes.BankCode']])
    assert.deepEqual(accounts().find('40127600000004'), [])
    // The EE host takes LHV EE codes and no codes.
    m = await syncXml(v1(acct({ iban: 'NL32RABO0195610843', region: 'NL' }), ['LHVBEE22']), { c: ee })
    assert.equal(accountsOf(m.doc).length, 1)
    assert.equal(accounts(ee).get('LHVEE', 'NL32RABO0195610843')?.master, EEM)
  })

  test('errors: one per problem, all at once, the whole bulk refused', async () => {
    const m = await syncXml(v1([
      acct({ no: '40127600000010' }),
      acct({ region: 'US', iban: 'NL32RABO0195610843' }),
      acct({ region: 'NL', no: '40127600000011' }),
      acct({ region: 'NL', iban: 'NL32RABO0195610844' }),
      acct({ region: 'DE', iban: 'NL32RABO0195610843' }),
      acct({ no: '40127600000012', iban: makeIban('GB', 'LHVB40127600000013') }),
      acct({ no: '99999900000001' }),
      acct({ no: '401276000000' }),
      acct({ no: '40127600000014', status: 'INST_RESTRICTED' }),
      acct({ no: '40127600000015', extra: '<Colour>red</Colour>' }),
      acct({ region: 'gb', no: '40127600000016' }),
      acct({ no: '40127600000017', name: 'x'.repeat(141) }),
    ].join('')))
    assert.deepEqual(errorsOf(m.doc), [
      ['INVALID_REGION', 'account[1].Region'],
      ['INVALID_ACCOUNT_NO_OR_IBAN', 'account[2].AccountNo, account[2].Iban'],
      ['INVALID_IBAN', 'account[3].Iban'],
      ['INVALID_REGION', 'account[4].Region'],
      ['ACCOUNT_NO_AND_IBAN_MISMATCH', 'account[5].AccountNo, account[5].Iban'],
      ['MASTER_ACCOUNT_NOT_FOUND', 'account[6].AccountNo, account[6].Iban'],
      ['INVALID_ACCOUNT_NO_OR_IBAN', 'account[7].AccountNo'],
      ['INVALID_REQUEST', 'account[8].Status'],
      ['INVALID_REQUEST', 'account[9].Colour'],
      ['INVALID_REQUEST', 'account[10].Region'],
      ['INVALID_REQUEST', 'account[11].Name'],
    ])
    assert.equal([m.doc.Errors.Error].flat()[0].Description, 'Invalid Region.')
    assert.equal(accounts().size, 0)
  })

  test('not XML, another root, no accounts, over 1000: INVALID_REQUEST', async () => {
    for (const [body, field] of [
      ['not xml', null], ['<Other/>', null], [v1(''), 'Accounts.Account'],
      ['<AgentAccountSyncRequest/>', 'Accounts'], [v1(acct({ no: '40127600000001' }).repeat(1001)), 'Accounts.Account'],
    ] as const) {
      const m = await syncXml(body)
      assert.deepEqual(errorsOf(m.doc), [['INVALID_REQUEST', field]], body.slice(0, 80))
      if (field === null) assert.equal(m.doc.Errors.Error.Description, 'Invalid request.')
    }
  })

  test('updates: an empty status keeps the account\'s, Name replaces, CLOSED and back to ACTIVE; the last duplicate wins', async () => {
    let m = await syncXml(v1(acct({ no: '40127600000020', name: 'JOHN DOE' }), ['LHVBGB2L']))
    assert.deepEqual(accountsOf(m.doc), [{ Region: 'GB', AccountNo: '40127600000020', Status: 'ACTIVE', Name: 'JOHN DOE' }])
    m = await syncXml(v1(acct({ no: '40127600000020', status: 'CLOSED' }), ['LHVBGB2L']))
    assert.deepEqual(accountsOf(m.doc), [{ Region: 'GB', AccountNo: '40127600000020', Status: 'CLOSED' }])
    m = await syncXml(v1(acct({ iban: makeIban('GB', 'LHVB40127600000020') }), ['LHVBGB2L']))
    assert.equal(accountsOf(m.doc)[0].Status, 'CLOSED')
    const a = accounts().get('LHVUK', '40127600000020')!
    assert.equal(a.name, 'JOHN DOE')
    assert.equal(a.iban, makeIban('GB', 'LHVB40127600000020'))
    m = await syncXml(v1(acct({ no: '40127600000020', status: 'CLOSED' }) + acct({ no: '40127600000020', status: 'ACTIVE', name: 'JANE DOE' }), ['LHVBGB2L']))
    assert.equal(accountsOf(m.doc).length, 2)
    assert.equal(accounts().get('LHVUK', '40127600000020')?.status, 'ACTIVE')
    assert.equal(accounts().get('LHVUK', '40127600000020')?.name, 'JANE DOE')
  })

  test('an INST_RESTRICTED account (set by v2) is answered by v1 without Status, XSD-valid', async () => {
    await syncJson({ Accounts: [gb('40127600000030', { Status: 'INST_RESTRICTED' })] })
    const m = await syncXml(v1(acct({ no: '40127600000030' }), ['LHVBGB2L']))
    assert.deepEqual(accountsOf(m.doc), [{ Region: 'GB', AccountNo: '40127600000030' }])
    assert.equal(accounts().get('LHVUK', '40127600000030')?.status, 'INST_RESTRICTED')
  })

  test('another agent\'s account is not taken over; a customer without the agreement gets 403', async () => {
    await syncXml(v1(acct({ no: '77777700000001' }), ['LHVBGB2L']), { as: AG2.code })
    const m = await syncXml(v1(acct({ no: '77777700000001' }), ['LHVBGB2L']))
    assert.deepEqual(errorsOf(m.doc), [['MASTER_ACCOUNT_NOT_FOUND', 'account[0].AccountNo, account[0].Iban']])
    for (const [url, body] of [['/agent/account/synchronize', v1(acct({ no: '40127600000001' }))], ['/v2/agent/account/synchronize', JSON.stringify({ Accounts: [gb('40127600000001')] })]]) {
      const r = await call(ctx, { method: 'POST', url, body, as: C1.code, contentType: url.startsWith('/v2') ? 'application/json' : 'application/xml' })
      assert.equal(r.statusCode, 403, r.body)
      assert.match(r.body, /FORBIDDEN/)
    }
    assert.deepEqual(await inbox(C1.code), [])
  })
})

// --- v2 -------------------------------------------------------------------------------------

describe('agent.account.sync.v2 (JSON, UK host)', () => {
  test('the published response samples are valid against the ssot schema', (t) => {
    const blocks = jsonBlocks(SYNC_PAGE)
    if (!blocks.length) return t.skip('no docs mirror')
    const resps = blocks.filter((b) => 'AcceptanceStatus' in b)
    assert.deepEqual(resps.map((r) => r.AcceptanceStatus), ['OK', 'PARTIAL', 'FAILED'])
    for (const r of resps) jsonValid('agent-account-sync-v2.response', r)
    jsonValid('agent-account-sync-v2.request', blocks.find((b) => 'Accounts' in b && !('AcceptanceStatus' in b)))
  })

  test('the G request example gets the G PARTIAL answer: the new CLOSED account is NOT_FOUND', async (t) => {
    const blocks = jsonBlocks(SYNC_PAGE)
    if (!blocks.length) return t.skip('no docs mirror')
    const req = blocks.find((b) => 'Accounts' in b && !('AcceptanceStatus' in b))
    const partial = blocks.find((b) => b.AcceptanceStatus === 'PARTIAL')
    const j = await syncJson(req)
    assert.deepEqual({ ...j, OriginalMsgId: '' }, partial)
    const a = accounts().get('LHVUK', '12345612345678')!
    assert.deepEqual([a.name, a.category, a.copOptOut, a.status, a.accountNo, a.iban], ['Account Name First', 'PERSONAL', false, 'ACTIVE', '12345612345678', undefined])
    assert.equal(accounts().get('LHVUK', '12345687654321'), undefined)
    // Synchronised as open first, the same account can then be closed and opted out.
    const k = await syncJson({ ...req, Accounts: [{ ...req.Accounts[1], Status: 'ACTIVE' }, req.Accounts[1]] })
    assert.equal(k.AcceptanceStatus, 'PARTIAL')
    assert.equal(k.Accounts[1].ErrorInfo.ErrorCode, 'DUPLICATE_ACCOUNT')
    const ok = await syncJson(req)
    assert.equal(ok.AcceptanceStatus, 'OK')
    assert.equal(accounts().get('LHVUK', '12345687654321')?.status, 'CLOSED')
  })

  test('per-account errors in order, OK / PARTIAL / FAILED from the confirmations', async () => {
    const list = [
      gb('40127600000040'),
      { ...gb('40127600000041'), Country: 'US' },
      gb('4012760000004'),
      { Country: 'NL', Identification: '0195610843', Name: 'N', AccountCategory: 'BUSINESS' },
      { Country: 'NL', Identification: 'NL32RABO0195610844', Name: 'N', AccountCategory: 'BUSINESS' },
      { Country: 'DE', Identification: 'NL32RABO0195610843', Name: 'N', AccountCategory: 'BUSINESS' },
      gb('40127600000042', { Status: 'OPEN' }),
      gb('40127600000043', { Name: 'x'.repeat(141) }),
      gb('40127600000044', { Name: undefined }),
      gb('40127600000045', { AccountCategory: undefined }),
      gb(makeIban('GB', 'LHVB40127600000040')),
      gb('99999900000001'),
      gb('40127600000046', { Status: 'CLOSED' }),
      gb('40127600000047', { AccountCategory: 'CHARITY' }),
    ]
    const j = await syncJson({ BankCodes: ['LHVBGB2L'], Accounts: list }, { schema: false })
    assert.equal(j.AcceptanceStatus, 'PARTIAL')
    assert.deepEqual(j.Accounts.map((a: any) => a.ErrorInfo?.ErrorCode ?? 'OK'), [
      'OK', 'INVALID_REGION', 'INVALID_ACCOUNT_NO_OR_IBAN', 'IBAN_MUST_EXIST_FOR_THIS_REGION', 'INVALID_IBAN', 'IBAN_AND_REGION_MISMATCH',
      'INVALID_ACCOUNT_STATUS', 'NAME_TOO_LONG', 'CONFIRMATION_OF_PAYEE_NAME_NOT_PROVIDED', 'CONFIRMATION_OF_PAYEE_ACCOUNT_CATEGORY_NOT_PROVIDED',
      'DUPLICATE_ACCOUNT', 'MASTER_ACCOUNT_NOT_FOUND', 'NOT_FOUND', 'CONFIRMATION_OF_PAYEE_ACCOUNT_CATEGORY_NOT_PROVIDED',
    ])
    assert.equal(j.Accounts[7].ErrorInfo.ErrorDescription, 'Name can be max 140 characters long.')
    assert.equal(j.Accounts[0].Data.Status, 'ACTIVE')
    assert.equal(j.Accounts[6].Data.Status, undefined)
    assert.equal(j.Accounts[7].Data.Name, undefined)
    const all = await syncJson({ Accounts: [gb('99999900000001')] })
    assert.equal(all.AcceptanceStatus, 'FAILED')
    assert.equal(all.Errors, undefined)
  })

  test('Name and AccountCategory are optional when the agent has no CoP/VoP responder; CoPOptOut is read, CopOptOut written', async () => {
    const put = await call(ctx, { method: 'PUT', url: `/_sim/agency/agents/GB/${AG.code}`, as: null, body: { ...SETUP, cop: false, vop: false } })
    assert.equal(put.statusCode, 200, put.body)
    const j = await syncJson({ Accounts: [{ Country: 'GB', Identification: '40127600000050', CoPOptOut: true }] })
    assert.equal(j.AcceptanceStatus, 'OK')
    assert.deepEqual(j.Accounts[0].Data, { Country: 'GB', Identification: '40127600000050', Status: 'ACTIVE', CopOptOut: true })
    assert.equal(accounts().get('LHVUK', '40127600000050')?.copOptOut, true)
    // A GB IBAN is the same account as its sort code and account number.
    const k = await syncJson({ Accounts: [{ Country: 'GB', Identification: makeIban('GB', 'NWBK40127600000050'), Status: 'CLOSED' }] })
    assert.equal(k.AcceptanceStatus, 'OK')
    assert.equal(accounts().get('LHVUK', '40127600000050')?.status, 'CLOSED')
    assert.equal(accounts().get('LHVUK', '40127600000050')?.copOptOut, true)
  })

  test('FAILED for the whole file: not JSON, schema violations, unsupported bank codes, over 1000 accounts', async () => {
    const cases: [unknown, string][] = [
      ['{"Accounts": [', 'INVALID_JSON_REQUEST'], [[], 'INVALID_JSON_REQUEST'], [{}, 'INVALID_JSON_REQUEST'], [{ Accounts: [] }, 'INVALID_JSON_REQUEST'],
      [{ Accounts: [{ Country: 'GB' }] }, 'INVALID_JSON_REQUEST'], [{ Accounts: [gb('40127600000060', { CopOptOut: 'yes' })] }, 'INVALID_JSON_REQUEST'],
      [{ Accounts: [gb('40127600000060', { Name: 5 })] }, 'INVALID_JSON_REQUEST'],
      [{ BankCodes: ['LHVBEE22'], Accounts: [gb('40127600000060')] }, 'INVALID_JSON_REQUEST'], [{ BankCodes: 'LHVBGB2L', Accounts: [gb('40127600000060')] }, 'INVALID_JSON_REQUEST'],
      [{ Accounts: Array.from({ length: 1001 }, (_, i) => gb(`401276${String(i).padStart(8, '0')}`)) }, 'ACCOUNTS_OVER_MAXIMUM_ALLOWED_LIMIT'],
    ]
    for (const [body, code] of cases) {
      // Schema violations except an empty list and an LHV EE bank code, which the schema allows.
      if (typeof body !== 'string' && code === 'INVALID_JSON_REQUEST' && (body as any).Accounts?.length !== 0 && !(body as any).BankCodes?.[0]?.startsWith('LHVBEE')) jsonInvalid('agent-account-sync-v2.request', body)
      const r = await call(ctx, { method: 'POST', url: '/v2/agent/account/synchronize', body: typeof body === 'string' ? body : JSON.stringify(body), contentType: 'application/json', as: AG.code })
      assert.equal(r.statusCode, 202)
      const j = jsonValid('agent-account-sync-v2.response', (await one()).body)
      assert.equal(j.AcceptanceStatus, 'FAILED')
      assert.deepEqual(j.Accounts, [])
      assert.equal(j.Errors[0].Code, code, JSON.stringify(j))
    }
    assert.equal(accounts().size, 0)
  })

  test('v2 is a UK host service: 404 on the EE host and with X-Bank-Code: LHVEE', async () => {
    const body = JSON.stringify({ Accounts: [gb('40127600000070')] })
    const a = await call(ee, { method: 'POST', url: '/v2/agent/account/synchronize', body, contentType: 'application/json', as: AG.code })
    assert.equal(a.statusCode, 404)
    const b = await call(ctx, { method: 'POST', url: '/v2/agent/account/synchronize', body, contentType: 'application/json', as: AG.code, headers: { 'x-bank-code': 'LHVEE' } })
    assert.equal(b.statusCode, 404)
  })

  test('the sync answer is a UK webhook of type AGENT_ACCOUNT_SYNC; v2 metadata is empty', async () => {
    const s = await call(ctx, { method: 'POST', url: '/notifications/subscription', as: AG.code, body: { messageType: 'AGENT_ACCOUNT_SYNC', requestUrl: 'https://hooks.example.org/lhv', active: true, attachFullBody: true } })
    assert.equal(s.statusCode, 200, s.body)
    await syncJson({ Accounts: [gb('40127600000080')] })
    await ctx.emulator.webhooksUk.idle()
    assert.equal(sent.length, 1)
    const hook = jsonValid('webhook-uk-payload', sent[0].body.toString('utf8'))
    assert.equal(hook.messageType, 'AGENT_ACCOUNT_SYNC')
    assert.equal(JSON.parse(Buffer.from(hook.messageBase64, 'base64').toString('utf8')).AcceptanceStatus, 'OK')
  })
})

// --- Store ------------------------------------------------------------------------------------

describe('agency account store', () => {
  test('keys, lookups across entities, ranges and what is receivable', async () => {
    assert.equal(agencyKey(makeIban('GB', 'ABCD40127600000001')), '40127600000001')
    assert.equal(agencyKey('40127600000001'), '40127600000001')
    assert.equal(agencyKey('nl32 rabo 0195 6108 43'), 'NL32RABO0195610843')
    assert.equal(agencyKey('INV-42'), undefined)
    await syncXml(v1(acct({ no: '40127600000090', name: 'JOHN DOE' }), ['LHVBGB2L', 'LHVBEE22']))
    assert.deepEqual(accounts().find(makeIban('GB', 'LHVB40127600000090')).map((a) => [a.bank, a.agent.code, a.master]), [['LHVEE', AG.code, GBM], ['LHVUK', AG.code, GBM]])
    assert.deepEqual(accounts().ofAgent(AG, 'LHVUK').map((a) => a.id), ['40127600000090'])
    const setup = ctx.emulator.directory.get(AG)!.agency
    assert.equal(rangeFor(setup, 'NL32RABO0195610843')?.master, EEM)
    assert.equal(rangeFor(setup, 'NL91ABNA0417164300'), undefined)
    assert.equal(rangeFor(setup, FR)?.bic, 'CCBPFRPPMTZ')
    assert.equal(rangeFor(undefined, '40127600000090'), undefined)
    const a = accounts().get('LHVUK', '40127600000090')!
    assert.ok(receivable(a, { instant: true }))
    assert.ok(receivable({ ...a, status: 'INST_RESTRICTED' }, { instant: false }))
    assert.ok(!receivable({ ...a, status: 'INST_RESTRICTED' }, { instant: true }))
    assert.ok(!receivable({ ...a, status: 'CLOSED' }, { instant: false }))
    const list = JSON.parse((await call(ctx, { url: `/_sim/agency/accounts?bank=LHVUK&agent=GB:${AG.code}`, as: null })).body)
    assert.deepEqual(list.accounts.map((x: any) => [x.bank, x.id, x.accountNo, x.status, x.name, x.master]), [['LHVUK', '40127600000090', '40127600000090', 'ACTIVE', 'JOHN DOE', GBM]])
  })

  test('the set-up is checked: master among the own accounts, sort codes for GB only', async () => {
    for (const body of [
      { agreement: true, ranges: [{ country: 'GB', sortCode: '401276', master: EEM.replace('EE', 'DE') }] },
      { agreement: true, ranges: [{ country: 'NL', sortCode: '401276', master: EEM }] },
      { agreement: true, ranges: [{ country: 'GB', bank: 'LHVB', master: GBM }] },
      { agreement: 'yes' }, { rtf: ['swift'] }, { colour: 'red' },
    ]) {
      const r = await call(ctx, { method: 'PUT', url: `/_sim/agency/agents/GB/${AG.code}`, as: null, body })
      assert.equal(r.statusCode, 400, JSON.stringify(body))
    }
    const r = await call(ctx, { method: 'PUT', url: `/_sim/agency/agents/GB/${AG.code}`, as: null, body: {} })
    assert.deepEqual(JSON.parse(r.body), { agency: null })
    assert.equal((await call(ctx, { url: '/_sim/agency/agents/GB/00000000', as: null })).statusCode, 404)
  })
})

// --- Responders ------------------------------------------------------------------------------

const COP_PAGE = `${G}/confirmation-of-payee-services/confirmation-of-payee-responder.md`
const VOP_PAGE = `${G}/verification-of-payee-services/verification-of-payee-responder.md`
const sim = async (url: string, body: object, c: Ctx = ctx) => {
  const r = await call(c, { method: 'POST', url: `/_sim/agency${url}`, body, as: null })
  assert.equal(r.statusCode, 200, r.body)
  return JSON.parse(r.body)
}

describe('cop.incoming (CONFIRMATION_OF_PAYEE_INCOMING)', () => {
  test('the three G samples are reproduced from synced accounts and delivered to the agent', async (t) => {
    const samples = responderSamples(COP_PAGE)
    if (!samples.length) return t.skip('no docs mirror')
    assert.equal(samples.length, 3)
    for (const s of samples) jsonValid('payee-check-incoming', s)
    await syncJson({ Accounts: [gb('12345612345678', { Name: 'Joe Bloggs' })] })
    for (const s of samples) {
      const a = s.Request.Data[0].Attributes
      const r = await sim('/cop-incoming', {
        sortCode: a.BankId, accountNumber: a.AccountNumber, name: a.Name[0], accountClassification: a.AccountClassification,
        secondaryIdentification: a.SecondaryIdentification, requesterBankName: s.Request.DebtorParty.AccountWith.BankName,
      })
      assert.deepEqual(r.response.Response, s.Response)
      assert.deepEqual(r.response.Request.Data[0].Attributes, a)
      assert.deepEqual(r.response.Request.DebtorParty, s.Request.DebtorParty)
      const m = await one()
      assert.equal(m.type, 'CONFIRMATION_OF_PAYEE_INCOMING')
      assert.equal(r.notified.messageResponseId, m.id)
      assert.equal(m.requestId, undefined)
      assert.deepEqual(jsonValid('payee-check-incoming', m.body), r.response)
    }
  })

  test('category, opt-out, closed, no responder and no notifications', async () => {
    await syncJson({ Accounts: [gb('40127600000101', { Name: 'Acme Trading Ltd', AccountCategory: 'BUSINESS' }), gb('40127600000102', { CopOptOut: true }), gb('40127600000103')] })
    await syncJson({ Accounts: [gb('40127600000103', { Status: 'CLOSED' })] })
    const ask = async (accountNumber: string, name: string, accountClassification = 'PERSONAL') =>
      (await sim('/cop-incoming', { sortCode: '40-12-76', accountNumber, name, accountClassification })).response.Response.Data.Attributes
    assert.deepEqual(await ask('00000101', 'Acme Trading Ltd'), { Status: 'confirmed', Answer: 'REJECTED', ReasonCode: 'BANM', Reason: 'The account details match. However, it is a business account, not a personal account.' })
    assert.deepEqual(await ask('00000101', 'Acme Trading', 'BUSINESS'), { Status: 'confirmed', Answer: 'REJECTED', ActualName: 'Acme Trading Ltd', ReasonCode: 'MBAM', Reason: 'String is a close match to the account name' })
    assert.equal((await ask('00000101', 'Acme Tradng', 'PERSONAL')).ReasonCode, 'BAMM')
    assert.equal((await ask('00000101', 'Someone Else', 'BUSINESS')).ReasonCode, 'ANNM')
    assert.equal((await ask('00000102', 'Jane Holder')).ReasonCode, 'OPTO')
    assert.equal((await ask('00000103', 'Jane Holder')).ReasonCode, 'AC01')
    assert.equal((await inbox()).length, 6)
    // Not in any agreement range: answered, nobody notified.
    const r = await sim('/cop-incoming', { sortCode: '000000', accountNumber: '00000001', name: 'X' })
    assert.equal(r.notified, null)
    assert.equal(r.response.Response.Data.Attributes.ReasonCode, 'AC01')
    // Without the CoP responder: ACNS; without notifications: nothing in the inbox.
    await call(ctx, { method: 'PUT', url: `/_sim/agency/agents/GB/${AG.code}`, as: null, body: { ...SETUP, cop: false } })
    assert.equal((await ask('00000101', 'Acme Trading Ltd', 'BUSINESS')).ReasonCode, 'ACNS')
    await call(ctx, { method: 'PUT', url: `/_sim/agency/agents/GB/${AG.code}`, as: null, body: { ...SETUP, notifications: false } })
    assert.equal((await ask('00000101', 'Acme Trading Ltd', 'BUSINESS')).Answer, 'CONFIRMED')
    assert.deepEqual(await inbox(), [])
  })

  test('the notification is a UK webhook; the CoP trigger exists on the UK host only', async () => {
    await call(ctx, { method: 'POST', url: '/notifications/subscription', as: AG.code, body: { messageType: 'CONFIRMATION_OF_PAYEE_INCOMING', requestUrl: 'https://hooks.example.org/lhv', active: true } })
    await syncJson({ Accounts: [gb('40127600000110')] })
    await sim('/cop-incoming', { sortCode: '401276', accountNumber: '00000110', name: 'Jane Holder' })
    await ctx.emulator.webhooksUk.idle()
    assert.equal(jsonValid('webhook-uk-payload', sent[0].body.toString('utf8')).messageType, 'CONFIRMATION_OF_PAYEE_INCOMING')
    const r = await call(ee, { method: 'POST', url: '/_sim/agency/cop-incoming', body: { sortCode: '401276', accountNumber: '00000110', name: 'X' }, as: null })
    assert.equal(r.statusCode, 404)
    const bad = await call(ctx, { method: 'POST', url: '/_sim/agency/cop-incoming', body: { sortCode: '4012', accountNumber: '00000110', name: 'X' }, as: null })
    assert.equal(bad.statusCode, 400)
  })
})

describe('vop.incoming_notification (VERIFICATION_OF_PAYEE_INCOMING_NOTIFICATION)', () => {
  test('the three G samples are reproduced from an account synced with v1 Name to LHV EE', async (t) => {
    const samples = responderSamples(VOP_PAGE)
    if (!samples.length) return t.skip('no docs mirror')
    assert.equal(samples.length, 3)
    for (const s of samples) jsonValid('payee-check-incoming', s)
    // The sample IBAN FR7610278067010002005307633 has wrong check digits: the same account with right ones.
    await syncXml(v1(acct({ region: 'FR', iban: FR, name: 'Smith John' })))
    for (const s of samples) {
      const a = s.Request.Data[0].Attributes
      ctx.clock.set(a.RequestDtime)
      const r = await sim('/vop-incoming', { iban: FR, name: a.Name[0], requesterBic: a.RequesterBankId })
      const fold = (x: any) => ({ ...x, Reason: x.Reason.replace(/\.+$/, '.') })
      assert.deepEqual(fold(r.response.Response.Data.Attributes), fold(s.Response.Data.Attributes))
      assert.deepEqual(r.response.Request.Data[0].Attributes, { ...a, AccountNumber: FR })
      assert.equal(r.response.Request.Data[0].CreatedOn, s.Request.Data[0].CreatedOn)
      const m = await one()
      assert.equal(m.type, 'VERIFICATION_OF_PAYEE_INCOMING_NOTIFICATION')
      assert.deepEqual(jsonValid('payee-check-incoming', m.body), r.response)
    }
  })

  test('unknown, closed or nameless accounts and an agent without VoP: NOAP; on the EE host too', async () => {
    await syncXml(v1(acct({ region: 'NL', iban: 'NL32RABO0195610843' })), { c: ee })
    let r = await sim('/vop-incoming', { iban: 'NL32RABO0195610843', name: 'Anyone' }, ee)
    assert.equal(r.response.Response.Data.Attributes.ReasonCode, 'NOAP')
    assert.equal(r.notified.code, AG.code)
    r = await sim('/vop-incoming', { iban: 'DE89370400440532013000', name: 'Anyone' }, ee)
    assert.equal(r.notified, null)
    assert.deepEqual(r.response.Response.Data.Attributes, {
      Answer: 'REJECTED', Reason: 'We are currently unable to verify the account details. You can either try again in a few minutes or continue your payment without verification. If you continue, please double check the details.',
      ReasonCode: 'NOAP', Status: 'confirmed',
    })
    assert.equal(r.response.Request.Data[0].Attributes.BankId, 'LHVBEE22XXX')
    assert.equal((await inbox(AG.code, ee)).length, 1)
  })
})

// --- RTF -------------------------------------------------------------------------------------

describe('agent.report.rtf (AGENT_REPORT)', () => {
  const next = async (c: Ctx = ctx, as = AG.code) => {
    const r = await call(c, { url: '/messages/next', as })
    assert.equal(r.statusCode, 200)
    await call(c, { method: 'DELETE', url: `/messages/${r.headers['message-response-id']}`, as })
    return r
  }

  test('TARGET2: the emulator\'s own directory in the published fixed-width layout', async () => {
    const r = await call(ctx, { method: 'POST', url: '/_sim/agency/rtf', body: { scheme: 't2' }, as: null })
    assert.equal(r.statusCode, 201, r.body)
    assert.deepEqual(JSON.parse(r.body).messages.map((m: any) => [m.code, m.contentType]), [[AG.code, 'application/vnd.lhv.t2.rtf']])
    const m = await next()
    assert.equal(m.headers['message-response-type'], 'AGENT_REPORT')
    assert.equal(m.headers['content-type'], 'application/vnd.lhv.t2.rtf')
    const text = m.rawPayload.toString('utf8')
    assert.ok(text.startsWith('<File fileId = "RTGSEURFULL20260310" xmlns="urn:CRDM:RTGSDirectory">LHVBEE22XXXLHVBEE22XXXLHVBEE22XXXOPEN-BANKING EMULATOR '), text.slice(0, 200))
    assert.ok(text.endsWith('\n</File>\n'))
    // The published sample's records are 208 characters: three BICs, name 105, city 50, code, two dates, type.
    const line = text.split('\n')[0].replace(/^<File[^>]*>/, '')
    assert.equal(line.length, 208)
    assert.equal(line.slice(138, 188).trim(), 'TALLINN')
    assert.equal(line.slice(188), 'TU202603109999123101')
    assert.equal(t2Directory({ bic: 'LHVBEE22', name: 'open-banking emulator' }, '2026-03-10'), text)
  })

  test('RT1 is gzip-ed, other schemes as given; recipients by set-up; content required for the EBA schemes', async () => {
    const file = 'H RT1 participants\nLHVBEE22XXX\n'
    let r = await call(ctx, { method: 'POST', url: '/_sim/agency/rtf', body: { scheme: 'rt1.in', text: file }, as: null })
    assert.equal(r.statusCode, 201, r.body)
    let m = await next()
    assert.equal(m.headers['content-type'], 'application/vnd.lhv.rt1.in.rtf+gzip')
    assert.equal(gunzipSync(m.rawPayload).toString('utf8'), file)
    r = await call(ctx, { method: 'POST', url: '/_sim/agency/rtf', body: { scheme: 'step2.in', content: Buffer.from(file).toString('base64'), customer: { code: AG.code, country: 'GB' } }, as: null })
    assert.equal(r.statusCode, 201, r.body)
    m = await next()
    assert.equal(m.headers['content-type'], 'application/vnd.lhv.step2.in.rtf')
    assert.equal(m.rawPayload.toString('utf8'), file)
    for (const [body, status] of [
      [{ scheme: 'step2.in' }, 400], [{ scheme: 'swift', text: 'x' }, 400], [{ scheme: 'tips', text: 'x', customer: { code: AG.code, country: 'GB' } }, 409],
      [{ scheme: 't2', customer: { code: '00000000', country: 'GB' } }, 404], [{ scheme: 't2', content: '***' }, 400],
    ] as const) {
      r = await call(ctx, { method: 'POST', url: '/_sim/agency/rtf', body, as: null })
      assert.equal(r.statusCode, status, JSON.stringify(body))
    }
    // No agent receives TIPS: nothing sent.
    r = await call(ctx, { method: 'POST', url: '/_sim/agency/rtf', body: { scheme: 'tips', text: 'x' }, as: null })
    assert.deepEqual(JSON.parse(r.body), { messages: [] })
  })

  test('a binary RTF in v2 messages has no metadata and goes to a UK webhook as base64', async () => {
    await call(ctx, { method: 'POST', url: '/notifications/subscription', as: AG.code, body: { messageType: 'AGENT_REPORT', requestUrl: 'https://hooks.example.org/lhv', active: true, attachFullBody: true, attachMetadata: true } })
    await call(ctx, { method: 'POST', url: '/_sim/agency/rtf', body: { scheme: 'rt1.in', text: 'abc' }, as: null })
    await ctx.emulator.webhooksUk.idle()
    const hook = jsonValid('webhook-uk-payload', sent[0].body.toString('utf8'))
    assert.equal(gunzipSync(Buffer.from(hook.messageBase64, 'base64')).toString('utf8'), 'abc')
    assert.equal(hook.metadata, undefined)
    const list = JSON.parse((await call(ctx, { url: '/v2/messages?includeMetadata=true', as: AG.code })).body)
    assert.equal(list.messages?.[0]?.metadata ?? list[0]?.metadata, undefined)
  })
})
